// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createClipboardImageFileName, saveClipboardImageToFile } from "./clipboardImage.ts";

type SpawnEventHandler = (...args: unknown[]) => void;

function createSpawnStub(steps: ReadonlyArray<{ stdout?: string | Buffer; code?: number }>) {
  let index = 0;
  return ((command: string, args: string[]) => {
    const step = steps[index];
    index += 1;
    if (!step) {
      throw new Error(`Unexpected clipboard helper invocation: ${command} ${args.join(" ")}`);
    }

    const childHandlers = new Map<string, SpawnEventHandler[]>();
    const stdoutHandlers = new Map<string, SpawnEventHandler[]>();
    const stderrHandlers = new Map<string, SpawnEventHandler[]>();

    queueMicrotask(() => {
      if (step.stdout !== undefined) {
        for (const handler of stdoutHandlers.get("data") ?? []) {
          handler(step.stdout);
        }
      }
      for (const handler of childHandlers.get("close") ?? []) {
        handler(step.code ?? 0);
      }
    });

    return {
      on(event: string, handler: SpawnEventHandler) {
        childHandlers.set(event, [...(childHandlers.get(event) ?? []), handler]);
        return this;
      },
      stdout: {
        on(event: string, handler: SpawnEventHandler) {
          stdoutHandlers.set(event, [...(stdoutHandlers.get(event) ?? []), handler]);
          return this;
        },
      },
      stderr: {
        on(event: string, handler: SpawnEventHandler) {
          stderrHandlers.set(event, [...(stderrHandlers.get(event) ?? []), handler]);
          return this;
        },
      },
    };
  }) as never;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("createClipboardImageFileName", () => {
  it("uses a short random id", () => {
    expect(createClipboardImageFileName("abc12")).toBe("abc12.png");
  });

  it("supports non-png extensions", () => {
    expect(createClipboardImageFileName("abc12", ".jpg")).toBe("abc12.jpg");
  });
});

describe("saveClipboardImageToFile", () => {
  it("returns null outside supported platforms", async () => {
    await expect(
      saveClipboardImageToFile("/tmp/ignored", {
        platform: "freebsd",
      }),
    ).resolves.toBeNull();
  });

  it("reads clipboard images from wl-paste on Linux", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t1code-clipboard-"));
    tempRoots.push(root);

    const filePath = await saveClipboardImageToFile(root, {
      platform: "linux",
      env: {
        WAYLAND_DISPLAY: "wayland-0",
      },
      spawnImpl: createSpawnStub([
        { stdout: "text/plain\nimage/png\n" },
        { stdout: Buffer.from("png-bytes") },
      ]),
    });

    expect(filePath).toMatch(/\.png$/);
    await expect(NodeFSP.readFile(filePath as string)).resolves.toEqual(Buffer.from("png-bytes"));
  });

  it("falls back to xclip and preserves the detected image type", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t1code-clipboard-"));
    tempRoots.push(root);

    const filePath = await saveClipboardImageToFile(root, {
      platform: "linux",
      env: {
        DISPLAY: ":1",
      },
      spawnImpl: createSpawnStub([
        { stdout: "TARGETS\nimage/jpeg\nUTF8_STRING\n" },
        { stdout: Buffer.from("jpeg-bytes") },
      ]),
    });

    expect(filePath).toMatch(/\.jpg$/);
    await expect(NodeFSP.readFile(filePath as string)).resolves.toEqual(Buffer.from("jpeg-bytes"));
  });
});
