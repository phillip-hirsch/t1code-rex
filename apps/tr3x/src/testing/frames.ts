import type { TestRendererSetup } from "@opentui/core/testing";

/**
 * Waits on what the renderer draws. Each check runs when a frame lands, or
 * when the test calls `wake` for something drawn later; a check that no frame
 * satisfies within the timeout throws with the last frame.
 */
export function frameWaiter(setup: TestRendererSetup, timeoutMs: number) {
  const waiting = new Set<() => void>();
  const wake = () => {
    // Each waiter removes itself; deleting the current entry is safe while iterating a Set.
    for (const resolve of waiting) resolve();
  };
  setup.renderer.on("frame", wake);
  const capture = (): string | null => {
    try {
      return setup.captureCharFrame();
    } catch {
      return null;
    }
  };
  const until = async (label: string, done: (frame: string) => boolean): Promise<string> => {
    const deadline = AbortSignal.timeout(timeoutMs);
    let frame = "";
    for (;;) {
      // A capture while the renderer draws fails; the frame it's drawing wakes the next try.
      const captured = capture();
      if (captured !== null) {
        frame = captured;
        if (done(frame)) return frame;
      }
      if (deadline.aborted) throw new Error(`timed out: ${label}\n${frame}`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          waiting.delete(stop);
          deadline.removeEventListener("abort", stop);
          resolve();
        };
        waiting.add(stop);
        deadline.addEventListener("abort", stop);
      });
    }
  };
  return { until, wake, dispose: () => setup.renderer.off("frame", wake) };
}
