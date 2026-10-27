import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";

/** The model and modes the next run uses. */
export interface ComposerSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export type ComposerSettingsPatch = Partial<ComposerSettings>;

/** The last settings picked in any composer; new drafts start from them. */
export interface ComposerSettingsDefaults {
  readonly draftProviderInstanceId?: ProviderInstanceId;
  readonly draftModel?: string;
  readonly draftRuntimeMode?: RuntimeMode;
  readonly draftInteractionMode?: ProviderInteractionMode;
}

const RUNTIME_MODES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly icon: string;
}> = [
  { mode: "approval-required", label: "Approval", icon: "󰌽" },
  { mode: "auto-accept-edits", label: "Accept edits", icon: "󰏫" },
  { mode: "auto", label: "Auto", icon: "󰁨" },
  { mode: "full-access", label: "Full access", icon: "󰌾" },
];

export function runtimeModeLabel(mode: RuntimeMode): string {
  return RUNTIME_MODES.find((entry) => entry.mode === mode)?.label ?? mode;
}

export function runtimeModeIcon(mode: RuntimeMode): string {
  return RUNTIME_MODES.find((entry) => entry.mode === mode)?.icon ?? "󰌾";
}

export function interactionModeLabel(mode: ProviderInteractionMode): string {
  return mode === "plan" ? "Plan" : "Chat";
}

export function interactionModeIcon(mode: ProviderInteractionMode): string {
  return mode === "plan" ? "󰨖" : "󰍩";
}

/** The runtime modes a provider accepts, in display order; all of them when it doesn't say. */
export function supportedRuntimeModes(provider: ServerProvider | undefined): RuntimeMode[] {
  const supported = provider?.supportedRuntimeModes;
  const modes = RUNTIME_MODES.map((entry) => entry.mode);
  if (!supported || supported.length === 0) return modes;
  return modes.filter((mode) => supported.includes(mode));
}

/** The mode after `current` in the supported cycle; the first one when `current` isn't in it. */
export function nextRuntimeMode(
  current: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode>,
): RuntimeMode {
  if (supported.length === 0) return current;
  const index = supported.indexOf(current);
  return supported[(index + 1) % supported.length] ?? current;
}

/** Reads a runtime mode the user typed, e.g. `/runtime full` or `/runtime approval`. */
export function parseRuntimeMode(value: string): RuntimeMode | null {
  switch (value.trim().toLowerCase()) {
    case "approval":
    case "approval-required":
    case "supervised":
      return "approval-required";
    case "edits":
    case "accept-edits":
    case "auto-accept-edits":
      return "auto-accept-edits";
    case "auto":
      return "auto";
    case "full":
    case "full-access":
      return "full-access";
    default:
      return null;
  }
}

function isSelectable(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && provider.availability !== "unavailable";
}

function selectableModel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
  model: string | undefined,
): ModelSelection | null {
  if (instanceId === undefined) return null;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider || !isSelectable(provider)) return null;
  const slug = provider.models.some((candidate) => candidate.slug === model)
    ? model
    : provider.models[0]?.slug;
  return slug === undefined ? null : createModelSelection(instanceId, slug);
}

/**
 * Settings for a new thread: the last ones picked, else the project's default model, else
 * the first usable provider's first model. Null until the server lists a usable provider.
 */
export function resolveNewThreadSettings(input: {
  readonly defaults: ComposerSettingsDefaults;
  readonly projectDefault: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ComposerSettings | null {
  const { defaults, projectDefault, providers } = input;
  const modelSelection =
    selectableModel(providers, defaults.draftProviderInstanceId, defaults.draftModel) ??
    (projectDefault === null
      ? null
      : selectableModel(providers, projectDefault.instanceId, projectDefault.model)) ??
    providers
      .filter(isSelectable)
      .map((provider) => selectableModel(providers, provider.instanceId, undefined))
      .find((selection) => selection !== null) ??
    null;
  if (modelSelection === null) return null;
  return {
    modelSelection,
    runtimeMode: defaults.draftRuntimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: defaults.draftInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}

export function applySettingsPatch(
  base: ComposerSettings,
  patch: ComposerSettingsPatch | undefined,
): ComposerSettings {
  if (patch === undefined) return base;
  return { ...base, ...patch };
}

/** Drops patch entries that match the thread again, so a pick that undoes itself clears. */
export function normalizeSettingsPatch(
  base: ComposerSettings,
  patch: ComposerSettingsPatch,
): ComposerSettingsPatch | undefined {
  const next: { -readonly [Key in keyof ComposerSettings]?: ComposerSettings[Key] } = {};
  if (
    patch.modelSelection !== undefined &&
    !modelSelectionsEqual(patch.modelSelection, base.modelSelection)
  ) {
    next.modelSelection = patch.modelSelection;
  }
  if (patch.runtimeMode !== undefined && patch.runtimeMode !== base.runtimeMode) {
    next.runtimeMode = patch.runtimeMode;
  }
  if (patch.interactionMode !== undefined && patch.interactionMode !== base.interactionMode) {
    next.interactionMode = patch.interactionMode;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** The defaults a settings change leaves behind for the next new thread. */
export function defaultsFromSettings(settings: ComposerSettings): ComposerSettingsDefaults {
  return {
    draftProviderInstanceId: settings.modelSelection.instanceId,
    draftModel: settings.modelSelection.model,
    draftRuntimeMode: settings.runtimeMode,
    draftInteractionMode: settings.interactionMode,
  };
}
