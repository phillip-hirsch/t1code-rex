import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createComposerSend, type ComposerSend } from "../composerSend.ts";
import { createComposerSender } from "../composerSender.ts";
import { createComposerStore } from "../composerStore.ts";
import { WORKTREE_FAILED_NOTICE } from "../worktreeLaunch.ts";
import { createWorkspaceGuard } from "./workspaceGuard.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
};
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const SETTINGS = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type Item = Projection["turnItems"][number];

const at = (time: string) => DateTime.makeUnsafe(`2026-10-27T10:${time}.000Z`);

/** The thread's runs and worktree as of `time`; the rest is empty. */
function projection(
  time: string,
  input: { readonly worktreePath?: string; readonly runs?: Run[]; readonly turnItems?: Item[] },
): Projection {
  return {
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Worktree thread",
      worktreePath: input.worktreePath ?? null,
      updatedAt: at(time),
    },
    runs: input.runs ?? [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: input.turnItems ?? [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at(time),
  } as unknown as Projection;
}

const launchRun = (status: Run["status"]) =>
  ({
    id: "run-1",
    ordinal: 1,
    status,
    startedAt: null,
    completedAt: null,
    workspacePreparation: { type: "worktree", baseRef: "main" },
  }) as unknown as Run;

const preparationFailure = {
  type: "error",
  status: "failed",
  runId: "run-1",
  failure: { code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE },
} as unknown as Item;

/** Before the launch's preparation was recorded: nothing blocks a send. */
const BEFORE = projection("00:00", {});
/** The preparation failed and the thread has no worktree. */
const FAILED = projection("01:00", {
  runs: [launchRun("failed")],
  turnItems: [preparationFailure],
});
/** A retry made the worktree. */
const READY = projection("02:00", {
  worktreePath: "/worktrees/one",
  runs: [launchRun("completed")],
  turnItems: [preparationFailure],
});

interface Subscription {
  readonly afterSequence: number | undefined;
  readonly items: Queue.Queue<OrchestrationV2ThreadStreamItem>;
  readonly closed: Deferred.Deferred<void>;
}

/**
 * client-runtime's real thread atoms on a scripted socket, and the real sender and store
 * with the guard wired as the connection wires it. Each subscription waits for the items
 * the test hands it. A cold thread loads `BEFORE`; `server.snapshot` is what the server's
 * HTTP snapshot says now.
 */
const setup = Effect.fn("WorkspaceGuardTest.setup")(function* () {
  const subscriptions = yield* Queue.unbounded<Subscription>();
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          yield* Queue.offer(subscriptions, { afterSequence: input.afterSequence, items, closed });
          return Stream.fromQueue(items);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const unexpected = () => Effect.die("unexpected");
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: unexpected,
    registerPlatform: unexpected,
    reconcilePlatform: unexpected,
    remove: unexpected,
    removeRoute: unexpected,
    reorderRoutes: unexpected,
    removeRelayEnvironments: unexpected,
    retryNow: () => Effect.void,
    setEnabled: unexpected,
    setCompatibility: unexpected,
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader,
        ThreadSnapshotLoader.of({
          load: () =>
            Effect.succeed({
              _tag: "present" as const,
              snapshot: { snapshotSequence: 1, projection: BEFORE },
            }),
        }),
      ),
    ),
  );
  const threadStates = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(threadStates.stateAtom);
  const stateAtom = details.stateAtom({ environmentId: TARGET.environmentId, threadId: THREAD_ID });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const server: { snapshot: Projection } = { snapshot: BEFORE };
  const snapshotLoads: Projection[] = [];

  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sent = yield* Queue.unbounded<string>();
  const timers: Array<() => void> = [];
  const sender = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createComposerSender({
        store,
        startTurn: (input) => {
          Queue.offerUnsafe(sent, input.commandId ?? "");
          return Promise.resolve({ ok: true });
        },
        setRuntimeMode: () => Promise.resolve({ ok: true }),
        setInteractionMode: () => Promise.resolve({ ok: true }),
        resumeQueue: () => Promise.resolve({ ok: true }),
        threadSettings: () => SETTINGS,
        guardWorkspace: () =>
          createWorkspaceGuard({
            registry,
            stateAtom,
            loadSnapshot: (): Promise<ThreadSnapshotLoadResult> => {
              snapshotLoads.push(server.snapshot);
              return Promise.resolve({
                _tag: "present",
                snapshot: { snapshotSequence: 1, projection: server.snapshot },
              });
            },
          }),
        schedule: (run) => {
          timers.push(run);
          return () => {
            const index = timers.indexOf(run);
            if (index >= 0) timers.splice(index, 1);
          };
        },
      }),
    ),
    (sender) => Effect.sync(() => sender.dispose()),
  );

  /** The server replays the thread as `next`, then confirms the subscription caught up. */
  const replay = (subscription: Subscription, next: Projection, snapshotSequence: number) =>
    Queue.offerAll(subscription.items, [
      { kind: "snapshot", snapshotSequence, projection: next } as OrchestrationV2ThreadStreamItem,
      { kind: "synchronized" },
    ]);
  const state = () => registry.get(stateAtom);
  const live = AtomRegistry.toStream(registry, stateAtom).pipe(
    Stream.filter((value) => value.status === "live"),
    Stream.runHead,
  );

  return {
    registry,
    stateAtom,
    state,
    live,
    server,
    snapshotLoads,
    store,
    sender,
    sent,
    timers,
    subscriptions,
    replay,
  };
});

