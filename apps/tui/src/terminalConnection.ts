import {
  createTerminalEnvironmentAtoms,
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
  type TerminalGridSize,
  type TerminalSession,
  type TerminalSessionAtoms,
  type TerminalSessionOptions,
} from "@t3tools/client-runtime/state/terminal";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  TerminalAttachInput,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

/** What a pane shows: the session's output buffer, how it's doing, and why it failed. */
export type TerminalPaneBuffer = Pick<
  TerminalBufferState,
  "output" | "status" | "error" | "version"
>;

/** One pane's line to its shell. */
export interface TerminalPaneConnection {
  readonly read: () => TerminalPaneBuffer;
  /** Calls back on every change, output chunks included; never re-renders React. */
  readonly subscribe: (listener: (buffer: TerminalPaneBuffer) => void) => () => void;
  readonly write: (data: string) => void;
  readonly reportGridSize: (size: TerminalGridSize) => void;
  readonly dispose: () => void;
}

/** Opens a pane's connection once the pane knows its grid. */
export type TerminalPaneConnector = (gridSize: TerminalGridSize) => TerminalPaneConnection;

/** A write over the schema's 64 KiB cap goes in pieces, in order. */
const MAX_WRITE_CHARS = 32_768;

/** Where the next write ends: the cap, pulled back so a surrogate pair stays whole. */
export function writeChunkEnd(data: string): number {
  if (data.length <= MAX_WRITE_CHARS) return data.length;
  const code = data.charCodeAt(MAX_WRITE_CHARS - 1);
  return code >= 0xd800 && code <= 0xdbff ? MAX_WRITE_CHARS - 1 : MAX_WRITE_CHARS;
}

export type TerminalEnvironmentAtoms = ReturnType<typeof createTerminalEnvironmentAtoms>;

/** The slice of the terminal atoms a pane's connection and close use. */
export interface TerminalConnectionAtoms {
  readonly attach: TerminalSessionAtoms["attach"];
  readonly write: TerminalSessionAtoms["write"];
  readonly close: TerminalSessionAtoms["close"];
  readonly createSession: (options: TerminalSessionOptions) => TerminalSession;
}

export interface TerminalLaunch {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  /** Where the shell starts: the thread's worktree, else its project's folder. */
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly projectRoot: string;
}

/** The attach input for a launch; equal launches share one attach stream. */
export function terminalAttachInput(launch: TerminalLaunch): TerminalAttachInput {
  return {
    threadId: launch.threadId,
    terminalId: launch.terminalId,
    cwd: launch.cwd,
    worktreePath: launch.worktreePath,
    env: projectScriptRuntimeEnv({
      project: { cwd: launch.projectRoot },
      worktreePath: launch.worktreePath,
    }),
  };
}

function bufferOf(
  result: AsyncResult.AsyncResult<TerminalBufferState, unknown>,
): TerminalPaneBuffer {
  const buffer = Option.getOrElse(AsyncResult.value(result), () => EMPTY_TERMINAL_BUFFER_STATE);
  if (result._tag !== "Failure") return buffer;
  const error = Cause.squash(result.cause);
  return {
    ...buffer,
    status: "error",
    error: error instanceof Error ? error.message : "Terminal unavailable",
  };
}

/** The failure's message without its final period, so it can sit inside a sentence. */
function failureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  const message = error instanceof Error ? error.message.replace(/\.$/u, "") : "";
  return message.length > 0 ? message : fallback;
}

/**
 * A pane attached to the server's terminal the way web's drawer attaches. Input goes to a
 * running shell one write at a time; a failed write drops what's queued behind it and
 * stops input until the terminal reattaches, so no later chunk runs without it.
 */
