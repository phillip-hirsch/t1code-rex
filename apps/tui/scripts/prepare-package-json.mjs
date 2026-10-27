import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.resolve(scriptDir, "..");
const packageJsonPath = NodePath.join(packageDir, "package.json");
const backupPath = NodePath.join(packageDir, ".package.json.publish.bak");

const packageJson = JSON.parse(await NodeFSP.readFile(packageJsonPath, "utf8"));

const publishedPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  private: packageJson.private,
  description: packageJson.description,
  homepage: packageJson.homepage,
  bugs: packageJson.bugs,
  license: packageJson.license,
  repository: packageJson.repository,
  bin: packageJson.bin,
  files: packageJson.files,
  type: packageJson.type,
  publishConfig: packageJson.publishConfig,
  dependencies: packageJson.dependencies,
  optionalDependencies: packageJson.optionalDependencies,
  engines: packageJson.engines,
};

await NodeFSP.copyFile(packageJsonPath, backupPath);
await NodeFSP.writeFile(
  packageJsonPath,
  `${JSON.stringify(publishedPackageJson, null, 2)}\n`,
  "utf8",
);
