// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- Sends are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  MessageId,
  type ProjectId,
  type ThreadId,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import type { ComposerSettings } from "./composerSettings.ts";

/** Where a send goes: an existing thread, or a new-thread draft that launches on first send. */
export type ComposerTarget =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly projectId: ProjectId }
  | { readonly kind: "draft"; readonly threadId: ThreadId; readonly projectId: ProjectId };

export type ComposerAttachment = UploadChatImageAttachment & { readonly id: string };

export type ComposerDispatch = "auto" | "queue" | "steer";

/**
 * Enter starts a run, or queues behind the one in progress; Alt+Enter steers it instead.
 * The server still decides when steering isn't possible yet (it queues).
 */
export function chooseDispatch(input: {
  readonly running: boolean;
  readonly alternate: boolean;
  readonly requested?: "queue" | "steer";
}): ComposerDispatch {
  if (input.requested !== undefined) return input.running ? input.requested : "auto";
  const mode = resolveComposerDispatchMode({
    running: input.running,
    alternateModifier: input.alternate,
    activeTurnDefault: "queue",
  });
  return mode === "restart" ? "steer" : mode;
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

/** Mode changes a send applies first, each with an id derived from the send's own. */
export function settingsCommandsForSend(
  send: ComposerSend,
  thread: ComposerSettings | null,
): ReadonlyArray<
  | {
      readonly kind: "runtime-mode";
      readonly commandId: CommandId;
      readonly value: ComposerSettings["runtimeMode"];
    }
  | {
      readonly kind: "interaction-mode";
      readonly commandId: CommandId;
      readonly value: ComposerSettings["interactionMode"];
    }
> {
  // A new thread launches with its settings; nothing to change first.
  if (send.target.kind === "draft" || thread === null) return [];
  const commands = [];
  if (send.settings.runtimeMode !== thread.runtimeMode) {
    commands.push({
      kind: "runtime-mode" as const,
      commandId: CommandId.make(`${send.commandId}:runtime-mode`),
      value: send.settings.runtimeMode,
    });
  }
  if (send.settings.interactionMode !== thread.interactionMode) {
    commands.push({
      kind: "interaction-mode" as const,
      commandId: CommandId.make(`${send.commandId}:interaction-mode`),
      value: send.settings.interactionMode,
    });
  }
  return commands;
}

/** The start-turn input for a send; a draft target launches its thread with this message. */
export function buildStartTurnInput(
  send: ComposerSend,
  thread: ComposerSettings | null,
): StartThreadTurnInput {
  const { target, settings } = send;
  const titleSeed = deriveThreadTitleSeed({ text: send.text, attachments: send.attachments });
  const modelChanged =
    thread === null || !modelSelectionsEqual(thread.modelSelection, settings.modelSelection);
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
    ...(target.kind === "draft" || modelChanged ? { modelSelection: settings.modelSelection } : {}),
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
