import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  type ThreadPendingUserInput,
  type ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

import { allowsCustomAnswer, answerText, optionValue, resolveAnswer } from "./questionAnswers.ts";
import {
  ENGAGE_HINT,
  activeQuestion,
  availableChoices,
  createEngagementGuard,
  draftOf,
  isOpen,
  onTextRow,
  pickActiveRequest,
  pressPanelKey,
  requestRunStopped,
  resolvePanelKey,
  setTypedAnswer,
  stepRequest,
  type PanelAction,
  type PanelRunState,
  type QuestionForm,
} from "./requestPanel.ts";
import type { RequestPanelStore } from "./requestPanelStore.ts";
import {
  approvalChoices,
  approvalTitle,
  decisionDoneLabel,
  type ApprovalChoice,
  type PendingRequest,
} from "./requestQueue.ts";
import type { RequestResponder, RequestResponse, ResponseStatus } from "./requestResponder.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

const COMMAND_LINES_MAX = 4;
const LINE_CHARS_MAX = 400;
const FILES_MAX = 4;
const TEXT_ROWS_MAX = 3;

export interface RequestPanelHandle {
  /** Keys while the panel has focus; true when it used the key. */
  readonly handleKey: (key: KeyEvent) => boolean;
  /** Focus just moved here by Tab: engages the panel once its request has settled. */
  readonly enter: () => void;
}

