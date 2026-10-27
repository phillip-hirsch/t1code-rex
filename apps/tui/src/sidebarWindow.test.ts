import { describe, expect, it } from "vite-plus/test";

import { presentedThread, projectShell } from "./shellTestFixtures.ts";
import { buildSidebarGroups, buildSidebarRows } from "./sidebarModel.ts";
import { buildSidebarLines, clampScrollTop, revealLine, scrollbarThumb } from "./sidebarWindow.ts";

describe("buildSidebarLines", () => {
  it("closes each expanded project with its notes", () => {
    const groups = buildSidebarGroups({
      projects: [projectShell("a"), projectShell("b"), projectShell("c")],
      threads: [presentedThread("a1", "a")],
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });
    const rows = buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["a", "b"]),
      showAllProjectIds: new Set(),
      previewCount: 5,
      activeThreadId: null,
    });
    const lines = buildSidebarLines({
      rows,
      expandedProjectIds: new Set(["a", "b"]),
      threadCountByProject: new Map([
        ["a", 1],
        ["b", 0],
        ["c", 0],
      ]),
      olderSettledByProject: new Map([
        ["a", 2],
        ["c", 4],
      ]),
    });
    expect(lines.map((line) => line.key)).toEqual([
      "project:a",
      "thread:a1",
      "older:a",
      "project:b",
      "empty:b",
      "project:c",
    ]);
    expect(lines[2]).toMatchObject({ kind: "note", text: "2 older settled threads" });
    // Lines that are rows are the row objects themselves.
    expect(lines[1]).toBe(rows[1]);
  });
});

describe("clampScrollTop", () => {
  it("keeps the window inside the list", () => {
    expect(clampScrollTop(-3, 40, 10)).toBe(0);
    expect(clampScrollTop(12, 40, 10)).toBe(12);
    expect(clampScrollTop(35, 40, 10)).toBe(30);
    // The list shrank below the viewport.
    expect(clampScrollTop(8, 6, 10)).toBe(0);
  });
});

describe("revealLine", () => {
  it("scrolls the least needed to show a line", () => {
    expect(revealLine(10, 10, 15)).toBe(10);
    expect(revealLine(10, 10, 4)).toBe(4);
    expect(revealLine(10, 10, 20)).toBe(11);
    expect(revealLine(0, 10, 39)).toBe(30);
  });

  it("leaves the scroll alone with no cursor or no viewport", () => {
    expect(revealLine(7, 10, -1)).toBe(7);
    expect(revealLine(7, 0, 3)).toBe(7);
  });
});

describe("scrollbarThumb", () => {
  it("hides when everything fits", () => {
    expect(scrollbarThumb(10, 10, 0)).toBeNull();
    expect(scrollbarThumb(3, 0, 0)).toBeNull();
  });

  it("sizes and places the thumb by the visible share", () => {
    expect(scrollbarThumb(40, 10, 0)).toEqual({ start: 0, size: 3 });
    expect(scrollbarThumb(40, 10, 30)).toEqual({ start: 7, size: 3 });
    expect(scrollbarThumb(40, 10, 15)).toEqual({ start: 4, size: 3 });
    expect(scrollbarThumb(1000, 10, 0)).toEqual({ start: 0, size: 1 });
  });
});

describe("subagent notes", () => {
  it("puts a note under an opened thread with no subagent rows, and none under one with them", () => {
    const groups = buildSidebarGroups({
      projects: [projectShell("a")],
      threads: [presentedThread("a1", "a"), presentedThread("a2", "a")],
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });
    const rows = buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["a"]),
      showAllProjectIds: new Set(),
      previewCount: 5,
      activeThreadId: null,
      subagents: {
        childrenByParent: new Map(),
        isOpen: (id) => id === "a1",
        activeAncestors: [],
      },
    });
    const lines = buildSidebarLines({
      rows,
      expandedProjectIds: new Set(["a"]),
      threadCountByProject: new Map([["a", 2]]),
      olderSettledByProject: new Map(),
    });
    const note = lines.find((line) => line.key === "subagents:a1");
    expect(note).toMatchObject({ kind: "note", subagentsOf: "a1", depth: 1 });
    expect(lines.some((line) => line.key === "subagents:a2")).toBe(false);
  });
});
