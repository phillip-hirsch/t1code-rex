import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import { resolveTuiPaths } from "./config.ts";

describe("resolveTuiPaths", () => {
  it("prefers TUI-specific paths", () => {
    const paths = resolveTuiPaths({
      T1CODE_HOME: "/tmp/t1-home",
      T1CODE_CONFIG_HOME: "/tmp/t1-config",
      T1CODE_STATE_HOME: "/tmp/t1-state",
    });

    expect(paths).toEqual({
      userHomeDir: NodeOS.homedir(),
      homeDir: "/tmp/t1-home",
      configHomeDir: "/tmp/t1-config",
      stateHomeDir: "/tmp/t1-state",
      prefsPath: "/tmp/t1-config/prefs.json",
      logPath: "/tmp/t1-state/tui.log",
      imagesDir: "/tmp/t1-state/images",
    });
  });

  it("uses XDG config, data, and state locations on Linux", () => {
    const paths = resolveTuiPaths(
      {
        XDG_CONFIG_HOME: "/var/config",
        XDG_DATA_HOME: "/var/data",
        XDG_STATE_HOME: "/var/state",
      },
      { homeDir: "/Users/tester", platform: "linux" },
    );

    expect(paths).toEqual({
      userHomeDir: "/Users/tester",
      homeDir: "/var/data/t1code",
      configHomeDir: "/var/config/t1code",
      stateHomeDir: "/var/state/t1code",
      prefsPath: "/var/config/t1code/prefs.json",
      logPath: "/var/state/t1code/tui.log",
      imagesDir: "/var/state/t1code/images",
    });
  });

  it("keeps legacy defaults on non-Linux platforms", () => {
    const paths = resolveTuiPaths({}, { homeDir: "/Users/tester", platform: "darwin" });

    expect(paths).toEqual({
      userHomeDir: "/Users/tester",
      homeDir: "/Users/tester/.t1",
      configHomeDir: "/Users/tester/.config/t1code",
      stateHomeDir: "/Users/tester/.config/t1code",
      prefsPath: "/Users/tester/.config/t1code/prefs.json",
      logPath: "/Users/tester/.config/t1code/tui.log",
      imagesDir: "/Users/tester/.config/t1code/images",
    });
  });
});
