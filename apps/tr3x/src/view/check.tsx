// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off -- A Bun check script outside the Effect runtime.
/**
 * Drives `tr3x view` end to end: the real daemon's server with the fake providers
 * from `testing/fakeProviders.ts`, and the view's own code in OpenTUI's test
 * renderer. `view.test.ts` runs it; by hand:
 *
 *   bun apps/tr3x/src/view/check.tsx <TR3X_HOME> <workspace> <second provider's request log>
 */
import * as NodeFS from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";

import { resolveTr3xPaths } from "../paths.ts";
import { frameWaiter } from "../testing/frames.ts";
import { mountView, resolveViewServer } from "./main.tsx";
import type { RexStatus } from "./status.ts";

const [home, workspace, requestLog] = process.argv.slice(2);
if (!home || !workspace || !requestLog) {
  console.error("usage: check.tsx <TR3X_HOME> <workspace> <request log>");
  process.exit(2);
}

/** Each step waits at most this long for the server and the fake provider. */
const STEP_TIMEOUT_MS = 15_000;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`ok   ${label}`);
}

const paths = resolveTr3xPaths({ TR3X_HOME: home });
const server = await resolveViewServer(paths, process.env);
const setup = await createTestRenderer({ width: 110, height: 34 });
const frames = frameWaiter(setup, STEP_TIMEOUT_MS);
const statuses: RexStatus[] = [];
const start = await mountView({
  renderer: setup.renderer,
  server,
  target: { kind: "new", cwd: workspace },
  signal: new AbortController().signal,
  onStatus: (status) => {
    statuses.push(status);
    // A report follows the render it describes, so wake the step that waits on it.
    frames.wake();
  },
  onQuit: () => {},
});
if (start.kind !== "mounted") {
  console.log(`FAIL the view didn't start: ${start.kind === "failed" ? start.message : "quit"}`);
  process.exit(1);
}
const view = start.view;
const lastStatus = () => statuses.at(-1);
const describeStatus = (status: RexStatus | undefined) =>
  status === undefined
    ? "none"
    : `${status.state}${status.state === "blocked" ? `:${status.kind}` : ""}`;

/** Waits until the frame and status satisfy `done`; the first step that times out ends the check. */
async function until(label: string, done: (frame: string) => boolean): Promise<string> {
  try {
    const frame = await frames.until(label, done);
    console.log(`ok   ${label}`);
    return frame;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstatus ${describeStatus(lastStatus())}`,
      { cause: error },
    );
  }
}

const press = async (name: string, modifiers?: { ctrl?: boolean }) => {
  setup.mockInput.pressKey(name, modifiers);
  await setup.renderOnce();
};
const send = async (text: string) => {
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await setup.renderOnce();
};

try {
  await until(
    "an empty new-thread view on the default provider",
    (frame) => frame.includes("New thread. Type a message") && frame.includes("Grok · Grok 4.6"),
  );
  await send("What is the code word?");
  await until(
    "the first send launches the thread, and Grok answers",
    (frame) => frame.includes("The code word is PAPAYA.") && lastStatus()?.state === "done",
  );

  await press("p", { ctrl: true });
  await until("the picker lists both providers", (frame) => frame.includes("Grok B · Grok 4.6"));
  await setup.mockInput.typeText("B");
  setup.mockInput.pressEnter();
  await until("switching to Grok B between runs", (frame) =>
    /^ .*Grok B · Grok 4\.6/mu.test(frame),
  );
  await press("t", { ctrl: true });
  await until(
    "runtime mode approval-required",
    (frame) => frame.split("\n")[0]?.includes("approval-required") ?? false,
  );

  await send("Repeat the code word");
  await until(
    "a handoff row, then Grok B's approval prompt",
    (frame) =>
      frame.includes("Context handoff: Grok · Grok 4.6 → Grok B · Grok 4.6") &&
      frame.includes("Approval needed") &&
      lastStatus()?.state === "blocked",
  );
  check(
    "Rex status is blocked, kind=permission",
    describeStatus(lastStatus()) === "blocked:permission",
  );
  await until("the approval offers the provider's choices once armed", (frame) =>
    /\[a\] Approve/u.test(frame),
  );
  await press("p", { ctrl: true });
  await until("the picker is disabled while the run is active", (frame) =>
    frame.includes("Model switching waits until the run finishes."),
  );

  await press("a");
  await until(
    "approving lets Grok B finish",
    (frame) => frame.includes("hello from mock") && lastStatus()?.state === "done",
  );
  setup.mockInput.pressArrow("right");
  await until(
    "a key press after the run marks it seen: idle",
    () => lastStatus()?.state === "idle",
  );

  const prompts = NodeFS.readFileSync(requestLog, "utf8");
  check("Grok B's prompt carried Grok's answer across the handoff", prompts.includes("PAPAYA"));
  check(
    "no status text carries control characters",
    statuses.every(
      (status) => !/[\u0000-\u001f\u007f-\u009f]/u.test(`${status.title}${status.message}`),
    ),
  );
  console.log("all checks passed");
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  frames.dispose();
  view.dispose();
  await setup.dispose();
}
process.exit(process.exitCode ?? 0);
