import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentThreadDetailAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type MessageId as MessageIdType,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  threadAtoms,
  type CommandResult,
  type ViewApi,
  type ViewConnection,
} from "../view/connection.ts";
import type { CreateProjectInput } from "@t3tools/client-runtime/operations";

/**
 * A view without a server: thread state the test sets, derived into structure,
 * requests and queue by client-runtime's own atoms, and commands the test can
 * hold, fail or pass.
 */

const NOW = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
export const FIXTURE_THREAD_ID = ThreadId.make("thread-fixture");
const ENVIRONMENT_ID = EnvironmentId.make("env-fixture");

export function projection(input: {
  readonly selection: ModelSelection;
  readonly items?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly requests?: OrchestrationV2ThreadProjection["runtimeRequests"];
  readonly runs?: OrchestrationV2ThreadProjection["runs"];
  /** User messages the server has, by id, as the echo of a send. */
  readonly messages?: ReadonlyArray<{ readonly id: MessageIdType; readonly text: string }>;
}): OrchestrationV2ThreadProjection {
  const { selection: modelSelection, items = [], requests: runtimeRequests = [] } = input;
  return {
    thread: {
      id: FIXTURE_THREAD_ID,
      projectId: ProjectId.make("project-fixture"),
      title: "Fixture thread",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: FIXTURE_THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: input.runs ?? [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests,
    messages: (input.messages ?? []).map((message) => ({
      id: message.id,
      threadId: FIXTURE_THREAD_ID,
      runId: null,
      nodeId: null,
      role: "user" as const,
      text: message.text,
      attachments: [],
      streaming: false,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    plans: [],
    turnItems: items,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: FIXTURE_THREAD_ID,
      sourceItemId: item.id,
      item,
    })),
    updatedAt: NOW,
  };
}

const itemBase = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId: FIXTURE_THREAD_ID,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  title: null,
  startedAt: NOW,
  completedAt: null,
  updatedAt: NOW,
});

