import { EMPTY_VCS_ACTION_STATE } from "@t3tools/client-runtime/state/vcs";
import { describe, expect, it } from "vite-plus/test";

import {
  describeBranchToolbar,
  describeVcsAction,
  resolveEnvMode,
  type BranchToolbarInput,
} from "./branchToolbar.ts";
import { dirtyTree, vcsStatus } from "./gitTestFixtures.ts";

function toolbar(overrides: Partial<BranchToolbarInput>) {
  return describeBranchToolbar({
    draft: false,
    envMode: "local",
    worktreePath: null,
    threadBranch: null,
    status: vcsStatus(),
    statusFailed: false,
    action: null,
    failure: null,
    setupFailed: false,
    ...overrides,
  }).map((segment) => segment.text);
}

describe("resolveEnvMode", () => {
  it("puts a thread in its worktree once it has one, and a draft in its picked mode", () => {
    const base = { draftEnvMode: undefined, defaultEnvMode: "local" as const };
    expect(resolveEnvMode({ ...base, draft: false, worktreePath: "/wt" })).toBe("worktree");
    expect(resolveEnvMode({ ...base, draft: false, worktreePath: null })).toBe("local");
    expect(resolveEnvMode({ ...base, draft: true, worktreePath: null })).toBe("local");
    expect(
      resolveEnvMode({ ...base, draft: true, worktreePath: null, defaultEnvMode: "worktree" }),
    ).toBe("worktree");
    expect(
      resolveEnvMode({
        draft: true,
        worktreePath: null,
        draftEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("describeBranchToolbar", () => {
  it("shows a clean, up-to-date branch", () => {
    expect(toolbar({})).toEqual(["󰉋 Local", "󰘬 feature", "✓ clean", "≡ up to date"]);
  });

  it("counts changed files and lines, commits ahead and behind, and the PR", () => {
    expect(
      toolbar({
        worktreePath: "/wt",
        envMode: "worktree",
        status: vcsStatus({
          ...dirtyTree([
            { path: "a.ts", insertions: 3, deletions: 1 },
            { path: "b.ts", insertions: 2, deletions: 0 },
          ]),
          aheadCount: 2,
          behindCount: 1,
          pr: {
            number: 12,
            title: "Feature",
            url: "https://github.com/o/r/pull/12",
            baseRef: "main",
            headRef: "feature",
            state: "open",
          },
        }),
      }),
    ).toEqual(["󰙅 Worktree", "󰘬 feature", "● 2 files +5 -1", "↑2 ↓1", "PR #12 open"]);
  });

  it("names what a branch without an upstream is missing", () => {
    expect(toolbar({ status: vcsStatus({ hasUpstream: false, aheadCount: 1 }) })).toContain(
      "↑1 not pushed",
    );
    expect(
      toolbar({ status: vcsStatus({ hasUpstream: false, hasPrimaryRemote: false }) }),
    ).toContain("no remote");
  });

  it("shows a new worktree's base, not the checkout's changes", () => {
    expect(
      toolbar({
        draft: true,
        envMode: "worktree",
        threadBranch: "main",
        status: vcsStatus({ ...dirtyTree([{ path: "a", insertions: 1, deletions: 0 }]) }),
      }),
    ).toEqual(["󰙅 New worktree", "󰘬 From main"]);
  });

  it("says when the folder isn't a repository, or the head is detached", () => {
    expect(toolbar({ status: vcsStatus({ isRepo: false }) })).toEqual([
      "󰉋 Local",
      "󰘬 Not a git repository",
    ]);
    expect(toolbar({ status: vcsStatus({ refName: null }) })[1]).toBe("󰘬 Detached HEAD");
    // A loaded detached HEAD wins over the branch the thread last recorded.
    expect(toolbar({ status: vcsStatus({ refName: null }), threadBranch: "old" })[1]).toBe(
      "󰘬 Detached HEAD",
    );
  });

  it("waits for status, and says when it failed", () => {
    expect(toolbar({ status: null })).toEqual(["󰉋 Local", "󰘬 …"]);
    expect(toolbar({ status: null, statusFailed: true })[1]).toBe("󰘬 Git status unavailable");
    // The thread's recorded branch stands in until status arrives.
    expect(toolbar({ status: null, threadBranch: "feature" })[1]).toBe("󰘬 feature");
  });

  it("shows a running action's phase and hook output", () => {
    const running = {
      ...EMPTY_VCS_ACTION_STATE,
      isRunning: true,
      currentLabel: "Committing...",
      lastOutputLine: "lint ok",
    };
    expect(toolbar({ action: running })).toContain("󱦟 Committing...  lint ok");
  });
});

describe("describeBranchToolbar failures", () => {
  it("keeps a failed worktree setup in view, opening the menu that recovers it", () => {
    const segments = describeBranchToolbar({
      draft: false,
      envMode: "worktree",
      worktreePath: null,
      threadBranch: "main",
      status: vcsStatus(),
      statusFailed: false,
      action: null,
      failure: null,
      setupFailed: true,
    });
    expect(segments.map((segment) => segment.text)).toEqual([
      "󰙅 Worktree",
      "󰘬 From main",
      "✗ Worktree setup failed",
    ]);
    expect(segments[2]?.action).toBe("git");
  });

  it("keeps the last failed action in view until the next one runs", () => {
    const failure = { cwd: "/repo", label: "Create PR", message: "No provider" };
    expect(toolbar({ failure })).toContain("✗ Create PR failed");
    const running = { ...EMPTY_VCS_ACTION_STATE, isRunning: true, currentLabel: "Pushing..." };
    expect(toolbar({ failure, action: running })).not.toContain("✗ Create PR failed");
  });
});

describe("describeVcsAction", () => {
  it("is quiet unless an action runs; failures go to the footer", () => {
    expect(describeVcsAction(EMPTY_VCS_ACTION_STATE)).toBeNull();
    expect(describeVcsAction({ ...EMPTY_VCS_ACTION_STATE, error: "boom" })).toBeNull();
    expect(describeVcsAction({ ...EMPTY_VCS_ACTION_STATE, isRunning: true })).toBe("Working…");
  });
});
