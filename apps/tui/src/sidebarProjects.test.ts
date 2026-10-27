import { describe, expect, it } from "vite-plus/test";

import {
  collapseProject,
  ensureProjectExpanded,
  pruneExpandedProjects,
  resolveProjectPrimaryAction,
  toggleProjectExpanded,
} from "./sidebarProjects.ts";

describe("sidebarProjects", () => {
  it("toggles a project open and closed", () => {
    const collapsed = new Set<string>();
    const expanded = toggleProjectExpanded(collapsed, "project-a");

    expect([...expanded]).toEqual(["project-a"]);
    expect([...toggleProjectExpanded(expanded, "project-a")]).toEqual([]);
  });

  it("prunes deleted projects from the expanded set", () => {
    const expanded = pruneExpandedProjects(new Set(["project-a", "project-b"]), ["project-a"]);

    expect(expanded).toEqual(new Set(["project-a"]));
  });

  it("returns the same set when the state already matches", () => {
    const expanded = new Set(["project-a"]);
    const collapsed = new Set<string>();

    expect(ensureProjectExpanded(expanded, "project-a")).toBe(expanded);
    expect(collapseProject(collapsed, "project-a")).toBe(collapsed);
  });

  it("reopens a collapsed active project before moving focus into threads", () => {
    expect(
      resolveProjectPrimaryAction({
        activeProjectId: "project-a",
        expandedProjectIds: new Set<string>(),
        threadCount: 3,
      }),
    ).toBe("expand-project");
  });

  it("focuses threads only after the active project is already expanded", () => {
    expect(
      resolveProjectPrimaryAction({
        activeProjectId: "project-a",
        expandedProjectIds: new Set(["project-a"]),
        threadCount: 3,
      }),
    ).toBe("focus-threads");
  });
});
