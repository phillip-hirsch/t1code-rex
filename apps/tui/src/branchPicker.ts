import type { VcsListRefsInput, VcsListRefsResult, VcsRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
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
  | { readonly kind: "init"; readonly id: string }
  /** The server has more matches than the pages loaded so far. */
  | {
      readonly kind: "more";
      readonly id: string;
      readonly shown: number;
      readonly total: number;
      readonly loading: boolean;
    };

/** A row the picker hands on when picked; "more" it handles itself. */
export type BranchPickerChoice = Exclude<BranchPickerItem, { kind: "more" }>;

/** Refs per `listRefs` page, as web asks for them. */
export const BRANCH_PICKER_PAGE_SIZE = 100;

/** The loaded pages of one query's refs, merged. */
export interface BranchRefPages {
  /** Null until the first page arrives. */
  readonly data: VcsListRefsResult | null;
  /** A page is still loading. */
  readonly loading: boolean;
  readonly failed: boolean;
}

/**
 * What the server filters refs by for what's typed. Ref names have no spaces, so a name
 * typed with them matches (and creates) its dashed form, as on web.
 */
export function branchRefsQuery(typed: string): string {
  return sanitizeNewRefName(typed).slice(0, 256);
}

export function branchRefsInput(
  cwd: string,
  query: string,
  cursor: number | undefined,
): VcsListRefsInput {
  return {
    cwd,
    limit: BRANCH_PICKER_PAGE_SIZE,
    ...(query.length > 0 ? { query } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Pages in order: their refs once each, and the last page's cursor. */
export function mergeRefPages(
  results: ReadonlyArray<AsyncResult.AsyncResult<VcsListRefsResult, unknown>>,
): BranchRefPages {
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const loading = results.some((result) => result.waiting || AsyncResult.isInitial(result));
  const failed = results.some(AsyncResult.isFailure);
  const first = values[0];
  const last = values.at(-1);
  if (first === undefined || last === undefined) return { data: null, loading, failed };
  const refs = new Map<string, VcsRef>();
  for (const value of values) for (const ref of value.refs) refs.set(ref.name, ref);
  return {
    data: {
      ...first,
      refs: [...refs.values()],
      nextCursor: last.nextCursor,
      totalCount: Math.max(...values.map((value) => value.totalCount)),
    },
    loading,
    failed,
  };
}

export interface BranchPickerInput {
  /** The refs the server matched for `refsQuery`; the last loaded while a new query loads. */
  readonly refs: BranchRefPages;
  readonly refsQuery: string;
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
 * once, as web lists them), "more" while the server has further matches, then "create" for
 * a name the server confirms no ref has. A folder that isn't a repository offers to
 * initialize one instead.
 */
export function buildBranchPickerItems(input: BranchPickerInput): ReadonlyArray<BranchPickerItem> {
  const refs = input.refs.data;
  if (refs !== null && !refs.isRepo) return [{ kind: "init", id: "init" }];
  const query = input.query.trim().toLowerCase();
  // While a new query loads, the last results narrow locally.
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
  const name = branchRefsQuery(input.query);
  const current = input.refsQuery === name;
  if (refs !== null && current && refs.nextCursor !== null) {
    items.push({
      kind: "more",
      id: "more",
      shown: refs.refs.length,
      total: refs.totalCount,
      loading: input.refs.loading,
    });
  }
  // Every match for this name is loaded, and none is it.
  const confirmedNew =
    refs !== null &&
    current &&
    !input.refs.loading &&
    refs.nextCursor === null &&
    !refs.refs.some((ref) => ref.name === name);
  if (input.canCreate && name.length > 0 && confirmedNew) {
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
    case "more":
      return item.loading ? "Loading more…" : `Load more (${item.shown} of ${item.total} shown)`;
  }
}
