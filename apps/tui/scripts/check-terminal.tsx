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
import type { TerminalBackend, TerminalLaunch } from "../src/terminalConnection.ts";
import { useTerminalDrawer } from "../src/terminalDrawerView.tsx";
import { createTerminalEmulator } from "../src/terminalEmulator.ts";
import { encodeTerminalKey } from "../src/terminalKeys.ts";
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

const replies: string[] = [];
const emulator = await createTerminalEmulator({
  cols: 40,
  rows: 5,
  theme: {
    foreground: { r: 229, g: 229, b: 229 },
    background: { r: 17, g: 17, b: 17 },
    cursor: { r: 212, g: 212, b: 212 },
  },
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
      reportGridSize: (size) => shell.grids.push(size),
      dispose: () => shell.listeners.clear(),
    };
  },
  close: (threadId, terminalId) => {
    closed.push(shellKey(threadId, terminalId));
    shells.delete(shellKey(threadId, terminalId));
  },
};

const statuses: string[] = [];
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
        platform: "darwin",
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

act(() => setup.mockInput.pressKey("w", { meta: true }));
await settle(setup.renderOnce);
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
act(() => controls.showThread("thread-a"));
await settle(setup.renderOnce);
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

act(() => shellA1()?.onExit?.());
await settle(setup.renderOnce);
check("a shell that exits leaves the drawer", frame().includes("term-1"), false);
act(() => setup.mockInput.pressKey("j", { meta: true }));
await settle(setup.renderOnce);
check("⌘J in a focused terminal hides the drawer", frame().includes("Terminal"), false);
check("…and hands focus back", frame().includes("focus:composer"), true);

setup.renderer.destroy();
console.log(
  failures === 0 ? "\nall terminal checks passed" : `\n${failures} terminal check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
