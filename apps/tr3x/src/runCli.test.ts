// @effect-diagnostics nodeBuiltinImport:off -- Real files, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCli } from "./runCli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

async function run(argv: ReadonlyArray<string>, bunVersion: string | undefined) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-run-"));
  dirs.push(dir);
  let out = "";
  let err = "";
  const code = await runCli(argv, {
    env: { TR3X_HOME: NodePath.join(dir, "home"), PATH: "" },
    cwd: dir,
    bunVersion,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
  });
  return { code, out, err };
}

describe("runCli on a Bun older than engines.bun", () => {
  it("stops a command before it does anything", async () => {
    const { code, out, err } = await run(["daemon"], "1.3.9");
    expect(code).toBe(1);
    expect(err).toBe("tr3x: This is Bun 1.3.9; tr3x needs Bun >=1.3.14. Upgrade Bun.\n");
    expect(out).toBe("");
  });

  it("still runs doctor, which reports it", async () => {
    const { code, out } = await run(["doctor"], "1.3.9");
    expect(code).toBe(1);
    expect(out).toMatch(
      /fail\s+bun\s+This is Bun 1\.3\.9; tr3x needs Bun >=1\.3\.14\. Upgrade Bun\./u,
    );
    expect(out).toMatch(/fail\s+daemon\s+not running/u);
  });
});
