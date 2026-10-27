import {
  pathToFiletype,
  type BoxRenderable,
  type KeyEvent,
  type MouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import type { CheckpointDiffAtom, TuiConnection } from "./connection/tuiConnection.ts";
import { resolveDiffKey, reconcileFileIndex, stepFile, stepHunk } from "./diffNavigation.ts";
import {
  DIFF_FILE_LINE_BUDGET,
  EMPTY_PARSED_DIFF,
  layoutDiffFile,
  lineLimitShowingHunk,
  parseUnifiedDiff,
  type DiffChunk,
  type DiffFile,
} from "./diffPatch.ts";
import {
  describeDiffScope,
  LATEST_DIFF_SCOPE,
  resolveDiffRange,
  scopeForRun,
  stepDiffScope,
  undiffableRunMessage,
  type DiffScope,
  type DiffTurns,
} from "./diffTurns.ts";
import type { MarkdownStyles } from "./messageMarkdownView.tsx";
import type { PrefsWriter, TuiPrefs } from "./prefs.ts";
import { clampScrollTop, revealLine } from "./sidebarWindow.ts";
import type { TuiTheme } from "./theme.ts";

export type DiffViewMode = "unified" | "split";

export interface DiffPanelHandle {
  /** Keys while the panel has focus; true when the key was used. */
  readonly handleKey: (key: KeyEvent) => boolean;
}

/** What the panel reads; the TUI's connection, or fixed atoms in checks. */
export type DiffSource = Pick<TuiConnection, "registry" | "diffTurnsAtom" | "checkpointDiffAtom">;

export interface DiffPanelProps {
  readonly connection: DiffSource;
  readonly threadId: ThreadId;
  readonly scope: DiffScope;
  readonly view: DiffViewMode;
  readonly wordWrap: boolean;
  readonly ignoreWhitespace: boolean;
  /** Below this the file list folds into the file header. */
  readonly showFileList: boolean;
  /** The thread has a run going; its changes arrive with its checkpoint. */
  readonly running: boolean;
  readonly theme: TuiTheme;
  readonly styles: MarkdownStyles;
  readonly onScopeChange: (scope: DiffScope) => void;
  readonly onViewChange: (view: DiffViewMode) => void;
  readonly onWordWrapChange: (wrap: boolean) => void;
  readonly onClose: () => void;
  readonly onActivate: () => void;
  readonly ref?: Ref<DiffPanelHandle>;
}

/**
 * Whether the diff replaces the transcript, and how it looks. Open state and view persist in
 * prefs.json (diffOpen, diffView) from the main window only; the scope resets per thread.
 */
export function useDiffPanelControls(options: {
  readonly initialPrefs: TuiPrefs;
  readonly prefsWriter: PrefsWriter | null;
  /** Overrides the saved open state, e.g. for a Rex diff tab. */
  readonly initiallyOpen?: boolean;
  readonly threadId: string | null;
}) {
  const { initialPrefs, prefsWriter, threadId } = options;
  const [open, setOpenState] = useState(options.initiallyOpen ?? initialPrefs.diffOpen === true);
  const [view, setViewState] = useState<DiffViewMode>(initialPrefs.diffView ?? "unified");
  const [wordWrap, setWordWrap] = useState(initialPrefs.appSettings?.diffWordWrap ?? false);
  const [scoped, setScoped] = useState<{ threadId: string | null; scope: DiffScope }>({
    threadId,
    scope: LATEST_DIFF_SCOPE,
  });
  const scope = scoped.threadId === threadId ? scoped.scope : LATEST_DIFF_SCOPE;
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      prefsWriter?.write({ diffOpen: next });
    },
    [prefsWriter],
  );
  const setView = useCallback(
    (next: DiffViewMode) => {
      setViewState(next);
      prefsWriter?.write({ diffView: next });
    },
    [prefsWriter],
  );
  const setScope = useCallback(
    (next: DiffScope) => setScoped({ threadId, scope: next }),
    [threadId],
  );
  return {
    open,
    view,
    wordWrap,
    scope,
    ignoreWhitespace: initialPrefs.appSettings?.diffIgnoreWhitespace ?? true,
    setOpen,
    setView,
    setWordWrap,
    setScope,
    /** Opens on one run's turn, e.g. from its changed-files row. */
    openForRun: (runId: string, diffTurns: DiffTurns) => {
      setScope(scopeForRun(runId, diffTurns));
      setOpen(true);
    },
  };
}

export type DiffPanelControls = ReturnType<typeof useDiffPanelControls>;

