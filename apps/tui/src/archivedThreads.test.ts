import { describe, expect, it } from "vite-plus/test";

import {
  buildArchivedThreadRows,
  reconcileArchivedSelection,
  selectArchivedRow,
} from "./archivedThreads.ts";
import { at, presentedThread, projectShell } from "./shellTestFixtures.ts";

describe("buildArchivedThreadRows", () => {
  it("lists archived threads newest first, with their project", () => {
    const rows = buildArchivedThreadRows({
      projects: [projectShell("p")],
      threads: [
        presentedThread("old", "p", { archivedAt: at("2026-06-20T01:00:00.000Z") }),
        presentedThread("live", "p"),
        presentedThread("new", "p", { archivedAt: at("2026-06-21T01:00:00.000Z") }),
        presentedThread("gone", "p", {
          archivedAt: at("2026-06-22T01:00:00.000Z"),
          deletedAt: at("2026-06-22T02:00:00.000Z"),
        }),
      ],
    });
    expect(rows.map((row) => row.threadId)).toEqual(["new", "old"]);
    expect(rows[0]?.projectTitle).toBe(projectShell("p").title);
  });
});

describe("archived-thread selection, PR 15 Sol audit round 1", () => {
  const rows = (...ids: ReadonlyArray<string>) =>
    buildArchivedThreadRows({
      projects: [projectShell("p")],
      threads: ids.map((id, index) =>
        presentedThread(id, "p", {
          archivedAt: at(`2026-06-2${9 - index}T01:00:00.000Z`),
        }),
      ),
    });

  it("S5: restoring the last row moves the selection to the row now there, for keys and view alike", () => {
    const before = rows("a", "b");
    const selected = selectArchivedRow(before, 1);
    expect(selected).toEqual({ threadId: "b", index: 1 });
    const after = rows("a");
    const reconciled = reconcileArchivedSelection(after, selected);
    expect(reconciled).toEqual({ threadId: "a", index: 0 });
    // Enter or Delete now acts on the highlighted row, not on nothing.
    expect(after[reconciled.index]?.threadId).toBe("a");
  });

  it("S5: stays on its thread when a row above it leaves", () => {
    const selected = selectArchivedRow(rows("a", "b", "c"), 1);
    expect(reconcileArchivedSelection(rows("b", "c"), selected)).toEqual({
      threadId: "b",
      index: 0,
    });
  });

  it("S5: keeps identity when nothing moved, and waits while the rows load", () => {
    const listed = rows("a", "b");
    const selected = selectArchivedRow(listed, 0);
    expect(reconcileArchivedSelection(listed, selected)).toBe(selected);
    const opening = { threadId: null, index: 0 };
    expect(reconcileArchivedSelection([], opening)).toBe(opening);
    expect(reconcileArchivedSelection(listed, opening)).toEqual({ threadId: "a", index: 0 });
  });

  it("S5: moves stop at either end", () => {
    const listed = rows("a", "b");
    expect(selectArchivedRow(listed, -1)).toEqual({ threadId: "a", index: 0 });
    expect(selectArchivedRow(listed, 5)).toEqual({ threadId: "b", index: 1 });
  });
});
