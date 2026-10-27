import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Builds upstream's server with Vite+ and stages its `dist` next to the TUI
 * bundle as `dist/server`, plus the native packages the server loads from
 * disk at runtime. The TUI launcher runs `dist/server/bin.mjs` with Node.
 */

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const tuiRoot = NodePath.resolve(scriptDir, "..");
const repoRoot = NodePath.resolve(tuiRoot, "../..");
const serverRoot = NodePath.resolve(repoRoot, "apps/server");
const serverDistSource = NodePath.resolve(serverRoot, "dist");
const serverDistTarget = NodePath.resolve(tuiRoot, "dist/server");
const serverRequire = NodeModule.createRequire(NodePath.join(serverRoot, "package.json"));
// Kept in step with CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts.
const runtimeExternalPackages = ["node-pty"];
const runtimeEntries = ["LICENSE", "README.md", "package.json", "lib", "prebuilds", "typings"];

async function exists(targetPath) {
  try {
    await NodeFSP.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed in ${cwd} (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
        ),
      );
    });
    child.once("error", reject);
  });
}

function resolvePackageDir(name) {
  return NodePath.dirname(serverRequire.resolve(`${name}/package.json`));
}

await run("vp", ["run", "build"], serverRoot);
if (!(await exists(NodePath.join(serverDistSource, "bin.mjs")))) {
  throw new Error(`Server build did not produce ${serverDistSource}/bin.mjs.`);
}
await NodeFSP.rm(serverDistTarget, { recursive: true, force: true });
await NodeFSP.mkdir(NodePath.dirname(serverDistTarget), { recursive: true });
await NodeFSP.cp(serverDistSource, serverDistTarget, { recursive: true });

for (const name of runtimeExternalPackages) {
  const source = resolvePackageDir(name);
  const target = NodePath.resolve(serverDistTarget, "node_modules", name);
  await NodeFSP.rm(target, { recursive: true, force: true });
  await NodeFSP.mkdir(target, { recursive: true });
  for (const entry of runtimeEntries) {
    const entrySource = NodePath.resolve(source, entry);
    if (await exists(entrySource)) {
      await NodeFSP.cp(entrySource, NodePath.resolve(target, entry), { recursive: true });
    }
  }
}
