import { RGBA, SyntaxStyle } from "@opentui/core";
import type { NativeResourceOwner } from "@opentui/core";

/** One dark palette; the view inherits the terminal's background. */
export const palette = {
  text: "#e6e6e6",
  muted: "#9a9a9a",
  subtle: "#6b6b6b",
  accent: "#7fb7ff",
  user: "#b7d7ff",
  success: "#7ee787",
  warning: "#f2cc60",
  error: "#ff7b72",
  surface: "#1e1e1e",
  border: "#3a3a3a",
} as const;

export interface MarkdownStyles {
  readonly assistant: SyntaxStyle;
  readonly user: SyntaxStyle;
}

/** Markdown for replies, and for the user's own messages in their color. */
export function markdownStyles(owner: NativeResourceOwner): MarkdownStyles {
  return {
    assistant: markdownStyle(owner, palette.text),
    user: markdownStyle(owner, palette.user),
  };
}

function markdownStyle(owner: NativeResourceOwner, text: string): SyntaxStyle {
  const fg = (hex: string) => RGBA.fromHex(hex);
  return SyntaxStyle.fromStyles(
    {
      keyword: { fg: fg(palette.warning), bold: true },
      string: { fg: fg("#9bd1ff") },
      comment: { fg: fg(palette.subtle), italic: true },
      number: { fg: fg("#8cc8ff") },
      function: { fg: fg(palette.accent) },
      "markup.heading": { fg: fg(text), bold: true },
      "markup.bold": { fg: fg(text), bold: true },
      "markup.strong": { fg: fg(text), bold: true },
      "markup.italic": { fg: fg(text), italic: true },
      "markup.list": { fg: fg(palette.muted) },
      "markup.quote": { fg: fg(palette.muted), italic: true },
      "markup.raw": { fg: fg("#9bd1ff") },
      "markup.link": { fg: fg(palette.accent), underline: true },
      "markup.link.label": { fg: fg(palette.user), underline: true },
      "markup.link.url": { fg: fg(palette.accent), underline: true },
      conceal: { fg: fg(palette.subtle) },
      default: { fg: fg(text) },
    },
    owner,
  );
}
