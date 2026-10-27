import { describe, expect, it } from "vite-plus/test";

import {
  DIFF_FILE_LINE_BUDGET,
  hunkLineOffsets,
  layoutDiffFile,
  lineLimitShowingHunk,
  parseUnifiedDiff,
  showTrailingWhitespace,
  type DiffFile,
} from "./diffPatch.ts";

const TWO_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export {};",
  "@@ -10,2 +11,2 @@",
  "--- a removed line that looks like a header",
  "+++ an added line that looks like a header",
  " end();",
  "diff --git a/docs/new file.md b/docs/new file.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new file.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("splits files and hunks and counts lines by the hunk headers", () => {
    const parsed = parseUnifiedDiff(TWO_FILES);
    expect(parsed.truncated).toBe(false);
    expect(parsed.files.map((file) => [file.path, file.status])).toEqual([
      ["src/app.ts", "modified"],
      ["docs/new file.md", "added"],
    ]);
    const [app, doc] = parsed.files;
    expect(app?.hunks.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.context])).toEqual([
      [1, 1, "export function main() {"],
      [10, 11, ""],
    ]);
    // Header-looking content inside a hunk stays content.
    expect(app?.hunks[1]?.lines).toEqual([
      "--- a removed line that looks like a header",
      "+++ an added line that looks like a header",
      " end();",
    ]);
    expect([app?.additions, app?.deletions]).toEqual([3, 2]);
    expect(doc?.hunks[0]?.lines).toEqual(["+# Title", "+"]);
    expect([parsed.additions, parsed.deletions]).toEqual([5, 2]);
  });

  it("reads renames, deletions, binaries and quoted paths", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
        'diff --git "a/caf\\303\\251 \\"x\\".ts" "b/caf\\303\\251 \\"x\\".ts"',
        '--- "a/caf\\303\\251 \\"x\\".ts"',
        '+++ "b/caf\\303\\251 \\"x\\".ts"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    expect(
      parsed.files.map((file) => [file.path, file.previousPath, file.status, file.lineCount]),
    ).toEqual([
      ["new.ts", "old.ts", "renamed", 0],
      ["gone.ts", null, "deleted", 1],
      ["logo.png", null, "binary", 0],
      ['café "x".ts', null, "modified", 2],
    ]);
  });

  it("flags the server's truncation marker and keeps what came before it", () => {
    const parsed = parseUnifiedDiff(`${TWO_FILES}\n\n[truncated]`);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files).toHaveLength(2);
    expect(parseUnifiedDiff("")).toMatchObject({ files: [], truncated: false });
  });

  it("keeps trailing whitespace on the last line; only the patch's final newline goes", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-before\n+after   \t\n";
    expect(parseUnifiedDiff(patch).files[0]?.hunks[0]?.lines).toEqual(["-before", "+after   \t"]);
    expect(parseUnifiedDiff(`${patch}\n\n[truncated]`).files[0]?.hunks[0]?.lines.at(-1)).toBe(
      "+after   \t",
    );
  });

  it("keeps which side has no final newline, without counting the marker as a line", () => {
    const hunks = (lines: ReadonlyArray<string>) =>
      parseUnifiedDiff(["--- a/x", "+++ b/x", "@@ -1 +1 @@", ...lines].join("\n")).files[0]?.hunks;
    // A newline-only change: the text is the same, the end of the file is not.
    const added = hunks(["-last", "\\ No newline at end of file", "+last"]);
    expect(added?.[0]).toMatchObject({
      lines: ["-last", "+last"],
      additions: 1,
      deletions: 1,
      missingFinalNewline: "old",
    });
    expect(
      hunks(["-last", "+last", "\\ No newline at end of file"])?.[0]?.missingFinalNewline,
    ).toBe("new");
    expect(
      hunks(["-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"])?.[0]
        ?.missingFinalNewline,
    ).toBe("both");
    expect(hunks([" same", "\\ No newline at end of file"])?.[0]?.missingFinalNewline).toBe("both");
    expect(parseUnifiedDiff(TWO_FILES).files[1]?.hunks[0]?.missingFinalNewline).toBe("new");
    expect(parseUnifiedDiff(TWO_FILES).files[0]?.hunks[0]?.missingFinalNewline).toBeNull();
  });
});

