// @effect-diagnostics nodeBuiltinImport:off -- Real files and processes, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { currentProcessStartedAt, writeDaemonState } from "./daemon/daemonState.ts";
import { runDoctor, summarizeProviders } from "./doctor.ts";
import { resolveTr3xPaths } from "./paths.ts";
import { provider } from "./testing/serverProvider.ts";

const dirs: string[] = [];
const servers: NodeHttp.Server[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

function tempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-doctor-"));
  dirs.push(dir);
  return dir;
}

async function doctor(
  env: NodeJS.ProcessEnv,
  rexAppBundleClis: ReadonlyArray<string> = [],
  bun: { readonly version: string | undefined } = { version: "1.4.4" },
) {
  const lines: string[] = [];
  const code = await runDoctor({
    paths: resolveTr3xPaths(env),
    env,
    out: (line) => lines.push(line),
    rexAppBundleClis,
    bunVersion: bun.version,
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
    expect(lines).toContainEqual(
      expect.stringMatching(
        /fail\s+node\s+The T3 server runs on Node, and no `node` is on PATH\./u,
      ),
    );
    expect(lines.join("\n")).toMatch(
      /fail\s+daemon\s+not running\. Start it with `tr3x daemon`\./u,
    );
    expect(lines.join("\n")).toMatch(/fail\s+server\s+not running/u);
    expect(lines.join("\n")).toMatch(/fail\s+providers\s+unknown: needs a running tr3x daemon/u);
    expect(lines).toContainEqual(expect.stringMatching(/ok\s+rex\s+.*\/rex \(rex 9\.9\.9\)$/u));
    expect(lines).toContainEqual(
      expect.stringMatching(/info\s+rex session\s+inside Rex \(session s1, block b1\)$/u),
    );
    expect(lines.at(-1)).toBe("4 required check(s) failed.");
  });

  it("fails when no Rex CLI is installed", async () => {
    const { code, lines } = await doctor({ TR3X_HOME: NodePath.join(tempDir(), "home"), PATH: "" });
    expect(code).toBe(1);
    expect(lines).toContainEqual(expect.stringMatching(/fail\s+rex\s+CLI not found/u));
    expect(lines).toContainEqual(expect.stringMatching(/rex session\s+not inside Rex/u));
  });

  it("refuses a daemon state file other users can read", async () => {
    const home = NodePath.join(tempDir(), "home");
    const paths = resolveTr3xPaths({ TR3X_HOME: home });
    NodeFS.mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(paths.daemonStatePath, "{}", { mode: 0o644 });
    NodeFS.chmodSync(paths.daemonStatePath, 0o644);
    const { code, lines } = await doctor({ TR3X_HOME: home, PATH: "" });
    expect(code).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /fail\s+daemon\s+refusing its state file: .*daemon\.json is accessible to other users \(mode 644\)/u,
      ),
    );
  });

  it("fails on a Node too old for the server, and passes on the one running these tests", async () => {
    const bin = tempDir();
    const oldNode = NodePath.join(bin, "node");
    NodeFS.writeFileSync(oldNode, '#!/bin/sh\necho "v20.11.0"\n', { mode: 0o755 });
    const old = await doctor({ TR3X_HOME: NodePath.join(tempDir(), "home"), PATH: bin });
    expect(old.lines).toContainEqual(
      expect.stringMatching(/fail\s+node\s+.*\/node is Node v20\.11\.0; the T3 server needs \^22/u),
    );
    const current = await doctor({
      TR3X_HOME: NodePath.join(tempDir(), "home"),
      PATH: "",
      TR3X_NODE_BIN: process.execPath,
    });
    expect(current.lines).toContainEqual(
      expect.stringMatching(/ok\s+node\s+\S+ \(v\d+\.\d+\.\d+\) runs the T3 server$/u),
    );
  });

  it("reports the Bun running tr3x, and fails one older than engines.bun or none", async () => {
    const home = () => NodePath.join(tempDir(), "home");
    const current = await doctor({ TR3X_HOME: home(), PATH: "" }, [], { version: "1.4.4" });
    expect(current.lines).toContainEqual(
      expect.stringMatching(/ok\s+bun\s+Bun 1\.4\.4 runs tr3x$/u),
    );
    const old = await doctor({ TR3X_HOME: home(), PATH: "" }, [], { version: "1.3.9" });
    expect(old.lines).toContainEqual(
      expect.stringMatching(
        /fail\s+bun\s+This is Bun 1\.3\.9; tr3x needs Bun >=1\.3\.14\. Upgrade Bun\.$/u,
      ),
    );
    const none = await doctor({ TR3X_HOME: home(), PATH: "" }, [], { version: undefined });
    expect(none.lines).toContainEqual(
      expect.stringMatching(
        /fail\s+bun\s+tr3x runs on Bun >=1\.3\.14, and this process isn't Bun\.$/u,
      ),
    );
  });

  it("fails when `rex version` exits non-zero", async () => {
    const bin = tempDir();
    NodeFS.writeFileSync(NodePath.join(bin, "rex"), '#!/bin/sh\necho "rex 9.9.9"\nexit 3\n', {
      mode: 0o755,
    });
    const { lines } = await doctor({ TR3X_HOME: NodePath.join(tempDir(), "home"), PATH: bin });
    expect(lines).toContainEqual(
      expect.stringMatching(/fail\s+rex\s+`.*\/rex version` failed \(exit code 3\)$/u),
    );
  });

  it("sends no credential when the recorded URL answers as another environment", async () => {
    const authorizations: Array<string | undefined> = [];
    const server = NodeHttp.createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          environmentId: "env-other",
          label: "Other",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.1.3",
          orchestrationProtocolVersion: 2,
          capabilities: { repositoryIdentity: false },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const home = NodePath.join(tempDir(), "home");
    writeDaemonState(resolveTr3xPaths({ TR3X_HOME: home }).daemonStatePath, {
      version: 1,
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
      serverPid: null,
      httpBaseUrl: `http://127.0.0.1:${port}`,
      wsBaseUrl: `ws://127.0.0.1:${port}`,
      environmentId: "env-recorded",
    });

    const { code, lines } = await doctor({ TR3X_HOME: home, PATH: "" });
    expect(code).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /fail\s+daemon\s+running \(pid \d+\), but its state is stale: the server at \S+ is environment env-other, not the recorded env-recorded$/u,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/fail\s+providers\s+skipped: the daemon's state is stale$/u),
    );
    expect(authorizations).toEqual([undefined]);
  });
});

describe("summarizeProviders", () => {
  it("counts a provider as usable only when it is signed in, as upstream web does", () => {
    const signedOut = provider("pi", {
      status: "warning",
      auth: { status: "unauthenticated" },
    });
    expect(summarizeProviders([signedOut])).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/^none of 1 usable/u),
      lines: [
        expect.stringMatching(/^pi\s+installed\s+enabled\s+warning\s+0 models\s+not signed in$/u),
      ],
    });

    const check = summarizeProviders([
      signedOut,
      provider("codex", { auth: { status: "unknown" } }),
      provider("claude", { status: "error" }),
    ]);
    expect(check).toMatchObject({ status: "ok", detail: "1 of 3 usable" });
    expect(check.lines?.[1]).not.toContain("not signed in");
  });
});
