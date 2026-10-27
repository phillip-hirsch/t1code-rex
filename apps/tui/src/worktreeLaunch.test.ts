import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmedWorktreeBlock,
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

describe("confirmedWorktreeBlock", () => {
  const view = (time: string, failed: boolean) => ({
    thread: failed ? noWorktree : { worktreePath: "/wt" },
    runs: [run("r1", 1, { status: failed ? "failed" : "completed" })],
    turnItems: failed ? [preparationFailure("r1")] : [],
    updatedAt: DateTime.makeUnsafe(`2026-10-27T10:${time}:00.000Z`),
  });
  const live = (projection: ReturnType<typeof view>, status = "live") => ({
    status,
    data: Option.some(projection),
  });
  const server = (projection: ReturnType<typeof view>) => ({
    _tag: "present" as const,
    projection,
  });

  it("knows nothing before the server's snapshot, or while the live state isn't live", () => {
    expect(confirmedWorktreeBlock(live(view("01", false)), undefined)).toBeUndefined();
    expect(
      confirmedWorktreeBlock(live(view("01", false), "synchronizing"), server(view("01", false))),
    ).toBeUndefined();
    expect(
      confirmedWorktreeBlock({ status: "live", data: Option.none() }, server(view("01", false))),
    ).toBeUndefined();
  });

  it("waits while kept live state that predates the server's disagrees with it", () => {
    expect(
      confirmedWorktreeBlock(live(view("00", false)), server(view("01", true))),
    ).toBeUndefined();
    expect(
      confirmedWorktreeBlock(live(view("00", true)), server(view("01", false))),
    ).toBeUndefined();
  });

  it("answers from the live state once it agrees with the server, or has moved past it", () => {
    expect(confirmedWorktreeBlock(live(view("01", true)), server(view("01", true)))).toBe(
      WORKTREE_FAILED_NOTICE,
    );
    expect(confirmedWorktreeBlock(live(view("00", false)), server(view("01", false)))).toBeNull();
    // A retry after the snapshot made the worktree.
    expect(confirmedWorktreeBlock(live(view("02", false)), server(view("01", true)))).toBeNull();
  });

  it("lets the server turn down a send to a thread it doesn't have", () => {
    expect(confirmedWorktreeBlock(live(view("00", true)), { _tag: "missing" })).toBeNull();
    expect(
      confirmedWorktreeBlock({ status: "deleted", data: Option.none() }, server(view("01", true))),
    ).toBeNull();
  });
});
