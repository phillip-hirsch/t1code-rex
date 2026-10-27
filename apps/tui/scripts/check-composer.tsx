// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real composer under OpenTUI's renderer, which needs Bun (Vitest runs on Node).
 * Keys reach it the way ui.tsx routes them: the shell's keyboard hook calls its handle.
 *
 *   bun apps/tui/scripts/check-composer.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, createRef, type RefObject, useState } from "react";

import { Composer, NO_MENTION_SEARCH_SOURCE, type ComposerHandle } from "../src/composer.tsx";
import { isEnterKey } from "../src/composerKeys.ts";
import { UNCONFIRMED_NOTICE } from "../src/composerRecovery.ts";
import { createComposerSend, DEFAULT_FOLLOW_UP_BEHAVIOR } from "../src/composerSend.ts";
import {
  createComposerSender,
  type ComposerCommandResult,
  type ComposerSender,
} from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore, type ComposerStore } from "../src/composerStore.ts";
import { useSyncKeyboard } from "../src/syncKeyboard.ts";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (want ${String(expected)})`}`,
  );
}

async function settle(render: () => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await render();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const threadId = ThreadId.make("t1");

/**
 * Keys reach the composer the way ui.tsx routes them, through the app's own keyboard hook.
 * While unfocused, Enter focuses the composer, as Enter in the thread or sidebar does.
 */
function Harness(props: {
  readonly composer: RefObject<ComposerHandle | null>;
  readonly startFocused: boolean;
  readonly children: (focused: boolean) => React.ReactNode;
}) {
  const [focused, setFocused] = useState(props.startFocused);
  useSyncKeyboard((key: KeyEvent) => {
    if (!focused) {
      if (isEnterKey(key.name)) {
        setFocused(true);
        key.preventDefault();
      }
      return;
    }
    if (props.composer.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children(focused)}</>;
}

interface Mounted {
  readonly setup: Awaited<ReturnType<typeof testRender>>;
  readonly stops: () => number;
}

async function mountComposer(input: {
  readonly store: ComposerStore;
  readonly sender: ComposerSender;
  readonly running: boolean;
  readonly focused?: boolean;
}): Promise<Mounted> {
  let stops = 0;
  const composer = createRef<ComposerHandle>();
  const setup = await testRender(
    <Harness composer={composer} startFocused={input.focused ?? true}>
      {(focused) => (
        <Composer
          ref={composer}
          target={{ kind: "thread", threadId, projectId: ProjectId.make("p") }}
          store={input.store}
          sender={input.sender}
          theme={DEFAULT_TUI_THEME}
          focused={focused}
          baseSettings={settings}
          modelLabel={() => "Claude Haiku 5.5"}
          providerBadge={() => ({ icon: "✱", color: "#ffffff" })}
          running={input.running}
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
          mentionSearch={NO_MENTION_SEARCH_SOURCE}
        />
      )}
    </Harness>,
    { width: 70, height: 12, kittyKeyboard: true },
  );
  await settle(setup.renderOnce);
  return { setup, stops: () => stops };
}

/** A sender whose dispatches land in `sent`; `reply` answers each one. */
function recordingSender(
  store: ComposerStore,
  reply: (input: StartThreadTurnInput) => Promise<ComposerCommandResult> = () =>
    Promise.resolve({ ok: true }),
  resumeReply: () => Promise<ComposerCommandResult> = () => Promise.resolve({ ok: true }),
) {
  const sent: Array<StartThreadTurnInput> = [];
  /** Every command in order: message texts, and "queue.resume". */
  const order: Array<string> = [];
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      sent.push(input);
      order.push(input.message.text);
      return reply(input);
    },
    resumeQueue: () => {
      order.push("queue.resume");
      return resumeReply();
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  return { sent, order, sender };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sends bytes as one stdin chunk, so the parser hands every key over before React renders. */
function emitChunk(setup: Mounted["setup"], bytes: string): void {
  act(() => {
    setup.renderer.stdin.emit("data", Buffer.from(bytes));
  });
}

/**
 * A composer on a running thread, with text and one image, as two quick Enters find it:
 * in one input chunk, then as two presses a render apart. Neither second Enter may stop
 * the run the first one steered. As upstream, Enter on an empty composer never stops a
 * run; Esc does.
 */
async function checkDoubleEnter(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const draft = (text: string) => {
    store.setDraftText(threadId, text);
    store.addAttachment(threadId, {
      id: `img-${text}`,
      type: "image",
      name: "red.png",
      mimeType: "image/png",
      sizeBytes: 68,
      dataUrl: "data:image/png;base64,AAAA",
    });
  };
  draft("What color is this?");
  const { sent, sender } = recordingSender(store);
  const { setup, stops } = await mountComposer({ store, sender, running: true });
  emitChunk(setup, "\r\r");
  await settle(setup.renderOnce);
  check("S1: two Enters in one chunk send one message", sent.length, 1);
  check("S1: the message carries its image once", sent[0]?.message.attachments.length, 1);
  check("S1: the second Enter in the chunk doesn't stop the run", stops(), 0);
  check("S1: the composer is empty after", store.getDraft(threadId).attachments.length, 0);

  // Two presses, the composer rendered empty between them.
  act(() => draft("And this?"));
  await settle(setup.renderOnce);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("S1: two quick presses send one message", sent.length, 2);
  check("S1: the second quick press doesn't stop the run", stops(), 0);

  // Enter on a composer that sat empty during a run does nothing; Esc stops it.
  await sleep(1000);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("parity: Enter on an empty composer doesn't stop the run", stops(), 0);
  act(() => setup.mockInput.pressEscape());
  await settle(setup.renderOnce);
  check("control: Esc stops the run", stops(), 1);
  setup.renderer.destroy();
  sender.dispose();
}

/** Enter that focuses the composer (from the thread or sidebar) and a second Enter, in one chunk. */
async function checkFocusEnter(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const { sender } = recordingSender(store);
  const { setup, stops } = await mountComposer({ store, sender, running: true, focused: false });
  emitChunk(setup, "\r\r");
  await settle(setup.renderOnce);
  check("S1: Enter, Enter from the thread doesn't stop the run", stops(), 0);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("S1: nor does a later Enter on the empty composer", stops(), 0);
  setup.renderer.destroy();
  sender.dispose();
}

/** Upstream web's default: Enter steers a busy run, Cmd/Ctrl+Enter queues (Alt+Enter too). */
async function checkBusyEnter(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const { sent, sender } = recordingSender(store);
  const { setup } = await mountComposer({ store, sender, running: true });
  check(
    "parity: the busy placeholder says Enter steers",
    setup.captureCharFrame().includes("Steer the run"),
    true,
  );
  const presses: ReadonlyArray<[string, Parameters<typeof setup.mockInput.pressEnter>[0]]> = [
    ["Enter", undefined],
    ["Cmd+Enter", { super: true }],
    ["Ctrl+Enter", { ctrl: true }],
    ["Alt+Enter", { meta: true }],
  ];
  for (const [label, modifiers] of presses) {
    await act(async () => {
      await setup.mockInput.typeText(label);
    });
    await settle(setup.renderOnce);
    act(() => setup.mockInput.pressEnter(modifiers));
    await settle(setup.renderOnce);
  }
  check("parity: Enter steers a busy run", sent[0]?.dispatchMode, "steer");
  check("parity: Cmd+Enter queues", sent[1]?.dispatchMode, "queue");
  check("parity: Ctrl+Enter queues", sent[2]?.dispatchMode, "queue");
  check("parity: Alt+Enter queues", sent[3]?.dispatchMode, "queue");
  setup.renderer.destroy();
  sender.dispose();
}

/** N3: Stop holds unsent messages; Enter leaves them held, and /resume sends them. */
async function checkResumeHeld(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  let answerFirst: (result: ComposerCommandResult) => void = () => undefined;
  const { sent, order, sender } = recordingSender(store, (input) =>
    input.message.text === "first"
      ? new Promise((resolve) => {
          answerFirst = resolve;
        })
      : Promise.resolve({ ok: true }),
  );
  const base = { target: { kind: "thread" as const, threadId, projectId: ProjectId.make("p") } };
  const make = (text: string) =>
    createComposerSend({ ...base, text, attachments: [], dispatch: "queue", settings });
  let held = 0;
  act(() => {
    void sender.send(make("first"));
    void sender.send(make("second"));
    held = sender.hold(threadId);
  });
  check("N3: Stop holds the message behind the one in flight", held, 1);
  await act(async () => {
    answerFirst({ ok: true });
    await settle(() => Promise.resolve());
  });
  check("N3: nothing more goes out after Stop", sent.length, 1);
  const { setup } = await mountComposer({ store, sender, running: false });
  check(
    "N3: the held message shows as held",
    setup.captureCharFrame().includes("Held after Stop: second"),
    true,
  );
  emitChunk(setup, "\r\r");
  await settle(setup.renderOnce);
  check("N3: Enter, Enter on the empty composer releases nothing", order.join(", "), "first");
  await act(async () => {
    await setup.mockInput.typeText("/resume");
  });
  await settle(setup.renderOnce);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("N3: /resume sends it", sent.at(-1)?.message.text, "second");
  check("N3: sent once", sent.filter((input) => input.message.text === "second").length, 1);
  check("N8: queue.resume goes out first", order.join(", "), "first, queue.resume, second");
  setup.renderer.destroy();
  sender.dispose();
}

/** A message the last quit couldn't confirm comes back with its note, mounted or not. */
async function checkRestoredNote(): Promise<void> {
  for (const mounted of [false, true]) {
    const store = createComposerStore({ initialPrefs: {}, persist: null });
    const { sender } = recordingSender(store);
    const restore = () =>
      store.restoreDraft(threadId, { text: "bravo", attachments: [] }, UNCONFIRMED_NOTICE);
    if (!mounted) restore();
    const { setup } = await mountComposer({ store, sender, running: false });
    if (mounted) act(restore);
    await settle(setup.renderOnce);
    const frame = setup.captureCharFrame();
    const when = mounted ? "into a mounted composer" : "before the composer mounts";
    check(`restore ${when}: the text is back`, frame.includes("bravo"), true);
    check(`restore ${when}: the note shows`, frame.includes("Maybe not sent"), true);
    await act(async () => {
      await setup.mockInput.typeText("!");
    });
    await settle(setup.renderOnce);
    check(`restore ${when}: typing dismisses the note`, store.snapshot(threadId).notice, null);
    setup.renderer.destroy();
    sender.dispose();
  }
}

/** /discard typed into the composer puts the held message back, even behind a hung resume. */
async function checkDiscardHeld(hungResume: boolean): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const never = () => new Promise<ComposerCommandResult>(() => undefined);
  const { sender } = recordingSender(
    store,
    (input) =>
      input.message.text === "first" && !hungResume ? never() : Promise.resolve({ ok: true }),
    never,
  );
  const base = { target: { kind: "thread" as const, threadId, projectId: ProjectId.make("p") } };
  const make = (text: string) =>
    createComposerSend({ ...base, text, attachments: [], dispatch: "queue", settings });
  act(() => {
    void sender.send(make("first"));
    void sender.send(make("second"));
    sender.hold(threadId);
  });
  if (hungResume) {
    await act(async () => {
      await settle(() => Promise.resolve());
      sender.resume(threadId);
    });
  }
  const { setup } = await mountComposer({ store, sender, running: false });
  await act(async () => {
    await setup.mockInput.typeText("/discard");
  });
  await settle(setup.renderOnce);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  const label = hungResume ? "/discard behind a hung resume" : "/discard";
  check(`${label}: the held message is back in the draft`, store.getDraft(threadId).text, "second");
  check(`${label}: the composer shows it`, setup.captureCharFrame().includes("│ second"), true);
  check(
    `${label}: with its note`,
    store.snapshot(threadId).notice,
    "Not sent; edit it and send again",
  );
  setup.renderer.destroy();
  sender.dispose();
}

await checkDoubleEnter();
await checkFocusEnter();
await checkBusyEnter();
await checkResumeHeld();
await checkRestoredNote();
await checkDiscardHeld(false);
await checkDiscardHeld(true);
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
