import type { ScrollBoxRenderable } from "@opentui/core";
import { useLayoutEffect, useState, type RefObject } from "react";

import { isNearBottom, PrependAnchorTracker } from "./threadScroll.ts";

export function timelineRowId(key: string): string {
  return `timeline-row:${key}`;
}

/** A timeline row's yoga top inside the scrolled content, from the last layout. */
export function timelineRowTop(scrollbox: ScrollBoxRenderable, key: string): number | null {
  const node = scrollbox.content.findDescendantById(timelineRowId(key));
  return node ? node.getLayoutNode().getComputedLayout().top : null;
}

function attachTranscriptScrollbox(
  scrollbox: ScrollBoxRenderable,
  anchor: PrependAnchorTracker,
): () => void {
  // The app's key handler is the only keyboard path. A click would otherwise focus the
  // scrollbox, and its native handler would scroll again on the same key, even after the
  // app moves focus to the sidebar. blur() is a no-op once it isn't focusable.
  scrollbox.blur();
  scrollbox.focusable = false;

  // Correct for rows prepended above inside the layout pass, right after OpenTUI resizes
  // the content, so the jump is never drawn.
  const content = scrollbox.content;
  const original = content.onSizeChange;
  content.onSizeChange = function onContentSizeChange() {
    original?.call(this);
    const scrollTop = anchor.consume((key) => timelineRowTop(scrollbox, key), scrollbox.scrollTop);
    if (scrollTop !== null) scrollbox.scrollTop = scrollTop;
  };
  return () => {
    content.onSizeChange = original;
  };
}

/**
 * Leaves keyboard scrolling to the app and keeps the reading position when rows are
 * prepended or what renders above them (`above`, e.g. the history hint) changes. `rowKeys`
 * must keep its identity until the rows change; `afterCommit` runs after each commit.
 */
export function useTranscriptScrollbox(
  scrollRef: RefObject<ScrollBoxRenderable | null>,
  rowKeys: ReadonlyArray<string>,
  above: string,
  afterCommit?: () => void,
): void {
  const [anchor] = useState(() => new PrependAnchorTracker());
  useLayoutEffect(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    return attachTranscriptScrollbox(scrollbox, anchor);
  }, [anchor, scrollRef]);

  useLayoutEffect(() => {
    const scrollbox = scrollRef.current;
    if (scrollbox) {
      anchor.commit(
        rowKeys,
        (key) => timelineRowTop(scrollbox, key),
        isNearBottom({
          scrollTop: scrollbox.scrollTop,
          scrollHeight: scrollbox.scrollHeight,
          viewportHeight: scrollbox.viewport.height,
        }),
        above,
      );
    }
    afterCommit?.();
  }, [above, afterCommit, anchor, rowKeys, scrollRef]);
}