export function userMessage(id: string, ordinal: number, text: string): OrchestrationV2TurnItem {
  return {
    ...itemBase(id, ordinal),
    type: "user_message",
    status: "completed",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${id}`),
    inputIntent: "turn_start",
    text,
    attachments: [],
  };
}

export function run(
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  selection: ModelSelection,
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId: FIXTURE_THREAD_ID,
    ordinal,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: status === "running" ? null : NOW,
    checkpointId: null,
    contextHandoffId: null,
  };
}

/** A finished reasoning item: one "Thinking - <text>" work row. */
export function reasoning(id: string, ordinal: number, text: string): OrchestrationV2TurnItem {
  return {
    ...itemBase(id, ordinal),
    type: "reasoning",
    status: "completed",
    text,
    streaming: false,
  };
}

/** A pending question: its runtime request and the turn item that carries its questions. */
export function pendingQuestion(
  id: string,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
) {
  const requestId = RuntimeRequestId.make(id);
  const item: OrchestrationV2TurnItem = {
    ...itemBase(`item-${id}`, 0),
    type: "user_input_request",
    status: "running",
    requestId,
    questions,
  };
  const request: OrchestrationV2ThreadProjection["runtimeRequests"][number] = {
    id: requestId,
    nodeId: NodeId.make("node-fixture"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: NOW,
    resolvedAt: null,
  };
  return { item, request };
}

/** A pending approval: its runtime request and the turn item that describes it. */
export function pendingApproval(id: string, prompt: string) {
  const requestId = RuntimeRequestId.make(id);
  const item: OrchestrationV2TurnItem = {
    ...itemBase(`item-${id}`, 0),
    type: "approval_request",
    status: "running",
    requestId,
    requestKind: "command",
    prompt,
  };
  const request: OrchestrationV2ThreadProjection["runtimeRequests"][number] = {
    id: requestId,
    nodeId: NodeId.make("node-fixture"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make("session-fixture"),
    },
    createdAt: NOW,
    resolvedAt: null,
  };
  return { item, request };
}

/** A command the test controls: each call settles with `next`, or waits for `release`. */
export class CommandStub<Input> {
  readonly calls: Input[] = [];
  /** What the next calls return; `"hold"` waits for `release`. */
  next: CommandResult | "hold" = { ok: true };
  private readonly held: Array<(result: CommandResult) => void> = [];

  readonly run = (input: Input): Promise<CommandResult> => {
    this.calls.push(input);
    const next = this.next;
    if (next !== "hold") return Promise.resolve(next);
    return new Promise((resolve) => this.held.push(resolve));
  };

  /** Settles the oldest held call. */
  release(result: CommandResult = { ok: true }): void {
    const resolve = this.held.shift();
    if (!resolve) throw new Error("No held call to release.");
    resolve(result);
  }
}

type Commands = {
  [
    K in keyof ViewApi as ViewApi[K] extends (input: never) => Promise<CommandResult> ? K : never
  ]: ViewApi[K] extends (input: infer Input) => Promise<CommandResult> ? CommandStub<Input> : never;
};

const CONNECTED: SupervisorConnectionState = {
  desired: true,
  network: "online",
  phase: "connected",
  stage: null,
  attempt: 0,
  generation: 1,
  lastFailure: null,
  retryAt: null,
};

export function createFakeView(providers: ReadonlyArray<ServerProvider>) {
  const registry = AtomRegistry.make();
  const live: EnvironmentThreadState = { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" };
  // Kept alive: the test sets it before the view mounts anything that reads it.
  const state = Atom.make(AsyncResult.success(live)).pipe(Atom.keepAlive);
  const details = createEnvironmentThreadDetailAtoms(() => state);
  const commands: Commands = {
    startTurn: new CommandStub(),
    interruptTurn: new CommandStub(),
    respondToApproval: new CommandStub(),
    respondToUserInput: new CommandStub(),
    dismissUserInput: new CommandStub(),
    updateThread: new CommandStub(),
    setRuntimeMode: new CommandStub(),
    cancelQueuedRun: new CommandStub(),
    loadEarlier: new CommandStub(),
  };
  const api: ViewApi = {
    registry,
    connectionStateAtom: Atom.make(AsyncResult.success(CONNECTED)),
    providersAtom: Atom.make<ReadonlyArray<ServerProvider> | null>(providers),
    thread: threadAtoms(details, ENVIRONMENT_ID),
    startTurn: commands.startTurn.run,
    interruptTurn: commands.interruptTurn.run,
    respondToApproval: commands.respondToApproval.run,
    respondToUserInput: commands.respondToUserInput.run,
    dismissUserInput: commands.dismissUserInput.run,
    updateThread: commands.updateThread.run,
    setRuntimeMode: commands.setRuntimeMode.run,
    cancelQueuedRun: commands.cancelQueuedRun.run,
    loadEarlier: commands.loadEarlier.run,
  };
  const createProject = new CommandStub<CreateProjectInput>();
  let projects: Array<OrchestrationProjectShell> = [];
  let disposed = false;
  /** The whole connection `mountView` opens: no projects yet, and `createProject` to hold. */
  const connection: ViewConnection = {
    ...api,
    environmentId: ENVIRONMENT_ID,
    shellSnapshot: () =>
      Promise.resolve({
        schemaVersion: 1,
        snapshotSequence: 0,
        projects,
        threads: [],
        archivedThreads: [],
      }),
    createProject: createProject.run,
    dispose: () => {
      disposed = true;
      registry.dispose();
    },
  };
  return {
    api,
    commands,
    connection,
    createProject,
    isDisposed: () => disposed,
    /** Replaces the thread as if the server streamed it; `history` as its paging reports. */
    setProjection: (
      next: OrchestrationV2ThreadProjection,
      history: Partial<EnvironmentThreadState["history"]> = {},
    ) =>
      registry.set(
        state,
        AsyncResult.success({
          ...live,
          data: Option.some(next),
          history: { ...live.history, ...history },
        }),
      ),
    /** Adds a project the server knows, rooted at `workspaceRoot` exactly as stored. */
    addProject: (id: string, workspaceRoot: string) => {
      projects = [
        ...projects,
        {
          id: ProjectId.make(id),
          title: id,
          workspaceRoot,
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-27T00:00:00.000Z",
          updatedAt: "2026-10-27T00:00:00.000Z",
        },
      ];
    },
    /** Replaces the thread's sync state, e.g. a failed load with no projection. */
    setThreadState: (next: Partial<EnvironmentThreadState>) =>
      registry.set(state, AsyncResult.success({ ...live, ...next })),
    instance: (id: string) => ProviderInstanceId.make(id),
  };
}
