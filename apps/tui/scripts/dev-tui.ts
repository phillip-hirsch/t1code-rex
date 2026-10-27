#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Dev launcher for the Bun TUI; it runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { currentTuiHost, resolveTuiPaths } from "../src/config.ts";
import { startManagedServer } from "../src/serverLauncher.ts";

/**
 * Starts one T3 Code server on T1Code's data directory and runs the TUI under
 * `bun --watch`, attached to it, so TUI restarts keep the server and its state.
 */

const SCRIPT_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(SCRIPT_DIR, "../../..");
const TUI_ENTRY = NodePath.join(REPO_ROOT, "apps/tui/src/index.tsx");

function ensureDependenciesInstalled(repoRoot: string) {
  if (NodeFS.existsSync(NodePath.join(repoRoot, "node_modules"))) return;
  throw new Error(`Dependencies are not installed. Run \`vp i\` in ${repoRoot} first.`);
}

function stripReservedLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("T1CODE_") && !key.startsWith("T3CODE_")),
  );
}

ensureDependenciesInstalled(REPO_ROOT);

const paths = resolveTuiPaths(process.env, currentTuiHost());
await NodeFS.promises.mkdir(paths.stateHomeDir, { recursive: true });
const logStream = NodeFS.createWriteStream(paths.logPath, { flags: "a" });
const log = (event: string, details?: Record<string, unknown>) => {
  logStream.write(
    `${new Date().toISOString()} dev-tui.${event}${details ? ` ${JSON.stringify(details)}` : ""}\n`,
  );
};

const configuredPort = process.env.T1CODE_PORT?.trim();
const server = await startManagedServer({
  baseDir: paths.homeDir,
  cwd: process.cwd(),
  ...(process.env.T1CODE_HOST?.trim() ? { host: process.env.T1CODE_HOST.trim() } : {}),
  ...(configuredPort ? { port: Number(configuredPort) } : {}),
  onLog: log,
  onFatal: (message) => {
    process.stderr.write(`${message}\n`);
    shutdown(undefined, 1);
  },
});
const bearerToken = await server.getBearerToken();
process.stderr.write(
  `T1Code dev server ${server.environment.serverVersion} at ${server.httpBaseUrl} (logs: ${paths.logPath})\n`,
);

const tui = NodeChildProcess.spawn("bun", ["--silent", "--watch", "run", TUI_ENTRY], {
  cwd: REPO_ROOT,
  env: {
    ...stripReservedLaunchEnv(process.env),
    T1CODE_HOME: paths.homeDir,
    T1CODE_CONFIG_HOME: paths.configHomeDir,
    T1CODE_STATE_HOME: paths.stateHomeDir,
    T1CODE_HOST: server.host,
    T1CODE_PORT: String(server.port),
    T1CODE_AUTH_TOKEN: bearerToken,
    T1CODE_TUI_ATTACH_ONLY: "1",
  },
  stdio: "inherit",
});

let shuttingDown = false;

function terminateChild(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.killed) return;
  child.kill(signal);
}

function shutdown(signal?: NodeJS.Signals, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateChild(tui, signal);
  server.stop();
  process.exitCode = exitCode;
  setTimeout(() => {
    terminateChild(tui, "SIGKILL");
    terminateChild(server.process, "SIGKILL");
    process.exit(process.exitCode ?? exitCode);
  }, 1_500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

tui.once("exit", (code, signal) => {
  log("tui.exit", { code: code ?? null, signal: signal ?? null });
  shutdown(signal ?? undefined, code ?? 0);
});

process.once("exit", () => {
  logStream.end();
});
