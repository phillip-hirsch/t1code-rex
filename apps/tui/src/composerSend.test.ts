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
    dispatch: "auto",
    settings: codex,
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("chooseDispatch", () => {
  it("starts when idle, queues behind a run, and steers with the alternate key", () => {
    expect(chooseDispatch({ running: false, alternate: false })).toBe("auto");
    expect(chooseDispatch({ running: false, alternate: true })).toBe("auto");
    expect(chooseDispatch({ running: true, alternate: false })).toBe("queue");
    expect(chooseDispatch({ running: true, alternate: true })).toBe("steer");
    expect(chooseDispatch({ running: true, alternate: false, requested: "steer" })).toBe("steer");
    expect(chooseDispatch({ running: false, alternate: false, requested: "queue" })).toBe("auto");
  });
});

describe("buildStartTurnInput", () => {
  it("sends a follow-up with the send's own ids and no model change", () => {
    const input = buildStartTurnInput(send(), codex);
    expect(input).toMatchObject({
      commandId: "cmd-1",
      threadId: "thread-1",
      message: { messageId: "msg-1", role: "user", text: "Fix the build", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "auto",
    });
    expect(input.modelSelection).toBeUndefined();
    expect(input.bootstrap).toBeUndefined();
  });

  it("carries a picked model with the message", () => {
    const claude = {
      ...codex,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-5-5",
      },
    };
    expect(buildStartTurnInput(send({ settings: claude }), codex).modelSelection).toEqual(
      claude.modelSelection,
    );
  });

  it("launches a draft as a new thread with its first message", () => {
    const draft = send({
      target: { kind: "draft", threadId: ThreadId.make("new-1"), projectId: ProjectId.make("p") },
      settings: { ...codex, interactionMode: "plan" },
    });
    expect(buildStartTurnInput(draft, null)).toMatchObject({
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