let commandCount = 0;
function message(text: string): ComposerSend {
  commandCount += 1;
  return {
    ...createComposerSend({
      target: { kind: "thread", threadId: THREAD_ID, projectId: PROJECT_ID },
      text,
      attachments: [],
      dispatch: "queue",
      settings: SETTINGS,
    }),
    commandId: CommandId.make(`cmd-${commandCount}`),
    messageId: MessageId.make(`msg-${commandCount}`),
  };
}

describe("createWorkspaceGuard on client-runtime's thread atoms", () => {
  it.effect("trusts a warm remount only once its replay has caught up with the server", () =>
    Effect.gen(function* () {
      const h = yield* setup();

      // The thread was on screen a moment ago: loaded, caught up, then left.
      const unmount = h.registry.mount(h.stateAtom);
      const viewed = yield* Queue.take(h.subscriptions);
      yield* h.replay(viewed, BEFORE, 1);
      yield* h.live;
      unmount();
      yield* Deferred.await(viewed.closed);

      // Meanwhile its worktree preparation failed. The remount shows the kept state as live
      // before any of the replay arrives, and that state predates the failure.
      h.server.snapshot = FAILED;
      const first = message("first");
      const firstDone = h.sender.send(first);
      const remount = yield* Queue.take(h.subscriptions);
      expect(remount.afterSequence).toBe(1);
      expect(h.state().status).toBe("live");
      expect(Option.getOrNull(h.state().data)).toBe(BEFORE);
      // The job waits, having asked the server.
      expect(yield* Queue.size(h.sent)).toBe(0);
      expect(h.sender.pendingCount()).toBe(1);
      expect(h.snapshotLoads).toEqual([FAILED]);

      // The replay arrives, showing the failure: the message goes back, unsent.
      yield* h.replay(remount, FAILED, 2);
      yield* Effect.promise(() => firstDone);
      expect(yield* Queue.size(h.sent)).toBe(0);
      expect(h.sender.pendingCount()).toBe(0);
      expect(h.store.getDraft(THREAD_ID).text).toBe("first");
      expect(h.store.snapshot(THREAD_ID).notice).toBe(WORKTREE_FAILED_NOTICE);
      // With nothing pending, the guard stops watching.
      yield* Deferred.await(remount.closed);

      // A retry makes the worktree. Until this remount's replay says so, the next send waits.
      h.server.snapshot = READY;
      const second = message("second");
      const secondDone = h.sender.send(second);
      const next = yield* Queue.take(h.subscriptions);
      expect(Option.getOrNull(h.state().data)).toBe(FAILED);
      expect(yield* Queue.size(h.sent)).toBe(0);
      expect(h.sender.pendingCount()).toBe(1);

      yield* h.replay(next, READY, 3);
      expect(yield* Queue.take(h.sent)).toBe(second.commandId);
      yield* Effect.promise(() => secondDone);
      expect(h.sender.pendingCount()).toBe(0);
      // It never fell back to waiting out a retry timer.
      expect(h.timers).toHaveLength(0);
    }),
  );
});
