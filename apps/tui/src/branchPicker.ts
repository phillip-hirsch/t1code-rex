import type { VcsListRefsResult, VcsRef } from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  sanitizeNewRefName,
} from "@t3tools/shared/git";

/** What a branch-picker row does when picked. */
export type BranchPickerItem =
  | {
      readonly kind: "ref";
      readonly id: string;
      readonly ref: VcsRef;
      /** Why it stands out: checked out here, in another worktree, only on a remote, the default. */
      readonly tag: "current" | "worktree" | "remote" | "default" | null;
      readonly selected: boolean;
    }
  | { readonly kind: "create"; readonly id: string; readonly name: string }
  | { readonly kind: "init"; readonly id: string };

export interface BranchPickerInput {
  readonly refs: VcsListRefsResult | null;
  readonly query: string;
  /** The branch the toolbar shows; its row is marked. */
  readonly activeBranch: string | null;
  readonly projectCwd: string;
  /** False while picking a new worktree's base: that only names a ref, it never creates one. */
  readonly canCreate: boolean;
}

function refTag(
  ref: VcsRef,
  projectCwd: string,
): Extract<BranchPickerItem, { kind: "ref" }>["tag"] {
  if (ref.current) return "current";
  if (ref.worktreePath !== null && ref.worktreePath !== projectCwd) return "worktree";
  if (ref.isRemote === true) return "remote";
  if (ref.isDefault) return "default";
  return null;
}

/**
 * The picker's rows for what's typed: matching refs (a remote's copy of a local branch only
 * once, as web lists them), then "create" for a name no ref has. A folder that isn't a
 * repository offers to initialize one instead.
 */
export function buildBranchPickerItems(input: BranchPickerInput): ReadonlyArray<BranchPickerItem> {
  const { refs } = input;
  if (refs !== null && !refs.isRepo) return [{ kind: "init", id: "init" }];
  const query = input.query.trim().toLowerCase();
  const visible = dedupeRemoteBranchesWithLocalMatches(refs?.refs ?? []).filter(
    (ref) => query.length === 0 || ref.name.toLowerCase().includes(query),
  );
  const items: BranchPickerItem[] = visible.map((ref) => ({
    kind: "ref",
    id: `ref:${ref.name}`,
    ref,
    tag: refTag(ref, input.projectCwd),
    selected: ref.name === input.activeBranch,
  }));
  const name = sanitizeNewRefName(input.query);
  if (
    input.canCreate &&
    refs !== null &&
    name.length > 0 &&
    !(refs.refs ?? []).some((ref) => ref.name === name)
  ) {
    items.push({ kind: "create", id: `create:${name}`, name });
  }
  return items;
}

/**
 * Where picking a ref takes the thread, as web resolves it: a branch checked out in a
 * worktree means working there; otherwise it's checked out in place, and picking the
 * default branch from a worktree goes back to the project's own checkout.
 */
export function resolveBranchSelectionTarget(input: {
  readonly projectCwd: string;
  readonly worktreePath: string | null;
  readonly ref: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  readonly checkoutCwd: string;
  readonly nextWorktreePath: string | null;
  readonly reuseExistingWorktree: boolean;
} {
  const { projectCwd, worktreePath, ref } = input;
  if (ref.worktreePath !== null) {
    return {
      checkoutCwd: ref.worktreePath,
      nextWorktreePath: ref.worktreePath === projectCwd ? null : ref.worktreePath,
      reuseExistingWorktree: true,
    };
  }
  const nextWorktreePath = worktreePath !== null && ref.isDefault ? null : worktreePath;
  return {
    checkoutCwd: nextWorktreePath ?? projectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

/** The local branch a checkout of this ref lands on: `origin/x` becomes `x`. */
export function localBranchName(ref: Pick<VcsRef, "name" | "isRemote">): string {
  return ref.isRemote === true ? deriveLocalBranchNameFromRemoteRef(ref.name) : ref.name;
}

export function describeBranchPickerItem(item: BranchPickerItem): string {
  switch (item.kind) {
    case "ref":
      return item.ref.name;
    case "create":
      return `Create branch "${item.name}"`;
    case "init":
      return "Initialize a git repository here";
  }
}
