// @effect-diagnostics nodeBuiltinImport:off -- The UI deletes launch files it wrote itself.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import packageJson from "../package.json" with { type: "json" };
import { copyTextToClipboard } from "./clipboardText.ts";
import type { TuiPaths } from "./config.ts";
import type { TuiConnection } from "./connection/tuiConnection.ts";
import type { T1Logger } from "./log.ts";
import type { PrefsWriter, TuiPrefs } from "./prefs.ts";
import { formatRelativeTime } from "./relativeTime.ts";
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
import { threadStatusColor } from "./sidebarStatus.ts";
import { RELATIVE_TIME_TICKER, useTicker } from "./ticker.ts";
import type { TuiTheme } from "./theme.ts";
import {
  buildThreadWindowCommand,
  expireThreadWindowLaunch,
  type ThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch.ts";
import { DEFAULT_THREAD_TITLE, truncateTitle } from "./threadTitle.ts";

const APP_VERSION = packageJson.version ?? "0.0.0";
const PLACEHOLDER = "Porting to orchestration v2";
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

type FocusArea = "sidebar" | "thread";

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

  const clock = useTicker(RELATIVE_TIME_TICKER);
  const sidebar = useSidebarController({
    connection,
    initialPrefs: props.initialPrefs,
    prefsWriter: props.prefsWriter,
    launch: threadWindowLaunch ?? null,
    cwd: props.cwd,
  });
  const { activeThread, activeProject, selection } = sidebar;

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

  useEffect(() => {
    if ((interruptRequestToken ?? 0) > 0) onRequestExit?.();
  }, [interruptRequestToken, onRequestExit]);

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

  // Stable, so the memoized sidebar rows don't re-render when the shell does.
  const pressSidebarRow = useEventCallback((press: SidebarPress) => {
    setFocusArea("sidebar");
    setContextMenu(null);
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

  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [];
    if (rexTabs) {
      items.push({
        id: "rex:thread",
        label: "Open thread in Rex tab",
        description: activeThread?.title ?? "Select a thread first",
        disabled: activeThread === null,
        run: () => openThreadInRexTab(selection.threadId),
      });
    }
    items.push({
      id: "connection:retry",
      label: "Reconnect now",
      description: connectionView.detail ?? connectionView.label,
      run: retryNow,
    });
    items.push({
      id: "app:quit",
      label: "Quit tr3x",
      description: "Ctrl+C",
      run: () => onRequestExit?.(),
    });
    return items;
  }, [
    activeThread,
    connectionView,
    onRequestExit,
    openThreadInRexTab,
    retryNow,
    rexTabs,
    selection.threadId,
  ]);

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

  useKeyboard((key) => {
    if (isPaletteShortcut(key)) {
      setContextMenu(null);
      setPaletteIndex(0);
      setPaletteOpen((open) => !open);
      return;
    }
    if (key.ctrl && key.name === "c") {
      onRequestExit?.();
      return;
    }
    if (paletteOpen) {
      if (key.name === "escape") setPaletteOpen(false);
      else if (key.name === "up") setPaletteIndex((index) => Math.max(0, index - 1));
      else if (key.name === "down")
        setPaletteIndex((index) => Math.min(actions.length - 1, index + 1));
      else if (isEnter(key.name)) {
        const action = actions[paletteIndex];
        if (action) runAction(action);
      }
      return;
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
      return;
    }
    if (key.ctrl && key.name === "b") {
      toggleSidebar();
      return;
    }
    if (key.name === "escape" && sidebarOverlayOpen) {
      setSidebarOverlayOpen(false);
      setFocusArea("thread");
      return;
    }
    if (key.name === "tab") {
      setFocusArea((area) => (area === "sidebar" || !sidebarVisible ? "thread" : "sidebar"));
      return;
    }
    if (sidebarFocused) {
      if (key.name === "m" && sidebar.cursorRow?.kind === "thread") {
        openContextMenu(sidebar.cursorRow.threadId, null);
        return;
      }
      const outcome = sidebar.handleKey(key);
      if (outcome === "open") {
        setFocusArea("thread");
        if (sidebarOverlayOpen) setSidebarOverlayOpen(false);
      }
      if (outcome !== null) return;
    }
    if (key.name === "q") onRequestExit?.();
    if (key.name === "r") retryNow();
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
  const footerHints = sidebarFocused
    ? "↑↓ move  ←→ fold  ⏎ open  m menu  tab focus  ⌘K palette  q quit"
    : `tab sidebar${layout.showSidebar ? "" : "  ctrl+b show sidebar"}  ⌘K palette  r reconnect  q quit`;

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
        <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
          {activeThread ? (
            <box style={{ flexDirection: "column", marginBottom: 1 }}>
              <text
                wrapMode="none"
                truncate
                content={activeThread.title || DEFAULT_THREAD_TITLE}
                style={{ fg: palette.text }}
              />
              <box style={{ flexDirection: "row", height: 1 }}>
                <text
                  wrapMode="none"
                  truncate
                  content={`${activeProject?.title ?? "Unknown project"}  ·  updated ${formatRelativeTime(activeThread.updatedAt, clock.nowMs)}`}
                  style={{ fg: palette.muted }}
                />
                {activeStatus ? (
                  <text
                    wrapMode="none"
                    content={`  ·  ${activeStatus.label}`}
                    style={{ fg: threadStatusColor(activeStatus.label, theme) }}
                  />
                ) : null}
              </box>
              <text
                wrapMode="none"
                truncate
                content={`Thread view, composer, approvals: ${PLACEHOLDER}`}
                style={{ fg: palette.subtle, marginTop: 1 }}
              />
            </box>
          ) : (
            <text
              wrapMode="none"
              truncate
              content={
                selection.threadId !== null
                  ? `Thread ${selection.threadId} is not in the sidebar`
                  : sidebar.hasSnapshot
                    ? "Select a thread in the sidebar"
                    : "Loading threads…"
              }
              style={{ fg: palette.muted, marginBottom: 1 }}
            />
          )}
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
            content={status ? `${PREFS_LOCKED_OUT_NOTE}  ·  ` : PREFS_LOCKED_OUT_NOTE}
            style={{ fg: palette.subtle }}
          />
        ) : null}
        {status ? (
          <text wrapMode="none" truncate content={status} style={{ fg: palette.muted }} />
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
