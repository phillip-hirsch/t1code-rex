import { describe, expect, it } from "vite-plus/test";

import {
  activeGroupOf,
  addTerminalGroup,
  canSplitTerminal,
  clampTerminalDrawerHeight,
  createTerminalDrawerStore,
  cycleTerminal,
  DEFAULT_TERMINAL_ID,
  EMPTY_THREAD_TERMINAL_STATE,
  hideTerminalDrawer,
  MIN_TERMINAL_DRAWER_HEIGHT,
  nextTerminalId,
  openTerminalDrawer,
  removeTerminal,
  splitTerminal,
  terminalIdsOf,
} from "./terminalDrawer.ts";

const opened = openTerminalDrawer(EMPTY_THREAD_TERMINAL_STATE);

describe("openTerminalDrawer", () => {
  it("starts a first terminal when the thread has none", () => {
    expect(opened.open).toBe(true);
    expect(terminalIdsOf(opened)).toEqual([DEFAULT_TERMINAL_ID]);
    expect(opened.activeTerminalId).toBe(DEFAULT_TERMINAL_ID);
  });

  it("picks up the shells the server still runs, each in its own tab", () => {
    const state = openTerminalDrawer(EMPTY_THREAD_TERMINAL_STATE, ["term-1", "term-3"]);
    expect(state.groups.map((group) => group.terminalIds)).toEqual([["term-1"], ["term-3"]]);
    expect(state.activeTerminalId).toBe("term-1");
  });

  it("shows a hidden drawer with the terminals it had", () => {
    const split = splitTerminal(opened, "term-2", "horizontal");
    const reopened = openTerminalDrawer(hideTerminalDrawer(split), ["term-9"]);
    expect(reopened.groups).toBe(split.groups);
    expect(reopened.activeTerminalId).toBe("term-2");
  });
});

describe("terminal ids", () => {
  it("takes the lowest free term-N, skipping ids the server holds", () => {
    expect(nextTerminalId(opened)).toBe("term-2");
    expect(nextTerminalId(opened, ["term-2"])).toBe("term-3");
    expect(nextTerminalId(removeTerminal(addTerminalGroup(opened, "term-2"), "term-1"))).toBe(
      "term-1",
    );
  });
});

describe("tabs and splits", () => {
  it("opens a new terminal in a tab of its own", () => {
    const state = addTerminalGroup(opened, "term-2");
    expect(state.groups.map((group) => group.terminalIds)).toEqual([["term-1"], ["term-2"]]);
    expect(activeGroupOf(state)?.terminalIds).toEqual(["term-2"]);
  });

  it("splits next to the active terminal, in the active tab", () => {
    const first = splitTerminal(opened, "term-2", "horizontal");
    const back = cycleTerminal(first, -1);
    const second = splitTerminal(back, "term-3", "vertical");
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]?.terminalIds).toEqual(["term-1", "term-3", "term-2"]);
    expect(second.groups[0]?.direction).toBe("vertical");
    expect(second.activeTerminalId).toBe("term-3");
  });

  it("stops splitting at four panes or when a pane would be too small", () => {
    let state = opened;
    for (const id of ["term-2", "term-3", "term-4"]) {
      state = splitTerminal(state, id, "horizontal");
    }
    expect(canSplitTerminal(state, "horizontal", { cols: 400, rows: 40 })).toBe(false);
    expect(canSplitTerminal(opened, "horizontal", { cols: 41, rows: 10 })).toBe(true);
    expect(canSplitTerminal(opened, "horizontal", { cols: 40, rows: 10 })).toBe(false);
    expect(canSplitTerminal(opened, "vertical", { cols: 80, rows: 8 })).toBe(true);
    expect(canSplitTerminal(opened, "vertical", { cols: 80, rows: 7 })).toBe(false);
  });

  it("cycles through every terminal across tabs, wrapping around", () => {
    const state = splitTerminal(addTerminalGroup(opened, "term-2"), "term-3", "horizontal");
    expect(cycleTerminal(state, 1).activeTerminalId).toBe("term-1");
    expect(cycleTerminal(state, -1).activeTerminalId).toBe("term-2");
  });
});

describe("removeTerminal", () => {
  it("hands focus to the neighbour and drops an emptied tab", () => {
    const state = splitTerminal(addTerminalGroup(opened, "term-2"), "term-3", "horizontal");
    const closed = removeTerminal(state, "term-3");
    expect(closed.activeTerminalId).toBe("term-2");
    const tabGone = removeTerminal(removeTerminal(closed, "term-2"), "unknown");
    expect(tabGone.groups.map((group) => group.terminalIds)).toEqual([["term-1"]]);
    expect(tabGone.activeTerminalId).toBe("term-1");
  });

  it("empties and hides the drawer with the last terminal", () => {
    expect(removeTerminal(opened, "term-1")).toBe(EMPTY_THREAD_TERMINAL_STATE);
  });
});

describe("clampTerminalDrawerHeight", () => {
  it("keeps the drawer between its minimum and what leaves the thread room", () => {
    expect(clampTerminalDrawerHeight(14, 40)).toBe(14);
    expect(clampTerminalDrawerHeight(60, 40)).toBe(32);
    expect(clampTerminalDrawerHeight(1, 40)).toBe(MIN_TERMINAL_DRAWER_HEIGHT);
    expect(clampTerminalDrawerHeight(14, 6)).toBe(MIN_TERMINAL_DRAWER_HEIGHT);
  });
});

describe("createTerminalDrawerStore", () => {
  it("keeps each thread's drawer apart and notifies only on change", () => {
    const store = createTerminalDrawerStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.update("a", (state) => openTerminalDrawer(state));
    store.update("a", (state) => openTerminalDrawer(state));
    expect(notified).toBe(1);
    expect(store.get("a").open).toBe(true);
    expect(store.get("b")).toBe(EMPTY_THREAD_TERMINAL_STATE);
    store.update("a", (state) => removeTerminal(state, "term-1"));
    expect(store.get("a")).toBe(EMPTY_THREAD_TERMINAL_STATE);
    store.setHeight(20);
    expect(store.height()).toBe(20);
    expect(notified).toBe(3);
  });
});
