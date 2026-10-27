// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitForOwnerExit } from "./daemon.ts";
import { currentProcessStartedAt, type DaemonState } from "./daemonState.ts";

const children: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function owner(pid: number, startedAt: string): DaemonState {
  return {
    version: 1,
    pid,
    startedAt,
    serverPid: null,
    httpBaseUrl: "http://127.0.0.1:43111",
    wsBaseUrl: "ws://127.0.0.1:43111",
    environmentId: "env-1",
  };
}

async function settlesAfterPolls(owner: DaemonState, polls: number): Promise<boolean> {
  vi.useFakeTimers();
  let settled = false;
  void waitForOwnerExit(owner, new AbortController().signal, 10).then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(10 * polls);
  return settled;
}

describe("waitForOwnerExit", () => {
  it("waits while the owner runs", async () => {
    expect(await settlesAfterPolls(owner(process.pid, currentProcessStartedAt()), 5)).toBe(false);
  });

  it("treats the owner's pid, now held by a newer process, as the owner exiting", async () => {
    // A live pid whose process started an hour after the recorded owner did:
    // what a watcher sees once the owner died and its pid was reused.
    const child = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    const anHourEarlier = new Date(Date.parse(currentProcessStartedAt()) - 3_600_000);
    expect(await settlesAfterPolls(owner(child.pid!, anHourEarlier.toISOString()), 1)).toBe(true);
    expect(child.exitCode).toBeNull();
  });
});
