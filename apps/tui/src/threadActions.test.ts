import { describe, expect, it } from "vite-plus/test";

import { describeBulkOutcome, runForThreads } from "./threadActions.ts";

describe("bulk thread actions", () => {
  it("runs one thread at a time, in order, and keeps going past a failure", async () => {
    const calls: string[] = [];
    const outcome = await runForThreads(["a", "b", "c"], async (threadId) => {
      calls.push(threadId);
      return threadId === "b" ? { ok: false, error: new Error("busy") } : { ok: true };
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(outcome.done).toEqual(["a", "c"]);
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
    expect(describeBulkOutcome("Archived", outcome, describe)).toBe(
      "Archived 2 of 3 threads: busy",
    );
    expect(describeBulkOutcome("Archived", { done: ["a"], failed: [] }, describe)).toBe(
      "Archived thread",
    );
    expect(describeBulkOutcome("Deleted", { done: ["a", "b"], failed: [] }, describe)).toBe(
      "Deleted 2 threads",
    );
  });
});
