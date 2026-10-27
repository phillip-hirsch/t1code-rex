// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  THREAD_WINDOW_LAUNCH_ENV,
  buildThreadWindowCommand,
  consumeThreadWindowLaunch,
  expireThreadWindowLaunch,
  parseThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch.ts";

const launch = {
  server: {
    httpBaseUrl: "http://127.0.0.1:4321",
    wsBaseUrl: "ws://127.0.0.1:4321",
    bearerToken: "secret",
  },
  projectId: "project-1",
  threadId: "thread-1",
};

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t1-thread-window-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("threadWindowLaunch", () => {
  it("round-trips through a private one-shot file", async () => {
    const filePath = await writeThreadWindowLaunch(NodePath.join(makeTempDir(), "windows"), launch);
    expect(NodeFS.statSync(filePath).mode & 0o777).toBe(0o600);

    const env: NodeJS.ProcessEnv = { [THREAD_WINDOW_LAUNCH_ENV]: filePath };
    expect(consumeThreadWindowLaunch(env)).toEqual(launch);
    expect(NodeFS.existsSync(filePath)).toBe(false);
    expect(env[THREAD_WINDOW_LAUNCH_ENV]).toBeUndefined();
  });

  it("refuses to start a thread window whose launch file is gone or invalid", async () => {
    const missing = NodePath.join(makeTempDir(), "missing.json");
    expect(() => consumeThreadWindowLaunch({ [THREAD_WINDOW_LAUNCH_ENV]: missing })).toThrow(
      "missing or expired",
    );

    const invalid = NodePath.join(makeTempDir(), "invalid.json");
    NodeFS.writeFileSync(invalid, "{}");
    expect(() => consumeThreadWindowLaunch({ [THREAD_WINDOW_LAUNCH_ENV]: invalid })).toThrow(
      "missing or expired",
    );
    expect(NodeFS.existsSync(invalid)).toBe(false);
  });

  it("deletes an unread launch file after its time limit", async () => {
    const filePath = await writeThreadWindowLaunch(makeTempDir(), launch);
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    expireThreadWindowLaunch(filePath, 1, (callback, ms) => {
      scheduled.push({ callback, ms });
      return { unref: () => undefined };
    });
    expect(scheduled.map((entry) => entry.ms)).toEqual([1]);
    expect(NodeFS.existsSync(filePath)).toBe(true);
    scheduled[0]?.callback();
    await vi.waitFor(() => expect(NodeFS.existsSync(filePath)).toBe(false));
  });

  it("ignores a missing variable and rejects malformed files", () => {
    expect(consumeThreadWindowLaunch({})).toBeNull();
    expect(parseThreadWindowLaunch("not json")).toBeNull();
    expect(parseThreadWindowLaunch(JSON.stringify({ ...launch, threadId: "" }))).toBeNull();
    expect(
      parseThreadWindowLaunch(
        JSON.stringify({ ...launch, server: { ...launch.server, wsBaseUrl: "http://x" } }),
      ),
    ).toBeNull();
  });

  it("relaunches the current runtime with shared paths but no connection secrets", () => {
    const paths = { homeDir: "/data/t1", configHomeDir: "/cfg/t1", stateHomeDir: "/state/t1" };
    const command = buildThreadWindowCommand("/state/launch.json", paths, {
      execPath: "/usr/bin/bun",
      entryPath: "/app/dist/index.mjs",
      env: {
        TR3X_USE_MOUSE: "0",
        TR3X_AUTH_TOKEN: "secret",
        TR3X_PORT: "4321",
        TR3X_TUI_ATTACH_ONLY: "1",
      },
    });
    expect(command).toEqual([
      "env",
      "TR3X_HOME=/data/t1",
      "TR3X_CONFIG_HOME=/cfg/t1",
      "TR3X_STATE_HOME=/state/t1",
      "TR3X_USE_MOUSE=0",
      `${THREAD_WINDOW_LAUNCH_ENV}=/state/launch.json`,
      "/usr/bin/bun",
      "/app/dist/index.mjs",
    ]);
    expect(command.join(" ")).not.toContain("secret");
  });
});
