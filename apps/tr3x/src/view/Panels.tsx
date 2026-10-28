import type {
  ThreadPendingApproval,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ModelSelection } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { filterPickerEntries, type PickerEntry, type PickerState } from "./picker.ts";
import { approvalChoices, optionValue, type QuestionDraft } from "./requests.ts";
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
      <text content={props.heading} fg={props.color} />
      {props.children}
    </box>
  );
}

export function ApprovalPanel(props: {
  readonly approval: ThreadPendingApproval;
  /** On screen long enough for keys to answer it. */
  readonly armed: boolean;
  readonly maxHeight: number;
}) {
  const { approval } = props;
  return (
    <Panel heading="Approval needed" color={palette.warning} maxHeight={props.maxHeight}>
      <box style={{ maxHeight: Math.max(1, props.maxHeight - 5), overflow: "hidden" }}>
        <text
          content={approval.detail ?? approval.reason ?? approval.requestKind}
          fg={palette.text}
        />
      </box>
      {props.armed ? (
        <text
          content={approvalChoices(approval)
            .map((choice) => `[${choice.key}] ${choice.label}`)
            .join("   ")}
          fg={palette.warning}
        />
      ) : null}
      <text content="keys answer while the message box is empty" fg={palette.subtle} />
    </Panel>
  );
}

/** Lines a question panel keeps for its question and the highlighted option's description. */
const QUESTION_LINES = 2;
const DESCRIPTION_LINES = 3;

export function QuestionPanel(props: {
  readonly question: ThreadUserInputQuestion;
  readonly draft: QuestionDraft;
  readonly dismissible: boolean;
  readonly maxHeight: number;
}) {
  const { question, draft } = props;
  const hints = [
    "↑↓ choose",
    ...(question.multiSelect ? ["tab pick"] : []),
    "enter answer",
    ...(question.allowCustomAnswer === false ? [] : ["or type an answer below"]),
    ...(props.dismissible ? ["esc dismiss"] : []),
  ];
  // Borders, heading, question, the cues above and below, description and hints.
  const rows = Math.max(1, props.maxHeight - 6 - QUESTION_LINES - DESCRIPTION_LINES);
  const count = question.options.length;
  const first = Math.min(Math.max(0, draft.cursor - rows + 1), Math.max(0, count - rows));
  const highlighted = question.options[draft.cursor];
  return (
    <Panel heading={question.header} color={palette.accent} maxHeight={props.maxHeight}>
      <box style={{ maxHeight: QUESTION_LINES, overflow: "hidden" }}>
        <text content={question.question} fg={palette.text} />
      </box>
      {first > 0 ? <text content={`  ↑ ${first} more`} fg={palette.subtle} /> : null}
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
      {count > first + rows ? (
        <text content={`  ↓ ${count - first - rows} more`} fg={palette.subtle} />
      ) : null}
      {highlighted ? (
        <box style={{ maxHeight: DESCRIPTION_LINES, overflow: "hidden", paddingLeft: 2 }}>
          <text content={highlighted.description} fg={palette.subtle} />
        </box>
      ) : null}
      <text content={hints.join("  ")} fg={palette.subtle} />
    </Panel>
  );
}

const PICKER_ROWS = 8;

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
