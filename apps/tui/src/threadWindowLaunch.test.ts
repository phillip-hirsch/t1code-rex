import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  THREAD_WINDOW_LAUNCH_ENV,
  buildThreadWindowCommand,
  consumeThreadWindowLaunch,
  expireThreadWindowLaunch,
  parseThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch";

const launch = {
  server: { host: "127.0.0.1", port: 4321, authToken: "secret" },
  projectId: "project-1",
  threadId: "thread-1",
};

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t1-thread-window-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("threadWindowLaunch", () => {
  it("round-trips through a private one-shot file", async () => {
    const filePath = await writeThreadWindowLaunch(path.join(makeTempDir(), "windows"), launch);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const env: NodeJS.ProcessEnv = { [THREAD_WINDOW_LAUNCH_ENV]: filePath };
    expect(consumeThreadWindowLaunch(env)).toEqual(launch);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(env[THREAD_WINDOW_LAUNCH_ENV]).toBeUndefined();
  });

  it("refuses to start a thread window whose launch file is gone or invalid", async () => {
    const missing = path.join(makeTempDir(), "missing.json");
    expect(() => consumeThreadWindowLaunch({ [THREAD_WINDOW_LAUNCH_ENV]: missing })).toThrow(
      "missing or expired",
    );

    const invalid = path.join(makeTempDir(), "invalid.json");
    fs.writeFileSync(invalid, "{}");
    expect(() => consumeThreadWindowLaunch({ [THREAD_WINDOW_LAUNCH_ENV]: invalid })).toThrow(
      "missing or expired",
    );
    expect(fs.existsSync(invalid)).toBe(false);
  });

  it("deletes an unread launch file after its time limit", async () => {
    const filePath = await writeThreadWindowLaunch(makeTempDir(), launch);
    expireThreadWindowLaunch(filePath, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("ignores a missing variable and rejects malformed files", () => {
    expect(consumeThreadWindowLaunch({})).toBeNull();
    expect(parseThreadWindowLaunch("not json")).toBeNull();
    expect(parseThreadWindowLaunch(JSON.stringify({ ...launch, threadId: "" }))).toBeNull();
    expect(
      parseThreadWindowLaunch(
        JSON.stringify({ ...launch, server: { ...launch.server, port: "1" } }),
      ),
    ).toBeNull();
  });

  it("relaunches the current runtime with shared paths but no connection secrets", () => {
    const paths = { homeDir: "/data/t1", configHomeDir: "/cfg/t1", stateHomeDir: "/state/t1" };
    const command = buildThreadWindowCommand("/state/launch.json", paths, {
      execPath: "/usr/bin/bun",
      entryPath: "/app/dist/index.mjs",
      env: {
        T1CODE_USE_MOUSE: "0",
        T1CODE_AUTH_TOKEN: "secret",
        T1CODE_PORT: "4321",
        T1CODE_TUI_ATTACH_ONLY: "1",
      },
    });
    expect(command).toEqual([
      "env",
      "T1CODE_HOME=/data/t1",
      "T1CODE_CONFIG_HOME=/cfg/t1",
      "T1CODE_STATE_HOME=/state/t1",
      "T1CODE_USE_MOUSE=0",
      `${THREAD_WINDOW_LAUNCH_ENV}=/state/launch.json`,
      "/usr/bin/bun",
      "/app/dist/index.mjs",
    ]);
    expect(command.join(" ")).not.toContain("secret");
  });
});
