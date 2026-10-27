import { describe, expect, it } from "vite-plus/test";
import { type KeybindingShortcut, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import {
  modelPickerJumpIndexFromCommand,
  modShortcutLabel,
  resolveTuiShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "./keybindings.ts";

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

const keybindings: ResolvedKeybindingsConfig = [
  {
    command: "commandPalette.toggle",
    shortcut: modShortcut("k"),
  },
  {
    command: "thread.jump.1",
    shortcut: modShortcut("1"),
  },
  {
    command: "modelPicker.toggle",
    shortcut: modShortcut("m", { shiftKey: true }),
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  },
  {
    command: "modelPicker.jump.1",
    shortcut: modShortcut("1"),
    whenAst: { type: "identifier", name: "modelPickerOpen" },
  },
  {
    command: "terminal.toggle",
    shortcut: modShortcut("j"),
  },
  {
    command: "commandPalette.toggle",
    shortcut: modShortcut("k"),
  },
];

describe("resolveTuiShortcutCommand", () => {
  it("matches mod shortcuts using ctrl on non-mac platforms", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "m", ctrl: true, shift: true }, keybindings, {
        platform: "linux",
      }),
    ).toBe("modelPicker.toggle");
  });

  it("uses the event key name for modified control sequences", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "k", ctrl: true, sequence: "\u000b" }, keybindings, {
        platform: "linux",
      }),
    ).toBe("commandPalette.toggle");
  });

  it("matches mod shortcuts using meta or super on macOS", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "m", meta: true, shift: true }, keybindings, {
        platform: "darwin",
      }),
    ).toBe("modelPicker.toggle");

    expect(
      resolveTuiShortcutCommand({ keyName: "m", super: true, shift: true }, keybindings, {
        platform: "darwin",
      }),
    ).toBe("modelPicker.toggle");
  });

  it("honors when clauses and resolves later active bindings first", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "1", ctrl: true }, keybindings, {
        platform: "linux",
        context: { modelPickerOpen: false },
      }),
    ).toBe("thread.jump.1");

    expect(
      resolveTuiShortcutCommand({ keyName: "1", ctrl: true }, keybindings, {
        platform: "linux",
        context: { modelPickerOpen: true },
      }),
    ).toBe("modelPicker.jump.1");
  });

  it("uses the event key name for modified control sequences", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "k", ctrl: true, sequence: "\u000b" }, keybindings, {
        platform: "linux",
      }),
    ).toBe("commandPalette.toggle");

    expect(
      resolveTuiShortcutCommand({ keyName: "j", ctrl: true, sequence: "\n" }, keybindings, {
        platform: "linux",
      }),
    ).toBe("terminal.toggle");
  });

  it("infers ctrl letter shortcuts from raw control sequences", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "linefeed", ctrl: false, sequence: "\n" }, keybindings, {
        platform: "linux",
      }),
    ).toBe("terminal.toggle");
  });
});

describe("Ctrl+D with upstream's default bindings (diff.toggle is mod+d)", () => {
  const ctrlD = { keyName: "d", ctrl: true, sequence: "\u0004" };

  it("toggles the diff with Cmd+D on macOS", () => {
    expect(
      resolveTuiShortcutCommand({ keyName: "d", super: true }, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "darwin",
      }),
    ).toBe("diff.toggle");
    expect(
      resolveTuiShortcutCommand(ctrlD, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "darwin" }),
    ).toBeNull();
  });

  it("leaves Ctrl+D and Ctrl+U to scrolling and the composer on Windows and Linux", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(
        resolveTuiShortcutCommand(ctrlD, DEFAULT_RESOLVED_KEYBINDINGS, { platform }),
      ).toBeNull();
      expect(
        resolveTuiShortcutCommand({ keyName: "u", ctrl: true }, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
        }),
      ).toBeNull();
      // Other mod shortcuts still map to Ctrl.
      expect(
        resolveTuiShortcutCommand({ keyName: "k", ctrl: true }, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
        }),
      ).toBe("commandPalette.toggle");
    }
  });

  it("still honors an explicit ctrl+d binding", () => {
    const custom = compileResolvedKeybindingsConfig([{ key: "ctrl+d", command: "diff.toggle" }]);
    expect(resolveTuiShortcutCommand(ctrlD, custom, { platform: "linux" })).toBe("diff.toggle");
  });

  it("labels mod shortcuts per platform, and none for a kept Ctrl key", () => {
    expect(modShortcutLabel("d", "darwin")).toBe("⌘D");
    expect(modShortcutLabel("d", "linux")).toBeNull();
    expect(modShortcutLabel("k", "win32")).toBe("Ctrl+K");
  });
});

describe("keys in a focused terminal with upstream's default bindings", () => {
  const inTerminal = (platform: NodeJS.Platform) => ({
    platform,
    context: { terminalFocus: true, terminalOpen: true },
  });

  it("leaves Ctrl+D (EOF) and Ctrl+U (kill line) to the shell on Windows and Linux", () => {
    for (const platform of ["linux", "win32"] as const) {
      for (const [keyName, sequence] of [
        ["d", "\u0004"],
        ["u", "\u0015"],
      ] as const) {
        expect(
          resolveTuiShortcutCommand(
            { keyName, ctrl: true, sequence },
            DEFAULT_RESOLVED_KEYBINDINGS,
            inTerminal(platform),
          ),
        ).toBeNull();
      }
      expect(
        resolveTuiShortcutCommand(
          { keyName: "d", ctrl: true, shift: true },
          DEFAULT_RESOLVED_KEYBINDINGS,
          inTerminal(platform),
        ),
      ).toBe("terminal.splitVertical");
    }
  });

  it("splits with Cmd+D on macOS and leaves Ctrl+D and Ctrl+U to the shell", () => {
    const darwin = inTerminal("darwin");
    expect(
      resolveTuiShortcutCommand(
        { keyName: "d", super: true },
        DEFAULT_RESOLVED_KEYBINDINGS,
        darwin,
      ),
    ).toBe("terminal.split");
    expect(
      resolveTuiShortcutCommand({ keyName: "d", meta: true }, DEFAULT_RESOLVED_KEYBINDINGS, darwin),
    ).toBe("terminal.split");
    for (const keyName of ["d", "u"]) {
      expect(
        resolveTuiShortcutCommand({ keyName, ctrl: true }, DEFAULT_RESOLVED_KEYBINDINGS, darwin),
      ).toBeNull();
    }
  });
});

describe("modelPickerJumpIndexFromCommand", () => {
  it("maps model picker jump commands to zero-based indexes", () => {
    expect(modelPickerJumpIndexFromCommand("modelPicker.jump.1")).toBe(0);
    expect(modelPickerJumpIndexFromCommand("modelPicker.jump.9")).toBe(8);
    expect(modelPickerJumpIndexFromCommand("thread.jump.1")).toBeNull();
  });
});

describe("thread command helpers", () => {
  it("maps thread jump commands to zero-based indexes", () => {
    expect(threadJumpIndexFromCommand("thread.jump.1")).toBe(0);
    expect(threadJumpIndexFromCommand("thread.jump.9")).toBe(8);
    expect(threadJumpIndexFromCommand("modelPicker.jump.1")).toBeNull();
  });

  it("maps thread traversal commands to directions", () => {
    expect(threadTraversalDirectionFromCommand("thread.previous")).toBe("previous");
    expect(threadTraversalDirectionFromCommand("thread.next")).toBe("next");
    expect(threadTraversalDirectionFromCommand("thread.jump.1")).toBeNull();
  });
});
