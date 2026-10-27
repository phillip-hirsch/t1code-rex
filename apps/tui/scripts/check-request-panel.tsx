// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real ComposerDock (composer and request panel) under OpenTUI with the kitty
 * keyboard protocol, as in Rex: Cmd parses as `super`, a held key's repeats as `repeated`.
 * Needs Bun. Run: bun apps/tui/scripts/check-request-panel.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { act, createRef, useImperativeHandle, useRef, useState } from "react";

import { NO_MENTION_SEARCH_SOURCE } from "../src/composer.tsx";
import { ComposerDock, type ComposerDockHandle, type DockFocus } from "../src/composerDock.tsx";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../src/composerSend.ts";
import { QUIT_NOTICE } from "../src/composerSender.ts";
import { createComposerSender, type ComposerCommandResult } from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore } from "../src/composerStore.ts";
import { PANEL_QUIET_MS } from "../src/requestPanel.ts";
import { createRequestPanelStore } from "../src/requestPanelStore.ts";
import {
  NO_PENDING_REQUESTS,
  deriveRequestQueue,
  type PendingRequest,
} from "../src/requestQueue.ts";
import { createRedirectDecliner } from "../src/requestRedirect.ts";
import { createRequestResponder } from "../src/requestResponder.ts";
import {
  approvalItem,
  item,
  node,
  question,
  questionItem,
  runtimeRequest,
  source,
} from "../src/requestTestFixtures.ts";
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

async function settle(render: () => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => render());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

const threadId = ThreadId.make("thread-requests");
const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** A command approval for `ls > listing.txt`, in run `run-1`. */
function approval(
  id = "approve-ls",
  fields: { second?: number; capability?: Record<string, unknown> } = {},
) {
  return {
    runtimeRequests: [runtimeRequest(id, "command", fields)],
    nodes: [node(`node-${id}`, "approval_request", "node-tool", "run-1")],
    turnItems: [
      item("tool", "node-tool", { type: "command_execution", input: "ls > listing.txt" }),
      approvalItem(id, { prompt: "Write the listing" }),
    ],
  };
}

type Call = { kind: string; input: Record<string, unknown> };

interface Controls {
  readonly setQueue: (queue: ReadonlyArray<PendingRequest>) => void;
  readonly focus: DockFocus;
}

