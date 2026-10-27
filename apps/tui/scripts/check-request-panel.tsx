// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real request panel under OpenTUI's renderer, which needs Bun (Vitest runs on
 * Node). Keys reach it the way ui.tsx routes them: the shell's keyboard hook calls its
 * handle first, and what it leaves goes to the focused text box.
 *
 *   bun apps/tui/scripts/check-request-panel.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { ThreadId } from "@t3tools/contracts";
import { act, createRef, type RefObject } from "react";

import { PANEL_QUIET_MS } from "../src/requestPanel.ts";
import { createRequestPanelStore } from "../src/requestPanelStore.ts";
import { RequestPanel, type RequestPanelHandle } from "../src/requestPanelView.tsx";
import { deriveRequestQueue, type PendingRequest } from "../src/requestQueue.ts";
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
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

const threadId = ThreadId.make("thread-requests");
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Mirrors ui.tsx: the shell's keyboard hook calls the panel's handle first. */
function Harness(props: {
  readonly panel: RefObject<RequestPanelHandle | null>;
  readonly keys: KeyEvent[];
  readonly children: React.ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    props.keys.push(key);
    if (props.panel.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children}</>;
}

type Call = { kind: string; input: Record<string, unknown> };

async function mount(
  queue: ReadonlyArray<PendingRequest>,
  run: { running: boolean; stopRequested: boolean } = { running: false, stopRequested: false },
) {
  const calls: Call[] = [];
  const outcomes: string[] = [];
  const keys: KeyEvent[] = [];
  const hints: string[] = [];
  const responder = createRequestResponder({
    respondToApproval: (input) => {
      calls.push({ kind: "approval", input: { ...input } });
      return Promise.resolve({ ok: true });
    },
    respondToUserInput: (input) => {
      calls.push({ kind: "answers", input: { ...input } });
      return Promise.resolve({ ok: true });
    },
    dismissUserInput: () => Promise.resolve({ ok: true }),
    schedule: () => () => undefined,
  });
  const panel = createRef<RequestPanelHandle>();
  const setup = await testRender(
    <Harness panel={panel} keys={keys}>
      <RequestPanel
        ref={panel}
        threadId={threadId}
        queue={queue}
        store={createRequestPanelStore()}
        responder={responder}
        theme={DEFAULT_TUI_THEME}
        focused
        cwd="/tmp/repo"
        running={run.running}
        stopRequested={run.stopRequested}
        onFocus={() => undefined}
        onStop={() => outcomes.push("stop")}
        onExit={() => outcomes.push("exit")}
        onStatus={() => undefined}
        onHints={(hint) => {
          hints.push(hint);
        }}
      />
    </Harness>,
    // Kitty keyboard, so Cmd (super) arrives as a parsed modifier, as in Rex or Ghostty.
    { width: 72, height: 18, kittyKeyboard: true, exitOnCtrlC: false },
  );
  await settle(setup.renderOnce);
  const engage = async () => {
    await wait(PANEL_QUIET_MS + 50);
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup.renderOnce);
  };
  const close = async () => {
    await act(async () => {
      responder.dispose();
      setup.renderer.destroy();
    });
  };
  return { setup, calls, outcomes, keys, hints, engage, close };
}

