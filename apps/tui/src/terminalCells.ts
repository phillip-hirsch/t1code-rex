import type { TerminalCell, TerminalColor, TerminalRow } from "./terminalEmulator.ts";

/** OpenTUI's TextAttributes bits (kept here so this module loads without OpenTUI's native lib). */
export const CELL_ATTRIBUTES = {
  bold: 1 << 0,
  italic: 1 << 2,
  underline: 1 << 3,
  strikethrough: 1 << 7,
} as const;

const WIDE = 1;
const SPACER_TAIL = 2;
const TRAILING_ZWJ = /\u200d+$/u;

/** Consecutive cells with one style, drawn with one call. */
export interface TerminalCellRun {
  readonly x: number;
  readonly text: string;
  readonly foreground: TerminalColor;
  readonly background: TerminalColor;
  readonly attributes: number;
}

function sameColor(left: TerminalColor, right: TerminalColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function cellAttributes(cell: TerminalCell): number {
  return (
    (cell.bold ? CELL_ATTRIBUTES.bold : 0) |
    (cell.italic ? CELL_ATTRIBUTES.italic : 0) |
    (cell.underline ? CELL_ATTRIBUTES.underline : 0) |
    (cell.strikethrough ? CELL_ATTRIBUTES.strikethrough : 0)
  );
}

/**
 * A row as styled runs. A wide character gets a run of its own, so the column after
 * it starts where the emulator put it even if the renderer measures the glyph differently.
 * Ghostty's snapshot marks the spacer after a wide cell, not always the wide cell itself.
 */
export function terminalRowRuns(row: TerminalRow): ReadonlyArray<TerminalCellRun> {
  const runs: TerminalCellRun[] = [];
  let current: {
    x: number;
    text: string;
    foreground: TerminalColor;
    background: TerminalColor;
    attributes: number;
  } | null = null;
  const flush = () => {
    if (current !== null) runs.push(current);
    current = null;
  };
  row.cells.forEach((cell, x) => {
    if (cell.wide === SPACER_TAIL) return;
    const wide = cell.wide === WIDE || row.cells[x + 1]?.wide === SPACER_TAIL;
    const blank = cell.invisible || cell.text.length === 0;
    // Ghostty splits a ZWJ emoji it can't join into wide cells; the first keeps the ZWJ,
    // which would let the outer terminal join it to the next one. Narrow text keeps its
    // joiners: in scripts like Devanagari they're part of the text.
    const text = blank
      ? wide
        ? "  "
        : " "
      : wide
        ? cell.text.replace(TRAILING_ZWJ, "")
        : cell.text;
    const attributes = cellAttributes(cell);
    if (wide) {
      flush();
      runs.push({
        x,
        text,
        foreground: cell.foreground,
        background: cell.background,
        attributes,
      });
      return;
    }
    if (
      current !== null &&
      current.attributes === attributes &&
      sameColor(current.foreground, cell.foreground) &&
      sameColor(current.background, cell.background)
    ) {
      current.text += text;
      return;
    }
    flush();
    current = { x, text, foreground: cell.foreground, background: cell.background, attributes };
  });
  flush();
  return runs;
}

/** "↑ 120" for a viewport scrolled up into the scrollback, else null. */
export function scrollbackLabel(
  scrollbar: { readonly total: number; readonly offset: number; readonly len: number } | null,
): string | null {
  if (scrollbar === null) return null;
  const linesBelow = scrollbar.total - scrollbar.len - scrollbar.offset;
  return linesBelow > 0 ? `↑ ${linesBelow}` : null;
}
