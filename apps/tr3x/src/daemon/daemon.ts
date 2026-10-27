// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The daemon runs on Node outside the Effect runtime.
import * as NodeFS from "node:fs";

import type { Tr3xPaths } from "../paths.ts";
import { describeError, redactSecrets } from "../redact.ts";
import {
  currentProcessStartedAt,
  type DaemonState,
  ensurePrivateDir,
  isDaemonAlive,
  readLiveDaemonState,
  readRecordedServer,
  removeDaemonState,
  writeDaemonState,
} from "./daemonState.ts";
import { describeServer, fetchRecordedEnvironment, StaleServerError } from "./health.ts";
import { type ManagedServer, StateDirOwnedError, startManagedServer } from "./serverLauncher.ts";

export interface DaemonOptions {
  readonly paths: Tr3xPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly healthIntervalMs?: number;
  /** How long to wait for another server to release the base dir, e.g. one a crashed daemon left behind. */
  readonly busyTimeoutMs?: number;
}

const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
// A desktop-mode server notices its launcher is gone within 2 s, then shuts down.
const DEFAULT_BUSY_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 20;

type Acquired =
  | { readonly kind: "owner"; readonly server: ManagedServer; readonly stderrTail: string[] }
  | { readonly kind: "attached"; readonly owner: DaemonState };

/**
 * Runs until `signal` aborts. Returns the process exit code. The first daemon
 * starts the server and owns it; later ones attach, never stop it, and take
 * over if the owner exits.
 */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { paths, log, signal } = options;
  NodeFS.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  ensurePrivateDir(paths.daemonDir);
  log(`home ${paths.home}`);
  while (!signal.aborted) {
    const acquired = await acquire(options);
    if (acquired === undefined) break;
    if (acquired.kind === "owner")
      return await runOwner(options, acquired.server, acquired.stderrTail);
    await watchOwner(options, acquired.owner);
    if (!signal.aborted) log(`daemon ${acquired.owner.pid} exited; taking over`);
  }
  return 0;
}

async function acquire(options: DaemonOptions): Promise<Acquired | undefined> {
  const { paths, signal, log } = options;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  let busySince: number | undefined;
  while (!signal.aborted) {
    const owner = readLiveDaemonState(paths.daemonStatePath);
    if (owner !== undefined && owner.pid !== process.pid) return { kind: "attached", owner };
    const stderrTail: string[] = [];
    try {
      const server = await startManagedServer(
        {
          baseDir: paths.home,
          signal,
          onStderr: (line) => {
            stderrTail.push(redactSecrets(line));
            stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_TAIL_LINES));
          },
        },
        { env: options.env },
      );
      return { kind: "owner", server, stderrTail };
    } catch (error) {
      if (signal.aborted) return undefined;
      if (!(error instanceof StateDirOwnedError)) {
        if (stderrTail.length > 0) log(`server output:\n${stderrTail.join("\n")}`);
        throw error;
      }
      // Either a racing daemon is starting, or a server is still holding the dir.
      const now = Date.now();
      if (busySince === undefined) {
        busySince = now;
        log(
          `${paths.home} is in use by another T3 server${describeRecordedServer(paths)}; waiting`,
        );
      } else if (now - busySince > busyTimeoutMs) {
        throw new Error(
          `Another T3 server${describeRecordedServer(paths)} owns ${paths.home}, and no tr3x daemon started it. tr3x doesn't stop servers it didn't start: stop it, or set TR3X_HOME to another directory.`,
          { cause: error },
        );
      }
      await abortableSleep(500, signal);
    }
  }
  return undefined;
}

