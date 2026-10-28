import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { IssuedSession } from "../daemon/localSession.ts";
import { sessionBearer } from "./sessionBearer.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"));
const REFRESH_MS = 5 * 60_000;

/** A mint that issues `session-1`, `session-2`, … expiring `ttlMs` after NOW. */
function counter(ttlMs: number) {
  let mints = 0;
  const mint = async (): Promise<IssuedSession> => {
    mints += 1;
    return {
      sessionId: `id-${mints}`,
      token: `session-${mints}`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + ttlMs)),
    };
  };
  return { mint, mints: () => mints };
}

describe("sessionBearer", () => {
  it("shares one mint between callers that start together", async () => {
    const { mint, mints } = counter(60 * 60_000);
    const bearer = sessionBearer(mint, REFRESH_MS, () => NOW);
    expect(await Promise.all([bearer(), bearer(), bearer()])).toEqual([
      "session-1",
      "session-1",
      "session-1",
    ]);
    expect(await bearer()).toBe("session-1");
    expect(mints()).toBe(1);
  });

  it("shares one refresh between callers that find the session near expiry", async () => {
    const { mint, mints } = counter(REFRESH_MS - 1);
    const bearer = sessionBearer(mint, REFRESH_MS, () => NOW);
    expect(await bearer()).toBe("session-1");
    expect(await Promise.all([bearer(), bearer()])).toEqual(["session-2", "session-2"]);
    expect(mints()).toBe(2);
  });

  it("mints again after a failed mint", async () => {
    let fail = true;
    const { mint } = counter(60 * 60_000);
    const bearer = sessionBearer(
      () => (fail ? Promise.reject(new Error("no node")) : mint()),
      REFRESH_MS,
      () => NOW,
    );
    await expect(bearer()).rejects.toThrow("no node");
    fail = false;
    expect(await bearer()).toBe("session-1");
  });
});
