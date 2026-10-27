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
  type ComposerStage,
  type PendingComposerSend,
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
  /** The thread's settings as the shell lists them now; null for threads it doesn't list. */
  readonly threadSettings: (threadId: ThreadId) => ComposerSettings | null;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** Sends saved at the last quit that may have reached the server; they go out again. */
  readonly restore?: ReadonlyArray<PendingComposerSend>;
  /**
   * Releases the queue the server holds after Stop. Called before messages Stop held here
   * go out, so the server's held runs (sent earlier) stay ahead of them.
   */
  readonly resumeQueue?: (threadId: ThreadId) => Promise<unknown>;
  /** How long a command may go unanswered before its send shows as stuck. */
  readonly stallMs?: number;
  readonly onFailure?: (
    send: ComposerSend,
    error: unknown,
    action: "retry" | "restore" | "stuck",
  ) => void;
}

/** A send and the commands it was planned to issue, frozen when it was sent. */
interface Job {
  readonly send: ComposerSend;
  readonly stages: ReadonlyArray<ComposerStage>;
  /** Stages before this one were accepted; a retry resumes here. */
  next: number;
  attempt: number;
  /** A command went out, so the server may have it: quitting saves it instead of handing it back. */
  started: boolean;
  /** The message itself went out unconfirmed: dropping it now may leave it sent. */
  dispatched: boolean;
  status: ComposerSendStatus;
  /** Set while a command is in flight; stops waiting on it (to resend, or to drop it). */
  abandon: (() => void) | null;
}

interface ThreadQueue {
  readonly jobs: Array<Job>;
  /** Set while a drain loop owns the queue. */
  draining: Promise<void> | null;
  /** The head lost the connection; set while its retry waits. */
  cancelRetry: (() => void) | null;
  /** Stop held the queue: nothing more goes out until it's resumed. */
  held: boolean;
  /** The server's held queue is being released; nothing goes out before it is. */
  releasing: Promise<unknown> | null;
}

const OK: ComposerCommandResult = { ok: true };
const ABANDONED = Symbol("abandoned");
const HELD = Symbol("held");
const STALL_MS = 30_000;

export const DISCARD_NOTICE = "Not sent; edit it and send again";
export const MAYBE_SENT_NOTICE =
  "A message may already have been sent; check the thread before sending it again";
export const QUIT_NOTICE = "Not sent before tr3x quit; edit it and send again";

/** Whether the shell already lists the modes the server accepted. */
function reflects(listed: ComposerSettings | null, accepted: ComposerSettings): boolean {
  return (
    listed !== null &&
    listed.runtimeMode === accepted.runtimeMode &&
    listed.interactionMode === accepted.interactionMode
  );
}

/**
 * Delivers sends in order, one at a time per thread. Each send's commands and ids are planned
 * once, when sent; a retry resumes that plan, so a lost reply can't double-send or overwrite
 * a mode picked since (the server answers a repeated id from its command receipt).
 */
