import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  MessageId,
  OrchestrationV2DispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerSend } from "./composerSend.ts";
import {
  createComposerSender,
  DISCARD_NOTICE,
  QUIT_NOTICE,
  type ComposerCommandResult,
} from "./composerSender.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore, type ComposerStore } from "./composerStore.ts";
import type { TuiPrefs } from "./prefs.ts";
import { deriveRequestQueue, type PendingRequest } from "./requestQueue.ts";
import {
  ANOTHER_ARRIVED,
  createRedirectDecliner,
  NOT_DECLINED,
  redirectSend,
} from "./requestRedirect.ts";
import { createRequestResponder } from "./requestResponder.ts";
import {
  approvalItem,
  item,
  node,
  question,
  questionItem,
  runtimeRequest,
  source,
} from "./requestTestFixtures.ts";

const threadId = ThreadId.make("t1");
const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const ok: ComposerCommandResult = { ok: true };
const dropped: ComposerCommandResult = {
  ok: false,
  error: new Error("Socket is not connected"),
  interrupted: false,
};
const rejected: ComposerCommandResult = {
  ok: false,
  error: new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("cmd-x"),
    commandType: "runtime-request.respond",
    message: "Runtime request a1 is resolved.",
  }),
  interrupted: false,
};
const a1 = RuntimeRequestId.make("a1");
const a2 = RuntimeRequestId.make("a2");

