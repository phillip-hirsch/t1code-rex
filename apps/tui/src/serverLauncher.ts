// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off -- The launcher runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  type DesktopBackendBootstrap,
  type EnvironmentId,
  ExecutionEnvironmentDescriptor,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
} from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * How the TUI reaches a T3 Code server. The server is upstream's `apps/server`
 * in `desktop` mode: the bootstrap credential travels over stdin, never argv,
 * and is exchanged for a bearer at `/oauth/token`.
 */

export interface ServerEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface EnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverVersion: string;
  readonly platformOs: string;
  readonly orchestrationProtocolVersion: number | null;
}

export interface AttachedServerConnection extends ServerEndpoint {
  readonly bearerToken: string;
}

export type TuiServerSessionMode = "managed" | "attached" | "thread-window";

/** What the connection layers need from a server, however it was reached. */
export interface TuiServerSession extends ServerEndpoint {
  readonly mode: TuiServerSessionMode;
  readonly environment: EnvironmentSummary;
  readonly getBearerToken: () => Promise<string>;
  readonly stop: () => void;
}

export async function attachServerSession(
  connection: AttachedServerConnection,
  mode: Exclude<TuiServerSessionMode, "managed">,
): Promise<TuiServerSession> {
  const environment = await fetchEnvironmentSummary(connection.httpBaseUrl);
  return {
    mode,
    httpBaseUrl: connection.httpBaseUrl,
    wsBaseUrl: connection.wsBaseUrl,
    environment,
    getBearerToken: () => Promise.resolve(connection.bearerToken),
    stop: () => {},
  };
}

export function managedServerSession(server: ManagedServer): TuiServerSession {
  return {
    mode: "managed",
    httpBaseUrl: server.httpBaseUrl,
    wsBaseUrl: server.wsBaseUrl,
    environment: server.environment,
    getBearerToken: server.getBearerToken,
    stop: server.stop,
  };
}

export interface ManagedServerOptions {
  readonly baseDir: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly port?: number;
  readonly readyTimeoutMs?: number;
  readonly restartOnExit?: boolean;
  readonly restartDelayMs?: number;
  readonly onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly onRestart?: (info: { attempt: number }) => void;
  readonly onFatal?: (message: string) => void;
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
   * because a new exchange revokes the bearer Rex thread tabs were given.
   */
  readonly getBearerToken: () => Promise<string>;
  readonly events: NodeEvents.EventEmitter<{
    restart: [attempt: number];
    exit: [code: number | null, signal: NodeJS.Signals | null];
    fatal: [message: string];
  }>;
  readonly stop: () => void;
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

const THIS_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const TUI_APP_DIR = NodePath.resolve(THIS_DIR, "..");
const REPO_ROOT = NodePath.resolve(TUI_APP_DIR, "../..");
const SERVER_APP_DIR = NodePath.resolve(REPO_ROOT, "apps/server");
const BUNDLED_SERVER_ENTRY = NodePath.resolve(THIS_DIR, "server", "bin.mjs");

export const TUI_CLIENT_LABEL = "T1Code";

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeHost(host: string | undefined): string {
  return host?.trim() || "127.0.0.1";
}

function parseConfiguredPort(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const port = Number(normalized);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("T1CODE_PORT must be a valid port between 1 and 65535.");
  }
  return port;
}

export function buildServerEndpoint(host: string, port: number): ServerEndpoint {
  const authority = `${formatHostForUrl(host)}:${port}`;
  return { httpBaseUrl: `http://${authority}`, wsBaseUrl: `ws://${authority}` };
}

/**
 * `T1CODE_TUI_ATTACH_ONLY=1` with `T1CODE_HOST`, `T1CODE_PORT` and a bearer in
 * `T1CODE_AUTH_TOKEN` (for example from `t3 auth session issue --token-only`)
 * joins a running server instead of starting one.
 */
export function resolveAttachedServerConnection(
  env: NodeJS.ProcessEnv = process.env,
): AttachedServerConnection | null {
  if (!readBooleanEnv(env.T1CODE_TUI_ATTACH_ONLY)) return null;
  const host = normalizeHost(env.T1CODE_HOST);
  const port = parseConfiguredPort(env.T1CODE_PORT);
  if (port === null) {
    throw new Error("T1CODE_TUI_ATTACH_ONLY requires a valid T1CODE_PORT.");
  }
  const bearerToken = env.T1CODE_AUTH_TOKEN?.trim();
  if (!bearerToken) {
    throw new Error("T1CODE_TUI_ATTACH_ONLY requires T1CODE_AUTH_TOKEN (a bearer token).");
  }
  return { ...buildServerEndpoint(host, port), bearerToken };
}

function stripReservedLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("T1CODE_") && !key.startsWith("T3CODE_")),
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

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

