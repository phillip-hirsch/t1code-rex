// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off -- The launcher runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { type DesktopBackendBootstrap, SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";

import { type EnvironmentSummary, fetchEnvironmentSummary } from "./health.ts";
import { resolveNodeBinary, SERVER_APP_DIR } from "./nodeRuntime.ts";

/**
 * Starts upstream's `apps/server` in `desktop` mode. The bootstrap credential
 * travels over stdin, never argv. tr3x never exchanges it: clients mint their
 * own short-lived sessions through `localSession.ts`.
 */

export interface ServerEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface ManagedServerOptions {
  readonly baseDir: string;
  readonly port?: number;
  /**
   * The first restart's delay. Each further rapid failure doubles it, until
   * the launcher gives up: 750 ms→6 s by default, then `fatal`.
   */
  readonly restartDelayMs?: number;
  /** Aborting before the server is ready stops it and rejects the start. */
  readonly signal?: AbortSignal;
  /** Each line the server writes to stderr. */
  readonly onStderr?: (line: string) => void;
}

export interface ManagedServer extends ServerEndpoint {
  readonly process: NodeChildProcess.ChildProcess;
  readonly environment: EnvironmentSummary;
  readonly events: NodeEvents.EventEmitter<ManagedServerEvents>;
  /** SIGTERM, then SIGKILL after the grace period. Resolves once the process has exited. */
  readonly stop: () => Promise<void>;
}

interface ManagedServerEvents {
  restart: [attempt: number, delayMs: number, reason: string];
  /** The server is down for good: it lost the base dir, or kept failing. */
  fatal: [message: string];
}

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 30_000;
/** Failures in a row, with no stable run between them, before the launcher gives up. */
const MAX_RAPID_FAILURES = 5;
/** A server that stayed ready this long before failing resets the failure count. */
const STABLE_RUN_MS = 30_000;

type SpawnImpl = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => NodeChildProcess.ChildProcess;

export interface ManagedServerDependencies {
  readonly spawnImpl?: SpawnImpl;
  readonly reservePort?: () => Promise<number>;
  readonly env?: NodeJS.ProcessEnv;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  readonly randomToken?: () => string;
  readonly waitUntilReady?: (input: {
    httpBaseUrl: string;
    timeoutMs: number;
    process: NodeChildProcess.ChildProcess;
  }) => Promise<EnvironmentSummary>;
  readonly killGraceMs?: number;
}