/** Mirrors ui.tsx: focus state, the shell's keyboard hook, and the dock under it. */
function Shell(props: {
  readonly initialQueue: ReadonlyArray<PendingRequest>;
  readonly controls: React.RefObject<Controls | null>;
  readonly keys: KeyEvent[];
  readonly dock: (
    queue: ReadonlyArray<PendingRequest>,
    focus: DockFocus,
    setFocus: (focus: DockFocus) => void,
    ref: React.RefObject<ComposerDockHandle | null>,
  ) => React.ReactNode;
}) {
  const [queue, setQueue] = useState(props.initialQueue);
  const [focus, setFocus] = useState<DockFocus>("composer");
  const ref = useRef<ComposerDockHandle | null>(null);
  useImperativeHandle(props.controls, () => ({ setQueue, focus }), [focus]);
  useSyncKeyboard((key: KeyEvent) => {
    props.keys.push(key);
    if (ref.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.dock(queue, focus, setFocus, ref)}</>;
}

async function mount(
  initialQueue: ReadonlyArray<PendingRequest>,
  options: {
    running?: boolean;
    stopRequested?: boolean;
    stopSentRunId?: string | null;
    /** Replies to approval responses, in order; ok once they run out. */
    approvalReplies?: Array<Promise<ComposerCommandResult> | ComposerCommandResult>;
  } = {},
) {
  const approvalReplies = [...(options.approvalReplies ?? [])];
  /** What the thread has pending now, as ui.tsx reads it from the live projection. */
  let liveQueue = initialQueue;
  const calls: Call[] = [];
  const turns: StartThreadTurnInput[] = [];
  const outcomes: string[] = [];
  const keys: KeyEvent[] = [];
  const hints: string[] = [];
  const statuses: string[] = [];
  const responder = createRequestResponder({
    respondToApproval: (input) => {
      calls.push({ kind: "approval", input: { ...input } });
      return Promise.resolve(approvalReplies.shift() ?? { ok: true });
    },
    respondToUserInput: (input) => {
      calls.push({ kind: "answers", input: { ...input } });
      return Promise.resolve({ ok: true });
    },
    dismissUserInput: () => Promise.resolve({ ok: true }),
    schedule: () => () => undefined,
  });
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      turns.push(input);
      return Promise.resolve({ ok: true });
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    resumeQueue: () => {
      calls.push({ kind: "queue.resume", input: {} });
      return Promise.resolve({ ok: true });
    },
    // As ui.tsx: a message's declines run as a stage of its sender job.
    declineApprovals: createRedirectDecliner({
      responder,
      pendingApprovalIds: () =>
        liveQueue.flatMap((request) => (request.kind === "approval" ? [request.requestId] : [])),
    }),
    schedule: () => () => undefined,
  });
  const panelStore = createRequestPanelStore();
  const handle = createRef<Controls>();
  const controls = {
    // A request resolving drops it from the queue and prunes it, as onThreadRequestsResolved.
    setQueue: (queue: ReadonlyArray<PendingRequest>) => {
      liveQueue = queue;
      const pending = queue.map((request) => request.requestId);
      responder.prune(threadId, pending);
      panelStore.prune(threadId, pending);
      handle.current?.setQueue(queue);
    },
    get focus() {
      return handle.current?.focus ?? null;
    },
  };
  const setup = await testRender(
    <Shell
      initialQueue={initialQueue}
      controls={handle}
      keys={keys}
      dock={(queue, focus, setFocus, ref) => (
        <ComposerDock
          ref={ref}
          composer={{
            target: { kind: "thread", threadId, projectId: ProjectId.make("p") },
            store,
            theme: DEFAULT_TUI_THEME,
            baseSettings: settings,
            followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
            modelLabel: () => "Claude Haiku 5.5",
            providerBadge: () => ({ icon: "✱", color: "#ffffff" }),
            running: options.running ?? true,
            stopRequested: options.stopRequested ?? false,
            clipboardDir: "/tmp",
            // As ui.tsx's stopRun: unsent messages wait until resumed.
            onStop: () => {
              outcomes.push("stop");
              sender.hold(threadId);
            },
            onExit: () => outcomes.push("exit"),
            onNewThread: () => undefined,
            onOpenModelPicker: () => undefined,
            onSetInteractionMode: () => undefined,
            onSetRuntimeMode: () => undefined,
            onStatus: (status) => {
              statuses.push(status);
            },
            onClone: async () => null,
            mentionSearch: NO_MENTION_SEARCH_SOURCE,
          }}
          sender={sender}
          requests={{
            queue,
            store: panelStore,
            responder,
            cwd: "/tmp/repo",
            stopSentRunId: options.stopSentRunId ?? null,
            onHints: (hint) => {
              hints.push(hint);
            },
          }}
          focus={focus}
          onFocus={setFocus}
          onPanelShown={() => undefined}
        />
      )}
    />,
    { width: 76, height: 26, kittyKeyboard: true, exitOnCtrlC: false },
  );
  await settle(setup.renderOnce);
  const frame = () => setup.captureCharFrame();
  const press = async (fn: () => unknown) => {
    await act(async () => fn());
    await settle(setup.renderOnce);
  };
  /**
   * Raw kitty key events: `CSI code ; mods : type u`, type 1 a press, 2 a repeat; mods 1 is
   * none, 5 is Ctrl.
   */
  const kitty = (code: number, type: 1 | 2, mods: 1 | 5 = 1) =>
    setup.renderer.stdin.emit("data", Buffer.from(`\x1b[${code};${mods}:${type}u`));
  const close = async () => {
    await act(async () => {
      responder.dispose();
      sender.dispose();
      setup.renderer.destroy();
    });
  };
  return {
    setup,
    store,
    sender,
    responder,
    calls,
    turns,
    outcomes,
    statuses,
    keys,
    hints,
    controls,
    frame,
    press,
    kitty,
    close,
  };
}