const FILE_LIST_WIDTH = 34;
const NO_DIFF_ATOM: CheckpointDiffAtom = Atom.make(
  AsyncResult.initial<never, unknown>(),
) as CheckpointDiffAtom;

function hunkId(chunk: DiffChunk): string {
  return `diff-hunk:${chunk.key}`;
}

function errorText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The diff request failed.";
}

function stat(additions: number, deletions: number): string {
  return `+${formatDiffCount(additions)} -${formatDiffCount(deletions)}`;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  modified: "",
  added: "new",
  deleted: "deleted",
  renamed: "renamed",
  binary: "binary",
};

/** Where the next layout should put the hunk view: its top, or one hunk's header. */
type PendingScroll = { readonly kind: "top" } | { readonly kind: "hunk"; readonly id: string };

/**
 * The active thread's checkpoint diffs: a turn's changes or the whole thread's, one file at a
 * time with a file list beside it. Only the selected file is drawn, and only its first
 * DIFF_FILE_LINE_BUDGET lines until "show more", so huge diffs stay cheap.
 */
export function DiffPanel(props: DiffPanelProps) {
  const { ref, connection, threadId, scope, view, wordWrap, theme, styles } = props;
  const palette = theme.palette;
  const diffTurns = useAtomValue(connection.diffTurnsAtom(threadId));
  const turns = diffTurns.turns;
  const range = resolveDiffRange(scope, turns);
  const diffAtom =
    range === null
      ? NO_DIFF_ATOM
      : connection.checkpointDiffAtom(threadId, range, props.ignoreWhitespace);
  const result = useAtomValue(diffAtom);
  const diffText = Option.getOrNull(AsyncResult.value(result))?.diff ?? null;
  const parsed = useMemo(
    () => (diffText === null ? EMPTY_PARSED_DIFF : parseUnifiedDiff(diffText)),
    [diffText],
  );
  const files = parsed.files;
  const loading = range !== null && result.waiting && diffText === null;
  const error = result._tag === "Failure" ? errorText(result.cause) : null;

  // The selected file follows its path when a new checkpoint changes the diff.
  const [selection, setSelection] = useState<{
    readonly path: string | null;
    readonly index: number;
  }>({ path: null, index: 0 });
  const fileIndex = reconcileFileIndex(files, selection.path, selection.index);
  const file = files[fileIndex] ?? null;
  const [lineLimits, setLineLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const lineLimit = (file && lineLimits.get(file.key)) ?? DIFF_FILE_LINE_BUDGET;
  const layout = useMemo(
    () => (file === null ? null : layoutDiffFile(file, lineLimit)),
    [file, lineLimit],
  );
  const [hunkIndex, setHunkIndex] = useState(0);

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const pendingScroll = useRef<PendingScroll | null>(null);
  const applyPendingScroll = useCallback(() => {
    const scrollbox = scrollRef.current;
    const pending = pendingScroll.current;
    if (!scrollbox || scrollbox.isDestroyed || pending === null) return;
    if (pending.kind === "top") {
      scrollbox.scrollTo({ x: 0, y: 0 });
      pendingScroll.current = null;
      return;
    }
    const node = scrollbox.content.findDescendantById(pending.id);
    const box = node?.getLayoutNode().getComputedLayout();
    // A hunk mounted this commit has no layout yet; the content resize brings it back here.
    if (!box || !(box.height > 0)) return;
    scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: box.top });
    pendingScroll.current = null;
  }, []);

  // The app's key handler is the only keyboard path, as in the transcript.
  useLayoutEffect(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    scrollbox.blur();
    scrollbox.focusable = false;
    const content = scrollbox.content;
    const original = content.onSizeChange;
    content.onSizeChange = function onContentSizeChange() {
      original?.call(this);
      applyPendingScroll();
    };
    return () => {
      content.onSizeChange = original;
    };
  }, [applyPendingScroll]);
  useLayoutEffect(applyPendingScroll);

  const selectFile = useCallback(
    (index: number) => {
      const next = files[index];
      if (next === undefined) return;
      setSelection({ path: next.path, index });
      setHunkIndex(0);
      pendingScroll.current = { kind: "top" };
    },
    [files],
  );

  const goToHunk = (nextFileIndex: number, nextHunkIndex: number) => {
    const target = files[nextFileIndex];
    if (target === undefined) return;
    const limit = lineLimitShowingHunk(
      target,
      nextHunkIndex,
      lineLimits.get(target.key) ?? DIFF_FILE_LINE_BUDGET,
    );
    if (limit !== (lineLimits.get(target.key) ?? DIFF_FILE_LINE_BUDGET)) {
      setLineLimits((current) => new Map(current).set(target.key, limit));
    }
    setSelection({ path: target.path, index: nextFileIndex });
    setHunkIndex(nextHunkIndex);
    pendingScroll.current = { kind: "hunk", id: `diff-hunk:${target.key}:${nextHunkIndex}` };
  };

  const showMore = () => {
    if (file === null || layout === null || layout.hiddenLines === 0) return;
    setLineLimits((current) => new Map(current).set(file.key, lineLimit + DIFF_FILE_LINE_BUDGET));
  };

  const refresh = () => {
    if (range !== null) connection.registry.refresh(diffAtom);
  };

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      const scrollbox = scrollRef.current;
      const action = resolveDiffKey(key, scrollbox?.viewport.height ?? 20);
      if (action === null) return false;
      switch (action.type) {
        case "file":
          selectFile(stepFile(files, fileIndex, action.delta));
          return true;
        case "hunk": {
          const next = stepHunk(files, { fileIndex, hunkIndex }, action.delta);
          if (next !== null) goToHunk(next.fileIndex, next.hunkIndex);
          return true;
        }
        case "turn":
          props.onScopeChange(stepDiffScope(scope, turns, action.delta));
          return true;
        case "toggle-all":
          props.onScopeChange(scope.kind === "all" ? LATEST_DIFF_SCOPE : { kind: "all" });
          return true;
        case "toggle-view":
          props.onViewChange(view === "unified" ? "split" : "unified");
          return true;
        case "toggle-wrap":
          props.onWordWrapChange(!wordWrap);
          return true;
        case "more":
          showMore();
          return true;
        case "refresh":
          refresh();
          return true;
        case "close":
          props.onClose();
          return true;
        case "scroll": {
          if (!scrollbox) return true;
          const scroll = action.action;
          if (scroll.kind === "by") scrollbox.scrollBy(scroll.rows);
          else if (scroll.kind === "top") scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: 0 });
          else scrollbox.scrollTo({ x: scrollbox.scrollLeft, y: scrollbox.scrollHeight });
          return true;
        }
      }
    },
  }));

  const scopeLabel = describeDiffScope(scope, turns);
  const summary =
    files.length === 0
      ? ""
      : `${files.length} file${files.length === 1 ? "" : "s"}  ${stat(parsed.additions, parsed.deletions)}`;
  const runMessage = undiffableRunMessage(scope, diffTurns);
  const emptyMessage =
    runMessage !== null
      ? runMessage
      : turns.length === 0
        ? props.running
          ? "No checkpoints yet. Changes show here when the run finishes."
          : "No changes yet. Each finished run's changes show here."
        : range === null
          ? `${scopeLabel} has no checkpoint to diff.`
          : loading
            ? "Loading diff…"
            : error !== null
              ? `Diff unavailable: ${error}`
              : "No changes in this turn.";

  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}
      onMouseDown={props.onActivate}
    >
      <DiffHeader
        scopeLabel={props.showFileList ? scopeLabel : describeDiffScope(scope, turns, true)}
        summary={summary}
        allTurns={scope.kind === "all"}
        compact={!props.showFileList}
        view={view}
        theme={theme}
        onStepTurn={(delta) => props.onScopeChange(stepDiffScope(scope, turns, delta))}
        onToggleAll={() =>
          props.onScopeChange(scope.kind === "all" ? LATEST_DIFF_SCOPE : { kind: "all" })
        }
        onView={props.onViewChange}
      />
      {props.running && turns.length > 0 ? (
        <text
          wrapMode="none"
          truncate
          content="A run is going; its changes show here when it finishes."
          style={{ fg: palette.subtle, flexShrink: 0 }}
        />
      ) : null}
      {parsed.truncated ? (
        <text
          wrapMode="none"
          truncate
          content="The server cut this diff short; it shows the first part only."
          style={{ fg: palette.warning, flexShrink: 0 }}
        />
      ) : null}
      <box style={{ flexDirection: "row", flexGrow: 1, minHeight: 0, marginTop: 1 }}>
        {props.showFileList && files.length > 0 ? (
          <DiffFileList
            files={files}
            selected={fileIndex}
            theme={theme}
            onSelect={(index) => {
              props.onActivate();
              selectFile(index);
            }}
          />
        ) : null}
        <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          {file === null ? (
            <text
              content={emptyMessage}
              style={{ fg: error !== null ? palette.warning : palette.subtle }}
            />
          ) : (
            <FileHeader
              file={file}
              position={props.showFileList ? null : `${fileIndex + 1}/${files.length}`}
              theme={theme}
            />
          )}
          <scrollbox
            ref={scrollRef}
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingRight: 1 }}
          >
            {file !== null && layout !== null ? (
              layout.chunks.length === 0 ? (
                <text
                  content={
                    file.status === "binary"
                      ? "Binary file; no text diff."
                      : "No line changes (mode or rename only)."
                  }
                  style={{ fg: palette.subtle }}
                />
              ) : (
                layout.chunks.map((chunk) => (
                  <DiffHunkView
                    key={chunk.key}
                    chunk={chunk}
                    filetype={pathToFiletype(file.path)}
                    view={view}
                    wordWrap={wordWrap}
                    styles={styles}
                  />
                ))
              )
            ) : null}
            {layout !== null && layout.hiddenLines > 0 ? (
              <box
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onActivate();
                  showMore();
                }}
                style={{
                  flexDirection: "row",
                  height: 1,
                  paddingLeft: 1,
                  paddingRight: 1,
                  backgroundColor: palette.surfaceAlt,
                  alignSelf: "flex-start",
                }}
              >
                <text
                  wrapMode="none"
                  content={`Show ${formatDiffCount(Math.min(layout.hiddenLines, DIFF_FILE_LINE_BUDGET))} more of ${formatDiffCount(layout.hiddenLines)} hidden lines  (m)`}
                  style={{ fg: palette.info }}
                />
              </box>
            ) : null}
          </scrollbox>
        </box>
      </box>
    </box>
  );
}

