// @effect-diagnostics globalDate:off -- The view runs on Bun outside the Effect runtime.
import type { IssuedSession } from "../daemon/localSession.ts";

/**
 * A bearer minted on demand and minted again once it's within `refreshMs` of
 * expiring. Callers that find it stale at the same time share one mint.
 */
export function sessionBearer(
  mint: () => Promise<IssuedSession>,
  refreshMs: number,
  now: () => number = Date.now,
): () => Promise<string> {
  let session: Promise<IssuedSession> | null = null;
  return async () => {
    const seen = session;
    const issued = await seen?.catch(() => null);
    const stale = !issued || Date.parse(issued.expiresAt) - now() < refreshMs;
    // Another caller may have started a mint while this one waited; use it.
    if (stale && session === seen) session = mint();
    return (await session!).token;
  };
}
