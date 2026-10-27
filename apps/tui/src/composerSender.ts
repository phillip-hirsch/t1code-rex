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
  type ComposerDeclines,
  type ComposerSend,
  type ComposerStage,
  type UnconfirmedComposerSend,
} from "./composerSend.ts";
import { normalizeSettingsPatch, type ComposerSettings } from "./composerSettings.ts";
import type { ComposerSendStatus, ComposerStore } from "./composerStore.ts";

export type ComposerCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly interrupted: boolean };

/** A message's declines, run as the first stage of its job; see `requestRedirect.ts`. */
export interface DeclineApprovalsInput {
  readonly threadId: ThreadId;
  /** The message's command id; each decline's id derives from it, so a retry reuses it. */
  readonly commandId: CommandId;
  readonly declines: ComposerDeclines;
}

export interface ComposerSenderOptions {
  readonly store: ComposerStore;
  readonly startTurn: (input: StartThreadTurnInput) => Promise<ComposerCommandResult>;
  readonly setRuntimeMode: (input: SetThreadRuntimeModeInput) => Promise<ComposerCommandResult>;
  readonly setInteractionMode: (
    input: SetThreadInteractionModeInput,
  ) => Promise<ComposerCommandResult>;
  /** Releases the queue the server holds after Stop (upstream's `queue.resume`). */
  readonly resumeQueue: (input: ResumeThreadQueueInput) => Promise<ComposerCommandResult>;
  /**
   * Watches a thread while it has jobs here, selected or not: why nothing may start on it
   * now (its worktree isn't there). Asked before each command, sends and resumes alike;
   * never before the thread exists.
   */
  readonly guardWorkspace?: (threadId: ThreadId) => WorkspaceGuard;
  /** Declines the approvals a message redirects past, before its other commands. */
  readonly declineApprovals?: (input: DeclineApprovalsInput) => Promise<ComposerCommandResult>;
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

/** Keeps a thread's runs loaded while the sender has jobs for it. */
export interface WorkspaceGuard {
  /**
   * Why nothing may start on the thread now; undefined while the server's state isn't known.
   * A promise only while the answer is on its way; once known, it's answered at once.
   */
  readonly blockedReason: () => WorkspaceBlock | Promise<WorkspaceBlock>;
  readonly dispose: () => void;
}

export type WorkspaceBlock = string | null | undefined;

/** A message, or the `queue.resume` that releases the server's held queue after Stop. */
interface JobState {
  readonly kind: "send" | "resume";
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  attempt: number;
  status: ComposerSendStatus;
  /** Set while a command is in flight; stops waiting on it (to resend, or to drop it). */
  abandon: (() => void) | null;
  /** Its command that can't be called back went out: the message, or the resume. */
  dispatched: boolean;
}

/** A message and the commands it was planned to issue, frozen when it was sent. */
interface SendJob extends JobState {
  readonly kind: "send";
  readonly send: ComposerSend;
  readonly stages: ReadonlyArray<ComposerStage>;
  /** Stages before this one were accepted; a retry resumes here. */
  next: number;
}

type ResumeJob = JobState & { readonly kind: "resume" };

export type ComposerJob = Pick<JobState, "kind" | "threadId" | "commandId">;

/** Some threads' jobs, and any message sent to the project (a launch the shell doesn't list yet). */
export interface ComposerJobScope {
  readonly threadIds: ReadonlyArray<string>;
  readonly projectId?: string;
}

type Job = SendJob | ResumeJob;

interface ThreadQueue {
  readonly jobs: Array<Job>;
  /** Set while a drain loop owns the queue. */
  draining: Promise<void> | null;
  /** The job whose command is going out now; not always first, as a resume can go ahead of it. */
  current: Job | null;
  /** The head lost the connection; set while its retry waits. */
  cancelRetry: (() => void) | null;
  /** Stop held the queue: nothing more goes out until it's resumed. */
  held: boolean;
  /** Made at the first command it checks: a draft's thread doesn't exist before its launch. */
  guard: WorkspaceGuard | null;
}

const OK: ComposerCommandResult = { ok: true };
/** How long a guard's answer may take before the job waits and asks again, as offline. */
const GUARD_WAIT_MS = 5_000;
const ABANDONED = Symbol("abandoned");
const HELD = Symbol("held");
/** The thread's runs aren't loaded yet, so whether its worktree is there is unknown. */
const UNKNOWN = Symbol("unknown");

/** A message that can't go out now; it goes back to its composer with the reason. */
interface Blocked {
  readonly blocked: string;
}

/** The guard's answer: go (null), wait, or go back. Waited answers can also pause or drop it. */
type Gated = Blocked | typeof UNKNOWN | typeof HELD | typeof ABANDONED | null;
const STALL_MS = 30_000;

export const DISCARD_NOTICE = "Not sent; edit it and send again";
export const MAYBE_SENT_NOTICE =
  "A message may already have been sent; check the thread before sending it again";
export const QUIT_NOTICE = "Not sent before tr3x quit; edit it and send again";
const NO_DECLINER: ComposerCommandResult = {
  ok: false,
  error: new Error("Not sent: this window can't decline the approval first"),
  interrupted: false,
};
const RESUME_NOTICES: Partial<Record<ComposerSendStatus, string>> = {
  waiting: "Resuming the queue once connected",
  stuck: "Resume got no reply (/resume retries, /discard drops it)",
};

function inScope(
  scope: ComposerJobScope,
  threadId: string,
  queue: { readonly jobs: ReadonlyArray<Job> },
): boolean {
  return (
    scope.threadIds.includes(threadId) ||
    (scope.projectId !== undefined &&
      queue.jobs.some(
        (job) => job.kind === "send" && job.send.target.projectId === scope.projectId,
      ))
  );
}

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
  /**
   * Threads whose modes are unknown: a discard dropped a mode command still in flight, and
   * the server may apply it anyway. The next send sets both modes explicitly; being sent
   * later, it lands after the dropped one.
   */
  const unsure = new Set<string>();
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
    const queue: ThreadQueue = {
      jobs: [],
      draining: null,
      current: null,
      cancelRetry: null,
      held: false,
      guard: null,
    };
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
      ahead?.send.settings ??
      (unsure.has(threadId)
        ? "unknown"
        : (accepted.get(threadId) ?? options.threadSettings(threadId) ?? null));
    return {
      kind: "send",
      threadId,
      commandId: send.commandId,
      send: planned,
      stages: [
        // Declines go first: the message steers the run they kept waiting.
        ...(planned.declines !== undefined && planned.declines.requestIds.length > 0
          ? [{ kind: "decline-approvals", declines: planned.declines } as const]
          : []),
        ...settingsCommandsForSend(planned, base),
        { kind: "start-turn" },
      ],
      next: 0,
      dispatched: false,
      attempt: 0,
      status: "sending",
      abandon: null,
    };
  };

  const runStage = (send: ComposerSend, stage: ComposerStage): Promise<ComposerCommandResult> => {
    if (stage.kind === "start-turn") return options.startTurn(buildStartTurnInput(send));
    if (stage.kind === "decline-approvals") {
      const input = {
        threadId: send.target.threadId,
        commandId: send.commandId,
        declines: stage.declines,
      };
      return options.declineApprovals?.(input) ?? Promise.resolve(NO_DECLINER);
    }
    const { commandId } = stage;
    const command = { commandId, threadId: send.target.threadId, createdAt: send.createdAt };
    return stage.kind === "runtime-mode"
      ? options.setRuntimeMode({ ...command, runtimeMode: stage.value })
      : options.setInteractionMode({ ...command, interactionMode: stage.value });
  };

  /**
   * Whether the job's next command may go out. A draft's own launch makes the thread, so
   * there's nothing to check yet; everything after it is checked. Watching starts here, not
   * when the job is queued: a thread watched before it exists reads as deleted.
   */
  const gate = (queue: ThreadQueue, job: Job): Gated | Promise<Gated> => {
    const { guardWorkspace } = options;
    if (guardWorkspace === undefined || (job.kind === "send" && job.send.target.kind === "draft")) {
      return null;
    }
    queue.guard ??= guardWorkspace(job.threadId);
    const reason = queue.guard.blockedReason();
    if (!(reason instanceof Promise)) return gated(reason);
    let cancelWait = () => {};
    const timedOut = new Promise<undefined>((resolve) => {
      cancelWait = options.schedule(() => resolve(undefined), GUARD_WAIT_MS);
    });
    return Promise.race([reason, timedOut]).then((answer) => {
      cancelWait();
      // The answer took a moment: anything that changed meanwhile wins, Stop included.
      if (disposed || !queue.jobs.includes(job)) return ABANDONED;
      if (queue.held || (job.kind === "send" && queue.jobs[0] !== job)) return HELD;
      return gated(answer);
    });
  };

  const gated = (reason: WorkspaceBlock): Gated => {
    if (reason === undefined) return UNKNOWN;
    return reason === null ? null : { blocked: reason };
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
  ): Promise<ComposerCommandResult | typeof ABANDONED | typeof HELD | typeof UNKNOWN | Blocked> => {
    if (job.kind === "resume") {
      // A resume releases the server's held runs; they'd start in the project checkout.
      const checked = gate(queue, job);
      const gated = checked instanceof Promise ? await checked : checked;
      if (gated !== null) return gated;
      mark(job, "sending");
      job.dispatched = true;
      return attempt(job, () =>
        options.resumeQueue({ commandId: job.commandId, threadId: job.threadId }),
      );
    }
    while (job.next < job.stages.length) {
      const stage = job.stages[job.next];
      if (stage === undefined) break;
      // Stop, or a resume that went ahead of it: it waits at this stage, before its message.
      if (queue.held || queue.jobs[0] !== job) return HELD;
      const checked = gate(queue, job);
      const gated = checked instanceof Promise ? await checked : checked;
      if (gated !== null) return gated;
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
    // It set both modes (or launched with them), so they're known again.
    const setsBoth =
      send.target.kind === "draft" ||
      (job.stages.some((stage) => stage.kind === "runtime-mode") &&
        job.stages.some((stage) => stage.kind === "interaction-mode"));
    if (setsBoth) unsure.delete(threadId);
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

  const removeQueue = (threadId: string, queue: ThreadQueue) => {
    queue.cancelRetry?.();
    queue.guard?.dispose();
    queues.delete(threadId);
  };

  const dropIfIdle = (threadId: string, queue: ThreadQueue) => {
    if (queue.jobs.length === 0 && queue.draining === null && queues.get(threadId) === queue) {
      removeQueue(threadId, queue);
    }
  };

  /**
   * A message can't go out: what waited behind it was planned on top of it, so all of it
   * goes back, in order. A resume ahead of it still goes out.
   */
  const restoreMessages = (queue: ThreadQueue, reason: string) => {
    for (const entry of sendJobs(queue).reverse()) store.restoreSend(entry.send, reason);
    const resumes = queue.jobs.filter((entry) => entry.kind === "resume");
    queue.jobs.splice(0, queue.jobs.length, ...resumes);
  };

  /**
   * Nothing may start on the thread: its messages go back to the composer, and resumes are
   * dropped, so the runs the server holds stay held.
   */
  const blockThread = (threadId: ThreadId, queue: ThreadQueue, reason: string) => {
    restoreMessages(queue, reason);
    queue.jobs.splice(0, queue.jobs.length);
    store.setNotice(threadId, reason);
  };

  /** Asks again later, as after a dropped connection. */
  const retryLater = (threadId: string, queue: ThreadQueue, job: Job) => {
    job.attempt += 1;
    for (const entry of queue.jobs) mark(entry, "waiting");
    queue.cancelRetry = options.schedule(
      () => void drain(threadId, queue),
      retryDelayMs(job.attempt - 1),
    );
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
          queue.current = job;
          const result = await runJob(queue, job);
          queue.current = null;
          if (disposed) break;
          // Paused (held, or a resume went ahead), resent, or dropped: the next pass decides.
          if (result === HELD || result === ABANDONED) continue;
          if (result === UNKNOWN) {
            retryLater(threadId, queue, job);
            break;
          }
          if ("blocked" in result) {
            blockThread(job.threadId, queue, result.blocked);
            continue;
          }
          if (result.ok) {
            queue.jobs.splice(queue.jobs.indexOf(job), 1);
            finish(job);
            continue;
          }
          const action = classifySendFailure(result.error, result.interrupted);
          options.onFailure?.(job, result.error, action);
          if (action === "restore") {
            const reason = describeSendFailure(result.error);
            if (job.kind === "resume") {
              // The server still holds its queue, so the messages held here stay held.
              queue.jobs.splice(queue.jobs.indexOf(job), 1);
              queue.held = true;
              store.setNotice(job.threadId, `Resume failed: ${reason} (/resume, /discard)`);
              break;
            }
            restoreMessages(queue, reason);
            continue;
          }
          retryLater(threadId, queue, job);
          break;
        }
      } finally {
        // Runs in the same tick as the loop's last check, so no send can slip in between.
        queue.draining = null;
        queue.current = null;
        if (queue.held) for (const entry of sendJobs(queue)) mark(entry, "held");
        dropIfIdle(threadId, queue);
      }
    };
    queue.draining = loop();
    return queue.draining;
  };

  /** The job whose command is going out now, if any. */
  const inFlight = (queue: ThreadQueue): Job | undefined => queue.current ?? undefined;

  /** A command in flight that must finish where it is: a resume or message that went out. */
  const committed = (job: Job | undefined): job is Job => job?.dispatched === true;

  const resumeJob = (threadId: ThreadId): ResumeJob => ({
    kind: "resume",
    threadId,
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    attempt: 0,
    status: "sending",
    abandon: null,
    dispatched: false,
  });

  /**
   * Lifts a hold. A `queue.resume` goes ahead of the held messages, so the server's held runs
   * (sent earlier) stay ahead of them. Only a resume or a message already out stays ahead of
   * it; a message still on its mode commands waits for the resume.
   */
  const release = (threadId: ThreadId, queue: ThreadQueue) => {
    if (!queue.held) return;
    queue.held = false;
    const current = inFlight(queue);
    const at = committed(current) ? queue.jobs.indexOf(current) + 1 : 0;
    if (queue.jobs[at]?.kind !== "resume") queue.jobs.splice(at, 0, resumeJob(threadId));
    for (const job of sendJobs(queue)) if (job.status === "held") mark(job, "sending");
  };

  const dispose = () => {
    disposed = true;
    for (const queue of queues.values()) {
      queue.cancelRetry?.();
      queue.guard?.dispose();
      queue.current?.abandon?.();
    }
    queues.clear();
    accepted.clear();
    launched.clear();
    unsure.clear();
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
     * release its own held queue. A command in flight finishes; a message still on its mode
     * commands stops after the one in flight. Returns how many messages are held.
     */
    hold(threadId: string): number {
      const queue = queues.get(threadId);
      if (!queue || queue.jobs.length === 0) return 0;
      queue.held = true;
      stopRetry(queue);
      const current = inFlight(queue);
      const held = sendJobs(queue).filter((job) => job !== current || !job.dispatched);
      for (const job of held) if (job !== current) mark(job, "held");
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
     * except a resume or message in flight that isn't stuck. A message that went out
     * unconfirmed comes back marked "may have been sent", so it's neither lost nor resent
     * behind the user's back.
     */
    discard(threadId: string): { readonly messages: number; readonly resumes: number } {
      const queue = queues.get(threadId);
      if (!queue) return { messages: 0, resumes: 0 };
      const current = inFlight(queue);
      const kept = committed(current) && current.status !== "stuck" ? current : undefined;
      const dropped = queue.jobs.filter((job) => job !== kept);
      if (dropped.length === 0) return { messages: 0, resumes: 0 };
      queue.jobs.splice(0, queue.jobs.length, ...(kept === undefined ? [] : [kept]));
      stopRetry(queue);
      queue.held = false;
      if (current !== kept) {
        // A mode command in flight may still apply: don't plan the next send on stale modes.
        const stage = current?.kind === "send" ? current.stages[current.next] : undefined;
        if (stage?.kind === "runtime-mode" || stage?.kind === "interaction-mode") {
          unsure.add(threadId);
          accepted.delete(threadId);
        }
        current?.abandon?.();
      }
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
        const current = inFlight(queue);
        if (queue.draining === null) drains.push(drain(threadId, queue));
        else if (current?.status === "stuck") current.abandon?.();
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

    /** Messages not yet accepted by the server: across threads, or only those in `scope`. */
    pendingCount(scope?: ComposerJobScope): number {
      return [...queues]
        .filter(([threadId, queue]) => scope === undefined || inScope(scope, threadId, queue))
        .reduce((count, [, queue]) => count + sendJobs(queue).length, 0);
    },

    /**
     * The threads were deleted: drops their jobs, unsent messages included, without handing
     * them back, since no composer can show them now. The user confirmed losing them. A
     * command in flight is abandoned; nothing is saved for them at quit. Returns how many
     * messages were dropped.
     */
    forget(scope: ComposerJobScope): number {
      let messages = 0;
      const forgotten = new Set(scope.threadIds);
      for (const [threadId, queue] of queues) {
        if (!inScope(scope, threadId, queue)) continue;
        forgotten.add(threadId);
        const jobs = sendJobs(queue);
        messages += jobs.length;
        for (const job of jobs) store.finishSend(job.send);
        store.setNotice(threadId, null);
        queue.jobs.splice(0, queue.jobs.length);
        queue.held = false;
        queue.current?.abandon?.();
        removeQueue(threadId, queue);
      }
      for (const threadId of forgotten) {
        accepted.delete(threadId);
        launched.delete(threadId);
        unsure.delete(threadId);
      }
      return messages;
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
            projectId: send.target.projectId,
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
