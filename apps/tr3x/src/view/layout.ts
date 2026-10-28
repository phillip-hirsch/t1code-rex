/**
 * Line arithmetic for the view's panels. Text is wrapped here rather than by
 * OpenTUI, so a panel knows how many lines it has and can say what it cut.
 */

/** `text` word-wrapped to `width` columns, keeping its own line breaks. */
export function wrapText(text: string, width: number): ReadonlyArray<string> {
  const columns = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    // A line keeps its indentation, which commands and code read by.
    const indent = /^ */u.exec(paragraph)?.[0] ?? "";
    let line = indent.length < columns ? indent : "";
    for (const word of paragraph.slice(indent.length).split(" ")) {
      let rest = word;
      // A word longer than a line is broken across lines.
      while ([...rest].length > columns) {
        if (line) {
          lines.push(line);
          line = "";
        }
        const chars = [...rest];
        lines.push(chars.slice(0, columns).join(""));
        rest = chars.slice(columns).join("");
      }
      const candidate = line.trim() ? `${line} ${rest}` : `${line}${rest}`;
      if ([...candidate].length > columns) {
        lines.push(line);
        line = rest;
      } else {
        line = candidate;
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
 * At most `max` lines, keeping the start and the end: a command's target is
 * usually its last line, so the end is never the part that's cut.
 */
export function headAndTail(lines: ReadonlyArray<string>, max: number): ReadonlyArray<string> {
  if (lines.length <= max) return lines;
  if (max <= 1) return clipLines(lines, max);
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
 * The rows key hints fill when each wraps as a whole, as the footer lays them
 * out: `indent` columns of padding, and `gap` columns of margin after each.
 */
export function hintRows(hints: ReadonlyArray<string>, width: number, gap = 2, indent = 1): number {
  const inner = Math.max(1, width - indent);
  let rows = 1;
  let used = 0;
  for (const hint of hints) {
    const need = [...hint].length + gap;
    if (used > 0 && used + need > inner) {
      rows += 1;
      used = 0;
    }
    used += need;
  }
  return rows;
}

/** The last `max` items, and how many came before them. */
export function lastItems<A>(
  items: ReadonlyArray<A>,
  max: number,
): { readonly shown: ReadonlyArray<A>; readonly hidden: number } {
  const hidden = Math.max(0, items.length - max);
  return { shown: items.slice(hidden), hidden };
}
