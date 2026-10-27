import { describe, expect, it } from "vite-plus/test";

import { buildThreadContextMenuItems, threadWorkspacePath } from "./sidebarContextMenu.ts";

describe("buildThreadContextMenuItems", () => {
  it("offers the Rex tab only where Rex tabs open", () => {
    expect(buildThreadContextMenuItems({ rexTabs: true }).map((item) => item.id)).toEqual([
      "open-rex-tab",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
    ]);
    expect(buildThreadContextMenuItems({ rexTabs: false }).map((item) => item.id)).toEqual([
      "mark-unread",
      "copy-path",
      "copy-thread-id",
    ]);
  });
});

describe("threadWorkspacePath", () => {
  it("prefers the thread's worktree over the project root", () => {
    expect(threadWorkspacePath({ worktreePath: "/wt" }, { workspaceRoot: "/repo" })).toBe("/wt");
    expect(threadWorkspacePath({ worktreePath: null }, { workspaceRoot: "/repo" })).toBe("/repo");
    expect(threadWorkspacePath({ worktreePath: null }, undefined)).toBeNull();
  });
});
