import type { GitRunStackedActionResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dirtyTree, vcsStatus } from "./gitTestFixtures.ts";
import {
  armConfirmation,
  buildGitMenuItems,
  isArmed,
  describeGitActionFailure,
  describeGitActionResult,
  type GitMenuItem,
} from "./gitMenu.ts";

function menu(status = vcsStatus(), busy = false) {
  return buildGitMenuItems({ status, busy, commitModelLabel: "Claude Haiku 5.5" });
}

function row(item: GitMenuItem) {
  return {
    id: item.id,
    label: item.label,
    command: item.command.kind === "action" ? item.command.action : item.command.kind,
    disabled: item.disabledReason !== undefined,
  };
}

const DIRTY = dirtyTree([{ path: "a.ts", insertions: 1, deletions: 0 }]);

describe("buildGitMenuItems", () => {
  it("leads with the quick action for changes on a feature branch", () => {
    expect(menu(vcsStatus(DIRTY)).map(row)).toEqual([
      { id: "quick", label: "Commit, push & PR", command: "commit_push_pr", disabled: false },
      { id: "commit", label: "Commit", command: "commit", disabled: false },
      { id: "push", label: "Push", command: "push", disabled: true },
      // Nothing is committed ahead of the base yet; the quick action commits first.
      { id: "pr", label: "Create PR", command: "create_pr", disabled: true },
      {
        id: "commit-model",
        label: "Commit message model: Claude Haiku 5.5",
        command: "commit-model",
        disabled: false,
      },
      { id: "refresh", label: "Refresh status", command: "refresh", disabled: false },
    ]);
  });

  it("offers push and a PR for local commits a branch without an upstream has", () => {
    const items = menu(vcsStatus({ hasUpstream: false, aheadCount: 2 }));
    expect(items.map(row).slice(0, 4)).toEqual([
      { id: "quick", label: "Push & create PR", command: "create_pr", disabled: false },
      { id: "commit", label: "Commit", command: "commit", disabled: true },
      { id: "push", label: "Push", command: "push", disabled: false },
      { id: "pr", label: "Create PR", command: "create_pr", disabled: false },
    ]);
    expect(items[1]?.disabledReason).toBe("Worktree is clean. Make changes before committing.");
  });

  it("offers pull when behind", () => {
    expect(menu(vcsStatus({ behindCount: 3 })).map(row)[0]).toEqual({
      id: "pull",
      label: "Pull",
      command: "pull",
      disabled: false,
    });
  });

  it("keeps the divergence hint instead of a pull that can't fast-forward", () => {
    const items = menu(vcsStatus({ aheadCount: 1, behindCount: 2 }));
    expect(items.map(row)[0]).toEqual({
      id: "quick",
      label: "Branch has diverged from upstream. Rebase/merge first.",
      command: "refresh",
      disabled: true,
    });
    expect(items.some((item) => item.command.kind === "pull")).toBe(false);
  });

  it("explains why nothing can run on an up-to-date branch", () => {
    const [first] = menu();
    expect(first?.label).toBe("Branch is up to date. No action needed.");
    expect(first?.disabledReason).toBe("Branch is up to date. No action needed.");
  });

  it("opens an open PR instead of creating one", () => {
    const pr = menu(
      vcsStatus({
        pr: {
          number: 7,
          title: "x",
          url: "https://github.com/o/r/pull/7",
          baseRef: "main",
          headRef: "feature",
          state: "open",
        },
      }),
    ).find((item) => item.id === "pr");
    expect(pr?.label).toBe("View PR");
    expect(pr?.command).toEqual({ kind: "open-pr", url: "https://github.com/o/r/pull/7" });
  });

  it("asks before pushing to the default branch, as web does", () => {
    const items = menu(vcsStatus({ ...DIRTY, refName: "main", isDefaultRef: true }));
    expect(items[0]?.label).toBe("Commit & push");
    expect(items[0]?.confirm).toBe("This pushes to main, the default branch. ⏎ again to continue");
    expect(items.find((item) => item.id === "commit")?.confirm).toBeUndefined();
  });

  it("binds a default-branch confirmation to its checkout, branch and action", () => {
    const status = vcsStatus({ ...DIRTY, refName: "main", isDefaultRef: true });
    const [quick] = menu(status);
    if (quick === undefined) throw new Error("no quick action");
    const armed = armConfirmation(quick, "/repo", "main");
    expect(isArmed(armed, quick, "/repo", "main")).toBe(true);
    // Another project's checkout, another branch, or the item now running something else.
    expect(isArmed(armed, quick, "/other", "main")).toBe(false);
    expect(isArmed(armed, quick, "/repo", "release")).toBe(false);
    expect(
      isArmed(armed, { ...quick, command: { kind: "action", action: "push" } }, "/repo", "main"),
    ).toBe(false);
    // Items that don't ask never arm.
    const commit = menu(status).find((item) => item.id === "commit");
    if (commit === undefined) throw new Error("no commit item");
    expect(armConfirmation(commit, "/repo", "main")).toBeNull();
  });

  it("leads with retry, and only retry, when a worktree setup failed", () => {
    const items = buildGitMenuItems({
      status: vcsStatus(),
      busy: false,
      commitModelLabel: "x",
      setupFailed: true,
    });
    expect(items[0] === undefined ? null : row(items[0])).toEqual({
      id: "setup-retry",
      label: "Retry worktree setup",
      command: "retry-setup",
      disabled: false,
    });
    // The server can't move such a thread to the project checkout, so nothing offers to.
    expect(items.filter((item) => item.id.startsWith("setup-"))).toHaveLength(1);
  });

  it("disables every action while one runs", () => {
    const items = menu(vcsStatus(DIRTY), true);
    expect(
      items.filter((item) => item.command.kind === "action").map((item) => item.disabledReason),
    ).toEqual(["Git action in progress.", "Git action in progress.", "Git action in progress."]);
  });

  it("offers no actions without a status", () => {
    expect(
      buildGitMenuItems({ status: null, busy: false, commitModelLabel: "x" }).map(
        (item) => item.id,
      ),
    ).toEqual(["commit-model", "refresh"]);
  });
});

describe("describeGitActionResult", () => {
  it("uses the result's own toast copy and links a new PR", () => {
    const result: GitRunStackedActionResult = {
      action: "create_pr",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "abc1234", subject: "Add a" },
      push: { status: "pushed" },
      pr: { status: "created", url: "https://github.com/o/r/pull/9", number: 9 },
      toast: { title: "Created PR #9", description: "Add a", cta: { kind: "none" } },
    };
    expect(describeGitActionResult(result)).toBe(
      "Created PR #9 · Add a · https://github.com/o/r/pull/9",
    );
  });
});

describe("describeGitActionFailure", () => {
  it("prefers the server's message to the client's generic one", () => {
    expect(describeGitActionFailure(new Error("generic"), "No GitHub remote")).toBe(
      "No GitHub remote",
    );
    expect(describeGitActionFailure(new Error("generic"), null)).toBe("generic");
    expect(describeGitActionFailure(null, null)).toBe("Git action failed.");
  });
});
