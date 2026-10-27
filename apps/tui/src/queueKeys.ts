import { printableText, type SidebarKey } from "./sidebarKeys.ts";

export type QueueKeyAction =
  | { readonly type: "select"; readonly delta: -1 | 1 }
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "edit" | "send" | "remove" | "leave" | "save" | "cancel-edit" }
  | { readonly type: "type"; readonly text: string };

/** The queue list's keys, listed in its footer hints. */
export const QUEUE_KEY_HINTS =
  "↑↓ select  ⏎/e edit  s send  ⇧↑↓ move  x remove  esc back  type to compose";
export const QUEUE_EDIT_KEY_HINTS = "⏎ save  ⇧⏎ newline  esc cancel";

const ENTER = new Set(["return", "enter", "kpenter"]);

/**
 * A key while the queue list has focus. The transcript's keys (j/k/g/G) don't reach it, and
 * Tab and Ctrl+C stay the shell's. While a message is open in the editor, the textarea gets
 * every key but these.
 */
export function resolveQueueKey(key: SidebarKey, editing: boolean): QueueKeyAction | null {
  const plain = !key.ctrl && !key.meta && !key.super && !key.option;
  if (editing) {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return { type: "cancel-edit" };
    // Shift+Enter and Ctrl+J are the editor's newlines.
    return plain && !key.shift && ENTER.has(key.name) ? { type: "save" } : null;
  }
  if (key.name === "escape") return { type: "leave" };
  if (!plain) return null;
  switch (key.name) {
    case "up":
      return key.shift ? { type: "move", delta: -1 } : { type: "select", delta: -1 };
    case "down":
      return key.shift ? { type: "move", delta: 1 } : { type: "select", delta: 1 };
    case "k":
      return key.shift ? { type: "move", delta: -1 } : { type: "select", delta: -1 };
    case "j":
      return key.shift ? { type: "move", delta: 1 } : { type: "select", delta: 1 };
    case "e":
      return key.shift ? typed(key) : { type: "edit" };
    case "s":
      return key.shift ? typed(key) : { type: "send" };
    case "x":
    case "delete":
    case "backspace":
      return key.shift && key.name === "x" ? typed(key) : { type: "remove" };
    case "tab":
      return null;
    default:
      if (ENTER.has(key.name) && !key.shift) return { type: "edit" };
      return typed(key);
  }
}

function typed(key: SidebarKey): QueueKeyAction | null {
  const text = printableText(key);
  return text === null ? null : { type: "type", text };
}
