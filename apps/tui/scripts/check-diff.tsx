// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Drives the real diff panel under OpenTUI (Bun only), fed by fixed atoms: hunks, views, keys,
 * the line cap, new checkpoints, a run with no diff, and invisible whitespace changes.
 *   bun apps/tui/scripts/check-diff.tsx
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { RegistryContext } from "@effect/atom-react";
import { testRender } from "@opentui/react/test-utils";
import { ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useRef, useState } from "react";

import type { CheckpointDiffAtom } from "../src/connection/tuiConnection.ts";
import {
  DiffPanel,
  type DiffPanelHandle,
  type DiffSource,
  type DiffViewMode,
} from "../src/diffPanel.tsx";
import {
  LATEST_DIFF_SCOPE,
  type DiffScope,
  type DiffTurn,
  type DiffTurns,
} from "../src/diffTurns.ts";
import { useMarkdownStyles } from "../src/messageMarkdownView.tsx";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";
import { useSyncKeyboard } from "../src/syncKeyboard.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (want ${String(expected)})`}`,
  );
}

async function settle(render: () => Promise<void>, passes = 4): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await act(async () => {
      await render();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const THREAD_ID = ThreadId.make("thread-check");

function filePatch(path: string, hunks: ReadonlyArray<{ start: number; added: number }>): string {
  let text = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (const hunk of hunks) {
    text += `@@ -${hunk.start},2 +${hunk.start},${hunk.added + 2} @@ hunk${hunk.start}\n`;
    text += ` const before${hunk.start} = 0;\n`;
    for (let line = 0; line < hunk.added; line += 1) {
      text += `+export const added${hunk.start}_${line} = ${line};\n`;
    }
    text += ` const after${hunk.start} = 0;\n`;
  }
  return text;
}

const TURN_1 = [
  filePatch("src/alpha.ts", [
    { start: 1, added: 2 },
    { start: 100, added: 12 },
    { start: 300, added: 12 },
  ]),
  filePatch("src/beta.ts", [{ start: 5, added: 1 }]),
  filePatch("src/huge.ts", [{ start: 1, added: 5_000 }]),
].join("");
const TURN_2 = [
  filePatch("src/beta.ts", [{ start: 5, added: 3 }]),
  filePatch("src/gamma.ts", [{ start: 1, added: 1 }]),
].join("");

function turn(turnCount: number, runId: string): DiffTurn {
  return { turnCount, runId, fileCount: 2, additions: 1, deletions: 0 };
}

function diffTurns(
  turns: ReadonlyArray<DiffTurn>,
  undiffable: DiffTurns["undiffable"] = new Map(),
): DiffTurns {
  return { turns, undiffable };
}

const defaultDiffText = (to: number) =>
  to === 1 ? TURN_1 : to === 2 ? TURN_2 : `${TURN_1}${TURN_2}`;

/** The panel's data as fixed atoms: diffs by range, and the thread's diffable turns. */
function createSource(
  initialTurns: DiffTurns = diffTurns([turn(1, "run-1")]),
  diffText: (toTurnCount: number) => string = defaultDiffText,
) {
  const registry = AtomRegistry.make();
  const turnsAtom = Atom.make<DiffTurns>(initialTurns);
  const diffs = new Map<string, CheckpointDiffAtom>();
  const source: DiffSource = {
    registry,
    diffTurnsAtom: () => turnsAtom,
    checkpointDiffAtom: (threadId, range) => {
      const key = `${range.fromTurnCount}:${range.toTurnCount}`;
      let atom = diffs.get(key);
      if (atom === undefined) {
        atom = Atom.make(
          AsyncResult.success({
            threadId,
            ...range,
            diff:
              range.fromTurnCount === 0 && range.toTurnCount > 1
                ? diffText(0)
                : diffText(range.toTurnCount),
          }),
        );
        diffs.set(key, atom);
      }
      return atom;
    },
  };
  return { registry, turnsAtom, source, requested: () => [...diffs.keys()] };
}

/** The panel with its owner's state, and the app's key path: every key goes to handleKey. */
function Harness(props: { source: DiffSource; initialScope?: DiffScope }) {
  const styles = useMarkdownStyles(DEFAULT_TUI_THEME);
  const [scope, setScope] = useState<DiffScope>(props.initialScope ?? LATEST_DIFF_SCOPE);
  const [view, setView] = useState<DiffViewMode>("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const panel = useRef<DiffPanelHandle | null>(null);
  useSyncKeyboard((key: KeyEvent) => {
    panel.current?.handleKey(key);
  });
  return (
    <RegistryContext.Provider value={props.source.registry}>
      <DiffPanel
        ref={panel}
        connection={props.source}
        threadId={THREAD_ID}
        scope={scope}
        view={view}
        wordWrap={wordWrap}
        ignoreWhitespace
        showFileList
        running={false}
        theme={DEFAULT_TUI_THEME}
        styles={styles}
        onScopeChange={setScope}
        onViewChange={setView}
        onWordWrapChange={setWordWrap}
        onClose={() => undefined}
        onActivate={() => undefined}
      />
    </RegistryContext.Provider>
  );
}

function findScrollbox(root: { getChildren: () => ReadonlyArray<unknown> }): ScrollBoxRenderable {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as {
      constructor: { name: string };
      getChildren: () => ReadonlyArray<unknown>;
    };
    if (node.constructor.name === "ScrollBoxRenderable")
      return node as unknown as ScrollBoxRenderable;
    stack.push(...node.getChildren());
  }
  throw new Error("no scrollbox");
}

const data = createSource();
const setup = await testRender(<Harness source={data.source} />, {
  width: 120,
  height: 30,
  kittyKeyboard: true,
});
await settle(setup.renderOnce);
const scrollbox = findScrollbox(setup.renderer.root);
let frame = setup.captureCharFrame();

// D1: the latest turn, its file list with counts, and the first file's hunks under their headers.
check("D1: asks for the latest turn's own range", data.requested().join(","), "0:1");
check("D1: the header names the turn", frame.includes("Turn 1 of 1 (latest)"), true);
check("D1: three files with totals", frame.includes("3 files  +5,027 -0"), true);
check(
  "D1: the file list shows per-file counts",
  frame.includes("beta.ts src") && frame.includes("+26"),
  true,
);
check("D1: the first hunk's header", frame.includes("@@ -1,2 +1,4 @@ hunk1"), true);
check("D1: an added line with its line number", /\b2 \+ export const added1_0/.test(frame), true);

// D2: hunk navigation scrolls the hunk's header to the top.
act(() => setup.mockInput.pressKey("n"));
await settle(setup.renderOnce);
act(() => setup.mockInput.pressKey("n"));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
check("D2: n twice reaches the third hunk", scrollbox.scrollTop > 0, true);
const firstBodyLine = frame.split("\n").find((line) => line.includes("@@"));
check("D2: whose header is the first one drawn", firstBodyLine?.includes("hunk300") ?? false, true);
act(() => setup.mockInput.pressKey("p"));
await settle(setup.renderOnce);
check(
  "D2: p goes back one",
  setup
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("@@"))
    ?.includes("hunk100") ?? false,
  true,
);

// D3: files: ] moves on and starts at the top; [ goes back.
act(() => setup.mockInput.pressKey("]"));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
check("D3: ] selects the next file", frame.includes("@@ -5,2 +5,3 @@ hunk5"), true);
check("D3: from its top", scrollbox.scrollTop, 0);

// D4: split view lays the sides out next to each other.
act(() => setup.mockInput.pressKey("v"));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
const splitRow = frame.split("\n").find((line) => line.includes("const before5"));
check("D4: split shows both sides on one row", (splitRow?.match(/const before5/g) ?? []).length, 2);
act(() => setup.mockInput.pressKey("v"));
await settle(setup.renderOnce);

// D5: a 5,000-line file draws only its first 400 lines until "show more".
act(() => setup.mockInput.pressKey("]"));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
const cappedHeight = scrollbox.scrollHeight;
check("D5: the huge file is capped", cappedHeight < 420, true);
act(() => setup.mockInput.pressKey("END"));
await settle(setup.renderOnce);
check(
  "D5: and offers the rest",
  setup.captureCharFrame().includes("Show 400 more of 4,602 hidden lines  (m)"),
  true,
);
act(() => setup.mockInput.pressKey("m"));
await settle(setup.renderOnce);
check("D5: m draws 400 more", scrollbox.scrollHeight - cappedHeight, 400);

// D6: a new checkpoint while on the latest turn shows it, keeping the selected file by path.
act(() => setup.mockInput.pressKey("["));
await settle(setup.renderOnce);
act(() => data.registry.set(data.turnsAtom, diffTurns([turn(1, "run-1"), turn(2, "run-2")])));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
check("D6: the panel moves to the new turn", frame.includes("Turn 2 of 2 (latest)"), true);
check("D6: asking only for its range", data.requested().join(","), "0:1,1:2");
check("D6: and stays on beta.ts", frame.includes("@@ -5,2 +5,5 @@ hunk5"), true);

// D7: the full thread diff and stepping back a turn.
act(() => setup.mockInput.pressKey("a"));
await settle(setup.renderOnce);
frame = setup.captureCharFrame();
check("D7: a shows all turns", frame.includes("All turns"), true);
check("D7: from the thread's start", data.requested().includes("0:2"), true);
act(() => setup.mockInput.pressKey("a"));
await settle(setup.renderOnce);
act(() => setup.mockInput.pressKey(","));
await settle(setup.renderOnce);
check("D7: , steps back to turn 1", setup.captureCharFrame().includes("Turn 1 of 2"), true);

setup.renderer.destroy();

// D8: "View diff" on an interrupted run's row keeps that run: it says why there's no diff,
// and never shows (or asks for) another run's.
const WHITESPACE_TURN = [
  "diff --git a/notes.txt b/notes.txt",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+two   ",
  " three",
  "@@ -9,2 +9,2 @@",
  " nine",
  "-last",
  "\\ No newline at end of file",
  "+last",
  "",
].join("\n");
const runData = createSource(
  diffTurns(
    [turn(1, "run-1")],
    new Map([
      ["run-2", { turnCount: 2, reason: "it was interrupted, and only completed runs have diffs" }],
    ]),
  ),
  () => WHITESPACE_TURN,
);
const runSetup = await testRender(
  <Harness source={runData.source} initialScope={{ kind: "run", runId: "run-2", turnCount: 2 }} />,
  { width: 120, height: 30, kittyKeyboard: true },
);
await settle(runSetup.renderOnce);
frame = runSetup.captureCharFrame();
check(
  "D8: an interrupted run says why it has no diff",
  frame.includes("No diff for this run: it was interrupted, and only completed runs have diffs."),
  true,
);
check("D8: the header names the run, not a turn", frame.includes("This run"), true);
check("D8: and no other run's diff is asked for", runData.requested().join(","), "");

// D9: , steps to the nearest diffable turn; a trailing whitespace change is named.
act(() => runSetup.mockInput.pressKey(","));
await settle(runSetup.renderOnce);
frame = runSetup.captureCharFrame();
check("D9: , steps back to turn 1", frame.includes("Turn 1 of 1 (latest)"), true);
check(
  "D9: a trailing whitespace change is named",
  frame.includes("· Trailing whitespace changed on line 2"),
  true,
);

// D10: a newline-only change says which side has no final newline, in both views.
check(
  "D10: unified names the side missing its final newline",
  frame.includes("↵ No newline at end of file in the old version"),
  true,
);
check("D10: without counting it as a line", frame.includes("@@ -9,2 +9,2 @@"), true);
act(() => runSetup.mockInput.pressKey("v"));
await settle(runSetup.renderOnce);
frame = runSetup.captureCharFrame();
check(
  "D10: split does too",
  frame.includes("↵ No newline at end of file in the old version"),
  true,
);
runSetup.renderer.destroy();

// D11-D12: CRLF lines and whitespace-only changes, which look the same once drawn.
const CRLF_TURN = [
  "diff --git a/crlf.txt b/crlf.txt",
  "--- a/crlf.txt",
  "+++ b/crlf.txt",
  "@@ -1,5 +1,5 @@",
  " one\r",
  "-two\r",
  "+two   \r",
  "-b",
  "+b   \t",
  "-four",
  "+four\r",
  " five\r",
  "",
].join("\n");
const crlfData = createSource(diffTurns([turn(1, "run-1")]), () => CRLF_TURN);
const crlfSetup = await testRender(<Harness source={crlfData.source} />, {
  width: 120,
  height: 30,
  kittyKeyboard: true,
});

/** Drags from just after `sign` (e.g. "+ b") to the end of its row, and reads the selection. */
async function copyAfter(sign: string): Promise<string | undefined> {
  const rows = crlfSetup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(sign));
  const row = rows[y] ?? "";
  await act(async () => {
    await crlfSetup.mockMouse.drag(row.indexOf(sign) + 2, y, row.length - 1, y);
    await crlfSetup.renderOnce();
  });
  const text = crlfSetup.renderer.getSelection()?.getSelectedText();
  act(() => crlfSetup.renderer.clearSelection());
  return text;
}

