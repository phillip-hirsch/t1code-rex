import { describe, expect, it, vi } from "vite-plus/test";

const filetypeByExtension = new Map([
  ["go", "go"],
  ["js", "javascript"],
  ["jsx", "javascriptreact"],
  ["md", "markdown"],
  ["patch", "diff"],
  ["py", "python"],
  ["rs", "rust"],
  ["ts", "typescript"],
  ["tsx", "typescriptreact"],
]);

vi.mock("@opentui/core", () => ({
  infoStringToFiletype: (infoString: string) => {
    const token = infoString.trim().split(/\s+/, 1)[0]?.replace(/^\./, "").toLowerCase();
    if (!token) return undefined;
    if (token === "dockerfile") return "dockerfile";
    const extension = token.includes(".") ? token.slice(token.lastIndexOf(".") + 1) : token;
    return filetypeByExtension.get(extension) ?? token;
  },
}));

import {
  isDiffLikeCodeBlockFiletype,
  resolveCodeBlockFiletype,
  splitMessageBlocks,
  type MessageBlock,
  type MessageBlocks,
} from "./messageMarkdown.ts";

function shape(content: string) {
  return splitMessageBlocks(content).blocks.map((block) =>
    block.kind === "code"
      ? { kind: block.kind, content: block.content, language: block.language }
      : { kind: block.kind, content: block.content },
  );
}

/** Streams `message` in `chunk`-sized appends, splitting incrementally like the view does. */
function stream(message: string, chunk: number): MessageBlocks[] {
  const results: MessageBlocks[] = [];
  let previous: MessageBlocks | null = null;
  for (let end = Math.min(chunk, message.length); ; end = Math.min(end + chunk, message.length)) {
    previous = splitMessageBlocks(message.slice(0, end), previous);
    results.push(previous);
    if (end === message.length) return results;
  }
}

/**
 * Characters OpenTUI parses and highlights over a stream: a block whose content changed (or
 * is new) is set on its renderable and highlighted again; an unchanged block isn't.
 */
function streamedHighlightChars(results: ReadonlyArray<MessageBlocks>): number {
  let total = 0;
  let previous = new Map<string, string>();
  for (const { blocks } of results) {
    const next = new Map<string, string>();
    for (const block of blocks) {
      const key = `${block.start}:${block.kind}`;
      next.set(key, block.content);
      if (previous.get(key) !== block.content) total += block.content.length;
    }
    previous = next;
  }
  return total;
}

function paragraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `Paragraph ${index + 1} has some words in it, about eighty characters long.`,
  ).join("\n\n");
}

const SAMPLE = [
  "Intro with **bold** and `code`.",
  "",
  "1. First item",
  "",
  "   continued under the first item",
  "2. Second item",
  "",
  "```ts",
  "const x = 1;",
  "",
  "const y = 2;",
  "```",
  "After the fence.",
  "",
  "",
  "    indented code after a blank line",
  "",
  "> quoted",
  "",
  "~~~",
  "unclosed tilde fence",
].join("\n");

