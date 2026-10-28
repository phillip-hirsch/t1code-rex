// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isExecutableFile(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `name` in the first `PATH` directory that has it as an executable file. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return (env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter(Boolean)
    .map((dir) => NodePath.join(dir, name))
    .find(isExecutableFile);
}
