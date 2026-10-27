import type { QueuedRunStatus } from "@t3tools/client-runtime/queued-run-edit";
import {
  CommandId,
  MessageId,
  OrchestrationV2DispatchCommandError,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createComposerSender,
  type ComposerCommandResult,
  type WorkspaceBlock,
} from "./composerSender.ts";
import { createComposerStore } from "./composerStore.ts";
import { createQueueController, WORKSPACE_UNKNOWN_NOTICE } from "./queueController.ts";
import { QUEUE_BUSY_REASON, type QueueRow, type QueueView } from "./queueView.ts";

const threadId = ThreadId.make("t1");

function row(id: string, text = id): QueueRow {
  return {
    runId: RunId.make(id),
    messageId: MessageId.make(`m-${id}`),
    text,
    preview: text,
    attachments: 0,
    held: false,
    guestName: null,
  };
}

function queueOf(rows: ReadonlyArray<QueueRow>, overrides: Partial<QueueView> = {}): QueueView {
  return {
    rows,
    holdReason: null,
    activeRunId: RunId.make("active"),
    canReorder: true,
    canSendNow: false,
    canPromoteToSteer: true,
    ...overrides,
  };
}

function deferred() {
  let resolve!: (result: ComposerCommandResult) => void;
  const promise = new Promise<ComposerCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

const notQueued = (type: string, runId: string): ComposerCommandResult => ({
  ok: false,
  error: new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("x"),
    commandType: type,
    message: `Run ${runId} is not queued.`,
  }),
  interrupted: false,
});

/**
 * The real controller, composer store and sender on a real atom registry; the server side is
 * scripted: each command logs itself and returns the next reply. `server.view` is the
 * thread's queue as the projection has it, `server.runs` what an open edit watches.
 */
function setup(
  options: {
    readonly replies?: ReadonlyArray<ComposerCommandResult | Promise<ComposerCommandResult>>;
    readonly blockedReason?: () => WorkspaceBlock | Promise<WorkspaceBlock>;
  } = {},
) {
  const registry = AtomRegistry.make();
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const replies = [...(options.replies ?? [])];
  const calls: Array<{ readonly type: string; readonly input: Record<string, unknown> }> = [];
  const statuses: string[] = [];
  const server = {
    view: queueOf([row("a"), row("b"), row("c")]) as QueueView | null,
    status: new Map<string, string>(),
  };
  const runs = Atom.make<ReadonlyArray<QueuedRunStatus> | null>([
    { id: RunId.make("a"), status: "queued" },
    { id: RunId.make("b"), status: "queued" },
    { id: RunId.make("c"), status: "queued" },
  ]).pipe(Atom.keepAlive);
  const respond =
    (type: string) =>
    (input: object): Promise<ComposerCommandResult> => {
      calls.push({ type, input: { ...input } });
      return Promise.resolve(replies.shift() ?? { ok: true });
    };
  let ids = 0;
  const guard =
    options.blockedReason === undefined
      ? {}
      : {
          guardWorkspace: () => ({
            blockedReason: options.blockedReason ?? (() => null),
            dispose: () => undefined,
          }),
        };
  const sender = createComposerSender({
    store,
    startTurn: respond("message.dispatch"),
    setRuntimeMode: respond("runtime-mode"),
    setInteractionMode: respond("interaction-mode"),
    resumeQueue: respond("queue.resume"),
    threadSettings: () => null,
    schedule: () => () => undefined,
    ...guard,
  });
  const controller = createQueueController({
    registry,
    view: () => server.view,
    runStatus: (_, runId) => server.status.get(runId) ?? "queued",
    queuedRuns: () => runs,
    editQueuedRun: respond("queued-run.edit"),
    cancelQueuedRun: respond("queued-run.cancel"),
    reorderQueuedRun: respond("queued-run.reorder"),
    promoteQueuedRun: respond("queued-message.promote-to-steer"),
    sender,
    schedule: () => () => undefined,
    store,
    onStatus: (status) => statuses.push(status),
    mintCommandId: () => CommandId.make(`cmd-${(ids += 1)}`),
    ...guard,
  });
  /** The run left the queue elsewhere: it started, or was removed. */
  const leave = (id: string, status: string) => {
    server.status.set(id, status);
    if (server.view !== null) {
      server.view = {
        ...server.view,
        rows: server.view.rows.filter((entry) => entry.runId !== id),
      };
    }
    registry.set(
      runs,
      (registry.get(runs) ?? []).map((run) => (run.id === id ? { ...run, status } : run)),
    );
  };
  return { registry, store, sender, controller, calls, statuses, server, leave };
}

