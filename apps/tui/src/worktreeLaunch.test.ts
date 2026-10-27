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

describe("deriveWorktreeLaunch", () => {
  it("is preparing while the latest run makes its worktree", () => {
    expect(
      deriveWorktreeLaunch({ runs: [run("r1", 1, { status: "preparing" })], turnItems: [] }),
    ).toEqual({ runId: "r1", status: "preparing", baseRef: "main" });
  });

  it("is failed when that preparation failed or was cancelled, even with a message queued behind", () => {
    expect(
      deriveWorktreeLaunch({
        runs: [run("r1", 1, { status: "failed" }), run("r2", 2, { status: "queued" })],
        turnItems: [preparationFailure("r1")],
      }),
    ).toEqual({ runId: "r1", status: "failed", baseRef: "main" });
  });

  it("ignores runs that failed after the agent started, and later runs that moved on", () => {
    expect(
      deriveWorktreeLaunch({ runs: [run("r1", 1, { status: "failed" })], turnItems: [] }),
    ).toBeNull();
    expect(
      deriveWorktreeLaunch({
        runs: [
          run("r1", 1, {
            status: "failed",
            completedAt: DateTime.makeUnsafe("2026-10-27T10:01:00.000Z"),
          }),
          run("r2", 2, { status: "running", workspacePreparation: undefined }),
        ],
        turnItems: [preparationFailure("r1")],
      }),
    ).toBeNull();
  });
});

describe("worktreeSendBlock", () => {
  const failed = { runId: RunId.make("r1"), status: "failed", baseRef: "main" } as const;
  it("blocks sends until the worktree exists or the user works locally", () => {
    expect(worktreeSendBlock({ worktreePath: null, launch: failed, workingLocally: false })).toBe(
      WORKTREE_FAILED_NOTICE,
    );
    expect(
      worktreeSendBlock({ worktreePath: null, launch: failed, workingLocally: true }),
    ).toBeNull();
    expect(
      worktreeSendBlock({ worktreePath: "/wt", launch: failed, workingLocally: false }),
    ).toBeNull();
    expect(
      worktreeSendBlock({
        worktreePath: null,
        launch: { ...failed, status: "preparing" },
        workingLocally: true,
      }),
    ).toBe(WORKTREE_PREPARING_NOTICE);
  });
});
