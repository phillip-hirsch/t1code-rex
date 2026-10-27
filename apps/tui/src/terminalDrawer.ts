/**
 * Each thread's terminal drawer: its terminals, their tabs and splits, the active one.
 * Like web's (`apps/web/src/terminalUiStateStore.ts`), "new" opens a tab and "split"
 * adds a pane to the active one. The shells live on the server.
 */

export type TerminalSplitDirection = "horizontal" | "vertical";

export interface TerminalGroup {
  readonly id: string;
  readonly terminalIds: ReadonlyArray<string>;
  /** Horizontal panes sit side by side; vertical ones are stacked. */
  readonly direction: TerminalSplitDirection;
}

export interface ThreadTerminalState {
  readonly open: boolean;
  readonly groups: ReadonlyArray<TerminalGroup>;
  readonly activeTerminalId: string | null;
}

export const DEFAULT_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;
/** A pane narrower or shorter than this can't fit a prompt, so it doesn't split further. */
export const MIN_TERMINAL_PANE_COLS = 20;
export const MIN_TERMINAL_PANE_ROWS = 3;
/** The drawer's rows, its header row included. */
export const DEFAULT_TERMINAL_DRAWER_HEIGHT = 14;
export const MIN_TERMINAL_DRAWER_HEIGHT = 5;
/** Rows the drawer always leaves the thread and composer above it. */
export const TERMINAL_DRAWER_RESERVED_ROWS = 8;

export const EMPTY_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  open: false,
  groups: Object.freeze([]),
  activeTerminalId: null,
});

export function terminalIdsOf(state: ThreadTerminalState): ReadonlyArray<string> {
  return state.groups.flatMap((group) => group.terminalIds);
}

export function activeGroupOf(state: ThreadTerminalState): TerminalGroup | null {
  const active = state.activeTerminalId;
  return (
    state.groups.find((group) => active !== null && group.terminalIds.includes(active)) ?? null
  );
}

/** The lowest free `term-N`: ids are client-chosen and stay unique within a thread. */
export function nextTerminalId(state: ThreadTerminalState, taken: Iterable<string> = []): string {
  const used = new Set([...terminalIdsOf(state), ...taken]);
  for (let index = 1; ; index += 1) {
    const id = `term-${index}`;
    if (!used.has(id)) return id;
  }
}

function withGroup(terminalId: string): TerminalGroup {
  return { id: `group-${terminalId}`, terminalIds: [terminalId], direction: "horizontal" };
}

/**
 * Shows the drawer. One with no terminals gets the server's running ones for this
 * thread (they outlive the TUI), or a first one.
 */
export function openTerminalDrawer(
  state: ThreadTerminalState,
  runningTerminalIds: ReadonlyArray<string> = [],
): ThreadTerminalState {
  if (state.groups.length > 0) return state.open ? state : { ...state, open: true };
  const ids = runningTerminalIds.length > 0 ? runningTerminalIds : [DEFAULT_TERMINAL_ID];
  return { open: true, groups: ids.map(withGroup), activeTerminalId: ids[0] ?? null };
}

export function hideTerminalDrawer(state: ThreadTerminalState): ThreadTerminalState {
  return state.open ? { ...state, open: false } : state;
}

/** A terminal in a tab of its own. */
export function addTerminalGroup(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  if (terminalIdsOf(state).includes(terminalId)) return activateTerminal(state, terminalId);
  return {
    open: true,
    groups: [...state.groups, withGroup(terminalId)],
    activeTerminalId: terminalId,
  };
}

