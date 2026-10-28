import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../testing/serverProvider.ts";
import {
  buildPickerEntries,
  defaultSelection,
  openPicker,
  reducePickerKey,
  selectionLabel,
} from "./picker.ts";

const model = (slug: string, name: string, isDefault = false) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
  ...(isDefault ? { isDefault } : {}),
});
const providers = [
  provider("codex", {
    displayName: "Codex",
    models: [model("gpt-5", "GPT-5"), model("gpt-5-mini", "GPT-5 mini", true)],
  }),
  provider("claudeAgent", { displayName: "Claude", models: [model("sonnet", "Sonnet")] }),
  provider("pi", { auth: { status: "unauthenticated" }, models: [model("pi-1", "Pi 1")] }),
];

describe("model picker", () => {
  it("offers usable providers' models, or one provider's when the thread can't hand off", () => {
    expect(
      buildPickerEntries(providers).map((entry) => `${entry.provider} · ${entry.label}`),
    ).toEqual(["Codex · GPT-5", "Codex · GPT-5 mini", "Claude · Sonnet"]);
    expect(buildPickerEntries(providers, ProviderInstanceId.make("claudeAgent"))).toHaveLength(1);
    expect(defaultSelection(providers)).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
    expect(
      selectionLabel(providers, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "sonnet",
      }),
    ).toBe("Claude · Sonnet");
  });

  it("filters as the user types, moves, and picks the highlighted model", () => {
    const entries = buildPickerEntries(providers);
    let state = openPicker(entries, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-mini",
    });
    expect(state.index).toBe(1);
    for (const sequence of ["c", "l"]) {
      const outcome = reducePickerKey(entries, state, { name: sequence, sequence });
      if (outcome?.type !== "state") throw new Error("expected a state");
      state = outcome.state;
    }
    expect(state).toEqual({ query: "cl", index: 0 });
    expect(reducePickerKey(entries, state, { name: "return" })).toEqual({
      type: "select",
      selection: { instanceId: "claudeAgent", model: "sonnet" },
    });
    expect(reducePickerKey(entries, state, { name: "escape" })).toEqual({ type: "close" });
    expect(reducePickerKey(entries, { query: "", index: 2 }, { name: "down" })).toEqual({
      type: "state",
      state: { query: "", index: 2 },
    });
  });
});
