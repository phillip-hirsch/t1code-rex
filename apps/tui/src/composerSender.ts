// @effect-diagnostics nodeBuiltinImport:off -- Resume ids are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { ResumeThreadQueueInput } from "@t3tools/client-runtime/operations";
import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/state/threads";
import { CommandId, type ThreadId } from "@t3tools/contracts";

import {
  buildStartTurnInput,
  classifySendFailure,
  describeSendFailure,
  retryDelayMs,
  settingsCommandsForSend,
  type ComposerSend,
  type ComposerStage,
  type UnconfirmedComposerSend,
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
  /** Releases the queue the server holds after Stop (upstream's `queue.resume`). */
  readonly resumeQueue: (input: ResumeThreadQueueInput) => Promise<ComposerCommandResult>;
  /** The thread's settings as the shell lists them now; null for threads it doesn't list. */
  readonly threadSettings: (threadId: ThreadId) => ComposerSettings | null;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** How long a command may go unanswered before its job shows as stuck. */
  readonly stallMs?: number;
  readonly onFailure?: (
    job: ComposerJob,
    error: unknown,
    action: "retry" | "restore" | "stuck",
  ) => void;
}

/** A message, or the `queue.resume` that releases the server's held queue after Stop. */
interface JobState {
  readonly kind: "send" | "resume";
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  attempt: number;
  status: ComposerSendStatus;
  /** Set while a command is in flight; stops waiting on it (to resend, or to drop it). */
  abandon: (() => void) | null;
}

/** A message and the commands it was planned to issue, frozen when it was sent. */
interface SendJob extends JobState {
  readonly kind: "send";
  readonly send: ComposerSend;
  readonly stages: ReadonlyArray<ComposerStage>;
  /** Stages before this one were accepted; a retry resumes here. */
  next: number;
  /** The message itself went out unconfirmed: it may have landed. */
  dispatched: boolean;
}

type ResumeJob = JobState & { readonly kind: "resume" };

export type ComposerJob = Pick<JobState, "kind" | "threadId" | "commandId">;

type Job = SendJob | ResumeJob;

interface ThreadQueue {
  readonly jobs: Array<Job>;
  /** Set while a drain loop owns the queue. */
  draining: Promise<void> | null;
  /** The head lost the connection; set while its retry waits. */
  cancelRetry: (() => void) | null;
  /** Stop held the queue: nothing more goes out until it's resumed. */
  held: boolean;
}

const OK: ComposerCommandResult = { ok: true };
const ABANDONED = Symbol("abandoned");
const HELD = Symbol("held");
const STALL_MS = 30_000;

export const DISCARD_NOTICE = "Not sent; edit it and send again";
export const MAYBE_SENT_NOTICE =
  "A message may already have been sent; check the thread before sending it again";
export const QUIT_NOTICE = "Not sent before tr3x quit; edit it and send again";
const RESUME_NOTICES: Partial<Record<ComposerSendStatus, string>> = {
  waiting: "Resuming the queue once connected",
  stuck: "Resume got no reply (/resume retries, /discard drops it)",
};

/** Whether the shell already lists the modes the server accepted. */
function reflects(listed: ComposerSettings | null, accepted: ComposerSettings): boolean {
  return (
    listed !== null &&
    listed.runtimeMode === accepted.runtimeMode &&
    listed.interactionMode === accepted.interactionMode
  );
}

/**
 * Delivers a thread's jobs in order, one at a time. Each job's commands and ids are fixed
 * when it's queued; a retry resends them, so the server answers a repeat from its receipt.
 * Nothing outlives the process: at quit, messages go back to their composers.
 */
