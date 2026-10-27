import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { at, presentedThread } from "./shellTestFixtures.ts";
import {
  effectiveVisitedAtMs,
  resolveProjectStatus,
  resolveThreadStatus,
} from "./sidebarStatus.ts";

const RUN = RunId.make("run-1");
const COMPLETED_AT = "2026-06-20T01:00:00.000Z";

function finished(status: "completed" | "failed" = "completed") {
  return presentedThread("t", "p", {
    latestRunId: RUN,
    status,
    latestRunStartedAt: at("2026-06-20T00:30:00.000Z"),
    latestRunCompletedAt: at(COMPLETED_AT),
  });
}

describe("resolveThreadStatus", () => {
  it("shows nothing for a thread that never ran", () => {
    expect(resolveThreadStatus(presentedThread("t", "p"))).toBeNull();
  });

  it("shows a running thread as working with a pulse", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      activeRunId: RUN,
      status: "running",
      activityRunStatus: "running",
    });
    expect(resolveThreadStatus(thread)).toEqual({ label: "Working", pulse: true });
  });

  it("shows a starting run as connecting", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      activeRunId: RUN,
      status: "starting",
      activityRunStatus: "starting",
    });
    expect(resolveThreadStatus(thread)?.label).toBe("Connecting");
  });

  it("puts a pending approval ahead of the running state", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      activeRunId: RUN,
      status: "running",
      activityRunStatus: "running",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("req-1"),
        kind: "command",
        createdAt: at(COMPLETED_AT),
      },
    });
    expect(resolveThreadStatus(thread)?.label).toBe("Pending Approval");
  });

  it("shows a pending question as awaiting input", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      activeRunId: RUN,
      status: "waiting",
      activityRunStatus: "waiting",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("req-1"),
        kind: "user_input",
        createdAt: at(COMPLETED_AT),
      },
    });
    expect(resolveThreadStatus(thread)?.label).toBe("Awaiting Input");
  });

  it("shows an unvisited finished run as completed", () => {
    expect(resolveThreadStatus(finished())?.label).toBe("Completed");
  });

  it("clears completed once the thread is visited after the run", () => {
    expect(
      resolveThreadStatus(finished(), { localVisitedAt: "2026-06-20T01:00:01.000Z" }),
    ).toBeNull();
  });

  it("counts a server visit as seen", () => {
    expect(
      resolveThreadStatus(finished(), { serverVisitedAt: "2026-06-20T02:00:00.000Z" }),
    ).toBeNull();
  });

  it("shows completed again after mark unread", () => {
    expect(
      resolveThreadStatus(finished(), {
        localVisitedAt: "2026-06-20T02:00:00.000Z",
        forceUnread: true,
      })?.label,
    ).toBe("Completed");
  });

  it("shows an unseen failure as failed", () => {
    expect(resolveThreadStatus(finished("failed"))?.label).toBe("Failed");
    expect(
      resolveThreadStatus(finished("failed"), { localVisitedAt: "2026-06-20T03:00:00.000Z" }),
    ).toBeNull();
  });

  it("shows plan ready for a settled plan-mode run with an actionable plan", () => {
    const thread = presentedThread("t", "p", {
      latestRunId: RUN,
      status: "completed",
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRunCompletedAt: at(COMPLETED_AT),
    });
    expect(resolveThreadStatus(thread, { localVisitedAt: "2026-06-21T00:00:00.000Z" })?.label).toBe(
      "Plan Ready",
    );
  });
});

describe("resolveProjectStatus", () => {
  it("picks the most urgent status", () => {
    const working = resolveThreadStatus(
      presentedThread("a", "p", {
        latestRunId: RUN,
        activeRunId: RUN,
        status: "running",
        activityRunStatus: "running",
      }),
    );
    const completed = resolveThreadStatus(finished());
    expect(resolveProjectStatus([null, completed, working])?.label).toBe("Working");
    expect(resolveProjectStatus([null, null])).toBeNull();
  });
});

describe("effectiveVisitedAtMs", () => {
  it("takes the later visit and ignores both when forced unread", () => {
    expect(
      effectiveVisitedAtMs({
        localVisitedAt: "2026-06-20T00:00:00.000Z",
        serverVisitedAt: "2026-06-20T00:00:05.000Z",
      }),
    ).toBe(Date.parse("2026-06-20T00:00:05.000Z"));
    expect(
      effectiveVisitedAtMs({ localVisitedAt: "2026-06-20T00:00:00.000Z", forceUnread: true }),
    ).toBeNull();
  });
});
