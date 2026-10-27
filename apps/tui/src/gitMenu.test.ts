import type { GitRunStackedActionResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dirtyTree, vcsStatus } from "./gitTestFixtures.ts";
import {
  buildGitMenuItems,
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

  it("explains why nothing can run on an up-to-date branch", () => {
    const [first] = menu();
    expect(first?.label).toBe("Commit");
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
