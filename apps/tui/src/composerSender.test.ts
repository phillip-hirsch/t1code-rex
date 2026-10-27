import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  MessageId,
  OrchestrationV2DispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkUnconfirmedSends,
  recoverOrphanedSends,
  UNCONFIRMED_NOTICE,
  type ThreadLookup,
} from "./composerRecovery.ts";
import { retryDelayMs, type ComposerSend } from "./composerSend.ts";
import {
  createComposerSender,
  DISCARD_NOTICE,
  MAYBE_SENT_NOTICE,
  QUIT_NOTICE,
  type ComposerCommandResult,
} from "./composerSender.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore, type ComposerStore } from "./composerStore.ts";
import type { TuiPrefs } from "./prefs.ts";

const threadSettings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

function send(overrides: Partial<ComposerSend> = {}): ComposerSend {
  return {
    target: { kind: "thread", threadId: ThreadId.make("t1"), projectId: ProjectId.make("p") },
    commandId: CommandId.make("cmd-1"),
    messageId: MessageId.make("msg-1"),
    text: "hello",
    attachments: [],
    dispatch: "queue",
    settings: threadSettings,
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

const ok: ComposerCommandResult = { ok: true };
const dropped: ComposerCommandResult = {
  ok: false,
  error: new Error("Socket is not connected"),
  interrupted: false,
};

/** A reply the test sends when it chooses, to force an interleaving. */
function deferred() {
  let resolve!: (result: ComposerCommandResult) => void;
  const promise = new Promise<ComposerCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The real sender and store, with the server side scripted: each command returns the next
 * scripted result, or waits on a scripted deferred reply. Timers (retries, stall checks)
 * queue up and run when the test says so. `server.settings` is what the shell lists now.
 */
function setup(
  script: ReadonlyArray<ComposerCommandResult | Promise<ComposerCommandResult>>,
  options: {
    readonly store?: ComposerStore;
    /** Why nothing may start on a thread; undefined while its runs aren't loaded. */
    readonly blockedReason?: (threadId: string) => string | null | undefined;
  } = {},
) {
  const store = options.store ?? createComposerStore({ initialPrefs: {}, persist: null });
  const results = [...script];
  const calls: Array<{
    readonly kind: string;
    readonly commandId: string;
    readonly input: unknown;
  }> = [];
  const timers: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const server: { settings: ComposerSettings | null } = { settings: threadSettings };
  /** The threads the sender watches now. */
  const watched = new Set<string>();
  const { blockedReason } = options;
  const respond = (kind: string, commandId: string | undefined, input: unknown) => {
    calls.push({ kind, commandId: commandId ?? "", input });
    return Promise.resolve(results.shift() ?? ok);
  };
  const sender = createComposerSender({
    store,
    startTurn: (input: StartThreadTurnInput) => respond("start-turn", input.commandId, input),
    setRuntimeMode: (input) => respond("runtime-mode", input.commandId, input),
    setInteractionMode: (input) => respond("interaction-mode", input.commandId, input),
    threadSettings: () => server.settings,
    // Logged as "resume"; the input keeps the job's real command id.
    resumeQueue: (input) => respond("queue.resume", "resume", input),
    ...(blockedReason === undefined
      ? {}
      : {
          guardWorkspace: (threadId: ThreadId) => {
            watched.add(threadId);
            return {
              blockedReason: () => blockedReason(threadId),
              dispose: () => watched.delete(threadId),
            };
          },
        }),
    schedule: (run, delayMs) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  /** Runs the pending timers with this delay, as if that much time passed. */
  const elapse = (delayMs: number) => {
    for (const timer of timers.filter((entry) => entry.delayMs === delayMs)) timer.run();
  };
  return { store, sender, calls, timers, server, elapse, watched };
}

/** Lets queued promise callbacks run; no clock involved. */
const settle = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

const ids = (calls: ReturnType<typeof setup>["calls"]) => calls.map((call) => call.commandId);

/** A store that saves to an in-memory prefs.json, as the window that owns it does. */
function savingStore(prefs: { current: TuiPrefs; writes?: number }) {
  return createComposerStore({
    initialPrefs: prefs.current,
    persist: (patch) => {
      prefs.writes = (prefs.writes ?? 0) + 1;
      const next: Record<string, unknown> = { ...prefs.current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      // Round-trip through JSON, as prefs.json does.
      prefs.current = JSON.parse(JSON.stringify(next)) as TuiPrefs;
    },
  });
}

/** A thread's whole history, as the server's full thread snapshot returns it. */
function history(
  messageIds: ReadonlyArray<string>,
  options: { readonly deleted?: boolean; readonly projectId?: string } = {},
): ThreadLookup {
  return {
    _tag: "present",
    snapshot: {
      projection: {
        thread: {
          projectId: ProjectId.make(options.projectId ?? "p"),
          deletedAt: options.deleted === true ? "2026-10-27T10:05:00.000Z" : null,
        },
        messages: messageIds.map((id) => ({ id: MessageId.make(id) })),
      },
    },
  };
}

/**
 * Runs the launch check on `store`, answering each thread's lookup from `answers` (a thread
 * not in it fails to load). Retries wait until the test runs `retry()`.
 */
function recovery(
  store: ComposerStore,
  answers: Record<string, ThreadLookup | Error>,
  options: { readonly projects?: ReadonlyArray<string> | null } = {},
) {
  const asked: Array<string> = [];
  const timers: Array<() => void> = [];
  const orphaned: Array<string> = [];
  const moved: Array<string> = [];
  let minted = 0;
  const stop = checkUnconfirmedSends({
    store,
    lookupThread: (threadId) => {
      asked.push(threadId);
      const answer = answers[threadId];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? { _tag: "unavailable" });
    },
    projectExists: (projectId) =>
      options.projects === null ? null : (options.projects ?? ["p", "q"]).includes(projectId),
    mintThreadId: () => ThreadId.make(`minted-${(minted += 1)}`),
    schedule: (run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    onMoved: (record, projectId) => moved.push(`${record.text} -> ${projectId}`),
    onOrphaned: (record) => orphaned.push(record.text),
  });
  const retry = async () => {
    for (const run of timers.splice(0)) run();
    await settle();
  };
  return { asked, timers, orphaned, moved, stop, retry };
}

const startTurns = (calls: ReturnType<typeof setup>["calls"]) =>
  calls
    .filter((call) => call.kind === "start-turn")
    .map((call) => call.input as StartThreadTurnInput);

describe("composer sender", () => {
  it("retries a send that lost the connection with the same command and message ids", async () => {
    const { store, sender, calls, timers } = setup([dropped, ok]);
    await sender.send(send());
    expect(store.snapshot("t1").sends).toMatchObject([{ status: "waiting", attempt: 1 }]);
    expect(timers).toHaveLength(1);
    // The connection comes back before the timer fires; the timer is dropped.
    await sender.retryWaiting();
    expect(timers).toHaveLength(0);
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1", "cmd-1"]);
    expect(calls.map((call) => (call.input as StartThreadTurnInput).message.messageId)).toEqual([
      "msg-1",
      "msg-1",
    ]);
    expect(store.snapshot("t1").sends).toEqual([]);
  });

  it("applies picked modes first, each with its own derived id, then sends", async () => {
    const { calls, sender } = setup([]);
    await sender.send(send({ settings: { ...threadSettings, interactionMode: "plan" } }));
    expect(calls.map((call) => [call.kind, call.commandId])).toEqual([
      ["interaction-mode", "cmd-1:interaction-mode"],
      ["start-turn", "cmd-1"],
    ]);
  });

  it("hands a rejected send back to the composer without retrying", async () => {
    const rejected: ComposerCommandResult = {
      ok: false,
      error: new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("cmd-1"),
        commandType: "message.dispatch",
        message: "Unknown model",
      }),
      interrupted: false,
    };
    const { store, sender, timers } = setup([rejected]);
    await sender.send(send());
    expect(timers).toHaveLength(0);
    expect(store.getDraft("t1").text).toBe("hello");
    expect(store.snapshot("t1").notice).toBe("Unknown model");
  });

  it("closes a new-thread draft once its thread launches", async () => {
    const { store, sender } = setup([]);
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    await sender.send(send({ target: { kind: "draft", ...draft } }));
    expect(store.findNewThreadDraft("new-1")).toBeUndefined();
  });
});

describe("composer sender ordering", () => {
  const plan: ComposerSettings = { ...threadSettings, interactionMode: "plan" };

  it("sends a thread's messages one at a time, settings included, in the order they were sent", async () => {
    const modeReply = deferred();
    const { sender, calls } = setup([modeReply.promise]);
    const first = sender.send(send({ settings: plan }));
    // The second message picks the same mode while the first one's mode change is in flight.
    const second = sender.send(
      send({
        commandId: CommandId.make("cmd-2"),
        messageId: MessageId.make("msg-2"),
        settings: plan,
      }),
    );
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1:interaction-mode"]);
    modeReply.resolve(ok);
    await Promise.all([first, second]);
    expect(calls.map((call) => [call.kind, call.commandId])).toEqual([
      ["interaction-mode", "cmd-1:interaction-mode"],
      ["start-turn", "cmd-1"],
      ["start-turn", "cmd-2"],
    ]);
  });

  it("applies a mode a later message switches back to, after the earlier message", async () => {
    const modeReply = deferred();
    const { sender, calls } = setup([modeReply.promise]);
    const first = sender.send(send({ settings: plan }));
    const second = sender.send(send({ commandId: CommandId.make("cmd-2") }));
    modeReply.resolve(ok);
    await Promise.all([first, second]);
    expect(calls.map((call) => call.commandId)).toEqual([
      "cmd-1:interaction-mode",
      "cmd-1",
      "cmd-2:interaction-mode",
      "cmd-2",
    ]);
  });

  it("retries the send it planned, skipping the steps the server already took", async () => {
    // The mode change lands; the dispatch reply is lost.
    const { sender, calls, server } = setup([ok, dropped]);
    await sender.send(send({ settings: plan }));
    // Another window switches the thread back to chat mode before the retry.
    server.settings = threadSettings;
    await sender.retryWaiting();
    expect(calls.map((call) => call.commandId)).toEqual([
      "cmd-1:interaction-mode",
      "cmd-1",
      "cmd-1",
    ]);
  });

  it("never adds a mode change on retry that the send didn't plan", async () => {
    const { sender, calls, server } = setup([dropped]);
    await sender.send(send());
    // Another window picks plan mode; replaying the lost dispatch must not undo it.
    server.settings = plan;
    await sender.retryWaiting();
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1", "cmd-1"]);
  });

  it("holds later messages behind a send waiting to retry", async () => {
    const { store, sender, calls } = setup([dropped]);
    await sender.send(send());
    await sender.send(send({ commandId: CommandId.make("cmd-2") }));
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1"]);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["waiting", "waiting"]);
    await sender.retryWaiting();
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
    expect(store.snapshot("t1").sends).toEqual([]);
  });

  it("always sends the model picked for the message", async () => {
    const { sender, calls } = setup([]);
    await sender.send(send());
    expect(startTurns(calls)[0]?.modelSelection).toEqual(threadSettings.modelSelection);
  });

  it("sends a second message to a launching thread after the launch, as a follow-up", async () => {
    const launchReply = deferred();
    const { store, sender, calls, server } = setup([launchReply.promise]);
    server.settings = null; // The shell hasn't listed the new thread.
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    const target = { kind: "draft" as const, ...draft };
    const first = sender.send(send({ target }));
    const second = sender.send(
      send({ target, commandId: CommandId.make("cmd-2"), messageId: MessageId.make("msg-2") }),
    );
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1"]);
    launchReply.resolve(ok);
    await Promise.all([first, second]);
    const [launch, followUp] = startTurns(calls);
    expect(launch).toMatchObject({ commandId: "cmd-1", threadId: "new-1" });
    expect(launch?.bootstrap).toBeDefined();
    expect(followUp).toMatchObject({ commandId: "cmd-2", threadId: "new-1" });
    expect(followUp?.bootstrap).toBeUndefined();
    expect(store.findNewThreadDraft("new-1")).toBeUndefined();
  });

  it("hands back a rejected launch and the messages queued behind it, in order", async () => {
    const launchReply = deferred();
    const { store, sender, calls } = setup([launchReply.promise]);
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    const target = { kind: "draft" as const, ...draft };
    const first = sender.send(send({ target, text: "one" }));
    const second = sender.send(send({ target, commandId: CommandId.make("cmd-2"), text: "two" }));
    launchReply.resolve({
      ok: false,
      error: new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("cmd-1"),
        commandType: "message.dispatch",
        message: "Project is gone",
      }),
      interrupted: false,
    });
    await Promise.all([first, second]);
    expect(calls.map((call) => call.commandId)).toEqual(["cmd-1"]);
    expect(store.getDraft("new-1").text).toBe("one\n\ntwo");
    expect(store.snapshot("new-1").sends).toEqual([]);
    expect(store.findNewThreadDraft("new-1")).toBeDefined();
  });
});

describe("composer sender, Sol audit round 2", () => {
  const approval: ComposerSettings = { ...threadSettings, runtimeMode: "approval-required" };
  const second = { commandId: CommandId.make("cmd-2"), messageId: MessageId.make("msg-2") };
  const third = { commandId: CommandId.make("cmd-3"), messageId: MessageId.make("msg-3") };

  it("N1: plans against modes the server accepted while the shell still lists the old ones", async () => {
    const { sender, calls, server } = setup([]);
    server.settings = approval;
    // Full access for the first message; the server accepts it.
    await sender.send(send({ settings: threadSettings }));
    // The shell still lists approval-required. Switching back must still send the change.
    await sender.send(send({ ...second, settings: approval }));
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode", "cmd-1", "cmd-2:runtime-mode", "cmd-2"]);
    expect(calls[2]?.input).toMatchObject({ runtimeMode: "approval-required" });
  });

  it("N1: goes back to the shell's modes once it lists the accepted ones", async () => {
    const { sender, calls, server } = setup([]);
    server.settings = approval;
    await sender.send(send({ settings: threadSettings }));
    // The shell catches up, then another window switches back to approval-required.
    server.settings = threadSettings;
    sender.reconcile();
    server.settings = approval;
    sender.reconcile();
    await sender.send(send({ ...second, settings: threadSettings }));
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode", "cmd-1", "cmd-2:runtime-mode", "cmd-2"]);
    expect(sender.trackedThreads().accepted).toBe(1);
  });

  it("N3: Stop holds the thread's unsent messages until they're resumed", async () => {
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send());
    void sender.send(send(second));
    expect(sender.hold("t1")).toBe(1);
    inFlight.resolve(ok);
    await first;
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["held"]);
    // A reconnect doesn't release the hold.
    await sender.retryWaiting();
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(sender.resume(ThreadId.make("t1"))).toBe(1);
    await settle();
    // The server's held queue goes first: it holds messages sent before these.
    expect(ids(calls)).toEqual(["cmd-1", "resume", "cmd-2"]);
    expect(store.snapshot("t1").sends).toEqual([]);
  });

  it("N3: held messages wait until the server has released its own held queue", async () => {
    const inFlight = deferred();
    const resumed = deferred();
    const { sender, calls } = setup([inFlight.promise, resumed.promise]);
    const first = sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
    resumed.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume", "cmd-2"]);
  });

  it("N3: a new message releases the hold, held ones first, as upstream releases its queue", async () => {
    const inFlight = deferred();
    const { sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    await sender.send(send(third));
    expect(ids(calls)).toEqual(["cmd-1", "resume", "cmd-2", "cmd-3"]);
  });

  it("N3: /discard puts held messages back in the composer", async () => {
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send({ text: "one" }));
    void sender.send(send({ ...second, text: "two" }));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    expect(sender.discard("t1")).toEqual({ messages: 1, resumes: 0 });
    expect(store.getDraft("t1").text).toBe("two");
    expect(store.snapshot("t1").notice).toBe(DISCARD_NOTICE);
    expect(store.snapshot("t1").sends).toEqual([]);
    // With nothing held here any more, /resume releases only the server's queue.
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
  });

  it("N4: a command with no reply shows as stuck; /resume resends it with the same ids", async () => {
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const { store, sender, calls, elapse } = setup([never]);
    void sender.send(send());
    void sender.send(send(second));
    elapse(30_000);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["stuck", "sending"]);
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
    expect(store.snapshot("t1").sends).toEqual([]);
  });

  it("N4: reconnecting resends a stuck command", async () => {
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const { sender, calls, elapse } = setup([never]);
    void sender.send(send());
    elapse(30_000);
    await sender.retryWaiting();
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "cmd-1"]);
  });

  it("N4: dropping a stuck message that went out keeps its text and says it may have been sent", async () => {
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const { store, sender, calls, elapse } = setup([never]);
    void sender.send(send({ text: "one" }));
    void sender.send(send({ ...second, text: "two" }));
    elapse(30_000);
    expect(sender.discard("t1")).toEqual({ messages: 2, resumes: 0 });
    await settle();
    expect(store.getDraft("t1").text).toBe("one\n\ntwo");
    expect(store.snapshot("t1").notice).toBe(MAYBE_SENT_NOTICE);
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(sender.pendingCount()).toBe(0);
  });

  it("N4: a send retrying after a lost reply can be dropped, and is marked as maybe sent", async () => {
    const { store, sender, timers } = setup([dropped]);
    await sender.send(send());
    expect(store.snapshot("t1").sends).toMatchObject([{ status: "waiting" }]);
    expect(sender.discard("t1")).toEqual({ messages: 1, resumes: 0 });
    expect(timers).toHaveLength(0);
    expect(store.snapshot("t1").notice).toBe(MAYBE_SENT_NOTICE);
  });

  it("N4: leaves a command in flight alone on /discard while it isn't stuck", async () => {
    const inFlight = deferred();
    const { sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send());
    expect(sender.discard("t1")).toEqual({ messages: 0, resumes: 0 });
    inFlight.resolve(ok);
    await first;
    expect(ids(calls)).toEqual(["cmd-1"]);
  });

  it("N4: retries back off", () => {
    const delays = [0, 1, 2, 3, 4, 5, 9].map(retryDelayMs);
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000]);
  });

  it("N5: forgets a launched draft once the shell lists it, and everything on dispose", async () => {
    const { store, sender, server } = setup([]);
    server.settings = null;
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    await sender.send(send({ target: { kind: "draft", ...draft } }));
    expect(sender.trackedThreads()).toEqual({ accepted: 1, launched: 1 });
    server.settings = threadSettings;
    sender.reconcile();
    expect(sender.trackedThreads()).toEqual({ accepted: 0, launched: 0 });

    server.settings = null;
    const other = store.openNewThreadDraft(ProjectId.make("q"), () => ThreadId.make("new-2"));
    await sender.send(send({ ...second, target: { kind: "draft", ...other } }));
    expect(sender.trackedThreads().launched).toBe(1);
    sender.dispose();
    expect(sender.trackedThreads()).toEqual({ accepted: 0, launched: 0 });
  });
});

