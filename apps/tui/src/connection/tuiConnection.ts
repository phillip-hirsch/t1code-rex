import { Connection, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { ResumeThreadQueueInput } from "@t3tools/client-runtime/operations";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createFilesystemEnvironmentAtoms } from "@t3tools/client-runtime/state/filesystem";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import {
  createEnvironmentProjectAtoms,
  createProjectEnvironmentAtoms,
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";
import {
  createEnvironmentServerConfigsAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  type RunVcsStackedActionInput,
  type VcsActionState,
} from "@t3tools/client-runtime/state/vcs";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  ShellSnapshotLoader,
  createEnvironmentShellAtoms,
} from "@t3tools/client-runtime/state/shell";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createRuntimeCommand,
  runAtomCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  type ArchiveThreadInput,
  type DeleteThreadInput,
  type DismissThreadUserInputInput,
  fetchEnvironmentThreadSnapshot,
  type InterruptThreadTurnInput,
  type PinThreadInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RetryWorkspacePreparationInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type SettleThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type ThreadSnapshotLoadResult,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UpdateThreadMetadataInput,
} from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  FilesystemBrowseInput,
  LaunchEditorInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  ProjectCloneStartInput,
  ProjectSearchEntriesInput,
  ServerSettingsPatch,
  SourceControlCloneRepositoryInput,
  ThreadId,
  VcsCreateRefInput,
  VcsInitInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsStatusResult,
  VcsSwitchRefInput,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ComposerCommandResult, WorkspaceGuard } from "../composerSender.ts";
import { deriveDiffTurns, NO_DIFF_TURNS, type DiffRange, type DiffTurns } from "../diffTurns.ts";
import { createRequestQueueSelector, type PendingRequest } from "../requestQueue.ts";
import { branchRefsInput, mergeRefPages, type BranchRefPages } from "../branchPicker.ts";
import {
  deriveWorktreeLaunch,
  sameWorktreeLaunch,
  worktreeBlockOf,
  type WorktreeLaunch,
} from "../worktreeLaunch.ts";
import type { TuiServerSession } from "../serverLauncher.ts";
import * as Platform from "./platform.ts";
import * as Runtime from "./runtime.ts";

export interface TuiConnectionOptions {
  readonly session: TuiServerSession;
  readonly appVersion: string;
  readonly platformOs: string;
}

const NO_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = [];

/** Turn and full-thread diffs share one result shape. */
export type CheckpointDiffAtom = Atom.Atom<
  AsyncResult.AsyncResult<OrchestrationGetTurnDiffResult, unknown>
>;

/** A checkout's live status; null when the server has none for it yet. */
export type VcsStatusAtom = Atom.Atom<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>;
/** The branch picker's refs for a query: its first pages, merged. */
export type VcsRefsAtom = Atom.Atom<BranchRefPages>;
export type WorktreeSetupAtom = Atom.Atom<
  AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, unknown>
>;

/** A management action's outcome: its value, or the failure to show. */
export type TuiActionResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown; readonly interrupted: boolean };

function toActionResult<A, E>(result: AtomCommandResult<A, E>): TuiActionResult<A> {
  if (AsyncResult.isSuccess(result)) return { ok: true, value: result.value };
  return {
    ok: false,
    error: Cause.squash(result.cause),
    interrupted: Cause.hasInterruptsOnly(result.cause),
  };
}

function toCommandResult<A, E>(result: AtomCommandResult<A, E>): ComposerCommandResult {
  if (AsyncResult.isSuccess(result)) return { ok: true };
  return {
    ok: false,
    error: Cause.squash(result.cause),
    interrupted: Cause.hasInterruptsOnly(result.cause),
  };
}

/**
 * One atom runtime per process, wired to the single server this TUI reached.
 * Later port steps add thread, terminal and VCS atoms on the same runtime.
 */