export interface RequestPanelProps extends PanelRunState {
  readonly threadId: ThreadId;
  readonly queue: ReadonlyArray<PendingRequest>;
  readonly store: RequestPanelStore;
  readonly responder: RequestResponder;
  readonly theme: TuiTheme;
  /** Keys come here only while focused; the composer has them otherwise. */
  readonly focused: boolean;
  /** Where the thread's commands run, shown under a command approval. */
  readonly cwd: string | null;
  /** The run Stop was last sent for; its requests can only be declined. */
  readonly stopSentRunId: string | null;
  /** A click on the panel: focus moves here. */
  readonly onFocus: () => void;
  /** Esc, Tab, or another request: focus goes back to the composer. */
  readonly onLeave: () => void;
  /** Ctrl+C stops the run, as in the composer. */
  readonly onStop: () => void;
  /** Ctrl+C with nothing running. */
  readonly onExit: () => void;
  readonly onStatus: (message: string) => void;
  /** The footer's key hints while the panel has focus. */
  readonly onHints: (hints: string) => void;
  readonly ref?: Ref<RequestPanelHandle>;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function commandLines(command: string): string {
  const lines = command.trimEnd().split("\n");
  const shown = lines.slice(0, COMMAND_LINES_MAX).map((line) => clip(line, LINE_CHARS_MAX));
  if (lines.length > COMMAND_LINES_MAX)
    shown.push(`… ${lines.length - COMMAND_LINES_MAX} more lines`);
  return shown.map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`)).join("\n");
}

function responseLabel(response: RequestResponse): string {
  switch (response.type) {
    case "approval":
      return decisionDoneLabel(response.decision);
    case "answers":
      return `Answered: ${clip(Object.values(response.answers).map(answerText).join(" · "), 80)}`;
    case "dismiss":
      return "Dismissed";
  }
}

function statusLine(
  status: ResponseStatus | null,
): { text: string; tone: "muted" | "error" } | null {
  if (status === null) return null;
  switch (status.state) {
    case "sending":
      return { text: `${responseLabel(status.response)} · sending…`, tone: "muted" };
    case "waiting":
      return { text: "Not sent yet; retrying when connected", tone: "muted" };
    case "sent":
      return { text: `${responseLabel(status.response)} · waiting for the agent…`, tone: "muted" };
    case "failed":
      return { text: `Not sent: ${status.error}`, tone: "error" };
  }
}

function hintsFor(
  request: PendingRequest | null,
  form: QuestionForm | null,
  count: number,
  engaged: boolean,
  stopped: boolean,
  run: PanelRunState,
): string {
  if (request === null) return "";
  const stop = run.running ? (run.stopRequested ? "  stopping…" : "  ^C stop") : "";
  const step = count > 1 ? "  [ ] request" : "";
  const back = "  esc back";
  const answerable =
    request.kind === "approval"
      ? approvalChoices(request.approval).length > 0
      : request.input.responseCapability !== "not_resumable";
  if (!answerable) return `${step}${stop}${back}`.trimStart();
  if (!engaged) return `⏎ respond${step}${stop}${back}`;
  if (request.kind === "approval") {
    const choices = availableChoices(approvalChoices(request.approval), stopped);
    const keys = choices.map((choice) => choice.key).join("/");
    return `${keys} or ${choices.length === 1 ? "1" : `1-${choices.length}`} choose${step}${stop}${back}`;
  }
  const question = form === null ? null : activeQuestion(request.input, form);
  const dismiss = request.input.dismissible && !run.running ? "  ^X dismiss" : "";
  const next = form !== null && form.index < request.input.questions.length - 1 ? "next" : "submit";
  if (question !== null && form !== null && onTextRow(form, question)) {
    return `type an answer  ⏎ ${next}  ↑ options${dismiss}${stop}${back}`;
  }
  const many = request.input.questions.length > 1 ? "  ←→ question" : "";
  return `↑↓ move  1-9 pick  ⏎ ${next}${many}${step}${dismiss}${stop}${back}`;
}

const STOPPED_NOTE = "Run stopped. This request can only be declined to clear it";

/** The panel's own line under the request: how to reach it, or what it waits for. */
function panelNote(input: {
  kind: PendingRequest["kind"];
  focused: boolean;
  engaged: boolean;
  stopped: boolean;
}): string {
  if (!input.focused) {
    const tab = "Tab to respond";
    if (input.stopped) return `Run stopped; this can only be declined · ${tab}`;
    return input.kind === "approval" ? `${tab} · sending a message declines it` : tab;
  }
  if (!input.engaged) return `${ENGAGE_HINT}; until then keys do nothing here`;
  return input.stopped ? STOPPED_NOTE : "";
}

/**
 * Approvals and questions, above the composer while any is pending. The composer keeps
 * focus and keys; Tab or a click moves focus here, and Esc, Tab or another request moves it
 * back. While focused, the shell's keyboard hook calls this handle first.
 */
export function RequestPanel(props: RequestPanelProps) {
  const { threadId, queue, store, responder, theme, ref } = props;
  const run: PanelRunState = { running: props.running, stopRequested: props.stopRequested };
  const palette = theme.palette;
  useSyncExternalStore(store.subscribe, store.version);
  useSyncExternalStore(responder.subscribe, responder.version);
  const statusOf = (requestId: RuntimeRequestId) => responder.status(requestId);
  const active = pickActiveRequest(queue, store.active(threadId), statusOf);
  const activeId = active?.requestId ?? null;
  const form = active?.kind === "question" ? store.form(threadId, active.input) : null;

  // Behind focus, a second layer: decisions wait until the request has settled in view.
  const [guard] = useState(() => createEngagementGuard());
  useEffect(() => {
    guard.show(activeId);
  }, [activeId, guard]);
  // Another request (answered, resolved elsewhere, or a new one) sends focus back to the
  // composer; stepping with [ ] stays here, disengaged.
  const steppedTo = useRef<RuntimeRequestId | null>(null);
  const shownId = useRef(activeId);
  const { focused, onLeave } = props;
  useEffect(() => {
    const previous = shownId.current;
    shownId.current = activeId;
    if (previous === activeId) return;
    if (activeId !== null && activeId === steppedTo.current) return;
    if (focused) onLeave();
  }, [activeId, focused, onLeave]);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const engaged = guard.engaged(activeId);
  // A click is deliberate, once the request has been in view long enough to be aimed at.
  const clicked = (requestId: RuntimeRequestId): boolean => {
    if (!guard.settled(requestId)) return false;
    if (!guard.engaged(requestId)) {
      guard.engage(requestId);
      rerender();
    }
    return true;
  };

  const stop = { stopSentRunId: props.stopSentRunId, stopRequested: props.stopRequested };
  const stoppedOf = (request: PendingRequest): boolean => requestRunStopped(request, stop);
  const stopped = active !== null && stoppedOf(active);
  const hints = hintsFor(active, form, queue.length, engaged, stopped, run);
  const { onHints } = props;
  useEffect(() => {
    onHints(hints);
  }, [hints, onHints]);

  const respond = (request: PendingRequest, response: RequestResponse) => {
    // With nothing else open, the panel keeps showing this one while its answer goes out.
    store.setActive(threadId, request.requestId);
    responder.clearFailure(request.requestId);
    responder.respond(threadId, request.requestId, response);
  };

  const apply = (request: PendingRequest, action: PanelAction) => {
    switch (action.type) {
      case "none":
        return;
      case "engage":
        props.onStatus("");
        rerender();
        return;
      case "leave":
        props.onLeave();
        return;
      case "stop":
        props.onStop();
        return;
      case "exit":
        props.onExit();
        return;
      case "step-request": {
        const next = stepRequest(queue, request.requestId, action.delta, statusOf);
        if (next === null) {
          props.onStatus("No other request is waiting");
        } else {
          steppedTo.current = next;
          store.setActive(threadId, next);
        }
        return;
      }
      case "decide":
        respond(request, { type: "approval", decision: action.decision });
        return;
      case "form":
        store.setForm(threadId, request.requestId, action.form);
        return;
      case "hint":
        if (action.form !== undefined) store.setForm(threadId, request.requestId, action.form);
        props.onStatus(action.message);
        return;
      case "submit":
        respond(request, { type: "answers", answers: action.answers });
        return;
      case "dismiss":
        respond(request, { type: "dismiss" });
        return;
    }
  };

  const busyOf = (request: PendingRequest): boolean => {
    if (!isOpen(responder.status(request.requestId))) return true;
    return request.kind === "approval"
      ? request.approval.responseCapability !== "live"
      : request.input.responseCapability === "not_resumable";
  };

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      // Read now, not from the last render: a burst of keys builds on itself.
      const request = pickActiveRequest(queue, store.active(threadId), statusOf);
      if (request === null) return false;
      const action = pressPanelKey(guard, request.requestId, key, (engagement) =>
        request.kind === "approval"
          ? {
              kind: "approval",
              choices: availableChoices(approvalChoices(request.approval), stoppedOf(request)),
              busy: busyOf(request),
              engagement,
              ...run,
            }
          : {
              kind: "question",
              input: request.input,
              form: store.form(threadId, request.input),
              busy: busyOf(request),
              engagement,
              ...run,
            },
      );
      if (action === null) return false;
      apply(request, action);
      return true;
    },
    enter: () => {
      const request = pickActiveRequest(queue, store.active(threadId), statusOf);
      if (request === null) return;
      guard.enter(request.requestId);
      rerender();
    },
  }));

  if (active === null) return null;
  const status = responder.status(active.requestId);
  const line = statusLine(status);
  const position = queue.length > 1 ? `[ ${queue.indexOf(active) + 1}/${queue.length} ]` : "";
  const busy = busyOf(active);
  const tone = active.kind === "approval" ? palette.warning : palette.info;
  const note = panelNote({ kind: active.kind, focused: props.focused, engaged, stopped });

  return (
    <box
      onMouseDown={() => {
        props.onFocus();
        clicked(active.requestId);
      }}
      style={{
        marginTop: 1,
        border: true,
        borderStyle: "rounded",
        borderColor: props.focused ? tone : palette.composerBorderMuted,
        backgroundColor: palette.composerPanel,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={
            active.kind === "approval"
              ? `󰳦 Approval needed · ${approvalTitle(active.approval)}`
              : questionTitle(active.input, form)
          }
          style={{ fg: tone, flexShrink: 1 }}
        />
        <box style={{ flexGrow: 1 }} />
        {position ? (
          <text wrapMode="none" content={position} style={{ fg: palette.subtle, flexShrink: 0 }} />
        ) : null}
      </box>
      {active.subagent ? (
        <text
          wrapMode="none"
          truncate
          content={`from subagent: ${active.subagent}`}
          style={{ fg: palette.subtle }}
        />
      ) : null}
      {active.kind === "approval" ? (
        <ApprovalBody
          request={active}
          cwd={props.cwd}
          busy={busy}
          stopped={stopped}
          engaged={engaged && props.focused}
          running={props.running}
          clicked={() => clicked(active.requestId)}
          theme={theme}
          onChoose={(choice) => respond(active, { type: "approval", decision: choice.decision })}
        />
      ) : form !== null ? (
        <QuestionBody
          input={active.input}
          form={form}
          focused={props.focused && !busy && engaged}
          theme={theme}
          onForm={(next) => store.setForm(threadId, active.requestId, next)}
          onType={(question, text) =>
            store.setForm(
              threadId,
              active.requestId,
              setTypedAnswer(store.form(threadId, active.input), question, text),
            )
          }
          onPick={(index) => {
            if (busy || !clicked(active.requestId)) return;
            apply(
              active,
              resolvePanelKey(
                { name: String(index + 1) },
                {
                  kind: "question",
                  input: active.input,
                  form: store.form(threadId, active.input),
                  busy,
                  engagement: "engaged",
                  ...run,
                },
              ) ?? { type: "none" },
            );
          }}
        />
      ) : null}
      {note !== "" && !busy && line === null ? (
        // Wraps rather than truncates: cut in the middle, it no longer says what to do.
        <text content={note} style={{ fg: tone }} />
      ) : null}
      {line ? (
        <text
          wrapMode="none"
          truncate
          content={line.tone === "error" ? `󰀦 ${line.text}` : line.text}
          style={{ fg: line.tone === "error" ? theme.colors.workEntryErrorAccent : palette.muted }}
        />
      ) : null}
    </box>
  );
}

function questionTitle(input: ThreadPendingUserInput, form: QuestionForm | null): string {
  const question = form === null ? input.questions[0] : activeQuestion(input, form);
  const count =
    input.questions.length > 1 && form !== null
      ? ` ${Math.min(form.index, input.questions.length - 1) + 1}/${input.questions.length}`
      : "";
  return `󰞋 Question${count}${question ? ` · ${question.header}` : ""}`;
}

function ApprovalBody(props: {
  request: Extract<PendingRequest, { kind: "approval" }>;
  cwd: string | null;
  busy: boolean;
  /** Its run was stopped: only declining is left. */
  stopped: boolean;
  engaged: boolean;
  running: boolean;
  /** A click on a choice: true once it counts. */
  clicked: () => boolean;
  theme: TuiTheme;
  onChoose: (choice: ApprovalChoice) => void;
}) {
  const { request, theme } = props;
  const palette = theme.palette;
  const { approval, subject } = request;
  const choices = availableChoices(approvalChoices(approval), props.stopped);
  const detail = approval.detail?.trim() ?? "";
  // The provider's summary, unless it only repeats the command or a file name shown above.
  const repeats =
    subject?.type === "command"
      ? subject.command.trim() === detail
      : subject?.type === "files" &&
        subject.files.some((file) => file.path === detail || file.path.endsWith(`/${detail}`));
  const showDetail = detail.length > 0 && !repeats;
  return (
    <box style={{ flexDirection: "column" }}>
      {subject?.type === "command" ? (
        <text content={commandLines(subject.command)} style={{ fg: palette.text }} />
      ) : subject?.type === "files" ? (
        <box style={{ flexDirection: "column" }}>
          {subject.files.slice(0, FILES_MAX).map((file) => (
            <box key={file.path} style={{ flexDirection: "row", height: 1 }}>
              <text
                wrapMode="none"
                truncate
                content={file.path}
                style={{ fg: palette.text, flexShrink: 1 }}
              />
              {file.additions !== undefined ? (
                <text
                  wrapMode="none"
                  content={`  +${file.additions}`}
                  style={{ fg: palette.success, flexShrink: 0 }}
                />
              ) : null}
              {file.deletions !== undefined ? (
                <text
                  wrapMode="none"
                  content={` −${file.deletions}`}
                  style={{ fg: theme.colors.workEntryErrorAccent, flexShrink: 0 }}
                />
              ) : null}
            </box>
          ))}
          {subject.files.length > FILES_MAX ? (
            <text
              wrapMode="none"
              content={`+${subject.files.length - FILES_MAX} more files`}
              style={{ fg: palette.subtle }}
            />
          ) : null}
        </box>
      ) : null}
      {showDetail ? (
        <text
          content={clip(detail, LINE_CHARS_MAX)}
          style={{ fg: subject === null ? palette.text : palette.muted }}
        />
      ) : null}
      {subject?.type === "command" && props.cwd ? (
        <text wrapMode="none" truncate content={`in ${props.cwd}`} style={{ fg: palette.subtle }} />
      ) : null}
      {approval.reason ? (
        <text content={clip(approval.reason, LINE_CHARS_MAX)} style={{ fg: palette.muted }} />
      ) : null}
      {approval.fullAccessOverride ? (
        <text
          content={`${FULL_ACCESS_OVERRIDE_QUESTION} ${fullAccessOverrideExplanation(approval.fullAccessOverride)}`}
          style={{ fg: palette.subtle }}
        />
      ) : null}
      {approval.responseCapability !== "live" ? (
        <text
          content={`The provider process is gone, so this can't be answered.${props.running ? " Ctrl+C stops the run." : ""}`}
          style={{ fg: palette.warning }}
        />
      ) : (
        <box style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {choices.map((choice, index) => (
            <ChoiceButton
              key={choice.decision}
              choice={choice}
              index={index}
              disabled={props.busy}
              muted={!props.engaged}
              theme={theme}
              onPress={() => {
                if (!props.busy && props.clicked()) props.onChoose(choice);
              }}
            />
          ))}
        </box>
      )}
    </box>
  );
}

