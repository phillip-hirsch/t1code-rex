/**
 * What each panel shows in a given number of rows. A panel's title sits in its
 * top border and its key hints in its bottom one, so neither costs a line.
 */
import type {
  ThreadPendingApproval,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ModelSelection } from "@t3tools/contracts";

import {
  clipLines,
  displayWidth,
  fitItems,
  headAndTail,
  listWindow,
  packItems,
  truncateText,
  wrapText,
  type PanelSize,
} from "./layout.ts";
import { filterPickerEntries, type PickerEntry, type PickerState } from "./picker.ts";
import { approvalChoices, optionValue, type QuestionDraft } from "./requests.ts";

export type Tone = "text" | "warning" | "accent" | "muted" | "subtle";

export interface PanelLine {
  readonly key: string;
  readonly text: string;
  readonly tone: Tone;
}

export interface PanelPlan extends PanelSize {
  readonly title: string;
  /** Key hints for the bottom border, fitted to it; empty when none fit. */
  readonly hint: string;
  /** The lines that fit `rows`, borders included. */
  readonly lines: (rows: number) => ReadonlyArray<PanelLine>;
}

/** A panel's text width: the terminal less its border and padding. */
const textWidth = (width: number) => Math.max(1, width - 4);

/** Border text with a space each side, if it fits between the corners and a rule each side. */
function borderText(text: string, width: number): string {
  return displayWidth(text) + 2 <= width - 4 ? ` ${text} ` : "";
}

/** Hints joined two spaces apart, dropping those in `dropOrder` until they fit the border. */
function borderHints(
  hints: ReadonlyArray<string>,
  dropOrder: ReadonlyArray<string>,
  width: number,
): string {
  const kept = fitItems(hints, (items) => borderText(items.join("  "), width) !== "", dropOrder);
  return kept.length > 0 ? borderText(kept.join("  "), width) : "";
}

function plan(
  title: string,
  width: number,
  hint: string,
  min: number,
  lines: (room: number) => ReadonlyArray<PanelLine>,
): PanelPlan {
  const columns = textWidth(width);
  // Cues are built without the width, so every line is cut here.
  const content = (rows: number) =>
    lines(Math.max(0, rows - 2)).map((line) => ({
      ...line,
      text: truncateText(line.text, columns),
    }));
  return {
    title: title ? borderText(truncateText(title, Math.max(1, width - 6)), width) : "",
    hint,
    natural: 2 + content(Number.MAX_SAFE_INTEGER).length,
    min: 2 + min,
    lines: content,
  };
}

const APPROVAL_HINT = "keys answer while the message box is empty";

/**
 * What goes last: the choices, then the detail's last line (the target), then
 * its first lines; the cue for hidden lines and the key hint go first.
 */
export function approvalPlan(
  approval: ThreadPendingApproval,
  armed: boolean,
  width: number,
): PanelPlan {
  const columns = textWidth(width);
  const choices = packItems(
    approvalChoices(approval).map((choice) => `[${choice.key}] ${choice.label}`),
    // No gap after the last choice on a row.
    columns + 3,
    3,
  ).map((row, index): PanelLine => {
    const text = truncateText(row.join("   "), columns);
    // Kept blank until armed, so the panel doesn't jump.
    return { key: `choice:${index}`, text: armed ? text : "", tone: "warning" };
  });
  // Trailing blank lines would take the place of the target.
  const detail = wrapText(
    (approval.detail ?? approval.reason ?? approval.requestKind).trimEnd(),
    columns,
  );
  return plan(
    "Approval needed",
    width,
    borderHints([APPROVAL_HINT], [APPROVAL_HINT], width),
    choices.length + 1,
    (room) => {
      if (room <= choices.length) return choices.slice(0, room);
      const shown = headAndTail(detail, room - choices.length).map((text, index): PanelLine => ({
        key: `detail:${index}`,
        text,
        tone: "text",
      }));
      return [...shown, ...choices];
    },
  );
}

/** Lines kept for the highlighted option's description. */
const DESCRIPTION_LINES = 3;

/**
 * What goes last: the key hints, then the highlighted option, then the
 * question's first line, then the other options, the rest of the question,
 * and the highlighted option's description.
 */
