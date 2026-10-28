// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeFS from "node:fs";

import { satisfiesVersionRange } from "./daemon/nodeRuntime.ts";

/** tr3x's own `engines.bun`, e.g. `>=1.3.14`. */
export function tr3xBunRange(): string {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const range =
    typeof manifest === "object" && manifest !== null && "engines" in manifest
      ? (manifest.engines as { bun?: unknown }).bun
      : undefined;
  return typeof range === "string" ? range : ">=0";
}

export type BunRuntimeCheck =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Whether a Bun is new enough for tr3x. Pass `process.versions.bun`, which is
 * undefined outside Bun, e.g. under Vitest on Node.
 */
export function checkBunRuntime(version: string | undefined): BunRuntimeCheck {
  const range = tr3xBunRange();
  if (version === undefined) {
    return { ok: false, detail: `tr3x runs on Bun ${range}, and this process isn't Bun.` };
  }
  return satisfiesVersionRange(version, range)
    ? { ok: true, version }
    : { ok: false, detail: `This is Bun ${version}; tr3x needs Bun ${range}. Upgrade Bun.` };
}
