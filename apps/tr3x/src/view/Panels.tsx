import type {
  ThreadPendingApproval,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ModelSelection } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { filterPickerEntries, type PickerEntry, type PickerState } from "./picker.ts";
import { approvalChoices, optionValue, type QuestionDraft } from "./requests.ts";
import { clipLines, headAndTail, wrapText } from "./layout.ts";
import { palette } from "./theme.ts";

function Panel(props: {
  readonly heading: string;
  readonly color: string;
  /** A hard cap, so the composer below always stays on screen. */
  readonly maxHeight?: number;
  readonly children: ReactNode;
}) {
  return (
    <box
      border
      borderColor={props.color}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        overflow: "hidden",
        ...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight }),
      }}
    >
      <text content={props.heading} fg={props.color} truncate wrapMode="none" />
      {props.children}
    </box>
  );
}

/** Lines already wrapped to the panel, so none wraps again. */
function Lines(props: { readonly lines: ReadonlyArray<string>; readonly color: string }) {
  if (props.lines.length === 0) return null;
  return <text content={props.lines.join("\n")} fg={props.color} wrapMode="none" />;
}

/** A panel's text width: the terminal less its border and padding. */
const textWidth = (width: number) => Math.max(10, width - 4);

const APPROVAL_HINT = "keys answer while the message box is empty";

export function ApprovalPanel(props: {
  readonly approval: ThreadPendingApproval;
  /** On screen long enough for keys to answer it. */
  readonly armed: boolean;
  readonly maxHeight: number;
  readonly width: number;
}) {
  const { approval } = props;
  const columns = textWidth(props.width);
  const choices = wrapText(
    approvalChoices(approval)
      .map((choice) => `[${choice.key}] ${choice.label}`)
      .join("   "),
    columns,
  );
  const hint = wrapText(APPROVAL_HINT, columns);
  // Borders and heading, then the choices (their lines kept while arming) and the hint.
  const room = props.maxHeight - 3 - choices.length - hint.length;
  const detail = headAndTail(
    wrapText(approval.detail ?? approval.reason ?? approval.requestKind, columns),
    Math.max(1, room),
  );
  return (
    <Panel heading="Approval needed" color={palette.warning} maxHeight={props.maxHeight}>
      <Lines lines={detail} color={palette.text} />
      <Lines lines={props.armed ? choices : choices.map(() => "")} color={palette.warning} />
      <Lines lines={hint} color={palette.subtle} />
    </Panel>
  );
}

/** Lines kept for the highlighted option's description. */
const DESCRIPTION_LINES = 3;

export function QuestionPanel(props: {
  readonly question: ThreadUserInputQuestion;
  readonly draft: QuestionDraft;
  readonly dismissible: boolean;
  readonly maxHeight: number;
  readonly width: number;
}) {
  const { question, draft } = props;
  const columns = textWidth(props.width);
  const hints = wrapText(
    [
      "↑↓ choose",
      ...(question.multiSelect ? ["tab pick"] : []),
      "enter answer",
      ...(question.allowCustomAnswer === false ? [] : ["or type an answer below"]),
      ...(props.dismissible ? ["esc dismiss"] : []),
    ].join("  "),
    columns,
  );
  const highlighted = question.options[draft.cursor];
  const description = highlighted
    ? clipLines(wrapText(highlighted.description, columns - 2), DESCRIPTION_LINES)
    : [];
  // Borders, heading, hints and description first; then the options; the question takes the rest.
  const room = props.maxHeight - 3 - hints.length - description.length;
  const count = question.options.length;
  // Options leave at least one line for the question; a window needs lines for its cues.
  const rows = count <= room - 1 ? count : Math.max(1, room - 3);
  const first = Math.min(Math.max(0, draft.cursor - rows + 1), Math.max(0, count - rows));
  const above = first;
  const below = Math.max(0, count - first - rows);
  const optionLines = rows + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0);
  const text = clipLines(wrapText(question.question, columns), Math.max(1, room - optionLines));
  return (
    <Panel heading={question.header} color={palette.accent} maxHeight={props.maxHeight}>
      <Lines lines={text} color={palette.text} />
      {above > 0 ? <text content={`  ↑ ${above} more`} fg={palette.subtle} /> : null}
      {question.options.slice(first, first + rows).map((option, offset) => {
        const index = first + offset;
        const mark = question.multiSelect
          ? draft.picked.includes(optionValue(option))
            ? "[x] "
            : "[ ] "
          : "";
        return (
          <text
            key={optionValue(option)}
            content={`${index === draft.cursor ? "›" : " "} ${mark}${option.label} - ${option.description}`}
            fg={index === draft.cursor ? palette.accent : palette.muted}
            truncate
            wrapMode="none"
          />
        );
      })}
      {below > 0 ? <text content={`  ↓ ${below} more`} fg={palette.subtle} /> : null}
      <box style={{ paddingLeft: 2, flexDirection: "column" }}>
        <Lines lines={description} color={palette.subtle} />
      </box>
      <Lines lines={hints} color={palette.subtle} />
    </Panel>
  );
}

