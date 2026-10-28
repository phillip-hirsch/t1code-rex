import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { isUsableProvider } from "../providers.ts";

/** One row of the model picker: a usable provider's model. */
export interface PickerEntry {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly provider: string;
  readonly label: string;
}

/**
 * Every usable provider's models. With `onlyInstance` set, the thread can't hand
 * off to another provider, so only that provider's models are offered.
 */
export function buildPickerEntries(
  providers: ReadonlyArray<ServerProvider>,
  onlyInstance: ProviderInstanceId | null = null,
): ReadonlyArray<PickerEntry> {
  return providers
    .filter((provider) => isUsableProvider(provider))
    .filter((provider) => onlyInstance === null || provider.instanceId === onlyInstance)
    .flatMap((provider) => {
      const name = resolveProviderInstanceDisplayName(provider);
      return provider.models.map((model) => ({
        instanceId: provider.instanceId,
        model: model.slug,
        provider: name,
        label: model.shortName ?? model.name,
      }));
    });
}

/** The selection a new thread starts with: the first usable provider's default model. */
export function defaultSelection(providers: ReadonlyArray<ServerProvider>): ModelSelection | null {
  const provider = providers.find(
    (candidate) => isUsableProvider(candidate) && candidate.models.length > 0,
  );
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
  return provider && model ? { instanceId: provider.instanceId, model: model.slug } : null;
}

export function selectionLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
): string {
  if (selection === null) return "no model";
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  const name = provider ? resolveProviderInstanceDisplayName(provider) : selection.instanceId;
  return `${name} · ${model?.shortName ?? model?.name ?? selection.model}`;
}

export interface PickerState {
  readonly query: string;
  readonly index: number;
}

export function filterPickerEntries(
  entries: ReadonlyArray<PickerEntry>,
  query: string,
): ReadonlyArray<PickerEntry> {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [entry.label, entry.model, entry.provider].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export function openPicker(
  entries: ReadonlyArray<PickerEntry>,
  current: ModelSelection | null,
): PickerState {
  const index = entries.findIndex(
    (entry) => entry.instanceId === current?.instanceId && entry.model === current.model,
  );
  return { query: "", index: Math.max(0, index) };
}

export type PickerOutcome =
  | { readonly type: "state"; readonly state: PickerState }
  | { readonly type: "select"; readonly selection: ModelSelection }
  | { readonly type: "close" };

export interface PickerKey {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/** ↑↓ move, Enter picks, typing filters, Backspace edits the filter, Esc closes. */
export function reducePickerKey(
  entries: ReadonlyArray<PickerEntry>,
  state: PickerState,
  key: PickerKey,
): PickerOutcome | null {
  const visible = filterPickerEntries(entries, state.query);
  const clamp = (index: number) => Math.min(Math.max(index, 0), Math.max(visible.length - 1, 0));
  const next = (patch: Partial<PickerState>): PickerOutcome => ({
    type: "state",
    state: { ...state, ...patch },
  });
  switch (key.name) {
    case "escape":
      return { type: "close" };
    case "up":
      return next({ index: clamp(state.index - 1) });
    case "down":
      return next({ index: clamp(state.index + 1) });
    case "return":
    case "enter": {
      const picked = visible[state.index];
      return picked
        ? { type: "select", selection: { instanceId: picked.instanceId, model: picked.model } }
        : null;
    }
    case "backspace":
      return next({ query: state.query.slice(0, -1), index: 0 });
  }
  const typed = key.sequence;
  if (!key.ctrl && !key.meta && typed?.length === 1 && typed >= " ") {
    return next({ query: state.query + typed, index: 0 });
  }
  return null;
}
