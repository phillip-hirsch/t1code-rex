// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off -- The launcher runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { type DesktopBackendBootstrap, SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";

import { type EnvironmentSummary, fetchEnvironmentSummary } from "./health.ts";

/**
 * Starts upstream's `apps/server` in `desktop` mode. The bootstrap credential
 * travels over stdin, never argv, and is exchanged for a bearer at `/oauth/token`.
 */

export interface ServerEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface ManagedServerOptions {
  readonly baseDir: string;
  readonly host?: string;
  readonly port?: number;
  readonly readyTimeoutMs?: number;
  readonly restartOnExit?: boolean;
  readonly restartDelayMs?: number;
  /** Aborting before the server is ready stops it and rejects the start. */
  readonly signal?: AbortSignal;
  readonly onLog?: (event: string, details?: Record<string, unknown>) => void;
}

export interface ManagedServer extends ServerEndpoint {
  readonly process: NodeChildProcess.ChildProcess;
  readonly host: string;
  readonly port: number;
  readonly environment: EnvironmentSummary;
  /**
   * Returns a bearer for the server. Exchanges the bootstrap credential once, then
   * keeps the same bearer across restarts while the server still accepts it,
   * because a new exchange revokes the bearer other clients were given.
   */
  readonly getBearerToken: () => Promise<string>;
  readonly events: NodeEvents.EventEmitter<{
    restart: [attempt: number];
    exit: [code: number | null, signal: NodeJS.Signals | null];
    fatal: [message: string];
  }>;
  /** SIGTERM, then SIGKILL after the grace period. Resolves once the process has exited. */
  readonly stop: () => Promise<void>;
}

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
  readonly exchangeBearerToken?: (input: {
    httpBaseUrl: string;
    credential: string;
  }) => Promise<string>;
  readonly isBearerAccepted?: (input: {
    httpBaseUrl: string;
    bearerToken: string;
  }) => Promise<boolean>;
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

const SERVER_APP_DIR = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../server",
);

export const CLIENT_LABEL = "tr3x";

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildServerEndpoint(host: string, port: number): ServerEndpoint {
  const authority = `${formatHostForUrl(host)}:${port}`;
  return { httpBaseUrl: `http://${authority}`, wsBaseUrl: `ws://${authority}` };
}

// The server must not pick up tr3x's settings or an ambient T3CODE_HOME.
function stripReservedLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

async function exchangeBootstrapForBearer(input: {
  httpBaseUrl: string;
  credential: string;
}): Promise<string> {
  const session = await Effect.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl: input.httpBaseUrl,
      credential: input.credential,
      clientMetadata: { label: CLIENT_LABEL, deviceType: "desktop", surface: "cli" },
    }).pipe(Effect.provide(layerRemoteHttpClient(fetch))),
  );
  return session.access_token;
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