const PICKER_ROWS = 8;

/** The lines `PickerPanel` takes, so the layout can leave room for it. */
export function pickerHeight(
  entries: ReadonlyArray<PickerEntry>,
  state: PickerState,
  providerLocked: boolean,
): number {
  const visible = filterPickerEntries(entries, state.query).length;
  const first = Math.max(0, state.index - (PICKER_ROWS - 1));
  const shown = Math.min(PICKER_ROWS, Math.max(0, visible - first));
  // Borders, heading and filter line, cues above and below, and the locked note.
  return (
    4 +
    shown +
    (first > 0 ? 1 : 0) +
    (visible > first + PICKER_ROWS ? 1 : 0) +
    (providerLocked ? 1 : 0)
  );
}

export function PickerPanel(props: {
  readonly entries: ReadonlyArray<PickerEntry>;
  readonly state: PickerState;
  readonly current: ModelSelection | null;
  readonly providerLocked: boolean;
}) {
  const visible = filterPickerEntries(props.entries, props.state.query);
  const first = Math.max(0, props.state.index - (PICKER_ROWS - 1));
  return (
    <Panel heading="Model" color={palette.accent}>
      <text
        content={
          props.state.query
            ? `filter: ${props.state.query}`
            : "type to filter  ↑↓ move  enter switch  esc close"
        }
        fg={palette.subtle}
      />
      {first > 0 ? <text content={`  ↑ ${first} more`} fg={palette.subtle} /> : null}
      {visible.slice(first, first + PICKER_ROWS).map((entry, offset) => {
        const highlighted = first + offset === props.state.index;
        const current =
          entry.instanceId === props.current?.instanceId && entry.model === props.current.model;
        return (
          <text
            key={`${entry.instanceId}:${entry.model}`}
            content={`${highlighted ? "›" : " "} ${entry.provider} · ${entry.label}${current ? "  (current)" : ""}`}
            fg={highlighted ? palette.accent : palette.text}
          />
        );
      })}
      {visible.length > first + PICKER_ROWS ? (
        <text content={`  ↓ ${visible.length - first - PICKER_ROWS} more`} fg={palette.subtle} />
      ) : null}
      {props.providerLocked ? (
        <text
          content="This thread can't switch providers; start a new thread."
          fg={palette.subtle}
        />
      ) : null}
    </Panel>
  );
}

/** Key hints, one per item, wrapping as a whole hint when the line is full. */
export function Footer({ hints }: { readonly hints: ReadonlyArray<string> }) {
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, paddingLeft: 1 }}>
      {hints.map((hint) => (
        <text key={hint} content={hint} fg={palette.subtle} style={{ marginRight: 2 }} />
      ))}
    </box>
  );
}
