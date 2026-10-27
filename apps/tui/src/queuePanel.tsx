import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import type { RunId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import type { QueueController } from "./queueController.ts";
import { QUEUE_EDIT_KEY_HINTS, resolveQueueKey } from "./queueKeys.ts";
import { queueRowActions, type QueueRow, type QueueView } from "./queueView.ts";
import type { TuiTheme } from "./theme.ts";

export interface QueuePanelHandle {
  /** Keys while the list has focus; true when it used the key. */
  readonly handleKey: (key: KeyEvent) => boolean;
  /** Upstream's `thread.steerQueuedMessage`: sends or steers the first queued message. */
  readonly sendFirst: (repeat: boolean) => boolean;
  /** Upstream's `thread.editQueuedMessage`: opens the last queued message in the editor. */
  readonly editLast: (repeat: boolean) => boolean;
}

export interface QueuePanelProps {
  readonly threadId: ThreadId;
  readonly viewAtom: Atom.Atom<QueueView | null>;
  readonly controller: QueueController;
  readonly theme: TuiTheme;
  readonly focused: boolean;
  readonly onFocus: () => void;
  /** Esc: focus goes back to the composer. */
  readonly onLeave: () => void;
  /** Text typed while the list has focus goes to the composer. */
  readonly onType: (text: string) => void;
  /** Whether the list is in view, for the shell's focus order. */
  readonly onShown: (shown: boolean) => void;
  readonly onHints: (hints: string) => void;
  readonly ref?: Ref<QueuePanelHandle>;
}

/** Rows in view at once; the window follows the selection. */
const VISIBLE_ROWS = 4;
const EDITOR_ROWS_MAX = 5;
const NO_VIEW: QueueView = {
  rows: [],
  holdReason: null,
  activeRunId: null,
  canReorder: false,
  canSendNow: false,
  canPromoteToSteer: false,
};

/** "Steer" while a run takes steers, "send now" while nothing runs, as web's button. */
function sendLabel(view: QueueView): string {
  return view.canSendNow ? "send now" : "steer";
}

/**
 * Upstream's "Up next" list: the messages the server queued for the thread, held or not,
 * with web's actions on the selected one. Only this list reads the queue, so a queue change
 * never re-renders the transcript.
 */
export function QueuePanel(props: QueuePanelProps) {
  const { threadId, viewAtom, controller, focused, theme, ref } = props;
  const { onFocus, onLeave, onType, onShown, onHints } = props;
  const palette = theme.palette;
  const view = useAtomValue(viewAtom) ?? NO_VIEW;
  const edit = useAtomValue(controller.editsAtom)[threadId] ?? null;
  const saving = useAtomValue(controller.savingAtom)[threadId] === true;
  const busyRunId = useAtomValue(controller.busyAtom)[threadId] ?? null;
  const { rows } = view;
  /** The selected message, and where it was, for when it leaves the queue. */
  const [selection, setSelection] = useState<{
    readonly runId: RunId | null;
    readonly index: number;
  }>({ runId: null, index: 0 });
  const [armedRunId, setArmedRunId] = useState<RunId | null>(null);
  const editorRef = useRef<TextareaRenderable | null>(null);

  const found = rows.findIndex((row) => row.runId === (edit?.runId ?? selection.runId));
  // A selected message that left the queue hands the selection to the one in its place.
  const index = found === -1 ? Math.min(selection.index, Math.max(0, rows.length - 1)) : found;
  const selected = rows[index] ?? null;
  const actions = queueRowActions(view, index, { busy: busyRunId !== null });

  const shown = rows.length > 0;
  useEffect(() => {
    onShown(shown);
  }, [onShown, shown]);
  useEffect(() => () => onShown(false), [onShown]);
  const hints =
    edit !== null
      ? saving
        ? "Saving…"
        : QUEUE_EDIT_KEY_HINTS
      : `↑↓ select  ⏎ edit  s ${sendLabel(view)}  ⇧↑↓ move  x remove  esc back  type to compose`;
  useEffect(() => {
    if (focused) onHints(hints);
  }, [focused, hints, onHints]);

  const select = (row: QueueRow) => {
    setSelection({ runId: row.runId, index: rows.indexOf(row) });
    setArmedRunId(null);
  };
  const beginEdit = (row: QueueRow) => {
    select(row);
    if (controller.beginEdit(threadId, row.runId)) onFocus();
  };
  /** Remove asks once: the first press arms it, a second removes. */
  const remove = (row: QueueRow) => {
    if (armedRunId !== row.runId) {
      setArmedRunId(row.runId);
      return;
    }
    setArmedRunId(null);
    void controller.remove(threadId, row.runId);
  };

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      const action = resolveQueueKey(key, edit !== null);
      if (action === null) return false;
      if (action.type !== "remove" && action.type !== "select") setArmedRunId(null);
      if (action.type === "leave") {
        onLeave();
        return true;
      }
      if (action.type === "type") {
        onType(action.text);
        return true;
      }
      if (action.type === "cancel-edit") {
        controller.cancelEdit(threadId);
        return true;
      }
      // A held key's repeats only move the selection; nothing else happens twice.
      if (key.repeated && action.type !== "select") return true;
      if (action.type === "save") {
        void controller.saveEdit(threadId);
        return true;
      }
      if (selected === null) return true;
      switch (action.type) {
        case "select": {
          const next = rows[Math.max(0, Math.min(rows.length - 1, index + action.delta))];
          if (next !== undefined) select(next);
          return true;
        }
        case "move":
          void controller.move(threadId, selected.runId, action.delta);
          return true;
        case "edit":
          beginEdit(selected);
          return true;
        case "send":
          void controller.sendNow(threadId, selected.runId);
          return true;
        case "remove":
          remove(selected);
          return true;
      }
      return true;
    },
    sendFirst: (repeat: boolean) => {
      const first = rows[0];
      if (first === undefined || (!view.canSendNow && !view.canPromoteToSteer)) return false;
      if (!repeat) void controller.sendNow(threadId, first.runId);
      return true;
    },
    editLast: (repeat: boolean) => {
      const last = rows.at(-1);
      if (last === undefined || last.guestName !== null || edit !== null) return false;
      if (!repeat) beginEdit(last);
      return true;
    },
  }));

  if (!shown) return null;
  const windowStart = Math.min(
    Math.max(0, index - VISIBLE_ROWS + 1),
    Math.max(0, rows.length - VISIBLE_ROWS),
  );
  const visible = rows.slice(windowStart, windowStart + VISIBLE_ROWS);
  const below = rows.length - windowStart - visible.length;
  const header = `󰒲 Up next · ${rows.length} queued${
    view.holdReason === null ? "" : ` · held: ${view.holdReason}`
  }`;

  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      <box onMouseDown={onFocus} style={{ flexDirection: "row", height: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={header}
          style={{ fg: view.holdReason === null ? palette.subtle : palette.warning }}
        />
        {!focused ? (
          <text
            wrapMode="none"
            content="  tab to manage"
            style={{ fg: palette.subtle, flexShrink: 0 }}
          />
        ) : null}
        {windowStart > 0 ? (
          <text
            wrapMode="none"
            content={`  ↑ ${windowStart} more`}
            style={{ fg: palette.subtle, flexShrink: 0 }}
          />
        ) : null}
      </box>
      {visible.map((row, offset) => {
        const position = windowStart + offset;
        const isSelected = focused && position === index;
        const isEditing = edit?.runId === row.runId;
        const marker = `${isSelected ? "›" : " "} ${position + 1}. ${row.held ? "󰏤" : "󰒲"} `;
        const images = row.attachments > 0 ? ` +${row.attachments} image` : "";
        const guest = row.guestName === null ? "" : `${row.guestName}: `;
        if (isEditing) {
          return (
            <box key={row.runId} style={{ flexDirection: "row", minHeight: 1 }}>
              <text
                wrapMode="none"
                content={`${focused ? "›" : " "} ${position + 1}. 󰏫 `}
                style={{ fg: palette.info, flexShrink: 0 }}
              />
              <box style={{ flexGrow: 1, minWidth: 0 }}>
                <textarea
                  key={`${threadId}:${row.runId}`}
                  ref={(node: TextareaRenderable | null) => {
                    if (node !== null && editorRef.current !== node) node.gotoBufferEnd();
                    editorRef.current = node;
                  }}
                  focused={focused && !saving}
                  initialValue={edit.text}
                  placeholder="The queued message"
                  cursorColor={palette.cursor}
                  keyBindings={[
                    { name: "return", shift: true, action: "newline" },
                    { name: "linefeed", action: "newline" },
                  ]}
                  onContentChange={() =>
                    controller.setEditText(threadId, editorRef.current?.plainText ?? edit.text)
                  }
                  style={{
                    flexGrow: 1,
                    minWidth: 0,
                    maxHeight: EDITOR_ROWS_MAX,
                    backgroundColor: palette.composerPanel,
                    focusedBackgroundColor: palette.composerPanel,
                    textColor: palette.text,
                    focusedTextColor: palette.text,
                    placeholderColor: palette.subtle,
                  }}
                />
              </box>
              <text
                wrapMode="none"
                content={saving ? "  Saving…" : images}
                style={{ fg: palette.subtle, flexShrink: 0 }}
              />
            </box>
          );
        }
        const armed = armedRunId === row.runId;
        const working = busyRunId === row.runId;
        return (
          <box
            key={row.runId}
            onMouseDown={() => {
              select(row);
              onFocus();
            }}
            style={{
              flexDirection: "row",
              height: 1,
              ...(isSelected ? { backgroundColor: palette.controlActive } : {}),
            }}
          >
            <text
              wrapMode="none"
              content={marker}
              style={{ fg: isSelected ? palette.info : palette.subtle, flexShrink: 0 }}
            />
            <text
              wrapMode="none"
              truncate
              content={`${guest}${row.preview}${images}`}
              style={{ fg: isSelected ? palette.text : palette.muted, flexShrink: 1 }}
            />
            {working ? (
              <text wrapMode="none" content="  …" style={{ fg: palette.info, flexShrink: 0 }} />
            ) : null}
            {isSelected && actions !== null ? (
              <box style={{ flexDirection: "row", flexShrink: 0, paddingLeft: 2 }}>
                {armed ? (
                  <QueueAction
                    label="Remove? x again"
                    tone={palette.warning}
                    onPress={() => remove(row)}
                  />
                ) : (
                  <>
                    <QueueAction
                      label="⏎ edit"
                      tone={actions.edit.ok ? palette.muted : palette.subtle}
                      onPress={() => beginEdit(row)}
                    />
                    <QueueAction
                      label={`s ${sendLabel(view)}`}
                      tone={actions.send.ok ? palette.muted : palette.subtle}
                      onPress={() => void controller.sendNow(threadId, row.runId)}
                    />
                    <QueueAction
                      label="x remove"
                      tone={actions.remove.ok ? palette.muted : palette.subtle}
                      onPress={() => remove(row)}
                    />
                  </>
                )}
              </box>
            ) : null}
          </box>
        );
      })}
      {below > 0 ? (
        <text wrapMode="none" content={`  ↓ ${below} more`} style={{ fg: palette.subtle }} />
      ) : null}
    </box>
  );
}

function QueueAction(props: {
  readonly label: string;
  readonly tone: string;
  readonly onPress: () => void;
}) {
  return (
    <box onMouseDown={props.onPress} style={{ flexShrink: 0, paddingLeft: 2 }}>
      <text wrapMode="none" content={props.label} style={{ fg: props.tone }} />
    </box>
  );
}
