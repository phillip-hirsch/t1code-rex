// @effect-diagnostics nodeBuiltinImport:off -- The TUI runs on Bun outside the Effect runtime.
import type { AppSettings } from "@t3tools/client-core";
import {
  type ProjectEntry,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { TuiPaths } from "./config.ts";
import type { TuiThemeId } from "./theme.ts";

export interface PersistedComposerImageAttachment {
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  readonly localPath?: string;
}

export interface PersistedComposerMention {
  readonly type: "path";
  readonly path: string;
  readonly kind: ProjectEntry["kind"];
  readonly parentPath?: string;
}

export interface PersistedComposerDraft {
  readonly text: string;
  readonly attachments: readonly PersistedComposerImageAttachment[];
  readonly mentions?: readonly PersistedComposerMention[];
}

export interface PersistedDraftThreadState {
  readonly id: string;
  readonly projectId: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly envMode?: "local" | "worktree";
}

export interface TuiPrefs {
  readonly tuiThemeId?: TuiThemeId;
  readonly selectedProjectId?: string;
  readonly selectedThreadId?: string;
  readonly expandedProjectIds?: readonly string[];
  readonly locallyUnreadThreadIds?: readonly string[];
  readonly threadLastVisitedAtById?: Readonly<Record<string, string>>;
  readonly draftThreadsByProjectId?: Readonly<Record<string, PersistedDraftThreadState>>;
  readonly composerDraftsByThreadId?: Readonly<Record<string, PersistedComposerDraft>>;
  readonly mainView?:
    | "thread"
    | "settings"
    | "keybindings"
    | "providers"
    | "source-control"
    | "scripts"
    | "connections"
    | "diagnostics"
    | "archive";
  readonly draftProviderInstanceId?: ProviderInstanceId;
  readonly draftModel?: string;
  readonly draftProviderOptionSelections?: readonly ProviderOptionSelection[];
  readonly draftRuntimeMode?: RuntimeMode;
  readonly draftInteractionMode?: "default" | "plan";
  readonly diffOpen?: boolean;
  readonly diffView?: "unified" | "split";
  readonly appSettings?: AppSettings;
}

export async function readPrefs(paths: TuiPaths): Promise<TuiPrefs> {
  try {
    const raw = await NodeFSP.readFile(paths.prefsPath, "utf8");
    const parsed = JSON.parse(raw) as TuiPrefs;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function writePrefs(paths: TuiPaths, prefs: TuiPrefs): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(paths.prefsPath), { recursive: true });
  // Write then rename, so a crash mid-write never leaves a truncated prefs.json.
  const temporaryPath = `${paths.prefsPath}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, JSON.stringify(prefs, null, 2));
  await NodeFSP.rename(temporaryPath, paths.prefsPath);
}

export type TuiPrefsPatch = { readonly [Key in keyof TuiPrefs]?: TuiPrefs[Key] | undefined };

/**
 * Rewrites only the given keys and keeps the rest of prefs.json, so a screen that owns a
 * few prefs never drops the others. An undefined value removes its key.
 */
export async function updatePrefs(paths: TuiPaths, patch: TuiPrefsPatch): Promise<TuiPrefs> {
  const next: Record<string, unknown> = { ...(await readPrefs(paths)) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const prefs = next as TuiPrefs;
  await writePrefs(paths, prefs);
  return prefs;
}

export interface PrefsWriter {
  /** Queues a patch; patches made while a write is running merge into the next one. */
  readonly write: (patch: TuiPrefsPatch) => void;
  /** Resolves once every queued patch is on disk. */
  readonly flush: () => Promise<void>;
}

/** Serializes prefs writes so overlapping updates never interleave or reorder. */
export function createPrefsWriter(paths: TuiPaths, onError: (error: unknown) => void): PrefsWriter {
  let pending: Record<string, unknown> | null = null;
  let running: Promise<void> | null = null;
  const drain = async () => {
    while (pending !== null) {
      const patch = pending as TuiPrefsPatch;
      pending = null;
      try {
        await updatePrefs(paths, patch);
      } catch (error) {
        onError(error);
      }
    }
    running = null;
  };
  return {
    write(patch) {
      pending = { ...pending, ...patch };
      running ??= drain();
    },
    flush: () => running ?? Promise.resolve(),
  };
}
