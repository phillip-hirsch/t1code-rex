import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "./providerInstances.ts";

/**
 * The provider and model picker (mod+shift+m or /model): ←→ switch providers, ↑↓ move,
 * Enter picks, typing searches every provider's models, Esc closes.
 */

export interface ModelPickerProvider {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly driver: string;
  readonly models: ReadonlyArray<ModelPickerModel>;
}

export interface ModelPickerModel {
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly label: string;
  readonly providerLabel: string;
}

export interface ModelPickerState {
  readonly instanceId: ProviderInstanceId | null;
  readonly index: number;
  readonly query: string;
}

export interface ModelPickerKey {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
}

export type ModelPickerOutcome =
  | { readonly type: "state"; readonly state: ModelPickerState }
  | { readonly type: "select"; readonly instanceId: ProviderInstanceId; readonly model: string }
  | { readonly type: "close" };

/** Providers a run can use right now, with their models; disabled or missing ones stay out. */
export function buildModelPickerProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelPickerProvider> {
  return sortProviderInstanceEntries(deriveProviderInstanceEntries(providers))
    .filter((entry) => entry.enabled && entry.installed && entry.isAvailable)
    .map((entry) => ({
      instanceId: entry.instanceId,
      label: entry.displayName,
      driver: entry.driverKind,
      models: entry.models.map((model) => ({
        instanceId: entry.instanceId,
        slug: model.slug,
        label: model.shortName ?? model.name,
        providerLabel: entry.displayName,
      })),
    }));
}

/** The label the composer toolbar shows for a selection. */
export function modelSelectionLabel(
  providers: ReadonlyArray<ModelPickerProvider>,
  selection: ModelSelection,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return provider?.models.find((model) => model.slug === selection.model)?.label ?? selection.model;
}

export function openModelPicker(
  providers: ReadonlyArray<ModelPickerProvider>,
  current: ModelSelection | null,
): ModelPickerState {
  const provider =
    providers.find((entry) => entry.instanceId === current?.instanceId) ?? providers[0];
  const index = provider?.models.findIndex((model) => model.slug === current?.model) ?? -1;
  return { instanceId: provider?.instanceId ?? null, index: Math.max(0, index), query: "" };
}

/** The rows the picker lists: the focused provider's models, or search hits across all. */
export function visibleModelPickerModels(
  providers: ReadonlyArray<ModelPickerProvider>,
  state: ModelPickerState,
): ReadonlyArray<ModelPickerModel> {
  const query = state.query.trim().toLowerCase();
  if (query.length === 0) {
    return providers.find((entry) => entry.instanceId === state.instanceId)?.models ?? [];
  }
  return providers.flatMap((provider) =>
    provider.models.filter((model) =>
      [model.label, model.slug, model.providerLabel].some((field) =>
        field.toLowerCase().includes(query),
      ),
    ),
  );
}

function clampIndex(index: number, count: number): number {
  return count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
}

export function reduceModelPickerKey(
  providers: ReadonlyArray<ModelPickerProvider>,
  state: ModelPickerState,
  key: ModelPickerKey,
): ModelPickerOutcome | null {
  const visible = visibleModelPickerModels(providers, state);
  const next = (patch: Partial<ModelPickerState>): ModelPickerOutcome => ({
    type: "state",
    state: { ...state, ...patch },
  });
  switch (key.name) {
    case "escape":
      return { type: "close" };
    case "up":
      return next({ index: clampIndex(state.index - 1, visible.length) });
    case "down":
      return next({ index: clampIndex(state.index + 1, visible.length) });
    case "left":
    case "right": {
      if (state.query.length > 0 || providers.length === 0) return null;
      const current = providers.findIndex((entry) => entry.instanceId === state.instanceId);
      const delta = key.name === "left" ? -1 : 1;
      const target = providers[(current + delta + providers.length) % providers.length];
      return target ? next({ instanceId: target.instanceId, index: 0 }) : null;
    }
    case "return":
    case "enter":
    case "kpenter": {
      const picked = visible[state.index];
      return picked ? { type: "select", instanceId: picked.instanceId, model: picked.slug } : null;
    }
    case "backspace":
      return next({ query: state.query.slice(0, -1), index: 0 });
  }
  if (key.ctrl && key.name === "u") return next({ query: "", index: 0 });
  if (key.ctrl && key.name === "k")
    return next({ index: clampIndex(state.index - 1, visible.length) });
  if (key.ctrl && key.name === "j")
    return next({ index: clampIndex(state.index + 1, visible.length) });
  const typed = key.sequence;
  if (!key.ctrl && !key.meta && !key.super && typed && typed.length === 1 && typed >= " ") {
    return next({ query: state.query + typed, index: 0 });
  }
  return null;
}
