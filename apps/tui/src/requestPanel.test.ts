import { RunId, type RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ENGAGE_HINT,
  PANEL_QUIET_MS,
  availableChoices,
  createEngagementGuard,
  initialForm,
  pickActiveRequest,
  pressPanelKey,
  requestRunStopped,
  resolvePanelKey,
  setTypedAnswer,
  stepRequest,
  type PanelAction,
  type PanelKey,
  type QuestionForm,
} from "./requestPanel.ts";
import { approvalChoices, deriveRequestQueue, type PendingRequest } from "./requestQueue.ts";
import type { ResponseStatus } from "./requestResponder.ts";
import {
  approvalItem,
  question,
  questionItem,
  runtimeRequest,
  source,
} from "./requestTestFixtures.ts";

const sent: ResponseStatus = {
  state: "sent",
  response: { type: "approval", decision: "accept" },
};

function queueOf(ids: ReadonlyArray<string>): ReadonlyArray<PendingRequest> {
  return deriveRequestQueue(
    source({
      runtimeRequests: ids.map((id, index) => runtimeRequest(id, "command", { second: index })),
      turnItems: ids.map((id) => approvalItem(id)),
    }),
  );
}

function questionInput(
  questions: ReadonlyArray<Record<string, unknown>>,
  fields: Record<string, unknown> = {},
  capability?: Record<string, unknown>,
) {
  const [request] = deriveRequestQueue(
    source({
      runtimeRequests: [runtimeRequest("q", "user_input", capability ? { capability } : {})],
      turnItems: [questionItem("q", questions, fields)],
    }),
  );
  if (request?.kind !== "question") throw new Error("expected a question");
  return request.input;
}

const key = (name: string, extra: Partial<PanelKey> = {}): PanelKey => ({ name, ...extra });

describe("pickActiveRequest", () => {
  const statuses = (map: Record<string, ResponseStatus>) => (id: RuntimeRequestId) =>
    map[id] ?? null;

  it("shows the picked request, or the oldest when none is picked", () => {
    const queue = queueOf(["a", "b"]);
    expect(pickActiveRequest(queue, null, statuses({}))?.requestId).toBe("a");
    expect(pickActiveRequest(queue, "b" as RuntimeRequestId, statuses({}))?.requestId).toBe("b");
  });

  it("moves past a request once it's answered, without waiting for the server", () => {
    const queue = queueOf(["a", "b", "c"]);
    expect(
      pickActiveRequest(queue, "a" as RuntimeRequestId, statuses({ a: sent }))?.requestId,
    ).toBe("b");
    expect(
      pickActiveRequest(queue, "c" as RuntimeRequestId, statuses({ c: sent }))?.requestId,
    ).toBe("a");
  });

  it("keeps the answered request in view when nothing else is open", () => {
    const queue = queueOf(["a"]);
    expect(pickActiveRequest(queue, null, statuses({ a: sent }))?.requestId).toBe("a");
  });

  it("steps between open requests only, wrapping", () => {
    const queue = queueOf(["a", "b", "c"]);
    const status = statuses({ b: sent });
    expect(stepRequest(queue, "a" as RuntimeRequestId, 1, status)).toBe("c");
    expect(stepRequest(queue, "a" as RuntimeRequestId, -1, status)).toBe("c");
    expect(stepRequest(queueOf(["a"]), "a" as RuntimeRequestId, 1, status)).toBeNull();
  });
});

const idle = { running: false, stopRequested: false } as const;

