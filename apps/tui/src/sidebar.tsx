import type { BoxRenderable, MouseEvent } from "@opentui/core";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";

import { formatRelativeTime } from "./relativeTime.ts";
import type { SidebarRow, SidebarThread } from "./sidebarModel.ts";
import { threadStatusColor, type ThreadStatusPill } from "./sidebarStatus.ts";
import {
  buildSidebarLines,
  clampScrollTop,
  revealLine,
  scrollbarThumb,
  type SidebarLine,
} from "./sidebarWindow.ts";
import { DEFAULT_THREAD_TITLE, truncateTitle } from "./threadTitle.ts";
import { PULSE_TICKER, RELATIVE_TIME_TICKER, useTicker } from "./ticker.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

const ROW_PADDING = 2;
const THREAD_INDENT = 1;
const STATUS_WIDTH = 2;
const TIMESTAMP_WIDTH = 4;
const TIMESTAMP_GAP = 1;

export function sidebarRowId(key: string): string {
  return `sidebar-row:${key}`;
}

export interface SidebarPress {
  readonly row: SidebarRow;
  readonly secondary: boolean;
  readonly x: number;
  readonly y: number;
  /** Ctrl+click toggles a thread in the multi-selection; Shift+click extends it. */
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  /** The project row's "+" button: start a new thread there. */
  readonly newThread?: boolean;
}

export interface SidebarProps {
  readonly theme: TuiTheme;
  readonly width: number;
  readonly focused: boolean;
  readonly rows: ReadonlyArray<SidebarRow>;
  readonly projectsById: ReadonlyMap<string, OrchestrationProjectShell>;
  readonly threadsById: ReadonlyMap<string, SidebarThread>;
  readonly threadCountByProject: ReadonlyMap<string, number>;
  readonly olderSettledByProject: ReadonlyMap<string, number>;
  readonly statusByThread: ReadonlyMap<string, ThreadStatusPill | null>;
  readonly projectStatusById: ReadonlyMap<string, ThreadStatusPill | null>;
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly activeProjectId: string | null;
  readonly activeThreadId: string | null;
  readonly cursorKey: string | null;
  /** Threads picked for a bulk action. */
  readonly multiSelectedThreadIds: ReadonlySet<string>;
  readonly emptyLabel: string;
  readonly onPress: (press: SidebarPress) => void;
}

type RowHighlight = "cursor" | "active" | "none";

function rowBackground(theme: TuiTheme, highlight: RowHighlight, hovered: boolean): TuiColor {
  if (highlight === "cursor") return theme.palette.selection;
  if (highlight === "active") return theme.palette.controlActiveStrong;
  return hovered ? theme.palette.controlHover : "transparent";
}

function SidebarRowBox(props: {
  readonly theme: TuiTheme;
  readonly rowKey: string;
  readonly row: SidebarRow;
  readonly highlight: RowHighlight;
  readonly indent: number;
  readonly onPress: (press: SidebarPress) => void;
  readonly children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const { row, onPress } = props;
  return (
    <box
      id={sidebarRowId(props.rowKey)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onPress({
          row,
          secondary: event.button === 2,
          x: event.x,
          y: event.y,
          ctrl: event.modifiers.ctrl,
          shift: event.modifiers.shift,
        });
      }}
      style={{
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "center",
        overflow: "hidden",
        marginLeft: props.indent,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: rowBackground(props.theme, props.highlight, hovered),
      }}
    >
      {props.children}
    </box>
  );
}

function StatusDot(props: { readonly theme: TuiTheme; readonly status: ThreadStatusPill }) {
  const color = threadStatusColor(props.status.label, props.theme);
  if (!props.status.pulse) return <text content="●" style={{ fg: color }} />;
  return <PulsingDot color={color} pulseColor={props.theme.status.pulse} />;
}

function PulsingDot(props: { readonly color: TuiColor; readonly pulseColor: TuiColor }) {
  const { tick } = useTicker(PULSE_TICKER);
  return <text content="●" style={{ fg: tick % 2 === 0 ? props.color : props.pulseColor }} />;
}

function RelativeTime(props: { readonly iso: string; readonly color: TuiColor }) {
  const { nowMs } = useTicker(RELATIVE_TIME_TICKER);
  return (
    <text
      wrapMode="none"
      content={formatRelativeTime(props.iso, nowMs).padStart(TIMESTAMP_WIDTH)}
      style={{ fg: props.color }}
    />
  );
}

