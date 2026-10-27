/**
 * The sidebar's context menus: one thread, several selected threads, or a project. The
 * palette lists the same actions for the selected thread and project, so both read these.
 */

export type ThreadMenuActionId =
  | "open-rex-tab"
  | "rename"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "mark-unread"
  | "open-editor"
  | "open-folder"
  | "copy-path"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type MultiThreadMenuActionId = "mark-unread" | "archive" | "delete";

export type ProjectMenuActionId =
  | "new-thread"
  | "rename-project"
  | "open-editor"
  | "open-folder"
  | "copy-path"
  | "remove-project";

export interface MenuItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** Asks before it runs and can't be undone. */
  readonly destructive?: boolean;
  /** Why the item can't run now; it stays listed but does nothing. */
  readonly disabledReason?: string;
}

/** What the server supports, from `ServerConfig.environment.capabilities`, as web reads it. */
export interface ThreadMenuCapabilities {
  readonly pinning: boolean;
  readonly settlement: boolean;
}

export function buildThreadMenuItems(input: {
  /** Rex is available and this is the main window, not a thread tab. */
  readonly rexTabs: boolean;
  readonly capabilities: ThreadMenuCapabilities;
  readonly pinned: boolean;
  readonly settled: boolean;
  /** Archive rejects a thread whose provider is attached, so web disables it while running. */
  readonly running: boolean;
}): ReadonlyArray<MenuItem<ThreadMenuActionId>> {
  return [
    ...(input.rexTabs ? [{ id: "open-rex-tab" as const, label: "Open in Rex Tab" }] : []),
    { id: "rename", label: "Rename thread" },
    ...(input.capabilities.pinning
      ? [
          input.pinned
            ? { id: "unpin" as const, label: "Unpin thread" }
            : { id: "pin" as const, label: "Pin thread" },
        ]
      : []),
    ...(input.capabilities.settlement
      ? [
          input.settled
            ? { id: "unsettle" as const, label: "Un-settle thread" }
            : { id: "settle" as const, label: "Settle thread" },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread" },
    { id: "open-editor", label: "Open in Editor" },
    { id: "open-folder", label: "Open Folder" },
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-thread-id", label: "Copy Thread ID" },
    {
      id: "archive",
      label: "Archive",
      ...(input.running ? { disabledReason: "Stop the run before archiving" } : {}),
    },
    { id: "delete", label: "Delete", destructive: true },
  ];
}

export function buildMultiThreadMenuItems(
  count: number,
): ReadonlyArray<MenuItem<MultiThreadMenuActionId>> {
  return [
    { id: "mark-unread", label: `Mark unread (${count})` },
    { id: "archive", label: `Archive (${count})` },
    { id: "delete", label: `Delete (${count})`, destructive: true },
  ];
}

export function buildProjectMenuItems(): ReadonlyArray<MenuItem<ProjectMenuActionId>> {
  return [
    { id: "new-thread", label: "New thread" },
    { id: "rename-project", label: "Rename project" },
    { id: "open-editor", label: "Open in Editor" },
    { id: "open-folder", label: "Open Folder" },
    { id: "copy-path", label: "Copy Path" },
    { id: "remove-project", label: "Remove project", destructive: true },
  ];
}

/** A thread works in its worktree when it has one, else in its project's root. */
export function threadWorkspacePath(
  thread: { readonly worktreePath: string | null },
  project: { readonly workspaceRoot: string } | undefined,
): string | null {
  return thread.worktreePath ?? project?.workspaceRoot ?? null;
}
