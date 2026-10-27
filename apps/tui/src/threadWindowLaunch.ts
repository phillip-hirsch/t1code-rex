// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { TuiPaths } from "./config.ts";

/**
 * A thread window is a second tr3x instance, opened in its own Rex tab,
 * that attaches to the server of the window that opened it and starts on one
 * thread. Launch details travel in a one-shot file (mode 0600) so the bearer
 * token never appears in process arguments.
 */

export const THREAD_WINDOW_LAUNCH_ENV = "TR3X_THREAD_WINDOW_FILE";

export interface ThreadWindowServer {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

export interface ThreadWindowLaunch {
  readonly server: ThreadWindowServer;
  readonly projectId: string;
  readonly threadId: string;
  /** "diff" opens the window on the thread's diff instead of its transcript. */
  readonly view?: "diff";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUrlWithProtocol(value: unknown, protocols: ReadonlyArray<string>): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function parseThreadWindowLaunch(raw: string): ThreadWindowLaunch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { server, projectId, threadId, view } = parsed as Record<string, unknown>;
  if (typeof server !== "object" || server === null) return null;
  const { httpBaseUrl, wsBaseUrl, bearerToken } = server as Record<string, unknown>;
  if (
    !isUrlWithProtocol(httpBaseUrl, ["http:", "https:"]) ||
    !isUrlWithProtocol(wsBaseUrl, ["ws:", "wss:"]) ||
    !isNonEmptyString(bearerToken) ||
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(threadId) ||
    (view !== undefined && view !== "diff")
  ) {
    return null;
  }
  return {
    server: { httpBaseUrl, wsBaseUrl, bearerToken },
    projectId,
    threadId,
    ...(view === "diff" ? { view } : {}),
  };
}

export async function writeThreadWindowLaunch(
  directory: string,
  launch: ThreadWindowLaunch,
): Promise<string> {
  await NodeFS.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = NodePath.join(
    directory,
    `thread-window-${NodeCrypto.randomBytes(8).toString("hex")}.json`,
  );
  await NodeFS.promises.writeFile(filePath, JSON.stringify(launch), { mode: 0o600, flag: "wx" });
  return filePath;
}

/** How long an unread launch file may stay on disk before the opener deletes it. */
export const THREAD_WINDOW_LAUNCH_TTL_MS = 60_000;

/** Deletes the launch file later in case the thread window never read it. */
export function expireThreadWindowLaunch(
  filePath: string,
  ttlMs: number = THREAD_WINDOW_LAUNCH_TTL_MS,
  schedule: (callback: () => void, ms: number) => { unref: () => unknown } = setTimeout,
): void {
  schedule(() => {
    void NodeFS.promises.rm(filePath, { force: true });
  }, ttlMs).unref();
}

/**
 * Reads and deletes the launch file named by the environment. Returns null
 * when this isn't a thread window. Throws when it is one but the file is gone
 * or invalid, so a thread window never falls back to running its own server.
 */
export function consumeThreadWindowLaunch(
  env: NodeJS.ProcessEnv = process.env,
): ThreadWindowLaunch | null {
  const filePath = env[THREAD_WINDOW_LAUNCH_ENV]?.trim();
  delete env[THREAD_WINDOW_LAUNCH_ENV];
  if (!filePath) return null;
  let raw: string | null = null;
  try {
    raw = NodeFS.readFileSync(filePath, "utf8");
  } catch {}
  NodeFS.rmSync(filePath, { force: true });
  const launch = raw === null ? null : parseThreadWindowLaunch(raw);
  if (!launch) {
    throw new Error(
      "This thread tab's launch details are missing or expired. Open the thread again from the main tr3x window.",
    );
  }
  return launch;
}

/**
 * Settings a thread window must share with the window that opened it. Rex
 * starts tabs from the login environment, so these are passed explicitly.
 * Connection and auth variables are excluded; they travel in the launch file.
 */
const FORWARDED_ENV_KEYS = [
  "TR3X_REX_BIN",
  "TR3X_USE_KITTY_KEYBOARD",
  "TR3X_USE_ALTERNATE_SCREEN",
  "TR3X_USE_MOUSE",
  "TR3X_ENABLE_MOUSE_MOVEMENT",
] as const;

/**
 * The command that starts this same tr3x build with a launch file. The
 * opener's resolved paths are passed so the thread window uses the same data
 * even when they came from variables the login environment lacks.
 */
export function buildThreadWindowCommand(
  launchFilePath: string,
  paths: Pick<TuiPaths, "homeDir" | "configHomeDir" | "stateHomeDir">,
  runtime: {
    readonly execPath: string;
    readonly entryPath: string | undefined;
    readonly env: NodeJS.ProcessEnv;
  } = {
    execPath: process.execPath,
    entryPath: process.argv[1],
    env: process.env,
  },
): string[] {
  const forwarded = FORWARDED_ENV_KEYS.flatMap((key) => {
    const value = runtime.env[key];
    return value ? [`${key}=${value}`] : [];
  });
  return [
    "env",
    `TR3X_HOME=${paths.homeDir}`,
    `TR3X_CONFIG_HOME=${paths.configHomeDir}`,
    `TR3X_STATE_HOME=${paths.stateHomeDir}`,
    ...forwarded,
    `${THREAD_WINDOW_LAUNCH_ENV}=${launchFilePath}`,
    runtime.execPath,
    ...(runtime.entryPath ? [runtime.entryPath] : []),
  ];
}
