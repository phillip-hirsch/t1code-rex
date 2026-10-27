import { workspacePreparationRetryRunIds } from "@t3tools/client-runtime/state/turn-item-presentation";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * A thread's launch into a new worktree that hasn't given it one yet, as the server has it:
 * the latest run is still preparing the worktree, or a preparation failed or was stopped
 * and the thread still has no worktree.
 */
export interface WorktreeLaunch {
  readonly runId: RunId;
  readonly status: "preparing" | "failed";
  readonly baseRef: string;
  /** A failed one the server can prepare again (`prepared-run.retry`). */
  readonly retryable: boolean;
}

type LaunchProjection = Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems"> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "worktreePath">;
};

/**
 * The thread's worktree launch; null when there's none. "failed" is the server's own rule
 * (`worktreeSetupUnresolved` in its Orchestrator): any run whose worktree preparation
 * failed or was stopped, while the thread has no worktree. The server holds queued messages
 * for exactly as long, and only a retry that makes the worktree ends it.
 */
export function deriveWorktreeLaunch(projection: LaunchProjection): WorktreeLaunch | null {
  const latest = latestExecutedRun(projection.runs);
  if (latest?.status === "preparing" && latest.workspacePreparation?.type === "worktree") {
    const { baseRef } = latest.workspacePreparation;
    return { runId: latest.id, status: "preparing", baseRef, retryable: false };
  }
  if (projection.thread.worktreePath !== null) return null;
  const failed = latestExecutedRun(
    projection.runs.filter(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    ),
  );
  if (failed?.workspacePreparation?.type !== "worktree") return null;
  return {
    runId: failed.id,
    status: "failed",
    baseRef: failed.workspacePreparation.baseRef,
    retryable: workspacePreparationRetryRunIds([failed], projection.turnItems).has(failed.id),
  };
}

export function sameWorktreeLaunch(a: WorktreeLaunch | null, b: WorktreeLaunch | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.runId === b.runId &&
      a.status === b.status &&
      a.baseRef === b.baseRef &&
      a.retryable === b.retryable)
  );
}

export const WORKTREE_PREPARING_NOTICE =
  "The new worktree is still being set up; send once it's ready";
export const WORKTREE_FAILED_NOTICE =
  "Worktree setup failed. /worktree retry, or start a new thread to work in the project checkout";
export const WORKTREE_STOPPED_NOTICE =
  "Worktree setup stopped and can't be retried; start a new thread to keep working";

/**
 * Why nothing may start on this thread now, neither a message nor a release of the queue
 * the server holds: it would run in the project's checkout while the thread is meant to
 * work in a worktree that isn't there.
 */
export function worktreeSendBlock(input: {
  readonly worktreePath: string | null;
  readonly launch: WorktreeLaunch | null;
}): string | null {
  const { launch } = input;
  if (launch === null || input.worktreePath !== null) return null;
  if (launch.status === "preparing") return WORKTREE_PREPARING_NOTICE;
  return launch.retryable ? WORKTREE_FAILED_NOTICE : WORKTREE_STOPPED_NOTICE;
}

/** `worktreeSendBlock` for a thread's loaded projection. */
export function worktreeBlockOf(projection: LaunchProjection): string | null {
  return worktreeSendBlock({
    worktreePath: projection.thread.worktreePath,
    launch: deriveWorktreeLaunch(projection),
  });
}

/** A thread as the server had it once the guard started watching, over HTTP. */
export type ServerLaunchView =
  | { readonly _tag: "missing" }
  | {
      readonly _tag: "present";
      readonly projection: LaunchProjection & {
        readonly updatedAt: DateTime.Utc;
      };
    };

/**
 * `worktreeBlockOf` for the live state once it agrees with `server`, fetched after watching
 * started, or has moved past it; undefined until then. A warm remount shows kept state as
 * live before its replay, and that state can predate a preparation that failed meanwhile.
 */
export function confirmedWorktreeBlock(
  live: {
    readonly status: string;
    readonly data: Option.Option<LaunchProjection & { readonly updatedAt: DateTime.Utc }>;
  },
  server: ServerLaunchView | undefined,
): string | null | undefined {
  // The server turns the send down itself.
  if (live.status === "deleted" || server?._tag === "missing") return null;
  if (server === undefined || live.status !== "live" || Option.isNone(live.data)) return undefined;
  const block = worktreeBlockOf(live.data.value);
  const agrees = (block === null) === (worktreeBlockOf(server.projection) === null);
  const newer =
    DateTime.toEpochMillis(live.data.value.updatedAt) >
    DateTime.toEpochMillis(server.projection.updatedAt);
  return agrees || newer ? block : undefined;
}