function DiffHeader(props: {
  scopeLabel: string;
  summary: string;
  allTurns: boolean;
  /** Narrow: no title and short labels, so the turn label always fits. */
  compact: boolean;
  view: DiffViewMode;
  theme: TuiTheme;
  onStepTurn: (delta: -1 | 1) => void;
  onToggleAll: () => void;
  onView: (view: DiffViewMode) => void;
}) {
  const palette = props.theme.palette;
  const button = (label: string, active: boolean, onPress: () => void) => (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        onPress();
      }}
      style={{
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        marginLeft: 1,
        flexShrink: 0,
        backgroundColor: active ? palette.controlActive : palette.surface,
      }}
    >
      <text wrapMode="none" content={label} style={{ fg: active ? palette.text : palette.muted }} />
    </box>
  );
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      {props.compact ? null : (
        <text wrapMode="none" content="󰦓 Diff  " style={{ fg: palette.text, flexShrink: 0 }} />
      )}
      {props.allTurns ? null : button("‹", false, () => props.onStepTurn(-1))}
      <text
        wrapMode="none"
        truncate
        content={` ${props.scopeLabel} `}
        style={{ fg: palette.accent, flexShrink: 0 }}
      />
      {props.allTurns ? null : button("›", false, () => props.onStepTurn(1))}
      <text
        wrapMode="none"
        truncate
        content={props.summary.length > 0 && !props.compact ? `  ${props.summary}` : ""}
        style={{ fg: palette.subtle, flexShrink: 1 }}
      />
      <box style={{ flexGrow: 1 }} />
      {button(props.compact ? "All" : "All turns", props.allTurns, props.onToggleAll)}
      {button(props.compact ? "Uni" : "Unified", props.view === "unified", () =>
        props.onView("unified"),
      )}
      {button("Split", props.view === "split", () => props.onView("split"))}
    </box>
  );
}

