import { describe, expect, it } from "vite-plus/test";

import {
  anchoredScrollTop,
  isAtBottom,
  isNearBottom,
  PrependAnchorTracker,
  resolvePrependAnchor,
  resolveScrollKey,
  shouldLoadEarlier,
} from "./threadScroll.ts";

const idle = { hasMoreHistory: true, loading: false, error: null };

describe("isAtBottom", () => {
  it("is only true at the very bottom, unlike isNearBottom", () => {
    expect(isAtBottom({ scrollTop: 100, scrollHeight: 120, viewportHeight: 20 })).toBe(true);
    expect(isAtBottom({ scrollTop: 97, scrollHeight: 120, viewportHeight: 20 })).toBe(false);
    expect(isNearBottom({ scrollTop: 97, scrollHeight: 120, viewportHeight: 20 })).toBe(true);
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 10, viewportHeight: 20 })).toBe(true);
  });
});

describe("isNearBottom", () => {
  it("counts the last few rows as the bottom", () => {
    expect(isNearBottom({ scrollTop: 96, scrollHeight: 120, viewportHeight: 20 })).toBe(true);
    expect(isNearBottom({ scrollTop: 90, scrollHeight: 120, viewportHeight: 20 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 10, viewportHeight: 20 })).toBe(true);
  });
});

describe("shouldLoadEarlier", () => {
  it("loads within a screen of the top while more history exists", () => {
    expect(
      shouldLoadEarlier({ scrollTop: 10, scrollHeight: 200, viewportHeight: 20 }, idle, false),
    ).toBe(true);
    expect(
      shouldLoadEarlier({ scrollTop: 40, scrollHeight: 200, viewportHeight: 20 }, idle, false),
    ).toBe(false);
  });

  it("fills a short window right away", () => {
    expect(
      shouldLoadEarlier({ scrollTop: 0, scrollHeight: 8, viewportHeight: 20 }, idle, false),
    ).toBe(true);
  });

  it("waits while a page loads and stops at the start of the thread", () => {
    const top = { scrollTop: 0, scrollHeight: 200, viewportHeight: 20 };
    expect(shouldLoadEarlier(top, { ...idle, loading: true }, true)).toBe(false);
    expect(shouldLoadEarlier(top, { ...idle, hasMoreHistory: false }, true)).toBe(false);
  });

  it("retries a failed page only when the user scrolls", () => {
    const top = { scrollTop: 0, scrollHeight: 200, viewportHeight: 20 };
    const failed = { ...idle, error: "timeout" };
    expect(shouldLoadEarlier(top, failed, false)).toBe(false);
    expect(shouldLoadEarlier(top, failed, true)).toBe(true);
  });
});

describe("resolveScrollKey", () => {
  it("maps lines, pages, half pages, and the ends", () => {
    expect(resolveScrollKey({ name: "up" }, 20)).toEqual({ kind: "by", rows: -1 });
    expect(resolveScrollKey({ name: "j" }, 20)).toEqual({ kind: "by", rows: 1 });
    expect(resolveScrollKey({ name: "pagedown" }, 20)).toEqual({ kind: "by", rows: 18 });
    expect(resolveScrollKey({ name: "pageup" }, 20)).toEqual({ kind: "by", rows: -18 });
    expect(resolveScrollKey({ name: "u", ctrl: true }, 20)).toEqual({ kind: "by", rows: -10 });
    expect(resolveScrollKey({ name: "home" }, 20)).toEqual({ kind: "top" });
    expect(resolveScrollKey({ name: "end" }, 20)).toEqual({ kind: "bottom" });
    expect(resolveScrollKey({ name: "g", shift: true }, 20)).toEqual({ kind: "bottom" });
  });

  it("leaves other keys alone", () => {
    expect(resolveScrollKey({ name: "q" }, 20)).toBeNull();
    expect(resolveScrollKey({ name: "c", ctrl: true }, 20)).toBeNull();
  });
});

