// @effect-diagnostics nodeBuiltinImport:off -- Command ids are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type {
  CancelQueuedRunInput,
  EditQueuedRunInput,
  PromoteQueuedRunInput,
  ReorderQueuedRunInput,
} from "@t3tools/client-runtime/operations";
import {
  makeQueuedRunEditStore,
  type QueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";
import { CommandId, type MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { classifySendFailure, describeSendFailure } from "./composerSend.ts";
import {
  awaitWorkspaceBlock,
  type ComposerCommandResult,
  type ComposerSender,
  type WorkspaceGuard,
} from "./composerSender.ts";
import type { ComposerStore } from "./composerStore.ts";
import {
  leftQueueNotice,
  QUEUE_BUSY_REASON,
  queueRowActions,
  reorderTarget,
  type QueueView,
} from "./queueView.ts";

/** A queued message open in the queue list's editor. */
export interface QueueEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly text: string;
}

export interface QueueControllerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  /** The thread's queue as the projection has it now. */
  readonly view: (threadId: ThreadId) => QueueView | null;
  readonly runStatus: (threadId: ThreadId, runId: RunId) => string | null;
  /** What an open edit watches for its run leaving the queue. */
  readonly queuedRuns: (threadId: ThreadId) => QueuedRunsAtom;
  readonly editQueuedRun: (input: EditQueuedRunInput) => Promise<ComposerCommandResult>;
  readonly cancelQueuedRun: (input: CancelQueuedRunInput) => Promise<ComposerCommandResult>;
  readonly reorderQueuedRun: (input: ReorderQueuedRunInput) => Promise<ComposerCommandResult>;
  readonly promoteQueuedRun: (input: PromoteQueuedRunInput) => Promise<ComposerCommandResult>;
  /** "Send now" goes through the sender, as a resume does. */
  readonly sender: Pick<ComposerSender, "startQueued">;
  /** Why nothing may start on the thread now; a steer can restart its run. */
  readonly guardWorkspace?: (threadId: ThreadId) => WorkspaceGuard;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly store: Pick<ComposerStore, "setNotice" | "restoreDraft">;
  /** A passing note for the footer. */
  readonly onStatus: (status: string) => void;
  readonly mintCommandId?: () => CommandId;
}

export const WORKSPACE_UNKNOWN_NOTICE =
  "Couldn't check the thread's worktree yet; try again once connected";
const DROPPED = "the connection dropped; check the queue once it's back";

/** The server's wording when a command names a run that left the queue. */
const NOT_QUEUED = /\bis not queued\b/u;

function failure(error: unknown): ComposerCommandResult {
  return { ok: false, error, interrupted: false };
}

/**
 * The queue list's actions on the server's queued messages, with upstream's commands: edit,
 * remove, reorder, steer and send now. A thread's queue changes one command at a time, like
 * web's busy row, and each command has one id, so nothing is sent twice. Every action checks
 * the live queue first, and a message that left it says so instead of going out.
 */