export function createComposerSender(options: ComposerSenderOptions) {
  const { store } = options;
  const stallMs = options.stallMs ?? STALL_MS;
  const queues = new Map<string, ThreadQueue>();
  /**
   * Modes the server accepted that the shell may not list yet. Later sends plan against
   * these, so a stale shell can't make a send skip the mode change it needs.
   */
  const accepted = new Map<string, ComposerSettings>();
  /** Draft threads this sender launched that the shell doesn't list yet. */
  const launched = new Set<string>();
  let disposed = false;

  const mark = (job: Job, status: ComposerSendStatus) => {
    if (job.status === status) return;
    job.status = status;
    store.updateSend(job.send, status, job.attempt);
  };

  const queueFor = (threadId: string): ThreadQueue => {
    const existing = queues.get(threadId);
    if (existing) return existing;
    const queue: ThreadQueue = {
      jobs: [],
      draining: null,
      cancelRetry: null,
      held: false,
      releasing: null,
    };
    queues.set(threadId, queue);
    return queue;
  };

  const accept = (
    threadId: ThreadId,
    settings: Partial<ComposerSettings>,
    fallback: ComposerSettings,
  ) => {
    const next = {
      ...(accepted.get(threadId) ?? options.threadSettings(threadId) ?? fallback),
      ...settings,
    };
    if (reflects(options.threadSettings(threadId), next)) accepted.delete(threadId);
    else accepted.set(threadId, next);
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
      ahead?.send.settings ?? accepted.get(threadId) ?? options.threadSettings(threadId) ?? null;
    return {
      send: planned,
      stages: [...settingsCommandsForSend(planned, base), { kind: "start-turn" }],
      next: 0,
      attempt: 0,
      started: false,
      dispatched: false,
      status: "sending",
      abandon: null,
    };
  };

  const runStage = (send: ComposerSend, stage: ComposerStage): Promise<ComposerCommandResult> => {
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
        return options.startTurn(buildStartTurnInput(send));
    }
  };

  /** One command's reply; marks the send stuck if none comes in time. */
  const attempt = (job: Job, stage: ComposerStage) =>
    new Promise<ComposerCommandResult | typeof ABANDONED>((resolve) => {
      let settled = false;
      const settle = (result: ComposerCommandResult | typeof ABANDONED) => {
        if (settled) return;
        settled = true;
        cancelStall();
        job.abandon = null;
        resolve(result);
      };
      const cancelStall = options.schedule(() => {
        if (settled || disposed) return;
        mark(job, "stuck");
        options.onFailure?.(job.send, null, "stuck");
      }, stallMs);
      job.abandon = () => settle(ABANDONED);
      let reply: Promise<ComposerCommandResult>;
      try {
        reply = runStage(job.send, stage);
      } catch (error) {
        reply = Promise.reject(error);
      }
      reply.then(settle, (error: unknown) => settle({ ok: false, error, interrupted: false }));
    });

  const runJob = async (
    queue: ThreadQueue,
    job: Job,
  ): Promise<ComposerCommandResult | typeof ABANDONED | typeof HELD> => {
    while (job.next < job.stages.length) {
      const stage = job.stages[job.next];
      if (stage === undefined) break;
      if (queue.held) return HELD;
      mark(job, "sending");
      job.started = true;
      if (stage.kind === "start-turn") job.dispatched = true;
      const result = await attempt(job, stage);
      if (result === ABANDONED || !result.ok) return result;
      if (stage.kind === "runtime-mode") {
        accept(job.send.target.threadId, { runtimeMode: stage.value }, job.send.settings);
      } else if (stage.kind === "interaction-mode") {
        accept(job.send.target.threadId, { interactionMode: stage.value }, job.send.settings);
      }
      job.next += 1;
    }
    return OK;
  };

  const finish = (job: Job) => {
    const { send } = job;
    const threadId = send.target.threadId;
    store.finishSend(send);
    accept(threadId, send.settings, send.settings);
    if (send.target.kind === "draft") {
      if (options.threadSettings(threadId) === null) launched.add(threadId);
      store.closeNewThreadDraft(threadId);
    }
    const patch = store.getPatch(threadId);
    if (patch !== undefined) {
      store.setPatch(threadId, normalizeSettingsPatch(send.settings, patch), send.settings);
    }
  };

  const dropIfIdle = (threadId: string, queue: ThreadQueue) => {
    if (queue.jobs.length === 0 && queue.draining === null && queues.get(threadId) === queue) {
      queue.cancelRetry?.();
      queues.delete(threadId);
    }
  };

  /** Sends the queue's jobs in order until it empties, is held, one is rejected, or the connection drops. */
  const drain = (threadId: string, queue: ThreadQueue): Promise<void> => {
    if (queue.draining !== null) return queue.draining;
    if (disposed || queue.held || queue.jobs.length === 0) return Promise.resolve();
    queue.cancelRetry?.();
    queue.cancelRetry = null;
    const loop = async () => {
      try {
        if (queue.releasing !== null) {
          await queue.releasing.catch(() => undefined);
          queue.releasing = null;
        }
        for (let job = queue.jobs[0]; job !== undefined; job = queue.jobs[0]) {
          if (disposed || queue.held) break;
          const result = await runJob(queue, job);
          if (disposed || result === HELD) break;
          // Resent (the same job is still first) or dropped (it's gone): carry on either way.
          if (result === ABANDONED) continue;
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
        if (queue.held) for (const entry of queue.jobs) mark(entry, "held");
        dropIfIdle(threadId, queue);
      }
    };
    queue.draining = loop();
    return queue.draining;
  };

  /** The job whose commands are going out now, if any. */
  const inFlight = (queue: ThreadQueue): Job | undefined =>
    queue.draining === null ? undefined : queue.jobs[0];

  /** Lets held messages go out again, in order, after the server's own held queue. */
  const release = (threadId: string, queue: ThreadQueue) => {
    if (!queue.held) return;
    queue.held = false;
    queue.releasing = options.resumeQueue?.(threadId as ThreadId) ?? null;
    for (const job of queue.jobs) if (job.status === "held") mark(job, "sending");
  };

  for (const pending of options.restore ?? []) {
    const queue = queueFor(pending.send.target.threadId);
    const job: Job = {
      send: pending.send,
      stages: pending.stages,
      next: pending.next,
      attempt: 0,
      started: true,
      // The message may have been in flight at quit.
      dispatched: pending.stages[pending.next]?.kind === "start-turn",
      status: "waiting",
      abandon: null,
    };
    queue.jobs.push(job);
    store.beginSend(job.send);
    store.updateSend(job.send, "waiting", 0);
  }

  const dispose = () => {
    disposed = true;
    for (const queue of queues.values()) {
      queue.cancelRetry?.();
      queue.jobs[0]?.abandon?.();
    }
    queues.clear();
    accepted.clear();
    launched.clear();
  };

  return {
    /** Resolves when the thread's queue settles; a retry may still follow. */
    send(send: ComposerSend): Promise<void> {
      const threadId = send.target.threadId;
      const queue = queueFor(threadId);
      const job = plan(send, queue);
      // As upstream, a new message releases a queue held after Stop: the held ones go first.
      release(threadId, queue);
      queue.jobs.push(job);
      store.beginSend(job.send);
      if (queue.cancelRetry !== null) {
        // The connection is down; this one waits behind the retry.
        mark(job, "waiting");
        return Promise.resolve();
      }
      return drain(threadId, queue);
    },

    /**
     * Stop: holds the thread's unsent messages so they don't go out after the interrupt
     * (the server would take them as new sends and release its own held queue). A command
     * already in flight finishes. Returns how many messages are held.
     */
    hold(threadId: string): number {
      const queue = queues.get(threadId);
      if (!queue || queue.jobs.length === 0) return 0;
      queue.held = true;
      queue.cancelRetry?.();
      queue.cancelRetry = null;
      const current = inFlight(queue);
      const held = queue.jobs.filter((job) => job !== current);
      for (const job of held) mark(job, "held");
      return held.length;
    },

    /**
     * Sends held, waiting, or stuck messages now. A stuck command goes out again with the
     * same ids, so the server dedupes it. Returns how many messages are pending.
     */
    resume(threadId: string): number {
      const queue = queues.get(threadId);
      if (!queue || queue.jobs.length === 0) return 0;
      release(threadId, queue);
      const current = inFlight(queue);
      if (current !== undefined) {
        if (current.status === "stuck") current.abandon?.();
      } else {
        void drain(threadId, queue);
      }
      return queue.jobs.length;
    },

    /**
     * Hands the thread's pending messages back to the composer, except one in flight that
     * isn't stuck. A message that went out unconfirmed comes back marked "may have been sent",
     * so it's neither lost nor resent behind the user's back. Returns how many came back.
     */
    discard(threadId: string): number {
      const queue = queues.get(threadId);
      if (!queue) return 0;
      const current = inFlight(queue);
      const dropped = queue.jobs.filter((job) => job !== current || job.status === "stuck");
      if (dropped.length === 0) return 0;
      queue.jobs.splice(queue.jobs.length - dropped.length);
      queue.cancelRetry?.();
      queue.cancelRetry = null;
      queue.held = false;
      dropped[0]?.abandon?.();
      const notice = dropped.some((job) => job.dispatched) ? MAYBE_SENT_NOTICE : DISCARD_NOTICE;
      for (const job of [...dropped].reverse()) store.restoreSend(job.send, notice);
      dropIfIdle(threadId, queue);
      return dropped.length;
    },

    /** The connection is back: sends what was waiting, and resends stuck commands. */
    retryWaiting(): Promise<void> {
      const drains: Array<Promise<void>> = [];
      for (const [threadId, queue] of queues) {
        if (queue.held || queue.jobs.length === 0) continue;
        if (queue.draining === null) drains.push(drain(threadId, queue));
        else if (queue.jobs[0]?.status === "stuck") queue.jobs[0].abandon?.();
      }
      return Promise.all(drains).then(() => undefined);
    },

    /** The shell changed: forgets accepted modes and launches it now lists. */
    reconcile(listed: (threadId: ThreadId) => ComposerSettings | null = options.threadSettings) {
      for (const threadId of launched) {
        if (listed(threadId as ThreadId) !== null) launched.delete(threadId);
      }
      for (const [threadId, settings] of accepted) {
        if (reflects(listed(threadId as ThreadId), settings)) accepted.delete(threadId);
      }
    },

    /** Messages not yet accepted by the server, across threads. */
    pendingCount(): number {
      let count = 0;
      for (const queue of queues.values()) count += queue.jobs.length;
      return count;
    },

    /**
     * Quitting: saves sends that may have reached the server, with their ids and plan, so the
     * next launch finishes them; hands the rest back to their composers. Then stops.
     */
    handOff() {
      // Once only: a second quit must not overwrite what the first one saved.
      if (disposed) return;
      const pending: Array<PendingComposerSend> = [];
      for (const queue of queues.values()) {
        const unstarted: Array<Job> = [];
        for (const job of queue.jobs) {
          if (job.started) pending.push({ send: job.send, stages: job.stages, next: job.next });
          else unstarted.push(job);
        }
        for (const job of unstarted.reverse()) store.restoreSend(job.send, QUIT_NOTICE);
      }
      store.setPendingSends(pending);
      dispose();
    },

    /** For tests: how many threads the sender still tracks outside its queues. */
    trackedThreads: () => ({ accepted: accepted.size, launched: launched.size }),

    dispose,
  };
}

export type ComposerSender = ReturnType<typeof createComposerSender>;
