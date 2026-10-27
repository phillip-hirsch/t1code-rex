import { describe, expect, it } from "vitest";

import {
  buildSplitArgs,
  buildWindowNewArgs,
  createRexClient,
  createRexWindowRegistry,
  parseSplitResult,
  parseWindowIds,
  parseWindowNewResult,
  resolveRexContext,
  rexTabLabel,
  type RexContext,
} from "./rexWorkspace";

const context: RexContext = { bin: "rex", sessionId: "session:1", blockId: "block:tui" };

describe("resolveRexContext", () => {
  it("is null outside Rex", () => {
    expect(resolveRexContext({})).toBeNull();
  });

  it("reads the session, block, and optional binary override", () => {
    expect(resolveRexContext({ REX_SESSION: "session:1", REX_BLOCK: "block:tui" })).toEqual(
      context,
    );
    expect(resolveRexContext({ REX_SESSION: "session:1", T1CODE_REX_BIN: "/opt/rex" })).toEqual({
      bin: "/opt/rex",
      sessionId: "session:1",
      blockId: null,
    });
  });
});

describe("rex arguments", () => {
  it("builds a window command with the program after --", () => {
    expect(
      buildWindowNewArgs(context, {
        label: "Diff: repo",
        cwd: "/repo",
        keepOpen: true,
        command: ["git", "diff", "HEAD"],
      }),
    ).toEqual([
      "window",
      "new",
      "-s",
      "session:1",
      "Diff: repo",
      "-c",
      "/repo",
      "--keep-open",
      "--focus=true",
      "--json",
      "--",
      "git",
      "diff",
      "HEAD",
    ]);
  });

  it("splits beside the T1Code block by default and runs a shell without a command", () => {
    expect(
      buildSplitArgs(context, { label: "Terminal", direction: "below", ratio: 30, cwd: "/repo" }),
    ).toEqual([
      "split",
      "-s",
      "session:1",
      "-b",
      "block:tui",
      "--split=below",
      "--ratio",
      "30",
      "--label",
      "Terminal",
      "-c",
      "/repo",
      "--focus=true",
      "--json",
    ]);
  });
});

describe("rex output parsing", () => {
  it("reads created windows, splits, and window listings", () => {
    expect(
      parseWindowNewResult('{"window_id":"window:2","block_ids":["block:2"],"revision":2}'),
    ).toEqual({ windowId: "window:2", blockId: "block:2" });
    expect(parseSplitResult('{"anchor_id":"block:1","block_ids":["block:3"]}')).toEqual({
      blockId: "block:3",
    });
    expect([
      ...parseWindowIds('{"windows":[{"window_id":"window:1"},{"window_id":"window:2"}]}'),
    ]).toEqual(["window:1", "window:2"]);
  });

  it("rejects output without the IDs T1Code needs", () => {
    expect(() => parseWindowNewResult("{}")).toThrow("did not return a window");
    expect(() => parseSplitResult('{"block_ids":[]}')).toThrow("did not return a block");
    expect(() => parseWindowNewResult("oops")).toThrow("invalid JSON");
  });
});

describe("createRexWindowRegistry", () => {
  it("focuses an open tab and reopens one the user closed", async () => {
    const calls: string[][] = [];
    let openWindows = '{"windows":[]}';
    const client = createRexClient(context, async (_bin, args) => {
      calls.push([...args]);
      return args[1] === "ls" ? openWindows : "";
    });
    const registry = createRexWindowRegistry(client);
    let opened = 0;
    const open = async () => {
      opened += 1;
      return { windowId: `window:${opened}`, blockId: `block:${opened}` };
    };

    expect(await registry.openOrFocus("thread:a", open)).toEqual({
      windowId: "window:1",
      reused: false,
    });
    openWindows = '{"windows":[{"window_id":"window:1"}]}';
    expect(await registry.openOrFocus("thread:a", open)).toEqual({
      windowId: "window:1",
      reused: true,
    });
    expect(calls.at(-1)).toEqual(["focus", "-s", "session:1", "window:1"]);

    openWindows = '{"windows":[]}';
    expect(await registry.openOrFocus("thread:a", open)).toEqual({
      windowId: "window:2",
      reused: false,
    });
  });
});

describe("createRexWindowRegistry concurrency", () => {
  it("opens one tab when the same thread is opened twice at once", async () => {
    const windows = new Set<string>();
    const client = createRexClient(context, async (_bin, args) =>
      args[1] === "ls"
        ? JSON.stringify({ windows: [...windows].map((window_id) => ({ window_id })) })
        : "",
    );
    const registry = createRexWindowRegistry(client);
    let opened = 0;
    const open = async () => {
      opened += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const windowId = `window:${opened}`;
      windows.add(windowId);
      return { windowId, blockId: `block:${opened}` };
    };

    const results = await Promise.all([
      registry.openOrFocus("thread:a", open),
      registry.openOrFocus("thread:a", open),
    ]);
    expect(opened).toBe(1);
    expect(results).toEqual([
      { windowId: "window:1", reused: false },
      { windowId: "window:1", reused: true },
    ]);
  });
});

describe("rexTabLabel", () => {
  it("collapses whitespace and truncates long titles", () => {
    expect(rexTabLabel("  Fix\n login  ")).toBe("Fix login");
    expect(rexTabLabel("")).toBe("Thread");
    expect(rexTabLabel("a".repeat(40), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
