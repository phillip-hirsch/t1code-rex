// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The entrypoint runs on Bun outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import React from "react";
import { DEFAULT_APP_THEME } from "@t3tools/client-core";

import packageJson from "../package.json" with { type: "json" };
import { resolveTuiPaths, type TuiPaths } from "./config.ts";
import { createTuiConnection } from "./connection/tuiConnection.ts";
import { createT1Logger, type T1Logger } from "./log.ts";
import { createPrefsWriter, readPrefs } from "./prefs.ts";
import { prefsLockPath, resolvePrefsAccess } from "./prefsLock.ts";
import {
  normalizeRendererThemeMode,
  resolveTerminalPalette,
  shouldResolveTerminalPalette,
  shouldTrackSystemThemeMode,
} from "./rendererTheme.ts";
import {
  attachServerSession,
  managedServerSession,
  resolveAttachedServerConnection,
  startManagedServer,
  type TuiServerSession,
} from "./serverLauncher.ts";
import { normalizeTuiThemeId, resolveTerminalThemeMode, resolveTuiTheme } from "./theme.ts";
import { consumeThreadWindowLaunch, type ThreadWindowLaunch } from "./threadWindowLaunch.ts";
import { App } from "./ui.tsx";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The TUI reports the host it runs on; there is no Effect runtime to inject it.
const HOST_PLATFORM = process.platform;

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function terminalIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return [env.TERM_PROGRAM, env.TERM, env.COLORTERM].filter(Boolean).join(" ").toLowerCase();
}

function shouldUseKittyKeyboard(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = readBooleanEnv(env.TR3X_USE_KITTY_KEYBOARD);
  if (forced !== undefined) return forced;
  const identity = terminalIdentity(env);
  // Rex (TERM_PROGRAM=rex) speaks the kitty keyboard protocol, which reports key repeats.
  return ["ghostty", "kitty", "wezterm", "iterm", "rex"].some((token) => identity.includes(token));
}

function shouldUseAlternateScreen(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.TR3X_USE_ALTERNATE_SCREEN) ?? true;
}

function shouldUseMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.TR3X_USE_MOUSE) ?? true;
}

