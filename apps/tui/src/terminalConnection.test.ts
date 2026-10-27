import { ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runningTerminalIds, terminalAttachInput, writeChunkEnd } from "./terminalConnection.ts";

describe("terminalAttachInput", () => {
  it("starts the shell in the worktree with upstream's project variables", () => {
    expect(
      terminalAttachInput({
        threadId: ThreadId.make("t1"),
        terminalId: "term-2",
        cwd: "/repo/.worktrees/feature",
        worktreePath: "/repo/.worktrees/feature",
        projectRoot: "/repo",
      }),
    ).toEqual({
      threadId: "t1",
      terminalId: "term-2",
      cwd: "/repo/.worktrees/feature",
      worktreePath: "/repo/.worktrees/feature",
      env: { T3CODE_PROJECT_ROOT: "/repo", T3CODE_WORKTREE_PATH: "/repo/.worktrees/feature" },
    });
  });
});

describe("writeChunkEnd", () => {
  it("sends short input whole and cuts long input without splitting a surrogate pair", () => {
    expect(writeChunkEnd("ls\r")).toBe(3);
    expect(writeChunkEnd("a".repeat(40_000))).toBe(32_768);
    expect(writeChunkEnd(`${"a".repeat(32_767)}🙂b`)).toBe(32_767);
  });
});

describe("runningTerminalIds", () => {
  const summary = (
    threadId: string,
    terminalId: string,
    status: TerminalSummary["status"],
  ): TerminalSummary => ({
    threadId,
    terminalId,
    status,
    cwd: "/repo",
    worktreePath: null,
    pid: null,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: terminalId,
    updatedAt: "2026-10-27T00:00:00.000Z",
  });

  it("lists the thread's live shells in term-N order", () => {
    const summaries = [
      summary("t1", "term-10", "running"),
      summary("t1", "term-2", "starting"),
      summary("t1", "term-3", "exited"),
      summary("t2", "term-1", "running"),
    ];
    expect(runningTerminalIds(summaries, "t1")).toEqual(["term-2", "term-10"]);
    expect(runningTerminalIds(null, "t1")).toEqual([]);
  });
});
