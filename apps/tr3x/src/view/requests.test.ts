import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalChoices, initialDraft, resolveAnswer, togglePicked } from "./requests.ts";

const question = (overrides: Partial<ThreadUserInputQuestion> = {}): ThreadUserInputQuestion => ({
  id: "q",
  header: "Branch",
  question: "Which branch?",
  options: [
    { label: "main", description: "The default branch" },
    { label: "dev", description: "Work in progress", value: "develop" },
  ],
  multiSelect: false,
  ...overrides,
});

describe("question answers", () => {
  it("answers with typed text, else the picks, else the highlighted option", () => {
    const single = question();
    expect(resolveAnswer(single, { ...initialDraft(single), cursor: 1 })).toBe("develop");
    expect(resolveAnswer(single, { ...initialDraft(single), text: " release " })).toBe("release");
    expect(
      resolveAnswer(question({ allowCustomAnswer: false }), { cursor: 0, picked: [], text: "x" }),
    ).toBe("main");

    const multi = question({ multiSelect: true });
    const picked = togglePicked(togglePicked(initialDraft(multi), "main"), "develop");
    expect(resolveAnswer(multi, picked)).toEqual(["main", "develop"]);
    expect(resolveAnswer(multi, togglePicked(picked, "main"))).toEqual(["develop"]);
    expect(
      resolveAnswer(question({ options: [] }), initialDraft(question({ options: [] }))),
    ).toBeNull();
  });

  it("seeds a suggested answer as typed text", () => {
    expect(initialDraft(question({ initialAnswer: "main" })).text).toBe("main");
  });
});

describe("approvalChoices", () => {
  it("keys the provider's own options, or offers accept, for session, and decline", () => {
    const base = {
      requestId: RuntimeRequestId.make("r"),
      requestKind: "command" as const,
      createdAt: "2026-10-27T00:00:00.000Z",
      responseCapability: "live" as const,
    };
    expect(approvalChoices(base).map((choice) => choice.key)).toEqual(["a", "s", "d"]);
    expect(
      approvalChoices({
        ...base,
        options: [
          { decision: "cancel", label: "Cancel" },
          { decision: "accept", label: "Approve" },
        ],
      }),
    ).toEqual([
      { key: "c", decision: "cancel", label: "Cancel" },
      { key: "a", decision: "accept", label: "Approve" },
    ]);
  });
});
