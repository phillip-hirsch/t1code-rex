import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  THREAD_WINDOW_LAUNCH_ENV,
  buildThreadWindowCommand,
  consumeThreadWindowLaunch,
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

    const env = { [THREAD_WINDOW_LAUNCH_ENV]: filePath };
    expect(consumeThreadWindowLaunch(env)).toEqual(launch);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(consumeThreadWindowLaunch(env)).toBeNull();
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
    const command = buildThreadWindowCommand("/state/launch.json", {
      execPath: "/usr/bin/bun",
      entryPath: "/app/dist/index.mjs",
      env: {
        T1CODE_HOME: "/data/t1",
        T1CODE_AUTH_TOKEN: "secret",
        T1CODE_PORT: "4321",
        T1CODE_TUI_ATTACH_ONLY: "1",
      },
    });
    expect(command).toEqual([
      "env",
      "T1CODE_HOME=/data/t1",
      `${THREAD_WINDOW_LAUNCH_ENV}=/state/launch.json`,
      "/usr/bin/bun",
      "/app/dist/index.mjs",
    ]);
    expect(command.join(" ")).not.toContain("secret");
  });
});