export function createComposerSender(options: ComposerSenderOptions) {
  const { store } = options;
  const stallMs = options.stallMs ?? STALL_MS;
  const queues = new Map<string, ThreadQueue>();
  /** Modes the server accepted that the shell may not list yet; later sends plan on them. */
  const accepted = new Map<string, ComposerSettings>();
  /** Draft threads this sender launched that the shell doesn't list yet. */
  const launched = new Set<string>();
  let disposed = false;

  const mark = (job: Job, status: ComposerSendStatus) => {
    if (job.status === status) return;
    job.status = status;
    if (job.kind === "send") store.updateSend(job.send, status, job.attempt);
    else store.setNotice(job.threadId, RESUME_NOTICES[status] ?? null);
  };

  const queueFor = (threadId: string): ThreadQueue => {
    const existing = queues.get(threadId);
    if (existing) return existing;
    const queue: ThreadQueue = { jobs: [], draining: null, cancelRetry: null, held: false };
    queues.set(threadId, queue);
    return queue;
  };

  const stopRetry = (queue: ThreadQueue) => {
    queue.cancelRetry?.();
    queue.cancelRetry = null;
  };

  const sendJobs = (queue: ThreadQueue) =>
    queue.jobs.filter((job): job is SendJob => job.kind === "send");

  const accept = (threadId: ThreadId, settings: Partial<ComposerSettings>) => {
    const base = accepted.get(threadId) ?? options.threadSettings(threadId);
    if (base === null) return;
    const next = { ...base, ...settings };
    if (reflects(options.threadSettings(threadId), next)) accepted.delete(threadId);
    else accepted.set(threadId, next);
  };

  const plan = (send: ComposerSend, queue: ThreadQueue): SendJob => {
    const threadId = send.target.threadId;
    const ahead = sendJobs(queue).at(-1);
    // A draft whose launch is queued or done gets follow-ups, not a second launch.
    const launching =
      launched.has(threadId) || sendJobs(queue).some((job) => job.send.target.kind === "draft");
    const planned: ComposerSend =
      send.target.kind === "draft" && launching
        ? { ...send, target: { ...send.target, kind: "thread" } }
        : send;
    const base =
      ahead?.send.settings ?? accepted.get(threadId) ?? options.threadSettings(threadId) ?? null;
    return {
      kind: "send",
      threadId,
      commandId: send.commandId,
      send: planned,
      stages: [...settingsCommandsForSend(planned, base), { kind: "start-turn" }],
      next: 0,
      dispatched: false,
      attempt: 0,
      status: "sending",
      abandon: null,
    };
  };

  const runStage = (send: ComposerSend, stage: ComposerStage): Promise<ComposerCommandResult> => {
    if (stage.kind === "start-turn") return options.startTurn(buildStartTurnInput(send));
    const { commandId } = stage;
    const command = { commandId, threadId: send.target.threadId, createdAt: send.createdAt };
    return stage.kind === "runtime-mode"
      ? options.setRuntimeMode({ ...command, runtimeMode: stage.value })
      : options.setInteractionMode({ ...command, interactionMode: stage.value });
  };

  /** One command's reply; marks the job stuck if none comes in time. */
  const attempt = (job: Job, issue: () => Promise<ComposerCommandResult>) =>
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
        options.onFailure?.(job, null, "stuck");
      }, stallMs);
      job.abandon = () => settle(ABANDONED);
      let reply: Promise<ComposerCommandResult>;
      try {
        reply = issue();
      } catch (error) {
        reply = Promise.reject(error);
      }
      reply.then(settle, (error: unknown) => settle({ ok: false, error, interrupted: false }));
    });

  const runJob = async (
    queue: ThreadQueue,
    job: Job,
  ): Promise<ComposerCommandResult | typeof ABANDONED | typeof HELD> => {
    if (job.kind === "resume") {
      mark(job, "sending");
      return attempt(job, () =>
        options.resumeQueue({ commandId: job.commandId, threadId: job.threadId }),
      );
    }
    while (job.next < job.stages.length) {
      const stage = job.stages[job.next];
      if (stage === undefined) break;
      if (queue.held) return HELD;
      mark(job, "sending");
      if (stage.kind === "start-turn") job.dispatched = true;
      const result = await attempt(job, () => runStage(job.send, stage));
      if (result === ABANDONED || !result.ok) return result;
      if (stage.kind === "runtime-mode") accept(job.threadId, { runtimeMode: stage.value });
      if (stage.kind === "interaction-mode") accept(job.threadId, { interactionMode: stage.value });
      job.next += 1;
    }
    return OK;
  };

  const finish = (job: Job) => {
    if (job.kind === "resume") return;
    const { send } = job;
    const threadId = send.target.threadId;
    store.finishSend(send);
    if (send.target.kind === "draft") {
      // The launch applied every setting; a message to an existing thread applies only
      // the mode commands accepted above.
      accepted.set(threadId, send.settings);
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

  /** Runs the queue's jobs in order until it empties, is held, one is rejected, or the connection drops. */
  const drain = (threadId: string, queue: ThreadQueue): Promise<void> => {
    if (queue.draining !== null) return queue.draining;
    if (disposed || queue.held || queue.jobs.length === 0) return Promise.resolve();
    stopRetry(queue);
    const loop = async () => {
      try {
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
          options.onFailure?.(job, result.error, action);
          if (action === "restore") {
            const reason = describeSendFailure(result.error);
            if (job.kind === "resume") {
              // The server still holds its queue, so the messages held here stay held.
              queue.jobs.shift();
              queue.held = true;
              store.setNotice(job.threadId, `Resume failed: ${reason} (/resume, /discard)`);
              break;
            }
            // What waited behind it was planned on top of it: all of it goes back, in order.
            for (const entry of sendJobs(queue).reverse()) store.restoreSend(entry.send, reason);
            queue.jobs.splice(0);
            break;
          }
          job.attempt += 1;
          for (const entry of queue.jobs) mark(entry, "waiting");
          queue.cancelRetry = options.schedule(
            () => void drain(threadId, queue),
            retryDelayMs(job.attempt - 1),
          );
          break;
        }
      } finally {
        // Runs in the same tick as the loop's last check, so no send can slip in between.
        queue.draining = null;
        if (queue.held) for (const entry of sendJobs(queue)) mark(entry, "held");
        dropIfIdle(threadId, queue);
      }
    };
    queue.draining = loop();
    return queue.draining;
  };

  /** The job whose command is going out now, if any. */
  const inFlight = (queue: ThreadQueue): Job | undefined =>
    queue.draining === null ? undefined : queue.jobs[0];

  const resumeJob = (threadId: ThreadId): ResumeJob => ({
    kind: "resume",
    threadId,
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    attempt: 0,
    status: "sending",
    abandon: null,
  });

  /**
   * Lifts a hold. A `queue.resume` goes ahead of the held messages, behind any command in
   * flight, so the server's held runs (sent earlier) stay ahead of them.
   */
  const release = (threadId: ThreadId, queue: ThreadQueue) => {
    if (!queue.held) return;
    queue.held = false;
    const at = inFlight(queue) === undefined ? 0 : 1;
    if (queue.jobs[at]?.kind !== "resume") queue.jobs.splice(at, 0, resumeJob(threadId));
    for (const job of sendJobs(queue)) if (job.status === "held") mark(job, "sending");
  };

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
     * Stop: holds unsent jobs, so the server doesn't take a message as a new send and
     * release its own held queue. A command in flight finishes. Returns how many are held.
     */
    hold(threadId: string): number {
      const queue = queues.get(threadId);
      if (!queue || queue.jobs.length === 0) return 0;
      queue.held = true;
      stopRetry(queue);
      const current = inFlight(queue);
      const held = sendJobs(queue).filter((job) => job !== current);
      for (const job of held) mark(job, "held");
      return held.length;
    },

    /**
     * Sends what's held, waiting, or stuck now; a stuck command goes out again with the same
     * ids, so the server dedupes it. With nothing pending here, queues a `queue.resume` for
     * the server's held queue, like web's "Resume thread". Returns how many messages are pending.
     */
    resume(threadId: ThreadId): number {
      const queue = queueFor(threadId);
      if (queue.jobs.length === 0) queue.jobs.push(resumeJob(threadId));
      release(threadId, queue);
      const current = inFlight(queue);
      if (current === undefined) void drain(threadId, queue);
      else if (current.status === "stuck") current.abandon?.();
      return sendJobs(queue).length;
    },

    /**
     * Hands the thread's pending messages back to the composer and drops pending resumes,
     * except a command in flight that isn't stuck. A message that went out unconfirmed comes
     * back marked "may have been sent", so it's neither lost nor resent behind the user's back.
     */
    discard(threadId: string): { readonly messages: number; readonly resumes: number } {
      const queue = queues.get(threadId);
      if (!queue) return { messages: 0, resumes: 0 };
      const current = inFlight(queue);
      const kept = current !== undefined && current.status !== "stuck" ? 1 : 0;
      const dropped = queue.jobs.splice(kept);
      if (dropped.length === 0) return { messages: 0, resumes: 0 };
      stopRetry(queue);
      queue.held = false;
      dropped[0]?.abandon?.();
      const messages = dropped.filter((job): job is SendJob => job.kind === "send");
      for (const job of dropped) if (job.kind === "resume") mark(job, "sending");
      const notice = messages.some((job) => job.dispatched) ? MAYBE_SENT_NOTICE : DISCARD_NOTICE;
      for (const job of messages.reverse()) store.restoreSend(job.send, notice);
      dropIfIdle(threadId, queue);
      return { messages: messages.length, resumes: dropped.length - messages.length };
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
      return [...queues.values()].reduce((count, queue) => count + sendJobs(queue).length, 0);
    },

    /**
     * Quitting: every pending message goes back to its composer. One that went out
     * unconfirmed is saved by id instead, and the next launch restores it only if its thread
     * doesn't have it. Nothing is sent again without the user. Then stops.
     */
    handOff() {
      // Once only: a second quit must not save the same messages twice.
      if (disposed) return;
      const unconfirmed = [...queues.values()].flatMap((queue) => {
        const jobs = sendJobs(queue);
        for (const job of jobs.filter((entry) => !entry.dispatched).reverse()) {
          store.restoreSend(job.send, QUIT_NOTICE);
        }
        return jobs
          .filter((job) => job.dispatched)
          .map(({ send }): UnconfirmedComposerSend => ({
            threadId: send.target.threadId,
            launch: send.target.kind === "draft",
            messageId: send.messageId,
            text: send.text,
            attachments: send.attachments,
          }));
      });
      store.addUnconfirmedSends(unconfirmed);
      dispose();
    },

    /** For tests: how many threads the sender still tracks outside its queues. */
    trackedThreads: () => ({ accepted: accepted.size, launched: launched.size }),

    dispose,
  };
}

export type ComposerSender = ReturnType<typeof createComposerSender>;
