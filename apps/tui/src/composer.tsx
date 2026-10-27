// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The composer reads clipboard images from disk and debounces file search on Bun.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import {
  decodePasteBytes,
  stripAnsiSequences,
  type KeyEvent,
  type PasteEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectEntry,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

import { saveClipboardImageToFile } from "./clipboardImage.ts";
import { resolveComposerKey, type ComposerKeyState } from "./composerKeys.ts";
import {
  MENTION_SEARCH_DEBOUNCE_MS,
  MENTION_SEARCH_LIMIT,
  mentionQueryAt,
  mentionReplacement,
  type MentionQuery,
} from "./composerMentions.ts";
import { recoverOrphanedSends } from "./composerRecovery.ts";
import {
  chooseDispatch,
  createComposerSend,
  type ComposerAttachment,
  type ComposerDispatch,
  type ComposerTarget,
  type LaunchWorktree,
} from "./composerSend.ts";
import type { ComposerSender } from "./composerSender.ts";
import {
  applySettingsPatch,
  interactionModeIcon,
  interactionModeLabel,
  runtimeModeIcon,
  runtimeModeLabel,
  type ComposerSettings,
} from "./composerSettings.ts";
import {
  matchSlashCommands,
  resolveComposerSlashAction,
  slashMenuQuery,
  type ComposerSlashCommand,
} from "./composerSlashCommands.ts";
import type { ComposerSendEntry, ComposerStore } from "./composerStore.ts";
import { pastedImagePath, resolveImageAttachmentFromPath } from "./composerSubmit.ts";
import { truncateToolbarLabel } from "./composerControlLabels.ts";
import { cursorStringOffset, replaceBeforeCursor } from "./textareaOffsets.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

export interface ProviderBadge {
  readonly icon: string;
  readonly color: TuiColor;
}

const MIN_ROWS = 2;
const MAX_ROWS = 8;
const MODEL_LABEL_MAX = 24;
const PENDING_TEXT_MAX = 72;

export interface ComposerHandle {
  /** Keys while the composer has focus; true when it used the key. */
  readonly handleKey: (key: KeyEvent) => boolean;
  /** Types text at the cursor. */
  readonly insertText: (text: string) => void;
  /** A paste that arrived while another pane had focus; handled as if pasted here. */
  readonly paste: (event: PasteEvent) => void;
}

type MentionSearchAtom = Atom.Atom<AsyncResult.AsyncResult<ProjectSearchEntriesResult, unknown>>;

/** Where `@` mentions search: the thread's workspace, through `projects.searchEntries`. */
export interface ComposerMentionSearch {
  readonly cwd: string | null;
  readonly searchAtom: (input: ProjectSearchEntriesInput) => MentionSearchAtom;
}

const NO_MENTION_SEARCH: MentionSearchAtom = Atom.make(
  AsyncResult.initial<ProjectSearchEntriesResult, unknown>(),
);
const NO_ENTRIES: ReadonlyArray<ProjectEntry> = [];
/** For a composer with no workspace to search, e.g. in the Bun checks. */
export const NO_MENTION_SEARCH_SOURCE: ComposerMentionSearch = {
  cwd: null,
  searchAtom: () => NO_MENTION_SEARCH,
};

export interface ComposerGitCommands {
  readonly openMenu: () => void;
  readonly openBranchPicker: (query: string) => void;
  readonly toggleWorktree: () => void;
  /** The new worktree a draft's first send makes; undefined launches it locally. */
  readonly launchWorktree: () => LaunchWorktree | undefined;
}

