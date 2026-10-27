// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks key encoding and the real drawer under OpenTUI with web's libghostty-vt core,
 * which needs Bun. The shells are an echoing stand-in for the server backend.
 *
 *   bun apps/tui/scripts/check-terminal.tsx
 */
import { decodePasteBytes, parseKeypress, type KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  applyTerminalAttachStreamEvent,
  nextTerminalAttachSeedState,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, useEffect, useState } from "react";

import { resolveTuiShortcutCommand } from "../src/keybindings.ts";
import { terminalRowRuns } from "../src/terminalCells.ts";
import type { TerminalBackend, TerminalLaunch } from "../src/terminalConnection.ts";
import { terminalFocusHints, useTerminalDrawer } from "../src/terminalDrawerView.tsx";
import { createTerminalEmulator } from "../src/terminalEmulator.ts";
import { encodeTerminalKey } from "../src/terminalKeys.ts";
import { TerminalPaneRenderable } from "../src/terminalPane.ts";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";

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
const controls: { showThread: (threadId: string) => void } = { showThread: () => {} };

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
  useKeyboard((key: KeyEvent) => {
    const shortcut = resolveTuiShortcutCommand(
      {
        keyName: key.name,
        sequence: key.sequence,
        ctrl: key.ctrl,
        meta: key.meta,
        super: key.super ?? false,
        shift: key.shift,
      },
      DEFAULT_RESOLVED_KEYBINDINGS,
      {
        platform,
        context: { terminalFocus: focus === "terminal", terminalOpen: drawer.open },
      },
    );
    if (drawer.handleKey(key, shortcut)) key.preventDefault();
  });
  usePaste((event) => {
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

const setup = await testRender(<Harness />, { width: 120, height: 36, exitOnCtrlC: false });
const frame = () => setup.captureCharFrame();
const shellA1 = () => shells.get("thread-a/term-1");
await settle(setup.renderOnce);
check("drawer starts hidden", frame().includes("Terminal"), false);

act(() => setup.mockInput.pressKey("j", { meta: true }));
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

act(() => setup.mockInput.pressKey("d", { meta: true }));
await settle(setup.renderOnce);
check("⌘D splits", frame().includes("● term-2") && frame().includes("○ term-1"), true);
act(() => setup.mockInput.pressKey("x"));
await settle(setup.renderOnce);
check("keys go to the new pane", shells.get("thread-a/term-2")?.input.join(""), "x");
act(() => setup.mockInput.pressArrow("left", { ctrl: true, shift: true }));
await settle(setup.renderOnce);
check("Ctrl+Shift+← switches panes", frame().includes("● term-1"), true);

act(() => setup.mockInput.pressKey("n", { meta: true }));
await settle(setup.renderOnce);
check("⌘N opens a new tab", frame().includes("2 term-3"), true);

/** ⌘W, with the close's reply landing inside `act`. */
async function pressClose(): Promise<void> {
  await act(async () => {
    setup.mockInput.pressKey("w", { meta: true });
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
act(() => setup.mockInput.pressKey("j", { meta: true }));
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
act(() => setup.mockInput.pressKey("j", { meta: true }));
await settle(setup.renderOnce);
check("⌘J in a focused terminal hides the drawer", frame().includes("Terminal"), false);
check("…and hands focus back", frame().includes("focus:composer"), true);

// Typed while "Starting terminal…" shows: the keys and the paste arrive, in order.
act(() => controls.showThread("thread-c"));
await settle(setup.renderOnce);
act(() => setup.mockInput.pressKey("j", { meta: true }));
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
act(() => setup.mockInput.pressKey("j", { meta: true }));
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

// Windows and Linux: Ctrl+D and Ctrl+U are the shell's.
platform = "linux";
act(() => {
  setup.mockInput.pressKey("d", { ctrl: true });
  setup.mockInput.pressKey("u", { ctrl: true });
});
await settle(setup.renderOnce);
check(
  "on Linux, Ctrl+D (EOF) and Ctrl+U (kill line) reach the shell",
  shells.get("thread-c/term-2")?.input.join(""),
  "z\u0004\u0015",
);
check("…without splitting", frame().includes("term-3"), false);
platform = "darwin";
check("the macOS footer shows ⌘D split", terminalFocusHints("darwin").includes("⌘D split"), true);
check(
  "the Linux footer offers no Ctrl+D split",
  terminalFocusHints("linux").includes("split"),
  false,
);

setup.renderer.destroy();
console.log(
  failures === 0 ? "\nall terminal checks passed" : `\n${failures} terminal check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
