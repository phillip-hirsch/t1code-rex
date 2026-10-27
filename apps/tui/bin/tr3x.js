#!/usr/bin/env bun

import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
const entryPath = NodeURL.fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

function printError(error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}

if (process.versions.bun === undefined) {
  const bunBin = process.env.TR3X_BUN_BIN?.trim() || "bun";
  const child = NodeChildProcess.spawn(bunBin, [entryPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.once("error", (error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      printError("tr3x requires Bun on your PATH to launch the TUI runtime.");
      process.exit(1);
      return;
    }
    printError(error);
    process.exit(1);
  });
} else {
  import("../dist/index.mjs").catch((error) => {
    printError(error);
    process.exit(1);
  });
}
