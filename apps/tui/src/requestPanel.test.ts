import type { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PANEL_ARM_DELAY_MS,
  createArmGuard,
  initialForm,
  pickActiveRequest,
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

describe("createArmGuard", () => {
  it("arms a request only after it has been in view for the delay", () => {
    let now = 1_000;
    const guard = createArmGuard(() => now);
    const id = "a" as RuntimeRequestId;
    expect(guard.armed(id)).toBe(false);
    guard.show(id);
    now += PANEL_ARM_DELAY_MS - 1;
    expect(guard.armed(id)).toBe(false);
    now += 1;
    expect(guard.armed(id)).toBe(true);
    // Showing it again doesn't restart the delay; another request does.
    guard.show(id);
    expect(guard.armed(id)).toBe(true);
    guard.show("b" as RuntimeRequestId);
    expect(guard.armed("b" as RuntimeRequestId)).toBe(false);
  });
});

describe("resolvePanelKey: approvals", () => {
  const [request] = queueOf(["a"]);
  if (request?.kind !== "approval") throw new Error("expected an approval");
  const choices = approvalChoices(request.approval);
  const context = { kind: "approval" as const, choices, busy: false, armed: true };

  it("picks a decision by number or by letter", () => {
    expect(resolvePanelKey(key("1"), context)).toEqual({ type: "decide", decision: "accept" });
    expect(resolvePanelKey(key("2"), context)).toEqual({
      type: "decide",
      decision: "acceptForSession",
    });
    expect(resolvePanelKey(key("n"), context)).toEqual({ type: "decide", decision: "decline" });
    expect(resolvePanelKey(key("c"), context)).toEqual({ type: "decide", decision: "cancel" });
  });

  it("ignores decisions before the panel arms and while an answer is out", () => {
    expect(resolvePanelKey(key("y"), { ...context, armed: false })).toEqual({ type: "none" });
    expect(resolvePanelKey(key("y"), { ...context, busy: true })).toEqual({ type: "none" });
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
    expect(resolvePanelKey(key("tab"), context)).toBeNull();
    expect(resolvePanelKey(key("y", { ctrl: true }), context)).toBeNull();
  });
});

describe("resolvePanelKey: questions", () => {
  const press = (
    input: ReturnType<typeof questionInput>,
    form: QuestionForm,
    name: string,
    extra: Partial<PanelKey> = {},
  ): PanelAction | null =>
    resolvePanelKey(key(name, extra), { kind: "question", input, form, busy: false, armed: true });
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

  it("dismisses on Esc only when the provider allows it", () => {
    const input = questionInput([question("q1", ["A"])]);
    expect(press(input, initialForm(input), "escape")).toEqual({
      type: "hint",
      message: "This question needs an answer; stop the run to skip it",
    });
    const dismissible = questionInput([question("q1", ["A"])], { responseMode: "message" });
    expect(press(dismissible, initialForm(dismissible), "escape")).toEqual({ type: "dismiss" });
  });

  it("does nothing but step requests while its answer is out", () => {
    const input = questionInput([question("q1", ["A"])]);
    const context = { kind: "question" as const, input, form: initialForm(input), armed: true };
    expect(resolvePanelKey(key("1"), { ...context, busy: true })).toBeNull();
    expect(resolvePanelKey(key("]"), { ...context, busy: true })).toEqual({
      type: "step-request",
      delta: 1,
    });
    expect(resolvePanelKey(key("1"), { ...context, busy: false, armed: false })).toEqual({
      type: "none",
    });
  });
});
