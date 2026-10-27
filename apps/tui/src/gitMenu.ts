import {
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";

/**
 * The git menu: a failed worktree setup's recovery, upstream's quick action (pull when only
 * behind; publish when there's no remote, as web's), then commit, push and the PR action as
 * web lists them, and the commit-message model, as the old TUI had it.
 */
export type GitMenuCommand =
  | { readonly kind: "action"; readonly action: GitStackedAction }
  | { readonly kind: "pull" }
  | { readonly kind: "retry-setup" }
  | { readonly kind: "open-pr"; readonly url: string }
  | { readonly kind: "commit-model" }
  | { readonly kind: "publish" }
  | { readonly kind: "refresh" };

export interface GitMenuItem {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  /** Why it can't run now; shown in place of running it. */
  readonly disabledReason?: string;
  readonly command: GitMenuCommand;
  /** Pushes to the default branch ask for a second ⏎, as web asks before them. */
  readonly confirm?: string;
}

export interface GitMenuInput {
  readonly status: VcsStatusResult | null;
  readonly busy: boolean;
  /** The commit-message model's label. */
  readonly commitModelLabel: string;
  /**
   * The thread's new worktree couldn't be made: offer to retry. The server has no way to
   * move such a thread to the project checkout; a new thread is the way there.
   */
  readonly setupFailed?: boolean;
}

/** A push to the default branch waiting for its second ⏎: what it was armed for. */
export interface ArmedConfirmation {
  readonly id: string;
  readonly cwd: string;
  readonly refName: string | null;
  readonly action: GitStackedAction;
}

/** What a first ⏎ on this item arms, here and on this branch. */
export function armConfirmation(
  item: GitMenuItem,
  cwd: string,
  refName: string | null,
): ArmedConfirmation | null {
  if (item.confirm === undefined || item.command.kind !== "action") return null;
  return { id: item.id, cwd, refName, action: item.command.action };
}

/** Whether a second ⏎ runs it: the same item, action, checkout and branch it was armed for. */
export function isArmed(
  armed: ArmedConfirmation | null,
  item: GitMenuItem,
  cwd: string,
  refName: string | null,
): boolean {
  return (
    armed !== null &&
    armed.id === item.id &&
    armed.cwd === cwd &&
    armed.refName === refName &&
    item.command.kind === "action" &&
    armed.action === item.command.action
  );
}

const ACTION_ICONS: Record<GitStackedAction, string> = {
  commit: "󰜘",
  push: "󰊤",
  create_pr: "󰙯",
  commit_push: "󰊤",
  commit_push_pr: "󰙯",
};

function confirmFor(action: GitStackedAction, status: VcsStatusResult | null): string | undefined {
  if (status === null || status.refName === null) return undefined;
  if (!requiresDefaultBranchConfirmation(action, status.isDefaultRef)) return undefined;
  return `This pushes to ${status.refName}, the default branch. ⏎ again to continue`;
}

export function buildGitMenuItems(input: GitMenuInput): ReadonlyArray<GitMenuItem> {
  const { status, busy } = input;
  const items: GitMenuItem[] = [];
  if (input.setupFailed === true) {
    items.push({
      id: "setup-retry",
      icon: "󰑐",
      label: "Retry worktree setup",
      command: { kind: "retry-setup" },
    });
  }
  const hasRemote = status?.hasPrimaryRemote ?? false;
  const quick = resolveQuickAction(status, busy, status?.isDefaultRef ?? false, hasRemote);
  // A repository with nowhere to push: web leads with publishing it.
  const publish: GitMenuItem | null =
    status !== null && status.isRepo && !hasRemote && !status.hasUpstream
      ? {
          id: "publish",
          icon: "󰅧",
          label: "Publish repository…",
          command: { kind: "publish" },
          ...(busy ? { disabledReason: "Git action in progress." } : {}),
        }
      : null;
  if (quick.kind === "run_action" && quick.action !== undefined) {
    const confirm = confirmFor(quick.action, status);
    items.push({
      id: "quick",
      icon: ACTION_ICONS[quick.action],
      label: quick.label,
      command: { kind: "action", action: quick.action },
      ...(confirm === undefined ? {} : { confirm }),
    });
  } else if (quick.kind === "run_pull") {
    items.push({
      id: "pull",
      icon: "󰓂",
      label: "Pull",
      command: { kind: "pull" },
    });
  } else if (quick.kind === "show_hint" && publish !== null && !busy) {
    // In place of "add an origin remote": the way to add one.
    items.push(publish);
  } else if (quick.kind === "show_hint" && quick.hint !== undefined && status !== null) {
    items.push({
      id: "quick",
      icon: "󰋼",
      // The hint says it all: nothing to run, and why.
      label: quick.hint,
      command: { kind: "refresh" },
      disabledReason: quick.hint,
    });
  }
  if (publish !== null && !items.includes(publish)) items.push(publish);
  for (const item of buildMenuItems(status, busy, hasRemote)) {
    const disabledReason =
      getGitActionDisabledReason({
        item,
        gitStatus: status,
        isBusy: busy,
        hasOriginRemote: hasRemote,
      }) ?? undefined;
    if (item.kind === "open_pr") {
      const url = status?.pr?.state === "open" ? status.pr.url : null;
      items.push({
        id: item.id,
        icon: "󰙯",
        label: item.label,
        command: url === null ? { kind: "refresh" } : { kind: "open-pr", url },
        ...(url === null ? { disabledReason: disabledReason ?? "No open PR." } : {}),
      });
      continue;
    }
    // Web runs push and create PR as they are, and commit with a generated message.
    const action: GitStackedAction =
      item.dialogAction === "push"
        ? "push"
        : item.dialogAction === "create_pr"
          ? "create_pr"
          : "commit";
    const confirm = confirmFor(action, status);
    items.push({
      id: item.id,
      icon: ACTION_ICONS[action],
      label: item.label,
      command: { kind: "action", action },
      ...(disabledReason === undefined ? {} : { disabledReason }),
      ...(confirm === undefined ? {} : { confirm }),
    });
  }
  items.push({
    id: "commit-model",
    icon: "󰚩",
    label: `Commit message model: ${input.commitModelLabel}`,
    command: { kind: "commit-model" },
  });
  items.push({ id: "refresh", icon: "󰑐", label: "Refresh status", command: { kind: "refresh" } });
  return items;
}

/** One line for a finished action, from the result's own toast copy. */
export function describeGitActionResult(result: GitRunStackedActionResult): string {
  const { title, description } = result.toast;
  const prUrl =
    result.pr.status === "created" || result.pr.status === "opened_existing" ? result.pr.url : null;
  return [title, description, prUrl].filter((part) => part != null && part !== "").join(" · ");
}

/** Why an action failed: the server's own message where it sent one. */
export function describeGitActionFailure(error: unknown, remoteMessage: string | null): string {
  if (remoteMessage !== null) return remoteMessage;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message).trim();
    if (message.length > 0) return message;
  }
  return "Git action failed.";
}