export function createQueueController(options: QueueControllerOptions) {
  const { registry, store } = options;
  const mintCommandId = options.mintCommandId ?? (() => CommandId.make(NodeCrypto.randomUUID()));
  /** The run each thread's command in flight is for. */
  const busyAtom = Atom.make<Readonly<Record<string, RunId>>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel("tr3x-queue-busy"),
  );
  const edits = makeQueuedRunEditStore<QueueEdit>({ registry, label: "tr3x-queued-run-edits" });

  const isBusy = (threadId: ThreadId) => registry.get(busyAtom)[threadId] !== undefined;
  const setBusy = (threadId: ThreadId, runId: RunId | null) => {
    const next = { ...registry.get(busyAtom) };
    if (runId === null) delete next[threadId];
    else next[threadId] = runId;
    registry.set(busyAtom, next);
  };
  const listed = (threadId: ThreadId, runId: RunId) =>
    options.view(threadId)?.rows.some((row) => row.runId === runId) === true;
  const leftNotice = (threadId: ThreadId, runId: RunId) => {
    const status = options.runStatus(threadId, runId);
    return leftQueueNotice(status === "queued" ? null : status);
  };
  const describe = (result: ComposerCommandResult & { readonly ok: false }) =>
    classifySendFailure(result.error, result.interrupted) === "retry"
      ? DROPPED
      : describeSendFailure(result.error);

  const issue = (run: () => Promise<ComposerCommandResult>): Promise<ComposerCommandResult> => {
    try {
      return run().catch(failure);
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  };

  /** Why nothing may start on the thread now, or null; asked fresh each time. */
  const workspaceBlock = async (threadId: ThreadId): Promise<string | null> => {
    if (options.guardWorkspace === undefined) return null;
    const guard = options.guardWorkspace(threadId);
    try {
      const now = guard.blockedReason();
      const answer =
        now instanceof Promise ? await awaitWorkspaceBlock(now, options.schedule) : now;
      return answer === undefined ? WORKSPACE_UNKNOWN_NOTICE : answer;
    } finally {
      guard.dispose();
    }
  };

  /**
   * One queue command for one queued message, while nothing else changes the thread's
   * queue. `prepare` runs under the same lock, and may stop it with a reason.
   */
  const change = async (
    threadId: ThreadId,
    runId: RunId,
    command: {
      readonly prepare?: () => Promise<string | null>;
      readonly send: (commandId: CommandId) => Promise<ComposerCommandResult>;
      readonly done: string;
      readonly failed: string;
    },
  ): Promise<boolean> => {
    if (isBusy(threadId)) {
      options.onStatus(QUEUE_BUSY_REASON);
      return false;
    }
    if (!listed(threadId, runId)) {
      store.setNotice(threadId, leftNotice(threadId, runId));
      return false;
    }
    setBusy(threadId, runId);
    try {
      const blocked = (await command.prepare?.()) ?? null;
      if (blocked !== null) {
        store.setNotice(threadId, blocked);
        return false;
      }
      // It may have left the queue while the worktree was checked.
      if (!listed(threadId, runId)) {
        store.setNotice(threadId, leftNotice(threadId, runId));
        return false;
      }
      const commandId = mintCommandId();
      const result = await issue(() => command.send(commandId));
      if (result.ok) {
        store.setNotice(threadId, null);
        options.onStatus(command.done);
        return true;
      }
      const reason = describe(result);
      store.setNotice(
        threadId,
        !listed(threadId, runId) || NOT_QUEUED.test(reason)
          ? leftNotice(threadId, runId)
          : `${command.failed}: ${reason}`,
      );
      return false;
    } finally {
      setBusy(threadId, null);
    }
  };

  /** The edit's run left the queue before it was saved: the edit is never lost. */
  const leftWhileEditing = (threadId: ThreadId, edit: QueueEdit) => {
    const notice = leftNotice(threadId, edit.runId);
    if (edit.text.trim() === edit.originalText.trim()) {
      store.setNotice(threadId, notice);
      return;
    }
    // In front of whatever the composer holds, so neither is lost.
    store.restoreDraft(
      threadId,
      { text: edit.text, attachments: [] },
      `${notice}; your edit is here`,
    );
  };

  return {
    busyAtom,
    editsAtom: edits.atom,
    /** Thread ids whose edit has a save in flight. */
    savingAtom: edits.savingAtom,

    edit: (threadId: ThreadId): QueueEdit | null => edits.get(threadId),

    /** Opens the message in the list's editor; false when it can't be edited now. */
    beginEdit(threadId: ThreadId, runId: RunId): boolean {
      const view = options.view(threadId);
      const index = view?.rows.findIndex((row) => row.runId === runId) ?? -1;
      const row = view?.rows[index];
      if (view === null || row === undefined) {
        store.setNotice(threadId, leftNotice(threadId, runId));
        return false;
      }
      const verdict = queueRowActions(view, index, { busy: isBusy(threadId) })?.edit;
      if (verdict !== undefined && !verdict.ok) {
        options.onStatus(verdict.reason);
        return false;
      }
      const edit = { runId, messageId: row.messageId, originalText: row.text, text: row.text };
      edits.begin(threadId, edit, {
        runs: options.queuedRuns(threadId),
        onRunLeftQueue: (_, left) => leftWhileEditing(threadId, left),
      });
      return edits.get(threadId)?.runId === runId;
    },

    setEditText(threadId: ThreadId, text: string) {
      edits.update(threadId, (edit) => (edit.text === text ? edit : { ...edit, text }));
    },

    cancelEdit(threadId: ThreadId) {
      edits.end(threadId);
    },

    /** Saves the open edit with `queued-run.edit`; its images stay as they were. */
    async saveEdit(threadId: ThreadId): Promise<void> {
      const edit = edits.get(threadId);
      if (edit === null) return;
      const text = edit.text.trim();
      if (text.length === 0) {
        options.onStatus("A queued message can't be empty; x removes it");
        return;
      }
      if (text === edit.originalText.trim()) {
        edits.end(threadId);
        return;
      }
      // The save's result decides the edit's fate, even if the run starts meanwhile.
      const finish = edits.startSave(threadId);
      if (finish === null) return;
      const commandId = mintCommandId();
      const result = await issue(() =>
        options.editQueuedRun({ commandId, threadId, runId: edit.runId, text }),
      );
      const current = finish(result.ok);
      if (result.ok) {
        store.setNotice(threadId, null);
        options.onStatus("Saved the queued message");
        return;
      }
      // Still open: the run is still queued, so the edit can be saved again.
      if (current) store.setNotice(threadId, `Couldn't save the edit: ${describe(result)}`);
    },

    remove: (threadId: ThreadId, runId: RunId) =>
      change(threadId, runId, {
        send: (commandId) => options.cancelQueuedRun({ commandId, threadId, runId }),
        done: "Removed from the queue",
        failed: "Couldn't remove it",
      }),

    /** One place up or down, as the row's move actions allow; keys and clicks both come here. */
    move(threadId: ThreadId, runId: RunId, delta: -1 | 1): Promise<boolean> {
      const view = options.view(threadId);
      const index = view?.rows.findIndex((row) => row.runId === runId) ?? -1;
      const actions =
        view === null ? null : queueRowActions(view, index, { busy: isBusy(threadId) });
      const verdict = delta === -1 ? actions?.moveUp : actions?.moveDown;
      if (verdict !== undefined && !verdict.ok) {
        options.onStatus(verdict.reason);
        return Promise.resolve(false);
      }
      const beforeRunId = view === null ? undefined : reorderTarget(view, runId, delta);
      return change(threadId, runId, {
        send: (commandId) =>
          options.reorderQueuedRun({
            commandId,
            threadId,
            runId,
            beforeRunId: beforeRunId ?? null,
          }),
        done: delta === -1 ? "Moved up" : "Moved down",
        failed: "Couldn't move it",
      });
    },

    /**
     * Upstream's "Send now" while nothing runs, its "Steer" while a run takes steers. Both can
     * start a run, so both wait for the worktree guard.
     */
    sendNow(threadId: ThreadId, runId: RunId): Promise<boolean> {
      const view = options.view(threadId);
      if (view === null || !listed(threadId, runId)) {
        store.setNotice(threadId, leftNotice(threadId, runId));
        return Promise.resolve(false);
      }
      if (view.canSendNow) {
        if (isBusy(threadId)) {
          options.onStatus(QUEUE_BUSY_REASON);
          return Promise.resolve(false);
        }
        // The sender asks the guard, and resends with the same id after a drop.
        const started = options.sender.startQueued(threadId, runId);
        options.onStatus(started ? "Sending it now" : "Already sending the queue");
        return Promise.resolve(started);
      }
      if (!view.canPromoteToSteer || view.activeRunId === null) {
        options.onStatus(
          view.activeRunId === null
            ? "The thread can't start a run now"
            : "The run can't take a steer right now",
        );
        return Promise.resolve(false);
      }
      // The run the user chose to steer; a newer one never takes its place.
      const targetRunId = view.activeRunId;
      return change(threadId, runId, {
        prepare: async () => {
          const blocked = await workspaceBlock(threadId);
          if (blocked !== null) return blocked;
          // The run may have ended while the worktree was checked; a steer never starts one.
          const now = options.view(threadId);
          if (now?.canPromoteToSteer === true && now.activeRunId === targetRunId) return null;
          return `The run ended before the steer went out; ${
            now?.canSendNow === true ? "s sends it now" : "nothing was sent"
          }`;
        },
        send: (commandId) =>
          options.promoteQueuedRun({ commandId, threadId, queuedRunId: runId, targetRunId }),
        done: "Steering the run with it",
        failed: "Couldn't steer with it",
      });
    },

    /** Quitting: an unsaved edit goes into its thread's composer, which is saved to disk. */
    handOff() {
      for (const [threadId, edit] of Object.entries(registry.get(edits.atom))) {
        edits.end(threadId);
        if (edit.text.trim() === edit.originalText.trim()) continue;
        store.restoreDraft(
          threadId,
          { text: edit.text, attachments: [] },
          "Your unsaved edit of a queued message; the queued one is unchanged",
        );
      }
    },
  };
}

export type QueueController = ReturnType<typeof createQueueController>;