describe("queue controller", () => {
  it("removes, moves and steers with upstream's commands", async () => {
    const { controller, calls, statuses } = setup();
    await controller.remove(threadId, RunId.make("b"));
    await controller.move(threadId, RunId.make("c"), -1);
    await controller.move(threadId, RunId.make("a"), 1);
    await controller.sendNow(threadId, RunId.make("a"));
    expect(calls).toEqual([
      { type: "queued-run.cancel", input: { commandId: "cmd-1", threadId, runId: "b" } },
      {
        type: "queued-run.reorder",
        input: { commandId: "cmd-2", threadId, runId: "c", beforeRunId: "b" },
      },
      {
        type: "queued-run.reorder",
        input: { commandId: "cmd-3", threadId, runId: "a", beforeRunId: "c" },
      },
      {
        type: "queued-message.promote-to-steer",
        input: { commandId: "cmd-4", threadId, queuedRunId: "a", targetRunId: "active" },
      },
    ]);
    expect(statuses).toEqual([
      "Removed from the queue",
      "Moved up",
      "Moved down",
      "Steering the run with it",
    ]);
  });

  it("sends one queue change at a time per thread; a second press waits its turn", async () => {
    const reply = deferred();
    const { controller, calls, statuses } = setup({ replies: [reply.promise] });
    const first = controller.remove(threadId, RunId.make("a"));
    expect(await controller.remove(threadId, RunId.make("a"))).toBe(false);
    expect(await controller.move(threadId, RunId.make("b"), 1)).toBe(false);
    reply.resolve({ ok: true });
    expect(await first).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(["queued-run.cancel"]);
    expect(statuses.slice(0, 2)).toEqual([QUEUE_BUSY_REASON, QUEUE_BUSY_REASON]);
  });

  it("sends nothing for a message that already left the queue, and says where it went", async () => {
    const { controller, calls, store, leave } = setup();
    leave("a", "running");
    leave("b", "cancelled");
    await controller.remove(threadId, RunId.make("a"));
    expect(store.snapshot(threadId).notice).toBe("That message already started");
    await controller.sendNow(threadId, RunId.make("b"));
    expect(store.snapshot(threadId).notice).toBe("That message was already removed from the queue");
    expect(controller.beginEdit(threadId, RunId.make("a"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("turns the server's 'not queued' into the same notice when it left meanwhile", async () => {
    const { controller, store } = setup({ replies: [notQueued("queued-run.cancel", "a")] });
    await controller.remove(threadId, RunId.make("a"));
    expect(store.snapshot(threadId).notice).toBe("That message is no longer queued");
  });

  it("says a dropped connection may not have applied the change, without resending", async () => {
    const dropped: ComposerCommandResult = {
      ok: false,
      error: new Error("Socket is not connected"),
      interrupted: false,
    };
    const { controller, calls, store } = setup({ replies: [dropped] });
    await controller.move(threadId, RunId.make("a"), 1);
    expect(calls).toHaveLength(1);
    expect(store.snapshot(threadId).notice).toBe(
      "Couldn't move it: the connection dropped; check the queue once it's back",
    );
  });

  it("won't move the first up, and doesn't ask the server", async () => {
    const { controller, calls, statuses } = setup();
    expect(await controller.move(threadId, RunId.make("a"), -1)).toBe(false);
    expect(calls).toEqual([]);
    expect(statuses).toEqual(["It's already first"]);
  });

  it("sends now through the sender while nothing runs: one queued-run.start, however often pressed", async () => {
    const { controller, calls, server } = setup();
    server.view = queueOf(server.view?.rows ?? [], {
      activeRunId: null,
      canSendNow: true,
      canPromoteToSteer: false,
    });
    expect(await controller.sendNow(threadId, RunId.make("b"))).toBe(true);
    await controller.sendNow(threadId, RunId.make("b"));
    await settle();
    expect(calls).toEqual([
      { type: "queue.resume", input: { commandId: expect.any(String), threadId, runId: "b" } },
    ]);
  });

  it("won't steer while the worktree isn't there, nor while it can't tell", async () => {
    let reason: string | null | undefined = "Worktree setup failed";
    const { controller, calls, store } = setup({ blockedReason: () => reason });
    await controller.sendNow(threadId, RunId.make("a"));
    expect(store.snapshot(threadId).notice).toBe("Worktree setup failed");
    reason = undefined;
    await controller.sendNow(threadId, RunId.make("a"));
    expect(store.snapshot(threadId).notice).toBe(WORKSPACE_UNKNOWN_NOTICE);
    reason = null;
    await controller.sendNow(threadId, RunId.make("a"));
    expect(calls.map((call) => call.type)).toEqual(["queued-message.promote-to-steer"]);
  });

  it("won't steer once the run it was for ended; it says to send it now instead", async () => {
    let release: (value: WorkspaceBlock) => void = () => {};
    const { controller, calls, store, server } = setup({
      blockedReason: () =>
        new Promise<WorkspaceBlock>((resolve) => {
          release = resolve;
        }),
    });
    const steering = controller.sendNow(threadId, RunId.make("a"));
    await settle();
    server.view = queueOf(server.view?.rows ?? [], {
      activeRunId: null,
      canSendNow: true,
      canPromoteToSteer: false,
    });
    release(null);
    expect(await steering).toBe(false);
    expect(calls).toEqual([]);
    expect(store.snapshot(threadId).notice).toBe(
      "The run ended before the steer went out; s sends it now",
    );
  });
});

describe("queue controller edits", () => {
  it("saves a changed edit with queued-run.edit, text only, and closes it", async () => {
    const { controller, calls, registry } = setup();
    expect(controller.beginEdit(threadId, RunId.make("b"))).toBe(true);
    controller.setEditText(threadId, "  b, better  ");
    await controller.saveEdit(threadId);
    expect(calls).toEqual([
      {
        type: "queued-run.edit",
        input: { commandId: "cmd-1", threadId, runId: "b", text: "b, better" },
      },
    ]);
    expect(controller.edit(threadId)).toBeNull();
    expect(registry.get(controller.savingAtom)).toEqual({});
  });

  it("closes an unchanged edit without a command, and refuses an empty one", async () => {
    const { controller, calls, statuses } = setup();
    controller.beginEdit(threadId, RunId.make("a"));
    controller.setEditText(threadId, "   ");
    await controller.saveEdit(threadId);
    expect(controller.edit(threadId)).not.toBeNull();
    expect(statuses).toEqual(["A queued message can't be empty; x removes it"]);
    controller.setEditText(threadId, "a");
    await controller.saveEdit(threadId);
    expect(controller.edit(threadId)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("won't edit a guest's message", () => {
    const { controller, server, statuses } = setup();
    server.view = queueOf([{ ...row("g"), guestName: "Sam" }]);
    expect(controller.beginEdit(threadId, RunId.make("g"))).toBe(false);
    expect(statuses).toEqual(["A guest's message can be removed, not edited"]);
  });

  it("keeps a changed edit in the composer when its message starts elsewhere", () => {
    const { controller, store, leave } = setup();
    store.setDraftText(threadId, "my draft");
    controller.beginEdit(threadId, RunId.make("a"));
    controller.setEditText(threadId, "a, edited");
    leave("a", "running");
    expect(controller.edit(threadId)).toBeNull();
    expect(store.getDraft(threadId).text).toBe("a, edited\n\nmy draft");
    expect(store.snapshot(threadId).notice).toBe("That message already started; your edit is here");
  });

  it("just closes an unchanged edit when its message is removed elsewhere", () => {
    const { controller, store, leave } = setup();
    controller.beginEdit(threadId, RunId.make("a"));
    leave("a", "cancelled");
    expect(controller.edit(threadId)).toBeNull();
    expect(store.getDraft(threadId).text).toBe("");
    expect(store.snapshot(threadId).notice).toBe("That message was already removed from the queue");
  });

  it("keeps the edit open after a failed save, and saves it once only while saving", async () => {
    const reply = deferred();
    const rejected: ComposerCommandResult = {
      ok: false,
      error: new Error("Queued run b cannot be edited to an empty message."),
      interrupted: false,
    };
    const { controller, calls, store } = setup({ replies: [reply.promise] });
    controller.beginEdit(threadId, RunId.make("b"));
    controller.setEditText(threadId, "new");
    const saving = controller.saveEdit(threadId);
    await controller.saveEdit(threadId);
    reply.resolve(rejected);
    await saving;
    expect(calls).toHaveLength(1);
    expect(controller.edit(threadId)?.text).toBe("new");
    expect(store.snapshot(threadId).notice).toBe(
      "Couldn't save the edit: Queued run b cannot be edited to an empty message.",
    );
  });

  it("puts the edit in the composer when the save fails because the message started", async () => {
    const reply = deferred();
    const { controller, store, leave } = setup({ replies: [reply.promise] });
    controller.beginEdit(threadId, RunId.make("b"));
    controller.setEditText(threadId, "too late");
    const saving = controller.saveEdit(threadId);
    leave("b", "running");
    reply.resolve(notQueued("queued-run.edit", "b"));
    await saving;
    expect(controller.edit(threadId)).toBeNull();
    expect(store.getDraft(threadId).text).toBe("too late");
  });

  it("hands an unsaved edit to the composer at quit, and drops an unchanged one", () => {
    const { controller, store } = setup();
    controller.beginEdit(threadId, RunId.make("a"));
    controller.setEditText(threadId, "unsaved");
    controller.handOff();
    expect(store.getDraft(threadId).text).toBe("unsaved");
    expect(controller.edit(threadId)).toBeNull();
  });
});
