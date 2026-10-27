import type { MouseEvent } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo } from "react";

import {
  subagentStateColor,
  subagentStopBlocker,
  summarizeSubagent,
  summarizeSubagentRecord,
  type SubagentSummary,
  type SubagentThreadContext,
  type SubagentTurnItem,
} from "./subagentPresentation.ts";
import { SUBAGENT_STATE_LABELS, type SubagentState } from "./subagentTree.ts";
import { PULSE_TICKER, useTicker, workingFrame } from "./ticker.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

/** What a transcript's subagent rows and a child's header can do; the shell provides it. */
export interface SubagentActions {
  /** The parent's record for one of its subagents, live from the parent's subscription. */
  readonly recordAtom: (
    threadId: string,
    subagentId: string,
  ) => Atom.Atom<OrchestrationV2Subagent | null>;
  /** The parent's record for a child thread, for the child's own view. */
  readonly childRecordAtom: (
    parentThreadId: string,
    childThreadId: string,
  ) => Atom.Atom<OrchestrationV2Subagent | null>;
  readonly onOpenThread: (threadId: string) => void;
  readonly onStop: (threadId: string, subagentId: string) => void;
  /** Null outside Rex, and in Rex thread tabs, which open no tabs of their own. */
  readonly onOpenInRex: ((threadId: string) => void) | null;
}

function pressHandler(run: () => void) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };
}

// Rows without actions read this, so the hook runs the same way every render.
const NO_RECORD_ATOM = Atom.make<OrchestrationV2Subagent | null>(null);

/** "Working 12s", "Completed in 4s", "Failed": ticking while the subagent works. */
function SubagentStatusText(props: {
  readonly summary: Pick<SubagentSummary, "status" | "startedAt" | "completedAt">;
  readonly color: TuiColor;
}) {
  const live = isOrchestrationV2WorkActive(props.summary.status);
  return live ? (
    <LiveStatusText {...props} />
  ) : (
    <text
      wrapMode="none"
      content={formatProviderSubagentStatus(props.summary, 0)}
      style={{ fg: props.color, flexShrink: 0 }}
    />
  );
}

function LiveStatusText(props: {
  readonly summary: Pick<SubagentSummary, "status" | "startedAt" | "completedAt">;
  readonly color: TuiColor;
}) {
  const { tick, nowMs } = useTicker(PULSE_TICKER);
  return (
    <text
      wrapMode="none"
      content={`${workingFrame(tick)} ${formatProviderSubagentStatus(props.summary, nowMs)}`}
      style={{ fg: props.color, flexShrink: 0 }}
    />
  );
}

function ActionLabel(props: {
  readonly label: string;
  readonly color: TuiColor;
  readonly onPress: () => void;
}) {
  return (
    <box onMouseDown={pressHandler(props.onPress)} style={{ flexShrink: 0, height: 1 }}>
      <text wrapMode="none" content={`  ${props.label}`} style={{ fg: props.color }} />
    </box>
  );
}

/**
 * A subagent in the parent's transcript: name, model, status, and its progress or result.
 * Clicking it opens the child thread; its own buttons stop it or open it in a Rex tab. It
 * reads its record itself, so progress re-renders this row and nothing else.
 */
