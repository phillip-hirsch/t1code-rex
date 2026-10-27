import { RGBA, SyntaxStyle, addDefaultParsers, infoStringToFiletype } from "@opentui/core";
import { memo, useMemo } from "react";

import { CODE_BLOCK_TREE_SITTER_PARSERS } from "./codeBlockParsers.ts";
import {
  isDiffLikeCodeBlockFiletype,
  parseMessageMarkdownSegments,
  resolveCodeBlockFiletype,
} from "./messageMarkdown.ts";
import type { TuiColor, TuiPalette, TuiTheme } from "./theme.ts";

let parsersRegistered = false;

/** Registers the extra tree-sitter grammars once, before the first code block renders. */
function ensureCodeBlockParsers(): void {
  if (parsersRegistered) return;
  parsersRegistered = true;
  addDefaultParsers(CODE_BLOCK_TREE_SITTER_PARSERS);
}

function rgba(color: TuiColor): RGBA {
  return RGBA.fromHex(color);
}

// The old TUI's styles, unchanged.
function buildMessageMarkdownSyntax(palette: TuiPalette) {
  return SyntaxStyle.fromStyles({
    keyword: { fg: rgba(palette.warning), bold: true },
    string: { fg: RGBA.fromHex("#9bd1ff") },
    comment: { fg: rgba(palette.subtle), italic: true },
    number: { fg: RGBA.fromHex("#8cc8ff") },
    function: { fg: rgba(palette.accent) },
    type: { fg: RGBA.fromHex("#f7b267") },
    operator: { fg: rgba(palette.warning) },
    variable: { fg: rgba(palette.text) },
    property: { fg: RGBA.fromHex("#8cc8ff") },
    "punctuation.bracket": { fg: rgba(palette.text) },
    "punctuation.delimiter": { fg: rgba(palette.muted) },
    "punctuation.special": { fg: rgba(palette.subtle) },
    "markup.heading": { fg: rgba(palette.text), bold: true },
    "markup.heading.1": { fg: rgba(palette.text), bold: true, underline: true },
    "markup.heading.2": { fg: rgba(palette.text), bold: true },
    "markup.heading.3": { fg: rgba(palette.text), bold: true },
    "markup.bold": { fg: rgba(palette.text), bold: true },
    "markup.strong": { fg: rgba(palette.text), bold: true },
    "markup.italic": { fg: rgba(palette.text), italic: true },
    "markup.list": { fg: rgba(palette.muted) },
    "markup.quote": { fg: rgba(palette.muted), italic: true },
    "markup.raw": { fg: RGBA.fromHex("#9bd1ff"), bg: rgba(palette.surfaceAlt) },
    "markup.raw.block": { fg: RGBA.fromHex("#9bd1ff"), bg: rgba(palette.surfaceAlt) },
    "markup.raw.inline": { fg: RGBA.fromHex("#9bd1ff"), bg: rgba(palette.surfaceAlt) },
    "markup.link": { fg: RGBA.fromHex("#7fb7ff"), underline: true },
    "markup.link.label": { fg: RGBA.fromHex("#b7d7ff"), underline: true },
    "markup.link.url": { fg: RGBA.fromHex("#7fb7ff"), underline: true },
    label: { fg: rgba(palette.success) },
    conceal: { fg: rgba(palette.subtle) },
    default: { fg: rgba(palette.text) },
  });
}

function buildDiffSyntax(palette: TuiPalette) {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#ff7b72"), bold: true },
    string: { fg: RGBA.fromHex("#a5d6ff") },
    comment: { fg: RGBA.fromHex("#8b949e"), italic: true },
    number: { fg: RGBA.fromHex("#79c0ff") },
    function: { fg: RGBA.fromHex("#d2a8ff") },
    type: { fg: RGBA.fromHex("#ffa657") },
    operator: { fg: RGBA.fromHex("#ffb86b") },
    variable: { fg: rgba(palette.text) },
    property: { fg: RGBA.fromHex("#79c0ff") },
    constant: { fg: RGBA.fromHex("#79c0ff") },
    tag: { fg: RGBA.fromHex("#7ee787") },
    attribute: { fg: RGBA.fromHex("#d2a8ff") },
    "punctuation.bracket": { fg: RGBA.fromHex("#c9d1d9") },
    "punctuation.delimiter": { fg: RGBA.fromHex("#c9d1d9") },
    "punctuation.special": { fg: RGBA.fromHex("#8b949e") },
    default: { fg: rgba(palette.text) },
  });
}

