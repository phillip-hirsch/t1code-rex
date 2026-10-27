// @effect-diagnostics globalTimers:off -- The TUI runs on Bun outside the Effect runtime.
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { OrchestrationProjectShell, ThreadId, TimestampFormat } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import type { TuiConnection } from "./connection/tuiConnection.ts";
import { MessageMarkdown, type MarkdownStyles } from "./messageMarkdownView.tsx";
import { resolveUserMessageBubbleWidth } from "./messageLayout.ts";
import { formatMessageTimestamp } from "./messageTimestamp.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { threadStatusColor, type ThreadStatusPill } from "./sidebarStatus.ts";
import { formatElapsed, resolveRunStatusLine, type RunStatusLine } from "./threadRunStatus.ts";
import {
  anchoredScrollTop,
  isNearBottom,
  resolvePrependAnchor,
  resolveScrollKey,
  shouldLoadEarlier,
  type ScrollMetrics,
} from "./threadScroll.ts";
import {
  buildTimelineRows,
  rowHasGapAfter,
  type TimelineRow,
  type WorkAccent,
} from "./threadTimeline.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitle.ts";
import { PULSE_TICKER, RELATIVE_TIME_TICKER, useTicker } from "./ticker.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

const WORK_ROW_MAX_WIDTH = "88%";
const PENDING_REQUEST_DETAIL_MAX = 160;
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function workingFrame(tick: number): string {
  return WORKING_FRAMES[tick % WORKING_FRAMES.length] ?? "⠋";
}

export function timelineRowId(key: string): string {
  return `timeline-row:${key}`;
}

export interface ThreadViewHandle {
  /** Scroll keys while the thread has focus; true when the key was used. */
  readonly handleKey: (key: KeyEvent) => boolean;
}

export interface ThreadViewProps {
  readonly connection: TuiConnection;
  readonly threadId: ThreadId;
  /** The sidebar's row for this thread; null while the shell hasn't listed it. */
  readonly thread: EnvironmentThreadShell | null;
  readonly project: OrchestrationProjectShell | null;
  readonly statusPill: ThreadStatusPill | null;
  readonly theme: TuiTheme;
  readonly styles: MarkdownStyles;
  readonly timestampFormat: TimestampFormat;
  readonly focused: boolean;
  readonly onActivate: () => void;
  readonly onCopy: (value: string, message: string) => void;
  readonly ref?: Ref<ThreadViewHandle>;
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readMetrics(scrollbox: ScrollBoxRenderable): ScrollMetrics {
  return {
    scrollTop: scrollbox.scrollTop,
    scrollHeight: scrollbox.scrollHeight,
    viewportHeight: scrollbox.viewport.height,
  };
}

function contentTop(scrollbox: ScrollBoxRenderable, key: string): number | null {
  const node = scrollbox.content.findDescendantById(timelineRowId(key));
  return node ? node.getLayoutNode().getComputedLayout().top : null;
}

/**
 * The selected thread's transcript, live from orchestration.subscribeThread. Mounted per
 * thread (keyed by id), so switching threads starts at the bottom of the new one.
 */
export function ThreadView(props: ThreadViewProps) {
  const {
    ref,
    connection,
    threadId,
    thread,
    project,
    statusPill,
    theme,
    styles,
    timestampFormat,
    focused,
    onActivate,
    onCopy,
  } = props;
  const palette = theme.palette;
  const atoms = useMemo(() => connection.thread(threadId), [connection, threadId]);
  const visibleItems = useAtomValue(atoms.visibleTurnItemsAtom);
  const syncStatus = useAtomValue(atoms.statusAtom);
  const syncError = useAtomValue(atoms.errorAtom);
  const history = useAtomValue(atoms.historyAtom);
  const pending = useAtomValue(atoms.pendingRequestsAtom);

  const rows = useMemo(() => buildTimelineRows(visibleItems), [visibleItems]);

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const historyRef = useRef(history);

  const loadEarlier = useCallback(() => {
    void runAtomCommand(connection.registry, connection.loadEarlierHistory, threadId, {
      label: "load earlier thread history",
    });
  }, [connection, threadId]);

  const syncScroll = useCallback(
    (userScrolled: boolean) => {
      const scrollbox = scrollRef.current;
      if (!scrollbox || scrollbox.isDestroyed) return;
      const metrics = readMetrics(scrollbox);
      setAtBottom(isNearBottom(metrics));
      if (shouldLoadEarlier(metrics, historyRef.current, userScrolled)) loadEarlier();
    },
    [loadEarlier],
  );
  // Layout runs on the next frame, so read scroll positions after it.
  const scheduleSync = useCallback(
    (userScrolled: boolean) => {
      setTimeout(() => syncScroll(userScrolled), 0);
    },
    [syncScroll],
  );

  // Holding the reading position when older rows arrive above it. The anchor row's yoga
  // top is read before layout here, and again from inside the next layout pass, where
  // OpenTUI has just pinned the scroll position for the taller content.
  const pendingAnchor = useRef<{ key: string; top: number } | null>(null);
  const previousKeys = useRef<ReadonlyArray<string>>([]);
  useLayoutEffect(() => {
    const keys = rows.map((row) => row.key);
    const anchorKey = resolvePrependAnchor(previousKeys.current, keys);
    previousKeys.current = keys;
    const scrollbox = scrollRef.current;
    pendingAnchor.current = null;
    if (anchorKey !== null && scrollbox && !isNearBottom(readMetrics(scrollbox))) {
      const top = contentTop(scrollbox, anchorKey);
      if (top !== null) pendingAnchor.current = { key: anchorKey, top };
    }
    scheduleSync(false);
  }, [rows, scheduleSync]);

  useLayoutEffect(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    const content = scrollbox.content;
    const original = content.onSizeChange;
    content.onSizeChange = function onContentSizeChange() {
      original?.call(this);
      const anchor = pendingAnchor.current;
      if (anchor === null) return;
      pendingAnchor.current = null;
      const top = contentTop(scrollbox, anchor.key);
      if (top !== null && top !== anchor.top) {
        scrollbox.scrollTop = anchoredScrollTop(scrollbox.scrollTop, anchor.top, top);
      }
    };
    return () => {
      content.onSizeChange = original;
    };
  }, []);

