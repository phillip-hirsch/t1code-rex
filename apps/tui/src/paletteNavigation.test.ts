import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { renderHook } from "./hookTestRenderer.ts";
import { usePaletteNavigation } from "./paletteNavigation.ts";

const ROWS = ["new thread", "new terminal tab", "split terminal", "hide terminal", "quit"];
const rowsFor = (query: string) => ROWS.filter((row) => row.includes(query));
const rowCount = (query: string) => rowsFor(query).length;

describe("usePaletteNavigation", () => {
  it("applies every key of one input chunk before React re-renders", () => {
    const hook = renderHook(() => usePaletteNavigation(), AtomRegistry.make());
    hook.act(() => {
      const nav = hook.current;
      for (let i = 0; i < 4; i += 1) nav.press({ kind: "down" }, rowCount);
      // Enter in the same chunk picks from the live selection.
      const { query, index } = nav.live();
      expect(rowsFor(query)[index]).toBe("quit");
    });
    expect(hook.current.index).toBe(4);
    hook.unmount();
  });

  it("filters by text typed in the same chunk, then stays in range", () => {
    const hook = renderHook(() => usePaletteNavigation(), AtomRegistry.make());
    hook.act(() => {
      const nav = hook.current;
      for (const text of "term") nav.press({ kind: "text", text }, rowCount);
      for (let i = 0; i < 5; i += 1) nav.press({ kind: "down" }, rowCount);
      const { query, index } = nav.live();
      expect(rowsFor(query)[index]).toBe("hide terminal");
    });
    expect(hook.current.query).toBe("term");
    hook.act(() => {
      hook.current.press({ kind: "backspace" }, rowCount);
      hook.current.press({ kind: "up" }, rowCount);
    });
    expect(hook.current).toMatchObject({ query: "ter", index: 0 });
    hook.act(() => hook.current.reset());
    expect(hook.current).toMatchObject({ query: "", index: 0 });
    hook.unmount();
  });
});
