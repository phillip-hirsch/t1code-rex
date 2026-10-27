import { ThreadId, NodeId } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { TuiConnection } from "./connection/tuiConnection.ts";
import type { SidebarSubagentSource } from "./sidebar.tsx";
import type { SidebarController } from "./sidebarController.ts";
import {
  PROVIDER_SUBAGENT_READ_ONLY_REASON,
  resolveSubagentThreadContext,
  subagentStopBlocker,
  summarizeSubagentRecord,
  type SubagentThreadContext,
} from "./subagentPresentation.ts";
import type { SubagentActions } from "./subagentViews.tsx";
import { DEFAULT_THREAD_TITLE } from "./threadTitle.ts";

/** A palette row the shell lists as is. */
export interface SubagentPaletteAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly run: () => void | Promise<void>;
}

/** A subagent row's context menu: what a child can do, unlike a top-level thread. */
export type SubagentMenuActionId =
  | "open-rex-tab"
  | "open-parent"
  | "stop-subagent"
  | "copy-thread-id";

export interface SubagentControlsOptions {
  readonly connection: Pick<
    TuiConnection,
    | "subagentAtom"
    | "subagentForChildAtom"
    | "subagentsAtom"
    | "mountThreadFamily"
    | "threadFamilyReadAtom"
    | "stopSubagent"
    | "registry"
  >;
  readonly sidebar: Pick<
    SidebarController,
    "threadsById" | "selection" | "activeThread" | "openedSubagentParents" | "selectThread"
  >;
  /** Rex is here and this is the main window. */
  readonly rexTabs: boolean;
  readonly openInRex: (threadId: string) => Promise<void>;
  readonly runTask: (id: string, task: () => void | Promise<void>) => void;
  readonly setStatus: (status: string) => void;
  readonly onOpened: () => void;
}

/** Keeps each family in the thread list while its id is listed; mounts before it releases. */
function useThreadFamilyMounts(
  mount: (threadId: ThreadId) => () => void,
  threadIds: ReadonlyArray<string>,
): void {
  const mounted = useRef(new Map<string, () => void>());
  const key = [...new Set(threadIds)].sort().join("\n");
  useEffect(() => {
    const wanted = new Set(key === "" ? [] : key.split("\n"));
    for (const threadId of wanted) {
      if (!mounted.current.has(threadId)) {
        mounted.current.set(threadId, mount(ThreadId.make(threadId)));
      }
    }
    for (const [threadId, release] of mounted.current) {
      if (wanted.has(threadId)) continue;
      release();
      mounted.current.delete(threadId);
    }
  }, [key, mount]);
  useEffect(
    () => () => {
      for (const release of mounted.current.values()) release();
      mounted.current.clear();
    },
    [],
  );
}

/**
 * Subagents for the shell: the families the sidebar and the open thread need, the open
 * child's parent, stopping and opening subagents, and their palette rows.
 */
