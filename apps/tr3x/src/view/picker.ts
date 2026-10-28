import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

import { isUsableProvider } from "../providers.ts";

function stripLeadingQualifier(value: string, qualifier: string | undefined): string {
  const trimmed = qualifier?.trim();
  if (!trimmed) return value;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value.replace(new RegExp(`^${escaped}(?:\\s*[.:/-]\\s*|\\s+)`, "iu"), "").trim() || value;
}

/**
 * A model's names as web shows them (apps/web/src/components/chat/providerIconUtils.ts):
 * the full one in the model list (`getDisplayModelName`), the short one on the
 * picker's trigger and handoff rows (`getTriggerDisplayModelName`).
 */
function modelListLabel(model: Pick<ServerProviderModel, "name" | "subProvider">): string {
  return stripLeadingQualifier(model.name, model.subProvider);
}

export function modelLabel(
  model: Pick<ServerProviderModel, "name" | "shortName" | "subProvider">,
  driver: ProviderDriverKind | null | undefined,
): string {
  const name = resolveModelShortName(model, driver) ?? model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

/** "Codex · GPT-5", or the provider alone when the model is unknown to it and unnamed. */
export function endpointLabel(
  providers: ReadonlyArray<ServerProvider>,
  endpoint: { readonly instanceId: ProviderInstanceId; readonly model?: string | undefined },
): string {
  const provider = providers.find((candidate) => candidate.instanceId === endpoint.instanceId);
  const name = provider ? resolveProviderInstanceDisplayName(provider) : endpoint.instanceId;
  const slug = endpoint.model?.trim();
  if (!slug) return name;
  const model = provider?.models.find((candidate) => candidate.slug === slug);
  return `${name} · ${model ? modelLabel(model, provider?.driver) : slug}`;
}

/**
 * Why a started thread can't change to `next`, or null when it can. Mirrors web's
 * `getStartedThreadModelChangeBlockReason` (apps/web/src/components/ChatView.logic.ts).
 */
export function modelChangeBlockReason(input: {
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">
  >;
  readonly hasStartedSession: boolean;
  readonly supportsHandoff: boolean;
  readonly current: ModelSelection;
  readonly currentProviderInstanceId: ProviderInstanceId | null;
  readonly next: ModelSelection;
}): string | null {
  if (!input.hasStartedSession) return null;
  const currentInstance = input.currentProviderInstanceId ?? input.current.instanceId;
  if (currentInstance === input.next.instanceId && input.current.model === input.next.model) {
    return null;
  }
  if (currentInstance !== input.next.instanceId) {
    return input.supportsHandoff ? null : "Start a new thread to switch providers.";
  }
  const requiresNewThread = (instanceId: ProviderInstanceId) =>
    input.providers.find((provider) => provider.instanceId === instanceId)
      ?.requiresNewThreadForModelChange === true;
  return requiresNewThread(currentInstance) || requiresNewThread(input.next.instanceId)
    ? "Start a new thread to change models: this provider can't switch models mid-conversation."
    : null;
}

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
        label: modelListLabel(model),
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
  return selection === null ? "no model" : endpointLabel(providers, selection);
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