function bigFile(hunkSizes: ReadonlyArray<number>): DiffFile {
  let body = "--- a/big.ts\n+++ b/big.ts\n";
  let start = 1;
  for (const size of hunkSizes) {
    body += `@@ -${start},0 +${start},${size} @@\n`;
    for (let index = 0; index < size; index += 1) body += `+line ${start + index}\n`;
    start += size + 10;
  }
  const file = parseUnifiedDiff(body).files[0];
  if (file === undefined) throw new Error("no file");
  return file;
}

describe("showTrailingWhitespace", () => {
  it("marks trailing spaces and tabs of changed lines only", () => {
    expect(showTrailingWhitespace("+after  \t")).toBe("+after··→");
    expect(showTrailingWhitespace("-a b ")).toBe("-a b·");
    expect(showTrailingWhitespace(" context  ")).toBe(" context  ");
    expect(showTrailingWhitespace("+")).toBe("+");
  });
});

describe("layoutDiffFile", () => {
  it("draws every hunk of a small file, each as a patch OpenTUI can parse", () => {
    const app = parseUnifiedDiff(TWO_FILES).files[0];
    if (app === undefined) throw new Error("no file");
    const layout = layoutDiffFile(app, DIFF_FILE_LINE_BUDGET);
    expect(layout.hiddenLines).toBe(0);
    expect(layout.chunks.map((chunk) => chunk.header)).toEqual([
      "@@ -1,3 +1,4 @@ export function main() {",
      "@@ -10,2 +11,2 @@",
    ]);
    expect(layout.chunks[0]?.patch).toBe(
      [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,4 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " export {};",
      ].join("\n"),
    );
  });

  it("notes a missing final newline under its hunk, unless the hunk is cut short", () => {
    const doc = parseUnifiedDiff(TWO_FILES).files[1];
    if (doc === undefined) throw new Error("no file");
    expect(layoutDiffFile(doc, DIFF_FILE_LINE_BUDGET).chunks[0]?.eofNote).toBe(
      "↵ No newline at end of file in the new version",
    );
    expect(layoutDiffFile(doc, 1).chunks[0]?.eofNote).toBeNull();
    const app = parseUnifiedDiff(TWO_FILES).files[0];
    expect(app && layoutDiffFile(app, DIFF_FILE_LINE_BUDGET).chunks[0]?.eofNote).toBeNull();
  });

  it("caps a huge file, cutting the hunk that crosses the limit with matching counts", () => {
    const file = bigFile([300, 300, 300]);
    const layout = layoutDiffFile(file, 400);
    expect(layout.chunks.map((chunk) => chunk.header)).toEqual([
      "@@ -1,0 +1,300 @@",
      "@@ -311,0 +311,300 @@",
    ]);
    expect(layout.chunks[1]?.patch.split("\n").slice(2, 3)).toEqual(["@@ -311,0 +311,100 @@"]);
    expect(layout.chunks[1]?.patch.split("\n")).toHaveLength(3 + 100);
    expect(layout.hiddenLines).toBe(500);
    // Showing more keeps each hunk's key, so a drawn hunk updates in place.
    const more = layoutDiffFile(file, 800);
    expect(more.chunks.map((chunk) => chunk.key)).toEqual([
      ...layout.chunks.map((chunk) => chunk.key),
      `${file.key}:2`,
    ]);
    expect(more.hiddenLines).toBe(100);
  });

  it("raises the limit just enough to reach a hunk past it", () => {
    const file = bigFile([300, 300, 300]);
    expect(hunkLineOffsets(file)).toEqual([0, 300, 600]);
    expect(lineLimitShowingHunk(file, 1, 400)).toBe(400);
    expect(lineLimitShowingHunk(file, 2, 400)).toBe(800);
    expect(lineLimitShowingHunk(file, 2, 1200)).toBe(1200);
  });
});
