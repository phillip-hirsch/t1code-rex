import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";

/** What the user has picked or typed for one question so far. */
export interface QuestionDraft {
  readonly selected: ReadonlyArray<string>;
  readonly custom: string;
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = { selected: [], custom: "" };

export type QuestionAnswer = string | ReadonlyArray<string>;

export function optionValue(option: ThreadUserInputQuestion["options"][number]): string {
  return option.value ?? option.label;
}

export function allowsCustomAnswer(question: ThreadUserInputQuestion): boolean {
  return question.allowCustomAnswer !== false;
}

/**
 * A question's draft before the user touched it: the provider's suggested answer, if any,
 * as typed text, like web and mobile seed it.
 */
export function initialDraft(question: ThreadUserInputQuestion): QuestionDraft {
  return question.initialAnswer !== undefined && allowsCustomAnswer(question)
    ? { selected: [], custom: question.initialAnswer }
    : EMPTY_QUESTION_DRAFT;
}

/**
 * The answer a draft gives, or null while it gives none. Typed text wins over a single
 * choice; a multi-select sends its choices when it has any. Mirrors web's rules.
 */
export function resolveAnswer(
  question: ThreadUserInputQuestion,
  draft: QuestionDraft,
): QuestionAnswer | null {
  const custom = allowsCustomAnswer(question) ? draft.custom.trim() : "";
  const known = new Set(question.options.map(optionValue));
  const selected = draft.selected.filter((value) => known.has(value));
  if (question.multiSelect) {
    if (selected.length > 0) return selected;
    return custom.length > 0 ? custom : null;
  }
  if (custom.length > 0) return custom;
  return selected[0] ?? null;
}

/** Picks an option: a single choice replaces the last one and clears typed text. */
export function toggleOption(
  question: ThreadUserInputQuestion,
  draft: QuestionDraft,
  value: string,
): QuestionDraft {
  if (!question.multiSelect) return { selected: [value], custom: "" };
  const selected = draft.selected.includes(value)
    ? draft.selected.filter((entry) => entry !== value)
    : [...draft.selected, value];
  return { selected, custom: draft.custom };
}

/** The form's answers keyed by question id, or null while any question has none. */
export function buildAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  drafts: ReadonlyMap<string, QuestionDraft>,
): Record<string, QuestionAnswer> | null {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const answer = resolveAnswer(question, drafts.get(question.id) ?? initialDraft(question));
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

/** The first question still unanswered, or the last one when all are. */
export function firstUnanswered(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  drafts: ReadonlyMap<string, QuestionDraft>,
): number {
  const index = questions.findIndex(
    (question) =>
      resolveAnswer(question, drafts.get(question.id) ?? initialDraft(question)) === null,
  );
  return index === -1 ? Math.max(0, questions.length - 1) : index;
}

/** A short line for a question's answer, e.g. in the sent state. */
export function answerText(answer: QuestionAnswer): string {
  return typeof answer === "string" ? answer : answer.join(", ");
}
