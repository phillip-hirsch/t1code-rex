import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId, ThreadId } from "@t3tools/contracts";

import { initialForm, type QuestionForm } from "./requestPanel.ts";

interface ThreadPanel {
  active: RuntimeRequestId | null;
  readonly forms: Map<RuntimeRequestId, QuestionForm>;
}

/**
 * The request panel's state outside React: which request each thread shows and the answers
 * typed into its questions, so switching threads keeps them. A thread's entries go when
 * its requests resolve, from here or anywhere else.
 */
export function createRequestPanelStore() {
  const threads = new Map<ThreadId, ThreadPanel>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const panelOf = (threadId: ThreadId): ThreadPanel => {
    let panel = threads.get(threadId);
    if (panel === undefined) {
      panel = { active: null, forms: new Map() };
      threads.set(threadId, panel);
    }
    return panel;
  };

  return {
    active(threadId: ThreadId): RuntimeRequestId | null {
      return threads.get(threadId)?.active ?? null;
    },
    setActive(threadId: ThreadId, requestId: RuntimeRequestId): void {
      const panel = panelOf(threadId);
      if (panel.active === requestId) return;
      panel.active = requestId;
      notify();
    },
    form(threadId: ThreadId, input: ThreadPendingUserInput): QuestionForm {
      return threads.get(threadId)?.forms.get(input.requestId) ?? initialForm(input);
    },
    setForm(threadId: ThreadId, requestId: RuntimeRequestId, form: QuestionForm): void {
      const panel = panelOf(threadId);
      if (panel.forms.get(requestId) === form) return;
      panel.forms.set(requestId, form);
      notify();
    },
    /** Drops the thread's state for requests no longer pending. */
    prune(threadId: ThreadId, pendingRequestIds: ReadonlyArray<RuntimeRequestId>): void {
      const panel = threads.get(threadId);
      if (panel === undefined) return;
      const pending = new Set(pendingRequestIds);
      let changed = false;
      for (const requestId of panel.forms.keys()) {
        if (pending.has(requestId)) continue;
        panel.forms.delete(requestId);
        changed = true;
      }
      if (panel.active !== null && !pending.has(panel.active)) {
        panel.active = null;
        changed = true;
      }
      if (panel.forms.size === 0 && panel.active === null) threads.delete(threadId);
      if (changed) notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

export type RequestPanelStore = ReturnType<typeof createRequestPanelStore>;
