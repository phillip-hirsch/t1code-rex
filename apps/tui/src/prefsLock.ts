// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
// Bun-only: `bun:sqlite` doesn't load on Node, so Vitest tests must not import this module.
// prefsLock.test.ts drives it through Bun subprocesses (prefsLockTestProbe.ts) instead.
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface PrefsLock {
  /** Releases the lock. Safe to call more than once. */
  readonly release: () => void;
}

/** A SQLite file that exists only to be locked. Older builds used a pid file named `prefs.json.lock`; it's ignored. */
export function prefsLockPath(prefsPath: string): string {
  return NodePath.join(NodePath.dirname(prefsPath), "prefs.lock.db");
}

/**
 * Two windows starting together can each hold SQLite's shared lock for an instant, which
 * makes the other's upgrade to exclusive fail. Waiting this long lets the loser back off so
 * the winner gets the lock. A window that finds the lock held waits this long once, at startup.
 */
const CONTENTION_WAIT_MS = 100;

function isBusy(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === "SQLITE_BUSY";
}

/**
 * Makes this process the only prefs writer, or returns null while another process holds the lock.
 * The lock is an exclusive SQLite transaction kept open until release; the OS frees it when the
 * holder dies, so it's never stale. Don't set `locking_mode = EXCLUSIVE`: Bun on macOS uses the
 * system SQLite, which then takes no cross-process lock.
 */
export function acquirePrefsLock(prefsPath: string): PrefsLock | null {
  const lockPath = prefsLockPath(prefsPath);
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  const db = new Database(lockPath, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${CONTENTION_WAIT_MS}`);
    db.run("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (isBusy(error)) return null;
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}

/**
 * How a window may use prefs.json: the owner writes it, a Rex thread tab (or a headless
 * run) only reads it, and a main window that lost the lock to another one only reads it
 * and says so. `error` is set when the lock couldn't be taken for another reason.
 */
export type PrefsAccess =
  | { readonly kind: "owner"; readonly lock: PrefsLock }
  | { readonly kind: "reader" }
  | { readonly kind: "locked-out"; readonly error?: string };

export function resolvePrefsAccess(input: {
  readonly prefsPath: string;
  /** False for Rex thread tabs and headless runs, which never write prefs. */
  readonly wantsWrites: boolean;
}): PrefsAccess {
  if (!input.wantsWrites) return { kind: "reader" };
  try {
    const lock = acquirePrefsLock(input.prefsPath);
    return lock ? { kind: "owner", lock } : { kind: "locked-out" };
  } catch (error) {
    // Reading prefs without saving them beats refusing to start.
    return { kind: "locked-out", error: error instanceof Error ? error.message : String(error) };
  }
}
