import { describe, expect, it } from "vite-plus/test";

import { buildTimelineRows, presentTurnItem, rowHasGapAfter } from "./threadTimeline.ts";
import { subagentItem } from "./subagentTestFixtures.ts";
import { assistantMessage, command, turnItem, userMessage } from "./turnItemTestFixtures.ts";

describe("presentTurnItem", () => {
  it("shows user and assistant messages with their text and time", () => {
    const user = presentTurnItem(userMessage("u1", "Fix the **build**"));
    expect(user).toMatchObject({
      kind: "user",
      text: "Fix the **build**",
      intent: null,
      attribution: null,
      createdAtMs: Date.parse("2026-06-20T10:00:00.000Z"),
    });
    expect(presentTurnItem(assistantMessage("a1", "Done.", true))).toMatchObject({
      kind: "assistant",
      text: "Done.",
      streaming: true,
    });
  });

  it("marks steered and queued messages and names agent senders", () => {
    expect(presentTurnItem(userMessage("u1", "also this", { inputIntent: "steer" }))).toMatchObject(
      { intent: "steer" },
    );
    expect(
      presentTurnItem(userMessage("u2", "later", { inputIntent: "queued_turn" })),
    ).toMatchObject({ intent: "queued" });
    expect(
      presentTurnItem(userMessage("u3", "from mcp", { createdBy: "agent", creationSource: "mcp" })),
    ).toMatchObject({ attribution: "Agent" });
  });

  it("drops empty finished assistant text but keeps a reply that is still streaming", () => {
    expect(presentTurnItem(assistantMessage("a1", "  "))).toBeNull();
    expect(presentTurnItem(assistantMessage("a2", "", true))).toMatchObject({ kind: "assistant" });
  });

  it("presents commands as one-line work rows with the old icon", () => {
    expect(presentTurnItem(command("c1", "ls -la"))).toMatchObject({
      kind: "work",
      icon: "󰆍",
      text: "Ran command - ls -la",
      accent: "command",
      status: "done",
    });
    expect(presentTurnItem(command("c2", "bun test", { status: "running" }))).toMatchObject({
      text: "Running command - bun test",
      status: "running",
    });
  });

  it("marks a command with a non-zero exit as failed", () => {
    expect(presentTurnItem(command("c1", "false", { exitCode: 1 }))).toMatchObject({
      status: "failed",
      accent: "error",
      icon: "󰀦",
    });
  });

  it("summarizes file changes with the first path, a count, and line stats", () => {
    const row = presentTurnItem(
      turnItem("f1", {
        type: "file_change",
        fileName: "src/a.ts",
        additions: 3,
        deletions: 1,
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
        ],
      }),
    );
    expect(row).toMatchObject({
      kind: "work",
      text: "Edited - src/a.ts +1 more (+3 -1)",
      accent: "change",
    });
  });

  it("shows reasoning as a Thinking row with its latest thought", () => {
    const row = presentTurnItem(
      turnItem("r1", {
        type: "reasoning",
        text: "**Checking the tests**\n\nThe suite fails because…",
        streaming: true,
        status: "running",
      }),
    );
    expect(row).toMatchObject({
      kind: "work",
      icon: "󰚩",
      text: "Thinking - Checking the tests",
      status: "running",
    });
    expect(
      presentTurnItem(turnItem("r2", { type: "reasoning", text: "", streaming: false })),
    ).toBeNull();
  });

  it("shows provider errors as error notices with the failure message", () => {
    const row = presentTurnItem(
      turnItem("e1", {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "model not found",
          code: null,
          retryable: false,
        },
      }),
    );
    expect(row).toMatchObject({
      kind: "notice",
      tone: "error",
      text: "Provider error",
      detail: "model not found",
    });
  });

  it("shows plans, todo lists, and read-only request rows", () => {
    expect(
      presentTurnItem(
        turnItem("p1", {
          type: "proposed_plan",
          planId: "plan-1",
          markdown: "1. Do it",
          streaming: false,
        }),
      ),
    ).toMatchObject({ kind: "plan", markdown: "1. Do it" });
    expect(
      presentTurnItem(
        turnItem("t1", {
          type: "todo_list",
          planId: "plan-2",
          steps: [{ id: "s1", text: "Write tests", status: "running" }],
        }),
      ),
    ).toMatchObject({
      kind: "todo",
      steps: [{ id: "s1", text: "Write tests", status: "running" }],
    });
    expect(
      presentTurnItem(
        turnItem("q1", {
          type: "approval_request",
          status: "waiting",
          requestId: "req-1",
          requestKind: "command",
          prompt: "rm -rf build",
        }),
      ),
    ).toMatchObject({ kind: "work", text: "Approval requested - rm -rf build", status: "running" });
  });

  it("hides checkpoints that changed no files", () => {
    const checkpoint = (files: ReadonlyArray<Record<string, unknown>>) =>
      turnItem("k1", { type: "checkpoint", checkpointId: "cp-1", scopeId: "scope-1", files });
    expect(presentTurnItem(checkpoint([]))).toBeNull();
    expect(
      presentTurnItem(checkpoint([{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }])),
    ).toMatchObject({ text: "Changed - a.ts (+1 -0)", diffRunId: null });
  });

  it("sums a checkpoint's files and points its row at the run's diff", () => {
    const row = presentTurnItem(
      turnItem("k2", {
        type: "checkpoint",
        runId: "run-7",
        checkpointId: "cp-2",
        scopeId: "scope-1",
        files: [
          { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
          { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
        ],
      }),
    );
    expect(row).toMatchObject({
      kind: "work",
      text: "Changed - 2 files (+13 -1)",
      accent: "change",
      diffRunId: "run-7",
    });
  });
});

describe("buildTimelineRows", () => {
  it("presents each item once, so unchanged items keep their row", () => {
    const user = userMessage("u1", "hi");
    const first = buildTimelineRows([user, assistantMessage("a1", "He", true)]);
    const second = buildTimelineRows([user, assistantMessage("a1", "Hello", true)]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toMatchObject({ text: "Hello" });
  });

  it("leaves out items with no row", () => {
    const rows = buildTimelineRows([userMessage("u1", "hi"), assistantMessage("a1", "")]);
    expect(rows.map((row) => row.kind)).toEqual(["user"]);
  });
});

describe("rowHasGapAfter", () => {
  it("keeps consecutive work rows flush and spaces everything else", () => {
    const [user, one, two] = buildTimelineRows([
      userMessage("u1", "go"),
      command("c1", "ls"),
      command("c2", "pwd"),
    ]);
    expect(rowHasGapAfter(user!, one)).toBe(true);
    expect(rowHasGapAfter(one!, two)).toBe(false);
    expect(rowHasGapAfter(two!, undefined)).toBe(false);
  });
});

describe("subagent items", () => {
  it("become subagent rows that sit flush with work rows", () => {
    const row = presentTurnItem(subagentItem("s1"));
    expect(row).toMatchObject({ kind: "subagent", threadId: "parent" });
    expect(row?.kind === "subagent" ? row.item.subagentId : null).toBe("sub-s1");
    const work = presentTurnItem(command("c1", "ls"));
    if (row === null || work === null) throw new Error("rows expected");
    expect(rowHasGapAfter(row, work)).toBe(false);
    expect(rowHasGapAfter(work, row)).toBe(false);
  });
});
