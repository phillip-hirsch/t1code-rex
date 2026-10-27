import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { at, presentedThread } from "./shellTestFixtures.ts";
import { childThread } from "./subagentTestFixtures.ts";
import {
  groupSubagentChildren,
  subagentShellState,
  subagentsOpen,
  threadAncestors,
} from "./subagentTree.ts";

const running = { status: "running" as const, activeRunId: RunId.make("run-1") };

describe("groupSubagentChildren", () => {
  it("groups children under their parent in spawn order and skips forks and archived rows", () => {
    const parent = presentedThread("parent", "p");
    const later = childThread("later", "p", "parent", {
      createdAt: at("2026-06-20T10:05:00.000Z"),
    });
    const first = childThread("first", "p", "parent", {
      createdAt: at("2026-06-20T10:01:00.000Z"),
    });
    const archived = childThread("archived", "p", "parent", {
      archivedAt: at("2026-06-20T11:00:00.000Z"),
    });
    const fork = presentedThread("fork", "p", {
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "fork",
      },
    });

    const children = groupSubagentChildren([parent, later, fork, first, archived]);

    expect(children.get("parent")?.map((thread) => thread.id)).toEqual(["first", "later"]);
    expect(children.has("fork")).toBe(false);
  });
});

describe("subagentShellState", () => {
  it("reads the child's run, with a pending request as waiting", () => {
    expect(subagentShellState(childThread("c", "p", "parent", running))).toBe("working");
    expect(subagentShellState(childThread("c", "p", "parent", { status: "completed" }))).toBe(
      "done",
    );
    expect(subagentShellState(childThread("c", "p", "parent", { status: "interrupted" }))).toBe(
      "stopped",
    );
    expect(subagentShellState(childThread("c", "p", "parent"))).toBe("idle");
    expect(
      subagentShellState(childThread("c", "p", "parent", { activityRunStatus: "running" })),
    ).toBe("working");
  });
});

describe("subagentsOpen", () => {
  const idle = childThread("idle", "p", "parent", { status: "completed" });
  const live = childThread("live", "p", "parent", running);

  it("starts folded while every child is idle and open while one is live", () => {
    expect(subagentsOpen("parent", [idle], new Map())).toBe(false);
    expect(subagentsOpen("parent", [idle, live], new Map())).toBe(true);
  });

  it("opens for the open subagent unless the user folded it", () => {
    expect(subagentsOpen("parent", [idle], new Map(), true)).toBe(true);
    expect(subagentsOpen("parent", [idle], new Map([["parent", false]]), true)).toBe(false);
  });

  it("follows the user's choice once made", () => {
    expect(subagentsOpen("parent", [idle], new Map([["parent", true]]))).toBe(true);
    expect(subagentsOpen("parent", [live], new Map([["parent", false]]))).toBe(false);
  });
});

describe("threadAncestors", () => {
  it("walks up to the top-level thread and stops at a cycle", () => {
    const root = presentedThread("root", "p");
    const child = childThread("child", "p", "root");
    const grandchild = childThread("grandchild", "p", "child");
    const byId = new Map([root, child, grandchild].map((thread) => [thread.id, thread]));
    expect(threadAncestors("grandchild", byId)).toEqual(["child", "root"]);
    expect(threadAncestors("root", byId)).toEqual([]);

    const loopA = childThread("loop-a", "p", "loop-b");
    const loopB = childThread("loop-b", "p", "loop-a");
    const loops = new Map([loopA, loopB].map((thread) => [thread.id, thread]));
    expect(threadAncestors("loop-a", loops)).toEqual(["loop-b", "loop-a"]);
  });
});