export interface ComposerProps {
  readonly target: ComposerTarget;
  readonly store: ComposerStore;
  readonly sender: ComposerSender;
  readonly theme: TuiTheme;
  readonly focused: boolean;
  /** Null until the server lists a provider a run can use. */
  readonly baseSettings: ComposerSettings | null;
  readonly modelLabel: (settings: ComposerSettings) => string;
  readonly providerBadge: (settings: ComposerSettings) => ProviderBadge;
  readonly running: boolean;
  readonly stopRequested: boolean;
  /** What Enter does while a run is busy; the alternate key does the other. */
  readonly followUpBehavior: ComposerDispatch;
  readonly clipboardDir: string;
  readonly onFocus: () => void;
  readonly onStop: () => void;
  readonly onExit: () => void;
  readonly onNewThread: () => void;
  readonly onOpenModelPicker: () => void;
  readonly onSetInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly onSetRuntimeMode: (mode: RuntimeMode | "next") => void;
  readonly onStatus: (message: string) => void;
  /** `/clone`: returns the error to show, or null once the clone started. */
  readonly onClone: (args: string) => Promise<string | null>;
  /** `/diff`, where the window has a diff panel. */
  readonly onToggleDiff?: () => void;
  /** `/git`, `/branch` and `/worktree`, where the window has the branch toolbar. */
  readonly git?: ComposerGitCommands;
  readonly mentionSearch: ComposerMentionSearch;
  readonly ref?: Ref<ComposerHandle>;
}

function newId(): string {
  return NodeCrypto.randomUUID();
}

function decodePaste(event: PasteEvent): string {
  return decodePasteBytes(event.bytes);
}

/**
 * The message box under the thread. The textarea owns its text while mounted, so a
 * keystroke re-renders only this component, and only when something it shows changes.
 */
