import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { vi } from "vite-plus/test";

/**
 * Renders a hook under React's test renderer, inside an atom registry, so controller tests
 * drive the real hook with real atoms. No JSX: the TUI's JSX runtime is OpenTUI, which
 * needs Bun.
 */
export function renderHook<T>(useHook: () => T, registry: AtomRegistry.AtomRegistry) {
  // React flushes act() work synchronously only when the environment opts in.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const latest: { value?: T; renders: number } = { renders: 0 };
  function Probe() {
    latest.value = useHook();
    latest.renders += 1;
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
    );
  });
  return {
    get current(): T {
      if (!("value" in latest)) throw new Error("hook never rendered");
      return latest.value as T;
    },
    get renders(): number {
      return latest.renders;
    },
    act(update: () => void): void {
      act(update);
    },
    unmount(): void {
      act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    },
  };
}