function buildCodeBlockSyntax() {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#c9b37e"), bold: true },
    string: { fg: RGBA.fromHex("#9ab37f") },
    comment: { fg: RGBA.fromHex("#6f6f6f"), italic: true },
    number: { fg: RGBA.fromHex("#b8a07a") },
    function: { fg: RGBA.fromHex("#c7c7c7") },
    type: { fg: RGBA.fromHex("#b3aaa0") },
    operator: { fg: RGBA.fromHex("#a8a8a8") },
    variable: { fg: RGBA.fromHex("#d0d0d0") },
    property: { fg: RGBA.fromHex("#bbbbbb") },
    constant: { fg: RGBA.fromHex("#c4c4c4") },
    tag: { fg: RGBA.fromHex("#c9b37e") },
    attribute: { fg: RGBA.fromHex("#b3aaa0") },
    "punctuation.bracket": { fg: RGBA.fromHex("#9a9a9a") },
    "punctuation.delimiter": { fg: RGBA.fromHex("#8a8a8a") },
    "punctuation.special": { fg: RGBA.fromHex("#7c7c7c") },
    default: { fg: RGBA.fromHex("#d0d0d0") },
  });
}

export interface MarkdownStyles {
  readonly theme: TuiTheme;
  readonly message: SyntaxStyle;
  readonly code: SyntaxStyle;
  readonly diff: SyntaxStyle;
}

/** Syntax styles for one theme; build once per theme and share across rows. */
export function useMarkdownStyles(theme: TuiTheme): MarkdownStyles {
  return useMemo(() => {
    ensureCodeBlockParsers();
    return {
      theme,
      message: buildMessageMarkdownSyntax(theme.palette),
      code: buildCodeBlockSyntax(),
      diff: buildDiffSyntax(theme.palette),
    };
  }, [theme]);
}

export interface MessageMarkdownProps {
  readonly content: string;
  readonly styles: MarkdownStyles;
  readonly color?: TuiColor;
  readonly fillWidth?: boolean;
  /** Keeps the trailing block open while text streams in. */
  readonly streaming?: boolean;
  readonly onCopyCodeBlock?: (value: string) => void;
}

/**
 * Markdown with fenced code blocks pulled out into highlighted, copyable blocks, as in the
 * old timeline. Segments are keyed by position so streamed text updates a block in place.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  styles,
  color,
  fillWidth = true,
  streaming = false,
  onCopyCodeBlock,
}: MessageMarkdownProps) {
  const segments = useMemo(() => parseMessageMarkdownSegments(content), [content]);
  const palette = styles.theme.palette;
  const fg = color ?? palette.text;
  const widthStyle = fillWidth
    ? ({ width: "100%" } as const)
    : ({ width: "auto", maxWidth: "100%" } as const);

  if (!segments.some((segment) => segment.kind === "code")) {
    return (
      <markdown
        content={content}
        syntaxStyle={styles.message}
        conceal
        streaming={streaming}
        style={{ ...widthStyle, minWidth: 0, flexShrink: 0, fg }}
      />
    );
  }

  return (
    <box style={{ ...widthStyle, minWidth: 0, flexShrink: 1, flexDirection: "column" }}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        const marginBottom = last ? 0 : 1;
        const key = `${index}:${segment.kind}`;
        if (segment.kind === "markdown") {
          if (!segment.content.trim()) {
            return <box key={key} style={{ height: marginBottom }} />;
          }
          return (
            <markdown
              key={key}
              content={segment.content}
              syntaxStyle={styles.message}
              conceal
              streaming={streaming && last}
              style={{ ...widthStyle, minWidth: 0, flexShrink: 0, fg, marginBottom }}
            />
          );
        }
        const filetype = resolveCodeBlockFiletype(segment.language, infoStringToFiletype);
        const syntax = isDiffLikeCodeBlockFiletype(filetype) ? styles.diff : styles.code;
        return (
          <box
            key={key}
            style={{
              width: "auto",
              minWidth: 0,
              maxWidth: "85%",
              flexDirection: "column",
              marginBottom,
            }}
          >
            <box
              style={{
                width: "auto",
                minWidth: 0,
                flexDirection: "column",
                backgroundColor: styles.theme.codeBlock.background,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
              {segment.language ? (
                <text content={segment.language} style={{ fg: styles.theme.codeBlock.language }} />
              ) : null}
              <code
                content={segment.content || " "}
                {...(filetype ? { filetype } : {})}
                syntaxStyle={syntax}
                conceal
                wrapMode="char"
                style={{ width: "auto", minWidth: 0, maxWidth: "100%" }}
              />
              {onCopyCodeBlock ? (
                <box
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onCopyCodeBlock(segment.content);
                  }}
                  style={{
                    width: "100%",
                    height: 1,
                    flexDirection: "row",
                    justifyContent: "flex-end",
                  }}
                >
                  <text content="󰆏" style={{ fg: styles.theme.codeBlock.copyIcon }} />
                </box>
              ) : null}
            </box>
          </box>
        );
      })}
    </box>
  );
});