export function Composer(props: ComposerProps) {
  const { target, store, sender, theme, baseSettings, running, stopRequested, ref } = props;
  const palette = theme.palette;
  const threadId = target.threadId;
  const snapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => store.subscribeThread(threadId, listener),
      [store, threadId],
    ),
    () => store.snapshot(threadId),
  );
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const initialText = store.getDraft(threadId).text;
  const [hasText, setHasText] = useState(initialText.length > 0);
  const [slashQuery, setSlashQuery] = useState<string | null>(() => slashMenuQuery(initialText));
  const [slashIndex, setSlashIndex] = useState(0);
  const [rows, setRows] = useState(MIN_ROWS);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [width, setWidth] = useState(0);
  // The `@query` the cursor ends, the query searched after a pause, and the picked row.
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    const timer = setTimeout(() => setSearchedQuery(mentionQuery), MENTION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mentionQuery]);
  const mentionCwd = props.mentionSearch.cwd;
  const searchAtom: MentionSearchAtom =
    mentionCwd !== null && searchedQuery !== null && searchedQuery.length > 0
      ? props.mentionSearch.searchAtom({
          cwd: mentionCwd,
          query: searchedQuery,
          limit: MENTION_SEARCH_LIMIT,
        })
      : NO_MENTION_SEARCH;
  const searchResult = useAtomValue(searchAtom);
  const mentionEntries =
    mentionQuery !== null && mentionQuery === searchedQuery
      ? (Option.getOrNull(AsyncResult.value(searchResult))?.entries ?? NO_ENTRIES)
      : NO_ENTRIES;

  // A loaded draft (on mount, or after a send came back) continues where it ends.
  const attachTextarea = useCallback((node: TextareaRenderable | null) => {
    textareaRef.current = node;
    node?.gotoBufferEnd();
  }, []);

  const settings = baseSettings === null ? null : applySettingsPatch(baseSettings, snapshot.patch);
  const slashItems: ReadonlyArray<ComposerSlashCommand> =
    slashQuery === null ? [] : matchSlashCommands(slashQuery);
  const slashMenuOpen = props.focused && slashItems.length > 0;
  const mentionActive =
    props.focused && mention !== null && dismissedMention !== mention.query && mentionCwd !== null;
  const mentionMenuOpen = mentionActive && mentionEntries.length > 0;
  const attachments = snapshot.attachments;

  const heldCount = snapshot.sends.filter((entry) => entry.status === "held").length;
  /** What the send button shows, and what Enter on an empty composer does. */
  const primary =
    hasText || attachments.length > 0
      ? "send"
      : running
        ? "stop"
        : heldCount > 0
          ? "resume"
          : "send";

  const resumeHeld = () => {
    const pending = sender.resume(threadId);
    if (pending > 0) props.onStatus(`Sending ${pending} held message${pending === 1 ? "" : "s"}`);
    return pending;
  };

  const readText = () => textareaRef.current?.plainText ?? "";
  /** The `@query` before the cursor; picking an entry replaces it. */
  const syncMention = (text: string) => {
    const textarea = textareaRef.current;
    const next = mentionQueryAt(text, textarea ? cursorStringOffset(textarea) : text.length);
    setMention((current) =>
      current?.query === next?.query && current?.length === next?.length ? current : next,
    );
    if (next === null) setDismissedMention(null);
    setMentionIndex(0);
  };
  const syncFromText = (text: string) => {
    setHasText(text.length > 0);
    const query = slashMenuQuery(text);
    setSlashQuery(query);
    if (query === null) setSlashIndex(0);
    syncMention(text);
    const virtualRows = textareaRef.current?.virtualLineCount ?? 1;
    setRows(Math.min(MAX_ROWS, Math.max(MIN_ROWS, virtualRows)));
  };
  /** Text we just set ourselves; its change event mustn't overwrite the store again. */
  const setByUs = useRef<string | null>(null);
  const replaceText = (text: string) => {
    setByUs.current = text;
    textareaRef.current?.setText(text);
    textareaRef.current?.gotoBufferEnd();
    store.setDraftText(threadId, text);
    syncFromText(text);
  };

  const addAttachment = (attachment: ComposerAttachment) => {
    if (attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      store.setNotice(threadId, `${attachment.name} is larger than 10 MB`);
      return;
    }
    store.addAttachment(threadId, attachment);
    store.setNotice(threadId, null);
  };

  const attachFromPath = async (filePath: string, removeAfter: boolean) => {
    const resolved = await resolveImageAttachmentFromPath({ filePath, homeDir: NodeOS.homedir() });
    if (removeAfter) await NodeFSP.rm(filePath, { force: true });
    if (resolved === null) return false;
    addAttachment({
      id: newId(),
      type: "image",
      name: resolved.name,
      mimeType: resolved.mimeType,
      sizeBytes: resolved.sizeBytes,
      dataUrl: resolved.dataUrl,
    });
    return true;
  };

  const pasteClipboardImage = () => {
    if (pasting) return;
    setPasting(true);
    saveClipboardImageToFile(props.clipboardDir)
      .then(async (filePath) => {
        if (filePath === null) {
          props.onStatus("No image on the clipboard");
          return;
        }
        await attachFromPath(filePath, true);
      })
      .catch((error: unknown) =>
        props.onStatus(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setPasting(false));
  };

  /**
   * Pastes that attach an image: an empty paste (terminals paste nothing when the clipboard
   * holds only an image) or an image's path. Returns false for text, which the textarea takes.
   */
  const takeImagePaste = (pasted: string): boolean => {
    if (pasted.trim().length === 0) {
      pasteClipboardImage();
      return true;
    }
    const imagePath = pastedImagePath(pasted);
    if (imagePath === null) return false;
    void attachFromPath(imagePath, false).then((attached) => {
      if (!attached) textareaRef.current?.insertText(pasted);
    });
    return true;
  };

  const submit = (
    alternate: boolean,
    requested?: { dispatch: "queue" | "steer"; text: string },
  ) => {
    const raw = requested?.text ?? readText();
    const text = raw.replace(/\s+$/u, "");
    // Commands run even with images attached; the images stay for the next message.
    if (requested === undefined) {
      const action = resolveComposerSlashAction(text);
      if (action !== null) {
        if (action.type === "error") {
          store.setNotice(threadId, action.message);
          return;
        }
        replaceText("");
        switch (action.type) {
          case "new-thread":
            props.onNewThread();
            return;
          case "open-model-picker":
            props.onOpenModelPicker();
            return;
          case "set-interaction-mode":
            props.onSetInteractionMode(action.mode);
            return;
          case "set-runtime-mode":
            props.onSetRuntimeMode(action.mode);
            return;
          case "send":
            submit(false, { dispatch: action.dispatch, text: action.text });
            return;
          case "resume":
            // A draft has no thread whose queue the server could hold.
            if (target.kind === "draft" && snapshot.sends.length === 0) {
              props.onStatus("Nothing to resume");
              return;
            }
            // Sends what's held here, after a `queue.resume`; with nothing here, just that.
            if (resumeHeld() === 0) props.onStatus("Resuming the thread's queue");
            return;
          case "recover": {
            const recovered = recoverOrphanedSends(store, threadId);
            props.onStatus(
              recovered === 0
                ? "Nothing to recover"
                : `${recovered} unsent message${recovered === 1 ? "" : "s"} back in the composer`,
            );
            return;
          }
          case "toggle-diff":
            if (props.onToggleDiff) props.onToggleDiff();
            else props.onStatus("No diff here");
            return;
          case "git-menu":
            if (props.git) props.git.openMenu();
            else props.onStatus("No git here");
            return;
          case "branch-picker":
            if (props.git) props.git.openBranchPicker(action.query);
            else props.onStatus("No git here");
            return;
          case "toggle-worktree":
            if (props.git) props.git.toggleWorktree();
            else props.onStatus("No git here");
            return;
          case "clone":
            props.onStatus("Starting clone…");
            void props.onClone(action.args).then((error) => {
              if (error !== null) {
                store.setNotice(threadId, error);
                if (readText().length === 0) replaceText(text);
              }
            });
            return;
          case "discard": {
            const { messages, resumes } = sender.discard(threadId);
            props.onStatus(
              messages > 0
                ? `${messages} unsent message${messages === 1 ? "" : "s"} back in the composer`
                : resumes > 0
                  ? "Stopped resuming the queue"
                  : "No unsent messages",
            );
            return;
          }
        }
      }
    }
    // The draft's images as of now, not as of the last render: the second of two quick
    // Enters must find them already sent.
    const draftAttachments = store.getDraft(threadId).attachments;
    if (text.trim().length === 0 && draftAttachments.length === 0) {
      // Like before, Enter on an empty composer stops a running turn, but only one that
      // showed empty; a second quick Enter after a send must not stop the run. Once the
      // run stopped, it sends what Stop held, like upstream's "Resume thread" button.
      if (primary === "stop" && !stopRequested) props.onStop();
      if (primary === "resume") resumeHeld();
      return;
    }
    if (pasting) {
      props.onStatus("Wait for the image to attach");
      return;
    }
    if (settings === null) {
      store.setNotice(threadId, "No provider is ready yet");
      return;
    }
    const worktree = target.kind === "draft" ? props.git?.launchWorktree() : undefined;
    void sender.send(
      createComposerSend({
        target,
        ...(worktree === undefined ? {} : { worktree }),
        text,
        attachments: draftAttachments,
        dispatch: chooseDispatch({
          alternate,
          followUpBehavior: props.followUpBehavior,
          ...(requested === undefined ? {} : { requested: requested.dispatch }),
        }),
        settings,
      }),
    );
    store.clearDraft(threadId);
    if (requested === undefined) replaceText("");
    setRemoveArmed(false);
  };

  const completeSlash = () => {
    const item = slashItems[slashIndex] ?? slashItems[0];
    if (item) replaceText(item.template);
  };

  /** Replaces the `@query` before the cursor with the entry's file link, as web does. */
  const pickMention = () => {
    const entry = mentionEntries[mentionIndex] ?? mentionEntries[0];
    const textarea = textareaRef.current;
    if (!entry || !textarea || mention === null) return;
    replaceBeforeCursor(textarea, mention.length, mentionReplacement(entry.path));
  };

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      const text = readText();
      const state: ComposerKeyState = {
        hasText: text.length > 0,
        attachmentCount: attachments.length,
        running,
        stopRequested,
        slashMenuOpen,
        mentionActive,
        mentionMenuOpen,
        slashMenuCompletes:
          slashMenuOpen &&
          resolveComposerSlashAction(text) === null &&
          (slashItems[slashIndex] ?? slashItems[0])?.template !== text,
        removeArmed,
      };
      const action = resolveComposerKey(key, state);
      if (removeArmed && action?.type !== "remove-attachment") setRemoveArmed(false);
      if (action === null) return false;
      switch (action.type) {
        case "submit":
          submit(action.alternate);
          return true;
        case "stop":
          props.onStop();
          return true;
        case "clear":
          replaceText("");
          store.clearDraft(threadId);
          return true;
        case "exit":
          props.onExit();
          return true;
        case "ignore":
          return true;
        case "paste-image":
          pasteClipboardImage();
          return true;
        case "arm-remove-attachment":
          setRemoveArmed(true);
          props.onStatus("Press backspace again to remove the last image");
          return true;
        case "remove-attachment":
          setRemoveArmed(false);
          store.removeLastAttachment(threadId);
          return true;
        case "slash-move":
          setSlashIndex((index) =>
            Math.min(Math.max(0, index + action.delta), Math.max(0, slashItems.length - 1)),
          );
          return true;
        case "slash-complete":
          completeSlash();
          return true;
        case "mention-move":
          setMentionIndex((index) =>
            Math.min(Math.max(0, index + action.delta), Math.max(0, mentionEntries.length - 1)),
          );
          return true;
        case "mention-pick":
          pickMention();
          return true;
        case "mention-dismiss":
          setDismissedMention(mention?.query ?? null);
          return true;
      }
    },
    insertText: (text: string) => textareaRef.current?.insertText(text),
    paste: (event: PasteEvent) => {
      const pasted = decodePaste(event);
      // As the textarea pastes text itself.
      if (!takeImagePaste(pasted)) textareaRef.current?.insertText(stripAnsiSequences(pasted));
    },
  }));

  const borderColor = props.focused ? palette.composerBorder : palette.composerBorderMuted;
  const placeholder = pasting
    ? "Attaching clipboard image…"
    : attachments.length > 0
      ? "Add a message"
      : target.kind === "draft"
        ? "Start a new thread with a prompt"
        : running
          ? props.followUpBehavior === "steer"
            ? "Steer the run (⌘Enter or Alt+Enter queues)"
            : "Queue a follow-up (⌘Enter or Alt+Enter steers)"
          : heldCount > 0
            ? "Enter sends held messages; /discard edits them"
            : "Ask for follow-up changes or attach images";

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {snapshot.sends.map((entry) => (
        <PendingSendRow key={entry.send.commandId} entry={entry} running={running} theme={theme} />
      ))}
      {snapshot.notice ? (
        <text
          wrapMode="none"
          truncate
          content={`󰀦 ${snapshot.notice}`}
          style={{ fg: theme.colors.workEntryErrorAccent, flexShrink: 0 }}
        />
      ) : null}
      {slashMenuOpen ? <SlashMenu items={slashItems} index={slashIndex} theme={theme} /> : null}
      {mentionActive ? (
        <MentionMenu
          entries={mentionEntries}
          index={mentionIndex}
          searching={
            mention.query.length === 0
              ? null
              : searchResult.waiting || mention.query !== searchedQuery
          }
          theme={theme}
        />
      ) : null}
      <box
        onMouseDown={props.onFocus}
        onSizeChange={function (this: { width: number }) {
          setWidth(this.width);
        }}
        style={{
          marginTop: 1,
          border: true,
          borderStyle: "rounded",
          borderColor,
          backgroundColor: palette.composerPanel,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        {attachments.length > 0 ? (
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            {attachments.map((attachment, index) => (
              <AttachmentPill
                key={attachment.id}
                label={removeArmed && index === attachments.length - 1 ? "󰋩 Remove?" : "󰋩 Image"}
                toneIndex={index}
                theme={theme}
              />
            ))}
          </box>
        ) : null}
        <box style={{ flexDirection: "row", height: rows }}>
          <box style={{ flexGrow: 1, minWidth: 0, height: rows }}>
            <textarea
              key={`${threadId}:${snapshot.textRevision}`}
              ref={attachTextarea}
              focused={props.focused}
              initialValue={initialText}
              placeholder={placeholder}
              cursorColor={palette.cursor}
              keyBindings={[
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", action: "newline" },
              ]}
              onCursorChange={() => syncMention(readText())}
              onContentChange={() => {
                const text = readText();
                // Our own setText can report late, after the store moved on (a /discard
                // restores right after clearing); mounting reports the saved text too.
                const echo = text === setByUs.current;
                setByUs.current = null;
                syncFromText(text);
                if (echo || text === store.getDraft(threadId).text) return;
                store.setDraftText(threadId, text);
                store.setNotice(threadId, null);
              }}
              onPaste={(event: PasteEvent) => {
                if (takeImagePaste(decodePaste(event))) event.preventDefault();
              }}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                height: rows,
                backgroundColor: palette.composerPanel,
                focusedBackgroundColor: palette.composerPanel,
                textColor: palette.text,
                focusedTextColor: palette.text,
                placeholderColor: palette.subtle,
              }}
            />
          </box>
        </box>
        <box style={{ flexDirection: "row", height: 1, alignItems: "center" }}>
          {settings ? (
            <ComposerControls
              width={width}
              settings={settings}
              modelLabel={props.modelLabel(settings)}
              badge={props.providerBadge(settings)}
              theme={theme}
              onModel={props.onOpenModelPicker}
              onInteraction={() =>
                props.onSetInteractionMode(settings.interactionMode === "plan" ? "default" : "plan")
              }
              onRuntime={() => props.onSetRuntimeMode("next")}
            />
          ) : (
            <text content="Waiting for providers…" style={{ fg: palette.subtle }} />
          )}
          <box style={{ flexGrow: 1 }} />
          <SendButton
            variant={primary}
            disabled={pasting || (primary === "send" && !hasText && attachments.length === 0)}
            theme={theme}
            onPress={() =>
              primary === "stop"
                ? props.onStop()
                : primary === "resume"
                  ? resumeHeld()
                  : submit(false)
            }
          />
        </box>
      </box>
    </box>
  );
}

