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
  typeAnswer,
  type QuestionAnswer,
  type QuestionDraft,
} from "./questionAnswers.ts";
import type { ApprovalChoice, PendingRequest, RequestRun } from "./requestQueue.ts";
import type { ResponseStatus } from "./requestResponder.ts";

/** How long a request must be in view, or keys must stop, before the panel takes decisions. */
export const PANEL_QUIET_MS = 750;

/**
 * Where the panel stands for a key: `engaged` takes decisions; `ready` and `typing` are
 * disengaged, and only `ready` lets Enter engage it.
 */
export type Engagement = "engaged" | "ready" | "typing";

/**
 * Behind focus, a second layer: entering engages the panel only once its request has been in
 * view for PANEL_QUIET_MS; otherwise Enter after PANEL_QUIET_MS with no keys does. Every key
 * while disengaged restarts that wait, and another request disengages it.
 */
export function createEngagementGuard(now: () => number = Date.now) {
  let shown = {
    requestId: null as RuntimeRequestId | null,
    shownAt: 0,
    quietSince: 0,
    engaged: false,
  };
  const show = (requestId: RuntimeRequestId | null): void => {
    if (shown.requestId === requestId) return;
    const at = now();
    shown = { requestId, shownAt: at, quietSince: at, engaged: false };
  };
  const settled = (requestId: RuntimeRequestId): boolean =>
    shown.requestId === requestId && now() - shown.shownAt >= PANEL_QUIET_MS;
  return {
    show,
    /** For a key the panel is about to handle: where it stands. The key restarts the wait. */
    press(requestId: RuntimeRequestId): Engagement {
      show(requestId);
      const at = now();
      const state: Engagement = shown.engaged
        ? "engaged"
        : at - shown.quietSince >= PANEL_QUIET_MS
          ? "ready"
          : "typing";
      shown.quietSince = at;
      return state;
    },
    engage(requestId: RuntimeRequestId): void {
      show(requestId);
      shown.engaged = true;
    },
    /** Focus moved to the panel (Tab or a click): engages it once the request has settled. */
    enter(requestId: RuntimeRequestId): boolean {
      show(requestId);
      if (settled(requestId)) shown.engaged = true;
      return shown.engaged;
    },
    engaged(requestId: RuntimeRequestId | null): boolean {
      return requestId !== null && shown.requestId === requestId && shown.engaged;
    },
    /** In view long enough that a click or Tab is aimed at it, not at what was there before. */
    settled,
  };
}

export type EngagementGuard = ReturnType<typeof createEngagementGuard>;

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
  drafts.set(question.id, typeAnswer(question, draft, text));
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
  readonly option?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
  /** A held key's auto-repeat (kitty keyboard protocol); never a fresh press. */
  readonly repeated?: boolean;
}

/** What the panel shares with the composer: the run that Ctrl+C stops. */
export interface PanelRunState {
  readonly running: boolean;
  /** Stop was already sent for this run, so another Ctrl+C quits instead. */
  readonly stopRequested: boolean;
}

/**
 * Whether the run a request belongs to was stopped: the run says it ended, or Stop was sent
 * for it. `stopSentRunId` is the run Stop was last sent for; a request with no known run
 * goes by the active run's `stopRequested`.
 */
export function requestRunStopped(
  request: RequestRun,
  stop: { readonly stopSentRunId: string | null; readonly stopRequested: boolean },
): boolean {
  if (request.runEnded) return true;
  return request.runId === null ? stop.stopRequested : request.runId === stop.stopSentRunId;
}

/**
 * The decisions a request offers now. Once its run was stopped, approving would act for a
 * run that's gone, so only declining is left, to clear it.
 */
export function availableChoices(
  choices: ReadonlyArray<ApprovalChoice>,
  stopped: boolean,
): ReadonlyArray<ApprovalChoice> {
  if (!stopped) return choices;
  const decline = choices.filter((choice) => choice.decision === "decline");
  return decline.length > 0 ? decline : choices.filter((choice) => choice.decision === "cancel");
}

export type PanelKeyContext = PanelRunState &
  (
    | {
        readonly kind: "approval";
        /** What can be decided now; see availableChoices. */
        readonly choices: ReadonlyArray<ApprovalChoice>;
        /** An answer is on its way, or the request can't be answered. */
        readonly busy: boolean;
        readonly engagement: Engagement;
      }
    | {
        readonly kind: "question";
        readonly input: ThreadPendingUserInput;
        readonly form: QuestionForm;
        readonly busy: boolean;
        readonly engagement: Engagement;
      }
  );

export type PanelAction =
  | { readonly type: "engage" }
  /** Back to the composer. */
  | { readonly type: "leave" }
  | { readonly type: "stop" }
  | { readonly type: "exit" }
  | { readonly type: "step-request"; readonly delta: 1 | -1 }
  | { readonly type: "decide"; readonly decision: ProviderApprovalDecision }
  | { readonly type: "form"; readonly form: QuestionForm }
  | { readonly type: "submit"; readonly answers: Readonly<Record<string, QuestionAnswer>> }
  | { readonly type: "dismiss" }
  | { readonly type: "hint"; readonly message: string; readonly form?: QuestionForm }
  /** Used up, nothing to do. */
  | { readonly type: "none" };

