import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  closeServerTerminal,
  connectServerTerminal,
  runningTerminalIds,
  terminalAttachInput,
  type TerminalConnectionAtoms,
  writeChunkEnd,
} from "./terminalConnection.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

type Reply = AtomCommandResult<unknown, unknown>;
const ok: Reply = AsyncResult.success(undefined);
const failed = (message: string): Reply => AsyncResult.failure(Cause.fail(new Error(message)));

/** The real connection on a registry, with the server's RPCs answered by the test. */
function setup() {
  const registry = AtomRegistry.make();
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const writes: Array<{ readonly data: string; readonly reply: (result: Reply) => void }> = [];
  const closes: Array<unknown> = [];
  let closeReply: Reply = ok;
  const atoms: TerminalConnectionAtoms = {
    attach: () => attachment,
    write: {
      label: "write",
      run: (_registry, { input }) =>
        new Promise((resolve) => writes.push({ data: input.data, reply: resolve })),
    },
    close: {
      label: "close",
      run: async (_registry, { input }) => {
        closes.push(input);
        return closeReply;
      },
    },
    createSession: () => ({ driver: () => Atom.make(undefined), reportGridSize: () => {} }),
  };
  /** The attach stream's state: `lifecycle` moves on with each reattach. */
  const attach = (status: TerminalBufferState["status"], lifecycle = 0) =>
    registry.set(
      attachment,
      AsyncResult.success({
        ...EMPTY_TERMINAL_BUFFER_STATE,
        status,
        version: lifecycle + 1,
        lifecycleVersion: lifecycle,
      }),
    );
  const connection = connectServerTerminal({
    registry,
    atoms,
    environmentId,
    launch: {
      threadId,
      terminalId: "term-1",
      cwd: "/repo",
      worktreePath: null,
      projectRoot: "/repo",
    },
    gridSize: { cols: 80, rows: 24 },
    onExit: () => {},
  });
  // Lets settled RPC replies run through the connection's promise chain.
  const settle = async () => {
    for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
  };
  return {
    registry,
    atoms,
    connection,
    attach,
    writes,
    closes,
    settle,
    setCloseReply: (reply: Reply) => {
      closeReply = reply;
    },
  };
}

describe("connectServerTerminal", () => {
  it("holds input until the shell runs attached", async () => {
    const { connection, attach, writes, settle } = setup();
    connection.write("ls");
    await settle();
    expect(writes).toEqual([]);
    attach("running");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["ls"]);
  });

  it("never sends input queued behind a failed write, and says why in the pane", async () => {
    const { connection, attach, writes, settle } = setup();
    attach("running");
    const seen: Array<string | null> = [];
    connection.subscribe((buffer) => seen.push(buffer.error));
    connection.write("echo ");
    connection.write("hello\r");
    writes[0]?.reply(failed("socket closed."));
    await settle();
    connection.write("x");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["echo "]);
    expect(connection.read().error).toBe(
      "Input not sent: socket closed. Keys typed after it were dropped; type again to resume.",
    );
    expect(seen.at(-1)).toContain("Input not sent");

    // Reattaching starts a new lifecycle; input flows again.
    attach("running", 1);
    connection.write("pwd\r");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["echo ", "pwd\r"]);
    expect(connection.read().error).toBeNull();
  });

  it("resumes on the next key, sent fresh, on the same shell and attach stream", async () => {
    const { connection, attach, writes, settle } = setup();
    attach("running");
    connection.write("rm -rf bu");
    connection.write("ild\r");
    writes[0]?.reply(failed("socket closed."));
    await settle();
    // An emulator reply isn't the user typing; it doesn't resume input.
    connection.write("\u001b[1;1R");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["rm -rf bu"]);

    connection.resume();
    connection.write("\u0003");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["rm -rf bu", "\u0003"]);
    expect(connection.read().error).toBeNull();
  });

  it("sends nothing more once disposed, queued input included", async () => {
    const { connection, attach, writes, settle } = setup();
    attach("running");
    connection.write("a");
    connection.write("pasted text");
    connection.dispose();
    writes[0]?.reply(ok);
    await settle();
    connection.write("b");
    await settle();
    expect(writes.map((write) => write.data)).toEqual(["a"]);
  });
});

describe("closeServerTerminal", () => {
  it("deletes the closed terminal's history, so a reused id starts empty", async () => {
    const { registry, atoms, closes } = setup();
    await closeServerTerminal({ registry, atoms, environmentId, threadId, terminalId: "term-1" });
    expect(closes).toEqual([{ threadId, terminalId: "term-1", deleteHistory: true }]);
  });

  it("rejects when the server didn't close it", async () => {
    const { registry, atoms, setCloseReply } = setup();
    setCloseReply(failed("terminal busy"));
    await expect(
      closeServerTerminal({ registry, atoms, environmentId, threadId, terminalId: "term-1" }),
    ).rejects.toThrow("terminal busy");
  });
});

describe("terminalAttachInput", () => {
  it("starts the shell in the worktree with upstream's project variables", () => {
    expect(
      terminalAttachInput({
        threadId: ThreadId.make("t1"),
        terminalId: "term-2",
        cwd: "/repo/.worktrees/feature",
        worktreePath: "/repo/.worktrees/feature",
        projectRoot: "/repo",
      }),
    ).toEqual({
      threadId: "t1",
      terminalId: "term-2",
      cwd: "/repo/.worktrees/feature",
      worktreePath: "/repo/.worktrees/feature",
      env: { T3CODE_PROJECT_ROOT: "/repo", T3CODE_WORKTREE_PATH: "/repo/.worktrees/feature" },
    });
  });
});

describe("writeChunkEnd", () => {
  it("sends short input whole and cuts long input without splitting a surrogate pair", () => {
    expect(writeChunkEnd("ls\r")).toBe(3);
    expect(writeChunkEnd("a".repeat(40_000))).toBe(32_768);
    expect(writeChunkEnd(`${"a".repeat(32_767)}🙂b`)).toBe(32_767);
  });
});

describe("runningTerminalIds", () => {
  const summary = (
    threadId: string,
    terminalId: string,
    status: TerminalSummary["status"],
  ): TerminalSummary => ({
    threadId,
    terminalId,
    status,
    cwd: "/repo",
    worktreePath: null,
    pid: null,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: terminalId,
    updatedAt: "2026-10-27T00:00:00.000Z",
  });

  it("lists the thread's live shells in term-N order", () => {
    const summaries = [
      summary("t1", "term-10", "running"),
      summary("t1", "term-2", "starting"),
      summary("t1", "term-3", "exited"),
      summary("t2", "term-1", "running"),
    ];
    expect(runningTerminalIds(summaries, "t1")).toEqual(["term-2", "term-10"]);
    expect(runningTerminalIds(null, "t1")).toEqual([]);
  });
});
