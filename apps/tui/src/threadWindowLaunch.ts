import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TuiPaths } from "./config";

/**
 * A thread window is a second T1Code instance, opened in its own Rex tab,
 * that attaches to the server of the window that opened it and starts on one
 * thread. Launch details travel in a one-shot file (mode 0600) so the server
 * auth token never appears in process arguments.
 */

export const THREAD_WINDOW_LAUNCH_ENV = "T1CODE_THREAD_WINDOW_FILE";

export interface ThreadWindowServer {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
}

export interface ThreadWindowLaunch {
  readonly server: ThreadWindowServer;
  readonly projectId: string;
  readonly threadId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseThreadWindowLaunch(raw: string): ThreadWindowLaunch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { server, projectId, threadId } = parsed as Record<string, unknown>;
  if (typeof server !== "object" || server === null) return null;
  const { host, port, authToken } = server as Record<string, unknown>;
  if (
    !isNonEmptyString(host) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    !isNonEmptyString(authToken) ||
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(threadId)
  ) {
    return null;
  }
  return { server: { host, port, authToken }, projectId, threadId };
}

export async function writeThreadWindowLaunch(
  directory: string,
  launch: ThreadWindowLaunch,
): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `thread-window-${randomBytes(8).toString("hex")}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(launch), { mode: 0o600, flag: "wx" });
  return filePath;
}

/** How long an unread launch file may stay on disk before the opener deletes it. */
export const THREAD_WINDOW_LAUNCH_TTL_MS = 60_000;

/** Deletes the launch file later in case the thread window never read it. */
export function expireThreadWindowLaunch(
  filePath: string,
  ttlMs: number = THREAD_WINDOW_LAUNCH_TTL_MS,
): void {
  setTimeout(() => {
    void fs.promises.rm(filePath, { force: true });
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
    raw = fs.readFileSync(filePath, "utf8");
  } catch {}
  fs.rmSync(filePath, { force: true });
  const launch = raw === null ? null : parseThreadWindowLaunch(raw);
  if (!launch) {
    throw new Error(
      "This thread tab's launch details are missing or expired. Open the thread again from the main T1Code window.",
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
  "T1CODE_REX_BIN",
  "T1CODE_USE_KITTY_KEYBOARD",
  "T1CODE_USE_ALTERNATE_SCREEN",
  "T1CODE_USE_MOUSE",
  "T1CODE_ENABLE_MOUSE_MOVEMENT",
] as const;

/**
 * The command that starts this same T1Code build with a launch file. The
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
    `T1CODE_HOME=${paths.homeDir}`,
    `T1CODE_CONFIG_HOME=${paths.configHomeDir}`,
    `T1CODE_STATE_HOME=${paths.stateHomeDir}`,
    ...forwarded,
    `${THREAD_WINDOW_LAUNCH_ENV}=${launchFilePath}`,
    runtime.execPath,
    ...(runtime.entryPath ? [runtime.entryPath] : []),
  ];
}
