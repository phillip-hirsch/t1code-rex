// @effect-diagnostics nodeBuiltinImport:off -- Real directories, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveTr3xPaths } from "./paths.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** A temp user home that has a `.t3`, like a machine with T3 Code installed. */
function userHome(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-paths-"));
  dirs.push(dir);
  NodeFS.mkdirSync(NodePath.join(dir, ".t3", "userdata"), { recursive: true });
  return dir;
}

const REFUSED = "overlaps T3 Code's own data";

describe("resolveTr3xPaths", () => {
  it("refuses T3 Code's home, anything inside it, and anything containing it", () => {
    const home = userHome();
    for (const tr3xHome of [
      NodePath.join(home, ".t3") + NodePath.sep,
      NodePath.join(home, ".t3", "userdata"),
      NodePath.join(home, ".t3", "not", "created", "yet"),
      home,
    ]) {
      expect(() => resolveTr3xPaths({ TR3X_HOME: tr3xHome }, home)).toThrow(REFUSED);
    }
    expect(resolveTr3xPaths({ TR3X_HOME: NodePath.join(home, ".t3x") }, home).home).toBe(
      NodePath.join(home, ".t3x"),
    );
  });

  it("refuses a different case on a case-insensitive volume", () => {
    const home = userHome();
    const resolve = () => resolveTr3xPaths({ TR3X_HOME: NodePath.join(home, ".T3", "sub") }, home);
    // macOS volumes are case-insensitive by default; most Linux ones aren't.
    if (NodeFS.existsSync(NodePath.join(home, ".T3"))) expect(resolve).toThrow(REFUSED);
    else expect(resolve).not.toThrow();
  });

  it("refuses a new directory under a symlink into T3 Code's home", () => {
    const home = userHome();
    const link = NodePath.join(home, "link");
    NodeFS.symlinkSync(NodePath.join(home, ".t3"), link);
    expect(() => resolveTr3xPaths({ TR3X_HOME: NodePath.join(link, "new", "sub") }, home)).toThrow(
      REFUSED,
    );
  });

  it("refuses T3CODE_HOME and anything inside it", () => {
    const home = userHome();
    const custom = NodePath.join(home, "custom-t3");
    expect(() =>
      resolveTr3xPaths({ TR3X_HOME: NodePath.join(custom, "tr3x"), T3CODE_HOME: custom }, home),
    ).toThrow(REFUSED);
    expect(
      resolveTr3xPaths({ TR3X_HOME: NodePath.join(home, "tr3x"), T3CODE_HOME: custom }, home).home,
    ).toBe(NodePath.join(home, "tr3x"));
  });

  it("expands a leading ~ in T3CODE_HOME", () => {
    const home = userHome();
    for (const t3CodeHome of ["~/custom-t3", "~"]) {
      expect(() =>
        resolveTr3xPaths(
          { TR3X_HOME: NodePath.join(home, "custom-t3", "tr3x"), T3CODE_HOME: t3CodeHome },
          home,
        ),
      ).toThrow(REFUSED);
    }
  });
});