describe("composer sender, Sol audit round 3", () => {
  const approval: ComposerSettings = { ...threadSettings, runtimeMode: "approval-required" };
  const second = { commandId: CommandId.make("cmd-2"), messageId: MessageId.make("msg-2") };
  const third = { commandId: CommandId.make("cmd-3"), messageId: MessageId.make("msg-3") };
  const never = () => new Promise<ComposerCommandResult>(() => undefined);
  const notActive: ComposerCommandResult = {
    ok: false,
    error: new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("resume"),
      commandType: "queue.resume",
      message: "Thread t1 is not active.",
    }),
    interrupted: false,
  };
  const statuses = (store: ComposerStore) =>
    store.snapshot("t1").sends.map((entry) => entry.status);
  const resumeIds = (calls: ReturnType<typeof setup>["calls"]) =>
    calls
      .filter((call) => call.kind === "queue.resume")
      .map((call) => (call.input as { commandId: string }).commandId);

  /**
   * Quits with one message out unconfirmed (an approval-mode send the server took the mode
   * change for) and one never sent, then relaunches on the saved prefs.
   */
  async function quitAndRelaunch() {
    const prefs: { current: TuiPrefs; writes?: number } = { current: {} };
    const first = setup([ok, never()], { store: savingStore(prefs) });
    void first.sender.send(send({ settings: approval }));
    void first.sender.send(send({ ...second, text: "second" }));
    await settle();
    first.sender.handOff();
    first.store.flush();
    const relaunched = setup([], { store: savingStore(prefs) });
    return { prefs, first, relaunched };
  }

  it("N6, N7: quit saves only an unconfirmed message's id and text; the next launch sends nothing and plans from the shell", async () => {
    const { prefs, first, relaunched } = await quitAndRelaunch();
    expect(ids(first.calls)).toEqual(["cmd-1:runtime-mode", "cmd-1"]);
    // No command ids, plan, or modes: nothing to replay.
    expect(prefs.current.composerUnconfirmedSends).toEqual([
      {
        threadId: "t1",
        projectId: "p",
        launch: false,
        messageId: "msg-1",
        text: "hello",
        attachments: [],
      },
    ]);
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("second");
    expect(first.store.snapshot("t1").notice).toBe(QUIT_NOTICE);

    // Another client switched the thread back to full access while tr3x was closed.
    await relaunched.sender.retryWaiting();
    await settle();
    expect(relaunched.calls).toEqual([]);
    expect(relaunched.sender.pendingCount()).toBe(0);
    expect(relaunched.sender.trackedThreads().accepted).toBe(0);
    // The approval mode from before the restart isn't assumed: the next send sets it again.
    await relaunched.sender.send(send({ ...third, settings: approval }));
    expect(ids(relaunched.calls)).toEqual(["cmd-3:runtime-mode", "cmd-3"]);
  });

  it("drops a saved message the thread has, once its history loads, leaving the composer alone", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    const answers: Record<string, ThreadLookup> = {};
    const check = recovery(relaunched.store, answers);
    await settle();
    // The lookup failed: not enough to tell.
    expect(relaunched.store.unconfirmedSends()).toHaveLength(1);
    answers.t1 = history(["msg-0", "msg-1"]);
    await check.retry();
    expect(check.asked).toEqual(["t1", "t1"]);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("second");
    expect(check.timers).toEqual([]);
    expect(relaunched.calls).toEqual([]);
  });

  it("puts a saved message the thread lacks back in the composer with a note, dropping the record in the same write", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    const writes = prefs.writes;
    recovery(relaunched.store, { t1: history(["msg-0"]) });
    await settle();
    expect(prefs.writes).toBe((writes ?? 0) + 1);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("hello\n\nsecond");
    expect(relaunched.store.snapshot("t1").notice).toBe(UNCONFIRMED_NOTICE);
    expect(relaunched.calls).toEqual([]);
  });

  it("N10: a restored message the user clears never comes back, even after a crash", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    recovery(relaunched.store, { t1: history([]) });
    await settle();
    relaunched.store.clearDraft("t1");
    relaunched.store.flush();
    // No hand-off: the process dies here.
    const afterCrash = setup([], { store: savingStore(prefs) });
    expect(afterCrash.store.unconfirmedSends()).toEqual([]);
    expect(afterCrash.store.getDraft("t1").text).toBe("");
    await afterCrash.sender.retryWaiting();
    expect(afterCrash.calls).toEqual([]);
  });

  it("restores a launch that never landed into its new-thread draft, and closes the draft of one that did", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const first = setup([never(), never()], { store: savingStore(prefs) });
    first.server.settings = null;
    const lost = first.store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    const landed = first.store.openNewThreadDraft(ProjectId.make("q"), () =>
      ThreadId.make("new-2"),
    );
    void first.sender.send(send({ target: { kind: "draft", ...lost }, text: "lost" }));
    void first.sender.send(send({ ...second, target: { kind: "draft", ...landed } }));
    await settle();
    first.sender.handOff();
    first.store.flush();
    expect(prefs.current.composerUnconfirmedSends?.map((record) => record.launch)).toEqual([
      true,
      true,
    ]);

    const { store } = setup([], { store: savingStore(prefs) });
    // The server never made new-1.
    recovery(store, { "new-1": { _tag: "missing" }, "new-2": history(["msg-2"]) });
    await settle();
    expect(store.getDraft("new-1").text).toBe("lost");
    expect(store.findNewThreadDraft("new-1")).toBeDefined();
    expect(store.getDraft("new-2").text).toBe("");
    expect(store.findNewThreadDraft("new-2")).toBeUndefined();
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
  });

  it("N8: messages held while the head was in flight wait for queue.resume, even when resumed before its reply", async () => {
    const inFlight = deferred();
    const resumed = deferred();
    const { sender, calls } = setup([inFlight.promise, resumed.promise]);
    void sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    sender.resume(ThreadId.make("t1"));
    inFlight.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
    resumed.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume", "cmd-2"]);
  });

  it("N8: a rejected resume keeps the hold and says why; /resume tries again", async () => {
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise, notActive]);
    const first = sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
    expect(statuses(store)).toEqual(["held"]);
    expect(store.snapshot("t1").notice).toBe(
      "Resume failed: Thread t1 is not active. (/resume, /discard)",
    );
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume", "resume", "cmd-2"]);
  });

  it("N8: a resume that lost the connection retries with the same id before the held messages", async () => {
    const inFlight = deferred();
    const { store, sender, calls, elapse } = setup([inFlight.promise, dropped]);
    const first = sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
    expect(statuses(store)).toEqual(["waiting"]);
    elapse(retryDelayMs(0));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume", "resume", "cmd-2"]);
    const [once, again] = resumeIds(calls);
    expect(again).toBe(once);
  });

  it("N9: a hung resume shows as stuck, and a reconnect resends it with the same id", async () => {
    const inFlight = deferred();
    const { store, sender, calls, elapse } = setup([inFlight.promise, never()]);
    const first = sender.send(send());
    void sender.send(send(second));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    sender.resume(ThreadId.make("t1"));
    await settle();
    elapse(30_000);
    expect(store.snapshot("t1").notice).toBe(
      "Resume got no reply (/resume retries, /discard drops it)",
    );
    await sender.retryWaiting();
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume", "resume", "cmd-2"]);
    const [once, again] = resumeIds(calls);
    expect(again).toBe(once);
    expect(store.snapshot("t1").notice).toBeNull();
  });

  it("N9: a hung resume can be discarded: the held message comes back and nothing more goes out", async () => {
    const inFlight = deferred();
    const { store, sender, calls, elapse } = setup([inFlight.promise, never()]);
    const first = sender.send(send());
    void sender.send(send({ ...second, text: "two" }));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    sender.resume(ThreadId.make("t1"));
    await settle();
    elapse(30_000);
    expect(sender.discard("t1")).toEqual({ messages: 1, resumes: 1 });
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "resume"]);
    expect(store.getDraft("t1").text).toBe("two");
    expect(store.snapshot("t1").notice).toBe(DISCARD_NOTICE);
    expect(sender.pendingCount()).toBe(0);
  });
});

