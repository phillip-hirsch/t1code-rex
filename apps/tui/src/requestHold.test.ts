import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_REQUEST_HOLD,
  REQUEST_HOLD_IDLE_MS,
  requestHoldReleaseAt,
  updateRequestHold,
  type RequestHoldEvent,
} from "./requestHold.ts";

const run = (...events: ReadonlyArray<RequestHoldEvent>) =>
  events.reduce(updateRequestHold, INITIAL_REQUEST_HOLD);

describe("updateRequestHold", () => {
  it("holds a request that arrives while you type in the focused composer", () => {
    const state = run(
      { type: "focus" },
      { type: "type", now: 1_000 },
      { type: "requests", requestIds: ["a"], now: 1_200 },
    );
    expect([...state.held]).toEqual(["a"]);
    expect(requestHoldReleaseAt(state)).toBe(1_000 + REQUEST_HOLD_IDLE_MS);
  });

  it("shows it once you pause, send, or leave the composer", () => {
    const typing = run(
      { type: "focus" },
      { type: "type", now: 1_000 },
      { type: "requests", requestIds: ["a"], now: 1_200 },
    );
    for (const type of ["idle", "send", "blur"] as const) {
      expect(updateRequestHold(typing, { type }).held.size).toBe(0);
    }
  });

  it("shows a request at once after a pause, or with the composer unfocused", () => {
    expect(
      run(
        { type: "focus" },
        { type: "type", now: 1_000 },
        { type: "requests", requestIds: ["a"], now: 1_000 + REQUEST_HOLD_IDLE_MS },
      ).held.size,
    ).toBe(0);
    expect(
      run({ type: "type", now: 1_000 }, { type: "requests", requestIds: ["a"], now: 1_100 }).held
        .size,
    ).toBe(0);
  });

  it("never holds a request again once it was in view", () => {
    const state = run(
      { type: "requests", requestIds: ["a"], now: 0 },
      { type: "focus" },
      { type: "type", now: 1_000 },
      { type: "requests", requestIds: ["a", "b"], now: 1_100 },
    );
    expect([...state.held]).toEqual(["b"]);
  });

  it("drops a held request once it resolves", () => {
    const state = run(
      { type: "focus" },
      { type: "type", now: 1_000 },
      { type: "requests", requestIds: ["a"], now: 1_100 },
      { type: "requests", requestIds: [], now: 1_200 },
    );
    expect(state.held.size).toBe(0);
  });
});
