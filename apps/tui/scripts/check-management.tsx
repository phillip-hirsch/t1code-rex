// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks step 6's key handling under OpenTUI's renderer with real parsed key events (kitty
 * protocol on): the sidebar's key map, the confirm dialog, and `@` mentions in the composer.
 *
 *   bun apps/tui/scripts/check-management.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, createRef, useState, type ReactNode, type RefObject } from "react";

import { Composer, type ComposerHandle } from "../src/composer.tsx";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../src/composerSend.ts";
import { createComposerSender } from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore } from "../src/composerStore.ts";
import {
  deleteThreadsConfirm,
  openConfirm,
  reduceConfirmKey,
  type ConfirmDialogState,
} from "../src/confirmDialog.ts";
import { ConfirmDialogView } from "../src/managementViews.tsx";
import { resolveSidebarKey, type SidebarKeyAction } from "../src/sidebarKeys.ts";
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
    await render();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const KEYS = { width: 80, height: 16, kittyKeyboard: true } as const;

/** S1: text typed with the sidebar focused is all typing; only control keys act on the sidebar. */
async function checkSidebarKeys(): Promise<void> {
  const actions: Array<SidebarKeyAction | null> = [];
  function Recorder() {
    useKeyboard((key: KeyEvent) => {
      actions.push(resolveSidebarKey(key, { hasMultiSelection: false }));
    });
    return <text content="sidebar" />;
  }
  const setup = await testRender(<Recorder />, KEYS);
  const text = "quit, make a new Rex tab: jk hl m r";
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await settle(setup.renderOnce, 1);
  const typed = actions.splice(0);
  check("S1: every typed character is a key", typed.length, text.length);
  check(
    "S1: and every one types into the composer",
    typed.every((action) => action?.type === "type"),
    true,
  );
  check(
    "S1: in order",
    typed.map((action) => (action?.type === "type" ? action.text : "")).join(""),
    text,
  );
  act(() => {
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("F10", { shift: true });
    setup.mockInput.pressKey("F2");
    setup.mockInput.pressArrow("down", { shift: true });
    setup.mockInput.pressKey("n", { super: true });
  });
  await settle(setup.renderOnce, 1);
  check("S1: Enter opens", actions[0]?.type, "open");
  check("S1: Shift+F10 opens the menu", actions[1]?.type, "menu");
  check("S1: F2 renames", actions[2]?.type, "rename");
  check("S1: Shift+↓ extends the selection", actions[3]?.type, "extend-selection");
  check("S1: Cmd+N is left to the app's shortcuts", actions[4], null);
  setup.renderer.destroy();
}

/** C1: a delete confirm cancels on typed text and Enter; it takes ← or → then Enter to delete. */
async function checkConfirmDialog(): Promise<void> {
  const outcomes: string[] = [];
  function Harness() {
    const [state, setState] = useState<ConfirmDialogState | null>(() =>
      openConfirm([deleteThreadsConfirm(["Fix the parser"])]),
    );
    useKeyboard((key: KeyEvent) => {
      if (state === null) return;
      const outcome = reduceConfirmKey(state, key);
      if (outcome.type === "state") setState(outcome.state);
      else if (outcome.type === "cancel" || outcome.type === "confirm") {
        outcomes.push(outcome.type);
        setState(openConfirm([deleteThreadsConfirm(["Fix the parser"])]));
      }
    });
    return state === null ? null : (
      <ConfirmDialogView state={state} theme={DEFAULT_TUI_THEME} onPress={() => undefined} />
    );
  }
  const setup = await testRender(<Harness />, KEYS);
  await settle(setup.renderOnce);
  const frame = setup.captureCharFrame();
  check("C1: the dialog names the thread", frame.includes('Delete thread "Fix the parser"?'), true);
  check("C1: and starts on Cancel", frame.includes("› Cancel"), true);
  await act(async () => {
    await setup.mockInput.typeText("yes delete it");
  });
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("C1: typed text and Enter cancel", outcomes.join(","), "cancel");
  act(() => setup.mockInput.pressArrow("right"));
  await settle(setup.renderOnce);
  check("C1: → moves to Delete", setup.captureCharFrame().includes("› Delete"), true);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("C1: then Enter deletes", outcomes.join(","), "cancel,confirm");
  setup.renderer.destroy();
}

