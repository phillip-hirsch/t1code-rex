import { describe, expect, it } from "vite-plus/test";

import { formatReasoningEffortLabel, truncateToolbarLabel } from "./composerControlLabels.ts";

describe("formatReasoningEffortLabel", () => {
  it("formats no reasoning explicitly", () => {
    expect(formatReasoningEffortLabel("none")).toBe("No reasoning");
  });

  it("formats codex extra high explicitly", () => {
    expect(formatReasoningEffortLabel("xhigh")).toBe("Extra High");
  });
});

describe("truncateToolbarLabel", () => {
  it("leaves labels that fit untouched", () => {
    expect(truncateToolbarLabel("No reasoning", 14)).toBe("No reasoning");
  });

  it("truncates long labels with an ellipsis", () => {
    expect(truncateToolbarLabel("Extra High · Fast", 14)).toBe("Extra High ·…");
  });
});
