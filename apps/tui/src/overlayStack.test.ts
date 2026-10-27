import { describe, expect, it } from "vite-plus/test";

import { topOverlay } from "./overlayStack.ts";

describe("topOverlay", () => {
  it("is null with nothing open", () => {
    expect(topOverlay({})).toBeNull();
  });

  it("puts every full-screen view and the palette over the git overlay", () => {
    for (const layer of [
      "dialog",
      "source-control",
      "archived",
      "model-picker",
      "palette",
    ] as const) {
      expect(topOverlay({ git: true, [layer]: true })).toBe(layer);
    }
  });

  it("puts the git overlay over the context menu", () => {
    expect(topOverlay({ git: true, "context-menu": true })).toBe("git");
  });

  it("puts a dialog over the view it was opened from", () => {
    expect(topOverlay({ dialog: true, "source-control": true, archived: true })).toBe("dialog");
  });
});
