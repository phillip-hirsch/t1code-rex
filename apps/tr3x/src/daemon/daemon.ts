// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The daemon runs on Bun outside the Effect runtime.
import * as NodeFS from "node:fs";

import type { Tr3xPaths } from "../paths.ts";
import { describeError, redactSecrets } from "../redact.ts";
import {
  currentProcessStartedAt,
  type DaemonState,
  ensurePrivateDir,
  readLiveDaemonState,
  readRecordedServer,
  removeDaemonState,
  writeDaemonState,
} from "./daemonState.ts";
import { describeServer, fetchEnvironmentSummary, isProcessAlive } from "./health.ts";
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
          onLog: (event, details) => {
            if (event !== "server.stderr" || typeof details?.chunk !== "string") return;
            stderrTail.push(...redactSecrets(details.chunk).split("\n"));
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
    let written = await publishState(paths, server);
    log(
      `started ${describeServer(server.environment, server.httpBaseUrl)} (server pid ${server.process.pid}, daemon pid ${process.pid})`,
    );
    server.events.on("restart", (attempt) => {
      log(`server exited unexpectedly; restarting (attempt ${attempt})`);
      if (stderrTail.length > 0) log(`server output:\n${stderrTail.join("\n")}`);
    });
    const fatalSignal = new Promise<void>((resolve) => {
      server.events.once("fatal", (message) => {
        fatal = message;
        resolve();
      });
    });
    stopHealth = reportHealth(options, server.httpBaseUrl, async () => {
      // A restarted server has a new pid and may need a new bearer.
      if (server.process.pid !== written.serverPid) written = await publishState(paths, server);
      else if ((await server.getBearerToken()) !== written.bearerToken) {
        written = await publishState(paths, server);
      }
    });
    await Promise.race([abortPromise(signal), fatalSignal]);
  } finally {
    stopHealth();
    if (fatal !== undefined) log(fatal);
    log(`stopping server (pid ${server.process.pid})`);
    await server.stop();
    removeDaemonState(paths.daemonStatePath, process.pid);
    log("server stopped");
  }
  return fatal === undefined ? 0 : 1;
}

async function publishState(paths: Tr3xPaths, server: ManagedServer): Promise<DaemonState> {
  const state: DaemonState = {
    version: 1,
    pid: process.pid,
    startedAt: currentProcessStartedAt(),
    serverPid: server.process.pid ?? null,
    httpBaseUrl: server.httpBaseUrl,
    wsBaseUrl: server.wsBaseUrl,
    environmentId: server.environment.environmentId,
    bearerToken: await server.getBearerToken(),
  };
  writeDaemonState(paths.daemonStatePath, state);
  return state;
}

async function watchOwner(options: DaemonOptions, owner: DaemonState): Promise<void> {
  const { log, signal } = options;
  const summary = await fetchEnvironmentSummary(owner.httpBaseUrl).catch(() => undefined);
  log(
    `attached to daemon ${owner.pid}: ${
      summary === undefined
        ? `T3 server at ${owner.httpBaseUrl} (not responding yet)`
        : describeServer(summary, owner.httpBaseUrl)
    }`,
  );
  log(
    `this daemon doesn't own the server and won't stop it; it takes over if daemon ${owner.pid} exits`,
  );
  const ownerGone = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (isProcessAlive(owner.pid)) return;
      clearInterval(timer);
      resolve();
    }, 500);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  });
  const stopHealth = reportHealth(options, owner.httpBaseUrl);
  await Promise.race([abortPromise(signal), ownerGone]);
  stopHealth();
}

/** Checks the server on an interval and logs only when its health changes. */
function reportHealth(
  options: DaemonOptions,
  httpBaseUrl: string,
  onHealthy?: () => Promise<void>,
): () => void {
  let healthy = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fetchEnvironmentSummary(httpBaseUrl);
      if (!healthy) options.log("server healthy again");
      healthy = true;
      await onHealthy?.();
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
