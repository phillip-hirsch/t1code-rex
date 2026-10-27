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

/** Whether a thread's subagent children show; null when it has none the sidebar knows of. */
export type SubagentDisclosure = "open" | "closed" | null;

export type SidebarRow =
  | { readonly kind: "project"; readonly key: string; readonly projectId: string }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly projectId: string;
      readonly threadId: string;
      readonly subagents?: SubagentDisclosure;
    }
  | {
      /** A subagent child under its parent. Its key is the thread's, so selection follows it. */
      readonly kind: "subagent";
      readonly key: string;
      readonly projectId: string;
      readonly threadId: string;
      readonly parentThreadId: string;
      /** 1 under a top-level thread, 2 under one of its subagents, and so on. */
      readonly depth: number;
      readonly subagents: SubagentDisclosure;
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

/** Pinned threads lead their project, as web's pinned section does; each part keeps its order. */
export function pinnedFirst<T extends Pick<SidebarThread, "pinnedAt">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!threads.some((thread) => thread.pinnedAt !== null)) return threads;
  return [
    ...threads.filter((thread) => thread.pinnedAt !== null),
    ...threads.filter((thread) => thread.pinnedAt === null),
  ];
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
    threads: pinnedFirst(
      sortThreads(threadsByProject.get(project.id) ?? [], input.threadSortOrder),
    ),
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

/** Subagent children per parent, and whether a parent shows them; see `subagentTree.ts`. */
export interface SidebarSubagents {
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<Pick<SidebarThread, "id">>>;
  readonly isOpen: (parentId: string) => boolean;
  /** The open thread's ancestors, nearest first: the preview keeps its top-level thread. */
  readonly activeAncestors: ReadonlyArray<string>;
}

const NO_SUBAGENTS: SidebarSubagents = {
  childrenByParent: new Map(),
  isOpen: () => false,
  activeAncestors: [],
};

export function buildSidebarRows(input: {
  readonly groups: ReadonlyArray<SidebarProjectGroup>;
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly showAllProjectIds: ReadonlySet<string>;
  readonly previewCount: number;
  readonly activeThreadId: string | null;
  readonly subagents?: SidebarSubagents;
}): ReadonlyArray<SidebarRow> {
  const subagents = input.subagents ?? NO_SUBAGENTS;
  const disclosure = (threadId: string): SubagentDisclosure => {
    const open = subagents.isOpen(threadId);
    // Opened by hand before its family loaded: shown open so the note under it reads right.
    if ((subagents.childrenByParent.get(threadId)?.length ?? 0) === 0) return open ? "open" : null;
    return open ? "open" : "closed";
  };
  const rows: SidebarRow[] = [];
  const pushChildren = (projectId: string, parentId: string, depth: number, seen: Set<string>) => {
    for (const child of subagents.childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const childDisclosure = disclosure(child.id);
      rows.push({
        kind: "subagent",
        key: threadRowKey(child.id),
        projectId,
        threadId: child.id,
        parentThreadId: parentId,
        depth,
        subagents: childDisclosure,
      });
      if (childDisclosure === "open") pushChildren(projectId, child.id, depth + 1, seen);
    }
  };
  // A subagent is listed under its top-level thread, which the preview keeps in view.
  const activeTopId = subagents.activeAncestors.at(-1) ?? input.activeThreadId;
  for (const { project, threads } of input.groups) {
    rows.push({ kind: "project", key: projectRowKey(project.id), projectId: project.id });
    if (!input.expandedProjectIds.has(project.id)) continue;
    const showAll = input.showAllProjectIds.has(project.id);
    const listed = visibleThreads({
      threads,
      previewCount: input.previewCount,
      showAll,
      activeThreadId: activeTopId,
    });
    for (const thread of listed) {
      const threadDisclosure = disclosure(thread.id);
      rows.push({
        kind: "thread",
        key: threadRowKey(thread.id),
        projectId: project.id,
        threadId: thread.id,
        ...(threadDisclosure === null ? {} : { subagents: threadDisclosure }),
      });
      if (threadDisclosure === "open") pushChildren(project.id, thread.id, 1, new Set([thread.id]));
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

function sameRow(left: SidebarRow, right: SidebarRow): boolean {
  if (left.kind !== right.kind || left.key !== right.key || left.projectId !== right.projectId) {
    return false;
  }
  if (left.kind === "thread" && right.kind === "thread") {
    return (
      left.threadId === right.threadId && (left.subagents ?? null) === (right.subagents ?? null)
    );
  }
  if (left.kind === "subagent" && right.kind === "subagent") {
    return (
      left.threadId === right.threadId &&
      left.parentThreadId === right.parentThreadId &&
      left.depth === right.depth &&
      left.subagents === right.subagents
    );
  }
  if (left.kind === "more" && right.kind === "more") return left.hiddenCount === right.hiddenCount;
  return true;
}

/**
 * Reuses `previous` row objects that `next` repeats, keyed by row key, so memoized rows
 * skip re-rendering when the list is rebuilt. Returns `previous` itself when nothing
 * changed. O(n).
 */
export function shareSidebarRows(
  previous: ReadonlyArray<SidebarRow>,
  next: ReadonlyArray<SidebarRow>,
): ReadonlyArray<SidebarRow> {
  if (previous === next) return next;
  const previousByKey = new Map(previous.map((row) => [row.key, row]));
  let unchanged = previous.length === next.length;
  const shared = next.map((row, index) => {
    const old = previousByKey.get(row.key);
    const reused = old !== undefined && sameRow(old, row) ? old : row;
    if (reused !== previous[index]) unchanged = false;
    return reused;
  });
  return unchanged ? previous : shared;
}
