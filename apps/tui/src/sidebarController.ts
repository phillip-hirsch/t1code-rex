import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from "@t3tools/client-core";
import type { OrchestrationProjectShell, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PrefsWriter, TuiPrefs } from "./prefs.ts";
import {
  buildSidebarGroups,
  buildSidebarRows,
  projectRowKey,
  shareSidebarRows,
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
  toggleProjectExpanded,
} from "./sidebarProjects.ts";
import type { SidebarKeyAction } from "./sidebarKeys.ts";
import {
  EMPTY_MULTI_SELECTION,
  extendThreadSelection,
  orderedThreadIds,
  pruneThreadSelection,
  selectThreadRange,
  toggleThreadInSelection,
  type ThreadMultiSelection,
} from "./sidebarSelection.ts";
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

/** The shell atoms the sidebar reads; the TUI connection provides them. */
export interface SidebarShellSource {
  readonly projectsAtom: Atom.Atom<ReadonlyArray<OrchestrationProjectShell>>;
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<SidebarThread>>;
  readonly hasShellSnapshotAtom: Atom.Atom<boolean>;
  readonly olderSettledAtom: Atom.Atom<OrchestrationV2ShellSnapshot["olderSettled"]>;
}

export interface SidebarControllerOptions {
  readonly connection: SidebarShellSource;
  readonly initialPrefs: TuiPrefs;
  /** New-thread drafts the saved selection may point at; they aren't listed threads yet. */
  readonly isNewThreadDraft?: (threadId: string) => boolean;
  /** Only the main window saves prefs; Rex thread tabs share the file read-only. */
  readonly prefsWriter: PrefsWriter | null;
  readonly launch: ThreadWindowLaunch | null;
  readonly cwd: string;
}

const NO_SELECTION: SidebarSelection = { projectId: null, threadId: null };

/**
 * Sidebar state on top of client-runtime's shell: expansion, the keyboard cursor, the
 * selected thread, and local unread marks. Rows come from the quiet thread list, so a
 * streaming run re-renders only its own status dot.
 */
