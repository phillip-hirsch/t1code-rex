// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { isProcessAlive } from "./health.ts";

/**
 * How a second tr3x process finds the daemon that owns the server. The owner
 * writes this after its server is ready and removes it when it stops. It holds
 * no secrets, but clients trust its endpoints, so it is 0600 inside a 0700
 * directory and readers refuse anything else.
 */
export const DaemonState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  /** When the daemon process started, to tell it apart from a later process that reused its pid. */
  startedAt: Schema.String,
  serverPid: Schema.NullOr(Schema.Int),
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  environmentId: Schema.String,
});
export type DaemonState = typeof DaemonState.Type;

const decodeDaemonState = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonState));
const encodeDaemonState = Schema.encodeSync(Schema.fromJsonString(DaemonState));

/**
 * This process's start time, read from `ps` as `isDaemonAlive` reads it, so a
 * wall-clock step after startup can't make a live owner look like a newer process.
 */
export function currentProcessStartedAt(): string {
  const started = processStartTime(process.pid) ?? Date.now() - process.uptime() * 1_000;
  return new Date(started).toISOString();
}

/** The state file or its directory could be swapped or read by someone else. */
export class UnsafeDaemonStateError extends Error {}

function assertPrivate(stats: NodeFS.Stats, path: string, kind: "directory" | "file"): void {
  const isKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!isKind) throw new UnsafeDaemonStateError(`${path} is not a ${kind}.`);
  if (stats.uid !== process.getuid?.()) {
    throw new UnsafeDaemonStateError(`${path} is owned by uid ${stats.uid}, not this user.`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new UnsafeDaemonStateError(
      `${path} is accessible to other users (mode ${(stats.mode & 0o777).toString(8)}).`,
    );
  }
}

/** Creates the directory if needed, then requires a real 0700 directory owned by this user. */
export function ensurePrivateDir(dir: string): void {
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // lstat: a symlink fails the directory check instead of being followed.
  const stats = NodeFS.lstatSync(dir);
  if (stats.isDirectory() && stats.uid === process.getuid?.()) NodeFS.chmodSync(dir, 0o700);
  assertPrivate(NodeFS.lstatSync(dir), dir, "directory");
}

export function writeDaemonState(path: string, state: DaemonState): void {
  ensurePrivateDir(NodePath.dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.rmSync(temp, { force: true });
  NodeFS.writeFileSync(temp, `${encodeDaemonState(state)}\n`, { mode: 0o600, flag: "wx" });
  NodeFS.renameSync(temp, path);
}

/**
 * Reads the state file as written. `undefined` when it's missing or corrupt.
 * Throws `UnsafeDaemonStateError` when the directory or file isn't private to
 * this user, or either is a symlink.
 */
export function readDaemonState(path: string): DaemonState | undefined {
  const dir = NodePath.dirname(path);
  let dirStats: NodeFS.Stats;
  try {
    dirStats = NodeFS.lstatSync(dir);
  } catch {
    return undefined;
  }
  assertPrivate(dirStats, dir, "directory");
  let fd: number;
  try {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UnsafeDaemonStateError(`${path} is a symlink.`);
    }
    throw error;
  }
  let contents: string;
  try {
    // Check what was opened, not the path, so a swap after the check can't slip through.
    assertPrivate(NodeFS.fstatSync(fd), path, "file");
    contents = NodeFS.readFileSync(fd, "utf8");
  } finally {
    NodeFS.closeSync(fd);
  }
  try {
    return decodeDaemonState(contents.trim());
  } catch {
    return undefined;
  }
}

/** Removes the state file only if `pid` wrote it, so a stopping daemon never deletes its successor's. */
export function removeDaemonState(path: string, pid: number): void {
  let owner: number | undefined;
  try {
    owner = readDaemonState(path)?.pid;
  } catch {
    return;
  }
  if (owner === pid) NodeFS.rmSync(path, { force: true });
}

/**
 * The recorded daemon is alive when its pid exists and that process started no
 * later than recorded. After a crash the file stays behind; a dead pid, or a pid
 * reused by a newer process, makes it stale.
 */
export function isDaemonAlive(state: DaemonState): boolean {
  if (!isProcessAlive(state.pid)) return false;
  const recorded = Date.parse(state.startedAt);
  const started = processStartTime(state.pid);
  // Both sides come from `ps`, in whole seconds. Unknown identity stays conservative.
  return started === undefined || !Number.isFinite(recorded) || started <= recorded + 1_000;
}

function processStartTime(pid: number): number | undefined {
  const result = NodeChildProcess.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    timeout: 2_000,
  });
  const output = result.status === 0 ? result.stdout.trim() : "";
  const started = output ? Date.parse(`${output} UTC`) : Number.NaN;
  return Number.isFinite(started) ? started : undefined;
}

/** The live owner's state, or `undefined` when no daemon owns the server. */
export function readLiveDaemonState(path: string): DaemonState | undefined {
  const state = readDaemonState(path);
  return state !== undefined && isDaemonAlive(state) ? state : undefined;
}

const RecordedServer = Schema.Struct({ pid: Schema.Int, origin: Schema.String });
const decodeRecordedServer = Schema.decodeUnknownSync(Schema.fromJsonString(RecordedServer));

/** The live server named by the T3 server's own `server-runtime.json`, whoever started it. */
export function readRecordedServer(
  serverRuntimeStatePath: string,
): { readonly pid: number; readonly origin: string } | undefined {
  try {
    const recorded = decodeRecordedServer(NodeFS.readFileSync(serverRuntimeStatePath, "utf8"));
    return isProcessAlive(recorded.pid) ? recorded : undefined;
  } catch {
    return undefined;
  }
}
