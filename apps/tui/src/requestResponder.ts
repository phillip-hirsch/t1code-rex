// @effect-diagnostics nodeBuiltinImport:off -- Response ids are minted outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type {
  DismissThreadUserInputInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
} from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";

import { classifySendFailure, describeSendFailure, retryDelayMs } from "./composerSend.ts";
import type { ComposerCommandResult } from "./composerSender.ts";
import type { QuestionAnswer } from "./questionAnswers.ts";

export type RequestResponse =
  | { readonly type: "approval"; readonly decision: ProviderApprovalDecision }
  | { readonly type: "answers"; readonly answers: Readonly<Record<string, QuestionAnswer>> }
  | { readonly type: "dismiss" };

/**
 * Where a response stands. "waiting" lost the connection and goes again with the same id;
 * "sent" was accepted and waits for the thread to drop the request; "failed" was turned
 * down, and the request can be answered again.
 */
export type ResponseStatus =
  | { readonly state: "sending"; readonly response: RequestResponse }
  | { readonly state: "waiting"; readonly response: RequestResponse; readonly attempt: number }
  | { readonly state: "sent"; readonly response: RequestResponse }
  | { readonly state: "failed"; readonly response: RequestResponse; readonly error: string };

export interface RequestResponderOptions {
  readonly respondToApproval: (
    input: RespondToThreadApprovalInput,
  ) => Promise<ComposerCommandResult>;
  readonly respondToUserInput: (
    input: RespondToThreadUserInputInput,
  ) => Promise<ComposerCommandResult>;
  readonly dismissUserInput: (input: DismissThreadUserInputInput) => Promise<ComposerCommandResult>;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly newCommandId?: () => CommandId;
  readonly onFailure?: (
    requestId: RuntimeRequestId,
    error: unknown,
    action: "retry" | "restore",
  ) => void;
}

interface Job {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly commandId: CommandId;
  readonly response: RequestResponse;
  attempt: number;
  status: ResponseStatus;
  cancelRetry: (() => void) | null;
  /** The attempt out now, if any. */
  inFlight: Promise<void> | null;
}

const DECLINE: RequestResponse = { type: "approval", decision: "decline" };

/**
 * Sends approval decisions, answers and dismissals. One response per request at a time;
 * each keeps its command id across retries, so a reply lost with the connection can't
 * answer twice (the server answers a repeated id from its command receipt).
 */