/** Room for the toolbar: mode labels go first, then the model label shortens. */
function toolbarLabels(width: number, model: string, modes: ReadonlyArray<string>) {
  // Each button pads 2 and keeps a gap; dividers take 2; borders, padding and send take 7.
  const room = width - 7 - modes.length * 2;
  const full = model.length + 4 + modes.reduce((sum, label) => sum + label.length + 4, 0);
  if (width === 0 || full <= room) return { model, showModes: true };
  const iconsOnly = modes.length * 4;
  return {
    model: truncateToolbarLabel(model, Math.max(4, room - iconsOnly - 4)),
    showModes: false,
  };
}

function ComposerControls(props: {
  width: number;
  settings: ComposerSettings;
  modelLabel: string;
  badge: ProviderBadge;
  theme: TuiTheme;
  onModel: () => void;
  onInteraction: () => void;
  onRuntime: () => void;
}) {
  const { settings, theme } = props;
  const interaction = interactionModeLabel(settings.interactionMode);
  const runtime = runtimeModeLabel(settings.runtimeMode);
  const labels = toolbarLabels(
    props.width,
    truncateToolbarLabel(props.modelLabel, MODEL_LABEL_MAX),
    [interaction, runtime],
  );
  const plan = settings.interactionMode === "plan";
  return (
    <box
      style={{ flexDirection: "row", flexShrink: 1, minWidth: 0, overflow: "hidden", height: 1 }}
    >
      <ToolbarButton
        icon={props.badge.icon}
        iconColor={props.badge.color}
        label={labels.model}
        theme={theme}
        onPress={props.onModel}
      />
      <Divider theme={theme} />
      <ToolbarButton
        icon={interactionModeIcon(settings.interactionMode)}
        label={labels.showModes ? interaction : null}
        active={plan}
        theme={theme}
        onPress={props.onInteraction}
      />
      <Divider theme={theme} />
      <ToolbarButton
        icon={runtimeModeIcon(settings.runtimeMode)}
        label={labels.showModes ? runtime : null}
        active={settings.runtimeMode === "approval-required"}
        theme={theme}
        onPress={props.onRuntime}
      />
    </box>
  );
}

