import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export type RunStatusTone = "working" | "warning" | "error";

export interface RunStatusLine {
  readonly tone: RunStatusTone;
  readonly label: string;
  readonly detail: string | null;
  /** When the active run started, for an elapsed timer; null when settled. */
  readonly startedAtMs: number | null;
}

type RunStatusThread = Pick<EnvironmentThreadShell, "runtime" | "latestRun">;

const ACTIVE_LABELS = {
  preparing: "Preparing workspace",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting: "Waiting",
} as const;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The line under the timeline for the thread's latest run: what's running now, or how the
 * last run ended when it didn't complete. Completed runs show nothing.
 */
export function resolveRunStatusLine(thread: RunStatusThread | null): RunStatusLine | null {
  if (thread === null) return null;
  const runtime = thread.runtime;
  const status = runtime?.status ?? "idle";
  if (status in ACTIVE_LABELS) {
    const label = ACTIVE_LABELS[status as keyof typeof ACTIVE_LABELS];
    const latest = thread.latestRun;
    return {
      tone: "working",
      label,
      detail: null,
      startedAtMs:
        parseMs(runtime?.activityStartedAt) ??
        parseMs(latest?.startedAt) ??
        parseMs(latest?.requestedAt),
    };
  }
  switch (thread.latestRun?.status) {
    case "failed":
      return {
        tone: "error",
        label: "Run failed",
        detail: runtime?.lastError ?? null,
        startedAtMs: null,
      };
    case "interrupted":
      return { tone: "warning", label: "Run interrupted", detail: null, startedAtMs: null };
    case "cancelled":
      return { tone: "warning", label: "Run cancelled", detail: null, startedAtMs: null };
    default:
      return null;
  }
}

/** "8s", "2m 05s", "1h 03m": the running timer next to Working. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
