import { describe, expect, it } from "vite-plus/test";

import { presentedThread, projectShell } from "./shellTestFixtures.ts";
import { buildSidebarGroups, buildSidebarRows } from "./sidebarModel.ts";
import {
  moveCursor,
  nearestSurvivor,
  reconcileSelection,
  resolveCursorKey,
  resolveInitialSelection,
} from "./sidebarNavigation.ts";

const groups = buildSidebarGroups({
  projects: [projectShell("alpha"), projectShell("beta"), projectShell("empty")],
  threads: [presentedThread("a1", "alpha"), presentedThread("b1", "beta")],
  projectSortOrder: "manual",
  threadSortOrder: "updated_at",
});
const rows = buildSidebarRows({
  groups,
  expandedProjectIds: new Set(["alpha", "beta"]),
  showAllProjectIds: new Set(),
  previewCount: 6,
  activeThreadId: null,
});

describe("moveCursor", () => {
  it("walks rows and stops at the ends", () => {
    expect(moveCursor(rows, "project:alpha", 1)?.key).toBe("thread:a1");
    expect(moveCursor(rows, "thread:a1", 1)?.key).toBe("project:beta");
    expect(moveCursor(rows, "project:alpha", -1)?.key).toBe("project:alpha");
    expect(moveCursor(rows, "project:empty", 1)?.key).toBe("project:empty");
  });

  it("starts at the top when the cursor is gone", () => {
    expect(moveCursor(rows, "thread:missing", 1)?.key).toBe("project:alpha");
    expect(moveCursor([], null, 1)).toBeNull();
  });
});

describe("nearestSurvivor", () => {
  const order = ["a", "b", "c", "d"];

  it("keeps a live item", () => {
    expect(nearestSurvivor(order, () => true, "b")).toBe("b");
  });

  it("falls to the next live item, then the previous one", () => {
    expect(nearestSurvivor(order, (id) => id !== "b", "b")).toBe("c");
    expect(nearestSurvivor(order, (id) => id === "a", "c")).toBe("a");
    expect(nearestSurvivor(order, () => false, "c")).toBeNull();
    expect(nearestSurvivor(order, () => false, "unknown")).toBeNull();
  });
});

describe("resolveInitialSelection", () => {
  const base = { groups, launch: null, savedProjectId: undefined, savedThreadId: undefined };

  it("opens a thread tab on its launched thread", () => {
    expect(
      resolveInitialSelection({
        ...base,
        launch: { projectId: "beta", threadId: "b1" },
        savedThreadId: "a1",
        cwd: undefined,
      }),
    ).toEqual({ projectId: "beta", threadId: "b1" });
  });

  it("restores the saved thread while it exists", () => {
    expect(resolveInitialSelection({ ...base, savedThreadId: "b1", cwd: undefined })).toEqual({
      projectId: "beta",
      threadId: "b1",
    });
  });

  it("falls back to the saved project's latest thread, then the working directory", () => {
    expect(
      resolveInitialSelection({
        ...base,
        savedProjectId: "beta",
        savedThreadId: "gone",
        cwd: undefined,
      }),
    ).toEqual({ projectId: "beta", threadId: "b1" });
    expect(resolveInitialSelection({ ...base, cwd: "/workspace/empty/" })).toEqual({
      projectId: "empty",
      threadId: null,
    });
  });

  it("picks the first project, or nothing when there are none", () => {
    expect(resolveInitialSelection({ ...base, cwd: "/elsewhere" })).toEqual({
      projectId: "alpha",
      threadId: "a1",
    });
    expect(resolveInitialSelection({ ...base, groups: [], cwd: undefined })).toEqual({
      projectId: null,
      threadId: null,
    });
  });
});

describe("reconcileSelection", () => {
  const before = buildSidebarGroups({
    projects: [projectShell("alpha"), projectShell("beta")],
    threads: [
      presentedThread("a1", "alpha"),
      presentedThread("a2", "alpha"),
      presentedThread("a3", "alpha"),
      presentedThread("b1", "beta"),
    ],
    projectSortOrder: "manual",
    threadSortOrder: "created_at",
  });
  const order = before[0]?.threads.map((thread) => thread.id) ?? [];
  const after = (keep: (id: string) => boolean, projects = ["alpha", "beta"]) =>
    before
      .filter((group) => projects.includes(group.project.id))
      .map((group) => ({ ...group, threads: group.threads.filter((t) => keep(t.id)) }));

  it("keeps a selection that is still listed", () => {
    const selection = { projectId: "alpha", threadId: order[1] ?? null };
    expect(reconcileSelection(selection, before, before)).toBe(selection);
  });

  it("moves to the next thread when the selected one is archived", () => {
    const removed = order[1] ?? "";
    expect(
      reconcileSelection(
        { projectId: "alpha", threadId: removed },
        before,
        after((id) => id !== removed),
      ),
    ).toEqual({ projectId: "alpha", threadId: order[2] });
  });

  it("follows a thread that moved to another project", () => {
    const moved = before.map((group) =>
      group.project.id === "beta"
        ? { ...group, threads: [...group.threads, ...(before[0]?.threads.slice(0, 1) ?? [])] }
        : { ...group, threads: group.threads.slice(1) },
    );
    expect(
      reconcileSelection({ projectId: "alpha", threadId: order[0] ?? null }, before, moved),
    ).toEqual({ projectId: "beta", threadId: order[0] });
  });

  it("hands a removed project's selection to its neighbor", () => {
    expect(
      reconcileSelection(
        { projectId: "alpha", threadId: order[0] ?? null },
        before,
        after(() => true, ["beta"]),
      ),
    ).toEqual({ projectId: "beta", threadId: null });
  });

  it("keeps a thread the sidebar never listed", () => {
    const selection = { projectId: "alpha", threadId: "subagent-child" };
    expect(
      reconcileSelection(
        selection,
        before,
        after(() => true),
      ),
    ).toBe(selection);
  });
});

describe("resolveCursorKey", () => {
  it("keeps a listed cursor and otherwise falls back to the selection", () => {
    expect(resolveCursorKey(rows, "project:beta", { projectId: null, threadId: null })).toBe(
      "project:beta",
    );
    expect(resolveCursorKey(rows, "thread:gone", { projectId: "beta", threadId: "b1" })).toBe(
      "thread:b1",
    );
    expect(resolveCursorKey(rows, "thread:gone", { projectId: "empty", threadId: "x" })).toBe(
      "project:empty",
    );
    expect(resolveCursorKey(rows, null, { projectId: null, threadId: null })).toBe("project:alpha");
    expect(resolveCursorKey([], "thread:a1", { projectId: null, threadId: null })).toBeNull();
  });
});
