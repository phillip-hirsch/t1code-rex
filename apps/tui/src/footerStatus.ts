import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

/** The note Stop leaves in the footer, tied to the thread and run it stopped. */
export interface StopNotice {
  readonly kind: "stop";
  readonly threadId: string;
  /** The thread's latest run when Stop was pressed. */
  readonly runId: string | null;
  readonly text: string;
}

/** The footer's status: a one-off message, or the note from the last Stop. */
export type FooterStatus = string | StopNotice | null;

export const STOPPING = "Stopping";

export function createStopNotice(
  thread: Pick<EnvironmentThreadShell, "id" | "latestRun">,
  text: string,
): StopNotice {
  return { kind: "stop", threadId: thread.id, runId: thread.latestRun?.runId ?? null, text };
}

/**
 * The footer text. A stop note shows only on the thread it stopped and until a newer run
 * appears there; "Stopping" turns into "Stopped" once the run ends.
 */
export function resolveFooterStatus(
  status: FooterStatus,
  thread: Pick<EnvironmentThreadShell, "id" | "latestRun" | "runtime"> | null,
): string | null {
  if (status === null || typeof status === "string") return status;
  if (thread === null || thread.id !== status.threadId) return null;
  if ((thread.latestRun?.runId ?? null) !== status.runId) return null;
  return status.text === STOPPING && !threadRuntimeIsActive(thread.runtime)
    ? "Stopped"
    : status.text;
}
