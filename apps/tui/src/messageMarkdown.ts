import { infoStringToFiletype } from "@opentui/core";

/**
 * One top-level block of a message: a fenced code block, or a markdown chunk. `start` is
 * where the block's source begins in the (newline-normalized) message.
 */
export type MessageBlock =
  | {
      readonly kind: "markdown";
      readonly start: number;
      readonly content: string;
    }
  | {
      readonly kind: "code";
      readonly start: number;
      readonly content: string;
      readonly language: string | null;
    };

export interface MessageBlocks {
  readonly source: string;
  readonly blocks: ReadonlyArray<MessageBlock>;
}

type FenceState = {
  marker: "`" | "~";
  length: number;
  language: string | null;
};

function parseFenceStart(line: string): FenceState | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) {
    return null;
  }

  const fence = match[1] ?? "";
  const marker = fence[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  const info = (match[2] ?? "").trim();
  const languageMatch = /^([^\s{]+)/.exec(info);
  return {
    marker,
    length: fence.length,
    language: languageMatch?.[1] ?? null,
  };
}

function isFenceEnd(line: string, state: FenceState): boolean {
  const pattern = new RegExp(`^ {0,3}${state.marker}{${state.length},}\\s*$`);
  return pattern.test(line);
}

/** Appends the blocks of `source` from `from` (a line start outside any block) onward. */
function scanBlocks(source: string, from: number, blocks: MessageBlock[]): void {
  let markdownStart = -1;
  let markdownEnd = -1;
  let blankSinceMarkdown = false;
  let fence: { state: FenceState; start: number; bodyStart: number } | null = null;
  // Inside an HTML comment (CommonMark HTML block type 2), blank lines don't end the block.
  let inComment = false;

  // A block ending in a setext underline ("Title\n====") keeps its newline: the
  // highlighter only styles the heading when the underline line is terminated.
  const markdownEndWithSetextNewline = () => {
    if (source[markdownEnd] !== "\n") return markdownEnd;
    const lastLine = source.slice(source.lastIndexOf("\n", markdownEnd - 1) + 1, markdownEnd);
    return /^ {0,3}(=+|-+)\s*$/.test(lastLine) ? markdownEnd + 1 : markdownEnd;
  };

  const flushMarkdown = () => {
    if (markdownStart === -1) return;
    blocks.push({
      kind: "markdown",
      start: markdownStart,
      content: source.slice(markdownStart, markdownEndWithSetextNewline()),
    });
    markdownStart = -1;
    blankSinceMarkdown = false;
  };

  let offset = from;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const lineEnd = newline === -1 ? source.length : newline;
    const next = newline === -1 ? source.length : newline + 1;
    const line = source.slice(offset, lineEnd);

    if (fence) {
      if (isFenceEnd(line, fence.state)) {
        blocks.push({
          kind: "code",
          start: fence.start,
          content: source.slice(fence.bodyStart, Math.max(fence.bodyStart, offset - 1)),
          language: fence.state.language,
        });
        fence = null;
      }
    } else if (inComment) {
      markdownEnd = lineEnd;
      if (line.includes("-->")) inComment = false;
    } else if (line.trim() === "") {
      if (markdownStart !== -1) blankSinceMarkdown = true;
    } else {
      const fenceStart = parseFenceStart(line);
      if (fenceStart) {
        flushMarkdown();
        fence = { state: fenceStart, start: offset, bodyStart: next };
      } else {
        // A blank line followed by an unindented line starts a new chunk. Indented lines
        // continue the chunk (list items, nested paragraphs, indented code).
        if (blankSinceMarkdown && !/^\s/.test(line)) flushMarkdown();
        if (markdownStart === -1) markdownStart = offset;
        markdownEnd = lineEnd;
        blankSinceMarkdown = false;
        // "<!-->" and "<!--->" close on the same line, so check the whole line.
        if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) {
          inComment = true;
        }
      }
    }
    offset = next;
  }

  if (fence) {
    // Unclosed (usually still streaming): code until the end.
    blocks.push({
      kind: "code",
      start: fence.start,
      content: source.slice(fence.bodyStart),
      language: fence.state.language,
    });
  } else {
    flushMarkdown();
  }
}

/**
 * Splits a message into fenced code blocks and markdown chunks separated by blank lines.
 * Appending text can't move a boundary before the last block, so given the result for a
 * prefix, only the last block is scanned again and earlier blocks keep their identity.
 */
export function splitMessageBlocks(
  content: string,
  previous: MessageBlocks | null = null,
): MessageBlocks {
  const source = content.includes("\r") ? content.replace(/\r\n?/g, "\n") : content;
  if (previous !== null && source.startsWith(previous.source)) {
    if (source.length === previous.source.length) return previous;
    const last = previous.blocks.at(-1);
    if (last !== undefined) {
      const blocks = previous.blocks.slice(0, -1);
      scanBlocks(source, last.start, blocks);
      return { source, blocks };
    }
  }
  const blocks: MessageBlock[] = [];
  scanBlocks(source, 0, blocks);
  return { source, blocks };
}

export function resolveCodeBlockFiletype(
  language: string | null,
  resolveInfoStringToFiletype: (infoString: string) => string | undefined = infoStringToFiletype,
): string | undefined {
  if (!language) {
    return undefined;
  }

  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "udiff" || normalized === "unified-diff") {
    return "diff";
  }

  return resolveInfoStringToFiletype(language) ?? normalized;
}

export function isDiffLikeCodeBlockFiletype(filetype: string | undefined): boolean {
  return filetype === "diff";
}
