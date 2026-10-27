import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextRuntimeMode,
  normalizeSettingsPatch,
  parseRuntimeMode,
  resolveNewThreadSettings,
  supportedRuntimeModes,
  type ComposerSettings,
} from "./composerSettings.ts";
import { testProvider } from "./providerTestFixtures.ts";

const codex = testProvider({ instanceId: "codex", models: ["gpt-5.5", "gpt-5.5-mini"] });
const claude = testProvider({
  instanceId: "claudeAgent",
  models: ["claude-opus-5-5", "claude-haiku-5-5"],
  supportedRuntimeModes: ["approval-required", "full-access"],
});

describe("resolveNewThreadSettings", () => {
  it("starts from the last picked model and modes", () => {
    expect(
      resolveNewThreadSettings({
        defaults: {
          draftProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
          draftModel: "claude-haiku-5-5",
          draftRuntimeMode: "approval-required",
          draftInteractionMode: "plan",
        },
        projectDefault: null,
        providers: [codex, claude],
      }),
    ).toEqual({
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  });

  it("falls back to the project default, then the first usable provider", () => {
    const projectDefault = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    };
    expect(
      resolveNewThreadSettings({ defaults: {}, projectDefault, providers: [codex, claude] }),
    ).toMatchObject({ modelSelection: projectDefault, runtimeMode: "full-access" });
    const disabledClaude = testProvider({
      instanceId: "claudeAgent",
      models: ["claude-opus-5-5"],
      enabled: false,
    });
    expect(
      resolveNewThreadSettings({
        defaults: { draftProviderInstanceId: ProviderInstanceId.make("claudeAgent") },
        projectDefault,
        providers: [disabledClaude, codex],
      }),
    ).toMatchObject({ modelSelection: { instanceId: "codex", model: "gpt-5.5" } });
  });

  it("keeps the provider but swaps a model it no longer lists", () => {
    expect(
      resolveNewThreadSettings({
        defaults: { draftProviderInstanceId: ProviderInstanceId.make("codex"), draftModel: "gone" },
        projectDefault: null,
        providers: [codex],
      })?.modelSelection,
    ).toEqual({ instanceId: "codex", model: "gpt-5.5" });
  });

  it("waits for a usable provider", () => {
    expect(
      resolveNewThreadSettings({ defaults: {}, projectDefault: null, providers: [] }),
    ).toBeNull();
  });
});

describe("runtime modes", () => {
  it("cycles through the modes the provider supports", () => {
    expect(supportedRuntimeModes(codex)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    const claudeModes = supportedRuntimeModes(claude);
    expect(claudeModes).toEqual(["approval-required", "full-access"]);
    expect(nextRuntimeMode("full-access", claudeModes)).toBe("approval-required");
    expect(nextRuntimeMode("approval-required", claudeModes)).toBe("full-access");
    expect(nextRuntimeMode("auto", claudeModes)).toBe("approval-required");
  });

  it("reads typed mode names", () => {
    expect(parseRuntimeMode("Full")).toBe("full-access");
    expect(parseRuntimeMode("edits")).toBe("auto-accept-edits");
    expect(parseRuntimeMode("nope")).toBeNull();
  });
});

describe("normalizeSettingsPatch", () => {
  const thread: ComposerSettings = {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
  };

  it("drops picks that match the thread again", () => {
    expect(
      normalizeSettingsPatch(thread, {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
        runtimeMode: "full-access",
      }),
    ).toBeUndefined();
    expect(
      normalizeSettingsPatch(thread, { interactionMode: "plan", runtimeMode: "full-access" }),
    ).toEqual({
      interactionMode: "plan",
    });
  });
});
