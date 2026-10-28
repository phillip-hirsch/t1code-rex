// @effect-diagnostics nodeBuiltinImport:off -- Real processes, outside any Effect runtime.
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isProcessAlive } from "../daemon/health.ts";
import { runBun } from "./bunProcess.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

describe("runBun", () => {
  it("kills and reaps a run that outlives its timeout", async () => {
    const run = await runBun(
      ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
      500,
      (step) => cleanup.push(step),
    );
    expect(run.timedOut).toBe(true);
    expect(run.code).toBeNull();
    expect(isProcessAlive(Number.parseInt(run.output, 10))).toBe(false);
  });

  it("returns a run that finishes in time with its output", async () => {
    const run = await runBun(["-e", "console.log('done')"], 30_000, (step) => cleanup.push(step));
    expect(run).toEqual({ code: 0, output: "done\n", timedOut: false });
  });
});