describe("splitMessageBlocks", () => {
  it("splits prose into chunks at blank lines", () => {
    expect(shape("hello\n\nworld\n")).toEqual([
      { kind: "markdown", content: "hello" },
      { kind: "markdown", content: "world" },
    ]);
  });

  it("keeps indented continuations and consecutive lines in one chunk", () => {
    expect(shape("- a\n\n  more of a\n- b\nlazy line")).toEqual([
      { kind: "markdown", content: "- a\n\n  more of a\n- b\nlazy line" },
    ]);
  });

  it("extracts fenced code blocks and their language", () => {
    expect(shape("before\n```ts\nconst x = 1;\n\nx;\n```\nafter")).toEqual([
      { kind: "markdown", content: "before" },
      { kind: "code", content: "const x = 1;\n\nx;", language: "ts" },
      { kind: "markdown", content: "after" },
    ]);
  });

  it("supports tilde fences and ignores extra info strings", () => {
    expect(shape("~~~typescript title=example.ts\nconsole.log(1)\n~~~")).toEqual([
      { kind: "code", content: "console.log(1)", language: "typescript" },
    ]);
  });

  it("treats unclosed fences as code until the end", () => {
    expect(shape("```js\nconsole.log('x')")).toEqual([
      { kind: "code", content: "console.log('x')", language: "js" },
    ]);
    expect(shape("```js")).toEqual([{ kind: "code", content: "", language: "js" }]);
  });

  it("drops blank-only text and normalizes CRLF", () => {
    expect(shape("\n \n")).toEqual([]);
    expect(shape("a\r\n\r\nb")).toEqual([
      { kind: "markdown", content: "a" },
      { kind: "markdown", content: "b" },
    ]);
  });

  it("matches a full split at every point of a stream and keeps earlier blocks", () => {
    for (const chunk of [1, 3, 7]) {
      const results = stream(SAMPLE, chunk);
      let previous: ReadonlyArray<MessageBlock> = [];
      results.forEach((result, step) => {
        expect(result.blocks).toEqual(splitMessageBlocks(result.source).blocks);
        // Every block but the previous last one is reused as is.
        for (let index = 0; index < previous.length - 1; index += 1) {
          expect(result.blocks[index], `chunk ${chunk}, step ${step}`).toBe(previous[index]);
        }
        previous = result.blocks;
      });
    }
  });

  it("re-highlights only the growing block, so streaming work grows linearly", () => {
    // Paragraph-by-paragraph, as the server streams Claude replies.
    const twelve = paragraphs(12);
    const byParagraph = streamedHighlightChars(
      twelve
        .split("\n\n")
        .map((_, index, all) => splitMessageBlocks(all.slice(0, index + 1).join("\n\n"))),
    );
    expect(byParagraph).toBeLessThanOrEqual(twelve.length);

    // Token-sized deltas: doubling the reply roughly doubles the work.
    const small = streamedHighlightChars(stream(paragraphs(12), 4));
    const large = streamedHighlightChars(stream(paragraphs(24), 4));
    expect(large / small).toBeLessThan(2.1);
    // One coalesced block re-highlights the whole reply on every delta instead.
    const coalesced = (count: number) =>
      stream(paragraphs(count), 4).reduce((sum, result) => sum + result.source.length, 0);
    expect(coalesced(24) / coalesced(12)).toBeGreaterThan(3.9);
  });
});

describe("resolveCodeBlockFiletype", () => {
  it("normalizes patch-style fence languages to diff", () => {
    expect(resolveCodeBlockFiletype("patch")).toBe("diff");
    expect(resolveCodeBlockFiletype("udiff")).toBe("diff");
    expect(resolveCodeBlockFiletype("unified-diff")).toBe("diff");
  });

  it("normalizes code fence info strings through OpenTUI filetype resolution", () => {
    expect(resolveCodeBlockFiletype("js")).toBe("javascript");
    expect(resolveCodeBlockFiletype("jsx")).toBe("javascriptreact");
    expect(resolveCodeBlockFiletype("ts")).toBe("typescript");
    expect(resolveCodeBlockFiletype("tsx")).toBe("typescriptreact");
    expect(resolveCodeBlockFiletype("py")).toBe("python");
    expect(resolveCodeBlockFiletype("main.rs")).toBe("rust");
    expect(resolveCodeBlockFiletype("Dockerfile")).toBe("dockerfile");
    expect(resolveCodeBlockFiletype("go")).toBe("go");
  });

  it("detects diff-like code block filetypes", () => {
    expect(isDiffLikeCodeBlockFiletype("diff")).toBe(true);
    expect(isDiffLikeCodeBlockFiletype("typescript")).toBe(false);
    expect(isDiffLikeCodeBlockFiletype(undefined)).toBe(false);
  });
});
