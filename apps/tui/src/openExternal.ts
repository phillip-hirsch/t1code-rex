// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
type SpawnImpl = typeof NodeChildProcess.spawn;

export interface OpenExternalDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawnImpl?: SpawnImpl;
}

export function resolveOpenExternalCommands(
  url: string,
  dependencies: OpenExternalDependencies = {},
): ReadonlyArray<readonly [string, ...string[]]> {
  const env = dependencies.env ?? process.env;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The TUI reports the host it runs on; there is no Effect runtime to inject it.
  const platform = dependencies.platform ?? process.platform;
  if (platform === "darwin") {
    return [["open", url]];
  }
  if (platform === "linux") {
    return env.WSL_DISTRO_NAME?.trim()
      ? [
          ["wslview", url],
          ["xdg-open", url],
          ["gio", "open", url],
          ["sensible-browser", url],
        ]
      : [
          ["xdg-open", url],
          ["gio", "open", url],
          ["sensible-browser", url],
        ];
  }
  if (platform === "win32") {
    return [["cmd", "/c", "start", "", url]];
  }
  return [];
}

function spawnDetachedCommand(
  command: readonly [string, ...string[]],
  spawnImpl: SpawnImpl,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command[0], command.slice(1), {
      detached: true,
      stdio: "ignore",
    }) as NodeChildProcess.ChildProcess;
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openExternalUrl(
  url: string,
  dependencies: OpenExternalDependencies = {},
): Promise<void> {
  const commands = resolveOpenExternalCommands(url, dependencies);
  if (commands.length === 0) {
    throw new Error(
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The TUI reports the host it runs on; there is no Effect runtime to inject it.
      `Opening external URLs is not supported on ${dependencies.platform ?? process.platform}.`,
    );
  }

  const spawnImpl = dependencies.spawnImpl ?? NodeChildProcess.spawn;
  let lastError: Error | null = null;
  for (const command of commands) {
    try {
      await spawnDetachedCommand(command, spawnImpl);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("No external URL opener was available.");
}
