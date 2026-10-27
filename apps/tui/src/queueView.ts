import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { MessageId, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

import type { ComposerSendEntry } from "./composerStore.ts";

/** One message the server queued for the thread, as the queue list shows it. */
export interface QueueRow {
  readonly runId: RunId;
  readonly messageId: MessageId;
  /** The message as sent, for editing. */
  readonly text: string;
  /** The text on one line. */
  readonly preview: string;
  readonly attachments: number;
  /** The server holds it: it won't start until resumed. */
  readonly held: boolean;
  /** A guest's message can be removed but not rewritten. */
  readonly guestName: string | null;
}

export interface QueueView {
  readonly rows: ReadonlyArray<QueueRow>;
  /** Why the server holds the queue; null while it isn't held. */
  readonly holdReason: string | null;
  readonly activeRunId: RunId | null;
  readonly canReorder: boolean;
  /** Nothing runs: a queued message can start now (`queued-run.start`). */
  readonly canSendNow: boolean;
  /** A run takes steers now: a queued message can join it (`promote-to-steer`). */
  readonly canPromoteToSteer: boolean;
}

type HoldRun = OrchestrationV2Run;

/**
 * Why the server holds a thread's queue, from the run that ran last. It holds after Stop,
 * after a failed run (a provider error or a failed worktree setup), and while the thread's
 * worktree is missing; a resume, or sending one now, releases it.
 */
export function queueHoldReason(input: {
  readonly runs: ReadonlyArray<HoldRun>;
  readonly worktreePath: string | null;
}): string {
  const latest = latestExecutedRun(input.runs);
  if (
    latest !== null &&
    input.worktreePath === null &&
    latest.workspacePreparation?.type === "worktree" &&
    (latest.status === "failed" || latest.status === "interrupted")
  ) {
    return "worktree setup didn't finish";
  }
  if (latest?.status === "interrupted" || latest?.status === "cancelled") return "stopped";
  if (latest?.status === "failed") return "the last run failed";
  return "until resumed";
}

function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function deriveQueueView(input: {
  readonly workflow: ThreadQueueWorkflowState;
  readonly runs: ReadonlyArray<HoldRun>;
  readonly worktreePath: string | null;
}): QueueView {
  const { workflow } = input;
  return {
    rows: workflow.queuedRuns.map(({ run, text, attachments, messageId, context }) => ({
      runId: run.id,
      messageId,
      text,
      preview: flatten(text),
      attachments: attachments.length,
      held: run.queueHeld === true,
      guestName: context?.guest?.name ?? null,
    })),
    holdReason: workflow.isHeld ? queueHoldReason(input) : null,
    activeRunId: workflow.activeRun?.id ?? null,
    canReorder: workflow.canReorder,
    canSendNow: workflow.canSendNow,
    canPromoteToSteer: workflow.canPromoteToSteer,
  };
}

function sameRow(a: QueueRow, b: QueueRow): boolean {
  return (
    a.runId === b.runId &&
    a.messageId === b.messageId &&
    a.text === b.text &&
    a.attachments === b.attachments &&
    a.held === b.held &&
    a.guestName === b.guestName
  );
}

export function sameQueueView(a: QueueView | null, b: QueueView | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.holdReason === b.holdReason &&
    a.activeRunId === b.activeRunId &&
    a.canReorder === b.canReorder &&
    a.canSendNow === b.canSendNow &&
    a.canPromoteToSteer === b.canPromoteToSteer &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, index) => {
      const other = b.rows[index];
      return other !== undefined && sameRow(row, other);
    })
  );
}

/**
 * The queue view for a projection, kept while nothing it shows changed. A streaming run
 * changes the projection on every token, so this keeps the list from re-rendering.
 */
export function createQueueViewSelector() {
  let workflow: ThreadQueueWorkflowState | null = null;
  let runs: ReadonlyArray<HoldRun> | null = null;
  let worktreePath: string | null = null;
  let view: QueueView | null = null;
  return (
    input: {
      readonly workflow: ThreadQueueWorkflowState;
      readonly runs: ReadonlyArray<HoldRun>;
      readonly worktreePath: string | null;
    } | null,
  ): QueueView | null => {
    if (input === null) {
      workflow = null;
      runs = null;
      view = null;
      return null;
    }
    if (input.workflow === workflow && input.runs === runs && input.worktreePath === worktreePath) {
      return view;
    }
    ({ workflow, runs, worktreePath } = input);
    const next = deriveQueueView(input);
    if (!sameQueueView(view, next)) view = next;
    return view;
  };
}

