// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real files and processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  currentProcessStartedAt,
  type DaemonState,
  readDaemonState,
  readLiveDaemonState,
  removeDaemonState,
  UnsafeDaemonStateError,
  writeDaemonState,
} from "./daemonState.ts";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function statePath(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-state-"));
  dirs.push(dir);
  return NodePath.join(dir, "daemon", "daemon.json");
}

function state(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    version: 1,
    pid: process.pid,
    startedAt: currentProcessStartedAt(),
    serverPid: 1234,
    httpBaseUrl: "http://127.0.0.1:43111",
    wsBaseUrl: "ws://127.0.0.1:43111",
    environmentId: "env-1",
    ...overrides,
  };
}

async function exitedPid(): Promise<number> {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

describe("daemon state", () => {
  it("is written 0600 inside a 0700 directory, replacing a stale file", () => {
    const path = statePath();
    NodeFS.mkdirSync(NodePath.dirname(path), { mode: 0o755 });
    NodeFS.writeFileSync(path, "stale", { mode: 0o644 });

    writeDaemonState(path, state());

    expect(NodeFS.statSync(NodePath.dirname(path)).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);
    expect(readDaemonState(path)).toEqual(state({ startedAt: readDaemonState(path)!.startedAt }));
  });

  it("names a live owner only while its process runs", async () => {
    const path = statePath();
    writeDaemonState(path, state());
    expect(readLiveDaemonState(path)?.pid).toBe(process.pid);

    writeDaemonState(path, state({ pid: await exitedPid() }));
    expect(readDaemonState(path)).toBeDefined();
    expect(readLiveDaemonState(path)).toBeUndefined();
  });

  it("treats a pid reused by a newer process as stale", () => {
    const path = statePath();
    const anHourBeforeThisProcess = new Date(Date.parse(currentProcessStartedAt()) - 3_600_000);
    writeDaemonState(path, state({ startedAt: anHourBeforeThisProcess.toISOString() }));
    expect(readLiveDaemonState(path)).toBeUndefined();
  });

  it("still names a live owner after the wall clock stepped back", () => {
    const path = statePath();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 3_600_000);
    writeDaemonState(path, state());
    expect(readLiveDaemonState(path)?.pid).toBe(process.pid);
  });

  it("ignores a missing or corrupt file", () => {
    const path = statePath();
    expect(readDaemonState(path)).toBeUndefined();
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(path, '{"version":1,"pid":', { mode: 0o600 });
    expect(readDaemonState(path)).toBeUndefined();
  });

  it("refuses a symlinked directory or file", () => {
    const path = statePath();
    writeDaemonState(path, state());
    const dir = NodePath.dirname(path);

    const linkedFile = NodePath.join(NodePath.dirname(dir), "linked-file", "daemon.json");
    NodeFS.mkdirSync(NodePath.dirname(linkedFile), { mode: 0o700 });
    NodeFS.symlinkSync(path, linkedFile);
    expect(() => readDaemonState(linkedFile)).toThrow(UnsafeDaemonStateError);
    expect(() => readDaemonState(linkedFile)).toThrow("is a symlink");

    const linkedDir = NodePath.join(NodePath.dirname(dir), "linked-dir");
    NodeFS.symlinkSync(dir, linkedDir);
    const viaLinkedDir = NodePath.join(linkedDir, "daemon.json");
    expect(() => readDaemonState(viaLinkedDir)).toThrow("is not a directory");
    expect(() => writeDaemonState(viaLinkedDir, state())).toThrow("is not a directory");
  });

  it("refuses a file or directory other users can access", () => {
    const path = statePath();
    writeDaemonState(path, state());
    NodeFS.chmodSync(path, 0o640);
    expect(() => readDaemonState(path)).toThrow("accessible to other users (mode 640)");
    expect(() => readLiveDaemonState(path)).toThrow(UnsafeDaemonStateError);

    NodeFS.chmodSync(path, 0o600);
    NodeFS.chmodSync(NodePath.dirname(path), 0o755);
    expect(() => readDaemonState(path)).toThrow("accessible to other users (mode 755)");
  });

  it("is removed only by the daemon that wrote it", () => {
    const path = statePath();
    writeDaemonState(path, state({ pid: 999_999 }));
    removeDaemonState(path, process.pid);
    expect(readDaemonState(path)?.pid).toBe(999_999);
    removeDaemonState(path, 999_999);
    expect(NodeFS.existsSync(path)).toBe(false);
  });
});
