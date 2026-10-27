import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.resolve(scriptDir, "..");
const distDir = NodePath.join(packageDir, "dist");
const entryPath = NodePath.join(packageDir, "src", "index.tsx");
const outputPath = NodePath.join(distDir, "index.mjs");
const require = NodeModule.createRequire(import.meta.url);
const openTuiCoreDir = NodePath.dirname(
  require.resolve("@opentui/core/package.json", { paths: [packageDir] }),
);
const openTuiWorkerEntries = ["parser.worker.js", "parser.worker.js.map"];

await NodeFSP.rm(distDir, { force: true, recursive: true });
await NodeFSP.mkdir(distDir, { recursive: true });

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    entryPath,
    "--target",
    "bun",
    "--format",
    "esm",
    "--outdir",
    distDir,
    "--entry-naming",
    "[name].mjs",
    "--asset-naming",
    "[name]-[hash].[ext]",
  ],
  {
    cwd: packageDir,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);

if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}

const output = await NodeFSP.readFile(outputPath, "utf8");
const shebang = "#!/usr/bin/env bun\n";
const nativeSpecifier = "@opentui/core-${process.platform}-${process.arch}/index.ts";
const normalizedNativeSpecifier = "@opentui/core-${process.platform}-${process.arch}";
const normalizedOutput = output.replaceAll(nativeSpecifier, normalizedNativeSpecifier);

if (!normalizedOutput.startsWith(shebang)) {
  await NodeFSP.writeFile(outputPath, `${shebang}${normalizedOutput}`, "utf8");
} else if (normalizedOutput !== output) {
  await NodeFSP.writeFile(outputPath, normalizedOutput, "utf8");
}

for (const entry of openTuiWorkerEntries) {
  const sourcePath = NodePath.join(openTuiCoreDir, entry);
  const targetPath = NodePath.join(distDir, entry);
  try {
    await NodeFSP.copyFile(sourcePath, targetPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
