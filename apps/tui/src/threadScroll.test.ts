import { describe, expect, it } from "vite-plus/test";

import {
  anchoredScrollTop,
  isNearBottom,
  resolvePrependAnchor,
  resolveScrollKey,
  shouldLoadEarlier,
} from "./threadScroll.ts";

const idle = { hasMoreHistory: true, loading: false, error: null };

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