async function runOwner(
  options: DaemonOptions,
  server: ManagedServer,
  stderrTail: string[],
): Promise<number> {
  const { paths, log, signal } = options;
  let fatal: string | undefined;
  let stopHealth = () => {};
  try {
    let written = publishState(paths, server);
    log(
      `started ${describeServer(server.environment, server.httpBaseUrl)} (server pid ${server.process.pid}, daemon pid ${process.pid})`,
    );
    const logStderrTail = () => {
      if (stderrTail.length > 0) log(`server output:\n${stderrTail.join("\n")}`);
    };
    server.events.on("restart", (attempt, delayMs, reason) => {
      log(
        `server stopped unexpectedly (${redactSecrets(reason)}); restarting in ${delayMs} ms (attempt ${attempt})`,
      );
      logStderrTail();
    });
    const fatalSignal = new Promise<void>((resolve) => {
      server.events.once("fatal", (message) => {
        fatal = redactSecrets(message);
        logStderrTail();
        resolve();
      });
    });
    const recorded = {
      httpBaseUrl: server.httpBaseUrl,
      environmentId: server.environment.environmentId,
    };
    stopHealth = reportHealth(options, recorded, () => {
      // A restarted server has a new pid.
      if (server.process.pid !== written.serverPid) written = publishState(paths, server);
    });
    await Promise.race([abortPromise(signal), fatalSignal]);
  } finally {
    stopHealth();
    if (fatal !== undefined) log(fatal);
    const pid = server.process.pid;
    log(`stopping server${pid === undefined ? "" : ` (pid ${pid})`}`);
    await server.stop();
    removeDaemonState(paths.daemonStatePath, process.pid);
    log("server stopped");
  }
  return fatal === undefined ? 0 : 1;
}

function publishState(paths: Tr3xPaths, server: ManagedServer): DaemonState {
  const state: DaemonState = {
    version: 1,
    pid: process.pid,
    startedAt: currentProcessStartedAt(),
    serverPid: server.process.pid ?? null,
    httpBaseUrl: server.httpBaseUrl,
    wsBaseUrl: server.wsBaseUrl,
    environmentId: server.environment.environmentId,
  };
  writeDaemonState(paths.daemonStatePath, state);
  return state;
}

async function watchOwner(options: DaemonOptions, owner: DaemonState): Promise<void> {
  const { log, signal } = options;
  let server: string;
  try {
    server = describeServer(await fetchRecordedEnvironment(owner), owner.httpBaseUrl);
  } catch (error) {
    server =
      error instanceof StaleServerError
        ? `its state is stale: ${error.message}`
        : `T3 server at ${owner.httpBaseUrl} (not responding yet)`;
  }
  log(`attached to daemon ${owner.pid}: ${server}`);
  log(
    `this daemon doesn't own the server and won't stop it; it takes over if daemon ${owner.pid} exits`,
  );
  const stopHealth = reportHealth(options, owner);
  await Promise.race([abortPromise(signal), waitForOwnerExit(owner, signal)]);
  stopHealth();
}

/**
 * Resolves once the owner exits. Checks its start time on every poll, not just
 * at attach, so a pid reused by another process counts as the owner exiting.
 */
export function waitForOwnerExit(
  owner: DaemonState,
  signal: AbortSignal,
  intervalMs = 500,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isDaemonAlive(owner)) return;
      clearInterval(timer);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  });
}

/** Checks the server on an interval and logs only when its health changes. */
function reportHealth(
  options: DaemonOptions,
  recorded: Parameters<typeof fetchRecordedEnvironment>[0],
  onHealthy?: () => void,
): () => void {
  let healthy = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fetchRecordedEnvironment(recorded);
      if (!healthy) options.log("server healthy again");
      healthy = true;
      onHealthy?.();
    } catch (error) {
      if (healthy) options.log(`server not responding: ${describeError(error)}`);
      healthy = false;
    } finally {
      running = false;
    }
  }, options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
  return () => clearInterval(timer);
}

function describeRecordedServer(paths: Tr3xPaths): string {
  const recorded = readRecordedServer(paths.serverRuntimeStatePath);
  return recorded === undefined ? "" : ` (pid ${recorded.pid}, ${recorded.origin})`;
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