describe("engagement", () => {
  const [request] = queueOf(["a"]);
  if (request?.kind !== "approval") throw new Error("expected an approval");
  const choices = approvalChoices(request.approval);
  const id = request.requestId;

  /** A guard on a fake clock, and keys pressed into it `gapMs` apart, as the panel does. */
  function panel() {
    let now = 1_000;
    const guard = createEngagementGuard(() => now);
    guard.show(id);
    const decisions: string[] = [];
    const press = (text: string, gapMs: number) => {
      for (const name of text) {
        now += gapMs;
        const action = pressPanelKey(
          guard,
          id,
          key(name === "\r" ? "return" : name),
          (engagement) => ({
            kind: "approval",
            choices,
            busy: false,
            engagement,
            ...idle,
          }),
        );
        if (action?.type === "decide") decisions.push(action.decision);
      }
    };
    return { guard, decisions, press, wait: (ms: number) => (now += ms) };
  }

  it("never answers from typing that carries on from the composer, however long", () => {
    const { decisions, press, guard } = panel();
    // Five seconds of steady typing, Enter included, across the handoff.
    press("yes sure, approve it\ry s a 1 2\r".repeat(4), 50);
    expect(decisions).toEqual([]);
    expect(guard.engaged(id)).toBe(false);
  });

  it("ignores typing after a pause too, until Enter after a pause engages it", () => {
    const { decisions, press, wait, guard } = panel();
    press("let me check", 80);
    wait(PANEL_QUIET_MS * 3);
    press("yes", 80);
    expect(decisions).toEqual([]);
    wait(PANEL_QUIET_MS);
    press("\r", 0);
    expect(guard.engaged(id)).toBe(true);
    // The engaging Enter decides nothing; the next key does.
    expect(decisions).toEqual([]);
    press("y", 10);
    expect(decisions).toEqual(["accept"]);
  });

  it("says why a key did nothing", () => {
    let now = 0;
    const guard = createEngagementGuard(() => now);
    const context = (engagement: ReturnType<typeof guard.press>) => ({
      kind: "approval" as const,
      choices,
      busy: false,
      engagement,
      ...idle,
    });
    guard.show(id);
    now += 10;
    expect(pressPanelKey(guard, id, key("y"), context)).toEqual({
      type: "hint",
      message: ENGAGE_HINT,
    });
    now += 10;
    expect(pressPanelKey(guard, id, key("return"), context)).toMatchObject({ type: "hint" });
    now += PANEL_QUIET_MS;
    expect(pressPanelKey(guard, id, key("return"), context)).toEqual({ type: "engage" });
  });

  it("disengages when another request comes into view", () => {
    let now = 0;
    const guard = createEngagementGuard(() => now);
    guard.show(id);
    guard.engage(id);
    expect(guard.engaged(id)).toBe(true);
    const other = "b" as RuntimeRequestId;
    guard.show(other);
    expect(guard.engaged(other)).toBe(false);
    // Coming back to the first one needs a new Enter, too.
    guard.show(id);
    expect(guard.engaged(id)).toBe(false);
  });

  it("engages on Tab into the panel only once the request has settled in view", () => {
    let now = 0;
    const guard = createEngagementGuard(() => now);
    guard.show(id);
    now += PANEL_QUIET_MS - 1;
    // Too soon: the panel takes focus but stays disengaged until Enter after a pause.
    expect(guard.enter(id)).toBe(false);
    expect(guard.engaged(id)).toBe(false);
    now += 1;
    expect(guard.enter(id)).toBe(true);
    expect(guard.engaged(id)).toBe(true);
  });

  it("takes a click only once the request has been in view for the quiet period", () => {
    let now = 0;
    const guard = createEngagementGuard(() => now);
    guard.show(id);
    now += PANEL_QUIET_MS - 1;
    expect(guard.settled(id)).toBe(false);
    now += 1;
    expect(guard.settled(id)).toBe(true);
  });
});

