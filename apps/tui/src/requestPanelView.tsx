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
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

import { allowsCustomAnswer, answerText, optionValue, resolveAnswer } from "./questionAnswers.ts";
import {
  activeQuestion,
  createArmGuard,
  draftOf,
  isOpen,
  onTextRow,
  pickActiveRequest,
  resolvePanelKey,
  setTypedAnswer,
  stepRequest,
  type PanelAction,
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
  readonly handleKey: (key: KeyEvent) => boolean;
}

export interface RequestPanelProps {
  readonly threadId: ThreadId;
  readonly queue: ReadonlyArray<PendingRequest>;
  readonly store: RequestPanelStore;
  readonly responder: RequestResponder;
  readonly theme: TuiTheme;
  readonly focused: boolean;
  /** Where the thread's commands run, shown under a command approval. */
  readonly cwd: string | null;
  readonly onFocus: () => void;
  readonly onStatus: (message: string) => void;
  /** The footer's key hints for what the panel shows. */
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
): string {
  const step = count > 1 ? "  [ ] request" : "";
  if (request === null) return "";
  if (request.kind === "approval") {
    const choices = approvalChoices(request.approval);
    if (choices.length === 0) return `esc stop run${step}  tab focus`;
    return `${choices.map((choice) => choice.key).join("/")} or 1-${choices.length} choose${step}  tab focus`;
  }
  const question = form === null ? null : activeQuestion(request.input, form);
  const dismiss = request.input.dismissible ? "  esc dismiss" : "";
  if (question !== null && form !== null && onTextRow(form, question)) {
    return `type an answer  ⏎ ${form.index < request.input.questions.length - 1 ? "next" : "submit"}  ↑ options${dismiss}  tab focus`;
  }
  const many = request.input.questions.length > 1 ? "  ←→ question" : "";
  return `↑↓ move  1-9 pick  ⏎ ${form !== null && form.index < request.input.questions.length - 1 ? "next" : "submit"}${many}${step}${dismiss}`;
}

/**
 * Approvals and questions, in the composer's place while any is pending. Keys reach it the
 * way they reach the composer: the shell's keyboard hook calls its handle first.
 */
export function RequestPanel(props: RequestPanelProps) {
  const { threadId, queue, store, responder, theme, ref } = props;
  const palette = theme.palette;
  useSyncExternalStore(store.subscribe, store.version);
  useSyncExternalStore(responder.subscribe, responder.version);
  const statusOf = (requestId: RuntimeRequestId) => responder.status(requestId);
  const active = pickActiveRequest(queue, store.active(threadId), statusOf);
  const activeId = active?.requestId ?? null;
  const form = active?.kind === "question" ? store.form(threadId, active.input) : null;

  // Keys typed just before a request shows up were meant for the composer.
  const [armGuard] = useState(() => createArmGuard());
  useEffect(() => armGuard.show(activeId), [activeId, armGuard]);
  const isArmed = (requestId: RuntimeRequestId) => armGuard.armed(requestId);

  const hints = hintsFor(active, form, queue.length);
  const { onHints } = props;
  useEffect(() => onHints(hints), [hints, onHints]);

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
      case "step-request": {
        const next = stepRequest(queue, request.requestId, action.delta, statusOf);
        if (next === null) props.onStatus("No other request is waiting");
        else store.setActive(threadId, next);
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
      const action = resolvePanelKey(
        key,
        request.kind === "approval"
          ? {
              kind: "approval",
              choices: approvalChoices(request.approval),
              busy: busyOf(request),
              armed: isArmed(request.requestId),
            }
          : {
              kind: "question",
              input: request.input,
              form: store.form(threadId, request.input),
              busy: busyOf(request),
              armed: isArmed(request.requestId),
            },
      );
      if (action === null) return false;
      apply(request, action);
      return true;
    },
  }));

  if (active === null) return null;
  const status = responder.status(active.requestId);
  const line = statusLine(status);
  const position = queue.length > 1 ? `[ ${queue.indexOf(active) + 1}/${queue.length} ]` : "";
  const busy = busyOf(active);
  const tone = active.kind === "approval" ? palette.warning : palette.info;

  return (
    <box
      onMouseDown={props.onFocus}
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
          armed={() => isArmed(active.requestId)}
          theme={theme}
          onChoose={(choice) => respond(active, { type: "approval", decision: choice.decision })}
        />
      ) : form !== null ? (
        <QuestionBody
          input={active.input}
          form={form}
          focused={props.focused && !busy}
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
            if (!isArmed(active.requestId) || busy) return;
            apply(
              active,
              resolvePanelKey(
                { name: String(index + 1) },
                { kind: "question", input: active.input, form, busy, armed: true },
              ) ?? { type: "none" },
            );
          }}
        />
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
  armed: () => boolean;
  theme: TuiTheme;
  onChoose: (choice: ApprovalChoice) => void;
}) {
  const { request, theme } = props;
  const palette = theme.palette;
  const { approval, subject } = request;
  const choices = approvalChoices(approval);
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
          content="The provider process is gone. Stop or restart the run to continue."
          style={{ fg: palette.warning }}
        />
      ) : (
        <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }}>
          {choices.map((choice, index) => (
            <ChoiceButton
              key={choice.decision}
              choice={choice}
              index={index}
              disabled={props.busy}
              theme={theme}
              onPress={() => {
                if (!props.busy && props.armed()) props.onChoose(choice);
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
        backgroundColor: approving && !props.disabled ? palette.surfaceWarn : palette.composerPanel,
      }}
    >
      <text
        wrapMode="none"
        content={`${props.index + 1} `}
        style={{ fg: props.disabled ? palette.subtle : palette.warning }}
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
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {question.options.map((option, index) => {
          const selected =
            draft.selected.includes(optionValue(option)) &&
            (question.multiSelect || draft.custom.trim().length === 0);
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
