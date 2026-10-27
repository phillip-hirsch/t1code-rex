import { describe, expect, it } from "vite-plus/test";

import {
  createEnterStopGuard,
  ENTER_STOP_QUIET_MS,
  resolveComposerKey,
  type ComposerKeyState,
} from "./composerKeys.ts";

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

  // Round 3, N4: a held Ctrl+C or Esc must not clear, then stop, then quit.
  it("ignores a held Ctrl+C's or Esc's repeats", () => {
    for (const name of ["c", "escape"]) {
      const held = { name, ctrl: name === "c", repeated: true };
      for (const state of [
        { ...idle, hasText: true, running: true },
        { ...idle, running: true },
        { ...idle, running: true, stopRequested: true },
        idle,
      ]) {
        expect(resolveComposerKey(held, state)).toEqual({ type: "ignore" });
      }
    }
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

describe("resolveComposerKey with the @ file menu", () => {
  const open = { ...idle, hasText: true, mentionMenuOpen: true };

  it("moves, picks with Tab or Enter, and closes with Esc instead of sending or stopping", () => {
    expect(resolveComposerKey({ name: "down" }, open)).toEqual({ type: "mention-move", delta: 1 });
    expect(resolveComposerKey({ name: "tab" }, open)).toEqual({ type: "mention-pick" });
    expect(resolveComposerKey({ name: "return" }, open)).toEqual({ type: "mention-pick" });
    expect(resolveComposerKey({ name: "escape" }, { ...open, running: true })).toEqual({
      type: "mention-dismiss",
    });
    // Shift+Enter still adds a newline.
    expect(resolveComposerKey({ name: "return", shift: true }, open)).toBeNull();
  });

  it("S2: Esc closes a menu that's still searching or found nothing, without stopping the run", () => {
    const searching = { ...idle, hasText: true, running: true, mentionActive: true };
    expect(resolveComposerKey({ name: "escape" }, searching)).toEqual({ type: "mention-dismiss" });
    // With nothing to pick, Enter sends and arrows edit as usual.
    expect(resolveComposerKey({ name: "return" }, searching)).toEqual({
      type: "submit",
      alternate: false,
    });
    expect(resolveComposerKey({ name: "down" }, searching)).toBeNull();
    // A held Esc's repeats still do nothing.
    expect(resolveComposerKey({ name: "escape", repeated: true }, searching)).toEqual({
      type: "ignore",
    });
  });
});

describe("createEnterStopGuard", () => {
  it("lets Enter stop only once the composer sat empty after a send or taking focus", () => {
    let clock = 10_000;
    const guard = createEnterStopGuard(() => clock);
    expect(guard.pressEmptyEnter()).toBe(true);

    guard.arm();
    // The second Enter of one input chunk, then quick presses: each re-arms the wait.
    expect(guard.pressEmptyEnter()).toBe(false);
    clock += ENTER_STOP_QUIET_MS - 1;
    expect(guard.pressEmptyEnter()).toBe(false);
    clock += ENTER_STOP_QUIET_MS - 1;
    expect(guard.pressEmptyEnter()).toBe(false);

    clock += ENTER_STOP_QUIET_MS;
    expect(guard.pressEmptyEnter()).toBe(true);
  });
});
