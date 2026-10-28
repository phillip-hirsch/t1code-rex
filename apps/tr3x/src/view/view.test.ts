// @effect-diagnostics nodeBuiltinImport:off -- Drives real tr3x and T3 server processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isProcessAlive } from "../daemon/health.ts";
import { spawnBun } from "../testing/bunProcess.ts";
import { startDaemon } from "../testing/daemonFixture.ts";
import { installFakeProviders, liveFakeProviders } from "../testing/fakeProviders.ts";

const CHECK = NodeURL.fileURLToPath(new URL("./check.tsx", import.meta.url));
/** Under the project's 60 s test timeout, which `afterEach` teardown still has to fit in. */
const CHECK_TIMEOUT_MS = 30_000;

// Runs whatever happens to the test: stops the daemon and its server, reaps fake
// providers, and only then deletes the home they ran in.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function setUp() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-view-"));
  cleanup.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const home = NodePath.join(dir, "home");
  const workspace = NodePath.join(dir, "work");
  NodeFS.mkdirSync(workspace);
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspace });
  const { secondRequestLog } = installFakeProviders(home, "The code word is PAPAYA.");
  const daemon = startDaemon(home);
  cleanup.push(async () => void (await daemon.stop()));
  const check = (requestLog: string) =>
    spawnBun(
      [CHECK, home, workspace, requestLog],
      {},
      (step) => cleanup.push(step),
      CHECK_TIMEOUT_MS,
    );
  return { home, secondRequestLog, daemon, check };
}

describe("tr3x view", () => {
  it("runs a thread across a provider switch against the real server", async () => {
    const { home, secondRequestLog, daemon, check } = setUp();
    const serverPid = await daemon.started;
    const run = check(secondRequestLog);
    const code = await run.exited;
    expect(run.output()).toContain("all checks passed");
    expect(code).toBe(0);

    const stopped = await daemon.stop();
    expect(stopped.daemonCode).toBe(0);
    expect(isProcessAlive(serverPid)).toBe(false);
    expect(liveFakeProviders(home)).toEqual([]);
  });

  it("leaves nothing running when the check fails after providers started", async () => {
    const { home, daemon, check } = setUp();
    const serverPid = await daemon.started;
    // The last step reads the request log; without one, the check fails after both providers ran.
    const run = check(NodePath.join(home, "no-such-request-log"));
    expect(await run.exited).not.toBe(0);
    expect(run.output()).toContain("ok   approving lets Grok B finish");

    await daemon.stop();
    expect(isProcessAlive(serverPid)).toBe(false);
    expect(liveFakeProviders(home)).toEqual([]);
  });
});
