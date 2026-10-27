// @effect-diagnostics nodeBuiltinImport:off -- Fake child processes stand in for the server.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildBootstrapEnvelope,
  buildServerArgs,
  resolveAttachedServerConnection,
  startManagedServer,
  type EnvironmentSummary,
} from "./serverLauncher.ts";

const environment: EnvironmentSummary = {
  environmentId: "env-1" as EnvironmentSummary["environmentId"],
  label: "Test",
  serverVersion: "0.1.2",
  platformOs: "darwin",
  orchestrationProtocolVersion: 2,
};

class FakeChildProcess extends NodeEvents.EventEmitter {
  killed = false;
  exitCode: number | null = null;
  pid = 4242;
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
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return signal !== undefined;
  });
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

describe("resolveAttachedServerConnection", () => {
  it("builds base URLs from the attach env and keeps the bearer out of them", () => {
    expect(
      resolveAttachedServerConnection({
        TR3X_TUI_ATTACH_ONLY: "1",
        TR3X_HOST: "127.0.0.1",
        TR3X_PORT: "43111",
        TR3X_AUTH_TOKEN: "bearer-1",
      }),
    ).toEqual({
      httpBaseUrl: "http://127.0.0.1:43111",
      wsBaseUrl: "ws://127.0.0.1:43111",
      bearerToken: "bearer-1",
    });
    expect(resolveAttachedServerConnection({ TR3X_PORT: "43111" })).toBeNull();
  });

  it("requires a port and a bearer token", () => {
    expect(() =>
      resolveAttachedServerConnection({ TR3X_TUI_ATTACH_ONLY: "1", TR3X_AUTH_TOKEN: "x" }),
    ).toThrow("TR3X_TUI_ATTACH_ONLY requires a valid TR3X_PORT.");
    expect(() =>
      resolveAttachedServerConnection({ TR3X_TUI_ATTACH_ONLY: "1", TR3X_PORT: "43111" }),
    ).toThrow("TR3X_TUI_ATTACH_ONLY requires TR3X_AUTH_TOKEN");
  });
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
        env: { TR3X_PORT: "49999", TR3X_AUTH_TOKEN: "ambient", NODE_ENV: "production" },
      },
    );

    expect(server.httpBaseUrl).toBe("http://127.0.0.1:43111");
    expect(server.wsBaseUrl).toBe("ws://127.0.0.1:43111");
    expect(server.environment).toEqual(environment);
    const call = calls[0]!;
    expect(call.command).toBe("node");
    expect(call.args[0]).toContain("/apps/server/dist/bin.mjs");
    expect(call.args.slice(1)).toEqual(
      buildServerArgs({ entryArgs: [], host: "127.0.0.1", port: 43111, baseDir: "/tmp/.tr3x" }),
    );
    expect(call.args).toContain("--mode");
    expect(call.args).toContain("desktop");
    expect(call.args).toContain("--base-dir");
    expect(call.args).toContain("--no-browser");
    expect(call.args).toContain("--auto-bootstrap-project-from-cwd");
    expect(call.args.join(" ")).not.toContain("bootstrap-secret");
    expect(call.args.join(" ")).not.toContain("--auth-token");
    expect(call.env.TR3X_PORT).toBeUndefined();
    expect(call.env.TR3X_AUTH_TOKEN).toBeUndefined();

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
    server.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps the bearer across a restart while the server accepts it, so Rex tabs stay signed in", async () => {
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

    children[0]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    // A failed check while the new server boots keeps the bearer and retries.
    children[1]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockRejectedValueOnce(new Error("connection refused"));
    await expect(server.getBearerToken()).rejects.toThrow("connection refused");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    accepted = false;
    children[2]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-4");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(2);
    server.stop();
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
    children[0]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockImplementationOnce(
      () => new Promise<boolean>((_resolve, reject) => (rejectPending = reject)),
    );
    const generation2 = server.getBearerToken();
    children[1]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    isBearerAccepted.mockRejectedValueOnce(new Error("still booting"));
    await expect(server.getBearerToken()).rejects.toThrow("still booting");
    rejectPending(new Error("connection refused"));
    await expect(generation2).rejects.toThrow("connection refused");

    // The next call checks the server again and keeps the last good bearer.
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(isBearerAccepted).toHaveBeenCalledTimes(3);
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);
    server.stop();
  });

  it("stops the server process when it never becomes ready", async () => {
    vi.useFakeTimers();
    const { children, spawnImpl } = fakeSpawn();
    const started = startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43115, restartDelayMs: 25 },
      {
        spawnImpl,
        waitUntilReady: () => Promise.reject(new Error("not ready")),
        killGraceMs: 100,
        env: {},
      },
    );
    await expect(started).rejects.toThrow("not ready");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("exchanges the bearer once per server generation and again after a restart it rejects", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnImpl } = fakeSpawn();
    const exchangeBearerToken = vi.fn(async ({ credential }: { credential: string }) => {
      return `bearer:${credential}`;
    });
    let tokenIndex = 0;
    const onRestart = vi.fn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43112, restartDelayMs: 25, onRestart },
      {
        spawnImpl,
        waitUntilReady: ready,
        randomToken: () => `token-${(tokenIndex += 1)}`,
        exchangeBearerToken,
        isBearerAccepted: async () => false,
        env: {},
      },
    );

    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-1");
    expect(exchangeBearerToken).toHaveBeenCalledTimes(1);

    children[0]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(25);
    expect(onRestart).toHaveBeenCalledWith({ attempt: 1 });
    expect(calls).toHaveLength(2);
    expect(server.process).toBe(children[1]);
    expect(JSON.parse(children[1]!.stdinChunks.join("")).desktopBootstrapToken).toBe("token-2");
    await expect(server.getBearerToken()).resolves.toBe("bearer:token-2");

    server.stop();
    children[1]!.emit("exit", 0, "SIGTERM");
    await vi.advanceTimersByTimeAsync(25);
    expect(calls).toHaveLength(2);
  });

  it("does not restart a server that lost the state directory lock", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnImpl } = fakeSpawn();
    const onFatal = vi.fn();
    const server = await startManagedServer(
      { baseDir: "/tmp/.tr3x", port: 43113, restartDelayMs: 25, onFatal },
      { spawnImpl, waitUntilReady: ready, env: {} },
    );
    const fatal = vi.fn();
    server.events.on("fatal", fatal);

    children[0]!.emit("exit", 78, null);
    await vi.advanceTimersByTimeAsync(25);

    expect(calls).toHaveLength(1);
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("already owns /tmp/.tr3x"));
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("surfaces a permission error instead of retrying when startup fails", async () => {
    vi.useFakeTimers();
    const { calls, spawnImpl } = fakeSpawn();
    const onRestart = vi.fn();
    await expect(
      startManagedServer(
        { baseDir: "/tmp/.tr3x", port: 43114, restartDelayMs: 25, onRestart },
        {
          spawnImpl,
          env: {},
          waitUntilReady: async ({ process }) => {
            const child = process as unknown as FakeChildProcess;
            child.stderr.emit(
              "data",
              "Error: EACCES: permission denied, mkdir '/tmp/.tr3x/userdata'",
            );
            child.exitCode = 1;
            child.emit("exit", 1, null);
            throw new Error("Server exited before becoming ready (1).");
          },
        },
      ),
    ).rejects.toThrow("tr3x could not start because a required path is not writable.");
    await vi.advanceTimersByTimeAsync(25);
    expect(onRestart).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
