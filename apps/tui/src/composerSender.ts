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
  type ComposerSettingsCommand,
} from "./composerSend.ts";
import { normalizeSettingsPatch, type ComposerSettings } from "./composerSettings.ts";
import type { ComposerSendStatus, ComposerStore } from "./composerStore.ts";

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

type Stage =
  | ComposerSettingsCommand
  | { readonly kind: "start-turn"; readonly input: StartThreadTurnInput };

/** A send and the commands it was planned to issue, frozen when it was sent. */
interface Job {
  readonly send: ComposerSend;
  readonly stages: ReadonlyArray<Stage>;
  /** Stages before this one were accepted; a retry resumes here. */
  next: number;
  attempt: number;
  status: ComposerSendStatus;
}

interface ThreadQueue {
  readonly jobs: Array<Job>;
  /** Set while a drain loop owns the queue. */
  draining: Promise<void> | null;
  /** The head lost the connection; set while its retry waits. */
  cancelRetry: (() => void) | null;
}

const OK: ComposerCommandResult = { ok: true };

/**
 * Delivers sends in order, one at a time per thread. Each send's commands and ids are planned
 * once, when sent; a retry resumes that plan, so a lost reply can't double-send or overwrite
 * a mode picked since (the server answers a repeated id from its command receipt).
 */
export function createComposerSender(options: ComposerSenderOptions) {
  const { store } = options;
  const queues = new Map<string, ThreadQueue>();
  /** Draft threads this sender launched, and the settings each went out with. */
  const launched = new Map<string, ComposerSettings>();
  let disposed = false;

  const mark = (job: Job, status: ComposerSendStatus) => {
    if (job.status === status) return;
    job.status = status;
    store.updateSend(job.send, status, job.attempt);
  };

  const plan = (send: ComposerSend, queue: ThreadQueue | undefined): Job => {
    const threadId = send.target.threadId;
    const ahead = queue?.jobs.at(-1);
    // A draft whose launch is queued or done gets follow-ups, not a second launch.
    const launching =
      launched.has(threadId) ||
      (queue?.jobs.some((job) => job.send.target.kind === "draft") ?? false);
    const planned: ComposerSend =
      send.target.kind === "draft" && launching
        ? { ...send, target: { ...send.target, kind: "thread" } }
        : send;
    const base =
      ahead?.send.settings ?? options.threadSettings(threadId) ?? launched.get(threadId) ?? null;
    return {
      send: planned,
      stages: [
        ...settingsCommandsForSend(planned, base),
        { kind: "start-turn", input: buildStartTurnInput(planned) },
      ],
      next: 0,
      attempt: 0,
      status: "sending",
    };
  };

  const runStage = (send: ComposerSend, stage: Stage): Promise<ComposerCommandResult> => {
    const threadId = send.target.threadId;
    switch (stage.kind) {
      case "runtime-mode":
        return options.setRuntimeMode({
          commandId: stage.commandId,
          threadId,
          runtimeMode: stage.value,
          createdAt: send.createdAt,
        });
      case "interaction-mode":
        return options.setInteractionMode({
          commandId: stage.commandId,
          threadId,
          interactionMode: stage.value,
          createdAt: send.createdAt,
        });
      case "start-turn":
        return options.startTurn(stage.input);
    }
  };

  const runJob = async (job: Job): Promise<ComposerCommandResult> => {
    mark(job, "sending");
    for (; job.next < job.stages.length; job.next += 1) {
      const stage = job.stages[job.next];
      if (stage === undefined) break;
      const result = await runStage(job.send, stage).catch(
        (error: unknown): ComposerCommandResult => ({ ok: false, error, interrupted: false }),
      );
      if (!result.ok) return result;
    }
    return OK;
  };

  const finish = (job: Job) => {
    const { send } = job;
    const threadId = send.target.threadId;
    store.finishSend(send);
    if (send.target.kind === "draft") {
      launched.set(threadId, send.settings);
      store.closeNewThreadDraft(threadId);
    }
    const patch = store.getPatch(threadId);
    if (patch !== undefined) {
      store.setPatch(threadId, normalizeSettingsPatch(send.settings, patch), send.settings);
    }
  };

  /** Sends the queue's jobs in order until it empties, one is rejected, or the connection drops. */
  const drain = (threadId: string, queue: ThreadQueue): Promise<void> => {
    if (queue.draining !== null) return queue.draining;
    if (disposed || queue.jobs.length === 0) return Promise.resolve();
    queue.cancelRetry?.();
    queue.cancelRetry = null;
    const loop = async () => {
      try {
        for (let job = queue.jobs[0]; job !== undefined; job = queue.jobs[0]) {
          if (disposed) break;
          const result = await runJob(job);
          if (disposed) break;
          if (result.ok) {
            queue.jobs.shift();
            finish(job);
            continue;
          }
          const action = classifySendFailure(result.error, result.interrupted);
          options.onFailure?.(job.send, result.error, action);
          if (action === "restore") {
            // What waited behind it was planned on top of it: all of it goes back, in order.
            const notice = describeSendFailure(result.error);
            for (const entry of queue.jobs.splice(0).reverse()) {
              store.restoreSend(entry.send, notice);
            }
            break;
          }
          job.attempt += 1;
          for (const entry of queue.jobs) {
            entry.status = "waiting";
            store.updateSend(entry.send, "waiting", entry.attempt);
          }
          queue.cancelRetry = options.schedule(
            () => void drain(threadId, queue),
            retryDelayMs(job.attempt - 1),
          );
          break;
        }
      } finally {
        // Runs in the same tick as the loop's last check, so no send can slip in between.
        queue.draining = null;
        if (queue.jobs.length === 0 && queues.get(threadId) === queue) queues.delete(threadId);
      }
    };
    queue.draining = loop();
    return queue.draining;
  };

  return {
    /** Resolves when the thread's queue settles; a retry may still follow. */
    send(send: ComposerSend): Promise<void> {
      const threadId = send.target.threadId;
      const existing = queues.get(threadId);
      const job = plan(send, existing);
      const queue: ThreadQueue = existing ?? { jobs: [], draining: null, cancelRetry: null };
      queues.set(threadId, queue);
      queue.jobs.push(job);
      store.beginSend(job.send);
      if (queue.cancelRetry !== null) {
        // The connection is down; this one waits behind the retry.
        mark(job, "waiting");
        return Promise.resolve();
      }
      return drain(threadId, queue);
    },
    /** Retries waiting sends now, e.g. once the connection is back. */
    retryWaiting(): Promise<void> {
      return Promise.all(
        [...queues]
          .filter(([, queue]) => queue.cancelRetry !== null)
          .map(([threadId, queue]) => drain(threadId, queue)),
      ).then(() => undefined);
    },
    dispose() {
      disposed = true;
      for (const queue of queues.values()) queue.cancelRetry?.();
      queues.clear();
    },
  };
}

export type ComposerSender = ReturnType<typeof createComposerSender>;
