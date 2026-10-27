// @effect-diagnostics globalTimers:off -- The TUI runs on Bun outside the Effect runtime.
import { ThreadId, type ProjectId } from "@t3tools/contracts";

import type { ComposerAttachment, ComposerSend, UnconfirmedComposerSend } from "./composerSend.ts";
import {
  applySettingsPatch,
  defaultsFromSettings,
  normalizeSettingsPatch,
  type ComposerSettings,
  type ComposerSettingsDefaults,
  type ComposerSettingsPatch,
} from "./composerSettings.ts";
import type {
  PersistedComposerDraft,
  PersistedDraftThreadState,
  TuiPrefs,
  TuiPrefsPatch,
} from "./prefs.ts";

/**
 * Composer state that outlives a mounted composer: per-thread drafts, settings picked for a
 * thread's next run, new-thread drafts per project, and sends still on their way. Lives
 * outside React so typing never re-renders the thread view; a composer subscribes to its
 * own thread only.
 */

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<ComposerAttachment>;
  /** Why the text was put back; saved with it until the draft is edited or sent. */
  readonly notice?: string;
}

/**
 * `sending`: going out, or next in line. `waiting`: the connection dropped; it retries.
 * `held`: Stop held it until resumed or discarded. `stuck`: a command got no reply in time.
 */
export type ComposerSendStatus = "sending" | "waiting" | "held" | "stuck";

export interface ComposerSendEntry {
  readonly send: ComposerSend;
  readonly status: ComposerSendStatus;
  readonly attempt: number;
}

/** What one composer renders from; a new object only when this thread's state changes. */
export interface ComposerThreadSnapshot {
  readonly attachments: ReadonlyArray<ComposerAttachment>;
  readonly patch: ComposerSettingsPatch | undefined;
  readonly sends: ReadonlyArray<ComposerSendEntry>;
  /** Why the last send came back, until the next one. */
  readonly notice: string | null;
  /** Bumped when the store replaces the text (a restored send), so the textarea reloads it. */
  readonly textRevision: number;
}

export interface NewThreadDraft {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export interface ComposerStoreOptions {
  readonly initialPrefs: TuiPrefs;
  /** Null in windows that never save prefs; drafts then live in memory only. */
  readonly persist: ((patch: TuiPrefsPatch) => void) | null;
  readonly persistDelayMs?: number;
}

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };
const PERSIST_DELAY_MS = 300;

/** Saved records that look like ours; anything else in prefs.json is ignored. */
function readUnconfirmedSends(value: unknown): Array<UnconfirmedComposerSend> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry: unknown): entry is UnconfirmedComposerSend => {
    if (typeof entry !== "object" || entry === null) return false;
    const { threadId, projectId, launch, messageId, text, attachments } = entry as Record<
      string,
      unknown
    >;
    return (
      typeof threadId === "string" &&
      (projectId === undefined || typeof projectId === "string") &&
      typeof launch === "boolean" &&
      typeof messageId === "string" &&
      typeof text === "string" &&
      Array.isArray(attachments)
    );
  });
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

function readDraft(persisted: PersistedComposerDraft): ComposerDraft {
  return {
    ...(typeof persisted.notice === "string" ? { notice: persisted.notice } : {}),
    text: persisted.text ?? "",
    attachments: (persisted.attachments ?? []).map((attachment, index) => ({
      id: attachment.id ?? `restored-${index}-${attachment.name}`,
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
    })),
  };
}

function writeDraft(draft: ComposerDraft): PersistedComposerDraft {
  return {
    ...(draft.notice === undefined ? {} : { notice: draft.notice }),
    text: draft.text,
    attachments: draft.attachments.map((attachment) => ({
      id: attachment.id,
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
    })),
  };
}

/** Joins text a failed send hands back with whatever was typed since. */
export function mergeRestoredText(restored: string, current: string): string {
  if (current.trim().length === 0) return restored;
  if (restored.trim().length === 0) return current;
  return `${restored}\n\n${current}`;
}

