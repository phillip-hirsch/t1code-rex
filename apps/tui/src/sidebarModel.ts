import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/client-core";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

/**
 * The sidebar tree: projects with their threads, sorted like the old TUI, flattened into
 * the rows keyboard navigation walks. Pure, so the shell stream only costs one grouping
 * and sort per changed list.
 */

export type SidebarThread = EnvironmentThreadShell;

export interface SidebarProjectGroup {
  readonly project: OrchestrationProjectShell;
  readonly threads: ReadonlyArray<SidebarThread>;
}

export type SidebarRow =
  | { readonly kind: "project"; readonly key: string; readonly projectId: string }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly projectId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly projectId: string;
      /** Threads hidden behind "Show N more"; 0 when the list is expanded ("Show fewer"). */
      readonly hiddenCount: number;
    };

export const projectRowKey = (projectId: string) => `project:${projectId}`;
export const threadRowKey = (threadId: string) => `thread:${threadId}`;
export const moreRowKey = (projectId: string) => `more:${projectId}`;

/**
 * Top-level threads the sidebar lists. Subagent children stay out of the tree; their
 * requests surface on the parent's status instead.
 */
export function isSidebarThread(thread: SidebarThread): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

function projectSortTimestamp(
  project: OrchestrationProjectShell,
  threads: ReadonlyArray<SidebarThread>,
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (threads.length > 0) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const thread of threads) {
      latest = Math.max(latest, getThreadSortTimestamp(thread, sortOrder));
    }
    return latest;
  }
  const iso = sortOrder === "created_at" ? project.createdAt : project.updatedAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

export function buildSidebarGroups(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<SidebarThread>;
  readonly projectSortOrder: SidebarProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}): ReadonlyArray<SidebarProjectGroup> {
  const threadsByProject = new Map<string, SidebarThread[]>();
  for (const thread of input.threads) {
    if (!isSidebarThread(thread)) continue;
    const list = threadsByProject.get(thread.projectId);
    if (list) list.push(thread);
    else threadsByProject.set(thread.projectId, [thread]);
  }
  const groups = input.projects.map((project) => ({
    project,
    threads: sortThreads(threadsByProject.get(project.id) ?? [], input.threadSortOrder),
  }));
  const sortOrder = input.projectSortOrder;
  if (sortOrder === "manual") return groups;
  return groups
    .map((group) => ({
      group,
      timestamp: projectSortTimestamp(group.project, group.threads, sortOrder),
    }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        left.group.project.title.localeCompare(right.group.project.title) ||
        left.group.project.id.localeCompare(right.group.project.id),
    )
    .map(({ group }) => group);
}

/**
 * The threads a project lists: the first `previewCount`, plus the selected thread when it
 * sorts past them, so the preview never hides it.
 */
export function visibleThreads<T extends Pick<SidebarThread, "id">>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly previewCount: number;
  readonly showAll: boolean;
  readonly activeThreadId: string | null;
}): ReadonlyArray<T> {
  const { threads, previewCount, showAll, activeThreadId } = input;
  if (showAll || threads.length <= previewCount) return threads;
  const preview = threads.slice(0, previewCount);
  const active =
    activeThreadId === null
      ? undefined
      : threads.find((thread, index) => index >= previewCount && thread.id === activeThreadId);
  return active === undefined ? preview : [...preview, active];
}

export function buildSidebarRows(input: {
  readonly groups: ReadonlyArray<SidebarProjectGroup>;
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly showAllProjectIds: ReadonlySet<string>;
  readonly previewCount: number;
  readonly activeThreadId: string | null;
}): ReadonlyArray<SidebarRow> {
  const rows: SidebarRow[] = [];
  for (const { project, threads } of input.groups) {
    rows.push({ kind: "project", key: projectRowKey(project.id), projectId: project.id });
    if (!input.expandedProjectIds.has(project.id)) continue;
    const showAll = input.showAllProjectIds.has(project.id);
    const listed = visibleThreads({
      threads,
      previewCount: input.previewCount,
      showAll,
      activeThreadId: input.activeThreadId,
    });
    for (const thread of listed) {
      rows.push({
        kind: "thread",
        key: threadRowKey(thread.id),
        projectId: project.id,
        threadId: thread.id,
      });
    }
    const hiddenCount = threads.length - listed.length;
    if (hiddenCount > 0 || (showAll && threads.length > input.previewCount)) {
      rows.push({
        kind: "more",
        key: moreRowKey(project.id),
        projectId: project.id,
        hiddenCount,
      });
    }
  }
  return rows;
}
