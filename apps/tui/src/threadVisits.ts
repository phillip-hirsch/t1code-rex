import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";

/**
 * Local unread tracking, persisted in prefs: when this TUI last saw each thread, and the
 * threads the user marked unread.
 */

export type ThreadVisits = Readonly<Record<string, string>>;

/** Bounds prefs.json; the oldest visits go first. */
export const MAX_TRACKED_VISITS = 500;

/**
 * Marks the open thread seen through its latest finished run. The stored time is the run's
 * completion, a watermark rather than a clock reading, so it needs no clock and records
 * once per run. The controller calls this while rendering, so it must be idempotent: the
 * thread just recorded survives the cap even when its run is older than every other visit.
 */
export function recordThreadVisit(
  visits: ThreadVisits,
  threadId: string,
  latestRun: Pick<ThreadRunSummary, "completedAt"> | null,
): ThreadVisits {
  const completedAt = latestRun?.completedAt ?? null;
  const completedAtMs = Date.parse(completedAt ?? "");
  if (completedAt === null || Number.isNaN(completedAtMs)) return visits;
  const visitedAtMs = Date.parse(visits[threadId] ?? "");
  if (!Number.isNaN(visitedAtMs) && visitedAtMs >= completedAtMs) return visits;
  return capThreadVisits({ ...visits, [threadId]: completedAt }, MAX_TRACKED_VISITS, threadId);
}

/** Drops the oldest visits past `max`, always keeping `keepThreadId`'s. */
export function capThreadVisits(
  visits: ThreadVisits,
  max = MAX_TRACKED_VISITS,
  keepThreadId?: string,
): ThreadVisits {
  const entries = Object.entries(visits);
  if (entries.length <= max) return visits;
  return Object.fromEntries(
    entries
      .toSorted(
        (left, right) =>
          Number(right[0] === keepThreadId) - Number(left[0] === keepThreadId) ||
          right[1].localeCompare(left[1]),
      )
      .slice(0, max),
  );
}

/** Only threads with a finished run can be unread, as before. */
export function markThreadUnread(
  unread: ReadonlySet<string>,
  threadId: string,
  latestRun: Pick<ThreadRunSummary, "completedAt"> | null,
): ReadonlySet<string> {
  if (!latestRun?.completedAt || unread.has(threadId)) return unread;
  return new Set([...unread, threadId]);
}

export function clearThreadUnread(
  unread: ReadonlySet<string>,
  threadId: string | null,
): ReadonlySet<string> {
  if (threadId === null || !unread.has(threadId)) return unread;
  const next = new Set(unread);
  next.delete(threadId);
  return next;
}
