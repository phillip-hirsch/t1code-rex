import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerSendEntry } from "./composerStore.ts";
import {
  createQueueViewSelector,
  deriveQueueView,
  leftQueueNotice,
  queueHoldReason,
  queueRowActions,
  queuedMessageIdsKey,
  reorderTarget,
  unlistedSends,
  type QueueView,
} from "./queueView.ts";

type Projection = Parameters<typeof deriveThreadQueueWorkflowState>[0];
type Run = OrchestrationV2ThreadProjection["runs"][number];
type Message = Projection["messages"][number];

function run(id: string, ordinal: number, overrides: Partial<Run> = {}): Run {
  return {
    id: RunId.make(id),
    ordinal,
    status: "completed",
    userMessageId: MessageId.make(`m-${id}`),
    providerThreadId: null,
    activeAttemptId: null,
    startedAt: "2026-10-27T10:00:00.000Z",
    completedAt: null,
    ...overrides,
  } as Run;
}

function message(id: string, text: string, extra: Partial<Message> = {}): Message {
  return { id: MessageId.make(id), role: "user", text, attachments: [], ...extra } as Message;
}

/** A thread whose session queues and steers, with `runs` and their messages. */
function projection(runs: ReadonlyArray<Run>, messages: ReadonlyArray<Message>): Projection {
  return {
    thread: {
      id: ThreadId.make("t"),
      activeProviderThreadId: null,
      archivedAt: null,
      deletedAt: null,
      worktreePath: null,
    },
    runs,
    messages,
    providerThreads: [],
    providerTurns: [],
    providerSessions: [
      {
        id: "s",
        status: "running",
        capabilities: {
          turns: {
            supportsQueuedMessages: true,
            supportsActiveSteering: true,
            supportsSteeringByInterruptRestart: false,
          },
        },
      },
    ],
  } as unknown as Projection;
}

function view(runs: ReadonlyArray<Run>, messages: ReadonlyArray<Message>): QueueView {
  const source = projection(runs, messages);
  return deriveQueueView({
    workflow: deriveThreadQueueWorkflowState(source),
    runs: source.runs,
    worktreePath: null,
  });
}

const queued = (id: string, ordinal: number, position: number, held = false) =>
  run(id, ordinal, {
    status: "queued",
    queuePosition: position,
    startedAt: null,
    ...(held ? { queueHeld: true } : {}),
  });

describe("deriveQueueView", () => {
  it("lists the server's queued messages in queue order, on one line each", () => {
    const result = view(
      [run("r1", 1, { status: "running" }), queued("r2", 2, 1), queued("r3", 3, 0)],
      [message("m-r2", "second\n  line"), message("m-r3", "first")],
    );
    expect(result.rows.map((row) => [row.runId, row.preview])).toEqual([
      ["r3", "first"],
      ["r2", "second line"],
    ]);
    expect(result.rows[1]?.text).toBe("second\n  line");
    expect(result.activeRunId).toBe("r1");
    expect(result.holdReason).toBeNull();
  });

  it("marks held messages and says why the queue is held", () => {
    const result = view(
      [run("r1", 1, { status: "interrupted" }), queued("r2", 2, 0, true)],
      [message("m-r2", "next")],
    );
    expect(result.rows[0]?.held).toBe(true);
    expect(result.holdReason).toBe("stopped");
    expect(result.canSendNow).toBe(true);
  });

  it("keeps a guest's name so its message can't be edited", () => {
    const result = view(
      [queued("r2", 2, 0)],
      [
        message("m-r2", "hi", {
          context: { guest: { name: "Sam", text: "hi" } },
        } as Partial<Message>),
      ],
    );
    expect(result.rows[0]?.guestName).toBe("Sam");
  });
});

describe("queueHoldReason", () => {
  it("names a stop, a failed run, and a worktree that never got made", () => {
    expect(
      queueHoldReason({ runs: [run("r", 1, { status: "interrupted" })], worktreePath: null }),
    ).toBe("stopped");
    expect(queueHoldReason({ runs: [run("r", 1, { status: "failed" })], worktreePath: null })).toBe(
      "the last run failed",
    );
    const setup = run("r", 1, {
      status: "failed",
      workspacePreparation: { type: "worktree", baseRef: "main" },
    } as Partial<Run>);
    expect(queueHoldReason({ runs: [setup], worktreePath: null })).toBe(
      "worktree setup didn't finish",
    );
    // With its worktree there, it's an ordinary failed run.
    expect(queueHoldReason({ runs: [setup], worktreePath: "/w" })).toBe("the last run failed");
  });
});