function shouldEnableMouseMovement(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.TR3X_ENABLE_MOUSE_MOVEMENT) ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Thread tabs attach to the window that opened them, attach-only runs join a
 * server the user points at, and everything else starts a server on tr3x's
 * own data directory (never ~/.t3, which the user's T3 Code owns).
 */
async function resolveServerSession(
  paths: TuiPaths,
  logger: T1Logger,
  threadWindowLaunch: ThreadWindowLaunch | null,
): Promise<TuiServerSession> {
  if (threadWindowLaunch) {
    return attachServerSession(threadWindowLaunch.server, "thread-window");
  }
  const attached = resolveAttachedServerConnection();
  if (attached) {
    return attachServerSession(attached, "attached");
  }
  const server = await startManagedServer({
    baseDir: paths.homeDir,
    onLog: (event, details) => logger.log(event, details),
    onRestart: ({ attempt }) => logger.log("server.restarting", { attempt }),
    onFatal: (message) => process.stderr.write(`${message}\n`),
  });
  return managedServerSession(server);
}

const paths = resolveTuiPaths();
const logger = createT1Logger(paths.logPath);
let threadWindowLaunch: ThreadWindowLaunch | null = null;
try {
  threadWindowLaunch = consumeThreadWindowLaunch();
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}

let session: TuiServerSession;
try {
  session = await resolveServerSession(paths, logger, threadWindowLaunch);
} catch (error) {
  logger.log("server.start.failed", { error: errorMessage(error) });
  process.stderr.write(
    `tr3x could not reach a server: ${errorMessage(error)}\nSee ${paths.logPath}.\n`,
  );
  process.exit(1);
}

const connection = createTuiConnection({
  session,
  appVersion: packageJson.version ?? "0.0.0",
  platformOs: HOST_PLATFORM,
});
// One window writes prefs.json: the first main window takes a lock next to it. Thread
// tabs, headless runs, and main windows that find the lock held only read it.
const headless = process.env.TR3X_HEADLESS === "1";
const prefsAccess = resolvePrefsAccess({
  prefsPath: paths.prefsPath,
  wantsWrites: !threadWindowLaunch && !headless,
});
if (prefsAccess.kind === "owner") {
  // The OS frees the lock when this process dies; releasing on exit just ends it sooner.
  process.on("exit", prefsAccess.lock.release);
} else if (prefsAccess.kind === "locked-out") {
  logger.log("prefs.locked", {
    lockPath: prefsLockPath(paths.prefsPath),
    error: prefsAccess.error,
  });
}
const prefs = await readPrefs(paths);
const prefsWriter =
  prefsAccess.kind === "owner"
    ? createPrefsWriter(paths, (error) =>
        logger.log("prefs.save.failed", { error: errorMessage(error) }),
      )
    : null;
const prefsLockedOut = prefsAccess.kind === "locked-out";
const launchCwd = process.cwd();
const appTheme = prefs.appSettings?.theme ?? DEFAULT_APP_THEME;
const tuiThemeId = normalizeTuiThemeId(prefs.tuiThemeId);

if (headless) {
  const outputPath =
    process.env.TR3X_HEADLESS_FRAME_PATH?.trim() ||
    NodePath.join(paths.configHomeDir, "headless-frame.txt");
  const timeoutMs = Number(process.env.TR3X_HEADLESS_TIMEOUT_MS ?? 1_500);
  const width = Number(process.env.TR3X_HEADLESS_WIDTH ?? 160);
  const height = Number(process.env.TR3X_HEADLESS_HEIGHT ?? 48);
  const testSetup = await createTestRenderer({ width, height, kittyKeyboard: true });
  const root = createRoot(testSetup.renderer);
  root.render(
    <App
      renderer={testSetup.renderer}
      connection={connection}
      paths={paths}
      logger={logger}
      theme={resolveTuiTheme(appTheme, tuiThemeId)}
      initialPrefs={prefs}
      prefsWriter={null}
      cwd={launchCwd}
      threadWindowLaunch={threadWindowLaunch}
    />,
  );

  setTimeout(() => {
    void (async () => {
      await testSetup.renderOnce();
      await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
      await NodeFSP.writeFile(outputPath, testSetup.captureCharFrame(), "utf8");
      root.unmount();
      testSetup.renderer.destroy();
      connection.dispose();
      process.stdout.write(`Headless frame written to ${outputPath}\n`);
      process.exit(0);
    })();
  }, timeoutMs);
} else {
  let shuttingDown = false;
  /** What the shell runs on a quit signal; re-rendering the root to deliver it would remount it. */
  let signalQuit: (() => void) | null = null;
  const onSignalQuit = (quit: () => void) => {
    signalQuit = quit;
    return () => {
      if (signalQuit === quit) signalQuit = null;
    };
  };
  const tracksSystemThemeMode = shouldTrackSystemThemeMode(appTheme);
  const usesTerminalPalette = shouldResolveTerminalPalette(tuiThemeId);
  const shouldDeferInitialBackground = tracksSystemThemeMode || usesTerminalPalette;
  const initialTheme = resolveTuiTheme(appTheme, tuiThemeId);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // tr3x quits on these itself, after handing off unsent messages; the rest stay OpenTUI's.
    exitSignals: ["SIGQUIT", "SIGABRT", "SIGBREAK", "SIGPIPE", "SIGBUS"],
    screenMode: shouldUseAlternateScreen() ? "alternate-screen" : "main-screen",
    useMouse: shouldUseMouse(),
    enableMouseMovement: shouldEnableMouseMovement(),
    useKittyKeyboard: shouldUseKittyKeyboard() ? { events: true } : null,
    ...(!shouldDeferInitialBackground ? { backgroundColor: initialTheme.palette.canvas } : {}),
  });
  const initialRendererThemeMode = normalizeRendererThemeMode(renderer.themeMode);
  const detectedTerminalPalette = usesTerminalPalette
    ? await resolveTerminalPalette(renderer, { clearCache: true })
    : { colors: null, durationMs: 0 };
  const initialSystemThemeMode =
    resolveTerminalThemeMode(detectedTerminalPalette.colors) ?? initialRendererThemeMode;
  const rendererTheme = resolveTuiTheme(appTheme, tuiThemeId, {
    systemMode: initialSystemThemeMode,
    terminalColors: detectedTerminalPalette.colors,
  });
  renderer.setBackgroundColor?.(rendererTheme.palette.canvas);
  const root = createRoot(renderer);

  const shutdown = (code = 0, error?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      root.unmount();
    } catch {}
    try {
      renderer.destroy();
    } catch {}
    try {
      connection.dispose();
    } catch {}
    if (error) {
      process.stderr.write(
        `tr3x shutdown after error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = code || 1;
    } else {
      process.exitCode = code;
    }
    // Give the last prefs write a moment to land, but never hang on exit.
    const exit = () => process.exit(process.exitCode ?? code);
    setTimeout(exit, 500).unref();
    void (prefsWriter?.flush() ?? Promise.resolve()).then(() => setTimeout(exit, 50).unref());
  };

  const renderApp = () => {
    root.render(
      <App
        renderer={renderer}
        connection={connection}
        paths={paths}
        logger={logger}
        theme={rendererTheme}
        initialPrefs={prefs}
        prefsWriter={prefsWriter}
        prefsLockedOut={prefsLockedOut}
        cwd={launchCwd}
        onSignalQuit={onSignalQuit}
        onRequestExit={() => shutdown(0)}
        threadWindowLaunch={threadWindowLaunch}
      />,
    );
  };

  // A signal quits like `q`: the shell saves unsent messages, then exits. The timer covers
  // a shell that never gets to it.
  const quitOnSignal = () => {
    setTimeout(() => shutdown(0), 2_000).unref();
    if (signalQuit === null) shutdown(0);
    else signalQuit();
  };
  const signalHandlers = [
    ["SIGINT", quitOnSignal],
    ["SIGTERM", quitOnSignal],
    ["SIGHUP", quitOnSignal],
    ["uncaughtException", (error: unknown) => shutdown(1, error)],
    ["unhandledRejection", (error: unknown) => shutdown(1, error)],
  ] as const;

  for (const [event, handler] of signalHandlers) {
    process.on(event, handler);
  }

  renderer.once("destroy", () => {
    for (const [event, handler] of signalHandlers) {
      process.off(event, handler);
    }
  });

  renderApp();
}
