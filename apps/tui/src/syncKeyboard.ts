import type { KeyEvent, PasteEvent } from "@opentui/core";
import { flushSync, useKeyboard, usePaste } from "@opentui/react";

/**
 * Runs an input handler inside `flushSync`, so its state updates render, and the hook's
 * handler ref refreshes, before the next event of the same input chunk is handled. One
 * chunk can hold several keys (a burst of arrows, Ctrl+K then Down, Down then Enter) or a
 * bracketed paste and then Enter; without this they would all read the last render's state.
 */
function synced<Event>(handler: (event: Event) => void): (event: Event) => void {
  return (event) => flushSync(() => handler(event));
}

/** `useKeyboard`, but each key's state updates render before the next key is handled. */
export function useSyncKeyboard(handler: (key: KeyEvent) => void): void {
  useKeyboard(synced(handler));
}

/** `usePaste`, but a paste's state updates (focus moving to the composer) render first. */
export function useSyncPaste(handler: (event: PasteEvent) => void): void {
  usePaste(synced(handler));
}
