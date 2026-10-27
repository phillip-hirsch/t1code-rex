import { US_SHIFTED_TO_UNSHIFTED_KEYS } from "@t3tools/shared/keybindings";

import type { TerminalEmulator, TerminalKeyboardEvent } from "./terminalEmulator.ts";

/** The OpenTUI key fields the terminal reads (KeyEvent has them all). */
export interface TerminalKeyLike {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  /** Alt: an ESC-prefixed key, or kitty's alt or meta. */
  readonly meta: boolean;
  readonly shift: boolean;
  /** Cmd on macOS; only kitty-protocol terminals report it. */
  readonly super?: boolean | undefined;
  readonly eventType?: "press" | "repeat" | "release" | undefined;
  readonly repeated?: boolean | undefined;
  readonly capsLock?: boolean | undefined;
  readonly numLock?: boolean | undefined;
}

/** OpenTUI key names for keys that aren't text, as DOM `key` and `code`. */
const NAMED_KEYS: Readonly<Record<string, readonly [key: string, code: string]>> = {
  return: ["Enter", "Enter"],
  enter: ["Enter", "Enter"],
  kpenter: ["Enter", "NumpadEnter"],
  tab: ["Tab", "Tab"],
  backspace: ["Backspace", "Backspace"],
  escape: ["Escape", "Escape"],
  space: [" ", "Space"],
  " ": [" ", "Space"],
  insert: ["Insert", "Insert"],
  delete: ["Delete", "Delete"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PageUp", "PageUp"],
  pagedown: ["PageDown", "PageDown"],
  up: ["ArrowUp", "ArrowUp"],
  down: ["ArrowDown", "ArrowDown"],
  left: ["ArrowLeft", "ArrowLeft"],
  right: ["ArrowRight", "ArrowRight"],
  kpup: ["ArrowUp", "ArrowUp"],
  kpdown: ["ArrowDown", "ArrowDown"],
  kpleft: ["ArrowLeft", "ArrowLeft"],
  kpright: ["ArrowRight", "ArrowRight"],
  kphome: ["Home", "Home"],
  kpend: ["End", "End"],
  kppageup: ["PageUp", "PageUp"],
  kppagedown: ["PageDown", "PageDown"],
  kpinsert: ["Insert", "Insert"],
  kpdelete: ["Delete", "Delete"],
  kpdecimal: [".", "NumpadDecimal"],
  kpdivide: ["/", "NumpadDivide"],
  kpmultiply: ["*", "NumpadMultiply"],
  kpminus: ["-", "NumpadSubtract"],
  kpplus: ["+", "NumpadAdd"],
  kpequal: ["=", "NumpadEqual"],
  kpseparator: [",", "NumpadComma"],
};

/** US-layout physical codes for the unshifted punctuation keys. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};

/** Text a key types: one printable character, or a burst such as an emoji or IME commit. */
function printableText(sequence: string): string | null {
  if (sequence.length === 0) return null;
  // C0 controls, DEL and an ESC-led sequence are not text.
  if (/[\u0000-\u001f\u007f]/u.test(sequence)) return null;
  return sequence;
}

function physicalCode(base: string): string {
  if (/^[a-z]$/u.test(base)) return `Key${base.toUpperCase()}`;
  if (/^[0-9]$/u.test(base)) return `Digit${base}`;
  return PUNCTUATION_CODES[base] ?? "";
}

function keyboardEvent(
  key: TerminalKeyLike,
  domKey: string,
  code: string,
  shift: boolean,
): TerminalKeyboardEvent {
  const capsLock = key.capsLock === true;
  const numLock = key.numLock === true;
  return {
    key: domKey,
    code,
    shiftKey: shift,
    ctrlKey: key.ctrl,
    altKey: key.meta,
    metaKey: key.super === true,
    repeat: key.repeated === true || key.eventType === "repeat",
    isComposing: false,
    getModifierState: (name) => (name === "CapsLock" ? capsLock : name === "NumLock" && numLock),
  };
}

/**
 * The DOM-shaped key event web's Ghostty encoder takes, for an OpenTUI key press.
 * Null for releases, which the drawer doesn't report.
 */
export function terminalKeyboardEvent(key: TerminalKeyLike): TerminalKeyboardEvent | null {
  if (key.eventType === "release") return null;
  const named = NAMED_KEYS[key.name];
  if (named) return keyboardEvent(key, named[0], named[1], key.shift);
  // A legacy Ctrl+J arrives as a bare line feed.
  if (key.name === "linefeed") return keyboardEvent({ ...key, ctrl: true }, "j", "KeyJ", false);
  const fn = /^f([1-9]|1[0-9]|2[0-5])$/u.exec(key.name);
  if (fn) return keyboardEvent(key, `F${fn[1]}`, `F${fn[1]}`, key.shift);
  const keypad = /^kp([0-9])$/u.exec(key.name);
  if (keypad) return keyboardEvent(key, keypad[1] ?? "0", `Numpad${keypad[1]}`, key.shift);

  const text = printableText(key.sequence);
  const name = [...key.name].length === 1 ? key.name : null;
  // A shifted symbol may arrive as itself ("!") or as its key with Shift ("1").
  const unshifted = name === null ? null : (US_SHIFTED_TO_UNSHIFTED_KEYS.get(name) ?? null);
  const base = unshifted ?? (name === null ? null : name.toLowerCase());
  if (base !== null) {
    const shift = key.shift || unshifted !== null || (name !== null && name !== base);
    const typed =
      text !== null && [...text].length === 1
        ? text
        : shift && unshifted === null
          ? base.toUpperCase()
          : (name ?? base);
    return keyboardEvent(key, typed, physicalCode(base), shift);
  }
  if (text !== null) return keyboardEvent(key, text, "", key.shift);
  return null;
}

/**
 * The bytes a key press sends to the PTY, as the terminal's current modes want them
 * (application cursor keys, the kitty keyboard protocol, …). Empty when it sends nothing.
 */
export function encodeTerminalKey(
  emulator: Pick<TerminalEmulator, "encodeKey">,
  key: TerminalKeyLike,
): string {
  const event = terminalKeyboardEvent(key);
  if (event === null) return "";
  const encoded = emulator.encodeKey(event);
  if (encoded.length > 0) return encoded;
  // The encoder takes one UTF-16 unit of text; an emoji or IME commit goes as typed.
  const text = printableText(key.sequence);
  return text !== null && !key.ctrl && !key.meta && key.super !== true ? text : "";
}

export type TerminalDrawerKeyAction =
  /**
   * Ctrl+] (telnet's escape key): focus moves on to the next pane, as Tab does
   * elsewhere, since the shell keeps Tab. The drawer stays open.
   */
  | { readonly type: "leave" }
  /** Ctrl+Shift+↑/↓: grow or shrink the drawer. */
  | { readonly type: "resize"; readonly delta: 1 | -1 }
  /** Ctrl+Shift+←/→: the previous or next terminal. */
  | { readonly type: "cycle"; readonly delta: 1 | -1 }
  /** Shift+PgUp/PgDn/Home/End: scroll the scrollback. */
  | { readonly type: "scroll"; readonly to: "pageUp" | "pageDown" | "top" | "bottom" };

/** Keys the drawer keeps for itself instead of sending them to the PTY. */
export function resolveTerminalDrawerKey(key: TerminalKeyLike): TerminalDrawerKeyAction | null {
  if (key.eventType === "release") return null;
  if (key.ctrl && !key.shift && !key.meta && key.name === "]") return { type: "leave" };
  if (key.ctrl && key.shift && !key.meta) {
    if (key.name === "up") return { type: "resize", delta: 1 };
    if (key.name === "down") return { type: "resize", delta: -1 };
    if (key.name === "left") return { type: "cycle", delta: -1 };
    if (key.name === "right") return { type: "cycle", delta: 1 };
  }
  if (key.shift && !key.ctrl && !key.meta) {
    if (key.name === "pageup") return { type: "scroll", to: "pageUp" };
    if (key.name === "pagedown") return { type: "scroll", to: "pageDown" };
    if (key.name === "home") return { type: "scroll", to: "top" };
    if (key.name === "end") return { type: "scroll", to: "bottom" };
  }
  return null;
}