for (const view of ["unified", "split"] as const) {
  await settle(crlfSetup.renderOnce);
  frame = crlfSetup.captureCharFrame();
  const rows = frame.split("\n");
  // D11: copying a changed line gives its own text, trailing spaces and tab included.
  check(`D11: ${view} copies a line exactly`, JSON.stringify(await copyAfter("+ b")), '"b   \\t"');
  check(
    `D11: ${view} copies a CRLF line's spaces, without its carriage return`,
    JSON.stringify(await copyAfter("+ two")),
    '"two   "',
  );
  // D12: a whitespace-only or line-ending-only change is named under its hunk.
  check(
    `D12: ${view} names the trailing whitespace change`,
    frame.includes("Trailing whitespace changed on lines 2, 3"),
    true,
  );
  check(
    `D12: ${view} names the line ending change`,
    frame.includes("Line endings changed (LF → CRLF) on line 4"),
    true,
  );
  check(
    `D12: ${view} keeps the sides' rows together`,
    (rows.find((line) => line.includes("five"))?.match(/five/g) ?? []).length,
    view === "split" ? 2 : 1,
  );
  if (view === "unified") act(() => crlfSetup.mockInput.pressKey("v"));
}
crlfSetup.renderer.destroy();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall diff checks passed");
process.exit(0);
