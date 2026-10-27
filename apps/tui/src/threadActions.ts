/**
 * Bulk thread actions run one thread at a time, as the old TUI did, so the server sees
 * them in order and a failure stops nothing else. The summary says what happened.
 */

export interface BulkOutcome {
  readonly done: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly threadId: string; readonly error: unknown }>;
}

export async function runForThreads(
  threadIds: ReadonlyArray<string>,
  run: (
    threadId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>,
): Promise<BulkOutcome> {
  const done: string[] = [];
  const failed: Array<{ threadId: string; error: unknown }> = [];
  for (const threadId of threadIds) {
    const result = await run(threadId);
    if (result.ok) done.push(threadId);
    else failed.push({ threadId, error: result.error });
  }
  return { done, failed };
}

/** "Archived 3 threads", or "Archived 2 of 3 threads: <first error>". */
export function describeBulkOutcome(
  verb: string,
  outcome: BulkOutcome,
  describeError: (error: unknown) => string,
): string {
  const total = outcome.done.length + outcome.failed.length;
  const noun = total === 1 ? "thread" : "threads";
  const first = outcome.failed[0];
  if (first === undefined) return `${verb} ${total === 1 ? "thread" : `${total} ${noun}`}`;
  if (total === 1) return `${verb} failed: ${describeError(first.error)}`;
  return `${verb} ${outcome.done.length} of ${total} ${noun}: ${describeError(first.error)}`;
}
