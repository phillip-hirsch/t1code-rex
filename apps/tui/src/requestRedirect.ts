import { CommandId, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";

import { classifySendFailure, describeSendFailure, type ComposerSend } from "./composerSend.ts";
import type { ComposerCommandResult, DeclineApprovalsInput } from "./composerSender.ts";
import { isOpen } from "./requestPanel.ts";
import type { PendingRequest } from "./requestQueue.ts";
import type { RequestResponder } from "./requestResponder.ts";

export const NOT_DECLINED = "Not sent: declining the approval didn't go through";
export const ANOTHER_ARRIVED =
  "Not sent: another approval came in. Send it again to decline that one too";

const OK: ComposerCommandResult = { ok: true };

/**
 * Upstream web's redirect, for a message sent from the composer: if the panel shows a live
 * approval, the message declines it first, then steers the run it kept waiting. Only the
 * approval on screen is declined; a question on screen, or nothing, leaves the send alone.
 */
export function redirectSend(
  send: ComposerSend,
  view: {
    /** The request the panel shows now, or null when none is in view. */
    readonly active: PendingRequest | null;
    readonly statusOf: RequestResponder["status"];
    /** Every request pending on the thread, shown or held. */
    readonly queue: ReadonlyArray<PendingRequest>;
  },
): ComposerSend {
  const { active } = view;
  if (
    send.target.kind !== "thread" ||
    active === null ||
    active.kind !== "approval" ||
    active.approval.responseCapability !== "live" ||
    !isOpen(view.statusOf(active.requestId))
  ) {
    return send;
  }
  return {
    ...send,
    dispatch: "steer",
    declines: {
      requestIds: [active.requestId],
      knownApprovalIds: view.queue.flatMap((request) =>
        request.kind === "approval" ? [request.requestId] : [],
      ),
    },
  };
}

export interface RedirectDeclinerOptions {
  readonly responder: Pick<RequestResponder, "declineOnce">;
  /** Approvals pending on a thread now; null when this window can't tell. */
  readonly pendingApprovalIds: (threadId: ThreadId) => ReadonlyArray<RuntimeRequestId> | null;
}

const failed = (message: string): ComposerCommandResult => ({
  ok: false,
  error: new Error(message),
  interrupted: false,
});

/**
 * Runs a message's decline stage inside its sender job, so the queue's order, Stop, discard,
 * retries and quit cover it. Each decline's id derives from the message's, so a retry can't
 * answer twice. An approval resolved before its turn is skipped. A turned-down decline, or
 * an approval that arrived since the message was sent, sends the message back with why.
 */
export function createRedirectDecliner(options: RedirectDeclinerOptions) {
  return async (input: DeclineApprovalsInput): Promise<ComposerCommandResult> => {
    const { threadId, declines } = input;
    for (const requestId of declines.requestIds) {
      const pending = options.pendingApprovalIds(threadId);
      if (pending !== null && !pending.includes(requestId)) continue;
      const commandId = CommandId.make(`${input.commandId}:decline:${requestId}`);
      const result = await options.responder.declineOnce(threadId, requestId, commandId);
      if (result === null || result.ok) continue;
      if (classifySendFailure(result.error, result.interrupted) === "retry") return result;
      return failed(`${NOT_DECLINED} (${describeSendFailure(result.error)})`);
    }
    const pending = options.pendingApprovalIds(threadId);
    if (pending?.some((requestId) => !declines.knownApprovalIds.includes(requestId))) {
      return failed(ANOTHER_ARRIVED);
    }
    return OK;
  };
}