function message(text: string, id: string): ComposerSend {
  return {
    target: { kind: "thread", threadId, projectId: ProjectId.make("p") },
    commandId: CommandId.make(id),
    messageId: MessageId.make(`msg-${id}`),
    text,
    attachments: [],
    dispatch: "queue",
    settings,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
}

/** A send from the composer while `a1` is the approval on screen. */
function redirected(text: string, id: string): ComposerSend {
  return {
    ...message(text, id),
    dispatch: "steer",
    declines: { requestIds: [a1], knownApprovalIds: [a1] },
  };
}

/** A reply the test sends when it chooses, to force an interleaving. */
function deferred() {
  let resolve!: (result: ComposerCommandResult) => void;
  const promise = new Promise<ComposerCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

/** A store that saves to an in-memory prefs.json, as the window that owns it does. */
function savingStore(prefs: { current: TuiPrefs }): ComposerStore {
  return createComposerStore({
    initialPrefs: prefs.current,
    persist: (patch) => {
      const next: Record<string, unknown> = { ...prefs.current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      prefs.current = JSON.parse(JSON.stringify(next)) as TuiPrefs;
    },
  });
}

/**
 * The real store, sender, responder and decliner, as ui.tsx wires them; only the server's
 * replies are scripted. `log` lists commands in the order they reach the server. A decline
 * reply comes from `declines` (a result or a deferred), else ok.
 */
function setup(
  options: {
    readonly declines?: Array<ComposerCommandResult | Promise<ComposerCommandResult>>;
    readonly store?: ComposerStore;
  } = {},
) {
  const log: string[] = [];
  const declineIds: string[] = [];
  const turns: StartThreadTurnInput[] = [];
  const timers: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const schedule = (run: () => void, delayMs: number) => {
    const timer = { run, delayMs };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  const server = { pending: [a1] as ReadonlyArray<RuntimeRequestId> };
  const store = options.store ?? createComposerStore({ initialPrefs: {}, persist: null });
  const replies = [...(options.declines ?? [])];
  const responder = createRequestResponder({
    respondToApproval: (input) => {
      log.push(`${input.decision}:${input.requestId}`);
      declineIds.push(input.commandId ?? "");
      return Promise.resolve(replies.shift() ?? ok);
    },
    respondToUserInput: () => Promise.resolve(ok),
    dismissUserInput: () => Promise.resolve(ok),
    schedule,
  });
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      log.push(`turn:${input.message.text}:${input.dispatchMode ?? "?"}`);
      turns.push(input);
      return Promise.resolve(ok);
    },
    setRuntimeMode: () => Promise.resolve(ok),
    setInteractionMode: () => Promise.resolve(ok),
    threadSettings: () => settings,
    resumeQueue: () => {
      log.push("queue.resume");
      return Promise.resolve(ok);
    },
    declineApprovals: createRedirectDecliner({
      responder,
      pendingApprovalIds: () => server.pending,
    }),
    schedule,
  });
  /** The approval resolved on the server: the thread drops it and the responder prunes it. */
  const resolve = (requestId: RuntimeRequestId) => {
    server.pending = server.pending.filter((id) => id !== requestId);
    responder.prune(threadId, server.pending);
  };
  return { log, declineIds, turns, timers, server, store, responder, sender, resolve };
}

describe("N5: a message's declines run inside its sender job", () => {
  it("declines once, then sends A and B in the order they were sent", async () => {
    const reply = deferred();
    const { log, declineIds, sender, resolve } = setup({ declines: [reply.promise] });
    void sender.send(redirected("A", "cmd-a"));
    void sender.send(redirected("B", "cmd-b"));
    await settle();
    // B waits behind A's decline: nothing of B's goes out first.
    expect(log).toEqual(["decline:a1"]);
    reply.resolve(ok);
    resolve(a1);
    await settle();
    expect(log).toEqual(["decline:a1", "turn:A:steer", "turn:B:steer"]);
    expect(declineIds).toEqual(["cmd-a:decline:a1"]);
  });

  it("B skips a decline A already sent, even before the thread drops the approval", async () => {
    const { log, sender } = setup();
    void sender.send(redirected("A", "cmd-a"));
    void sender.send(redirected("B", "cmd-b"));
    await settle();
    expect(log).toEqual(["decline:a1", "turn:A:steer", "turn:B:steer"]);
  });

  it("Stop during the decline holds the messages; nothing goes out until resumed", async () => {
    const reply = deferred();
    const { log, sender, store, resolve } = setup({ declines: [reply.promise] });
    void sender.send(redirected("A", "cmd-a"));
    void sender.send(redirected("B", "cmd-b"));
    await settle();
    expect(sender.hold(threadId)).toBe(2);
    reply.resolve(ok);
    resolve(a1);
    await settle();
    // No queue.resume, no message: the server's held queue and ours both wait.
    expect(log).toEqual(["decline:a1"]);
    expect(store.snapshot(threadId).sends.map((entry) => entry.status)).toEqual(["held", "held"]);
    expect(sender.resume(threadId)).toBe(2);
    await settle();
    expect(log).toEqual(["decline:a1", "queue.resume", "turn:A:steer", "turn:B:steer"]);
  });

  it("quitting during the decline puts the message back, and it's there on relaunch", async () => {
    const prefs: { current: TuiPrefs } = { current: {} };
    const reply = deferred();
    const { log, sender, store } = setup({ declines: [reply.promise], store: savingStore(prefs) });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    expect(sender.pendingCount()).toBe(1);
    sender.handOff();
    store.flush();
    reply.resolve(ok);
    await settle();
    expect(log).toEqual(["decline:a1"]);
    // Never dispatched, so it's back in the composer, not a "may have been sent" record.
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
    const relaunched = savingStore(prefs);
    expect(relaunched.getDraft(threadId).text).toBe("A");
    expect(relaunched.snapshot(threadId).notice).toBe(QUIT_NOTICE);
  });

  it("/discard during the decline hands the message back and sends nothing more", async () => {
    const reply = deferred();
    const { log, sender, store, resolve } = setup({ declines: [reply.promise] });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    expect(sender.discard(threadId)).toEqual({ messages: 1, resumes: 0 });
    expect(store.getDraft(threadId).text).toBe("A");
    expect(store.snapshot(threadId).notice).toBe(DISCARD_NOTICE);
    reply.resolve(ok);
    resolve(a1);
    await settle();
    expect(log).toEqual(["decline:a1"]);
    expect(sender.pendingCount()).toBe(0);
  });

  it("/discard while a decline waits on the connection leaves the approval answerable", async () => {
    const { log, sender, responder, timers } = setup({ declines: [dropped] });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    expect(responder.status(a1)).toBeNull();
    sender.discard(threadId);
    for (const timer of timers.splice(0)) timer.run();
    await settle();
    expect(log).toEqual(["decline:a1"]);
  });

  it("a turned-down decline sends the messages back with why, and the approval stays answerable", async () => {
    const { log, sender, store, responder } = setup({ declines: [rejected] });
    void sender.send(redirected("A", "cmd-a"));
    void sender.send(redirected("B", "cmd-b"));
    await settle();
    expect(log).toEqual(["decline:a1"]);
    expect(store.getDraft(threadId).text).toBe("A\n\nB");
    expect(store.snapshot(threadId).notice).toBe(
      `${NOT_DECLINED} (Runtime request a1 is resolved.)`,
    );
    expect(sender.pendingCount()).toBe(0);
    expect(responder.status(a1)?.state).toBe("failed");
  });

  it("a decline that lost the connection is retried with the same id, then the message goes", async () => {
    const { log, declineIds, sender, timers, store } = setup({ declines: [dropped] });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    expect(store.snapshot(threadId).sends[0]?.status).toBe("waiting");
    for (const timer of timers.filter((entry) => entry.delayMs === 1_000)) timer.run();
    await settle();
    expect(log).toEqual(["decline:a1", "decline:a1", "turn:A:steer"]);
    expect(declineIds).toEqual(["cmd-a:decline:a1", "cmd-a:decline:a1"]);
  });

  it("skips the decline when the approval resolved before its stage ran", async () => {
    const { log, sender, resolve } = setup();
    // "first" is out; A waits behind it, held by Stop.
    void sender.send(message("first", "cmd-0"));
    void sender.send(redirected("A", "cmd-a"));
    sender.hold(threadId);
    await settle();
    resolve(a1);
    sender.resume(threadId);
    await settle();
    expect(log).toEqual(["turn:first:queue", "queue.resume", "turn:A:steer"]);
  });

  it("skips the decline when the approval is being answered from the panel", async () => {
    const answer = deferred();
    const { log, sender, responder } = setup({ declines: [answer.promise] });
    responder.respond(threadId, a1, { type: "approval", decision: "accept" });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    expect(log).toEqual(["accept:a1", "turn:A:steer"]);
  });

  it("sends the message back when another approval arrived since it was sent", async () => {
    const reply = deferred();
    const { log, sender, store, server } = setup({ declines: [reply.promise] });
    void sender.send(redirected("A", "cmd-a"));
    await settle();
    server.pending = [a1, a2];
    reply.resolve(ok);
    await settle();
    expect(log).toEqual(["decline:a1"]);
    expect(store.getDraft(threadId).text).toBe("A");
    expect(store.snapshot(threadId).notice).toBe(ANOTHER_ARRIVED);
  });
});

/** A command approval `id`, at `second`. */
function approvalSource(id: string, second: number) {
  return {
    runtimeRequests: [runtimeRequest(id, "command", { second })],
    nodes: [node(`node-${id}`, "approval_request", `tool-${id}`, "run-1")],
    turnItems: [
      item("tool", `tool-${id}`, { type: "command_execution", input: "ls > listing.txt" }),
      approvalItem(id),
    ],
  };
}

describe("N6: a send declines only the approval on screen", () => {
  const question0 = {
    runtimeRequests: [runtimeRequest("q0", "user_input", { second: 0 })],
    turnItems: [questionItem("q0", [question("color", ["Red", "Blue"])])],
  };
  const both = approvalSource("a1", 1);
  const second = approvalSource("a2", 2);
  const queue: ReadonlyArray<PendingRequest> = deriveRequestQueue(
    source({
      runtimeRequests: [
        ...question0.runtimeRequests,
        ...both.runtimeRequests,
        ...second.runtimeRequests,
      ],
      nodes: [...both.nodes, ...second.nodes],
      turnItems: [...question0.turnItems, ...both.turnItems, ...second.turnItems],
    }),
  );
  const byId = (id: string) => queue.find((request) => request.requestId === id) ?? null;
  const none = () => null;

  it("leaves the send alone while a question is on screen", () => {
    const send = message("hi", "cmd-a");
    expect(redirectSend(send, { active: byId("q0"), statusOf: none, queue })).toBe(send);
  });

  it("declines the approval on screen only, and steers", () => {
    const routed = redirectSend(message("hi", "cmd-a"), {
      active: byId("a1"),
      statusOf: none,
      queue,
    });
    expect(routed.dispatch).toBe("steer");
    expect(routed.declines).toEqual({ requestIds: ["a1"], knownApprovalIds: ["a1", "a2"] });
  });

  it("leaves an answered or unanswerable approval alone", () => {
    const send = message("hi", "cmd-a");
    const answering = () => ({
      state: "sending" as const,
      response: { type: "approval" as const, decision: "accept" as const },
    });
    expect(redirectSend(send, { active: byId("a1"), statusOf: answering, queue })).toBe(send);
    const gone = deriveRequestQueue(
      source({
        ...approvalSource("a3", 3),
        runtimeRequests: [
          runtimeRequest("a3", "command", { capability: { type: "not_resumable", reason: "x" } }),
        ],
      }),
    );
    expect(redirectSend(send, { active: gone[0] ?? null, statusOf: none, queue: gone })).toBe(send);
  });

  it("leaves the send alone with nothing on screen", () => {
    const send = message("hi", "cmd-a");
    expect(redirectSend(send, { active: null, statusOf: none, queue })).toBe(send);
  });
});