const NONE: PanelAction = { type: "none" };

export const ENGAGE_HINT = "Press ⏎ to respond";
const STILL_TYPING_HINT = "Keys were still coming in; pause, then press ⏎ to respond";
const REPEAT_HINT = "Let go of the key, then press it again";

function isEnterKey(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter";
}

/** Ctrl, Alt/Option, Cmd/Super or Hyper: a shortcut, never a decision. */
function hasModifier(key: PanelKey): boolean {
  return Boolean(key.ctrl || key.meta || key.option || key.super || key.hyper);
}

/** Keys that only move the cursor; a held one may repeat. */
const MOVE_KEYS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "j", "k", "h", "l"]);

function digitOf(key: PanelKey): number | null {
  return /^[1-9]$/.test(key.name) ? Number(key.name) : null;
}

function stepRequestKey(key: PanelKey): 1 | -1 | null {
  if (key.name === "]" || key.sequence === "]") return 1;
  if (key.name === "[" || key.sequence === "[") return -1;
  return null;
}

/**
 * Resolves a key with the guard: where the panel stands goes into `context`, the key
 * restarts the guard's wait, and an engage action engages it.
 */
export function pressPanelKey(
  guard: EngagementGuard,
  requestId: RuntimeRequestId,
  key: PanelKey,
  context: (engagement: Engagement) => PanelKeyContext,
): PanelAction | null {
  const action = resolvePanelKey(key, context(guard.press(requestId)));
  if (action?.type === "engage") guard.engage(requestId);
  return action;
}

/**
 * What a key does in the focused request panel; null leaves it to the panel's text box.
 * A held key's repeats only move the cursor or type: engaging, picking, deciding and
 * submitting each take a fresh press.
 */
export function resolvePanelKey(key: PanelKey, context: PanelKeyContext): PanelAction | null {
  const action = resolveFreshKey(key, context);
  if (!key.repeated || action === null || MOVE_KEYS.has(key.name)) return action;
  switch (action.type) {
    case "step-request":
    case "none":
      return action;
    // Holding Ctrl+C must not stop the run and then quit: each takes a fresh press.
    case "stop":
    case "exit":
      return NONE;
    case "hint":
      return action.form === undefined ? action : { type: "hint", message: REPEAT_HINT };
    default:
      return { type: "hint", message: REPEAT_HINT };
  }
}

function resolveFreshKey(key: PanelKey, context: PanelKeyContext): PanelAction | null {
  // Ctrl+C stops the run first, as in the composer; it quits once nothing runs.
  if (key.ctrl && key.name === "c") {
    return context.running && !context.stopRequested ? { type: "stop" } : { type: "exit" };
  }
  if (key.name === "tab" || (key.name === "escape" && !hasModifier(key))) {
    return key.repeated ? NONE : { type: "leave" };
  }
  if (hasModifier(key) && !(context.kind === "question" && key.ctrl && key.name === "x")) {
    return null;
  }

  const step = stepRequestKey(key);
  const onText =
    context.kind === "question" &&
    context.engagement === "engaged" &&
    !context.busy &&
    (() => {
      const question = activeQuestion(context.input, context.form);
      return question !== null && onTextRow(context.form, question);
    })();
  // Moving to another request works whatever state this one is in.
  if (step !== null && !onText) return { type: "step-request", delta: step };
  // An answer is out, or the request can't be answered.
  if (context.busy) return NONE;

  // Disengaged, every key is used up; only Enter after a pause engages the panel.
  if (context.engagement !== "engaged") {
    if (isEnterKey(key.name) && !key.shift && context.engagement === "ready") {
      return key.repeated ? NONE : { type: "engage" };
    }
    return {
      type: "hint",
      message: isEnterKey(key.name) ? STILL_TYPING_HINT : ENGAGE_HINT,
    };
  }

  if (context.kind === "approval") {
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
    return { type: "decide", decision: choice.decision };
  }

  const { input, form } = context;
  const question = activeQuestion(input, form);
  if (question === null) return null;
  const typing = onTextRow(form, question);

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

  if (key.ctrl && key.name === "x") {
    if (!input.dismissible) return { type: "hint", message: "This question needs an answer" };
    return context.running
      ? { type: "hint", message: "Ctrl+C stops the run; then Ctrl+X dismisses this" }
      : { type: "dismiss" };
  }

  if (typing) {
    if (isEnterKey(key.name) && !key.shift) return advance(form);
    if (key.name === "up" && question.options.length > 0) {
      return { type: "form", form: { ...form, cursor: question.options.length - 1 } };
    }
    return null;
  }

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
    const next = pick(digit - 1);
    return next === null ? NONE : { type: "form", form: next };
  }
  if (key.name === "space") {
    const next = pick(form.cursor);
    return next === null ? NONE : { type: "form", form: next };
  }
  if (isEnterKey(key.name)) {
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