function FileHeader(props: { file: DiffFile; position: string | null; theme: TuiTheme }) {
  const { file, theme } = props;
  const palette = theme.palette;
  const name =
    file.previousPath !== null && file.previousPath !== file.path
      ? `${file.previousPath} → ${file.path}`
      : file.path;
  const label = STATUS_LABEL[file.status];
  return (
    <box
      style={{
        flexDirection: "row",
        height: 1,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: palette.surface,
      }}
    >
      {props.position ? (
        <text
          wrapMode="none"
          content={`${props.position}  `}
          style={{ fg: palette.subtle, flexShrink: 0 }}
        />
      ) : null}
      <text wrapMode="none" truncate content={name} style={{ fg: palette.text, flexShrink: 1 }} />
      {label.length > 0 ? (
        <text
          wrapMode="none"
          content={`  ${label}`}
          style={{ fg: palette.warning, flexShrink: 0 }}
        />
      ) : null}
      <box style={{ flexGrow: 1 }} />
      <StatText additions={file.additions} deletions={file.deletions} theme={theme} />
    </box>
  );
}

function StatText(props: { additions: number; deletions: number; theme: TuiTheme }) {
  const palette = props.theme.palette;
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, marginLeft: 1 }}>
      <text
        wrapMode="none"
        content={`+${formatDiffCount(props.additions)}`}
        style={{ fg: palette.success }}
      />
      <text
        wrapMode="none"
        content={` -${formatDiffCount(props.deletions)}`}
        style={{ fg: props.theme.colors.workEntryErrorAccent }}
      />
    </box>
  );
}

