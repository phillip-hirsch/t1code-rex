import { describe, expect, it } from "vite-plus/test";

import {
  buildMultiThreadMenuItems,
  buildProjectMenuItems,
  buildThreadMenuItems,
  threadWorkspacePath,
} from "./sidebarContextMenu.ts";

const noCapabilities = { pinning: false, settlement: false };

describe("buildThreadMenuItems", () => {
  it("lists the old TUI's thread actions, with the Rex tab only where Rex tabs open", () => {
    const items = buildThreadMenuItems({
      rexTabs: true,
      capabilities: noCapabilities,
      pinned: false,
      settled: false,
      running: false,
    });
    expect(items.map((item) => item.id)).toEqual([
      "open-rex-tab",
      "open-rex-diff",
      "rename",
      "mark-unread",
      "open-editor",
      "open-folder",
      "copy-path",
      "copy-thread-id",
      "archive",
      "delete",
    ]);
    expect(items.find((item) => item.id === "delete")?.destructive).toBe(true);
    expect(
      buildThreadMenuItems({
        rexTabs: false,
        capabilities: noCapabilities,
        pinned: false,
        settled: false,
        running: false,
      })[0]?.id,
    ).toBe("rename");
  });

  it("offers pin and settle only when the server supports them, flipped by state", () => {
    const ids = (pinned: boolean, settled: boolean) =>
      buildThreadMenuItems({
        rexTabs: false,
        capabilities: { pinning: true, settlement: true },
        pinned,
        settled,
        running: false,
      }).map((item) => item.id);
    expect(ids(false, false)).toEqual(expect.arrayContaining(["pin", "settle"]));
    expect(ids(true, true)).toEqual(expect.arrayContaining(["unpin", "unsettle"]));
    expect(ids(true, true)).not.toContain("pin");
  });

  it("keeps Archive listed but disabled while the thread runs", () => {
    const archive = buildThreadMenuItems({
      rexTabs: false,
      capabilities: noCapabilities,
      pinned: false,
      settled: false,
      running: true,
    }).find((item) => item.id === "archive");
    expect(archive?.disabledReason).toBe("Stop the run before archiving");
  });
});

describe("bulk and project menus", () => {
  it("counts the selection and marks the destructive items", () => {
    expect(buildMultiThreadMenuItems(3).map((item) => item.label)).toEqual([
      "Mark unread (3)",
      "Archive (3)",
      "Delete (3)",
    ]);
    expect(
      buildProjectMenuItems()
        .filter((item) => item.destructive)
        .map((item) => item.id),
    ).toEqual(["remove-project"]);
  });
});

describe("threadWorkspacePath", () => {
  it("prefers the thread's worktree over the project root", () => {
    expect(threadWorkspacePath({ worktreePath: "/wt" }, { workspaceRoot: "/repo" })).toBe("/wt");
    expect(threadWorkspacePath({ worktreePath: null }, { workspaceRoot: "/repo" })).toBe("/repo");
    expect(threadWorkspacePath({ worktreePath: null }, undefined)).toBeNull();
  });
});
