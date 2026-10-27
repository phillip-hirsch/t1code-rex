// @effect-diagnostics globalTimers:off globalDate:off -- The TUI runs on Bun outside the Effect runtime.
import { useSyncExternalStore } from "react";

/**
 * A shared interval that runs only while something reads it, so a pulsing status dot or a
 * relative time re-renders just itself, and an idle sidebar runs no timers.
 */
export interface TickerSnapshot {
  /** Ticks since the ticker was made. */
  readonly tick: number;
  /** Wall time of the latest tick, or of the first subscription. */
  readonly nowMs: number;
}

export interface Ticker {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TickerSnapshot;
}

export interface TickerClock {
  readonly now: () => number;
  readonly start: (onTick: () => void, intervalMs: number) => () => void;
}

const systemClock: TickerClock = {
  now: () => Date.now(),
  start: (onTick, intervalMs) => {
    const timer = setInterval(onTick, intervalMs);
    return () => clearInterval(timer);
  },
};

export function createTicker(intervalMs: number, clock: TickerClock = systemClock): Ticker {
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  let snapshot: TickerSnapshot = { tick: 0, nowMs: clock.now() };
  const advance = () => {
    snapshot = { tick: snapshot.tick + 1, nowMs: clock.now() };
    for (const notify of listeners) notify();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (stop === null) {
        // The clock may have been idle for a while; start from the current time.
        snapshot = { tick: snapshot.tick, nowMs: clock.now() };
        stop = clock.start(advance, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop !== null) {
          stop();
          stop = null;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}

export function useTicker(ticker: Ticker): TickerSnapshot {
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
}

export const PULSE_TICKER = createTicker(260);
export const RELATIVE_TIME_TICKER = createTicker(30_000);

const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The spinner frame for a pulse tick. */
export function workingFrame(tick: number): string {
  return WORKING_FRAMES[tick % WORKING_FRAMES.length] ?? "⠋";
}