  // A finished page can leave the view near the top, which asks for the next one.
  useLayoutEffect(() => {
    historyRef.current = history;
    scheduleSync(false);
  }, [history, scheduleSync]);

  const scrollToBottom = useCallback(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: scrollbox.scrollHeight });
    setAtBottom(true);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      handleKey: (key: KeyEvent) => {
        const scrollbox = scrollRef.current;
        if (!scrollbox) return false;
        const action = resolveScrollKey(key, scrollbox.viewport.height);
        if (action === null) return false;
        if (action.kind === "by") scrollbox.scrollBy(action.rows);
        else if (action.kind === "top") scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: 0 });
        else scrollToBottom();
        scheduleSync(true);
        return true;
      },
    }),
    [scheduleSync, scrollToBottom],
  );

  const copyCode = useCallback((value: string) => onCopy(value, "Code copied"), [onCopy]);
  const runStatus = resolveRunStatusLine(thread);
  const bubbleWidth = resolveUserMessageBubbleWidth(0);
  const loading = rows.length === 0 && syncStatus !== "live" && syncStatus !== "deleted";

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ThreadHeader thread={thread} project={project} statusPill={statusPill} theme={theme} />
      <scrollbox
        ref={scrollRef}
        stickyScroll
        stickyStart="bottom"
        onMouseDown={onActivate}
        onMouseScroll={() => {
          onActivate();
          scheduleSync(true);
        }}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingRight: 1 }}
      >
        <HistoryRow
          hasMoreHistory={history.hasMoreHistory}
          loading={history.loading}
          error={history.error}
          theme={theme}
        />
        {loading ? (
          <text content="Loading thread…" style={{ fg: palette.muted }} />
        ) : syncStatus === "deleted" ? (
          <text content="This thread was deleted." style={{ fg: palette.muted }} />
        ) : rows.length === 0 ? (
          <text content="No messages yet." style={{ fg: palette.subtle }} />
        ) : null}
        {rows.map((row, index) => (
          <TimelineRowView
            key={row.key}
            row={row}
            gapAfter={rowHasGapAfter(row, rows[index + 1])}
            styles={styles}
            timestampFormat={timestampFormat}
            bubbleWidth={bubbleWidth}
            onCopyCode={copyCode}
          />
        ))}
      </scrollbox>
      {atBottom ? (
        <box style={{ height: 1 }} />
      ) : (
        <box style={{ flexDirection: "row", justifyContent: "center", height: 1, flexShrink: 0 }}>
          <box
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onActivate();
              scrollToBottom();
            }}
            style={{
              flexDirection: "row",
              backgroundColor: palette.surfaceAlt,
              paddingLeft: 1,
              paddingRight: 1,
              height: 1,
            }}
          >
            <text content="󰁅 Scroll to bottom  (End)" style={{ fg: palette.muted }} />
          </box>
        </box>
      )}
      {syncError !== null ? (
        <text
          wrapMode="none"
          truncate
          content={`Thread sync: ${syncError}`}
          style={{ fg: palette.warning, flexShrink: 0 }}
        />
      ) : null}
      {runStatus ? <RunStatusRow status={runStatus} theme={theme} /> : null}
      <PendingRequestsNotice pending={pending} theme={theme} />
      <ComposerPlaceholder theme={theme} focused={focused} />
    </box>
  );
}

