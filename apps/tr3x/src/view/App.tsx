// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The view runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useAtomValue } from "@effect/atom-react";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ViewConnection } from "./connection.ts";
import {
  buildPickerEntries,
  defaultSelection,
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
import { resolveRexStatus, sameRexStatus, type RexStatus } from "./status.ts";
import { markdownStyle, palette } from "./theme.ts";
import { buildTimelineRows } from "./timeline.ts";
import { ApprovalPanel, PickerPanel, QuestionPanel } from "./Panels.tsx";
import { Transcript, type TranscriptHandle } from "./Transcript.tsx";
import { useThreadData } from "./useThreadData.ts";

export interface AppProps {
  readonly connection: ViewConnection;
  readonly threadId: ThreadId;
  /** Set for `--new`: the first send launches the thread in this project. */
  readonly newThread: { readonly projectId: ProjectId } | null;
  readonly onStatus: (status: RexStatus) => void;
  readonly onQuit: () => void;
}

type Answer = string | ReadonlyArray<string>;

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_RUNS: ReadonlyArray<never> = [];

const nowIso = () => new Date().toISOString();

const RUN_ACTIVE = "Model switching waits until the run finishes.";

function nextRuntimeMode(mode: RuntimeMode): RuntimeMode {
  return mode === "full-access" ? "approval-required" : "full-access";
}

export function App(props: AppProps) {
  const { connection, threadId } = props;
  const renderer = useRenderer();
  const style = useMemo(() => markdownStyle(renderer.nativeScene), [renderer]);
  const [launched, setLaunched] = useState(props.newThread === null);
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
  const pickerDisabled = activeRun !== null ? RUN_ACTIVE : null;
  const runs = data.structure?.runs ?? NO_RUNS;
  const latestRun = runs.at(-1) ?? null;

  const rows = useMemo(
    () => buildTimelineRows(data.items, runs, providers),
    [data.items, runs, providers],
  );
  const request = activeRequest(data.requests);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, QuestionDraft>>(new Map());
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const answerKey = (questionId: string) =>
    request?.type === "question" ? `${request.input.requestId}:${questionId}` : "";
  const question =
    request?.type === "question"
      ? request.input.questions.find((candidate) => !answers.has(answerKey(candidate.id)))
      : undefined;
  const questionKey = question ? answerKey(question.id) : null;
  const questionDraft =
    question && questionKey ? (drafts.get(questionKey) ?? initialDraft(question)) : null;

  // Keys can arrive faster than React renders, so the key handler reads the ref.
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
  const composerRef = useRef<TextareaRenderable | null>(null);
  const transcriptRef = useRef<TranscriptHandle | null>(null);

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

  const answerQuestion = async (text: string) => {
    if (request?.type !== "question" || !question || !questionKey || !questionDraft) return false;
    const answer = resolveAnswer(question, { ...questionDraft, text });
    if (answer === null) return false;
    const next = new Map(answers).set(questionKey, answer);
    setAnswers(next);
    const { requestId, questions } = request.input;
    if (questions.some((candidate) => !next.has(answerKey(candidate.id)))) return true;
    const result = await connection.respondToUserInput({
      threadId,
      requestId,
      answers: Object.fromEntries(
        questions.map((candidate) => [candidate.id, next.get(answerKey(candidate.id))]),
      ),
    });
    setNotice(result.ok ? null : `Could not answer: ${result.error}`);
    return true;
  };

  const send = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed === "/model") {
      togglePicker();
      return true;
    }
    if (questionDraft) return await answerQuestion(text);
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
    const interactionMode = thread?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
    const result =
      props.newThread !== null && !launched
        ? await connection.startTurn({
            threadId,
            message,
            modelSelection: selection,
            titleSeed: trimmed,
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: props.newThread.projectId,
                title: "New thread",
                modelSelection: selection,
                runtimeMode,
                interactionMode,
                branch: null,
                worktreePath: null,
                createdAt: nowIso(),
              },
            },
          })
        : await connection.startTurn({
            threadId,
            message,
            runtimeMode,
            interactionMode,
            dispatchMode: "auto",
          });
    if (result.ok && !launched) setLaunched(true);
    setNotice(result.ok ? null : `Could not send: ${result.error}`);
    return result.ok;
  };

  const submitComposer = () => {
    const composer = composerRef.current;
    if (!composer) return;
    const text = composer.plainText;
    composer.clear();
    void send(text).then((ok) => {
      if (!ok && composer.plainText === "") composer.setText(text);
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
    if (activeRun !== null) return setNotice(pickerDisabled);
    const result = await connection.updateThread({ threadId, modelSelection: next });
    setNotice(result.ok ? null : `Could not switch: ${result.error}`);
  };

  const toggleRuntimeMode = async () => {
    const next = nextRuntimeMode(runtimeMode);
    if (!launched) return setDraftMode(next);
    const result = await connection.setRuntimeMode({ threadId, runtimeMode: next });
    setNotice(result.ok ? null : `Could not change mode: ${result.error}`);
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
        void connection.loadEarlier(threadId);
      return;
    }
    if (key.ctrl && key.name === "x") {
      consume();
      const queued = data.queue?.queuedRuns.at(-1);
      if (queued) void connection.cancelQueuedRun({ threadId, runId: queued.run.id });
      return;
    }
    if (request?.type === "approval") {
      const choice = approvalChoices(request.approval).find(
        (candidate) =>
          candidate.key === key.name || (key.name === "return" && candidate.decision === "accept"),
      );
      if (!choice) return;
      consume();
      void connection
        .respondToApproval({
          threadId,
          requestId: request.approval.requestId,
          decision: choice.decision,
        })
        .then((result) => setNotice(result.ok ? null : `Could not answer: ${result.error}`));
      return;
    }
    if (question && questionKey && questionDraft) {
      const setDraft = (draft: QuestionDraft) => setDrafts(new Map(drafts).set(questionKey, draft));
      const count = question.options.length;
      if ((key.name === "up" || key.name === "down") && count > 0) {
        consume();
        setDraft({
          ...questionDraft,
          cursor: (questionDraft.cursor + (key.name === "up" ? count - 1 : 1)) % count,
        });
        return;
      }
      if (key.name === "tab" && question.multiSelect) {
        const option = question.options[questionDraft.cursor];
        if (option) setDraft(togglePicked(questionDraft, optionValue(option)));
        return consume();
      }
      if (key.name === "return" && !key.shift && (composerRef.current?.plainText ?? "") === "") {
        consume();
        void answerQuestion("");
        return;
      }
      if (key.name === "escape" && request?.type === "question" && request.input.dismissible) {
        consume();
        void connection.dismissUserInput({ threadId, requestId: request.input.requestId });
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
    : data.history.hasMoreHistory
      ? "PgUp at the top loads earlier messages"
      : null;
  const empty = !launched
    ? "New thread. Type a message; the first send starts it."
    : data.status === "deleted"
      ? "This thread was deleted."
      : data.status === "live"
        ? "No messages yet."
        : "Loading thread…";

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text
          content={header}
          fg={reconnecting ? palette.warning : palette.muted}
          truncate
          wrapMode="none"
        />
      </box>
      <Transcript
        ref={transcriptRef}
        rows={rows}
        style={style}
        header={historyHeader}
        empty={empty}
      />
      {request?.type === "approval" ? <ApprovalPanel approval={request.approval} /> : null}
      {question && questionDraft ? (
        <QuestionPanel
          question={question}
          draft={questionDraft}
          dismissible={request?.type === "question" && request.input.dismissible}
        />
      ) : null}
      {data.queue?.queuedRuns.length ? (
        <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1 }}>
          {data.queue.queuedRuns.map((queued) => (
            <text
              key={queued.run.id}
              content={`queued: ${queued.text}`}
              fg={palette.muted}
              truncate
              wrapMode="none"
            />
          ))}
          <text content="ctrl+x cancels the last queued message" fg={palette.subtle} />
        </box>
      ) : null}
      {picker ? (
        <PickerPanel
          entries={pickerEntries}
          state={picker}
          current={selection}
          providerLocked={!supportsHandoff}
        />
      ) : null}
      {/* The run-active notice is moot once the run ends. */}
      {notice && !(notice === RUN_ACTIVE && activeRun === null) ? (
        <text content={notice} fg={palette.error} style={{ paddingLeft: 1, flexShrink: 0 }} />
      ) : null}
      <box
        border
        borderColor={palette.border}
        style={{ flexShrink: 0, minHeight: 3, maxHeight: 10, paddingLeft: 1 }}
      >
        <textarea
          ref={composerRef}
          focused={request?.type !== "approval" && picker === null}
          placeholder={
            questionDraft ? "Type an answer, or enter picks the highlighted option" : "Message"
          }
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onSubmit={submitComposer}
          style={{ flexGrow: 1 }}
        />
      </box>
      <text
        content={[
          "enter send",
          "shift+enter newline",
          ...(activeRun ? ["esc stop"] : ["^p model"]),
          `^t ${nextRuntimeMode(runtimeMode)}`,
          "pgup scroll",
          "^c quit",
        ].join("  ")}
        fg={palette.subtle}
        style={{ paddingLeft: 1, flexShrink: 0 }}
        truncate
        wrapMode="none"
      />
    </box>
  );
}
