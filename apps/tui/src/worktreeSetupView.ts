import {
  WORKTREE_SETUP_STAGE_ORDER,
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";

import type { ToolbarTone } from "./branchToolbar.ts";

export interface WorktreeSetupLine {
  readonly id: string;
  readonly icon: string;
  readonly text: string;
  readonly tone: ToolbarTone;
}

export interface WorktreeSetupView {
  readonly title: string;
  readonly tone: ToolbarTone;
  readonly lines: ReadonlyArray<WorktreeSetupLine>;
  readonly error: string | null;
  readonly cancellable: boolean;
}

const STAGE_ICONS: Record<WorktreeSetupStageStatus, string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  skipped: "–",
  warning: "!",
  failed: "✗",
};

const STAGE_TONES: Record<WorktreeSetupStageStatus, ToolbarTone> = {
  pending: "muted",
  running: "info",
  done: "success",
  skipped: "muted",
  warning: "warning",
  failed: "error",
};

/**
 * The worktree setup card: each stage in order with its progress, the running stage's last
 * output line, and how setup ended.
 */
export function describeWorktreeSetup(snapshot: WorktreeSetupSnapshot): WorktreeSetupView {
  const stages = [...snapshot.stages].sort(
    (left, right) =>
      WORKTREE_SETUP_STAGE_ORDER.indexOf(left.id) - WORKTREE_SETUP_STAGE_ORDER.indexOf(right.id),
  );
  const lines = stages.map((stage): WorktreeSetupLine => {
    const parts: string[] = [worktreeSetupStageLabel(stage.id)];
    if (stage.id === "setup-script" && snapshot.setupScript !== null) {
      parts[0] = `${parts[0]}: ${snapshot.setupScript.name}`;
    }
    if (stage.status === "running" && stage.percent !== null) parts.push(`${stage.percent}%`);
    if (stage.detail !== null && stage.detail.length > 0) parts.push(stage.detail);
    const tail = stage.status === "running" || stage.status === "failed" ? stage.tail.at(-1) : null;
    if (tail != null && tail.trim().length > 0) parts.push(`› ${tail.trim()}`);
    return {
      id: stage.id,
      icon: STAGE_ICONS[stage.status],
      text: parts.join("  "),
      tone: STAGE_TONES[stage.status],
    };
  });
  const where = [
    snapshot.branch === null ? null : `on ${snapshot.branch}`,
    snapshot.baseRef === null ? null : `from ${snapshot.baseRef}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const suffix = where.length === 0 ? "" : ` ${where}`;
  switch (snapshot.phase) {
    case "running":
      return {
        title: `Setting up worktree${suffix}`,
        tone: "info",
        lines,
        error: null,
        cancellable: true,
      };
    case "done":
      return {
        title: `Worktree ready${suffix}`,
        tone: stages.some((stage) => stage.status === "failed") ? "warning" : "success",
        lines,
        error: snapshot.error,
        cancellable: false,
      };
    case "failed":
      return {
        title: `Worktree setup failed${suffix}`,
        tone: "error",
        lines,
        error: snapshot.error,
        cancellable: false,
      };
    case "cancelled":
      return {
        title: `Worktree setup cancelled${suffix}`,
        tone: "warning",
        lines,
        error: snapshot.error,
        cancellable: false,
      };
  }
}
