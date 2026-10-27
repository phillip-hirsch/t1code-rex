// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The UI deletes launch files it wrote itself and runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { type CliRenderer, decodePasteBytes, type KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { onThreadRequestsResolved } from "@t3tools/client-runtime/state/thread-requests";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import packageJson from "../package.json" with { type: "json" };
import { copyTextToClipboard } from "./clipboardText.ts";
import { QueuedMessages, type ProviderBadge } from "./composer.tsx";
import { ComposerDock, type ComposerDockHandle } from "./composerDock.tsx";
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  describeSendFailure,
  type ComposerTarget,
} from "./composerSend.ts";
import { checkUnconfirmedSends } from "./composerRecovery.ts";
import { createComposerSender } from "./composerSender.ts";
import {
  applySettingsPatch,
  interactionModeLabel,
  nextRuntimeMode,
  resolveNewThreadSettings,
  runtimeModeLabel,
  supportedRuntimeModes,
  type ComposerSettings,
  type ComposerSettingsPatch,
} from "./composerSettings.ts";
import { createComposerStore } from "./composerStore.ts";
import { DiffPanel, useDiffPanelControls, type DiffPanelHandle } from "./diffPanel.tsx";
import { useGitControls } from "./gitController.ts";
import { routeThreadPaneKey, THREAD_PANE_SHORTCUT_HINTS } from "./threadPaneKeys.ts";
import {
  BranchToolbar,
  GitOverlay,
  WorktreeSetupPanel,
  type GitOverlayHandle,
} from "./gitViews.tsx";
import { DIFF_KEY_HINTS } from "./diffNavigation.ts";
import type { TuiPaths } from "./config.ts";
import type { TuiConnection } from "./connection/tuiConnection.ts";
import {
  createStopNotice,
  resolveFooterStatus,
  STOPPING,
  type FooterStatus,
} from "./footerStatus.ts";
import { modShortcutLabel, resolveTuiShortcutCommand, tuiShortcutEvent } from "./keybindings.ts";
import type { T1Logger } from "./log.ts";
import type { PrefsWriter, TuiPrefs } from "./prefs.ts";
import {
  resolveTuiResponsiveLayout,
  toggleSidebarState,
  TUI_SIDEBAR_WIDTH,
} from "./responsiveLayout.ts";
import {
  createRexClient,
  createRexWindowRegistry,
  resolveRexContext,
  rexTabLabel,
} from "./rexWorkspace.ts";
import {
  buildArchivedThreadRows,
  reconcileArchivedSelection,
  selectArchivedRow,
  type ArchivedSelection,
} from "./archivedThreads.ts";
import { useManagement } from "./management.ts";
import { ArchivedThreadsView, ConfirmDialogView, PromptDialogView } from "./managementViews.tsx";
import { Sidebar, sidebarRowId, type SidebarPress } from "./sidebar.tsx";
import {
  buildMultiThreadMenuItems,
  buildProjectMenuItems,
  buildThreadMenuItems,
  threadWorkspacePath,
  type MenuItem,
} from "./sidebarContextMenu.ts";
import { useSidebarController } from "./sidebarController.ts";
import { useSubagentControls } from "./subagentController.ts";
import { SubagentComposerBar } from "./subagentViews.tsx";
import { subagentShellState } from "./subagentTree.ts";
import { printableText, resolveSidebarKey } from "./sidebarKeys.ts";
import type { SidebarRow, SidebarThread } from "./sidebarModel.ts";
import type { TuiTheme } from "./theme.ts";
import {
  buildThreadWindowCommand,
  expireThreadWindowLaunch,
  type ThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch.ts";
import { createServerTerminalBackend } from "./terminalConnection.ts";
import { TERMINAL_FOCUS_HINTS, useTerminalDrawer } from "./terminalDrawerView.tsx";
import { DEFAULT_THREAD_TITLE, truncateTitle } from "./threadTitle.ts";
import { ThreadView, type ThreadViewHandle } from "./threadView.tsx";
import { useMarkdownStyles } from "./messageMarkdownView.tsx";
import {
  buildModelPickerProviders,
  modelSelectionLabel,
  openModelPicker,
  reduceModelPickerKey,
  type ModelPickerState,
} from "./modelPicker.ts";
import { ModelPickerView } from "./modelPickerView.tsx";
import { NewThreadView } from "./newThreadView.tsx";
import { useSyncKeyboard, useSyncPaste } from "./syncKeyboard.ts";
import { createRequestPanelStore } from "./requestPanelStore.ts";
import { NO_PENDING_REQUESTS, type PendingRequest } from "./requestQueue.ts";
import { createRedirectDecliner } from "./requestRedirect.ts";
import { createRequestResponder } from "./requestResponder.ts";

const APP_VERSION = packageJson.version ?? "0.0.0";
const NO_REQUESTS_ATOM = Atom.make<ReadonlyArray<PendingRequest>>(NO_PENDING_REQUESTS);
const NO_ARCHIVED_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, unknown>
> = Atom.make(AsyncResult.initial<OrchestrationV2ArchivedShellSnapshot, unknown>());
const HEADER_THREAD_TITLE_MAX_LENGTH = 44;
const CONTEXT_MENU_WIDTH = 26;
const PALETTE_ROWS_MAX = 14;
/** The thread menu's items as palette rows, which have no thread row to point at. */
const THREAD_PALETTE_LABELS: Partial<Record<string, string>> = {
  "open-rex-tab": "Open thread in Rex tab",
  "open-rex-diff": "Open diff in Rex tab",
  "mark-unread": "Mark thread unread",
  "open-editor": "Open thread in Editor",
  "open-folder": "Open thread folder",
  "copy-path": "Copy thread path",
  "copy-thread-id": "Copy thread ID",
  archive: "Archive thread",
  delete: "Delete thread",
};

export interface AppProps {
  readonly renderer: CliRenderer;
  readonly connection: TuiConnection;
  readonly paths: TuiPaths;
  readonly logger: T1Logger;
  readonly theme: TuiTheme;
  readonly initialPrefs: TuiPrefs;
  /** Null in Rex thread tabs, which never write prefs.json. */
  readonly prefsWriter: PrefsWriter | null;
  /** A main window that found prefs.json locked by another one; it says it won't save. */
  readonly prefsLockedOut?: boolean;
  readonly cwd: string;
  /** Registers what a quit signal runs; returns a function that unregisters it. */
  readonly onSignalQuit?: (quit: () => void) => () => void;
  readonly onRequestExit?: () => void;
  readonly threadWindowLaunch?: ThreadWindowLaunch | null;
}

/** Footer note in a main window that another window's prefs lock keeps from saving. */
const PREFS_LOCKED_OUT_NOTE = "prefs not saved here";

/** Runs `run` after `delayMs`; returns a cancel. Retries and stall checks use it. */
function scheduleTimer(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly run: () => void | Promise<void>;
}

/** What a context menu acts on: one thread, the multi-selection, or a project. */
type MenuTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "subagent"; readonly threadId: string }
  | { readonly kind: "threads"; readonly threadIds: ReadonlyArray<string> }
  | { readonly kind: "project"; readonly projectId: string };

interface ContextMenuState {
  readonly target: MenuTarget;
  readonly top: number;
  readonly left: number;
  readonly index: number;
}

