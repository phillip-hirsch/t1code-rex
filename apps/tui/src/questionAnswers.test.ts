import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_QUESTION_DRAFT,
  buildAnswers,
  firstUnanswered,
  initialDraft,
  resolveAnswer,
  toggleOption,
} from "./questionAnswers.ts";

function q(id: string, fields: Partial<ThreadUserInputQuestion> = {}): ThreadUserInputQuestion {
  return {
    id,
    header: id,
    question: `${id}?`,
    options: [
      { label: "Postgres", description: "Relational", value: "pg" },
      { label: "SQLite", description: "Embedded" },
    ],
    multiSelect: false,
    ...fields,
  };
}

describe("question answers", () => {
  it("answers a single choice with the option's value, or its label without one", () => {
    const question = q("db");
    expect(resolveAnswer(question, toggleOption(question, EMPTY_QUESTION_DRAFT, "pg"))).toBe("pg");
    expect(resolveAnswer(question, toggleOption(question, EMPTY_QUESTION_DRAFT, "SQLite"))).toBe(
      "SQLite",
    );
    expect(resolveAnswer(question, EMPTY_QUESTION_DRAFT)).toBeNull();
  });

  it("lets typed text win over a single choice", () => {
    const question = q("db");
    expect(resolveAnswer(question, { selected: ["pg"], custom: "  MySQL " })).toBe("MySQL");
  });

  it("ignores typed text when the question takes only its options", () => {
    const question = q("db", { allowCustomAnswer: false });
    expect(resolveAnswer(question, { selected: [], custom: "MySQL" })).toBeNull();
  });

  it("toggles multi-select choices and sends them as a list", () => {
    const question = q("dbs", { multiSelect: true });
    const both = toggleOption(
      question,
      toggleOption(question, EMPTY_QUESTION_DRAFT, "pg"),
      "SQLite",
    );
    expect(resolveAnswer(question, both)).toEqual(["pg", "SQLite"]);
    expect(resolveAnswer(question, toggleOption(question, both, "pg"))).toEqual(["SQLite"]);
  });

  it("drops picks the question no longer offers", () => {
    expect(resolveAnswer(q("db"), { selected: ["gone"], custom: "" })).toBeNull();
  });

  it("seeds a suggested answer as typed text", () => {
    expect(initialDraft(q("name", { initialAnswer: "tr3x" }))).toEqual({
      selected: [],
      custom: "tr3x",
    });
    expect(initialDraft(q("name", { initialAnswer: "tr3x", allowCustomAnswer: false }))).toEqual(
      EMPTY_QUESTION_DRAFT,
    );
  });

  it("builds the form's answers only once every question has one", () => {
    const questions = [q("a"), q("b", { initialAnswer: "suggested" })];
    expect(buildAnswers(questions, new Map())).toBeNull();
    expect(firstUnanswered(questions, new Map())).toBe(0);
    const drafts = new Map([["a", { selected: ["pg"], custom: "" }]]);
    expect(buildAnswers(questions, drafts)).toEqual({ a: "pg", b: "suggested" });
    expect(firstUnanswered(questions, drafts)).toBe(1);
  });
});