export async function isBearerAcceptedByServer(input: {
  httpBaseUrl: string;
  bearerToken: string;
}): Promise<boolean> {
  // Resolves false only for a definitive rejection; network errors and other
  // statuses (e.g. 503 while booting) throw so the caller retries later.
  const response = await fetch(new URL("/api/auth/session", input.httpBaseUrl), {
    headers: { authorization: `Bearer ${input.bearerToken}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error(`Server returned ${response.status} for the session check.`);
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "authenticated" in body
    ? body.authenticated === true
    : false;
}

/** Upstream's dev entry point, run from `apps/server` as its `dev` script does. */
export function resolveServerCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
  cwd: string;
} {
  const configured = env.TR3X_NODE_BIN?.trim();
  const node = configured || (process.versions.bun === undefined ? process.execPath : "node");
  return {
    command: node,
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
  const exchangeBearerToken = dependencies.exchangeBearerToken ?? exchangeBootstrapForBearer;
  const isBearerAccepted = dependencies.isBearerAccepted ?? isBearerAcceptedByServer;
  const killGraceMs = dependencies.killGraceMs ?? 5_000;
  const port = options.port ?? (await reservePort());
  const host = options.host?.trim() || "127.0.0.1";
  const endpoint = buildServerEndpoint(host, port);
  const { command, args: entryArgs, cwd } = resolveServerCommand(env);
  const args = buildServerArgs({ entryArgs, host, port, baseDir: options.baseDir });
  const events = new NodeEvents.EventEmitter<{
    restart: [attempt: number];
    exit: [code: number | null, signal: NodeJS.Signals | null];
    fatal: [message: string];
  }>();
  const restartOnExit = options.restartOnExit ?? true;
  const restartDelayMs = options.restartDelayMs ?? 750;
  let child: NodeChildProcess.ChildProcess | null = null;
  let stopped = false;
  let ready = false;
  let stateDirOwned = false;
  let fatalStartupError: string | null = null;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let bootstrapToken = "";
  let bearer: { generation: number; token: Promise<string> } | null = null;

  const spawnChild = (): NodeChildProcess.ChildProcess => {
    fatalStartupError = null;
    generation += 1;
    bootstrapToken = randomToken();
    const spawned = spawnImpl(command, args, {
      cwd,
      env: stripReservedLaunchEnv(env),
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    child = spawned;
    const envelope = buildBootstrapEnvelope({
      host,
      port,
      baseDir: options.baseDir,
      bootstrapToken,
    });
    spawned.stdin?.on("error", () => {});
    spawned.stdin?.end(`${JSON.stringify(envelope)}\n`);

    options.onLog?.("server.spawned", { pid: spawned.pid ?? null, host, port, generation });

    const watchOutput = (stream: NodeJS.ReadableStream | null | undefined, event: string) => {
      stream?.on("data", (chunk) => {
        const output = String(chunk).trimEnd();
        options.onLog?.(event, { chunk: output });
        if (!ready) fatalStartupError = extractFatalStartupError(output) ?? fatalStartupError;
      });
    };
    watchOutput(spawned.stdout, "server.stdout");
    watchOutput(spawned.stderr, "server.stderr");

    spawned.once("exit", (code, signal) => {
      options.onLog?.("server.exit", { code, signal: signal ?? null });
      events.emit("exit", code, signal);
      if (stopped) return;
      if (code === SERVER_EXIT_CODE_STATE_DIR_OWNED) {
        stateDirOwned = true;
        const message = new StateDirOwnedError(options.baseDir).message;
        fatalStartupError = message;
        if (ready) events.emit("fatal", message);
        return;
      }
      if (!restartOnExit || !ready) return;
      restartAttempt += 1;
      options.onLog?.("server.restart", { attempt: restartAttempt });
      events.emit("restart", restartAttempt);
      restartTimer = setTimeoutImpl(() => {
        restartTimer = null;
        if (!stopped) spawnChild();
      }, restartDelayMs);
    });
    return spawned;
  };

  const stop = async () => {
    stopped = true;
    if (restartTimer !== null) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    current.kill("SIGTERM");
    const escalate = setTimeoutImpl(() => {
      if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
    }, killGraceMs);
    await exited;
    clearTimeoutImpl(escalate);
  };

  const onAbort = () => void stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const first = spawnChild();
  let environment: EnvironmentSummary;
  try {
    environment = await waitUntilReady({
      httpBaseUrl: endpoint.httpBaseUrl,
      timeoutMs: options.readyTimeoutMs ?? 30_000,
      process: first,
    });
    if (options.signal?.aborted) throw new Error("Aborted while the server started.");
  } catch (error) {
    // Don't leave a slow server running and holding the data directory.
    await stop();
    if (stateDirOwned) throw new StateDirOwnedError(options.baseDir);
    if (fatalStartupError) throw new Error(fatalStartupError, { cause: error });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  ready = true;
  options.onLog?.("server.ready", { host, port, serverVersion: environment.serverVersion });

  const exchange = () =>
    exchangeBearerToken({ httpBaseUrl: endpoint.httpBaseUrl, credential: bootstrapToken });

  // The last bearer that worked. Retries always start from it, never from a
  // pending or failed request of an earlier server generation.
  let lastGoodBearer: string | null = null;

  const getBearerToken = () => {
    if (bearer !== null && bearer.generation === generation) return bearer.token;
    const current = generation;
    const previous = lastGoodBearer;
    // Exchange again only when the server definitively rejects the old bearer. A
    // network error while the new server boots must not trigger an exchange, or
    // it would revoke the bearer other clients share.
    const token = (
      previous
        ? isBearerAccepted({ httpBaseUrl: endpoint.httpBaseUrl, bearerToken: previous }).then(
            (accepted) => (accepted ? previous : exchange()),
          )
        : exchange()
    ).then(
      (resolved) => {
        if (current === generation) lastGoodBearer = resolved;
        return resolved;
      },
      (error: unknown) => {
        // Let the next call try again from the last good bearer.
        if (bearer?.generation === current) bearer = null;
        throw error;
      },
    );
    bearer = { generation: current, token };
    return token;
  };

  return {
    get process() {
      return child ?? first;
    },
    host,
    port,
    ...endpoint,
    environment,
    getBearerToken,
    events,
    stop,
  };
}
