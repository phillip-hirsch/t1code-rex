import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { OrchestrationProjectShell, OrchestrationV2Subagent } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";

import { formatRelativeTime } from "./relativeTime.ts";
import type { SidebarRow, SidebarThread, SubagentDisclosure } from "./sidebarModel.ts";
import { subagentDetailPreview } from "@t3tools/client-runtime/state/subagent-display";
import { subagentStateColor } from "./subagentPresentation.ts";
import {
  SUBAGENT_STATE_LABELS,
  subagentRecordState,
  subagentShellState,
  type SubagentState,
} from "./subagentTree.ts";
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
  /** A thread row's fold glyph: show or hide its subagents. */
  readonly toggleSubagents?: boolean;
}

/** Where a subagent row's live state comes from besides its own shell row. */
export interface SidebarSubagentSource {
  /** The parent's record for a child, when the parent's subagents are loaded; else null. */
  readonly recordAtom: (
    parentThreadId: string,
    childThreadId: string,
  ) => Atom.Atom<OrchestrationV2Subagent | null> | null;
  /** The family read behind an opened thread's subagents. */
  readonly familyReadAtom: (threadId: string) => Atom.Atom<ThreadFamilyRead>;
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
  readonly subagentSource?: SidebarSubagentSource;
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
  readonly subagents: SubagentDisclosure;
  readonly onPress: (press: SidebarPress) => void;
}) {
  const { theme, thread } = props;
  const selected = props.highlight === "cursor";
  const pin = thread.pinnedAt !== null ? "󰐃 " : "";
  const fold = props.subagents === null ? 0 : 2;
  const title = `${pin}${truncateTitle(thread.title || DEFAULT_THREAD_TITLE, props.titleWidth - 3 - pin.length - fold)}`;
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
      {props.subagents === null ? null : (
        <FoldGlyph
          theme={theme}
          row={props.row}
          open={props.subagents === "open"}
          onPress={props.onPress}
        />
      )}
      <box style={{ width: props.titleWidth - fold, flexShrink: 0, overflow: "hidden", height: 1 }}>
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

/** ▸/▾ before a title: a click shows or hides the thread's subagents. */
function FoldGlyph(props: {
  readonly theme: TuiTheme;
  readonly row: SidebarRow;
  readonly open: boolean;
  readonly onPress: (press: SidebarPress) => void;
}) {
  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPress({
          row: props.row,
          secondary: false,
          x: event.x,
          y: event.y,
          toggleSubagents: true,
        });
      }}
      style={{ width: 2, flexShrink: 0 }}
    >
      <text content={props.open ? "▾" : "▸"} style={{ fg: props.theme.palette.subtle }} />
    </box>
  );
}

function SubagentDot(props: { readonly theme: TuiTheme; readonly state: SubagentState }) {
  const color = subagentStateColor(props.state, props.theme);
  if (props.state !== "working") return <text content="●" style={{ fg: color }} />;
  return <PulsingDot color={color} pulseColor={props.theme.status.pulse} />;
}

const NO_RECORD_ATOM = null;

interface SubagentRowProps {
  readonly theme: TuiTheme;
  readonly row: Extract<SidebarRow, { kind: "subagent" }>;
  readonly thread: SidebarThread;
  readonly active: boolean;
  readonly highlight: RowHighlight;
  readonly recordAtom: Atom.Atom<OrchestrationV2Subagent | null> | null;
  readonly onPress: (press: SidebarPress) => void;
}

/**
 * A subagent child under its parent: state dot, name, and progress or result once the
 * parent's record is loaded. It reads that record itself, so a progress update re-renders
 * this row alone.
 */
const SubagentRow = memo(function SubagentRow(props: SubagentRowProps) {
  return props.recordAtom === NO_RECORD_ATOM ? (
    <SubagentRowView {...props} record={null} />
  ) : (
    <SubagentRecordRow {...props} recordAtom={props.recordAtom} />
  );
});

