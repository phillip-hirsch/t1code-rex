import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchPickerItems,
  describeBranchPickerItem,
  localBranchName,
  resolveBranchSelectionTarget,
  type BranchPickerInput,
} from "./branchPicker.ts";
import { vcsRef, vcsRefs } from "./gitTestFixtures.ts";

const REFS = vcsRefs([
  vcsRef("main", { isDefault: true, current: true, worktreePath: "/repo" }),
  vcsRef("feature/login", { worktreePath: "/repo-wt/login" }),
  vcsRef("fix-typo"),
  vcsRef("origin/main", { isRemote: true, remoteName: "origin" }),
  vcsRef("origin/release", { isRemote: true, remoteName: "origin" }),
]);

function picker(overrides: Partial<BranchPickerInput>) {
  return buildBranchPickerItems({
    refs: REFS,
    query: "",
    activeBranch: "main",
    projectCwd: "/repo",
    canCreate: true,
    ...overrides,
  });
}

describe("buildBranchPickerItems", () => {
  it("lists refs once, tagged, with the active one marked", () => {
    expect(
      picker({}).map((item) =>
        item.kind === "ref" ? [item.ref.name, item.tag, item.selected] : [item.kind],
      ),
    ).toEqual([
      ["main", "current", true],
      ["feature/login", "worktree", false],
      ["fix-typo", null, false],
      // origin/main is main's remote copy, so only origin/release is listed.
      ["origin/release", "remote", false],
    ]);
  });

  it("filters by what's typed and offers to create a new name", () => {
    const items = picker({ query: "LOG" });
    expect(items.map(describeBranchPickerItem)).toEqual(["feature/login", 'Create branch "LOG"']);
    expect(picker({ query: "my new branch" }).at(-1)).toEqual({
      kind: "create",
      id: "create:my-new-branch",
      name: "my-new-branch",
    });
  });

  it("never offers to create a name a ref has, or while picking a worktree base", () => {
    expect(picker({ query: "fix-typo" }).map((item) => item.kind)).toEqual(["ref"]);
    expect(picker({ query: "brand-new", canCreate: false })).toEqual([]);
  });

  it("offers git init in a folder that isn't a repository", () => {
    expect(picker({ refs: vcsRefs([], { isRepo: false }) })).toEqual([
      { kind: "init", id: "init" },
    ]);
  });

  it("waits for refs before offering to create", () => {
    expect(picker({ refs: null, query: "x" })).toEqual([]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("works in a branch's existing worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        projectCwd: "/repo",
        worktreePath: null,
        ref: { isDefault: false, worktreePath: "/repo-wt/login" },
      }),
    ).toEqual({
      checkoutCwd: "/repo-wt/login",
      nextWorktreePath: "/repo-wt/login",
      reuseExistingWorktree: true,
    });
  });

  it("goes back to the project's checkout for a branch it has", () => {
    expect(
      resolveBranchSelectionTarget({
        projectCwd: "/repo",
        worktreePath: "/repo-wt/login",
        ref: { isDefault: true, worktreePath: "/repo" },
      }),
    ).toEqual({ checkoutCwd: "/repo", nextWorktreePath: null, reuseExistingWorktree: true });
  });

  it("checks out in place otherwise, leaving a worktree for the default branch", () => {
    expect(
      resolveBranchSelectionTarget({
        projectCwd: "/repo",
        worktreePath: "/repo-wt/x",
        ref: { isDefault: false, worktreePath: null },
      }),
    ).toEqual({
      checkoutCwd: "/repo-wt/x",
      nextWorktreePath: "/repo-wt/x",
      reuseExistingWorktree: false,
    });
    expect(
      resolveBranchSelectionTarget({
        projectCwd: "/repo",
        worktreePath: "/repo-wt/x",
        ref: { isDefault: true, worktreePath: null },
      }),
    ).toEqual({ checkoutCwd: "/repo", nextWorktreePath: null, reuseExistingWorktree: false });
  });
});

describe("localBranchName", () => {
  it("drops a remote's name", () => {
    expect(localBranchName({ name: "origin/release", isRemote: true })).toBe("release");
    expect(localBranchName({ name: "feature/login" })).toBe("feature/login");
  });
});
