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
import { moreRowKey, projectRowKey, threadRowKey, type SidebarRow } from "./sidebarModel.ts";
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
    const renders = hook.renders;
    hook.act(() => {});
    expect(hook.renders).toBe(renders);
  });
});
