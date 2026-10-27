import { describe, expect, it } from "vite-plus/test";

import { createTicker, type TickerClock } from "./ticker.ts";

/** A clock whose interval fires on demand, at the timer boundary only. */
function manualClock() {
  let nowMs = 1_000;
  let onTick: (() => void) | null = null;
  const clock: TickerClock = {
    now: () => nowMs,
    start: (tick) => {
      onTick = tick;
      return () => {
        onTick = null;
      };
    },
  };
  return {
    clock,
    running: () => onTick !== null,
    fire: (advanceMs: number) => {
      nowMs += advanceMs;
      onTick?.();
    },
  };
}

describe("createTicker", () => {
  it("runs its interval only while subscribed", () => {
    const manual = manualClock();
    const ticker = createTicker(260, manual.clock);
    expect(manual.running()).toBe(false);
    let calls = 0;
    const unsubscribeFirst = ticker.subscribe(() => {
      calls += 1;
    });
    const unsubscribeSecond = ticker.subscribe(() => {});
    expect(manual.running()).toBe(true);

    manual.fire(260);
    expect(calls).toBe(1);
    expect(ticker.getSnapshot()).toEqual({ tick: 1, nowMs: 1_260 });

    unsubscribeFirst();
    expect(manual.running()).toBe(true);
    unsubscribeSecond();
    expect(manual.running()).toBe(false);
  });

  it("keeps one snapshot between ticks and refreshes the time on resubscribe", () => {
    const manual = manualClock();
    const ticker = createTicker(1_000, manual.clock);
    const first = ticker.getSnapshot();
    expect(ticker.getSnapshot()).toBe(first);
    manual.fire(5_000);
    ticker.subscribe(() => {})();
    expect(ticker.getSnapshot().nowMs).toBe(6_000);
  });
});
