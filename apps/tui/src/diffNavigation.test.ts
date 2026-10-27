import { describe, expect, it } from "vite-plus/test";

import { reconcileFileIndex, resolveDiffKey, stepFile, stepHunk } from "./diffNavigation.ts";
import { parseUnifiedDiff } from "./diffPatch.ts";

const files = parseUnifiedDiff(
  [
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "@@ -9 +9 @@",
    "-c",
    "+d",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "--- a/three.ts",
    "+++ b/three.ts",
    "@@ -1 +1 @@",
    "-e",
    "+f",
  ].join("\n"),
).files;

describe("resolveDiffKey", () => {
  it("maps the panel's keys and leaves scrolling to the transcript's keys", () => {
    const resolve = (name: string, extra: Record<string, unknown> = {}) =>
      resolveDiffKey({ name, ...extra }, 20);
    expect(resolve("]", { sequence: "]" })).toEqual({ type: "file", delta: 1 });
    expect(resolve("n")).toEqual({ type: "hunk", delta: 1 });
    expect(resolve("n", { shift: true, sequence: "N" })).toEqual({ type: "hunk", delta: -1 });
    expect(resolve(",", { sequence: "," })).toEqual({ type: "turn", delta: -1 });
    expect(resolve("v")).toEqual({ type: "toggle-view" });
    expect(resolve("escape")).toEqual({ type: "close" });
    expect(resolve("j")).toEqual({ type: "scroll", action: { kind: "by", rows: 1 } });
    expect(resolve("d", { ctrl: true })).toEqual({
      type: "scroll",
      action: { kind: "by", rows: 10 },
    });
    expect(resolve("x")).toBeNull();
    expect(resolve("v", { meta: true })).toBeNull();
  });
});

describe("file and hunk steps", () => {
  it("stops at the ends of the file list", () => {
    expect(stepFile(files, 0, -1)).toBe(0);
    expect(stepFile(files, 2, 1)).toBe(2);
    expect(stepFile([], 0, 1)).toBe(0);
  });

  it("walks hunks across files, skipping files without any", () => {
    expect(stepHunk(files, { fileIndex: 0, hunkIndex: 0 }, 1)).toEqual({
      fileIndex: 0,
      hunkIndex: 1,
    });
    expect(stepHunk(files, { fileIndex: 0, hunkIndex: 1 }, 1)).toEqual({
      fileIndex: 2,
      hunkIndex: 0,
    });
    expect(stepHunk(files, { fileIndex: 2, hunkIndex: 0 }, -1)).toEqual({
      fileIndex: 0,
      hunkIndex: 1,
    });
    expect(stepHunk(files, { fileIndex: 2, hunkIndex: 0 }, 1)).toBeNull();
  });

  it("keeps the selected file by path when the diff changes", () => {
    expect(reconcileFileIndex(files, "three.ts", 0)).toBe(2);
    expect(reconcileFileIndex(files, "gone.ts", 7)).toBe(2);
    expect(reconcileFileIndex([], "three.ts", 3)).toBe(0);
  });
});