const ProjectRow = memo(function ProjectRow(props: {
  readonly theme: TuiTheme;
  readonly row: SidebarRow;
  readonly project: OrchestrationProjectShell;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly highlight: RowHighlight;
  readonly status: ThreadStatusPill | null;
  readonly onPress: (press: SidebarPress) => void;
}) {
  const { theme } = props;
  const showStatus = !props.expanded && props.status !== null;
  return (
    <SidebarRowBox
      theme={theme}
      rowKey={props.row.key}
      row={props.row}
      highlight={props.highlight}
      indent={0}
      onPress={props.onPress}
    >
      <box style={{ width: 2, flexShrink: 0 }}>
        {showStatus && props.status ? (
          <StatusDot theme={theme} status={props.status} />
        ) : (
          <text content={props.expanded ? "▾" : "▸"} style={{ fg: theme.palette.subtle }} />
        )}
      </box>
      <text content="󰉋 " style={{ fg: theme.palette.muted }} />
      <text
        wrapMode="none"
        truncate
        content={props.project.title}
        style={{
          fg:
            props.highlight === "cursor"
              ? theme.colors.selectedText
              : props.active
                ? theme.palette.text
                : theme.palette.muted,
          flexGrow: 1,
        }}
      />
      <box
        onMouseDown={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          props.onPress({
            row: props.row,
            secondary: false,
            x: event.x,
            y: event.y,
            newThread: true,
          });
        }}
        style={{ width: 2, flexShrink: 0, alignItems: "flex-end" }}
      >
        <text content="+" style={{ fg: theme.palette.subtle }} />
      </box>
    </SidebarRowBox>
  );
});

const ThreadRow = memo(function ThreadRow(props: {
  readonly theme: TuiTheme;
  readonly row: SidebarRow;
  readonly thread: SidebarThread;
  readonly titleWidth: number;
  readonly active: boolean;
  readonly highlight: RowHighlight;
  readonly status: ThreadStatusPill | null;
  readonly multiSelected: boolean;
  readonly onPress: (press: SidebarPress) => void;
}) {
  const { theme, thread } = props;
  const selected = props.highlight === "cursor";
  const pin = thread.pinnedAt !== null ? "󰐃 " : "";
  const title = `${pin}${truncateTitle(thread.title || DEFAULT_THREAD_TITLE, props.titleWidth - 3 - pin.length)}`;
  const settled = thread.settledOverride === "settled";
  return (
    <SidebarRowBox
      theme={theme}
      rowKey={props.row.key}
      row={props.row}
      highlight={props.highlight}
      indent={THREAD_INDENT}
      onPress={props.onPress}
    >
      <box style={{ width: STATUS_WIDTH, flexShrink: 0 }}>
        {props.multiSelected ? (
          <text content="✓" style={{ fg: theme.palette.accent }} />
        ) : props.status ? (
          <StatusDot theme={theme} status={props.status} />
        ) : null}
      </box>
      <box style={{ width: props.titleWidth, flexShrink: 0, overflow: "hidden", height: 1 }}>
        <text
          wrapMode="none"
          content={title}
          style={{
            fg: selected
              ? theme.colors.selectedText
              : props.active
                ? theme.palette.text
                : settled
                  ? theme.palette.subtle
                  : theme.palette.muted,
          }}
        />
      </box>
      <box style={{ width: TIMESTAMP_WIDTH, marginLeft: TIMESTAMP_GAP, flexShrink: 0 }}>
        <RelativeTime
          iso={thread.updatedAt}
          color={
            selected
              ? theme.colors.selectedText
              : props.active
                ? theme.palette.muted
                : theme.palette.subtle
          }
        />
      </box>
    </SidebarRowBox>
  );
});

const MoreRow = memo(function MoreRow(props: {
  readonly theme: TuiTheme;
  readonly row: Extract<SidebarRow, { kind: "more" }>;
  readonly highlight: RowHighlight;
  readonly onPress: (press: SidebarPress) => void;
}) {
  return (
    <SidebarRowBox
      theme={props.theme}
      rowKey={props.row.key}
      row={props.row}
      highlight={props.highlight}
      indent={THREAD_INDENT}
      onPress={props.onPress}
    >
      <text
        wrapMode="none"
        content={
          props.row.hiddenCount > 0 ? `  Show ${props.row.hiddenCount} more` : "  Show fewer"
        }
        style={{
          fg:
            props.highlight === "cursor"
              ? props.theme.colors.selectedText
              : props.theme.palette.subtle,
        }}
      />
    </SidebarRowBox>
  );
});

function NoteRow(props: { readonly theme: TuiTheme; readonly text: string }) {
  return (
    <box style={{ height: 1, flexShrink: 0, paddingLeft: 4, overflow: "hidden" }}>
      <text
        wrapMode="none"
        truncate
        content={props.text}
        style={{ fg: props.theme.palette.subtle }}
      />
    </box>
  );
}

