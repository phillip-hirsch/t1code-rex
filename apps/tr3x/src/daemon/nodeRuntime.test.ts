import { describe, expect, it } from "vite-plus/test";

import { satisfiesVersionRange, serverNodeRange } from "./nodeRuntime.ts";

describe("satisfiesVersionRange", () => {
  it("reads the server's engines as npm does", () => {
    const range = "^22.16 || ^23.11 || >=24.10";
    expect(satisfiesVersionRange("v22.16.0", range)).toBe(true);
    expect(satisfiesVersionRange("v22.15.9", range)).toBe(false);
    expect(satisfiesVersionRange("v23.10.0", range)).toBe(false);
    expect(satisfiesVersionRange("v24.9.1", range)).toBe(false);
    expect(satisfiesVersionRange("v24.10.0", range)).toBe(true);
    expect(satisfiesVersionRange("v26.12.1", range)).toBe(true);
    expect(satisfiesVersionRange("not a version", range)).toBe(false);
  });

  it("finds the range in the server's package.json", () => {
    expect(serverNodeRange()).toMatch(/\d/u);
  });
});