const decisions = (calls: ReadonlyArray<Call>) =>
  calls.map((call) => String(call.input.decision ?? call.kind)).join(",");

/**
 * N1, Sol's repro: type a draft, the request appears, pause, Enter meaning to send, then
 * type "yes". Nothing is approved and the draft is sent; then Tab and `y` approve.
 */
async function checkTypingThenRequest(): Promise<void> {
  const dock = await mount(NO_PENDING_REQUESTS);
  const { setup, calls, turns, controls, frame, press } = dock;
  await act(() => setup.mockInput.typeText("please also update the ", 30));
  await act(async () => controls.setQueue(deriveRequestQueue(source(approval()))));
  await act(() => setup.mockInput.typeText("README", 30));
  await settle(setup.renderOnce);
  check(
    "N1: the draft stays in the composer",
    frame().includes("please also update the README"),
    true,
  );
  check(
    "N1: the request that came mid-typing waits out of view",
    frame().includes("ls > listing.txt"),
    false,
  );
  await wait(PANEL_QUIET_MS + 50);
  await press(() => setup.mockInput.pressEnter());
  await act(() => setup.mockInput.typeText("yes", 30));
  await settle(setup.renderOnce);
  check("N1: Enter sent the draft", turns[0]?.message.text, "please also update the README");
  // A plain follow-up: Enter while busy uses the follow-up default (steer, as upstream).
  check(
    "N1: as a plain follow-up, the request having been out of view",
    turns[0]?.dispatchMode,
    DEFAULT_FOLLOW_UP_BEHAVIOR,
  );
  check("N1: nothing was approved or declined", calls.length, 0);
  check("N1: yes went into the composer", frame().includes("yes"), true);
  check("N1: the request shows after the send", frame().includes("$ ls > listing.txt"), true);
  check("N1: saying Tab reaches it", frame().includes("Tab to respond"), true);
  check("N1: focus stayed in the composer", controls.focus, "composer");

  await wait(PANEL_QUIET_MS + 50);
  await press(() => setup.mockInput.pressTab());
  check("N1: Tab moves focus to the panel", controls.focus, "requests");
  await press(() => setup.mockInput.pressKey("y"));
  check("N1: then y approves once", decisions(calls), "accept");
  check("N1: and the composer kept its text", frame().includes("yes"), true);
  await dock.close();
}

/** Web's redirect: a message sent while an approval is in view declines it and steers. */
async function checkSendDeclines(): Promise<void> {
  const dock = await mount(deriveRequestQueue(source(approval())));
  const { setup, calls, turns, press } = dock;
  await wait(50);
  await act(() => setup.mockInput.typeText("use a temp file instead", 20));
  await press(() => setup.mockInput.pressEnter());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await settle(setup.renderOnce);
  check("R1: the shown approval is declined", decisions(calls), "decline");
  check("R1: then the message steers the run", turns[0]?.dispatchMode, "steer");
  check("R1: with its text", turns[0]?.message.text, "use a temp file instead");
  await dock.close();
}

/** Tab before the request settles opens the panel disengaged; Esc goes back. */
async function checkEarlyTab(): Promise<void> {
  const dock = await mount(deriveRequestQueue(source(approval())));
  const { setup, calls, controls, frame, press } = dock;
  await press(() => setup.mockInput.pressTab());
  check("T1: an early Tab still moves focus", controls.focus, "requests");
  check("T1: but the panel waits for Enter", frame().includes("Press ⏎ to respond"), true);
  await press(() => setup.mockInput.pressKey("y"));
  check("T1: so y decides nothing", calls.length, 0);
  await press(() => setup.mockInput.pressEscape());
  check("T1: Esc goes back to the composer", controls.focus, "composer");
  await press(() => setup.mockInput.pressKey("y"));
  check("T1: where y is just text", frame().includes("y"), true);
  check("T1: still nothing decided", calls.length, 0);

  // Cmd, Alt and Ctrl shortcuts never decide, even engaged.
  await wait(PANEL_QUIET_MS + 50);
  await press(() => setup.mockInput.pressTab());
  check("T2: a Tab once it settled engages", frame().includes("Press ⏎"), false);
  await press(() => {
    setup.mockInput.pressKey("s", { super: true });
    setup.mockInput.pressKey("a", { super: true });
    setup.mockInput.pressKey("y", { super: true });
    setup.mockInput.pressKey("y", { meta: true });
    setup.mockInput.pressKey("s", { ctrl: true });
  });
  check(
    "T2: OpenTUI parsed Cmd+S with super",
    dock.keys.some((key) => key.name === "s" && key.super),
    true,
  );
  check("T2: Cmd+S, Cmd+A, Cmd+Y, Alt+Y, Ctrl+S decide nothing", calls.length, 0);
  await dock.close();
}

