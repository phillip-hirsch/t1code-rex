import { describe, expect, it } from "vite-plus/test";

import {
  NO_PENDING_REQUESTS,
  approvalChoices,
  createRequestQueueSelector,
  deriveRequestQueue,
  type PendingRequest,
} from "./requestQueue.ts";
import {
  approvalItem,
  item,
  node,
  question,
  questionItem,
  runtimeRequest,
  source,
  subagent,
} from "./requestTestFixtures.ts";

function approvalOf(request: PendingRequest | undefined) {
  if (request?.kind !== "approval") throw new Error("expected an approval");
  return request;
}

describe("deriveRequestQueue", () => {
  it("lists approvals and questions oldest first, skipping resolved ones", () => {
    const queue = deriveRequestQueue(
      source({
        runtimeRequests: [
          runtimeRequest("late-approval", "command", { second: 30 }),
          runtimeRequest("question", "user_input", { second: 20 }),
          runtimeRequest("early-approval", "file-change", { second: 10 }),
          runtimeRequest("done", "command", { second: 5, status: "resolved" }),
        ],
        turnItems: [
          approvalItem("late-approval"),
          approvalItem("early-approval", { requestKind: "file-change" }),
          approvalItem("done"),
          questionItem("question", [question("q1", ["A", "B"])]),
        ],
      }),
    );
    expect(queue.map((request) => [request.kind, request.requestId])).toEqual([
      ["approval", "early-approval"],
      ["question", "question"],
      ["approval", "late-approval"],
    ]);
  });

  it("shows the command a command approval gates, from the tool call it hangs off", () => {
    const [request] = deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("r1", "command")],
        nodes: [
          node("node-r1", "approval_request", "node-tool"),
          node("node-tool", "tool_call", null),
        ],
        turnItems: [
          item("tool", "node-tool", { type: "command_execution", input: "ls -la" }),
          approvalItem("r1", { prompt: "Run ls" }),
        ],
      }),
    );
    expect(approvalOf(request).subject).toEqual({ type: "command", command: "ls -la" });
    expect(approvalOf(request).approval.detail).toBe("Run ls");
  });

  it("shows the file and line counts a file-change approval gates", () => {
    const [request] = deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("r1", "file-change")],
        nodes: [node("node-r1", "approval_request", "node-tool")],
        turnItems: [
          item("tool", "node-tool", {
            type: "file_change",
            fileName: "hello.txt",
            additions: 1,
            deletions: 0,
          }),
          approvalItem("r1", { requestKind: "file-change" }),
        ],
      }),
    );
    expect(approvalOf(request).subject).toEqual({
      type: "files",
      files: [{ path: "hello.txt", additions: 1, deletions: 0 }],
    });
  });

  it("has no subject when the tool call isn't in the thread yet", () => {
    const [request] = deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("r1", "command")],
        turnItems: [approvalItem("r1", { prompt: "Run something" })],
      }),
    );
    expect(approvalOf(request).subject).toBeNull();
  });

  it("names the native subagent a request came from", () => {
    const [request] = deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("r1", "command")],
        nodes: [
          node("node-r1", "approval_request", "node-tool"),
          node("node-tool", "tool_call", "node-sub"),
          node("node-sub", "subagent", "node-root"),
          node("node-root", "root_turn", null),
        ],
        subagents: [subagent("node-sub", "Explore the repo")],
        turnItems: [approvalItem("r1")],
      }),
    );
    expect(request?.subagent).toBe("Explore the repo");
  });

  it("leaves the parent's own requests unlabeled", () => {
    const [request] = deriveRequestQueue(
      source({
        runtimeRequests: [runtimeRequest("r1", "command")],
        nodes: [
          node("node-r1", "approval_request", "node-root"),
          node("node-root", "root_turn", null),
        ],
        turnItems: [approvalItem("r1")],
      }),
    );
    expect(request?.subagent).toBeNull();
  });
});

describe("approvalChoices", () => {
  const first = (fields: Record<string, unknown> = {}, capability?: Record<string, unknown>) =>
    approvalOf(
      deriveRequestQueue(
        source({
          runtimeRequests: [runtimeRequest("r1", "command", capability ? { capability } : {})],
          turnItems: [approvalItem("r1", fields)],
        }),
      )[0],
    ).approval;

  it("offers web's defaults when the provider names none, approvals first", () => {
    expect(approvalChoices(first()).map((choice) => [choice.decision, choice.key])).toEqual([
      ["accept", "y"],
      ["acceptForSession", "s"],
      ["decline", "n"],
      ["cancel", "c"],
    ]);
  });

  it("offers only the provider's options, with its labels", () => {
    const choices = approvalChoices(
      first({
        options: [
          { decision: "decline", label: "Decline" },
          { decision: "accept", label: "Approve", warning: "Runs outside the sandbox" },
        ],
      }),
    );
    expect(choices).toEqual([
      { decision: "accept", label: "Approve", warning: "Runs outside the sandbox", key: "y" },
      { decision: "decline", label: "Decline", key: "n" },
    ]);
  });

  it("offers nothing for a request the provider can no longer answer", () => {
    expect(approvalChoices(first({}, { type: "not_resumable", reason: "gone" }))).toEqual([]);
  });
});

describe("createRequestQueueSelector", () => {
  it("keeps the queue's identity while only unrelated items change", () => {
    const select = createRequestQueueSelector();
    const runtimeRequests = [runtimeRequest("r1", "command")];
    const first = select(source({ runtimeRequests, turnItems: [approvalItem("r1")] }));
    const streamed = select(
      source({
        runtimeRequests,
        turnItems: [
          approvalItem("r1"),
          item("text", null, {
            type: "assistant_message",
            messageId: "m1",
            text: "more",
            streaming: true,
          }),
        ],
      }),
    );
    expect(streamed).toBe(first);
  });

  it("returns the shared empty queue once nothing is pending", () => {
    const select = createRequestQueueSelector();
    select(
      source({
        runtimeRequests: [runtimeRequest("r1", "command")],
        turnItems: [approvalItem("r1")],
      }),
    );
    const after = select(
      source({
        runtimeRequests: [runtimeRequest("r1", "command", { status: "resolved" })],
        turnItems: [approvalItem("r1")],
      }),
    );
    expect(after).toBe(NO_PENDING_REQUESTS);
    expect(select(null)).toBe(NO_PENDING_REQUESTS);
  });
});
