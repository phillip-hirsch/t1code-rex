import { Connection } from "@t3tools/client-runtime/connection";
import type { ResumeThreadQueueInput } from "@t3tools/client-runtime/operations";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  ShellSnapshotLoader,
  createEnvironmentShellAtoms,
} from "@t3tools/client-runtime/state/shell";
import {
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
  type InterruptThreadTurnInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type StartThreadTurnInput,
} from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ComposerCommandResult } from "../composerSender.ts";
import type { TuiServerSession } from "../serverLauncher.ts";
import * as Platform from "./platform.ts";
import * as Runtime from "./runtime.ts";

export interface TuiConnectionOptions {
  readonly session: TuiServerSession;
  readonly appVersion: string;
  readonly platformOs: string;
}

const NO_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = [];

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
  // One page request per thread at a time; repeats while it runs share its result.
  const loadEarlierHistory = createRuntimeCommand(runtime, {
    label: "tr3x:thread:load-earlier",
    concurrency: { mode: "singleFlight", key: (threadId: ThreadId) => threadId },
    execute: (threadId: ThreadId) =>
      ThreadHistoryController.ThreadHistoryController.pipe(
        Effect.flatMap((controller) => controller.loadEarlier(environmentId, threadId)),
      ),
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
        visibleTurnItemsAtom: threadDetails.visibleTurnItemsAtom(ref),
        statusAtom: threadDetails.statusAtom(ref),
        errorAtom: threadDetails.errorAtom(ref),
        historyAtom: threadDetails.historyAtom(ref),
        pendingRequestsAtom: threadDetails.pendingRequestsAtom(ref),
        queueAtom: threadDetails.queueWorkflowAtom(ref),
      };
    },
    loadEarlierHistory,
    startTurn: (input: StartThreadTurnInput) => runThreadCommand(threadCommands.startTurn, input),
    interruptTurn: (input: InterruptThreadTurnInput) =>
      runThreadCommand(threadCommands.interruptTurn, input),
    resumeQueue: (input: ResumeThreadQueueInput) =>
      runThreadCommand(threadCommands.resumeThreadQueue, input),
    setRuntimeMode: (input: SetThreadRuntimeModeInput) =>
      runThreadCommand(threadCommands.setRuntimeMode, input),
    setInteractionMode: (input: SetThreadInteractionModeInput) =>
      runThreadCommand(threadCommands.setInteractionMode, input),
    retryNow: catalog.retryNow,
    dispose: () => {
      registry.dispose();
      options.session.stop();
    },
  };
}

export type TuiConnection = ReturnType<typeof createTuiConnection>;
