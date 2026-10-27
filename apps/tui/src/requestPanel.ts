// @effect-diagnostics globalDate:off -- The TUI runs on Bun outside the Effect runtime.
import type {
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";

import {
  allowsCustomAnswer,
  buildAnswers,
  firstUnanswered,
  initialDraft,
  optionValue,
  resolveAnswer,
  toggleOption,
  type QuestionAnswer,
  type QuestionDraft,
} from "./questionAnswers.ts";
import type { ApprovalChoice, PendingRequest } from "./requestQueue.ts";
import type { ResponseStatus } from "./requestResponder.ts";

/** Keys right after a request appears are ignored, so typing meant for the composer can't answer it. */
export const PANEL_ARM_DELAY_MS = 500;

/**
 * Tracks when each request came into view; keys count only after the arm delay, so a key
 * typed for the composer just as a request replaced it can't answer it.
 */
export function createArmGuard(now: () => number = Date.now) {
  let shown: { readonly requestId: RuntimeRequestId | null; readonly at: number } = {
    requestId: null,
    at: 0,
  };
  return {
    show(requestId: RuntimeRequestId | null): void {
      if (shown.requestId !== requestId) shown = { requestId, at: now() };
    },
    armed(requestId: RuntimeRequestId): boolean {
      return shown.requestId === requestId && now() - shown.at >= PANEL_ARM_DELAY_MS;
    },
  };
}

/** Whether a request still takes an answer: not answered yet, or its answer was turned down. */
export function isOpen(status: ResponseStatus | null): boolean {
  return status === null || status.state === "failed";
}

/**
 * The request the panel shows: the one picked, while it's open; otherwise the next open one
 * after it, so answering moves on without waiting for the server. With none open, the
 * picked one stays, showing that its answer is on the way.
 */
export function pickActiveRequest(
  queue: ReadonlyArray<PendingRequest>,
  preferred: RuntimeRequestId | null,
  statusOf: (requestId: RuntimeRequestId) => ResponseStatus | null,
): PendingRequest | null {
  if (queue.length === 0) return null;
  const start = Math.max(
    0,
    queue.findIndex((request) => request.requestId === preferred),
  );
  for (let offset = 0; offset < queue.length; offset += 1) {
    const request = queue[(start + offset) % queue.length];
    if (request !== undefined && isOpen(statusOf(request.requestId))) return request;
  }
  return queue[start] ?? null;
}

/** The open request `delta` steps from `current`, wrapping; null when there is no other. */
export function stepRequest(
  queue: ReadonlyArray<PendingRequest>,
  current: RuntimeRequestId,
  delta: 1 | -1,
  statusOf: (requestId: RuntimeRequestId) => ResponseStatus | null,
): RuntimeRequestId | null {
  const start = queue.findIndex((request) => request.requestId === current);
  for (let offset = 1; offset < queue.length; offset += 1) {
    const index = (((start + delta * offset) % queue.length) + queue.length) % queue.length;
    const request = queue[index];
    if (request !== undefined && isOpen(statusOf(request.requestId))) return request.requestId;
  }
  return null;
}

/** A question form's place: which question, which row, and the answers so far. */
export interface QuestionForm {
  readonly index: number;
  /** The option row under the cursor; `options.length` is the typed-answer row. */
  readonly cursor: number;
  readonly drafts: ReadonlyMap<string, QuestionDraft>;
  /** Bumped when the form rewrites typed text, so the text box reloads it. */
  readonly textRevision: number;
}

function firstRow(question: ThreadUserInputQuestion | undefined): number {
  return question === undefined || question.options.length > 0 ? 0 : question.options.length;
}

export function initialForm(input: ThreadPendingUserInput): QuestionForm {
  return { index: 0, cursor: firstRow(input.questions[0]), drafts: new Map(), textRevision: 0 };
}

export function activeQuestion(
  input: ThreadPendingUserInput,
  form: QuestionForm,
): ThreadUserInputQuestion | null {
  return input.questions[Math.min(form.index, input.questions.length - 1)] ?? null;
}

export function draftOf(form: QuestionForm, question: ThreadUserInputQuestion): QuestionDraft {
  return form.drafts.get(question.id) ?? initialDraft(question);
}

export function onTextRow(form: QuestionForm, question: ThreadUserInputQuestion): boolean {
  return allowsCustomAnswer(question) && form.cursor >= question.options.length;
}

function withDraft(
  form: QuestionForm,
  question: ThreadUserInputQuestion,
  draft: QuestionDraft,
): QuestionForm {
  const drafts = new Map(form.drafts);
  drafts.set(question.id, draft);
  const cleared = draftOf(form, question).custom !== "" && draft.custom === "";
  return { ...form, drafts, textRevision: form.textRevision + (cleared ? 1 : 0) };
}

/** Typed text for the active question; the text box calls this as the user types. */
export function setTypedAnswer(
  form: QuestionForm,
  question: ThreadUserInputQuestion,
  text: string,
): QuestionForm {
  const draft = draftOf(form, question);
  if (draft.custom === text) return form;
  const drafts = new Map(form.drafts);
  // Typing replaces a single choice, as web does.
  drafts.set(question.id, {
    selected: question.multiSelect || text.trim().length === 0 ? draft.selected : [],
    custom: text,
  });
  return { ...form, drafts };
}

function goToQuestion(
  input: ThreadPendingUserInput,
  form: QuestionForm,
  index: number,
): QuestionForm {
  return { ...form, index, cursor: firstRow(input.questions[index]) };
}

export interface PanelKey {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export type PanelKeyContext =
  | {
      readonly kind: "approval";
      readonly choices: ReadonlyArray<ApprovalChoice>;
      /** An answer is on its way, or the request can't be answered. */
      readonly busy: boolean;
      readonly armed: boolean;
    }
  | {
      readonly kind: "question";
      readonly input: ThreadPendingUserInput;
      readonly form: QuestionForm;
      readonly busy: boolean;
      readonly armed: boolean;
    };

export type PanelAction =
  | { readonly type: "step-request"; readonly delta: 1 | -1 }
  | { readonly type: "decide"; readonly decision: ProviderApprovalDecision }
  | { readonly type: "form"; readonly form: QuestionForm }
  | { readonly type: "submit"; readonly answers: Readonly<Record<string, QuestionAnswer>> }
  | { readonly type: "dismiss" }
  | { readonly type: "hint"; readonly message: string; readonly form?: QuestionForm }
  /** Used up, nothing to do. */
  | { readonly type: "none" };

const NONE: PanelAction = { type: "none" };

function isEnterKey(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter";
}

function digitOf(key: PanelKey): number | null {
  if (key.ctrl || key.meta) return null;
  const digit = /^[1-9]$/.test(key.name) ? Number(key.name) : null;
  return digit;
}

function stepRequestKey(key: PanelKey): 1 | -1 | null {
  if (key.ctrl || key.meta) return null;
  if (key.name === "]" || key.sequence === "]") return 1;
  if (key.name === "[" || key.sequence === "[") return -1;
  return null;
}

/** What a key does in the request panel; null leaves it to the text box or the shell. */
export function resolvePanelKey(key: PanelKey, context: PanelKeyContext): PanelAction | null {
  const step = stepRequestKey(key);
  if (context.kind === "approval") {
    if (step !== null) return { type: "step-request", delta: step };
    if (key.ctrl || key.meta) return null;
    const digit = digitOf(key);
    const letter = key.name.length === 1 ? key.name.toLowerCase() : null;
    const choice =
      digit !== null
        ? context.choices[digit - 1]
        : letter === null
          ? undefined
          : context.choices.find((entry) => entry.key === letter);
    if (choice === undefined) {
      if (isEnterKey(key.name) && context.choices.length > 0) {
        return { type: "hint", message: `Press 1–${context.choices.length} to choose` };
      }
      return null;
    }
    if (context.busy || !context.armed) return NONE;
    return { type: "decide", decision: choice.decision };
  }

  const { input, form } = context;
  const question = activeQuestion(input, form);
  if (question === null) return null;
  const typing = onTextRow(form, question);
  // The text box is unfocused while an answer is out; only moving to another request works.
  if (context.busy) return step === null ? null : { type: "step-request", delta: step };

  const advance = (next: QuestionForm): PanelAction => {
    const answer = resolveAnswer(question, draftOf(next, question));
    if (answer === null) {
      return {
        type: "hint",
        message: allowsCustomAnswer(question)
          ? "Pick an option or type an answer"
          : "Pick an option",
        form: next,
      };
    }
    if (next.index < input.questions.length - 1) {
      return { type: "form", form: goToQuestion(input, next, next.index + 1) };
    }
    const answers = buildAnswers(input.questions, next.drafts);
    if (answers === null) {
      return {
        type: "hint",
        message: "Answer every question first",
        form: goToQuestion(input, next, firstUnanswered(input.questions, next.drafts)),
      };
    }
    return { type: "submit", answers };
  };

  if (key.name === "escape") {
    if (!context.armed) return NONE;
    return input.dismissible
      ? { type: "dismiss" }
      : { type: "hint", message: "This question needs an answer; stop the run to skip it" };
  }

  if (typing) {
    if (isEnterKey(key.name) && !key.shift) return context.armed ? advance(form) : NONE;
    if (key.name === "up" && question.options.length > 0) {
      return { type: "form", form: { ...form, cursor: question.options.length - 1 } };
    }
    return null;
  }

  if (step !== null) return { type: "step-request", delta: step };
  const lastRow = question.options.length - (allowsCustomAnswer(question) ? 0 : 1);
  if (key.name === "up" || key.name === "k") {
    return { type: "form", form: { ...form, cursor: Math.max(0, form.cursor - 1) } };
  }
  if (key.name === "down" || key.name === "j") {
    return { type: "form", form: { ...form, cursor: Math.min(lastRow, form.cursor + 1) } };
  }
  if (key.name === "left" || key.name === "h") {
    return form.index > 0
      ? { type: "form", form: goToQuestion(input, form, form.index - 1) }
      : NONE;
  }
  if (key.name === "right" || key.name === "l") {
    if (form.index >= input.questions.length - 1) return NONE;
    return resolveAnswer(question, draftOf(form, question)) === null
      ? { type: "hint", message: "Answer this question first" }
      : { type: "form", form: goToQuestion(input, form, form.index + 1) };
  }

  const pick = (index: number): QuestionForm | null => {
    const option = question.options[index];
    if (option === undefined) return null;
    return {
      ...withDraft(
        form,
        question,
        toggleOption(question, draftOf(form, question), optionValue(option)),
      ),
      cursor: index,
    };
  };
  const digit = digitOf(key);
  if (digit !== null) {
    if (!context.armed) return NONE;
    const next = pick(digit - 1);
    return next === null ? NONE : { type: "form", form: next };
  }
  if (key.name === "space") {
    if (!context.armed) return NONE;
    const next = pick(form.cursor);
    return next === null ? NONE : { type: "form", form: next };
  }
  if (isEnterKey(key.name)) {
    if (!context.armed) return NONE;
    const option = question.options[form.cursor];
    const draft = draftOf(form, question);
    // Enter takes the option under the cursor, unless a multi-select already has picks.
    const needsPick =
      option !== undefined &&
      (question.multiSelect
        ? resolveAnswer(question, draft) === null
        : !draft.selected.includes(optionValue(option)) || draft.custom.trim().length > 0);
    return advance(needsPick ? (pick(form.cursor) ?? form) : form);
  }
  return null;
}
