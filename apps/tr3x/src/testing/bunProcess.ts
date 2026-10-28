// @effect-diagnostics nodeBuiltinImport:off -- Test helpers for real processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { findOnPath } from "../executables.ts";

export const CLI = NodeURL.fileURLToPath(new URL("../cli.ts", import.meta.url));
export const STARTED =
  /started T3 server \S+ \(orchestration protocol 2\) at \S+ \(server pid (\d+), daemon pid (\d+)\)/u;

export interface BunProcess {
  readonly child: NodeChildProcess.ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

/**
 * Runs `args` on Bun, as the tr3x CLI runs. Vitest runs on Node, so its Node
 * runs the T3 server. `onCleanup` gets the kill that the test's teardown runs.
 */
export function spawnBun(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  onCleanup: (step: () => void) => void,
  /** Kills the process with SIGKILL once it has run this long. */
  timeoutMs?: number,
): BunProcess {
  const bun = findOnPath("bun", process.env);
  if (bun === undefined) throw new Error("These tests run the tr3x CLI with Bun; install it.");
  const child = NodeChildProcess.spawn(bun, args, {
    env: { ...process.env, TR3X_NODE_BIN: process.execPath, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }),
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  // `close` follows the pipes' end too, so the process is reaped and its output complete.
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  onCleanup(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, output: () => output, exited };
}

export interface BunRun {
  readonly code: number | null;
  readonly output: string;
  /** The process ran past its timeout and was killed. */
  readonly timedOut: boolean;
}

/**
 * Runs `args` on Bun to completion within `timeoutMs`, killing it past that.
 * `onCleanup` gets the kill for a run the test abandons, e.g. on its own timeout.
 */
export async function runBun(
  args: ReadonlyArray<string>,
  timeoutMs: number,
  onCleanup: (step: () => void) => void,
): Promise<BunRun> {
  const run = spawnBun(args, {}, onCleanup, timeoutMs);
  const code = await run.exited;
  return { code, output: run.output(), timedOut: run.child.signalCode === "SIGKILL" };
}

/** Resolves on the first output line matching `pattern`; rejects if the process exits first. */
export function waitForLine(cli: BunProcess, pattern: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = cli.output().match(pattern);
      if (!match) return false;
      cli.child.stdout?.off("data", onData);
      resolve(match);
      return true;
    };
    const onData = () => void check();
    if (check()) return;
    cli.child.stdout?.on("data", onData);
    void cli.exited.then(() => {
      if (!check()) reject(new Error(`exited before printing ${pattern}:\n${cli.output()}`));
    });
  });
}
