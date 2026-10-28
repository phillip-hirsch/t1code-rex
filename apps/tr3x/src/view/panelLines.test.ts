import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { displayWidth } from "./layout.ts";
import { approvalPlan } from "./panelLines.ts";

const approval = (detail: string): ThreadPendingApproval => ({
  requestId: RuntimeRequestId.make("approval"),
  requestKind: "command",
  createdAt: "2026-10-28T00:00:00Z",
  responseCapability: "live",
  detail,
});

describe("approvalPlan", () => {
  it("keeps the target as the last line when the detail ends in blank lines", () => {
    const plan = approvalPlan(
      approval(`${"rm -rf build\n".repeat(10)}TARGET=/production.db\n\n`),
      true,
      80,
    );
    expect(plan.lines(4).map((line) => line.text)).toEqual([
      "TARGET=/production.db",
      "[a] accept   [s] accept for session   [d] decline",
    ]);
  });

  it("cuts every line, cues included, to the panel's width", () => {
    const detail = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const lines = approvalPlan(approval(detail), true, 20).lines(8);
    expect(lines.some((line) => line.text.startsWith("… 58 lines"))).toBe(true);
    for (const line of lines) expect(displayWidth(line.text)).toBeLessThanOrEqual(16);
  });
});
