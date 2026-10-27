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

import type { ComposerSend } from "./composerSend.ts";
import { createComposerSender, type ComposerCommandResult } from "./composerSender.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore } from "./composerStore.ts";

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
 * scripted result, or waits on a scripted deferred reply. Retry timers queue up and run
 * when the test says so. `server.settings` is what the shell lists for the thread now.
 */
function setup(script: ReadonlyArray<ComposerCommandResult | Promise<ComposerCommandResult>>) {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const results = [...script];
  const calls: Array<{
    readonly kind: string;
    readonly commandId: string;
    readonly input: unknown;
  }> = [];
  const timers: Array<() => void> = [];
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
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  return { store, sender, calls, timers, server };
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
