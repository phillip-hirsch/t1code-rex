import type {
  VcsListRefsResult,
  VcsRef,
  VcsStatusResult,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

/** A clean checkout of `feature` with an upstream, no PR. */
export function vcsStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

/** A working tree with these files changed, each by +insertions -deletions. */
export function dirtyTree(
  files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>,
): Pick<VcsStatusResult, "hasWorkingTreeChanges" | "workingTree"> {
  return {
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}

export function vcsRef(name: string, overrides: Partial<VcsRef> = {}): VcsRef {
  return { name, current: false, isDefault: false, worktreePath: null, ...overrides };
}

export function vcsRefs(
  refs: ReadonlyArray<VcsRef>,
  overrides: Partial<VcsListRefsResult> = {},
): VcsListRefsResult {
  return {
    refs,
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: refs.length,
    ...overrides,
  };
}

function stage(
  id: WorktreeSetupStage["id"],
  status: WorktreeSetupStage["status"],
  overrides: Partial<WorktreeSetupStage> = {},
): WorktreeSetupStage {
  return {
    id,
    status,
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
    ...overrides,
  };
}

export const SETUP_THREAD_ID = ThreadId.make("thread-setup");

/** A worktree mid-checkout: fetch done, checkout at 40%, the rest pending. */
export function worktreeSetup(
  overrides: Partial<WorktreeSetupSnapshot> = {},
): WorktreeSetupSnapshot {
  return {
    threadId: SETUP_THREAD_ID,
    phase: "running",
    startedAt: "2026-10-27T10:00:00.000Z",
    endedAt: null,
    branch: "t3/1a2b3c4d",
    baseRef: "main",
    worktreePath: "/tmp/repo-worktrees/t3-1a2b3c4d",
    setupScript: null,
    stages: [
      stage("agent", "pending"),
      stage("fetch", "done"),
      stage("checkout", "running", { percent: 40, tail: ["Updating files: 40% (4/10)"] }),
      stage("submodules", "skipped"),
      stage("setup-script", "skipped"),
    ],
    error: null,
    sequence: 3,
    ...overrides,
  };
}

export { stage as worktreeSetupStage };