describe("composer sender, Sol audit round 4", () => {
  const approval: ComposerSettings = { ...threadSettings, runtimeMode: "approval-required" };

  it("N8: Stop and Resume before a send's mode reply: queue.resume completes before its message", async () => {
    const modeReply = deferred();
    const resumed = deferred();
    const { store, sender, calls } = setup([modeReply.promise, resumed.promise]);
    void sender.send(send({ settings: approval }));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode"]);
    expect(sender.hold("t1")).toBe(1);
    sender.resume(ThreadId.make("t1"));
    modeReply.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode", "resume"]);
    resumed.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode", "resume", "cmd-1"]);
    expect(store.snapshot("t1").sends).toEqual([]);
  });

  it("N8: Stop during a send's mode command holds its message after the mode reply", async () => {
    const modeReply = deferred();
    const { store, sender, calls } = setup([modeReply.promise]);
    void sender.send(send({ settings: approval }));
    await settle();
    sender.hold("t1");
    modeReply.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode"]);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["held"]);
    sender.resume(ThreadId.make("t1"));
    await settle();
    // The mode command isn't sent again: it was accepted.
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode", "resume", "cmd-1"]);
  });

  it("N8: /discard after Stop hands back a message still on its mode command", async () => {
    const modeReply = deferred();
    const { store, sender, calls } = setup([modeReply.promise]);
    void sender.send(send({ settings: approval, text: "one" }));
    await settle();
    sender.hold("t1");
    expect(sender.discard("t1")).toEqual({ messages: 1, resumes: 0 });
    modeReply.resolve(ok);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode"]);
    expect(store.getDraft("t1").text).toBe("one");
    expect(store.snapshot("t1").notice).toBe(DISCARD_NOTICE);
  });

  /** prefs.json as a quit left it: one message to t1 (project p) went out unconfirmed. */
  const quitPrefs = (): { current: TuiPrefs; writes?: number } => ({
    current: {
      composerUnconfirmedSends: [
        {
          threadId: ThreadId.make("t1"),
          projectId: ProjectId.make("p"),
          launch: false,
          messageId: MessageId.make("msg-1"),
          text: "hello",
          attachments: [],
        },
      ],
    },
  });

  it("N11: a message the thread has outside the live window is dropped, not restored", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    // The live window holds only the latest messages; the whole history has msg-1 first.
    const latest = Array.from({ length: 300 }, (_, index) => `msg-${index + 2}`);
    const check = recovery(store, { t1: history(["msg-1", ...latest]) });
    await settle();
    expect(check.asked).toEqual(["t1"]);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(store.getDraft("t1").text).toBe("");
    expect(store.snapshot("t1").notice).toBeNull();
  });

  it("N11: a failed lookup keeps the record and asks again later", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    const answers: Record<string, ThreadLookup | Error> = { t1: new Error("socket closed") };
    const check = recovery(store, answers);
    await settle();
    expect(check.timers).toHaveLength(1);
    answers.t1 = { _tag: "unavailable" };
    await check.retry();
    expect(check.timers).toHaveLength(1);
    store.flush();
    expect(prefs.current.composerUnconfirmedSends).toHaveLength(1);
    expect(store.getDraft("t1").text).toBe("");
    answers.t1 = history([]);
    await check.retry();
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(store.getDraft("t1").text).toBe("hello");
  });

  it("N12: a deleted thread's message goes into a new-thread draft in its project, in one write", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    const check = recovery(store, { t1: history([], { deleted: true }) });
    await settle();
    expect(check.moved).toEqual(["hello -> p"]);
    expect(prefs.writes).toBe(1);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(prefs.current.draftThreadsByProjectId?.p?.id).toBe("minted-1");
    expect(prefs.current.composerDraftsByThreadId?.["minted-1"]?.text).toBe("hello");
    expect(store.snapshot("minted-1").notice).toBe(UNCONFIRMED_NOTICE);
    expect(store.getDraft("t1").text).toBe("");
  });

  it("N12: a thread the server no longer has counts as deleted", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    recovery(store, { t1: { _tag: "missing" } });
    await settle();
    expect(store.getNewThreadDraft("p")?.threadId).toBe("minted-1");
    expect(store.getDraft("minted-1").text).toBe("hello");
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
  });

  it("N12: with its project gone too, the record stays and /recover puts it in a composer", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    const check = recovery(store, { t1: history([], { deleted: true }) }, { projects: ["q"] });
    await settle();
    expect(check.orphaned).toEqual(["hello"]);
    expect(store.orphanedSends()).toHaveLength(1);
    expect(store.getNewThreadDraft("p")).toBeUndefined();
    store.flush();
    expect(prefs.current.composerUnconfirmedSends).toHaveLength(1);

    // Still there after a relaunch, and offered again.
    const relaunched = savingStore(prefs);
    const again = recovery(relaunched, { t1: { _tag: "missing" } }, { projects: ["q"] });
    await settle();
    expect(again.orphaned).toEqual(["hello"]);
    expect(recoverOrphanedSends(relaunched, ThreadId.make("t9"))).toBe(1);
    expect(relaunched.getDraft("t9").text).toBe("hello");
    expect(relaunched.snapshot("t9").notice).toBe(UNCONFIRMED_NOTICE);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(recoverOrphanedSends(relaunched, ThreadId.make("t9"))).toBe(0);
  });

  it("N12: waits for the shell before deciding a project is gone", async () => {
    const prefs = quitPrefs();
    const store = savingStore(prefs);
    const check = recovery(store, { t1: { _tag: "missing" } }, { projects: null });
    await settle();
    expect(check.orphaned).toEqual([]);
    expect(check.timers).toHaveLength(1);
    expect(store.unconfirmedSends()).toHaveLength(1);
  });

  it("N13: the restored note survives relaunches until the draft is edited", async () => {
    const prefs = quitPrefs();
    recovery(savingStore(prefs), { t1: history([]) });
    await settle();
    for (let relaunch = 0; relaunch < 2; relaunch += 1) {
      const relaunched = savingStore(prefs);
      expect(relaunched.unconfirmedSends()).toEqual([]);
      expect(relaunched.getDraft("t1").text).toBe("hello");
      expect(relaunched.snapshot("t1").notice).toBe(UNCONFIRMED_NOTICE);
    }
    const editing = savingStore(prefs);
    editing.setDraftText("t1", "hello again");
    editing.flush();
    expect(savingStore(prefs).snapshot("t1").notice).toBeNull();
    expect(prefs.current.composerDraftsByThreadId?.t1).toEqual({
      text: "hello again",
      attachments: [],
    });
  });

  it("N13: sending the restored draft drops its note", async () => {
    const prefs = quitPrefs();
    recovery(savingStore(prefs), { t1: history([]) });
    await settle();
    const relaunched = setup([], { store: savingStore(prefs) });
    await relaunched.sender.send(send({ commandId: CommandId.make("cmd-9"), text: "x" }));
    relaunched.store.flush();
    expect(prefs.current.composerDraftsByThreadId?.t1?.notice).toBeUndefined();
    expect(savingStore(prefs).snapshot("t1").notice).toBeNull();
  });
});