/** N4: a held key's kitty repeats never engage, pick, decide or submit. */
async function checkHeldKeys(): Promise<void> {
  const ENTER = 13;
  const TAB = 9;
  const Y = 121;
  const dock = await mount(
    deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("pick-color", "user_input")],
        turnItems: [questionItem("pick-color", [question("color", ["Red", "Blue"])])],
      }),
    ),
  );
  const { calls, controls, frame, press, kitty } = dock;
  // Held Tab: enters once; its repeats don't bounce focus back.
  await press(() => {
    kitty(TAB, 1);
    for (let index = 0; index < 5; index += 1) kitty(TAB, 2);
  });
  check("N4: OpenTUI parsed the repeats", dock.keys.filter((key) => key.repeated).length, 5);
  check("N4: a held Tab leaves focus in the panel", controls.focus, "requests");
  check("N4: which, entered early, waits for Enter", frame().includes("Press ⏎ to respond"), true);
  // Held Enter: the press engages; its repeats must not submit the highlighted Red.
  await wait(PANEL_QUIET_MS + 50);
  await press(() => {
    kitty(ENTER, 1);
    for (let index = 0; index < 10; index += 1) kitty(ENTER, 2);
  });
  check("N4: the held Enter engaged the panel", frame().includes("Press ⏎"), false);
  check("N4: and its repeats answered nothing", calls.length, 0);
  await press(() => kitty(ENTER, 1));
  check(
    "N4: a fresh Enter answers",
    JSON.stringify(calls[0]?.input.answers),
    JSON.stringify({ color: "Red" }),
  );
  await dock.close();

  const approvalDock = await mount(deriveRequestQueue(source(approval())));
  await wait(PANEL_QUIET_MS + 50);
  await approvalDock.press(() => approvalDock.setup.mockInput.pressTab());
  await approvalDock.press(() => {
    for (let index = 0; index < 5; index += 1) approvalDock.kitty(Y, 2);
  });
  check("N4: y's repeats alone approve nothing", approvalDock.calls.length, 0);
  await approvalDock.press(() => approvalDock.kitty(Y, 1));
  check("N4: a fresh y approves", decisions(approvalDock.calls), "accept");
  await approvalDock.close();
}

/** N3: after Stop, the approval can only be declined, and the composer still works. */
async function checkStopped(): Promise<void> {
  const dock = await mount(deriveRequestQueue(source(approval())), {
    running: false,
    stopSentRunId: "run-1",
  });
  const { setup, calls, frame, press } = dock;
  check(
    "N3: the panel says the run stopped",
    frame().includes("Run stopped; this can only be declined"),
    true,
  );
  check("N3: approve choices are gone", frame().includes("Approve"), false);
  check("N3: decline is left", frame().includes("1 Decline (n)"), true);
  check("N3: the composer is still there", frame().includes("Ask for follow-up changes"), true);
  await wait(PANEL_QUIET_MS + 50);
  await press(() => setup.mockInput.pressTab());
  check(
    "N3: and, focused, why",
    frame().includes("Run stopped. This request can only be declined to clear it"),
    true,
  );
  await press(() => {
    setup.mockInput.pressKey("y");
    setup.mockInput.pressKey("s");
    setup.mockInput.pressKey("2");
  });
  check("N3: y, s and 2 approve nothing", calls.length, 0);
  await press(() => setup.mockInput.pressKey("1"));
  check("N3: 1 declines it", decisions(calls), "decline");
  await dock.close();

  // The run's own status says it ended, with no stop sent from here (another client).
  const ended = await mount(
    deriveRequestQueue(
      source({ ...approval(), runs: [{ id: RunId.make("run-1"), status: "interrupted" }] }),
    ),
    { running: false },
  );
  check("N3: a run stopped elsewhere counts too", ended.frame().includes("Run stopped"), true);
  await ended.close();
}

