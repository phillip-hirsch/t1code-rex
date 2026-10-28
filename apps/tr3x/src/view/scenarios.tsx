// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- A Bun script outside the Effect runtime.
/**
 * The real App in OpenTUI's test renderer, against `testing/viewFixture.ts`.
 * OpenTUI needs Bun, so `App.test.ts` runs each scenario here as its own process:
 *
 *   bun apps/tr3x/src/view/scenarios.tsx <scenario>   (or --list)
 */
import * as NodeURL from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";

import { frameWaiter } from "../testing/frames.ts";
import { provider } from "../testing/serverProvider.ts";
import {
  createFakeView,
  FIXTURE_THREAD_ID,
  pendingQuestion,
  projection,
  run,
  userMessage,
} from "../testing/viewFixture.ts";
import { App } from "./App.tsx";
import type { ViewConnection } from "./connection.ts";
import { mountView, type ViewStart, type ViewTarget } from "./main.tsx";
import type { ViewServer } from "./platform.ts";

const model = (slug: string, name: string) => ({ slug, name, isCustom: false, capabilities: null });
const codex = provider("codex", {
  displayName: "Codex",
  models: [model("gpt-5", "GPT-5"), model("gpt-6", "GPT-6")],
});
const selection: ModelSelection = { instanceId: codex.instanceId, model: "gpt-5" };
const question = {
  id: "q",
  header: "Branch",
  question: "Which branch?",
  options: [{ label: "main", description: "The default branch" }],
};

const FRAME_TIMEOUT_MS = 5_000;

function expect(condition: boolean, message: string, frame?: string): void {
  if (!condition) throw new Error(frame === undefined ? message : `${message}\n${frame}`);
}

async function mount(
  view: ReturnType<typeof createFakeView>,
  options: { readonly newThread?: boolean; readonly width?: number } = {},
) {
  const setup = await createTestRenderer({ width: options.width ?? 100, height: 30 });
  const root = createRoot(setup.renderer);
  root.render(
    <RegistryContext.Provider value={view.api.registry}>
      <App
        connection={view.api}
        threadId={FIXTURE_THREAD_ID}
        newThread={options.newThread ? { projectId: ProjectId.make("project-fixture") } : null}
        onStatus={() => {}}
        onQuit={() => {}}
      />
    </RegistryContext.Provider>,
  );
  // React commits on a later macrotask; let it, then render until the renderer is idle.
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await setup.renderOnce();
    await setup.flush();
    return setup.captureCharFrame();
  };
  const frames = frameWaiter(setup, FRAME_TIMEOUT_MS);
  /** The first frame that satisfies `predicate`, after React commits what's pending. */
  const frame = async (label: string, predicate: (frame: string) => boolean) => {
    await settle();
    return await frames.until(label, predicate);
  };
  const send = async (text: string) => {
    await setup.mockInput.typeText(text);
    setup.mockInput.pressEnter();
    return await settle();
  };
  const press = async (name: string, modifiers?: { ctrl?: boolean }) => {
    setup.mockInput.pressKey(name, modifiers);
    return await settle();
  };
  const arrow = async (direction: "up" | "down") => {
    setup.mockInput.pressArrow(direction);
    return await settle();
  };
  const enter = async () => {
    setup.mockInput.pressEnter();
    return await settle();
  };
  await frame(
    "the view renders",
    (current) => current.includes("Message") || current.includes("Which"),
  );
  return {
    setup,
    settle,
    frame,
    send,
    press,
    arrow,
    enter,
    dispose: async () => {
      frames.dispose();
      root.unmount();
      await setup.dispose();
    },
  };
}

type Scenario = () => Promise<void>;

/**
 * Starts the real view against a server whose sign-in `bearerToken` controls,
 * and returns how startup ended, or throws if it hasn't ended in time.
 */
