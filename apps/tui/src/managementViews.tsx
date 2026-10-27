import type { MouseEvent } from "@opentui/core";
import type { FilesystemBrowseEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { ArchivedThreadRow } from "./archivedThreads.ts";
import { currentStep, type ConfirmButton, type ConfirmDialogState } from "./confirmDialog.ts";
import type { PromptState } from "./management.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import type { TuiTheme } from "./theme.ts";
import { RELATIVE_TIME_TICKER, useTicker } from "./ticker.ts";

const DIALOG_WIDTH = 64;

function stop(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/** A full-screen layer that swallows clicks, with a centered panel. */
function Modal(props: {
  readonly theme: TuiTheme;
  readonly borderColor: string;
  readonly onDismiss: () => void;
  readonly width?: number;
  readonly children: ReactNode;
}) {
  const palette = props.theme.palette;
  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 260,
        alignItems: "center",
        paddingTop: 3,
      }}
      onMouseDown={(event: MouseEvent) => {
        stop(event);
        props.onDismiss();
      }}
    >
      <box
        style={{
          width: props.width ?? DIALOG_WIDTH,
          maxWidth: "90%",
          flexDirection: "column",
          backgroundColor: palette.popup,
          border: true,
          borderColor: props.borderColor,
          paddingLeft: 1,
          paddingRight: 1,
        }}
        onMouseDown={stop}
      >
        {props.children}
      </box>
    </box>
  );
}

function Button(props: {
  readonly theme: TuiTheme;
  readonly label: string;
  readonly focused: boolean;
  readonly destructive: boolean;
  readonly onPress: () => void;
}) {
  const palette = props.theme.palette;
  const background = props.focused
    ? props.destructive
      ? palette.composerStop
      : palette.selection
    : palette.controlActive;
  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        stop(event);
        props.onPress();
      }}
      style={{
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        marginLeft: 2,
        backgroundColor: background,
      }}
    >
      <text
        wrapMode="none"
        content={props.focused ? `› ${props.label}` : `  ${props.label}`}
        style={{ fg: props.focused ? palette.text : palette.muted }}
      />
    </box>
  );
}

export function ConfirmDialogView(props: {
  readonly state: ConfirmDialogState;
  readonly theme: TuiTheme;
  readonly onPress: (button: ConfirmButton) => void;
}) {
  const step = currentStep(props.state);
  if (step === null) return null;
  const palette = props.theme.palette;
  const stepLabel =
    props.state.steps.length > 1
      ? `Step ${props.state.stepIndex + 1} of ${props.state.steps.length}`
      : null;
  return (
    <Modal
      theme={props.theme}
      borderColor={step.destructive ? palette.composerStop : palette.accent}
      onDismiss={() => props.onPress("cancel")}
    >
      <text content={step.title} style={{ fg: palette.text, marginTop: 1 }} />
      {step.body ? <text content={step.body} style={{ fg: palette.muted, marginTop: 1 }} /> : null}
      <box style={{ flexDirection: "row", height: 1, marginTop: 1, marginBottom: 1 }}>
        <text
          wrapMode="none"
          content={stepLabel ?? "←→ choose  ⏎ select  esc cancel"}
          style={{ fg: palette.subtle, flexGrow: 1 }}
        />
        <Button
          theme={props.theme}
          label="Cancel"
          focused={props.state.focus === "cancel"}
          destructive={false}
          onPress={() => props.onPress("cancel")}
        />
        <Button
          theme={props.theme}
          label={step.confirmLabel}
          focused={props.state.focus === "confirm"}
          destructive={step.destructive}
          onPress={() => props.onPress("confirm")}
        />
      </box>
    </Modal>
  );
}

const PROMPT_TITLES: Record<
  PromptState["kind"],
  { title: string; hint: string; placeholder: string }
> = {
  "rename-thread": {
    title: "Rename thread",
    hint: "⏎ save  esc cancel",
    placeholder: "Thread title",
  },
  "rename-project": {
    title: "Rename project",
    hint: "⏎ save  esc cancel",
    placeholder: "Project name",
  },
  "add-project": {
    title: "Add project",
    hint: "⏎ add  tab complete  ↑↓ pick  esc cancel",
    placeholder: "~/src/project or ../other-repo",
  },
  clone: {
    title: "Clone repository",
    hint: "owner/repo or URL, then optionally a destination, https|ssh, provider=…  ⏎ clone",
    placeholder: "owner/repo",
  },
};

