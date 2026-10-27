// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
const APP_DIR_NAME = "t1code";

export interface TuiPaths {
  readonly userHomeDir: string;
  readonly homeDir: string;
  readonly configHomeDir: string;
  readonly stateHomeDir: string;
  readonly prefsPath: string;
  readonly logPath: string;
  readonly imagesDir: string;
}

function resolveAppDir(explicit: string | undefined, fallback: string): string {
  const configured = explicit?.trim();
  return configured ? NodePath.join(configured, APP_DIR_NAME) : fallback;
}

export interface TuiHost {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}

export function currentTuiHost(): TuiHost {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The TUI reports the host it runs on; there is no Effect runtime to inject it.
  return { homeDir: NodeOS.homedir(), platform: process.platform };
}

export function resolveTuiPaths(
  env: NodeJS.ProcessEnv = process.env,
  host: TuiHost = currentTuiHost(),
): TuiPaths {
  const home = host.homeDir;
  const isLinux = host.platform === "linux";
  const homeDir =
    env.T1CODE_HOME?.trim() ||
    (isLinux
      ? resolveAppDir(env.XDG_DATA_HOME, NodePath.join(home, ".local", "share", APP_DIR_NAME))
      : NodePath.join(home, ".t1"));
  const configHomeDir =
    env.T1CODE_CONFIG_HOME?.trim() ||
    resolveAppDir(env.XDG_CONFIG_HOME, NodePath.join(home, ".config", APP_DIR_NAME));
  const stateHomeDir =
    env.T1CODE_STATE_HOME?.trim() ||
    (isLinux
      ? resolveAppDir(env.XDG_STATE_HOME, NodePath.join(home, ".local", "state", APP_DIR_NAME))
      : configHomeDir);
  return {
    userHomeDir: home,
    homeDir,
    configHomeDir,
    stateHomeDir,
    prefsPath: NodePath.join(configHomeDir, "prefs.json"),
    logPath: NodePath.join(stateHomeDir, "tui.log"),
    imagesDir: NodePath.join(stateHomeDir, "images"),
  };
}
