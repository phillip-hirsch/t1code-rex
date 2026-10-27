import type { RuntimeRequestId, ThreadId } from "@t3tools/contracts";

import type { ComposerSend } from "./composerSend.ts";
import type { ComposerSender } from "./composerSender.ts";
import type { ComposerStore } from "./composerStore.ts";
import type { RequestResponder } from "./requestResponder.ts";

export interface RedirectApproval {
  readonly requestId: RuntimeRequestId;
  /** Only a live approval can be declined; one the provider lost has nothing to decline. */
  readonly live: boolean;
}

export interface RedirectingSenderOptions {
  readonly sender: ComposerSender;
  readonly store: Pick<ComposerStore, "beginSend" | "finishSend" | "restoreSend">;
  readonly responder: Pick<RequestResponder, "respond" | "outcome">;
  /** The approvals the panel shows on a thread now: in view, and not answered yet. */
  readonly shownApprovals: (threadId: ThreadId) => ReadonlyArray<RedirectApproval>;
  /** Every approval pending on a thread, shown or held. */
  readonly pendingApprovalIds: (threadId: ThreadId) => ReadonlyArray<RuntimeRequestId>;
}

const NOT_DECLINED =
  "Not sent: declining the approval didn't go through yet. Send it again when you're ready.";
const ANOTHER_ARRIVED =
  "Not sent: another approval came in. Send it again to decline that one too.";

/**
 * Upstream web's redirect: a message sent while approvals are shown declines them, then
 * steers the run, which an open approval would keep waiting. If a decline fails or another
 * approval arrives meanwhile, the message goes back into the composer.
 */
export function createRedirectingSender(options: RedirectingSenderOptions): ComposerSender {
  const { sender, store, responder } = options;
  const redirect = async (send: ComposerSend): Promise<void> => {
    const threadId = send.target.threadId;
    const approvals =
      send.target.kind === "thread"
        ? options.shownApprovals(threadId).filter((approval) => approval.live)
        : [];
    if (approvals.length === 0) return sender.send(send);

    const steer: ComposerSend = { ...send, dispatch: "steer" };
    // Shown as on its way while the declines go out.
    store.beginSend(steer);
    const before = new Set(options.pendingApprovalIds(threadId));
    for (const approval of approvals) {
      responder.respond(threadId, approval.requestId, {
        type: "approval",
        decision: "decline",
      });
    }
    const outcomes = await Promise.all(
      approvals.map((approval) => responder.outcome(approval.requestId)),
    );
    // Null: resolved and pruned meanwhile, so there's nothing left to decline.
    if (!outcomes.every((outcome) => outcome === null || outcome.state === "sent")) {
      store.restoreSend(steer, NOT_DECLINED);
      return;
    }
    if (options.pendingApprovalIds(threadId).some((requestId) => !before.has(requestId))) {
      store.restoreSend(steer, ANOTHER_ARRIVED);
      return;
    }
    store.finishSend(steer);
    return sender.send(steer);
  };
  return { ...sender, send: redirect };
}
