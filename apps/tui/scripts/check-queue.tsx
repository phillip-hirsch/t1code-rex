// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real queue list (QueuePanel) with the real composer dock under OpenTUI with the
 * kitty keyboard protocol, as in Rex, routed as ui.tsx routes keys through `useSyncKeyboard`.
 * The controller, sender and composer store are the app's; the server is scripted, and
 * updates the thread's queue the way its projection would.
 * Needs Bun. Run: bun apps/tui/scripts/check-queue.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { RegistryContext } from "@effect/atom-react";
import type { QueuedRunStatus } from "@t3tools/client-runtime/queued-run-edit";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, createRef, useImperativeHandle, useRef, useState } from "react";

import { NO_MENTION_SEARCH_SOURCE } from "../src/composer.tsx";
import { ComposerDock, type ComposerDockHandle } from "../src/composerDock.tsx";
import { DEFAULT_FOLLOW_UP_BEHAVIOR, type ComposerSend } from "../src/composerSend.ts";
import { createComposerSender, type ComposerCommandResult } from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore } from "../src/composerStore.ts";
import { resolveTuiShortcutCommand, tuiShortcutEvent } from "../src/keybindings.ts";
import { createQueueController } from "../src/queueController.ts";
import { QueuePanel, type QueuePanelHandle } from "../src/queuePanel.tsx";
import { queuedMessageIdsKey, type QueueRow, type QueueView } from "../src/queueView.ts";
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
    await act(async () => render());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

const threadId = ThreadId.make("thread-queue");
const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const ACTIVE = RunId.make("run-active");

function row(id: string, text: string, held = false): QueueRow {
  return {
    runId: RunId.make(id),
    messageId: MessageId.make(`msg-${id}`),
    text,
    preview: text.replace(/\s+/gu, " ").trim(),
    attachments: 0,
    held,
    guestName: null,
  };
}

const THREE = [
  row("a", "explain the failing test"),
  row("b", "then fix it"),
  row("c", "and add a regression test"),
];

function queueOf(rows: ReadonlyArray<QueueRow>, overrides: Partial<QueueView> = {}): QueueView {
  return {
    rows,
    holdReason: null,
    activeRunId: ACTIVE,
    canReorder: true,
    canSendNow: false,
    canPromoteToSteer: true,
    ...overrides,
  };
}

type Call = { readonly type: string; readonly input: Record<string, unknown> };

interface Controls {
  readonly focus: "composer" | "queue";
}

