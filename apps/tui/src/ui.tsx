// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The UI deletes launch files it wrote itself and runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
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
import { Composer, QueuedMessages, type ComposerHandle, type ProviderBadge } from "./composer.tsx";
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  describeSendFailure,
  type ComposerTarget,
} from "./composerSend.ts";
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
import type { TuiPaths } from "./config.ts";
import type { TuiConnection } from "./connection/tuiConnection.ts";
import { resolveTuiShortcutCommand } from "./keybindings.ts";
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
import { Sidebar, sidebarRowId, type SidebarPress } from "./sidebar.tsx";
import {
  buildThreadContextMenuItems,
  threadWorkspacePath,
  type ThreadContextMenuItem,
} from "./sidebarContextMenu.ts";
import { useSidebarController } from "./sidebarController.ts";
import type { SidebarThread } from "./sidebarModel.ts";
import type { TuiTheme } from "./theme.ts";
import {
  buildThreadWindowCommand,
  expireThreadWindowLaunch,
  type ThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch.ts";
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

const APP_VERSION = packageJson.version ?? "0.0.0";
const HEADER_THREAD_TITLE_MAX_LENGTH = 44;
const CONTEXT_MENU_WIDTH = 24;

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
  readonly interruptRequestToken?: number;
  readonly onRequestExit?: () => void;
  readonly threadWindowLaunch?: ThreadWindowLaunch | null;
}

/** Footer note in a main window that another window's prefs lock keeps from saving. */
const PREFS_LOCKED_OUT_NOTE = "prefs not saved here";

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly run: () => void | Promise<void>;
}

interface ContextMenuState {
  readonly threadId: string;
  readonly top: number;
  readonly left: number;
  readonly index: number;
}

type FocusArea = "sidebar" | "thread" | "composer";

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

