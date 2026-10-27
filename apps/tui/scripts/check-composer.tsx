// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real composer under OpenTUI's renderer, which needs Bun (Vitest runs on Node).
 * Keys reach it the way ui.tsx routes them: the shell's keyboard hook calls its handle.
 *
 *   bun apps/tui/scripts/check-composer.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, createRef, type RefObject } from "react";

import { Composer, type ComposerHandle } from "../src/composer.tsx";
import { createComposerSend, DEFAULT_FOLLOW_UP_BEHAVIOR } from "../src/composerSend.ts";
import {
  createComposerSender,
  type ComposerCommandResult,
  type ComposerSender,
} from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore, type ComposerStore } from "../src/composerStore.ts";
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

function Harness(props: {
  readonly composer: RefObject<ComposerHandle | null>;
  readonly children: React.ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    if (props.composer.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children}</>;
}

interface Mounted {
  readonly setup: Awaited<ReturnType<typeof testRender>>;
  readonly stops: () => number;
}

async function mountComposer(input: {
  readonly store: ComposerStore;
  readonly sender: ComposerSender;
  readonly running: boolean;
}): Promise<Mounted> {
  let stops = 0;
  const composer = createRef<ComposerHandle>();
  const setup = await testRender(
    <Harness composer={composer}>
      <Composer
        ref={composer}
        target={{ kind: "thread", threadId, projectId: ProjectId.make("p") }}
        store={input.store}
        sender={input.sender}
        theme={DEFAULT_TUI_THEME}
        focused
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
      />
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
      return Promise.resolve({ ok: true });
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  return { sent, order, sender };
}

/** A composer on a running thread, with text and one image, as two quick Enters find it. */
async function checkDoubleEnter(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  store.setDraftText(threadId, "What color is this?");
  store.addAttachment(threadId, {
    id: "img-1",
    type: "image",
    name: "red.png",
    mimeType: "image/png",
    sizeBytes: 68,
    dataUrl: "data:image/png;base64,AAAA",
  });
  const { sent, sender } = recordingSender(store);
  const { setup, stops } = await mountComposer({ store, sender, running: true });
  // Both Enters land before React renders again.
  act(() => {
    setup.mockInput.pressEnter();
    setup.mockInput.pressEnter();
  });
  await settle(setup.renderOnce);
  check("S2: two quick Enters send one message", sent.length, 1);
  check("S2: the message carries its image once", sent[0]?.message.attachments.length, 1);
  check(
    "S2: no second message, empty or not",
    sent.filter((input) => input.message.attachments.length > 0).length,
    1,
  );
  check("S2: the second Enter doesn't stop the run", stops(), 0);
  check("S2: the composer is empty after", store.getDraft(threadId).attachments.length, 0);

  // Control: Enter on a composer that showed empty during a run still stops it.
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("S2 control: Enter on an empty composer stops the run", stops(), 1);
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

/** N3: Stop holds unsent messages; Enter on the empty composer after the run stops sends them. */
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
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("N3: Enter on the empty composer sends it", sent.at(-1)?.message.text, "second");
  check("N3: sent once", sent.filter((input) => input.message.text === "second").length, 1);
  check("N8: queue.resume goes out first", order.join(", "), "first, queue.resume, second");
  setup.renderer.destroy();
  sender.dispose();
}

await checkDoubleEnter();
await checkBusyEnter();
await checkResumeHeld();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