const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const threadId = ThreadId.make("t1");

function Harness(props: {
  readonly composer: RefObject<ComposerHandle | null>;
  readonly children: ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    if (props.composer.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children}</>;
}

/** M1: `@ma` searches the workspace, and Tab replaces it with web's markdown file link. */
async function checkMentions(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sender = createComposerSender({
    store,
    startTurn: () => Promise.resolve({ ok: true }),
    resumeQueue: () => Promise.resolve({ ok: true }),
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  const searches: Array<ProjectSearchEntriesInput> = [];
  const result: ProjectSearchEntriesResult = {
    entries: [
      { path: "src/main.ts", kind: "file" },
      { path: "src/math", kind: "directory" },
    ],
    truncated: false,
  };
  let stops = 0;
  const composer = createRef<ComposerHandle>();
  const setup = await testRender(
    <Harness composer={composer}>
      <Composer
        ref={composer}
        target={{ kind: "thread", threadId, projectId: ProjectId.make("p") }}
        store={store}
        sender={sender}
        theme={DEFAULT_TUI_THEME}
        focused
        baseSettings={settings}
        modelLabel={() => "Claude Haiku 5.5"}
        providerBadge={() => ({ icon: "✱", color: "#ffffff" })}
        running
        stopRequested={false}
        followUpBehavior={DEFAULT_FOLLOW_UP_BEHAVIOR}
        clipboardDir="/tmp"
        onFocus={() => undefined}
        onStop={() => {
          stops += 1;
        }}
        onExit={() => undefined}
        onNewThread={() => undefined}
        onOpenModelPicker={() => undefined}
        onSetInteractionMode={() => undefined}
        onSetRuntimeMode={() => undefined}
        onStatus={() => undefined}
        onClone={async () => null}
        mentionSearch={{
          cwd: "/repo",
          searchAtom: (input) => {
            searches.push(input);
            return Atom.make(AsyncResult.success(result));
          },
        }}
      />
    </Harness>,
    { ...KEYS, height: 20 },
  );
  await settle(setup.renderOnce);
  await act(async () => {
    await setup.mockInput.typeText("see @ma");
  });
  await settle(setup.renderOnce, 6);
  check(
    "M1: the menu lists the search's entries",
    setup.captureCharFrame().includes("src/main.ts"),
    true,
  );
  check("M1: searched the thread's workspace", searches.at(-1)?.cwd, "/repo");
  check("M1: for what follows the @", searches.at(-1)?.query, "ma");
  act(() => setup.mockInput.pressTab());
  await settle(setup.renderOnce);
  check(
    "M1: Tab inserts the file link",
    store.getDraft(threadId).text,
    "see [main.ts](src/main.ts) ",
  );

  // M2: Esc closes the menu; it doesn't stop the running turn.
  await act(async () => {
    await setup.mockInput.typeText("@ma");
  });
  await settle(setup.renderOnce, 6);
  act(() => setup.mockInput.pressEscape());
  await settle(setup.renderOnce);
  check("M2: Esc closes the menu", setup.captureCharFrame().includes("src/math"), false);
  check("M2: without stopping the run", stops, 0);

  // M3: keys typed elsewhere land in the composer through its handle.
  act(() => composer.current?.insertText(" ok"));
  await settle(setup.renderOnce);
  check(
    "M3: inserted text lands at the cursor",
    store.getDraft(threadId).text.endsWith("@ma ok"),
    true,
  );
  setup.renderer.destroy();
  sender.dispose();
}

await checkSidebarKeys();
await checkConfirmDialog();
await checkMentions();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
