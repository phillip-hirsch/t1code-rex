import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { UnconfirmedComposerSend } from "./composerSend.ts";
import type { ComposerStore } from "./composerStore.ts";

export const UNCONFIRMED_NOTICE = "Maybe not sent; check the thread first";

/** The part of a thread's state the check reads. */
export interface ThreadMessagesState {
  readonly status: EnvironmentThreadState["status"];
  readonly data: Option.Option<{ readonly messages: ReadonlyArray<{ readonly id: MessageId }> }>;
}

/**
 * Whether a message saved at quit landed, from its thread's state: the server stores a
 * message under the id the client gave it. Null until the thread's live state is in; a
 * thread the server doesn't have (a launch that never landed) counts as missing.
 */
export function unconfirmedSendLanded(
  record: UnconfirmedComposerSend,
  state: ThreadMessagesState,
): boolean | null {
  if (state.status === "deleted") return false;
  if (state.status !== "live") return null;
  const projection = Option.getOrNull(state.data);
  if (projection === null) return null;
  return projection.messages.some((message) => message.id === record.messageId);
}

/**
 * At launch, checks each message the last quit saved against its thread. One that landed is
 * dropped; one that didn't goes back into its composer with a note. Either way the record
 * goes in the same prefs write. Nothing is sent. Returns a function that stops watching.
 */
export function checkUnconfirmedSends(options: {
  readonly store: ComposerStore;
  /** Calls back with the thread's state now and on each change, until unsubscribed. */
  readonly watchThread: (
    threadId: ThreadId,
    onState: (state: ThreadMessagesState) => void,
  ) => () => void;
}): () => void {
  const { store } = options;
  const stops = store.unconfirmedSends().map((record) => {
    let stop: (() => void) | null = null;
    let settled = false;
    const onState = (state: ThreadMessagesState) => {
      const landed = settled ? null : unconfirmedSendLanded(record, state);
      if (landed === null) return;
      settled = true;
      store.removeUnconfirmedSend(record);
      if (!landed) store.restoreDraft(record.threadId, record, UNCONFIRMED_NOTICE);
      // The launch made the thread, so its new-thread draft is done.
      if (record.launch && state.status === "live") store.closeNewThreadDraft(record.threadId);
      store.flush();
      stop?.();
    };
    stop = options.watchThread(record.threadId, onState);
    if (settled) stop();
    return () => stop?.();
  });
  return () => {
    for (const stop of stops) stop();
  };
}
