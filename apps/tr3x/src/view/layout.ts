/**
 * Line arithmetic for the view. Text is measured, wrapped and cut here rather
 * than by OpenTUI, so every section knows its rows and can say what it cut.
 * Widths are terminal columns: a CJK character or an emoji takes two.
 */
import stringWidth from "string-width";

export const displayWidth = (text: string): number => stringWidth(text);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

const TAB_STOP = 4;

/**
 * Tabs as spaces to the next tab stop. string-width counts a tab as no
 * columns while the terminal draws it wider, so no tab is measured or drawn.
 */
export function expandTabs(text: string): string {
  if (!text.includes("\t")) return text;
  return text
    .split("\n")
    .map((line) => {
      const [first = "", ...rest] = line.split("\t");
      let expanded = first;
      let column = displayWidth(first);
      for (const part of rest) {
        const pad = TAB_STOP - (column % TAB_STOP);
        expanded += `${" ".repeat(pad)}${part}`;
        column += pad + displayWidth(part);
      }
      return expanded;
    })
    .join("\n");
}

/** `text` on one line of `width` columns, ending in "…" when cut. */
export function truncateText(text: string, width: number): string {
  const line = expandTabs(text).replace(/\s*[\r\n]\s*/gu, " ");
  if (displayWidth(line) <= width) return line;
  if (width <= 0) return "";
  let kept = "";
  let used = 0;
  for (const grapheme of graphemes(line)) {
    const size = displayWidth(grapheme);
    if (used + size > width - 1) break;
    kept += grapheme;
    used += size;
  }
  return `${kept}…`;
}

