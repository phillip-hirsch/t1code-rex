import type { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

import { retryDelayMs, type UnconfirmedComposerSend } from "./composerSend.ts";
import type { ComposerStore } from "./composerStore.ts";

export const UNCONFIRMED_NOTICE = "Maybe not sent; check the thread first";

/**
 * A thread's whole history, as the server's full thread snapshot returns it (client-runtime's
 * `ThreadSnapshotLoadResult`). A bounded window can leave out a message the thread has, so
 * only this proves one is missing. "missing": the server has no such thread. "unavailable":
 * the lookup failed, so nothing is decided.
 */
export type ThreadLookup =
  | {
      readonly _tag: "present";
      readonly snapshot: {
        readonly projection: {
          readonly thread: { readonly projectId: ProjectId; readonly deletedAt: unknown };
          readonly messages: ReadonlyArray<{ readonly id: MessageId }>;
        };
      };
    }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

/** What to do with a message saved at quit, given its thread's whole history. */
export type UnconfirmedSendOutcome =
  | { readonly kind: "landed" }
  /** Back into its thread's composer. */
  | { readonly kind: "restore" }
  /** A launch that never landed: back into its new-thread draft. */
  | { readonly kind: "restore-in-draft" }
  /** The thread is gone: into a new-thread draft in its project. */
  | { readonly kind: "restore-in-project"; readonly projectId: ProjectId }
  /** The thread and its project are gone: kept until the user takes it with /recover. */
  | { readonly kind: "orphaned" }
  | { readonly kind: "retry" };

export function decideUnconfirmedSend(
  record: UnconfirmedComposerSend,
  lookup: ThreadLookup,
  context: {
    /** Null until the shell lists projects. */
    readonly projectExists: (projectId: ProjectId) => boolean | null;
    readonly draftOpen: (threadId: ThreadId) => boolean;
  },
): UnconfirmedSendOutcome {
  if (lookup._tag === "unavailable") return { kind: "retry" };
  const projection = lookup._tag === "present" ? lookup.snapshot.projection : null;
  if (projection?.messages.some((message) => message.id === record.messageId)) {
    return { kind: "landed" };
  }
  if (projection !== null && projection.thread.deletedAt === null) {
    return { kind: "restore" };
  }
  // A launch that never landed goes back into its draft while that's still open.
  if (projection === null && record.launch && context.draftOpen(record.threadId)) {
    return { kind: "restore-in-draft" };
  }
  const projectId = projection?.thread.projectId ?? record.projectId;
  if (projectId === undefined) return { kind: "orphaned" };
  const exists = context.projectExists(projectId);
  if (exists === null) return { kind: "retry" };
  return exists ? { kind: "restore-in-project", projectId } : { kind: "orphaned" };
}

/**
 * At launch, checks each message the last quit saved against its thread's whole history. One
 * that landed is dropped; one that didn't goes back into a composer with a note, in the same
 * prefs write that drops the record. Nothing is sent. A failed lookup keeps the record and
 * asks again later. Returns a function that stops checking.
 */
export function checkUnconfirmedSends(options: {
  readonly store: ComposerStore;
  readonly lookupThread: (threadId: ThreadId) => Promise<ThreadLookup>;
  readonly projectExists: (projectId: ProjectId) => boolean | null;
  readonly mintThreadId: () => ThreadId;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** A record whose thread is gone, now in its project's new-thread draft. */
  readonly onMoved?: (record: UnconfirmedComposerSend, projectId: ProjectId) => void;
  /** A record whose thread and project are gone; it stays saved for /recover. */
  readonly onOrphaned?: (record: UnconfirmedComposerSend) => void;
}): () => void {
  const { store } = options;
  let stopped = false;
  const cancels = new Set<() => void>();

  const settle = (record: UnconfirmedComposerSend, outcome: UnconfirmedSendOutcome) => {
    if (outcome.kind === "orphaned") {
      store.markOrphanedSend(record);
      options.onOrphaned?.(record);
      return;
    }
    store.removeUnconfirmedSend(record);
    // The thread exists or existed, so the draft that launched it is done.
    if (record.launch && outcome.kind !== "restore-in-draft") {
      store.closeNewThreadDraft(record.threadId);
    }
    if (outcome.kind === "restore" || outcome.kind === "restore-in-draft") {
      store.restoreDraft(record.threadId, record, UNCONFIRMED_NOTICE);
    } else if (outcome.kind === "restore-in-project") {
      const draft = store.openNewThreadDraft(outcome.projectId, options.mintThreadId);
      store.restoreDraft(draft.threadId, record, UNCONFIRMED_NOTICE);
    }
    store.flush();
    if (outcome.kind === "restore-in-project") options.onMoved?.(record, outcome.projectId);
  };

  const check = (record: UnconfirmedComposerSend, attempt: number) => {
    void options
      .lookupThread(record.threadId)
      .catch((): ThreadLookup => ({ _tag: "unavailable" }))
      .then((lookup) => {
        if (stopped || !store.unconfirmedSends().includes(record)) return;
        const outcome = decideUnconfirmedSend(record, lookup, {
          projectExists: options.projectExists,
          draftOpen: (threadId) => store.findNewThreadDraft(threadId) !== undefined,
        });
        if (outcome.kind !== "retry") return settle(record, outcome);
        const cancel = options.schedule(() => {
          cancels.delete(cancel);
          check(record, attempt + 1);
        }, retryDelayMs(attempt));
        cancels.add(cancel);
      });
  };

  for (const record of store.unconfirmedSends()) check(record, 0);
  return () => {
    stopped = true;
    for (const cancel of cancels) cancel();
    cancels.clear();
  };
}

/** /recover: puts messages whose thread and project are gone into this composer. */
export function recoverOrphanedSends(store: ComposerStore, threadId: ThreadId): number {
  const records = store.orphanedSends();
  for (const record of records) {
    store.removeUnconfirmedSend(record);
    store.restoreDraft(threadId, record, UNCONFIRMED_NOTICE);
  }
  if (records.length > 0) store.flush();
  return records.length;
}
