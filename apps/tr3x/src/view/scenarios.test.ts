// @effect-diagnostics nodeBuiltinImport:off -- Runs Bun scenario processes, outside any Effect runtime.
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runBun } from "../testing/bunProcess.ts";

// OpenTUI runs on Bun and Vitest on Node, so each scenario runs in its own Bun process.
const SCENARIOS = NodeURL.fileURLToPath(new URL("./scenarios.tsx", import.meta.url));
/** Under the project's 60 s test timeout, so a stalled scenario fails here and is killed. */
const SCENARIO_TIMEOUT_MS = 45_000;

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

// Collection awaits this; past the timeout the listing is killed and collection fails.
const listing = await runBun([SCENARIOS, "--list"], SCENARIO_TIMEOUT_MS, () => {});
if (listing.code !== 0) {
  throw new Error(
    `${listing.timedOut ? "Listing the scenarios timed out" : "Could not list the scenarios"}:\n${listing.output}`,
  );
}
const names: ReadonlyArray<string> = JSON.parse(listing.output);

describe("the view in OpenTUI's renderer", () => {
  it.each(names)("%s", async (name) => {
    const run = await runBun([SCENARIOS, name], SCENARIO_TIMEOUT_MS, (step) => cleanup.push(step));
    expect(run.timedOut, `killed after ${SCENARIO_TIMEOUT_MS} ms:\n${run.output}`).toBe(false);
    expect(run.output).toContain(`ok   ${name}`);
    expect(run.code).toBe(0);
  });
});
