import type { DiffFile } from "./diffPatch.ts";
import { resolveScrollKey, type ScrollAction, type ScrollKey } from "./threadScroll.ts";

export type DiffKeyAction =
  | { readonly type: "file"; readonly delta: -1 | 1 }
  | { readonly type: "hunk"; readonly delta: -1 | 1 }
  | { readonly type: "turn"; readonly delta: -1 | 1 }
  | { readonly type: "toggle-all" }
  | { readonly type: "toggle-view" }
  | { readonly type: "toggle-wrap" }
  | { readonly type: "more" }
  | { readonly type: "refresh" }
  | { readonly type: "close" }
  | { readonly type: "scroll"; readonly action: ScrollAction };

export interface DiffKey extends ScrollKey {
  readonly sequence?: string;
  readonly meta?: boolean;
}

export const DIFF_KEY_HINTS =
  "[ ] file  n/p hunk  , . turn  a all  v split  w wrap  m more  r refresh  d close";

/** Keys while the diff panel has focus; scrolling keys are the transcript's. */
export function resolveDiffKey(key: DiffKey, viewportHeight: number): DiffKeyAction | null {
  if (key.meta) return null;
  if (!key.ctrl) {
    const typed = key.sequence?.length === 1 ? key.sequence : key.name;
    switch (typed) {
      case "]":
        return { type: "file", delta: 1 };
      case "[":
        return { type: "file", delta: -1 };
      case "n":
        return { type: "hunk", delta: 1 };
      case "p":
      case "N":
        return { type: "hunk", delta: -1 };
      case ".":
        return { type: "turn", delta: 1 };
      case ",":
        return { type: "turn", delta: -1 };
      case "a":
        return { type: "toggle-all" };
      case "v":
        return { type: "toggle-view" };
      case "w":
        return { type: "toggle-wrap" };
      case "m":
        return { type: "more" };
      case "r":
        return { type: "refresh" };
      case "d":
        return { type: "close" };
    }
    if (key.name === "escape") return { type: "close" };
  }
  const scroll = resolveScrollKey(key, viewportHeight);
  return scroll === null ? null : { type: "scroll", action: scroll };
}

export interface DiffCursor {
  readonly fileIndex: number;
  readonly hunkIndex: number;
}

export function stepFile(files: ReadonlyArray<DiffFile>, fileIndex: number, delta: -1 | 1) {
  if (files.length === 0) return 0;
  return Math.max(0, Math.min(files.length - 1, fileIndex + delta));
}

/**
 * The next or previous hunk, moving on to the neighbouring file with hunks at either end;
 * null when there is none in that direction.
 */
export function stepHunk(
  files: ReadonlyArray<DiffFile>,
  cursor: DiffCursor,
  delta: -1 | 1,
): DiffCursor | null {
  const current = files[cursor.fileIndex];
  if (current !== undefined) {
    const hunkIndex = cursor.hunkIndex + delta;
    if (hunkIndex >= 0 && hunkIndex < current.hunks.length) {
      return { fileIndex: cursor.fileIndex, hunkIndex };
    }
  }
  for (
    let fileIndex = cursor.fileIndex + delta;
    fileIndex >= 0 && fileIndex < files.length;
    fileIndex += delta
  ) {
    const count = files[fileIndex]?.hunks.length ?? 0;
    if (count > 0) return { fileIndex, hunkIndex: delta === 1 ? 0 : count - 1 };
  }
  return null;
}

/** Keeps the same file selected when the diff changes under it, by path. */
export function reconcileFileIndex(
  files: ReadonlyArray<DiffFile>,
  path: string | null,
  fallbackIndex: number,
): number {
  if (files.length === 0) return 0;
  if (path !== null) {
    const index = files.findIndex((file) => file.path === path);
    if (index !== -1) return index;
  }
  return Math.max(0, Math.min(files.length - 1, fallbackIndex));
}