function Divider(props: { theme: TuiTheme }) {
  return (
    <text content="│" style={{ fg: props.theme.palette.border, marginRight: 1, flexShrink: 0 }} />
  );
}

function ToolbarButton(props: {
  icon: string;
  iconColor?: TuiColor;
  label: string | null;
  active?: boolean;
  theme: TuiTheme;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const palette = props.theme.palette;
  const foreground = props.active ? palette.text : palette.muted;
  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPress();
      }}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        marginRight: 1,
        height: 1,
        backgroundColor: props.active
          ? palette.controlActive
          : hovered
            ? palette.controlHover
            : palette.control,
      }}
    >
      <text
        content={props.icon}
        style={{ fg: props.iconColor ?? foreground, marginRight: props.label === null ? 0 : 1 }}
      />
      {props.label === null ? null : (
        <text wrapMode="none" content={props.label} style={{ fg: foreground }} />
      )}
    </box>
  );
}

function SendButton(props: {
  variant: "send" | "stop" | "resume";
  disabled: boolean;
  theme: TuiTheme;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const palette = props.theme.palette;
  const stop = props.variant === "stop";
  const background = props.disabled
    ? palette.controlActive
    : stop
      ? hovered
        ? palette.composerStopHover
        : palette.composerStop
      : hovered
        ? palette.composerSendHover
        : palette.composerSend;
  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!props.disabled) props.onPress();
      }}
      style={{
        width: 3,
        height: 1,
        flexShrink: 0,
        justifyContent: "center",
        backgroundColor: background,
      }}
    >
      <text
        content={stop ? "■" : props.variant === "resume" ? "▶" : "↑"}
        style={{
          fg: props.disabled ? palette.subtle : props.theme.colors.primaryButtonText,
        }}
      />
    </box>
  );
}

