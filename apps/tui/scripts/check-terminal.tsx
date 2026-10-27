// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks key encoding and the real drawer under OpenTUI with web's libghostty-vt core,
 * which needs Bun. The shells are an echoing stand-in for the server backend.
 *
 *   bun apps/tui/scripts/check-terminal.tsx
 */
import { decodePasteBytes, parseKeypress, type KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import {
  applyTerminalAttachStreamEvent,
  nextTerminalAttachSeedState,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, useEffect, useState } from "react";

import { resolveTuiShortcutCommand, tuiShortcutEvent } from "../src/keybindings.ts";
import { terminalRowRuns } from "../src/terminalCells.ts";
import type { TerminalBackend, TerminalLaunch } from "../src/terminalConnection.ts";
import { terminalFocusHints, useTerminalDrawer } from "../src/terminalDrawerView.tsx";
import { createTerminalEmulator } from "../src/terminalEmulator.ts";
import { encodeTerminalKey } from "../src/terminalKeys.ts";
import { TerminalPaneRenderable } from "../src/terminalPane.ts";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";
import { useSyncKeyboard, useSyncPaste } from "../src/syncKeyboard.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  const show = (value: unknown) => JSON.stringify(value);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${show(actual)}${ok ? "" : ` (want ${show(expected)})`}`,
  );
}

