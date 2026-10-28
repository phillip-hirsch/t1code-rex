import { Connection } from "@t3tools/client-runtime/connection";
import {
  cancelQueuedRun,
  createProject,
  type CancelQueuedRunInput,
  type CreateProjectInput,
} from "@t3tools/client-runtime/operations";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentCommand,
  runAtomCommand,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  createEnvironmentShellAtoms,
  ShellSnapshotLoader,
} from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  ThreadHistoryController,
  type DismissThreadUserInputInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type SetThreadRuntimeModeInput,
  type StartThreadTurnInput,
  type UpdateThreadMetadataInput,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as Platform from "./platform.ts";

/** A command's outcome: ok, or the error to show. */
export type CommandResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

const noShell = Atom.make<OrchestrationV2ShellSnapshot | null>(null);

/**
 * One atom runtime per view, wired to the daemon's server. It holds only what
 * one thread needs: its subscription, the server config, and thread commands.
 */
export function createViewConnection(server: Platform.ViewServer) {
  const layer = Layer.mergeAll(
    ShellSnapshotLoader.layer,
    BoundedThreadSnapshotLoader.layer,
    ThreadHistoryController.layer,
  ).pipe(
    Layer.provideMerge(Connection.layerWithOptions({})),
    Layer.provideMerge(Platform.layer(server)),
  );
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(layer);
  const environmentId: EnvironmentId = server.environmentId;
  const catalog = createEnvironmentCatalogAtoms(runtime);
  const session = createEnvironmentSessionAtoms(runtime);
  const serverAtoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: session.initialConfigValueAtom,
  });
  const shell = createEnvironmentShellAtoms(runtime);
  const threadStates = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(threadStates.stateAtom);
  const threadCommands = createThreadEnvironmentAtoms(runtime, () => noShell);
  const createProjectCommand = createEnvironmentCommand(runtime, {
    label: "tr3x:project:create",
    execute: (input: CreateProjectInput) => createProject(input),
  });
  const cancelQueuedCommand = createEnvironmentCommand(runtime, {
    label: "tr3x:thread:cancel-queued",
    execute: (input: CancelQueuedRunInput) => cancelQueuedRun(input),
  });

  const run = <Input, A, E>(
    command: AtomCommand<{ environmentId: EnvironmentId; input: Input }, A, E>,
    input: Input,
  ): Promise<CommandResult> =>
    runAtomCommand(registry, command, { environmentId, input }, { reportFailure: false }).then(
      (result) =>
        AsyncResult.isSuccess(result)
          ? { ok: true }
          : { ok: false, error: errorText(Cause.squash(result.cause)) },
    );

  return {
    environmentId,
    registry,
    connectionStateAtom: catalog.stateAtom(environmentId),
    providersAtom: serverAtoms.providersValueAtom(environmentId),
    thread: threadAtoms(details, environmentId),
    /**
     * The server's shell once it arrives; mounted only for as long as this waits.
     * Rejects when `signal` aborts or the connection is refused for good.
     */
    shellSnapshot: (signal: AbortSignal) =>
      new Promise<OrchestrationV2ShellSnapshot>((resolve, reject) => {
        const shellAtom = shell.stateValueAtom(environmentId);
        const connectionAtom = catalog.stateAtom(environmentId);
        const cleanup: Array<() => void> = [];
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          for (const step of cleanup) step();
          finish();
        };
        const check = () => {
          const snapshot = Option.getOrNull(registry.get(shellAtom).snapshot);
          if (snapshot !== null) return settle(() => resolve(snapshot));
          const state = Option.getOrNull(AsyncResult.value(registry.get(connectionAtom)));
          if (state?.phase === "blocked") {
            const detail = state.lastFailure?.detail ?? "The server refused the connection.";
            settle(() => reject(new Error(detail)));
          }
        };
        const onAbort = () => settle(() => reject(new Error("Stopped while connecting.")));
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup.push(
          () => signal.removeEventListener("abort", onAbort),
          registry.mount(shellAtom),
          registry.subscribe(shellAtom, check),
          registry.subscribe(connectionAtom, check),
        );
        if (signal.aborted) onAbort();
        else check();
      }),
    startTurn: (input: StartThreadTurnInput) => run(threadCommands.startTurn, input),
    interruptTurn: (input: InterruptThreadTurnInput) => run(threadCommands.interruptTurn, input),
    respondToApproval: (input: RespondToThreadApprovalInput) =>
      run(threadCommands.respondToApproval, input),
    respondToUserInput: (input: RespondToThreadUserInputInput) =>
      run(threadCommands.respondToUserInput, input),
    dismissUserInput: (input: DismissThreadUserInputInput) =>
      run(threadCommands.dismissUserInput, input),
    updateThread: (input: UpdateThreadMetadataInput) => run(threadCommands.updateMetadata, input),
    setRuntimeMode: (input: SetThreadRuntimeModeInput) => run(threadCommands.setRuntimeMode, input),
    cancelQueuedRun: (input: CancelQueuedRunInput) => run(cancelQueuedCommand, input),
    createProject: (input: CreateProjectInput) => run(createProjectCommand, input),
    loadEarlier: (threadId: ThreadId) => run(threadCommands.loadEarlierHistory, { threadId }),
    dispose: () => registry.dispose(),
  };
}

export type ViewConnection = ReturnType<typeof createViewConnection>;

/** What the view reads and runs; the rest of `ViewConnection` serves startup. */
export type ViewApi = Omit<
  ViewConnection,
  "environmentId" | "shellSnapshot" | "createProject" | "dispose"
>;

/**
 * The atoms one thread's view reads, all derived by client-runtime from the
 * thread's state. Tests feed `details` their own state and get the same derivations.
 */
export function threadAtoms(
  details: ReturnType<typeof createEnvironmentThreadDetailAtoms>,
  environmentId: EnvironmentId,
) {
  return (threadId: ThreadId) => {
    const ref = { environmentId, threadId };
    return {
      stateAtom: details.stateAtom(ref),
      structureAtom: details.quietThreadAtom(ref),
      visibleTurnItemsAtom: details.visibleTurnItemsAtom(ref),
      pendingRequestsAtom: details.pendingRequestsAtom(ref),
      queueAtom: details.queueWorkflowAtom(ref),
    };
  };
}
