// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodePath from "node:path";
export function expandUserPath(input: string, userHomeDir: string): string {
  if (input === "~") return userHomeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return NodePath.join(userHomeDir, input.slice(2));
  }
  return input;
}

export function normalizeWorkspaceRoot(input: string, userHomeDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return NodePath.resolve(expandUserPath(trimmed, userHomeDir));
}
