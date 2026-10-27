import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { act, createElement, useEffect } from "react";
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
  const latest: { value?: T; commits: number } = { commits: 0 };
  function Probe(props: { readonly onCommit: (value: T) => void }) {
    const value = useHook();
    const { onCommit } = props;
    useEffect(() => onCommit(value));
    return null;
  }
  const onCommit = (value: T) => {
    latest.value = value;
    latest.commits += 1;
  };
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(Probe, { onCommit }),
      ),
    );
  });
  return {
    get current(): T {
      if (!("value" in latest)) throw new Error("hook never rendered");
      return latest.value as T;
    },
    /** Committed renders so far; a settled hook adds none on an empty update. */
    get commits(): number {
      return latest.commits;
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
