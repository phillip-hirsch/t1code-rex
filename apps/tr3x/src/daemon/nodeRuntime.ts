// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { findOnPath } from "../executables.ts";

/**
 * tr3x runs on Bun, but upstream's server runs on Node, as upstream runs it.
 * This finds that Node: `TR3X_NODE_BIN`, else `node` on `PATH`.
 */

export const SERVER_APP_DIR = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../server",
);

/** The server's own `engines.node`, e.g. `^22.16 || ^23.11 || >=24.10`. */
export function serverNodeRange(): string {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(SERVER_APP_DIR, "package.json"), "utf8"),
  );
  const range =
    typeof manifest === "object" && manifest !== null && "engines" in manifest
      ? (manifest.engines as { node?: unknown }).node
      : undefined;
  return typeof range === "string" ? range : ">=0";
}

export class NodeNotFoundError extends Error {
  constructor() {
    super(
      "The T3 server runs on Node, and no `node` is on PATH. Install Node, or set TR3X_NODE_BIN to a Node binary.",
    );
  }
}

/** The Node that runs the server. Throws `NodeNotFoundError` when there is none. */
export function resolveNodeBinary(env: NodeJS.ProcessEnv): string {
  const configured = env.TR3X_NODE_BIN?.trim();
  const node = configured || findOnPath("node", env);
  if (!node) throw new NodeNotFoundError();
  return node;
}

function parseVersion(text: string): ReadonlyArray<number> | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function compare(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether `version` meets a range of `^x.y` and `>=x.y` terms joined by `||`, as npm reads them. */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (actual === null) return false;
  return range.split("||").some((term) => {
    const trimmed = term.trim();
    const caret = trimmed.startsWith("^");
    const floor = parseVersion(trimmed.replace(/^(\^|>=)/u, ""));
    if (floor === null) return false;
    if (compare(actual, floor) < 0) return false;
    return !caret || actual[0] === floor[0];
  });
}

export type NodeRuntimeCheck =
  | { readonly ok: true; readonly node: string; readonly version: string }
  | { readonly ok: false; readonly detail: string };

/** Finds the server's Node and checks its version against the server's engines. */
export function checkNodeRuntime(env: NodeJS.ProcessEnv): NodeRuntimeCheck {
  let node: string;
  try {
    node = resolveNodeBinary(env);
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  const result = NodeChildProcess.spawnSync(node, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const version = result.status === 0 ? result.stdout.trim() : "";
  if (!version) {
    return {
      ok: false,
      detail: `\`${node} --version\` failed. Set TR3X_NODE_BIN to a working Node.`,
    };
  }
  const range = serverNodeRange();
  if (!satisfiesVersionRange(version, range)) {
    return {
      ok: false,
      detail: `${node} is Node ${version}; the T3 server needs ${range}. Install a newer Node, or set TR3X_NODE_BIN.`,
    };
  }
  return { ok: true, node, version };
}