/** The changed files, drawing only the rows that fit, with the selected one kept in view. */
function DiffFileList(props: {
  files: ReadonlyArray<DiffFile>;
  selected: number;
  theme: TuiTheme;
  onSelect: (index: number) => void;
}) {
  const { files, selected, theme } = props;
  const palette = theme.palette;
  const viewportRef = useRef<BoxRenderable | null>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // Keep the selected file in view when it moves or the list resizes; the wheel moves the selection.
  const [revealed, setRevealed] = useState({ selected: -1, height: 0 });
  if (revealed.selected !== selected || revealed.height !== height) {
    setRevealed({ selected, height });
    setScrollTop((current) =>
      revealLine(clampScrollTop(current, files.length, height), height, selected),
    );
  }
  const start = clampScrollTop(scrollTop, files.length, height);
  const visible = height > 0 ? files.slice(start, start + height) : [];
  return (
    <box
      style={{
        flexDirection: "column",
        width: FILE_LIST_WIDTH,
        flexShrink: 0,
        minHeight: 0,
        marginRight: 1,
        backgroundColor: palette.surface,
      }}
      ref={viewportRef}
      onSizeChange={() => setHeight(viewportRef.current?.height ?? 0)}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        props.onSelect(
          Math.max(0, Math.min(files.length - 1, selected + (direction === "up" ? -1 : 1))),
        );
      }}
    >
      {visible.map((entry, offset) => (
        <DiffFileRow
          key={entry.key}
          file={entry}
          index={start + offset}
          selected={start + offset === selected}
          theme={theme}
          onSelect={props.onSelect}
        />
      ))}
    </box>
  );
}

const DiffFileRow = memo(function DiffFileRow(props: {
  file: DiffFile;
  index: number;
  selected: boolean;
  theme: TuiTheme;
  onSelect: (index: number) => void;
}) {
  const { file, theme } = props;
  const palette = theme.palette;
  const slash = file.path.lastIndexOf("/");
  const name = slash === -1 ? file.path : file.path.slice(slash + 1);
  const directory = slash === -1 ? "" : file.path.slice(0, slash);
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(props.index);
      }}
      style={{
        flexDirection: "row",
        height: 1,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: props.selected ? palette.selection : palette.surface,
      }}
    >
      <text
        wrapMode="none"
        content={name}
        style={{ fg: props.selected ? palette.text : palette.muted, flexShrink: 0 }}
      />
      <text
        wrapMode="none"
        truncate
        content={directory.length > 0 ? ` ${directory}` : ""}
        style={{ fg: palette.subtle, flexShrink: 1 }}
      />
      <box style={{ flexGrow: 1 }} />
      <StatText additions={file.additions} deletions={file.deletions} theme={theme} />
    </box>
  );
});

/** One hunk under its "@@" line; a separate <diff> per hunk keeps hunks apart and addressable. */
const DiffHunkView = memo(function DiffHunkView(props: {
  chunk: DiffChunk;
  filetype: string | undefined;
  view: DiffViewMode;
  wordWrap: boolean;
  styles: MarkdownStyles;
}) {
  const { chunk, styles } = props;
  const theme = styles.theme;
  const palette = theme.palette;
  const colors = theme.diffViewer;
  return (
    <box id={hunkId(chunk)} style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      <text
        wrapMode="none"
        truncate
        content={chunk.header}
        style={{ fg: palette.info, bg: palette.surfaceInfo }}
      />
      <diff
        diff={chunk.patch}
        view={props.view}
        syntaxStyle={styles.diff}
        showLineNumbers
        wrapMode={props.wordWrap ? "word" : "none"}
        {...(props.filetype === undefined ? {} : { filetype: props.filetype })}
        addedBg={colors.addedBg}
        removedBg={colors.removedBg}
        addedContentBg={colors.addedContentBg}
        removedContentBg={colors.removedContentBg}
        addedSignColor={colors.addedSignColor}
        removedSignColor={colors.removedSignColor}
        contextBg={palette.main}
        lineNumberBg={palette.surface}
        lineNumberFg={palette.subtle}
      />
      {chunk.notes.map((note) => (
        <text
          key={note}
          wrapMode="none"
          truncate
          content={note}
          style={{ fg: palette.warning, bg: palette.surface }}
        />
      ))}
    </box>
  );
});
