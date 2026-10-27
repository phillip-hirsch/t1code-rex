import { useRef, useState } from "react";

export type PaletteKey =
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "backspace" }
  | { readonly kind: "text"; readonly text: string };

export interface PaletteState {
  readonly query: string;
  /** The highlighted row, kept within the rows the query matches. */
  readonly index: number;
}

const CLOSED: PaletteState = { query: "", index: 0 };

/**
 * The command palette's query and selection. One input chunk can hold several keys, all
 * handled before React re-renders, so each key builds on the previous key's result (`live`),
 * not on the last render's.
 */
export function usePaletteNavigation() {
  const [state, setState] = useState(CLOSED);
  const live = useRef(state);
  const update = (next: PaletteState) => {
    live.current = next;
    setState(next);
  };
  return {
    query: state.query,
    index: state.index,
    reset: () => update(CLOSED),
    /** The query and selection after every key so far, for Enter to pick from. */
    live: (): PaletteState => live.current,
    /** Applies one key; `rowCount` gives how many rows a query matches. */
    press(key: PaletteKey, rowCount: (query: string) => number): void {
      const { query, index } = live.current;
      const last = Math.max(0, rowCount(query) - 1);
      const selected = Math.min(index, last);
      switch (key.kind) {
        case "up":
          return update({ query, index: Math.max(0, selected - 1) });
        case "down":
          return update({ query, index: Math.min(last, selected + 1) });
        case "backspace":
          return update({ query: query.slice(0, -1), index: 0 });
        case "text":
          return update({ query: query + key.text, index: 0 });
      }
    },
  };
}