function SubagentRecordRow(
  props: SubagentRowProps & { readonly recordAtom: Atom.Atom<OrchestrationV2Subagent | null> },
) {
  return <SubagentRowView {...props} record={useAtomValue(props.recordAtom)} />;
}

function SubagentRowView(
  props: SubagentRowProps & { readonly record: OrchestrationV2Subagent | null },
) {
  const { theme, thread, row, record } = props;
  const selected = props.highlight === "cursor";
  const state = record === null ? subagentShellState(thread) : subagentRecordState(record.status);
  const detail =
    record === null
      ? null
      : subagentDetailPreview({
          status: record.status,
          result: record.result,
          progress: record.progress,
        });
  const name = formatSubagentDisplayTitle(record?.title?.trim() || thread.title || "Subagent");
  return (
    <SidebarRowBox
      theme={theme}
      rowKey={row.key}
      row={row}
      highlight={props.highlight}
      indent={THREAD_INDENT + row.depth * 2}
      onPress={props.onPress}
    >
      {row.subagents === null ? (
        <box style={{ width: 2, flexShrink: 0 }}>
          <text content="↳" style={{ fg: theme.palette.subtle }} />
        </box>
      ) : (
        <FoldGlyph
          theme={theme}
          row={row}
          open={row.subagents === "open"}
          onPress={props.onPress}
        />
      )}
      <box style={{ width: STATUS_WIDTH, flexShrink: 0 }}>
        <SubagentDot theme={theme} state={state} />
      </box>
      <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden", height: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={detail === null ? name : `${name} · ${detail}`}
          style={{
            fg: selected
              ? theme.colors.selectedText
              : props.active
                ? theme.palette.text
                : theme.palette.muted,
          }}
        />
      </box>
      <text
        wrapMode="none"
        content={` ${SUBAGENT_STATE_LABELS[state]}`}
        style={{
          fg: selected ? theme.colors.selectedText : subagentStateColor(state, theme),
          flexShrink: 0,
        }}
      />
    </SidebarRowBox>
  );
}

/** Under an opened thread with no subagent rows: whether its family is still loading. */
function SubagentNote(props: {
  readonly theme: TuiTheme;
  readonly depth: number;
  readonly readAtom: Atom.Atom<ThreadFamilyRead>;
}) {
  const read = useAtomValue(props.readAtom);
  return (
    <NoteRow
      theme={props.theme}
      depth={props.depth}
      text={
        read === "pending"
          ? "Loading subagents…"
          : read === "failed"
            ? "Couldn't load subagents"
            : "No subagents"
      }
    />
  );
}

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

function NoteRow(props: {
  readonly theme: TuiTheme;
  readonly text: string;
  readonly depth?: number;
}) {
  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        paddingLeft: 4 + (props.depth ?? 0) * 2,
        overflow: "hidden",
      }}
    >
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
      const source = props.subagentSource;
      if (line.subagentsOf !== undefined && source !== undefined) {
        return (
          <SubagentNote
            key={line.key}
            theme={theme}
            depth={line.depth ?? 0}
            readAtom={source.familyReadAtom(line.subagentsOf)}
          />
        );
      }
      return <NoteRow key={line.key} theme={theme} text={line.text} depth={line.depth ?? 0} />;
    }
    if (line.kind === "subagent") {
      const thread = props.threadsById.get(line.threadId);
      if (!thread) return <box key={line.key} style={{ height: 1, flexShrink: 0 }} />;
      const active = props.activeThreadId === line.threadId;
      return (
        <SubagentRow
          key={line.key}
          theme={theme}
          row={line}
          thread={thread}
          active={active}
          highlight={highlightFor(line.key, props, active)}
          recordAtom={
            props.subagentSource?.recordAtom(line.parentThreadId, line.threadId) ?? NO_RECORD_ATOM
          }
          onPress={props.onPress}
        />
      );
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
          subagents={line.subagents ?? null}
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
