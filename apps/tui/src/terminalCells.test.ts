import { describe, expect, it } from "vite-plus/test";

import { CELL_ATTRIBUTES, scrollbackLabel, terminalRowRuns } from "./terminalCells.ts";
import type { TerminalCell, TerminalColor } from "./terminalEmulator.ts";

const FG: TerminalColor = { r: 229, g: 229, b: 229 };
const BG: TerminalColor = { r: 17, g: 17, b: 17 };
const RED: TerminalColor = { r: 204, g: 102, b: 102 };

function cell(text: string, overrides: Partial<TerminalCell> = {}): TerminalCell {
  return {
    text,
    wide: 0,
    foreground: FG,
    background: BG,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    underline: false,
    ...overrides,
  };
}

describe("terminalRowRuns", () => {
  it("joins cells of one style and splits where the style changes", () => {
    const runs = terminalRowRuns({
      cells: [
        cell("l"),
        cell("s"),
        cell(""),
        cell("r", { foreground: RED, bold: true }),
        cell("e", { foreground: { ...RED }, bold: true }),
        cell("d", { foreground: RED, underline: true }),
      ],
    });
    expect(runs.map((run) => [run.x, run.text, run.attributes])).toEqual([
      [0, "ls ", 0],
      [3, "re", CELL_ATTRIBUTES.bold],
      [5, "d", CELL_ATTRIBUTES.underline],
    ]);
  });

  it("gives a wide character a run of its own and skips its spacer", () => {
    const runs = terminalRowRuns({
      cells: [cell("a"), cell("界", { wide: 1 }), cell("", { wide: 2 }), cell("b")],
    });
    expect(runs.map((run) => [run.x, run.text])).toEqual([
      [0, "a"],
      [1, "界"],
      [3, "b"],
    ]);
  });

  it("draws hidden text as blanks", () => {
    expect(terminalRowRuns({ cells: [cell("p", { invisible: true })] })[0]?.text).toBe(" ");
  });
});

describe("scrollbackLabel", () => {
  it("counts the lines below a viewport scrolled into the scrollback", () => {
    expect(scrollbackLabel({ total: 100, offset: 60, len: 20 })).toBe("↑ 20");
    expect(scrollbackLabel({ total: 100, offset: 80, len: 20 })).toBeNull();
    expect(scrollbackLabel(null)).toBeNull();
  });
});
