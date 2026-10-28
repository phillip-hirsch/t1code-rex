// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- The view runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useAtomValue } from "@effect/atom-react";
import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { CommandResult, ViewApi } from "./connection.ts";
import {
  buildPickerEntries,
  defaultSelection,
  modelChangeBlockReason,
  openPicker,
  reducePickerKey,
  selectionLabel,
  type PickerState,
} from "./picker.ts";
import {
  activeRequest,
  approvalChoices,
  initialDraft,
  optionValue,
  resolveAnswer,
  togglePicked,
  type QuestionDraft,
} from "./requests.ts";
import { PendingWork } from "./pending.ts";
import { resolveRexStatus, sameRexStatus, type RexStatus } from "./status.ts";
import { markdownStyles, palette } from "./theme.ts";
import { buildTimelineRows } from "./timeline.ts";
import {
  clipLines,
  fitItems,
  hintRows,
  lastItems,
  planLayout,
  truncateText,
  wrapText,
} from "./layout.ts";
import { approvalPlan, pickerPlan, questionPlan } from "./panelLines.ts";
import { Footer, Lines, Panel } from "./Panels.tsx";
import { Transcript, type TranscriptHandle } from "./Transcript.tsx";
import { useThreadData } from "./useThreadData.ts";

export interface AppProps {
  readonly connection: ViewApi;
  readonly threadId: ThreadId;
  /** Set for `--new`: the first send launches the thread in this project. */
  readonly newThread: { readonly projectId: ProjectId } | null;
  readonly onStatus: (status: RexStatus) => void;
  readonly onQuit: () => void;
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_RUNS: ReadonlyArray<never> = [];

const nowIso = () => new Date().toISOString();

const RUN_ACTIVE = "Model switching waits until the run finishes.";
const APPROVAL_ARM_MS = 300;
/** Queued messages shown at once; older ones are counted. */
const QUEUE_ROWS = 3;
/** Composer text lines before it scrolls. */
const COMPOSER_LINES = 8;
/** Lines an error or notice shows before it's cut. */
const MESSAGE_LINES = 3;
const APPROVAL_FIRST = "Answer the approval first (a/s/d); your message stays here.";

function nextRuntimeMode(mode: RuntimeMode): RuntimeMode {
  return mode === "full-access" ? "approval-required" : "full-access";
}

export function App(props: AppProps) {
  const { connection, threadId } = props;
  const renderer = useRenderer();
  const styles = useMemo(() => markdownStyles(renderer.nativeScene), [renderer]);
  const [launched, setLaunched] = useState(props.newThread === null);
  const [pending] = useState(() => new PendingWork(props.newThread === null));
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const terminal = useTerminalDimensions();
  // The composer's wrapped lines, which set its height and so the rest of the layout.
  const [composerLines, setComposerLines] = useState(1);
  const composerRef = useRef<TextareaRenderable | null>(null);
  const transcriptRef = useRef<TranscriptHandle | null>(null);
  const data = useThreadData(connection, threadId, launched);
  const loadedProviders = useAtomValue(connection.providersAtom);
  const providers = loadedProviders ?? NO_PROVIDERS;
  const noProviders =
    loadedProviders === null
      ? "Still connecting to the server; try again in a moment."
      : "No usable provider. Run `tr3x doctor`.";
  const connectionState = Option.getOrNull(
    AsyncResult.value(useAtomValue(connection.connectionStateAtom)),
  );

  const thread = data.structure?.thread ?? null;
  const [draftSelection, setDraftSelection] = useState<ModelSelection | null>(null);
  const [draftMode, setDraftMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const selection = thread?.modelSelection ?? draftSelection ?? defaultSelection(providers);
  const runtimeMode = thread?.runtimeMode ?? draftMode;
  const activeRun = data.queue?.activeRun ?? null;
  const supportsHandoff = !launched || threadSupportsProviderHandoff(data.structure);
  /** A run is on, or about to be: no switching until it settles. */
  const busy = () => {
    const { registry } = connection;
    const messages = registry.get(data.atoms.structureAtom)?.projection.messages ?? [];
    return registry.get(data.atoms.queueAtom)?.activeRun != null || pending.busy(messages);
  };
  const pickerDisabled = busy() ? RUN_ACTIVE : null;
  const runs = data.structure?.runs ?? NO_RUNS;
  const latestRun = runs.at(-1) ?? null;

  const rows = useMemo(
    () => buildTimelineRows(data.items, runs, providers),
    [data.items, runs, providers],
  );
  const shown = activeRequest(data.requests);
  const shownId =
    shown?.type === "question"
      ? shown.input.requestId
      : shown?.type === "approval"
        ? shown.approval.requestId
        : null;
  const request = shownId !== null && pending.isAnswered(shownId) ? null : shown;
  const approvalId = request?.type === "approval" ? request.approval.requestId : null;
  // Keys typed as an approval appears were meant for the composer; arm it after a beat.
  useEffect(() => {
    if (approvalId === null) return;
    const timer = setTimeout(() => {
      pending.armApproval(approvalId);
      rerender();
    }, APPROVAL_ARM_MS);
    return () => clearTimeout(timer);
  }, [approvalId, pending]);
  const answered = request?.type === "question" ? pending.answersTo(request.input.requestId) : null;
  const question =
    request?.type === "question"
      ? request.input.questions.find((candidate) => !answered?.has(candidate.id))
      : undefined;
  const questionKey =
    request?.type === "question" && question ? `${request.input.requestId}:${question.id}` : null;
  const questionDraft =
    question && questionKey ? (pending.draftOf(questionKey) ?? initialDraft(question)) : null;

  // Keys can arrive faster than React renders, so the key handler reads the ref.
  // A question's suggested answer starts in the composer, as on web, until the user edits it.
  const suggestion = questionDraft?.text ?? "";
  useEffect(() => {
    const composer = composerRef.current;
    if (questionKey && composer && suggestion && composer.plainText === "") {
      composer.setText(suggestion);
    }
  }, [composerRef, questionKey, suggestion]);

  const [picker, setPickerState] = useState<PickerState | null>(null);
  const pickerRef = useRef<PickerState | null>(null);
  const setPicker = (next: PickerState | null) => {
    pickerRef.current = next;
    setPickerState(next);
  };
  const pickerEntries = useMemo(
    () => buildPickerEntries(providers, supportsHandoff ? null : (selection?.instanceId ?? null)),
    [providers, supportsHandoff, selection?.instanceId],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [seenRunId, setSeenRunId] = useState<RunId | null>(null);

  const lastReply = useMemo(() => {
    const reply = rows.findLast((row) => row.kind === "assistant");
    return reply?.kind === "assistant"
      ? (reply.text
          .split("\n")
          .find((line) => line.trim())
          ?.replace(/\*\*|`/gu, "") ?? null)
      : null;
  }, [rows]);
  const title = thread?.title ?? (launched ? "Loading…" : "New thread");
  const status = resolveRexStatus({
    title,
    requests: data.requests,
    activeRun: activeRun !== null,
    latestRun: latestRun === null ? null : { id: latestRun.id, status: latestRun.status },
    seenRunId,
    lastReply,
  });
  const lastStatus = useRef<RexStatus | null>(null);
  // Reports state to the terminal (OSC 7501, OSC 2), outside React.
  useEffect(() => {
    if (sameRexStatus(lastStatus.current, status)) return;
    lastStatus.current = status;
    props.onStatus(status);
  });

  /**
   * Answers the request's first unanswered question, read fresh, so keys that
   * arrive before a render move through the questions in order.
   */
  const modelHint = activeRun ? "esc stop" : "^p model";
  const modeHint = `^t ${nextRuntimeMode(runtimeMode)}`;
  const footerHints = [
    "enter send",
    "shift+enter newline",
    modelHint,
    modeHint,
    "pgup history",
    "^c quit",
  ];
  const queuedRuns = data.queue?.queuedRuns ?? [];
  const queueHint = data.queue?.isHeld
    ? "held since stop; sending a message resumes them  ·  ctrl+x cancels the last"
    : "ctrl+x cancels the last queued message";
  const syncLine =
    data.error && rows.length > 0 ? `The thread stopped syncing: ${data.error}` : null;
  // The run-active notice is moot once the run ends.
  const shownNotice = notice && !(notice === RUN_ACTIVE && activeRun === null) ? notice : null;
  // Lines below the transcript sit after one column of padding.
  const wrapLine = (text: string | null) => (text ? wrapText(text, terminal.width - 1) : []);
  const syncLines = wrapLine(syncLine);
  const noticeLines = wrapLine(shownNotice);
  // A message shows a few lines, and its start when down to one.
  const clipMessage = (lines: ReadonlyArray<string>, max: number) =>
    max === 1 && lines.length > 1
      ? [truncateText(lines.join(" "), terminal.width - 1)]
      : clipLines(lines, max);
  const queueHintLines = wrapLine(queueHint);
  const requestPlan =
    request?.type === "approval"
      ? approvalPlan(
          request.approval,
          pending.isApprovalArmed(request.approval.requestId),
          terminal.width,
        )
      : question && questionDraft
        ? questionPlan(
            question,
            questionDraft,
            request?.type === "question" && request.input.dismissible,
            terminal.width,
          )
        : null;
  const picked = picker
    ? pickerPlan(pickerEntries, picker, selection, !supportsHandoff, terminal.width)
    : null;
  const layout = planLayout({
    height: terminal.height,
    footerRows: hintRows(footerHints, terminal.width),
    composerLines: Math.min(COMPOSER_LINES, composerLines),
    queue: { length: queuedRuns.length, window: QUEUE_ROWS, hintLines: queueHintLines.length },
    messages: [syncLines, noticeLines].map((lines) => Math.min(MESSAGE_LINES, lines.length)),
    request: requestPlan,
    picker: picked,
  });
  // Its keys answer only while it shows.
  const requestHidden = requestPlan !== null && !layout.requestFits;
  const queue = lastItems(queuedRuns, layout.queueShown);
  const queueCount =
    queue.shown.length > 0 ? `+${queue.hidden} more queued` : `+${queue.hidden} queued`;
  // Folded, the footer keeps what fits one row; sending and quitting go last.
  const shownHints = layout.footerFolded
    ? fitItems(footerHints, (kept) => hintRows(kept, terminal.width) === 1, [
        "pgup history",
        "shift+enter newline",
        modeHint,
        modelHint,
      ])
    : footerHints;

  const currentQuestion = () => {
    if (request?.type !== "question") return null;
    const { requestId, questions } = request.input;
    const given = pending.answersTo(requestId);
    const current = questions.find((candidate) => !given.has(candidate.id));
    if (current === undefined) return null;
    const key = `${requestId}:${current.id}`;
    return {
      requestId,
      questions,
      given,
      current,
      key,
      draft: pending.draftOf(key) ?? initialDraft(current),
    };
  };

  const answerQuestion = async (text: string): Promise<boolean> => {
    const fresh = currentQuestion();
    if (fresh === null) return false;
    const { requestId, questions, given, current, draft } = fresh;
    const answer = resolveAnswer(current, { ...draft, text });
    if (answer === null) return false;
    if (questions.some((candidate) => candidate.id !== current.id && !given.has(candidate.id))) {
      pending.recordAnswer(requestId, current.id, answer);
      rerender();
      return true;
    }
    // The last answer counts only once the server takes it, so a failure can be retried.
    if (!pending.beginAnswer(requestId)) return false;
    rerender();
    const result = await connection.respondToUserInput({
      threadId,
      requestId,
      answers: Object.fromEntries(
        questions.map((candidate) => [
          candidate.id,
          candidate.id === current.id ? answer : given.get(candidate.id),
        ]),
      ),
    });
    pending.endAnswer(requestId, result.ok);
    if (result.ok) pending.recordAnswer(requestId, current.id, answer);
    setNotice(result.ok ? null : `Could not answer: ${result.error}`);
    rerender();
    return result.ok;
  };

  /** Starts the thread with its first message, once; later sends wait for that. */
  const dispatch = async (
    message: StartThreadTurnInput["message"],
    interactionMode: ProviderInteractionMode,
    modelSelection: ModelSelection,
  ): Promise<CommandResult> => {
    const newThread = props.newThread;
    if (newThread !== null && !pending.isLaunched) {
      const { result, started } = await pending.launch(() =>
        connection.startTurn({
          threadId,
          message,
          modelSelection,
          titleSeed: message.text,
          runtimeMode,
          interactionMode,
          bootstrap: {
            createThread: {
              projectId: newThread.projectId,
              title: "New thread",
              modelSelection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: nowIso(),
            },
          },
        }),
      );
      if (result.ok) setLaunched(true);
      if (started || !result.ok) return result;
    }
    return await connection.startTurn({
      threadId,
      message,
      runtimeMode,
      interactionMode,
      dispatchMode: "auto",
    });
  };

  const send = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed === "/model") {
      togglePicker();
      return true;
    }
    // An answer the user can't see would go unread; the text stays in the composer.
    if (requestHidden) return false;
    if (questionDraft) return await answerQuestion(text);
    // A run waiting on an approval would take the message as a steer; answer first.
    if (request?.type === "approval") {
      setNotice(APPROVAL_FIRST);
      return false;
    }
    if (selection === null) {
      setNotice(noProviders);
      return false;
    }
    const message = {
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      role: "user" as const,
      text: trimmed,
      attachments: [],
    };
    pending.beginSend(message.messageId);
    rerender();
    const result = await dispatch(
      message,
      thread?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      selection,
    );
    pending.endSend(message.messageId, result.ok);
    setNotice(result.ok ? null : `Could not send: ${result.error}`);
    rerender();
    return result.ok;
  };

  const submitComposer = () => {
    const composer = composerRef.current;
    if (!composer) return;
    const text = composer.plainText;
    composer.clear();
    // A failed send's text goes back, after anything typed or restored since.
    void send(text).then((ok) => {
      if (ok || composer.isDestroyed) return;
      const current = composer.plainText;
      composer.setText(current ? `${current}\n${text}` : text);
    });
  };

  const togglePicker = () => {
    if (pickerRef.current) return setPicker(null);
    if (pickerDisabled) return setNotice(pickerDisabled);
    if (pickerEntries.length === 0) return setNotice(noProviders);
    setNotice(null);
    setPicker(openPicker(pickerEntries, selection));
  };

  const pick = async (next: ModelSelection) => {
    setPicker(null);
    if (!launched) return setDraftSelection(next);
    if (busy()) return setNotice(RUN_ACTIVE);
    const fresh = connection.registry.get(data.atoms.structureAtom)?.projection ?? null;
    const runtime = fresh === null ? null : deriveThreadStructureRuntime(fresh);
    const blocked =
      fresh === null
        ? null
        : modelChangeBlockReason({
            providers,
            hasStartedSession: runtime !== null,
            supportsHandoff: threadSupportsProviderHandoff(fresh),
            current: fresh.thread.modelSelection,
            currentProviderInstanceId: runtime?.providerInstanceId ?? null,
            next,
          });
    if (blocked !== null) return setNotice(blocked);
    pending.beginSwitch();
    rerender();
    const result = await connection.updateThread({ threadId, modelSelection: next });
    pending.endSwitch();
    setNotice(result.ok ? null : `Could not switch: ${result.error}`);
    rerender();
  };

  const toggleRuntimeMode = async () => {
    const next = nextRuntimeMode(runtimeMode);
    if (!launched) return setDraftMode(next);
    const result = await connection.setRuntimeMode({ threadId, runtimeMode: next });
    setNotice(result.ok ? null : `Could not change mode: ${result.error}`);
  };

  /** Shows a failed command's error; a success leaves the notice alone. */
  const reportFailure = (what: string) => (result: CommandResult) => {
    if (!result.ok) setNotice(`${what}: ${result.error}`);
  };

  const stop = async () => {
    if (activeRun === null) return;
    const result = await connection.interruptTurn({ threadId, runId: activeRun.id });
    setNotice(result.ok ? null : `Could not stop: ${result.error}`);
  };

  useKeyboard((key: KeyEvent) => {
    if (latestRun !== null && activeRun === null && seenRunId !== latestRun.id)
      setSeenRunId(latestRun.id);
    const consume = () => key.preventDefault();
    const shownPicker = pickerRef.current;
    if (shownPicker) {
      consume();
      const outcome = reducePickerKey(pickerEntries, shownPicker, key);
      if (outcome?.type === "close") setPicker(null);
      else if (outcome?.type === "state") setPicker(outcome.state);
      else if (outcome?.type === "select") void pick(outcome.selection);
      return;
    }
    if (key.ctrl && key.name === "c") {
      consume();
      const composer = composerRef.current;
      if (composer && composer.plainText.length > 0) composer.clear();
      else if (activeRun !== null) void stop();
      else props.onQuit();
      return;
    }
    if (key.ctrl && key.name === "p") return (consume(), togglePicker());
    if (key.ctrl && key.name === "t") return (consume(), void toggleRuntimeMode());
    if (key.name === "pageup" || key.name === "pagedown") {
      consume();
      const atTop = transcriptRef.current?.page(key.name === "pageup" ? -1 : 1);
      if (atTop && data.history.hasMoreHistory && !data.history.loading)
        void connection
          .loadEarlier(threadId)
          .then(reportFailure("Could not load earlier messages"));
      return;
    }
    if (key.ctrl && key.name === "x") {
      consume();
      const queued = data.queue?.queuedRuns.at(-1);
      if (queued) {
        void connection
          .cancelQueuedRun({ threadId, runId: queued.run.id })
          .then(reportFailure("Could not cancel the queued message"));
      }
      return;
    }
    // a/s/d answer an approval only from an empty composer, once it's armed, once per request.
    if (
      request?.type === "approval" &&
      !requestHidden &&
      (composerRef.current?.plainText ?? "") === ""
    ) {
      const requestId = request.approval.requestId;
      const choice = approvalChoices(request.approval).find(
        (candidate) => candidate.key === key.name && !key.ctrl && !key.meta,
      );
      // While an answer is in flight, a key passes on to the composer rather than vanishing.
      if (choice && pending.isApprovalArmed(requestId) && pending.beginAnswer(requestId)) {
        consume();
        rerender();
        void connection
          .respondToApproval({ threadId, requestId, decision: choice.decision })
          .then((result) => {
            pending.endAnswer(requestId, result.ok);
            setNotice(result.ok ? null : `Could not answer: ${result.error}`);
            rerender();
          });
        return;
      }
    }
    const fresh = requestHidden ? null : currentQuestion();
    if (fresh !== null) {
      const { current, key: draftKey, draft } = fresh;
      const setDraft = (next: QuestionDraft) => {
        pending.setDraft(draftKey, next);
        rerender();
      };
      const count = current.options.length;
      if ((key.name === "up" || key.name === "down") && count > 0) {
        consume();
        // Moving to an option drops an untouched suggestion, so Enter picks the option.
        if (suggestion && composerRef.current?.plainText === suggestion)
          composerRef.current.clear();
        setDraft({
          ...draft,
          cursor: (draft.cursor + (key.name === "up" ? count - 1 : 1)) % count,
        });
        return;
      }
      if (key.name === "tab" && current.multiSelect) {
        const option = current.options[draft.cursor];
        if (option) setDraft(togglePicked(draft, optionValue(option)));
        return consume();
      }
      if (key.name === "return" && !key.shift && (composerRef.current?.plainText ?? "") === "") {
        consume();
        void answerQuestion("");
        return;
      }
      if (key.name === "escape" && request?.type === "question" && request.input.dismissible) {
        consume();
        void connection
          .dismissUserInput({ threadId, requestId: request.input.requestId })
          .then(reportFailure("Could not dismiss the question"));
        return;
      }
    }
    if (key.name === "escape" && activeRun !== null) return (consume(), void stop());
  });

  const reconnecting = connectionState !== null && connectionState.phase !== "connected";
  const header = [
    title,
    selectionLabel(providers, selection),
    runtimeMode,
    ...(reconnecting
      ? [connectionState.phase === "connecting" ? "connecting…" : "reconnecting…"]
      : []),
  ].join("  ·  ");
  const historyHeader = data.history.loading
    ? "Loading earlier messages…"
    : data.history.error
      ? `Could not load earlier messages: ${data.history.error}`
      : data.history.hasMoreHistory
        ? "PgUp at the top loads earlier messages"
        : null;
  const empty = !launched
    ? "New thread. Type a message; the first send starts it."
    : data.status === "deleted"
      ? "This thread was deleted."
      : data.error
        ? `Could not load this thread: ${data.error}`
        : data.status === "live"
          ? "No messages yet."
          : "Loading thread…";

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {layout.header ? (
        <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
          <text
            content={truncateText(header, terminal.width - 2)}
            fg={reconnecting ? palette.warning : palette.muted}
            wrapMode="none"
          />
        </box>
      ) : null}
      <Transcript
        ref={transcriptRef}
        rows={rows}
        styles={styles}
        header={historyHeader}
        empty={empty}
        visible={layout.transcriptRows > 0}
      />
      {requestHidden ? (
        <Lines
          lines={[
            truncateText(
              `${request?.type === "approval" ? "Approval" : "Question"} waiting: make the pane taller to answer`,
              terminal.width - 1,
            ),
          ].slice(0, layout.requestRows)}
          color={palette.warning}
        />
      ) : requestPlan ? (
        <Panel
          plan={requestPlan}
          rows={layout.requestRows}
          color={request?.type === "approval" ? palette.warning : palette.accent}
        />
      ) : null}
      {queuedRuns.length > 0 && !layout.queueFolded ? (
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          <Lines lines={queue.hidden > 0 ? [queueCount] : []} color={palette.subtle} />
          <Lines
            lines={queue.shown.map((queued) =>
              truncateText(
                `${queued.run.queueHeld === true ? "held" : "queued"}: ${queued.text}`,
                terminal.width - 1,
              ),
            )}
            color={palette.muted}
          />
          <Lines lines={layout.queueHint ? queueHintLines : []} color={palette.subtle} />
        </box>
      ) : null}
      {picked ? <Panel plan={picked} rows={layout.pickerRows} color={palette.accent} /> : null}
      <Lines lines={clipMessage(syncLines, layout.messageLines[0] ?? 0)} color={palette.warning} />
      <Lines lines={clipMessage(noticeLines, layout.messageLines[1] ?? 0)} color={palette.error} />
      <box
        border
        borderColor={palette.border}
        // oxlint-disable-next-line t3code/no-native-title-tooltip -- OpenTUI's border title.
        title={layout.queueFolded ? ` ${queueCount} ` : ""}
        titleColor={palette.subtle}
        style={{ flexShrink: 0, height: 2 + layout.composerLines, paddingLeft: 1 }}
      >
        <textarea
          ref={composerRef}
          focused={picker === null}
          placeholder={
            questionDraft ? "Type an answer, or enter picks the highlighted option" : "Message"
          }
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onSubmit={submitComposer}
          onContentChange={() =>
            // The border and padding take 3 columns; `virtualLineCount` lags behind the text.
            setComposerLines(
              wrapText(composerRef.current?.plainText ?? "", terminal.width - 3).length,
            )
          }
          style={{ flexGrow: 1 }}
        />
      </box>
      <Footer hints={shownHints} />
    </box>
  );
}
