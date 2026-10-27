import { workspacePreparationRetryRunIds } from "@t3tools/client-runtime/state/turn-item-presentation";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * A thread's launch into a new worktree, as the server has it: the latest run is still
 * preparing the worktree, or its preparation failed or was cancelled.
 */
export interface WorktreeLaunch {
  readonly runId: RunId;
  readonly status: "preparing" | "failed";
  readonly baseRef: string;
}

/** The thread's worktree launch, from its latest executed run; null when there's none. */
export function deriveWorktreeLaunch(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): WorktreeLaunch | null {
  const run = latestExecutedRun(projection.runs);
  const preparation = run?.workspacePreparation;
  if (run === null || preparation?.type !== "worktree") return null;
  const launch = { runId: run.id, baseRef: preparation.baseRef };
  if (run.status === "preparing") return { ...launch, status: "preparing" };
  // A run can also fail after the agent started; only a failed preparation counts.
  if (
    run.status === "failed" &&
    workspacePreparationRetryRunIds([run], projection.turnItems).has(run.id)
  ) {
    return { ...launch, status: "failed" };
  }
  return null;
}

export function sameWorktreeLaunch(a: WorktreeLaunch | null, b: WorktreeLaunch | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.runId === b.runId &&
      a.status === b.status &&
      a.baseRef === b.baseRef)
  );
}

export const WORKTREE_PREPARING_NOTICE =
  "The new worktree is still being set up; send once it's ready";
export const WORKTREE_FAILED_NOTICE =
  "Worktree setup failed. /worktree retry, or /worktree local to work in the project checkout";

/**
 * Why a message to this thread can't go out now: it would run in the project's checkout
 * while the thread is meant to work in a worktree that isn't there.
 */
export function worktreeSendBlock(input: {
  readonly worktreePath: string | null;
  readonly launch: WorktreeLaunch | null;
  /** The user chose to work in the project's checkout after the setup failed. */
  readonly workingLocally: boolean;
}): string | null {
  const { launch } = input;
  if (launch === null || input.worktreePath !== null) return null;
  if (launch.status === "preparing") return WORKTREE_PREPARING_NOTICE;
  return input.workingLocally ? null : WORKTREE_FAILED_NOTICE;
}
