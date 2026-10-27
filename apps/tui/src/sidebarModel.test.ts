import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { at, presentedThread, projectShell } from "./shellTestFixtures.ts";
import {
  buildSidebarGroups,
  buildSidebarRows,
  isSidebarThread,
  shareSidebarRows,
  visibleThreads,
} from "./sidebarModel.ts";
import { childThread } from "./subagentTestFixtures.ts";
import { groupSubagentChildren, subagentsOpen } from "./subagentTree.ts";

const alpha = projectShell("alpha", { title: "Alpha" });
const beta = projectShell("beta", { title: "Beta" });

function thread(id: string, projectId: string, createdAt: string, userMessageAt?: string) {
  return presentedThread(id, projectId, {
    createdAt: at(createdAt),
    updatedAt: at(createdAt),
    latestUserMessageAt: userMessageAt ? at(userMessageAt) : null,
  });
}

describe("buildSidebarGroups", () => {
  const threads = [
    thread("a-old", "alpha", "2026-06-01T00:00:00.000Z", "2026-06-10T00:00:00.000Z"),
    thread("a-new", "alpha", "2026-06-05T00:00:00.000Z"),
    thread("b-1", "beta", "2026-06-02T00:00:00.000Z", "2026-06-20T00:00:00.000Z"),
    thread("orphan", "gone", "2026-06-02T00:00:00.000Z"),
  ];

  it("groups threads under their projects, newest activity first", () => {
    const groups = buildSidebarGroups({
      projects: [alpha, beta],
      threads,
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });
    expect(groups.map((group) => group.project.id)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["a-old", "a-new"]);
  });

  it("sorts threads by creation time when asked", () => {
    const groups = buildSidebarGroups({
      projects: [alpha],
      threads,
      projectSortOrder: "manual",
      threadSortOrder: "created_at",
    });
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["a-new", "a-old"]);
  });

  it("sorts projects by their latest thread activity", () => {
    const groups = buildSidebarGroups({
      projects: [alpha, beta],
      threads,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
    });
    expect(groups.map((group) => group.project.id)).toEqual(["beta", "alpha"]);
  });

  it("leaves out archived threads and subagent children", () => {
    const archived = presentedThread("archived", "alpha", {
      archivedAt: at("2026-06-03T00:00:00Z"),
    });
    const child = presentedThread("child", "alpha", {
      lineage: {
        rootThreadId: ThreadId.make("a-old"),
        parentThreadId: ThreadId.make("a-old"),
        relationshipToParent: "subagent",
      },
    });
    expect(isSidebarThread(archived)).toBe(false);
    expect(isSidebarThread(child)).toBe(false);
    const groups = buildSidebarGroups({
      projects: [alpha],
      threads: [archived, child, ...threads],
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["a-old", "a-new"]);
  });
});

describe("buildSidebarRows", () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    thread(`t${index}`, "alpha", `2026-06-0${9 - index}T00:00:00.000Z`),
  );
  const groups = buildSidebarGroups({
    projects: [alpha, beta],
    threads: many,
    projectSortOrder: "manual",
    threadSortOrder: "updated_at",
  });

  it("lists threads only under expanded projects, with a show-more row past the preview", () => {
    const rows = buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(),
      previewCount: 3,
      activeThreadId: null,
    });
    expect(rows.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:t0",
      "thread:t1",
      "thread:t2",
      "more:alpha",
      "project:beta",
    ]);
    expect(rows[4]).toMatchObject({ kind: "more", hiddenCount: 2 });
  });

  it("offers show fewer once expanded", () => {
    const rows = buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(["alpha"]),
      previewCount: 3,
      activeThreadId: null,
    });
    expect(rows.filter((row) => row.kind === "thread")).toHaveLength(5);
    expect(rows.find((row) => row.kind === "more")).toMatchObject({ hiddenCount: 0 });
  });

  it("lists a selected thread past the preview without widening it", () => {
    expect(
      visibleThreads({
        threads: many,
        previewCount: 2,
        showAll: false,
        activeThreadId: "t3",
      }).map((thread) => thread.id),
    ).toEqual(["t0", "t1", "t3"]);
    const rows = buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(),
      previewCount: 2,
      activeThreadId: "t4",
    });
    expect(rows.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:t0",
      "thread:t1",
      "thread:t4",
      "more:alpha",
      "project:beta",
    ]);
    expect(rows[4]).toMatchObject({ hiddenCount: 2 });
  });
});

describe("buildSidebarRows edge cases", () => {
  it("drops the show-more row when the selected thread is the only one past the preview", () => {
    const three = [0, 1, 2].map((index) =>
      thread(`e${index}`, "alpha", `2026-06-0${5 - index}T00:00:00.000Z`),
    );
    const rows = buildSidebarRows({
      groups: buildSidebarGroups({
        projects: [alpha],
        threads: three,
        projectSortOrder: "manual",
        threadSortOrder: "updated_at",
      }),
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(),
      previewCount: 2,
      activeThreadId: "e2",
    });
    expect(rows.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:e0",
      "thread:e1",
      "thread:e2",
    ]);
  });
});