describe("composer sender, Sol audit round 5", () => {
  const approval: ComposerSettings = { ...threadSettings, runtimeMode: "approval-required" };
  const second = { commandId: CommandId.make("cmd-2"), messageId: MessageId.make("msg-2") };

  it("N14: after /discard drops a mode command in flight, the next send sets both modes", async () => {
    const modeReply = deferred();
    const { sender, calls, server } = setup([modeReply.promise]);
    server.settings = approval;
    // Full access for the first message; its mode command is in flight.
    void sender.send(send({ settings: threadSettings }));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1:runtime-mode"]);
    sender.hold("t1");
    expect(sender.discard("t1")).toEqual({ messages: 1, resumes: 0 });
    // The server may still apply full access. An approval-mode message must say so itself,
    // even though the shell already lists approval-required.
    await sender.send(send({ ...second, settings: approval }));
    expect(ids(calls)).toEqual([
      "cmd-1:runtime-mode",
      "cmd-2:runtime-mode",
      "cmd-2:interaction-mode",
      "cmd-2",
    ]);
    expect(calls[1]?.input).toMatchObject({ runtimeMode: "approval-required" });
    // The dropped reply arriving late changes nothing; later sends plan normally again.
    modeReply.resolve(ok);
    await settle();
    await sender.send(
      send({
        commandId: CommandId.make("cmd-3"),
        messageId: MessageId.make("msg-3"),
        settings: approval,
      }),
    );
    expect(ids(calls).slice(4)).toEqual(["cmd-3"]);
  });

  it("N12: a lost launch whose project is gone stays recoverable, even with its draft open", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const first = setup([never], { store: savingStore(prefs) });
    first.server.settings = null;
    const draft = first.store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    void first.sender.send(send({ target: { kind: "draft", ...draft }, text: "lost" }));
    await settle();
    first.sender.handOff();
    first.store.flush();

    const store = savingStore(prefs);
    // The draft is still listed as open, but project p is gone.
    expect(store.findNewThreadDraft("new-1")).toBeDefined();
    const check = recovery(store, { "new-1": { _tag: "missing" } }, { projects: ["q"] });
    await settle();
    expect(check.orphaned).toEqual(["lost"]);
    expect(store.orphanedSends()).toHaveLength(1);
    expect(recoverOrphanedSends(store, ThreadId.make("t9"))).toBe(1);
    expect(store.getDraft("t9").text).toBe("lost");
  });
  it("N15: an older launch record without a project id is checked against its draft's project", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const first = setup([never], { store: savingStore(prefs) });
    first.server.settings = null;
    const draft = first.store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    void first.sender.send(send({ target: { kind: "draft", ...draft }, text: "old" }));
    await settle();
    first.sender.handOff();
    first.store.flush();
    // As written before records carried a project id.
    prefs.current = {
      ...prefs.current,
      composerUnconfirmedSends: (prefs.current.composerUnconfirmedSends ?? []).map(
        ({ projectId: _projectId, ...record }) => record,
      ),
    };

    const store = savingStore(prefs);
    const check = recovery(store, { "new-1": { _tag: "missing" } }, { projects: ["q"] });
    await settle();
    expect(check.orphaned).toEqual(["old"]);
    expect(recoverOrphanedSends(store, ThreadId.make("t9"))).toBe(1);
    expect(store.getDraft("t9").text).toBe("old");
  });
});

