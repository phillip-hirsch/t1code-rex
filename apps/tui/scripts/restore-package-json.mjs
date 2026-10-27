import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.resolve(scriptDir, "..");
const packageJsonPath = NodePath.join(packageDir, "package.json");
const backupPath = NodePath.join(packageDir, ".package.json.publish.bak");

try {
  await NodeFSP.copyFile(backupPath, packageJsonPath);
  await NodeFSP.rm(backupPath, { force: true });
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
