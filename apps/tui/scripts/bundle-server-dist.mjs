import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

/**
 * Stages the server like upstream's CLI archive: `vp pack` with the externals in
 * scripts/lib/cli-external-packages.ts, then a production install of those
 * externals for this host. The web client is left out; the TUI never serves it.
 */

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const tuiRoot = NodePath.resolve(scriptDir, "..");
const repoRoot = NodePath.resolve(tuiRoot, "../..");
const serverRoot = NodePath.join(repoRoot, "apps/server");
const serverDistTarget = NodePath.join(tuiRoot, "dist/server");

const BUILD_PLATFORMS = { darwin: "mac", linux: "linux", win32: "win" };

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed in ${cwd} (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
        ),
      );
    });
    child.once("error", reject);
  });
}

await NodeFSP.rm(serverDistTarget, { recursive: true, force: true });
await run("vp", ["pack", "--out-dir", serverDistTarget], serverRoot);

// Node only reads source maps with --enable-source-maps, which the launcher doesn't pass.
for (const entry of await NodeFSP.readdir(serverDistTarget)) {
  if (entry.endsWith(".map")) await NodeFSP.rm(NodePath.join(serverDistTarget, entry));
}

// The platform layer lives in the root scripts package, not in the TUI's dependencies.
const scriptsRequire = NodeModule.createRequire(NodePath.join(repoRoot, "scripts/package.json"));
const NodeServices = await import(
  NodeURL.pathToFileURL(scriptsRequire.resolve("@effect/platform-node/NodeServices")).href
);
const { stageRuntimeExternals } = await import(
  NodeURL.pathToFileURL(NodePath.join(repoRoot, "scripts/build-cli-archive.ts")).href
);
const serverPackageJson = JSON.parse(
  await NodeFSP.readFile(NodePath.join(serverRoot, "package.json"), "utf8"),
);

await Effect.runPromise(
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const platform = BUILD_PLATFORMS[hostPlatform];
    if (!platform || (arch !== "arm64" && arch !== "x64")) {
      return yield* Effect.die(new Error(`Unsupported build host ${hostPlatform}-${arch}.`));
    }
    yield* stageRuntimeExternals({
      repoRoot,
      stageDir: serverDistTarget,
      platform,
      arch,
      version: serverPackageJson.version,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
