// @effect-diagnostics nodeBuiltinImport:off -- Drives real tr3x and T3 server processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CLI, spawnBun, STARTED, waitForLine } from "../testing/bunProcess.ts";
import { installFakeProviders } from "../testing/fakeProviders.ts";

const CHECK = NodeURL.fileURLToPath(new URL("./check.tsx", import.meta.url));
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

describe("tr3x view", () => {
  it("runs a thread across a provider switch against the real server", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-view-"));
    cleanup.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const home = NodePath.join(dir, "home");
    const workspace = NodePath.join(dir, "work");
    NodeFS.mkdirSync(workspace);
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspace });
    const { secondRequestLog } = installFakeProviders(home, "The code word is PAPAYA.");

    const daemon = spawnBun([CLI, "daemon"], { TR3X_HOME: home }, (step) => cleanup.push(step));
    await waitForLine(daemon, STARTED);
    const check = spawnBun([CHECK, home, workspace, secondRequestLog], {}, (step) =>
      cleanup.push(step),
    );
    const code = await check.exited;
    expect(check.output()).toContain("all checks passed");
    expect(code).toBe(0);

    daemon.child.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
  });
});