/** Whether the active tab has room for one more pane in that direction. */
export function canSplitTerminal(
  state: ThreadTerminalState,
  direction: TerminalSplitDirection,
  drawer: { readonly cols: number; readonly rows: number },
): boolean {
  const group = activeGroupOf(state);
  if (group === null) return true;
  if (group.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return false;
  const panes = group.terminalIds.length + 1;
  // Panes split the space with a one-cell divider (or title row) between them.
  return direction === "horizontal"
    ? Math.floor((drawer.cols - (panes - 1)) / panes) >= MIN_TERMINAL_PANE_COLS
    : Math.floor((drawer.rows - panes) / panes) >= MIN_TERMINAL_PANE_ROWS;
}

/** A terminal next to the active one, in its tab. */
export function splitTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  direction: TerminalSplitDirection,
): ThreadTerminalState {
  const group = activeGroupOf(state);
  if (group === null) return addTerminalGroup(state, terminalId);
  if (terminalIdsOf(state).includes(terminalId)) return activateTerminal(state, terminalId);
  const anchor =
    state.activeTerminalId === null ? -1 : group.terminalIds.indexOf(state.activeTerminalId);
  const terminalIds = [...group.terminalIds];
  terminalIds.splice(anchor + 1, 0, terminalId);
  return {
    open: true,
    groups: state.groups.map((entry) =>
      entry === group ? { ...entry, terminalIds, direction } : entry,
    ),
    activeTerminalId: terminalId,
  };
}

export function activateTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  if (state.activeTerminalId === terminalId || !terminalIdsOf(state).includes(terminalId)) {
    return state;
  }
  return { ...state, activeTerminalId: terminalId };
}

/** The terminal `delta` places away from the active one, wrapping around. */
export function cycleTerminal(state: ThreadTerminalState, delta: number): ThreadTerminalState {
  const ids = terminalIdsOf(state);
  if (ids.length === 0) return state;
  const index = state.activeTerminalId === null ? 0 : ids.indexOf(state.activeTerminalId);
  const next = ids[(((index + delta) % ids.length) + ids.length) % ids.length];
  return next === undefined ? state : activateTerminal(state, next);
}

/**
 * Drops a terminal. The neighbour that takes its place is the next one in its tab,
 * else the previous one, else the next tab's. Closing the last one hides the drawer.
 */
export function removeTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const ids = terminalIdsOf(state);
  const index = ids.indexOf(terminalId);
  if (index === -1) return state;
  const groups = state.groups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);
  if (groups.length === 0) return EMPTY_THREAD_TERMINAL_STATE;
  const remaining = ids.filter((id) => id !== terminalId);
  const activeTerminalId =
    state.activeTerminalId === terminalId
      ? (remaining[Math.min(index, remaining.length - 1)] ?? null)
      : state.activeTerminalId;
  return { ...state, groups, activeTerminalId };
}

/** The drawer's height for a request, kept between its minimum and what the screen spares. */
export function clampTerminalDrawerHeight(requested: number, availableRows: number): number {
  const max = Math.max(MIN_TERMINAL_DRAWER_HEIGHT, availableRows - TERMINAL_DRAWER_RESERVED_ROWS);
  return Math.max(MIN_TERMINAL_DRAWER_HEIGHT, Math.min(Math.round(requested), max));
}

export interface TerminalDrawerStore {
  readonly subscribe: (listener: () => void) => () => void;
  /** Changes whenever any thread's drawer or the height does. */
  readonly version: () => number;
  readonly get: (threadId: string) => ThreadTerminalState;
  readonly update: (
    threadId: string,
    change: (state: ThreadTerminalState) => ThreadTerminalState,
  ) => ThreadTerminalState;
  readonly height: () => number;
  readonly setHeight: (height: number) => void;
}

/**
 * Every thread's drawer for this window. Switching threads keeps each one's
 * terminals, tabs and splits; the height is one for all threads.
 */
export function createTerminalDrawerStore(
  initialHeight = DEFAULT_TERMINAL_DRAWER_HEIGHT,
): TerminalDrawerStore {
  const states = new Map<string, ThreadTerminalState>();
  const listeners = new Set<() => void>();
  let version = 0;
  let height = initialHeight;
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    get: (threadId) => states.get(threadId) ?? EMPTY_THREAD_TERMINAL_STATE,
    update: (threadId, change) => {
      const current = states.get(threadId) ?? EMPTY_THREAD_TERMINAL_STATE;
      const next = change(current);
      if (next === current) return current;
      if (next === EMPTY_THREAD_TERMINAL_STATE) states.delete(threadId);
      else states.set(threadId, next);
      notify();
      return next;
    },
    height: () => height,
    setHeight: (next) => {
      if (next === height) return;
      height = next;
      notify();
    },
  };
}
