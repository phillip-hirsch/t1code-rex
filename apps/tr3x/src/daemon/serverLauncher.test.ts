// @effect-diagnostics nodeBuiltinImport:off -- Fake child processes stand in for the server.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentSummary } from "./health.ts";
import {
  buildBootstrapEnvelope,
  buildServerArgs,
  StateDirOwnedError,
  startManagedServer,
} from "./serverLauncher.ts";

const environment: EnvironmentSummary = {
  environmentId: "env-1" as EnvironmentSummary["environmentId"],
  label: "Test",
  serverVersion: "0.1.2",
  orchestrationProtocolVersion: 2,
};

class FakeChildProcess extends NodeEvents.EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  /** Signals the fake ignores, like a server that hangs on shutdown. */
  ignoredSignals = new Set<NodeJS.Signals>();
  stdout = new NodeStream.PassThrough();
  stderr = new NodeStream.PassThrough();
  stdinChunks: string[] = [];
  stdinEnded = false;
  stdin = new NodeStream.Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(String(chunk));
      callback();
    },
    final: (callback) => {
      this.stdinEnded = true;
      callback();
    },
  });
  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    if (this.ignoredSignals.has(signal)) return true;
    this.exit(null, signal);
    return true;
  });
  /** What a real child does when `spawn` fails: no pid, an `error` event, and no `exit`. */
  failSpawn(code: string) {
    (this as { pid: number | undefined }).pid = undefined;
    queueMicrotask(() =>
      this.emit("error", Object.assign(new Error(`spawn /opt/node ${code}`), { code })),
    );
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function fakeSpawn(onSpawn?: (child: FakeChildProcess, index: number) => void) {
  const children: FakeChildProcess[] = [];
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnImpl = (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ): NodeChildProcess.ChildProcess => {
    const child = new FakeChildProcess();
    onSpawn?.(child, children.length);
    children.push(child);
    calls.push({ command, args, env: options.env });
    return child as unknown as NodeChildProcess.ChildProcess;
  };
  return { children, calls, spawnImpl };
}

const ready = async () => environment;

afterEach(() => {
  vi.useRealTimers();
});

describe("startManagedServer", () => {
  it("spawns upstream's server in desktop mode with the secret on stdin, not argv", async () => {
    const { children, calls, spawnImpl } = fakeSpawn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x" },
      {
        spawnImpl,
        reservePort: async () => 43111,
        waitUntilReady: ready,
        randomToken: () => "bootstrap-secret",
        env: { TR3X_NODE_BIN: "/opt/node", T3CODE_HOME: "/home/me/.t3", PATH: "/usr/bin" },
      },
    );

    expect(server.httpBaseUrl).toBe("http://127.0.0.1:43111");
    expect(server.wsBaseUrl).toBe("ws://127.0.0.1:43111");
    expect(server.environment).toEqual(environment);
    const call = calls[0]!;
    expect(call.command).toBe("/opt/node");
    expect(call.args[0]).toMatch(/\/apps\/server\/src\/bin\.ts$/u);
    expect(call.args.slice(1)).toEqual(
      buildServerArgs({ entryArgs: [], host: "127.0.0.1", port: 43111, baseDir: "/tmp/.tr3x" }),
    );
    expect(call.args.join(" ")).not.toContain("bootstrap-secret");
    expect(call.args.join(" ")).not.toContain("--auth-token");
    expect(call.env).toEqual({ PATH: "/usr/bin" });

    const child = children[0]!;
    expect(child.stdinEnded).toBe(true);
    expect(JSON.parse(child.stdinChunks.join(""))).toEqual(
      buildBootstrapEnvelope({
        host: "127.0.0.1",
        port: 43111,
        baseDir: "/tmp/.tr3x",
        bootstrapToken: "bootstrap-secret",
      }),
    );

    await server.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL when the server ignores SIGTERM, and resolves once it exits", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43117 },
      { spawnImpl, waitUntilReady: ready, killGraceMs: 100, env: {} },
    );
    const child = children[0]!;
    child.ignoredSignals.add("SIGTERM");
    let stopped = false;
    const stopping = server.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("stops the server process when it never becomes ready", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    let child: FakeChildProcess | undefined;
    const started = startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43115, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: () => {
          child = children[0]!;
          child.ignoredSignals.add("SIGTERM");
          return Promise.reject(new Error("not ready"));
        },
        killGraceMs: 100,
        env: {},
      },
    );
    const outcome = expect(started).rejects.toThrow("not ready");
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
    expect(child!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("stops a starting server when the signal aborts", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const started = startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43118, signal: controller.signal },
      {
        spawnImpl,
        env: {},
        waitUntilReady: async ({ process }) => {
          controller.abort();
          expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
          throw new Error("Server exited before becoming ready (SIGTERM).");
        },
      },
    );
    await expect(started).rejects.toThrow("exited before becoming ready");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops before spawning when the signal aborts while the port is reserved", async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const waitUntilReady = vi.fn(ready);
    const started = startManagedServer(
      { baseDir: "/tmp/.tr3x", signal: controller.signal },
      {
        spawnImpl,
        env: {},
        waitUntilReady,
        reservePort: async () => {
          await Promise.resolve();
          controller.abort();
          return 43120;
        },
      },
    );
    await expect(started).rejects.toThrow("Aborted while the server started.");
    expect(calls).toHaveLength(0);
    expect(waitUntilReady).not.toHaveBeenCalled();
  });

  it("restarts a crashed server with a fresh bootstrap credential", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnImpl } = fakeSpawn();
    let tokenIndex = 0;
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43112, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: ready,
        randomToken: () => `token-${(tokenIndex += 1)}`,
        env: {},
      },
    );
    const restarts: number[] = [];
    server.events.on("restart", (attempt) => restarts.push(attempt));

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(restarts).toEqual([1]);
    expect(calls).toHaveLength(2);
    expect(server.process).toBe(children[1]);
    expect(JSON.parse(children[1]!.stdinChunks.join("")).desktopBootstrapToken).toBe("token-2");

    await server.stop();
    await vi.advanceTimersByTimeAsync(25);
    expect(calls).toHaveLength(2);
  });

  it("rejects with StateDirOwnedError when another server owns the base dir at startup", async () => {
    const { calls, spawnImpl } = fakeSpawn();
    await expect(
      startManagedServer(
        { baseDir: "/tmp/.tr3x", port: 43119 },
        {
          spawnImpl,
          env: {},
          waitUntilReady: async ({ process }) => {
            (process as unknown as FakeChildProcess).exit(78);
            throw new Error("Server exited before becoming ready (78).");
          },
        },
      ),
    ).rejects.toBeInstanceOf(StateDirOwnedError);
    expect(calls).toHaveLength(1);
  });

  it("does not restart a running server that lost the state directory lock", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnImpl } = fakeSpawn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43113, restartDelayMs: 25 },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const fatal = vi.fn();
    server.events.on("fatal", fatal);

    children[0]!.exit(78);
    await vi.advanceTimersByTimeAsync(25);

    expect(calls).toHaveLength(1);
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("already owns /tmp/.tr3x"));
  });

  it("surfaces a permission error instead of retrying when startup fails", async () => {
    vi.useFakeTimers();
    const { calls, spawnImpl } = fakeSpawn();
    await expect(
      startManagedServer(
        { baseDir: "/tmp/.tr3x", port: 43114, restartDelayMs: 25 },
        {
          spawnImpl,
          env: {},
          waitUntilReady: async ({ process }) => {
            const child = process as unknown as FakeChildProcess;
            child.stderr.emit(
              "data",
              "Error: EACCES: permission denied, mkdir '/tmp/.tr3x/userdata'",
            );
            child.exit(1);
            throw new Error("Server exited before becoming ready (1).");
          },
        },
      ),
    ).rejects.toThrow(
      "tr3x could not start the T3 server because a required path is not writable.",
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(calls).toHaveLength(1);
  });

  it("backs off while a restarted server keeps crashing, then gives up", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43121, restartDelayMs: 100 },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const delays: number[] = [];
    const fatal = vi.fn();
    server.events.on("restart", (_attempt, delayMs) => delays.push(delayMs));
    server.events.on("fatal", fatal);

    for (let crash = 0; crash < 5; crash += 1) {
      children.at(-1)!.exit(1);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(delays).toEqual([100, 200, 400, 800]);
    expect(fatal).toHaveBeenCalledWith("The T3 server failed 5 times in a row (exit code 1).");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(5);
  });

  it("stops a restarted server that never gets ready, then backs off and gives up", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn((child, index) => {
      // Restarted servers stay up, ignoring SIGTERM, but never answer.
      if (index > 0) child.ignoredSignals.add("SIGTERM");
    });
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43125, restartDelayMs: 100 },
      {
        spawnImpl,
        waitUntilReady: ({ process }) =>
          process === (children[0] as unknown) ? ready() : Promise.reject(new Error("timed out")),
        killGraceMs: 50,
        env: {},
      },
    );
    const delays: number[] = [];
    const fatal = vi.fn();
    server.events.on("restart", (_attempt, delayMs) => delays.push(delayMs));
    server.events.on("fatal", fatal);

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delays).toEqual([100, 200, 400, 800]);
    expect(fatal).toHaveBeenCalledWith("The T3 server failed 5 times in a row (timed out).");
    expect(children).toHaveLength(5);
    for (const child of children.slice(1)) {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.signalCode).toBe("SIGKILL");
    }
  });

  it("passes stderr on by whole lines, so a secret split across chunks stays whole", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const lines: string[] = [];
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43126, onStderr: (line) => lines.push(line) },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const stderr = children[0]!.stderr;
    stderr.emit("data", "first\nauth-token=abc");
    stderr.emit("data", "def rest\r\npartial");
    expect(lines).toEqual(["first", "auth-token=abcdef rest"]);
    await server.stop();
    stderr.emit("end");
    expect(lines).toEqual(["first", "auth-token=abcdef rest", "partial"]);
  });

  it("keeps a line whole when its end arrives after the server exited", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const lines: string[] = [];
    await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43127, onStderr: (line) => lines.push(line) },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const child = children[0]!;
    child.stderr.emit("data", "auth-token=abc");
    child.exit(1);
    child.stderr.emit("data", "def\n");
    child.stderr.emit("end");
    expect(lines).toEqual(["auth-token=abcdef"]);
  });

  it("resets the backoff once a restarted server has stayed up", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43122, restartDelayMs: 100 },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const delays: number[] = [];
    server.events.on("restart", (_attempt, delayMs) => delays.push(delayMs));

    children.at(-1)!.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    children.at(-1)!.exit(1);
    await vi.advanceTimersByTimeAsync(31_000);
    children.at(-1)!.exit(1);
    expect(delays).toEqual([100, 200, 100]);
    await server.stop();
  });

  it("backs off when a restart can't spawn the server, without throwing", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn((child, index) => {
      if (index > 0) child.failSpawn("EAGAIN");
    });
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43123, restartDelayMs: 25 },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const delays: number[] = [];
    const fatal = vi.fn();
    server.events.on("restart", (_attempt, delayMs) => delays.push(delayMs));
    server.events.on("fatal", fatal);

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delays).toEqual([25, 50, 100, 200]);
    expect(fatal).toHaveBeenCalledWith(
      "The T3 server failed 5 times in a row (spawn /opt/node EAGAIN).",
    );
    await server.stop();
  });

  it("rejects the start when the server can't be spawned", async () => {
    await expect(
      startManagedServer(
        { baseDir: "/tmp/.tr3x", port: 43124 },
        { env: { TR3X_NODE_BIN: "/nonexistent/tr3x-node" } },
      ),
    ).rejects.toThrow("Could not start the T3 server (spawn /nonexistent/tr3x-node ENOENT).");
  });
});