export function connectServerTerminal(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atoms: TerminalConnectionAtoms;
  readonly environmentId: EnvironmentId;
  readonly launch: TerminalLaunch;
  readonly gridSize: TerminalGridSize;
  /** The shell exited while shown; the server's terminal is already closed. */
  readonly onExit: () => void;
  readonly debugLog?: (message: string, data: Record<string, unknown>) => void;
}): TerminalPaneConnection {
  const { registry, atoms, environmentId, launch } = input;
  const attachInput = terminalAttachInput(launch);
  const session = atoms.createSession({
    target: { environmentId, threadId: launch.threadId, terminalId: launch.terminalId },
    gridSize: input.gridSize,
    canOperate: () => true,
    onExit: input.onExit,
    ...(input.debugLog ? { debugLog: input.debugLog } : {}),
  });
  const unmount = registry.mount(session.driver({ kind: "attached", input: attachInput }));
  const attachAtom = atoms.attach({ environmentId, input: attachInput });
  const listeners = new Set<(buffer: TerminalPaneBuffer) => void>();
  let disposed = false;
  let pending = "";
  let writing = false;
  /** Why input stopped; it resumes once a shell other than `stoppedAt` runs attached. */
  let inputError: string | null = null;
  let stoppedAt: number | null = null;

  const read = (): TerminalPaneBuffer => {
    const buffer = bufferOf(registry.get(attachAtom));
    return inputError === null ? buffer : { ...buffer, error: inputError };
  };
  const notify = () => {
    const buffer = read();
    for (const listener of listeners) listener(buffer);
  };
  /** The lifecycle of a running, attached shell, else null. */
  const runningLifecycle = (): number | null => {
    const result = registry.get(attachAtom);
    const buffer = Option.getOrNull(AsyncResult.value(result));
    return result._tag !== "Failure" &&
      buffer !== null &&
      buffer.version > 0 &&
      buffer.status === "running"
      ? buffer.lifecycleVersion
      : null;
  };
  const resumeInput = () => {
    if (inputError === null) return;
    const lifecycle = runningLifecycle();
    if (lifecycle !== null && lifecycle !== stoppedAt) inputError = null;
  };
  // One write in flight at a time, so keys can't overtake each other on the way;
  // what's typed meanwhile goes out together in the next one.
  const pump = () => {
    if (disposed || writing || inputError !== null || pending.length === 0) return;
    const lifecycle = runningLifecycle();
    if (lifecycle === null) return;
    const end = writeChunkEnd(pending);
    const data = pending.slice(0, end);
    pending = pending.slice(end);
    writing = true;
    void runAtomCommand(
      registry,
      atoms.write,
      { environmentId, input: { threadId: launch.threadId, terminalId: launch.terminalId, data } },
      { reportFailure: false },
    ).then((result) => {
      writing = false;
      if (disposed) return;
      if (result._tag === "Success") {
        pump();
        return;
      }
      pending = "";
      inputError = `Input not sent: ${failureMessage(result, "Terminal write failed")}. Typing resumes when the terminal reconnects.`;
      stoppedAt = lifecycle;
      notify();
      // The pane has printed why; a reattach that landed meanwhile resumes input at once.
      resumeInput();
    });
  };
  const unsubscribe = registry.subscribe(attachAtom, () => {
    resumeInput();
    pump();
    notify();
  });
  return {
    read,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (data) => {
      if (disposed || inputError !== null) return;
      pending += data;
      pump();
    },
    reportGridSize: session.reportGridSize,
    dispose: () => {
      disposed = true;
      pending = "";
      listeners.clear();
      unsubscribe();
      unmount();
    },
  };
}

/** Ends a terminal's shell on the server and deletes its history, as web's close does. */
export async function closeServerTerminal(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atoms: Pick<TerminalConnectionAtoms, "close">;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}): Promise<void> {
  const result = await runAtomCommand(
    input.registry,
    input.atoms.close,
    {
      environmentId: input.environmentId,
      input: { threadId: input.threadId, terminalId: input.terminalId, deleteHistory: true },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    throw new Error(failureMessage(result, "Terminal close failed"));
  }
}

/** Running shells a thread has on the server, in `term-N` order. */
export function runningTerminalIds(
  summaries: ReadonlyArray<TerminalSummary> | null,
  threadId: string,
): ReadonlyArray<string> {
  if (summaries === null) return [];
  const compare = new Intl.Collator(undefined, { numeric: true }).compare;
  return summaries
    .filter(
      (summary) =>
        summary.threadId === threadId &&
        (summary.status === "running" || summary.status === "starting"),
    )
    .map((summary) => summary.terminalId)
    .toSorted(compare);
}

/** Where the drawer's shells live: the server, or a stand-in in checks. */
export interface TerminalBackend {
  /** Keeps what the backend watches subscribed; returns the release. */
  readonly retain: () => () => void;
  /** Shells the backend runs for a thread, which a newly shown drawer picks up. */
  readonly runningTerminalIds: (threadId: string) => ReadonlyArray<string>;
  readonly connect: (
    launch: TerminalLaunch,
    gridSize: TerminalGridSize,
    onExit: () => void,
  ) => TerminalPaneConnection;
  /** Ends the shell and deletes its history; rejects when the server didn't. */
  readonly close: (threadId: ThreadId, terminalId: string) => Promise<void>;
}

/** The drawer's backend on this server's terminal RPCs. */
export function createServerTerminalBackend(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atoms: TerminalEnvironmentAtoms;
  readonly environmentId: EnvironmentId;
}): TerminalBackend {
  const { registry, atoms, environmentId } = input;
  // The server's terminal list is small, so it stays subscribed while the drawer can show.
  const metadataAtom = atoms.metadata({ environmentId, input: null });
  return {
    retain: () => registry.mount(metadataAtom),
    runningTerminalIds: (threadId) =>
      runningTerminalIds(Option.getOrNull(AsyncResult.value(registry.get(metadataAtom))), threadId),
    connect: (launch, gridSize, onExit) =>
      connectServerTerminal({ registry, atoms, environmentId, launch, gridSize, onExit }),
    close: (threadId, terminalId) =>
      closeServerTerminal({ registry, atoms, environmentId, threadId, terminalId }),
  };
}