/** Palette rows whose label or description holds every typed word. */
function filterPaletteActions(
  actions: ReadonlyArray<PaletteAction>,
  query: string,
): ReadonlyArray<PaletteAction> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return actions;
  return actions.filter((action) => {
    const haystack = `${action.label} ${action.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * "requests" is the request panel above the composer, reached with Tab or a click;
 * "terminal" is the drawer's active terminal, which gets every key but its own.
 */
type FocusArea = "sidebar" | "thread" | "composer" | "requests" | "terminal";

function threadSettings(thread: SidebarThread): ComposerSettings {
  return {
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  };
}

type ServerConfigEnvironment = ServerConfig["environment"];

function describeConnection(
  state: SupervisorConnectionState | null,
  mode: TuiConnection["session"]["mode"],
): { label: string; detail: string | null; tone: "success" | "warning" | "info" | "muted" } {
  const via =
    mode === "managed" ? "managed server" : mode === "attached" ? "attached" : "thread tab";
  if (state === null) return { label: "Starting", detail: via, tone: "muted" };
  const failure = state.lastFailure?.detail ?? null;
  switch (connectionProjectionPhase(state)) {
    case "ready":
      return { label: "Connected", detail: via, tone: "success" };
    case "synchronizing":
      return {
        label: state.stage === "preparing" ? "Authenticating" : "Connecting",
        detail: state.attempt > 1 ? `attempt ${state.attempt}` : via,
        tone: "info",
      };
    case "disconnected":
      if (state.phase === "blocked") return { label: "Blocked", detail: failure, tone: "warning" };
      if (state.phase === "backoff") {
        return {
          label: "Reconnecting",
          detail: failure ?? `attempt ${state.attempt}`,
          tone: "warning",
        };
      }
      return { label: "Disconnected", detail: failure ?? via, tone: "muted" };
  }
}

function providerStatusLabel(provider: ServerProvider): string {
  if (!provider.enabled) return "disabled";
  if (!provider.installed) return "not installed";
  if (provider.availability === "unavailable") return provider.unavailableReason ?? "unavailable";
  return provider.status;
}

/** Ctrl+K, or Cmd+K where the terminal sends Cmd. Alt+K isn't Cmd+K. */
function isPaletteShortcut(key: KeyEvent): boolean {
  return key.name === "k" && Boolean(key.ctrl || key.super);
}

function isEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A callback with a fixed identity that always runs the latest render's function. */
function useEventCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

/**
 * State whose latest value key handlers can read before React re-renders, so a burst of
 * keys (a paste, or fast typing) builds on itself instead of the last render's value.
 */
function useSyncedState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set] as const;
}

function ServerSummary(props: {
  connection: TuiConnection;
  environment: ServerConfigEnvironment | null;
  providers: ReadonlyArray<ServerProvider>;
  theme: TuiTheme;
  emptyLabel: string;
}) {
  const { connection, environment, providers } = props;
  const palette = props.theme.palette;
  return (
    <box style={{ flexDirection: "column" }}>
      <text
        wrapMode="none"
        truncate
        content={props.emptyLabel}
        style={{ fg: palette.muted, marginBottom: 1 }}
      />
      <text wrapMode="none" truncate content="Server" style={{ fg: palette.subtle }} />
      {environment ? (
        <box style={{ flexDirection: "column" }}>
          <text
            wrapMode="none"
            truncate
            content={`${environment.label}  ·  T3 Code server ${environment.serverVersion}  ·  ${environment.platform.os}/${environment.platform.arch}`}
            style={{ fg: palette.text }}
          />
          <text
            wrapMode="none"
            truncate
            content={`${connection.session.httpBaseUrl}  ·  orchestration protocol ${environment.orchestrationProtocolVersion ?? 1}  ·  environment ${environment.environmentId}`}
            style={{ fg: palette.muted }}
          />
        </box>
      ) : (
        <text
          wrapMode="none"
          truncate
          content="Waiting for server config…"
          style={{ fg: palette.muted }}
        />
      )}
      <text
        wrapMode="none"
        truncate
        content="Providers"
        style={{ fg: palette.subtle, marginTop: 1 }}
      />
      {providers.length === 0 ? (
        <text
          wrapMode="none"
          truncate
          content="No providers reported yet"
          style={{ fg: palette.muted }}
        />
      ) : (
        providers.map((provider) => (
          <text
            key={provider.instanceId}
            wrapMode="none"
            truncate
            content={`  ${(provider.displayName ?? provider.driver).padEnd(18)} ${providerStatusLabel(provider).padEnd(16)} ${provider.version ?? "no version"}  ${provider.models.length} models`}
            style={{
              fg: provider.enabled && provider.installed ? palette.text : palette.muted,
            }}
          />
        ))
      )}
    </box>
  );
}

export function App(props: AppProps) {
  return (
    <RegistryContext.Provider value={props.connection.registry}>
      <Shell {...props} />
    </RegistryContext.Provider>
  );
}

function Shell(props: AppProps) {
  const {
    renderer,
    connection,
    theme,
    logger,
    paths,
    threadWindowLaunch,
    onSignalQuit,
    onRequestExit,
  } = props;
  const palette = theme.palette;
  const connectionResult = useAtomValue(connection.connectionStateAtom);
  const serverConfig = useAtomValue(connection.serverConfigAtom);
  const { width: viewportColumns, height: viewportRows } = useTerminalDimensions();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteQuery, setPaletteQuery] = useState("");
  /** The archived-threads view's highlighted row; null while the view is closed. */
  const [archivedSelection, setArchivedSelection] = useState<ArchivedSelection | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusArea, setFocusArea] = useState<FocusArea>("sidebar");
  const [sidebarCollapsedPreference, setSidebarCollapsedPreference] = useState(false);
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [status, setStatus] = useState<FooterStatus>(null);

  const markdownStyles = useMarkdownStyles(theme);
  const threadViewRef = useRef<ThreadViewHandle | null>(null);
  const dockRef = useRef<ComposerDockHandle | null>(null);
  const [modelPicker, modelPickerRef, setModelPicker] = useSyncedState<ModelPickerState | null>(
    null,
  );
  /** What the open model picker sets: the composer's model, or git's commit-message model. */
  const [modelPickerPurpose, setModelPickerPurpose] = useState<"composer" | "commit">("composer");
  const [stopRequestedRunId, setStopRequestedRunId] = useState<string | null>(null);
  // Drafts are saved only by the window that owns prefs.json.
  const [composerStore] = useState(() => {
    const writer = props.prefsWriter;
    return createComposerStore({
      initialPrefs: props.initialPrefs,
      persist: writer === null ? null : (patch) => writer.write(patch),
    });
  });
  useSyncExternalStore(composerStore.subscribe, composerStore.version);
  const sidebar = useSidebarController({
    connection,
    initialPrefs: props.initialPrefs,
    prefsWriter: props.prefsWriter,
    isNewThreadDraft: (threadId) => composerStore.findNewThreadDraft(threadId) !== undefined,
    launch: threadWindowLaunch ?? null,
    cwd: props.cwd,
  });
  const { activeThread, activeProject, selection } = sidebar;
  const diff = useDiffPanelControls({
    initialPrefs: props.initialPrefs,
    prefsWriter: props.prefsWriter,
    // A thread tab opens on its transcript unless it is a Rex diff tab.
    ...(threadWindowLaunch ? { initiallyOpen: threadWindowLaunch.view === "diff" } : {}),
    threadId: selection.threadId,
  });
  const diffPanelRef = useRef<DiffPanelHandle | null>(null);
  const settingsOfThread = useEventCallback((threadId: string) => {
    const thread = sidebar.threadsById.get(threadId);
    return thread ? threadSettings(thread) : null;
  });
  // Approvals and questions: what each thread's panel shows, and the answers on their way.
  const [requestPanelStore] = useState(createRequestPanelStore);
  const [responder] = useState(() =>
    createRequestResponder({
      respondToApproval: connection.respondToApproval,
      respondToUserInput: connection.respondToUserInput,
      dismissUserInput: connection.dismissUserInput,
      schedule: scheduleTimer,
      onFailure: (requestId, error, action) =>
        logger.log("request.respond.failed", {
          requestId,
          action,
          error: describeSendFailure(error),
        }),
    }),
  );
  useEffect(() => () => responder.dispose(), [responder]);
  // Only the thread in view has its pending approvals loaded; elsewhere they're unknown.
  const pendingApprovalIdsOf = useEventCallback((threadId: ThreadId) =>
    selection.threadId === threadId
      ? connection.registry
          .get(connection.thread(threadId).requestQueueAtom)
          .flatMap((request) => (request.kind === "approval" ? [request.requestId] : []))
      : null,
  );
  const [sender] = useState(() =>
    createComposerSender({
      store: composerStore,
      startTurn: connection.startTurn,
      setRuntimeMode: connection.setRuntimeMode,
      setInteractionMode: connection.setInteractionMode,
      threadSettings: settingsOfThread,
      schedule: scheduleTimer,
      resumeQueue: connection.resumeQueue,
      // Every thread with pending jobs, selected or not: nothing starts without its worktree.
      guardWorkspace: (threadId) => connection.guardWorkspace(threadId, scheduleTimer),
      declineApprovals: createRedirectDecliner({
        responder,
        pendingApprovalIds: pendingApprovalIdsOf,
      }),
      onFailure: (job, error, action) =>
        logger.log(job.kind === "send" ? "composer.send.failed" : "composer.resume.failed", {
          threadId: job.threadId,
          commandId: job.commandId,
          action,
          error: action === "stuck" ? "no reply yet" : describeSendFailure(error),
        }),
    }),
  );
  useEffect(() => () => sender.dispose(), [sender]);
  // A request can resolve anywhere: here, another window or client, an interrupt, the run ending.
  useEffect(
    () =>
      onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds }) => {
        if (environmentId !== connection.environmentId) return;
        responder.prune(threadId, pendingRequestIds);
        requestPanelStore.prune(threadId, pendingRequestIds);
      }),
    [connection.environmentId, requestPanelStore, responder],
  );
  const [panelHints, setPanelHints] = useState("");
  const [requestsShown, setRequestsShown] = useState(false);
  // Messages the last quit couldn't confirm: dropped if their thread has them, else restored.
  useEffect(
    () =>
      checkUnconfirmedSends({
        store: composerStore,
        lookupThread: connection.fetchFullThreadSnapshot,
        projectExists: (projectId) =>
          connection.registry.get(connection.hasShellSnapshotAtom)
            ? connection.registry
                .get(connection.projectsAtom)
                .some((project) => project.id === projectId)
            : null,
        mintThreadId: () => ThreadId.make(NodeCrypto.randomUUID()),
        schedule: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);
          return () => clearTimeout(timer);
        },
        onMoved: (_record, projectId) => {
          const project = connection.registry
            .get(connection.projectsAtom)
            .find((entry) => entry.id === projectId);
          setStatus(`Unsent message moved to a new thread in ${project?.title ?? "its project"}`);
        },
        onOrphaned: () => setStatus("Unsent message's project is gone; /recover"),
      }),
    [composerStore, connection],
  );
  // Forget modes and launches the shell now lists.
  const listedThreads = sidebar.threadsById;
  useEffect(
    () =>
      sender.reconcile((threadId) => {
        const thread = listedThreads.get(threadId);
        return thread ? threadSettings(thread) : null;
      }),
    [sender, listedThreads],
  );
  const followUpBehavior = props.initialPrefs.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR;

  const connectionState = Option.getOrNull(AsyncResult.value(connectionResult));
  const connectionView = describeConnection(connectionState, connection.session.mode);
  const environment = serverConfig?.environment ?? null;
  const providers = serverConfig?.providers ?? [];

  const layout = resolveTuiResponsiveLayout({
    viewportColumns,
    sidebarCollapsedPreference,
  });
  const sidebarVisible = layout.showSidebar || sidebarOverlayOpen;
  const sidebarFocused = sidebarVisible && focusArea === "sidebar";

  const rex = useMemo(() => {
    const context = resolveRexContext();
    if (!context) return null;
    const client = createRexClient(context);
    return { client, windows: createRexWindowRegistry(client) };
  }, []);
  // Rex tabs open from the main window only; a thread tab never opens more tabs.
  const rexTabs = rex !== null && !threadWindowLaunch;

  // A window that can't save prefs asks once before dropping unsent messages.
  const [exitArmed, setExitArmed] = useState(false);
  useEffect(() => {
    if (!exitArmed) return;
    const timer = setTimeout(() => setExitArmed(false), 5_000);
    return () => clearTimeout(timer);
  }, [exitArmed]);
  // Unsent messages and unsaved draft edits go to disk before the app exits.
  const finishExit = useCallback(() => {
    if (composerStore.canPersist) {
      sender.handOff();
    } else {
      const pending = sender.pendingCount();
      if (pending > 0) logger.log("composer.sends.dropped", { count: pending });
    }
    composerStore.flush();
    onRequestExit?.();
  }, [composerStore, logger, onRequestExit, sender]);
  const requestExit = useCallback(() => {
    const pending = composerStore.canPersist ? 0 : sender.pendingCount();
    if (pending > 0 && !exitArmed) {
      setStatus(
        `${pending} message${pending === 1 ? "" : "s"} not sent yet, and this window can't save them. Quit again to drop them`,
      );
      setExitArmed(true);
      return;
    }
    finishExit();
  }, [composerStore, exitArmed, finishExit, sender]);

  // A signal quits without asking.
  useEffect(() => onSignalQuit?.(finishExit), [onSignalQuit, finishExit]);

  // Sends that lost the connection go out again, with the same ids, once it's back.
  const connected = connectionView.label === "Connected";
  useEffect(() => {
    if (!connected) return;
    void sender.retryWaiting();
    responder.retryWaiting();
  }, [connected, responder, sender]);

  const retryNow = useCallback(() => {
    void runAtomCommand(connection.registry, connection.retryNow, connection.environmentId);
    setStatus("Reconnecting");
  }, [connection]);

  const threadsById = sidebar.threadsById;
  const projectsById = sidebar.projectsById;
  const openThreadInRexTab = useCallback(
    async (threadId: string | null, view?: "diff") => {
      const thread = threadId === null ? undefined : threadsById.get(threadId);
      if (!rex || !thread) {
        setStatus(rex ? "Select a thread first" : "Rex not detected");
        return;
      }
      const bearerToken = await connection.session.getBearerToken();
      const cwd = threadWorkspacePath(thread, projectsById.get(thread.projectId)) ?? undefined;
      const { reused } = await rex.windows.openOrFocus(
        `${view ?? "thread"}:${thread.id}`,
        async () => {
          const launchFile = await writeThreadWindowLaunch(
            NodePath.join(paths.stateHomeDir, "thread-windows"),
            {
              server: {
                httpBaseUrl: connection.session.httpBaseUrl,
                wsBaseUrl: connection.session.wsBaseUrl,
                bearerToken,
              },
              projectId: thread.projectId,
              threadId: thread.id,
              ...(view === undefined ? {} : { view }),
            },
          );
          try {
            return await rex.client.openWindow({
              label: rexTabLabel(
                `${view === "diff" ? "Diff: " : ""}${thread.title || DEFAULT_THREAD_TITLE}`,
              ),
              cwd,
              command: buildThreadWindowCommand(launchFile, paths),
            });
          } catch (error) {
            await NodeFSP.rm(launchFile, { force: true });
            throw error;
          } finally {
            expireThreadWindowLaunch(launchFile);
          }
        },
      );
      setStatus(
        reused ? "Focused Rex tab" : `Opened ${view === "diff" ? "diff" : "thread"} in Rex tab`,
      );
    },
    [connection.session, paths, projectsById, rex, threadsById],
  );

  /** A shell in a native Rex split below this window, in the thread's folder. */
  const openRexTerminal = useCallback(
    async (cwd: string | null) => {
      if (!rex) {
        setStatus("Rex not detected");
        return;
      }
      await rex.client.split({
        label: "Terminal",
        direction: "below",
        ratio: 30,
        cwd: cwd ?? undefined,
      });
      setStatus("Opened terminal in Rex split");
    },
    [rex],
  );

  const copyToClipboard = useCallback((value: string, message: string) => {
    copyTextToClipboard(value)
      .then(() => setStatus(message))
      .catch((error: unknown) => setStatus(errorMessage(error)));
  }, []);
  const activateThreadView = useCallback(() => {
    setContextMenu(null);
    setFocusArea("thread");
  }, []);

  const runTask = useCallback(
    (id: string, task: () => void | Promise<void>) => {
      Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          const message = errorMessage(error);
          logger.log("action.failed", { action: id, error: message });
          setStatus(message);
        });
    },
    [logger],
  );

  const subagents = useSubagentControls({
    connection,
    sidebar,
    rexTabs,
    openInRex: (threadId) => openThreadInRexTab(threadId),
    runTask,
    setStatus,
    onOpened: () => setFocusArea("thread"),
  });

  const openContextMenu = useCallback(
    (target: MenuTarget, anchor: { x: number; y: number } | null) => {
      const rowKey =
        target.kind === "project"
          ? `project:${target.projectId}`
          : `thread:${target.kind === "threads" ? (target.threadIds[0] ?? "") : target.threadId}`;
      const rowY = renderer.root.findDescendantById(sidebarRowId(rowKey))?.y;
      const top = anchor?.y ?? (rowY === undefined ? 2 : rowY + 1);
      const left = anchor?.x ?? 2;
      setPaletteOpen(false);
      setContextMenu({
        target,
        // The tallest menu (a thread's) fits; shorter ones only sit higher than they must.
        top: Math.max(0, Math.min(top, renderer.height - 16)),
        left: Math.max(0, Math.min(left, renderer.width - CONTEXT_MENU_WIDTH - 1)),
        index: 0,
      });
    },
    [renderer],
  );

  // The composer's target: the selected thread, or a new-thread draft that isn't one yet.
  const selectedThreadId = selection.threadId;
  const newThreadDraft =
    selectedThreadId === null || sidebar.threadsById.has(selectedThreadId)
      ? undefined
      : composerStore.findNewThreadDraft(selectedThreadId);
  const composerTarget: ComposerTarget | null =
    selectedThreadId === null
      ? null
      : newThreadDraft
        ? { kind: "draft", threadId: newThreadDraft.threadId, projectId: newThreadDraft.projectId }
        : {
            kind: "thread",
            threadId: ThreadId.make(selectedThreadId),
            projectId: ProjectId.make(activeThread?.projectId ?? selection.projectId ?? ""),
          };
  // A provider-native subagent takes no messages: its composer gives way to a status bar.
  const composerLocked = composerTarget?.kind === "thread" && subagents.readOnlyReason !== null;
  const pickerProviders = useMemo(() => buildModelPickerProviders(providers), [providers]);
  const baseSettings = activeThread
    ? threadSettings(activeThread)
    : resolveNewThreadSettings({
        defaults: composerStore.getDefaults(),
        projectDefault: activeProject?.defaultModelSelection ?? null,
        providers,
      });
  const effectiveSettings =
    baseSettings === null || composerTarget === null
      ? null
      : applySettingsPatch(baseSettings, composerStore.getPatch(composerTarget.threadId));
  const requestQueue = useAtomValue(
    composerTarget?.kind === "thread"
      ? connection.thread(composerTarget.threadId).requestQueueAtom
      : NO_REQUESTS_ATOM,
  );
  const running = threadRuntimeIsActive(activeThread?.runtime);
  const activeRunId = activeThread?.runtime?.activeRunId ?? null;
  const stopRequested = running && stopRequestedRunId === (activeRunId ?? "unknown");
  const diffShown = diff.open && composerTarget?.kind === "thread";
  const toggleDiff = () => {
    if (!diff.open && composerTarget?.kind !== "thread") {
      setStatus("Select a thread first");
      return;
    }
    diff.setOpen(!diff.open);
    setContextMenu(null);
    setPaletteOpen(false);
    setFocusArea("thread");
  };
  const openDiffForRun = useEventCallback((runId: string) => {
    if (composerTarget?.kind !== "thread") return;
    diff.openForRun(
      runId,
      connection.registry.get(connection.diffTurnsAtom(composerTarget.threadId)),
    );
    setFocusArea("thread");
  });

  const openNewThread = (projectId: string | null) => {
    const target = projectId ?? sidebar.groups[0]?.project.id ?? null;
    if (target === null) {
      setStatus("Add a project first");
      return;
    }
    const draft = composerStore.openNewThreadDraft(ProjectId.make(target), () =>
      ThreadId.make(NodeCrypto.randomUUID()),
    );
    sidebar.selectThread(target, draft.threadId);
    setContextMenu(null);
    setPaletteOpen(false);
    setModelPicker(null);
    setFocusArea("composer");
    setStatus("New thread");
  };

  const management = useManagement({
    connection,
    sidebar,
    serverConfig,
    composerStore,
    sender,
    logger,
    setStatus,
    openNewThread,
  });

  const commitModelSelection = serverConfig?.settings.textGenerationModelSelection ?? null;
  const gitOverlayRef = useRef<GitOverlayHandle | null>(null);
  const git = useGitControls({
    overlayRef: gitOverlayRef,
    connection,
    store: composerStore,
    target: composerTarget,
    thread: activeThread,
    project: activeProject ?? null,
    defaultEnvMode: serverConfig?.settings.defaultThreadEnvMode ?? "local",
    startFromOrigin: serverConfig?.settings.newWorktreesStartFromOrigin ?? false,
    setStatus,
    onPickCommitModel: () => {
      setContextMenu(null);
      setPaletteOpen(false);
      setModelPickerPurpose("commit");
      setModelPicker(openModelPicker(pickerProviders, commitModelSelection));
    },
    onFocusComposer: () => setFocusArea(composerTarget === null ? "thread" : "composer"),
  });
  const commitModelLabel =
    commitModelSelection === null
      ? "server default"
      : modelSelectionLabel(pickerProviders, commitModelSelection);
  const pickCommitModel = (instanceId: ServerProvider["instanceId"], model: string) => {
    setModelPicker(null);
    setModelPickerPurpose("composer");
    void connection
      .updateServerSettings({
        textGenerationModelSelection: { instanceId, model, options: [] },
      })
      .then((result) =>
        setStatus(
          result.ok
            ? `Commit messages: ${modelSelectionLabel(pickerProviders, createModelSelection(instanceId, model))}`
            : `Couldn't set the commit model: ${errorMessage(result.error)}`,
        ),
      );
  };
  // The thread's terminal drawer. A draft has no server thread to hold shells yet.
  const terminalCwd =
    composerTarget?.kind === "thread" && activeThread !== null
      ? threadWorkspacePath(activeThread, activeProject ?? undefined)
      : null;
  const [terminalBackend] = useState(() =>
    createServerTerminalBackend({
      registry: connection.registry,
      atoms: connection.terminals,
      environmentId: connection.environmentId,
    }),
  );
  const terminalDrawer = useTerminalDrawer({
    backend: terminalBackend,
    theme,
    target:
      terminalCwd === null || activeThread === null
        ? null
        : {
            threadId: activeThread.id,
            cwd: terminalCwd,
            worktreePath: activeThread.worktreePath,
            projectRoot: activeProject?.workspaceRoot ?? terminalCwd,
          },
    focused: focusArea === "terminal",
    area: {
      // The main column: the screen less the header, footer, padding and a docked sidebar.
      cols: viewportColumns - (layout.showSidebar ? TUI_SIDEBAR_WIDTH : 0) - 2,
      rows: viewportRows - 4,
    },
    onFocus: () => {
      setContextMenu(null);
      setFocusArea("terminal");
    },
    onLeave: () => setFocusArea(composerTarget === null ? "thread" : "composer"),
    onTabOut: () => cycleFocus(),
    onStatus: setStatus,
  });
  const terminalFocused = focusArea === "terminal" && terminalDrawer.open;
  // A thread without its drawer open can't keep the terminal's focus.
  if (focusArea === "terminal" && !terminalDrawer.open) {
    setFocusArea(composerTarget === null ? "thread" : "composer");
  }

  const threadPath = (threadId: string) => {
    const thread = threadsById.get(threadId);
    return thread ? threadWorkspacePath(thread, projectsById.get(thread.projectId)) : null;
  };
  const projectPath = (projectId: string) => projectsById.get(projectId)?.workspaceRoot ?? null;

  const menuItemsFor = (target: MenuTarget): ReadonlyArray<MenuItem<string>> => {
    if (target.kind === "threads") return buildMultiThreadMenuItems(target.threadIds.length);
    if (target.kind === "subagent") return subagents.menuItems(target.threadId);
    if (target.kind === "project") return buildProjectMenuItems();
    const thread = threadsById.get(target.threadId);
    return buildThreadMenuItems({
      rexTabs,
      capabilities: management.capabilities,
      pinned: thread?.pinnedAt != null,
      settled: thread?.settledOverride === "settled",
      running: threadRuntimeIsActive(thread?.runtime),
    });
  };
  const contextMenuItems = contextMenu === null ? [] : menuItemsFor(contextMenu.target);

  /** Runs a context-menu or palette action; both list the same items. */
  const runMenuAction = (target: MenuTarget, item: MenuItem<string>) => {
    setContextMenu(null);
    setPaletteOpen(false);
    if (item.disabledReason !== undefined) {
      setStatus(item.disabledReason);
      return;
    }
    runTask(`menu:${item.id}`, async () => {
      if (target.kind === "threads") {
        const ids = target.threadIds;
        if (item.id === "mark-unread") management.markUnread(ids);
        else if (item.id === "archive") management.requestArchive(ids);
        else if (item.id === "delete") management.requestDelete(ids);
        return;
      }
      if (target.kind === "project") {
        const { projectId } = target;
        switch (item.id) {
          case "new-thread":
            openNewThread(projectId);
            return;
          case "rename-project":
            management.renameProject(projectId);
            return;
          case "open-editor":
            await management.openPath(projectPath(projectId), "editor");
            return;
          case "open-folder":
            await management.openPath(projectPath(projectId), "folder");
            return;
          case "copy-path":
            await management.copyPath(projectPath(projectId));
            return;
          case "remove-project":
            await management.requestRemoveProject(projectId);
            return;
        }
        return;
      }
      const { threadId } = target;
      if (target.kind === "subagent" && subagents.runMenuItem(threadId, item.id)) return;
      switch (item.id) {
        case "open-rex-tab":
          await openThreadInRexTab(threadId);
          return;
        case "open-rex-diff":
          await openThreadInRexTab(threadId, "diff");
          return;
        case "rename":
          management.renameThread(threadId);
          return;
        case "pin":
        case "unpin":
          await management.setPinned(threadId, item.id === "pin");
          return;
        case "settle":
        case "unsettle":
          await management.setSettled(threadId, item.id === "settle");
          return;
        case "mark-unread":
          management.markUnread([threadId]);
          return;
        case "open-editor":
          await management.openPath(threadPath(threadId), "editor");
          return;
        case "open-folder":
          await management.openPath(threadPath(threadId), "folder");
          return;
        case "copy-path":
          await management.copyPath(threadPath(threadId));
          return;
        case "copy-thread-id":
          await copyTextToClipboard(threadId);
          setStatus("Copied thread ID");
          return;
        case "archive":
          management.requestArchive([threadId]);
          return;
        case "delete":
          management.requestDelete([threadId]);
          return;
      }
    });
  };

  /** The menu for a sidebar row: a project's, the selection's when the row is in it, else the thread's. */
  const menuTargetForRow = (row: SidebarRow): MenuTarget | null => {
    if (row.kind === "project") return { kind: "project", projectId: row.projectId };
    if (row.kind === "subagent") {
      if (sidebar.multiSelection.threadIds.size > 0) sidebar.clearMultiSelection();
      return { kind: "subagent", threadId: row.threadId };
    }
    if (row.kind !== "thread") return null;
    const selected = sidebar.multiSelection.threadIds;
    if (selected.size > 0 && selected.has(row.threadId)) {
      return { kind: "threads", threadIds: [...selected] };
    }
    if (selected.size > 0) sidebar.clearMultiSelection();
    return { kind: "thread", threadId: row.threadId };
  };

  // Archived threads, fetched while the view is open.
  const archivedResult = useAtomValue(
    archivedSelection === null ? NO_ARCHIVED_ATOM : connection.archivedShellSnapshotAtom,
  );
  const archivedSnapshot = Option.getOrNull(AsyncResult.value(archivedResult));
  const archivedRows = useMemo(
    () =>
      archivedSnapshot === null
        ? []
        : buildArchivedThreadRows({
            projects: archivedSnapshot.projects,
            threads: archivedSnapshot.threads.map((thread) =>
              presentThreadShell(connection.environmentId, thread),
            ),
          }),
    [archivedSnapshot, connection.environmentId],
  );
  const archivedError = archivedResult._tag === "Failure" ? "Couldn't load archived threads" : null;
  // One selection for the view and its keys, kept on a live row as rows come and go.
  const archivedSelected =
    archivedSelection === null ? null : reconcileArchivedSelection(archivedRows, archivedSelection);
  if (archivedSelected !== archivedSelection) setArchivedSelection(archivedSelected);
  const archivedRow =
    archivedSelected === null ? null : (archivedRows[archivedSelected.index] ?? null);
  const openArchivedView = () => {
    setPaletteOpen(false);
    setContextMenu(null);
    connection.refreshArchivedThreads();
    setArchivedSelection({ threadId: null, index: 0 });
  };

  const pickSettings = (patch: ComposerSettingsPatch): ComposerSettings | null => {
    if (composerTarget === null || baseSettings === null) return null;
    return composerStore.pickSettings(
      composerTarget.threadId,
      composerTarget.kind === "draft" ? "draft" : "thread",
      baseSettings,
      patch,
    );
  };
  const providerFor = (settings: ComposerSettings) =>
    providers.find((provider) => provider.instanceId === settings.modelSelection.instanceId);
  const nextRunNote = composerTarget?.kind === "thread" ? " for the next message" : "";

  const pickModel = (instanceId: ServerProvider["instanceId"], model: string) => {
    setModelPicker(null);
    setFocusArea("composer");
    if (baseSettings === null) return;
    // Re-picking the thread's own model keeps its options (effort and the like).
    const sameAsThread =
      baseSettings.modelSelection.instanceId === instanceId &&
      baseSettings.modelSelection.model === model;
    const modelSelection = sameAsThread
      ? baseSettings.modelSelection
      : createModelSelection(instanceId, model);
    const supported = supportedRuntimeModes(
      providers.find((provider) => provider.instanceId === instanceId),
    );
    const runtimeMode = effectiveSettings?.runtimeMode;
    const picked = pickSettings({
      modelSelection,
      ...(runtimeMode !== undefined && supported.length > 0 && !supported.includes(runtimeMode)
        ? { runtimeMode: supported[0] }
        : {}),
    });
    if (picked) {
      setStatus(
        `Model: ${modelSelectionLabel(pickerProviders, picked.modelSelection)}${nextRunNote}`,
      );
    }
  };

  const setRuntimeMode = (mode: RuntimeMode | "next") => {
    if (effectiveSettings === null) return;
    const next =
      mode === "next"
        ? nextRuntimeMode(
            effectiveSettings.runtimeMode,
            supportedRuntimeModes(providerFor(effectiveSettings)),
          )
        : mode;
    if (pickSettings({ runtimeMode: next })) {
      setStatus(`Runtime: ${runtimeModeLabel(next)}${nextRunNote}`);
    }
  };

  const setInteractionMode = (mode: ProviderInteractionMode) => {
    if (pickSettings({ interactionMode: mode })) {
      setStatus(`Mode: ${interactionModeLabel(mode)}${nextRunNote}`);
    }
  };

  const toggleModelPicker = () => {
    if (modelPicker !== null) {
      setModelPicker(null);
      return;
    }
    if (composerTarget === null) {
      setStatus("Select a thread first");
      return;
    }
    setContextMenu(null);
    setPaletteOpen(false);
    setModelPickerPurpose("composer");
    setModelPicker(openModelPicker(pickerProviders, effectiveSettings?.modelSelection ?? null));
  };

  const pickFromModelPicker = (instanceId: ServerProvider["instanceId"], model: string) => {
    if (modelPickerPurpose === "commit") pickCommitModel(instanceId, model);
    else pickModel(instanceId, model);
  };

  const stopRun = () => {
    if (!activeThread || !running) return;
    const runKey = activeRunId ?? "unknown";
    setStopRequestedRunId(runKey);
    // Messages not sent yet stay here until resumed, like the queue the server holds.
    const held = sender.hold(activeThread.id);
    setStatus(
      createStopNotice(
        activeThread,
        held === 0
          ? STOPPING
          : `Stopping; ${held} unsent message${held === 1 ? "" : "s"} held. /resume or ▶ sends, /discard edits`,
      ),
    );
    void connection
      .interruptTurn({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: activeThread.id,
        ...(activeRunId === null ? {} : { runId: activeRunId }),
      })
      .then((result) => {
        if (result.ok) return;
        setStopRequestedRunId(null);
        setStatus(`Stop failed: ${describeSendFailure(result.error)}`);
      });
  };

  const providerBadge = (settings: ComposerSettings): ProviderBadge => {
    const provider = providerFor(settings);
    if (provider?.driver === "claudeAgent") return { icon: "✱", color: palette.claude };
    return { icon: "󰚩", color: provider?.accentColor ?? palette.muted };
  };
  const modelLabel = (settings: ComposerSettings) =>
    modelSelectionLabel(pickerProviders, settings.modelSelection);

  // Stable, so the memoized sidebar rows don't re-render when the shell does.
  const pressSidebarRow = useEventCallback((press: SidebarPress) => {
    setContextMenu(null);
    if (press.newThread) {
      openNewThread(press.row.projectId);
      return;
    }
    setFocusArea("sidebar");
    if (!press.secondary) {
      sidebar.pressRow(press.row, { ctrl: press.ctrl, shift: press.shift });
      return;
    }
    // Like before, a right-click opens the menu without switching threads.
    sidebar.focusRow(press.row);
    const target = menuTargetForRow(press.row);
    if (target !== null) openContextMenu(target, { x: press.x, y: press.y });
  });

  const newThreadProjectId =
    sidebarFocused && sidebar.cursorRow !== null
      ? sidebar.cursorRow.projectId
      : selection.projectId;

  const actions: PaletteAction[] = [];
  actions.push({
    id: "thread:new",
    label: "New thread",
    description: "⌘N",
    run: () => openNewThread(newThreadProjectId),
  });
  // The open thread's actions, as its context menu lists them.
  if (activeThread !== null) {
    const target: MenuTarget = { kind: "thread", threadId: activeThread.id };
    for (const item of menuItemsFor(target)) {
      actions.push({
        id: `thread:${item.id}`,
        label: THREAD_PALETTE_LABELS[item.id] ?? item.label,
        description: item.disabledReason ?? activeThread.title ?? DEFAULT_THREAD_TITLE,
        disabled: item.disabledReason !== undefined,
        run: () => runMenuAction(target, item),
      });
    }
  }
  actions.push(...subagents.paletteActions(paletteOpen));
  if (sidebar.multiSelection.threadIds.size > 0) {
    const target: MenuTarget = {
      kind: "threads",
      threadIds: [...sidebar.multiSelection.threadIds],
    };
    for (const item of menuItemsFor(target)) {
      actions.push({
        id: `threads:${item.id}`,
        label: `${item.label.replace(/ \(\d+\)$/, "")} selected threads`,
        description: `${target.threadIds.length} selected`,
        run: () => runMenuAction(target, item),
      });
    }
  }
  actions.push({
    id: "diff:toggle",
    label: diff.open ? "Hide diff" : "Show diff",
    description:
      activeThread === null
        ? "Select a thread first"
        : ["d in the thread", modShortcutLabel("d")].filter((hint) => hint !== null).join("  "),
    disabled: !diff.open && composerTarget?.kind !== "thread",
    run: toggleDiff,
  });
  actions.push(
    {
      id: "git:menu",
      label: "Git actions",
      description: "Commit, push, PR, pull  c in the thread  /git",
      disabled: git.cwd === null,
      run: git.openMenu,
    },
    {
      id: "git:branch",
      label: "Switch branch",
      description: "b in the thread  /branch",
      disabled: git.cwd === null,
      run: () => git.openBranchPicker(),
    },
  );
  if (composerTarget?.kind === "draft") {
    actions.push({
      id: "git:worktree",
      label:
        git.envMode === "worktree"
          ? "Start this thread locally"
          : "Start this thread in a new worktree",
      description: "/worktree",
      run: git.toggleWorktree,
    });
  }
  if (git.setupFailed) {
    actions.push({
      id: "git:retry-setup",
      label: "Retry worktree setup",
      description: "/worktree retry",
      run: git.retrySetup,
    });
  }
  if (git.setupThreadId !== null) {
    actions.push({
      id: "git:cancel-setup",
      label: "Cancel worktree setup",
      description: "Stops a new worktree's setup",
      run: git.cancelWorktreeSetup,
    });
  }
  actions.push({
    id: "git:commit-model",
    label: "Commit message model",
    description: commitModelLabel,
    run: () => {
      setModelPickerPurpose("commit");
      setModelPicker(openModelPicker(pickerProviders, commitModelSelection));
    },
  });
  actions.push({
    id: "archive:open",
    label: "Archived threads",
    description: "Restore or delete archived threads",
    run: openArchivedView,
  });
  actions.push({
    id: "project:add",
    label: "Add project",
    description: "Ctrl+P",
    run: management.openAddProject,
  });
  actions.push({
    id: "project:clone",
    label: "Clone repository",
    description: "/clone owner/repo",
    run: management.openClone,
  });
  const paletteProject =
    newThreadProjectId === null ? undefined : projectsById.get(newThreadProjectId);
  if (paletteProject !== undefined) {
    const target: MenuTarget = { kind: "project", projectId: paletteProject.id };
    const projectLabels: Partial<Record<string, string>> = {
      "rename-project": "Rename project",
      "open-editor": "Open project in Editor",
      "open-folder": "Open project folder",
      "copy-path": "Copy project path",
      "remove-project": "Remove project",
    };
    for (const item of menuItemsFor(target)) {
      const label = projectLabels[item.id];
      if (label === undefined) continue;
      actions.push({
        id: `project:${item.id}`,
        label,
        description: paletteProject.title,
        run: () => runMenuAction(target, item),
      });
    }
  }
  actions.push({
    id: "model:pick",
    label: "Pick model",
    description: "⌘⇧M",
    disabled: composerTarget === null,
    run: toggleModelPicker,
  });
  actions.push(...terminalDrawer.actions);
  if (rex !== null) {
    const cwd =
      terminalCwd ?? activeProject?.workspaceRoot ?? (threadWindowLaunch ? null : props.cwd);
    actions.push({
      id: "rex:terminal",
      label: "Open terminal in Rex split",
      description: cwd ?? "Open a shell below tr3x",
      run: () => openRexTerminal(cwd),
    });
  }
  if (rexTabs && activeThread === null) {
    actions.push({
      id: "rex:thread",
      label: "Open thread in Rex tab",
      description: "Select a thread first",
      disabled: true,
      run: () => openThreadInRexTab(selection.threadId),
    });
  }
  actions.push({
    id: "connection:retry",
    label: "Reconnect now",
    description: connectionView.detail ?? connectionView.label,
    run: retryNow,
  });
  actions.push({
    id: "app:quit",
    label: "Quit tr3x",
    description: "Ctrl+C",
    run: requestExit,
  });
  const paletteActions = filterPaletteActions(actions, paletteQuery);
  const paletteSelected = Math.min(paletteIndex, Math.max(0, paletteActions.length - 1));
  const paletteWindowStart = Math.max(0, paletteSelected - PALETTE_ROWS_MAX + 1);

  const runAction = useCallback(
    (action: PaletteAction) => {
      setPaletteOpen(false);
      if (action.disabled) return;
      runTask(action.id, action.run);
    },
    [runTask],
  );

  const toggleSidebar = () => {
    setContextMenu(null);
    const next = toggleSidebarState(layout, {
      collapsedPreference: sidebarCollapsedPreference,
      overlayOpen: sidebarOverlayOpen,
    });
    if (next === null) return;
    setSidebarCollapsedPreference(next.collapsedPreference);
    setSidebarOverlayOpen(next.overlayOpen);
    setFocusArea(next.focus);
  };

  // Re-showing the sidebar after a widen keeps it docked instead of as an overlay.
  const wasDocked = useRef(layout.showSidebar);
  useEffect(() => {
    if (layout.showSidebar && !wasDocked.current) setSidebarOverlayOpen(false);
    wasDocked.current = layout.showSidebar;
  }, [layout.showSidebar]);

  const composerFocused = focusArea === "composer" && composerTarget !== null && !composerLocked;
  const requestsFocused = focusArea === "requests" && composerTarget !== null && !composerLocked;
  const dockFocused = composerFocused || requestsFocused;
  const cycleFocus = () => {
    const order: FocusArea[] = [
      ...(sidebarVisible ? (["sidebar"] as const) : []),
      ...(composerTarget !== null && !composerLocked ? (["composer"] as const) : []),
      "thread",
      ...(terminalDrawer.open ? (["terminal"] as const) : []),
    ];
    setFocusArea((area) => order[(order.indexOf(area) + 1) % order.length] ?? "thread");
  };

  /**
   * Text typed or pasted into the sidebar goes to the composer: the first key lands there,
   * and the rest follow focus.
   */
  const writeToComposer = (write: (dock: ComposerDockHandle) => void): boolean => {
    if (composerLocked && subagents.readOnlyReason !== null) {
      setStatus(subagents.readOnlyReason);
      return true;
    }
    if (composerTarget === null || dockRef.current === null) {
      setStatus("Select a thread to type a message");
      return true;
    }
    write(dockRef.current);
    setFocusArea("composer");
    if (sidebarOverlayOpen) setSidebarOverlayOpen(false);
    return true;
  };
  const typeIntoComposer = (text: string) => writeToComposer((dock) => dock.insertText(text));

  const runSidebarCommand = (type: "menu" | "rename" | "delete"): void => {
    const row = sidebar.cursorRow;
    const selected = sidebar.multiSelection.threadIds;
    if (type === "delete") {
      if (selected.size > 0) management.requestDelete([...selected]);
      else if (row?.kind === "thread") management.requestDelete([row.threadId]);
      else if (row?.kind === "project") setStatus("Remove a project from its menu (⇧F10)");
      return;
    }
    if (row === null) return;
    if (type === "rename") {
      if (row.kind === "thread") management.renameThread(row.threadId);
      else if (row.kind === "project") management.renameProject(row.projectId);
      return;
    }
    const target = menuTargetForRow(row);
    if (target !== null) openContextMenu(target, null);
  };

  /** Every key comes here before the focused textarea; true means it was used up. */
  const handleKey = (key: KeyEvent): boolean => {
    const picker = modelPickerRef.current;
    if (picker !== null) {
      if (key.ctrl && key.name === "c") {
        setModelPicker(null);
        return true;
      }
      const outcome = reduceModelPickerKey(pickerProviders, picker, key);
      if (outcome?.type === "close") setModelPicker(null);
      else if (outcome?.type === "state") setModelPicker(outcome.state);
      else if (outcome?.type === "select") pickFromModelPicker(outcome.instanceId, outcome.model);
      return true;
    }
    // A dialog owns the keyboard: its text box gets the keys it doesn't use.
    if (management.dialogOpen) return management.handleDialogKey(key);
    if (git.handleKey(key)) return true;
    if (archivedSelected !== null) {
      const row = archivedRow;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) setArchivedSelection(null);
      else if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        setArchivedSelection(selectArchivedRow(archivedRows, archivedSelected.index + delta));
      } else if (isEnter(key.name) && !key.repeated && row) void management.unarchive(row.threadId);
      else if ((key.name === "delete" || key.name === "backspace") && row) {
        management.requestDelete([row.threadId], [row.title]);
      }
      return true;
    }
    const shortcut = resolveTuiShortcutCommand(
      tuiShortcutEvent(key),
      serverConfig?.keybindings ?? [],
      { context: { terminalFocus: terminalFocused, terminalOpen: terminalDrawer.open } },
    );
    // In the terminal, Ctrl+K is the shell's; the palette waits until focus leaves.
    if ((!terminalFocused && isPaletteShortcut(key)) || shortcut === "commandPalette.toggle") {
      setContextMenu(null);
      setPaletteIndex(0);
      setPaletteQuery("");
      setPaletteOpen((open) => !open);
      return true;
    }
    if (shortcut === "modelPicker.toggle") {
      toggleModelPicker();
      return true;
    }
    if (shortcut === "diff.toggle") {
      toggleDiff();
      return true;
    }
    if (shortcut === "chat.new" || shortcut === "chat.newLocal") {
      openNewThread(newThreadProjectId);
      return true;
    }
    if (paletteOpen) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) setPaletteOpen(false);
      else if (key.name === "up") setPaletteIndex(Math.max(0, paletteSelected - 1));
      else if (key.name === "down")
        setPaletteIndex(Math.min(paletteActions.length - 1, paletteSelected + 1));
      else if (isEnter(key.name)) {
        const action = paletteActions[paletteSelected];
        if (action && !key.repeated) runAction(action);
      } else if (key.name === "backspace") {
        setPaletteQuery((query) => query.slice(0, -1));
        setPaletteIndex(0);
      } else {
        // Typing filters the list.
        const text = printableText(key);
        if (text !== null) {
          setPaletteQuery((query) => query + text);
          setPaletteIndex(0);
        }
      }
      return true;
    }
    if (contextMenu) {
      if (key.name === "escape") setContextMenu(null);
      else if (key.name === "up" || key.name === "k")
        setContextMenu({ ...contextMenu, index: Math.max(0, contextMenu.index - 1) });
      else if (key.name === "down" || key.name === "j")
        setContextMenu({
          ...contextMenu,
          index: Math.min(contextMenuItems.length - 1, contextMenu.index + 1),
        });
      else if (isEnter(key.name) && !key.repeated) {
        const item = contextMenuItems[contextMenu.index];
        if (item) runMenuAction(contextMenu.target, item);
      }
      return true;
    }
    // The drawer's shortcuts work from anywhere; a focused terminal takes every other key.
    if (terminalDrawer.handleKey(key, shortcut)) return true;
    if (key.ctrl && key.name === "b") {
      toggleSidebar();
      return true;
    }
    if (key.ctrl && key.name === "p") {
      management.openAddProject();
      return true;
    }
    if (
      key.name === "escape" &&
      sidebarOverlayOpen &&
      sidebar.multiSelection.threadIds.size === 0
    ) {
      setSidebarOverlayOpen(false);
      setFocusArea(composerTarget === null ? "thread" : "composer");
      return true;
    }
    // Paging the transcript (or the diff in its place) works from any pane.
    const mainPane = diffShown ? diffPanelRef.current : threadViewRef.current;
    if ((key.name === "pageup" || key.name === "pagedown") && mainPane?.handleKey(key)) {
      return true;
    }
    if (dockFocused && dockRef.current?.handleKey(key)) return true;
    if (key.ctrl && key.name === "c") {
      // A held Ctrl+C's repeats never quit; quitting takes a fresh press.
      if (!key.repeated) requestExit();
      return true;
    }
    if (key.name === "tab" && !key.shift) {
      cycleFocus();
      return true;
    }
    // Everything else is typing.
    if (dockFocused) return false;
    if (sidebarFocused) {
      const action = resolveSidebarKey(key, {
        hasMultiSelection: sidebar.multiSelection.threadIds.size > 0,
      });
      if (action === null) return false;
      if (action.type === "type") return typeIntoComposer(action.text);
      if (action.type === "menu" || action.type === "rename" || action.type === "delete") {
        if (!key.repeated) runSidebarCommand(action.type);
        return true;
      }
      const outcome = sidebar.applyKey(action);
      if (outcome === "open") {
        setFocusArea(composerTarget === null ? "thread" : "composer");
        if (sidebarOverlayOpen) setSidebarOverlayOpen(false);
      }
      return outcome !== null;
    }
    const paneKey = routeThreadPaneKey(key, {
      composer: composerTarget?.kind ?? null,
      parent: subagents.context !== null,
      pane: mainPane === null ? null : (paneKeyEvent) => mainPane.handleKey(paneKeyEvent),
    });
    switch (paneKey) {
      case null:
        return false;
      case "pane":
        return true;
      case "diff":
        toggleDiff();
        return true;
      case "git-menu":
        git.openMenu();
        return true;
      case "branch-picker":
        git.openBranchPicker();
        return true;
      case "compose":
        if (composerLocked && subagents.readOnlyReason !== null)
          setStatus(subagents.readOnlyReason);
        else setFocusArea("composer");
        return true;
      case "parent":
        return subagents.openParent();
    }
  };

  useSyncKeyboard((key) => {
    if (handleKey(key)) key.preventDefault();
  });
  // A bracketed paste is one event, not keys: with the sidebar focused it goes to the
  // composer too, and the focus it moves there holds for an Enter in the same input chunk.
  // Dialogs, menus and the palette keep theirs (their inputs take pastes).
  useSyncPaste((event) => {
    const overlayOpen =
      modelPickerRef.current !== null ||
      management.dialogOpen ||
      archivedSelected !== null ||
      paletteOpen ||
      git.overlay !== null ||
      contextMenu !== null;
    if (overlayOpen) return;
    if (terminalFocused) {
      event.preventDefault();
      event.stopPropagation();
      terminalDrawer.paste(decodePasteBytes(event.bytes));
      return;
    }
    if (!sidebarFocused) return;
    event.preventDefault();
    event.stopPropagation();
    writeToComposer((dock) => dock.paste(event));
  });

  const toneColor = {
    success: palette.success,
    warning: palette.warning,
    info: palette.info,
    muted: palette.muted,
  }[connectionView.tone];
  const title = threadWindowLaunch ? "tr3x thread tab" : "tr3x";
  const activeStatus =
    selection.threadId === null ? null : (sidebar.statusByThread.get(selection.threadId) ?? null);
  const headerThreadTitle = activeThread
    ? truncateTitle(activeThread.title || DEFAULT_THREAD_TITLE, HEADER_THREAD_TITLE_MAX_LENGTH)
    : null;
  const sidebarWidth = TUI_SIDEBAR_WIDTH;
  const emptyLabel = sidebar.hasSnapshot ? "No projects yet" : "Loading projects…";
  const statusText = resolveFooterStatus(status, activeThread);
  const footerHints = modelPicker
    ? modelPickerPurpose === "commit"
      ? "Commit message model  ←→ provider  ↑↓ move  ⏎ pick  esc close"
      : "←→ provider  ↑↓ move  ⏎ pick  esc close"
    : git.overlay !== null
      ? git.overlay.kind === "branches"
        ? "type to filter  ↑↓ move  ⏎ pick  esc close"
        : "↑↓ move  ⏎ run  esc close"
      : terminalFocused
        ? TERMINAL_FOCUS_HINTS
        : sidebarFocused
          ? sidebar.multiSelection.threadIds.size > 0
            ? `${sidebar.multiSelection.threadIds.size} selected  ⇧↑↓ extend  ⇧F10 menu  del delete  esc clear`
            : "↑↓ move  ⏎ open  ⇧↑↓ select  ⇧F10 menu  F2 rename  del delete  type to compose  ⌘K palette"
          : requestsFocused
            ? panelHints
            : composerFocused
              ? `⏎ send  ⇧⏎ newline  ${running ? "⌥⏎ steer  esc stop  " : ""}^Y image  ⌘⇧M model  ${requestsShown ? "tab respond" : "tab focus"}  ⌘K palette`
              : diffShown
                ? `${DIFF_KEY_HINTS}  ↑↓ scroll  i compose`
                : `↑↓ scroll  PgUp/PgDn page  g/G top/bottom  ${THREAD_PANE_SHORTCUT_HINTS}  tab focus${layout.showSidebar ? "" : "  ctrl+b sidebar"}  ⌘K palette`;

  const sidebarElement = sidebarVisible ? (
    <Sidebar
      theme={theme}
      width={sidebarWidth}
      focused={sidebarFocused}
      rows={sidebar.rows}
      projectsById={sidebar.projectsById}
      threadsById={sidebar.threadsById}
      threadCountByProject={sidebar.threadCountByProject}
      olderSettledByProject={sidebar.olderSettledByProject}
      statusByThread={sidebar.statusByThread}
      projectStatusById={sidebar.projectStatusById}
      expandedProjectIds={sidebar.expandedProjectIds}
      activeProjectId={selection.projectId}
      activeThreadId={selection.threadId}
      cursorKey={sidebar.cursorKey}
      multiSelectedThreadIds={sidebar.multiSelection.threadIds}
      emptyLabel={emptyLabel}
      subagentSource={subagents.sidebarSource}
      onPress={pressSidebarRow}
    />
  ) : null;

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: palette.canvas,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          height: 1,
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: palette.surface,
        }}
      >
        <text
          wrapMode="none"
          truncate
          content={`${title} v${APP_VERSION}`}
          style={{ fg: palette.text }}
        />
        {headerThreadTitle ? (
          <text
            wrapMode="none"
            truncate
            content={`  ›  ${headerThreadTitle}`}
            style={{ fg: palette.muted }}
          />
        ) : null}
        <box style={{ flexGrow: 1 }} />
        <text
          wrapMode="none"
          truncate
          content={`● ${connectionView.label}`}
          style={{ fg: toneColor }}
        />
        {connectionView.detail ? (
          <text
            wrapMode="none"
            truncate
            content={`  ${connectionView.detail}`}
            style={{ fg: palette.subtle }}
          />
        ) : null}
      </box>
      <box style={{ flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
        {layout.showSidebar ? sidebarElement : null}
        <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0, padding: 1 }}>
          {composerTarget !== null ? (
            <>
              {composerTarget.kind === "draft" ? (
                <NewThreadView project={activeProject} theme={theme} />
              ) : diffShown ? (
                <DiffPanel
                  key={`diff:${composerTarget.threadId}`}
                  ref={diffPanelRef}
                  connection={connection}
                  threadId={composerTarget.threadId}
                  scope={diff.scope}
                  view={diff.view}
                  wordWrap={diff.wordWrap}
                  ignoreWhitespace={diff.ignoreWhitespace}
                  showFileList={viewportColumns - (layout.showSidebar ? sidebarWidth : 0) >= 100}
                  running={running}
                  theme={theme}
                  styles={markdownStyles}
                  onScopeChange={diff.setScope}
                  onViewChange={diff.setView}
                  onWordWrapChange={diff.setWordWrap}
                  onClose={() => diff.setOpen(false)}
                  onActivate={activateThreadView}
                />
              ) : (
                <ThreadView
                  key={`thread:${composerTarget.threadId}`}
                  ref={threadViewRef}
                  connection={connection}
                  threadId={composerTarget.threadId}
                  thread={activeThread}
                  project={activeProject}
                  statusPill={activeStatus}
                  theme={theme}
                  styles={markdownStyles}
                  timestampFormat={sidebar.settings.timestampFormat}
                  onActivate={activateThreadView}
                  onCopy={copyToClipboard}
                  onOpenDiff={openDiffForRun}
                  subagentActions={subagents.actions}
                  subagentContext={subagents.context}
                />
              )}
              {git.setupThreadId !== null && !diffShown ? (
                <WorktreeSetupPanel
                  key={`setup:${git.setupThreadId}`}
                  source={connection}
                  threadId={git.setupThreadId}
                  theme={theme}
                  onCancel={git.cancelWorktreeSetup}
                />
              ) : null}
              {composerTarget.kind === "thread" && !diffShown ? (
                <QueuedMessages
                  key={`queue:${composerTarget.threadId}`}
                  queueAtom={connection.thread(composerTarget.threadId).queueAtom}
                  theme={theme}
                />
              ) : null}
              {composerLocked && subagents.context !== null && activeThread !== null ? (
                <SubagentComposerBar
                  key={`subagent-bar:${composerTarget.threadId}`}
                  threadId={composerTarget.threadId}
                  context={subagents.context}
                  modelLabel={modelLabel(threadSettings(activeThread))}
                  fallbackState={subagentShellState(activeThread)}
                  reason={subagents.readOnlyReason ?? ""}
                  theme={theme}
                  actions={subagents.actions}
                />
              ) : (
                <ComposerDock
                  key={`composer:${composerTarget.threadId}`}
                  ref={dockRef}
                  composer={{
                    target: composerTarget,
                    store: composerStore,
                    theme,
                    baseSettings,
                    modelLabel,
                    providerBadge,
                    running,
                    stopRequested,
                    followUpBehavior,
                    clipboardDir: NodePath.join(paths.stateHomeDir, "clipboard"),
                    onStop: stopRun,
                    onExit: requestExit,
                    onNewThread: () => openNewThread(composerTarget.projectId),
                    onOpenModelPicker: toggleModelPicker,
                    onSetInteractionMode: setInteractionMode,
                    onSetRuntimeMode: setRuntimeMode,
                    onStatus: setStatus,
                    onClone: management.clone,
                    onToggleDiff: toggleDiff,
                    git: {
                      openMenu: git.openMenu,
                      openBranchPicker: git.openBranchPicker,
                      toggleWorktree: git.toggleWorktree,
                      retrySetup: git.retrySetup,
                      launchWorktree: git.launchWorktree,
                      sendBlockedReason: git.sendBlockedReason,
                    },
                    mentionSearch: {
                      cwd: activeThread
                        ? threadWorkspacePath(activeThread, activeProject ?? undefined)
                        : (activeProject?.workspaceRoot ?? null),
                      searchAtom: connection.searchEntriesAtom,
                    },
                  }}
                  sender={sender}
                  requests={
                    composerTarget.kind === "thread"
                      ? {
                          queue: requestQueue,
                          store: requestPanelStore,
                          responder,
                          cwd: activeThread
                            ? threadWorkspacePath(activeThread, activeProject ?? undefined)
                            : null,
                          stopSentRunId: stopRequestedRunId,
                          onHints: setPanelHints,
                        }
                      : null
                  }
                  focus={
                    // Overlays with their own text box take OpenTUI's focus; releasing the
                    // dock's here makes it take focus back when they close.
                    modelPicker !== null ||
                    paletteOpen ||
                    git.overlay !== null ||
                    management.dialogOpen ||
                    archivedSelected !== null
                      ? null
                      : composerFocused
                        ? "composer"
                        : requestsFocused
                          ? "requests"
                          : null
                  }
                  onFocus={setFocusArea}
                  onPanelShown={setRequestsShown}
                />
              )}
              {git.cwd !== null ? (
                <BranchToolbar
                  source={connection}
                  cwd={git.cwd}
                  draft={git.draft}
                  envMode={git.envMode}
                  worktreePath={git.worktreePath}
                  threadBranch={git.threadBranch}
                  failure={git.failure}
                  setupFailed={git.setupFailed}
                  theme={theme}
                  onPress={git.pressToolbar}
                />
              ) : null}
              {terminalDrawer.element}
            </>
          ) : (
            <ServerSummary
              connection={connection}
              environment={environment}
              providers={providers}
              theme={theme}
              emptyLabel={
                sidebar.hasSnapshot ? "Select a thread in the sidebar" : "Loading threads…"
              }
            />
          )}
        </box>
      </box>
      <box
        style={{
          flexDirection: "row",
          height: 1,
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: palette.footer,
        }}
      >
        <text wrapMode="none" truncate content={footerHints} style={{ fg: palette.subtle }} />
        <box style={{ flexGrow: 1 }} />
        {props.prefsLockedOut ? (
          <text
            wrapMode="none"
            content={statusText ? `  ${PREFS_LOCKED_OUT_NOTE}  ·  ` : `  ${PREFS_LOCKED_OUT_NOTE}`}
            // The hints truncate first, so the note always shows whole.
            style={{ fg: palette.subtle, flexShrink: 0 }}
          />
        ) : null}
        {statusText ? (
          // The hints truncate first, so a status reads whole.
          <text
            wrapMode="none"
            truncate
            content={statusText ?? ""}
            style={{ fg: palette.muted, flexShrink: 0, maxWidth: "60%" }}
          />
        ) : null}
      </box>
      {!layout.showSidebar && sidebarOverlayOpen ? (
        <box
          style={{
            position: "absolute",
            top: 1,
            left: 0,
            bottom: 1,
            zIndex: 130,
            flexDirection: "row",
          }}
        >
          {sidebarElement}
        </box>
      ) : null}
      {contextMenu ? (
        <box
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            zIndex: 240,
          }}
          onMouseDown={() => setContextMenu(null)}
        >
          <box
            style={{
              position: "absolute",
              top: contextMenu.top,
              left: contextMenu.left,
              width: CONTEXT_MENU_WIDTH,
              backgroundColor: palette.popup,
              border: true,
              borderColor: palette.border,
              flexDirection: "column",
              zIndex: 241,
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {contextMenuItems.map((item, index) => (
              <box
                key={item.id}
                onMouseOver={() => setContextMenu({ ...contextMenu, index })}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  runMenuAction(contextMenu.target, item);
                }}
                style={{
                  height: 1,
                  paddingLeft: 1,
                  backgroundColor:
                    index === contextMenu.index ? palette.controlActive : palette.popup,
                }}
              >
                <text
                  wrapMode="none"
                  content={item.label}
                  style={{
                    fg:
                      item.disabledReason !== undefined
                        ? palette.subtle
                        : item.destructive
                          ? palette.composerStop
                          : index === contextMenu.index
                            ? palette.text
                            : palette.muted,
                  }}
                />
              </box>
            ))}
          </box>
        </box>
      ) : null}
      {modelPicker ? (
        <ModelPickerView
          providers={pickerProviders}
          state={modelPicker}
          current={
            modelPickerPurpose === "commit"
              ? commitModelSelection
              : (effectiveSettings?.modelSelection ?? null)
          }
          theme={theme}
          onPick={pickFromModelPicker}
        />
      ) : null}
      {git.overlay !== null && git.cwd !== null && git.projectCwd !== null ? (
        <GitOverlay
          ref={gitOverlayRef}
          source={connection}
          cwd={git.cwd}
          mode={git.overlay}
          projectCwd={git.projectCwd}
          envMode={git.envMode}
          worktreePath={git.worktreePath}
          threadBranch={git.threadBranch}
          pickingWorktreeBase={git.pickingWorktreeBase}
          commitModelLabel={commitModelLabel}
          armed={git.armed}
          setupFailed={git.setupFailed}
          failure={git.failure}
          left={(layout.showSidebar ? sidebarWidth : 0) + 2}
          theme={theme}
          onMenuItem={git.runMenuItem}
          onBranchItem={git.pickBranch}
          onClose={git.closeOverlay}
        />
      ) : null}
      {paletteOpen ? (
        <box
          style={{
            position: "absolute",
            top: 2,
            left: 4,
            right: 4,
            flexDirection: "column",
            backgroundColor: palette.popup,
            border: true,
            borderColor: palette.accent,
            padding: 1,
            zIndex: 250,
          }}
        >
          <text
            wrapMode="none"
            truncate
            content={
              paletteQuery.length > 0 ? `› ${paletteQuery}▏` : "Command palette  (type to filter)"
            }
            style={{ fg: paletteQuery.length > 0 ? palette.text : palette.subtle, marginBottom: 1 }}
          />
          {paletteActions.length === 0 ? (
            <text content="No matching actions" style={{ fg: palette.muted }} />
          ) : null}
          {paletteActions
            .slice(paletteWindowStart, paletteWindowStart + PALETTE_ROWS_MAX)
            .map((action) => (
              <box
                key={action.id}
                style={{
                  flexDirection: "row",
                  height: 1,
                  paddingLeft: 1,
                  backgroundColor:
                    action === paletteActions[paletteSelected] ? palette.selection : palette.popup,
                }}
              >
                <text
                  wrapMode="none"
                  truncate
                  content={action.label}
                  style={{ fg: action.disabled ? palette.subtle : palette.text }}
                />
                <text
                  wrapMode="none"
                  truncate
                  content={`  ${action.description}`}
                  style={{ fg: palette.subtle }}
                />
              </box>
            ))}
        </box>
      ) : null}
      {archivedSelected !== null ? (
        <ArchivedThreadsView
          rows={archivedRows}
          index={archivedSelected.index}
          loading={archivedSnapshot === null}
          error={archivedError}
          theme={theme}
          onSelect={(index) => setArchivedSelection(selectArchivedRow(archivedRows, index))}
          onClose={() => setArchivedSelection(null)}
        />
      ) : null}
      {management.prompt !== null ? (
        <PromptDialogView
          prompt={management.prompt}
          revision={management.promptRevision}
          busy={management.promptBusy}
          suggestions={management.suggestions}
          suggestionIndex={management.suggestionIndex}
          theme={theme}
          onInput={management.setPromptValue}
          onPickSuggestion={management.pickSuggestion}
          onCancel={management.closePrompt}
        />
      ) : null}
      {management.confirm !== null ? (
        <ConfirmDialogView
          state={management.confirm}
          theme={theme}
          onPress={management.pressConfirm}
        />
      ) : null}
    </box>
  );
}
