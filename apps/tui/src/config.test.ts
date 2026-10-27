import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import { resolveTuiPaths } from "./config.ts";

describe("resolveTuiPaths", () => {
  it("prefers TUI-specific paths", () => {
    const paths = resolveTuiPaths({
      TR3X_HOME: "/tmp/t1-home",
      TR3X_CONFIG_HOME: "/tmp/t1-config",
      TR3X_STATE_HOME: "/tmp/t1-state",
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
      homeDir: "/var/data/tr3x",
      configHomeDir: "/var/config/tr3x",
      stateHomeDir: "/var/state/tr3x",
      prefsPath: "/var/config/tr3x/prefs.json",
      logPath: "/var/state/tr3x/tui.log",
      imagesDir: "/var/state/tr3x/images",
    });
  });

  it("uses ~/.tr3x and ~/.config/tr3x on non-Linux platforms", () => {
    const paths = resolveTuiPaths({}, { homeDir: "/Users/tester", platform: "darwin" });

    expect(paths).toEqual({
      userHomeDir: "/Users/tester",
      homeDir: "/Users/tester/.tr3x",
      configHomeDir: "/Users/tester/.config/tr3x",
      stateHomeDir: "/Users/tester/.config/tr3x",
      prefsPath: "/Users/tester/.config/tr3x/prefs.json",
      logPath: "/Users/tester/.config/tr3x/tui.log",
      imagesDir: "/Users/tester/.config/tr3x/images",
    });
  });
});