function ChoiceButton(props: {
  choice: ApprovalChoice;
  index: number;
  disabled: boolean;
  /** Shown but not taking keys yet. */
  muted: boolean;
  theme: TuiTheme;
  onPress: () => void;
}) {
  const { choice, theme } = props;
  const palette = theme.palette;
  const approving = choice.decision.startsWith("accept");
  const fg: TuiColor = props.disabled ? palette.subtle : approving ? palette.text : palette.muted;
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPress();
      }}
      style={{
        flexDirection: "row",
        height: 1,
        marginRight: 2,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor:
          approving && !props.disabled && !props.muted
            ? palette.surfaceWarn
            : palette.composerPanel,
      }}
    >
      <text
        wrapMode="none"
        content={`${props.index + 1} `}
        style={{ fg: props.disabled || props.muted ? palette.subtle : palette.warning }}
      />
      <text
        wrapMode="none"
        content={`${choice.warning ? "󰀦 " : ""}${choice.label}`}
        style={{ fg }}
      />
      <text wrapMode="none" content={` (${choice.key})`} style={{ fg: palette.subtle }} />
    </box>
  );
}

function QuestionBody(props: {
  input: ThreadPendingUserInput;
  form: QuestionForm;
  focused: boolean;
  theme: TuiTheme;
  onForm: (form: QuestionForm) => void;
  onType: (question: ThreadUserInputQuestion, text: string) => void;
  onPick: (index: number) => void;
}) {
  const { input, form, theme } = props;
  const palette = theme.palette;
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const question = activeQuestion(input, form);
  if (question === null) return null;
  const draft = draftOf(form, question);
  const typing = onTextRow(form, question);
  const answered = resolveAnswer(question, draft) !== null;
  const custom = allowsCustomAnswer(question);
  const marker = (selected: boolean) =>
    question.multiSelect ? (selected ? "■" : "□") : selected ? "◉" : "○";
  return (
    <box style={{ flexDirection: "column" }}>
      <text content={question.question} style={{ fg: palette.text }} />
      <box style={{ flexDirection: "column" }}>
        {question.options.map((option, index) => {
          // Typed text wins over picks, as in resolveAnswer.
          const selected =
            draft.selected.includes(optionValue(option)) && draft.custom.trim().length === 0;
          const atCursor = props.focused && !typing && form.cursor === index;
          return (
            <box
              key={`${question.id}:${optionValue(option)}`}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(index);
              }}
              style={{
                flexDirection: "row",
                height: 1,
                backgroundColor: atCursor ? palette.selection : palette.composerPanel,
              }}
            >
              <text
                wrapMode="none"
                content={`${atCursor ? "›" : " "} ${index < 9 ? `${index + 1}.` : "  "} ${marker(selected)} `}
                style={{ fg: selected ? palette.info : palette.subtle, flexShrink: 0 }}
              />
              <text
                wrapMode="none"
                content={option.label}
                style={{ fg: palette.text, flexShrink: 0 }}
              />
              {option.description && option.description !== option.label ? (
                <text
                  wrapMode="none"
                  truncate
                  content={`  ${option.description}`}
                  style={{ fg: palette.muted, flexShrink: 1 }}
                />
              ) : null}
            </box>
          );
        })}
        {custom ? (
          <box
            onMouseDown={() => props.onForm({ ...form, cursor: question.options.length })}
            style={{ flexDirection: "row", minHeight: 1 }}
          >
            <text
              wrapMode="none"
              content={`${typing && props.focused ? "›" : " "} ${question.options.length > 0 ? "Other:" : "Answer:"} `}
              style={{ fg: typing ? palette.info : palette.subtle, flexShrink: 0 }}
            />
            <box style={{ flexGrow: 1, minWidth: 0 }}>
              <textarea
                key={`${input.requestId}:${question.id}:${form.textRevision}`}
                ref={(node: TextareaRenderable | null) => {
                  textareaRef.current = node;
                  node?.gotoBufferEnd();
                }}
                focused={props.focused && typing}
                initialValue={draft.custom}
                placeholder={typing ? "Type your answer" : "↓ to type your own answer"}
                keyBindings={[{ name: "return", shift: true, action: "newline" }]}
                onContentChange={() => props.onType(question, textareaRef.current?.plainText ?? "")}
                style={{
                  flexGrow: 1,
                  minWidth: 0,
                  maxHeight: TEXT_ROWS_MAX,
                  backgroundColor: palette.composerPanel,
                  focusedBackgroundColor: palette.composerPanel,
                  textColor: palette.text,
                  focusedTextColor: palette.text,
                  placeholderColor: palette.subtle,
                }}
              />
            </box>
          </box>
        ) : null}
      </box>
      {input.questions.length > 1 ? (
        <text
          wrapMode="none"
          truncate
          content={input.questions
            .map((entry, index) =>
              index === form.index
                ? `● ${entry.header}`
                : resolveAnswer(entry, draftOf(form, entry)) !== null
                  ? `✓ ${entry.header}`
                  : `○ ${entry.header}`,
            )
            .join("  ")}
          style={{ fg: answered ? palette.muted : palette.subtle }}
        />
      ) : null}
    </box>
  );
}
