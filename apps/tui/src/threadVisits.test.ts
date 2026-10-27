import { describe, expect, it } from "vite-plus/test";

import {
  capThreadVisits,
  clearThreadUnread,
  MAX_TRACKED_VISITS,
  markThreadUnread,
  recordThreadVisit,
} from "./threadVisits.ts";

const finishedRun = { completedAt: "2026-06-20T01:00:00.000Z" };
describe("recordThreadVisit", () => {
  it("marks the thread seen through its finished run", () => {
    expect(recordThreadVisit({}, "t", finishedRun)).toEqual({ t: finishedRun.completedAt });
  });

  it("keeps the same object when already seen, or nothing finished", () => {
    const visits = { t: "2026-06-20T02:00:00.000Z" };
    expect(recordThreadVisit(visits, "t", finishedRun)).toBe(visits);
    expect(recordThreadVisit(visits, "u", null)).toBe(visits);
    expect(recordThreadVisit(visits, "u", { completedAt: null })).toBe(visits);
  });

  it("records again after a later run", () => {
    const visits = { t: finishedRun.completedAt };
    expect(recordThreadVisit(visits, "t", { completedAt: "2026-06-20T05:00:00.000Z" })).toEqual({
      t: "2026-06-20T05:00:00.000Z",
    });
  });
});

describe("capThreadVisits", () => {
  it("keeps the given thread even when its visit is the oldest", () => {
    const visits = {
      a: "2026-06-03T00:00:00.000Z",
      b: "2026-06-02T00:00:00.000Z",
      old: "2026-06-01T00:00:00.000Z",
    };
    expect(capThreadVisits(visits, 2, "old")).toEqual({
      a: "2026-06-03T00:00:00.000Z",
      old: "2026-06-01T00:00:00.000Z",
    });
  });

  it("records an old run into a full cache once, then returns the same object", () => {
    const full: Record<string, string> = {};
    for (let index = 0; index < MAX_TRACKED_VISITS; index += 1) {
      full[`newer-${index}`] = "2026-06-21T00:00:00.000Z";
    }
    const recorded = recordThreadVisit(full, "old", finishedRun);
    expect(recorded.old).toBe(finishedRun.completedAt);
    expect(Object.keys(recorded)).toHaveLength(MAX_TRACKED_VISITS);
    expect(recordThreadVisit(recorded, "old", finishedRun)).toBe(recorded);
  });

  it("drops the oldest visits past the limit", () => {
    const visits = {
      a: "2026-06-01T00:00:00.000Z",
      b: "2026-06-03T00:00:00.000Z",
      c: "2026-06-02T00:00:00.000Z",
    };
    expect(capThreadVisits(visits, 2)).toEqual({
      b: "2026-06-03T00:00:00.000Z",
      c: "2026-06-02T00:00:00.000Z",
    });
    expect(capThreadVisits(visits, 3)).toBe(visits);
  });
});

describe("unread marks", () => {
  it("marks only threads with a finished run", () => {
    const empty: ReadonlySet<string> = new Set();
    expect([...markThreadUnread(empty, "t", finishedRun)]).toEqual(["t"]);
    expect(markThreadUnread(empty, "t", null)).toBe(empty);
  });

  it("clears a mark and keeps the set when there is none", () => {
    const unread: ReadonlySet<string> = new Set(["t"]);
    expect([...clearThreadUnread(unread, "t")]).toEqual([]);
    expect(clearThreadUnread(unread, "u")).toBe(unread);
    expect(clearThreadUnread(unread, null)).toBe(unread);
  });
});
