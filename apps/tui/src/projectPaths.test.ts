import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectPathSuggestion,
  defaultCloneParent,
  initialProjectPath,
  parseCloneArgs,
  projectPathBrowseTarget,
  projectPathSuggestions,
} from "./projectPaths.ts";

describe("add-project prompt", () => {
  it("starts in the base directory, else the home folder", () => {
    expect(initialProjectPath("")).toBe("~/");
    expect(initialProjectPath("~/src")).toBe("~/src/");
  });

  it("lists the typed path's folder and filters by the last segment", () => {
    expect(projectPathBrowseTarget("~/src/al", "darwin")).toEqual({
      partialPath: "~/src/",
      filter: "al",
    });
    expect(projectPathBrowseTarget("~/src/", "darwin")).toEqual({
      partialPath: "~/src/",
      filter: "",
    });
    expect(projectPathBrowseTarget("alpha", "darwin")).toBeNull();
  });

  it("hides dot folders unless asked, and descends into a pick", () => {
    const entries = [
      { name: ".git", fullPath: "/h/src/.git" },
      { name: "alpha", fullPath: "/h/src/alpha" },
      { name: "beta", fullPath: "/h/src/beta" },
    ];
    expect(projectPathSuggestions(entries, "").map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(projectPathSuggestions(entries, ".").map((entry) => entry.name)).toEqual([".git"]);
    expect(applyProjectPathSuggestion("~/src/al", "alpha")).toBe("~/src/alpha/");
  });
});

describe("/clone", () => {
  it("clones owner/repo next to the open project, by URL on the default host", () => {
    const parent = defaultCloneParent("/home/me/src/app", "");
    expect(parent).toBe("/home/me/src/");
    const parsed = parseCloneArgs("octo/hello-world", parent);
    expect(parsed).toEqual({
      ok: true,
      request: {
        destinationPath: "/home/me/src/hello-world",
        title: "hello-world",
        remoteUrl: "https://github.com/octo/hello-world.git",
      },
    });
  });

  it("takes a URL, a destination, a protocol and a provider", () => {
    expect(parseCloneArgs("file:///tmp/repo.git ~/work/copy ssh", "~/")).toEqual({
      ok: true,
      request: {
        destinationPath: "~/work/copy",
        title: "copy",
        protocol: "ssh",
        remoteUrl: "file:///tmp/repo.git",
      },
    });
    const gitlab = parseCloneArgs("group/tool provider=gitlab", "~/");
    expect(gitlab.ok && gitlab.request.provider).toBe("gitlab");
    expect(gitlab.ok && gitlab.request.repository).toBe("group/tool");
  });

  it("explains bad input", () => {
    expect(parseCloneArgs("", "~/").ok).toBe(false);
    expect(parseCloneArgs("a/b one two", "~/")).toMatchObject({ ok: false });
    expect(defaultCloneParent(null, "")).toBe("~/");
  });
});