/** Another server holds the base dir's ownership lock, so this one exited with code 78. */
export class StateDirOwnedError extends Error {
  readonly baseDir: string;
  constructor(baseDir: string) {
    super(`Another T3 server already owns ${baseDir}.`);
    this.baseDir = baseDir;
  }
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildServerEndpoint(host: string, port: number): ServerEndpoint {
  const authority = `${formatHostForUrl(host)}:${port}`;
  return { httpBaseUrl: `http://${authority}`, wsBaseUrl: `ws://${authority}` };
}

// The server must not pick up tr3x's settings or an ambient T3CODE_HOME.
export function stripReservedLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("TR3X_") && !key.startsWith("T3CODE_")),
  );
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServerReady(input: {
  httpBaseUrl: string;
  timeoutMs: number;
  process: NodeChildProcess.ChildProcess;
}): Promise<EnvironmentSummary> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.process.exitCode !== null || input.process.signalCode !== null) {
      throw new Error(
        `Server exited before becoming ready (${input.process.exitCode ?? input.process.signalCode}).`,
      );
    }
    try {
      return await fetchEnvironmentSummary(input.httpBaseUrl, 1_000);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for the T3 server at ${input.httpBaseUrl}.`);
}

function extractFatalStartupError(output: string): string | null {
  const normalized = output.trim();
  if (!normalized) return null;
  if (/\b(EACCES|EPERM)\b|permission denied/iu.test(normalized)) {
    const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? normalized;
    return `tr3x could not start the T3 server because a required path is not writable. ${firstLine}`;
  }
  return null;
}

/**
 * Upstream's dev entry point, run on Node from `apps/server` as its `dev`
 * script does. Throws `NodeNotFoundError` when there's no Node to run it.
 */
export function resolveServerCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
  cwd: string;
} {
  return {
    command: resolveNodeBinary(env),
    args: [NodePath.join(SERVER_APP_DIR, "src", "bin.ts")],
    cwd: SERVER_APP_DIR,
  };
}

export function buildServerArgs(input: {
  readonly entryArgs: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly baseDir: string;
}): string[] {
  return [
    ...input.entryArgs,
    "--mode",
    "desktop",
    "--host",
    input.host,
    "--port",
    String(input.port),
    "--base-dir",
    input.baseDir,
    "--no-browser",
    "--bootstrap-fd",
    "0",
  ];
}

export function buildBootstrapEnvelope(input: {
  readonly host: string;
  readonly port: number;
  readonly baseDir: string;
  readonly bootstrapToken: string;
}): DesktopBackendBootstrap {
  return {
    mode: "desktop",
    noBrowser: true,
    port: input.port,
    t3Home: input.baseDir,
    host: input.host,
    desktopBootstrapToken: input.bootstrapToken,
    shellEnvironmentPrepared: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: input.port,
  };
}

export async function startManagedServer(
  options: ManagedServerOptions,
  dependencies: ManagedServerDependencies = {},
): Promise<ManagedServer> {
  const env = dependencies.env ?? process.env;
  const spawnImpl = dependencies.spawnImpl ?? NodeChildProcess.spawn;
  const reservePort = dependencies.reservePort ?? reserveLoopbackPort;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;
  const randomToken =
    dependencies.randomToken ?? (() => NodeCrypto.randomBytes(32).toString("hex"));
  const waitUntilReady = dependencies.waitUntilReady ?? waitForServerReady;
  const killGraceMs = dependencies.killGraceMs ?? 5_000;
  const { command, args: entryArgs, cwd } = resolveServerCommand(env);
  // Set once the port is known, before the first spawn.
  let port = 0;
  let args: string[] = [];
  const events = new NodeEvents.EventEmitter<ManagedServerEvents>();
  const restartDelayMs = options.restartDelayMs ?? 750;
  let child: NodeChildProcess.ChildProcess | null = null;
  let childRunning = false;
  let stopped = false;
  let ready = false;
  let stateDirOwned = false;
  let fatalStartupError: string | null = null;
  /** Rejects the initial start when the first child ends before it is ready. */
  let onStartupEnd: ((reason: string) => void) | undefined;
  let failures = 0;
  /** When the current child became ready, if it has. */
  let readyAt: number | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why tr3x stopped a restarted server that never got ready. */
  const notReadyReasons = new WeakMap<NodeChildProcess.ChildProcess, string>();

  const spawnChild = (): NodeChildProcess.ChildProcess => {
    fatalStartupError = null;
    readyAt = undefined;
    const spawned = spawnImpl(command, args, {
      cwd,
      env: stripReservedLaunchEnv(env),
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    child = spawned;
    // No pid means the spawn failed; its `error` event is still to come.
    childRunning = spawned.pid !== undefined;
    let ended = false;
    const onEnd = (code: number | null, reason: string) => {
      if (ended) return;
      ended = true;
      if (child === spawned) childRunning = false;
      onStartupEnd?.(reason);
      handleEnd(code, notReadyReasons.get(spawned) ?? reason);
    };
    // A failed spawn (ENOENT, EAGAIN) emits `error` and never `exit`.
    spawned.on("error", (error) => {
      if (spawned.pid === undefined) onEnd(null, error.message);
    });
    // Whole lines only, so a secret split across two chunks is redacted as one.
    let partialLine = "";
    const onStderrLine = (line: string) => {
      const output = line.trimEnd();
      if (!output) return;
      options.onStderr?.(output);
      if (!ready) fatalStartupError = extractFatalStartupError(output) ?? fatalStartupError;
    };
    const flushStderr = () => {
      const line = partialLine;
      partialLine = "";
      onStderrLine(line);
    };
    spawned.once("exit", (code, signal) => {
      // Classify an unfinished last line now, but hand it on only at stderr's end.
      if (!ready) fatalStartupError = extractFatalStartupError(partialLine) ?? fatalStartupError;
      onEnd(code, code === null ? `signal ${signal}` : `exit code ${code}`);
    });

    const envelope = buildBootstrapEnvelope({
      host: HOST,
      port,
      baseDir: options.baseDir,
      bootstrapToken: randomToken(),
    });
    spawned.stdin?.on("error", () => {});
    spawned.stdin?.end(`${JSON.stringify(envelope)}\n`);
    // Drain stdout so a chatty server never blocks on a full pipe.
    spawned.stdout?.resume();
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (chunk: string) => {
      const lines = (partialLine + chunk).split("\n");
      partialLine = lines.pop() ?? "";
      for (const line of lines) onStderrLine(line);
    });
    // The last partial line waits for stderr's own end: bytes can still arrive after `exit`.
    spawned.stderr?.on("end", flushStderr);
    return spawned;
  };

  const handleEnd = (code: number | null, reason: string) => {
    if (stopped) return;
    if (code === SERVER_EXIT_CODE_STATE_DIR_OWNED) {
      stateDirOwned = true;
      const message = new StateDirOwnedError(options.baseDir).message;
      fatalStartupError = message;
      if (ready) events.emit("fatal", message);
      return;
    }
    if (!ready) return;
    if (readyAt !== undefined && Date.now() - readyAt >= STABLE_RUN_MS) failures = 0;
    failures += 1;
    if (failures >= MAX_RAPID_FAILURES) {
      events.emit("fatal", `The T3 server failed ${failures} times in a row (${reason}).`);
      return;
    }
    const delayMs = restartDelayMs * 2 ** (failures - 1);
    events.emit("restart", failures, delayMs, reason);
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      if (!stopped) restart();
    }, delayMs);
  };

  const restart = () => {
    let restarted: NodeChildProcess.ChildProcess;
    try {
      restarted = spawnChild();
    } catch (error) {
      childRunning = false;
      handleEnd(null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (restarted.pid === undefined) return;
    waitUntilReady({ httpBaseUrl, timeoutMs: READY_TIMEOUT_MS, process: restarted }).then(
      () => {
        if (child === restarted && childRunning) readyAt = Date.now();
      },
      // A server that stays up but never gets ready counts as a failure once it exits.
      (error: unknown) => {
        if (stopped || child !== restarted || !childRunning) return;
        notReadyReasons.set(restarted, error instanceof Error ? error.message : String(error));
        void terminate(restarted);
      },
    );
  };

  /** SIGTERM, then SIGKILL after the grace period. Resolves once the process has exited. */
  const terminate = async (target: NodeChildProcess.ChildProcess) => {
    const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
    target.kill("SIGTERM");
    const escalate = setTimeoutImpl(() => {
      if (child === target && childRunning) target.kill("SIGKILL");
    }, killGraceMs);
    await exited;
    clearTimeoutImpl(escalate);
  };

  const stop = async () => {
    stopped = true;
    if (restartTimer !== null) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    if (child && childRunning) await terminate(child);
  };

  // Registered before any await: an abort while the port is reserved must stop
  // the launch before it spawns anything.
  const onAbort = () => void stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) stopped = true;
  let httpBaseUrl = "";
  let first: NodeChildProcess.ChildProcess | null = null;
  let environment: EnvironmentSummary;
  try {
    port = options.port ?? (await reservePort());
    args = buildServerArgs({ entryArgs, host: HOST, port, baseDir: options.baseDir });
    httpBaseUrl = buildServerEndpoint(HOST, port).httpBaseUrl;
    if (stopped) throw new Error("Aborted while the server started.");
    const spawned = spawnChild();
    first = spawned;
    if (spawned.pid === undefined) {
      const error = await new Promise<Error>((resolve) => spawned.once("error", resolve));
      throw new Error(`Could not start the T3 server (${error.message}).`);
    }
    environment = await new Promise<EnvironmentSummary>((resolve, reject) => {
      onStartupEnd = (reason) =>
        reject(new Error(`Server exited before becoming ready (${reason}).`));
      waitUntilReady({ httpBaseUrl, timeoutMs: READY_TIMEOUT_MS, process: spawned }).then(
        resolve,
        reject,
      );
    });
    if (stopped) throw new Error("Aborted while the server started.");
  } catch (error) {
    // Don't leave a slow server running and holding the data directory.
    await stop();
    if (stateDirOwned) throw new StateDirOwnedError(options.baseDir);
    if (fatalStartupError) throw new Error(fatalStartupError, { cause: error });
    throw error;
  } finally {
    onStartupEnd = undefined;
    options.signal?.removeEventListener("abort", onAbort);
  }
  ready = true;
  readyAt = Date.now();
  const spawnedFirst = first;

  return {
    get process() {
      return child ?? spawnedFirst;
    },
    ...buildServerEndpoint(HOST, port),
    environment,
    events,
    stop,
  };
}