describe("resolvePanelKey: approvals", () => {
  const [request] = queueOf(["a"]);
  if (request?.kind !== "approval") throw new Error("expected an approval");
  const choices = approvalChoices(request.approval);
  const context = {
    kind: "approval" as const,
    choices,
    busy: false,
    engagement: "engaged" as const,
    ...idle,
  };

  it("picks a decision by number or by letter", () => {
    expect(resolvePanelKey(key("1"), context)).toEqual({ type: "decide", decision: "accept" });
    expect(resolvePanelKey(key("2"), context)).toEqual({
      type: "decide",
      decision: "acceptForSession",
    });
    expect(resolvePanelKey(key("n"), context)).toEqual({ type: "decide", decision: "decline" });
    expect(resolvePanelKey(key("c"), context)).toEqual({ type: "decide", decision: "cancel" });
  });

  it("ignores decisions until the panel is engaged, and while an answer is out", () => {
    for (const engagement of ["ready", "typing"] as const) {
      expect(resolvePanelKey(key("y"), { ...context, engagement })).toEqual({
        type: "hint",
        message: ENGAGE_HINT,
      });
    }
    expect(resolvePanelKey(key("y"), { ...context, busy: true })).toEqual({ type: "none" });
  });

  it("never decides on a key with Cmd, Ctrl, Alt/Option or Hyper held", () => {
    for (const modifier of ["super", "ctrl", "meta", "option", "hyper"] as const) {
      for (const name of ["y", "s", "a", "n", "c", "1", "2"]) {
        expect(resolvePanelKey(key(name, { [modifier]: true }), context)?.type).not.toBe("decide");
      }
    }
    expect(resolvePanelKey(key("s", { super: true }), context)).toBeNull();
  });

  it("goes back to the composer on Esc or Tab, in any state", () => {
    for (const state of [
      context,
      { ...context, engagement: "typing" as const },
      { ...context, busy: true },
      { ...context, running: true },
    ]) {
      expect(resolvePanelKey(key("escape"), state)).toEqual({ type: "leave" });
      expect(resolvePanelKey(key("tab"), state)).toEqual({ type: "leave" });
      expect(resolvePanelKey(key("tab", { shift: true }), state)).toEqual({ type: "leave" });
    }
  });

  it("stops the run on Ctrl+C, and quits once nothing runs or a stop was sent", () => {
    const running = { ...context, running: true };
    expect(resolvePanelKey(key("c", { ctrl: true }), running)).toEqual({ type: "stop" });
    // Disengaged or not, and even when the request can't be answered.
    expect(
      resolvePanelKey(key("c", { ctrl: true }), { ...running, engagement: "typing", busy: true }),
    ).toEqual({ type: "stop" });
    const stopping = { ...running, stopRequested: true };
    expect(resolvePanelKey(key("c", { ctrl: true }), stopping)).toEqual({ type: "exit" });
    expect(resolvePanelKey(key("c", { ctrl: true }), context)).toEqual({ type: "exit" });
  });

  it("never approves on Enter", () => {
    expect(resolvePanelKey(key("return"), context)).toEqual({
      type: "hint",
      message: "Press 1–4 to choose",
    });
  });

  it("steps between requests and leaves other keys to the shell", () => {
    expect(resolvePanelKey(key("]"), context)).toEqual({ type: "step-request", delta: 1 });
    expect(resolvePanelKey(key("[", { sequence: "[" }), context)).toEqual({
      type: "step-request",
      delta: -1,
    });
    expect(resolvePanelKey(key("5"), context)).toBeNull();
    expect(resolvePanelKey(key("y", { ctrl: true }), context)).toBeNull();
  });

  // N2: an approval that can't be answered must not trap the keyboard.
  it("steps between requests while disengaged, busy, or unanswerable", () => {
    for (const state of [
      { ...context, engagement: "typing" as const },
      { ...context, engagement: "ready" as const },
      { ...context, busy: true },
      { ...context, busy: true, engagement: "typing" as const, choices: [] },
    ]) {
      expect(resolvePanelKey(key("]"), state)).toEqual({ type: "step-request", delta: 1 });
      expect(resolvePanelKey(key("["), state)).toEqual({ type: "step-request", delta: -1 });
    }
  });

  // N4: holding a key must not answer; each decision takes a fresh press.
  it("ignores a held key's repeats for engaging and deciding", () => {
    expect(
      resolvePanelKey(key("return", { repeated: true }), { ...context, engagement: "ready" }),
    ).toEqual({ type: "none" });
    for (const name of ["y", "1", "s", "2", "n", "c"]) {
      expect(resolvePanelKey(key(name, { repeated: true }), context)?.type).toBe("hint");
    }
    // Repeats still step between requests.
    expect(resolvePanelKey(key("]", { repeated: true }), context)?.type).toBe("step-request");
    // And a held Tab or Esc doesn't bounce focus.
    expect(resolvePanelKey(key("tab", { repeated: true }), context)).toEqual({ type: "none" });
  });

  // Round 3, N4: holding Ctrl+C must not stop the run and then quit.
  it("ignores a held Ctrl+C's repeats for stop and quit", () => {
    const ctrlC = (repeated: boolean) => key("c", { ctrl: true, repeated });
    const running = { ...context, running: true, stopRequested: false };
    expect(resolvePanelKey(ctrlC(false), running)).toEqual({ type: "stop" });
    expect(resolvePanelKey(ctrlC(true), running)).toEqual({ type: "none" });
    const stopping = { ...context, running: true, stopRequested: true };
    expect(resolvePanelKey(ctrlC(true), stopping)).toEqual({ type: "none" });
    expect(resolvePanelKey(ctrlC(false), stopping)).toEqual({ type: "exit" });
  });

  it("holding Enter engages once, then decides nothing", () => {
    let now = 0;
    const guard = createEngagementGuard(() => now);
    guard.show(request.requestId);
    now += PANEL_QUIET_MS;
    const at = (engagement: ReturnType<typeof guard.press>) => ({ ...context, engagement });
    const actions = [
      pressPanelKey(guard, request.requestId, key("return"), at),
      ...Array.from({ length: 20 }, () => {
        now += 30;
        return pressPanelKey(guard, request.requestId, key("return", { repeated: true }), at);
      }),
    ];
    expect(actions[0]).toEqual({ type: "engage" });
    expect(actions.some((action) => action?.type === "decide")).toBe(false);
  });
});