export function PromptDialogView(props: {
  readonly prompt: PromptState;
  readonly revision: number;
  readonly busy: boolean;
  readonly suggestions: ReadonlyArray<FilesystemBrowseEntry>;
  readonly suggestionIndex: number;
  readonly theme: TuiTheme;
  readonly onInput: (value: string) => void;
  readonly onPickSuggestion: (index: number) => void;
  readonly onCancel: () => void;
}) {
  const { prompt, theme } = props;
  const palette = theme.palette;
  const copy = PROMPT_TITLES[prompt.kind];
  return (
    <Modal theme={theme} borderColor={palette.accent} onDismiss={props.onCancel}>
      <box style={{ flexDirection: "row", height: 1, marginTop: 1 }}>
        <text wrapMode="none" content={copy.title} style={{ fg: palette.text, flexGrow: 1 }} />
        {props.busy ? (
          <text wrapMode="none" content="Working…" style={{ fg: palette.info }} />
        ) : null}
      </box>
      <box
        style={{
          marginTop: 1,
          height: 1,
          backgroundColor: palette.input,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <input
          key={`${prompt.kind}:${props.revision}`}
          focused={!props.busy}
          value={prompt.value}
          placeholder={copy.placeholder}
          cursorColor={palette.cursor}
          onInput={props.onInput}
          style={{
            backgroundColor: palette.input,
            focusedBackgroundColor: palette.input,
            textColor: palette.text,
            focusedTextColor: palette.text,
            placeholderColor: palette.subtle,
          }}
        />
      </box>
      {prompt.error ? (
        <text content={`󰀦 ${prompt.error}`} style={{ fg: palette.warning, marginTop: 1 }} />
      ) : null}
      {props.suggestions.length > 0 ? (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          {props.suggestions.map((entry, index) => (
            <box
              key={entry.fullPath}
              onMouseDown={(event: MouseEvent) => {
                stop(event);
                props.onPickSuggestion(index);
              }}
              style={{
                flexDirection: "row",
                height: 1,
                paddingLeft: 1,
                backgroundColor:
                  index === props.suggestionIndex ? palette.selection : palette.popup,
              }}
            >
              <text content="󰉋 " style={{ fg: palette.muted }} />
              <text
                wrapMode="none"
                truncate
                content={entry.fullPath}
                style={{ fg: palette.text }}
              />
            </box>
          ))}
        </box>
      ) : null}
      <text
        wrapMode="none"
        truncate
        content={copy.hint}
        style={{ fg: palette.subtle, marginTop: 1, marginBottom: 1 }}
      />
    </Modal>
  );
}

const ARCHIVE_ROWS_MAX = 14;

export function ArchivedThreadsView(props: {
  readonly rows: ReadonlyArray<ArchivedThreadRow>;
  readonly index: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly theme: TuiTheme;
  readonly onSelect: (index: number) => void;
  readonly onClose: () => void;
}) {
  const { rows, theme } = props;
  const palette = theme.palette;
  const { nowMs } = useTicker(RELATIVE_TIME_TICKER);
  const start = Math.max(
    0,
    Math.min(props.index - Math.floor(ARCHIVE_ROWS_MAX / 2), rows.length - ARCHIVE_ROWS_MAX),
  );
  const visible = rows.slice(start, start + ARCHIVE_ROWS_MAX);
  return (
    <Modal theme={theme} borderColor={palette.accent} onDismiss={props.onClose} width={76}>
      <box style={{ flexDirection: "row", height: 1, marginTop: 1, marginBottom: 1 }}>
        <text
          wrapMode="none"
          content="Archived threads"
          style={{ fg: palette.text, flexGrow: 1 }}
        />
        <text wrapMode="none" content={`${rows.length}`} style={{ fg: palette.subtle }} />
      </box>
      {props.error ? (
        <text content={`󰀦 ${props.error}`} style={{ fg: palette.warning }} />
      ) : rows.length === 0 ? (
        <text
          content={props.loading ? "Loading…" : "No archived threads"}
          style={{ fg: palette.muted }}
        />
      ) : (
        visible.map((row, offset) => {
          const index = start + offset;
          const selected = index === props.index;
          return (
            <box
              key={row.threadId}
              onMouseDown={(event: MouseEvent) => {
                stop(event);
                props.onSelect(index);
              }}
              style={{
                flexDirection: "row",
                height: 1,
                paddingLeft: 1,
                paddingRight: 1,
                backgroundColor: selected ? palette.selection : palette.popup,
              }}
            >
              <text
                wrapMode="none"
                truncate
                content={row.title}
                style={{ fg: selected ? palette.text : palette.muted, flexGrow: 1, flexShrink: 1 }}
              />
              <text
                wrapMode="none"
                content={`  ${row.projectTitle}  ${formatRelativeTime(row.archivedAt, nowMs).padStart(4)}`}
                style={{ fg: palette.subtle, flexShrink: 0 }}
              />
            </box>
          );
        })
      )}
      <text
        wrapMode="none"
        truncate
        content="↑↓ move  ⏎ restore  del delete  esc close"
        style={{ fg: palette.subtle, marginTop: 1, marginBottom: 1 }}
      />
    </Modal>
  );
}
