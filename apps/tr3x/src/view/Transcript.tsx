import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";

import { palette, type MarkdownStyles } from "./theme.ts";
import type { DividerTone, TimelineRow, WorkStatus } from "./timeline.ts";

export interface TranscriptHandle {
  /** Scrolls by a page; returns true when it reached the top, where older history loads. */
  readonly page: (direction: -1 | 1) => boolean;
}

const STATUS_COLOR: Record<WorkStatus, string> = {
  running: palette.accent,
  done: palette.muted,
  failed: palette.error,
  stopped: palette.warning,
};

const DIVIDER_COLOR: Record<DividerTone, string> = {
  info: palette.muted,
  warning: palette.warning,
  error: palette.error,
};

const Row = memo(function Row({ row, styles }: { row: TimelineRow; styles: MarkdownStyles }) {
  switch (row.kind) {
    case "user":
      return (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="›" fg={palette.user} style={{ marginRight: 1 }} />
            <box style={{ flexGrow: 1, flexShrink: 1 }}>
              <markdown
                content={row.text}
                syntaxStyle={styles.user}
                conceal
                style={{ width: "100%" }}
              />
            </box>
          </box>
          {row.note ? <text content={`  ${row.note}`} fg={palette.subtle} /> : null}
        </box>
      );
    case "assistant":
      return (
        <box style={{ marginTop: 1 }}>
          <markdown
            content={row.text}
            syntaxStyle={styles.assistant}
            conceal
            streaming={row.streaming}
          />
        </box>
      );
    case "work":
      return (
        <text
          content={`${row.status === "running" ? "▸" : row.icon} ${row.text}`}
          fg={STATUS_COLOR[row.status]}
          truncate
          wrapMode="none"
        />
      );
    case "divider":
      return (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text content={`── ${row.text} ──`} fg={DIVIDER_COLOR[row.tone]} />
          {row.detail ? <text content={row.detail} fg={palette.subtle} /> : null}
        </box>
      );
  }
});

const rowId = (key: string) => `row:${key}`;

/**
 * Holds the reading position when older rows are prepended: OpenTUI keeps the
 * absolute scroll offset, so without this the view would jump to the new rows.
 */
class PrependAnchor {
  private keys: ReadonlyArray<string> = [];
  private pending: {
    readonly key: string;
    readonly top: number;
    readonly scrollTop: number;
  } | null = null;

  /** After React commits, before OpenTUI lays the new rows out. */
  commit(keys: ReadonlyArray<string>, scrollbox: ScrollBoxRenderable): void {
    const first = this.keys[0];
    this.keys = keys;
    // A prepend: the old first row is still here, further down.
    if (first === undefined || keys[0] === first || !keys.includes(first)) return;
    // At the bottom, sticky scrolling already keeps the latest rows in view.
    if (scrollbox.scrollTop + scrollbox.viewport.height >= scrollbox.scrollHeight - 1) return;
    const node = scrollbox.content.findDescendantById(rowId(first));
    if (node) {
      this.pending = {
        key: first,
        top: node.getComputedLayout().top,
        scrollTop: scrollbox.scrollTop,
      };
    }
  }

  /** Once the content has its new size: move by as much as the anchored row did. */
  apply(scrollbox: ScrollBoxRenderable): void {
    const anchor = this.pending;
    this.pending = null;
    const node = anchor ? scrollbox.content.findDescendantById(rowId(anchor.key)) : undefined;
    if (!anchor || !node) return;
    scrollbox.scrollTop = anchor.scrollTop + node.getComputedLayout().top - anchor.top;
  }
}

export function Transcript({
  rows,
  styles,
  header,
  empty,
  visible,
  ref,
}: {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly styles: MarkdownStyles;
  /** Shown above the first row: older history, loading, or nothing. */
  readonly header: string | null;
  readonly empty: string;
  /** Hidden when the layout leaves it no rows: a scrollbox with none still draws its first. */
  readonly visible: boolean;
  readonly ref?: Ref<TranscriptHandle>;
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [anchor] = useState(() => new PrependAnchor());
  // Corrects inside OpenTUI's layout pass, right after the content resizes, so the jump never draws.
  useLayoutEffect(() => {
    const content = scrollRef.current?.content;
    if (!content) return;
    const original = content.onSizeChange;
    content.onSizeChange = function onContentSizeChange() {
      original?.call(this);
      if (scrollRef.current) anchor.apply(scrollRef.current);
    };
    return () => {
      content.onSizeChange = original;
    };
  }, [anchor]);
  useLayoutEffect(() => {
    if (scrollRef.current)
      anchor.commit(
        rows.map((row) => row.key),
        scrollRef.current,
      );
  }, [anchor, rows]);
  useImperativeHandle(ref, () => ({
    page: (direction) => {
      const scrollbox = scrollRef.current;
      if (!scrollbox) return false;
      scrollbox.scrollBy(direction * Math.max(1, scrollbox.viewport.height - 2));
      return scrollbox.scrollTop <= 0;
    },
  }));
  return (
    <scrollbox
      ref={scrollRef}
      stickyScroll
      stickyStart="bottom"
      visible={visible}
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}
    >
      {header ? <text content={header} fg={palette.subtle} /> : null}
      {rows.length === 0 ? <text content={empty} fg={palette.subtle} /> : null}
      {rows.map((row) => (
        <box key={row.key} id={rowId(row.key)}>
          <Row row={row} styles={styles} />
        </box>
      ))}
    </scrollbox>
  );
}
