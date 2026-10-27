/**
 * The confirm dialog: one or more steps, each with Cancel and a confirm button. A
 * destructive step starts on Cancel, so a stray Enter (the end of text typed into the wrong
 * pane) cancels instead of deleting. Reaching its confirm button takes a deliberate ←/→ or
 * Tab first. Held keys' repeats do nothing.
 */

export interface ConfirmStep {
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel: string;
  /** Can't be undone: starts on Cancel. */
  readonly destructive: boolean;
}

export type ConfirmButton = "cancel" | "confirm";

export interface ConfirmDialogState {
  readonly steps: ReadonlyArray<ConfirmStep>;
  readonly stepIndex: number;
  readonly focus: ConfirmButton;
}

export interface ConfirmKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly repeated?: boolean;
}

export type ConfirmOutcome =
  | { readonly type: "state"; readonly state: ConfirmDialogState }
  | { readonly type: "cancel" }
  | { readonly type: "confirm" }
  | { readonly type: "ignore" };

function stepFocus(step: ConfirmStep | undefined): ConfirmButton {
  return step?.destructive === false ? "confirm" : "cancel";
}

export function openConfirm(steps: ReadonlyArray<ConfirmStep>): ConfirmDialogState {
  return { steps, stepIndex: 0, focus: stepFocus(steps[0]) };
}

export function currentStep(state: ConfirmDialogState): ConfirmStep | null {
  return state.steps[state.stepIndex] ?? null;
}

/** A button press, by key or mouse: Cancel closes; confirm moves on, or confirms the last step. */
export function pressConfirmButton(
  state: ConfirmDialogState,
  button: ConfirmButton,
): ConfirmOutcome {
  if (button === "cancel") return { type: "cancel" };
  const next = state.stepIndex + 1;
  if (next < state.steps.length) {
    return {
      type: "state",
      state: { steps: state.steps, stepIndex: next, focus: stepFocus(state.steps[next]) },
    };
  }
  return { type: "confirm" };
}

function isEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed";
}

export function reduceConfirmKey(state: ConfirmDialogState, key: ConfirmKey): ConfirmOutcome {
  if (key.repeated) return { type: "ignore" };
  if (key.name === "escape" || (key.ctrl && key.name === "c")) return { type: "cancel" };
  if (key.name === "left" || key.name === "right" || key.name === "tab") {
    return {
      type: "state",
      state: { ...state, focus: state.focus === "cancel" ? "confirm" : "cancel" },
    };
  }
  if (isEnter(key.name)) return pressConfirmButton(state, state.focus);
  return { type: "ignore" };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Archiving is undone from the archive view, so Enter confirms it, as before. */
export function archiveThreadsConfirm(titles: ReadonlyArray<string>): ConfirmStep {
  return {
    title:
      titles.length === 1
        ? `Archive thread "${titles[0]}"?`
        : `Archive ${plural(titles.length, "thread")}?`,
    body: "Archived threads leave the sidebar. Restore them from Archived threads in the palette.",
    confirmLabel: "Archive",
    destructive: false,
  };
}

/** Messages queued for threads being deleted: no composer could show them afterwards. */
function unsentNote(pending: number): string {
  if (pending <= 0) return "";
  return ` ${plural(pending, "unsent message")} ${pending === 1 ? "is" : "are"} discarded too.`;
}

export function deleteThreadsConfirm(titles: ReadonlyArray<string>, pending = 0): ConfirmStep {
  return {
    title:
      titles.length === 1
        ? `Delete thread "${titles[0]}"?`
        : `Delete ${plural(titles.length, "thread")}?`,
    body:
      (titles.length === 1
        ? "This permanently clears the thread's conversation history."
        : "This permanently clears these threads' conversation history.") + unsentNote(pending),
    confirmLabel: "Delete",
    destructive: true,
  };
}

/** A project's threads: those the sidebar lists (older settled ones too), and archived ones. */
export interface ProjectThreadCount {
  readonly listed: number;
  readonly archived: number;
}

/**
 * The old TUI's two steps for a project with threads: a heads-up, then the real question.
 * The server deletes archived threads too, so they count; when they can't be counted, it
 * asks both steps.
 */
export function projectRemovalSteps(
  projectTitle: string,
  threads: ProjectThreadCount | null,
  pending = 0,
): ReadonlyArray<ConfirmStep> {
  const total = threads === null ? null : threads.listed + threads.archived;
  if (total === 0) {
    return [
      {
        title: `Remove project "${projectTitle}"?`,
        body: `It has no threads. Files on disk are kept.${unsentNote(pending)}`,
        confirmLabel: "Remove",
        destructive: true,
      },
    ];
  }
  const archived =
    threads !== null && threads.archived > 0 ? ` (${threads.archived} archived)` : "";
  const counted =
    total === null
      ? "its threads, archived ones included"
      : `its ${plural(total, "thread")}${archived}`;
  return [
    {
      title: `Remove project "${projectTitle}"?`,
      body: `This also deletes ${counted}. Continue to confirm.`,
      confirmLabel: "Continue",
      destructive: true,
    },
    {
      title:
        total === null
          ? `Remove project "${projectTitle}" and its threads?`
          : `Remove project "${projectTitle}" and ${plural(total, "thread")}?`,
      body: `This permanently deletes the project's conversation history, archived threads included. Files on disk are kept.${unsentNote(pending)}`,
      confirmLabel: "Remove project",
      destructive: true,
    },
  ];
}
