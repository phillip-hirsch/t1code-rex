// @effect-diagnostics globalConsole:off globalTimers:off nodeBuiltinImport:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks step 6's key handling under OpenTUI's renderer with real parsed key events (kitty
 * protocol on): the sidebar's key map, the confirm dialog, and `@` mentions in the composer.
 *
 *   bun apps/tui/scripts/check-management.tsx
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { KeyEvent, PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
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
  /** Set while "the sidebar has focus": pastes go to the composer through its handle, as ui.tsx routes them. */
  readonly routePaste?: { current: boolean };
  readonly children: ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    if (props.composer.current?.handleKey(key)) key.preventDefault();
  });
  usePaste((event: PasteEvent) => {
    if (props.routePaste?.current !== true) return;
    event.preventDefault();
    event.stopPropagation();
    props.composer.current?.paste(event);
  });
  return <>{props.children}</>;
}

type SearchAtom = (
  input: ProjectSearchEntriesInput,
) => Atom.Atom<AsyncResult.AsyncResult<ProjectSearchEntriesResult, unknown>>;

const MAIN_ENTRIES: ProjectSearchEntriesResult = {
  entries: [
    { path: "src/main.ts", kind: "file" },
    { path: "src/math", kind: "directory" },
  ],
  truncated: false,
};

/** The real composer under OpenTUI, on a real store and sender; the server's side is scripted. */
async function mountComposer(options: {
  readonly focused: boolean;
  readonly searchAtom?: SearchAtom;
  readonly routePaste?: { current: boolean };
}) {
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
  const counts = { stops: 0 };
  const composer = createRef<ComposerHandle>();
  const setup = await testRender(
    <Harness
      composer={composer}
      {...(options.routePaste ? { routePaste: options.routePaste } : {})}
    >
      <Composer
        ref={composer}
        target={{ kind: "thread", threadId, projectId: ProjectId.make("p") }}
        store={store}
        sender={sender}
        theme={DEFAULT_TUI_THEME}
        focused={options.focused}
        baseSettings={settings}
        modelLabel={() => "Claude Haiku 5.5"}
        providerBadge={() => ({ icon: "✱", color: "#ffffff" })}
        running
        stopRequested={false}
        followUpBehavior={DEFAULT_FOLLOW_UP_BEHAVIOR}
        clipboardDir="/tmp"
        onFocus={() => undefined}
        onStop={() => {
          counts.stops += 1;
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
            return (options.searchAtom ?? (() => Atom.make(AsyncResult.success(MAIN_ENTRIES))))(
              input,
            );
          },
        }}
      />
    </Harness>,
    { ...KEYS, height: 20 },
  );
  await settle(setup.renderOnce);
  return {
    setup,
    store,
    composer,
    searches,
    counts,
    destroy: () => {
      setup.renderer.destroy();
      sender.dispose();
    },
  };
}

/** S2: Esc closes a menu that's still searching, or found nothing, without stopping the run. */
async function checkMentionEscape(): Promise<void> {
  for (const [label, searchAtom] of [
    ["searching", () => Atom.make(AsyncResult.initial<ProjectSearchEntriesResult, unknown>(true))],
    [
      "empty",
      () =>
        Atom.make(
          AsyncResult.success<ProjectSearchEntriesResult>({ entries: [], truncated: false }),
        ),
    ],
  ] as const) {
    const mounted = await mountComposer({ focused: true, searchAtom });
    await act(async () => {
      await mounted.setup.mockInput.typeText("see @zz");
    });
    await settle(mounted.setup.renderOnce, 6);
    const shown = mounted.setup.captureCharFrame();
    check(
      `S2: the ${label} menu shows`,
      label === "searching" ? shown.includes("Searching") : shown.includes("No matching files"),
      true,
    );
    act(() => mounted.setup.mockInput.pressEscape());
    await settle(mounted.setup.renderOnce);
    check(`S2: Esc on the ${label} menu doesn't stop the run`, mounted.counts.stops, 0);
    const after = mounted.setup.captureCharFrame();
    check(
      `S2: and closes it`,
      after.includes("Searching") || after.includes("No matching files"),
      false,
    );
    act(() => mounted.setup.mockInput.pressEscape());
    await settle(mounted.setup.renderOnce);
    check(`S2: a second Esc, with the menu closed, stops the run`, mounted.counts.stops, 1);
    mounted.destroy();
  }
}

