/**
 * Unified diffs from the checkpoint diff RPCs, split into files and hunks for the diff panel.
 * Hunk bodies are read by their header's line counts, so content lines that look like
 * headers ("--- x" removed, "+++ y" added) stay content.
 */

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  /** The text after the closing "@@", usually the enclosing function. */
  readonly context: string;
  /** Body lines, each starting with " ", "+" or "-". */
  readonly lines: ReadonlyArray<string>;
  readonly additions: number;
  readonly deletions: number;
  /** Which side's file ends in this hunk without a final newline ("\ No newline at end of file"). */
  readonly missingFinalNewline: MissingFinalNewline | null;
}

export type MissingFinalNewline = "old" | "new" | "both";

export interface DiffFile {
  /** Unique within one diff, stable while the diff is unchanged. */
  readonly key: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: DiffFileStatus;
  readonly hunks: ReadonlyArray<DiffHunk>;
  readonly additions: number;
  readonly deletions: number;
  readonly lineCount: number;
}

export interface ParsedDiff {
  readonly files: ReadonlyArray<DiffFile>;
  readonly additions: number;
  readonly deletions: number;
  /** The server cut the diff short. */
  readonly truncated: boolean;
}

export const EMPTY_PARSED_DIFF: ParsedDiff = {
  files: [],
  additions: 0,
  deletions: 0,
  truncated: false,
};

const TRUNCATED_MARKER = /\n*\[truncated\]\n*$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

const UTF8 = new TextEncoder();

/** Git's C-style quoting, used for paths with spaces, quotes or non-ASCII bytes. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...UTF8.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = body[index + 1] ?? "";
    bytes.push(...UTF8.encode(ESCAPES[next] ?? next));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** "--- a/x" or "+++ b/x" (or /dev/null), with git's trailing tab metadata dropped. */
function headerPath(line: string, prefix: "a/" | "b/"): string | null {
  const raw = unquotePath(line.slice(4).replace(/\t.*$/, "").trim());
  return raw === "/dev/null" ? null : stripPrefix(raw, prefix);
}

/** Both paths of "diff --git a/x b/y"; ambiguous names with spaces split where they match. */
function gitHeaderPaths(rest: string): { readonly from: string; readonly to: string } | null {
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (!match) return null;
    return {
      from: stripPrefix(unquotePath(match[1] ?? ""), "a/"),
      to: stripPrefix(unquotePath(match[2] ?? ""), "b/"),
    };
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const from = rest.slice(0, half);
    const to = rest.slice(half + 1);
    if (from.startsWith("a/") && to.startsWith("b/") && from.slice(2) === to.slice(2)) {
      return { from: from.slice(2), to: to.slice(2) };
    }
  }
  const match = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return match ? { from: match[1] ?? "", to: match[2] ?? "" } : null;
}

interface FileDraft {
  path: string | null;
  previousPath: string | null;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  /** Saw its "--- " line; another one starts the next file. */
  sawOldPath: boolean;
  hunks: DiffHunk[];
}

function newDraft(): FileDraft {
  return {
    path: null,
    previousPath: null,
    added: false,
    deleted: false,
    renamed: false,
    binary: false,
    sawOldPath: false,
    hunks: [],
  };
}

