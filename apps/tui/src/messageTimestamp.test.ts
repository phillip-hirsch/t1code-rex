import { describe, expect, it } from "vite-plus/test";

import { formatMessageTimestamp } from "./messageTimestamp.ts";

const AFTERNOON = Date.parse("2026-06-20T15:07:00.000Z");

describe("formatMessageTimestamp", () => {
  it("honors the 12- and 24-hour settings", () => {
    expect(formatMessageTimestamp(AFTERNOON, "24-hour", "UTC")).toBe("15:07");
    expect(formatMessageTimestamp(AFTERNOON, "12-hour", "UTC")).toMatch(/^3:07\s?PM$/);
  });

  it("is empty without a time", () => {
    expect(formatMessageTimestamp(null, "locale")).toBe("");
    expect(formatMessageTimestamp(Number.NaN, "locale")).toBe("");
  });
});
