import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPickerProviders,
  modelSelectionLabel,
  openModelPicker,
  reduceModelPickerKey,
  visibleModelPickerModels,
  type ModelPickerOutcome,
  type ModelPickerState,
} from "./modelPicker.ts";
import { testProvider } from "./providerTestFixtures.ts";

const providers = buildModelPickerProviders([
  testProvider({ instanceId: "codex", displayName: "Codex", models: ["gpt-5.5", "gpt-5.5-mini"] }),
  testProvider({
    instanceId: "claudeAgent",
    displayName: "Claude",
    models: [
      { slug: "claude-opus-5-5", shortName: "Opus 5.5" },
      { slug: "claude-haiku-5-5", shortName: "Haiku 5.5" },
    ],
  }),
  testProvider({ instanceId: "cursor", models: ["auto"], enabled: false }),
]);

function stateOf(outcome: ModelPickerOutcome | null): ModelPickerState {
  if (outcome?.type !== "state") throw new Error(`expected a state, got ${outcome?.type}`);
  return outcome.state;
}

describe("model picker", () => {
  it("lists only usable providers and labels models by short name", () => {
    expect(providers.map((provider) => provider.label)).toEqual(["Codex", "Claude"]);
    expect(
      modelSelectionLabel(providers, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-5-5",
      }),
    ).toBe("Haiku 5.5");
  });

  it("opens on the current model and switches providers with the arrows", () => {
    const opened = openModelPicker(providers, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5-mini",
    });
    expect(opened).toEqual({ instanceId: "codex", index: 1, query: "" });
    const right = stateOf(reduceModelPickerKey(providers, opened, { name: "right" }));
    expect(right).toEqual({ instanceId: "claudeAgent", index: 0, query: "" });
    const down = stateOf(reduceModelPickerKey(providers, right, { name: "down" }));
    expect(reduceModelPickerKey(providers, down, { name: "return" })).toEqual({
      type: "select",
      instanceId: "claudeAgent",
      model: "claude-haiku-5-5",
    });
    expect(stateOf(reduceModelPickerKey(providers, right, { name: "right" })).instanceId).toBe(
      "codex",
    );
  });

  it("searches every provider as you type", () => {
    let state = openModelPicker(providers, null);
    for (const sequence of "haiku") {
      state = stateOf(reduceModelPickerKey(providers, state, { name: sequence, sequence }));
    }
    expect(visibleModelPickerModels(providers, state).map((model) => model.slug)).toEqual([
      "claude-haiku-5-5",
    ]);
    expect(reduceModelPickerKey(providers, state, { name: "return" })).toMatchObject({
      type: "select",
      model: "claude-haiku-5-5",
    });
    const cleared = stateOf(reduceModelPickerKey(providers, state, { name: "u", ctrl: true }));
    expect(cleared.query).toBe("");
    expect(reduceModelPickerKey(providers, state, { name: "escape" })).toEqual({ type: "close" });
  });
});
