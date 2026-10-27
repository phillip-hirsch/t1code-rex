// @effect-diagnostics nodeBuiltinImport:off -- The composer reads clipboard images from disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { Atom } from "effect/reactivity";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

import { saveClipboardImageToFile } from "./clipboardImage.ts";
import { resolveComposerKey, type ComposerKeyState } from "./composerKeys.ts";
import {
  chooseDispatch,
  createComposerSend,
  type ComposerAttachment,
  type ComposerTarget,
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
  readonly clipboardDir: string;
  readonly onFocus: () => void;
  readonly onStop: () => void;
  readonly onExit: () => void;
  readonly onNewThread: () => void;
  readonly onOpenModelPicker: () => void;
  readonly onSetInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly onSetRuntimeMode: (mode: RuntimeMode | "next") => void;
  readonly onStatus: (message: string) => void;
  readonly ref?: Ref<ComposerHandle>;
}

function newId(): string {
  return NodeCrypto.randomUUID();
}

function decodePaste(event: PasteEvent): string {
  return new TextDecoder().decode(event.bytes);
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

  // A loaded draft (on mount, or after a send came back) continues where it ends.
  const attachTextarea = useCallback((node: TextareaRenderable | null) => {
    textareaRef.current = node;
    node?.gotoBufferEnd();
  }, []);

  const settings = baseSettings === null ? null : applySettingsPatch(baseSettings, snapshot.patch);
  const slashItems: ReadonlyArray<ComposerSlashCommand> =
    slashQuery === null ? [] : matchSlashCommands(slashQuery);
  const slashMenuOpen = props.focused && slashItems.length > 0;
  const attachments = snapshot.attachments;

  const readText = () => textareaRef.current?.plainText ?? "";
  const syncFromText = (text: string) => {
    setHasText(text.length > 0);
    const query = slashMenuQuery(text);
    setSlashQuery(query);
    if (query === null) setSlashIndex(0);
    const virtualRows = textareaRef.current?.virtualLineCount ?? 1;
    setRows(Math.min(MAX_ROWS, Math.max(MIN_ROWS, virtualRows)));
  };
  const replaceText = (text: string) => {
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
        }
      }
    }
    if (text.trim().length === 0 && attachments.length === 0) {
      // Like before, Enter on an empty composer stops a running turn.
      if (running && !stopRequested) props.onStop();
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
    void sender.send(
      createComposerSend({
        target,
        text,
        attachments,
        dispatch: chooseDispatch({
          running,
          alternate,
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

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      const text = readText();
      const state: ComposerKeyState = {
        hasText: text.length > 0,
        attachmentCount: attachments.length,
        running,
        stopRequested,
        slashMenuOpen,
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
      }
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
          ? "Queue a follow-up (Alt+Enter steers)"
          : "Ask for follow-up changes or attach images";
  const primary = running && !hasText && attachments.length === 0 ? "stop" : "send";

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {snapshot.sends.map((entry) => (
        <PendingSendRow key={entry.send.commandId} entry={entry} theme={theme} />
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
              onContentChange={() => {
                const text = readText();
                store.setDraftText(threadId, text);
                syncFromText(text);
                if (snapshot.notice !== null) store.setNotice(threadId, null);
              }}
              onPaste={(event: PasteEvent) => {
                const pasted = decodePaste(event);
                if (pasted.trim().length === 0) {
                  // Terminals paste nothing when the clipboard holds only an image.
                  event.preventDefault();
                  pasteClipboardImage();
                  return;
                }
                const imagePath = pastedImagePath(pasted);
                if (imagePath !== null) {
                  event.preventDefault();
                  void attachFromPath(imagePath, false).then((attached) => {
                    if (!attached) textareaRef.current?.insertText(pasted);
                  });
                }
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
            onPress={() => (primary === "stop" ? props.onStop() : submit(false))}
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
  variant: "send" | "stop";
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
        content={stop ? "■" : "↑"}
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

function PendingSendRow(props: { entry: ComposerSendEntry; theme: TuiTheme }) {
  const { entry, theme } = props;
  const palette = theme.palette;
  const flat = entry.send.text.replace(/\s+/gu, " ").trim();
  const preview = flat.length > PENDING_TEXT_MAX ? `${flat.slice(0, PENDING_TEXT_MAX - 1)}…` : flat;
  const images =
    entry.send.attachments.length > 0 ? ` +${entry.send.attachments.length} image` : "";
  const label =
    entry.status === "sending"
      ? entry.send.target.kind === "draft"
        ? "Starting thread…"
        : entry.send.dispatch === "queue"
          ? "Queueing…"
          : entry.send.dispatch === "steer"
            ? "Steering…"
            : "Sending…"
      : "Not sent yet; retrying when connected";
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <text
        wrapMode="none"
        content={`󰁝 ${label} `}
        style={{ fg: entry.status === "sending" ? palette.info : palette.warning, flexShrink: 0 }}
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
