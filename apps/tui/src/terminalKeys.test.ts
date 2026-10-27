import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalDrawerKey,
  terminalKeyboardEvent,
  type TerminalKeyLike,
} from "./terminalKeys.ts";

function key(overrides: Partial<TerminalKeyLike> & Pick<TerminalKeyLike, "name">): TerminalKeyLike {
  return {
    sequence: overrides.name,
    ctrl: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}

function domKey(input: TerminalKeyLike) {
  const event = terminalKeyboardEvent(input);
  return event === null
    ? null
    : {
        key: event.key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      };
}

describe("terminalKeyboardEvent", () => {
  it("maps named keys to DOM keys and physical codes", () => {
    expect(domKey(key({ name: "return", sequence: "\r" }))).toMatchObject({
      key: "Enter",
      code: "Enter",
    });
    expect(domKey(key({ name: "tab", sequence: "\u001b[Z", shift: true }))).toMatchObject({
      key: "Tab",
      shift: true,
    });
    expect(domKey(key({ name: "up", sequence: "\u001b[A" }))?.code).toBe("ArrowUp");
    expect(domKey(key({ name: "f12", sequence: "\u001b[24~" }))?.code).toBe("F12");
    expect(domKey(key({ name: "kp7", sequence: "7" }))?.code).toBe("Numpad7");
    // Legacy terminals send Ctrl+J as a bare line feed.
    expect(domKey(key({ name: "linefeed", sequence: "\n" }))).toMatchObject({
      key: "j",
      ctrl: true,
    });
  });

  it("keeps letters' case and Ctrl and Alt chords", () => {
    expect(domKey(key({ name: "a" }))).toMatchObject({ key: "a", code: "KeyA", shift: false });
    expect(domKey(key({ name: "a", sequence: "A", shift: true }))).toMatchObject({
      key: "A",
      code: "KeyA",
      shift: true,
    });
    expect(domKey(key({ name: "c", sequence: "\u0003", ctrl: true }))).toMatchObject({
      key: "c",
      code: "KeyC",
      ctrl: true,
    });
    expect(domKey(key({ name: "b", sequence: "\u001bb", meta: true }))).toMatchObject({
      key: "b",
      alt: true,
      meta: false,
    });
    expect(domKey(key({ name: "k", sequence: "k", super: true }))).toMatchObject({ meta: true });
  });

  it("finds the US key under a shifted symbol, however the terminal reports it", () => {
    // Legacy: the symbol itself. Kitty: the key with Shift and the symbol as text.
    expect(domKey(key({ name: "!" }))).toMatchObject({ key: "!", code: "Digit1", shift: true });
    expect(domKey(key({ name: "1", sequence: "!", shift: true }))).toMatchObject({
      key: "!",
      code: "Digit1",
      shift: true,
    });
    expect(domKey(key({ name: "]", sequence: "\u001d", ctrl: true }))).toMatchObject({
      key: "]",
      code: "BracketRight",
      ctrl: true,
    });
  });

  it("passes other text through with no physical key", () => {
    expect(domKey(key({ name: "é" }))).toMatchObject({ key: "é", code: "" });
    expect(domKey(key({ name: "🙂" }))).toMatchObject({ key: "🙂", code: "" });
    expect(domKey(key({ name: "", sequence: "日本" }))).toMatchObject({ key: "日本", code: "" });
  });

  it("ignores releases and keys that type nothing", () => {
    expect(terminalKeyboardEvent(key({ name: "a", eventType: "release" }))).toBeNull();
    expect(terminalKeyboardEvent(key({ name: "leftshift", sequence: "\u001b[57441u" }))).toBeNull();
  });

  it("reports repeats and lock keys the way the encoder asks for them", () => {
    const event = terminalKeyboardEvent(key({ name: "x", repeated: true, capsLock: true }));
    expect(event?.repeat).toBe(true);
    expect(event?.getModifierState("CapsLock")).toBe(true);
    expect(event?.getModifierState("NumLock")).toBe(false);
  });
});

describe("resolveTerminalDrawerKey", () => {
  it("keeps Ctrl+] to leave the terminal", () => {
    expect(resolveTerminalDrawerKey(key({ name: "]", sequence: "\u001d", ctrl: true }))).toEqual({
      type: "leave",
    });
  });

  it("keeps Ctrl+Shift arrows to size the drawer and switch terminals", () => {
    expect(resolveTerminalDrawerKey(key({ name: "up", ctrl: true, shift: true }))).toEqual({
      type: "resize",
      delta: 1,
    });
    expect(resolveTerminalDrawerKey(key({ name: "right", ctrl: true, shift: true }))).toEqual({
      type: "cycle",
      delta: 1,
    });
  });

  it("keeps Shift+PgUp and friends to scroll the scrollback", () => {
    expect(resolveTerminalDrawerKey(key({ name: "pageup", shift: true }))).toEqual({
      type: "scroll",
      to: "pageUp",
    });
    expect(resolveTerminalDrawerKey(key({ name: "end", shift: true }))).toEqual({
      type: "scroll",
      to: "bottom",
    });
  });

  it("leaves the shell everything else, Ctrl+C, Escape and plain arrows included", () => {
    for (const input of [
      key({ name: "c", sequence: "\u0003", ctrl: true }),
      key({ name: "escape", sequence: "\u001b" }),
      key({ name: "up", ctrl: true }),
      key({ name: "pageup" }),
      key({ name: "]" }),
    ]) {
      expect(resolveTerminalDrawerKey(input)).toBeNull();
    }
  });
});
