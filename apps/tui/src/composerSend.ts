// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- Sends are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  MessageId,
  type ProjectId,
  type ThreadId,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";

import type { ComposerSettings } from "./composerSettings.ts";

/** Where a send goes: an existing thread, or a new-thread draft that launches on first send. */
export type ComposerTarget =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly projectId: ProjectId }
  | { readonly kind: "draft"; readonly threadId: ThreadId; readonly projectId: ProjectId };

export type ComposerAttachment = UploadChatImageAttachment & { readonly id: string };

/**
 * How a message meets a run in progress. Enter queues behind it and Alt+Enter steers it; on
 * an idle thread both start a run (client-runtime and the server resolve that, from the
 * thread's live state). So the choice never depends on the TUI's cached run state, which
 * can be stale: an explicit `/queue` must never become a dispatch that steers a live run.
 */
export type ComposerDispatch = "queue" | "steer";

export function chooseDispatch(input: {
  readonly alternate: boolean;
  readonly requested?: ComposerDispatch;
}): ComposerDispatch {
  return input.requested ?? (input.alternate ? "steer" : "queue");
}

/** One message on its way to the server. Its ids stay fixed, so a retry can't double-send. */
export interface ComposerSend {
  readonly target: ComposerTarget;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ComposerAttachment>;
  readonly dispatch: ComposerDispatch;
  readonly settings: ComposerSettings;
  readonly createdAt: string;
}

/** A new send with fresh ids, stamped now. */
export function createComposerSend(
  input: Omit<ComposerSend, "commandId" | "messageId" | "createdAt">,
): ComposerSend {
  return {
    ...input,
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    messageId: MessageId.make(NodeCrypto.randomUUID()),
    createdAt: new Date().toISOString(),
  };
}

export type ComposerSettingsCommand =
  | {
      readonly kind: "runtime-mode";
      readonly commandId: CommandId;
      readonly value: ComposerSettings["runtimeMode"];
    }
  | {
      readonly kind: "interaction-mode";
      readonly commandId: CommandId;
      readonly value: ComposerSettings["interactionMode"];
    };

/**
 * Mode changes a send applies first, each with an id derived from the send's own. `base` is
 * what the thread will have when the send goes out: the thread's settings now, or those of
 * the send queued ahead of it.
 */
export function settingsCommandsForSend(
  send: ComposerSend,
  base: ComposerSettings | null,
): ReadonlyArray<ComposerSettingsCommand> {
  // A new thread launches with its settings; nothing to change first.
  if (send.target.kind === "draft" || base === null) return [];
  const commands: Array<ComposerSettingsCommand> = [];
  if (send.settings.runtimeMode !== base.runtimeMode) {
    commands.push({
      kind: "runtime-mode",
      commandId: CommandId.make(`${send.commandId}:runtime-mode`),
      value: send.settings.runtimeMode,
    });
  }
  if (send.settings.interactionMode !== base.interactionMode) {
    commands.push({
      kind: "interaction-mode",
      commandId: CommandId.make(`${send.commandId}:interaction-mode`),
      value: send.settings.interactionMode,
    });
  }
  return commands;
}

/**
 * The start-turn input for a send; a draft target launches its thread with this message.
 * The model always rides along: the thread's cached model can lag behind a send that
 * switched it, so leaving it out could run this message on the wrong one.
 */
export function buildStartTurnInput(send: ComposerSend): StartThreadTurnInput {
  const { target, settings } = send;
  const titleSeed = deriveThreadTitleSeed({ text: send.text, attachments: send.attachments });
  return {
    commandId: send.commandId,
    createdAt: send.createdAt,
    threadId: target.threadId,
    message: {
      messageId: send.messageId,
      role: "user",
      text: send.text,
      attachments: send.attachments,
    },
    modelSelection: settings.modelSelection,
    titleSeed,
    runtimeMode: settings.runtimeMode,
    interactionMode: settings.interactionMode,
    dispatchMode: send.dispatch,
    ...(target.kind === "draft"
      ? {
          bootstrap: {
            createThread: {
              projectId: target.projectId,
              title: titleSeed,
              modelSelection: settings.modelSelection,
              runtimeMode: settings.runtimeMode,
              interactionMode: settings.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: send.createdAt,
            },
          },
        }
      : {}),
  };
}

const RETRYABLE_TAGS = new Set([
  "ConnectionTransientError",
  "RpcClientError",
  "EnvironmentRpcUnavailableError",
  "EnvironmentNotRegisteredError",
]);

/**
 * Whether a failed send should be retried with the same ids (the connection dropped) or
 * handed back to the composer (the server rejected it).
 */
export function classifySendFailure(error: unknown, interrupted: boolean): "retry" | "restore" {
  if (interrupted) return "retry";
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (RETRYABLE_TAGS.has(String(error._tag))) return "retry";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : typeof error === "string"
          ? error
          : null;
  return isTransportConnectionErrorMessage(message) ? "retry" : "restore";
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000;
}

/** A readable reason for a send the server turned down. */
export function describeSendFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message).trim();
    if (message.length > 0) return message;
  }
  return error instanceof Error ? error.message : "The message could not be sent.";
}
