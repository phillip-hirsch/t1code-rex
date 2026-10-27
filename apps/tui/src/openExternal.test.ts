import { describe, expect, it, vi } from "vite-plus/test";

import { openExternalUrl, resolveOpenExternalCommands } from "./openExternal.ts";

describe("resolveOpenExternalCommands", () => {
  it("prefers Linux desktop openers", () => {
    expect(
      resolveOpenExternalCommands("https://example.com", {
        platform: "linux",
        env: {},
      }),
    ).toEqual([
      ["xdg-open", "https://example.com"],
      ["gio", "open", "https://example.com"],
      ["sensible-browser", "https://example.com"],
    ]);
  });

  it("prefers wslview when running under WSL", () => {
    const commands = resolveOpenExternalCommands("https://example.com", {
      platform: "linux",
      env: {
        WSL_DISTRO_NAME: "Ubuntu",
      },
    });

    expect(commands[0]).toEqual(["wslview", "https://example.com"]);
  });
});

describe("openExternalUrl", () => {
  it("falls back to the next helper when the first one fails", async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        return {
          once(event: string, handler: (error?: Error) => void) {
            if (event === "error") {
              queueMicrotask(() => handler(new Error("missing xdg-open")));
            }
            return this;
          },
          unref() {},
        };
      })
      .mockImplementationOnce(() => {
        return {
          once(event: string, handler: () => void) {
            if (event === "spawn") {
              queueMicrotask(handler);
            }
            return this;
          },
          unref() {},
        };
      });

    await expect(
      openExternalUrl("https://example.com", {
        platform: "linux",
        env: {},
        spawnImpl: spawnImpl as never,
      }),
    ).resolves.toBeUndefined();

    expect(spawnImpl).toHaveBeenNthCalledWith(1, "xdg-open", ["https://example.com"], {
      detached: true,
      stdio: "ignore",
    });
    expect(spawnImpl).toHaveBeenNthCalledWith(2, "gio", ["open", "https://example.com"], {
      detached: true,
      stdio: "ignore",
    });
  });
});