describe("composer sender, PR 15 Sol audit round 1", () => {
  const second = { commandId: CommandId.make("cmd-2"), messageId: MessageId.make("msg-2") };

  it("S1: deleting a thread drops its held message, so quit leaves no draft or record for it", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise], { store: savingStore(prefs) });
    const first = sender.send(send());
    void sender.send(send({ ...second, text: "held" }));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    expect(sender.pendingCount({ threadIds: ["t1"] })).toBe(1);
    expect(sender.pendingCount({ threadIds: ["t2"] })).toBe(0);

    expect(sender.forget({ threadIds: ["t1"] })).toBe(1);
    expect(sender.pendingCount()).toBe(0);
    expect(store.snapshot("t1").sends).toEqual([]);
    await sender.retryWaiting();
    sender.handOff();
    store.flush();
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(prefs.current.composerDraftsByThreadId).toBeUndefined();
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
  });

  it("S1: a message in flight to a deleted thread is abandoned, not restored or saved at quit", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const { store, sender } = setup([new Promise<ComposerCommandResult>(() => undefined)], {
      store: savingStore(prefs),
    });
    const sending = sender.send(send());
    await settle();
    expect(sender.forget({ threadIds: ["t1"] })).toBe(1);
    await sending;
    sender.handOff();
    store.flush();
    expect(store.getDraft("t1").text).toBe("");
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
  });

  it("S1: removing a project drops messages to its threads the shell doesn't list yet", async () => {
    const { sender } = setup([new Promise<ComposerCommandResult>(() => undefined)]);
    const launch = send({
      target: { kind: "draft", threadId: ThreadId.make("draft-1"), projectId: ProjectId.make("p") },
    });
    void sender.send(launch);
    await settle();
    expect(sender.pendingCount({ threadIds: [], projectId: "p" })).toBe(1);
    expect(sender.pendingCount({ threadIds: [], projectId: "q" })).toBe(0);
    expect(sender.forget({ threadIds: [], projectId: "p" })).toBe(1);
    expect(sender.pendingCount()).toBe(0);
  });
});

