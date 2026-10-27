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
  stdout = new NodeEvents.EventEmitter();
  stderr = new NodeEvents.EventEmitter();
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
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function fakeSpawn() {
  const children: FakeChildProcess[] = [];
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnImpl = (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ): NodeChildProcess.ChildProcess => {
    const child = new FakeChildProcess();
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
        exchangeBearerToken: async ({ credential }) => `bearer-for-${credential}`,
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

    await expect(server.getBearerToken()).resolves.toBe("bearer-for-bootstrap-secret");
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

  it("keeps the bearer across a restart while the server accepts it", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const exchangeBearerToken = vi.fn(async ({ credential }: { credential: string }) => {
      return `bearer:${credential}`;
    });
    let accepted = true;
    const isBearerAccepted = vi.fn(async () => accepted);
    let tokenIndex = 0;
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43114, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: ready,
        randomToken: () => `token-${(tokenIndex += 1)}`,
        exchangeBearerToken,
        isBearerAccepted,
        env: {},
      },
    );
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    // A failed check while the new server boots keeps the bearer and retries.
    children[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockRejectedValueOnce(new Error("connection refused"));
    await expect(server.getBearerToken()).rejects.toThrow("connection refused");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    accepted = false;
    children[2]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-4");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(2);
    await server.stop();
  });

  it("recovers when checks from overlapping server generations fail", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const exchangeBearerToken = vi.fn(async ({ credential }: { credential: string }) => {
      return `bearer:${credential}`;
    });
    let rejectPending: (error: Error) => void = () => {};
    const isBearerAccepted = vi.fn(async () => true);
    let tokenIndex = 0;
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43116, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: ready,
        randomToken: () => `token-${(tokenIndex += 1)}`,
        exchangeBearerToken,
        isBearerAccepted,
        env: {},
      },
    );
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");

    // Generation 2's check hangs, then generation 3 starts and its check fails too.
    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockImplementationOnce(
      () => new Promise<boolean>((_resolve, reject) => (rejectPending = reject)),
    );
    const generation2 = server.getBearerToken();
    children[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockRejectedValueOnce(new Error("still booting"));
    await expect(server.getBearerToken()).rejects.toThrow("still booting");
    rejectPending(new Error("connection refused"));
    await expect(generation2).rejects.toThrow("connection refused");

    // The next call checks the server again and keeps the last good bearer.
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(isBearerAccepted).toHaveBeenCalledTimes(3);
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);
    await server.stop();
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

  it("exchanges the bearer once per server generation and again after a restart it rejects", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnImpl } = fakeSpawn();
    const exchangeBearerToken = vi.fn(async ({ credential }: { credential: string }) => {
      return `bearer:${credential}`;
    });
    let tokenIndex = 0;
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43112, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: ready,
        randomToken: () => `token-${(tokenIndex += 1)}`,
        exchangeBearerToken,
        isBearerAccepted: async () => false,
        env: {},
      },
    );
    const restarts: number[] = [];
    server.events.on("restart", (attempt) => restarts.push(attempt));

    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(restarts).toEqual([1]);
    expect(calls).toHaveLength(2);
    expect(server.process).toBe(children[1]);
    expect(JSON.parse(children[1]!.stdinChunks.join("")).desktopBootstrapToken).toBe("token-2");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-2");

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
});
