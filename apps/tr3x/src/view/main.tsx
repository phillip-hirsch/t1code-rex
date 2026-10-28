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
import { issueLocalSession, type IssuedSession } from "../daemon/localSession.ts";
import type { Tr3xPaths } from "../paths.ts";
import { App } from "./App.tsx";
import { createViewConnection, type ViewConnection } from "./connection.ts";
import type { ViewServer } from "./platform.ts";
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
  let session: Promise<IssuedSession> | null = null;
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    httpBaseUrl: daemon.httpBaseUrl,
    wsBaseUrl: daemon.wsBaseUrl,
    bearerToken: async () => {
      const current = await session?.catch(() => null);
      if (!current || Date.parse(current.expiresAt) - Date.now() < SESSION_REFRESH_MS) {
        session = issueLocalSession({
          baseDir: paths.home,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          ttl: SESSION_TTL,
          label: "tr3x view",
          env,
        });
      }
      return (await session!).token;
    },
  };
}

/** The project rooted at `cwd`, created when the server has none. */
async function resolveProject(connection: ViewConnection, cwd: string): Promise<ProjectId> {
  const root = NodeFS.realpathSync(cwd);
  const snapshot = await connection.shellSnapshot();
  const existing = snapshot.projects.find((project) => project.workspaceRoot === root);
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

export interface MountedView {
  readonly connection: ViewConnection;
  readonly threadId: ThreadId;
  readonly dispose: () => void;
}

/** Renders the view into `renderer`. The CLI and the scripted check share this. */
export async function mountView(input: {
  readonly renderer: CliRenderer;
  readonly server: ViewServer;
  readonly target: ViewTarget;
  readonly onStatus?: (status: RexStatus) => void;
  readonly onQuit: () => void;
}): Promise<MountedView> {
  const connection = createViewConnection(input.server);
  const { renderer, target } = input;
  const newThread =
    target.kind === "new" ? { projectId: await resolveProject(connection, target.cwd) } : null;
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
  const root = createRoot(renderer);
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
    connection,
    threadId,
    dispose: () => {
      root.unmount();
      connection.dispose();
    },
  };
}

/** `tr3x view`: runs until the user quits. */
export async function runView(input: {
  readonly paths: Tr3xPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly target: ViewTarget;
}): Promise<number> {
  const server = await resolveViewServer(input.paths, input.env);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    autoFocus: false,
  });
  let quit: () => void = () => {};
  const quitting = new Promise<void>((resolve) => (quit = resolve));
  let view: MountedView;
  try {
    view = await mountView({ renderer, server, target: input.target, onQuit: () => quit() });
  } catch (error) {
    renderer.destroy();
    await renderer.closed;
    throw error;
  }
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.once(signal, () => quit());
  await quitting;
  // Records belong to the terminal; leave none behind for a view that's gone.
  renderer.setProgramStatus({ state: "clear" });
  view.dispose();
  renderer.destroy();
  await renderer.closed;
  return 0;
}