/** N2: an approval that can't be answered doesn't trap the keyboard. */
async function checkUnanswerable(): Promise<void> {
  const gone = approval("gone", { second: 1, capability: { type: "not_resumable", reason: "x" } });
  const next = approval("next", { second: 2 });
  const dock = await mount(
    deriveRequestQueue(
      source({
        runtimeRequests: [...gone.runtimeRequests, ...next.runtimeRequests],
        nodes: [...gone.nodes, ...next.nodes],
        turnItems: [...gone.turnItems, ...next.turnItems.slice(1)],
      }),
    ),
  );
  const { setup, frame, press } = dock;
  check("N2: the unanswerable one shows first", frame().includes("can't be answered"), true);
  await press(() => setup.mockInput.pressTab());
  await press(() => setup.mockInput.pressKey("]"));
  check("N2: ] steps to the next one", frame().includes("[ 2/2 ]"), true);
  await dock.close();
}

/** A question answered with typed text; a multi-select pick replaced by typing. */
async function checkQuestions(): Promise<void> {
  const dock = await mount(
    deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("pick-many", "user_input")],
        turnItems: [
          questionItem("pick-many", [question("tools", ["Vim", "Emacs"], { multiSelect: true })]),
        ],
      }),
    ),
  );
  const { setup, calls, frame, press } = dock;
  await wait(PANEL_QUIET_MS + 50);
  await press(() => setup.mockInput.pressTab());
  await press(() => {
    setup.mockInput.pressKey("1");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
  });
  check("Q1: multi-select: Vim is picked", frame().includes("■ Vim"), true);
  await act(() => setup.mockInput.typeText("Nano"));
  await settle(setup.renderOnce);
  check("Q1: typing Nano clears the pick", frame().includes("□ Vim"), true);
  await press(() => setup.mockInput.pressEnter());
  check(
    "Q1: the typed answer is sent",
    JSON.stringify(calls[0]?.input.answers),
    JSON.stringify({ tools: "Nano" }),
  );
  check("Q1: and shown on its way", frame().includes("Answered: Nano"), true);
  await dock.close();
}

/** Ctrl+C in the panel stops the run, then quits once a stop was sent. */
async function checkStop(): Promise<void> {
  const queue = deriveRequestQueue(source(approval()));
  const running = await mount(queue, { running: true });
  await running.press(() => running.setup.mockInput.pressTab());
  check("S1: the footer offers stop", running.hints.at(-1)?.includes("^C stop"), true);
  await running.press(() => running.setup.mockInput.pressCtrlC());
  check("S1: Ctrl+C stops the run, engaged or not", running.outcomes.join(","), "stop");
  await running.close();

  const stopping = await mount(queue, { running: true, stopRequested: true });
  await stopping.press(() => stopping.setup.mockInput.pressTab());
  await stopping.press(() => stopping.setup.mockInput.pressCtrlC());
  check("S1: Ctrl+C after a stop quits", stopping.outcomes.join(","), "exit");
  await stopping.close();
}

type Dock = Awaited<ReturnType<typeof mount>>;

