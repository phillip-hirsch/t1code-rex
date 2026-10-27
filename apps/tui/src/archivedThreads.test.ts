import { describe, expect, it } from "vite-plus/test";

import { buildArchivedThreadRows } from "./archivedThreads.ts";
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
