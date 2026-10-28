// @effect-diagnostics nodeBuiltinImport:off -- Drives real tr3x and T3 server processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readDaemonState } from "./daemon/daemonState.ts";
import { isProcessAlive } from "./daemon/health.ts";
import { resolveServerCommand } from "./daemon/serverLauncher.ts";
import { resolveTr3xPaths } from "./paths.ts";
import { type BunProcess, CLI, spawnBun, STARTED, waitForLine } from "./testing/bunProcess.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function tempHome(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-cli-"));
  cleanup.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return NodePath.join(dir, "home");
}

function startCli(home: string, command: "daemon" | "doctor"): BunProcess {
  return spawnBun([CLI, command], { TR3X_HOME: home }, (step) => cleanup.push(step));
}

/** A server pid that the daemon under test started; killed after the test if it outlives it. */
function trackServer(pid: number): number {
  cleanup.push(() => {
    if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  });
  return pid;
}

/** Revokes every session in the base dir through upstream's control plane, as expiry would. */
function revokeAllSessions(home: string): number {
  const { command, args, cwd } = resolveServerCommand({ TR3X_NODE_BIN: process.execPath });
  const run = (...rest: string[]) =>
    NodeChildProcess.execFileSync(command, [...args, "auth", "session", ...rest], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const sessions: Array<{ sessionId: string }> = JSON.parse(
    run("list", "--base-dir", home, "--json"),
  );
  for (const { sessionId } of sessions) run("revoke", "--base-dir", home, sessionId);
  return sessions.length;
}

function argvOf(pids: ReadonlyArray<number>): string {
  return NodeChildProcess.execFileSync("ps", ["-ww", "-o", "args=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
}

/** Pids of T3 servers running with `home` as their base dir. */
function serverPidsFor(home: string): number[] {
  return NodeChildProcess.execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(`--base-dir ${home} `) && line.includes("--mode desktop"))
    .map((line) => Number.parseInt(line, 10));
}

describe("tr3x daemon", () => {
  it("starts one server, lets a second daemon attach, and stops only the server it started", async () => {
    const home = tempHome();
    const paths = resolveTr3xPaths({ TR3X_HOME: home });
    const first = startCli(home, "daemon");
    const started = await waitForLine(first, STARTED);
    const firstServer = trackServer(Number(started[1]));
    expect(Number(started[2])).toBe(first.child.pid);

    const state = readDaemonState(paths.daemonStatePath)!;
    expect(state.pid).toBe(first.child.pid);
    expect(NodeFS.statSync(paths.daemonDir).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(paths.daemonStatePath).mode & 0o777).toBe(0o600);

    const second = startCli(home, "daemon");
    await waitForLine(second, new RegExp(`attached to daemon ${first.child.pid}: T3 server`, "u"));

    const doctor = startCli(home, "doctor");
    await doctor.exited;
    expect(doctor.output()).toMatch(
      new RegExp(
        `ok\\s+daemon\\s+running \\(pid ${first.child.pid}, server pid ${firstServer}\\)`,
        "u",
      ),
    );
    expect(doctor.output()).toMatch(/ok\s+server\s+T3 \S+, orchestration protocol 2/u);
    const providersReadable = /(ok|fail)\s+providers\s+(\d+|none) of \d+ usable/u;
    expect(doctor.output()).toMatch(providersReadable);

    // Discovery holds no bearer, and secrets stay out of argv.
    expect(NodeFS.readFileSync(paths.daemonStatePath, "utf8")).not.toMatch(/token|bearer/iu);
    const argv = argvOf([first.child.pid!, second.child.pid!, firstServer]);
    expect(argv).toContain("--bootstrap-fd 0");
    expect(argv).not.toContain("--auth-token");

    // Every session the server knows expires or is revoked; doctor still gets in.
    expect(revokeAllSessions(home)).toBeGreaterThan(0);
    const afterRevoke = startCli(home, "doctor");
    await afterRevoke.exited;
    expect(afterRevoke.output()).toMatch(providersReadable);

    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    expect(isProcessAlive(firstServer)).toBe(false);
    expect(second.output()).not.toContain("stopping server");

    await waitForLine(second, /taking over/u);
    const takenOver = await waitForLine(second, STARTED);
    trackServer(Number(takenOver[1]));
    second.child.kill("SIGINT");
    expect(await second.exited).toBe(0);
    expect(isProcessAlive(Number(takenOver[1]))).toBe(false);
    expect(NodeFS.existsSync(paths.daemonStatePath)).toBe(false);
  });

  it("gives the server to exactly one of two daemons started together", async () => {
    const home = tempHome();
    const daemons = [startCli(home, "daemon"), startCli(home, "daemon")];
    const owner = await Promise.any(
      daemons.map(async (cli) => ({ cli, started: await waitForLine(cli, STARTED) })),
    );
    const server = trackServer(Number(owner.started[1]));
    const attached = daemons.find((cli) => cli !== owner.cli)!;
    await waitForLine(
      attached,
      new RegExp(`attached to daemon ${owner.cli.child.pid}: T3 server`, "u"),
    );
    expect(attached.output()).not.toMatch(STARTED);
    expect(serverPidsFor(home)).toEqual([server]);

    attached.child.kill("SIGTERM");
    expect(await attached.exited).toBe(0);
    owner.cli.child.kill("SIGTERM");
    expect(await owner.cli.exited).toBe(0);
    expect(serverPidsFor(home)).toEqual([]);
  });

  it("recovers after the owning daemon is killed with SIGKILL", async () => {
    const home = tempHome();
    const paths = resolveTr3xPaths({ TR3X_HOME: home });
    const crashed = startCli(home, "daemon");
    const orphan = trackServer(Number((await waitForLine(crashed, STARTED))[1]));
    crashed.child.kill("SIGKILL");
    await crashed.exited;

    const next = startCli(home, "daemon");
    const started = await waitForLine(next, STARTED);
    const server = trackServer(Number(started[1]));
    expect(server).not.toBe(orphan);
    expect(readDaemonState(paths.daemonStatePath)?.pid).toBe(next.child.pid);
    expect(JSON.parse(NodeFS.readFileSync(paths.serverRuntimeStatePath, "utf8")).pid).toBe(server);

    next.child.kill("SIGTERM");
    expect(await next.exited).toBe(0);
    expect(isProcessAlive(server)).toBe(false);
  });
});
