#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Dev launcher for the Bun TUI; it runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { currentTuiHost, resolveTuiPaths } from "../src/config.ts";
import { type ManagedServer, startManagedServer } from "../src/serverLauncher.ts";

/**
 * Starts one T3 Code server on tr3x's data directory and runs the TUI under
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
    Object.entries(env).filter(([key]) => !key.startsWith("TR3X_") && !key.startsWith("T3CODE_")),
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

let shuttingDown = false;
let server: ManagedServer | null = null;
let tui: NodeChildProcess.ChildProcess | null = null;

function terminateChild(
  child: NodeChildProcess.ChildProcess | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill(signal);
}

// Safe to call before the server or TUI exist, e.g. when the data dir is owned (exit 78).
function shutdown(signal?: NodeJS.Signals, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateChild(tui, signal);
  server?.stop();
  process.exitCode = exitCode;
  setTimeout(() => {
    terminateChild(tui, "SIGKILL");
    terminateChild(server?.process, "SIGKILL");
    process.exit(process.exitCode ?? exitCode);
  }, 1_500).unref();
}

const configuredPort = process.env.TR3X_PORT?.trim();
const managed = await startManagedServer({
  baseDir: paths.homeDir,
  cwd: process.cwd(),
  ...(process.env.TR3X_HOST?.trim() ? { host: process.env.TR3X_HOST.trim() } : {}),
  ...(configuredPort ? { port: Number(configuredPort) } : {}),
  onLog: log,
  onFatal: (message) => {
    process.stderr.write(`${message}\n`);
    shutdown(undefined, 1);
  },
}).catch((error: unknown): Promise<never> => {
  // onFatal has already reported a state-dir conflict; report anything else once.
  if (!shuttingDown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  shutdown(undefined, 1);
  return new Promise<never>(() => {});
});
server = managed;
const bearerToken = await managed.getBearerToken();
process.stderr.write(
  `tr3x dev server ${managed.environment.serverVersion} at ${managed.httpBaseUrl} (logs: ${paths.logPath})\n`,
);

tui = NodeChildProcess.spawn("bun", ["--silent", "--watch", "run", TUI_ENTRY], {
  cwd: REPO_ROOT,
  env: {
    ...stripReservedLaunchEnv(process.env),
    TR3X_HOME: paths.homeDir,
    TR3X_CONFIG_HOME: paths.configHomeDir,
    TR3X_STATE_HOME: paths.stateHomeDir,
    TR3X_HOST: managed.host,
    TR3X_PORT: String(managed.port),
    TR3X_AUTH_TOKEN: bearerToken,
    TR3X_TUI_ATTACH_ONLY: "1",
  },
  stdio: "inherit",
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

tui.once("exit", (code, signal) => {
  log("tui.exit", { code: code ?? null, signal: signal ?? null });
  shutdown(signal ?? undefined, code ?? 0);
});

process.once("exit", () => {
  logStream.end();
});