/** `text` word-wrapped to `width` columns, keeping its own line breaks. */
export function wrapText(text: string, width: number): ReadonlyArray<string> {
  const columns = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of expandTabs(text).split(/\r?\n/u)) {
    // A line keeps its indentation, which commands and code read by.
    const indent = /^ */u.exec(paragraph)?.[0] ?? "";
    let line = indent.length < columns ? indent : "";
    let used = line.length;
    for (const word of paragraph.slice(indent.length).split(" ")) {
      const size = displayWidth(word);
      const gap = line.trim() ? 1 : 0;
      if (used + gap + size <= columns) {
        line += `${gap ? " " : ""}${word}`;
        used += gap + size;
        continue;
      }
      if (line.trim()) {
        lines.push(line);
        line = "";
        used = 0;
      }
      // A word longer than a line breaks between characters, never inside one.
      for (const grapheme of graphemes(word)) {
        const cell = displayWidth(grapheme);
        if (used > 0 && used + cell > columns) {
          lines.push(line);
          line = "";
          used = 0;
        }
        line += grapheme;
        used += cell;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** At most `max` lines; when some are cut, the last line says how many. */
export function clipLines(lines: ReadonlyArray<string>, max: number): ReadonlyArray<string> {
  if (lines.length <= max) return lines;
  if (max <= 0) return [];
  const kept = max - 1;
  return [...lines.slice(0, kept), `… ${lines.length - kept} more lines`];
}

/**
 * At most `max` lines, keeping the end first and then the start: a command's
 * target is usually its last line. The cue saying what's hidden goes first.
 */
export function headAndTail(lines: ReadonlyArray<string>, max: number): ReadonlyArray<string> {
  if (lines.length <= max) return lines;
  if (max <= 0) return [];
  const last = lines[lines.length - 1] ?? "";
  if (max === 1) return [last];
  if (max === 2) return [lines[0] ?? "", last];
  const kept = max - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return [
    ...lines.slice(0, head),
    `… ${lines.length - kept} lines hidden …`,
    ...lines.slice(lines.length - tail),
  ];
}

/**
 * Items packed into rows of `width` columns, each kept whole, `gap` columns
 * apart: how the footer's hints wrap, and the approval's choices.
 */
export function packItems(
  items: ReadonlyArray<string>,
  width: number,
  gap: number,
): ReadonlyArray<ReadonlyArray<string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let used = 0;
  for (const item of items) {
    const need = displayWidth(item) + gap;
    if (row.length > 0 && used + need > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(item);
    used += need;
  }
  if (row.length > 0) rows.push(row);
  return rows.length > 0 ? rows : [[]];
}

/** The rows the footer's hints fill: one column of padding, and two of margin after each. */
export function hintRows(hints: ReadonlyArray<string>, width: number): number {
  return packItems(hints, Math.max(1, width - 1), 2).length;
}

/** The items that fit one row, dropping those in `dropOrder` first; the rest keep their order. */
export function fitItems(
  items: ReadonlyArray<string>,
  fits: (kept: ReadonlyArray<string>) => boolean,
  dropOrder: ReadonlyArray<string>,
): ReadonlyArray<string> {
  let kept = items;
  for (const drop of dropOrder) {
    if (fits(kept)) return kept;
    kept = kept.filter((item) => item !== drop);
  }
  return fits(kept) ? kept : [];
}

/** The last `max` items, and how many came before them. */
export function lastItems<A>(
  items: ReadonlyArray<A>,
  max: number,
): { readonly shown: ReadonlyArray<A>; readonly hidden: number } {
  const hidden = Math.max(0, items.length - max);
  return { shown: items.slice(hidden), hidden };
}

export interface ListWindow {
  readonly first: number;
  readonly count: number;
  /** Items above and below the window, each a cue line when shown. */
  readonly above: number;
  readonly below: number;
}

/**
 * The slice of a list `rows` lines show with the cursor in it, cue lines
 * included, at most `maxItems` items. The cursor's item is the last to go.
 */
export function listWindow(
  length: number,
  cursor: number,
  rows: number,
  maxItems = Number.POSITIVE_INFINITY,
): ListWindow {
  if (length === 0 || rows <= 0) return { first: 0, count: 0, above: 0, below: 0 };
  for (let count = Math.min(length, maxItems, rows); count >= 1; count -= 1) {
    const first = Math.min(Math.max(0, cursor - count + 1), length - count);
    const above = first;
    const below = length - first - count;
    if (count + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0) <= rows) {
      return { first, count, above, below };
    }
  }
  // Too few rows for both cues: the cursor's item, and the larger cue if there's a row for it.
  const first = Math.min(Math.max(0, cursor), length - 1);
  const above = first;
  const below = length - first - 1;
  if (rows < 2) return { first, count: 1, above: 0, below: 0 };
  return above >= below
    ? { first, count: 1, above, below: 0 }
    : { first, count: 1, above: 0, below };
}

export interface PanelSize {
  /** Rows with every line shown, borders included. */
  readonly natural: number;
  /** Rows for the lines it must keep. */
  readonly min: number;
}

export interface LayoutInput {
  readonly height: number;
  /** The footer's rows with every hint shown; folded it takes one. */
  readonly footerRows: number;
  /** The composer's text lines, before it scrolls. */
  readonly composerLines: number;
  readonly queue: { readonly length: number; readonly window: number; readonly hintLines: number };
  /** Each message's lines, such as an error or a notice, already capped. */
  readonly messages: ReadonlyArray<number>;
  readonly request: PanelSize | null;
  readonly picker: PanelSize | null;
}

export interface LayoutPlan {
  readonly header: boolean;
  readonly transcriptLine: boolean;
  /** Rows left to the transcript, its line included. */
  readonly transcriptRows: number;
  /** Lines shown of each message, in input order. */
  readonly messageLines: ReadonlyArray<number>;
  readonly footerFolded: boolean;
  readonly composerLines: number;
  /** Queued messages listed; the rest are counted, on their own line or, folded, in the composer's border. */
  readonly queueShown: number;
  readonly queueHint: boolean;
  readonly queueFolded: boolean;
  /** False when the request panel can't keep its lines: `requestRows` is then one line saying so. */
  readonly requestFits: boolean;
  readonly requestRows: number;
  readonly pickerRows: number;
}

/**
 * One height budget for the whole view. Before a panel goes below what it must keep,
 * the queue folds, messages go to a line each, then the composer, transcript line,
 * header, footer and messages shrink. A request that still can't fit becomes one line.
 */
export function planLayout(input: LayoutInput): LayoutPlan {
  const plan = fitLayout(input);
  if (!input.request || plan.requestRows >= input.request.min) return plan;
  return { ...fitLayout({ ...input, request: { natural: 1, min: 1 } }), requestFits: false };
}

function fitLayout(input: LayoutInput): LayoutPlan {
  const { queue } = input;
  let plan: LayoutPlan = {
    header: true,
    transcriptLine: true,
    transcriptRows: 0,
    messageLines: input.messages,
    footerFolded: false,
    composerLines: Math.max(1, input.composerLines),
    queueShown: Math.min(queue.window, queue.length),
    queueHint: queue.length > 0,
    queueFolded: false,
    requestFits: true,
    requestRows: 0,
    pickerRows: 0,
  };
  const queueRows = (next: LayoutPlan) =>
    queue.length === 0 || next.queueFolded
      ? 0
      : (next.queueShown < queue.length ? 1 : 0) +
        next.queueShown +
        (next.queueHint ? queue.hintLines : 0);
  const used = (next: LayoutPlan) =>
    (next.header ? 1 : 0) +
    (next.transcriptLine ? 1 : 0) +
    queueRows(next) +
    next.messageLines.reduce((sum, lines) => sum + lines, 0) +
    2 +
    next.composerLines +
    (next.footerFolded ? 1 : input.footerRows);
  /** The longest message one line shorter, if one is longer than `floor`. */
  const shorterMessages = (next: LayoutPlan, floor: number): LayoutPlan | null => {
    const longest = Math.max(0, ...next.messageLines);
    if (longest <= floor) return null;
    const index = next.messageLines.indexOf(longest);
    return {
      ...next,
      messageLines: next.messageLines.map((lines, at) => (at === index ? lines - 1 : lines)),
    };
  };
  const needed = (input.request?.min ?? 0) + (input.picker?.min ?? 0);
  const shrink = (next: LayoutPlan): LayoutPlan | null => {
    if (next.queueShown > 0) return { ...next, queueShown: next.queueShown - 1 };
    if (next.queueHint) return { ...next, queueHint: false };
    if (queue.length > 0 && !next.queueFolded) return { ...next, queueFolded: true };
    const oneLine = shorterMessages(next, 1);
    if (oneLine) return oneLine;
    if (next.composerLines > 1) return { ...next, composerLines: next.composerLines - 1 };
    if (next.transcriptLine) return { ...next, transcriptLine: false };
    if (next.header) return { ...next, header: false };
    if (!next.footerFolded && input.footerRows > 1) return { ...next, footerFolded: true };
    return shorterMessages(next, 0);
  };
  while (used(plan) + needed > input.height) {
    const next = shrink(plan);
    if (next === null) break;
    plan = next;
  }
  const room = Math.max(0, input.height - used(plan));
  // The request comes first: the picker's lines are only what it must keep.
  const request = input.request
    ? Math.min(
        input.request.natural,
        room,
        Math.max(input.request.min, room - (input.picker?.min ?? 0)),
      )
    : 0;
  const picker = input.picker ? Math.min(input.picker.natural, room - request) : 0;
  return {
    ...plan,
    transcriptRows: room - request - picker + (plan.transcriptLine ? 1 : 0),
    requestRows: request,
    pickerRows: picker,
  };
}
