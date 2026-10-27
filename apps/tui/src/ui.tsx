// @effect-diagnostics nodeBuiltinImport:off -- The UI deletes launch files it wrote itself.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CliRenderer } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";

import packageJson from "../package.json" with { type: "json" };
import type { TuiPaths } from "./config.ts";
import type { TuiConnection } from "./connection/tuiConnection.ts";
import type { T1Logger } from "./log.ts";
import {
  createRexClient,
  createRexWindowRegistry,
  resolveRexContext,
  rexTabLabel,
} from "./rexWorkspace.ts";
import type { TuiTheme } from "./theme.ts";
import {
  buildThreadWindowCommand,
  expireThreadWindowLaunch,
  type ThreadWindowLaunch,
  writeThreadWindowLaunch,
} from "./threadWindowLaunch.ts";

const APP_VERSION = packageJson.version ?? "0.0.0";
const PLACEHOLDER = "Porting to orchestration v2";

export interface AppProps {
  readonly renderer: CliRenderer;
  readonly connection: TuiConnection;
  readonly paths: TuiPaths;
  readonly logger: T1Logger;
  readonly theme: TuiTheme;
  readonly interruptRequestToken?: number;
  readonly onRequestExit?: () => void;
  readonly threadWindowLaunch?: ThreadWindowLaunch | null;
}

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly run: () => void | Promise<void>;
}

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

function isPaletteShortcut(key: {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
}): boolean {
  return key.name === "k" && Boolean(key.ctrl || key.meta || key.super);
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
  const shellState = useAtomValue(connection.shellStateAtom);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  const connectionState = Option.getOrNull(AsyncResult.value(connectionResult));
  const connectionView = describeConnection(connectionState, connection.session.mode);
  const environment = serverConfig?.environment ?? null;
  const providers = serverConfig?.providers ?? [];
  const snapshot = Option.getOrNull(shellState.snapshot);
  const threads = snapshot?.threads ?? [];
  const projects = snapshot?.projects ?? [];

  const rex = useMemo(() => {
    const context = resolveRexContext();
    if (!context) return null;
    const client = createRexClient(context);
    return { client, windows: createRexWindowRegistry(client) };
  }, []);

  useEffect(() => {
    if ((interruptRequestToken ?? 0) > 0) onRequestExit?.();
  }, [interruptRequestToken, onRequestExit]);

  const retryNow = useCallback(() => {
    void runAtomCommand(connection.registry, connection.retryNow, connection.environmentId);
    setStatus("Reconnecting");
  }, [connection]);

  const openThreadInRexTab = useCallback(async () => {
    const thread = threads[0];
    if (!rex || !thread) {
      setStatus(rex ? "No threads yet" : "Rex not detected");
      return;
    }
    const bearerToken = await connection.session.getBearerToken();
    const cwd = projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
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
          label: rexTabLabel(thread.title),
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
  }, [connection.session, paths, projects, rex, threads]);

  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [];
    if (rex && !threadWindowLaunch) {
      items.push({
        id: "rex:thread",
        label: "Open thread in Rex tab",
        description: threads[0]?.title ?? "No threads yet",
        disabled: threads.length === 0,
        run: openThreadInRexTab,
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
    connectionView,
    onRequestExit,
    openThreadInRexTab,
    retryNow,
    rex,
    threadWindowLaunch,
    threads,
  ]);

  const runAction = useCallback(
    (action: PaletteAction) => {
      setPaletteOpen(false);
      if (action.disabled) return;
      Promise.resolve(action.run()).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.log("action.failed", { action: action.id, error: message });
        setStatus(message);
      });
    },
    [logger],
  );

  useKeyboard((key) => {
    if (isPaletteShortcut(key)) {
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
      else if (key.name === "return" || key.name === "enter") {
        const action = actions[paletteIndex];
        if (action) runAction(action);
      }
      return;
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
        <box
          style={{
            width: 34,
            flexDirection: "column",
            border: ["right"],
            borderColor: palette.border,
            padding: 1,
          }}
        >
          <text
            wrapMode="none"
            truncate
            content="Projects and threads"
            style={{ fg: palette.subtle }}
          />
          <text
            wrapMode="none"
            truncate
            content={`${projects.length} project${projects.length === 1 ? "" : "s"}, ${threads.length} thread${threads.length === 1 ? "" : "s"}`}
            style={{ fg: palette.muted, marginTop: 1 }}
          />
          <text
            wrapMode="none"
            truncate
            content={PLACEHOLDER}
            style={{ fg: palette.subtle, marginTop: 1 }}
          />
        </box>
        <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
          <text wrapMode="none" truncate content="Server" style={{ fg: palette.subtle }} />
          {environment ? (
            <box style={{ flexDirection: "column", marginTop: 1 }}>
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
              style={{ fg: palette.muted, marginTop: 1 }}
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
          <box style={{ flexGrow: 1 }} />
          <text
            wrapMode="none"
            truncate
            content={
              threadWindowLaunch
                ? `Thread ${threadWindowLaunch.threadId}: ${PLACEHOLDER}`
                : `Thread view, composer, approvals: ${PLACEHOLDER}`
            }
            style={{ fg: palette.subtle }}
          />
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
        <text
          wrapMode="none"
          truncate
          content="⌘K / Ctrl+K palette   r reconnect   q quit"
          style={{ fg: palette.subtle }}
        />
        <box style={{ flexGrow: 1 }} />
        {status ? (
          <text wrapMode="none" truncate content={status} style={{ fg: palette.muted }} />
        ) : null}
      </box>
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