async function startup(
  target: ViewTarget,
  bearerToken: () => Promise<string>,
  during: (ui: {
    readonly frame: (label: string, done: (frame: string) => boolean) => Promise<string>;
    readonly press: (name: string, modifiers?: { ctrl?: boolean }) => void;
  }) => Promise<void>,
  connect?: (server: ViewServer) => ViewConnection,
): Promise<ViewStart> {
  const setup = await createTestRenderer({ width: 80, height: 12, exitOnCtrlC: false });
  const frames = frameWaiter(setup, FRAME_TIMEOUT_MS);
  const quit = new AbortController();
  const started = mountView({
    renderer: setup.renderer,
    // Nothing listens here: startup must not need the server before it signs in.
    server: {
      environmentId: EnvironmentId.make("env-startup"),
      label: "Startup",
      httpBaseUrl: "http://127.0.0.1:9",
      wsBaseUrl: "ws://127.0.0.1:9",
      bearerToken,
    },
    target,
    signal: quit.signal,
    onQuit: () => quit.abort(),
    ...(connect === undefined ? {} : { connect }),
  });
  try {
    await during({
      frame: frames.until,
      press: (name, modifiers) => setup.mockInput.pressKey(name, modifiers),
    });
    const deadline = AbortSignal.timeout(FRAME_TIMEOUT_MS);
    const ended = await new Promise<ViewStart | "timeout">((resolve) => {
      deadline.addEventListener("abort", () => resolve("timeout"), { once: true });
      void started.then(resolve);
    });
    if (ended === "timeout") throw new Error(`startup never ended\n${setup.captureCharFrame()}`);
    if (ended.kind === "mounted") ended.view.dispose();
    return ended;
  } finally {
    frames.dispose();
    await setup.dispose();
  }
}

const TARGETS: ReadonlyArray<readonly [string, ViewTarget]> = [
  ["view <threadId>", { kind: "thread", threadId: ThreadId.make("thread-startup") }],
  ["view --new", { kind: "new", cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)) }],
];

const startupScenarios: Record<string, () => Promise<void>> = Object.fromEntries(
  TARGETS.flatMap(([name, target]) => [
    [
      `${name}: a session that can't be minted ends startup with the reason`,
      async () => {
        const ended = await startup(
          target,
          () => Promise.reject(new Error("The T3 server runs on Node, and no `node` is on PATH.")),
          async () => {},
        );
        expect(ended.kind === "failed", `startup ended as ${ended.kind}, not failed`);
        expect(
          ended.kind === "failed" && ended.message.includes("no `node` is on PATH"),
          `the failure says why: ${ended.kind === "failed" ? ended.message : ""}`,
        );
      },
    ],
    [
      `${name}: ctrl+c quits while it is still connecting`,
      async () => {
        const ended = await startup(
          target,
          () => new Promise<string>(() => {}),
          async (ui) => {
            await ui.frame("the startup screen shows", (frame) => frame.includes("Connecting"));
            ui.press("c", { ctrl: true });
          },
        );
        expect(ended.kind === "quit", `startup ended as ${ended.kind}, not quit`);
      },
    ],
  ]),
);

