// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- A Bun script outside the Effect runtime.
/**
 * The real App in OpenTUI's test renderer, against `testing/viewFixture.ts`.
 * OpenTUI needs Bun, so `App.test.ts` runs each scenario here as its own process:
 *
 *   bun apps/tr3x/src/view/scenarios.tsx <scenario>   (or --list)
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import * as Option from "effect/Option";
import { createRoot } from "@opentui/react";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";

import { frameWaiter } from "../testing/frames.ts";
import { provider } from "../testing/serverProvider.ts";
import {
  createFakeView,
  FIXTURE_THREAD_ID,
  pendingApproval,
  pendingQuestion,
  projection,
  reasoning,
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
/** OpenTUI's mock keys have no name for page up; this is its escape sequence. */
const PAGE_UP = "\u001b[5~";

function expect(condition: boolean, message: string, frame?: string): void {
  if (!condition) throw new Error(frame === undefined ? message : `${message}\n${frame}`);
}

async function mount(
  view: ReturnType<typeof createFakeView>,
  options: { readonly newThread?: boolean; readonly width?: number; readonly height?: number } = {},
) {
  const setup = await createTestRenderer({
    width: options.width ?? 100,
    height: options.height ?? 30,
  });
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
  await frame("the view renders", (current) => current.includes("enter send"));
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

/** This script runs on Bun; the view's own tsconfig has no Bun types. */
declare const Bun: { readonly stringWidth: (text: string) => number };

/** Every size the layout must hold at, width × height. */
const SWEEP_SIZES = [
  [80, 8],
  [80, 10],
  [80, 12],
  [80, 14],
  [80, 24],
  [120, 40],
  [40, 24],
] as const;

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

interface FrameBox {
  readonly top: string;
  readonly bottom: string;
  /** Its rows between the borders, trimmed. */
  readonly rows: ReadonlyArray<string>;
}

/**
 * The frame's boxes top to bottom, after checking each is whole: every row
 * inside one starts and ends with its border at the screen's edges, and no
 * row outside one starts with a border. A panel that overflows breaks this.
 */
function frameBoxes(frame: string, width: number, height: number): ReadonlyArray<FrameBox> {
  const rows = frame.split("\n").slice(0, height);
  expect(rows.length === height, `the frame has ${height} rows`, frame);
  const boxes: FrameBox[] = [];
  let open: number | null = null;
  rows.forEach((row, index) => {
    // Bun's width, not the view's: the check doesn't measure with the code it checks.
    const whole = Bun.stringWidth(row) === width;
    if (open === null) {
      if (row.startsWith("┌")) {
        expect(whole && row.endsWith("┐"), `row ${index} opens a whole box`, frame);
        open = index;
      } else {
        expect(!/^[│└├]/u.test(row), `row ${index} lies outside every box`, frame);
      }
    } else if (row.startsWith("└")) {
      expect(whole && row.endsWith("┘"), `row ${index} closes its box`, frame);
      boxes.push({
        top: rows[open] ?? "",
        bottom: row,
        rows: rows.slice(open + 1, index).map((inner) => inner.slice(1, -1).trim()),
      });
      open = null;
    } else {
      expect(
        whole && row.startsWith("│") && row.endsWith("│"),
        `row ${index} stays in its box`,
        frame,
      );
    }
  });
  expect(open === null, "every box closes", frame);
  return boxes;
}

/** Checks the composer and the footer show, and returns the boxes above the composer. */
function checkFrame(frame: string, width: number, height: number): ReadonlyArray<FrameBox> {
  const boxes = frameBoxes(frame, width, height);
  const composer = boxes.at(-1);
  expect(composer !== undefined, "the composer's border shows", frame);
  const rows = frame.split("\n").slice(0, height);
  const below = rows.slice(rows.lastIndexOf(composer?.bottom ?? "") + 1);
  expect(
    below.length > 0 &&
      below.every((row) => row.trim() !== "") &&
      (below.at(-1) ?? "").includes("^c quit"),
    "the footer sits under the composer and its last row shows",
    frame,
  );
  return boxes.slice(0, -1);
}

/**
 * Checks each row comes whole from one source: a cue, or text from one line of
 * `sources` (a row cut short ends in "…"). Rows drawn over each other fail.
 */
function checkRows(
  frame: string,
  rows: ReadonlyArray<string>,
  sources: ReadonlyArray<string>,
  prefixes: ReadonlyArray<string> = [],
): void {
  const whole = sources.map(normalize);
  const starts = prefixes.map(normalize);
  for (const row of rows) {
    const line = normalize(row.replace(/^› /u, ""));
    const text = line.replace(/…$/u, "");
    expect(
      text === "" ||
        /^… \d+ lines hidden …$|^… \d+ more lines$|^[↑↓] \d+ more$/u.test(line) ||
        whole.some((source) => source.includes(text)) ||
        starts.some((source) => source.startsWith(text)),
      `row "${row}" comes from one source`,
      frame,
    );
  }
}

const SWEEP_TARGET = "TARGET=/very/important/production.db";
const SWEEP_APPROVAL = [
  "rm -rf with the following arguments:",
  ...Array.from({ length: 30 }, (_, index) => `  filler-line-${index} lorem ipsum dolor`),
  SWEEP_TARGET,
].join("\n");
const CJK_TARGET = "終端=/本番/データ.db";
/** One long line of double-width text, its target at the very end. */
const CJK_APPROVAL = `削除の対象：${"漢字かな交じり文👍🏽".repeat(22)} ${CJK_TARGET}`;
const SWEEP_CHOICES = "[a] accept   [s] accept for session   [d] decline";
const TAB_TARGET = "TARGET=/production.db";
/** Tabs a terminal draws wider than string-width counts them, the target after them. */
const TAB_APPROVAL = `START tabbed operation\n\tindented\n${"abc\t".repeat(17)}${TAB_TARGET}`;
const DIAGNOSTICS = Array.from({ length: 25 }, (_, index) => `diagnostic line ${index}`).join("\n");
const SWEEP_QUESTION = {
  id: "sweep",
  header: "Migration",
  question:
    "Which approach should I take for the migration? It touches the users table, the sessions " +
    "table and the audit log, and the backfill already finished last week.",
  options: Array.from({ length: 12 }, (_, index) => ({
    label: `Option ${index}`,
    description: `Approach ${index} keeps the old table and backfills the new one in batches overnight.`,
  })),
};
const optionText = (index: number) =>
  `Option ${index} - Approach ${index} keeps the old table and backfills the new one in batches overnight.`;

function checkApproval(
  frame: string,
  boxes: ReadonlyArray<FrameBox>,
  prompt: string,
  target: string,
) {
  const panel = boxes.find((box) => box.top.includes("Approval needed"));
  expect(panel !== undefined, "the approval panel shows", frame);
  const rows = panel?.rows ?? [];
  checkRows(frame, rows, [...prompt.split("\n"), SWEEP_CHOICES]);
  expect(
    rows.some((row) => row.startsWith("[a] accept")),
    "[a] accept shows",
    frame,
  );
  expect(
    rows.some((row) => row.includes(target)),
    "the detail's last line shows",
    frame,
  );
}

function checkQuestion(frame: string, boxes: ReadonlyArray<FrameBox>, cursor: number) {
  const panel = boxes.find((box) => box.top.includes(SWEEP_QUESTION.header));
  expect(panel !== undefined, "the question panel shows", frame);
  const rows = panel?.rows ?? [];
  checkRows(
    frame,
    rows,
    [SWEEP_QUESTION.question, ...SWEEP_QUESTION.options.map((option) => option.description)],
    SWEEP_QUESTION.options.map((_, index) => optionText(index)),
  );
  const first = normalize(rows[0] ?? "").replace(/…$/u, "");
  expect(
    first.length >= 10 && SWEEP_QUESTION.question.startsWith(first),
    "the question's first line shows",
    frame,
  );
  expect(
    rows.some((row) => row.startsWith(`› Option ${cursor} `)),
    "the highlighted option shows",
    frame,
  );
}

const QUEUED = Array.from({ length: 10 }, (_, index) =>
  run(`q${index}`, index + 2, "queued", selection),
);

/** The thread with ten queued messages behind a running one, and `request` pending. */
function queuedProjection(
  request?: ReturnType<typeof pendingApproval> | ReturnType<typeof pendingQuestion>,
) {
  return projection({
    selection,
    ...(request ? { items: [request.item], requests: [request.request] } : {}),
    runs: [run("r1", 1, "running", selection), ...QUEUED],
    messages: QUEUED.map((entry, index) => ({
      id: entry.userMessageId,
      text: `follow-up ${index}`,
    })),
  });
}

async function typeDraft(ui: Awaited<ReturnType<typeof mount>>) {
  for (let line = 1; line <= 8; line += 1) {
    await ui.setup.mockInput.typeText(`draft line ${line}`);
    // Ctrl+J: a legacy terminal sends shift+enter as a plain enter.
    if (line < 8) ui.setup.mockInput.pressKey("LINEFEED");
  }
}

/** Mounts the view at each sweep size, brings up a case, and checks the frame it settles on. */
async function sweep(
  label: string,
  open: (
    view: ReturnType<typeof createFakeView>,
    ui: Awaited<ReturnType<typeof mount>>,
  ) => Promise<string>,
  check: (frame: string, boxes: ReadonlyArray<FrameBox>) => void,
): Promise<void> {
  for (const [width, height] of SWEEP_SIZES) {
    const view = createFakeView([codex]);
    const ui = await mount(view, { width, height });
    try {
      const frame = await open(view, ui);
      console.log(`--- ${label} ${width}x${height}\n${frame}`);
      try {
        check(frame, checkFrame(frame, width, height));
      } catch (error) {
        throw new Error(
          `at ${width}x${height}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    } finally {
      await ui.dispose();
    }
  }
}

const armed = (ui: Awaited<ReturnType<typeof mount>>) =>
  ui.frame("the approval is armed", (frame) => frame.includes("[a] accept"));

async function highlightOption(ui: Awaited<ReturnType<typeof mount>>, cursor: number) {
  await ui.frame("the question shows", (frame) => frame.includes(SWEEP_QUESTION.header));
  for (let press = 0; press < cursor; press += 1) await ui.arrow("down");
  return await ui.frame("the option is highlighted", (frame) =>
    frame.includes(`› Option ${cursor} `),
  );
}

const sweepScenarios: Record<string, Scenario> = {
  async "the layout holds at every size: an approval"() {
    await sweep(
      "approval",
      async (view, ui) => {
        const { item, request } = pendingApproval("sweep-a", SWEEP_APPROVAL);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        return await armed(ui);
      },
      (frame, boxes) => checkApproval(frame, boxes, SWEEP_APPROVAL, SWEEP_TARGET),
    );
  },

  async "the layout holds at every size: a double-width approval"() {
    await sweep(
      "cjk-approval",
      async (view, ui) => {
        const { item, request } = pendingApproval("sweep-c", CJK_APPROVAL);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        return await armed(ui);
      },
      (frame, boxes) => checkApproval(frame, boxes, CJK_APPROVAL, CJK_TARGET),
    );
  },

  async "the layout holds at every size: a twelve-option question"() {
    await sweep(
      "question",
      async (view, ui) => {
        const { item, request } = pendingQuestion("sweep-q", [SWEEP_QUESTION]);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        return await highlightOption(ui, 9);
      },
      (frame, boxes) => checkQuestion(frame, boxes, 9),
    );
  },

  async "the layout holds at every size: a question under a long draft and a queue"() {
    await sweep(
      "draft-queue-question",
      async (view, ui) => {
        view.setProjection(queuedProjection());
        await typeDraft(ui);
        view.setProjection(queuedProjection(pendingQuestion("sweep-dq", [SWEEP_QUESTION])));
        return await highlightOption(ui, 9);
      },
      (frame, boxes) => {
        checkQuestion(frame, boxes, 9);
        expect(frame.includes("queued"), "the queue is counted", frame);
      },
    );
  },

  async "the layout holds at every size: an approval under a long draft and a queue"() {
    await sweep(
      "draft-queue-approval",
      async (view, ui) => {
        view.setProjection(queuedProjection());
        // Typed before the approval arrives: its keys answer only an empty composer.
        await typeDraft(ui);
        view.setProjection(queuedProjection(pendingApproval("sweep-da", SWEEP_APPROVAL)));
        return await armed(ui);
      },
      (frame, boxes) => {
        checkApproval(frame, boxes, SWEEP_APPROVAL, SWEEP_TARGET);
        expect(frame.includes("queued"), "the queue is counted", frame);
      },
    );
  },

  async "the layout holds at every size: a tab-indented approval"() {
    await sweep(
      "tab-approval",
      async (view, ui) => {
        const { item, request } = pendingApproval("sweep-t", TAB_APPROVAL);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        return await armed(ui);
      },
      (frame, boxes) => checkApproval(frame, boxes, TAB_APPROVAL, TAB_TARGET),
    );
  },

  async "the layout holds at every size: an approval ending in a newline"() {
    await sweep(
      "newline-approval",
      async (view, ui) => {
        const { item, request } = pendingApproval("sweep-n", `${SWEEP_APPROVAL}\n`);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        return await armed(ui);
      },
      (frame, boxes) => checkApproval(frame, boxes, SWEEP_APPROVAL, SWEEP_TARGET),
    );
  },

  async "the layout holds at every size: an approval under a 25-line error"() {
    await sweep(
      "error-approval",
      async (view, ui) => {
        const { item, request } = pendingApproval("sweep-e", SWEEP_APPROVAL);
        view.setProjection(projection({ selection, items: [item], requests: [request] }));
        view.commands.respondToApproval.next = { ok: false, error: DIAGNOSTICS };
        await armed(ui);
        await ui.press("a");
        // The failure's notice lands after the command settles.
        return await ui.settle();
      },
      (frame, boxes) => {
        checkApproval(frame, boxes, SWEEP_APPROVAL, SWEEP_TARGET);
        const shown = frame.split("\n").filter((row) => row.includes("diagnostic line"));
        expect(shown.length < 3, "the error is cut to a few lines", frame);
        expect(
          !frame.includes("diagnostic line 24"),
          "the error's end gives way to its cue",
          frame,
        );
      },
    );
    // Where there's room, the error shows with its cue.
    const view = createFakeView([codex]);
    const ui = await mount(view, { width: 80, height: 24 });
    try {
      const { item, request } = pendingApproval("sweep-e2", SWEEP_APPROVAL);
      view.setProjection(projection({ selection, items: [item], requests: [request] }));
      view.commands.respondToApproval.next = { ok: false, error: DIAGNOSTICS };
      await armed(ui);
      await ui.press("a");
      const frame = await ui.frame("the error shows", (current) =>
        current.includes("Could not answer"),
      );
      expect(/… \d+ more lines/u.test(frame), "the cut error says how much", frame);
    } finally {
      await ui.dispose();
    }
  },

  async "a request in a pane too short for it shows a line, and its keys wait"() {
    for (const kind of ["approval", "question"] as const) {
      const view = createFakeView([codex]);
      const ui = await mount(view, { width: 80, height: 24 });
      try {
        const pending =
          kind === "approval"
            ? pendingApproval("short-a", SWEEP_APPROVAL)
            : pendingQuestion("short-q", [SWEEP_QUESTION]);
        view.setProjection(
          projection({ selection, items: [pending.item], requests: [pending.request] }),
        );
        if (kind === "approval") await armed(ui);
        else await ui.frame("the question shows", (frame) => frame.includes("› Option 0"));
        ui.setup.resize(80, 6);
        const frame = await ui.frame("the request waits", (current) =>
          current.includes("waiting: make the pane taller to answer"),
        );
        console.log(`--- short ${kind} 80x6\n${frame}`);
        const rows = frame.split("\n").slice(0, 6);
        expect(
          rows.every((row) => row.trim() !== ""),
          "no row is left blank",
          frame,
        );
        checkFrame(frame, 80, 6);
        await ui.press(kind === "approval" ? "a" : "ESCAPE");
        await ui.enter();
        expect(view.commands.respondToApproval.calls.length === 0, "a answers nothing", frame);
        expect(view.commands.respondToUserInput.calls.length === 0, "enter answers nothing", frame);
        expect(view.commands.dismissUserInput.calls.length === 0, "esc dismisses nothing", frame);
        ui.setup.resize(80, 24);
        await ui.frame("the panel comes back", (current) =>
          current.includes(kind === "approval" ? "[a] accept" : "› Option 0"),
        );
      } finally {
        await ui.dispose();
      }
    }
  },

  async "the model picker fits a narrow terminal"() {
    const wide = provider("codex", {
      displayName: "Codex",
      models: Array.from({ length: 12 }, (_, index) =>
        model(`m${index}`, `Model ${index} with a long marketing name for wide screens`),
      ),
    });
    const view = createFakeView([wide]);
    view.setProjection(projection({ selection: { instanceId: wide.instanceId, model: "m0" } }));
    const [width, height] = [40, 24];
    const ui = await mount(view, { width, height });
    const frame = await ui.press("p", { ctrl: true });
    console.log(`--- picker ${width}x${height}\n${frame}`);
    const boxes = checkFrame(frame, width, height);
    const picker = boxes.find((box) => box.top.includes("Model"));
    expect(picker !== undefined, "the picker shows", frame);
    const rows = picker?.rows ?? [];
    const entries = rows.filter((row) => !/^(type to filter|[↑↓] \d+ more)/u.test(row));
    expect(entries.length > 0, "the picker lists models", frame);
    expect(
      entries.every((row) => /^(› )?Codex · Model \d+ /u.test(row) && row.endsWith("…")),
      "each model is one line, cut with …",
      frame,
    );
    expect(
      rows.some((row) => /^↓ \d+ more$/u.test(row)),
      "the hidden models are counted",
      frame,
    );
    await ui.dispose();
  },
};

const scenarios: Record<string, Scenario> = {
  ...startupScenarios,
  ...sweepScenarios,

  async "view --new finds a project stored under a symlinked path"() {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-symlink-"));
    try {
      const real = NodePath.join(dir, "real");
      const link = NodePath.join(dir, "link");
      NodeFS.mkdirSync(real);
      NodeFS.symlinkSync(real, link);
      const view = createFakeView([codex]);
      // The server keeps the path it was given, so a project made via `link` stays under it.
      view.addProject("project-link", link);
      const ended = await startup(
        { kind: "new", cwd: link },
        () => Promise.resolve("token"),
        async () => {},
        () => view.connection,
      );
      expect(ended.kind === "mounted", `startup ended as ${ended.kind}, not mounted`);
      expect(view.createProject.calls.length === 0, "no second project for the same directory");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  },

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

  async "typing through an approval keeps the text and answers nothing"() {
    const view = createFakeView([codex]);
    const running = run("r1", 1, "running", selection);
    view.setProjection(projection({ selection, runs: [running] }));
    const ui = await mount(view);
    await ui.setup.mockInput.typeText("ple");
    const { item, request } = pendingApproval("a1", "rm -rf build");
    view.setProjection(
      projection({ selection, runs: [running], items: [item], requests: [request] }),
    );
    await ui.frame("the approval is armed", (frame) => frame.includes("[a] accept"));
    await ui.setup.mockInput.typeText("ase add");
    const frame = await ui.settle();
    expect(view.commands.respondToApproval.calls.length === 0, "typing answers nothing");
    expect(frame.includes("please add"), "the text stays in the composer", frame);
    await ui.dispose();
  },

  async "an approval takes one answer, and enter gives none"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingApproval("a2", "rm -rf build");
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    view.commands.respondToApproval.next = "hold";
    const ui = await mount(view);
    await ui.enter();
    await ui.frame("the approval is armed", (frame) => frame.includes("[a] accept"));
    await ui.enter();
    expect(view.commands.respondToApproval.calls.length === 0, "enter answers nothing");
    ui.setup.mockInput.pressKey("a");
    ui.setup.mockInput.pressKey("a");
    await ui.settle();
    expect(view.commands.respondToApproval.calls.length === 1, "a held key answers once");
    expect(view.commands.respondToApproval.calls[0]?.decision === "accept", "a accepts");
    view.commands.respondToApproval.release();
    await ui.dispose();
  },

  async "a question with long options keeps the composer on screen at 80x24"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingQuestion("long", [
      {
        id: "q",
        header: "Choose implementation",
        question: "Which approach?",
        options: Array.from({ length: 4 }, (_, index) => ({
          label: `Approach ${index}`,
          description: "A valid possible implementation for the task. ".repeat(8).trim(),
        })),
      },
    ]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view, { width: 80, height: 24 });
    await ui.setup.mockInput.typeText("custom answer");
    let frame = await ui.settle();
    expect(frame.includes("custom answer"), "the composer shows what's typed", frame);
    expect(frame.includes("enter send"), "the key hints show", frame);
    expect(frame.includes("more lines"), "a cut description says so", frame);
    for (let press = 0; press < 3; press += 1) frame = await ui.arrow("down");
    expect(frame.includes("› Approach 3"), "the last option scrolls into view", frame);
    expect(frame.includes("custom answer"), "the composer stays on screen", frame);
    console.log(frame);
    await ui.dispose();
  },

  async "loading earlier history keeps the row you were reading"() {
    const view = createFakeView([codex]);
    const rows = (from: number) =>
      Array.from({ length: 150 - from }, (_, index) =>
        userMessage(`u${from + index}`, from + index, `row ${from + index}`),
      );
    view.setProjection(projection({ selection, items: rows(100) }), { hasMoreHistory: true });
    const ui = await mount(view, { width: 80, height: 24 });
    /** The screen line row `n` is on, or -1 when it's off screen. */
    const lineOf = (frame: string, n: number) =>
      frame.split("\n").findIndex((line) => line.trim() === `› row ${n}`);
    let frame = await ui.settle();
    for (let press = 0; press < 40 && view.commands.loadEarlier.calls.length === 0; press += 1) {
      frame = await ui.press(PAGE_UP);
    }
    expect(view.commands.loadEarlier.calls.length === 1, "paging to the top loads earlier history");
    const reading = lineOf(frame, 100);
    expect(reading > 0, "row 100 is on screen at the top", frame);
    view.setProjection(projection({ selection, items: rows(50) }), { hasMoreHistory: true });
    frame = await ui.settle();
    expect(lineOf(frame, 100) === reading, "row 100 stays where it was read", frame);
    frame = await ui.press(PAGE_UP);
    expect(
      lineOf(frame, 100) === -1 && lineOf(frame, 99) >= 0,
      "the next page up reads just above it",
      frame,
    );
    await ui.dispose();
  },

  async "a thread that can't load says why instead of loading forever"() {
    const view = createFakeView([codex]);
    view.setThreadState({ status: "synchronizing", error: Option.some("Thread not found.") });
    const ui = await mount(view, { width: 80, height: 24 });
    let frame = await ui.frame("the reason shows", (current) =>
      current.includes("Could not load this thread: Thread not found."),
    );
    expect(!frame.includes("Loading thread"), "no endless loading", frame);
    view.setProjection(projection({ selection, items: [userMessage("u1", 0, "hello")] }), {
      error: "History request failed.",
    });
    frame = await ui.frame("the history error shows", (current) =>
      current.includes("Could not load earlier messages: History request failed."),
    );
    await ui.dispose();
  },

  async "rapid arrows then enter answer the option they reached"() {
    const view = createFakeView([codex]);
    const options = ["one", "two", "three"].map((label) => ({ label, description: label }));
    const { item, request } = pendingQuestion("q4", [{ ...question, options }]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view);
    // All before React commits.
    ui.setup.mockInput.pressArrow("down");
    ui.setup.mockInput.pressArrow("down");
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    const answers = view.commands.respondToUserInput.calls[0]?.answers;
    expect(answers?.q === "three", `both arrows count: ${JSON.stringify(answers)}`);
    await ui.dispose();
  },

  async "rapid picks on a multi-select all count"() {
    const view = createFakeView([codex]);
    const options = ["one", "two", "three"].map((label) => ({ label, description: label }));
    const { item, request } = pendingQuestion("q5", [{ ...question, options, multiSelect: true }]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view);
    ui.setup.mockInput.pressKey("TAB");
    ui.setup.mockInput.pressArrow("down");
    ui.setup.mockInput.pressKey("TAB");
    ui.setup.mockInput.pressEnter();
    await ui.settle();
    const answers = view.commands.respondToUserInput.calls[0]?.answers;
    expect(
      JSON.stringify(answers?.q) === JSON.stringify(["one", "two"]),
      `both picks count: ${JSON.stringify(answers)}`,
    );
    await ui.dispose();
  },

  async "failed history, cancel and dismiss commands say so"() {
    const view = createFakeView([codex]);
    const failed = (error: string) => ({ ok: false as const, error });
    view.commands.loadEarlier.next = failed("history is gone");
    view.commands.cancelQueuedRun.next = failed("already started");
    view.commands.dismissUserInput.next = failed("request expired");
    const queued = run("r2", 2, "queued", selection);
    const { item, request } = pendingQuestion("q6", [question]);
    view.setProjection(
      projection({
        selection,
        items: [item],
        requests: [request],
        runs: [run("r1", 1, "running", selection), queued],
        messages: [{ id: queued.userMessageId, text: "queued follow-up" }],
      }),
      { hasMoreHistory: true },
    );
    const ui = await mount(view, { width: 100, height: 40 });
    await ui.frame("the queued message shows", (frame) => frame.includes("queued follow-up"));
    let frame = await ui.press("x", { ctrl: true });
    expect(frame.includes("Could not cancel the queued message: already started"), "cancel", frame);
    // A lone ESC reaches the app only after the input parser's escape timeout.
    ui.setup.mockInput.pressKey("ESCAPE");
    await ui.frame("the dismiss failure shows", (current) =>
      current.includes("Could not dismiss the question: request expired"),
    );
    for (let press = 0; press < 20 && view.commands.loadEarlier.calls.length === 0; press += 1) {
      frame = await ui.press(PAGE_UP);
    }
    expect(frame.includes("Could not load earlier messages: history is gone"), "history", frame);
    await ui.dispose();
  },

  async "a queue held by stop says it's held and how to resume it"() {
    const view = createFakeView([codex]);
    const held = { ...run("r2", 2, "queued", selection), queueHeld: true };
    view.setProjection(
      projection({
        selection,
        runs: [run("r1", 1, "interrupted", selection), held],
        messages: [{ id: held.userMessageId, text: "queued follow-up" }],
      }),
    );
    const ui = await mount(view, { width: 100, height: 24 });
    const frame = await ui.frame("the queue shows", (current) =>
      current.includes("queued follow-up"),
    );
    expect(frame.includes("held: queued follow-up"), "the message reads as held", frame);
    expect(frame.includes("sending a message resumes them"), "the view says how to resume", frame);
    console.log(
      frame
        .split("\n")
        .filter((line) => line.includes("held"))
        .join("\n"),
    );
    await ui.dispose();
  },

  async "loading earlier history keeps a one-line work row where it was read"() {
    const view = createFakeView([codex]);
    const rows = (from: number) =>
      Array.from({ length: 150 - from }, (_, index) =>
        reasoning(`w${from + index}`, from + index, `row ${from + index}`),
      );
    view.setProjection(projection({ selection, items: rows(100) }), { hasMoreHistory: true });
    const ui = await mount(view, { width: 80, height: 24 });
    const lineOf = (frame: string, n: number) =>
      frame.split("\n").findIndex((line) => line.trim() === `… Thinking - row ${n}`);
    let frame = await ui.settle();
    for (let press = 0; press < 40 && view.commands.loadEarlier.calls.length === 0; press += 1) {
      frame = await ui.press(PAGE_UP);
    }
    const reading = lineOf(frame, 100);
    expect(reading > 0, "row 100 is on screen at the top", frame);
    view.setProjection(projection({ selection, items: rows(50) }), { hasMoreHistory: true });
    frame = await ui.settle();
    expect(lineOf(frame, 100) === reading, `row 100 stays on line ${reading}`, frame);
    console.log(frame.split("\n").slice(0, 4).join("\n"));
    await ui.dispose();
  },

  async "sending under an approval keeps the message and asks for an answer first"() {
    const view = createFakeView([codex]);
    const running = run("r1", 1, "running", selection);
    const { item, request } = pendingApproval("a3", "rm -rf build");
    view.setProjection(
      projection({ selection, runs: [running], items: [item], requests: [request] }),
    );
    const ui = await mount(view);
    await ui.frame("the approval is armed", (frame) => frame.includes("[a] accept"));
    await ui.setup.mockInput.typeText("then run the tests");
    const frame = await ui.enter();
    expect(view.commands.startTurn.calls.length === 0, "nothing is sent into the blocked run");
    expect(frame.includes("Answer the approval first"), "the view says why", frame);
    expect(frame.includes("then run the tests"), "the message stays in the composer", frame);
    await ui.dispose();
  },

  async "keys typed while an approval answer is in flight reach the composer"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingApproval("a4", "rm -rf build");
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    view.commands.respondToApproval.next = "hold";
    const ui = await mount(view);
    await ui.frame("the approval is armed", (frame) => frame.includes("[a] accept"));
    await ui.setup.mockInput.typeText("add");
    const frame = await ui.settle();
    expect(view.commands.respondToApproval.calls.length === 1, "the first a answers once");
    expect(frame.includes("│ dd"), "the keys after it land in the composer", frame);
    view.commands.respondToApproval.release();
    await ui.dispose();
  },

  async "a long approval shows the command's start and end, and says what's hidden"() {
    const lines = [
      "rm -rf with the following arguments:",
      ...Array.from({ length: 40 }, (_, index) => `  filler-line-${index} lorem ipsum dolor`),
      "TARGET=/very/important/production.db",
    ];
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      const view = createFakeView([codex]);
      const { item, request } = pendingApproval("a5", lines.join("\n"));
      view.setProjection(projection({ selection, items: [item], requests: [request] }));
      const ui = await mount(view, { width, height });
      const frame = await ui.frame("the approval is armed", (current) =>
        current.includes("[a] accept"),
      );
      expect(frame.includes("rm -rf with the following arguments:"), "the start shows", frame);
      expect(frame.includes("TARGET=/very/important/production.db"), "the end shows", frame);
      expect(/… \d+ lines hidden …/u.test(frame), "the cut says how much", frame);
      expect(
        frame.includes("enter send") && frame.includes("Message"),
        "the composer shows",
        frame,
      );
      console.log(`--- ${width}x${height}\n${frame}`);
      await ui.dispose();
    }
  },

  async "a long question shows all of its text when the panel has room"() {
    const view = createFakeView([codex]);
    const text =
      "The migration touches the users table, the sessions table and the audit log. " +
      "Each has a legacy column that nothing reads any more, and the indexes on them slow " +
      "every write. The backfill finished last week and the dashboards moved to the new " +
      "columns. Before I write the down migration: should I drop the legacy column?";
    const { item, request } = pendingQuestion("q7", [
      { ...question, question: text, options: [{ label: "yes", description: "Drop it" }] },
    ]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view, { width: 120, height: 40 });
    const frame = await ui.frame("the question shows", (current) => current.includes("migration"));
    // The transcript's one-line summary can end with it too, so look inside the panel.
    const panel = frame.split("\n").filter((line) => line.startsWith("│"));
    expect(
      panel.some((line) => line.includes("should I drop the legacy column?")),
      "its last sentence shows in the panel",
      frame,
    );
    expect(!frame.includes("more lines"), "nothing is cut", frame);
    console.log(frame);
    await ui.dispose();
  },

  async "a question with ten queued messages keeps the composer on screen at 80x24"() {
    const view = createFakeView([codex]);
    const queued = Array.from({ length: 10 }, (_, index) =>
      run(`q${index}`, index + 2, "queued", selection),
    );
    const { item, request } = pendingQuestion("q8", [
      {
        ...question,
        options: Array.from({ length: 4 }, (_, index) => ({
          label: `Approach ${index}`,
          description: "A valid possible implementation for the task. ".repeat(8).trim(),
        })),
      },
    ]);
    view.setProjection(
      projection({
        selection,
        items: [item],
        requests: [request],
        runs: [run("r1", 1, "running", selection), ...queued],
        messages: queued.map((entry, index) => ({
          id: entry.userMessageId,
          text: `follow-up ${index}`,
        })),
      }),
    );
    const ui = await mount(view, { width: 80, height: 24 });
    await ui.setup.mockInput.typeText("custom answer");
    const frame = await ui.settle();
    expect(frame.includes("custom answer"), "the typed answer shows", frame);
    expect(frame.includes("enter send"), "the key hints show", frame);
    expect(
      frame.includes("+7 more queued") && frame.includes("follow-up 9"),
      "the queue is windowed",
      frame,
    );
    console.log(frame);
    await ui.dispose();
  },

  async "an eight-line draft keeps the key hints on screen at 80x24"() {
    const view = createFakeView([codex]);
    const { item, request } = pendingQuestion("q9", [
      {
        ...question,
        options: Array.from({ length: 4 }, (_, index) => ({
          label: `Approach ${index}`,
          description: "A valid possible implementation for the task. ".repeat(8).trim(),
        })),
      },
    ]);
    view.setProjection(projection({ selection, items: [item], requests: [request] }));
    const ui = await mount(view, { width: 80, height: 24 });
    for (let line = 1; line <= 8; line += 1) {
      await ui.setup.mockInput.typeText(`draft line ${line}`);
      // Ctrl+J: a legacy terminal sends shift+enter as a plain enter.
      if (line < 8) ui.setup.mockInput.pressKey("LINEFEED");
    }
    const frame = await ui.settle();
    expect(frame.includes("draft line 8"), "the draft shows", frame);
    expect(frame.includes("Approach 0"), "the question is still open", frame);
    expect(frame.includes("enter send") && frame.includes("^c quit"), "the key hints show", frame);
    console.log(frame);
    await ui.dispose();
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