export const SubagentTimelineRow = memo(function SubagentTimelineRow(props: {
  readonly id: string;
  readonly threadId: string;
  readonly item: SubagentTurnItem;
  readonly marginBottom: number;
  readonly maxWidth: `${number}%`;
  readonly theme: TuiTheme;
  readonly actions: SubagentActions | undefined;
}) {
  const { item, theme, actions } = props;
  const palette = theme.palette;
  const record = useAtomValue(
    actions?.recordAtom(props.threadId, item.subagentId) ?? NO_RECORD_ATOM,
  );
  const summary = summarizeSubagent({ item, record });
  const color = subagentStateColor(summary.state, theme);
  const childThreadId = summary.childThreadId;
  const canStop = actions !== undefined && subagentStopBlocker(record) === null;
  const open =
    actions === undefined || childThreadId === null
      ? undefined
      : () => actions.onOpenThread(childThreadId);
  return (
    <box
      id={props.id}
      {...(open === undefined ? {} : { onMouseDown: pressHandler(open) })}
      style={{
        backgroundColor: palette.surface,
        marginBottom: props.marginBottom,
        maxWidth: props.maxWidth,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "column",
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text content="󰚩  " style={{ fg: color, flexShrink: 0 }} />
        <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden", height: 1 }}>
          <text
            wrapMode="none"
            truncate
            content={summary.model === null ? summary.title : `${summary.title} · ${summary.model}`}
            style={{ fg: palette.text }}
          />
        </box>
        <text content="  " style={{ flexShrink: 0 }} />
        <SubagentStatusText summary={summary} color={color} />
        {canStop ? (
          <ActionLabel
            label="■ stop"
            color={palette.composerStop}
            onPress={() => actions.onStop(props.threadId, item.subagentId)}
          />
        ) : null}
        {actions?.onOpenInRex && childThreadId !== null ? (
          <ActionLabel
            label="⧉ tab"
            color={palette.info}
            onPress={() => actions.onOpenInRex?.(childThreadId)}
          />
        ) : null}
        {open === undefined ? null : (
          <text wrapMode="none" content="  open ›" style={{ fg: palette.info, flexShrink: 0 }} />
        )}
      </box>
      {summary.detail === null ? null : (
        <box style={{ flexDirection: "row", height: 1, paddingLeft: 3, overflow: "hidden" }}>
          <text wrapMode="none" truncate content={summary.detail} style={{ fg: palette.muted }} />
        </box>
      )}
    </box>
  );
});

/**
 * A child thread's line under its title: the parent it belongs to (click, or p, opens it),
 * its status from the parent's record, and stop and Rex buttons when they apply.
 */
export function SubagentParentLine(props: {
  readonly threadId: string;
  readonly context: SubagentThreadContext;
  readonly theme: TuiTheme;
  readonly actions: SubagentActions;
}) {
  const { context, theme, actions, threadId } = props;
  const palette = theme.palette;
  const record = useAtomValue(actions.childRecordAtom(context.parentThreadId, threadId));
  const summary = record === null ? null : summarizeSubagentRecord(record);
  const canStop = record !== null && subagentStopBlocker(record) === null;
  return (
    <box style={{ flexDirection: "row", height: 1 }}>
      <box
        onMouseDown={pressHandler(() => actions.onOpenThread(context.parentThreadId))}
        style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", height: 1 }}
      >
        <text
          wrapMode="none"
          truncate
          content={`↖ Subagent of ${context.parentTitle ?? "its parent thread"}  (p)`}
          style={{ fg: palette.info }}
        />
      </box>
      {summary === null ? null : (
        <>
          <text content="  ·  " style={{ fg: palette.subtle, flexShrink: 0 }} />
          <SubagentStatusText summary={summary} color={subagentStateColor(summary.state, theme)} />
        </>
      )}
      {canStop ? (
        <ActionLabel
          label="■ stop"
          color={palette.composerStop}
          onPress={() => actions.onStop(context.parentThreadId, record.id)}
        />
      ) : null}
      {actions.onOpenInRex ? (
        <ActionLabel
          label="⧉ tab"
          color={palette.info}
          onPress={() => actions.onOpenInRex?.(threadId)}
        />
      ) : null}
    </box>
  );
}

/**
 * Stands in for the composer on a provider-native child, which takes no messages: what runs
 * it, how it stands, and the way back to its parent.
 */
export function SubagentComposerBar(props: {
  readonly threadId: string;
  readonly context: SubagentThreadContext;
  readonly modelLabel: string;
  readonly fallbackState: SubagentState;
  readonly reason: string;
  readonly theme: TuiTheme;
  readonly actions: SubagentActions;
}) {
  const { context, theme, actions } = props;
  const palette = theme.palette;
  const record = useAtomValue(actions.childRecordAtom(context.parentThreadId, props.threadId));
  const summary = record === null ? null : summarizeSubagentRecord(record);
  const state = summary?.state ?? props.fallbackState;
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        border: ["top"],
        borderColor: palette.divider,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text content="󰚩  " style={{ fg: subagentStateColor(state, theme), flexShrink: 0 }} />
        <text
          wrapMode="none"
          content={summary?.model ?? props.modelLabel}
          style={{ fg: palette.text, flexShrink: 0 }}
        />
        <text content="  ·  " style={{ fg: palette.subtle, flexShrink: 0 }} />
        {summary === null ? (
          <text
            wrapMode="none"
            content={SUBAGENT_STATE_LABELS[state]}
            style={{ fg: subagentStateColor(state, theme), flexShrink: 0 }}
          />
        ) : (
          <SubagentStatusText summary={summary} color={subagentStateColor(state, theme)} />
        )}
        <box style={{ flexGrow: 1 }} />
        <ActionLabel
          label="↖ open parent (p)"
          color={palette.info}
          onPress={() => actions.onOpenThread(context.parentThreadId)}
        />
      </box>
      <text wrapMode="none" truncate content={props.reason} style={{ fg: palette.muted }} />
    </box>
  );
}