async function settle(render: () => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await render();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Keys: OpenTUI's parser in, Ghostty's encoder out.

const THEME = {
  foreground: { r: 229, g: 229, b: 229 },
  background: { r: 17, g: 17, b: 17 },
  cursor: { r: 212, g: 212, b: 212 },
};
const replies: string[] = [];
const emulator = await createTerminalEmulator({
  cols: 40,
  rows: 5,
  theme: THEME,
  onReply: (data) => replies.push(data),
});
const encode = (raw: string, kitty = false) => {
  const key = parseKeypress(raw, { useKittyKeyboard: kitty });
  return key === null ? null : encodeTerminalKey(emulator, key);
};

check("Ctrl+C", encode("\u0003"), "\u0003");
check("letters", encode("a"), "a");
check("Shift letter", encode("A"), "A");
check("Backspace", encode("\u007f"), "\u007f");
check("Enter", encode("\r"), "\r");
check("Tab", encode("\t"), "\t");
check("Shift+Tab", encode("\u001b[Z"), "\u001b[Z");
check("Escape", encode("\u001b"), "\u001b");
check("Alt+B", encode("\u001bb"), "\u001bb");
check("Ctrl+←", encode("\u001b[1;5D"), "\u001b[1;5D");
check("Delete", encode("\u001b[3~"), "\u001b[3~");
check("emoji", encode("🙂"), "🙂");
check("arrow, normal cursor keys", encode("\u001b[A"), "\u001b[A");
emulator.write("\u001b[?1h");
check("arrow, application cursor keys (vim, less)", encode("\u001b[A"), "\u001bOA");
check("kitty-protocol Ctrl+C from the outer terminal", encode("\u001b[99;5u", true), "\u0003");
emulator.write("\u001b[>1u");
check(
  "Ctrl+C to a program that asked for kitty keys",
  encode("\u001b[99;5u", true),
  "\u001b[99;5u",
);
emulator.write("\u001b[<u\u001b[?1l");
check("paste", emulator.encodePaste("a\nb"), "a\rb");
emulator.write("\u001b[?2004h");
check("bracketed paste", emulator.encodePaste("a\nb"), "\u001b[200~a\nb\u001b[201~");
emulator.write("\u001b[?2004l\u001b[6n");
check("cursor position report goes back to the PTY", replies.at(-1), "\u001b[1;1R");
emulator.write("\u001b[31mred\u001b[0m");
const cell = emulator.snapshot().rowData[0]?.cells[0];
check(
  "SGR color reaches the cell",
  cell?.text === "r" && cell.foreground.r > cell.foreground.g,
  true,
);
// A joiner in Devanagari is the script's (क्‍ष is a half-form), not a split emoji's.
emulator.write("\u001b[2J\u001b[Hक्\u200dष");
check(
  "a non-emoji joiner survives the row's runs",
  terminalRowRuns(emulator.snapshot().rowData[0] ?? { cells: [] })
    .map((run) => run.text)
    .join("")
    .startsWith("क्\u200dष"),
  true,
);
emulator.dispose();

// Shortcuts: OpenTUI's parser in, the resolver out. OpenTUI's `meta` is Alt, never Cmd.
const resolveRaw = (
  raw: string,
  host: NodeJS.Platform,
  terminalFocus: boolean,
  kitty = false,
): string | null => {
  const key = parseKeypress(raw, { useKittyKeyboard: kitty });
  if (key === null) return "unparsed";
  return resolveTuiShortcutCommand(tuiShortcutEvent(key), DEFAULT_RESOLVED_KEYBINDINGS, {
    platform: host,
    context: { terminalFocus, terminalOpen: true },
  });
};
for (const [label, raw] of [
  ["Alt+B", "\u001bb"],
  ["Alt+F", "\u001bf"],
  ["Alt+D", "\u001bd"],
  ["Alt+W", "\u001bw"],
  ["Alt+N", "\u001bn"],
  ["Alt+J", "\u001bj"],
  ["Alt+Backspace", "\u001b\u007f"],
] as const) {
  check(
    `macOS terminal: ${label} (ESC-prefixed) is the shell's`,
    resolveRaw(raw, "darwin", true),
    null,
  );
}
check(
  "macOS terminal: kitty Alt+D is the shell's",
  resolveRaw("\u001b[100;3u", "darwin", true, true),
  null,
);
check(
  "macOS terminal: kitty Alt+W is the shell's",
  resolveRaw("\u001b[119;3u", "darwin", true, true),
  null,
);
check("macOS composer: Alt+D isn't ⌘D (diff)", resolveRaw("\u001bd", "darwin", false), null);
for (const [letter, command] of [
  ["d", "terminal.split"],
  ["w", "terminal.close"],
  ["n", "terminal.new"],
  ["j", "terminal.toggle"],
] as const) {
  check(
    `macOS terminal: kitty ⌘${letter.toUpperCase()}`,
    resolveRaw(`\u001b[${letter.charCodeAt(0)};9u`, "darwin", true, true),
    command,
  );
}
check(
  "macOS composer: kitty ⌘D",
  resolveRaw("\u001b[100;9u", "darwin", false, true),
  "diff.toggle",
);
for (const host of ["linux", "win32"] as const) {
  for (const [label, raw, kitty] of [
    ["Ctrl+N", "\u000e", false],
    ["Ctrl+W", "\u0017", false],
    ["Ctrl+J", "\n", false],
    ["Ctrl+D", "\u0004", false],
    ["Ctrl+U", "\u0015", false],
    ["kitty Ctrl+N", "\u001b[110;5u", true],
    ["kitty Ctrl+W", "\u001b[119;5u", true],
    ["kitty Ctrl+J", "\u001b[106;5u", true],
  ] as const) {
    check(`${host} terminal: ${label} is the shell's`, resolveRaw(raw, host, true, kitty), null);
  }
  check(
    `${host} terminal: kitty Ctrl+Shift+D splits down`,
    resolveRaw("\u001b[100;6u", host, true, true),
    "terminal.splitVertical",
  );
  check(
    `${host} composer: Ctrl+J opens the terminal`,
    resolveRaw("\n", host, false),
    "terminal.toggle",
  );
  check(`${host} composer: Ctrl+N is a new thread`, resolveRaw("\u000e", host, false), "chat.new");
}

interface FakeShell {
  buffer: TerminalBufferState;
  readonly listeners: Set<(buffer: TerminalBufferState) => void>;
  readonly input: string[];
  readonly grids: Array<{ cols: number; rows: number }>;
  connects: number;
  onExit: (() => void) | null;
}

const shells = new Map<string, FakeShell>();
const closed: string[] = [];
/** Set, the server refuses to close a shell. */
let closeFailure: string | null = null;
/** Set, closes wait for it, as a slow server's reply does. */
let closeGate: Promise<void> | null = null;
const shellKey = (threadId: string, terminalId: string) => `${threadId}/${terminalId}`;

function emit(shell: FakeShell, data: string) {
  shell.buffer = applyTerminalAttachStreamEvent(shell.buffer, {
    type: "output",
    threadId: "t",
    terminalId: "t",
    data,
  });
  for (const listener of shell.listeners) listener(shell.buffer);
}

function shellFor(launch: TerminalLaunch): FakeShell {
  const key = shellKey(launch.threadId, launch.terminalId);
  let shell = shells.get(key);
  if (shell === undefined) {
    shell = {
      buffer: applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
        type: "snapshot",
        snapshot: {
          threadId: launch.threadId,
          terminalId: launch.terminalId,
          cwd: launch.cwd,
          worktreePath: launch.worktreePath,
          status: "running",
          pid: 42,
          history: `\u001b[32m${launch.cwd}\u001b[0m $ `,
          exitCode: null,
          exitSignal: null,
          label: launch.terminalId,
          updatedAt: "2026-10-27T00:00:00.000Z",
        },
      }),
      listeners: new Set(),
      input: [],
      grids: [],
      connects: 0,
      onExit: null,
    };
    shells.set(key, shell);
  }
  return shell;
}

