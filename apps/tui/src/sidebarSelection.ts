import type { SidebarRow } from "./sidebarModel.ts";

/**
 * Threads picked for a bulk action, as in the old TUI: Shift+↑/↓ or Shift+click extends a
 * range from the anchor, Ctrl+click toggles one, Esc clears. The open thread is separate;
 * an empty selection means actions apply to the thread under the cursor.
 */
export interface ThreadMultiSelection {
  readonly threadIds: ReadonlySet<string>;
  readonly anchorThreadId: string | null;
}

export const EMPTY_MULTI_SELECTION: ThreadMultiSelection = {
  threadIds: new Set(),
  anchorThreadId: null,
};

/** Thread ids in the order the sidebar lists them. */
export function orderedThreadIds(rows: ReadonlyArray<SidebarRow>): ReadonlyArray<string> {
  return rows.flatMap((row) => (row.kind === "thread" ? [row.threadId] : []));
}

export function toggleThreadInSelection(
  selection: ThreadMultiSelection,
  threadId: string,
): ThreadMultiSelection {
  const next = new Set(selection.threadIds);
  if (!next.delete(threadId)) next.add(threadId);
  return {
    threadIds: next,
    anchorThreadId: next.has(threadId) ? threadId : selection.anchorThreadId,
  };
}

/** Adds every thread between the anchor and `threadId`; with no anchor, starts one there. */
export function selectThreadRange(
  selection: ThreadMultiSelection,
  threadId: string,
  order: ReadonlyArray<string>,
): ThreadMultiSelection {
  const anchor = selection.anchorThreadId;
  const anchorIndex = anchor === null ? -1 : order.indexOf(anchor);
  const targetIndex = order.indexOf(threadId);
  if (anchorIndex === -1 || targetIndex === -1) {
    return { threadIds: new Set([...selection.threadIds, threadId]), anchorThreadId: threadId };
  }
  const next = new Set(selection.threadIds);
  for (
    let index = Math.min(anchorIndex, targetIndex);
    index <= Math.max(anchorIndex, targetIndex);
    index += 1
  ) {
    const id = order[index];
    if (id !== undefined) next.add(id);
  }
  return { threadIds: next, anchorThreadId: anchor };
}

/**
 * Shift+↑/↓ from the thread `fromThreadId`: the first press selects it and its neighbor,
 * later ones extend from the anchor. Returns the thread the cursor moves to, or null at an
 * end of the list.
 */
export function extendThreadSelection(
  selection: ThreadMultiSelection,
  fromThreadId: string,
  order: ReadonlyArray<string>,
  delta: -1 | 1,
): { readonly selection: ThreadMultiSelection; readonly threadId: string } | null {
  const index = order.indexOf(fromThreadId);
  if (index === -1) return null;
  const threadId = order[index + delta];
  if (threadId === undefined) return null;
  const base =
    selection.threadIds.size === 0
      ? { threadIds: new Set([fromThreadId]), anchorThreadId: fromThreadId }
      : selection;
  return { selection: selectThreadRange(base, threadId, order), threadId };
}

/** Drops threads that left the list (archived, deleted, or elsewhere). Keeps identity if none did. */
export function pruneThreadSelection(
  selection: ThreadMultiSelection,
  isLive: (threadId: string) => boolean,
): ThreadMultiSelection {
  let changed = false;
  const next = new Set<string>();
  for (const id of selection.threadIds) {
    if (isLive(id)) next.add(id);
    else changed = true;
  }
  const anchorGone = selection.anchorThreadId !== null && !isLive(selection.anchorThreadId);
  if (!changed && !anchorGone) return selection;
  return { threadIds: next, anchorThreadId: anchorGone ? null : selection.anchorThreadId };
}