export function questionPlan(
  question: ThreadUserInputQuestion,
  draft: QuestionDraft,
  dismissible: boolean,
  width: number,
): PanelPlan {
  const columns = textWidth(width);
  const typed = question.allowCustomAnswer === false ? [] : ["or type an answer below"];
  const hints = [
    "↑↓ choose",
    ...(question.multiSelect ? ["tab pick"] : []),
    "enter answer",
    ...typed,
    ...(dismissible ? ["esc dismiss"] : []),
  ];
  const asked = question.question.trimEnd();
  const text = wrapText(asked, columns);
  const options = question.options;
  const highlighted = options[draft.cursor];
  const description = highlighted
    ? clipLines(wrapText(highlighted.description, columns - 2), DESCRIPTION_LINES)
    : [];
  const optionLine = (index: number): PanelLine => {
    const option = options[index];
    if (!option) return { key: `option:${index}`, text: "", tone: "muted" };
    const mark = question.multiSelect
      ? draft.picked.includes(optionValue(option))
        ? "[x] "
        : "[ ] "
      : "";
    const current = index === draft.cursor;
    return {
      key: `option:${optionValue(option)}`,
      text: truncateText(
        `${current ? "›" : " "} ${mark}${option.label} - ${option.description}`,
        columns,
      ),
      tone: current ? "accent" : "muted",
    };
  };
  const questionLines = (extra: number): ReadonlyArray<PanelLine> => {
    const shown =
      text.length <= 1 + extra
        ? text
        : extra === 0
          ? [truncateText(asked, columns)]
          : clipLines(text, 1 + extra);
    return shown.map((line, index) => ({ key: `question:${index}`, text: line, tone: "text" }));
  };
  return plan(
    question.header,
    width,
    borderHints(hints, [...typed, "esc dismiss", "tab pick", "↑↓ choose"], width),
    (highlighted ? 1 : 0) + 1,
    (room) => {
      if (room <= 0) return [];
      if (highlighted && room === 1) return [optionLine(draft.cursor)];
      let rest = room - 1;
      const window = listWindow(options.length, draft.cursor, Math.min(rest, options.length + 2));
      const listed: PanelLine[] = [];
      if (window.above > 0) {
        listed.push({ key: "above", text: `  ↑ ${window.above} more`, tone: "subtle" });
      }
      for (let index = window.first; index < window.first + window.count; index += 1) {
        listed.push(optionLine(index));
      }
      if (window.below > 0) {
        listed.push({ key: "below", text: `  ↓ ${window.below} more`, tone: "subtle" });
      }
      rest -= listed.length;
      const extra = Math.min(Math.max(0, text.length - 1), rest);
      rest -= extra;
      const notes = clipLines(description, rest).map((line, index): PanelLine => ({
        key: `description:${index}`,
        text: `  ${line}`,
        tone: "subtle",
      }));
      return [...questionLines(extra), ...listed, ...notes];
    },
  );
}

const PICKER_ROWS = 8;
const PROVIDER_LOCKED = "This thread can't switch providers; start a new thread.";

/**
 * What goes last: the highlighted entry, then the filter line, then the note
 * that the provider is locked, then the other entries.
 */
export function pickerPlan(
  entries: ReadonlyArray<PickerEntry>,
  state: PickerState,
  current: ModelSelection | null,
  providerLocked: boolean,
  width: number,
): PanelPlan {
  const columns = textWidth(width);
  const visible = filterPickerEntries(entries, state.query);
  const help: PanelLine = {
    key: "help",
    text: truncateText(
      state.query ? `filter: ${state.query}` : "type to filter  ↑↓ move  enter switch  esc close",
      columns,
    ),
    tone: "subtle",
  };
  const note = providerLocked
    ? wrapText(PROVIDER_LOCKED, columns).map((text, index): PanelLine => ({
        key: `locked:${index}`,
        text,
        tone: "subtle",
      }))
    : [];
  const entryLine = (index: number): PanelLine => {
    const entry = visible[index];
    if (!entry) return { key: `entry:${index}`, text: "", tone: "text" };
    const highlighted = index === state.index;
    const isCurrent = entry.instanceId === current?.instanceId && entry.model === current.model;
    return {
      key: `entry:${entry.instanceId}:${entry.model}`,
      text: truncateText(
        `${highlighted ? "›" : " "} ${entry.provider} · ${entry.label}${isCurrent ? "  (current)" : ""}`,
        columns,
      ),
      tone: highlighted ? "accent" : "text",
    };
  };
  const hasEntries = visible.length > 0;
  return plan("Model", width, "", 1 + (hasEntries ? 1 : 0), (room) => {
    if (room <= 0) return [];
    if (hasEntries && room === 1) return [entryLine(state.index)];
    let rest = room - 1;
    const notes = rest - (hasEntries ? 1 : 0) >= note.length ? note : [];
    rest -= notes.length;
    const window = listWindow(visible.length, state.index, rest, PICKER_ROWS);
    const listed: PanelLine[] = [];
    if (window.above > 0) {
      listed.push({ key: "above", text: `  ↑ ${window.above} more`, tone: "subtle" });
    }
    for (let index = window.first; index < window.first + window.count; index += 1) {
      listed.push(entryLine(index));
    }
    if (window.below > 0) {
      listed.push({ key: "below", text: `  ↓ ${window.below} more`, tone: "subtle" });
    }
    return [help, ...listed, ...notes];
  });
}
