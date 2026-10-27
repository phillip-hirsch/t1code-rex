import type { KeyEvent } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from "@t3tools/client-core";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { TuiConnection } from "./connection/tuiConnection.ts";
import type { PrefsWriter, TuiPrefs } from "./prefs.ts";
import {
  buildSidebarGroups,
  buildSidebarRows,
  projectRowKey,
  threadRowKey,
  type SidebarRow,
  type SidebarThread,
} from "./sidebarModel.ts";
import {
  moveCursor,
  reconcileSelection,
  resolveCursorKey,
  resolveInitialSelection,
  type SidebarSelection,
} from "./sidebarNavigation.ts";
import {
  collapseProject,
  ensureProjectExpanded,
  pruneExpandedProjects,
  resolveProjectExpansionOnRowPress,
} from "./sidebarProjects.ts";
import {
  resolveProjectStatus,
  resolveThreadStatus,
  type ThreadStatusPill,
} from "./sidebarStatus.ts";
import type { ThreadWindowLaunch } from "./threadWindowLaunch.ts";
import {
  clearThreadUnread,
  markThreadUnread,
  recordThreadVisit,
  type ThreadVisits,
} from "./threadVisits.ts";

export interface SidebarControllerOptions {
  readonly connection: TuiConnection;
  readonly initialPrefs: TuiPrefs;
  /** Only the main window saves prefs; Rex thread tabs share the file read-only. */
  readonly prefsWriter: PrefsWriter | null;
  readonly launch: ThreadWindowLaunch | null;
  readonly cwd: string;
}

const NO_SELECTION: SidebarSelection = { projectId: null, threadId: null };

function isEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed";
}

/**
 * Sidebar state on top of client-runtime's shell: expansion, the keyboard cursor, the
 * selected thread, and local unread marks. Rows come from the quiet thread list, so a
 * streaming run re-renders only its own status dot.
 */