export async function fetchEnvironmentSummary(
  httpBaseUrl: string,
  timeoutMs = 2_000,
): Promise<EnvironmentSummary> {
  const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Server descriptor request failed (${response.status}).`);
  }
  const descriptor = decodeDescriptor(await response.json());
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    serverVersion: descriptor.serverVersion,
    platformOs: descriptor.platform.os,
    orchestrationProtocolVersion: descriptor.orchestrationProtocolVersion ?? null,
  };
}

async function waitForServerReady(input: {
  httpBaseUrl: string;
  timeoutMs: number;
  process: NodeChildProcess.ChildProcess;
}): Promise<EnvironmentSummary> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.process.exitCode !== null) {
      throw new Error(`Server exited before becoming ready (${input.process.exitCode}).`);
    }
    try {
      return await fetchEnvironmentSummary(input.httpBaseUrl, 1_000);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for the T1Code server at ${input.httpBaseUrl}.`);
}

async function exchangeBootstrapForBearer(input: {
  httpBaseUrl: string;
  credential: string;
}): Promise<string> {
  const session = await Effect.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl: input.httpBaseUrl,
      credential: input.credential,
      clientMetadata: { label: TUI_CLIENT_LABEL, deviceType: "desktop", surface: "cli" },
    }).pipe(Effect.provide(layerRemoteHttpClient(fetch))),
  );
  return session.access_token;
}

function extractFatalStartupError(output: string): string | null {
  const normalized = output.trim();
  if (!normalized) return null;
  if (/\b(EACCES|EPERM)\b|permission denied/iu.test(normalized)) {
    const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? normalized;
    return `T1Code could not start because a required path is not writable. ${firstLine}`;
  }
  return null;
}

async function isBearerAcceptedByServer(input: {
  httpBaseUrl: string;
  bearerToken: string;
}): Promise<boolean> {
  // Resolves false only for a definitive rejection; network errors and other
  // statuses (e.g. 503 while booting) throw so the caller retries later.
  const response = await fetch(new URL("/api/auth/session", input.httpBaseUrl), {
    headers: { authorization: `Bearer ${input.bearerToken}` },
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error(`Server returned ${response.status} for the session check.`);
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "authenticated" in body
    ? body.authenticated === true
    : false;
}

function stateDirOwnedMessage(baseDir: string): string {
  return `Another T1Code or T3 Code server already owns ${baseDir}. Stop it, or attach to it with T1CODE_TUI_ATTACH_ONLY=1.`;
}

export function resolveServerCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const node = env.T1CODE_NODE_BIN?.trim() || "node";
  if (NodeFS.existsSync(BUNDLED_SERVER_ENTRY)) {
    return { command: node, args: [BUNDLED_SERVER_ENTRY] };
  }
  if (env.NODE_ENV === "production") {
    return { command: node, args: [NodePath.join(SERVER_APP_DIR, "dist", "bin.mjs")] };
  }
  return { command: node, args: [NodePath.join(SERVER_APP_DIR, "src", "bin.ts")] };
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
    "--auto-bootstrap-project-from-cwd",
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
  const host = normalizeHost(options.host);
  const endpoint = buildServerEndpoint(host, port);
  const { command, args: entryArgs } = resolveServerCommand(env);
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
      cwd: options.cwd ?? process.cwd(),
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
      options.onExit?.({ code, signal });
      if (stopped) return;
      if (code === SERVER_EXIT_CODE_STATE_DIR_OWNED) {
        const message = stateDirOwnedMessage(options.baseDir);
        fatalStartupError = message;
        events.emit("fatal", message);
        options.onFatal?.(message);
        return;
      }
      if (!restartOnExit || (!ready && fatalStartupError)) return;
      restartAttempt += 1;
      options.onLog?.("server.restart", { attempt: restartAttempt });
      options.onRestart?.({ attempt: restartAttempt });
      events.emit("restart", restartAttempt);
      restartTimer = setTimeoutImpl(() => {
        restartTimer = null;
        if (!stopped) spawnChild();
      }, restartDelayMs);
    });
    return spawned;
  };

  const stop = () => {
    stopped = true;
    if (restartTimer !== null) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode) return;
    current.kill("SIGTERM");
    const escalate = setTimeoutImpl(() => {
      if (current.exitCode === null && !current.signalCode) current.kill("SIGKILL");
    }, killGraceMs);
    escalate.unref?.();
    current.once("exit", () => clearTimeoutImpl(escalate));
  };

  const first = spawnChild();
  let environment: EnvironmentSummary;
  try {
    environment = await waitUntilReady({
      httpBaseUrl: endpoint.httpBaseUrl,
      timeoutMs: options.readyTimeoutMs ?? 20_000,
      process: first,
    });
  } catch (error) {
    // Don't leave a slow server running and holding the data directory.
    stop();
    if (fatalStartupError) throw new Error(fatalStartupError, { cause: error });
    throw error;
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
    // it would revoke the bearer that Rex thread tabs share.
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
