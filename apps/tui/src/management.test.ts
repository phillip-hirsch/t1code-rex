import { describe, expect, it } from "vite-plus/test";

import { describeError, preferredEditor } from "./management.ts";

describe("describeError", () => {
  it("adds the cause the server wraps in a generic message", () => {
    expect(
      describeError({
        message: "Failed to mutate project.",
        cause: { message: "Workspace root does not exist: /tmp/nope" },
      }),
    ).toBe("Failed to mutate project. Workspace root does not exist: /tmp/nope");
    expect(
      describeError({
        message: "Failed to mutate project.",
        cause: { message: "normalize failed", cause: { message: "No such directory: /x" } },
      }),
    ).toBe("Failed to mutate project. No such directory: /x");
    expect(describeError(new Error("busy"))).toBe("busy");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("preferredEditor", () => {
  it("picks the first code editor the host has, never the file manager", () => {
    expect(preferredEditor(["file-manager", "zed", "vscode"])).toBe("vscode");
    expect(preferredEditor(["file-manager"])).toBeNull();
  });
});