// Echoes like a cooked-mode shell: Enter ends the line, Ctrl+C prints ^C.
const backend: TerminalBackend = {
  retain: () => () => {},
  runningTerminalIds: () => [],
  connect: (launch, gridSize, onExit) => {
    const shell = shellFor(launch);
    shell.grids.push(gridSize);
    shell.connects += 1;
    shell.onExit = onExit;
    return {
      read: () => shell.buffer,
      subscribe: (listener) => {
        shell.listeners.add(listener);
        return () => shell.listeners.delete(listener);
      },
      write: (data) => {
        shell.input.push(data);
        emit(
          shell,
          data === "\r" ? "\r\n$ " : data === "\u0003" ? "^C\r\n$ " : data.replace(/\r/g, "\r\n"),
        );
      },
      resume: () => {},
      reportGridSize: (size) => shell.grids.push(size),
      dispose: () => shell.listeners.clear(),
    };
  },
  close: async (threadId, terminalId) => {
    if (closeGate !== null) await closeGate;
    if (closeFailure !== null) throw new Error(closeFailure);
    closed.push(shellKey(threadId, terminalId));
    shells.delete(shellKey(threadId, terminalId));
  },
};

const statuses: string[] = [];
/** The host the harness resolves shortcuts for. */
let platform: NodeJS.Platform = "darwin";
const controls: {
  showThread: (threadId: string) => void;
  actions: ReadonlyArray<{ readonly id: string; readonly run: () => void }>;
} = { showThread: () => {}, actions: [] };

function Harness() {
  const [threadId, setThreadId] = useState("thread-a");
  const [focus, setFocus] = useState<"composer" | "terminal">("composer");
  useEffect(() => {
    controls.showThread = setThreadId;
  }, []);
  const drawer = useTerminalDrawer({
    backend,
    theme: DEFAULT_TUI_THEME,
    target: {
      threadId: ThreadId.make(threadId),
      cwd: `/work/${threadId}`,
      worktreePath: null,
      projectRoot: `/work/${threadId}`,
    },
    focused: focus === "terminal",
    area: { cols: 118, rows: 34 },
    onFocus: () => setFocus("terminal"),
    onLeave: () => setFocus("composer"),
    onTabOut: () => setFocus("composer"),
    onStatus: (status) => statuses.push(status),
  });
  useEffect(() => {
    controls.actions = drawer.actions;
  });
  useSyncKeyboard((key: KeyEvent) => {
    const shortcut = resolveTuiShortcutCommand(
      tuiShortcutEvent(key),
      DEFAULT_RESOLVED_KEYBINDINGS,
      {
        platform,
        context: { terminalFocus: focus === "terminal", terminalOpen: drawer.open },
      },
    );
    if (drawer.handleKey(key, shortcut)) key.preventDefault();
  });
  useSyncPaste((event) => {
    if (drawer.paste(decodePasteBytes(event.bytes))) event.preventDefault();
  });
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <text content={`focus:${focus} thread:${threadId}`} />
      <box style={{ flexGrow: 1 }} />
      {drawer.element}
    </box>
  );
}

// The app's parser in Rex: kitty keys on, legacy ESC-prefixed Alt keys still read.
const setup = await testRender(<Harness />, {
  width: 120,
  height: 36,
  exitOnCtrlC: false,
  useKittyKeyboard: { events: true },
});
/** Bytes as the outer terminal sends them, through the renderer's own parser. */
const pressRaw = (bytes: string) => setup.renderer.stdin.emit("data", Buffer.from(bytes));
/** Cmd+<letter> under the kitty keyboard protocol, as Rex sends it. */
const pressCmd = (letter: string) => pressRaw(`\u001b[${letter.charCodeAt(0)};9u`);
const frame = () => setup.captureCharFrame();
const shellA1 = () => shells.get("thread-a/term-1");
await settle(setup.renderOnce);
check("drawer starts hidden", frame().includes("Terminal"), false);

