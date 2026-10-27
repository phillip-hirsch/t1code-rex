import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { subagentRecordState, type SubagentState } from "./subagentTree.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

/**
 * What the TUI shows about one subagent, built from upstream's display helpers: the
 * transcript's `subagent` item, live-updated by the parent's subagent record when loaded.
 */

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type SubagentStatus = OrchestrationV2Subagent["status"];

export interface SubagentSummary {
  readonly subagentId: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly state: SubagentState;
  /** The model's short name, or null when the provider didn't report one. */
  readonly model: string | null;
  /** Progress while it works, its result once it's done; one line. */
  readonly detail: string | null;
  readonly childThreadId: string | null;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function firstLine(value: string | null | undefined): string | null {
  const line = value
    ?.split(/\r?\n/)
    .find((part) => part.trim().length > 0)
    ?.trim();
  return line && line.length > 0 ? line : null;
}

function iso(value: DateTime.Utc | null): string | null {
  return value === null ? null : DateTime.formatIso(value);
}

interface SubagentFields {
  readonly subagentId: string;
  readonly status: SubagentStatus;
  readonly title: string | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly progress?: string | undefined;
  readonly result: string | null;
  readonly childThreadId: string | null;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

function summarizeFields(
  fields: SubagentFields,
  provider: Pick<ServerProvider, "driver" | "models"> | null,
): SubagentSummary {
  const rawTitle = fields.title?.trim() || firstLine(fields.prompt) || "Subagent";
  const model = fields.model?.trim() || null;
  return {
    subagentId: fields.subagentId,
    title: formatSubagentDisplayTitle(rawTitle),
    status: fields.status,
    state: subagentRecordState(fields.status),
    model: model === null ? null : resolveSubagentMetadata({ model, provider }).modelLabel,
    detail: subagentDetailPreview({
      status: fields.status,
      result: fields.result,
      progress: fields.progress,
    }),
    childThreadId: fields.childThreadId,
    origin: fields.origin,
    startedAt: iso(fields.startedAt),
    completedAt: iso(fields.completedAt),
  };
}

/** A transcript `subagent` item, with the parent's live record laid over it once loaded. */
export function summarizeSubagent(input: {
  readonly item: SubagentTurnItem;
  readonly record: OrchestrationV2Subagent | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null;
}): SubagentSummary {
  const { item, record } = input;
  return summarizeFields(
    {
      subagentId: item.subagentId,
      status: record?.status ?? item.status,
      title: record?.title?.trim() || item.title,
      prompt: record?.prompt || item.prompt,
      model: record?.model ?? null,
      progress: record?.progress ?? item.progress,
      result: record?.result ?? item.result,
      childThreadId: record?.childThreadId ?? item.childThreadId,
      origin: record?.origin ?? item.origin,
      startedAt: record?.startedAt ?? item.startedAt,
      completedAt: record?.completedAt ?? item.completedAt,
    },
    input.provider ?? null,
  );
}

/** A subagent from its record alone, as a child's view has it. */
export function summarizeSubagentRecord(
  record: OrchestrationV2Subagent,
  provider: Pick<ServerProvider, "driver" | "models"> | null = null,
): SubagentSummary {
  return summarizeFields({ ...record, subagentId: record.id }, provider);
}

/**
 * Why a subagent can't be stopped now, or null when it can. Web's rule: app-owned tasks stop
 * through their parent; provider-native ones only on Claude, which names the task strongly.
 */
export function subagentStopBlocker(record: OrchestrationV2Subagent | null): string | null {
  if (record === null) return "Subagent details are still loading";
  if (!isOrchestrationV2WorkActive(record.status)) return "Subagent isn't running";
  if (record.startedAt === null) return "Subagent hasn't started yet";
  if (record.origin === "app_owned") return null;
  const stoppable =
    record.driver === "claudeAgent" &&
    record.runId !== null &&
    record.nativeTaskRef?.strength === "strong" &&
    record.nativeTaskRef.nativeId !== null;
  return stoppable ? null : "This provider can't stop one subagent; stop the parent's run instead";
}

/** A child thread's place under its parent, for its view's header and composer. */
export interface SubagentThreadContext {
  readonly parentThreadId: string;
  readonly parentTitle: string | null;
  /** Provider-native children run inside the parent's provider and take no messages. */
  readonly readOnly: boolean;
}

export const PROVIDER_SUBAGENT_READ_ONLY_REASON =
  "Runs on its own: the parent's agent drives this subagent, so it takes no messages";

export function resolveSubagentThreadContext(
  thread: Pick<EnvironmentThreadShell, "lineage" | "source"> | null,
  parent: Pick<EnvironmentThreadShell, "title"> | null,
): SubagentThreadContext | null {
  if (thread === null || thread.lineage.relationshipToParent !== "subagent") return null;
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null) return null;
  return {
    parentThreadId,
    parentTitle: parent?.title?.trim() || null,
    readOnly: isProviderNativeSubagentThread(thread.source),
  };
}

/** The parent's record for a child thread, if its subagents are loaded. */
export function findSubagentForChild(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  childThreadId: string,
): OrchestrationV2Subagent | null {
  return subagents.findLast((subagent) => subagent.childThreadId === childThreadId) ?? null;
}

export function subagentStateColor(state: SubagentState, theme: TuiTheme): TuiColor {
  switch (state) {
    case "working":
      return theme.status.working;
    case "waiting":
      return theme.status.awaitingInput;
    case "done":
      return theme.palette.success;
    case "failed":
      return theme.palette.composerStop;
    case "stopped":
      return theme.palette.warning;
    case "idle":
      return theme.palette.subtle;
  }
}
