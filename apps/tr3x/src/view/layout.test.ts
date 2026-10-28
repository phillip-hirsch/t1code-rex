import { describe, expect, it } from "vite-plus/test";

import { clipLines, headAndTail, hintRows, lastItems, wrapText } from "./layout.ts";

describe("wrapText", () => {
  it("wraps at words, keeps line breaks and indentation, and breaks long words", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapText("a\n  b c", 10)).toEqual(["a", "  b c"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
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
});

describe("hintRows and lastItems", () => {
  it("count whole hints per row and keep the newest items", () => {
    expect(hintRows(["aaaa", "bbbb"], 13)).toBe(1);
    expect(hintRows(["aaaa", "bbbb"], 12)).toBe(2);
    expect(lastItems([1, 2, 3, 4, 5], 3)).toEqual({ shown: [3, 4, 5], hidden: 2 });
  });
});
