// @effect-diagnostics nodeBuiltinImport:off -- Action ids are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { KeyEvent } from "@opentui/core";
import {
  type GitActionProgressEvent,
  type OrchestrationProjectShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import {
  localBranchName,
  resolveBranchSelectionTarget,
  type BranchPickerChoice,
} from "./branchPicker.ts";
import {
  resolveEnvMode,
  type EnvMode,
  type GitFailure,
  type ToolbarSegment,
} from "./branchToolbar.ts";
import type { LaunchWorktree } from "./composerSend.ts";
import type { ComposerStore } from "./composerStore.ts";
import type { TuiActionResult, TuiConnection } from "./connection/tuiConnection.ts";
import {
  armConfirmation,
  describeGitActionFailure,
  describeGitActionResult,
  isArmed,
  type ArmedConfirmation,
  type GitMenuItem,
} from "./gitMenu.ts";
import type { GitOverlayHandle, GitOverlayMode } from "./gitViews.tsx";
import { openExternalUrl } from "./openExternal.ts";
import {
  describePublishFailure,
  describePublishResult,
  parsePublishArgs,
  repositoryTakenMessage,
  resolvePublish,
  type PublishPlan,
} from "./publishCommand.ts";
import type { SidebarThread } from "./sidebarModel.ts";
import { worktreeSendBlock, type WorktreeLaunch } from "./worktreeLaunch.ts";

/** What the git controls act on: the selected thread, or a new-thread draft. */
export interface GitTarget {
  readonly kind: "thread" | "draft";
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

type GitCommands = Pick<
  TuiConnection,
  | "registry"
  | "vcsStatusAtom"
  | "switchRef"
  | "createRef"
  | "initRepository"
  | "pull"
  | "runStackedAction"
  | "refreshVcsStatus"
  | "cancelWorktreeSetup"
  | "worktreeSetupAtom"
  | "worktreeLaunchAtom"
  | "retryWorkspacePreparation"
  | "stopThreadSession"
  | "updateThreadMetadata"
  | "vcsActionStateAtom"
  | "discoverSourceControl"
  | "lookupRepository"
  | "listRemoteRefs"
  | "publishRepository"
>;

export interface GitControlsOptions {
  readonly connection: GitCommands;
  readonly store: Pick<
    ComposerStore,
    "findNewThreadDraft" | "setNewThreadDraftWorkspace" | "setNotice" | "getDraft" | "restoreDraft"
  >;
  readonly target: GitTarget | null;
  readonly thread: SidebarThread | null;
  readonly project: OrchestrationProjectShell | null;
  /** The server's default for new threads; a project's own default wins. */
  readonly defaultEnvMode: EnvMode;
  /** New worktrees branch from the base's remote copy, per the server setting. */
  readonly startFromOrigin: boolean;
  readonly setStatus: (message: string) => void;
  /** Opens the model picker for the commit-message model. */
  readonly onPickCommitModel: () => void;
  readonly onFocusComposer: () => void;
  /** The open overlay's key handler. */
  readonly overlayRef: RefObject<GitOverlayHandle | null>;
}

const NO_LAUNCH: Atom.Atom<WorktreeLaunch | null> = Atom.make(null);

function errorText(error: unknown): string {
  return describeGitActionFailure(error, null);
}

function failed<A>(result: TuiActionResult<A>, what: string): string | null {
  if (result.ok) return null;
  return result.interrupted ? `${what} cancelled` : `${what} failed: ${errorText(result.error)}`;
}

/**
 * The branch toolbar, git menu, branch picker and worktree setup for the active thread or
 * draft. Overlay state lives here; the views read status and refs themselves, so status
 * updates never re-render the shell.
 */
export function useGitControls(options: GitControlsOptions) {
  const { connection, store, target, thread, project, setStatus } = options;
  const [overlay, setOverlay] = useState<GitOverlayMode | null>(null);
  const [armed, setArmed] = useState<ArmedConfirmation | null>(null);
  const [lastFailure, setLastFailure] = useState<GitFailure | null>(null);
  const { overlayRef } = options;

  const draft = target?.kind === "draft" ? store.findNewThreadDraft(target.threadId) : undefined;
  const projectCwd = project?.workspaceRoot ?? null;
  const worktreePath = target?.kind === "thread" ? (thread?.worktreePath ?? null) : null;
  // The server's word on a launch into a new worktree: still preparing, or failed.
  const launch = useAtomValue(
    target?.kind === "thread" ? connection.worktreeLaunchAtom(target.threadId) : NO_LAUNCH,
  );
  const setupFailed = worktreePath === null && launch?.status === "failed";
  const launching = worktreePath === null && launch !== null;
  const envMode = launching
    ? "worktree"
    : resolveEnvMode({
        draft: target?.kind === "draft",
        worktreePath,
        draftEnvMode: draft?.envMode,
        defaultEnvMode: project?.defaultThreadEnvMode ?? options.defaultEnvMode,
      });
  const threadBranch =
    target?.kind === "thread"
      ? (thread?.branch ?? (launching ? (launch?.baseRef ?? null) : null))
      : (draft?.baseBranch ?? null);
  const sendBlock = target?.kind === "thread" ? worktreeSendBlock({ worktreePath, launch }) : null;
  const cwd = worktreePath ?? projectCwd;
  const pickingWorktreeBase = target?.kind === "draft" && envMode === "worktree";
  const failure = lastFailure !== null && lastFailure.cwd === cwd ? lastFailure : null;
  const threadId = target?.threadId ?? null;
  // The thread, checkout and overlay as of the latest render, for async work and key presses
  // that must not land on another one.
  const live = useRef({ threadId, cwd, overlay });
  useLayoutEffect(() => {
    live.current = { threadId, cwd, overlay };
  });
  const isLive = (forThread: ThreadId, forCwd: string) =>
    live.current.threadId === forThread && live.current.cwd === forCwd;
  // A confirmation is for the thread and checkout it was checked on; moving away drops it,
  // so coming back never shows it again.
  const stalePublish =
    overlay?.kind === "publish" &&
    (overlay.threadId !== threadId || overlay.plan.input.cwd !== cwd);
  if (stalePublish) {
    setOverlay(null);
    setStatus("Publish cancelled: the thread changed; nothing was created");
  }
  const shownOverlay = stalePublish ? null : overlay;

  const close = () => {
    setOverlay(null);
    setArmed(null);
  };
  const openMenu = () => {
    if (target === null || cwd === null) {
      setStatus("Select a thread first");
      return;
    }
    setArmed(null);
    setOverlay({ kind: "menu" });
    // As web re-reads status when its git menu opens.
    void connection.refreshVcsStatus(cwd, true);
  };
  const openBranchPicker = (query = "") => {
    if (target === null || cwd === null) {
      setStatus("Select a thread first");
      return;
    }
    setArmed(null);
    setOverlay({ kind: "branches", initialQuery: query });
    void connection.refreshVcsStatus(cwd, true);
  };

  const currentRefName = (): string | null => {
    if (cwd === null) return null;
    const status = Option.getOrNull(
      AsyncResult.value(connection.registry.get(connection.vcsStatusAtom(cwd))),
    );
    return status?.refName ?? null;
  };

  const setEnvMode = (next: EnvMode) => {
    if (target === null) return;
    if (target.kind === "thread") {
      if (setupFailed) {
        openMenu();
        return;
      }
      setStatus(
        worktreePath === null
          ? "This thread works in the project's checkout; start a new thread for a worktree"
          : "This thread keeps its worktree; pick a branch to switch it",
      );
      return;
    }
    store.setNewThreadDraftWorkspace(target.threadId, {
      envMode: next,
      baseBranch: draft?.baseBranch ?? (next === "worktree" ? currentRefName() : null),
    });
    setStatus(
      next === "worktree" ? "New thread starts in a new worktree" : "New thread starts locally",
    );
  };
  const toggleWorktree = () => setEnvMode(envMode === "worktree" ? "local" : "worktree");

  /** A draft's first send makes its worktree from the picked base, else from the checkout's branch. */
  const launchWorktree = (): LaunchWorktree | undefined => {
    if (target?.kind !== "draft" || envMode !== "worktree" || projectCwd === null) return undefined;
    const baseBranch = draft?.baseBranch ?? currentRefName() ?? "HEAD";
    return { projectCwd, baseBranch, startFromOrigin: options.startFromOrigin };
  };

  /**
   * Runs the failed preparation again (`prepared-run.retry`, as web's retry button). Once it
   * makes the worktree, the server lets the messages it held follow, in order.
   */
  const retrySetup = async () => {
    if (target?.kind !== "thread" || !setupFailed || launch === null) {
      setStatus("No failed worktree setup here");
      return;
    }
    if (!launch.retryable) {
      setStatus("This worktree setup can't be retried; start a new thread");
      return;
    }
    const threadId = target.threadId;
    const result = await connection.retryWorkspacePreparation({ threadId, runId: launch.runId });
    if (result.ok) {
      // The composer's "setup failed" notice is answered.
      store.setNotice(threadId, null);
      setStatus("Retrying worktree setup");
    } else setStatus(failed(result, "Retrying worktree setup") ?? "");
  };

  /** Points the thread at a branch and checkout, stopping its session if the checkout moves. */
  const setThreadBranch = async (branch: string, nextWorktreePath: string | null) => {
    if (target?.kind !== "thread") return;
    if (nextWorktreePath !== worktreePath && thread?.runtime != null) {
      const stopped = await connection.stopThreadSession({ threadId: target.threadId });
      const error = failed(stopped, "Stopping the session");
      if (error !== null) setStatus(error);
    }
    const updated = await connection.updateThreadMetadata({
      threadId: target.threadId,
      branch,
      worktreePath: nextWorktreePath,
    });
    setStatus(failed(updated, "Updating the thread") ?? `On ${branch}`);
  };

  const pickBranch = async (item: BranchPickerChoice) => {
    if (target === null || cwd === null || projectCwd === null) return;
    close();
    setLastFailure(null);
    options.onFocusComposer();
    switch (item.kind) {
      case "init": {
        const result = await connection.initRepository({ cwd });
        setStatus(failed(result, "git init") ?? "Initialized a git repository");
        return;
      }
      case "create": {
        const result = await connection.createRef({ cwd, refName: item.name, switchRef: true });
        if (!result.ok) {
          setStatus(failed(result, `Creating ${item.name}`) ?? "");
          return;
        }
        if (target.kind === "thread") await setThreadBranch(result.value.refName, worktreePath);
        else setStatus(`Created and switched to ${result.value.refName}`);
        return;
      }
      case "ref": {
        const { ref } = item;
        if (pickingWorktreeBase) {
          store.setNewThreadDraftWorkspace(target.threadId, {
            envMode: "worktree",
            baseBranch: ref.name,
          });
          setStatus(`New worktree from ${ref.name}`);
          return;
        }
        const selection = resolveBranchSelectionTarget({
          projectCwd,
          worktreePath,
          ref,
        });
        if (selection.reuseExistingWorktree) {
          if (target.kind === "draft") {
            setStatus(`${ref.name} is checked out in another worktree`);
            return;
          }
          await setThreadBranch(ref.name, selection.nextWorktreePath);
          return;
        }
        const switched = await connection.switchRef({
          cwd: selection.checkoutCwd,
          refName: ref.name,
        });
        if (!switched.ok) {
          setStatus(failed(switched, `Switching to ${ref.name}`) ?? "");
          return;
        }
        const next =
          ref.isRemote === true ? (switched.value.refName ?? localBranchName(ref)) : ref.name;
        if (target.kind === "thread") await setThreadBranch(next, selection.nextWorktreePath);
        else setStatus(`Switched to ${next}`);
        return;
      }
    }
  };

  const runMenuItem = async (item: GitMenuItem) => {
    if (target === null || cwd === null) return;
    if (item.disabledReason !== undefined) {
      setStatus(item.disabledReason);
      return;
    }
    const refName = currentRefName();
    if (item.confirm !== undefined && !isArmed(armed, item, cwd, refName)) {
      setArmed(armConfirmation(item, cwd, refName));
      return;
    }
    close();
    setLastFailure(null);
    const { command } = item;
    switch (command.kind) {
      case "action": {
        let remoteMessage: string | null = null;
        const result = await connection.runStackedAction(cwd, {
          actionId: NodeCrypto.randomUUID(),
          action: command.action,
          ...(target.kind === "thread" ? { threadId: target.threadId } : {}),
          projectId: target.projectId,
          onProgress: (event: GitActionProgressEvent) => {
            if (event.kind === "action_failed") remoteMessage = event.message;
          },
        });
        if (result.ok) setStatus(describeGitActionResult(result.value));
        else if (result.interrupted) setStatus(`${item.label} cancelled`);
        else {
          const message = describeGitActionFailure(result.error, remoteMessage);
          setLastFailure({ cwd, label: item.label, message });
          setStatus(`${item.label} failed: ${message}`);
        }
        return;
      }
      case "pull": {
        const result = await connection.pull({ cwd });
        if (!result.ok && !result.interrupted) {
          setLastFailure({ cwd, label: "Pull", message: errorText(result.error) });
        }
        setStatus(
          failed(result, "Pull") ??
            (result.ok && result.value.status === "pulled" ? "Pulled" : "Already up to date"),
        );
        return;
      }
      case "open-pr":
        try {
          await openExternalUrl(command.url);
          setStatus("Opened PR");
        } catch (error) {
          setStatus(errorText(error));
        }
        return;
      case "commit-model":
        options.onPickCommitModel();
        return;
      case "retry-setup":
        await retrySetup();
        return;
      case "publish":
        await publish("", null);
        return;
      case "refresh": {
        const result = await connection.refreshVcsStatus(cwd);
        setStatus(failed(result, "Refresh") ?? "Git status refreshed");
        return;
      }
    }
  };

  /**
   * Puts a command back in the composer with a notice: the typed command after an error, or
   * `/publish owner/` to finish. Text typed since stays; the notice says what to do.
   */
  const backToComposer = (text: string | null, notice: string) => {
    if (target === null) return;
    if (text !== null && store.getDraft(target.threadId).text.trim().length === 0) {
      store.restoreDraft(target.threadId, { text, attachments: [] }, notice);
    } else store.setNotice(target.threadId, notice);
    options.onFocusComposer();
  };

  /**
   * `/publish`: checks the command, the checkout and the server's providers, and that the
   * name is free, then asks to confirm. Nothing is created before the confirmation.
   * `typed` is the command as typed, put back in the composer if it can't run.
   */
  const publish = async (args: string, typed: string | null) => {
    if (target === null || cwd === null) {
      setStatus("Select a thread first");
      return;
    }
    const fail = (message: string) => {
      setStatus(message);
      backToComposer(typed, message);
    };
    const parsed = parsePublishArgs(args);
    if (!parsed.ok) {
      fail(parsed.error);
      return;
    }
    if (connection.registry.get(connection.vcsActionStateAtom(cwd)).isRunning) {
      fail("Wait for the current git action to finish");
      return;
    }
    const forThread = target.threadId;
    setStatus("Checking source control providers…");
    const [discovery, status, remoteRefs] = await Promise.all([
      connection.discoverSourceControl(),
      connection.refreshVcsStatus(cwd, true),
      connection.listRemoteRefs(cwd),
    ]);
    if (!isLive(forThread, cwd)) {
      setStatus("Publish stopped: the thread changed while checking");
      return;
    }
    if (!discovery.ok) {
      fail(`Couldn't check source control providers: ${errorText(discovery.error)}`);
      return;
    }
    if (!status.ok) {
      fail(`Couldn't read git status: ${errorText(status.error)}`);
      return;
    }
    if (!remoteRefs.ok) {
      fail(`Couldn't list this repository's remotes: ${errorText(remoteRefs.error)}`);
      return;
    }
    const resolved = resolvePublish({
      args: parsed.value,
      cwd,
      status: status.value,
      remoteRefs: remoteRefs.value.refs,
      discovery: discovery.value,
    });
    if (resolved.kind === "error") {
      fail(resolved.message);
      return;
    }
    if (resolved.kind === "prefill") {
      setStatus(resolved.hint);
      backToComposer(resolved.text, resolved.hint);
      return;
    }
    const { plan } = resolved;
    setStatus(`Checking ${plan.location}…`);
    // A repository that reads back is taken. A failed read doesn't block: the name may be free.
    const existing = await connection.lookupRepository({
      provider: plan.input.provider,
      repository: plan.input.repository,
      cwd,
    });
    if (!isLive(forThread, cwd)) {
      setStatus("Publish stopped: the thread changed while checking");
      return;
    }
    if (existing.ok) {
      fail(repositoryTakenMessage(plan));
      return;
    }
    setStatus(`Confirm publishing ${plan.location}`);
    setArmed(null);
    setOverlay({ kind: "publish", plan, threadId: forThread });
  };

  /**
   * The confirmed publish: creates the repository, adds the remote and pushes. Only the
   * confirmation that's open now, for the thread and checkout in view, is sent.
   */
  const confirmPublish = async (plan: PublishPlan) => {
    const pending = live.current.overlay;
    const current =
      pending?.kind === "publish" &&
      pending.plan === plan &&
      isLive(pending.threadId, plan.input.cwd);
    // Taken now, so a second ⏎ before the next render can't send it again.
    live.current = { ...live.current, overlay: null };
    if (!current) {
      close();
      setStatus("Publish stopped: the thread changed; nothing was created");
      return;
    }
    close();
    setLastFailure(null);
    options.onFocusComposer();
    const { cwd: planCwd, repository } = plan.input;
    setStatus(`Publishing ${repository} to ${plan.providerLabel}…`);
    const result = await connection.publishRepository(plan.input);
    if (result.ok) {
      setStatus(describePublishResult(result.value, plan.providerLabel));
    } else if (result.interrupted) {
      setStatus("Publish cancelled");
    } else {
      const message = describePublishFailure(result.error);
      setLastFailure({ cwd: planCwd, label: "Publish", message });
      setStatus(`Couldn't publish ${repository} to ${plan.providerLabel}: ${message}`);
    }
    // The toolbar picks up the new remote and upstream.
    void connection.refreshVcsStatus(planCwd, true);
  };

  /** The thread whose worktree setup shows: one with a worktree, or one the server is launching into one. */
  const setupThreadId =
    target?.kind === "thread" && (worktreePath !== null || launch !== null)
      ? target.threadId
      : null;

  const cancelWorktreeSetup = async () => {
    if (setupThreadId === null) {
      setStatus("No worktree setup here");
      return;
    }
    const live = Option.getOrNull(
      AsyncResult.value(connection.registry.get(connection.worktreeSetupAtom(setupThreadId))),
    );
    if (live?.phase !== "running") {
      setStatus("Worktree setup isn't running");
      return;
    }
    const result = await connection.cancelWorktreeSetup(setupThreadId);
    setStatus(
      failed(result, "Cancelling setup") ??
        (result.ok && result.value.cancelled
          ? "Worktree setup cancelled"
          : "Setup already finished"),
    );
  };

  const pressToolbar = (action: NonNullable<ToolbarSegment["action"]>) => {
    if (action === "env") toggleWorktree();
    else if (action === "branch") openBranchPicker();
    else openMenu();
  };

  return {
    cwd,
    projectCwd,
    envMode,
    worktreePath,
    threadBranch,
    pickingWorktreeBase,
    draft: target?.kind === "draft",
    overlay: shownOverlay,
    armed,
    failure,
    setupFailed,
    setupThreadId,
    openMenu,
    openBranchPicker,
    toggleWorktree,
    launchWorktree,
    closeOverlay: () => {
      if (shownOverlay?.kind === "publish") setStatus("Publish cancelled; nothing was created");
      close();
    },
    pressToolbar,
    pickBranch: (item: BranchPickerChoice) => void pickBranch(item),
    runMenuItem: (item: GitMenuItem) => void runMenuItem(item),
    /** `/publish <args>`; `typed` goes back in the composer if it can't run. */
    publish: (args: string, typed: string) => void publish(args, typed),
    /** The menu's and palette's way in: `/publish owner/` in the composer to finish. */
    startPublish: () => void publish("", null),
    confirmPublish: (plan: PublishPlan) => void confirmPublish(plan),
    cancelWorktreeSetup: () => void cancelWorktreeSetup(),
    retrySetup: () => void retrySetup(),
    /**
     * Why the composer of the thread in view shouldn't send or resume now, so its text stays
     * put. The sender checks every thread with pending jobs again before each command.
     */
    sendBlockedReason: (threadId: string): string | null =>
      target?.kind === "thread" && target.threadId === threadId ? sendBlock : null,
    /** Keys while an overlay is open; it takes them all. */
    handleKey: (key: KeyEvent): boolean => {
      if (shownOverlay === null) return false;
      overlayRef.current?.handleKey(key);
      return true;
    },
  };
}

export type GitControls = ReturnType<typeof useGitControls>;
