import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_MULTI_SELECTION,
  extendThreadSelection,
  pruneThreadSelection,
  selectThreadRange,
  toggleThreadInSelection,
} from "./sidebarSelection.ts";

const order = ["a", "b", "c", "d"];
const ids = (selection: { threadIds: ReadonlySet<string> }) => [...selection.threadIds].toSorted();

describe("thread multi-selection", () => {
  it("starts from the cursor's thread and extends from the anchor", () => {
    const first = extendThreadSelection(EMPTY_MULTI_SELECTION, "b", order, 1);
    expect(first?.threadId).toBe("c");
    expect(ids(first!.selection)).toEqual(["b", "c"]);
    const second = extendThreadSelection(first!.selection, "c", order, 1);
    expect(ids(second!.selection)).toEqual(["b", "c", "d"]);
    expect(extendThreadSelection(second!.selection, "d", order, 1)).toBeNull();
  });

  it("toggles single threads and ranges from the last toggled one", () => {
    const one = toggleThreadInSelection(EMPTY_MULTI_SELECTION, "a");
    expect(ids(selectThreadRange(one, "c", order))).toEqual(["a", "b", "c"]);
    expect(ids(toggleThreadInSelection(one, "a"))).toEqual([]);
  });

  it("prunes threads that left, keeping identity when none did", () => {
    const selection = selectThreadRange(
      toggleThreadInSelection(EMPTY_MULTI_SELECTION, "a"),
      "c",
      order,
    );
    expect(pruneThreadSelection(selection, () => true)).toBe(selection);
    const pruned = pruneThreadSelection(selection, (id) => id !== "a");
    expect(ids(pruned)).toEqual(["b", "c"]);
    expect(pruned.anchorThreadId).toBeNull();
  });
});
