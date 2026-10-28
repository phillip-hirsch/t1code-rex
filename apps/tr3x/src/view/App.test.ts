// @effect-diagnostics nodeBuiltinImport:off -- Runs Bun scenario processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { findOnPath } from "../executables.ts";

// OpenTUI runs on Bun and Vitest on Node, so each scenario runs in its own Bun process.
const SCENARIOS = NodeURL.fileURLToPath(new URL("./App.scenarios.tsx", import.meta.url));
const BUN = findOnPath("bun", process.env);
if (BUN === undefined) throw new Error("These tests run the view with Bun; install it.");
const bun = BUN;

const names: ReadonlyArray<string> = JSON.parse(
  NodeChildProcess.execFileSync(bun, [SCENARIOS, "--list"], { encoding: "utf8" }),
);

function runScenario(name: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      bun,
      [SCENARIOS, name],
      { encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: stdout + stderr,
        }),
    );
  });
}

describe("the view in OpenTUI's renderer", () => {
  it.each(names)("%s", async (name) => {
    const { code, output } = await runScenario(name);
    expect(output).toContain(`ok   ${name}`);
    expect(code).toBe(0);
  });
});
