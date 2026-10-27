import { describe, expect, it } from "vite-plus/test";

import { formatRelativeTime } from "./relativeTime.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it("formats ages compactly", () => {
    expect(formatRelativeTime("2026-06-20T11:59:30.000Z", NOW)).toBe("now");
    expect(formatRelativeTime("2026-06-20T11:55:00.000Z", NOW)).toBe("5m");
    expect(formatRelativeTime("2026-06-20T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatRelativeTime("2026-06-18T12:00:00.000Z", NOW)).toBe("2d");
  });

  it("treats future and missing times safely", () => {
    expect(formatRelativeTime("2026-06-20T13:00:00.000Z", NOW)).toBe("now");
    expect(formatRelativeTime(null, NOW)).toBe("");
    expect(formatRelativeTime("not a date", NOW)).toBe("");
  });
});