function highlightFor(
  key: string,
  props: Pick<SidebarProps, "cursorKey" | "focused">,
  active: boolean,
): RowHighlight {
  if (props.focused && key === props.cursorKey) return "cursor";
  return active ? "active" : "none";
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const { theme, rows } = props;
  const titleWidth = Math.max(
    8,
    props.width -
      1 -
      ROW_PADDING -
      THREAD_INDENT -
      STATUS_WIDTH -
      TIMESTAMP_GAP -
      TIMESTAMP_WIDTH -
      1,
  );

  const lines = useMemo(
    () =>
      buildSidebarLines({
        rows,
        expandedProjectIds: props.expandedProjectIds,
        threadCountByProject: props.threadCountByProject,
        olderSettledByProject: props.olderSettledByProject,
      }),
    [rows, props.expandedProjectIds, props.threadCountByProject, props.olderSettledByProject],
  );
  const viewportRef = useRef<BoxRenderable | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  // Keep the cursor in view when it moves, its row shifts (Show more), or the viewport
  // resizes. Mouse-wheel scrolling leaves the cursor where it is.
  const cursorIndex =
    props.cursorKey === null ? -1 : lines.findIndex((line) => line.key === props.cursorKey);
  const [revealed, setRevealed] = useState({ cursorIndex: -1, viewportHeight: 0 });
  if (revealed.cursorIndex !== cursorIndex || revealed.viewportHeight !== viewportHeight) {
    setRevealed({ cursorIndex, viewportHeight });
    setScrollTop((current) =>
      revealLine(
        clampScrollTop(current, lines.length, viewportHeight),
        viewportHeight,
        cursorIndex,
      ),
    );
  }
  const top = clampScrollTop(scrollTop, lines.length, viewportHeight);
  const thumb = scrollbarThumb(lines.length, viewportHeight, top);

  const renderLine = (line: SidebarLine): ReactNode => {
    if (line.kind === "note") {
      return <NoteRow key={line.key} theme={theme} text={line.text} />;
    }
    if (line.kind === "project") {
      const project = props.projectsById.get(line.projectId);
      if (!project) return <box key={line.key} style={{ height: 1, flexShrink: 0 }} />;
      const active = props.activeProjectId === line.projectId;
      return (
        <ProjectRow
          key={line.key}
          theme={theme}
          row={line}
          project={project}
          expanded={props.expandedProjectIds.has(line.projectId)}
          active={active}
          highlight={highlightFor(line.key, props, active)}
          status={props.projectStatusById.get(line.projectId) ?? null}
          onPress={props.onPress}
        />
      );
    }
    if (line.kind === "thread") {
      const thread = props.threadsById.get(line.threadId);
      if (!thread) return <box key={line.key} style={{ height: 1, flexShrink: 0 }} />;
      const active = props.activeThreadId === line.threadId;
      return (
        <ThreadRow
          key={line.key}
          theme={theme}
          row={line}
          thread={thread}
          titleWidth={titleWidth}
          active={active}
          highlight={highlightFor(line.key, props, active)}
          status={props.statusByThread.get(line.threadId) ?? null}
          multiSelected={props.multiSelectedThreadIds.has(line.threadId)}
          onPress={props.onPress}
        />
      );
    }
    return (
      <MoreRow
        key={line.key}
        theme={theme}
        row={line}
        highlight={highlightFor(line.key, props, false)}
        onPress={props.onPress}
      />
    );
  };

  return (
    <box
      style={{
        width: props.width,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: theme.palette.sidebar,
        border: ["right"],
        borderColor: props.focused ? theme.palette.accent : theme.palette.divider,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, paddingLeft: 1, marginTop: 1, marginBottom: 1 }}>
        <text wrapMode="none" content="PROJECTS" style={{ fg: theme.palette.subtle }} />
      </box>
      <box
        ref={viewportRef}
        style={{ flexGrow: 1, minHeight: 0, flexDirection: "row", overflow: "hidden" }}
        onSizeChange={() => setViewportHeight(viewportRef.current?.height ?? 0)}
        onMouseScroll={(event: MouseEvent) => {
          const direction = event.scroll?.direction;
          if (direction !== "up" && direction !== "down") return;
          const step = Math.max(1, event.scroll?.delta ?? 1) * (direction === "up" ? -1 : 1);
          setScrollTop(clampScrollTop(top + step, lines.length, viewportHeight));
        }}
      >
        <box style={{ flexGrow: 1, flexDirection: "column", overflow: "hidden" }}>
          {rows.length === 0 ? (
            <box style={{ paddingLeft: 2, paddingRight: 1 }}>
              <text content={props.emptyLabel} style={{ fg: theme.palette.muted }} />
            </box>
          ) : (
            lines.slice(top, top + viewportHeight).map(renderLine)
          )}
        </box>
        <box style={{ width: 1, flexShrink: 0 }}>
          {thumb ? (
            <text
              content={Array.from({ length: viewportHeight }, (_, index) =>
                index >= thumb.start && index < thumb.start + thumb.size ? "█" : " ",
              ).join("\n")}
              style={{ fg: theme.palette.subtle }}
            />
          ) : null}
        </box>
      </box>
    </box>
  );
});
