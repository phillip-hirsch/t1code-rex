// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface Tr3xPaths {
  /** The T3 server's base dir (`--base-dir`). tr3x never shares T3 Code's `~/.t3`. */
  readonly home: string;
  /** tr3x's own files: 0700, holding the 0600 daemon state. */
  readonly daemonDir: string;
  readonly daemonStatePath: string;
  /** Written by the T3 server itself while it runs. */
  readonly serverRuntimeStatePath: string;
}

export function resolveTr3xPaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = NodeOS.homedir(),
): Tr3xPaths {
  const configured = env.TR3X_HOME?.trim();
  const home = NodePath.resolve(configured || NodePath.join(userHome, ".tr3x"));
  const t3Home = NodePath.join(userHome, ".t3");
  if (realPath(home) === realPath(t3Home)) {
    throw new Error(
      `TR3X_HOME points at T3 Code's own data (${t3Home}). tr3x keeps its server and data apart; pick another directory.`,
    );
  }
  const daemonDir = NodePath.join(home, "daemon");
  return {
    home,
    daemonDir,
    daemonStatePath: NodePath.join(daemonDir, "daemon.json"),
    serverRuntimeStatePath: NodePath.join(home, "userdata", "server-runtime.json"),
  };
}

function realPath(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}