describe("createQueueViewSelector", () => {
  it("keeps the same view while the projection changes but the queue doesn't", () => {
    const select = createQueueViewSelector();
    const runs = [run("r1", 1, { status: "running" }), queued("r2", 2, 0)];
    const messages = [message("m-r2", "next")];
    const first = select({
      workflow: deriveThreadQueueWorkflowState(projection(runs, messages)),
      runs,
      worktreePath: null,
    });
    // A token streamed: a new projection and workflow, the same queue.
    const again = select({
      workflow: deriveThreadQueueWorkflowState(projection([...runs], [...messages])),
      runs: [...runs],
      worktreePath: null,
    });
    expect(again).toBe(first);
    const edited = select({
      workflow: deriveThreadQueueWorkflowState(projection(runs, [message("m-r2", "changed")])),
      runs,
      worktreePath: null,
    });
    expect(edited).not.toBe(first);
    expect(edited?.rows[0]?.text).toBe("changed");
    expect(select(null)).toBeNull();
  });
});

function entry(messageId: string): ComposerSendEntry {
  return {
    send: {
      commandId: CommandId.make(`c-${messageId}`),
      messageId: MessageId.make(messageId),
      target: { kind: "thread", threadId: ThreadId.make("t"), projectId: ProjectId.make("p") },
    },
    status: "sending",
    attempt: 0,
  } as ComposerSendEntry;
}

describe("unlistedSends", () => {
  it("hides a pending send once the server lists it as queued, and keeps the rest", () => {
    const sends = [entry("a"), entry("b")];
    // The server queued send "a": its run's message id is the send's.
    const listed = { ...queued("r2", 2, 0), userMessageId: MessageId.make("a") };
    const key = queuedMessageIdsKey(view([listed], [message("a", "a")]));
    expect(unlistedSends(sends, key).map((shown) => shown.send.messageId)).toEqual(["b"]);
    expect(unlistedSends(sends, "")).toBe(sends);
    expect(unlistedSends(sends, "zzz")).toBe(sends);
  });
});

describe("queueRowActions", () => {
  const three = view(
    [run("r1", 1, { status: "running" }), queued("a", 2, 0), queued("b", 3, 1), queued("c", 4, 2)],
    [message("m-a", "a"), message("m-b", "b"), message("m-c", "c")],
  );
  const idle = { busy: false };

  it("allows every action on a middle row, and steering while the run takes steers", () => {
    const steerable = { ...three, canPromoteToSteer: true };
    const actions = queueRowActions(steerable, 1, idle);
    expect(actions?.edit.ok && actions.remove.ok && actions.moveUp.ok && actions.moveDown.ok).toBe(
      true,
    );
    expect(actions?.send).toEqual({ ok: true, mode: "steer" });
  });

  it("won't move the first up or the last down", () => {
    expect(queueRowActions(three, 0, idle)?.moveUp).toEqual({
      ok: false,
      reason: "It's already first",
    });
    expect(queueRowActions(three, 2, idle)?.moveDown).toEqual({
      ok: false,
      reason: "It's already last",
    });
  });

  it("says why it can't send while the run doesn't take steers", () => {
    expect(queueRowActions(three, 0, idle)?.send).toEqual({
      ok: false,
      reason: "The run can't take a steer right now",
      mode: null,
    });
  });

  it("sends now while nothing runs", () => {
    const stopped = { ...three, activeRunId: null, canSendNow: true };
    expect(queueRowActions(stopped, 2, idle)?.send).toEqual({ ok: true, mode: "start" });
  });

  it("blocks everything while a change is in flight", () => {
    const busy = queueRowActions(three, 1, { busy: true });
    expect([busy?.edit.ok, busy?.remove.ok, busy?.moveUp.ok, busy?.send.ok]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("doesn't reorder where the session can't", () => {
    expect(queueRowActions({ ...three, canReorder: false }, 1, idle)?.moveUp.ok).toBe(false);
    expect(queueRowActions(three, 5, idle)).toBeNull();
  });
});

describe("reorderTarget", () => {
  const three = view(
    [queued("a", 2, 0), queued("b", 3, 1), queued("c", 4, 2)],
    [message("m-a", "a"), message("m-b", "b"), message("m-c", "c")],
  );
  it("moves before the one above, or before the one two below, or last", () => {
    expect(reorderTarget(three, RunId.make("b"), -1)).toBe("a");
    expect(reorderTarget(three, RunId.make("a"), 1)).toBe("c");
    expect(reorderTarget(three, RunId.make("b"), 1)).toBeNull();
    expect(reorderTarget(three, RunId.make("a"), -1)).toBeUndefined();
    expect(reorderTarget(three, RunId.make("c"), 1)).toBeUndefined();
    expect(reorderTarget(three, RunId.make("gone"), 1)).toBeUndefined();
  });
});

describe("leftQueueNotice", () => {
  it("tells a removed message from one that started", () => {
    expect(leftQueueNotice("cancelled")).toBe("That message was already removed from the queue");
    expect(leftQueueNotice("running")).toBe("That message already started");
    expect(leftQueueNotice(null)).toBe("That message is no longer queued");
  });
});