const scenarios: Record<string, Scenario> = {
  ...startupScenarios,

  async "view --new: ctrl+c quits while the project is being created"() {
    const view = createFakeView([codex]);
    view.createProject.next = "hold";
    const ended = await startup(
      { kind: "new", cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)) },
      () => Promise.resolve("token"),
      async (ui) => {
        await ui.frame(
          "the shell arrived and creating the project is held",
          (frame) => frame.includes("Loading projects") && view.createProject.calls.length === 1,
        );
        ui.press("c", { ctrl: true });
      },
      () => view.connection,
    );
    expect(ended.kind === "quit", `startup ended as ${ended.kind}, not quit`);
    expect(view.isDisposed(), "quitting disposes the connection");
  },

  async "rapid enters keep a typed answer to an earlier question"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingQuestion("q3", [
      question,
      { ...question, id: "q2", question: "Which base?" },
    ]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view);
    await ui.setup.mockInput.typeText("feature");
    // Both before React commits: the first answers q, the second answers q2.
    ui.setup.mockInput.pressEnter();
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    const answers = view.commands.respondToUserInput.calls[0]?.answers;
    expect(view.commands.respondToUserInput.calls.length === 1, "one response for the request");
    expect(answers?.q === "feature", `the typed answer stands: ${JSON.stringify(answers)}`);
    expect(
      answers?.q2 === "main",
      `the second Enter picks q2's option: ${JSON.stringify(answers)}`,
    );
    await ui.dispose();
  },

  async "a failed answer keeps the question, retries it, and never sends it twice"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingQuestion("q1", [question]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    view.commands.respondToUserInput.next = { ok: false, error: "Connection interrupted" };
    const ui = await mount(view);
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    expect(
      view.commands.respondToUserInput.calls.length === 1,
      "respondToUserInput was called 1 time(s)",
    );
    const failed = await ui.frame("the failure shows", (frame) =>
      frame.includes("Connection interrupted"),
    );
    expect(failed.includes("Which branch?"), "the question stays after a failed answer", failed);

    view.commands.respondToUserInput.next = "hold";
    await ui.send("retry answer");
    await ui.settle();
    expect(
      view.commands.respondToUserInput.calls.length === 2,
      "respondToUserInput was called 2 time(s)",
    );
    expect(
      view.commands.respondToUserInput.calls[1]?.answers.q === "retry answer",
      "the retry carries the typed answer",
    );
    await ui.enter();
    expect(
      view.commands.respondToUserInput.calls.length === 2,
      "no second answer while one is in flight",
    );
    expect(view.commands.startTurn.calls.length === 0, "an answer never goes out as a message");
    view.commands.respondToUserInput.release();
    await ui.dispose();
  },

  async "a second first-send waits for the launch, then dispatches normally"() {
    const view = createFakeView([codex]);
    view.commands.startTurn.next = "hold";
    const ui = await mount(view, { newThread: true });
    await ui.send("first");
    await ui.settle();
    expect(view.commands.startTurn.calls.length === 1, "startTurn was called 1 time(s)");
    await ui.send("second");
    expect(view.commands.startTurn.calls.length === 1, "only one launch while it is in flight");
    view.commands.startTurn.next = { ok: true };
    view.commands.startTurn.release();
    await ui.settle();
    expect(view.commands.startTurn.calls.length === 2, "startTurn was called 2 time(s)");
    const [launch, follow] = view.commands.startTurn.calls;
    if (follow === undefined) throw new Error("the second send never dispatched");
    expect(launch?.bootstrap?.createThread !== undefined, "the first send launches the thread");
    expect(
      follow?.bootstrap === undefined && follow.message.text === "second",
      "the second dispatches into it",
    );
    await ui.dispose();
  },

  async "a failed launch keeps both drafts"() {
    const view = createFakeView([codex]);
    view.commands.startTurn.next = "hold";
    const ui = await mount(view, { newThread: true });
    await ui.send("first");
    await ui.settle();
    expect(view.commands.startTurn.calls.length === 1, "startTurn was called 1 time(s)");
    await ui.send("second");
    view.commands.startTurn.release({ ok: false, error: "launch refused" });
    const frame = await ui.frame("the failure shows", (current) =>
      current.includes("launch refused"),
    );
    expect(
      frame.includes("first") && frame.includes("second"),
      "both drafts are back in the composer",
      frame,
    );
    expect(view.commands.startTurn.calls.length === 1, "nothing launches twice");
    await ui.dispose();
  },

  async "the picker stays closed while a send or a switch is pending"() {
    const view = createFakeView([codex]);
    view.setProjection(projection({ selection }));
    view.commands.startTurn.next = "hold";
    const ui = await mount(view);
    await ui.send("start a run");
    await ui.settle();
    expect(view.commands.startTurn.calls.length === 1, "startTurn was called 1 time(s)");
    let frame = await ui.press("p", { ctrl: true });
    expect(!frame.includes("type to filter"), "no picker while the send is pending", frame);
    view.commands.startTurn.release();
    frame = await ui.press("p", { ctrl: true });
    expect(
      !frame.includes("type to filter"),
      "no picker until the server shows the message",
      frame,
    );
    const sent = view.commands.startTurn.calls[0]?.message;
    if (sent === undefined) throw new Error("the send never dispatched");
    view.setProjection(
      projection({ selection, messages: [{ id: sent.messageId, text: sent.text }] }),
    );
    await ui.settle();

    frame = await ui.press("p", { ctrl: true });
    expect(frame.includes("type to filter"), "the picker opens once the send settled", frame);
    view.commands.updateThread.next = "hold";
    await ui.arrow("down");
    await ui.enter();
    await ui.settle();
    expect(view.commands.updateThread.calls.length === 1, "updateThread was called 1 time(s)");
    frame = await ui.press("p", { ctrl: true });
    expect(!frame.includes("type to filter"), "no picker while the switch is pending", frame);
    view.commands.updateThread.release();
    await ui.settle();

    frame = await ui.press("p", { ctrl: true });
    expect(frame.includes("type to filter"), "the picker opens again", frame);
    await ui.arrow("down");
    // A run starts between the last render and Enter: the switch reads fresh state.
    view.setProjection(projection({ selection, runs: [run("r1", 1, "running", selection)] }));
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    expect(view.commands.updateThread.calls.length === 1, "no switch into a running run");
    await ui.dispose();
  },

  async "a suggested answer fills the composer and Enter sends it"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingQuestion("q2", [
      { ...question, options: [], initialAnswer: "suggested branch" },
    ]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view);
    await ui.frame("the suggestion shows in the composer", (frame) =>
      frame.includes("suggested branch"),
    );
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    expect(
      view.commands.respondToUserInput.calls.length === 1,
      "respondToUserInput was called 1 time(s)",
    );
    expect(
      view.commands.respondToUserInput.calls[0]?.answers.q === "suggested branch",
      "Enter sends the suggestion",
    );
    await ui.dispose();
  },

  async "user messages render as markdown"() {
    const view = createFakeView([codex]);
    const items = [userMessage("u1", 0, "Use **bold** and `code`")];
    view.setProjection(projection({ selection, items }));
    const ui = await mount(view);
    const frame = await ui.frame("the message renders", (current) => current.includes("Use "));
    expect(frame.includes("Use bold and code"), "markdown markers are rendered, not shown", frame);
    await ui.dispose();
  },

  async "every shortcut stays readable at 80 columns"() {
    const view = createFakeView([codex]);
    view.setProjection(projection({ selection }));
    const ui = await mount(view, { width: 80 });
    const idle = await ui.settle();
    for (const hint of [
      "enter send",
      "^p model",
      "^t approval-required",
      "pgup history",
      "^c quit",
    ]) {
      expect(idle.includes(hint), `"${hint}" is readable while idle`, idle);
    }
    view.setProjection(projection({ selection, runs: [run("r1", 1, "running", selection)] }));
    const busy = await ui.frame("the run shows", (frame) => frame.includes("esc stop"));
    for (const hint of [
      "enter send",
      "esc stop",
      "^t approval-required",
      "pgup history",
      "^c quit",
    ]) {
      expect(busy.includes(hint), `"${hint}" is readable during a run`, busy);
    }
    console.log(busy);
    await ui.dispose();
  },

  async "the picker says how many models it isn't showing"() {
    const many = provider("claudeAgent", {
      displayName: "Claude",
      models: Array.from({ length: 12 }, (_, index) => model(`m${index}`, `Model ${index}`)),
    });
    const view = createFakeView([many]);
    view.setProjection(projection({ selection: { instanceId: many.instanceId, model: "m0" } }));
    const ui = await mount(view);
    const frame = await ui.press("p", { ctrl: true });
    expect(frame.includes("4 more"), "the hidden models are counted", frame);
    await ui.dispose();
  },

  async "a provider that needs a new thread for a model change refuses one once started"() {
    const locked = provider("claudeAgent", {
      displayName: "Claude",
      requiresNewThreadForModelChange: true,
      models: [model("opus", "Opus"), model("sonnet", "Sonnet")],
    });
    const current = { instanceId: locked.instanceId, model: "opus" };
    const view = createFakeView([locked]);
    view.setProjection(
      projection({ selection: current, runs: [run("r1", 1, "completed", current)] }),
    );
    const ui = await mount(view);
    await ui.press("p", { ctrl: true });
    await ui.arrow("down");
    const frame = await ui.enter();
    expect(view.commands.updateThread.calls.length === 0, "no model change is sent");
    expect(frame.includes("Start a new thread to change models"), "the view says why", frame);
    await ui.dispose();
  },
};

const [name] = process.argv.slice(2);
if (name === "--list") {
  console.log(JSON.stringify(Object.keys(scenarios)));
  process.exit(0);
}
const scenario = name === undefined ? undefined : scenarios[name];
if (scenario === undefined) {
  console.error(`unknown scenario: ${name}`);
  process.exit(2);
}
try {
  await scenario();
  console.log(`ok   ${name}`);
  process.exit(0);
} catch (error) {
  console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