async function mount(initial: QueueView, options: { readonly running?: boolean } = {}) {
  const registry = AtomRegistry.make();
  const viewAtom = Atom.make<QueueView | null>(initial).pipe(Atom.keepAlive);
  const runsAtom = Atom.make<ReadonlyArray<QueuedRunStatus> | null>(
    initial.rows.map((entry) => ({ id: entry.runId, status: "queued" })),
  ).pipe(Atom.keepAlive);
  const idsAtom = Atom.make((get) => queuedMessageIdsKey(get(viewAtom)));
  const statusByRun = new Map<string, string>();
  const calls: Call[] = [];
  const statuses: string[] = [];
  const keys: KeyEvent[] = [];
  const view = () => registry.get(viewAtom);
  /** The server applied a change: the projection's queue moves on. */
  const update = (rows: ReadonlyArray<QueueRow>, overrides: Partial<QueueView> = {}) => {
    const current = view() ?? queueOf([]);
    // A message that left without a status here started.
    for (const entry of current.rows) {
      if (!rows.some((next) => next.runId === entry.runId) && !statusByRun.has(entry.runId)) {
        statusByRun.set(entry.runId, "running");
      }
    }
    registry.set(viewAtom, { ...current, rows, ...overrides });
    registry.set(
      runsAtom,
      [...(registry.get(runsAtom) ?? [])].map((run) =>
        rows.some((entry) => entry.runId === run.id)
          ? run
          : { ...run, status: statusByRun.get(run.id) ?? "queued" },
      ),
    );
  };
  const rowsNow = () => view()?.rows ?? [];
  const server = (type: string, apply: (input: Record<string, unknown>) => void) => {
    return (input: object): Promise<ComposerCommandResult> => {
      const record = { ...input } as Record<string, unknown>;
      calls.push({ type, input: record });
      apply(record);
      return Promise.resolve({ ok: true });
    };
  };
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      calls.push({ type: "message.dispatch", input: { messageId: input.messageId } });
      return Promise.resolve({ ok: true });
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    resumeQueue: server("queue.resume", (input) => {
      update(
        rowsNow().filter((entry) => entry.runId !== input.runId),
        { activeRunId: (input.runId as RunId | undefined) ?? null, canSendNow: false },
      );
    }),
    schedule: () => () => undefined,
  });
  const controller = createQueueController({
    registry,
    view,
    runStatus: (_, runId) => statusByRun.get(runId) ?? "queued",
    queuedRuns: () => runsAtom,
    editQueuedRun: server("queued-run.edit", (input) =>
      update(
        rowsNow().map((entry) =>
          entry.runId === input.runId
            ? { ...entry, text: String(input.text), preview: String(input.text) }
            : entry,
        ),
      ),
    ),
    cancelQueuedRun: server("queued-run.cancel", (input) => {
      statusByRun.set(String(input.runId), "cancelled");
      update(rowsNow().filter((entry) => entry.runId !== input.runId));
    }),
    reorderQueuedRun: server("queued-run.reorder", (input) => {
      const moving = rowsNow().find((entry) => entry.runId === input.runId);
      const rest = rowsNow().filter((entry) => entry.runId !== input.runId);
      const at = rest.findIndex((entry) => entry.runId === input.beforeRunId);
      if (moving === undefined) return;
      rest.splice(at === -1 ? rest.length : at, 0, moving);
      update(rest);
    }),
    promoteQueuedRun: server("queued-message.promote-to-steer", (input) => {
      statusByRun.set(String(input.queuedRunId), "running");
      update(rowsNow().filter((entry) => entry.runId !== input.queuedRunId));
    }),
    sender,
    schedule: () => () => undefined,
    store,
    onStatus: (status) => statuses.push(status),
  });
  const handle = createRef<Controls>();

  /** Mirrors ui.tsx: focus, upstream's queue shortcuts, the dock and the list. */
  function Shell() {
    const [focus, setFocus] = useState<"composer" | "queue">("composer");
    const [queueShown, setQueueShown] = useState(false);
    const [, setHints] = useState("");
    const dock = useRef<ComposerDockHandle | null>(null);
    const panel = useRef<QueuePanelHandle | null>(null);
    useImperativeHandle(handle, () => ({ focus }), [focus]);
    if (focus === "queue" && !queueShown) setFocus("composer");
    const queueFocused = focus === "queue" && queueShown;
    useSyncKeyboard((key: KeyEvent) => {
      keys.push(key);
      const shortcut = resolveTuiShortcutCommand(
        tuiShortcutEvent(key),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "darwin",
          context: { composerFocus: focus === "composer" },
        },
      );
      const used = (() => {
        if (shortcut === "thread.steerQueuedMessage" && panel.current?.sendFirst(key.repeated)) {
          return true;
        }
        if (shortcut === "thread.editQueuedMessage" && panel.current?.editLast(key.repeated)) {
          return true;
        }
        if (focus === "composer" && dock.current?.handleKey(key)) return true;
        if (queueFocused && panel.current?.handleKey(key)) return true;
        if (key.name === "tab" && !key.shift) {
          setFocus((area) => (area === "composer" && queueShown ? "queue" : "composer"));
          return true;
        }
        return false;
      })();
      if (used) key.preventDefault();
    });
    return (
      <RegistryContext.Provider value={registry}>
        <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
          <box style={{ flexGrow: 1 }} />
          <QueuePanel
            ref={panel}
            threadId={threadId}
            viewAtom={viewAtom}
            controller={controller}
            theme={DEFAULT_TUI_THEME}
            focused={queueFocused}
            onFocus={() => setFocus("queue")}
            onLeave={() => setFocus("composer")}
            onType={(text) => {
              dock.current?.insertText(text);
              setFocus("composer");
            }}
            onShown={setQueueShown}
            onHints={setHints}
          />
          <ComposerDock
            ref={dock}
            composer={{
              target: { kind: "thread", threadId, projectId: ProjectId.make("p") },
              store,
              theme: DEFAULT_TUI_THEME,
              baseSettings: settings,
              followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
              modelLabel: () => "Claude Haiku 5.5",
              providerBadge: () => ({ icon: "✱", color: "#ffffff" }),
              running: options.running ?? true,
              stopRequested: false,
              clipboardDir: "/tmp",
              onStop: () => undefined,
              onExit: () => undefined,
              onNewThread: () => undefined,
              onOpenModelPicker: () => undefined,
              onSetInteractionMode: () => undefined,
              onSetRuntimeMode: () => undefined,
              onStatus: (status) => statuses.push(status),
              onClone: async () => null,
              mentionSearch: NO_MENTION_SEARCH_SOURCE,
              queuedMessageIds: idsAtom,
            }}
            sender={sender}
            requests={null}
            focus={focus === "composer" ? "composer" : null}
            onFocus={() => setFocus("composer")}
            onPanelShown={() => undefined}
          />
        </box>
      </RegistryContext.Provider>
    );
  }

  const setup = await testRender(<Shell />, {
    width: 100,
    height: 20,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  await settle(setup.renderOnce);
  const frame = () => setup.captureCharFrame();
  const press = async (fn: () => unknown) => {
    await act(async () => fn());
    await settle(setup.renderOnce);
  };
  /** Raw kitty keys: `CSI code ; mods : type u`; mods 1 none, 2 Shift, 3 Alt, 10 Cmd+Shift. */
  const kitty = (code: number, mods = 1, type: 1 | 2 = 1) =>
    setup.renderer.stdin.emit("data", Buffer.from(`\x1b[${code};${mods}:${type}u`));
  /** Kitty's arrow form: `CSI 1 ; mods A` (up) or `B` (down). */
  const arrow = (direction: "A" | "B", mods = 1) =>
    setup.renderer.stdin.emit("data", Buffer.from(`\x1b[1;${mods}${direction}`));
  const type = (text: string) => setup.mockInput.typeText(text);
  const close = async () => {
    await act(async () => {
      sender.dispose();
      setup.renderer.destroy();
    });
  };
  return {
    setup,
    registry,
    store,
    sender,
    calls,
    statuses,
    keys,
    frame,
    press,
    kitty,
    arrow,
    type,
    update,
    view,
    close,
    get focus() {
      return handle.current?.focus ?? null;
    },
  };
}

const TAB = 9;
const ENTER = 13;
const ESC = 27;
const x = "x".charCodeAt(0);
const s = "s".charCodeAt(0);

async function checkList() {
  const ui = await mount(queueOf(THREE));
  check(
    "Q1: the list shows the three queued messages",
    ui.frame().includes("Up next · 3 queued"),
    true,
  );
  check(
    "Q1: in order",
    /1\. 󰒲 explain[\s\S]*2\. 󰒲 then fix[\s\S]*3\. 󰒲 and add/u.test(ui.frame()),
    true,
  );
  check("Q1: and says Tab manages it", ui.frame().includes("tab to manage"), true);
  await ui.press(() => ui.kitty(TAB));
  check("Q1: Tab moves focus to the list", ui.focus, "queue");
  check("Q1: the first is selected, with its actions", ui.frame().includes("› 1."), true);
  check("Q1: steer is offered while the run takes steers", ui.frame().includes("s steer"), true);
  await ui.press(() => ui.kitty(ESC));
  check("Q1: Esc goes back to the composer", ui.focus, "composer");
  await ui.close();
}

async function checkHeld() {
  const ui = await mount(
    queueOf([row("a", "first", true), row("b", "second", true)], {
      holdReason: "stopped",
      activeRunId: null,
      canSendNow: true,
      canPromoteToSteer: false,
    }),
    { running: false },
  );
  check(
    "Q2: a held queue says why",
    ui.frame().includes("Up next · 2 queued · held: stopped"),
    true,
  );
  check("Q2: and marks held messages", ui.frame().includes("1. 󰏤 first"), true);
  await ui.press(() => ui.kitty(TAB));
  check("Q2: send now is offered while nothing runs", ui.frame().includes("s send now"), true);
  await ui.press(() => ui.arrow("B"));
  await ui.press(() => {
    ui.kitty(s);
    for (let index = 0; index < 4; index += 1) ui.kitty(s, 1, 2);
  });
  const starts = ui.calls.filter((call) => call.type === "queue.resume");
  check(
    "Q2: s sends queued-run.start for the selected one, once however long it's held",
    starts.length,
    1,
  );
  check("Q2: for that run", starts[0]?.input.runId, "b");
  await ui.close();
}

async function checkReorderRemoveEdit() {
  const ui = await mount(queueOf(THREE));
  await ui.press(() => ui.kitty(TAB));
  await ui.press(() => ui.arrow("B"));
  await ui.press(() => ui.arrow("B", 2));
  const reorder = ui.calls.find((call) => call.type === "queued-run.reorder");
  check("Q3: Shift+↓ moves the selected one down: last", reorder?.input.beforeRunId, null);
  check("Q3: it's the second", reorder?.input.runId, "b");
  check(
    "Q3: the list shows the new order",
    /2\. 󰒲 and add[\s\S]*3\. 󰒲 then fix/u.test(ui.frame()),
    true,
  );
  check("Q3: the selection follows the moved message", ui.frame().includes("› 3."), true);
  await ui.press(() => ui.arrow("A", 2));
  check(
    "Q3: Shift+↑ moves it back up",
    ui.calls.filter((call) => call.type === "queued-run.reorder").at(-1)?.input.beforeRunId,
    "c",
  );

  // Remove asks once.
  await ui.press(() => ui.kitty(x));
  check("Q4: x asks first", ui.frame().includes("Remove? x again"), true);
  check(
    "Q4: and sends nothing yet",
    ui.calls.some((call) => call.type === "queued-run.cancel"),
    false,
  );
  await ui.press(() => {
    ui.kitty(x);
    for (let index = 0; index < 3; index += 1) ui.kitty(x, 1, 2);
  });
  const cancels = ui.calls.filter((call) => call.type === "queued-run.cancel");
  check("Q4: x again removes it, once", cancels.length, 1);
  check("Q4: the message it removed", cancels[0]?.input.runId, "b");
  check("Q4: two left", ui.frame().includes("Up next · 2 queued"), true);

  // Edit in place.
  await ui.press(() => ui.arrow("A"));
  await ui.press(() => ui.kitty(ENTER));
  check(
    "Q5: Enter opens the selected one in the editor",
    ui.frame().includes("󰏫 explain the failing test"),
    true,
  );
  await ui.press(() => ui.type(" first"));
  await ui.press(() => ui.kitty(ENTER));
  const edit = ui.calls.find((call) => call.type === "queued-run.edit");
  check(
    "Q5: Enter saves it with queued-run.edit",
    edit?.input.text,
    "explain the failing test first",
  );
  check(
    "Q5: the list shows the edit",
    ui.frame().includes("1. 󰒲 explain the failing test first"),
    true,
  );
  check("Q5: the composer stayed empty", ui.store.getDraft(threadId).text, "");

  // Steer now.
  await ui.press(() => ui.kitty(s));
  const steer = ui.calls.find((call) => call.type === "queued-message.promote-to-steer");
  check("Q6: s steers the run with it", steer?.input.queuedRunId, "a");
  check("Q6: the run it steers", steer?.input.targetRunId, ACTIVE);
  check("Q6: one left", ui.frame().includes("Up next · 1 queued"), true);
  await ui.close();
}

async function checkStaleEdit() {
  const ui = await mount(queueOf(THREE));
  await ui.press(() => ui.kitty(TAB));
  await ui.press(() => ui.kitty(ENTER));
  await ui.press(() => ui.type(" now"));
  // Another client started it.
  await ui.press(() => ui.update(THREE.slice(1)));
  check(
    "Q7: an edit whose message started elsewhere goes to the composer",
    ui.store.getDraft(threadId).text,
    "explain the failing test now",
  );
  check(
    "Q7: and says so",
    ui.frame().includes("That message already started; your edit is here"),
    true,
  );
  check("Q7: nothing was sent", ui.calls.length, 0);
  // The remaining two are still manageable; a stale selection goes nowhere.
  check("Q7: two left", ui.frame().includes("Up next · 2 queued"), true);
  await ui.close();
}

async function checkShortcutsAndTyping() {
  const ui = await mount(queueOf(THREE));
  // Upstream's thread.editQueuedMessage: Alt+↑ in the composer.
  await ui.press(() => ui.arrow("A", 3));
  check(
    "Q8: Alt+↑ in the composer opens the last queued message",
    ui.frame().includes("󰏫 and add a regression test"),
    true,
  );
  check("Q8: with the list focused", ui.focus, "queue");
  await ui.press(() => ui.kitty(ESC));
  check("Q8: Esc cancels the edit and sends nothing", ui.calls.length, 0);
  // Upstream's thread.steerQueuedMessage: Cmd+Shift+Enter from anywhere.
  await ui.press(() => ui.kitty(ENTER, 10));
  const steer = ui.calls.find((call) => call.type === "queued-message.promote-to-steer");
  check("Q8: Cmd+Shift+Enter steers with the first queued message", steer?.input.queuedRunId, "a");
  // Typing in the list goes to the composer.
  await ui.press(() => ui.type("h"));
  check("Q9: a letter typed in the list goes to the composer", ui.focus, "composer");
  await ui.press(() => ui.type("i"));
  check("Q9: and the rest follows", ui.store.getDraft(threadId).text, "hi");
  await ui.close();
}

async function checkNoDuplicateRows() {
  const ui = await mount(queueOf([]));
  const send: ComposerSend = {
    target: { kind: "thread", threadId, projectId: ProjectId.make("p") },
    commandId: CommandId.make("cmd-pending"),
    messageId: MessageId.make("msg-pending"),
    text: "pending follow-up",
    attachments: [],
    dispatch: "queue",
    settings,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
  await ui.press(() => ui.store.beginSend(send));
  check(
    "Q10: a send still on its way shows in the composer",
    ui.frame().includes("pending follow-up"),
    true,
  );
  // The server queued it before its reply came back.
  await ui.press(() =>
    ui.update([{ ...row("p", "pending follow-up"), messageId: MessageId.make("msg-pending") }]),
  );
  const shown = ui.frame().split("pending follow-up").length - 1;
  check("Q10: once the server lists it, it shows once, in the queue", shown, 1);
  check("Q10: as queued", ui.frame().includes("1. 󰒲 pending follow-up"), true);
  await ui.close();
}

await checkList();
await checkHeld();
await checkReorderRemoveEdit();
await checkStaleEdit();
await checkShortcutsAndTyping();
await checkNoDuplicateRows();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
