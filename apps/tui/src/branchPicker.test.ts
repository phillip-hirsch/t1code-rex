import type { VcsListRefsResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  branchRefsInput,
  branchRefsQuery,
  buildBranchPickerItems,
  describeBranchPickerItem,
  localBranchName,
  mergeRefPages,
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

function picker(
  overrides: Partial<Omit<BranchPickerInput, "refs">> & {
    readonly refs?: VcsListRefsResult | null;
    readonly loading?: boolean;
  },
) {
  const { refs = REFS, loading = false, ...rest } = overrides;
  const query = rest.query ?? "";
  return buildBranchPickerItems({
    refs: { data: refs, loading, failed: false },
    refsQuery: branchRefsQuery(query),
    query,
    activeBranch: "main",
    projectCwd: "/repo",
    canCreate: true,
    ...rest,
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

  it("offers to create only once the server has listed every match", () => {
    // The server matched 300 refs and sent the first page: "x" may be on a later one.
    const partial = vcsRefs([vcsRef("x-1"), vcsRef("x-2")], { nextCursor: 2, totalCount: 300 });
    expect(picker({ refs: partial, query: "x" }).map(describeBranchPickerItem)).toEqual([
      "x-1",
      "x-2",
      "Load more (2 of 300 shown)",
    ]);
    expect(picker({ refs: vcsRefs([vcsRef("x-1")]), query: "x", loading: true }).at(-1)).toEqual(
      expect.objectContaining({ kind: "ref" }),
    );
    // Results for an older query narrow locally, but don't vouch for the new name.
    expect(
      picker({ refs: vcsRefs([vcsRef("fix-typo")]), query: "fix-t", refsQuery: "fix" }).map(
        (item) => item.kind,
      ),
    ).toEqual(["ref"]);
  });
});

describe("branch ref pages", () => {
  it("sends what's typed, dashed, to the server", () => {
    expect(branchRefsInput("/repo", branchRefsQuery(" my branch "), undefined)).toEqual({
      cwd: "/repo",
      limit: 100,
      query: "my-branch",
    });
    expect(branchRefsInput("/repo", "", 100)).toEqual({ cwd: "/repo", limit: 100, cursor: 100 });
  });

  it("merges pages in order, with the last page's cursor", () => {
    const merged = mergeRefPages([
      AsyncResult.success(vcsRefs([vcsRef("a"), vcsRef("b")], { nextCursor: 2, totalCount: 3 })),
      AsyncResult.success(vcsRefs([vcsRef("c")], { nextCursor: null, totalCount: 3 })),
    ]);
    expect(merged.data?.refs.map((ref) => ref.name)).toEqual(["a", "b", "c"]);
    expect(merged.data?.nextCursor).toBeNull();
    expect(merged.loading).toBe(false);
    const loading = mergeRefPages([
      AsyncResult.success(vcsRefs([vcsRef("a")], { nextCursor: 1, totalCount: 2 })),
      AsyncResult.initial(true),
    ]);
    expect([loading.data?.nextCursor, loading.loading]).toEqual([1, true]);
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
