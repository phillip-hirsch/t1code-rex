import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ModelPickerJumpKeybindingCommand,
  type ResolvedKeybindingsConfig,
  type ThreadJumpKeybindingCommand,
} from "@t3tools/contracts";

export interface TuiShortcutEventLike {
  readonly keyName: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  /** Alt (Option on macOS). */
  readonly alt?: boolean;
  /** Cmd on macOS. Only kitty-protocol terminals send it. */
  readonly super?: boolean;
  readonly shift?: boolean;
}

/** The OpenTUI key fields a shortcut reads (KeyEvent has them all). */
export interface TuiShortcutKeyLike {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl: boolean;
  /** OpenTUI's `meta` is Alt: an ESC-prefixed key, or kitty's alt or meta. Never Cmd. */
  readonly meta: boolean;
  readonly option?: boolean;
  readonly shift: boolean;
  readonly super?: boolean | undefined;
}

/**
 * A key press as the shortcut resolver reads it: Alt stays Alt, and only `super` is Cmd. So
 * Alt+B, Alt+D and Alt+Backspace stay the shell's and the composer's word keys on macOS too.
 */
export function tuiShortcutEvent(key: TuiShortcutKeyLike): TuiShortcutEventLike {
  return {
    keyName: key.name,
    ...(key.sequence === undefined ? {} : { sequence: key.sequence }),
    ctrl: key.ctrl,
    alt: key.meta || key.option === true,
    super: key.super === true,
    shift: key.shift,
  };
}

export interface TuiShortcutMatchContext {
  readonly terminalFocus: boolean;
  readonly terminalOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly [key: string]: boolean;
}

interface TuiShortcutMatchOptions {
  readonly platform?: NodeJS.Platform;
  readonly context?: Partial<TuiShortcutMatchContext>;
}

function isMacPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/**
 * Ctrl keys the TUI keeps on Windows and Linux, where "mod" means Ctrl: Ctrl+D and Ctrl+U
 * scroll the transcript and diff by half a page, and delete in the composer. A default "mod+d"
 * (upstream's diff.toggle) doesn't take them there; an explicit "ctrl+d" binding still does.
 */
const RESERVED_CTRL_KEYS: ReadonlySet<string> = new Set(["d", "u"]);

/**
 * Whether Ctrl+<key> stays the TUI's or the shell's instead of a "mod+<key>" binding's. On
 * Windows and Linux a focused terminal keeps every Ctrl+letter: Ctrl+N, Ctrl+W, Ctrl+J and
 * the rest are readline's. Ctrl+] leaves the terminal, and the palette has its actions.
 */
function keepsCtrlKey(key: string, platform: NodeJS.Platform, terminalFocus: boolean): boolean {
  if (isMacPlatform(platform)) return false;
  return RESERVED_CTRL_KEYS.has(key) || (terminalFocus && /^[a-z]$/u.test(key));
}

function yieldsToReservedCtrlKey(
  shortcut: KeybindingShortcut,
  platform: NodeJS.Platform,
  terminalFocus: boolean,
): boolean {
  return (
    shortcut.modKey &&
    !shortcut.ctrlKey &&
    !shortcut.metaKey &&
    !shortcut.shiftKey &&
    !shortcut.altKey &&
    keepsCtrlKey(shortcut.key, platform, terminalFocus)
  );
}

function currentPlatform(): NodeJS.Platform {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The TUI reports the host it runs on; there is no Effect runtime to inject it.
  return process.platform;
}

/**
 * "⌘D" or "Ctrl+K" for a "mod+<key>" shortcut, or null where the TUI or a focused terminal
 * keeps that Ctrl key.
 */
export function modShortcutLabel(
  key: string,
  platform: NodeJS.Platform = currentPlatform(),
  options?: { readonly terminalFocus?: boolean },
): string | null {
  if (isMacPlatform(platform)) return `⌘${key.toUpperCase()}`;
  return keepsCtrlKey(key, platform, options?.terminalFocus === true)
    ? null
    : `Ctrl+${key.toUpperCase()}`;
}

function controlKeyFromSequence(sequence: string | undefined): string | null {
  if (!sequence || sequence.length !== 1) return null;
  const code = sequence.charCodeAt(0);
  if (code < 1 || code > 26 || code === 13) return null;
  return String.fromCharCode(code + 96);
}

function normalizeEventKey(event: TuiShortcutEventLike): string {
  const { keyName, sequence } = event;
  const normalizedName = keyName.toLowerCase();
  if (normalizedName === "esc") return "escape";
  if (normalizedName === "space") return " ";
  if (event.ctrl || event.alt || event.super) return normalizedName;
  const controlKey = controlKeyFromSequence(sequence);
  if (controlKey) return controlKey;
  if (sequence && sequence.length === 1) return sequence.toLowerCase();
  return normalizedName;
}

function matchesShortcut(
  event: TuiShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: NodeJS.Platform,
): boolean {
  const key = normalizeEventKey(event);
  if (key !== shortcut.key) return false;

  const useMetaForMod = isMacPlatform(platform);
  const eventCtrl = Boolean(
    event.ctrl || (!useMetaForMod && controlKeyFromSequence(event.sequence)),
  );
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    Boolean(event.super) === expectedMeta &&
    eventCtrl === expectedCtrl &&
    Boolean(event.shift) === shortcut.shiftKey &&
    Boolean(event.alt) === shortcut.altKey
  );
}

function resolveContext(options: TuiShortcutMatchOptions | undefined): TuiShortcutMatchContext {
  return {
    terminalFocus: false,
    terminalOpen: false,
    modelPickerOpen: false,
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: TuiShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: TuiShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

export function resolveTuiShortcutCommand(
  event: TuiShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: TuiShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = options?.platform ?? currentPlatform();
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (yieldsToReservedCtrlKey(binding.shortcut, platform, context.terminalFocus)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

export function modelPickerJumpIndexFromCommand(command: string): number | null {
  const index = MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.indexOf(
    command as ModelPickerJumpKeybindingCommand,
  );
  return index === -1 ? null : index;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function threadTraversalDirectionFromCommand(command: string): "previous" | "next" | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  return null;
}
