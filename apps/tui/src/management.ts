// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- The TUI mints ids and runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { KeyEvent } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  resolveProjectPathForDispatch,
} from "@t3tools/client-runtime/state/projects";
import {
  EDITORS,
  ProjectId,
  ThreadId,
  type EditorId,
  type FilesystemBrowseResult,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";

import { copyTextToClipboard } from "./clipboardText.ts";
import type { ComposerStore } from "./composerStore.ts";
import {
  archiveThreadsConfirm,
  deleteThreadsConfirm,
  openConfirm,
  pressConfirmButton,
  projectRemovalSteps,
  reduceConfirmKey,
  type ConfirmButton,
  type ConfirmDialogState,
  type ConfirmOutcome,
} from "./confirmDialog.ts";
import type { TuiActionResult, TuiConnection } from "./connection/tuiConnection.ts";
import type { T1Logger } from "./log.ts";
import {
  applyProjectPathSuggestion,
  CLONE_USAGE,
  defaultCloneParent,
  initialProjectPath,
  parseCloneArgs,
  projectPathBrowseTarget,
  projectPathSuggestions,
} from "./projectPaths.ts";
import type { SidebarController } from "./sidebarController.ts";
import { describeBulkOutcome, runForThreads } from "./threadActions.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitle.ts";

/**
 * Thread and project management: rename, archive, delete, pin, settle, open in editor,
 * add, clone and remove projects. Every action goes through client-runtime's commands, the
 * ones web and mobile use. Dialogs live here too; the shell renders them and routes keys.
 */

export type PromptState =
  | {
      readonly kind: "rename-thread";
      readonly threadId: string;
      readonly value: string;
      readonly error: string | null;
    }
  | {
      readonly kind: "rename-project";
      readonly projectId: string;
      readonly value: string;
      readonly error: string | null;
    }
  | { readonly kind: "add-project"; readonly value: string; readonly error: string | null }
  | { readonly kind: "clone"; readonly value: string; readonly error: string | null };

interface ConfirmState {
  readonly dialog: ConfirmDialogState;
  readonly run: () => Promise<void>;
}

type BrowseAtom = Atom.Atom<AsyncResult.AsyncResult<FilesystemBrowseResult, unknown>>;
const NO_BROWSE: BrowseAtom = Atom.make(AsyncResult.initial<FilesystemBrowseResult, unknown>());
const SUGGESTION_DEBOUNCE_MS = 80;

export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message).trim();
    if (message.length > 0) return message;
  }
  return String(error);
}

/** The first code editor the host has, in upstream's order; web falls back the same way. */
export function preferredEditor(available: ReadonlyArray<EditorId>): EditorId | null {
  return (
    EDITORS.find((editor) => editor.id !== "file-manager" && available.includes(editor.id))?.id ??
    null
  );
}

function isEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed";
}

export interface ManagementOptions {
  readonly connection: TuiConnection;
  readonly sidebar: SidebarController;
  readonly serverConfig: ServerConfig | null;
  readonly composerStore: ComposerStore;
  readonly logger: T1Logger;
  readonly setStatus: (status: string) => void;
  /** Opens a new-thread draft in the project and focuses the composer. */
  readonly openNewThread: (projectId: string) => void;
}

