import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createStopNotice, resolveFooterStatus, STOPPING } from "./footerStatus.ts";
import { presentedThread } from "./shellTestFixtures.ts";

const STOPPED_RUN = RunId.make("run-1");
const NEXT_RUN = RunId.make("run-2");

const running = (runId: RunId) =>
  presentedThread("t", "p", { latestRunId: runId, activeRunId: runId, status: "running" });
const ended = (runId: RunId, status: "interrupted" | "completed") =>
  presentedThread("t", "p", { latestRunId: runId, status });

describe("resolveFooterStatus", () => {
  it("says Stopping while the run winds down, then Stopped", () => {
    const notice = createStopNotice(running(STOPPED_RUN), STOPPING);
    expect(resolveFooterStatus(notice, running(STOPPED_RUN))).toBe("Stopping");
    expect(resolveFooterStatus(notice, ended(STOPPED_RUN, "interrupted"))).toBe("Stopped");
  });

  it("clears once a later run starts, and stays clear after it finishes", () => {
    const notice = createStopNotice(running(STOPPED_RUN), STOPPING);
    expect(resolveFooterStatus(notice, running(NEXT_RUN))).toBeNull();
    expect(resolveFooterStatus(notice, ended(NEXT_RUN, "completed"))).toBeNull();
  });

  it("shows only on the thread that was stopped", () => {
    const notice = createStopNotice(running(STOPPED_RUN), STOPPING);
    const other = presentedThread("other", "p", { latestRunId: STOPPED_RUN, status: "completed" });
    expect(resolveFooterStatus(notice, other)).toBeNull();
    expect(resolveFooterStatus(notice, null)).toBeNull();
  });

  it("keeps the held-messages note after the run ends", () => {
    const text = "Stopping; 1 unsent message held. Enter or /resume sends, /discard edits";
    const notice = createStopNotice(running(STOPPED_RUN), text);
    expect(resolveFooterStatus(notice, ended(STOPPED_RUN, "interrupted"))).toBe(text);
  });

  it("passes plain messages through", () => {
    expect(resolveFooterStatus("Copied path", running(NEXT_RUN))).toBe("Copied path");
    expect(resolveFooterStatus(null, running(NEXT_RUN))).toBeNull();
  });
});
