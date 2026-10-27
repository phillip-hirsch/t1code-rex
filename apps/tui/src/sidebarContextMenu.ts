/**
 * The thread context menu. It lists only actions that work on orchestration v2 today;
 * rename, archive, delete, and the editor and folder openers return with thread management.
 */

export type ThreadContextMenuActionId =
  | "open-rex-tab"
  | "mark-unread"
  | "copy-path"
  | "copy-thread-id";

export interface ThreadContextMenuItem {
  readonly id: ThreadContextMenuActionId;
  readonly label: string;
}

export function buildThreadContextMenuItems(input: {
  /** Rex is available and this is the main window, not a thread tab. */
  readonly rexTabs: boolean;
}): ReadonlyArray<ThreadContextMenuItem> {
  return [
    ...(input.rexTabs ? [{ id: "open-rex-tab" as const, label: "Open in Rex Tab" }] : []),
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-thread-id", label: "Copy Thread ID" },
  ];
}

/** A thread works in its worktree when it has one, else in its project's root. */
export function threadWorkspacePath(
  thread: { readonly worktreePath: string | null },
  project: { readonly workspaceRoot: string } | undefined,
): string | null {
  return thread.worktreePath ?? project?.workspaceRoot ?? null;
}
