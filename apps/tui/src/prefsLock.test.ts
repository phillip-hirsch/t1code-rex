// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquirePrefsLock,
  isProcessAlive,
  prefsLockPath,
  resolvePrefsAccess,
} from "./prefsLock.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function makePrefsPath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-prefs-lock-"));
  tempRoots.push(root);
  // The config dir doesn't exist yet, as on a first launch.
  return NodePath.join(root, "config", "prefs.json");
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const { pid } = NodeChildProcess.spawnSync("true");
  if (pid === undefined || isProcessAlive(pid)) throw new Error("expected an exited pid");
  return pid;
}

// Two live pids: this test process and its parent.
const OTHER_WINDOW = process.ppid;
const THIS_WINDOW = process.pid;

describe("acquirePrefsLock", () => {
  it("creates the lock holding the owner's pid and removes it on release", () => {
    const prefsPath = makePrefsPath();
    const lock = acquirePrefsLock(prefsPath, THIS_WINDOW);
    expect(lock).not.toBeNull();
    expect(NodeFS.readFileSync(prefsLockPath(prefsPath), "utf8")).toBe(`${THIS_WINDOW}\n`);
    expect(NodeFS.readdirSync(NodePath.dirname(prefsPath))).toEqual(["prefs.json.lock"]);

    lock?.release();
    lock?.release();
    expect(NodeFS.existsSync(prefsLockPath(prefsPath))).toBe(false);
  });

  it("leaves a second window read-only while the owner is alive", () => {
    const prefsPath = makePrefsPath();
    const owner = acquirePrefsLock(prefsPath, OTHER_WINDOW);
    expect(owner).not.toBeNull();

    expect(acquirePrefsLock(prefsPath, THIS_WINDOW)).toBeNull();
    expect(NodeFS.readFileSync(prefsLockPath(prefsPath), "utf8")).toBe(`${OTHER_WINDOW}\n`);

    // Once the owner quits, the next window takes the lock.
    owner?.release();
    const next = acquirePrefsLock(prefsPath, THIS_WINDOW);
    expect(next).not.toBeNull();
    expect(NodeFS.readFileSync(prefsLockPath(prefsPath), "utf8")).toBe(`${THIS_WINDOW}\n`);
    next?.release();
  });

  it("takes over a lock whose owner died", () => {
    const prefsPath = makePrefsPath();
    NodeFS.mkdirSync(NodePath.dirname(prefsPath), { recursive: true });
    NodeFS.writeFileSync(prefsLockPath(prefsPath), `${deadPid()}\n`);

    const lock = acquirePrefsLock(prefsPath, THIS_WINDOW);
    expect(lock).not.toBeNull();
    expect(NodeFS.readFileSync(prefsLockPath(prefsPath), "utf8")).toBe(`${THIS_WINDOW}\n`);
    lock?.release();
  });

  it("takes over an unreadable lock", () => {
    const prefsPath = makePrefsPath();
    NodeFS.mkdirSync(NodePath.dirname(prefsPath), { recursive: true });
    NodeFS.writeFileSync(prefsLockPath(prefsPath), "not a pid");

    expect(acquirePrefsLock(prefsPath, THIS_WINDOW)).not.toBeNull();
  });

  it("doesn't remove a lock another window took over", () => {
    const prefsPath = makePrefsPath();
    const stale = acquirePrefsLock(prefsPath, deadPid());
    const live = acquirePrefsLock(prefsPath, OTHER_WINDOW);
    expect(live).not.toBeNull();

    stale?.release();
    expect(NodeFS.readFileSync(prefsLockPath(prefsPath), "utf8")).toBe(`${OTHER_WINDOW}\n`);
    live?.release();
  });
});

describe("resolvePrefsAccess", () => {
  it("makes the first main window the owner and later ones read-only", () => {
    const prefsPath = makePrefsPath();
    const first = resolvePrefsAccess({ prefsPath, pid: OTHER_WINDOW, wantsWrites: true });
    expect(first.kind).toBe("owner");
    expect(resolvePrefsAccess({ prefsPath, pid: THIS_WINDOW, wantsWrites: true })).toEqual({
      kind: "locked-out",
    });

    if (first.kind === "owner") first.lock.release();
    const next = resolvePrefsAccess({ prefsPath, pid: THIS_WINDOW, wantsWrites: true });
    expect(next.kind).toBe("owner");
    if (next.kind === "owner") next.lock.release();
  });

  it("never locks for a thread tab", () => {
    const prefsPath = makePrefsPath();
    expect(resolvePrefsAccess({ prefsPath, pid: THIS_WINDOW, wantsWrites: false })).toEqual({
      kind: "reader",
    });
    expect(NodeFS.existsSync(prefsLockPath(prefsPath))).toBe(false);
  });
});