/** A command approval and a question behind it, answered from the keyboard. */
async function checkApprovalThenQuestion(): Promise<void> {
  const queue = deriveRequestQueue(
    source({
      runtimeRequests: [
        runtimeRequest("approve-ls", "command", { second: 1 }),
        runtimeRequest("pick-color", "user_input", { second: 2 }),
      ],
      nodes: [node("node-approve-ls", "approval_request", "node-tool")],
      turnItems: [
        item("tool", "node-tool", { type: "command_execution", input: "ls -la" }),
        approvalItem("approve-ls", { prompt: "Run ls" }),
        questionItem("pick-color", [question("color", ["Red", "Blue"])]),
      ],
    }),
  );
  const { setup, calls, keys, engage, close } = await mount(queue);
  let frame = setup.captureCharFrame();
  check("P1: the approval shows its command", frame.includes("$ ls -la"), true);
  check("P1: and where it runs", frame.includes("in /tmp/repo"), true);
  check("P1: and which of two requests it is", frame.includes("[ 1/2 ]"), true);
  check("P1: and that it waits for Enter", frame.includes("Press ⏎ to respond"), true);

  // Typing carried on from the composer, for well over a second, never answers.
  const started = Date.now();
  await act(() => setup.mockInput.typeText("yes sure, sounds good. y s a 1 2 yes", 60));
  await act(async () => setup.mockInput.pressEnter());
  await act(() => setup.mockInput.typeText("ys", 60));
  await settle(setup.renderOnce);
  check("P2: typing ran for over a second", Date.now() - started > 1_000, true);
  check("P2: and approved nothing", calls.length, 0);
  check(
    "P2: Enter mid-typing didn't engage it",
    setup.captureCharFrame().includes("Press ⏎ to respond"),
    true,
  );

  // A pause, then Enter, engages it; Enter itself decides nothing.
  await engage();
  check("P3: Enter after a pause engages", setup.captureCharFrame().includes("Press ⏎"), false);
  check("P3: and decides nothing", calls.length, 0);

  // Cmd, Alt and Ctrl shortcuts never decide.
  await act(async () => {
    setup.mockInput.pressKey("s", { super: true });
    setup.mockInput.pressKey("a", { super: true });
    setup.mockInput.pressKey("y", { super: true });
    setup.mockInput.pressKey("y", { meta: true });
    setup.mockInput.pressKey("s", { ctrl: true });
  });
  await settle(setup.renderOnce);
  const cmdS = keys.find((key) => key.name === "s" && key.super === true);
  check("P4: OpenTUI parsed Cmd+S with super", cmdS !== undefined, true);
  check("P4: Cmd+S, Cmd+A, Cmd+Y, Alt+Y, Ctrl+S approve nothing", calls.length, 0);

  await act(async () => setup.mockInput.pressKey("y"));
  await settle(setup.renderOnce);
  check("P5: y once engaged approves once", calls[0]?.input.decision, "accept");
  check("P5: for the shown request", calls[0]?.input.requestId, "approve-ls");
  frame = setup.captureCharFrame();
  check("P6: the panel moves on to the question", frame.includes("Question · Header color"), true);
  check("P6: which needs its own Enter", frame.includes("Press ⏎ to respond"), true);
  await act(async () => setup.mockInput.pressKey("2"));
  await settle(setup.renderOnce);
  check("P6: a digit before that picks nothing", setup.captureCharFrame().includes("◉"), false);

  await engage();
  // ↓↓ reaches the text row; typing goes to the text box, Enter submits it.
  await act(async () => {
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
  });
  await settle(setup.renderOnce);
  await act(() => setup.mockInput.typeText("Green"));
  await settle(setup.renderOnce);
  check("P7: typed text lands in the answer box", setup.captureCharFrame().includes("Green"), true);
  await act(async () => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("P7: Enter submits the typed answer", calls[1]?.kind, "answers");
  check(
    "P7: with the text as the answer",
    JSON.stringify(calls[1]?.input.answers),
    JSON.stringify({ color: "Green" }),
  );
  check(
    "P8: the answered question shows its answer on the way",
    setup.captureCharFrame().includes("Answered: Green"),
    true,
  );
  await close();
}

/** With a run going, Esc and Ctrl+C stop it, as in the composer. */
async function checkStop(): Promise<void> {
  const queue = deriveRequestQueue(
    source({
      runtimeRequests: [runtimeRequest("must-answer", "user_input")],
      turnItems: [questionItem("must-answer", [question("color", ["Red", "Blue"])])],
    }),
  );
  const running = await mount(queue, { running: true, stopRequested: false });
  check("P9: the footer offers stop", running.hints.at(-1)?.includes("esc stop"), true);
  await act(async () => running.setup.mockInput.pressEscape());
  await act(async () => running.setup.mockInput.pressCtrlC());
  await settle(running.setup.renderOnce);
  check(
    "P9: Esc and Ctrl+C stop the run, before any Enter",
    running.outcomes.join(","),
    "stop,stop",
  );
  await running.close();

  const stopping = await mount(queue, { running: true, stopRequested: true });
  await act(async () => stopping.setup.mockInput.pressCtrlC());
  await settle(stopping.setup.renderOnce);
  check("P10: Ctrl+C after a stop quits", stopping.outcomes.join(","), "exit");
  await stopping.close();
}

/** A typed answer replaces multi-select picks. */
async function checkMultiSelectTyped(): Promise<void> {
  const queue = deriveRequestQueue(
    source({
      runtimeRequests: [runtimeRequest("pick-many", "user_input")],
      turnItems: [
        questionItem("pick-many", [question("tools", ["Vim", "Emacs"], { multiSelect: true })]),
      ],
    }),
  );
  const { setup, calls, engage, close } = await mount(queue);
  await engage();
  await act(async () => {
    setup.mockInput.pressKey("1");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
  });
  await settle(setup.renderOnce);
  check("P11: multi-select: Vim is picked", setup.captureCharFrame().includes("■ Vim"), true);
  await act(() => setup.mockInput.typeText("Nano"));
  await settle(setup.renderOnce);
  check("P11: typing Nano clears the pick", setup.captureCharFrame().includes("□ Vim"), true);
  await act(async () => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check(
    "P11: the typed answer is sent",
    JSON.stringify(calls[0]?.input.answers),
    JSON.stringify({ tools: "Nano" }),
  );
  await close();
}

await checkApprovalThenQuestion();
await checkStop();
await checkMultiSelectTyped();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
