// @effect-diagnostics globalConsole:off -- A Bun check script; it runs outside the Effect runtime.
// Drives useSyncKeyboard and useSyncPaste through OpenTUI's real input parser: several keys
// arriving in one stdin chunk must each see the state the previous key left, as the palette
// and context menu need, and Enter after a paste must see the focus the paste moved. Plain
// useKeyboard and usePaste are the controls that show the failures.
import { decodePasteBytes, type KeyEvent, type PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";

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

const ITEMS = ["a", "b", "c", "d"];
interface MenuState {
  readonly open: boolean;
  readonly index: number;
  readonly picked: string | null;
  readonly typed: string;
}
let latest: MenuState = { open: false, index: 0, picked: null, typed: "" };

/** A menu that reads render state in its key handler, as ui.tsx's palette does. */
function Menu(props: { readonly useKeys: (handler: (key: KeyEvent) => void) => void }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    latest = { open, index, picked, typed };
  });
  props.useKeys((key) => {
    if (!open) {
      if (key.ctrl && key.name === "k") {
        setOpen(true);
        setIndex(0);
      } else if (key.name.length === 1) setTyped(typed + key.name);
      return;
    }
    if (key.name === "down") setIndex(Math.min(ITEMS.length - 1, index + 1));
    else if (key.name === "return") {
      setPicked(ITEMS[index] ?? null);
      setOpen(false);
    }
  });
  return <text content={`${open} ${index} ${picked} ${typed}`} />;
}

const DOWN = "\u001b[B";
const BURSTS = [
  { label: "Ctrl+K, Down ×3, Enter", bytes: `\u000b${DOWN}${DOWN}${DOWN}\r` },
  { label: "…then Ctrl+K, Down, Enter, x", bytes: `\u000b${DOWN}\rx` },
];

async function run(useKeys: (handler: (key: KeyEvent) => void) => void) {
  latest = { open: false, index: 0, picked: null, typed: "" };
  const setup = await testRender(<Menu useKeys={useKeys} />, { width: 40, height: 3 });
  const results: MenuState[] = [];
  for (const burst of BURSTS) {
    act(() => {
      setup.renderer.stdin.emit("data", Buffer.from(burst.bytes));
    });
    await setup.renderOnce();
    results.push(latest);
  }
  setup.renderer.destroy();
  return results;
}

const synced = await run(useSyncKeyboard);
check(`${BURSTS[0]?.label} in one chunk picks the 4th item`, synced[0]?.picked, "d");
check("…and closes the menu", synced[0]?.open, false);
check(`${BURSTS[1]?.label} picks the 2nd item`, synced[1]?.picked, "b");
check("…and x lands after the menu closed", synced[1]?.typed, "x");

const plain = await run(useKeyboard);
check(
  "control: plain useKeyboard reads stale state in the same burst",
  plain[0]?.picked === "d",
  false,
);

interface PasteState {
  readonly focus: "sidebar" | "composer";
  readonly sent: string | null;
  readonly opened: number;
}
let pasteLatest: PasteState = { focus: "sidebar", sent: null, opened: 0 };

/**
 * As ui.tsx routes them: a paste with the sidebar focused goes to the composer and focuses it;
 * Enter sends from the composer and opens the row from the sidebar.
 */
function PasteShell(props: {
  readonly useKeys: (handler: (key: KeyEvent) => void) => void;
  readonly usePastes: (handler: (event: PasteEvent) => void) => void;
}) {
  const [focus, setFocus] = useState<"sidebar" | "composer">("sidebar");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    pasteLatest = { focus, sent, opened };
  });
  props.usePastes((event) => {
    if (focus !== "sidebar") return;
    setDraft(draft + decodePasteBytes(event.bytes));
    setFocus("composer");
  });
  props.useKeys((key) => {
    if (key.name !== "return") return;
    if (focus === "composer") {
      setSent(draft);
      setDraft("");
    } else setOpened(opened + 1);
  });
  return <text content={`${focus} ${sent} ${opened}`} />;
}

async function runPaste(
  useKeys: (handler: (key: KeyEvent) => void) => void,
  usePastes: (handler: (event: PasteEvent) => void) => void,
): Promise<PasteState> {
  pasteLatest = { focus: "sidebar", sent: null, opened: 0 };
  const setup = await testRender(<PasteShell useKeys={useKeys} usePastes={usePastes} />, {
    width: 40,
    height: 3,
  });
  act(() => {
    setup.renderer.stdin.emit("data", Buffer.from("\u001b[200~hello\u001b[201~\r"));
  });
  await setup.renderOnce();
  setup.renderer.destroy();
  return pasteLatest;
}

const pasted = await runPaste(useSyncKeyboard, useSyncPaste);
check("sidebar: a paste and Enter in one chunk send the pasted text", pasted.sent, "hello");
check("…and Enter doesn't reach the sidebar", pasted.opened, 0);
// a550bb341's Shell: synced keys, but a plain paste.
const plainPaste = await runPaste(useSyncKeyboard, usePaste);
check("control: a plain usePaste leaves Enter on the sidebar", plainPaste.opened, 1);

console.log(failures === 0 ? "\nall key checks passed" : `\n${failures} key check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
