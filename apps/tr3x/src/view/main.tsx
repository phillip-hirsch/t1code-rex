// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The view runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { readLiveDaemonState } from "../daemon/daemonState.ts";
import { fetchRecordedEnvironment } from "../daemon/health.ts";
import { issueLocalSession } from "../daemon/localSession.ts";
import type { Tr3xPaths } from "../paths.ts";
import { describeError } from "../redact.ts";
import { App } from "./App.tsx";
import { createViewConnection, type ViewConnection } from "./connection.ts";
import type { ViewServer } from "./platform.ts";
import { sessionBearer } from "./sessionBearer.ts";
import { Startup } from "./Startup.tsx";
import type { RexStatus } from "./status.ts";

export type ViewTarget =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "new"; readonly cwd: string };

const SESSION_TTL = "1h";
/** Re-mint this long before expiry, so a reconnect never presents a dying bearer. */
const SESSION_REFRESH_MS = 5 * 60_000;

/**
 * The daemon's server, with a bearer minted on demand. The bearer is scoped to
 * reading and operating threads and lives an hour; client-runtime asks for it
 * again on every reconnect, so a fresh one is minted once it nears expiry.
 */
export async function resolveViewServer(
  paths: Tr3xPaths,
  env: NodeJS.ProcessEnv,
): Promise<ViewServer> {
  const daemon = readLiveDaemonState(paths.daemonStatePath);
  if (daemon === undefined) {
    throw new Error(`No tr3x daemon is running for ${paths.home}. Start it with \`tr3x daemon\`.`);
  }
  // Never send a credential to a server the daemon didn't record.
  const environment = await fetchRecordedEnvironment(daemon);
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    httpBaseUrl: daemon.httpBaseUrl,
    wsBaseUrl: daemon.wsBaseUrl,
    bearerToken: sessionBearer(
      () =>
        issueLocalSession({
          baseDir: paths.home,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          ttl: SESSION_TTL,
          label: "tr3x view",
          env,
        }),
      SESSION_REFRESH_MS,
    ),
  };
}

/** The project rooted at `cwd`, created when the server has none. */
async function resolveProject(
  connection: ViewConnection,
  cwd: string,
  signal: AbortSignal,
): Promise<ProjectId> {
  const root = NodeFS.realpathSync(cwd);
  // The server resolves a workspace root without following symlinks, so a
  // project made elsewhere under a symlinked path is found by that path too.
  const roots = new Set([NodePath.resolve(cwd), root]);
  const snapshot = await connection.shellSnapshot(signal);
  const existing = snapshot.projects.find((project) => roots.has(project.workspaceRoot));
  if (existing) return existing.id;
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const result = await connection.createProject({
    projectId,
    title: NodePath.basename(root) || root,
    workspaceRoot: root,
  });
  if (!result.ok) throw new Error(`Could not create a project for ${root}: ${result.error}`);
  return projectId;
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Stopped."));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface MountedView {
  readonly connection: ViewConnection;
  readonly threadId: ThreadId;
  readonly dispose: () => void;
}

/** How startup ended: the view is up, the user quit, or it can't start. */
export type ViewStart =
  | { readonly kind: "mounted"; readonly view: MountedView }
  | { readonly kind: "quit" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Renders the view into `renderer`; the CLI and the scripted checks share this.
 * A startup screen shows at once, and ctrl+c (`onQuit`) or `signal` ends it. It
 * signs in before anything waits on the server, so a session that can't be
 * minted fails startup instead of leaving it waiting.
 */
export async function mountView(input: {
  readonly renderer: CliRenderer;
  readonly server: ViewServer;
  readonly target: ViewTarget;
  readonly signal: AbortSignal;
  readonly onStatus?: (status: RexStatus) => void;
  readonly onQuit: () => void;
  /** Opens the connection; tests pass one that needs no server. */
  readonly connect?: (server: ViewServer) => ViewConnection;
}): Promise<ViewStart> {
  const { renderer, target, signal } = input;
  const root = createRoot(renderer);
  const startup = (message: string, connection: ViewConnection | null) =>
    root.render(
      connection === null ? (
        <Startup message={message} connection={null} onQuit={input.onQuit} />
      ) : (
        <RegistryContext.Provider value={connection.registry}>
          <Startup message={message} connection={connection} onQuit={input.onQuit} />
        </RegistryContext.Provider>
      ),
    );
  const stop = (connection: ViewConnection | null, outcome: ViewStart): ViewStart => {
    root.unmount();
    connection?.dispose();
    return outcome;
  };

  startup("Connecting to the tr3x server…", null);
  try {
    await untilAborted(input.server.bearerToken(), signal);
  } catch (error) {
    if (signal.aborted) return stop(null, { kind: "quit" });
    return stop(null, {
      kind: "failed",
      message: `Could not sign in to the tr3x server: ${describeError(error)}`,
    });
  }
  const connection = (input.connect ?? createViewConnection)(input.server);
  let newThread: { readonly projectId: ProjectId } | null = null;
  if (target.kind === "new") {
    startup("Loading projects…", connection);
    try {
      // Each step can stall on the server (the shell, then creating the project); quit wins.
      newThread = {
        projectId: await untilAborted(resolveProject(connection, target.cwd, signal), signal),
      };
    } catch (error) {
      if (signal.aborted) return stop(connection, { kind: "quit" });
      return stop(connection, { kind: "failed", message: describeError(error) });
    }
  }
  if (signal.aborted) return stop(connection, { kind: "quit" });
  const threadId =
    target.kind === "thread" ? target.threadId : ThreadId.make(NodeCrypto.randomUUID());
  const onStatus = (status: RexStatus) => {
    try {
      renderer.setProgramStatus(status);
      renderer.setTerminalTitle(status.title);
    } catch {
      // A report the terminal can't take must not take the view down.
    }
    input.onStatus?.(status);
  };
  root.render(
    <RegistryContext.Provider value={connection.registry}>
      <App
        connection={connection}
        threadId={threadId}
        newThread={newThread}
        onStatus={onStatus}
        onQuit={input.onQuit}
      />
    </RegistryContext.Provider>,
  );
  return {
    kind: "mounted",
    view: { connection, threadId, dispose: () => stop(connection, { kind: "quit" }) },
  };
}

/** `tr3x view`: runs until the user quits; 1 when it can't start. */
export async function runView(input: {
  readonly paths: Tr3xPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly target: ViewTarget;
}): Promise<number> {
  // Before anything waits: a signal ends the view at any point.
  const quit = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => quit.abort());
  }
  const server = await resolveViewServer(input.paths, input.env);
  if (quit.signal.aborted) return 0;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    autoFocus: false,
  });
  const start = await mountView({
    renderer,
    server,
    target: input.target,
    signal: quit.signal,
    onQuit: () => quit.abort(),
  });
  if (start.kind === "mounted") {
    if (!quit.signal.aborted) {
      await new Promise((resolve) =>
        quit.signal.addEventListener("abort", resolve, { once: true }),
      );
    }
    // Records belong to the terminal; leave none behind for a view that's gone.
    renderer.setProgramStatus({ state: "clear" });
    start.view.dispose();
  }
  renderer.destroy();
  await renderer.closed;
  if (start.kind !== "failed") return 0;
  process.stderr.write(`tr3x: ${start.message}\n`);
  return 1;
}
