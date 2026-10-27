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

import { retryDelayMs, type ComposerSend, type PendingComposerSend } from "./composerSend.ts";
import {
  createComposerSender,
  DISCARD_NOTICE,
  MAYBE_SENT_NOTICE,
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
    readonly restore?: ReadonlyArray<PendingComposerSend>;
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
    schedule: (run, delayMs) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    ...(options.restore === undefined ? {} : { restore: options.restore }),
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
function savingStore(prefs: { current: TuiPrefs }) {
  return createComposerStore({
    initialPrefs: prefs.current,
    persist: (patch) => {
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

  it("N2: at quit, saves a send that may have reached the server and hands unsent ones back; the next launch resends it once, same ids", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const inFlight = deferred();
    const first = setup([inFlight.promise], { store: savingStore(prefs) });
    void first.sender.send(send());
    void first.sender.send(send({ ...second, text: "second" }));
    void first.sender.send(send({ ...third, text: "third" }));
    expect(ids(first.calls)).toEqual(["cmd-1"]);
    first.sender.handOff();
    first.store.flush();
    // The unsent ones are back in the composer, in order; the started one is saved as planned.
    expect(prefs.current.composerDraftsByThreadId?.t1?.text).toBe("second\n\nthird");
    expect(prefs.current.composerPendingSends).toMatchObject([
      { send: { commandId: "cmd-1", messageId: "msg-1", text: "hello" }, next: 0 },
    ]);
    // A second quit must not overwrite what the first saved.
    first.sender.handOff();
    first.store.flush();
    expect(prefs.current.composerPendingSends).toHaveLength(1);

    const relaunchedStore = savingStore(prefs);
    const relaunched = setup([], {
      store: relaunchedStore,
      restore: relaunchedStore.pendingSendsAtLaunch(),
    });
    expect(relaunched.store.snapshot("t1").sends).toMatchObject([{ status: "waiting" }]);
    expect(relaunched.store.getDraft("t1").text).toBe("second\n\nthird");
    // Connected: it goes out with the ids it had, so the server dedupes it.
    await relaunched.sender.retryWaiting();
    expect(relaunched.calls.map((call) => call.input)).toMatchObject([
      { commandId: "cmd-1", message: { messageId: "msg-1", text: "hello" } },
    ]);
    expect(relaunched.store.snapshot("t1").sends).toEqual([]);
    relaunched.sender.handOff();
    relaunched.store.flush();
    expect(prefs.current.composerPendingSends).toBeUndefined();
  });

  it("N2: a window that can't save prefs never picks up saved sends", () => {
    const store = createComposerStore({
      initialPrefs: {
        composerPendingSends: [{ send: send(), stages: [{ kind: "start-turn" }], next: 0 }],
      },
      persist: null,
    });
    expect(store.canPersist).toBe(false);
    expect(store.pendingSendsAtLaunch()).toEqual([]);
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
    expect(sender.resume("t1")).toBe(1);
    await settle();
    expect(ids(calls)).toEqual(["cmd-1", "cmd-2"]);
    expect(store.snapshot("t1").sends).toEqual([]);
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
    expect(ids(calls)).toEqual(["cmd-1", "cmd-2", "cmd-3"]);
  });

  it("N3: /discard puts held messages back in the composer", async () => {
    const inFlight = deferred();
    const { store, sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send({ text: "one" }));
    void sender.send(send({ ...second, text: "two" }));
    sender.hold("t1");
    inFlight.resolve(ok);
    await first;
    expect(sender.discard("t1")).toBe(1);
    expect(store.getDraft("t1").text).toBe("two");
    expect(store.snapshot("t1").notice).toBe(DISCARD_NOTICE);
    expect(store.snapshot("t1").sends).toEqual([]);
    sender.resume("t1");
    await settle();
    expect(ids(calls)).toEqual(["cmd-1"]);
  });

  it("N4: a command with no reply shows as stuck; /resume resends it with the same ids", async () => {
    const never = new Promise<ComposerCommandResult>(() => undefined);
    const { store, sender, calls, elapse } = setup([never]);
    void sender.send(send());
    void sender.send(send(second));
    elapse(30_000);
    expect(store.snapshot("t1").sends.map((entry) => entry.status)).toEqual(["stuck", "sending"]);
    sender.resume("t1");
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
    expect(sender.discard("t1")).toBe(2);
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
    expect(sender.discard("t1")).toBe(1);
    expect(timers).toHaveLength(0);
    expect(store.snapshot("t1").notice).toBe(MAYBE_SENT_NOTICE);
  });

  it("N4: leaves a command in flight alone on /discard while it isn't stuck", async () => {
    const inFlight = deferred();
    const { sender, calls } = setup([inFlight.promise]);
    const first = sender.send(send());
    expect(sender.discard("t1")).toBe(0);
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