export function useSubagentControls(options: SubagentControlsOptions) {
  const { connection, sidebar, rexTabs } = options;
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { threadsById, selection, activeThread } = sidebar;

  const rootOf = useCallback(
    (threadId: string) => threadsById.get(threadId)?.lineage.rootThreadId ?? threadId,
    [threadsById],
  );
  // The open thread's family (its own row may be an idle child the shell left out), and the
  // families of threads whose subagents the user opened.
  const selectedThreadId = selection.threadId;
  const familyIds = useMemo(
    () => [
      ...(selectedThreadId === null ? [] : [rootOf(selectedThreadId)]),
      ...sidebar.openedSubagentParents.map(rootOf),
    ],
    [rootOf, selectedThreadId, sidebar.openedSubagentParents],
  );
  useThreadFamilyMounts(connection.mountThreadFamily, familyIds);

  const parentShell =
    activeThread?.lineage.parentThreadId == null
      ? null
      : (threadsById.get(activeThread.lineage.parentThreadId) ?? null);
  const context: SubagentThreadContext | null = resolveSubagentThreadContext(
    activeThread,
    parentShell,
  );

  const openThread = useCallback((threadId: string) => {
    const { sidebar: current, onOpened } = latest.current;
    const thread = current.threadsById.get(threadId);
    const projectId = thread?.projectId ?? current.selection.projectId;
    if (projectId === null) return;
    current.selectThread(projectId, threadId);
    onOpened();
  }, []);

  const stop = useCallback((threadId: string, subagentId: string) => {
    const { connection: conn, setStatus, runTask } = latest.current;
    setStatus("Stopping subagent");
    runTask("subagent:stop", async () => {
      const result = await conn.stopSubagent(ThreadId.make(threadId), NodeId.make(subagentId));
      setStatus(result.ok ? "Stop requested" : "Couldn't stop the subagent");
    });
  }, []);

  const openInRex = useCallback((threadId: string) => {
    const { openInRex: open, runTask } = latest.current;
    runTask("subagent:rex-tab", () => open(threadId));
  }, []);

  const actions = useMemo(
    (): SubagentActions => ({
      recordAtom: (threadId, subagentId) =>
        connection.subagentAtom(ThreadId.make(threadId), subagentId),
      childRecordAtom: (parentThreadId, childThreadId) =>
        connection.subagentForChildAtom(ThreadId.make(parentThreadId), childThreadId),
      onOpenThread: openThread,
      onStop: stop,
      onOpenInRex: rexTabs ? openInRex : null,
    }),
    [connection, openInRex, openThread, rexTabs, stop],
  );

  // Records are read only for parents whose detail is already loaded: the open thread, and
  // the open child's parent, which its header reads. Others show their shell state.
  const parentId = context?.parentThreadId ?? null;
  const sidebarSource = useMemo(
    (): SidebarSubagentSource => ({
      recordAtom: (parentThreadId, childThreadId) =>
        parentThreadId === selectedThreadId || parentThreadId === parentId
          ? connection.subagentForChildAtom(ThreadId.make(parentThreadId), childThreadId)
          : null,
      familyReadAtom: (threadId) =>
        connection.threadFamilyReadAtom(ThreadId.make(rootOf(threadId))),
    }),
    [connection, parentId, rootOf, selectedThreadId],
  );

  /** The parent's record for a child, if its parent's subagents are loaded. */
  const recordForChild = (childThreadId: string) => {
    const child = threadsById.get(childThreadId);
    const parent = child?.lineage.parentThreadId ?? null;
    if (parent === null || (parent !== selectedThreadId && parent !== parentId)) return null;
    return connection.registry.get(
      connection.subagentForChildAtom(ThreadId.make(parent), childThreadId),
    );
  };

  /** The open child's way back: p in the thread pane. False when it has no parent. */
  const openParent = (): boolean => {
    if (context === null) return false;
    openThread(context.parentThreadId);
    return true;
  };

  const menuItems = (childThreadId: string) => {
    const record = recordForChild(childThreadId);
    const blocker =
      record === null ? "Open the subagent to stop it from here" : subagentStopBlocker(record);
    return [
      ...(rexTabs ? [{ id: "open-rex-tab" as const, label: "Open in Rex Tab" }] : []),
      { id: "open-parent" as const, label: "Open parent thread" },
      {
        id: "stop-subagent" as const,
        label: "Stop subagent",
        ...(blocker === null ? {} : { disabledReason: blocker }),
      },
      { id: "copy-thread-id" as const, label: "Copy Thread ID" },
    ];
  };

  /** Runs a subagent row's menu item; copying the id is the shell's, as for threads. */
  const runMenuItem = (childThreadId: string, id: string): boolean => {
    switch (id) {
      case "open-rex-tab":
        openInRex(childThreadId);
        return true;
      case "open-parent": {
        const parent = threadsById.get(childThreadId)?.lineage.parentThreadId;
        if (parent) openThread(parent);
        return true;
      }
      case "stop-subagent": {
        const record = recordForChild(childThreadId);
        if (record !== null) stop(record.threadId, record.id);
        return true;
      }
      default:
        return false;
    }
  };

  /**
   * Palette rows, built only while the palette is open: the open child's own actions, then
   * each subagent of the open thread.
   */
  const paletteActions = (open: boolean): ReadonlyArray<SubagentPaletteAction> => {
    if (!open || selectedThreadId === null) return [];
    const rows: SubagentPaletteAction[] = [];
    if (context !== null) {
      const self = recordForChild(selectedThreadId);
      const name = activeThread?.title || DEFAULT_THREAD_TITLE;
      rows.push({
        id: "subagent:parent",
        label: "Open parent thread",
        description: `p in the thread  ${context.parentTitle ?? ""}`.trim(),
        run: () => openThread(context.parentThreadId),
      });
      const blocker =
        self === null ? "Subagent details are still loading" : subagentStopBlocker(self);
      rows.push({
        id: "subagent:stop-self",
        label: "Stop this subagent",
        description: blocker ?? name,
        disabled: blocker !== null,
        run: () => {
          if (self !== null) stop(self.threadId, self.id);
        },
      });
      if (rexTabs) {
        rows.push({
          id: "subagent:rex-self",
          label: "Open subagent in Rex tab",
          description: name,
          run: () => openInRex(selectedThreadId),
        });
      }
    }
    const subagents = connection.registry.get(
      connection.subagentsAtom(ThreadId.make(selectedThreadId)),
    );
    for (const record of subagents) {
      const summary = summarizeSubagentRecord(record);
      const childId = record.childThreadId;
      const what = `${summary.title} · ${summary.state}`;
      if (childId !== null) {
        rows.push({
          id: `subagent:open:${record.id}`,
          label: `Open subagent: ${summary.title}`,
          description: what,
          run: () => openThread(childId),
        });
        if (rexTabs) {
          rows.push({
            id: `subagent:rex:${record.id}`,
            label: `Open subagent in Rex tab: ${summary.title}`,
            description: what,
            run: () => openInRex(childId),
          });
        }
      }
      if (subagentStopBlocker(record) === null) {
        rows.push({
          id: `subagent:stop:${record.id}`,
          label: `Stop subagent: ${summary.title}`,
          description: what,
          run: () => stop(record.threadId, record.id),
        });
      }
    }
    return rows;
  };

  return {
    context,
    /** Why the composer is replaced, for a provider-native child; else null. */
    readOnlyReason: context?.readOnly === true ? PROVIDER_SUBAGENT_READ_ONLY_REASON : null,
    actions,
    sidebarSource,
    openParent,
    menuItems,
    runMenuItem,
    paletteActions,
  };
}

export type SubagentControls = ReturnType<typeof useSubagentControls>;
