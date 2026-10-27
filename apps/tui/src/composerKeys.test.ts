import { describe, expect, it } from "vite-plus/test";

import { resolveComposerKey, type ComposerKeyState } from "./composerKeys.ts";

const idle: ComposerKeyState = {
  hasText: false,
  attachmentCount: 0,
  running: false,
  stopRequested: false,
  slashMenuOpen: false,
  slashMenuCompletes: false,
  removeArmed: false,
};

describe("resolveComposerKey", () => {
  it("sends on Enter, uses the alternate send on Cmd/Ctrl/Alt+Enter, and leaves Shift+Enter to the textarea", () => {
    expect(resolveComposerKey({ name: "return" }, { ...idle, hasText: true })).toEqual({
      type: "submit",
      alternate: false,
    });
    expect(resolveComposerKey({ name: "return", meta: true }, idle)).toEqual({
      type: "submit",
      alternate: true,
    });
    // Upstream's alternate is mod+Enter: Cmd on macOS (super under kitty), Ctrl elsewhere.
    for (const modifier of [{ super: true }, { ctrl: true }, { option: true }]) {
      expect(resolveComposerKey({ name: "return", ...modifier }, idle)).toEqual({
        type: "submit",
        alternate: true,
      });
    }
    expect(resolveComposerKey({ name: "return", shift: true }, idle)).toBeNull();
    // Ctrl+J still adds a newline.
    expect(resolveComposerKey({ name: "linefeed" }, idle)).toBeNull();
  });

  it("clears text first, then stops a run, then quits on Ctrl+C", () => {
    const ctrlC = { name: "c", ctrl: true };
    expect(resolveComposerKey(ctrlC, { ...idle, hasText: true, running: true })).toEqual({
      type: "clear",
    });
    expect(resolveComposerKey(ctrlC, { ...idle, attachmentCount: 1 })).toEqual({ type: "clear" });
    expect(resolveComposerKey(ctrlC, { ...idle, running: true })).toEqual({ type: "stop" });
    // A second Ctrl+C after Stop quits, so quitting never gets stuck behind a slow stop.
    expect(resolveComposerKey(ctrlC, { ...idle, running: true, stopRequested: true })).toEqual({
      type: "exit",
    });
    expect(resolveComposerKey(ctrlC, idle)).toEqual({ type: "exit" });
  });

  it("stops a running turn on Esc and otherwise leaves Esc alone", () => {
    expect(resolveComposerKey({ name: "escape" }, { ...idle, running: true })).toEqual({
      type: "stop",
    });
    expect(resolveComposerKey({ name: "escape" }, idle)).toBeNull();
    expect(
      resolveComposerKey({ name: "escape" }, { ...idle, running: true, stopRequested: true }),
    ).toBeNull();
  });

  it("drives the slash menu while it is open", () => {
    const menu = { ...idle, hasText: true, slashMenuOpen: true };
    expect(resolveComposerKey({ name: "down" }, menu)).toEqual({ type: "slash-move", delta: 1 });
    expect(resolveComposerKey({ name: "k", ctrl: true }, menu)).toEqual({
      type: "slash-move",
      delta: -1,
    });
    expect(resolveComposerKey({ name: "tab" }, menu)).toEqual({ type: "slash-complete" });
    expect(resolveComposerKey({ name: "return" }, { ...menu, slashMenuCompletes: true })).toEqual({
      type: "slash-complete",
    });
    // A complete command runs on Enter instead of completing again.
    expect(resolveComposerKey({ name: "return" }, menu)).toEqual({
      type: "submit",
      alternate: false,
    });
    expect(resolveComposerKey({ name: "down" }, idle)).toBeNull();
  });

  it("removes the last image on a second backspace in an empty composer", () => {
    const withImage = { ...idle, attachmentCount: 2 };
    expect(resolveComposerKey({ name: "backspace" }, withImage)).toEqual({
      type: "arm-remove-attachment",
    });
    expect(resolveComposerKey({ name: "backspace" }, { ...withImage, removeArmed: true })).toEqual({
      type: "remove-attachment",
    });
    expect(resolveComposerKey({ name: "backspace" }, { ...withImage, hasText: true })).toBeNull();
  });

  it("pastes a clipboard image on Ctrl+Y", () => {
    expect(resolveComposerKey({ name: "y", ctrl: true }, idle)).toEqual({ type: "paste-image" });
  });
});