act(() => pressCmd("j"));
await settle(setup.renderOnce);
check("⌘J opens the drawer and focuses the terminal", frame().includes("focus:terminal"), true);
check("the shell starts in the thread's folder", frame().includes("/work/thread-a $"), true);
check("the shell gets the pane's grid", (shellA1()?.grids[0]?.cols ?? 0) > 100, true);

await act(() => setup.mockInput.typeText("ls"));
act(() => setup.mockInput.pressEnter());
act(() => setup.mockInput.pressCtrlC());
act(() => setup.mockInput.pressTab());
await settle(setup.renderOnce);
check("typing, Enter, Ctrl+C and Tab go to the shell", shellA1()?.input.join(""), "ls\r\u0003\t");
check("its echo is drawn", frame().includes("^C"), true);

// Wide characters: each cell is drawn in the column Ghostty put it in.
const WIDE_LINE = "Qa👨‍👩‍👧‍👦b 界x \u001b[8m界\u001b[0my \u001b[41m界\u001b[0mz";
const reference = await createTerminalEmulator({
  cols: 60,
  rows: 2,
  theme: THEME,
  onReply: () => {},
});
reference.write(WIDE_LINE);
const ghosttyColumns = new Map<string, number>();
let ghosttyRed = THEME.background;
reference.snapshot().rowData[0]?.cells.forEach((cell, x) => {
  if (/^[Qabxyz]$/u.test(cell.text) || cell.text === "界") ghosttyColumns.set(cell.text, x);
  if (cell.text === "界") ghosttyRed = cell.background;
});
reference.dispose();
const shellA = shellA1();
if (shellA !== undefined) emit(shellA, `\r\n${WIDE_LINE}\r\n$ `);
await settle(setup.renderOnce);
const drawn = setup.renderer.currentRenderBuffer;
const cellIndex = (x: number, y: number) => y * drawn.width + x;
const markIndex = drawn.buffers.char.indexOf("Q".codePointAt(0) ?? 0);
const origin = {
  x: (markIndex % drawn.width) - (ghosttyColumns.get("Q") ?? 0),
  y: Math.floor(markIndex / drawn.width),
};
const drawnAt = (letter: string) =>
  String.fromCodePoint(
    drawn.buffers.char[cellIndex(origin.x + (ghosttyColumns.get(letter) ?? -1), origin.y)] ?? 0,
  );
check("Ghostty puts the family emoji in 8 columns", ghosttyColumns.get("b"), 10);
check("the letter after a ZWJ emoji is drawn in Ghostty's column", drawnAt("b"), "b");
check("…after CJK", drawnAt("x"), "x");
check("…after hidden CJK", drawnAt("y"), "y");
check("…after colored CJK", drawnAt("z"), "z");
const redColumn = origin.x + (ghosttyColumns.get("界") ?? 0);
const redBackground = (x: number) => {
  const [r, g, b] = drawn.buffers.bg.subarray(cellIndex(x, origin.y) * 4);
  return r === ghosttyRed.r && g === ghosttyRed.g && b === ghosttyRed.b && r !== THEME.background.r;
};
check(
  "a colored wide char fills both its columns",
  redBackground(redColumn) && redBackground(redColumn + 1),
  true,
);
check("focus stays in the terminal", frame().includes("focus:terminal"), true);

await act(() => setup.mockInput.pasteBracketedText("echo pasted"));
await settle(setup.renderOnce);
check("a paste is the shell's too", shellA1()?.input.at(-1), "echo pasted");

act(() => pressCmd("d"));
await settle(setup.renderOnce);
check("⌘D splits", frame().includes("● term-2") && frame().includes("○ term-1"), true);
act(() => setup.mockInput.pressKey("x"));
await settle(setup.renderOnce);
check("keys go to the new pane", shells.get("thread-a/term-2")?.input.join(""), "x");
act(() => setup.mockInput.pressArrow("left", { ctrl: true, shift: true }));
await settle(setup.renderOnce);
check("Ctrl+Shift+← switches panes", frame().includes("● term-1"), true);

