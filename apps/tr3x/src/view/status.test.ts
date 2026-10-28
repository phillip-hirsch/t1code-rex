import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveRexStatus,
  sameRexStatus,
  sanitizeStatusText,
  type RexStatusInput,
} from "./status.ts";

const run = RunId.make("run-1");
const idle: RexStatusInput = {
  title: "Fix login",
  requests: null,
  activeRun: false,
  latestRun: null,
  seenRunId: null,
  lastReply: null,
};

const approval: PendingThreadRequests = {
  approvals: [
    {
      requestId: RuntimeRequestId.make("req-1"),
      requestKind: "command",
      createdAt: "2026-10-27T00:00:00.000Z",
      detail: "rm -rf build\u001b[2J",
      responseCapability: "live",
    },
  ],
  userInputs: [],
};

describe("resolveRexStatus", () => {
  it("reports what the thread needs, most urgent first", () => {
    expect(resolveRexStatus({ ...idle, requests: approval, activeRun: true })).toEqual({
      state: "blocked",
      kind: "permission",
      app: "tr3x",
      title: "Fix login",
      message: "rm -rf build [2J",
    });
    const question: PendingThreadRequests = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("req-2"),
          createdAt: "2026-10-27T00:00:00.000Z",
          questions: [
            { id: "q", header: "Pick", question: "Which branch?", options: [], multiSelect: false },
          ],
          responseCapability: "live",
          dismissible: true,
        },
      ],
    };
    expect(resolveRexStatus({ ...idle, requests: question })).toMatchObject({
      state: "blocked",
      kind: "question",
      message: "Which branch?",
    });
    expect(
      resolveRexStatus({ ...idle, activeRun: true, lastReply: "Reading files" }),
    ).toMatchObject({
      state: "working",
      message: "Reading files",
    });
  });

  it("reports a finished run as done until the user has seen it, then idle", () => {
    const finished = {
      ...idle,
      latestRun: { id: run, status: "completed" as const },
      lastReply: "All set",
    };
    expect(resolveRexStatus(finished)).toMatchObject({ state: "done", message: "All set" });
    expect(resolveRexStatus({ ...finished, seenRunId: run })).toMatchObject({ state: "idle" });
    const failed = { ...idle, latestRun: { id: run, status: "failed" as const } };
    expect(resolveRexStatus(failed)).toMatchObject({ state: "error" });
    expect(resolveRexStatus({ ...failed, seenRunId: run }).state).toBe("idle");
  });

  it("compares reports by what Rex stores", () => {
    const status = resolveRexStatus(idle);
    expect(sameRexStatus(status, resolveRexStatus(idle))).toBe(true);
    expect(sameRexStatus(status, resolveRexStatus({ ...idle, title: "Other" }))).toBe(false);
    expect(sameRexStatus(null, status)).toBe(false);
  });
});

describe("sanitizeStatusText", () => {
  it("keeps one line without controls, within the protocol's byte limit", () => {
    expect(sanitizeStatusText("line one\nline\ttwo\u0085‮", 100)).toBe("line one line two");
    const long = sanitizeStatusText("é".repeat(200), 192);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(192);
    expect(long.endsWith("…")).toBe(true);
  });
});
