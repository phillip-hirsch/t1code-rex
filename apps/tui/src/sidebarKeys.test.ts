import { describe, expect, it } from "vite-plus/test";

import { printableText, resolveSidebarKey } from "./sidebarKeys.ts";

const none = { hasMultiSelection: false };

function typed(text: string) {
  return [...text].map((char) =>
    resolveSidebarKey(
      {
        name: char === " " ? "space" : char.toLowerCase(),
        sequence: char,
        shift: char !== char.toLowerCase(),
      },
      none,
    ),
  );
}

describe("resolveSidebarKey", () => {
  it("turns every printable key into typing, so text can't trigger app actions", () => {
    // The keys that used to quit (q), reconnect (r), open the menu (m), or switch threads.
    for (const action of typed("quit my work, Jake! 1 2 3 hjkl m q r ?/.")) {
      expect(action?.type).toBe("type");
    }
    expect(resolveSidebarKey({ name: "q", sequence: "q" }, none)).toEqual({
      type: "type",
      text: "q",
    });
  });

  it("keeps arrows, Enter, Home/End, F2, Shift+F10 and Delete as sidebar keys", () => {
    expect(resolveSidebarKey({ name: "down" }, none)).toEqual({ type: "move", delta: 1 });
    expect(resolveSidebarKey({ name: "up", shift: true }, none)).toEqual({
      type: "extend-selection",
      delta: -1,
    });
    expect(resolveSidebarKey({ name: "left" }, none)).toEqual({ type: "fold", direction: "left" });
    expect(resolveSidebarKey({ name: "return", sequence: "\r" }, none)).toEqual({ type: "open" });
    expect(resolveSidebarKey({ name: "end" }, none)).toEqual({ type: "edge", edge: "end" });
    expect(resolveSidebarKey({ name: "f2" }, none)).toEqual({ type: "rename" });
    expect(resolveSidebarKey({ name: "f10", shift: true }, none)).toEqual({ type: "menu" });
    expect(resolveSidebarKey({ name: "f10" }, none)).toBeNull();
    expect(resolveSidebarKey({ name: "delete" }, none)).toEqual({ type: "delete" });
    expect(resolveSidebarKey({ name: "backspace", sequence: "\x7f" }, none)).toEqual({
      type: "delete",
    });
  });

  it("leaves modified keys to the app's shortcuts", () => {
    expect(resolveSidebarKey({ name: "n", sequence: "n", super: true }, none)).toBeNull();
    expect(resolveSidebarKey({ name: "k", sequence: "\x0b", ctrl: true }, none)).toBeNull();
    expect(resolveSidebarKey({ name: "up", ctrl: true }, none)).toBeNull();
  });

  it("uses Esc only to clear a multi-selection", () => {
    expect(resolveSidebarKey({ name: "escape", sequence: "\x1b" }, none)).toBeNull();
    expect(
      resolveSidebarKey({ name: "escape", sequence: "\x1b" }, { hasMultiSelection: true }),
    ).toEqual({ type: "clear-selection" });
  });
});

describe("printableText", () => {
  it("rejects control sequences and modified keys", () => {
    expect(printableText({ name: "tab", sequence: "\t" })).toBeNull();
    expect(printableText({ name: "escape", sequence: "\x1b[A" })).toBeNull();
    expect(printableText({ name: "a", sequence: "a", option: true })).toBeNull();
    expect(printableText({ name: "é", sequence: "é" })).toBe("é");
  });
});