export function useSidebarController(options: SidebarControllerOptions) {
  const { connection, initialPrefs, prefsWriter, launch, cwd } = options;
  const projects = useAtomValue(connection.projectsAtom);
  const threads = useAtomValue(connection.threadShellsAtom);
  const hasSnapshot = useAtomValue(connection.hasShellSnapshotAtom);
  const olderSettled = useAtomValue(connection.olderSettledAtom);

  const settings = useMemo(
    () => normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, ...initialPrefs.appSettings }),
    [initialPrefs],
  );
  const [initialized, setInitialized] = useState(false);
  const [selection, setSelection] = useState<SidebarSelection>(NO_SELECTION);
  const [storedCursorKey, setCursorKey] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(initialPrefs.expandedProjectIds ?? []),
  );
  const [showAllProjectIds, setShowAllProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  const [visits, setVisits] = useState<ThreadVisits>(
    () => initialPrefs.threadLastVisitedAtById ?? {},
  );
  const [unread, setUnread] = useState<ReadonlySet<string>>(
    () => new Set(initialPrefs.locallyUnreadThreadIds ?? []),
  );

  const groups = useMemo(
    () =>
      buildSidebarGroups({
        projects,
        threads,
        projectSortOrder: settings.sidebarProjectSortOrder,
        threadSortOrder: settings.sidebarThreadSortOrder,
      }),
    [projects, threads, settings],
  );
  const rows = useMemo(
    () =>
      buildSidebarRows({
        groups,
        expandedProjectIds,
        showAllProjectIds,
        previewCount: settings.sidebarThreadPreviewCount,
        activeThreadId: selection.threadId,
      }),
    [groups, expandedProjectIds, showAllProjectIds, settings, selection.threadId],
  );
  const projectsById = useMemo(
    () => new Map<string, OrchestrationProjectShell>(projects.map((p) => [p.id, p])),
    [projects],
  );
  const threadsById = useMemo(
    () => new Map<string, SidebarThread>(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const threadCountByProject = useMemo(
    () => new Map(groups.map((group) => [group.project.id, group.threads.length])),
    [groups],
  );
  const olderSettledByProject = useMemo(
    () => new Map((olderSettled?.counts ?? []).map((entry) => [entry.projectId, entry.count])),
    [olderSettled],
  );
  const statusByThread = useMemo(() => {
    const statuses = new Map<string, ThreadStatusPill | null>();
    for (const group of groups) {
      for (const thread of group.threads) {
        statuses.set(
          thread.id,
          resolveThreadStatus(thread, {
            localVisitedAt: visits[thread.id],
            serverVisitedAt: thread.lastVisitedAt,
            forceUnread: unread.has(thread.id),
          }),
        );
      }
    }
    return statuses;
  }, [groups, visits, unread]);
  const projectStatusById = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.project.id,
          resolveProjectStatus(
            group.threads.map((thread) => statusByThread.get(thread.id) ?? null),
          ),
        ]),
      ),
    [groups, statusByThread],
  );

  const activeThread =
    selection.threadId === null ? null : (threadsById.get(selection.threadId) ?? null);

  // Adjustments made while rendering, so a shell change costs one render rather than an
  // effect's second pass: restore the start selection once the first snapshot lands, keep
  // the selection on live threads, drop removed projects' expansion, clear the unread mark
  // of the thread being opened, and record that its latest run was seen.
  const [seenGroups, setSeenGroups] = useState(groups);
  if (seenGroups !== groups) {
    setSeenGroups(groups);
    if (initialized) {
      const reconciled = reconcileSelection(selection, seenGroups, groups);
      if (reconciled !== selection) setSelection(reconciled);
      const pruned = pruneExpandedProjects(
        expandedProjectIds,
        groups.map((group) => group.project.id),
      );
      if (pruned !== expandedProjectIds) setExpandedProjectIds(pruned);
    }
  }
  if (!initialized && hasSnapshot) {
    const start = resolveInitialSelection({
      groups,
      launch,
      savedProjectId: initialPrefs.selectedProjectId,
      savedThreadId: initialPrefs.selectedThreadId,
      cwd,
    });
    setInitialized(true);
    setSelection(start);
    if (start.projectId !== null) {
      setExpandedProjectIds(ensureProjectExpanded(expandedProjectIds, start.projectId));
    }
  }
  const [seenThreadId, setSeenThreadId] = useState<string | null>(null);
  if (seenThreadId !== selection.threadId) {
    setSeenThreadId(selection.threadId);
    const cleared = clearThreadUnread(unread, selection.threadId);
    if (cleared !== unread) setUnread(cleared);
  }
  if (selection.threadId !== null) {
    const recorded = recordThreadVisit(visits, selection.threadId, activeThread?.latestRun ?? null);
    if (recorded !== visits) setVisits(recorded);
  }

  const cursorKey = resolveCursorKey(rows, storedCursorKey, selection);
  const cursorRow = rows.find((row) => row.key === cursorKey) ?? null;

  useEffect(() => {
    if (!prefsWriter || !initialized) return;
    prefsWriter.write({
      selectedProjectId: selection.projectId ?? undefined,
      selectedThreadId: selection.threadId ?? undefined,
      expandedProjectIds: expandedProjectIds.size > 0 ? [...expandedProjectIds] : undefined,
      locallyUnreadThreadIds: unread.size > 0 ? [...unread] : undefined,
      threadLastVisitedAtById: Object.keys(visits).length > 0 ? visits : undefined,
    });
  }, [expandedProjectIds, initialized, prefsWriter, selection, unread, visits]);

  const selectThread = useCallback((projectId: string, threadId: string) => {
    setSelection({ projectId, threadId });
    setCursorKey(threadRowKey(threadId));
    setExpandedProjectIds((current) => ensureProjectExpanded(current, projectId));
  }, []);

  const toggleShowAll = useCallback((projectId: string) => {
    setShowAllProjectIds((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  }, []);

  /** Moves the cursor without selecting, as a right-click does before its menu opens. */
  const focusRow = useCallback((row: SidebarRow) => setCursorKey(row.key), []);

  /** Mouse presses: the row under the pointer becomes the cursor. */
  const pressRow = useCallback(
    (row: SidebarRow) => {
      setCursorKey(row.key);
      if (row.kind === "thread") {
        selectThread(row.projectId, row.threadId);
      } else if (row.kind === "project") {
        setSelection((current) =>
          current.projectId === row.projectId ? current : { ...current, projectId: row.projectId },
        );
        setExpandedProjectIds((current) =>
          resolveProjectExpansionOnRowPress({
            expandedProjectIds: current,
            projectId: row.projectId,
            isProjectActive: selection.projectId === row.projectId,
          }),
        );
      } else {
        toggleShowAll(row.projectId);
      }
    },
    [selectThread, selection.projectId, toggleShowAll],
  );

  /**
   * Arrow keys (or j/k/h/l) walk the tree. Landing on a thread opens it, as before;
   * Enter opens a thread or toggles a project. Returns "open" when the caller should move
   * focus to the thread view.
   */
  const handleKey = useCallback(
    (key: KeyEvent): "handled" | "open" | null => {
      const name = key.name;
      if (name === "up" || name === "down" || name === "k" || name === "j") {
        const next = moveCursor(rows, cursorKey, name === "up" || name === "k" ? -1 : 1);
        if (next === null) return "handled";
        setCursorKey(next.key);
        if (next.kind === "thread") selectThread(next.projectId, next.threadId);
        else if (next.kind === "project") {
          setSelection((current) =>
            current.projectId === next.projectId
              ? current
              : { ...current, projectId: next.projectId },
          );
        }
        return "handled";
      }
      if (name === "home" || name === "end") {
        const next = name === "home" ? rows[0] : rows.at(-1);
        if (next) setCursorKey(next.key);
        return "handled";
      }
      if (cursorRow === null) return null;
      if (name === "right" || name === "l") {
        if (cursorRow.kind !== "project") return "handled";
        if (!expandedProjectIds.has(cursorRow.projectId)) {
          setExpandedProjectIds((current) => ensureProjectExpanded(current, cursorRow.projectId));
        } else {
          const child = moveCursor(rows, cursorRow.key, 1);
          if (child && child.kind !== "project") {
            setCursorKey(child.key);
            if (child.kind === "thread") selectThread(child.projectId, child.threadId);
          }
        }
        return "handled";
      }
      if (name === "left" || name === "h") {
        if (cursorRow.kind === "project") {
          setExpandedProjectIds((current) => collapseProject(current, cursorRow.projectId));
        } else {
          setCursorKey(projectRowKey(cursorRow.projectId));
        }
        return "handled";
      }
      if (isEnter(name) || name === "space") {
        if (cursorRow.kind === "thread") {
          selectThread(cursorRow.projectId, cursorRow.threadId);
          return "open";
        }
        if (cursorRow.kind === "more") {
          toggleShowAll(cursorRow.projectId);
          return "handled";
        }
        setExpandedProjectIds((current) =>
          current.has(cursorRow.projectId)
            ? collapseProject(current, cursorRow.projectId)
            : ensureProjectExpanded(current, cursorRow.projectId),
        );
        return "handled";
      }
      return null;
    },
    [cursorKey, cursorRow, expandedProjectIds, rows, selectThread, toggleShowAll],
  );

  const markUnread = useCallback(
    (threadId: string) => {
      const thread = threadsById.get(threadId);
      setUnread((current) => markThreadUnread(current, threadId, thread?.latestRun ?? null));
    },
    [threadsById],
  );

  return {
    settings,
    initialized,
    hasSnapshot,
    rows,
    groups,
    projectsById,
    threadsById,
    threadCountByProject,
    olderSettledByProject,
    statusByThread,
    projectStatusById,
    expandedProjectIds,
    selection,
    activeThread,
    activeProject:
      selection.projectId === null ? null : (projectsById.get(selection.projectId) ?? null),
    cursorKey,
    cursorRow,
    handleKey,
    pressRow,
    focusRow,
    markUnread,
  };
}

export type SidebarController = ReturnType<typeof useSidebarController>;
