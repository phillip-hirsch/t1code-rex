import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  MessageId,
  OrchestrationV2DispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerSend } from "./composerSend.ts";
import { createComposerSender, type ComposerCommandResult } from "./composerSender.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore } from "./composerStore.ts";
import { createRedirectingSender, type RedirectApproval } from "./requestRedirect.ts";
import { createRequestResponder } from "./requestResponder.ts";

const threadId = ThreadId.make("t1");
const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const ok: ComposerCommandResult = { ok: true };
const rejected: ComposerCommandResult = {
  ok: false,
  error: new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("cmd-x"),
    commandType: "runtime-request.respond",
    message: "Runtime request a1 is resolved.",
  }),
  interrupted: false,
};

function send(text = "use a different file"): ComposerSend {
  return {
    target: { kind: "thread", threadId, projectId: ProjectId.make("p") },
    commandId: CommandId.make("cmd-send"),
    messageId: MessageId.make("msg-1"),
    text,
    attachments: [],
    dispatch: "queue",
    settings,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
}

/**
 * The real composer store, sender and responder, with only the server's replies scripted.
 * `log` records commands in the order they reach the server.
 */
function setup(options: {
  shown: ReadonlyArray<RedirectApproval>;
  pending?: () => ReadonlyArray<RuntimeRequestId>;
  decline?: ComposerCommandResult;
}) {
  const log: string[] = [];
  const turns: StartThreadTurnInput[] = [];
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      log.push(`turn:${input.dispatchMode ?? "?"}`);
      turns.push(input);
      return Promise.resolve(ok);
    },
    setRuntimeMode: () => Promise.resolve(ok),
    setInteractionMode: () => Promise.resolve(ok),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  const responder = createRequestResponder({
    respondToApproval: (input) => {
      log.push(`${input.decision}:${input.requestId}`);
      return Promise.resolve(options.decline ?? ok);
    },
    respondToUserInput: () => Promise.resolve(ok),
    dismissUserInput: () => Promise.resolve(ok),
    schedule: () => () => undefined,
  });
  const redirecting = createRedirectingSender({
    sender,
    store,
    responder,
    shownApprovals: () => options.shown,
    pendingApprovalIds:
      options.pending ?? (() => options.shown.map((approval) => approval.requestId)),
  });
  return { log, turns, store, redirecting };
}

const a1 = RuntimeRequestId.make("a1");
const a2 = RuntimeRequestId.make("a2");

describe("createRedirectingSender", () => {
  it("sends as usual with no approval shown", async () => {
    const { log, redirecting } = setup({ shown: [] });
    await redirecting.send(send());
    expect(log).toEqual(["turn:queue"]);
  });

  it("declines the shown approvals, then steers the run with the message", async () => {
    const { log, turns, store, redirecting } = setup({
      shown: [
        { requestId: a1, live: true },
        { requestId: a2, live: true },
      ],
    });
    await redirecting.send(send());
    expect(log).toEqual(["decline:a1", "decline:a2", "turn:steer"]);
    expect(turns[0]?.message.text).toBe("use a different file");
    expect(store.snapshot(threadId).sends).toEqual([]);
  });

  it("never approves, and skips an approval the provider can no longer answer", async () => {
    const { log, redirecting } = setup({ shown: [{ requestId: a1, live: false }] });
    await redirecting.send(send());
    expect(log).toEqual(["turn:queue"]);
  });

  it("puts the message back when a decline is turned down", async () => {
    const { log, store, redirecting } = setup({
      shown: [{ requestId: a1, live: true }],
      decline: rejected,
    });
    await redirecting.send(send());
    expect(log).toEqual(["decline:a1"]);
    expect(store.getDraft(threadId).text).toBe("use a different file");
    expect(store.snapshot(threadId).notice).toMatch(/^Not sent: declining the approval/);
    expect(store.snapshot(threadId).sends).toEqual([]);
  });

  it("puts the message back when another approval arrives during the decline", async () => {
    let pending: ReadonlyArray<RuntimeRequestId> = [a1];
    const { log, store, redirecting } = setup({
      shown: [{ requestId: a1, live: true }],
      pending: () => pending,
    });
    const sent = redirecting.send(send());
    pending = [a1, a2];
    await sent;
    expect(log).toEqual(["decline:a1"]);
    expect(store.getDraft(threadId).text).toBe("use a different file");
    expect(store.snapshot(threadId).notice).toMatch(/another approval came in/);
  });
});
