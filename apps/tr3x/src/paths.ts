// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Node outside the Effect runtime.
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
  const t3Homes = [NodePath.join(userHome, ".t3"), env.T3CODE_HOME?.trim()].filter(
    (dir): dir is string => Boolean(dir),
  );
  for (const t3Home of t3Homes) {
    if (overlaps(resolveReal(home), resolveReal(NodePath.resolve(expandHome(t3Home, userHome))))) {
      throw new Error(
        `TR3X_HOME (${home}) overlaps T3 Code's own data (${t3Home}). tr3x keeps its server and data apart; pick another directory.`,
      );
    }
  }
  const daemonDir = NodePath.join(home, "daemon");
  return {
    home,
    daemonDir,
    daemonStatePath: NodePath.join(daemonDir, "daemon.json"),
    serverRuntimeStatePath: NodePath.join(home, "userdata", "server-runtime.json"),
  };
}

/** Expands a leading `~`, as T3 Code does for `T3CODE_HOME`. */
function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/") || path.startsWith("~\\"))
    return NodePath.join(userHome, path.slice(2));
  return path;
}

/**
 * The real path of the nearest existing ancestor, with the rest of `path`
 * appended. The native call also returns the on-disk case, so `~/.T3` on a
 * case-insensitive volume resolves to `~/.t3`.
 */
function resolveReal(path: string): string {
  const missing: string[] = [];
  for (let dir = path; ; dir = NodePath.dirname(dir)) {
    try {
      return NodePath.join(NodeFS.realpathSync.native(dir), ...missing);
    } catch {
      if (NodePath.dirname(dir) === dir) return path;
      missing.unshift(NodePath.basename(dir));
    }
  }
}

/** Whether either directory is the other or inside it. */
function overlaps(a: string, b: string): boolean {
  const withSep = (dir: string) => (dir.endsWith(NodePath.sep) ? dir : `${dir}${NodePath.sep}`);
  return withSep(a).startsWith(withSep(b)) || withSep(b).startsWith(withSep(a));
}
