// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { pastedImagePath, resolveImageAttachmentFromPath } from "./composerSubmit.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function makeTempImage(
  fileName: string,
  bytes = Buffer.from("png-bytes"),
): Promise<{ root: string; filePath: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tr3x-composer-submit-"));
  tempRoots.push(root);
  const filePath = NodePath.join(root, fileName);
  await NodeFSP.writeFile(filePath, bytes);
  return { root, filePath };
}

describe("resolveImageAttachmentFromPath", () => {
  it("preserves the resolved local file path for draft previews", async () => {
    const { root, filePath } = await makeTempImage("draft-preview.png");

    await expect(
      resolveImageAttachmentFromPath({
        filePath,
        homeDir: root,
      }),
    ).resolves.toMatchObject({
      type: "image",
      name: "draft-preview.png",
      mimeType: "image/png",
      localPath: filePath,
    });
  });
});

describe("pastedImagePath", () => {
  it("reads a dropped file's path, quoted or with escaped spaces", () => {
    expect(pastedImagePath("/tmp/shot.png")).toBe("/tmp/shot.png");
    expect(pastedImagePath("'/tmp/my shot.PNG'\n")).toBe("/tmp/my shot.PNG");
    expect(pastedImagePath("/tmp/my\\ shot.jpg")).toBe("/tmp/my shot.jpg");
    expect(pastedImagePath("~/Desktop/a.webp")).toBe("~/Desktop/a.webp");
  });

  it("leaves other pastes alone", () => {
    expect(pastedImagePath("look at /tmp/shot.png")).toBeNull();
    expect(pastedImagePath("/tmp/notes.txt")).toBeNull();
    expect(pastedImagePath("/tmp/a.png\n/tmp/b.png")).toBeNull();
    expect(pastedImagePath("relative/a.png")).toBeNull();
  });
});