export function createRequestResponder(options: RequestResponderOptions) {
  const jobs = new Map<RuntimeRequestId, Job>();
  const running = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let disposed = false;
  const newCommandId = options.newCommandId ?? (() => CommandId.make(NodeCrypto.randomUUID()));

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const setStatus = (job: Job, status: ResponseStatus) => {
    job.status = status;
    notify();
  };

  const dispatch = (job: Job): Promise<ComposerCommandResult> => {
    const base = { commandId: job.commandId, threadId: job.threadId, requestId: job.requestId };
    switch (job.response.type) {
      case "approval":
        return options.respondToApproval({ ...base, decision: job.response.decision });
      case "answers":
        return options.respondToUserInput({ ...base, answers: job.response.answers });
      case "dismiss":
        return options.dismissUserInput(base);
    }
  };

  const track = (job: Job) => {
    const attempt = run(job);
    job.inFlight = attempt;
    running.add(attempt);
    void attempt.finally(() => {
      running.delete(attempt);
      if (job.inFlight === attempt) job.inFlight = null;
    });
  };

  const run = async (job: Job): Promise<void> => {
    job.cancelRetry = null;
    setStatus(job, { state: "sending", response: job.response });
    const result = await dispatch(job).catch((error: unknown): ComposerCommandResult => ({
      ok: false,
      error,
      interrupted: false,
    }));
    // Resolved elsewhere, or replaced, while this one was out.
    if (disposed || jobs.get(job.requestId) !== job) return;
    if (result.ok) {
      setStatus(job, { state: "sent", response: job.response });
      return;
    }
    const action = classifySendFailure(result.error, result.interrupted);
    options.onFailure?.(job.requestId, result.error, action);
    if (action === "restore") {
      setStatus(job, {
        state: "failed",
        response: job.response,
        error: describeSendFailure(result.error),
      });
      return;
    }
    job.attempt += 1;
    setStatus(job, { state: "waiting", response: job.response, attempt: job.attempt });
    job.cancelRetry = options.schedule(() => track(job), retryDelayMs(job.attempt - 1));
  };

  return {
    /**
     * Answers a request. A request already being answered, or answered, keeps that answer;
     * one the server turned down takes a new one with a new id.
     */
    respond(threadId: ThreadId, requestId: RuntimeRequestId, response: RequestResponse): boolean {
      if (disposed) return false;
      const existing = jobs.get(requestId);
      if (existing !== undefined && existing.status.state !== "failed") return false;
      const job: Job = {
        threadId,
        requestId,
        commandId: newCommandId(),
        response,
        attempt: 0,
        status: { state: "sending", response },
        cancelRetry: null,
        inFlight: null,
      };
      jobs.set(requestId, job);
      track(job);
      return true;
    },
    /**
     * One decline for a queued message, which retries with the same id. A lost connection
     * leaves nothing here, so a dropped message leaves no stale state. Null when there's
     * nothing to decline: answered another way, or resolved meanwhile.
     */
    async declineOnce(
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      commandId: CommandId,
    ): Promise<ComposerCommandResult | null> {
      if (disposed) return null;
      const existing = jobs.get(requestId);
      if (existing !== undefined && existing.status.state !== "failed") {
        // Its own decline from an earlier attempt still out: this one goes again.
        if (existing.commandId !== commandId || existing.status.state === "sent") return null;
      }
      existing?.cancelRetry?.();
      const job: Job = {
        threadId,
        requestId,
        commandId,
        response: DECLINE,
        attempt: 0,
        status: { state: "sending", response: DECLINE },
        cancelRetry: null,
        inFlight: null,
      };
      jobs.set(requestId, job);
      notify();
      const reply = dispatch(job).catch((error: unknown): ComposerCommandResult => ({
        ok: false,
        error,
        interrupted: false,
      }));
      const inFlight = reply.then(() => undefined);
      job.inFlight = inFlight;
      running.add(inFlight);
      const result = await reply;
      running.delete(inFlight);
      job.inFlight = null;
      // Pruned meanwhile: it resolved, so there's nothing left to decline.
      if (!jobs.has(requestId)) return null;
      // Replaced by a newer attempt, or the responder is gone: this reply decides nothing.
      if (disposed || jobs.get(requestId) !== job) return result;
      if (result.ok) {
        setStatus(job, { state: "sent", response: DECLINE });
        return result;
      }
      const action = classifySendFailure(result.error, result.interrupted);
      options.onFailure?.(requestId, result.error, action);
      if (action === "restore") {
        setStatus(job, {
          state: "failed",
          response: DECLINE,
          error: describeSendFailure(result.error),
        });
      } else {
        jobs.delete(requestId);
        notify();
      }
      return result;
    },
    status(requestId: RuntimeRequestId): ResponseStatus | null {
      return jobs.get(requestId)?.status ?? null;
    },
    /** Clears a turned-down response's error, e.g. once the user saw it and moved on. */
    clearFailure(requestId: RuntimeRequestId): void {
      if (jobs.get(requestId)?.status.state !== "failed") return;
      jobs.delete(requestId);
      notify();
    },
    /** Forgets a thread's responses for requests no longer pending, wherever they resolved. */
    prune(threadId: ThreadId, pendingRequestIds: ReadonlyArray<RuntimeRequestId>): void {
      const pending = new Set(pendingRequestIds);
      let changed = false;
      for (const [requestId, job] of jobs) {
        if (job.threadId !== threadId || pending.has(requestId)) continue;
        job.cancelRetry?.();
        jobs.delete(requestId);
        changed = true;
      }
      if (changed) notify();
    },
    /** Sends waiting responses now, e.g. once the connection is back. */
    retryWaiting(): void {
      for (const job of jobs.values()) {
        if (job.status.state !== "waiting") continue;
        job.cancelRetry?.();
        track(job);
      }
    },
    /** Resolves once every response out now has its reply. */
    async settled(): Promise<void> {
      while (running.size > 0) await Promise.all(running);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    dispose(): void {
      disposed = true;
      for (const job of jobs.values()) job.cancelRetry?.();
      jobs.clear();
      listeners.clear();
    },
  };
}

export type RequestResponder = ReturnType<typeof createRequestResponder>;
