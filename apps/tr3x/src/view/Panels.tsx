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
  readonly children: ReactNode;
}) {
  return (
    <box
      border
      borderColor={props.color}
      style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}
    >
      <text content={props.heading} fg={props.color} />
      {props.children}
    </box>
  );
}

export function ApprovalPanel({ approval }: { readonly approval: ThreadPendingApproval }) {
  return (
    <Panel heading="Approval needed" color={palette.warning}>
      <text
        content={approval.detail ?? approval.reason ?? approval.requestKind}
        fg={palette.text}
      />
      <text
        content={approvalChoices(approval)
          .map((choice) => `[${choice.key}] ${choice.label}`)
          .join("   ")}
        fg={palette.warning}
      />
    </Panel>
  );
}

export function QuestionPanel(props: {
  readonly question: ThreadUserInputQuestion;
  readonly draft: QuestionDraft;
  readonly dismissible: boolean;
}) {
  const { question, draft } = props;
  const hints = [
    "↑↓ choose",
    ...(question.multiSelect ? ["tab pick"] : []),
    "enter answer",
    ...(question.allowCustomAnswer === false ? [] : ["or type an answer below"]),
    ...(props.dismissible ? ["esc dismiss"] : []),
  ];
  return (
    <Panel heading={question.header} color={palette.accent}>
      <text content={question.question} fg={palette.text} />
      {question.options.map((option, index) => {
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
          />
        );
      })}
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
      {props.providerLocked ? (
        <text
          content="This thread can't switch providers; start a new thread."
          fg={palette.subtle}
        />
      ) : null}
    </Panel>
  );
}