describe("shareSidebarRows", () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    thread(`t${index}`, "alpha", `2026-06-0${9 - index}T00:00:00.000Z`),
  );
  const groups = buildSidebarGroups({
    projects: [alpha, beta],
    threads: many,
    projectSortOrder: "manual",
    threadSortOrder: "updated_at",
  });
  const build = (activeThreadId: string | null, showAll = false) =>
    buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(showAll ? ["alpha"] : []),
      previewCount: 3,
      activeThreadId,
    });

  it("returns the previous list when a rebuild repeats it", () => {
    const previous = build(null);
    expect(shareSidebarRows(previous, build("t1"))).toBe(previous);
  });

  it("keeps unchanged rows and swaps only the ones that changed", () => {
    const previous = build(null);
    // The selected t4 sorts past the preview, so it joins the list and the more row shrinks.
    const shared = shareSidebarRows(previous, build("t4"));
    expect(shared.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:t0",
      "thread:t1",
      "thread:t2",
      "thread:t4",
      "more:alpha",
      "project:beta",
    ]);
    expect(shared.slice(0, 4)).toEqual(previous.slice(0, 4));
    for (let index = 0; index < 4; index += 1) expect(shared[index]).toBe(previous[index]);
    expect(shared[6]).toBe(previous[5]);
    expect(shared[5]).not.toBe(previous[4]);
    expect(shared[5]).toMatchObject({ kind: "more", hiddenCount: 1 });
  });
});

describe("pinned threads", () => {
  it("lead their project and keep the sort order within each part", () => {
    const groups = buildSidebarGroups({
      projects: [alpha],
      threads: [
        thread("newest", "alpha", "2026-06-03T00:00:00.000Z"),
        presentedThread("pinned-old", "alpha", {
          createdAt: at("2026-06-01T00:00:00.000Z"),
          updatedAt: at("2026-06-01T00:00:00.000Z"),
          pinnedAt: at("2026-06-04T00:00:00.000Z"),
        }),
        thread("middle", "alpha", "2026-06-02T00:00:00.000Z"),
      ],
      projectSortOrder: "manual",
      threadSortOrder: "updated_at",
    });
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["pinned-old", "newest", "middle"]);
  });
});

describe("buildSidebarRows subagents", () => {
  const parent = thread("parent", "alpha", "2026-06-09T00:00:00.000Z");
  const other = thread("other", "alpha", "2026-06-08T00:00:00.000Z");
  const done = childThread("done", "alpha", "parent", { status: "completed" });
  const live = childThread("live", "alpha", "parent", {
    status: "running",
    activeRunId: RunId.make("run-live"),
  });
  const grandchild = childThread("grand", "alpha", "done", { status: "completed" });
  const groups = buildSidebarGroups({
    projects: [alpha],
    threads: [parent, other, done, live, grandchild],
    projectSortOrder: "manual",
    threadSortOrder: "updated_at",
  });
  const childrenByParent = groupSubagentChildren([parent, other, done, live, grandchild]);
  const build = (input: {
    readonly folds?: ReadonlyMap<string, boolean>;
    readonly activeThreadId?: string | null;
    readonly activeAncestors?: ReadonlyArray<string>;
    readonly previewCount?: number;
  }) =>
    buildSidebarRows({
      groups,
      expandedProjectIds: new Set(["alpha"]),
      showAllProjectIds: new Set(),
      previewCount: input.previewCount ?? 5,
      activeThreadId: input.activeThreadId ?? null,
      subagents: {
        childrenByParent,
        isOpen: (id) =>
          subagentsOpen(
            id,
            childrenByParent.get(id) ?? [],
            input.folds ?? new Map(),
            input.activeAncestors?.includes(id) ?? false,
          ),
        activeAncestors: input.activeAncestors ?? [],
      },
    });

  it("lists subagents under a parent with a live child, and folds idle grandchildren", () => {
    const rows = build({});
    expect(rows.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:parent",
      "thread:done",
      "thread:live",
      "thread:other",
    ]);
    expect(rows[1]).toMatchObject({ kind: "thread", subagents: "open" });
    expect(rows[2]).toMatchObject({
      kind: "subagent",
      parentThreadId: "parent",
      depth: 1,
      subagents: "closed",
    });
    expect(rows[3]).toMatchObject({ kind: "subagent", subagents: null });
    expect(rows[4]).toMatchObject({ kind: "thread" });
    expect(rows[4]).not.toHaveProperty("subagents");
  });

  it("folds a parent the user closed, and opens a nested one the user opened", () => {
    expect(build({ folds: new Map([["parent", false]]) }).map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:parent",
      "thread:other",
    ]);
    const rows = build({ folds: new Map([["done", true]]) });
    expect(rows.find((row) => row.key === "thread:grand")).toMatchObject({
      kind: "subagent",
      parentThreadId: "done",
      depth: 2,
    });
  });

  it("marks a thread opened before its family loads, so the note under it reads right", () => {
    const rows = build({ folds: new Map([["other", true]]) });
    expect(rows.find((row) => row.key === "thread:other")).toMatchObject({ subagents: "open" });
  });

  it("opens the open subagent's ancestors and keeps its top-level thread in the preview", () => {
    const rows = build({
      activeThreadId: "grand",
      activeAncestors: ["done", "parent"],
      previewCount: 1,
    });
    expect(rows.map((row) => row.key)).toEqual([
      "project:alpha",
      "thread:parent",
      "thread:done",
      "thread:grand",
      "thread:live",
      "more:alpha",
    ]);
    // Folding an ancestor by hand still folds it.
    const folded = build({
      folds: new Map([["parent", false]]),
      activeThreadId: "grand",
      activeAncestors: ["done", "parent"],
      previewCount: 1,
    });
    expect(folded.map((row) => row.key)).toEqual(["project:alpha", "thread:parent", "more:alpha"]);
  });

  it("shares unchanged subagent rows and swaps one whose fold changed", () => {
    const previous = build({});
    expect(shareSidebarRows(previous, build({}))).toBe(previous);
    const shared = shareSidebarRows(previous, build({ folds: new Map([["done", true]]) }));
    expect(shared[1]).toBe(previous[1]);
    expect(shared[2]).not.toBe(previous[2]);
    expect(shared[2]).toMatchObject({ subagents: "open" });
  });
});