// N3: Stop ends the run an approval belongs to; approving it then would act for nothing.
describe("a stopped run's requests", () => {
  const stopFor = (stopSentRunId: string | null, stopRequested = false) => ({
    stopSentRunId,
    stopRequested,
  });

  it("knows the run was stopped from the run itself, or from the stop that was sent", () => {
    expect(requestRunStopped({ runId: null, runEnded: true }, stopFor(null))).toBe(true);
    expect(
      requestRunStopped({ runId: RunId.make("run-1"), runEnded: false }, stopFor("run-1")),
    ).toBe(true);
    expect(
      requestRunStopped({ runId: RunId.make("run-2"), runEnded: false }, stopFor("run-1")),
    ).toBe(false);
    // No known run: the active run's stop counts.
    expect(requestRunStopped({ runId: null, runEnded: false }, stopFor("x", true))).toBe(true);
    expect(requestRunStopped({ runId: null, runEnded: false }, stopFor("x", false))).toBe(false);
  });

  it("offers only Decline, so 1, y and s can't approve", () => {
    const [request] = queueOf(["a"]);
    if (request?.kind !== "approval") throw new Error("expected an approval");
    const choices = availableChoices(approvalChoices(request.approval), true);
    expect(choices.map((choice) => choice.decision)).toEqual(["decline"]);
    const context = {
      kind: "approval" as const,
      choices,
      busy: false,
      engagement: "engaged" as const,
      ...idle,
    };
    expect(resolvePanelKey(key("1"), context)).toEqual({ type: "decide", decision: "decline" });
    expect(resolvePanelKey(key("n"), context)).toEqual({ type: "decide", decision: "decline" });
    for (const name of ["y", "s", "a", "2", "3", "4"]) {
      expect(resolvePanelKey(key(name), context)?.type).not.toBe("decide");
    }
    expect(availableChoices(approvalChoices(request.approval), false)).toHaveLength(4);
  });
});

