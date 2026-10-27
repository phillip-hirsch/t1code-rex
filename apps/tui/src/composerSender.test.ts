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
    dispatch: "auto",
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

/**
 * The real sender and store, with the server side scripted: each command returns the next
 * scripted result. Retry timers queue up and run when the test says so.
 */
function setup(script: ReadonlyArray<ComposerCommandResult>) {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const results = [...script];
  const calls: Array<{
    readonly kind: string;
    readonly commandId: string;
    readonly input: unknown;
  }> = [];
  const timers: Array<() => void> = [];
  const respond = (kind: string, commandId: string | undefined, input: unknown) => {
    calls.push({ kind, commandId: commandId ?? "", input });
    return Promise.resolve(results.shift() ?? ok);
  };
  const sender = createComposerSender({
    store,
    startTurn: (input: StartThreadTurnInput) => respond("start-turn", input.commandId, input),
    setRuntimeMode: (input) => respond("runtime-mode", input.commandId, input),
    setInteractionMode: (input) => respond("interaction-mode", input.commandId, input),
    threadSettings: () => threadSettings,
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  return { store, sender, calls, timers };
}

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