export function createComposerStore(options: ComposerStoreOptions) {
  const { initialPrefs, persist } = options;
  const drafts = new Map<string, ComposerDraft>(
    Object.entries(initialPrefs.composerDraftsByThreadId ?? {}).map(([threadId, draft]) => [
      threadId,
      readDraft(draft),
    ]),
  );
  const newThreadDrafts = new Map<string, NewThreadDraft>(
    Object.values(initialPrefs.draftThreadsByProjectId ?? {}).map((draft) => [
      draft.projectId,
      { threadId: ThreadId.make(draft.id), projectId: draft.projectId as ProjectId },
    ]),
  );
  let defaults: ComposerSettingsDefaults = {
    ...(initialPrefs.draftProviderInstanceId === undefined
      ? {}
      : { draftProviderInstanceId: initialPrefs.draftProviderInstanceId }),
    ...(initialPrefs.draftModel === undefined ? {} : { draftModel: initialPrefs.draftModel }),
    ...(initialPrefs.draftRuntimeMode === undefined
      ? {}
      : { draftRuntimeMode: initialPrefs.draftRuntimeMode }),
    ...(initialPrefs.draftInteractionMode === undefined
      ? {}
      : { draftInteractionMode: initialPrefs.draftInteractionMode }),
  };
  const patches = new Map<string, ComposerSettingsPatch>();
  const sends = new Map<string, ReadonlyArray<ComposerSendEntry>>();
  const notices = new Map<string, string>(
    [...drafts].flatMap(([threadId, draft]) =>
      draft.notice === undefined ? [] : [[threadId, draft.notice] as const],
    ),
  );
  const textRevisions = new Map<string, number>();
  const snapshots = new Map<string, ComposerThreadSnapshot>();
  const threadListeners = new Map<string, Set<() => void>>();
  const globalListeners = new Set<() => void>();
  let globalVersion = 0;

  // Only the window that owns prefs.json checks these; it's the only one that saves them.
  let unconfirmed: ReadonlyArray<UnconfirmedComposerSend> =
    persist === null ? [] : readUnconfirmedSends(initialPrefs.composerUnconfirmedSends);

  /** Unconfirmed records whose thread and project are gone, this session. */
  const orphaned = new Set<UnconfirmedComposerSend>();

  const clean = { drafts: false, newThreads: false, defaults: false, unconfirmed: false };
  let dirty: Record<keyof typeof clean, boolean> = { ...clean };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (persist === null) return;
    const patch: { -readonly [Key in keyof TuiPrefsPatch]: TuiPrefsPatch[Key] } = {};
    if (dirty.drafts) {
      const entries = [...drafts].filter(([, draft]) => !isEmptyDraft(draft));
      patch.composerDraftsByThreadId =
        entries.length === 0
          ? undefined
          : Object.fromEntries(entries.map(([threadId, draft]) => [threadId, writeDraft(draft)]));
    }
    if (dirty.newThreads) {
      patch.draftThreadsByProjectId =
        newThreadDrafts.size === 0
          ? undefined
          : Object.fromEntries(
              [...newThreadDrafts.values()].map((draft): [string, PersistedDraftThreadState] => [
                draft.projectId,
                { id: draft.threadId, projectId: draft.projectId },
              ]),
            );
    }
    if (dirty.defaults) {
      patch.draftProviderInstanceId = defaults.draftProviderInstanceId;
      patch.draftModel = defaults.draftModel;
      patch.draftRuntimeMode = defaults.draftRuntimeMode;
      patch.draftInteractionMode = defaults.draftInteractionMode;
    }
    if (dirty.unconfirmed) {
      patch.composerUnconfirmedSends = unconfirmed.length === 0 ? undefined : unconfirmed;
    }
    const wrote = Object.values(dirty).some(Boolean);
    dirty = { ...clean };
    if (wrote) persist(patch);
  };

  const schedulePersist = (part: keyof typeof dirty) => {
    if (persist === null) return;
    dirty[part] = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, options.persistDelayMs ?? PERSIST_DELAY_MS);
  };

  const notifyThread = (threadId: string) => {
    snapshots.delete(threadId);
    for (const listener of threadListeners.get(threadId) ?? []) listener();
  };

  const notifyGlobal = () => {
    globalVersion += 1;
    for (const listener of globalListeners) listener();
  };

  const setDraft = (threadId: string, draft: ComposerDraft) => {
    if (isEmptyDraft(draft)) drafts.delete(threadId);
    else drafts.set(threadId, draft);
    schedulePersist("drafts");
  };

  /** The draft without its saved note: the user edited or sent it, or a newer note replaced it. */
  const dropDraftNotice = (threadId: string) => {
    const draft = drafts.get(threadId);
    if (draft?.notice === undefined) return;
    setDraft(threadId, { text: draft.text, attachments: draft.attachments });
  };

  /** Puts text and images back in front of whatever the composer holds, with why. */
  const restoreDraft = (threadId: string, restored: ComposerDraft, notice: string) => {
    const current = drafts.get(threadId) ?? EMPTY_DRAFT;
    setDraft(threadId, {
      text: mergeRestoredText(restored.text, current.text),
      attachments: [...restored.attachments, ...current.attachments],
      notice,
    });
    textRevisions.set(threadId, (textRevisions.get(threadId) ?? 0) + 1);
    notices.set(threadId, notice);
    notifyThread(threadId);
  };

  return {
    /** False in windows that never save prefs: Rex thread tabs and locked-out windows. */
    canPersist: persist !== null,

    /** Messages that went out unconfirmed before a quit, not yet checked against their thread. */
    unconfirmedSends: (): ReadonlyArray<UnconfirmedComposerSend> => unconfirmed,

    /** Quitting: saves messages that went out unconfirmed, next to any still unchecked. */
    addUnconfirmedSends(records: ReadonlyArray<UnconfirmedComposerSend>) {
      if (records.length === 0) return;
      unconfirmed = [...unconfirmed, ...records];
      schedulePersist("unconfirmed");
    },

    /** Checked against its thread: drops the record (call `flush` to write it with the draft). */
    removeUnconfirmedSend(record: UnconfirmedComposerSend) {
      unconfirmed = unconfirmed.filter((entry) => entry !== record);
      if (orphaned.delete(record)) notifyGlobal();
      schedulePersist("unconfirmed");
    },

    /** Records whose thread and project are gone, still saved until /recover takes them. */
    orphanedSends: (): ReadonlyArray<UnconfirmedComposerSend> =>
      unconfirmed.filter((record) => orphaned.has(record)),

    markOrphanedSend(record: UnconfirmedComposerSend) {
      if (!unconfirmed.includes(record) || orphaned.has(record)) return;
      orphaned.add(record);
      notifyGlobal();
    },

    getDraft: (threadId: string): ComposerDraft => drafts.get(threadId) ?? EMPTY_DRAFT,

    /** Text edits; silent, since the textarea already shows them. */
    setDraftText(threadId: string, text: string) {
      const current = drafts.get(threadId) ?? EMPTY_DRAFT;
      if (current.text === text) return;
      setDraft(threadId, { text, attachments: current.attachments });
    },

    addAttachment(threadId: string, attachment: ComposerAttachment) {
      const current = drafts.get(threadId) ?? EMPTY_DRAFT;
      setDraft(threadId, { text: current.text, attachments: [...current.attachments, attachment] });
      notifyThread(threadId);
    },

    removeLastAttachment(threadId: string) {
      const current = drafts.get(threadId) ?? EMPTY_DRAFT;
      if (current.attachments.length === 0) return;
      setDraft(threadId, { text: current.text, attachments: current.attachments.slice(0, -1) });
      notifyThread(threadId);
    },

    /** Empties the composer after a send leaves it, or on Ctrl+C. */
    clearDraft(threadId: string) {
      if (!drafts.has(threadId)) return;
      const hadAttachments = (drafts.get(threadId)?.attachments.length ?? 0) > 0;
      setDraft(threadId, EMPTY_DRAFT);
      if (hadAttachments) notifyThread(threadId);
    },

    getPatch: (threadId: string) => patches.get(threadId),

    /** Settings picked for this thread's next run; an undefined patch clears them. */
    setPatch(threadId: string, patch: ComposerSettingsPatch | undefined, picked: ComposerSettings) {
      if (patch === undefined) patches.delete(threadId);
      else patches.set(threadId, patch);
      defaults = defaultsFromSettings(picked);
      schedulePersist("defaults");
      notifyThread(threadId);
    },

    /**
     * A pick in the model picker or a mode toggle. A thread keeps it for its next run; a
     * new-thread draft has no thread yet, so the pick only becomes the new default.
     */
    pickSettings(
      threadId: string,
      scope: "thread" | "draft",
      base: ComposerSettings,
      patch: ComposerSettingsPatch,
    ): ComposerSettings {
      const merged = { ...patches.get(threadId), ...patch };
      const picked = applySettingsPatch(base, merged);
      if (scope === "thread") patches.set(threadId, normalizeSettingsPatch(base, merged) ?? {});
      if (scope === "thread" && Object.keys(patches.get(threadId) ?? {}).length === 0) {
        patches.delete(threadId);
      }
      defaults = defaultsFromSettings(picked);
      schedulePersist("defaults");
      notifyThread(threadId);
      notifyGlobal();
      return picked;
    },

    getDefaults: () => defaults,

    getNewThreadDraft: (projectId: string): NewThreadDraft | undefined =>
      newThreadDrafts.get(projectId),

    findNewThreadDraft: (threadId: string): NewThreadDraft | undefined =>
      [...newThreadDrafts.values()].find((draft) => draft.threadId === threadId),

    /** The project's open new-thread draft, or a fresh one. */
    openNewThreadDraft(projectId: ProjectId, mintThreadId: () => ThreadId): NewThreadDraft {
      const existing = newThreadDrafts.get(projectId);
      if (existing) return existing;
      const draft = { threadId: mintThreadId(), projectId };
      newThreadDrafts.set(projectId, draft);
      schedulePersist("newThreads");
      notifyGlobal();
      return draft;
    },

    /** The draft became a real thread; its text moved with the send. */
    closeNewThreadDraft(threadId: string) {
      const draft = [...newThreadDrafts.values()].find((entry) => entry.threadId === threadId);
      if (!draft) return;
      newThreadDrafts.delete(draft.projectId);
      schedulePersist("newThreads");
      notifyGlobal();
    },

    beginSend(send: ComposerSend) {
      const threadId = send.target.threadId;
      sends.set(threadId, [
        ...(sends.get(threadId) ?? []),
        { send, status: "sending", attempt: 0 },
      ]);
      notices.delete(threadId);
      dropDraftNotice(threadId);
      notifyThread(threadId);
    },

    updateSend(send: ComposerSend, status: ComposerSendStatus, attempt: number) {
      const threadId = send.target.threadId;
      const list = sends.get(threadId) ?? [];
      sends.set(
        threadId,
        list.map((entry) =>
          entry.send.commandId === send.commandId ? { send, status, attempt } : entry,
        ),
      );
      notifyThread(threadId);
    },

    finishSend(send: ComposerSend) {
      const threadId = send.target.threadId;
      const remaining = (sends.get(threadId) ?? []).filter(
        (entry) => entry.send.commandId !== send.commandId,
      );
      if (remaining.length === 0) sends.delete(threadId);
      else sends.set(threadId, remaining);
      notifyThread(threadId);
    },

    /** A send that came back: its text and images go back into the composer, with why. */
    restoreSend(send: ComposerSend, notice: string) {
      const threadId = send.target.threadId;
      const remaining = (sends.get(threadId) ?? []).filter(
        (entry) => entry.send.commandId !== send.commandId,
      );
      if (remaining.length === 0) sends.delete(threadId);
      else sends.set(threadId, remaining);
      restoreDraft(threadId, send, notice);
    },

    restoreDraft,

    setNotice(threadId: string, notice: string | null) {
      if ((notices.get(threadId) ?? null) === notice) return;
      dropDraftNotice(threadId);
      if (notice === null) notices.delete(threadId);
      else notices.set(threadId, notice);
      notifyThread(threadId);
    },

    snapshot(threadId: string): ComposerThreadSnapshot {
      const cached = snapshots.get(threadId);
      if (cached) return cached;
      const next: ComposerThreadSnapshot = {
        attachments: (drafts.get(threadId) ?? EMPTY_DRAFT).attachments,
        patch: patches.get(threadId),
        sends: sends.get(threadId) ?? [],
        notice: notices.get(threadId) ?? null,
        textRevision: textRevisions.get(threadId) ?? 0,
      };
      snapshots.set(threadId, next);
      return next;
    },

    subscribeThread(threadId: string, listener: () => void): () => void {
      let set = threadListeners.get(threadId);
      if (!set) {
        set = new Set();
        threadListeners.set(threadId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) threadListeners.delete(threadId);
      };
    },

    /** New-thread drafts opening or closing. */
    subscribe(listener: () => void): () => void {
      globalListeners.add(listener);
      return () => globalListeners.delete(listener);
    },
    version: () => globalVersion,

    /** Writes pending draft changes now, before the app exits. */
    flush,
  };
}

export type ComposerStore = ReturnType<typeof createComposerStore>;
