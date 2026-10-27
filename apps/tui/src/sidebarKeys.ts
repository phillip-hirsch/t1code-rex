/**
 * Keys while the sidebar has focus. No printable key is a shortcut: each one moves focus to
 * the composer and types there, so text typed into the wrong pane can't act on the app.
 */

export interface SidebarKey {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly option?: boolean;
  readonly shift?: boolean;
}

export type SidebarKeyAction =
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "extend-selection"; readonly delta: -1 | 1 }
  | { readonly type: "edge"; readonly edge: "start" | "end" }
  | { readonly type: "fold"; readonly direction: "left" | "right" }
  | { readonly type: "open" }
  | { readonly type: "menu" }
  | { readonly type: "rename" }
  | { readonly type: "delete" }
  | { readonly type: "clear-selection" }
  | { readonly type: "type"; readonly text: string };

function isEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed";
}

/** The text a key types, or null for control keys and modified keys. */
export function printableText(key: SidebarKey): string | null {
  if (key.ctrl || key.meta || key.super || key.option) return null;
  const text = key.sequence ?? "";
  if (text.length === 0) return null;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return text;
}

export function resolveSidebarKey(
  key: SidebarKey,
  state: { readonly hasMultiSelection: boolean },
): SidebarKeyAction | null {
  const { name } = key;
  const modified = Boolean(key.ctrl || key.meta || key.super || key.option);
  if ((name === "up" || name === "down") && !modified) {
    const delta = name === "up" ? -1 : 1;
    return key.shift ? { type: "extend-selection", delta } : { type: "move", delta };
  }
  if (modified) return null;
  if (name === "home" || name === "end") {
    return { type: "edge", edge: name === "home" ? "start" : "end" };
  }
  if (name === "left" || name === "right") return { type: "fold", direction: name };
  if (isEnter(name)) return { type: "open" };
  if (name === "f10" && key.shift) return { type: "menu" };
  if (name === "f2") return { type: "rename" };
  if (name === "delete" || name === "backspace") return { type: "delete" };
  if (name === "escape") return state.hasMultiSelection ? { type: "clear-selection" } : null;
  const text = printableText(key);
  return text === null ? null : { type: "type", text };
}
