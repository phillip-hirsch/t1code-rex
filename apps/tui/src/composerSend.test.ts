import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
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
  buildStartTurnInput,
  chooseDispatch,
  classifySendFailure,
  settingsCommandsForSend,
  type ComposerSend,
} from "./composerSend.ts";
import type { ComposerSettings } from "./composerSettings.ts";

const codex: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

function send(overrides: Partial<ComposerSend> = {}): ComposerSend {
  return {
    target: {
      kind: "thread",
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
    },
    commandId: CommandId.make("cmd-1"),
    messageId: MessageId.make("msg-1"),
    text: "Fix the build",
    attachments: [],
    dispatch: "queue",
    settings: codex,
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("chooseDispatch", () => {
  it("queues on Enter and steers on Alt+Enter, whatever the cached run state says", () => {
    expect(chooseDispatch({ alternate: false })).toBe("queue");
    expect(chooseDispatch({ alternate: true })).toBe("steer");
  });

  it("keeps an explicit /queue or /steer even when the thread looks idle", () => {
    // A stale idle snapshot must not turn /queue into a dispatch that can steer a live run.
    expect(chooseDispatch({ alternate: false, requested: "queue" })).toBe("queue");
    expect(chooseDispatch({ alternate: false, requested: "steer" })).toBe("steer");
  });
});

describe("buildStartTurnInput", () => {
  it("sends a follow-up with the send's own ids and its model", () => {
    const input = buildStartTurnInput(send());
    expect(input).toMatchObject({
      commandId: "cmd-1",
      threadId: "thread-1",
      message: { messageId: "msg-1", role: "user", text: "Fix the build", attachments: [] },
      modelSelection: codex.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "queue",
    });
    expect(input.bootstrap).toBeUndefined();
  });

  it("launches a draft as a new thread with its first message", () => {
    const draft = send({
      target: { kind: "draft", threadId: ThreadId.make("new-1"), projectId: ProjectId.make("p") },
      settings: { ...codex, interactionMode: "plan" },
    });
    expect(buildStartTurnInput(draft)).toMatchObject({
      threadId: "new-1",
      titleSeed: "Fix the build",
      modelSelection: codex.modelSelection,
      bootstrap: {
        createThread: {
          projectId: "p",
          title: "Fix the build",
          modelSelection: codex.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
        },
      },
    });
  });
});

describe("settingsCommandsForSend", () => {
  it("changes only the modes that differ, with ids derived from the send", () => {
    expect(settingsCommandsForSend(send(), codex)).toEqual([]);
    expect(
      settingsCommandsForSend(
        send({ settings: { ...codex, runtimeMode: "approval-required", interactionMode: "plan" } }),
        codex,
      ),
    ).toEqual([
      { kind: "runtime-mode", commandId: "cmd-1:runtime-mode", value: "approval-required" },
      { kind: "interaction-mode", commandId: "cmd-1:interaction-mode", value: "plan" },
    ]);
  });

  it("changes nothing first for a draft, which launches with its settings", () => {
    const draft = send({
      target: { kind: "draft", threadId: ThreadId.make("new-1"), projectId: ProjectId.make("p") },
      settings: { ...codex, runtimeMode: "approval-required" },
    });
    expect(settingsCommandsForSend(draft, codex)).toEqual([]);
  });
});

describe("classifySendFailure", () => {
  it("retries dropped connections and hands back what the server rejected", () => {
    expect(
      classifySendFailure(
        new EnvironmentRpcUnavailableError({ environmentId: "env", message: "offline" }),
        false,
      ),
    ).toBe("retry");
    expect(classifySendFailure(new Error("Socket is not connected"), false)).toBe("retry");
    expect(classifySendFailure(new Error("anything"), true)).toBe("retry");
    expect(
      classifySendFailure(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make("cmd-1"),
          commandType: "message.dispatch",
          message: "Model not available",
        }),
        false,
      ),
    ).toBe("restore");
  });
});
