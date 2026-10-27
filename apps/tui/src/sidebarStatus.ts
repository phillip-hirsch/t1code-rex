import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { TuiColor, TuiTheme } from "./theme.ts";

/**
 * Sidebar status pills, derived from orchestration v2 shell rows. The rules follow the
 * web sidebar (`resolveThreadStatusPill`), except unread: like the old TUI, a finished
 * run counts as unread until the thread is visited after it, including threads never
 * opened.
 */

export type ThreadStatusLabel =
  | "Pending Approval"
  | "Awaiting Input"
  | "Working"
  | "Connecting"
  | "Waiting"
  | "Failed"
  | "Plan Ready"
  | "Completed";

export interface ThreadStatusPill {
  readonly label: ThreadStatusLabel;
  readonly pulse: boolean;
}

const pill = (label: ThreadStatusLabel, pulse = false): ThreadStatusPill =>
  Object.freeze({ label, pulse });

// One object per label, so memoized rows see the same value while the status holds.
const PILLS = {
  approval: pill("Pending Approval"),
  input: pill("Awaiting Input"),
  working: pill("Working", true),
  connecting: pill("Connecting", true),
  waiting: pill("Waiting"),
  failed: pill("Failed"),
  planReady: pill("Plan Ready"),
  completed: pill("Completed"),
} as const;

const STATUS_PRIORITY: Record<ThreadStatusLabel, number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

export type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "pendingBackgroundTasks"
> &
  Partial<Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "blockedOnThreadWait">>;

export interface ThreadVisitState {
  /** When this TUI last saw the thread, from prefs. */
  readonly localVisitedAt?: string | undefined;
  /** The server's visited watermark, when it tracks one. */
  readonly serverVisitedAt?: string | null | undefined;
  /** Set by "Mark unread"; wins over any visit. */
  readonly forceUnread?: boolean;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The later of the local and server visits, or null when the thread counts as unvisited. */
export function effectiveVisitedAtMs(visit: ThreadVisitState): number | null {
  if (visit.forceUnread) return null;
  const local = parseMs(visit.localVisitedAt);
  const server = parseMs(visit.serverVisitedAt);
  if (local === null) return server;
  if (server === null) return local;
  return Math.max(local, server);
}

function finishedAfterVisit(completedAt: string | null, visitedAtMs: number | null): boolean {
  const completedAtMs = parseMs(completedAt);
  if (completedAtMs === null) return false;
  return visitedAtMs === null || completedAtMs > visitedAtMs;
}

function isLatestRunSettled(thread: ThreadStatusInput): boolean {
  const run = thread.latestRun;
  if (run === null) return false;
  if (
    run.status === "preparing" ||
    run.status === "queued" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  ) {
    return false;
  }
  return thread.runtime?.activeRunId !== run.runId;
}

export function resolveThreadStatus(
  thread: ThreadStatusInput,
  visit: ThreadVisitState = {},
): ThreadStatusPill | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return PILLS.approval;
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return PILLS.input;
  }
  const runtimeStatus = thread.runtime?.status;
  const blocked = thread.blockedOnThreadWait === true;
  if ((runtimeStatus === "running" && !blocked) || runtimeStatus === "waiting") {
    return PILLS.working;
  }
  if (runtimeStatus === "preparing" || runtimeStatus === "starting" || runtimeStatus === "queued") {
    return PILLS.connecting;
  }
  if (
    (runtimeStatus === "running" && blocked) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)
  ) {
    return PILLS.waiting;
  }
  const visitedAtMs = effectiveVisitedAtMs(visit);
  if (
    thread.latestRun?.status === "failed" &&
    // A failure without a time still needs the user until the thread is visited.
    (thread.latestRun.completedAt === null
      ? visitedAtMs === null
      : finishedAfterVisit(thread.latestRun.completedAt, visitedAtMs))
  ) {
    return PILLS.failed;
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread)
  ) {
    return PILLS.planReady;
  }
  if (finishedAfterVisit(thread.latestRun?.completedAt ?? null, visitedAtMs)) {
    return PILLS.completed;
  }
  return null;
}

/** The most urgent status among a project's threads, for its collapsed dot. */
export function resolveProjectStatus(
  statuses: Iterable<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highest: ThreadStatusPill | null = null;
  for (const status of statuses) {
    if (status === null) continue;
    if (highest === null || STATUS_PRIORITY[status.label] > STATUS_PRIORITY[highest.label]) {
      highest = status;
    }
  }
  return highest;
}

export function threadStatusColor(label: ThreadStatusLabel, theme: TuiTheme): TuiColor {
  switch (label) {
    case "Pending Approval":
      return theme.palette.warning;
    case "Awaiting Input":
      return theme.status.awaitingInput;
    case "Working":
    case "Connecting":
      return theme.status.working;
    case "Waiting":
      return theme.palette.muted;
    case "Failed":
      return theme.palette.composerStop;
    case "Plan Ready":
      return theme.status.planReady;
    case "Completed":
      return theme.palette.success;
  }
}
