// @effect-diagnostics globalDate:off -- The TUI runs on Bun outside the Effect runtime.
/**
 * What a key does while the composer has focus. Keys this returns null for go to the
 * textarea, which edits text as usual (Shift+Enter or Ctrl+J for a newline).
 */

export interface ComposerKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
  /** A held key's repeat (kitty keyboard protocol). */
  readonly repeated?: boolean;
}

export interface ComposerKeyState {
  readonly hasText: boolean;
  readonly attachmentCount: number;
  /** The thread has a run in progress that Esc or Ctrl+C can stop. */
  readonly running: boolean;
  /** Stop was already sent for this run, so another Ctrl+C quits instead. */
  readonly stopRequested: boolean;
  readonly slashMenuOpen: boolean;
  /** Enter on the open slash menu completes the highlighted command instead of sending. */
  readonly slashMenuCompletes: boolean;
  /** Backspace on an empty composer was pressed once and now removes an image. */
  readonly removeArmed: boolean;
  /** The `@` file menu shows: searching, empty, or listing entries. Esc closes it. */
  readonly mentionActive?: boolean;
  /** The `@` file menu lists entries to pick. */
  readonly mentionMenuOpen?: boolean;
}

export type ComposerKeyAction =
  | { readonly type: "submit"; readonly alternate: boolean }
  | { readonly type: "stop" }
  | { readonly type: "clear" }
  | { readonly type: "exit" }
  | { readonly type: "ignore" }
  | { readonly type: "paste-image" }
  | { readonly type: "arm-remove-attachment" }
  | { readonly type: "remove-attachment" }
  | { readonly type: "slash-move"; readonly delta: -1 | 1 }
  | { readonly type: "slash-complete" }
  | { readonly type: "mention-move"; readonly delta: -1 | 1 }
  | { readonly type: "mention-pick" }
  | { readonly type: "mention-dismiss" };

export function isEnterKey(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter";
}

export function resolveComposerKey(
  key: ComposerKey,
  state: ComposerKeyState,
): ComposerKeyAction | null {
  const { name } = key;
  // Holding Ctrl+C or Esc must not clear, then stop, then quit: each takes a fresh press.
  if (key.repeated && ((key.ctrl && name === "c") || name === "escape")) return { type: "ignore" };
  if (key.ctrl && name === "c") {
    if (state.hasText || state.attachmentCount > 0) return { type: "clear" };
    if (state.running && !state.stopRequested) return { type: "stop" };
    return { type: "exit" };
  }
  // Esc closes the menu while it shows at all, so it never stops the run behind it.
  if ((state.mentionActive || state.mentionMenuOpen) && name === "escape") {
    return { type: "mention-dismiss" };
  }
  if (state.mentionMenuOpen) {
    if (name === "up" || (key.ctrl && name === "k")) return { type: "mention-move", delta: -1 };
    if (name === "down" || (key.ctrl && name === "j")) return { type: "mention-move", delta: 1 };
    if (name === "tab" || (isEnterKey(name) && !key.shift)) return { type: "mention-pick" };
  }
  if (state.slashMenuOpen) {
    if (name === "up" || (key.ctrl && name === "k")) return { type: "slash-move", delta: -1 };
    if (name === "down" || (key.ctrl && name === "j")) return { type: "slash-move", delta: 1 };
    if (name === "tab") return { type: "slash-complete" };
    if (isEnterKey(name) && !key.shift && state.slashMenuCompletes) {
      return { type: "slash-complete" };
    }
  }
  // Upstream's alternate send is Cmd/Ctrl+Enter; Alt+Enter also works, since many
  // terminals only report Cmd or Ctrl with Enter under the kitty keyboard protocol.
  if (isEnterKey(name) && !key.shift) {
    return {
      type: "submit",
      alternate: Boolean(key.meta || key.option || key.super || key.ctrl),
    };
  }
  if (name === "escape") return state.running && !state.stopRequested ? { type: "stop" } : null;
  if (key.ctrl && name === "y") return { type: "paste-image" };
  if ((name === "backspace" || name === "delete") && !state.hasText && state.attachmentCount > 0) {
    return state.removeArmed ? { type: "remove-attachment" } : { type: "arm-remove-attachment" };
  }
  return null;
}

/** How long the composer must sit empty, after a send or taking focus, before Enter stops a run. */
export const ENTER_STOP_QUIET_MS = 750;

/**
 * Enter on an empty composer stops a busy run, but never as the echo of an Enter that sent
 * or focused the composer: those arm the guard, and an Enter within ENTER_STOP_QUIET_MS
 * re-arms it instead. It reads the clock, not render state, so batching can't defeat it.
 */
export function createEnterStopGuard(now: () => number = Date.now) {
  let armedAt = Number.NEGATIVE_INFINITY;
  return {
    /** A send went out, or the composer took focus. */
    arm(): void {
      armedAt = now();
    },
    /** For Enter on the empty composer: whether it may stop the run. */
    pressEmptyEnter(): boolean {
      const at = now();
      if (at - armedAt >= ENTER_STOP_QUIET_MS) return true;
      armedAt = at;
      return false;
    },
  };
}

export type EnterStopGuard = ReturnType<typeof createEnterStopGuard>;
