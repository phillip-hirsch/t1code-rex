import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/state/threads";
import type { ThreadId } from "@t3tools/contracts";

import {
  buildStartTurnInput,
  classifySendFailure,
  describeSendFailure,
  retryDelayMs,
  settingsCommandsForSend,
  type ComposerSend,
} from "./composerSend.ts";
import { normalizeSettingsPatch, type ComposerSettings } from "./composerSettings.ts";
import type { ComposerStore } from "./composerStore.ts";

export type ComposerCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly interrupted: boolean };

export interface ComposerSenderOptions {
  readonly store: ComposerStore;
  readonly startTurn: (input: StartThreadTurnInput) => Promise<ComposerCommandResult>;
  readonly setRuntimeMode: (input: SetThreadRuntimeModeInput) => Promise<ComposerCommandResult>;
  readonly setInteractionMode: (
    input: SetThreadInteractionModeInput,
  ) => Promise<ComposerCommandResult>;
  /** The thread's settings on the server right now; null for threads the shell hasn't listed. */
  readonly threadSettings: (threadId: ThreadId) => ComposerSettings | null;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly onFailure?: (send: ComposerSend, error: unknown, action: "retry" | "restore") => void;
}

/**
 * Delivers composer sends. A send keeps its command and message ids across retries, so a
 * reply lost to a dropped connection can't start a second run: the server answers the
 * repeat from its command receipt.
 */
export function createComposerSender(options: ComposerSenderOptions) {
  const { store } = options;
  const inFlight = new Set<string>();
  const timers = new Map<string, () => void>();
  let disposed = false;

  const runSettings = async (send: ComposerSend): Promise<ComposerCommandResult> => {
    const thread = options.threadSettings(send.target.threadId);
    for (const command of settingsCommandsForSend(send, thread)) {
      const result =
        command.kind === "runtime-mode"
          ? await options.setRuntimeMode({
              commandId: command.commandId,
              threadId: send.target.threadId,
              runtimeMode: command.value,
              createdAt: send.createdAt,
            })
          : await options.setInteractionMode({
              commandId: command.commandId,
              threadId: send.target.threadId,
              interactionMode: command.value,
              createdAt: send.createdAt,
            });
      if (!result.ok) return result;
    }
    return { ok: true };
  };

  const attempt = async (send: ComposerSend, attemptNumber: number) => {
    const key = send.commandId;
    if (disposed || inFlight.has(key)) return;
    inFlight.add(key);
    timers.get(key)?.();
    timers.delete(key);
    if (attemptNumber > 0) store.updateSend(send, "sending", attemptNumber);
    let result = await runSettings(send);
    if (result.ok) {
      result = await options.startTurn(
        buildStartTurnInput(send, options.threadSettings(send.target.threadId)),
      );
    }
    inFlight.delete(key);
    if (disposed) return;
    if (result.ok) {
      store.finishSend(send);
      const threadId = send.target.threadId;
      if (send.target.kind === "draft") store.closeNewThreadDraft(threadId);
      const patch = store.getPatch(threadId);
      if (patch !== undefined) {
        store.setPatch(threadId, normalizeSettingsPatch(send.settings, patch), send.settings);
      }
      return;
    }
    const action = classifySendFailure(result.error, result.interrupted);
    options.onFailure?.(send, result.error, action);
    if (action === "restore") {
      store.restoreSend(send, describeSendFailure(result.error));
      return;
    }
    store.updateSend(send, "waiting", attemptNumber + 1);
    timers.set(
      key,
      options.schedule(() => void attempt(send, attemptNumber + 1), retryDelayMs(attemptNumber)),
    );
  };

  return {
    /** Resolves when this attempt settles; a retry may still follow. */
    send(send: ComposerSend): Promise<void> {
      store.beginSend(send);
      return attempt(send, 0);
    },
    /** Retries waiting sends now, e.g. once the connection is back. */
    retryWaiting(): Promise<void> {
      return Promise.all(
        store.sendsWaiting().map((entry) => attempt(entry.send, entry.attempt)),
      ).then(() => undefined);
    },
    dispose() {
      disposed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },
  };
}

export type ComposerSender = ReturnType<typeof createComposerSender>;