function AttachmentPill(props: { label: string; toneIndex: number; theme: TuiTheme }) {
  const tones = props.theme.attachmentPillTones;
  const tone = tones[props.toneIndex % tones.length] ?? tones[0];
  return (
    <box
      style={{
        backgroundColor: tone?.backgroundColor ?? props.theme.palette.surfaceInfo,
        paddingLeft: 1,
        paddingRight: 1,
        marginRight: 1,
        height: 1,
        flexShrink: 0,
      }}
    >
      <text
        wrapMode="none"
        content={props.label}
        style={{ fg: tone?.textColor ?? props.theme.palette.info }}
      />
    </box>
  );
}

function SlashMenu(props: {
  items: ReadonlyArray<ComposerSlashCommand>;
  index: number;
  theme: TuiTheme;
}) {
  const palette = props.theme.palette;
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
        backgroundColor: palette.popup,
        border: true,
        borderColor: palette.border,
      }}
    >
      {props.items.map((item, index) => (
        <box
          key={item.command}
          style={{
            flexDirection: "row",
            height: 1,
            paddingLeft: 1,
            backgroundColor: index === props.index ? palette.selection : palette.popup,
          }}
        >
          <text wrapMode="none" content={item.usage.padEnd(30)} style={{ fg: palette.text }} />
          <text
            wrapMode="none"
            truncate
            content={item.description}
            style={{ fg: palette.subtle }}
          />
        </box>
      ))}
    </box>
  );
}

