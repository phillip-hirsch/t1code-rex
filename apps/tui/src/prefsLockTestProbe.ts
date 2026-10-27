// @effect-diagnostics nodeBuiltinImport:off -- A Bun test fixture outside the Effect runtime.
// Run by prefsLock.test.ts under Bun: `bun prefsLockTestProbe.ts <prefsPath> <write|read>`.
// Prints "ready", resolves prefs access on a "go" line from stdin, and prints the result
// as JSON. It keeps the lock until a "release" line (which releases twice) or until it dies.
import * as NodeReadline from "node:readline";

import { resolvePrefsAccess } from "./prefsLock.ts";

const [prefsPath, mode] = process.argv.slice(2);
if (!prefsPath || (mode !== "write" && mode !== "read")) {
  throw new Error("usage: prefsLockTestProbe.ts <prefsPath> <write|read>");
}

let access: ReturnType<typeof resolvePrefsAccess> | null = null;
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line === "go" && access === null) {
    access = resolvePrefsAccess({ prefsPath, wantsWrites: mode === "write" });
    const { kind } = access;
    process.stdout.write(
      `${JSON.stringify(access.kind === "locked-out" && access.error ? { kind, error: access.error } : { kind })}\n`,
    );
  } else if (line === "release" && access?.kind === "owner") {
    access.lock.release();
    access.lock.release();
    process.stdout.write(`${JSON.stringify({ kind: "released" })}\n`);
  }
});
lines.on("close", () => process.exit(0));
process.stdout.write("ready\n");
