import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../testing/serverProvider.ts";
import {
  buildPickerEntries,
  defaultSelection,
  modelChangeBlockReason,
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

describe("modelChangeBlockReason", () => {
  const codexId = ProviderInstanceId.make("codex");
  const claudeId = ProviderInstanceId.make("claudeAgent");
  const base = {
    providers: [
      { instanceId: codexId, requiresNewThreadForModelChange: true },
      { instanceId: claudeId },
    ],
    hasStartedSession: true,
    supportsHandoff: true,
    current: { instanceId: codexId, model: "gpt-5" },
    currentProviderInstanceId: null,
  };

  it("follows web: no limit before the session starts, or for the same selection", () => {
    const next = { instanceId: codexId, model: "gpt-6" };
    expect(modelChangeBlockReason({ ...base, hasStartedSession: false, next })).toBeNull();
    expect(modelChangeBlockReason({ ...base, next: base.current })).toBeNull();
  });

  it("refuses a model change on a provider that needs a new thread for one", () => {
    expect(
      modelChangeBlockReason({ ...base, next: { instanceId: codexId, model: "gpt-6" } }),
    ).toMatch(/^Start a new thread to change models/u);
  });

  it("allows a provider switch only with handoff support", () => {
    const next = { instanceId: claudeId, model: "sonnet" };
    expect(modelChangeBlockReason({ ...base, next })).toBeNull();
    expect(modelChangeBlockReason({ ...base, supportsHandoff: false, next })).toBe(
      "Start a new thread to switch providers.",
    );
  });
});
