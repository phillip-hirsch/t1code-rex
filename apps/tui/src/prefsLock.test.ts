// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
// prefsLock.ts needs Bun (bun:sqlite) and Vitest runs on Node, so every test here drives
// real Bun processes running prefsLockTestProbe.ts against one temp config dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const PROBE_PATH = NodeURL.fileURLToPath(new URL("./prefsLockTestProbe.ts", import.meta.url));
const BUN_ON_PATH = NodeChildProcess.spawnSync("bun", ["--version"]).error === undefined;

interface ProbeResult {
  readonly kind: string;
  readonly error?: string;
}

interface Probe {
  /** Resolves prefs access in the probe and returns what it got. */
  readonly go: () => Promise<ProbeResult>;
  readonly release: () => Promise<ProbeResult>;
  /** kill -9, resolved once the process is gone. */
  readonly kill: () => Promise<void>;
}

const tempRoots: string[] = [];
const running = new Set<NodeChildProcess.ChildProcess>();

afterEach(async () => {
  await Promise.all([...running].map(killChild));
  for (const root of tempRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function makePrefsPath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-prefs-lock-"));
  tempRoots.push(root);
  // The config dir doesn't exist yet, as on a first launch.
  return NodePath.join(root, "config", "prefs.json");
}

function killChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  return exited;
}

/** Starts a probe and resolves once it has loaded and is waiting for "go". */
async function startProbe(prefsPath: string, mode: "write" | "read"): Promise<Probe> {
  const child = NodeChildProcess.spawn("bun", [PROBE_PATH, prefsPath, mode], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  running.add(child);
  child.once("exit", () => running.delete(child));

  const pending: Array<(line: string) => void> = [];
  const buffered: string[] = [];
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      const line = buffered.shift();
      if (line !== undefined) return resolve(line);
      pending.push(resolve);
      child.once("exit", (code, signal) =>
        reject(new Error(`probe exited (${signal ?? code}) before answering`)),
      );
    });
  const ask = async (command: string): Promise<ProbeResult> => {
    child.stdin.write(`${command}\n`);
    return JSON.parse(await nextLine()) as ProbeResult;
  };

  expect(await nextLine()).toBe("ready");
  return { go: () => ask("go"), release: () => ask("release"), kill: () => killChild(child) };
}

describe.skipIf(!BUN_ON_PATH)(
  `prefs lock across Bun processes${BUN_ON_PATH ? "" : " (skipped: bun is not on PATH)"}`,
  () => {
    it("lets the first main window own prefs and keeps a second one read-only", async () => {
      const prefsPath = makePrefsPath();
      // A pid lock from an older build, naming a live process, doesn't block anyone.
      NodeFS.mkdirSync(NodePath.dirname(prefsPath), { recursive: true });
      NodeFS.writeFileSync(`${prefsPath}.lock`, `${process.pid}\n`);

      const first = await startProbe(prefsPath, "write");
      expect(await first.go()).toEqual({ kind: "owner" });
      const second = await startProbe(prefsPath, "write");
      expect(await second.go()).toEqual({ kind: "locked-out" });

      // Once the owner releases (twice, which is harmless), the next window owns prefs.
      expect(await first.release()).toEqual({ kind: "released" });
      const third = await startProbe(prefsPath, "write");
      expect(await third.go()).toEqual({ kind: "owner" });
    });

    it("frees the lock when the owner is killed", async () => {
      const prefsPath = makePrefsPath();
      const owner = await startProbe(prefsPath, "write");
      expect(await owner.go()).toEqual({ kind: "owner" });
      const lockedOut = await startProbe(prefsPath, "write");
      expect(await lockedOut.go()).toEqual({ kind: "locked-out" });

      await owner.kill();
      const next = await startProbe(prefsPath, "write");
      expect(await next.go()).toEqual({ kind: "owner" });
    });

    it("gives exactly one owner when windows start at the same instant", async () => {
      for (let round = 0; round < 20; round += 1) {
        const prefsPath = makePrefsPath();
        const probes = await Promise.all(
          Array.from({ length: 5 }, () => startProbe(prefsPath, "write")),
        );
        // Every probe has loaded before any of them asks for the lock.
        const kinds = (await Promise.all(probes.map((probe) => probe.go()))).map(
          (result) => result.kind,
        );
        expect(kinds.toSorted(), `round ${round}`).toEqual([
          "locked-out",
          "locked-out",
          "locked-out",
          "locked-out",
          "owner",
        ]);
        await Promise.all(probes.map((probe) => probe.kill()));
      }
    });

    it("never locks for a thread tab", async () => {
      const prefsPath = makePrefsPath();
      const reader = await startProbe(prefsPath, "read");
      expect(await reader.go()).toEqual({ kind: "reader" });
      expect(NodeFS.existsSync(NodePath.dirname(prefsPath))).toBe(false);
    });

    it("stays read-only, without crashing, when the lock file isn't a database", async () => {
      const prefsPath = makePrefsPath();
      NodeFS.mkdirSync(NodePath.dirname(prefsPath), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(NodePath.dirname(prefsPath), "prefs.lock.db"), "garbage");

      const probe = await startProbe(prefsPath, "write");
      expect(await probe.go()).toEqual({ kind: "locked-out", error: "file is not a database" });
    });
  },
);
