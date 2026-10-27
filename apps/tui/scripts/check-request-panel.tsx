// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
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

import { PANEL_ARM_DELAY_MS } from "../src/requestPanel.ts";
import { createRequestPanelStore } from "../src/requestPanelStore.ts";
import { RequestPanel, type RequestPanelHandle } from "../src/requestPanelView.tsx";
import { deriveRequestQueue } from "../src/requestQueue.ts";
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

function Harness(props: {
  readonly panel: RefObject<RequestPanelHandle | null>;
  readonly children: React.ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    if (props.panel.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children}</>;
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
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
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
  const store = createRequestPanelStore();
  const panel = createRef<RequestPanelHandle>();
  const setup = await testRender(
    <Harness panel={panel}>
      <RequestPanel
        ref={panel}
        threadId={threadId}
        queue={queue}
        store={store}
        responder={responder}
        theme={DEFAULT_TUI_THEME}
        focused
        cwd="/tmp/repo"
        onFocus={() => undefined}
        onStatus={() => undefined}
        onHints={() => undefined}
      />
    </Harness>,
    { width: 72, height: 16 },
  );
  await settle(setup.renderOnce);
  let frame = setup.captureCharFrame();
  check("P1: the approval shows its command", frame.includes("$ ls -la"), true);
  check("P1: and where it runs", frame.includes("in /tmp/repo"), true);
  check("P1: and which of two requests it is", frame.includes("[ 1/2 ]"), true);

  // A key typed for the composer as the panel replaced it doesn't approve.
  act(() => setup.mockInput.pressKey("y"));
  await settle(setup.renderOnce);
  check("P2: y right away is ignored", calls.length, 0);

  await act(() => new Promise((resolve) => setTimeout(resolve, PANEL_ARM_DELAY_MS)));
  act(() => setup.mockInput.pressKey("y"));
  await settle(setup.renderOnce);
  check("P2: y once armed approves once", calls[0]?.input.decision, "accept");
  check("P2: for the shown request", calls[0]?.input.requestId, "approve-ls");
  frame = setup.captureCharFrame();
  check("P3: the panel moves on to the question", frame.includes("Question · Header color"), true);

  await act(() => new Promise((resolve) => setTimeout(resolve, PANEL_ARM_DELAY_MS)));
  // ↓↓ reaches the text row; typing goes to the text box, Enter submits it.
  act(() => {
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
  });
  await settle(setup.renderOnce);
  await act(() => setup.mockInput.typeText("Green"));
  await settle(setup.renderOnce);
  check("P4: typed text lands in the answer box", setup.captureCharFrame().includes("Green"), true);
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("P4: Enter submits the typed answer", calls[1]?.kind, "answers");
  check(
    "P4: with the text as the answer",
    JSON.stringify(calls[1]?.input.answers),
    JSON.stringify({ color: "Green" }),
  );
  check(
    "P5: the answered question shows its answer on the way",
    setup.captureCharFrame().includes("Answered: Green"),
    true,
  );
  setup.renderer.destroy();
  responder.dispose();
}

await checkApprovalThenQuestion();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
