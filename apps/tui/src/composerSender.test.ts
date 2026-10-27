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

import * as Option from "effect/Option";

import {
  checkUnconfirmedSends,
  UNCONFIRMED_NOTICE,
  type ThreadMessagesState,
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
  options: { readonly store?: ComposerStore } = {},
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
  return { store, sender, calls, timers, server, elapse };
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
  const live = (...messageIds: Array<string>): ThreadMessagesState => ({
    status: "live",
    data: Option.some({ messages: messageIds.map((id) => ({ id: MessageId.make(id) })) }),
  });
  const statuses = (store: ComposerStore) =>
    store.snapshot("t1").sends.map((entry) => entry.status);
  const resumeIds = (calls: ReturnType<typeof setup>["calls"]) =>
    calls
      .filter((call) => call.kind === "queue.resume")
      .map((call) => (call.input as { commandId: string }).commandId);

  /** Thread state delivered by hand: `push` hands a thread's state to whoever watches it. */
  function threadWatcher() {
    const watchers = new Map<string, (state: ThreadMessagesState) => void>();
    return {
      watchThread: (threadId: ThreadId, onState: (state: ThreadMessagesState) => void) => {
        watchers.set(threadId, onState);
        return () => watchers.delete(threadId);
      },
      push: (threadId: string, state: ThreadMessagesState) => watchers.get(threadId)?.(state),
      watching: () => [...watchers.keys()],
    };
  }

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
      { threadId: "t1", launch: false, messageId: "msg-1", text: "hello", attachments: [] },
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

  it("drops a saved message the thread has, once its live state is in, leaving the composer alone", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    const watcher = threadWatcher();
    checkUnconfirmedSends({ store: relaunched.store, watchThread: watcher.watchThread });
    expect(watcher.watching()).toEqual(["t1"]);
    // Cached or still loading: not enough to tell.
    watcher.push("t1", { status: "cached", data: Option.none() });
    watcher.push("t1", { status: "synchronizing", data: Option.none() });
    expect(relaunched.store.unconfirmedSends()).toHaveLength(1);
    watcher.push("t1", live("msg-0", "msg-1"));
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("second");
    expect(watcher.watching()).toEqual([]);
    expect(relaunched.calls).toEqual([]);
  });

  it("puts a saved message the thread lacks back in the composer with a note, dropping the record in the same write", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    const watcher = threadWatcher();
    checkUnconfirmedSends({ store: relaunched.store, watchThread: watcher.watchThread });
    const writes = prefs.writes;
    watcher.push("t1", live("msg-0"));
    expect(prefs.writes).toBe((writes ?? 0) + 1);
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("hello\n\nsecond");
    expect(relaunched.store.snapshot("t1").notice).toBe(UNCONFIRMED_NOTICE);
    expect(relaunched.calls).toEqual([]);
  });

  it("N10: a restored message the user clears never comes back, even after a crash", async () => {
    const { prefs, relaunched } = await quitAndRelaunch();
    const watcher = threadWatcher();
    checkUnconfirmedSends({ store: relaunched.store, watchThread: watcher.watchThread });
    watcher.push("t1", live());
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
    const watcher = threadWatcher();
    checkUnconfirmedSends({ store, watchThread: watcher.watchThread });
    // The server never made new-1; client-runtime reports a thread it lacks as deleted.
    watcher.push("new-1", { status: "deleted", data: Option.none() });
    watcher.push("new-2", live("msg-2"));
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