describe("prepend anchoring", () => {
  it("finds the old first row when rows arrive above it", () => {
    expect(resolvePrependAnchor(["c", "d"], ["a", "b", "c", "d"])).toBe("c");
  });

  it("ignores appends, first renders, and replaced timelines", () => {
    expect(resolvePrependAnchor(["a"], ["a", "b"])).toBeNull();
    expect(resolvePrependAnchor([], ["a"])).toBeNull();
    expect(resolvePrependAnchor(["x"], ["a", "b"])).toBeNull();
  });

  it("moves the scroll position by how far the anchor moved", () => {
    expect(anchoredScrollTop(0, 2, 42)).toBe(40);
    expect(anchoredScrollTop(15, 30, 30)).toBe(15);
  });
});

describe("PrependAnchorTracker", () => {
  // Row tops as OpenTUI last laid them out.
  function layout(tops: Record<string, number>) {
    return (key: string) => tops[key] ?? null;
  }

  it("holds the reading position when a page lands above it", () => {
    const tracker = new PrependAnchorTracker();
    tracker.commit(["c", "d"], layout({ c: 2, d: 12 }), false);
    tracker.commit(["a", "b", "c", "d"], layout({ c: 2, d: 12 }), false);
    expect(tracker.consume(layout({ a: 0, b: 5, c: 12, d: 22 }), 5)).toBe(15);
    // Consumed: the next layout leaves the position alone.
    expect(tracker.consume(layout({ a: 0, b: 5, c: 12, d: 22 }), 15)).toBeNull();
  });

  it("keeps the anchor through a streaming commit before layout", () => {
    const tracker = new PrependAnchorTracker();
    const before = layout({ c: 2, d: 12 });
    tracker.commit(["c", "d"], before, false);
    tracker.commit(["a", "b", "c", "d"], before, false);
    // A delta to the last row commits before OpenTUI lays out the page.
    tracker.commit(["a", "b", "c", "d"], before, false);
    expect(tracker.consume(layout({ a: 0, b: 5, c: 12, d: 22 }), 5)).toBe(15);
  });

  it("measures two pages before one layout from the first anchor", () => {
    const tracker = new PrependAnchorTracker();
    const before = layout({ e: 2 });
    tracker.commit(["e"], before, false);
    tracker.commit(["c", "d", "e"], before, false);
    tracker.commit(["a", "b", "c", "d", "e"], before, false);
    expect(tracker.consume(layout({ a: 0, c: 10, e: 22 }), 5)).toBe(25);
  });

  it("leaves the bottom to sticky scroll and ignores appends", () => {
    const tracker = new PrependAnchorTracker();
    tracker.commit(["c"], layout({ c: 2 }), false);
    tracker.commit(["a", "c"], layout({ c: 2 }), true);
    expect(tracker.consume(layout({ a: 0, c: 12 }), 5)).toBeNull();
    tracker.commit(["a", "c", "d"], layout({ a: 0, c: 12 }), false);
    expect(tracker.consume(layout({ a: 0, c: 12, d: 20 }), 5)).toBeNull();
  });

  it("drops the anchor when its row goes away", () => {
    const tracker = new PrependAnchorTracker();
    tracker.commit(["c"], layout({ c: 2 }), false);
    tracker.commit(["a", "c"], layout({ c: 2 }), false);
    tracker.commit(["x"], layout({}), false);
    expect(tracker.consume(layout({ x: 0 }), 5)).toBeNull();
  });
});

describe("PrependAnchorTracker above the rows", () => {
  const layout = (tops: Record<string, number>) => (key: string) => tops[key] ?? null;

  it("anchors the first row when the history hint above it changes", () => {
    const tracker = new PrependAnchorTracker();
    tracker.commit(["a", "b"], layout({ a: 2, b: 10 }), false, "↑ Scroll up");
    // The last page landed in an earlier layout; now the hint above it goes away.
    tracker.commit(["a", "b"], layout({ a: 2, b: 10 }), false, "");
    expect(tracker.consume(layout({ a: 0, b: 8 }), 40)).toBe(38);
  });

  it("measures a page and the hint change together when both land before layout", () => {
    const tracker = new PrependAnchorTracker();
    tracker.commit(["c"], layout({ c: 2 }), false, "↑ Scroll up");
    tracker.commit(["a", "b", "c"], layout({ c: 2 }), false, "↑ Scroll up");
    tracker.commit(["a", "b", "c"], layout({ c: 2 }), false, "");
    expect(tracker.consume(layout({ a: 0, b: 6, c: 12 }), 0)).toBe(10);
  });
});