export function createTuiConnection(options: TuiConnectionOptions) {
  const layerPlatform = Platform.layer(options);
  const layerConnection = Layer.mergeAll(
    ShellSnapshotLoader.layer,
    BoundedThreadSnapshotLoader.layer,
    ThreadHistoryController.layer,
  ).pipe(
    Layer.provideMerge(Connection.layerWithOptions({})),
    Layer.provideMerge(Layer.mergeAll(Runtime.layer, layerPlatform)),
  );
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(layerConnection);
  const environmentId: EnvironmentId = options.session.environment.environmentId;
  const catalog = createEnvironmentCatalogAtoms(runtime);
  const sessionAtoms = createEnvironmentSessionAtoms(runtime);
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: sessionAtoms.initialConfigValueAtom,
  });
  const shell = createEnvironmentShellAtoms(runtime);
  const snapshotAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(get(shell.stateValueAtom(id)).snapshot)),
  );
  const threadShells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog.catalogValueAtom,
    snapshotAtom,
  });
  const threadStates = createEnvironmentThreadStateAtoms(runtime);
  const threadDetails = createEnvironmentThreadDetailAtoms(threadStates.stateAtom);
  // Pending approvals and questions, oldest first, with what each is about.
  const requestQueueAtom = Atom.family((threadId: ThreadId) => {
    const select = createRequestQueueSelector();
    return Atom.make((get): ReadonlyArray<PendingRequest> =>
      select(Option.getOrNull(get(threadDetails.stateAtom({ environmentId, threadId })).data)),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`tr3x:thread-requests:${threadId}`));
  });
  // The turns the diff panel can show; a new list only when checkpoints or runs change.
  const diffTurnsAtom = Atom.family((threadId: ThreadId) => {
    let previous: { checkpoints: unknown; runs: unknown } | null = null;
    let value: DiffTurns = NO_DIFF_TURNS;
    return Atom.make((get) => {
      const projection = Option.getOrNull(
        get(threadDetails.stateAtom({ environmentId, threadId })).data,
      );
      if (projection === null) {
        previous = null;
        value = NO_DIFF_TURNS;
      } else if (
        projection.checkpoints !== previous?.checkpoints ||
        projection.runs !== previous?.runs
      ) {
        previous = { checkpoints: projection.checkpoints, runs: projection.runs };
        value = deriveDiffTurns(projection);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`tr3x:diff-turns:${threadId}`));
  });
  // The thread's worktree launch; a new value only when its run, status or base changes.
  const worktreeLaunchAtom = Atom.family((threadId: ThreadId) => {
    let value: WorktreeLaunch | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(
        get(threadDetails.stateAtom({ environmentId, threadId })).data,
      );
      const next = projection === null ? null : deriveWorktreeLaunch(projection);
      if (!sameWorktreeLaunch(value, next)) value = next;
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`tr3x:worktree-launch:${threadId}`));
  });
  // One page request per thread at a time; repeats while it runs share its result.
  const loadEarlierHistory = createRuntimeCommand(runtime, {
    label: "tr3x:thread:load-earlier",
    concurrency: { mode: "singleFlight", key: (threadId: ThreadId) => threadId },
    execute: (threadId: ThreadId) =>
      ThreadHistoryController.ThreadHistoryController.pipe(
        Effect.flatMap((controller) => controller.loadEarlier(environmentId, threadId)),
      ),
  });
  // The thread's whole history over HTTP, not the bounded window the socket and
  // `orchestration.getThreadProjection` send: only this proves a message is missing.
  const fullThreadSnapshot = createEnvironmentCommand(runtime, {
    label: "tr3x:thread:full-snapshot",
    execute: Effect.fn("tr3x.fullThreadSnapshot")(function* (threadId: ThreadId) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return { _tag: "unavailable" } satisfies ThreadSnapshotLoadResult;
      }
      return yield* fetchEnvironmentThreadSnapshot({
        prepared: prepared.value,
        threadId,
        signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      }).pipe(
        Effect.map((snapshot): ThreadSnapshotLoadResult => ({ _tag: "present", snapshot })),
        Effect.catchTags({
          EnvironmentResourceNotFoundError: () =>
            Effect.succeed<ThreadSnapshotLoadResult>({ _tag: "missing" }),
        }),
      );
    }),
  });
  // Upstream's thread commands, serialized per thread like web and mobile.
  const threadCommands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const runThreadCommand = <Input, A, E>(
    command: AtomCommand<{ environmentId: EnvironmentId; input: Input }, A, E>,
    input: Input,
  ) =>
    runAtomCommand(registry, command, { environmentId, input }, { reportFailure: false }).then(
      toCommandResult,
    );
  const runAction = <Input, A, E>(
    command: AtomCommand<{ environmentId: EnvironmentId; input: Input }, A, E>,
    input: Input,
  ) =>
    runAtomCommand(registry, command, { environmentId, input }, { reportFailure: false }).then(
      toActionResult,
    );
  // Projects, clones, file search, editors, and archived threads: the same atoms web and
  // mobile build, on this runtime.
  const environmentProjects = createEnvironmentProjectAtoms({
    catalogValueAtom: catalog.catalogValueAtom,
    snapshotAtom,
    serverConfigValueAtom: server.configValueAtom,
  });
  const projectCommands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: environmentProjects.projectAtom,
  });
  const sourceControl = createSourceControlEnvironmentAtoms(runtime);
  const filesystem = createFilesystemEnvironmentAtoms(runtime);
  const shellCommands = createShellEnvironmentAtoms(runtime);
  const orchestration = createOrchestrationEnvironmentAtoms(runtime);
  const archivedShellSnapshotAtom = orchestration.archivedShellSnapshot({
    environmentId,
    input: {},
  });
  const archivedShellSnapshot = createEnvironmentRpcCommand(runtime, {
    label: "tr3x:orchestration:archived-shell-snapshot",
    tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  });
  // Branch status, refs and worktree setup, plus git actions with their streamed progress.
  const vcs = createVcsEnvironmentAtoms(runtime);
  const vcsActions = createVcsActionManager(runtime);
  const vcsTarget = (cwd: string) => ({ environmentId, cwd });
  // Each page is its own `listRefs` query; a page is asked for once the one before it says
  // there's more.
  const refPagesAtom = Atom.family((key: string) => {
    const [cwd, query, pages] = JSON.parse(key) as [string, string, number];
    return Atom.make((get): BranchRefPages => {
      const results: Array<AsyncResult.AsyncResult<VcsListRefsResult, unknown>> = [];
      let cursor: number | undefined;
      for (let page = 0; page < pages; page += 1) {
        const result = get(
          vcs.listRefs({ environmentId, input: branchRefsInput(cwd, query, cursor) }),
        );
        results.push(result);
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null || value.nextCursor === null) break;
        cursor = value.nextCursor;
      }
      return mergeRefPages(results);
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`tr3x:vcs-ref-pages:${key}`));
  });
  /** Runs a VCS command while the checkout's action state shows it as busy. */
  const trackVcs = <Input, A, E>(
    cwd: string,
    operation: "pull" | "switch_ref" | "create_ref" | "init",
    label: string,
    command: AtomCommand<{ environmentId: EnvironmentId; input: Input }, A, E>,
    input: Input,
  ) =>
    vcsActions
      .track(registry, vcsTarget(cwd), { operation, label }, () =>
        runAtomCommand(registry, command, { environmentId, input }, { reportFailure: false }),
      )
      .then(toActionResult);
  const serverConfigsAtom = createEnvironmentServerConfigsAtom({
    catalogValueAtom: catalog.catalogValueAtom,
    serverConfigValueAtom: server.configValueAtom,
  });

  return {
    session: options.session,
    environmentId,
    registry,
    runtime,
    connectionStateAtom: catalog.stateAtom(environmentId),
    serverConfigAtom: server.configValueAtom(environmentId),
    serverConfigsAtom,
    shellStateAtom: shell.stateValueAtom(environmentId),
    shellStatusAtom: shell.statusAtom(environmentId),
    hasShellSnapshotAtom: shell.hasSnapshotAtom(environmentId),
    // Thread events keep the projects array, so the sidebar's project list only changes
    // with project events.
    projectsAtom: Atom.make(
      (get): ReadonlyArray<OrchestrationProjectShell> =>
        get(snapshotAtom(environmentId))?.projects ?? NO_PROJECTS,
    ),
    // Shells that leave out older settled threads count them per project.
    olderSettledAtom: Atom.make(
      (get): OrchestrationV2ShellSnapshot["olderSettled"] =>
        get(snapshotAtom(environmentId))?.olderSettled,
    ),
    // Rows keep their identity while only a running thread's streaming fields tick.
    threadShellsAtom: threadShells.quietThreadShellsAtom,
    threadShellAtom: (threadId: ThreadId) =>
      threadShells.quietThreadShellAtom({ environmentId, threadId }),
    /** Detail for one thread, fed by orchestration.subscribeThread while something reads it. */
    thread: (threadId: ThreadId) => {
      const ref = { environmentId, threadId };
      return {
        stateAtom: threadDetails.stateAtom(ref),
        visibleTurnItemsAtom: threadDetails.visibleTurnItemsAtom(ref),
        statusAtom: threadDetails.statusAtom(ref),
        errorAtom: threadDetails.errorAtom(ref),
        historyAtom: threadDetails.historyAtom(ref),
        requestQueueAtom: requestQueueAtom(threadId),
        queueAtom: threadDetails.queueWorkflowAtom(ref),
      };
    },
    /** The turns a thread's diff panel can show, live from its subscription. */
    diffTurnsAtom: (threadId: ThreadId) => diffTurnsAtom(threadId),
    /** A checkpoint range's unified diff; from turn 0 it is the full thread diff, as on web. */
    checkpointDiffAtom: (
      threadId: ThreadId,
      range: DiffRange,
      ignoreWhitespace: boolean,
    ): CheckpointDiffAtom =>
      range.fromTurnCount === 0
        ? orchestration.fullThreadDiff({
            environmentId,
            input: { threadId, toTurnCount: range.toTurnCount, ignoreWhitespace },
          })
        : orchestration.turnDiff({
            environmentId,
            input: { threadId, ...range, ignoreWhitespace },
          }),
    loadEarlierHistory,
    /** A failed request reads as "unavailable": nothing is decided from it. */
    fetchFullThreadSnapshot: (threadId: ThreadId): Promise<ThreadSnapshotLoadResult> =>
      runAtomCommand(
        registry,
        fullThreadSnapshot,
        { environmentId, input: threadId },
        { reportFailure: false },
      ).then((result) =>
        AsyncResult.isSuccess(result) ? result.value : { _tag: "unavailable" as const },
      ),
    startTurn: (input: StartThreadTurnInput) => runThreadCommand(threadCommands.startTurn, input),
    interruptTurn: (input: InterruptThreadTurnInput) =>
      runThreadCommand(threadCommands.interruptTurn, input),
    resumeQueue: (input: ResumeThreadQueueInput) =>
      runThreadCommand(threadCommands.resumeThreadQueue, input),
    setRuntimeMode: (input: SetThreadRuntimeModeInput) =>
      runThreadCommand(threadCommands.setRuntimeMode, input),
    setInteractionMode: (input: SetThreadInteractionModeInput) =>
      runThreadCommand(threadCommands.setInteractionMode, input),
    respondToApproval: (input: RespondToThreadApprovalInput) =>
      runThreadCommand(threadCommands.respondToApproval, input),
    respondToUserInput: (input: RespondToThreadUserInputInput) =>
      runThreadCommand(threadCommands.respondToUserInput, input),
    dismissUserInput: (input: DismissThreadUserInputInput) =>
      runThreadCommand(threadCommands.dismissUserInput, input),
    archiveThread: (input: ArchiveThreadInput) => runAction(threadCommands.archive, input),
    unarchiveThread: (input: UnarchiveThreadInput) => runAction(threadCommands.unarchive, input),
    deleteThread: (input: DeleteThreadInput) => runAction(threadCommands.delete, input),
    updateThreadMetadata: (input: UpdateThreadMetadataInput) =>
      runAction(threadCommands.updateMetadata, input),
    pinThread: (input: PinThreadInput) => runAction(threadCommands.pin, input),
    unpinThread: (input: UnpinThreadInput) => runAction(threadCommands.unpin, input),
    settleThread: (input: SettleThreadInput) => runAction(threadCommands.settle, input),
    unsettleThread: (input: UnsettleThreadInput) => runAction(threadCommands.unsettle, input),
    createProject: (input: CreateProjectInput) => runAction(projectCommands.create, input),
    updateProject: (input: UpdateProjectInput) => runAction(projectCommands.update, input),
    deleteProject: (input: DeleteProjectInput) => runAction(projectCommands.delete, input),
    /** Clone-backed project creation; the clone itself runs on in the background. */
    startProjectClone: (input: ProjectCloneStartInput) =>
      runAction(sourceControl.startProjectClone, input),
    /** Older servers' blocking clone, for those without clone tracking. */
    cloneRepository: (input: SourceControlCloneRepositoryInput) =>
      runAction(sourceControl.cloneRepository, input),
    projectClonesAtom: sourceControl.projectClones({ environmentId, input: {} }),
    openInEditor: (input: LaunchEditorInput) => runAction(shellCommands.openInEditor, input),
    searchEntriesAtom: (input: ProjectSearchEntriesInput) =>
      projectCommands.searchEntries({ environmentId, input }),
    browseAtom: (input: FilesystemBrowseInput) => filesystem.browse({ environmentId, input }),
    archivedShellSnapshotAtom,
    refreshArchivedThreads: () => registry.refresh(archivedShellSnapshotAtom),
    /** The archived threads as the server has them now, never from cache. */
    fetchArchivedShellSnapshot: () => runAction(archivedShellSnapshot, {}),
    /** Live status of a checkout, from `subscribeVcsStatus` while something reads it. */
    vcsStatusAtom: (cwd: string): VcsStatusAtom => vcs.status({ environmentId, input: { cwd } }),
    /** The refs matching a query, as the server filters them: its first `pages` pages. */
    vcsRefsAtom: (cwd: string, query: string, pages: number): VcsRefsAtom =>
      refPagesAtom(JSON.stringify([cwd, query, pages])),
    /** What a checkout's git action is doing now: its phase, hook and last output line. */
    vcsActionStateAtom: (cwd: string): Atom.Atom<VcsActionState> =>
      vcsActions.stateAtom(vcsTarget(cwd)),
    worktreeSetupAtom: (threadId: ThreadId): WorktreeSetupAtom =>
      vcs.worktreeSetup({ environmentId, input: { threadId } }),
    cancelWorktreeSetup: (threadId: ThreadId) => runAction(vcs.cancelWorktreeSetup, { threadId }),
    /** Whether the thread is launching into a worktree, or that launch failed; from its runs. */
    worktreeLaunchAtom: (threadId: ThreadId): Atom.Atom<WorktreeLaunch | null> =>
      worktreeLaunchAtom(threadId),
    /**
     * Keeps the thread's runs loaded until disposed, selected or not, and says why nothing
     * may start on it now: its worktree isn't there. Undefined until its runs are live.
     */
    guardWorkspace: (threadId: ThreadId): WorkspaceGuard => {
      const state = threadDetails.stateAtom({ environmentId, threadId });
      const dispose = registry.mount(state);
      return {
        blockedReason: () => {
          const current = registry.get(state);
          // The server turns the send down itself.
          if (current.status === "deleted") return null;
          if (current.status !== "live") return undefined;
          return Option.match(current.data, { onNone: () => undefined, onSome: worktreeBlockOf });
        },
        dispose,
      };
    },
    /** Runs a failed worktree preparation again, for the message that started it. */
    retryWorkspacePreparation: (input: RetryWorkspacePreparationInput) =>
      runAction(threadCommands.retryWorkspacePreparation, input),
    /** Re-reads a checkout's status; `localOnly` skips the remote fetch. */
    refreshVcsStatus: (cwd: string, localOnly = false) =>
      runAction(vcs.refreshStatus, { cwd, ...(localOnly ? { localOnly } : {}) }),
    switchRef: (input: VcsSwitchRefInput) =>
      trackVcs(input.cwd, "switch_ref", "Switching branch", vcs.switchRef, input),
    createRef: (input: VcsCreateRefInput) =>
      trackVcs(input.cwd, "create_ref", "Creating branch", vcs.createRef, input),
    initRepository: (input: VcsInitInput) =>
      trackVcs(input.cwd, "init", "Initializing repository", vcs.init, input),
    pull: (input: VcsPullInput) => trackVcs(input.cwd, "pull", "Pulling", vcs.pull, input),
    /** Commit, push or open a PR; progress lands in `vcsActionStateAtom(cwd)` as it streams. */
    runStackedAction: (cwd: string, input: RunVcsStackedActionInput) =>
      runAtomCommand(registry, vcsActions.runStackedAction(vcsTarget(cwd)), input, {
        reportFailure: false,
      }).then(toActionResult),
    stopThreadSession: (input: StopThreadSessionInput) =>
      runAction(threadCommands.stopSession, input),
    updateServerSettings: (patch: ServerSettingsPatch) =>
      runAction(server.updateSettings, { patch }),
    retryNow: catalog.retryNow,
    dispose: () => {
      registry.dispose();
      options.session.stop();
    },
  };
}

export type TuiConnection = ReturnType<typeof createTuiConnection>;
