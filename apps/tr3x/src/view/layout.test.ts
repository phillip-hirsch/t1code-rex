import { describe, expect, it } from "vite-plus/test";

import {
  clipLines,
  displayWidth,
  headAndTail,
  hintRows,
  lastItems,
  listWindow,
  planLayout,
  truncateText,
  wrapText,
  type LayoutInput,
} from "./layout.ts";

describe("wrapText", () => {
  it("wraps at words, keeps line breaks and indentation, and breaks long words", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapText("a\n  b c", 10)).toEqual(["a", "  b c"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("measures double-width text in columns and never splits a character", () => {
    expect(wrapText("漢字漢字漢字", 5)).toEqual(["漢字", "漢字", "漢字"]);
    expect(wrapText("👍🏽👍🏽👍🏽", 4)).toEqual(["👍🏽👍🏽", "👍🏽"]);
    expect(wrapText("👨‍👩‍👧 family", 2)).toEqual(["👨‍👩‍👧", "fa", "mi", "ly"]);
    for (const line of wrapText(`削除：${"漢字かな👍🏽".repeat(20)} 終端`, 30)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
    }
  });
});

describe("expandTabs", () => {
  it("measures and draws tabs as spaces to the next stop", () => {
    expect(wrapText("\tTARGET", 20)).toEqual(["    TARGET"]);
    expect(truncateText("a\tb", 10)).toBe("a   b");
    const lines = wrapText(`${"abc\t".repeat(17)}/tmp/TARGET`, 40);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(lines.at(-1)).toContain("/tmp/TARGET");
  });
});

describe("truncateText", () => {
  it("fits one line in columns and says it cut", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("漢字漢字", 5)).toBe("漢字…");
    expect(truncateText("first\nsecond", 20)).toBe("first second");
  });
});

describe("clipLines and headAndTail", () => {
  const lines = ["1", "2", "3", "4", "5", "6"];

  it("say how much they cut", () => {
    expect(clipLines(lines, 3)).toEqual(["1", "2", "… 4 more lines"]);
    expect(clipLines(lines, 6)).toEqual(lines);
    expect(headAndTail(lines, 4)).toEqual(["1", "2", "… 3 lines hidden …", "6"]);
    expect(headAndTail(lines, 6)).toEqual(lines);
  });

  it("keep the last line whenever there's one line of room", () => {
    expect(headAndTail(lines, 1)).toEqual(["6"]);
    expect(headAndTail(lines, 2)).toEqual(["1", "6"]);
    expect(headAndTail(lines, 0)).toEqual([]);
  });
});

describe("hintRows and lastItems", () => {
  it("count whole hints per row and keep the newest items", () => {
    expect(hintRows(["aaaa", "bbbb"], 13)).toBe(1);
    expect(hintRows(["aaaa", "bbbb"], 12)).toBe(2);
    expect(hintRows(["漢字", "漢字"], 12)).toBe(2);
    expect(lastItems([1, 2, 3, 4, 5], 3)).toEqual({ shown: [3, 4, 5], hidden: 2 });
  });
});

describe("listWindow", () => {
  it("keeps the cursor in view with cues for what's above and below", () => {
    expect(listWindow(12, 9, 20)).toEqual({ first: 0, count: 12, above: 0, below: 0 });
    expect(listWindow(12, 9, 4)).toEqual({ first: 8, count: 2, above: 8, below: 2 });
    expect(listWindow(12, 0, 4)).toEqual({ first: 0, count: 3, above: 0, below: 9 });
  });

  it("keeps the cursor's item last, with one cue if there's a row for it", () => {
    expect(listWindow(12, 9, 2)).toEqual({ first: 9, count: 1, above: 9, below: 0 });
    expect(listWindow(12, 9, 1)).toEqual({ first: 9, count: 1, above: 0, below: 0 });
  });
});

describe("planLayout", () => {
  const input: LayoutInput = {
    height: 24,
    footerRows: 2,
    composerLines: 8,
    queue: { length: 10, window: 3, hintLines: 1 },
    messages: [],
    request: { natural: 30, min: 4 },
    picker: null,
  };
  /** Every row the plan hands out; it should be the whole height. */
  const used = (plan: ReturnType<typeof planLayout>, queued = 10) =>
    (plan.header ? 1 : 0) +
    plan.transcriptRows +
    (plan.queueFolded || queued === 0
      ? 0
      : (plan.queueShown < 10 ? 1 : 0) + plan.queueShown + (plan.queueHint ? 1 : 0)) +
    plan.messageLines.reduce((sum, lines) => sum + lines, 0) +
    2 +
    plan.composerLines +
    (plan.footerFolded ? 1 : 2) +
    plan.requestRows;

  it("gives a panel the rows left over, and shrinks nothing it doesn't need to", () => {
    const plan = planLayout(input);
    expect(plan).toMatchObject({
      queueShown: 3,
      composerLines: 8,
      header: true,
      transcriptLine: true,
    });
    expect(plan.requestRows).toBe(24 - 1 - 1 - 5 - 10 - 2);
    expect(used(plan)).toBe(24);
  });

  it("shrinks the queue, the composer, the transcript, the header, then the footer before the panel", () => {
    const plans = [14, 11, 10, 9, 8].map((height) => planLayout({ ...input, height }));
    expect(plans.map((plan) => plan.requestRows)).toEqual([4, 4, 4, 4, 4]);
    expect(plans.map(used)).toEqual([14, 11, 10, 9, 8]);
    expect(plans[0]).toMatchObject({ queueFolded: true, composerLines: 4, transcriptLine: true });
    expect(plans[1]).toMatchObject({ composerLines: 1, transcriptLine: true });
    expect(plans[2]).toMatchObject({ transcriptLine: false, header: true, footerFolded: false });
    expect(plans[3]).toMatchObject({ header: false, footerFolded: false });
    expect(plans[4]).toMatchObject({ header: false, footerFolded: true });
  });

  it("turns a request that can't keep its lines into one line, and leaves no row unused", () => {
    const plan = planLayout({ ...input, height: 6 });
    expect(plan).toMatchObject({ requestFits: false, requestRows: 1, header: false });
    expect(used(plan)).toBe(6);
  });

  it("cuts messages to a line each before the composer, and drops them before the panel", () => {
    const messages = { ...input, queue: { length: 0, window: 3, hintLines: 0 }, messages: [3, 3] };
    expect(planLayout(messages)).toMatchObject({ messageLines: [3, 3], requestRows: 4 });
    const tight = planLayout({ ...messages, height: 16 });
    expect(tight).toMatchObject({ messageLines: [1, 1], composerLines: 4, requestRows: 4 });
    const tightest = planLayout({ ...messages, height: 8 });
    expect(tightest).toMatchObject({ messageLines: [0, 0], requestFits: true, requestRows: 4 });
    expect([tight, tightest].map((plan) => used(plan, 0))).toEqual([16, 8]);
  });
});
