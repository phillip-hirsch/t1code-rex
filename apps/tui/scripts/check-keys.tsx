// @effect-diagnostics globalConsole:off -- A Bun check script; it runs outside the Effect runtime.
// Drives useSyncKeyboard through OpenTUI's real input parser: several keys arriving in one
// stdin chunk must each see the state the previous key left, as the palette and context
// menu need. Plain useKeyboard runs alongside as the control that shows the failure.
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";

import { useSyncKeyboard } from "../src/syncKeyboard.ts";

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

console.log(failures === 0 ? "\nall key checks passed" : `\n${failures} key check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
