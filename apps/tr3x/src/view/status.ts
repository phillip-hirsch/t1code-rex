import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

/** The root OSC 7501 record, in the shape OpenTUI's `setProgramStatus` takes. */
export type RexStatus =
  | {
      readonly state: "idle" | "working" | "done" | "error";
      readonly app: "tr3x";
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly state: "blocked";
      readonly kind: "permission" | "question";
      readonly app: "tr3x";
      readonly title: string;
      readonly message: string;
    };

export interface RexStatusInput {
  readonly title: string;
  readonly requests: PendingThreadRequests | null;
  readonly activeRun: boolean;
  readonly latestRun: { readonly id: RunId; readonly status: OrchestrationV2RunStatus } | null;
  /** The latest run the user has seen finish: a key press after it ended. */
  readonly seenRunId: RunId | null;
  /** The last reply's first line, for `msg`. */
  readonly lastReply: string | null;
}

// The protocol refuses decoded text with C0, DEL or C1 controls; bidi controls could disguise it.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/gu;
const MSG_BYTES = 2048;
const TITLE_BYTES = 192;

/** Model text as one line the protocol accepts: no controls, at most `maxBytes` of UTF-8. */
export function sanitizeStatusText(text: string, maxBytes: number): string {
  const line = text.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(line) <= maxBytes) return line;
  let out = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes - 3) break;
    out += char;
    bytes += size;
  }
  return `${out}…`;
}

export function resolveRexStatus(input: RexStatusInput): RexStatus {
  const title = sanitizeStatusText(input.title, TITLE_BYTES);
  const status = (state: "idle" | "working" | "done" | "error", message: string): RexStatus => ({
    state,
    app: "tr3x",
    title,
    message: sanitizeStatusText(message, MSG_BYTES),
  });
  const approval = input.requests?.approvals[0];
  if (approval) {
    return {
      state: "blocked",
      kind: "permission",
      app: "tr3x",
      title,
      message: sanitizeStatusText(
        approval.detail ?? approval.reason ?? `Approve ${approval.requestKind}`,
        MSG_BYTES,
      ),
    };
  }
  const question = input.requests?.userInputs[0]?.questions[0];
  if (question) {
    return {
      state: "blocked",
      kind: "question",
      app: "tr3x",
      title,
      message: sanitizeStatusText(question.question, MSG_BYTES),
    };
  }
  if (input.activeRun) return status("working", input.lastReply ?? "Working");
  const latest = input.latestRun;
  if (latest !== null && latest.id !== input.seenRunId) {
    if (latest.status === "failed") return status("error", "The run failed");
    if (latest.status === "completed") return status("done", input.lastReply ?? "Done");
  }
  return status("idle", input.lastReply ?? "Ready");
}

export function sameRexStatus(a: RexStatus | null, b: RexStatus): boolean {
  return (
    a !== null &&
    a.state === b.state &&
    a.title === b.title &&
    a.message === b.message &&
    (a.state === "blocked" ? a.kind : null) === (b.state === "blocked" ? b.kind : null)
  );
}
