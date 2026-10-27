import { describe, expect, it } from "vite-plus/test";

import { resolveDiffKey } from "./diffNavigation.ts";
import { routeThreadPaneKey, type ThreadPaneKey } from "./threadPaneKeys.ts";
import { resolveScrollKey } from "./threadScroll.ts";

// The panes as the shell has them: the transcript, or the diff in its place.
const transcript = (key: ThreadPaneKey) => resolveScrollKey(key, 20) !== null;
const diff = (key: ThreadPaneKey) => resolveDiffKey(key, 20) !== null;

function route(name: string, pane = transcript, composer: "thread" | "draft" | null = "thread") {
  return routeThreadPaneKey({ name }, { composer, pane });
}

describe("routeThreadPaneKey", () => {
  it("keeps g and G for the transcript and opens the git menu on c", () => {
    expect(route("g")).toBe("pane");
    expect(routeThreadPaneKey({ name: "g" }, { composer: "thread", pane: transcript })).toBe(
      "pane",
    );
    expect(route("c")).toBe("git-menu");
    expect(route("b")).toBe("branch-picker");
  });

  it("reaches the git menu and branch picker past the diff panel too", () => {
    expect(route("c", diff)).toBe("git-menu");
    expect(route("b", diff)).toBe("branch-picker");
    // The diff's own d closes it.
    expect(route("d", diff)).toBe("pane");
  });

  it("toggles the diff only for a thread, and leaves modified keys alone", () => {
    expect(route("d")).toBe("diff");
    expect(route("d", transcript, "draft")).toBeNull();
    expect(
      routeThreadPaneKey({ name: "c", ctrl: true }, { composer: "thread", pane: transcript }),
    ).toBeNull();
    expect(route("c", transcript, null)).toBeNull();
    expect(route("i")).toBe("compose");
  });
});
