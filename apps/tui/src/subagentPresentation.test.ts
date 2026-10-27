import { describe, expect, it } from "vite-plus/test";

import { presentedThread } from "./shellTestFixtures.ts";
import {
  PROVIDER_SUBAGENT_READ_ONLY_REASON,
  findSubagentForChild,
  resolveSubagentThreadContext,
  subagentStopBlocker,
  summarizeSubagent,
} from "./subagentPresentation.ts";
import { childThread, subagentItem, subagentRecord } from "./subagentTestFixtures.ts";
import type { SubagentTurnItem } from "./subagentPresentation.ts";

function itemOf(projected: ReturnType<typeof subagentItem>): SubagentTurnItem {
  const { item } = projected;
  if (item.type !== "subagent") throw new Error("not a subagent item");
  return item;
}

describe("summarizeSubagent", () => {
  it("shows the item until the parent's record loads, then the record's live state", () => {
    const item = itemOf(
      subagentItem("a", { title: "Subagent: list files", progress: "Reading src" }),
    );
    const before = summarizeSubagent({ item, record: null });
    expect(before).toMatchObject({
      title: "list files",
      state: "working",
      model: null,
      detail: "Reading src",
      childThreadId: "child-a",
    });

    const record = subagentRecord("sub-a", {
      status: "completed",
      result: "Found 3 files.\n\nDone.",
      progress: "Reading src",
      completedAt: "2026-06-20T10:00:04.000Z",
    });
    const after = summarizeSubagent({ item, record });
    expect(after.state).toBe("done");
    // A finished subagent shows its result, on one line.
    expect(after.detail).toBe("Found 3 files. Done.");
    expect(after.model).not.toBeNull();
    expect(after.completedAt).toBe("2026-06-20T10:00:04.000Z");
  });

  it("names an untitled subagent by its prompt's first line", () => {
    const item = itemOf(subagentItem("b", { title: null, prompt: "\nRun pwd\nthen report" }));
    expect(summarizeSubagent({ item, record: null }).title).toBe("Run pwd");
  });
});

describe("subagentStopBlocker", () => {
  it("lets a running Claude subagent with a strong task ref stop, as web does", () => {
    expect(subagentStopBlocker(subagentRecord("a"))).toBeNull();
  });

  it("explains why others can't", () => {
    expect(subagentStopBlocker(null)).toMatch(/loading/);
    expect(subagentStopBlocker(subagentRecord("a", { status: "completed" }))).toMatch(
      /isn't running/,
    );
    expect(subagentStopBlocker(subagentRecord("a", { startedAt: null }))).toMatch(/started/);
    expect(
      subagentStopBlocker(
        subagentRecord("a", {
          driver: "codex",
          providerInstanceId: "codex",
          nativeTaskRef: { driver: "codex", strength: "weak", nativeId: null },
        }),
      ),
    ).toMatch(/can't stop one subagent/);
  });

  it("stops app-owned tasks whatever their provider", () => {
    expect(
      subagentStopBlocker(
        subagentRecord("a", { origin: "app_owned", driver: "codex", nativeTaskRef: null }),
      ),
    ).toBeNull();
  });
});

describe("resolveSubagentThreadContext", () => {
  const parent = presentedThread("parent", "p", { title: "Refactor auth" });

  it("links a child to its parent and keeps a provider-native one read-only", () => {
    expect(resolveSubagentThreadContext(childThread("c", "p", "parent"), parent)).toEqual({
      parentThreadId: "parent",
      parentTitle: "Refactor auth",
      readOnly: true,
    });
    expect(PROVIDER_SUBAGENT_READ_ONLY_REASON).toMatch(/takes no messages/);
  });

  it("lets an app-owned child take messages", () => {
    const delegated = childThread("c", "p", "parent", { creationSource: "mcp" });
    expect(resolveSubagentThreadContext(delegated, null)).toEqual({
      parentThreadId: "parent",
      parentTitle: null,
      readOnly: false,
    });
  });

  it("is null for top-level threads", () => {
    expect(resolveSubagentThreadContext(parent, null)).toBeNull();
    expect(resolveSubagentThreadContext(null, null)).toBeNull();
  });
});

describe("findSubagentForChild", () => {
  it("finds the latest record naming the child", () => {
    const first = subagentRecord("a", { childThreadId: "child" });
    const again = subagentRecord("b", { childThreadId: "child" });
    expect(findSubagentForChild([first, again], "child")).toBe(again);
    expect(findSubagentForChild([first], "other")).toBeNull();
  });
});
