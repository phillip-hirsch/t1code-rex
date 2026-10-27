import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { renderHook } from "./hookTestRenderer.ts";
import { presentedThread, projectShell } from "./shellTestFixtures.ts";
import { useSidebarController } from "./sidebarController.ts";
import { useSubagentControls } from "./subagentController.ts";
import { childThread } from "./subagentTestFixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NO_RECORD = Atom.make<OrchestrationV2Subagent | null>(null);

/**
 * A Rex child tab opened on an idle subagent the shell left out: its row arrives only with
 * its family. Mounting the family by the child's id adds the row, as the real merge does;
 * the parent's own read stays pending.
 */
function childTab() {
  const registry = AtomRegistry.make();
  const parent = presentedThread("parent", "p");
  const child = childThread("child", "p", "parent", { status: "completed" });
  const threadShellsAtom = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([parent]);
  const mounts: string[] = [];
  const connection = {
    projectsAtom: Atom.make<ReadonlyArray<OrchestrationProjectShell>>([projectShell("p")]),
    threadShellsAtom,
    hasShellSnapshotAtom: Atom.make(true),
    olderSettledAtom: Atom.make<OrchestrationV2ShellSnapshot["olderSettled"]>(undefined),
    registry,
    subagentAtom: () => NO_RECORD,
    subagentForChildAtom: () => NO_RECORD,
    subagentsAtom: () => Atom.make<ReadonlyArray<OrchestrationV2Subagent>>([]),
    threadFamilyReadAtom: () => Atom.make("pending" as const),
    stopSubagent: () => Promise.resolve({ ok: true as const, value: { sequence: 0 } }),
    mountThreadFamily: (threadId: string) => {
      mounts.push(threadId);
      if (threadId !== "child") return () => {};
      registry.set(threadShellsAtom, [parent, child]);
      return () => registry.set(threadShellsAtom, [parent]);
    },
  };
  const launch = {
    server: { httpBaseUrl: "http://x", wsBaseUrl: "ws://x", bearerToken: "t" },
    projectId: "p",
    threadId: "child",
  };
  const prefs = {};
  const hook = renderHook(() => {
    const sidebar = useSidebarController({
      connection,
      initialPrefs: prefs,
      prefsWriter: null,
      launch,
      cwd: "/nowhere",
    });
    const subagents = useSubagentControls({
      connection,
      sidebar,
      rexTabs: false,
      openInRex: () => Promise.resolve(),
      runTask: () => {},
      setStatus: () => {},
      onOpened: () => {},
    });
    return { sidebar, subagents };
  }, registry);
  cleanups.push(() => {
    hook.unmount();
    registry.dispose();
  });
  return { hook, mounts };
}

describe("useSubagentControls families", () => {
  it("keeps one mount for an idle child whose row only its family has", () => {
    const { hook, mounts } = childTab();
    expect(mounts).toEqual(["child"]);
    expect(hook.current.sidebar.activeThread?.id).toBe("child");
    expect(hook.current.subagents.context).toMatchObject({
      parentThreadId: "parent",
      readOnly: true,
    });
  });
});