act(() => pressCmd("n"));
await settle(setup.renderOnce);
check("⌘N opens a new tab", frame().includes("2 term-3"), true);

/** ⌘W, with the close's reply landing inside `act`. */
async function pressClose(): Promise<void> {
  await act(async () => {
    pressCmd("w");
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await settle(setup.renderOnce);
}

closeFailure = "terminal busy";
await pressClose();
check("a close the server refuses keeps the terminal", frame().includes("2 term-3"), true);
check("…and says why", statuses.at(-1), "Couldn't close term-3: terminal busy");
closeFailure = null;
await pressClose();
check("⌘W closes the active terminal on the server", closed.at(-1), "thread-a/term-3");
check("…and its tab", frame().includes("term-3"), false);

act(() => setup.mockInput.pressKey("]", { ctrl: true }));
await settle(setup.renderOnce);
check(
  "Ctrl+] leaves the terminal, the drawer stays",
  frame().includes("focus:composer") && frame().includes("Terminal"),
  true,
);
act(() => setup.mockInput.pressKey("q"));
check("unfocused, keys stay out of the shell", shellA1()?.input.includes("q"), false);

act(() => controls.showThread("thread-b"));
await settle(setup.renderOnce);
check("another thread has its own drawer", frame().includes("Terminal"), false);
act(() => pressCmd("j"));
await settle(setup.renderOnce);
check("…with its own shell", frame().includes("/work/thread-b $"), true);

// A hidden thread's shell keeps printing; its pane reads the output but asks for no frames.
let renderRequests = 0;
const requestRender = setup.renderer.requestRender.bind(setup.renderer);
setup.renderer.requestRender = () => {
  renderRequests += 1;
  requestRender();
};
const hiddenShell = shellA1();
if (hiddenShell !== undefined) for (let chunk = 0; chunk < 40; chunk += 1) emit(hiddenShell, ".");
setup.renderer.requestRender = requestRender;
check("a hidden thread's output asks for no frames", renderRequests, 0);

act(() => controls.showThread("thread-a"));
await settle(setup.renderOnce);
check("showing it again draws what it printed meanwhile", frame().includes(".".repeat(40)), true);
// ⌘W on term-3 handed the focus to term-2, its neighbour.
check(
  "switching back finds the split intact",
  frame().includes("○ term-1") && frame().includes("● term-2"),
  true,
);
check("…with its screen as it was", frame().includes("^C"), true);
check("…from the same pane, not a reconnect", shellA1()?.connects, 1);

act(() => setup.mockInput.pressArrow("up", { ctrl: true, shift: true }));
await settle(setup.renderOnce);
const rowsBefore = shellA1()?.grids.at(-2)?.rows ?? 0;
check(
  "Ctrl+Shift+↑ grows the drawer and resizes the PTY",
  (shellA1()?.grids.at(-1)?.rows ?? 0) - rowsBefore,
  1,
);

await act(async () => {
  shellA1()?.onExit?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
});
await settle(setup.renderOnce);
check("a shell that exits leaves the drawer", frame().includes("term-1"), false);
check("…and its history goes, as a close's does", closed.at(-1), "thread-a/term-1");
act(() => pressCmd("j"));
await settle(setup.renderOnce);
check("⌘J in a focused terminal hides the drawer", frame().includes("Terminal"), false);
check("…and hands focus back", frame().includes("focus:composer"), true);

// Typed while "Starting terminal…" shows: the keys and the paste arrive, in order.
act(() => controls.showThread("thread-c"));
await settle(setup.renderOnce);
act(() => pressCmd("j"));
act(() => {
  for (const letter of "echo") setup.mockInput.pressKey(letter);
  void setup.mockInput.pasteBracketedText(" early");
  setup.mockInput.pressEnter();
});
await settle(setup.renderOnce);
const shellC1 = () => shells.get("thread-c/term-1");
check(
  "input typed during startup reaches the shell, in order",
  shellC1()?.input.join(""),
  "echo early\r",
);

// Held input is bounded, and a pane that goes before its shell starts sends none of it.
let heldConnects = 0;
const held = new TerminalPaneRenderable(setup.renderer, {
  cwd: "/work/held",
  theme: THEME,
  mutedColor: THEME.foreground,
  connect: () => {
    heldConnects += 1;
    throw new Error("a destroyed pane connected");
  },
});
const keyY = parseKeypress("y");
held.paste("x".repeat(65_535));
check("a starting pane holds keys", keyY !== null && held.sendKey(keyY), true);
check("…up to its cap", keyY !== null && held.sendKey(keyY), false);
held.destroy();
check("a destroyed pane holds nothing", keyY !== null && held.sendKey(keyY), false);
await new Promise((resolve) => setTimeout(resolve, 50));
check("…and never connects", heldConnects, 0);

// A close whose reply lands after the shell's exit event and a reopen leaves the new shell be.
let releaseClose = () => {};
closeGate = new Promise((resolve) => {
  releaseClose = resolve;
});
await pressClose();
const closingShell = shellC1();
await act(async () => {
  closingShell?.onExit?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
});
await settle(setup.renderOnce);
check("the exit event drops the closing terminal", frame().includes("Terminal"), false);
act(() => pressCmd("j"));
await settle(setup.renderOnce);
check("reopening skips the id whose close is in flight", frame().includes("term-2"), true);
closeGate = null;
await act(async () => {
  releaseClose();
  await new Promise((resolve) => setTimeout(resolve, 25));
});
await settle(setup.renderOnce);
check("the late close reply leaves the new terminal open", frame().includes("Terminal"), true);
act(() => setup.mockInput.pressKey("z"));
await settle(setup.renderOnce);
check("…and its shell takes input", shells.get("thread-c/term-2")?.input.join(""), "z");

// macOS: Alt is readline's word keys, never Cmd.
const shellC2Input = () => shells.get("thread-c/term-2")?.input.join("") ?? "";
for (const bytes of ["\u001bb", "\u001bf", "\u001bd", "\u001b\u007f", "\u001bw", "\u001b[100;3u"]) {
  act(() => pressRaw(bytes));
  await settle(setup.renderOnce);
}
check(
  "on macOS, Alt+B/F/D/Backspace/W reach the shell (kitty Alt+D too)",
  shellC2Input(),
  "z\u001bb\u001bf\u001bd\u001b\u007f\u001bw\u001bd",
);
check(
  "…without splitting or closing",
  frame().includes("term-2") && !frame().includes("term-3"),
  true,
);

// Windows and Linux: a focused terminal keeps every Ctrl+letter.
platform = "linux";
for (const letter of ["d", "u", "n", "w", "j"]) {
  act(() => setup.mockInput.pressKey(letter, { ctrl: true }));
  await settle(setup.renderOnce);
}
act(() => pressRaw("\u001b[110;5u"));
await settle(setup.renderOnce);
check(
  "on Linux, Ctrl+D/U/N/W/J (and kitty Ctrl+N) reach the shell",
  shellC2Input().slice("z\u001bb\u001bf\u001bd\u001b\u007f\u001bw\u001bd".length),
  "\u0004\u0015\u000e\u0017\n\u000e",
);
check(
  "…without a split, a new tab, a close or a hide",
  frame().includes("1 term-2") && !frame().includes("term-3") && frame().includes("focus:terminal"),
  true,
);
act(() => setup.mockInput.pressKey("]", { ctrl: true }));
await settle(setup.renderOnce);
check(
  "Ctrl+] then the palette has every terminal action",
  controls.actions.map((action) => action.id).join(" "),
  "terminal:toggle terminal:new terminal:split terminal:split-vertical terminal:hide terminal:close",
);
act(() => controls.actions.find((action) => action.id === "terminal:hide")?.run());
await settle(setup.renderOnce);
check("…and its Hide terminal hides the drawer", frame().includes("Terminal"), false);
platform = "darwin";
check("the macOS footer shows ⌘D split", terminalFocusHints("darwin").includes("⌘D split"), true);
for (const host of ["linux", "win32"] as const) {
  const hints = terminalFocusHints(host);
  check(
    `the ${host} footer offers no Ctrl key for terminal actions`,
    /Ctrl\+|\^[A-Z]\b/u.test(hints.replace("^K", "")),
    false,
  );
  check(
    `…and sends them to the palette`,
    hints.includes("^] then ^K: hide, split, new tab, close"),
    true,
  );
}

setup.renderer.destroy();
console.log(
  failures === 0 ? "\nall terminal checks passed" : `\n${failures} terminal check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
