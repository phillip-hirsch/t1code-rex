// @effect-diagnostics nodeBuiltinImport:off -- Real files and processes, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runDoctor } from "./doctor.ts";
import { resolveTr3xPaths } from "./paths.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-doctor-"));
  dirs.push(dir);
  return dir;
}

async function doctor(env: NodeJS.ProcessEnv, rexAppBundleClis: ReadonlyArray<string> = []) {
  const lines: string[] = [];
  const code = await runDoctor({
    paths: resolveTr3xPaths(env),
    env,
    out: (line) => lines.push(line),
    rexAppBundleClis,
  });
  return { code, lines };
}

describe("tr3x doctor", () => {
  it("fails on each missing piece and finds the Rex CLI on PATH", async () => {
    const bin = tempDir();
    NodeFS.writeFileSync(NodePath.join(bin, "rex"), '#!/bin/sh\necho "rex 9.9.9"\n', {
      mode: 0o755,
    });
    const { code, lines } = await doctor({
      TR3X_HOME: NodePath.join(tempDir(), "home"),
      PATH: bin,
      REX_SESSION: "s1",
      REX_BLOCK: "b1",
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /fail\s+daemon\s+not running\. Start it with `tr3x daemon`\./u,
    );
    expect(lines.join("\n")).toMatch(/fail\s+server\s+not running/u);
    expect(lines.join("\n")).toMatch(/fail\s+providers\s+unknown: needs a running tr3x daemon/u);
    expect(lines).toContainEqual(expect.stringMatching(/ok\s+rex\s+.*\/rex \(rex 9\.9\.9\)$/u));
    expect(lines).toContainEqual(
      expect.stringMatching(/info\s+rex session\s+inside Rex \(session s1, block b1\)$/u),
    );
    expect(lines.at(-1)).toBe("3 required check(s) failed.");
  });

  it("fails when no Rex CLI is installed", async () => {
    const { code, lines } = await doctor({ TR3X_HOME: NodePath.join(tempDir(), "home"), PATH: "" });
    expect(code).toBe(1);
    expect(lines).toContainEqual(expect.stringMatching(/fail\s+rex\s+CLI not found/u));
    expect(lines).toContainEqual(expect.stringMatching(/rex session\s+not inside Rex/u));
  });

  it("refuses T3 Code's own home as TR3X_HOME", () => {
    expect(() => resolveTr3xPaths({ TR3X_HOME: "/Users/me/.t3/" }, "/Users/me")).toThrow(
      "TR3X_HOME points at T3 Code's own data",
    );
  });
});
