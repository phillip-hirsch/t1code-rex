// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface PrefsLock {
  /** Removes the lock if this process still holds it. Safe to call more than once. */
  readonly release: () => void;
}

export function prefsLockPath(prefsPath: string): string {
  return `${prefsPath}.lock`;
}

/** True while `pid` names a running process, including one owned by another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockOwner(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(NodeFS.readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Creates the lock holding `pid`. The temp file is linked into place, so it's never empty. */
function tryCreateLock(lockPath: string, pid: number): boolean {
  const temporaryPath = `${lockPath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${pid}\n`);
  try {
    NodeFS.linkSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Makes `pid` the only process that writes the prefs file at `prefsPath`. Returns null while
 * another live process holds the lock; that window must treat prefs as read-only. A lock
 * whose owner has died (kill -9, crash) is taken over.
 */
export function acquirePrefsLock(prefsPath: string, pid: number): PrefsLock | null {
  const lockPath = prefsLockPath(prefsPath);
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  let created = tryCreateLock(lockPath, pid);
  if (!created) {
    const owner = readLockOwner(lockPath);
    if (owner !== null && owner !== pid && isProcessAlive(owner)) return null;
    // Stale (or unreadable): replace it. Two windows taking over the same stale lock at
    // the same instant could both win; that race is narrow enough to accept.
    NodeFS.rmSync(lockPath, { force: true });
    created = tryCreateLock(lockPath, pid);
    if (!created) return null;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      if (readLockOwner(lockPath) === pid) NodeFS.rmSync(lockPath, { force: true });
    },
  };
}

/**
 * How a window may use prefs.json: the owner writes it, a Rex thread tab (or a headless
 * run) only reads it, and a main window that lost the lock to another one only reads it
 * and says so.
 */
export type PrefsAccess =
  | { readonly kind: "owner"; readonly lock: PrefsLock }
  | { readonly kind: "reader" }
  | { readonly kind: "locked-out" };

export function resolvePrefsAccess(input: {
  readonly prefsPath: string;
  readonly pid: number;
  /** False for Rex thread tabs and headless runs, which never write prefs. */
  readonly wantsWrites: boolean;
}): PrefsAccess {
  if (!input.wantsWrites) return { kind: "reader" };
  const lock = acquirePrefsLock(input.prefsPath, input.pid);
  return lock ? { kind: "owner", lock } : { kind: "locked-out" };
}