/** Which sides lack a final newline once a "\" line follows `line` (the side's last line). */
function withMissingNewline(
  current: MissingFinalNewline | null,
  line: string | undefined,
): MissingFinalNewline | null {
  const side = line?.startsWith("+") ? "new" : line?.startsWith("-") ? "old" : "both";
  if (current === null || current === side) return side;
  return "both";
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  // Only the patch's own final newline goes: a body line's trailing whitespace is content.
  const truncated = TRUNCATED_MARKER.test(text);
  const body = truncated ? text.replace(TRUNCATED_MARKER, "") : text.replace(/\r?\n$/, "");
  if (body.trim().length === 0) {
    return truncated ? { ...EMPTY_PARSED_DIFF, truncated } : EMPTY_PARSED_DIFF;
  }

  const files: DiffFile[] = [];
  let draft: FileDraft | null = null;
  let hunk: {
    header: Omit<DiffHunk, "lines" | "additions" | "deletions" | "missingFinalNewline">;
    lines: string[];
    missingFinalNewline: MissingFinalNewline | null;
  } | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const closeHunk = () => {
    if (draft === null || hunk === null) return;
    let additions = 0;
    let deletions = 0;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    draft.hunks.push({
      ...hunk.header,
      lines: hunk.lines,
      additions,
      deletions,
      missingFinalNewline: hunk.missingFinalNewline,
    });
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (draft === null) return;
    const current = draft;
    draft = null;
    const path = current.path ?? current.previousPath;
    if (path === null) return;
    let additions = 0;
    let deletions = 0;
    let lineCount = 0;
    for (const entry of current.hunks) {
      additions += entry.additions;
      deletions += entry.deletions;
      lineCount += entry.lines.length;
    }
    const status: DiffFileStatus = current.binary
      ? "binary"
      : current.added
        ? "added"
        : current.deleted
          ? "deleted"
          : current.renamed
            ? "renamed"
            : "modified";
    files.push({
      key: `${files.length}:${path}`,
      path,
      previousPath: current.renamed ? current.previousPath : null,
      status,
      hunks: current.hunks,
      additions,
      deletions,
      lineCount,
    });
  };

  for (const line of body.split("\n")) {
    // "\ No newline at end of file" follows its side's last line, even the hunk's very last.
    if (hunk !== null && line.startsWith("\\")) {
      hunk.missingFinalNewline = withMissingNewline(hunk.missingFinalNewline, hunk.lines.at(-1));
      continue;
    }
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      // Some tools strip the space from empty context lines.
      const bodyLine = line.length === 0 ? " " : line;
      if (marker === "+") newLeft -= 1;
      else if (marker === "-") oldLeft -= 1;
      else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      hunk.lines.push(bodyLine);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      closeFile();
      draft = newDraft();
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      if (paths) {
        draft.previousPath = paths.from;
        draft.path = paths.to;
      }
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      closeHunk();
      draft ??= newDraft();
      oldLeft = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      newLeft = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      hunk = {
        header: {
          oldStart: Number(hunkMatch[1]),
          newStart: Number(hunkMatch[3]),
          context: (hunkMatch[5] ?? "").trim(),
        },
        lines: [],
        missingFinalNewline: null,
      };
      continue;
    }
    if (line.startsWith("--- ")) {
      // A bare patch (no "diff --git") starts its file here.
      if (draft === null || draft.sawOldPath || draft.binary || draft.hunks.length > 0) {
        closeFile();
        draft = newDraft();
      }
      draft.sawOldPath = true;
      const path = headerPath(line, "a/");
      if (path === null) draft.added = true;
      else draft.previousPath = path;
      continue;
    }
    if (draft === null) continue;
    if (line.startsWith("+++ ")) {
      const path = headerPath(line, "b/");
      if (path === null) draft.deleted = true;
      else draft.path = path;
    } else if (line.startsWith("new file mode")) draft.added = true;
    else if (line.startsWith("deleted file mode")) draft.deleted = true;
    else if (line.startsWith("rename from ")) {
      draft.renamed = true;
      draft.previousPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      draft.renamed = true;
      draft.path = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      draft.binary = true;
    }
  }
  closeFile();

  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files, additions, deletions, truncated };
}

/** Body lines a file shows before "show more", and how many more each press reveals. */
export const DIFF_FILE_LINE_BUDGET = 400;

export interface DiffChunk {
  /** Stable per hunk, so revealing more lines updates a drawn hunk instead of remounting it. */
  readonly key: string;
  readonly hunkIndex: number;
  /** The hunk's "@@" line as drawn above it, counting all its lines even when cut short. */
  readonly header: string;
  /** A one-hunk patch for OpenTUI's <diff>, with counts matching the lines it holds. */
  readonly patch: string;
  /** Drawn under the hunk: changes its rows can't show, like a line ending or final newline. */
  readonly notes: ReadonlyArray<string>;
}

export interface DiffFileLayout {
  readonly chunks: ReadonlyArray<DiffChunk>;
  readonly hiddenLines: number;
}

function hunkHeader(hunk: DiffHunk, lines: ReadonlyArray<string>): string {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.startsWith("+")) newCount += 1;
    else if (line.startsWith("-")) oldCount += 1;
    else {
      oldCount += 1;
      newCount += 1;
    }
  }
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
}

const EOF_NOTES: Record<MissingFinalNewline, string> = {
  old: "↵ No newline at end of file in the old version",
  new: "↵ No newline at end of file in the new version",
  both: "↵ No newline at end of file",
};

/** Lists line numbers, the first few only. */
function onLines(lines: ReadonlyArray<number>): string {
  const shown = lines.slice(0, 5).join(", ");
  const more = lines.length > 5 ? ` and ${lines.length - 5} more` : "";
  return `on ${lines.length === 1 ? "line" : "lines"} ${shown}${more}`;
}

