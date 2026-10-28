import { resolveHandoffEndpoints, type HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import {
  IDLE_COMPACTION_TITLES,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import {
  contextCompactionLabel,
  liveThoughtLine,
  normalizeCompactToolLabel,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";

import { endpointLabel } from "./picker.ts";

type TurnItem = OrchestrationV2TurnItem;
type ItemOf<T extends TurnItem["type"]> = Extract<TurnItem, { type: T }>;

export type WorkStatus = "running" | "done" | "failed" | "stopped";
export type DividerTone = "info" | "warning" | "error";

/** One transcript line or block. `key` is stable across updates of the same item. */
export type TimelineRow =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly text: string;
      readonly note: string | null;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly icon: string;
      readonly text: string;
      readonly status: WorkStatus;
    }
  | {
      readonly kind: "divider";
      readonly key: string;
      readonly tone: DividerTone;
      readonly text: string;
      readonly detail: string | null;
    };

const ICONS = {
  command: "$",
  change: "±",
  read: "◎",
  web: "◍",
  tool: "⚙",
  agent: "◆",
  request: "?",
  thinking: "…",
} as const;

function firstLine(value: string | null | undefined): string | null {
  const line = value
    ?.split(/\r?\n/u)
    .find((part) => part.trim().length > 0)
    ?.trim();
  return line ? line : null;
}

function capitalize(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}` : value;
}

function titleOf(item: TurnItem): string | null {
  const title = item.title?.trim();
  return title ? capitalize(normalizeCompactToolLabel(title)) : null;
}

function workStatus(item: TurnItem): WorkStatus {
  if (isOrchestrationV2WorkActive(item.status)) return "running";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled" || item.status === "interrupted") return "stopped";
  if (
    item.type === "command_execution" &&
    (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0))
  ) {
    return "failed";
  }
  return "done";
}

function fileChangePreview(item: ItemOf<"file_change">): string {
  const files = item.changes?.map((change) => change.path) ?? [item.fileName];
  const more = files.length > 1 ? ` +${files.length - 1} more` : "";
  const stats =
    item.additions !== undefined || item.deletions !== undefined
      ? ` (+${item.additions ?? 0} -${item.deletions ?? 0})`
      : "";
  return `${files[0] ?? item.fileName}${more}${stats}`;
}

/** A tool's one-line row: icon, heading and a short preview. Null for items without one. */
function workLine(
  item: TurnItem,
): { readonly icon: string; readonly heading: string; readonly preview: string | null } | null {
  const running = isOrchestrationV2WorkActive(item.status);
  switch (item.type) {
    case "command_execution":
      return {
        icon: ICONS.command,
        heading: titleOf(item) ?? (running ? "Running command" : "Ran command"),
        preview: firstLine(commandDisplayText(item.input)),
      };
    case "file_change":
      return {
        icon: ICONS.change,
        heading: titleOf(item) ?? (running ? "Editing" : "Edited"),
        preview: fileChangePreview(item),
      };
    case "file_search":
      return {
        icon: ICONS.read,
        heading: titleOf(item) ?? "Searched files",
        preview: firstLine(item.pattern),
      };
    case "web_search":
      return {
        icon: ICONS.web,
        heading: titleOf(item) ?? "Searched the web",
        preview: firstLine(item.patterns?.join(", ")),
      };
    case "dynamic_tool":
      return { icon: ICONS.tool, heading: titleOf(item) ?? item.toolName ?? "Tool", preview: null };
    case "subagent":
      return {
        icon: ICONS.agent,
        heading: titleOf(item) ?? "Subagent",
        preview: firstLine(item.progress ?? item.prompt),
      };
    case "reasoning":
      return {
        icon: ICONS.thinking,
        heading: "Thinking",
        preview: liveThoughtLine(item.text) || null,
      };
    case "approval_request":
      return {
        icon: ICONS.request,
        heading: running ? "Approval requested" : "Approval",
        preview: firstLine(item.prompt ?? item.reason) ?? item.requestKind,
      };
    case "user_input_request":
      return {
        icon: ICONS.request,
        heading: running ? "Question" : "Asked",
        preview: firstLine(item.questions.map((question) => question.question).join(" · ")),
      };
    default:
      return null;
  }
}

function divider(
  key: string,
  tone: DividerTone,
  text: string,
  detail: string | null = null,
): TimelineRow {
  return { kind: "divider", key, tone, text, detail };
}

/** One turn item as a row, or null for items the view doesn't show. Handoffs go through `handoffRow`. */
export function presentTurnItem(row: OrchestrationV2ProjectedTurnItem): TimelineRow | null {
  const item = row.item;
  const key = `${row.sourceThreadId}:${row.sourceItemId}`;
  switch (item.type) {
    case "user_message": {
      if (item.idleCompaction !== undefined) {
        return divider(key, "info", IDLE_COMPACTION_TITLES[item.idleCompaction]);
      }
      const presentation = resolveUserMessagePresentation({
        id: item.messageId,
        role: "user",
        text: item.text,
        createdBy: item.createdBy,
        creationSource: item.creationSource,
        ...(item.scheduledTaskId === undefined ? {} : { scheduledTaskId: item.scheduledTaskId }),
        context: item.context,
      });
      const note =
        item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"
          ? "steered"
          : item.inputIntent === "queued_turn"
            ? "queued"
            : null;
      return { kind: "user", key, text: presentation.text, note };
    }
    case "assistant_message":
      if (!item.streaming && item.text.trim().length === 0) return null;
      return { kind: "assistant", key, text: item.text.trimEnd(), streaming: item.streaming };
    case "proposed_plan":
      return { kind: "assistant", key, text: item.markdown, streaming: item.streaming };
    case "reasoning":
      if (!item.streaming && item.text.trim().length === 0) return null;
      break;
    case "error": {
      const heading =
        item.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
      return divider(
        key,
        item.status === "completed" ? "info" : "error",
        heading,
        item.failure.message,
      );
    }
    case "system_notice":
      return divider(key, "warning", item.message);
    case "run_interrupt_request":
    case "run_interrupt_result":
      return divider(key, "warning", item.message || "Run interrupted");
    case "notification":
      return divider(key, "info", item.summary, item.detail ?? null);
    case "compaction":
      return divider(key, "info", contextCompactionLabel(item));
    case "fork":
      return divider(key, "info", "Thread forked");
    default:
      break;
  }
  const line = workLine(item);
  if (line === null) return null;
  return {
    kind: "work",
    key,
    icon: line.icon,
    text: line.preview ? `${line.heading} - ${line.preview}` : line.heading,
    status: workStatus(item),
  };
}

/** "Context handoff: Codex · GPT-5 → Claude · Sonnet 5.5", as web's handoff divider reads. */
export function handoffRow(
  row: OrchestrationV2ProjectedTurnItem,
  runs: ReadonlyArray<HandoffTimelineRun>,
  providers: ReadonlyArray<ServerProvider>,
): TimelineRow | null {
  const item = row.item;
  if (item.type !== "handoff") return null;
  const { from, to } = resolveHandoffEndpoints(item, runs);
  const route = `${from.map((endpoint) => endpointLabel(providers, endpoint)).join(", ")} → ${endpointLabel(providers, to)}`;
  return divider(
    `${row.sourceThreadId}:${row.sourceItemId}`,
    item.status === "failed" ? "error" : "info",
    `Context handoff: ${route}`,
  );
}

const rowCache = new WeakMap<OrchestrationV2ProjectedTurnItem, TimelineRow | null>();

/**
 * The transcript's rows. The projection keeps unchanged items' identity, so each
 * item is presented once and a streamed delta re-presents only its own row.
 */
export function buildTimelineRows(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<HandoffTimelineRun>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<TimelineRow> {
  const rows: TimelineRow[] = [];
  for (const item of items) {
    if (item.item.type === "handoff") {
      const row = handoffRow(item, runs, providers);
      if (row !== null) rows.push(row);
      continue;
    }
    let row = rowCache.get(item);
    if (row === undefined) {
      row = presentTurnItem(item);
      rowCache.set(item, row);
    }
    if (row !== null) rows.push(row);
  }
  return rows;
}
