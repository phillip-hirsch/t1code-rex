import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { at, presentedThread } from "./shellTestFixtures.ts";
import { formatElapsed, resolveRunStatusLine } from "./threadRunStatus.ts";

const RUN = RunId.make("run-1");

describe("resolveRunStatusLine", () => {
  it("shows Working with the run's start time while it runs", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      activeRunId: RUN,
      status: "running",
      latestRunStartedAt: at("2026-06-20T00:30:00.000Z"),
    });
    expect(resolveRunStatusLine(thread)).toMatchObject({
      tone: "working",
      label: "Working",
      startedAtMs: Date.parse("2026-06-20T00:30:00.000Z"),
    });
  });

  it("shows how an unfinished run ended, with the error for a failure", () => {
    const failed = presentedThread("t", "p", {
      latestRunId: RUN,
      status: "failed",
      lastError: "model not found",
      latestRunCompletedAt: at("2026-06-20T01:00:00.000Z"),
    });
    expect(resolveRunStatusLine(failed)).toMatchObject({
      tone: "error",
      label: "Run failed",
      detail: "model not found",
    });
    const interrupted = presentedThread("t", "p", { latestRunId: RUN, status: "interrupted" });
    expect(resolveRunStatusLine(interrupted)).toMatchObject({
      tone: "warning",
      label: "Run interrupted",
    });
  });

  it("shows nothing for a completed run or an unknown thread", () => {
    expect(
      resolveRunStatusLine(presentedThread("t", "p", { latestRunId: RUN, status: "completed" })),
    ).toBeNull();
    expect(resolveRunStatusLine(null)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
    expect(formatElapsed(-5)).toBe("0s");
  });
});
