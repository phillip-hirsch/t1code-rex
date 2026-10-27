// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Drives the real diff panel under OpenTUI's renderer (which needs Bun; Vitest runs on
 * Node), fed by fixed atoms instead of a server: files and hunks, unified and split, keyboard
 * navigation, the line cap, and a new checkpoint arriving while it is open.
 *
 *   bun apps/tui/scripts/check-diff.tsx
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { RegistryContext } from "@effect/atom-react";
import { useKeyboard } from "@opentui/react";
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
import { LATEST_DIFF_SCOPE, type DiffScope, type DiffTurn } from "../src/diffTurns.ts";
import { useMarkdownStyles } from "../src/messageMarkdownView.tsx";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";

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

/** The panel's data as fixed atoms: diffs by range, and the thread's diffable turns. */
function createSource() {
  const registry = AtomRegistry.make();
  const turnsAtom = Atom.make<ReadonlyArray<DiffTurn>>([turn(1, "run-1")]);
  const diffs = new Map<string, CheckpointDiffAtom>();
  const diffText = (to: number) => (to === 1 ? TURN_1 : to === 2 ? TURN_2 : `${TURN_1}${TURN_2}`);
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
function Harness(props: { source: DiffSource }) {
  const styles = useMarkdownStyles(DEFAULT_TUI_THEME);
  const [scope, setScope] = useState<DiffScope>(LATEST_DIFF_SCOPE);
  const [view, setView] = useState<DiffViewMode>("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const panel = useRef<DiffPanelHandle | null>(null);
  useKeyboard((key: KeyEvent) => {
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
act(() => data.registry.set(data.turnsAtom, [turn(1, "run-1"), turn(2, "run-2")]));
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
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall diff checks passed");
process.exit(0);