/** A reply the check sends when it chooses, to force an interleaving. */
function deferredReply() {
  let resolve!: (result: ComposerCommandResult) => void;
  const promise = new Promise<ComposerCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sentTexts = (turns: ReadonlyArray<StartThreadTurnInput>) =>
  turns.map((turn) => `${turn.message.text} (${turn.dispatchMode})`).join(", ");

async function typeAndSend(dock: Dock, text: string): Promise<void> {
  await act(() => dock.setup.mockInput.typeText(text, 5));
  await dock.press(() => dock.setup.mockInput.pressEnter());
}

/** The approval's decline gets its reply, and the thread drops the approval. */
async function declineLands(dock: Dock, reply: ReturnType<typeof deferredReply>): Promise<void> {
  await act(async () => reply.resolve({ ok: true }));
  await act(async () => dock.controls.setQueue(NO_PENDING_REQUESTS));
  await settle(dock.setup.renderOnce);
}

/** Round 3, N5: two messages while an approval is shown: one decline, then both, in order. */
async function checkRedirectOrder(): Promise<void> {
  const reply = deferredReply();
  const dock = await mount(deriveRequestQueue(source(approval())), {
    approvalReplies: [reply.promise],
  });
  await wait(50);
  await typeAndSend(dock, "message A");
  await typeAndSend(dock, "message B");
  check("R2: the shown approval's decline goes out", decisions(dock.calls), "decline");
  check("R2: no message passes it", sentTexts(dock.turns), "");
  check("R2: both count as unsent", dock.sender.pendingCount(), 2);
  await declineLands(dock, reply);
  check(
    "R2: then both go, in order",
    sentTexts(dock.turns),
    "message A (steer), message B (steer)",
  );
  check("R2: having declined once", decisions(dock.calls), "decline");
  await dock.close();
}

/** Round 3, N5: Stop during the decline holds the message until resumed. */
async function checkStopDuringDecline(): Promise<void> {
  const reply = deferredReply();
  const dock = await mount(deriveRequestQueue(source(approval())), {
    approvalReplies: [reply.promise],
  });
  await wait(50);
  await typeAndSend(dock, "use a temp file");
  await dock.press(() => dock.setup.mockInput.pressCtrlC());
  check("R3: Ctrl+C stops the run", dock.outcomes.join(","), "stop");
  await declineLands(dock, reply);
  check("R3: the message is held, not sent", sentTexts(dock.turns), "");
  check("R3: nothing resumes the server's queue", decisions(dock.calls), "decline");
  check("R3: the composer shows it held", dock.store.snapshot(threadId).sends[0]?.status, "held");
  await typeAndSend(dock, "/resume");
  check(
    "R3: /resume releases the server's queue first",
    decisions(dock.calls),
    "decline,queue.resume",
  );
  check("R3: then sends it", sentTexts(dock.turns), "use a temp file (steer)");
  await dock.close();
}

/** Round 3, N5: quitting during the decline puts the message back in the composer. */
async function checkQuitDuringDecline(): Promise<void> {
  const reply = deferredReply();
  const dock = await mount(deriveRequestQueue(source(approval())), {
    approvalReplies: [reply.promise],
  });
  await wait(50);
  await typeAndSend(dock, "keep this text");
  check("R4: quit sees one unsent message", dock.sender.pendingCount(), 1);
  await act(async () => dock.sender.handOff());
  check("R4: it's back in the composer", dock.store.getDraft(threadId).text, "keep this text");
  check("R4: saying why", dock.store.snapshot(threadId).notice, QUIT_NOTICE);
  await declineLands(dock, reply);
  check("R4: and it never went out", sentTexts(dock.turns), "");
  await dock.close();
}

/** Round 3, N5: /discard during the decline hands the message back. */
async function checkDiscardDuringDecline(): Promise<void> {
  const reply = deferredReply();
  const dock = await mount(deriveRequestQueue(source(approval())), {
    approvalReplies: [reply.promise],
  });
  await wait(50);
  await typeAndSend(dock, "drop me");
  await typeAndSend(dock, "/discard");
  check("R5: /discard finds it", dock.statuses.at(-1), "1 unsent message back in the composer");
  check("R5: it's back in the composer", dock.store.getDraft(threadId).text, "drop me");
  await declineLands(dock, reply);
  check("R5: and it never went out", sentTexts(dock.turns), "");
  await dock.close();
}

/** Round 3, N5: a turned-down decline keeps the text and says why, here and in the panel. */
async function checkDeclineRejected(): Promise<void> {
  const dock = await mount(deriveRequestQueue(source(approval())), {
    approvalReplies: [
      {
        ok: false,
        error: new Error("Runtime request approve-ls is resolved."),
        interrupted: false,
      },
    ],
  });
  await wait(50);
  await typeAndSend(dock, "try this instead");
  check("R6: nothing was sent", sentTexts(dock.turns), "");
  check("R6: the text is back", dock.store.getDraft(threadId).text, "try this instead");
  check(
    "R6: with why",
    dock.store.snapshot(threadId).notice,
    "Not sent: declining the approval didn't go through (Runtime request approve-ls is resolved.)",
  );
  check("R6: the panel says it too", dock.frame().includes("Not sent: Runtime request"), true);
  await dock.close();
}

/** Round 3, N6: with a question on screen, a send declines no approval behind it. */
async function checkSendDeclinesOnlyShown(): Promise<void> {
  const later = approval("approve-ls", { second: 1 });
  const dock = await mount(
    deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("pick-color", "user_input"), ...later.runtimeRequests],
        nodes: later.nodes,
        turnItems: [
          questionItem("pick-color", [question("color", ["Red", "Blue"])]),
          ...later.turnItems,
        ],
      }),
    ),
  );
  await wait(50);
  check("N6: the question is on screen", dock.frame().includes("Question"), true);
  check("N6: the approval isn't", dock.frame().includes("$ ls > listing.txt"), false);
  await typeAndSend(dock, "hello");
  await settle(dock.setup.renderOnce);
  check("N6: nothing was declined", decisions(dock.calls), "");
  check(
    "N6: the message went as usual",
    sentTexts(dock.turns),
    `hello (${DEFAULT_FOLLOW_UP_BEHAVIOR})`,
  );
  await dock.close();
}

