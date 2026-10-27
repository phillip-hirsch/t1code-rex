import {
  changeRequestTerminologyFor,
  type VcsActionState,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusResult } from "@t3tools/contracts";

/** Where a thread works: the project's own checkout, or a worktree of its own. */
export type EnvMode = "local" | "worktree";

export type ToolbarTone = "text" | "muted" | "success" | "warning" | "info" | "error";

/** One piece of the branch toolbar; `action` is what a click on it opens. */
export interface ToolbarSegment {
  readonly id: "env" | "branch" | "changes" | "sync" | "pr" | "action";
  readonly text: string;
  readonly tone: ToolbarTone;
  readonly action?: "env" | "branch" | "git";
}

export interface BranchToolbarInput {
  /** A new-thread draft, which has no thread (or worktree) yet. */
  readonly draft: boolean;
  readonly envMode: EnvMode;
  readonly worktreePath: string | null;
  /** The thread's recorded branch, or a draft's chosen base branch. */
  readonly threadBranch: string | null;
  /** The checkout's live status; null while it loads. */
  readonly status: VcsStatusResult | null;
  readonly statusFailed: boolean;
  readonly action: VcsActionState | null;
}

/** A thread works in its worktree once it has one; a draft in the mode picked for it. */
export function resolveEnvMode(input: {
  readonly draft: boolean;
  readonly worktreePath: string | null;
  readonly draftEnvMode: EnvMode | undefined;
  readonly defaultEnvMode: EnvMode;
}): EnvMode {
  if (!input.draft) return input.worktreePath === null ? "local" : "worktree";
  return input.draftEnvMode ?? input.defaultEnvMode;
}

/**
 * The branch a toolbar shows, as web resolves it: a new worktree starts from the picked base;
 * anything else is on whatever the checkout has now.
 */
export function resolveToolbarBranch(input: {
  readonly envMode: EnvMode;
  readonly worktreePath: string | null;
  readonly threadBranch: string | null;
  readonly currentBranch: string | null;
}): string | null {
  if (input.envMode === "worktree" && input.worktreePath === null) {
    return input.threadBranch ?? input.currentBranch;
  }
  return input.currentBranch ?? input.threadBranch;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * What a running git action is doing, in one line: its phase, then the hook's last output.
 * A failure goes to the footer with the server's message, so the toolbar shows none.
 */
export function describeVcsAction(state: VcsActionState | null): string | null {
  if (state === null || !state.isRunning) return null;
  const label = state.currentLabel ?? "Working…";
  return state.lastOutputLine === null ? label : `${label}  ${state.lastOutputLine}`;
}

/** The toolbar under the composer: env mode, branch, changes, upstream sync and PR. */
export function describeBranchToolbar(input: BranchToolbarInput): ReadonlyArray<ToolbarSegment> {
  const { status } = input;
  const segments: ToolbarSegment[] = [];
  segments.push({
    id: "env",
    text:
      input.envMode === "worktree" ? (input.draft ? "󰙅 New worktree" : "󰙅 Worktree") : "󰉋 Local",
    tone: input.envMode === "worktree" ? "info" : "muted",
    action: "env",
  });
  if (status !== null && !status.isRepo) {
    segments.push({
      id: "branch",
      text: "󰘬 Not a git repository",
      tone: "muted",
      action: "branch",
    });
    return segments;
  }
  const branch = resolveToolbarBranch({
    envMode: input.envMode,
    worktreePath: input.worktreePath,
    threadBranch: input.threadBranch,
    currentBranch: status?.refName ?? null,
  });
  const newWorktree = input.envMode === "worktree" && input.worktreePath === null;
  segments.push({
    id: "branch",
    text:
      branch === null
        ? status === null
          ? input.statusFailed
            ? "󰘬 Git status unavailable"
            : "󰘬 …"
          : "󰘬 Detached HEAD"
        : newWorktree
          ? `󰘬 From ${branch}`
          : `󰘬 ${branch}`,
    tone: branch === null ? "muted" : "text",
    action: "branch",
  });
  const running = describeVcsAction(input.action);
  if (running !== null) {
    segments.push({
      id: "action",
      text: `󱦟 ${running}`,
      tone: "info",
      action: "git",
    });
  }
  // A new worktree doesn't exist yet: the checkout's changes and upstream aren't its own.
  if (status === null || newWorktree) return segments;
  const { workingTree } = status;
  segments.push(
    status.hasWorkingTreeChanges
      ? {
          id: "changes",
          text: `● ${plural(workingTree.files.length, "file")} +${workingTree.insertions} -${workingTree.deletions}`,
          tone: "warning",
          action: "git",
        }
      : { id: "changes", text: "✓ clean", tone: "success", action: "git" },
  );
  if (status.refName !== null) {
    const sync = status.hasUpstream
      ? status.aheadCount === 0 && status.behindCount === 0
        ? "≡ up to date"
        : [
            status.aheadCount > 0 ? `↑${status.aheadCount}` : null,
            status.behindCount > 0 ? `↓${status.behindCount}` : null,
          ]
            .filter((part) => part !== null)
            .join(" ")
      : status.hasPrimaryRemote
        ? status.aheadCount > 0
          ? `↑${status.aheadCount} not pushed`
          : "not pushed"
        : "no remote";
    segments.push({
      id: "sync",
      text: sync,
      tone: status.behindCount > 0 ? "warning" : "muted",
      action: "git",
    });
  }
  if (status.pr !== null) {
    const { shortLabel } = changeRequestTerminologyFor(status);
    segments.push({
      id: "pr",
      text: `${shortLabel} #${status.pr.number} ${status.pr.state}`,
      tone: status.pr.state === "open" ? "success" : "muted",
      action: "git",
    });
  }
  return segments;
}
