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
