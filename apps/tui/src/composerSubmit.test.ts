// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveComposerSubmission, resolveImageAttachmentFromPath } from "./composerSubmit.ts";

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

describe("resolveComposerSubmission", () => {
  it("keeps local preview paths for image attachments resolved from pasted file paths", async () => {
    const { root, filePath } = await makeTempImage("clipboard-2026-03-25-120233-E549D4EE.png");

    await expect(
      resolveComposerSubmission({
        text: `${filePath}\nplease inspect this`,
        homeDir: root,
      }),
    ).resolves.toMatchObject({
      promptText: "please inspect this",
      attachments: [
        {
          type: "image",
          name: "clipboard-2026-03-25-120233-E549D4EE.png",
          mimeType: "image/png",
          localPath: filePath,
        },
      ],
    });
  });
});