export function useSidebarController(options: SidebarControllerOptions) {
  const { connection, initialPrefs, prefsWriter, launch, cwd, isNewThreadDraft } = options;
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
  const [multiSelection, setMultiSelection] = useState<ThreadMultiSelection>(EMPTY_MULTI_SELECTION);

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
  const builtRows = useMemo(
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
  // Rebuilt rows reuse the previous objects they repeat, so a selection change or shell
  // update re-renders only the rows it touches.
  const [sharedRows, setSharedRows] = useState({ built: builtRows, rows: builtRows });
  let rows = sharedRows.rows;
  if (sharedRows.built !== builtRows) {
    rows = shareSidebarRows(sharedRows.rows, builtRows);
    setSharedRows({ built: builtRows, rows });
  }
  const projectsById = useMemo(
    () => new Map<string, OrchestrationProjectShell>(projects.map((p) => [p.id, p])),
    [projects],
  );
  const threadsById = useMemo(
    () => new Map<string, SidebarThread>(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  /** Threads the sidebar lists, for keeping the multi-selection on live rows. */
  const listedThreadIds = useMemo(
    () => new Set(groups.flatMap((group) => group.threads.map((thread) => thread.id))),
    [groups],
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
  const activeProjectId = activeThread?.projectId ?? selection.projectId;

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
    const prunedSelection = pruneThreadSelection(multiSelection, listedThreadIds);
    if (prunedSelection !== multiSelection) setMultiSelection(prunedSelection);
  }
  if (!initialized && hasSnapshot) {
    const start = resolveInitialSelection({
      groups,
      launch,
      savedProjectId: initialPrefs.selectedProjectId,
      savedThreadId: initialPrefs.selectedThreadId,
      cwd,
      isNewThreadDraft,
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
  // When the cursor's row disappears, the cursor goes back to following the selection, so
  // the row returning later (an unarchive) doesn't pull it away from the open thread.
  if (storedCursorKey !== null && cursorKey !== storedCursorKey) setCursorKey(null);
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

  /** Every explicit open (click, Enter, or landing on the row) clears its unread mark. */
  const selectThread = useCallback((projectId: string, threadId: string) => {
    setSelection({ projectId, threadId });
    setCursorKey(threadRowKey(threadId));
    setExpandedProjectIds((current) => ensureProjectExpanded(current, projectId));
    setUnread((current) => clearThreadUnread(current, threadId));
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

  /**
   * Mouse presses: the row under the pointer becomes the cursor. A project row only folds
   * or unfolds; the selection is always a thread and its own project. Ctrl+click toggles a
   * thread in the multi-selection and Shift+click extends it, as in the old TUI.
   */
  const pressRow = useCallback(
    (
      row: SidebarRow,
      modifiers: { readonly ctrl?: boolean | undefined; readonly shift?: boolean | undefined } = {},
    ) => {
      setCursorKey(row.key);
      if (row.kind === "thread") {
        if (modifiers.ctrl) {
          setMultiSelection((current) => toggleThreadInSelection(current, row.threadId));
          return;
        }
        if (modifiers.shift) {
          setMultiSelection((current) =>
            selectThreadRange(current, row.threadId, orderedThreadIds(rows)),
          );
          return;
        }
        setMultiSelection(EMPTY_MULTI_SELECTION);
        selectThread(row.projectId, row.threadId);
      } else if (row.kind === "project") {
        setExpandedProjectIds((current) => toggleProjectExpanded(current, row.projectId));
      } else {
        toggleShowAll(row.projectId);
      }
    },
    [rows, selectThread, toggleShowAll],
  );

  /**
   * The sidebar's navigation keys (see `sidebarKeys.ts`). ↑↓ walk the tree, and landing on
   * a thread opens it, as before; landing on a project only moves the cursor. Shift+↑↓
   * extends the multi-selection. Enter opens a thread or toggles a project. Returns "open"
   * when the caller should move focus to the thread.
   */
  const applyKey = useCallback(
    (action: SidebarKeyAction): "handled" | "open" | null => {
      switch (action.type) {
        case "move": {
          const next = moveCursor(rows, cursorKey, action.delta);
          if (next === null) return "handled";
          setCursorKey(next.key);
          if (next.kind === "thread") selectThread(next.projectId, next.threadId);
          return "handled";
        }
        case "extend-selection": {
          if (cursorRow?.kind !== "thread") return "handled";
          const extended = extendThreadSelection(
            multiSelection,
            cursorRow.threadId,
            orderedThreadIds(rows),
            action.delta,
          );
          if (extended === null) return "handled";
          setMultiSelection(extended.selection);
          setCursorKey(threadRowKey(extended.threadId));
          return "handled";
        }
        case "clear-selection":
          setMultiSelection(EMPTY_MULTI_SELECTION);
          return "handled";
        case "edge": {
          const next = action.edge === "start" ? rows[0] : rows.at(-1);
          if (next) setCursorKey(next.key);
          return "handled";
        }
        case "fold": {
          if (cursorRow === null) return "handled";
          if (action.direction === "left") {
            if (cursorRow.kind === "project") {
              setExpandedProjectIds((current) => collapseProject(current, cursorRow.projectId));
            } else {
              setCursorKey(projectRowKey(cursorRow.projectId));
            }
            return "handled";
          }
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
        case "open": {
          if (cursorRow === null) return "handled";
          if (cursorRow.kind === "thread") {
            setMultiSelection(EMPTY_MULTI_SELECTION);
            selectThread(cursorRow.projectId, cursorRow.threadId);
            return "open";
          }
          if (cursorRow.kind === "more") {
            toggleShowAll(cursorRow.projectId);
            return "handled";
          }
          setExpandedProjectIds((current) => toggleProjectExpanded(current, cursorRow.projectId));
          return "handled";
        }
        default:
          return null;
      }
    },
    [cursorKey, cursorRow, expandedProjectIds, multiSelection, rows, selectThread, toggleShowAll],
  );

  const clearMultiSelection = useCallback(() => setMultiSelection(EMPTY_MULTI_SELECTION), []);

  /** Marks the threads that have a finished run; returns how many it marked. */
  const markUnread = useCallback(
    (threadIds: ReadonlyArray<string>) => {
      let marked = 0;
      let next = unread;
      for (const threadId of threadIds) {
        const thread = threadsById.get(threadId);
        const updated = markThreadUnread(next, threadId, thread?.latestRun ?? null);
        if (updated !== next || next.has(threadId)) marked += 1;
        next = updated;
      }
      setUnread(next);
      return marked;
    },
    [threadsById, unread],
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
    // The open thread's own project, so the thread view never pairs it with another title.
    activeProject: activeProjectId === null ? null : (projectsById.get(activeProjectId) ?? null),
    cursorKey,
    cursorRow,
    multiSelection,
    applyKey,
    pressRow,
    focusRow,
    selectThread,
    clearMultiSelection,
    markUnread,
  };
}

export type SidebarController = ReturnType<typeof useSidebarController>;
