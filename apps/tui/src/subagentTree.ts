import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isLiveSubagentShell, type OrchestrationV2Subagent } from "@t3tools/contracts";

/**
 * Subagent children in the sidebar: which threads nest under which parent, and whether a
 * parent's children show. Children are other threads whose lineage names the parent with
 * `relationshipToParent: "subagent"`. A parent shows them while any is live and hides idle
 * ones until opened, as web's lineage panel folds "Previous agents".
 */

type ChildThread = Pick<
  EnvironmentThreadShell,
  "id" | "lineage" | "archivedAt" | "deletedAt" | "createdAt" | "source"
>;

/** A subagent's state as one word, for its dot and label. */
export type SubagentState = "working" | "waiting" | "done" | "failed" | "stopped" | "idle";

export function isSubagentThread(thread: Pick<EnvironmentThreadShell, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

/** Each parent's subagent children, in the order they started. */
export function groupSubagentChildren<T extends ChildThread>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (!isSubagentThread(thread) || parentId === null) continue;
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const list = children.get(parentId);
    if (list) list.push(thread);
    else children.set(parentId, [thread]);
  }
  for (const list of children.values()) {
    list.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }
  return children;
}

/** A child thread's state from its shell row. */
export function subagentShellState(thread: Pick<ChildThread, "source">): SubagentState {
  const source = thread.source;
  if (source.pendingRuntimeRequest !== null) return "waiting";
  const activity = source.activityRunStatus ?? null;
  if (activity === "waiting") return "waiting";
  if (activity !== null) return "working";
  switch (source.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    case "idle":
      return "idle";
  }
}

/** A subagent record's state; the parent's record is the source of truth while it is loaded. */
export function subagentRecordState(status: OrchestrationV2Subagent["status"]): SubagentState {
  switch (status) {
    case "pending":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "idle":
      return "idle";
  }
}

export const SUBAGENT_STATE_LABELS: Record<SubagentState, string> = {
  working: "working",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  idle: "idle",
};

/**
 * Whether a parent's children show: the user's choice once made, else open while any child
 * is live or one of them is open (`holdsOpenThread`), so finished and idle subagents start
 * folded.
 */
export function subagentsOpen(
  parentId: string,
  children: ReadonlyArray<Pick<ChildThread, "source">>,
  overrides: ReadonlyMap<string, boolean>,
  holdsOpenThread = false,
): boolean {
  return (
    overrides.get(parentId) ??
    (holdsOpenThread || children.some((child) => isLiveSubagentShell(child.source)))
  );
}

/** The thread and every ancestor above it, nearest first; stops at a cycle or a gap. */
export function threadAncestors(
  threadId: string,
  threadsById: ReadonlyMap<string, Pick<EnvironmentThreadShell, "id" | "lineage">>,
): ReadonlyArray<string> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = threadsById.get(threadId);
  while (current !== undefined && isSubagentThread(current)) {
    const parentId = current.lineage.parentThreadId;
    if (parentId === null || seen.has(parentId)) break;
    seen.add(parentId);
    chain.push(parentId);
    current = threadsById.get(parentId);
  }
  return chain;
}
