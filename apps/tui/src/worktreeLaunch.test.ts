import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorktreeLaunch,
  WORKTREE_FAILED_NOTICE,
  WORKTREE_PREPARING_NOTICE,
  WORKTREE_STOPPED_NOTICE,
  worktreeBlockOf,
  worktreeSendBlock,
} from "./worktreeLaunch.ts";

type Run = OrchestrationV2ThreadProjection["runs"][number];
type Item = OrchestrationV2ThreadProjection["turnItems"][number];

function run(id: string, ordinal: number, overrides: Partial<Run> = {}): Run {
  return {
    id,
    ordinal,
    status: "completed",
    startedAt: "2026-10-27T10:00:00.000Z",
    completedAt: null,
    workspacePreparation: { type: "worktree", baseRef: "main" },
    ...overrides,
  } as Run;
}

function preparationFailure(runId: string): Item {
  return {
    type: "error",
    status: "failed",
    runId,
    failure: { code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE },
  } as Item;
}

const noWorktree = { worktreePath: null };

describe("deriveWorktreeLaunch", () => {
  it("is preparing while the latest run makes its worktree", () => {
    expect(
      deriveWorktreeLaunch({
        thread: noWorktree,
        runs: [run("r1", 1, { status: "preparing" })],
        turnItems: [],
      }),
    ).toEqual({ runId: "r1", status: "preparing", baseRef: "main", retryable: false });
  });

  it("is failed, and retryable, when that preparation failed, with a message queued behind", () => {
    expect(
      deriveWorktreeLaunch({
        thread: noWorktree,
        runs: [run("r1", 1, { status: "failed" }), run("r2", 2, { status: "queued" })],
        turnItems: [preparationFailure("r1")],
      }),
    ).toEqual({ runId: "r1", status: "failed", baseRef: "main", retryable: true });
  });

  it("stays failed after a later run, as the server keeps holding queued messages", () => {
    // A run that started in the project checkout anyway (an older client) doesn't resolve it.
    expect(
      deriveWorktreeLaunch({
        thread: noWorktree,
        runs: [
          run("r1", 1, {
            status: "failed",
            completedAt: DateTime.makeUnsafe("2026-10-27T10:01:00.000Z"),
          }),
          run("r2", 2, { status: "running", workspacePreparation: undefined }),
        ],
        turnItems: [preparationFailure("r1")],
      }),
    ).toMatchObject({ runId: "r1", status: "failed" });
  });

  it("counts a stopped preparation, which can't be retried", () => {
    expect(
      deriveWorktreeLaunch({
        thread: noWorktree,
        runs: [run("r1", 1, { status: "interrupted" })],
        turnItems: [],
      }),
    ).toEqual({ runId: "r1", status: "failed", baseRef: "main", retryable: false });
  });

  it("is resolved once the thread has a worktree, or never asked for one", () => {
    expect(
      deriveWorktreeLaunch({
        thread: { worktreePath: "/wt" },
        runs: [run("r1", 1, { status: "failed" })],
        turnItems: [preparationFailure("r1")],
      }),
    ).toBeNull();
    expect(
      deriveWorktreeLaunch({
        thread: noWorktree,
        runs: [run("r1", 1, { status: "failed", workspacePreparation: undefined })],
        turnItems: [],
      }),
    ).toBeNull();
  });
});

describe("worktreeSendBlock", () => {
  const failed = {
    runId: RunId.make("r1"),
    status: "failed",
    baseRef: "main",
    retryable: true,
  } as const;
  it("blocks sends until the worktree exists, and names the way on", () => {
    expect(worktreeSendBlock({ worktreePath: null, launch: failed })).toBe(WORKTREE_FAILED_NOTICE);
    expect(worktreeSendBlock({ worktreePath: null, launch: { ...failed, retryable: false } })).toBe(
      WORKTREE_STOPPED_NOTICE,
    );
    expect(worktreeSendBlock({ worktreePath: "/wt", launch: failed })).toBeNull();
    expect(
      worktreeSendBlock({ worktreePath: null, launch: { ...failed, status: "preparing" } }),
    ).toBe(WORKTREE_PREPARING_NOTICE);
  });

  it("reads a projection the same way", () => {
    expect(
      worktreeBlockOf({
        thread: noWorktree,
        runs: [run("r1", 1, { status: "failed" })],
        turnItems: [preparationFailure("r1")],
      }),
    ).toBe(WORKTREE_FAILED_NOTICE);
  });
});
