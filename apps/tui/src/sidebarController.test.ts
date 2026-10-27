import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  RunId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { renderHook } from "./hookTestRenderer.ts";
import type { TuiPrefs } from "./prefs.ts";
import { at, presentedThread, projectShell } from "./shellTestFixtures.ts";
import { useSidebarController } from "./sidebarController.ts";
import { projectRowKey, threadRowKey } from "./sidebarModel.ts";
import { MAX_TRACKED_VISITS } from "./threadVisits.ts";

function finishedRun(completedAt: string): Partial<OrchestrationV2ThreadShell> {
  return {
    latestRunId: RunId.make(`run-${completedAt}`),
    status: "completed",
    latestRunStartedAt: at(completedAt),
    latestRunCompletedAt: at(completedAt),
    updatedAt: at(completedAt),
  };
}

function setup(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly prefs?: TuiPrefs;
}) {
  const registry = AtomRegistry.make();
  const source = {
    projectsAtom: Atom.make(input.projects),
    threadShellsAtom: Atom.make(input.threads),
    hasShellSnapshotAtom: Atom.make(true),
    olderSettledAtom: Atom.make<OrchestrationV2ShellSnapshot["olderSettled"]>(undefined),
  };
  const hook = renderHook(
    () =>
      useSidebarController({
        connection: source,
        initialPrefs: input.prefs ?? {},
        prefsWriter: null,
        launch: null,
        cwd: "/nowhere",
      }),
    registry,
  );
  cleanups.push(() => {
    hook.unmount();
    registry.dispose();
  });
  return {
    hook,
    setThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
      hook.act(() => registry.set(source.threadShellsAtom, threads));
    },
    press(key: string) {
      const row = hook.current.rows.find((candidate) => candidate.key === key);
      if (!row) throw new Error(`no row ${key}`);
      hook.act(() => hook.current.pressRow(row));
    },
    key(name: string) {
      let outcome: ReturnType<typeof hook.current.handleKey> = null;
      hook.act(() => {
        outcome = hook.current.handleKey({ name });
      });
      return outcome;
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("useSidebarController visits", () => {
  it("opens an old finished thread while the visit cache is full of newer ones", () => {
    const visits: Record<string, string> = {};
    for (let index = 0; index < MAX_TRACKED_VISITS; index += 1) {
      visits[`newer-${index}`] = `2026-06-21T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
    }
    const old = presentedThread("old", "p", finishedRun("2026-06-20T01:00:00.000Z"));
    const { hook } = setup({
      projects: [projectShell("p")],
      threads: [old],
      prefs: { selectedThreadId: "old", threadLastVisitedAtById: visits },
    });

    expect(hook.current.selection.threadId).toBe("old");
    expect(hook.current.statusByThread.get("old")).toBeNull();
    const commits = hook.commits;
    hook.act(() => {});
    expect(hook.commits).toBe(commits);
  });
});

describe("useSidebarController selection", () => {
  const projects = [projectShell("a"), projectShell("b")];
  const a1 = presentedThread("a1", "a", { updatedAt: at("2026-06-20T03:00:00.000Z") });
  const b1 = presentedThread("b1", "b", { updatedAt: at("2026-06-20T02:00:00.000Z") });

  it("keeps the open thread and its project when a project row is pressed", () => {
    const sidebar = setup({ projects, threads: [a1, b1], prefs: { selectedThreadId: "a1" } });
    sidebar.press(projectRowKey("b"));

    const { current } = sidebar.hook;
    expect(current.selection).toEqual({ projectId: "a", threadId: "a1" });
    expect(current.activeProject?.id).toBe("a");
    expect(current.cursorKey).toBe(projectRowKey("b"));
    expect(current.expandedProjectIds.has("b")).toBe(true);

    // A shell change neither moves the selection nor snaps the cursor back.
    const a2 = presentedThread("a2", "a", { updatedAt: at("2026-06-20T04:00:00.000Z") });
    sidebar.setThreads([a1, b1, a2]);
    expect(sidebar.hook.current.selection).toEqual({ projectId: "a", threadId: "a1" });
    expect(sidebar.hook.current.cursorKey).toBe(projectRowKey("b"));

    // Pressing it again folds it.
    sidebar.press(projectRowKey("b"));
    expect(sidebar.hook.current.expandedProjectIds.has("b")).toBe(false);
  });

  it("moves only the cursor when the keyboard lands on a project", () => {
    const sidebar = setup({
      projects,
      threads: [a1, b1],
      prefs: { selectedThreadId: "a1", expandedProjectIds: ["a", "b"] },
    });
    expect(sidebar.hook.current.cursorKey).toBe(threadRowKey("a1"));
    expect(sidebar.key("down")).toBe("handled");

    expect(sidebar.hook.current.cursorKey).toBe(projectRowKey("b"));
    expect(sidebar.hook.current.selection).toEqual({ projectId: "a", threadId: "a1" });
    expect(sidebar.hook.current.activeProject?.id).toBe("a");

    sidebar.key("down");
    expect(sidebar.hook.current.selection).toEqual({ projectId: "b", threadId: "b1" });
    expect(sidebar.hook.current.activeProject?.id).toBe("b");
  });
});

describe("useSidebarController unread", () => {
  const done = presentedThread("done", "p", finishedRun("2026-06-20T01:00:00.000Z"));
  const other = presentedThread("other", "p");

  it("clears a mark on the open thread when it is opened again", () => {
    const sidebar = setup({
      projects: [projectShell("p")],
      threads: [done, other],
      prefs: { selectedThreadId: "done" },
    });
    expect(sidebar.hook.current.statusByThread.get("done")).toBeNull();

    sidebar.hook.act(() => sidebar.hook.current.markUnread("done"));
    expect(sidebar.hook.current.statusByThread.get("done")?.label).toBe("Completed");

    sidebar.press(threadRowKey("done"));
    expect(sidebar.hook.current.statusByThread.get("done")).toBeNull();

    sidebar.hook.act(() => sidebar.hook.current.markUnread("done"));
    expect(sidebar.key("return")).toBe("open");
    expect(sidebar.hook.current.statusByThread.get("done")).toBeNull();
  });
});

describe("useSidebarController rows", () => {
  it("keeps unchanged row objects across selection changes and shell updates", () => {
    const t1 = presentedThread("t1", "p", { updatedAt: at("2026-06-20T03:00:00.000Z") });
    const t2 = presentedThread("t2", "p", { updatedAt: at("2026-06-20T02:00:00.000Z") });
    const t3 = presentedThread("t3", "p", { updatedAt: at("2026-06-20T01:00:00.000Z") });
    const sidebar = setup({
      projects: [projectShell("p"), projectShell("q")],
      threads: [t1, t2, t3],
      prefs: { selectedThreadId: "t1" },
    });
    const before = sidebar.hook.current.rows;
    sidebar.press(threadRowKey("t2"));
    expect(sidebar.hook.current.rows).toBe(before);

    // Retitling t3 changes its shell row, not the sidebar rows.
    sidebar.setThreads([t1, t2, { ...t3, title: "renamed" }]);
    expect(sidebar.hook.current.rows).toBe(before);

    // A new thread adds one row; every other row keeps its object.
    const t0 = presentedThread("t0", "p", { updatedAt: at("2026-06-20T05:00:00.000Z") });
    sidebar.setThreads([t0, t1, t2, t3]);
    const after = sidebar.hook.current.rows;
    expect(after.map((row) => row.key)).toEqual([
      projectRowKey("p"),
      threadRowKey("t0"),
      threadRowKey("t1"),
      threadRowKey("t2"),
      threadRowKey("t3"),
      projectRowKey("q"),
    ]);
    for (const row of before) {
      expect(after.find((candidate) => candidate.key === row.key)).toBe(row);
    }
  });
});