/** The parts of a thread's projection that name its messages. */
export interface ProjectedMessages {
  readonly runs: ReadonlyArray<{ readonly userMessageId: MessageId }>;
  readonly messages: ReadonlyArray<{ readonly id: MessageId }>;
}

/**
 * Every message id the thread's projection has, from its runs and its messages: queued,
 * started, finished or removed. The same set while those don't change, so a streaming run
 * doesn't re-render the composer.
 */
export function createProjectedMessageIdsSelector() {
  let runs: ProjectedMessages["runs"] | null = null;
  let messages: ProjectedMessages["messages"] | null = null;
  let ids: ReadonlySet<MessageId> = new Set();
  return (projection: ProjectedMessages | null): ReadonlySet<MessageId> => {
    if (projection === null) {
      runs = messages = null;
      if (ids.size > 0) ids = new Set();
      return ids;
    }
    if (projection.runs === runs && projection.messages === messages) return ids;
    ({ runs, messages } = projection);
    const next = new Set<MessageId>();
    for (const run of projection.runs) next.add(run.userMessageId);
    for (const message of projection.messages) next.add(message.id);
    if (next.size !== ids.size || [...next].some((id) => !ids.has(id))) ids = next;
    return ids;
  };
}

/**
 * Sends still pending here, less those the thread's projection already has: the reply can
 * lag the server's update, and one message must not show twice, whether it's queued, started
 * or was removed since. The sender keeps the job until the reply comes, so it's still covered
 * by Stop, /discard and quitting.
 */
export function unlistedSends(
  sends: ReadonlyArray<ComposerSendEntry>,
  projected: ReadonlySet<MessageId>,
): ReadonlyArray<ComposerSendEntry> {
  if (projected.size === 0 || sends.length === 0) return sends;
  const shown = sends.filter((entry) => !projected.has(entry.send.messageId));
  return shown.length === sends.length ? sends : shown;
}

export type QueueVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: QueueVerdict = { ok: true };
const no = (reason: string): QueueVerdict => ({ ok: false, reason });

export const QUEUE_BUSY_REASON = "Wait for the last queue change to finish";

export interface QueueRowActions {
  readonly edit: QueueVerdict;
  readonly remove: QueueVerdict;
  readonly moveUp: QueueVerdict;
  readonly moveDown: QueueVerdict;
  /** Upstream's one button: "Send now" while nothing runs, "Steer" while a run takes steers. */
  readonly send: QueueVerdict & { readonly mode: "start" | "steer" | null };
}

/** What can be done to a queued message now, and why not, as upstream's web queue allows. */
export function queueRowActions(
  view: QueueView,
  index: number,
  state: { readonly busy: boolean },
): QueueRowActions | null {
  const row = view.rows[index];
  if (row === undefined) return null;
  const busy = state.busy ? no(QUEUE_BUSY_REASON) : null;
  const reorder =
    view.rows.length < 2
      ? no("Only one message is queued")
      : view.canReorder
        ? null
        : no("This thread's provider session can't reorder its queue now");
  const mode = view.canSendNow ? "start" : view.canPromoteToSteer ? "steer" : null;
  return {
    edit:
      busy ?? (row.guestName !== null ? no("A guest's message can be removed, not edited") : OK),
    remove: busy ?? OK,
    moveUp: busy ?? reorder ?? (index === 0 ? no("It's already first") : OK),
    moveDown: busy ?? reorder ?? (index === view.rows.length - 1 ? no("It's already last") : OK),
    send: {
      ...(busy ??
        (mode === null
          ? no(
              view.activeRunId === null
                ? "The thread can't start a run now"
                : "The run can't take a steer right now",
            )
          : OK)),
      mode,
    },
  };
}

/**
 * The `beforeRunId` that moves a queued message one place up or down, as web's arrow keys
 * do: null puts it last. Undefined when it can't move that way.
 */
export function reorderTarget(
  view: QueueView,
  runId: RunId,
  delta: -1 | 1,
): RunId | null | undefined {
  const index = view.rows.findIndex((row) => row.runId === runId);
  if (index === -1) return undefined;
  if (delta === -1) return index === 0 ? undefined : view.rows[index - 1]?.runId;
  if (index === view.rows.length - 1) return undefined;
  return view.rows[index + 2]?.runId ?? null;
}

/** What a queue action says when its message left the queue before it went out. */
export function leftQueueNotice(status: string | null): string {
  if (status === "cancelled") return "That message was already removed from the queue";
  if (status === null) return "That message is no longer queued";
  return "That message already started";
}