function isPaletteShortcut(key: KeyEvent): boolean {
  return key.name === "k" && Boolean(key.ctrl || key.meta || key.super);
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
    interruptRequestToken,
    onRequestExit,
  } = props;
  const palette = theme.palette;
  const connectionResult = useAtomValue(connection.connectionStateAtom);
  const serverConfig = useAtomValue(connection.serverConfigAtom);
  const { width: viewportColumns } = useTerminalDimensions();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusArea, setFocusArea] = useState<FocusArea>("sidebar");
  const [sidebarCollapsedPreference, setSidebarCollapsedPreference] = useState(false);
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const markdownStyles = useMarkdownStyles(theme);
  const threadViewRef = useRef<ThreadViewHandle | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  const [modelPicker, modelPickerRef, setModelPicker] = useSyncedState<ModelPickerState | null>(
    null,
  );
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
  const settingsOfThread = useEventCallback((threadId: string) => {
    const thread = sidebar.threadsById.get(threadId);
    return thread ? threadSettings(thread) : null;
  });
  const [sender] = useState(() =>
    createComposerSender({
      store: composerStore,
      startTurn: connection.startTurn,
      setRuntimeMode: connection.setRuntimeMode,
      setInteractionMode: connection.setInteractionMode,
      threadSettings: settingsOfThread,
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      // Sends the last quit saved because they may have reached the server.
      restore: composerStore.pendingSendsAtLaunch(),
      onFailure: (send, error, action) =>
        logger.log("composer.send.failed", {
          threadId: send.target.threadId,
          commandId: send.commandId,
          action,
          error: action === "stuck" ? "no reply yet" : describeSendFailure(error),
        }),
    }),
  );
  useEffect(() => () => sender.dispose(), [sender]);
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
  useEffect(() => {
    if ((interruptRequestToken ?? 0) > 0) finishExit();
  }, [interruptRequestToken, finishExit]);

  // Sends that lost the connection go out again, with the same ids, once it's back.
  const connected = connectionView.label === "Connected";
  useEffect(() => {
    if (connected) void sender.retryWaiting();
  }, [connected, sender]);

  const retryNow = useCallback(() => {
    void runAtomCommand(connection.registry, connection.retryNow, connection.environmentId);
    setStatus("Reconnecting");
  }, [connection]);

  const threadsById = sidebar.threadsById;
  const projectsById = sidebar.projectsById;
  const openThreadInRexTab = useCallback(
    async (threadId: string | null) => {
      const thread = threadId === null ? undefined : threadsById.get(threadId);
      if (!rex || !thread) {
        setStatus(rex ? "Select a thread first" : "Rex not detected");
        return;
      }
      const bearerToken = await connection.session.getBearerToken();
      const cwd = threadWorkspacePath(thread, projectsById.get(thread.projectId)) ?? undefined;
      const { reused } = await rex.windows.openOrFocus(`thread:${thread.id}`, async () => {
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
          },
        );
        try {
          return await rex.client.openWindow({
            label: rexTabLabel(thread.title || DEFAULT_THREAD_TITLE),
            cwd,
            command: buildThreadWindowCommand(launchFile, paths),
          });
        } catch (error) {
          await NodeFSP.rm(launchFile, { force: true });
          throw error;
        } finally {
          expireThreadWindowLaunch(launchFile);
        }
      });
      setStatus(reused ? "Focused Rex tab" : "Opened thread in Rex tab");
    },
    [connection.session, paths, projectsById, rex, threadsById],
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

  const contextMenuItems = useMemo(() => buildThreadContextMenuItems({ rexTabs }), [rexTabs]);
  const runContextAction = useCallback(
    (item: ThreadContextMenuItem, threadId: string) => {
      setContextMenu(null);
      runTask(`context:${item.id}`, async () => {
        const thread = threadsById.get(threadId);
        switch (item.id) {
          case "open-rex-tab":
            await openThreadInRexTab(threadId);
            return;
          case "mark-unread":
            sidebar.markUnread(threadId);
            setStatus(thread?.latestRun?.completedAt ? "Marked unread" : "Nothing to mark unread");
            return;
          case "copy-path": {
            const path = thread
              ? threadWorkspacePath(thread, projectsById.get(thread.projectId))
              : null;
            if (path === null) throw new Error("This thread has no workspace path.");
            await copyTextToClipboard(path);
            setStatus("Copied path");
            return;
          }
          case "copy-thread-id":
            await copyTextToClipboard(threadId);
            setStatus("Copied thread ID");
            return;
        }
      });
    },
    [openThreadInRexTab, projectsById, runTask, sidebar, threadsById],
  );

  const openContextMenu = useCallback(
    (threadId: string, anchor: { x: number; y: number } | null) => {
      const rowY = renderer.root.findDescendantById(sidebarRowId(`thread:${threadId}`))?.y;
      const top = anchor?.y ?? (rowY === undefined ? 2 : rowY + 1);
      const left = anchor?.x ?? 2;
      setPaletteOpen(false);
      setContextMenu({
        threadId,
        top: Math.max(0, Math.min(top, renderer.height - contextMenuItems.length - 3)),
        left: Math.max(0, Math.min(left, renderer.width - CONTEXT_MENU_WIDTH - 1)),
        index: 0,
      });
    },
    [contextMenuItems.length, renderer],
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
  const running = threadRuntimeIsActive(activeThread?.runtime);
  const activeRunId = activeThread?.runtime?.activeRunId ?? null;
  const stopRequested = running && stopRequestedRunId === (activeRunId ?? "unknown");

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
    setModelPicker(openModelPicker(pickerProviders, effectiveSettings?.modelSelection ?? null));
  };

  const stopRun = () => {
    if (!activeThread || !running) return;
    const runKey = activeRunId ?? "unknown";
    setStopRequestedRunId(runKey);
    // Messages not sent yet stay here until resumed, like the queue the server holds.
    const held = sender.hold(activeThread.id);
    setStatus(
      held === 0
        ? "Stopping"
        : `Stopping; ${held} unsent message${held === 1 ? "" : "s"} held. Enter or /resume sends, /discard edits`,
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

  // `/resume`: releases what the server holds after Stop, like upstream's "Resume thread".
  const resumeQueue = (threadId: ThreadId) => {
    void connection
      .resumeQueue({ commandId: CommandId.make(NodeCrypto.randomUUID()), threadId })
      .then((result) => {
        if (!result.ok) setStatus(`Resume failed: ${describeSendFailure(result.error)}`);
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
      sidebar.pressRow(press.row);
      return;
    }
    // Like before, a right-click opens the menu without switching threads.
    sidebar.focusRow(press.row);
    if (press.row.kind === "thread") {
      openContextMenu(press.row.threadId, { x: press.x, y: press.y });
    }
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
  actions.push({
    id: "model:pick",
    label: "Pick model",
    description: "⌘⇧M",
    disabled: composerTarget === null,
    run: toggleModelPicker,
  });
  if (rexTabs) {
    actions.push({
      id: "rex:thread",
      label: "Open thread in Rex tab",
      description: activeThread?.title ?? "Select a thread first",
      disabled: activeThread === null,
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

  const composerFocused = focusArea === "composer" && composerTarget !== null;
  const cycleFocus = () => {
    const order: FocusArea[] = [
      ...(sidebarVisible ? (["sidebar"] as const) : []),
      ...(composerTarget !== null ? (["composer"] as const) : []),
      "thread",
    ];
    setFocusArea((area) => order[(order.indexOf(area) + 1) % order.length] ?? "thread");
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
      else if (outcome?.type === "select") pickModel(outcome.instanceId, outcome.model);
      return true;
    }
    const shortcut = resolveTuiShortcutCommand(
      {
        keyName: key.name,
        sequence: key.sequence,
        ctrl: key.ctrl,
        meta: key.meta,
        super: key.super ?? false,
        shift: key.shift,
      },
      serverConfig?.keybindings ?? [],
    );
    if (isPaletteShortcut(key) || shortcut === "commandPalette.toggle") {
      setContextMenu(null);
      setPaletteIndex(0);
      setPaletteOpen((open) => !open);
      return true;
    }
    if (shortcut === "modelPicker.toggle") {
      toggleModelPicker();
      return true;
    }
    if (shortcut === "chat.new" || shortcut === "chat.newLocal") {
      openNewThread(newThreadProjectId);
      return true;
    }
    if (paletteOpen) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) setPaletteOpen(false);
      else if (key.name === "up") setPaletteIndex((index) => Math.max(0, index - 1));
      else if (key.name === "down")
        setPaletteIndex((index) => Math.min(actions.length - 1, index + 1));
      else if (isEnter(key.name)) {
        const action = actions[paletteIndex];
        if (action) runAction(action);
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
      else if (isEnter(key.name)) {
        const item = contextMenuItems[contextMenu.index];
        if (item) runContextAction(item, contextMenu.threadId);
      }
      return true;
    }
    if (key.ctrl && key.name === "b") {
      toggleSidebar();
      return true;
    }
    if (key.name === "escape" && sidebarOverlayOpen) {
      setSidebarOverlayOpen(false);
      setFocusArea(composerTarget === null ? "thread" : "composer");
      return true;
    }
    // Paging the transcript works from any pane.
    if (
      (key.name === "pageup" || key.name === "pagedown") &&
      threadViewRef.current?.handleKey(key)
    ) {
      return true;
    }
    if (composerFocused && composerRef.current?.handleKey(key)) return true;
    if (key.ctrl && key.name === "c") {
      requestExit();
      return true;
    }
    if (key.name === "tab" && !key.shift) {
      cycleFocus();
      return true;
    }
    // Everything else is typing.
    if (composerFocused) return false;
    if (sidebarFocused) {
      if (key.name === "m" && sidebar.cursorRow?.kind === "thread") {
        openContextMenu(sidebar.cursorRow.threadId, null);
        return true;
      }
      const outcome = sidebar.handleKey(key);
      if (outcome === "open") {
        setFocusArea(composerTarget === null ? "thread" : "composer");
        if (sidebarOverlayOpen) setSidebarOverlayOpen(false);
      }
      if (outcome !== null) return true;
    }
    if (!sidebarFocused && threadViewRef.current?.handleKey(key)) return true;
    if (!sidebarFocused && composerTarget !== null && (key.name === "i" || isEnter(key.name))) {
      setFocusArea("composer");
      return true;
    }
    if (key.name === "q") {
      requestExit();
      return true;
    }
    if (key.name === "r") {
      retryNow();
      return true;
    }
    return false;
  };

  useKeyboard((key) => {
    if (handleKey(key)) key.preventDefault();
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
  // "Stopping" ends with the run.
  const statusText = status === "Stopping" && !running ? "Stopped" : status;
  const footerHints = modelPicker
    ? "←→ provider  ↑↓ move  ⏎ pick  esc close"
    : sidebarFocused
      ? "↑↓ move  ←→ fold  ⏎ open  m menu  ⌘N new  tab focus  ⌘K palette  q quit"
      : composerFocused
        ? `⏎ send  ⇧⏎ newline  ${running ? "⌥⏎ steer  esc stop  " : ""}^Y image  ⌘⇧M model  tab focus  ⌘K palette`
        : `↑↓ scroll  PgUp/PgDn page  End bottom  i compose  tab focus${layout.showSidebar ? "" : "  ctrl+b sidebar"}  ⌘K palette  q quit`;

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
      emptyLabel={emptyLabel}
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
                />
              )}
              {composerTarget.kind === "thread" ? (
                <QueuedMessages
                  key={`queue:${composerTarget.threadId}`}
                  queueAtom={connection.thread(composerTarget.threadId).queueAtom}
                  theme={theme}
                />
              ) : null}
              <Composer
                key={`composer:${composerTarget.threadId}`}
                ref={composerRef}
                target={composerTarget}
                store={composerStore}
                sender={sender}
                theme={theme}
                focused={composerFocused && modelPicker === null && !paletteOpen}
                baseSettings={baseSettings}
                modelLabel={modelLabel}
                providerBadge={providerBadge}
                running={running}
                stopRequested={stopRequested}
                followUpBehavior={followUpBehavior}
                clipboardDir={NodePath.join(paths.stateHomeDir, "clipboard")}
                onFocus={() => setFocusArea("composer")}
                onStop={stopRun}
                onResumeQueue={() => resumeQueue(composerTarget.threadId)}
                onExit={requestExit}
                onNewThread={() => openNewThread(composerTarget.projectId)}
                onOpenModelPicker={toggleModelPicker}
                onSetInteractionMode={setInteractionMode}
                onSetRuntimeMode={setRuntimeMode}
                onStatus={setStatus}
              />
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
            content={status ? `  ${PREFS_LOCKED_OUT_NOTE}  ·  ` : `  ${PREFS_LOCKED_OUT_NOTE}`}
            // The hints truncate first, so the note always shows whole.
            style={{ fg: palette.subtle, flexShrink: 0 }}
          />
        ) : null}
        {status ? (
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
                  runContextAction(item, contextMenu.threadId);
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
                  style={{ fg: index === contextMenu.index ? palette.text : palette.muted }}
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
          current={effectiveSettings?.modelSelection ?? null}
          theme={theme}
          onPick={pickModel}
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
            content="Command palette"
            style={{ fg: palette.subtle, marginBottom: 1 }}
          />
          {actions.map((action, index) => (
            <box
              key={action.id}
              style={{
                flexDirection: "row",
                height: 1,
                paddingLeft: 1,
                backgroundColor: index === paletteIndex ? palette.selection : palette.popup,
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
    </box>
  );
}
