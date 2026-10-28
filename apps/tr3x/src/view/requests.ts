import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision } from "@t3tools/contracts";

/** The request the panel shows: approvals first, then questions, oldest first. */
export type ActiveRequest =
  | { readonly type: "approval"; readonly approval: ThreadPendingApproval }
  | { readonly type: "question"; readonly input: ThreadPendingUserInput };

export function activeRequest(requests: PendingThreadRequests | null): ActiveRequest | null {
  const approval = requests?.approvals[0];
  if (approval) return { type: "approval", approval };
  const input = requests?.userInputs[0];
  return input ? { type: "question", input } : null;
}

export interface ApprovalChoice {
  readonly key: string;
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
}

const DECISION_KEYS: Record<ProviderApprovalDecision, string> = {
  accept: "a",
  acceptForSession: "s",
  acceptAlways: "w",
  decline: "d",
  cancel: "c",
};

const DEFAULT_CHOICES: ReadonlyArray<ApprovalChoice> = [
  { key: "a", decision: "accept", label: "accept" },
  { key: "s", decision: "acceptForSession", label: "accept for session" },
  { key: "d", decision: "decline", label: "decline" },
];

/** The provider's own options when it lists them, else accept / accept for session / decline. */
export function approvalChoices(approval: ThreadPendingApproval): ReadonlyArray<ApprovalChoice> {
  if (!approval.options?.length) return DEFAULT_CHOICES;
  return approval.options.map((option) => ({
    key: DECISION_KEYS[option.decision],
    decision: option.decision,
    label: option.label,
  }));
}

/** An answer to one question: typed text or an option's value, or several for a multi-select. */
export type Answer = string | ReadonlyArray<string>;

/** What the user picked or typed for one question. */
export interface QuestionDraft {
  readonly cursor: number;
  readonly picked: ReadonlyArray<string>;
  readonly text: string;
}

export function optionValue(option: ThreadUserInputQuestion["options"][number]): string {
  return option.value ?? option.label;
}

export function initialDraft(question: ThreadUserInputQuestion): QuestionDraft {
  return {
    cursor: 0,
    picked: [],
    text: question.allowCustomAnswer === false ? "" : (question.initialAnswer ?? ""),
  };
}

/**
 * The answer a draft gives, or null while it gives none. Typed text wins over
 * picked options; a multi-select sends its picks as a list; with nothing picked,
 * the highlighted option is the answer. Mirrors web's rules.
 */
export function resolveAnswer(
  question: ThreadUserInputQuestion,
  draft: QuestionDraft,
): Answer | null {
  const text = question.allowCustomAnswer === false ? "" : draft.text.trim();
  if (text) return text;
  if (question.multiSelect && draft.picked.length > 0) return draft.picked;
  const highlighted = question.options[draft.cursor];
  if (!highlighted) return null;
  return question.multiSelect ? [optionValue(highlighted)] : optionValue(highlighted);
}

export function togglePicked(draft: QuestionDraft, value: string): QuestionDraft {
  const picked = draft.picked.includes(value)
    ? draft.picked.filter((entry) => entry !== value)
    : [...draft.picked, value];
  return { ...draft, picked };
}
