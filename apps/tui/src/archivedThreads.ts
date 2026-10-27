import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { DEFAULT_THREAD_TITLE } from "./threadTitle.ts";

/** One row of the archived-threads view: newest archive first, as web lists them. */
export interface ArchivedThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly archivedAt: string;
}

export function buildArchivedThreadRows(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "id" | "projectId" | "title" | "archivedAt" | "createdAt" | "deletedAt"
    >
  >;
}): ReadonlyArray<ArchivedThreadRow> {
  const projectTitles = new Map(input.projects.map((project) => [project.id, project.title]));
  return input.threads
    .filter((thread) => thread.archivedAt !== null && thread.deletedAt === null)
    .map((thread) => ({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title || DEFAULT_THREAD_TITLE,
      projectTitle: projectTitles.get(thread.projectId) ?? "Unknown project",
      archivedAt: thread.archivedAt ?? thread.createdAt,
    }))
    .toSorted(
      (left, right) =>
        right.archivedAt.localeCompare(left.archivedAt) ||
        right.threadId.localeCompare(left.threadId),
    );
}

/** The archive view's highlighted row: its thread, and its place in case the thread leaves. */
export interface ArchivedSelection {
  readonly threadId: string | null;
  readonly index: number;
}

export function selectArchivedRow(
  rows: ReadonlyArray<ArchivedThreadRow>,
  index: number,
): ArchivedSelection {
  const clamped = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
  return { threadId: rows[clamped]?.threadId ?? null, index: clamped };
}

/**
 * The selection once the rows change: the same thread while it's listed, else the row that
 * took its place (the last one, when the last row left). Keys and the view both use this,
 * so Enter and Delete act on the highlighted row. Keeps identity when nothing moved.
 */
export function reconcileArchivedSelection(
  rows: ReadonlyArray<ArchivedThreadRow>,
  selection: ArchivedSelection,
): ArchivedSelection {
  // Still loading: nothing to move to yet.
  if (rows.length === 0) return selection;
  const kept =
    selection.threadId === null ? -1 : rows.findIndex((row) => row.threadId === selection.threadId);
  const next = selectArchivedRow(rows, kept >= 0 ? kept : selection.index);
  return next.index === selection.index && next.threadId === selection.threadId ? selection : next;
}