const withoutCr = (text: string) => (text.endsWith("\r") ? text.slice(0, -1) : text);
const withoutTrailingWhitespace = (text: string) => text.replace(/[ \t]+$/, "");

/**
 * Notes for changed lines that draw the same on both sides: trailing whitespace (invisible on a
 * highlighted row) and line endings (the "\r" isn't drawn). Removals pair with the additions
 * after them in order, as the split view lays them out; additions are numbered on the new side.
 */
function invisibleChangeNotes(hunk: DiffHunk, lines: ReadonlyArray<string>): string[] {
  const whitespace: number[] = [];
  const endings = { "LF → CRLF": [] as number[], "CRLF → LF": [] as number[] };
  let newLine = hunk.newStart;
  let index = 0;
  while (index < lines.length) {
    const removed: string[] = [];
    const added: string[] = [];
    while (lines[index]?.startsWith("-")) removed.push((lines[index++] ?? "").slice(1));
    while (lines[index]?.startsWith("+")) added.push((lines[index++] ?? "").slice(1));
    for (const [pair, after] of added.slice(0, removed.length).entries()) {
      const before = removed[pair] ?? "";
      const [drawnBefore, drawnAfter] = [withoutCr(before), withoutCr(after)];
      if (withoutTrailingWhitespace(drawnBefore) !== withoutTrailingWhitespace(drawnAfter))
        continue;
      if (drawnBefore !== drawnAfter) whitespace.push(newLine + pair);
      if (before.endsWith("\r") !== after.endsWith("\r")) {
        endings[after.endsWith("\r") ? "LF → CRLF" : "CRLF → LF"].push(newLine + pair);
      }
    }
    newLine += added.length;
    if (removed.length === 0 && added.length === 0) {
      newLine += 1;
      index += 1;
    }
  }
  const notes =
    whitespace.length > 0 ? [`· Trailing whitespace changed ${onLines(whitespace)}`] : [];
  for (const [change, at] of Object.entries(endings)) {
    if (at.length > 0) notes.push(`↵ Line endings changed (${change}) ${onLines(at)}`);
  }
  return notes;
}

/** Index of the first body line of each hunk, counted across the file. */
export function hunkLineOffsets(file: DiffFile): ReadonlyArray<number> {
  const offsets: number[] = [];
  let offset = 0;
  for (const hunk of file.hunks) {
    offsets.push(offset);
    offset += hunk.lines.length;
  }
  return offsets;
}

/**
 * The hunks to draw for one file, cut off after `lineLimit` body lines so a huge file costs
 * one screenful of work; a hunk that crosses the limit is drawn in part.
 */
export function layoutDiffFile(file: DiffFile, lineLimit: number): DiffFileLayout {
  const chunks: DiffChunk[] = [];
  let shown = 0;
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const room = lineLimit - shown;
    if (room <= 0) break;
    const lines = hunk.lines.length <= room ? hunk.lines : hunk.lines.slice(0, room);
    shown += lines.length;
    // The label names the whole hunk; the patch's counts match the lines it draws.
    const label = hunkHeader(hunk, hunk.lines);
    chunks.push({
      key: `${file.key}:${hunkIndex}`,
      hunkIndex,
      header: hunk.context.length > 0 ? `${label} ${hunk.context}` : label,
      // A CRLF line's "\r" would draw as an extra row; its notes say when line endings change.
      patch: `--- a/${file.path}\n+++ b/${file.path}\n${hunkHeader(hunk, lines)}\n${lines.map(withoutCr).join("\n")}`,
      notes:
        hunk.missingFinalNewline === null || lines.length < hunk.lines.length
          ? invisibleChangeNotes(hunk, lines)
          : [...invisibleChangeNotes(hunk, lines), EOF_NOTES[hunk.missingFinalNewline]],
    });
  }
  return { chunks, hiddenLines: Math.max(0, file.lineCount - shown) };
}

/** The line limit that draws hunk `hunkIndex` with at least a screenful of it. */
export function lineLimitShowingHunk(file: DiffFile, hunkIndex: number, lineLimit: number): number {
  const start = hunkLineOffsets(file)[hunkIndex];
  if (start === undefined || start < lineLimit) return lineLimit;
  return (Math.floor(start / DIFF_FILE_LINE_BUDGET) + 1) * DIFF_FILE_LINE_BUDGET;
}
