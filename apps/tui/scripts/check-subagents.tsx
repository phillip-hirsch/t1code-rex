// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks subagent rows, keys and the child view under OpenTUI's real renderer (Bun only).
 * Each render-isolation check runs a naive control too, so it proves it can fail.
 *   bun apps/tui/scripts/check-subagents.tsx
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { testRender } from "@opentui/react/test-utils";
import {
  RunId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";

import { at, presentedThread, projectShell } from "../src/shellTestFixtures.ts";
import { Sidebar, type SidebarSubagentSource } from "../src/sidebar.tsx";
import { useSidebarController } from "../src/sidebarController.ts";
import { resolveSidebarKey } from "../src/sidebarKeys.ts";
import type { SidebarThread } from "../src/sidebarModel.ts";
import {
  PROVIDER_SUBAGENT_READ_ONLY_REASON,
  type SubagentTurnItem,
} from "../src/subagentPresentation.ts";
import { childThread, subagentItem, subagentRecord } from "../src/subagentTestFixtures.ts";
import {
  SubagentComposerBar,
  SubagentParentLine,
  SubagentTimelineRow,
  type SubagentActions,
} from "../src/subagentViews.tsx";
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

// Live rows tick their elapsed time, so the waits run inside act too.
async function settle(render: () => Promise<void>, passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await act(async () => {
      await render();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

/** The cell where `text` starts in the frame, for clicks. */
function locate(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y]?.indexOf(text) ?? -1;
    if (x >= 0) return { x, y };
  }
  throw new Error(`"${text}" is not on screen:\n${frame}`);
}

const theme = DEFAULT_TUI_THEME;

const project = projectShell("p", { title: "tr3x" });
const parent = presentedThread("parent", "p", {
  title: "Refactor auth",
  updatedAt: at("2026-06-20T03:00:00.000Z"),
});
const liveChild = childThread("live", "p", "parent", {
  title: "List files",
  status: "running",
  activeRunId: RunId.make("run-live"),
  createdAt: at("2026-06-20T03:00:01.000Z"),
});
const doneChild = childThread("done", "p", "parent", {
  title: "Print cwd",
  status: "completed",
  createdAt: at("2026-06-20T03:00:02.000Z"),
});
const other = presentedThread("other", "p", {
  title: "Docs pass",
  updatedAt: at("2026-06-20T02:00:00.000Z"),
});
const otherChild = childThread("other-child", "p", "other", {
  title: "Check links",
  status: "completed",
});

interface SidebarFixture {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly source: {
    readonly projectsAtom: Atom.Atom<ReadonlyArray<OrchestrationProjectShell>>;
    readonly threadShellsAtom: Atom.Atom<ReadonlyArray<SidebarThread>>;
    readonly hasShellSnapshotAtom: Atom.Atom<boolean>;
    readonly olderSettledAtom: Atom.Atom<OrchestrationV2ShellSnapshot["olderSettled"]>;
  };
  readonly records: Atom.Writable<ReadonlyMap<string, OrchestrationV2Subagent>>;
  readonly recordAtoms: (childId: string) => Atom.Atom<OrchestrationV2Subagent | null>;
  readonly calls: { readonly recordAtom: number; readonly harness: number };
  readonly count: (counter: "recordAtom" | "harness") => void;
}

function sidebarFixture(): SidebarFixture {
  const registry = AtomRegistry.make();
  const calls = { recordAtom: 0, harness: 0 };
  const records = Atom.make<ReadonlyMap<string, OrchestrationV2Subagent>>(
    new Map([
      [
        "live",
        subagentRecord("sub-live", {
          childThreadId: "live",
          title: "List files",
          progress: "Reading src",
        }),
      ],
      [
        "done",
        subagentRecord("sub-done", {
          childThreadId: "done",
          title: "Print cwd",
          status: "completed",
          result: "/repo",
          completedAt: "2026-06-20T10:00:03.000Z",
        }),
      ],
    ]),
  );
  // One atom per child, as the connection's `subagentForChildAtom` family has them.
  const recordAtoms = Atom.family((childId: string) =>
    Atom.make((get) => get(records).get(childId) ?? null),
  );
  return {
    registry,
    source: {
      projectsAtom: Atom.make<ReadonlyArray<OrchestrationProjectShell>>([project]),
      threadShellsAtom: Atom.make<ReadonlyArray<SidebarThread>>([
        parent,
        liveChild,
        doneChild,
        other,
        otherChild,
      ]),
      hasShellSnapshotAtom: Atom.make(true),
      olderSettledAtom: Atom.make<OrchestrationV2ShellSnapshot["olderSettled"]>(undefined),
    },
    records,
    recordAtoms,
    calls,
    count: (counter) => {
      calls[counter] += 1;
    },
  };
}

const PREFS = { selectedThreadId: "parent", expandedProjectIds: ["p"] };
const familyRead = Atom.make("settled" as const);

/** The sidebar as the shell wires it: the real controller, keys, and per-row record atoms. */
function WiredSidebar(props: { readonly fixture: SidebarFixture }) {
  const { fixture } = props;
  fixture.count("harness");
  const sidebar = useSidebarController({
    connection: fixture.source,
    initialPrefs: PREFS,
    prefsWriter: null,
    launch: null,
    cwd: "/nowhere",
  });
  useSyncKeyboard((key) => {
    const action = resolveSidebarKey(key, { hasMultiSelection: false });
    if (action !== null) sidebar.applyKey(action);
  });
  const subagentSource = useStableSource(fixture);
  return <SidebarView sidebar={sidebar} source={subagentSource} />;
}

const sources = new WeakMap<SidebarFixture, SidebarSubagentSource>();
function useStableSource(fixture: SidebarFixture): SidebarSubagentSource {
  let source = sources.get(fixture);
  if (source === undefined) {
    source = {
      recordAtom: (_parentId, childId) => {
        fixture.count("recordAtom");
        return fixture.recordAtoms(childId);
      },
      familyReadAtom: () => familyRead,
    };
    sources.set(fixture, source);
  }
  return source;
}

/** The naive wiring: the shell reads every record and hands the sidebar a fresh source. */
function NaiveSidebar(props: { readonly fixture: SidebarFixture }) {
  const { fixture } = props;
  fixture.count("harness");
  const records = useAtomValue(fixture.records);
  const sidebar = useSidebarController({
    connection: fixture.source,
    initialPrefs: PREFS,
    prefsWriter: null,
    launch: null,
    cwd: "/nowhere",
  });
  const source: SidebarSubagentSource = {
    recordAtom: (_parentId, childId) => {
      fixture.count("recordAtom");
      return Atom.make(records.get(childId) ?? null);
    },
    familyReadAtom: () => familyRead,
  };
  return <SidebarView sidebar={sidebar} source={source} />;
}

function SidebarView(props: {
  readonly sidebar: ReturnType<typeof useSidebarController>;
  readonly source: SidebarSubagentSource;
}) {
  const { sidebar } = props;
  return (
    <box style={{ height: 14, flexDirection: "row" }}>
      <Sidebar
        theme={theme}
        width={48}
        focused
        rows={sidebar.rows}
        projectsById={sidebar.projectsById}
        threadsById={sidebar.threadsById}
        threadCountByProject={sidebar.threadCountByProject}
        olderSettledByProject={sidebar.olderSettledByProject}
        statusByThread={sidebar.statusByThread}
        projectStatusById={sidebar.projectStatusById}
        expandedProjectIds={sidebar.expandedProjectIds}
        activeProjectId={sidebar.selection.projectId}
        activeThreadId={sidebar.selection.threadId}
        cursorKey={sidebar.cursorKey}
        multiSelectedThreadIds={sidebar.multiSelection.threadIds}
        emptyLabel="No projects"
        subagentSource={props.source}
        onPress={(press) =>
          sidebar.pressRow(press.row, {
            ctrl: press.ctrl,
            shift: press.shift,
            toggleSubagents: press.toggleSubagents,
          })
        }
      />
    </box>
  );
}

async function renderWith(registry: AtomRegistry.AtomRegistry, node: ReactNode) {
  const setup = await testRender(
    <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>,
    { width: 110, height: 16, kittyKeyboard: true },
  );
  await settle(setup.renderOnce);
  return setup;
}

async function checkSidebar(wired: boolean): Promise<void> {
  const name = wired ? "S1 sidebar" : "S1 control";
  const fixture = sidebarFixture();
  const setup = await renderWith(
    fixture.registry,
    wired ? <WiredSidebar fixture={fixture} /> : <NaiveSidebar fixture={fixture} />,
  );
  const frame = () => setup.captureCharFrame();
  if (wired) {
    const first = frame();
    console.log(first);
    check(
      `${name}: the running subagent nests with its progress`,
      /List files · Reading src\s+working/.test(first),
      true,
    );
    check(`${name}: the finished one says done`, /Print cwd\s+done/.test(first), true);
    check(`${name}: an idle parent's subagents start folded`, first.includes("Check links"), false);
    check(`${name}: the folded parent has a ▸`, /▸ Docs pass/.test(first), true);
  }

  const before = { ...fixture.calls };
  act(() =>
    fixture.registry.update(fixture.records, (current) =>
      new Map(current).set(
        "live",
        subagentRecord("sub-live", {
          childThreadId: "live",
          title: "List files",
          progress: "Scanning tests",
        }),
      ),
    ),
  );
  await settle(setup.renderOnce);
  check(`${name}: progress shows`, frame().includes("List files · Scanning tests"), true);
  check(
    `${name}: a progress update leaves the sidebar's other rows alone`,
    fixture.calls.recordAtom === before.recordAtom && fixture.calls.harness === before.harness,
    wired,
  );

  if (wired) {
    // ↓↓↓ to the folded parent, → opens its subagents, ↓ lands on the child and opens it.
    for (const key of ["down", "down", "down", "right"]) {
      act(() => setup.mockInput.pressArrow(key as "down" | "right"));
      await settle(setup.renderOnce, 2);
    }
    check(`${name}: → shows an idle parent's subagents`, frame().includes("Check links"), true);
    check(`${name}: and the parent's glyph turns`, /▾ Docs pass/.test(frame()), true);
    act(() => setup.mockInput.pressArrow("down"));
    await settle(setup.renderOnce, 2);
    act(() => setup.mockInput.pressArrow("left"));
    await settle(setup.renderOnce, 2);
    act(() => setup.mockInput.pressArrow("left"));
    await settle(setup.renderOnce, 2);
    check(`${name}: ← climbs to the parent, then folds it`, frame().includes("Check links"), false);
  }
  setup.renderer.destroy();
}

function itemOf(projected: ReturnType<typeof subagentItem>): SubagentTurnItem {
  if (projected.item.type !== "subagent") throw new Error("not a subagent item");
  return projected.item;
}

const ITEMS = [
  itemOf(subagentItem("a", { title: "List files" })),
  itemOf(subagentItem("b", { title: "Print cwd", status: "completed" })),
  itemOf(subagentItem("c", { title: "Codex helper", driver: "codex" })),
];

interface TranscriptFixture {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly records: Atom.Writable<ReadonlyMap<string, OrchestrationV2Subagent>>;
  readonly calls: Map<string, number>;
  readonly events: string[];
  readonly actions: SubagentActions;
}

function transcriptFixture(): TranscriptFixture {
  const registry = AtomRegistry.make();
  const records = Atom.make<ReadonlyMap<string, OrchestrationV2Subagent>>(
    new Map([
      ["sub-a", subagentRecord("sub-a", { childThreadId: "child-a", progress: "Reading src" })],
      [
        "sub-b",
        subagentRecord("sub-b", {
          childThreadId: "child-b",
          title: "Print cwd",
          status: "completed",
          result: "/repo",
          completedAt: "2026-06-20T10:00:03.000Z",
        }),
      ],
      [
        "sub-c",
        subagentRecord("sub-c", {
          childThreadId: "child-c",
          title: "Codex helper",
          driver: "codex",
          providerInstanceId: "codex",
          model: null,
          nativeTaskRef: null,
        }),
      ],
    ]),
  );
  const recordAtom = Atom.family((id: string) => Atom.make((get) => get(records).get(id) ?? null));
  const calls = new Map<string, number>();
  const events: string[] = [];
  return {
    registry,
    records,
    calls,
    events,
    actions: {
      recordAtom: (_threadId, subagentId) => {
        calls.set(subagentId, (calls.get(subagentId) ?? 0) + 1);
        return recordAtom(subagentId);
      },
      childRecordAtom: (_parentId, childId) =>
        Atom.make(
          (get) => [...get(records).values()].find((r) => r.childThreadId === childId) ?? null,
        ),
      onOpenThread: (threadId) => events.push(`open:${threadId}`),
      onStop: (threadId, subagentId) => events.push(`stop:${threadId}:${subagentId}`),
      onOpenInRex: (threadId) => events.push(`rex:${threadId}`),
    },
  };
}

function Rows(props: { readonly actions: SubagentActions }) {
  return (
    <box style={{ flexDirection: "column", width: 100 }}>
      {ITEMS.map((item) => (
        <SubagentTimelineRow
          key={item.id}
          id={`row:${item.id}`}
          threadId="parent"
          item={item}
          marginBottom={0}
          maxWidth="100%"
          theme={theme}
          actions={props.actions}
        />
      ))}
    </box>
  );
}

/** The naive wiring: the view reads every record and hands rows fresh actions. */
function NaiveRows(props: { readonly fixture: TranscriptFixture }) {
  const records = useAtomValue(props.fixture.records);
  const actions: SubagentActions = {
    ...props.fixture.actions,
    recordAtom: (threadId, subagentId) => {
      props.fixture.actions.recordAtom(threadId, subagentId);
      return Atom.make(records.get(subagentId) ?? null);
    },
  };
  return <Rows actions={actions} />;
}

async function checkTranscript(wired: boolean): Promise<void> {
  const name = wired ? "S2 transcript" : "S2 control";
  const fixture = transcriptFixture();
  const setup = await renderWith(
    fixture.registry,
    wired ? <Rows actions={fixture.actions} /> : <NaiveRows fixture={fixture} />,
  );
  const frame = () => setup.captureCharFrame();
  if (wired) {
    const first = frame();
    console.log(first);
    check(`${name}: title, model and status`, /List files · .*Haiku.*Working/.test(first), true);
    check(`${name}: progress under it`, first.includes("Reading src"), true);
    check(
      `${name}: the finished one's result`,
      /Completed/.test(first) && first.includes("/repo"),
      true,
    );
    check(`${name}: stop only where web allows`, first.split("󰓛 stop").length - 1, 1);
    check(`${name}: a Rex tab button per child`, first.split("⧉ tab").length - 1, 3);
  }
  const before = new Map(fixture.calls);
  act(() =>
    fixture.registry.update(fixture.records, (current) =>
      new Map(current).set(
        "sub-a",
        subagentRecord("sub-a", { childThreadId: "child-a", progress: "Scanning tests" }),
      ),
    ),
  );
  await settle(setup.renderOnce);
  check(`${name}: progress shows`, frame().includes("Scanning tests"), true);
  check(
    `${name}: a progress update re-renders only its own row`,
    fixture.calls.get("sub-b") === before.get("sub-b") &&
      fixture.calls.get("sub-c") === before.get("sub-c"),
    wired,
  );
  if (wired) {
    const stop = locate(frame(), "󰓛 stop");
    await act(() => setup.mockMouse.click(stop.x + 1, stop.y));
    check(`${name}: 󰓛 stop stops that subagent`, fixture.events.at(-1), "stop:parent:sub-a");
    const rex = locate(frame(), "⧉ tab");
    await act(() => setup.mockMouse.click(rex.x + 1, rex.y));
    check(`${name}: ⧉ tab opens its child in Rex`, fixture.events.at(-1), "rex:child-a");
    const row = locate(frame(), "Print cwd");
    await act(() => setup.mockMouse.click(row.x + 1, row.y));
    check(`${name}: a click opens the child`, fixture.events.at(-1), "open:child-b");
  }
  setup.renderer.destroy();
}

async function checkChildView(): Promise<void> {
  const fixture = transcriptFixture();
  const context = { parentThreadId: "parent", parentTitle: "Refactor auth", readOnly: true };
  const setup = await renderWith(
    fixture.registry,
    <box style={{ flexDirection: "column", width: 100 }}>
      <SubagentParentLine
        threadId="child-a"
        context={context}
        theme={theme}
        actions={fixture.actions}
      />
      <SubagentComposerBar
        threadId="child-a"
        context={context}
        modelLabel="Claude Haiku"
        fallbackState="working"
        reason={PROVIDER_SUBAGENT_READ_ONLY_REASON}
        theme={theme}
        actions={fixture.actions}
      />
    </box>,
  );
  const frame = setup.captureCharFrame();
  console.log(frame);
  check("S3 child: links its parent", frame.includes("↖ Subagent of Refactor auth  (p)"), true);
  check("S3 child: says why it takes no messages", frame.includes("takes no messages"), true);
  const link = locate(frame, "Subagent of");
  await act(() => setup.mockMouse.click(link.x, link.y));
  check("S3 child: the link opens the parent", fixture.events.at(-1), "open:parent");
  const stop = locate(frame, "󰓛 stop");
  await act(() => setup.mockMouse.click(stop.x + 1, stop.y));
  check("S3 child: 󰓛 stop stops it through its parent", fixture.events.at(-1), "stop:parent:sub-a");
  setup.renderer.destroy();
}

await checkSidebar(true);
await checkSidebar(false);
await checkTranscript(true);
await checkTranscript(false);
await checkChildView();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall subagent checks passed");
process.exit(0);
