import {
  CommandId,
  OrchestrationV2DispatchCommandError,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerCommandResult } from "./composerSender.ts";
import { createRequestResponder } from "./requestResponder.ts";

const threadId = ThreadId.make("t1");
const requestId = RuntimeRequestId.make("r1");
const ok: ComposerCommandResult = { ok: true };
const dropped: ComposerCommandResult = {
  ok: false,
  error: new Error("Socket is not connected"),
  interrupted: false,
};
const alreadyResolved: ComposerCommandResult = {
  ok: false,
  error: new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("cmd-1"),
    commandType: "runtime-request.respond",
    message: "Runtime request r1 is resolved.",
  }),
  interrupted: false,
};

/**
 * The real responder with the server side scripted: each command returns the next result.
 * Retry timers queue up and run when the test says so.
 */
function setup(script: ReadonlyArray<ComposerCommandResult>) {
  const results = [...script];
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];
  let ids = 0;
  const reply = (kind: string) => (input: object) => {
    calls.push({ kind, input: { ...input } });
    return Promise.resolve(results.shift() ?? ok);
  };
  const responder = createRequestResponder({
    respondToApproval: reply("approval"),
    respondToUserInput: reply("answers"),
    dismissUserInput: reply("dismiss"),
    newCommandId: () => CommandId.make(`cmd-${(ids += 1)}`),
    schedule: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index !== -1) timers.splice(index, 1);
      };
    },
  });
  return { responder, calls, timers, settle: () => responder.settled() };
}

describe("createRequestResponder", () => {
  it("sends a decision once, however often it's asked", async () => {
    const { responder, calls, settle } = setup([ok]);
    expect(responder.respond(threadId, requestId, { type: "approval", decision: "accept" })).toBe(
      true,
    );
    expect(responder.status(requestId)?.state).toBe("sending");
    expect(responder.respond(threadId, requestId, { type: "approval", decision: "decline" })).toBe(
      false,
    );
    await settle();
    expect(responder.status(requestId)?.state).toBe("sent");
    expect(responder.respond(threadId, requestId, { type: "approval", decision: "decline" })).toBe(
      false,
    );
    expect(calls).toEqual([
      {
        kind: "approval",
        input: { commandId: "cmd-1", threadId: "t1", requestId: "r1", decision: "accept" },
      },
    ]);
  });

  it("retries a response that lost the connection with the same command id", async () => {
    const { responder, calls, timers, settle } = setup([dropped, dropped, ok]);
    responder.respond(threadId, requestId, { type: "answers", answers: { q1: "Blue" } });
    await settle();
    expect(responder.status(requestId)).toMatchObject({ state: "waiting", attempt: 1 });
    timers.shift()?.();
    await settle();
    expect(responder.status(requestId)).toMatchObject({ state: "waiting", attempt: 2 });
    // The connection comes back before the timer fires; the timer is dropped.
    responder.retryWaiting();
    expect(timers).toHaveLength(0);
    await settle();
    expect(responder.status(requestId)?.state).toBe("sent");
    expect(calls.map((call) => call.input.commandId)).toEqual(["cmd-1", "cmd-1", "cmd-1"]);
    expect(calls[0]?.input.answers).toEqual({ q1: "Blue" });
  });

  it("reports a rejection and takes a new answer, with a new id", async () => {
    const { responder, calls, settle } = setup([alreadyResolved, ok]);
    responder.respond(threadId, requestId, { type: "dismiss" });
    await settle();
    expect(responder.status(requestId)).toEqual({
      state: "failed",
      response: { type: "dismiss" },
      error: "Runtime request r1 is resolved.",
    });
    expect(responder.respond(threadId, requestId, { type: "dismiss" })).toBe(true);
    await settle();
    expect(calls.map((call) => [call.kind, call.input.commandId])).toEqual([
      ["dismiss", "cmd-1"],
      ["dismiss", "cmd-2"],
    ]);
  });

  it("forgets a thread's requests that resolved elsewhere, retries included", async () => {
    const { responder, timers, settle } = setup([dropped]);
    responder.respond(threadId, requestId, { type: "approval", decision: "accept" });
    const other = RuntimeRequestId.make("r2");
    responder.respond(ThreadId.make("t2"), other, { type: "approval", decision: "accept" });
    await settle();
    expect(timers).toHaveLength(1);
    responder.prune(threadId, []);
    expect(timers).toHaveLength(0);
    expect(responder.status(requestId)).toBeNull();
    expect(responder.status(other)?.state).toBe("sent");
  });

  it("drops a reply that lands after its request resolved", async () => {
    let release!: (result: ComposerCommandResult) => void;
    const responder = createRequestResponder({
      respondToApproval: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      respondToUserInput: () => Promise.resolve(ok),
      dismissUserInput: () => Promise.resolve(ok),
      schedule: () => () => undefined,
    });
    responder.respond(threadId, requestId, { type: "approval", decision: "accept" });
    responder.prune(threadId, []);
    release(alreadyResolved);
    await responder.settled();
    expect(responder.status(requestId)).toBeNull();
  });
});