function MentionMenu(props: {
  entries: ReadonlyArray<ProjectEntry>;
  index: number;
  /** Null before anything is typed after the `@`. */
  searching: boolean | null;
  theme: TuiTheme;
}) {
  const palette = props.theme.palette;
  const note =
    props.searching === null
      ? "Type to search files and folders"
      : props.entries.length === 0
        ? props.searching
          ? "Searching…"
          : "No matching files"
        : null;
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
        backgroundColor: palette.popup,
        border: true,
        borderColor: palette.border,
      }}
    >
      {note !== null ? (
        <text wrapMode="none" content={` ${note}`} style={{ fg: palette.subtle }} />
      ) : (
        props.entries.map((entry, index) => (
          <box
            key={entry.path}
            style={{
              flexDirection: "row",
              height: 1,
              paddingLeft: 1,
              backgroundColor: index === props.index ? palette.selection : palette.popup,
            }}
          >
            <text
              content={entry.kind === "directory" ? "󰉋 " : "󰈔 "}
              style={{ fg: palette.muted, flexShrink: 0 }}
            />
            <text wrapMode="none" truncate content={entry.path} style={{ fg: palette.text }} />
          </box>
        ))
      )}
    </box>
  );
}

function PendingSendRow(props: { entry: ComposerSendEntry; running: boolean; theme: TuiTheme }) {
  const { entry, running, theme } = props;
  const palette = theme.palette;
  const flat = entry.send.text.replace(/\s+/gu, " ").trim();
  const preview = flat.length > PENDING_TEXT_MAX ? `${flat.slice(0, PENDING_TEXT_MAX - 1)}…` : flat;
  const images =
    entry.send.attachments.length > 0 ? ` +${entry.send.attachments.length} image` : "";
  const label =
    entry.status === "sending"
      ? entry.send.target.kind === "draft"
        ? "Starting thread…"
        : !running
          ? "Sending…"
          : entry.send.dispatch === "steer"
            ? "Steering…"
            : "Queueing…"
      : entry.status === "held"
        ? "Held after Stop:"
        : entry.status === "stuck"
          ? "No reply (/resume retries, /discard edits):"
          : "Not sent yet; retrying when connected";
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <text
        wrapMode="none"
        content={`${entry.status === "held" ? "󰏤" : "󰁝"} ${label} `}
        style={{
          fg:
            entry.status === "sending"
              ? palette.info
              : entry.status === "held"
                ? palette.subtle
                : palette.warning,
          flexShrink: 0,
        }}
      />
      <text
        wrapMode="none"
        truncate
        content={`${preview}${images}`}
        style={{ fg: palette.muted }}
      />
    </box>
  );
}