describe("resolvePanelKey: questions", () => {
  const press = (
    input: ReturnType<typeof questionInput>,
    form: QuestionForm,
    name: string,
    extra: Partial<PanelKey> = {},
  ): PanelAction | null =>
    resolvePanelKey(key(name, extra), {
      kind: "question",
      input,
      form,
      busy: false,
      engagement: "engaged",
      ...idle,
    });
  const formOf = (action: PanelAction | null): QuestionForm => {
    if (action?.type !== "form" && action?.type !== "hint")
      throw new Error(`no form: ${action?.type}`);
    if (action.form === undefined) throw new Error("hint without form");
    return action.form;
  };

  it("submits a single question with the option under the cursor on Enter", () => {
    const input = questionInput([question("q1", ["Red", "Blue"])]);
    const moved = formOf(press(input, initialForm(input), "down"));
    expect(press(input, moved, "return")).toEqual({ type: "submit", answers: { q1: "Blue" } });
  });

  it("picks by number, then walks a multi-question form and submits on the last", () => {
    const input = questionInput([question("q1", ["Red", "Blue"]), question("q2", ["Yes", "No"])]);
    let form = formOf(press(input, initialForm(input), "2"));
    form = formOf(press(input, form, "return"));
    expect(form.index).toBe(1);
    form = formOf(press(input, form, "1"));
    expect(press(input, form, "return")).toEqual({
      type: "submit",
      answers: { q1: "Blue", q2: "Yes" },
    });
    // ← goes back, and → returns only past an answered question.
    const back = formOf(press(input, form, "left"));
    expect(back.index).toBe(0);
    expect(formOf(press(input, back, "right")).index).toBe(1);
  });

  it("won't move on from an unanswered question", () => {
    const input = questionInput([question("q1", ["Red"]), question("q2", ["Yes"])]);
    expect(press(input, initialForm(input), "right")).toEqual({
      type: "hint",
      message: "Answer this question first",
    });
  });

  it("toggles multi-select picks with space and sends them together", () => {
    const input = questionInput([question("q1", ["A", "B", "C"], { multiSelect: true })]);
    let form = formOf(press(input, initialForm(input), "space"));
    form = formOf(press(input, form, "down"));
    form = formOf(press(input, form, "down"));
    form = formOf(press(input, form, "space"));
    expect(press(input, form, "return")).toEqual({ type: "submit", answers: { q1: ["A", "C"] } });
  });

  it("lets typed text replace multi-select picks, and a pick clear the text", () => {
    const input = questionInput([question("q1", ["A", "B"], { multiSelect: true })]);
    const q1 = input.questions[0]!;
    let form = formOf(press(input, initialForm(input), "1"));
    form = formOf(press(input, form, "down"));
    form = formOf(press(input, form, "down"));
    form = setTypedAnswer(form, q1, "Neither");
    expect(press(input, form, "return")).toEqual({ type: "submit", answers: { q1: "Neither" } });
    // Back on the options, a pick clears the text and reloads the text box.
    form = formOf(press(input, form, "up"));
    const picked = formOf(press(input, form, "2"));
    expect(picked.textRevision).toBe(form.textRevision + 1);
    expect(press(input, picked, "return")).toEqual({ type: "submit", answers: { q1: ["B"] } });
  });

  it("answers with typed text from the text row, below the options", () => {
    const input = questionInput([question("q1", ["Red"])]);
    let form = formOf(press(input, initialForm(input), "down"));
    expect(press(input, form, "x")).toBeNull();
    form = setTypedAnswer(form, input.questions[0]!, "Green");
    expect(press(input, form, "return", { shift: true })).toBeNull();
    expect(press(input, form, "return")).toEqual({ type: "submit", answers: { q1: "Green" } });
    expect(formOf(press(input, form, "up")).cursor).toBe(0);
  });

  it("starts on the text row for a question without options", () => {
    const input = questionInput([question("q1", [])]);
    const form = initialForm(input);
    expect(press(input, form, "return")).toEqual({
      type: "hint",
      message: "Pick an option or type an answer",
      form,
    });
  });

  it("dismisses on Ctrl+X only when the provider allows it and nothing runs", () => {
    const input = questionInput([question("q1", ["A"])]);
    const ctrlX = { ctrl: true };
    expect(press(input, initialForm(input), "x", ctrlX)).toEqual({
      type: "hint",
      message: "This question needs an answer",
    });
    const dismissible = questionInput([question("q1", ["A"])], { responseMode: "message" });
    expect(press(dismissible, initialForm(dismissible), "x", ctrlX)).toEqual({ type: "dismiss" });
    // Esc goes back to the composer; it never dismisses.
    expect(press(dismissible, initialForm(dismissible), "escape")).toEqual({ type: "leave" });
    const context = {
      kind: "question" as const,
      form: initialForm(input),
      busy: false,
      engagement: "engaged" as const,
      running: true,
      stopRequested: false,
    };
    // While a run is going, dismissing waits for a stop.
    expect(resolvePanelKey(key("x", ctrlX), { ...context, input: dismissible })?.type).toBe("hint");
    expect(resolvePanelKey(key("c", { ctrl: true }), { ...context, input })).toEqual({
      type: "stop",
    });
  });

  it("ignores a held Enter's repeats, so a default answer isn't submitted", () => {
    const input = questionInput([question("q1", ["Red", "Blue"]), question("q2", ["A", "B"])]);
    const form = initialForm(input);
    expect(press(input, form, "return", { repeated: true })?.type).toBe("hint");
    expect(press(input, form, "space", { repeated: true })?.type).toBe("hint");
    expect(press(input, form, "1", { repeated: true })?.type).toBe("hint");
    // Moving the cursor may repeat.
    expect(press(input, form, "down", { repeated: true })?.type).toBe("form");
    // A fresh press still advances.
    expect(press(input, form, "return")?.type).toBe("form");
  });

  it("types [ and ] into the text box instead of stepping requests", () => {
    const input = questionInput([question("q1", [])]);
    expect(press(input, initialForm(input), "]", { sequence: "]" })).toBeNull();
  });

  it("does nothing but step requests while its answer is out", () => {
    const input = questionInput([question("q1", ["A"])]);
    const context = {
      kind: "question" as const,
      input,
      form: initialForm(input),
      engagement: "engaged" as const,
      ...idle,
    };
    expect(resolvePanelKey(key("1"), { ...context, busy: true })).toEqual({ type: "none" });
    expect(resolvePanelKey(key("]"), { ...context, busy: true })).toEqual({
      type: "step-request",
      delta: 1,
    });
    expect(resolvePanelKey(key("1"), { ...context, busy: false, engagement: "ready" })).toEqual({
      type: "hint",
      message: ENGAGE_HINT,
    });
  });
});
