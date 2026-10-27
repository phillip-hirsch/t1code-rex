import {
  projectRowKey,
  threadRowKey,
  type SidebarProjectGroup,
  type SidebarRow,
} from "./sidebarModel.ts";

/** Keyboard cursor and selection rules for the sidebar tree. */

export function moveCursor(
  rows: ReadonlyArray<SidebarRow>,
  cursorKey: string | null,
  delta: number,
): SidebarRow | null {
  if (rows.length === 0) return null;
  const index = cursorKey === null ? -1 : rows.findIndex((row) => row.key === cursorKey);
  if (index === -1) return rows[0] ?? null;
  return rows[Math.min(rows.length - 1, Math.max(0, index + delta))] ?? null;
}

/**
 * The item to fall back to when `id` leaves a list: the next item after it that is still
 * live, else the closest one before it, else null.
 */
export function nearestSurvivor(
  previousOrder: ReadonlyArray<string>,
  isLive: (id: string) => boolean,
  id: string,
): string | null {
  if (isLive(id)) return id;
  const index = previousOrder.indexOf(id);
  if (index === -1) return null;
  for (let next = index + 1; next < previousOrder.length; next += 1) {
    const candidate = previousOrder[next];
    if (candidate !== undefined && isLive(candidate)) return candidate;
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const candidate = previousOrder[previous];
    if (candidate !== undefined && isLive(candidate)) return candidate;
  }
  return null;
}

export interface SidebarSelection {
  readonly projectId: string | null;
  readonly threadId: string | null;
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/**
 * Where the sidebar starts: the launched thread for a Rex thread tab, else the saved thread
 * when it still exists, else the saved project (or the one for the working directory, which
 * the server bootstraps) with its latest thread, else the first project.
 */
export function resolveInitialSelection(input: {
  readonly groups: ReadonlyArray<SidebarProjectGroup>;
  readonly launch: { readonly projectId: string; readonly threadId: string } | null;
  readonly savedProjectId: string | undefined;
  readonly savedThreadId: string | undefined;
  readonly cwd: string | undefined;
  readonly isNewThreadDraft?: ((threadId: string) => boolean) | undefined;
}): SidebarSelection {
  const { groups, launch } = input;
  if (launch) return { projectId: launch.projectId, threadId: launch.threadId };
  // A new-thread draft that was open at quit reopens, if its project is still here.
  if (
    input.savedThreadId !== undefined &&
    input.savedProjectId !== undefined &&
    input.isNewThreadDraft?.(input.savedThreadId) === true &&
    groups.some((group) => group.project.id === input.savedProjectId)
  ) {
    return { projectId: input.savedProjectId, threadId: input.savedThreadId };
  }
  if (input.savedThreadId !== undefined) {
    for (const group of groups) {
      if (group.threads.some((thread) => thread.id === input.savedThreadId)) {
        return { projectId: group.project.id, threadId: input.savedThreadId };
      }
    }
  }
  const cwd = input.cwd === undefined ? undefined : normalizePath(input.cwd);
  const group =
    groups.find((candidate) => candidate.project.id === input.savedProjectId) ??
    (cwd === undefined
      ? undefined
      : groups.find((candidate) => normalizePath(candidate.project.workspaceRoot) === cwd)) ??
    groups[0];
  if (group === undefined) return { projectId: null, threadId: null };
  return { projectId: group.project.id, threadId: group.threads[0]?.id ?? null };
}

/**
 * Keeps the selection valid when the tree changes: a moved thread follows its new project,
 * and an archived or deleted thread (or removed project) hands the selection to its
 * neighbor. A selected thread the sidebar never listed (a thread tab's subagent, say) stays.
 */
export function reconcileSelection(
  selection: SidebarSelection,
  before: ReadonlyArray<SidebarProjectGroup>,
  after: ReadonlyArray<SidebarProjectGroup>,
): SidebarSelection {
  const { threadId } = selection;
  if (threadId !== null) {
    const owner = after.find((group) => group.threads.some((thread) => thread.id === threadId));
    if (owner) {
      return owner.project.id === selection.projectId
        ? selection
        : { projectId: owner.project.id, threadId };
    }
  }
  const liveProjectIds = new Set<string>(after.map((group) => group.project.id));
  const projectId =
    selection.projectId === null
      ? null
      : nearestSurvivor(
          before.map((group) => group.project.id),
          (id) => liveProjectIds.has(id),
          selection.projectId,
        );
  const previousGroup = before.find((group) =>
    group.threads.some((thread) => thread.id === threadId),
  );
  if (threadId === null || previousGroup === undefined) {
    return projectId === selection.projectId ? selection : { projectId, threadId };
  }
  const sameProject = after.find((group) => group.project.id === previousGroup.project.id);
  const liveThreadIds = new Set<string>(sameProject?.threads.map((thread) => thread.id));
  const neighbor = nearestSurvivor(
    previousGroup.threads.map((thread) => thread.id),
    (id) => liveThreadIds.has(id),
    threadId,
  );
  return { projectId, threadId: projectId === previousGroup.project.id ? neighbor : null };
}

/**
 * The row the cursor sits on: the stored one while it is listed, else the selected thread,
 * else the selected project, else the first row.
 */
export function resolveCursorKey(
  rows: ReadonlyArray<SidebarRow>,
  storedKey: string | null,
  selection: SidebarSelection,
): string | null {
  const keys = new Set(rows.map((row) => row.key));
  if (storedKey !== null && keys.has(storedKey)) return storedKey;
  if (selection.threadId !== null && keys.has(threadRowKey(selection.threadId))) {
    return threadRowKey(selection.threadId);
  }
  if (selection.projectId !== null && keys.has(projectRowKey(selection.projectId))) {
    return projectRowKey(selection.projectId);
  }
  return rows[0]?.key ?? null;
}
