/** Rows from the bottom that still count as "at the bottom", as in the old timeline. */
export const TIMELINE_BOTTOM_THRESHOLD_ROWS = 4;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isNearBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= TIMELINE_BOTTOM_THRESHOLD_ROWS;
}

export interface HistoryPagingState {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Older turns load once the view comes within a screen of the top, or right away when the
 * loaded window doesn't fill the screen. After a failed page only a scroll the user makes
 * retries, so a broken endpoint isn't hammered by layout passes.
 */
export function shouldLoadEarlier(
  metrics: ScrollMetrics,
  history: HistoryPagingState,
  userScrolled: boolean,
): boolean {
  if (!history.hasMoreHistory || history.loading) return false;
  if (history.error !== null && !userScrolled) return false;
  return metrics.scrollTop < Math.max(metrics.viewportHeight, 1);
}

export type ScrollAction =
  | { readonly kind: "by"; readonly rows: number }
  | { readonly kind: "top" }
  | { readonly kind: "bottom" };

export interface ScrollKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

/** Keyboard scrolling while the thread has focus: lines, half pages, pages, and the ends. */
export function resolveScrollKey(key: ScrollKey, viewportHeight: number): ScrollAction | null {
  const page = Math.max(1, viewportHeight - 2);
  const half = Math.max(1, Math.floor(viewportHeight / 2));
  if (key.ctrl) {
    if (key.name === "u") return { kind: "by", rows: -half };
    if (key.name === "d") return { kind: "by", rows: half };
    return null;
  }
  switch (key.name) {
    case "up":
    case "k":
      return { kind: "by", rows: -1 };
    case "down":
    case "j":
      return { kind: "by", rows: 1 };
    case "pageup":
      return { kind: "by", rows: -page };
    case "pagedown":
    case "space":
      return { kind: "by", rows: page };
    case "home":
      return { kind: "top" };
    case "end":
      return { kind: "bottom" };
    case "g":
      return key.shift ? { kind: "bottom" } : { kind: "top" };
    default:
      return null;
  }
}

/**
 * Rows prepended above the first visible row push it down. Moving the scroll position by
 * the same amount keeps what the user was reading in place.
 */
export function anchoredScrollTop(
  scrollTop: number,
  anchorTopBefore: number,
  anchorTopAfter: number,
) {
  return Math.max(0, scrollTop + (anchorTopAfter - anchorTopBefore));
}

/**
 * The row to hold in place when a render changes the first rows: the old first row, if it
 * is still there and new rows arrived above it. Null when nothing was prepended.
 */
export function resolvePrependAnchor(
  previousKeys: ReadonlyArray<string>,
  nextKeys: ReadonlyArray<string>,
): string | null {
  const anchor = previousKeys[0];
  if (anchor === undefined || nextKeys[0] === anchor) return null;
  return nextKeys.includes(anchor) ? anchor : null;
}

/** A row's top within the scrolled content, from the last layout; null when it isn't there. */
export type MeasureRowTop = (key: string) => number | null;

/**
 * Holds the reading position when older rows arrive above it. A page and a streaming delta
 * can both commit before OpenTUI lays out, so the anchor stays pending until a layout pass
 * consumes it, and later commits don't replace it (their rows have no layout yet).
 */
export class PrependAnchorTracker {
  private previousKeys: ReadonlyArray<string> = [];
  private pending: { readonly key: string; readonly top: number } | null = null;

  /** Call after React commits the rows, before OpenTUI's next layout pass. */
  commit(keys: ReadonlyArray<string>, measure: MeasureRowTop, nearBottom: boolean): void {
    const anchorKey = resolvePrependAnchor(this.previousKeys, keys);
    this.previousKeys = keys;
    if (this.pending !== null) {
      if (!keys.includes(this.pending.key)) this.pending = null;
      return;
    }
    // At the bottom, the scrollbox's own sticky scroll keeps the latest rows in view.
    if (anchorKey === null || nearBottom) return;
    const top = measure(anchorKey);
    if (top !== null) this.pending = { key: anchorKey, top };
  }

  /** Call once layout has run; the scroll position to apply, or null to leave it. */
  consume(measure: MeasureRowTop, scrollTop: number): number | null {
    const anchor = this.pending;
    if (anchor === null) return null;
    this.pending = null;
    const top = measure(anchor.key);
    if (top === null || top === anchor.top) return null;
    return anchoredScrollTop(scrollTop, anchor.top, top);
  }
}
