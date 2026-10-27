/**
 * Upstream web's composer typing guard (apps/web/.../composerTypingGuard.ts), ported: a
 * request that arrives while you're typing in the focused composer is held out of view
 * until you pause, send or leave the composer. So a message typed before it appeared can't
 * be read as an answer to it, and the send that ends the typing doesn't decline it.
 */
export const REQUEST_HOLD_IDLE_MS = 1500;

export interface RequestHoldState {
  readonly seen: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
  readonly focused: boolean;
  readonly lastTypedAt: number;
}

export type RequestHoldEvent =
  | { readonly type: "requests"; readonly requestIds: ReadonlyArray<string>; readonly now: number }
  | { readonly type: "type"; readonly now: number }
  | { readonly type: "focus" | "blur" | "send" | "idle" };

export const INITIAL_REQUEST_HOLD: RequestHoldState = {
  seen: new Set(),
  held: new Set(),
  focused: false,
  lastTypedAt: Number.NEGATIVE_INFINITY,
};

export function updateRequestHold(
  state: RequestHoldState,
  event: RequestHoldEvent,
): RequestHoldState {
  switch (event.type) {
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      for (const id of event.requestIds) {
        if (
          !seen.has(id) &&
          state.focused &&
          event.now - state.lastTypedAt < REQUEST_HOLD_IDLE_MS
        ) {
          held.add(id);
        }
        seen.add(id);
      }
      return { ...state, seen, held };
    }
    case "type":
      return { ...state, lastTypedAt: event.now };
    case "focus":
      return state.focused ? state : { ...state, focused: true };
    case "blur":
    case "send":
    case "idle":
      if (state.held.size === 0 && state.lastTypedAt === Number.NEGATIVE_INFINITY) {
        return event.type === "blur" && state.focused ? { ...state, focused: false } : state;
      }
      return {
        ...state,
        held: new Set(),
        lastTypedAt: Number.NEGATIVE_INFINITY,
        focused: event.type === "blur" ? false : state.focused,
      };
  }
}

/** When the held requests show if no more typing comes; null with nothing held. */
export function requestHoldReleaseAt(state: RequestHoldState): number | null {
  return state.held.size === 0 ? null : state.lastTypedAt + REQUEST_HOLD_IDLE_MS;
}