function ThreadHeader(props: {
  thread: EnvironmentThreadShell | null;
  project: OrchestrationProjectShell | null;
  statusPill: ThreadStatusPill | null;
  theme: TuiTheme;
}) {
  const { thread, project, statusPill, theme } = props;
  const clock = useTicker(RELATIVE_TIME_TICKER);
  const palette = theme.palette;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      <text
        wrapMode="none"
        truncate
        content={thread?.title || DEFAULT_THREAD_TITLE}
        style={{ fg: palette.text }}
      />
      <box style={{ flexDirection: "row", height: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={`${project?.title ?? "Unknown project"}${thread ? `  ·  updated ${formatRelativeTime(thread.updatedAt, clock.nowMs)}` : ""}`}
          style={{ fg: palette.muted }}
        />
        {statusPill ? (
          <text
            wrapMode="none"
            content={`  ·  ${statusPill.label}`}
            style={{ fg: threadStatusColor(statusPill.label, theme) }}
          />
        ) : null}
      </box>
    </box>
  );
}

function HistoryRow(props: {
  hasMoreHistory: boolean;
  loading: boolean;
  error: string | null;
  theme: TuiTheme;
}) {
  const palette = props.theme.palette;
  if (props.loading) {
    return (
      <text content="Loading earlier messages…" style={{ fg: palette.muted, marginBottom: 1 }} />
    );
  }
  if (props.error !== null) {
    return (
      <text
        content={`Couldn't load earlier messages: ${props.error}. Scroll up to retry.`}
        style={{ fg: palette.warning, marginBottom: 1 }}
      />
    );
  }
  if (props.hasMoreHistory) {
    return (
      <text
        content="↑ Scroll up for earlier messages"
        style={{ fg: palette.subtle, marginBottom: 1 }}
      />
    );
  }
  return null;
}

interface TimelineRowViewProps {
  readonly row: TimelineRow;
  readonly gapAfter: boolean;
  readonly styles: MarkdownStyles;
  readonly timestampFormat: TimestampFormat;
  readonly bubbleWidth: `${number}%`;
  readonly onCopyCode: (value: string) => void;
}

/** One row; rows keep their identity until their item changes, so memo skips the rest. */
const TimelineRowView = memo(function TimelineRowView(props: TimelineRowViewProps) {
  const { row, styles, timestampFormat, onCopyCode } = props;
  const theme = styles.theme;
  const palette = theme.palette;
  const id = timelineRowId(row.key);
  const marginBottom = props.gapAfter ? 1 : 0;
  const timestamp = formatMessageTimestamp(row.createdAtMs, timestampFormat);

  switch (row.kind) {
    case "user": {
      const meta = [
        row.attribution,
        row.intent === "steer" ? "steered" : row.intent === "queued" ? "queued" : null,
        timestamp,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        <box
          id={id}
          style={{ width: "100%", marginBottom, flexDirection: "column", alignItems: "flex-end" }}
        >
          <box
            style={{
              width: props.bubbleWidth,
              flexDirection: "column",
              flexShrink: 1,
              alignItems: "flex-end",
            }}
          >
            <box
              style={{
                width: "auto",
                maxWidth: "100%",
                minWidth: 0,
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: "column",
                flexShrink: 1,
                alignSelf: "flex-end",
                backgroundColor: palette.surfaceUser,
              }}
            >
              {row.attachments.length > 0 ? (
                <text
                  wrapMode="none"
                  truncate
                  content={row.attachments.map((name) => `󰋩 ${name}`).join("  ")}
                  style={{ fg: palette.info }}
                />
              ) : null}
              {row.text.trim().length > 0 ? (
                <MessageMarkdown
                  content={row.text}
                  styles={styles}
                  fillWidth={false}
                  onCopyCodeBlock={onCopyCode}
                />
              ) : null}
            </box>
          </box>
          <box
            style={{
              width: props.bubbleWidth,
              flexDirection: "row",
              justifyContent: "flex-end",
              flexShrink: 0,
            }}
          >
            <text content={meta} style={{ fg: palette.subtle, flexShrink: 0 }} />
          </box>
        </box>
      );
    }
    case "assistant":
      return (
        <box id={id} style={{ width: "100%", marginBottom, flexDirection: "column" }}>
          <MessageMarkdown
            content={row.text || " "}
            styles={styles}
            streaming={row.streaming}
            onCopyCodeBlock={onCopyCode}
          />
          {row.streaming ? null : (
            <text content={timestamp} style={{ fg: palette.subtle, flexShrink: 0 }} />
          )}
        </box>
      );
    case "work":
      return (
        <box
          id={id}
          style={{
            backgroundColor: palette.surface,
            marginBottom,
            maxWidth: WORK_ROW_MAX_WIDTH,
            paddingLeft: 1,
            paddingRight: 1,
            height: 1,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <box style={{ width: 3, height: 1, flexShrink: 0, alignItems: "center" }}>
            {row.status === "running" ? (
              <WorkingGlyph color={theme.status.working} />
            ) : (
              <text content={row.icon} style={{ fg: workAccentColor(row.accent, theme) }} />
            )}
          </box>
          <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden", height: 1 }}>
            <text
              wrapMode="none"
              truncate
              content={row.text}
              style={{
                fg: row.accent === "error" ? workAccentColor("error", theme) : palette.muted,
              }}
            />
          </box>
        </box>
      );
    case "plan":
      return (
        <box
          id={id}
          style={{
            backgroundColor: palette.surfacePlan,
            marginBottom,
            padding: 1,
            flexDirection: "column",
          }}
        >
          <text
            content={`plan${timestamp ? ` · ${timestamp}` : ""}`}
            style={{ fg: palette.success, marginBottom: 1 }}
          />
          <MessageMarkdown
            content={row.markdown || " "}
            styles={styles}
            streaming={row.streaming}
            onCopyCodeBlock={onCopyCode}
          />
        </box>
      );
    case "todo":
      return (
        <box
          id={id}
          style={{
            backgroundColor: palette.surface,
            marginBottom,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column",
            maxWidth: WORK_ROW_MAX_WIDTH,
          }}
        >
          <text content="Plan" style={{ fg: palette.subtle }} />
          {row.explanation ? (
            <text content={row.explanation} style={{ fg: palette.muted }} />
          ) : null}
          {row.steps.map((step) => (
            <text
              key={step.id}
              content={`${step.status === "completed" ? "✓" : step.status === "running" ? "◐" : "○"} ${step.text}`}
              style={{ fg: step.status === "completed" ? palette.subtle : palette.text }}
            />
          ))}
        </box>
      );
    case "notice": {
      const color =
        row.tone === "error"
          ? theme.colors.workEntryErrorAccent
          : row.tone === "warning"
            ? palette.warning
            : palette.muted;
      return (
        <box
          id={id}
          style={{ marginBottom, flexDirection: "column", maxWidth: WORK_ROW_MAX_WIDTH }}
        >
          <text
            content={`${row.tone === "error" ? "󰀦" : row.tone === "warning" ? "" : "󰋼"} ${row.text}`}
            style={{ fg: color }}
          />
          {row.detail ? <text content={row.detail} style={{ fg: palette.muted }} /> : null}
        </box>
      );
    }
  }
});

function workAccentColor(accent: WorkAccent, theme: TuiTheme): TuiColor {
  const palette = theme.palette;
  switch (accent) {
    case "error":
      return theme.colors.workEntryErrorAccent;
    case "command":
      return palette.text;
    case "change":
      return palette.info;
    case "read":
      return palette.muted;
    default:
      return palette.subtle;
  }
}

function WorkingGlyph(props: { color: TuiColor }) {
  const { tick } = useTicker(PULSE_TICKER);
  return <text content={workingFrame(tick)} style={{ fg: props.color }} />;
}

function RunStatusRow(props: { status: RunStatusLine; theme: TuiTheme }) {
  const { status, theme } = props;
  const palette = theme.palette;
  if (status.tone === "working") {
    return <WorkingStatusRow status={status} theme={theme} />;
  }
  return (
    <text
      wrapMode="none"
      truncate
      content={`${status.tone === "error" ? "󰀦" : ""} ${status.label}${status.detail ? `: ${status.detail}` : ""}`}
      style={{
        fg: status.tone === "error" ? theme.colors.workEntryErrorAccent : palette.warning,
        flexShrink: 0,
      }}
    />
  );
}

function WorkingStatusRow(props: { status: RunStatusLine; theme: TuiTheme }) {
  const { tick, nowMs } = useTicker(PULSE_TICKER);
  const { status, theme } = props;
  const elapsed = status.startedAtMs === null ? null : formatElapsed(nowMs - status.startedAtMs);
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <text content={`${workingFrame(tick)} `} style={{ fg: theme.status.working }} />
      <text
        wrapMode="none"
        truncate
        content={`${status.label}${elapsed ? ` · ${elapsed}` : ""}`}
        style={{ fg: theme.palette.muted }}
      />
    </box>
  );
}

function PendingRequestsNotice(props: { pending: PendingThreadRequests | null; theme: TuiTheme }) {
  const { pending, theme } = props;
  if (pending === null || (pending.approvals.length === 0 && pending.userInputs.length === 0)) {
    return null;
  }
  const palette = theme.palette;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      {pending.approvals.map((approval) => (
        <box
          key={approval.requestId}
          style={{ backgroundColor: palette.surfaceWarn, paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            wrapMode="none"
            truncate
            content={`Approval needed (${approval.requestKind})${approval.detail ? `: ${truncate(approval.detail, PENDING_REQUEST_DETAIL_MAX)}` : ""}`}
            style={{ fg: palette.text }}
          />
        </box>
      ))}
      {pending.userInputs.map((input) => (
        <box
          key={input.requestId}
          style={{ backgroundColor: palette.surfaceInfo, paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            wrapMode="none"
            truncate
            content={`Question waiting: ${truncate(input.questions.map((question) => question.question).join(" · "), PENDING_REQUEST_DETAIL_MAX)}`}
            style={{ fg: palette.text }}
          />
        </box>
      ))}
      <text
        wrapMode="none"
        truncate
        content="Answering from tr3x isn't ported yet; respond in T3 Code web or mobile."
        style={{ fg: palette.subtle }}
      />
    </box>
  );
}

function ComposerPlaceholder(props: { theme: TuiTheme; focused: boolean }) {
  const palette = props.theme.palette;
  return (
    <box
      style={{
        flexShrink: 0,
        marginTop: 1,
        height: 3,
        border: true,
        borderStyle: "rounded",
        borderColor: props.focused ? palette.composerBorder : palette.composerBorderMuted,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        wrapMode="none"
        truncate
        content="Read-only for now; the composer comes next."
        style={{ fg: palette.subtle }}
      />
    </box>
  );
}
