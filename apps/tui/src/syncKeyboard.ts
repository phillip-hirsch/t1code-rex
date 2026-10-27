import type { KeyEvent } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";

/**
 * `useKeyboard`, but each key's state updates render before the next key is handled. One
 * input chunk can hold several keys (a burst of arrows, Ctrl+K then Down, Down then Enter),
 * and without this they would all read the state of the last render.
 */
export function useSyncKeyboard(handler: (key: KeyEvent) => void): void {
  useKeyboard((key) => flushSync(() => handler(key)));
}
