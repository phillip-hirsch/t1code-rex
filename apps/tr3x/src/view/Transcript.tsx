import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useImperativeHandle, useRef, type Ref } from "react";

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

export function Transcript({
  rows,
  styles,
  header,
  empty,
  ref,
}: {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly styles: MarkdownStyles;
  /** Shown above the first row: older history, loading, or nothing. */
  readonly header: string | null;
  readonly empty: string;
  readonly ref?: Ref<TranscriptHandle>;
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
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
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}
    >
      {header ? <text content={header} fg={palette.subtle} /> : null}
      {rows.length === 0 ? <text content={empty} fg={palette.subtle} /> : null}
      {rows.map((row) => (
        <Row key={row.key} row={row} styles={styles} />
      ))}
    </scrollbox>
  );
}