const QUEUED_ROWS_MAX = 3;

/**
 * Messages waiting behind the running turn. They aren't timeline items until they start,
 * so without this a queued send would seem to vanish. Editing the queue comes later.
 */
export function QueuedMessages(props: {
  readonly queueAtom: Atom.Atom<ThreadQueueWorkflowState | null>;
  readonly theme: TuiTheme;
}) {
  const queue = useAtomValue(props.queueAtom);
  const palette = props.theme.palette;
  const queued = queue?.queuedRuns ?? [];
  if (queued.length === 0) return null;
  const hidden = queued.length - QUEUED_ROWS_MAX;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      {queued.slice(0, QUEUED_ROWS_MAX).map((entry, index) => (
        <box key={entry.run.id} style={{ flexDirection: "row", height: 1 }}>
          <text
            wrapMode="none"
            content={index === 0 && queue?.isHeld ? "󰏤 Queued, held after Stop: " : "󰒲 Queued: "}
            style={{ fg: palette.subtle, flexShrink: 0 }}
          />
          <text
            wrapMode="none"
            truncate
            content={entry.text.replace(/\s+/gu, " ").trim()}
            style={{ fg: palette.muted }}
          />
        </box>
      ))}
      {hidden > 0 ? <text content={`  and ${hidden} more`} style={{ fg: palette.subtle }} /> : null}
    </box>
  );
}