describe("composer sender, worktree setup", () => {
  it("hands back queued messages, without sending them, once the thread's worktree is gone", async () => {
    let blocked: string | null = null;
    const { store, sender, calls } = setup([dropped], { blockedReason: () => blocked });
    await sender.send(send({ text: "one" }));
    await sender.send(send({ commandId: CommandId.make("cmd-2"), text: "two" }));
    expect(ids(calls)).toEqual(["cmd-1"]);
    // While they wait to reconnect, the thread's worktree setup fails.
    blocked = "Worktree setup failed";
    await sender.retryWaiting();
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(store.getDraft("t1").text).toBe("one\n\ntwo");
    expect(store.snapshot("t1").sends).toEqual([]);
    expect(store.snapshot("t1").notice).toBe("Worktree setup failed");
  });

  it("S1: checks every thread it has jobs for, whichever one is on screen", async () => {
    const blocked = new Map<string, string | null>();
    const { store, sender, calls, watched } = setup([dropped], {
      blockedReason: (threadId) => blocked.get(threadId) ?? null,
    });
    const other = {
      kind: "thread" as const,
      threadId: ThreadId.make("t2"),
      projectId: ProjectId.make("p"),
    };
    // A steer to t1 waits to reconnect; the user moves on to t2.
    await sender.send(send({ dispatch: "steer", text: "steer" }));
    expect(watched).toEqual(new Set(["t1"]));
    await sender.send(send({ target: other, commandId: CommandId.make("cmd-2") }));
    expect(ids(calls)).toEqual(["cmd-1", "cmd-2"]);
    // t1's worktree setup fails meanwhile. Nothing here knows which thread is selected.
    blocked.set("t1", "Worktree setup failed");
    await sender.retryWaiting();
    expect(ids(calls)).toEqual(["cmd-1", "cmd-2"]);
    expect(store.getDraft("t1").text).toBe("steer");
    expect(store.snapshot("t1").notice).toBe("Worktree setup failed");
    // Watching stops once the thread has nothing pending.
    expect(watched).toEqual(new Set());
  });

  it("S1: waits while the thread's runs aren't loaded, then asks again", async () => {
    let known = false;
    const { store, sender, calls, elapse } = setup([], {
      blockedReason: () => (known ? null : undefined),
    });
    await sender.send(send());
    expect(ids(calls)).toEqual([]);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["waiting"]);
    known = true;
    elapse(retryDelayMs(0));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1"]);
  });

  it("S2: never sends queue.resume while the thread's worktree isn't there", async () => {
    const { store, sender, calls } = setup([], { blockedReason: () => "Worktree setup failed" });
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(calls).toEqual([]);
    expect(store.snapshot("t1").notice).toBe("Worktree setup failed");
    expect(sender.pendingCount()).toBe(0);
  });

  it("S2: messages held by Stop go back, unreleased, once the worktree setup failed", async () => {
    let blocked: string | null = null;
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise], { blockedReason: () => blocked });
    const first = sender.send(send());
    void sender.send(send({ commandId: CommandId.make("cmd-2"), text: "two" }));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    blocked = "Worktree setup failed";
    sender.resume(ThreadId.make("t1"));
    await settle();
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(store.getDraft("t1").text).toBe("two");
    expect(store.snapshot("t1").notice).toBe("Worktree setup failed");
  });

  it("never holds back a draft's own launch, nor watches its thread before it exists", async () => {
    const launchReply = deferred();
    const { sender, calls, store, watched } = setup([launchReply.promise], {
      blockedReason: () => "blocked",
    });
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("new-1"));
    const target = { kind: "draft" as const, ...draft };
    const launched = sender.send(send({ target }));
    void sender.send(send({ target, commandId: CommandId.make("cmd-2"), text: "follow-up" }));
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(watched).toEqual(new Set());
    launchReply.resolve(ok);
    await launched;
    // The follow-up is checked once the launch made the thread.
    expect(ids(calls)).toEqual(["cmd-1"]);
    expect(store.getDraft("new-1").text).toBe("follow-up");
  });
});