/** Round 3, N4: a held Ctrl+C's repeats never stop the run or quit, in either part. */
async function checkHeldCtrlC(): Promise<void> {
  const C = 99;
  const CTRL = 5;
  const composer = await mount(NO_PENDING_REQUESTS, { running: true });
  await act(() => composer.setup.mockInput.typeText("a draft", 5));
  await composer.press(() => {
    composer.kitty(C, 1, CTRL);
    for (let index = 0; index < 5; index += 1) composer.kitty(C, 2, CTRL);
  });
  check(
    "N4: OpenTUI parsed held Ctrl+C",
    composer.keys.filter((key) => key.ctrl && key.name === "c" && key.repeated).length,
    5,
  );
  check("N4: in the composer, Ctrl+C clears the draft", composer.store.getDraft(threadId).text, "");
  check("N4: and its repeats don't stop the run", composer.outcomes.join(","), "");
  await composer.press(() => {
    composer.kitty(C, 1, CTRL);
    for (let index = 0; index < 5; index += 1) composer.kitty(C, 2, CTRL);
  });
  check("N4: a fresh Ctrl+C stops, once", composer.outcomes.join(","), "stop");
  await composer.close();

  const panel = await mount(deriveRequestQueue(source(approval())), { running: true });
  await panel.press(() => panel.setup.mockInput.pressTab());
  check("N4: the panel has focus", panel.controls.focus, "requests");
  await panel.press(() => {
    panel.kitty(C, 1, CTRL);
    for (let index = 0; index < 5; index += 1) panel.kitty(C, 2, CTRL);
  });
  check(
    "N4: in the panel, held Ctrl+C stops once and doesn't quit",
    panel.outcomes.join(","),
    "stop",
  );
  await panel.close();
}

await checkTypingThenRequest();
await checkSendDeclines();
await checkEarlyTab();
await checkHeldKeys();
await checkStopped();
await checkUnanswerable();
await checkQuestions();
await checkStop();
await checkRedirectOrder();
await checkStopDuringDecline();
await checkQuitDuringDecline();
await checkDiscardDuringDecline();
await checkDeclineRejected();
await checkSendDeclinesOnlyShown();
await checkHeldCtrlC();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