export function useManagement(options: ManagementOptions) {
  const { connection, sidebar, serverConfig, composerStore, logger, setStatus, openNewThread } =
    options;
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  /** Remounts the prompt's input so a picked suggestion's text lands with the cursor at its end. */
  const [promptRevision, setPromptRevision] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const capabilities = serverConfig?.environment.capabilities;
  const platform = serverConfig?.environment.platform.os ?? "";

  // Folder suggestions for the add-project prompt, from the server, after a short pause.
  const browseTarget =
    prompt?.kind === "add-project" ? projectPathBrowseTarget(prompt.value, platform) : null;
  const browsePath = browseTarget?.partialPath ?? null;
  const browseFilter = browseTarget?.filter ?? "";
  const [debouncedBrowse, setDebouncedBrowse] = useState<{
    readonly partialPath: string;
    readonly filter: string;
  } | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setDebouncedBrowse(
          browsePath === null ? null : { partialPath: browsePath, filter: browseFilter },
        ),
      SUGGESTION_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [browsePath, browseFilter]);
  const browseAtom: BrowseAtom =
    debouncedBrowse === null
      ? NO_BROWSE
      : connection.browseAtom({ partialPath: debouncedBrowse.partialPath });
  const browseResult = useAtomValue(browseAtom);
  const browsed = Option.getOrNull(AsyncResult.value(browseResult));
  const suggestions =
    prompt?.kind === "add-project" && debouncedBrowse !== null && browsed !== null
      ? projectPathSuggestions(browsed.entries, debouncedBrowse.filter)
      : [];

  const report = useCallback(
    (action: string, result: TuiActionResult<unknown>, success: string) => {
      if (result.ok) {
        setStatus(success);
        return true;
      }
      if (!result.interrupted) {
        logger.log("management.failed", { action, error: describeError(result.error) });
        setStatus(`${action} failed: ${describeError(result.error)}`);
      }
      return false;
    },
    [logger, setStatus],
  );

  const threadTitle = (threadId: string) =>
    sidebar.threadsById.get(threadId)?.title || DEFAULT_THREAD_TITLE;

  const archiveNow = async (threadIds: ReadonlyArray<string>) => {
    const outcome = await runForThreads(threadIds, (threadId) =>
      connection.archiveThread({ threadId: ThreadId.make(threadId) }),
    );
    sidebar.clearMultiSelection();
    connection.refreshArchivedThreads();
    setStatus(describeBulkOutcome("Archived", outcome, describeError));
  };

  const requestArchive = (threadIds: ReadonlyArray<string>) => {
    // Archive rejects a thread whose provider is attached; web disables it while running.
    const running = threadIds.filter(
      (threadId) => !threadRuntimeCanArchive(sidebar.threadsById.get(threadId)?.runtime),
    );
    if (running.length > 0) {
      setStatus(
        running.length === threadIds.length
          ? "Stop the run before archiving"
          : `Stop ${running.length} running thread${running.length === 1 ? "" : "s"} before archiving`,
      );
      return;
    }
    if (!sidebar.settings.confirmThreadArchive) {
      void archiveNow(threadIds);
      return;
    }
    setConfirm({
      dialog: openConfirm([archiveThreadsConfirm(threadIds.map(threadTitle))]),
      run: () => archiveNow(threadIds),
    });
  };

  const unarchive = async (threadId: string) => {
    const result = await connection.unarchiveThread({ threadId: ThreadId.make(threadId) });
    connection.refreshArchivedThreads();
    report("Restore", result, "Thread restored");
  };

  /** Deleting always asks, whatever the confirm setting says: it can't be undone. */
  const requestDelete = (threadIds: ReadonlyArray<string>, titles?: ReadonlyArray<string>) => {
    if (threadIds.length === 0) return;
    setConfirm({
      dialog: openConfirm([deleteThreadsConfirm(titles ?? threadIds.map(threadTitle))]),
      run: async () => {
        const outcome = await runForThreads(threadIds, (threadId) =>
          connection.deleteThread({ threadId: ThreadId.make(threadId) }),
        );
        for (const threadId of outcome.done) composerStore.clearDraft(threadId);
        sidebar.clearMultiSelection();
        connection.refreshArchivedThreads();
        setStatus(describeBulkOutcome("Deleted", outcome, describeError));
      },
    });
  };

  const setPinned = async (threadId: string, pinned: boolean) => {
    const input = { threadId: ThreadId.make(threadId) };
    const result = pinned ? await connection.pinThread(input) : await connection.unpinThread(input);
    report(pinned ? "Pin" : "Unpin", result, pinned ? "Pinned thread" : "Unpinned thread");
  };

  const setSettled = async (threadId: string, settled: boolean) => {
    const id = ThreadId.make(threadId);
    const result = settled
      ? await connection.settleThread({ threadId: id })
      : await connection.unsettleThread({ threadId: id, reason: "user" });
    report(
      settled ? "Settle" : "Un-settle",
      result,
      settled ? "Settled thread" : "Un-settled thread",
    );
  };

  const markUnread = (threadIds: ReadonlyArray<string>) => {
    const marked = sidebar.markUnread(threadIds);
    sidebar.clearMultiSelection();
    setStatus(marked > 0 ? "Marked unread" : "Nothing to mark unread");
  };

  const renameThread = (threadId: string) => {
    setPrompt({ kind: "rename-thread", threadId, value: threadTitle(threadId), error: null });
    setPromptRevision((revision) => revision + 1);
  };

  const openPath = async (path: string | null, target: "editor" | "folder") => {
    if (path === null) {
      setStatus("Path unavailable");
      return;
    }
    const available = serverConfig?.availableEditors ?? [];
    const editor: EditorId | null =
      target === "folder"
        ? available.includes("file-manager")
          ? "file-manager"
          : null
        : preferredEditor(available);
    if (editor === null) {
      setStatus(target === "folder" ? "No file manager found" : "No editor found");
      return;
    }
    const result = await connection.openInEditor({ cwd: path, editor });
    const label = EDITORS.find((entry) => entry.id === editor)?.label ?? editor;
    report(
      target === "folder" ? "Open folder" : "Open in editor",
      result,
      target === "folder" ? "Opened folder" : `Opened in ${label}`,
    );
  };

  const copyPath = async (path: string | null) => {
    if (path === null) {
      setStatus("Path unavailable");
      return;
    }
    await copyTextToClipboard(path);
    setStatus("Copied path");
  };

  const openAddProject = () => {
    setPrompt({
      kind: "add-project",
      value: initialProjectPath(serverConfig?.settings.addProjectBaseDirectory),
      error: null,
    });
    setSuggestionIndex(0);
    setPromptRevision((revision) => revision + 1);
  };

  const openClone = () => {
    setPrompt({ kind: "clone", value: "", error: null });
    setPromptRevision((revision) => revision + 1);
  };

  const renameProject = (projectId: string) => {
    const project = sidebar.projectsById.get(projectId);
    if (!project) return;
    setPrompt({ kind: "rename-project", projectId, value: project.title, error: null });
    setPromptRevision((revision) => revision + 1);
  };

  const requestRemoveProject = (projectId: string) => {
    const project = sidebar.projectsById.get(projectId);
    if (!project) return;
    const threadCount =
      (sidebar.threadCountByProject.get(ProjectId.make(projectId)) ?? 0) +
      (sidebar.olderSettledByProject.get(ProjectId.make(projectId)) ?? 0);
    setConfirm({
      dialog: openConfirm(projectRemovalSteps(project.title, threadCount)),
      run: async () => {
        // The user confirmed deleting its threads; the server refuses otherwise.
        const result = await connection.deleteProject({
          projectId: ProjectId.make(projectId),
          force: true,
        });
        report("Remove project", result, `Removed project ${project.title}`);
      },
    });
  };

  const activeProjectRoot = sidebar.activeProject?.workspaceRoot ?? null;

  /** Adds the folder as a project, or reuses the project already there, and starts a thread. */
  const addProjectAt = async (rawPath: string): Promise<string | null> => {
    const path = resolveProjectPathForDispatch(rawPath, activeProjectRoot);
    if (path.length === 0) return "Enter a project path";
    const projects = [...sidebar.projectsById.values()];
    const existing = findProjectByPath(projects, path);
    if (existing) {
      openNewThread(existing.id);
      setStatus(`${existing.title} is already a project`);
      return null;
    }
    const projectId = ProjectId.make(NodeCrypto.randomUUID());
    const result = await connection.createProject({
      projectId,
      title: inferProjectTitleFromPath(path),
      workspaceRoot: path,
      // Like the old TUI, a typo doesn't make a folder: the path must exist.
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    });
    if (!result.ok) return describeError(result.error);
    openNewThread(result.value.id);
    setStatus(`Added project ${result.value.title}`);
    return null;
  };

  /** Runs `/clone`; returns the error to show, or null once the clone started. */
  const clone = async (args: string): Promise<string | null> => {
    const parsed = parseCloneArgs(
      args,
      defaultCloneParent(activeProjectRoot, serverConfig?.settings.addProjectBaseDirectory),
    );
    if (!parsed.ok) return parsed.error;
    const { request } = parsed;
    const source = {
      ...(request.remoteUrl ? { remoteUrl: request.remoteUrl } : {}),
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.repository ? { repository: request.repository } : {}),
      ...(request.protocol ? { protocol: request.protocol } : {}),
    };
    setStatus(`Cloning into ${request.destinationPath}`);
    if (capabilities?.projectCloneTracking === true) {
      const projectId = ProjectId.make(NodeCrypto.randomUUID());
      const result = await connection.startProjectClone({
        projectId,
        title: request.title,
        createdAt: new Date().toISOString(),
        destinationPath: request.destinationPath,
        ...source,
      });
      if (!result.ok) return describeError(result.error);
      openNewThread(projectId);
      setStatus(`Cloning ${result.value.repository?.nameWithOwner ?? result.value.remoteUrl}`);
      return null;
    }
    // Older servers clone first and add the project after.
    const cloned = await connection.cloneRepository({
      destinationPath: request.destinationPath,
      ...source,
    });
    if (!cloned.ok) return describeError(cloned.error);
    return addProjectAt(cloned.value.cwd);
  };

  const submitPrompt = async () => {
    if (prompt === null || busy) return;
    const value = prompt.value.trim();
    const fail = (error: string) =>
      setPrompt((current) => (current === null ? current : { ...current, error }));
    setBusy(true);
    try {
      switch (prompt.kind) {
        case "rename-thread": {
          if (value.length === 0) return fail("Thread title required");
          if (value !== threadTitle(prompt.threadId)) {
            const result = await connection.updateThreadMetadata({
              threadId: ThreadId.make(prompt.threadId),
              title: value,
            });
            if (!result.ok) return fail(describeError(result.error));
            setStatus("Thread renamed");
          }
          setPrompt(null);
          return;
        }
        case "rename-project": {
          if (value.length === 0) return fail("Project name required");
          if (value !== sidebar.projectsById.get(prompt.projectId)?.title) {
            const result = await connection.updateProject({
              projectId: ProjectId.make(prompt.projectId),
              title: value,
            });
            if (!result.ok) return fail(describeError(result.error));
            setStatus("Project renamed");
          }
          setPrompt(null);
          return;
        }
        case "add-project": {
          const error = await addProjectAt(value);
          if (error !== null) return fail(error);
          setPrompt(null);
          return;
        }
        case "clone": {
          if (value.length === 0) return fail(`Usage: ${CLONE_USAGE}`);
          const error = await clone(value);
          if (error !== null) return fail(error);
          setPrompt(null);
          return;
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const setPromptValue = (value: string) => {
    setPrompt((current) => (current === null ? current : { ...current, value, error: null }));
    setSuggestionIndex(0);
  };

  const pickSuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (prompt?.kind !== "add-project" || suggestion === undefined) return;
    setPromptValue(applyProjectPathSuggestion(prompt.value, suggestion.name));
    setPromptRevision((revision) => revision + 1);
  };

  const applyConfirmOutcome = (outcome: ConfirmOutcome) => {
    if (confirm === null) return;
    if (outcome.type === "state") setConfirm({ ...confirm, dialog: outcome.state });
    else if (outcome.type === "cancel") {
      setConfirm(null);
      setStatus("Cancelled");
    } else if (outcome.type === "confirm") {
      setConfirm(null);
      void confirm.run().catch((error: unknown) => setStatus(describeError(error)));
    }
  };

  const pressConfirm = (button: ConfirmButton) => {
    if (confirm !== null) applyConfirmOutcome(pressConfirmButton(confirm.dialog, button));
  };

  /**
   * Keys while a dialog is open. The confirm dialog takes every key. The prompt takes Esc,
   * Enter, and suggestion keys, and leaves the rest to its text input. Returns true when the
   * key is used up.
   */
  const handleDialogKey = (key: KeyEvent): boolean => {
    if (confirm !== null) {
      applyConfirmOutcome(reduceConfirmKey(confirm.dialog, key));
      return true;
    }
    if (prompt === null) return false;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      setPrompt(null);
      return true;
    }
    if (isEnter(key.name)) {
      if (!key.repeated) void submitPrompt();
      return true;
    }
    if (prompt.kind === "add-project" && suggestions.length > 0) {
      if (key.name === "tab") {
        pickSuggestion(suggestionIndex);
        return true;
      }
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        setSuggestionIndex((index) => Math.min(suggestions.length - 1, Math.max(0, index + delta)));
        return true;
      }
    }
    return key.name === "tab";
  };

  return {
    confirm: confirm?.dialog ?? null,
    prompt,
    promptRevision,
    promptBusy: busy,
    suggestions,
    suggestionIndex: Math.min(suggestionIndex, Math.max(0, suggestions.length - 1)),
    dialogOpen: confirm !== null || prompt !== null,
    handleDialogKey,
    pressConfirm,
    setPromptValue,
    pickSuggestion,
    closePrompt: () => setPrompt(null),
    capabilities: {
      pinning: capabilities?.threadPinning === true,
      settlement: capabilities?.threadSettlement === true,
    },
    requestArchive,
    unarchive,
    requestDelete,
    setPinned,
    setSettled,
    markUnread,
    renameThread,
    openPath,
    copyPath,
    openAddProject,
    openClone,
    renameProject,
    requestRemoveProject,
    clone,
  };
}

export type Management = ReturnType<typeof useManagement>;
