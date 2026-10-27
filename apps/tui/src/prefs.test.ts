// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { TuiPaths } from "./config.ts";
import { readPrefs, writePrefs } from "./prefs.ts";

async function makePaths(): Promise<{ root: string; paths: TuiPaths }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tr3x-prefs-"));
  return {
    root,
    paths: {
      userHomeDir: NodePath.join(root, "user-home"),
      homeDir: NodePath.join(root, "home"),
      configHomeDir: NodePath.join(root, "config"),
      stateHomeDir: NodePath.join(root, "state"),
      prefsPath: NodePath.join(root, "config", "prefs.json"),
      logPath: NodePath.join(root, "state", "tui.log"),
      imagesDir: NodePath.join(root, "state", "images"),
    },
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("prefs", () => {
  it("persists thread read state alongside other tui prefs", async () => {
    const { root, paths } = await makePaths();
    tempRoots.push(root);

    await writePrefs(paths, {
      tuiThemeId: "terminal-match",
      selectedThreadId: "thread-1",
      locallyUnreadThreadIds: ["thread-2"],
      threadLastVisitedAtById: {
        "thread-1": "2026-03-24T12:00:00.000Z",
      },
      draftThreadsByProjectId: {
        "project-1": {
          id: "draft-thread-1",
          projectId: "project-1",
        },
      },
      composerDraftsByThreadId: {
        "thread-1": {
          text: "unsent draft",
          mentions: [
            {
              type: "path",
              path: "apps/tui/src/ui.tsx",
              kind: "file",
              parentPath: "apps/tui/src",
            },
          ],
          attachments: [
            {
              type: "image",
              name: "draft-image.png",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:image/png;base64,MTIzNA==",
              localPath: "/tmp/draft-image.png",
            },
          ],
        },
      },
      mainView: "settings",
      diffOpen: true,
    });

    await expect(readPrefs(paths)).resolves.toEqual({
      tuiThemeId: "terminal-match",
      selectedThreadId: "thread-1",
      locallyUnreadThreadIds: ["thread-2"],
      threadLastVisitedAtById: {
        "thread-1": "2026-03-24T12:00:00.000Z",
      },
      draftThreadsByProjectId: {
        "project-1": {
          id: "draft-thread-1",
          projectId: "project-1",
        },
      },
      composerDraftsByThreadId: {
        "thread-1": {
          text: "unsent draft",
          mentions: [
            {
              type: "path",
              path: "apps/tui/src/ui.tsx",
              kind: "file",
              parentPath: "apps/tui/src",
            },
          ],
          attachments: [
            {
              type: "image",
              name: "draft-image.png",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:image/png;base64,MTIzNA==",
              localPath: "/tmp/draft-image.png",
            },
          ],
        },
      },
      mainView: "settings",
      diffOpen: true,
    });
  });

  it("persists keybindings as the active main view", async () => {
    const { root, paths } = await makePaths();
    tempRoots.push(root);

    await writePrefs(paths, {
      mainView: "keybindings",
    });

    await expect(readPrefs(paths)).resolves.toEqual({
      mainView: "keybindings",
    });
  });
});
