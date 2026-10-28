// @effect-diagnostics globalTimers:off -- Test teardown for real processes, outside any Effect runtime.
import { isProcessAlive } from "../daemon/health.ts";
import { CLI, spawnBun, STARTED, waitForLine, type BunProcess } from "./bunProcess.ts";
import { commandLine, liveFakeProviders } from "./fakeProviders.ts";

/** How long each stage of teardown waits before it forces the next step. */
const DAEMON_STOP_MS = 20_000;
const PROCESS_EXIT_MS = 10_000;

export interface DaemonStopReport {
  readonly daemonCode: number | null;
  /** Each stage teardown had to force, empty when the daemon shut everything down itself. */
  readonly forced: ReadonlyArray<string>;
}

export interface DaemonFixture {
  readonly daemon: BunProcess;
  /** The server the daemon started, once it reported it. */
  readonly started: Promise<number>;
  /**
   * Stops the daemon with SIGTERM and waits for it and its server to exit, then
   * reaps fake providers the server left behind. Every stage is bounded and
   * forces with SIGKILL past its limit. Safe to call more than once.
   */
  readonly stop: () => Promise<DaemonStopReport>;
}

/** Resolves true once `pid` has exited, or false after `timeoutMs`. Not our child, so probe it. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = AbortSignal.timeout(timeoutMs);
  while (isProcessAlive(pid)) {
    if (deadline.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** `promise`'s value, or `undefined` after `timeoutMs`. */
function within<A>(promise: Promise<A>, timeoutMs: number): Promise<A | undefined> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve) => {
    deadline.addEventListener("abort", () => resolve(undefined), { once: true });
    void promise.then(resolve);
  });
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // It exited since we looked.
  }
}

/** SIGTERM, then SIGKILL past the limit. */
async function terminate(pid: number): Promise<void> {
  signal(pid, "SIGTERM");
  if (await waitForExit(pid, PROCESS_EXIT_MS)) return;
  signal(pid, "SIGKILL");
  await waitForExit(pid, PROCESS_EXIT_MS);
}

/** Starts `tr3x daemon` on Bun in `home`; pair it with an unconditional `stop()` in teardown. */
export function startDaemon(home: string): DaemonFixture {
  const daemon = spawnBun([CLI, "daemon"], { TR3X_HOME: home }, () => {});
  let serverPid: number | undefined;
  const started = waitForLine(daemon, STARTED).then((match) => {
    serverPid = Number(match[1]);
    return serverPid;
  });
  // A daemon that never starts rejects `started`; `stop` still runs.
  started.catch(() => {});
  let stopping: Promise<DaemonStopReport> | undefined;
  const stop = async (): Promise<DaemonStopReport> => {
    const forced: string[] = [];
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      daemon.child.kill("SIGTERM");
      if ((await within(daemon.exited, DAEMON_STOP_MS)) === undefined) {
        forced.push("daemon");
        daemon.child.kill("SIGKILL");
      }
    }
    const daemonCode = await daemon.exited;
    // The daemon waits for its server, so one still running was left behind; only ours, by its base dir.
    if (serverPid !== undefined && commandLine(serverPid)?.includes(`--base-dir ${home}`)) {
      await terminate(serverPid);
      forced.push("server");
    }
    const providers = liveFakeProviders(home);
    for (const pid of providers) await terminate(pid);
    if (providers.length > 0) forced.push(`${providers.length} fake provider(s)`);
    return { daemonCode, forced };
  };
  return {
    daemon,
    started,
    stop: () => (stopping ??= stop()),
  };
}