/**
 * S3: OpenTUI's cursor counts display columns; the mention is found and replaced in string
 * units, after combining marks, emoji ZWJ sequences, and wide CJK characters.
 */
async function checkMentionUnicode(): Promise<void> {
  const link = "[main.ts](src/main.ts) ";
  for (const [label, prefix] of [
    ["a combining mark", "e\u0301 "],
    ["an emoji ZWJ sequence", "👩‍💻 "],
    ["CJK wide characters", "中文 "],
    ["a line above", "中\n👩‍💻 "],
  ] as const) {
    const mounted = await mountComposer({ focused: true });
    act(() => mounted.composer.current?.insertText(prefix));
    await act(async () => {
      await mounted.setup.mockInput.typeText("@ma");
    });
    await settle(mounted.setup.renderOnce, 6);
    check(`S3: after ${label}, it searches for "ma"`, mounted.searches.at(-1)?.query, "ma");
    act(() => mounted.setup.mockInput.pressTab());
    await settle(mounted.setup.renderOnce);
    check(
      `S3: after ${label}, Tab replaces exactly "@ma"`,
      mounted.store.getDraft(threadId).text,
      `${prefix}${link}`,
    );
    mounted.destroy();
  }
  // Mid-text: the cursor sits after "@ma", with text after it.
  const mounted = await mountComposer({ focused: true });
  act(() => mounted.composer.current?.insertText("中 @ma tail"));
  for (let step = 0; step < 5; step += 1) {
    act(() => mounted.setup.mockInput.pressArrow("left"));
  }
  await settle(mounted.setup.renderOnce, 6);
  check(
    'S3: with text after the cursor, it searches for "ma"',
    mounted.searches.at(-1)?.query,
    "ma",
  );
  act(() => mounted.setup.mockInput.pressTab());
  await settle(mounted.setup.renderOnce);
  check(
    "S3: and replaces only the mention",
    mounted.store.getDraft(threadId).text,
    `中 ${link} tail`,
  );
  mounted.destroy();
}

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** S4: a bracketed paste while the composer lacks focus reaches it, image rules included. */
async function checkPasteRedirect(): Promise<void> {
  const routePaste = { current: false };
  const mounted = await mountComposer({ focused: false, routePaste });
  await act(async () => {
    await mounted.setup.mockInput.pasteBracketedText("lost?");
  });
  await settle(mounted.setup.renderOnce);
  check("S4: unrouted, a paste reaches no composer", mounted.store.getDraft(threadId).text, "");
  routePaste.current = true;
  await act(async () => {
    await mounted.setup.mockInput.pasteBracketedText("fix the \u001b[31mparser\u001b[0m");
  });
  await settle(mounted.setup.renderOnce);
  check(
    "S4: routed, the text lands in the composer, colors stripped as the textarea does",
    mounted.store.getDraft(threadId).text,
    "fix the parser",
  );
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-paste-"));
  const imagePath = NodePath.join(dir, "shot.png");
  NodeFS.writeFileSync(imagePath, PNG);
  await act(async () => {
    await mounted.setup.mockInput.pasteBracketedText(imagePath);
  });
  for (
    let pass = 0;
    pass < 10 && mounted.store.getDraft(threadId).attachments.length === 0;
    pass += 1
  ) {
    await settle(mounted.setup.renderOnce, 1);
  }
  check(
    "S4: a pasted image path attaches the image",
    mounted.store
      .getDraft(threadId)
      .attachments.map((attachment) => attachment.name)
      .join(","),
    "shot.png",
  );
  check("S4: and isn't typed as text", mounted.store.getDraft(threadId).text, "fix the parser");
  NodeFS.rmSync(dir, { recursive: true, force: true });
  mounted.destroy();
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
await checkMentionEscape();
await checkMentionUnicode();
await checkPasteRedirect();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
