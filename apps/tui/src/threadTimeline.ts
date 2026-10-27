import {
  contextCompactionLabel,
  liveThoughtLine,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
} from "@t3tools/client-runtime/work-log/presentation";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import {
  IDLE_COMPACTION_TITLES,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import { resolveWorkEntryIcon, type WorkEntryKind } from "./workEntryIcons.ts";

type TurnItem = OrchestrationV2TurnItem;
type ItemOf<T extends TurnItem["type"]> = Extract<TurnItem, { type: T }>;

/** How a one-line work row is colored, matching the old work log. */
export type WorkAccent = "command" | "change" | "read" | "error" | "subtle";
export type WorkStatus = "running" | "done" | "failed" | "stopped";
export type NoticeTone = "error" | "warning" | "info";

interface RowBase {
  /** Stable across updates of the same item; also the renderable id suffix. */
  readonly key: string;
  readonly createdAtMs: number | null;
}

export type TimelineRow =
  | (RowBase & {
      readonly kind: "user";
      readonly text: string;
      readonly attachments: ReadonlyArray<string>;
      /** "steer" or "queued" for messages that didn't start a turn, else null. */
      readonly intent: "steer" | "queued" | null;
      readonly attribution: string | null;
    })
  | (RowBase & {
      readonly kind: "assistant";
      readonly text: string;
      readonly streaming: boolean;
    })
  | (RowBase & {
      readonly kind: "work";
      readonly entryKind: WorkEntryKind;
      readonly icon: string;
      readonly text: string;
      readonly accent: WorkAccent;
      readonly status: WorkStatus;
      /** A checkpoint's run, whose diff the row opens; null for other work. */
      readonly diffRunId: string | null;
    })
  | (RowBase & {
      readonly kind: "plan";
      readonly markdown: string;
      readonly streaming: boolean;
    })
  | (RowBase & {
      readonly kind: "todo";
      readonly steps: ReadonlyArray<{
        readonly id: string;
        readonly text: string;
        readonly status: "pending" | "running" | "completed";
      }>;
      readonly explanation: string | null;
    })
  | (RowBase & {
      readonly kind: "notice";
      readonly tone: NoticeTone;
      readonly text: string;
      readonly detail: string | null;
    });

export type TimelineRowKind = TimelineRow["kind"];

function toMillis(value: DateTime.Utc | null): number | null {
  return value === null ? null : DateTime.toEpochMillis(value);
}

function capitalize(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function firstLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .find((part) => part.trim().length > 0)
    ?.trim();
  return line && line.length > 0 ? line : null;
}

function workStatus(item: TurnItem): WorkStatus {
  if (isOrchestrationV2WorkActive(item.status)) return "running";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled" || item.status === "interrupted") return "stopped";
  if (item.type === "command_execution") {
    if (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return "failed";
    }
  }
  return "done";
}

function joinWork(heading: string, preview: string | null): string {
  return preview ? `${heading} - ${preview}` : heading;
}

function itemTitle(item: TurnItem): string | null {
  const title = item.title?.trim();
  return title ? capitalize(normalizeCompactToolLabel(title)) : null;
}

interface WorkParts {
  readonly entryKind: WorkEntryKind;
  readonly heading: string;
  readonly preview: string | null;
}

function fileChangePreview(item: ItemOf<"file_change">): string {
  const files = item.changes?.map((change) => change.path) ?? [item.fileName];
  const [first = item.fileName] = files;
  const more = files.length > 1 ? ` +${files.length - 1} more` : "";
  const stats =
    item.additions !== undefined || item.deletions !== undefined
      ? ` (+${item.additions ?? 0} -${item.deletions ?? 0})`
      : "";
  return `${first}${more}${stats}`;
}

function dynamicToolParts(item: ItemOf<"dynamic_tool">, running: boolean): WorkParts {
  const t3 = resolveWorkEntryToolPresentation(
    {
      label: item.toolName ?? "Tool",
      toolTitle: item.title ?? item.toolName ?? "Tool",
      toolData: { input: item.input, output: item.output },
      toolLifecycleStatus: running
        ? "inProgress"
        : item.status === "failed"
          ? "failed"
          : "completed",
      structuredPayload: item,
    },
    running ? "inProgress" : "completed",
  );
  if (t3) return { entryKind: "tool", heading: t3.displayName, preview: null };
  const presentation = deriveToolActivityPresentation({
    itemType: "dynamic_tool_call",
    title: item.title ?? item.toolName,
    data: { toolName: item.toolName ?? undefined, input: item.input },
    fallbackSummary: item.toolName ?? "Tool call",
  });
  const summary = presentation.summary;
  const lower = summary.toLowerCase();
  const entryKind: WorkEntryKind =
    item.viewedImagePath !== undefined
      ? "image"
      : lower.startsWith("ran command")
        ? "command"
        : lower.startsWith("read ")
          ? "read"
          : lower.startsWith("searched")
            ? "search"
            : lower.startsWith("changed")
              ? "change"
              : "tool";
  return {
    entryKind,
    heading: capitalize(normalizeCompactToolLabel(summary)),
    preview: firstLine(presentation.detail),
  };
}

function workParts(item: TurnItem): WorkParts | null {
  const running = isOrchestrationV2WorkActive(item.status);
  switch (item.type) {
    case "command_execution":
      return {
        entryKind: "command",
        heading: itemTitle(item) ?? (running ? "Running command" : "Ran command"),
        preview: firstLine(commandDisplayText(item.input)),
      };
    case "file_change":
      return {
        entryKind: "change",
        heading: itemTitle(item) ?? (running ? "Editing" : "Edited"),
        preview: fileChangePreview(item),
      };
    case "file_search":
      return {
        entryKind: "search",
        heading: itemTitle(item) ?? "Searched files",
        preview: firstLine(item.pattern),
      };
    case "web_search":
      return {
        entryKind: "web",
        heading: itemTitle(item) ?? "Searched the web",
        preview: firstLine(item.patterns?.join(", ")),
      };
    case "dynamic_tool":
      return dynamicToolParts(item, running);
    case "subagent":
      return {
        entryKind: "agent",
        heading: itemTitle(item) ?? "Subagent",
        preview: firstLine(item.progress ?? item.prompt),
      };
    case "checkpoint": {
      // A checkpoint with no changed files says nothing worth a row.
      if (item.files.length === 0) return null;
      let additions = 0;
      let deletions = 0;
      for (const file of item.files) {
        additions += file.additions;
        deletions += file.deletions;
      }
      const files =
        item.files.length === 1 ? (item.files[0]?.path ?? "1 file") : `${item.files.length} files`;
      return {
        entryKind: "change",
        heading: "Changed",
        preview: `${files} (+${additions} -${deletions})`,
      };
    }
    case "reasoning": {
      const thought = item.text ? liveThoughtLine(item.text) : "";
      return { entryKind: "thinking", heading: "Thinking", preview: thought || null };
    }
    case "approval_request":
      return {
        entryKind: "request",
        heading: running ? "Approval requested" : "Approval",
        preview: firstLine(item.prompt ?? item.reason) ?? item.requestKind,
      };
    case "user_input_request":
      return {
        entryKind: "request",
        heading: running ? "Input requested" : "Asked",
        preview: firstLine(item.questions.map((question) => question.question).join(" · ")),
      };
    case "secret_request":
      return {
        entryKind: "request",
        heading: item.secretStatus === "pending" ? "Secret requested" : "Secret",
        preview: item.label,
      };
    default:
      return null;
  }
}

function workAccent(entryKind: WorkEntryKind, status: WorkStatus): WorkAccent {
  if (status === "failed") return "error";
  switch (entryKind) {
    case "command":
      return "command";
    case "change":
      return "change";
    case "read":
    case "search":
    case "image":
      return "read";
    default:
      return "subtle";
  }
}

function noticeRow(
  key: string,
  createdAtMs: number | null,
  tone: NoticeTone,
  text: string,
  detail: string | null = null,
): TimelineRow {
  return { kind: "notice", key, createdAtMs, tone, text, detail };
}

/** One turn item as a timeline row, or null for items the TUI doesn't show. */
export function presentTurnItem(row: OrchestrationV2ProjectedTurnItem): TimelineRow | null {
  const item = row.item;
  const key = `${row.sourceThreadId}:${row.sourceItemId}`;
  const createdAtMs = toMillis(item.startedAt) ?? toMillis(item.updatedAt);
  switch (item.type) {
    case "user_message": {
      if (item.idleCompaction !== undefined) {
        return noticeRow(key, createdAtMs, "info", IDLE_COMPACTION_TITLES[item.idleCompaction]);
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
      const attribution =
        presentation.attribution === "guest"
          ? (presentation.guestName ?? "Guest")
          : presentation.attribution === "automation"
            ? "Scheduled"
            : presentation.attribution === "agent"
              ? "Agent"
              : presentation.attribution === "t3code"
                ? "T3 Code"
                : null;
      return {
        kind: "user",
        key,
        createdAtMs,
        text: presentation.text,
        attachments: item.attachments.map((attachment) => attachment.name),
        intent:
          item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"
            ? "steer"
            : item.inputIntent === "queued_turn"
              ? "queued"
              : null,
        attribution,
      };
    }
    case "assistant_message":
      if (!item.streaming && item.text.trim().length === 0) return null;
      return {
        kind: "assistant",
        key,
        createdAtMs,
        text: item.text.trimEnd(),
        streaming: item.streaming,
      };
    case "reasoning":
      if (!item.streaming && item.text.trim().length === 0) return null;
      break;
    case "proposed_plan":
      return {
        kind: "plan",
        key,
        createdAtMs,
        markdown: item.markdown,
        streaming: item.streaming,
      };
    case "todo_list":
      return {
        kind: "todo",
        key,
        createdAtMs,
        steps: item.steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
        explanation: item.explanation?.trim() || null,
      };
    case "error": {
      const usageLimit = item.failure.class === "usage_limit";
      const heading = usageLimit ? "Usage limit reached" : "Provider error";
      const retry = item.retry
        ? ` (retry ${item.retry.attempt}${item.retry.maxAttempts ? `/${item.retry.maxAttempts}` : ""})`
        : "";
      return noticeRow(
        key,
        createdAtMs,
        item.status === "completed" ? "info" : "error",
        `${heading}${retry}`,
        item.failure.message,
      );
    }
    case "system_notice":
      return noticeRow(key, createdAtMs, "warning", item.message);
    case "run_interrupt_request":
      return noticeRow(key, createdAtMs, "warning", item.message || "Interrupt requested");
    case "run_interrupt_result":
      return noticeRow(key, createdAtMs, "warning", item.message || "Run interrupted");
    case "notification":
      return noticeRow(key, createdAtMs, "info", item.summary, item.detail ?? null);
    case "compaction":
      return noticeRow(key, createdAtMs, "info", contextCompactionLabel(item));
    case "handoff":
      return noticeRow(key, createdAtMs, "info", "Context handed off", item.summary ?? null);
    case "fork":
      return noticeRow(key, createdAtMs, "info", "Thread forked");
    case "thread_created":
      return noticeRow(key, createdAtMs, "info", `Thread created on ${item.targetModel}`);
    default:
      break;
  }
  const parts = workParts(item);
  if (parts === null) return null;
  const status = workStatus(item);
  const entryKind: WorkEntryKind = status === "failed" ? "error" : parts.entryKind;
  return {
    kind: "work",
    key,
    createdAtMs,
    entryKind,
    icon: resolveWorkEntryIcon(entryKind),
    text: joinWork(parts.heading, parts.preview),
    accent: workAccent(parts.entryKind, status),
    status,
    diffRunId: item.type === "checkpoint" ? item.runId : null,
  };
}

const rowCache = new WeakMap<OrchestrationV2ProjectedTurnItem, TimelineRow | null>();

function cachedRow(item: OrchestrationV2ProjectedTurnItem): TimelineRow | null {
  const cached = rowCache.get(item);
  if (cached !== undefined) return cached;
  const row = presentTurnItem(item);
  rowCache.set(item, row);
  return row;
}

/**
 * Rows for the visible transcript. The projection keeps unchanged items' identity, so each
 * item is presented once and a streamed delta re-presents only its own row; memoized row
 * components skip the rest.
 */
export function buildTimelineRows(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<TimelineRow> {
  const rows: TimelineRow[] = [];
  for (const item of items) {
    const row = cachedRow(item);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Work rows sit flush against each other, as in the old work log; others get a gap. */
export function rowHasGapAfter(row: TimelineRow, next: TimelineRow | undefined): boolean {
  if (next === undefined) return false;
  return !(row.kind === "work" && next.kind === "work");
}
