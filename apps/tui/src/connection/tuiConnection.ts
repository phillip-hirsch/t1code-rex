import { Connection } from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  ShellSnapshotLoader,
  createEnvironmentShellAtoms,
} from "@t3tools/client-runtime/state/shell";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { TuiServerSession } from "../serverLauncher.ts";
import * as Platform from "./platform.ts";
import * as Runtime from "./runtime.ts";

export interface TuiConnectionOptions {
  readonly session: TuiServerSession;
  readonly appVersion: string;
  readonly platformOs: string;
}

const NO_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = [];

/**
 * One atom runtime per process, wired to the single server this TUI reached.
 * Later port steps add thread, terminal and VCS atoms on the same runtime.
 */
export function createTuiConnection(options: TuiConnectionOptions) {
  const layerPlatform = Platform.layer(options);
  const layerConnection = ShellSnapshotLoader.layer.pipe(
    Layer.provideMerge(Connection.layerWithOptions({})),
    Layer.provideMerge(Layer.mergeAll(Runtime.layer, layerPlatform)),
  );
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(layerConnection);
  const environmentId: EnvironmentId = options.session.environment.environmentId;
  const catalog = createEnvironmentCatalogAtoms(runtime);
  const sessionAtoms = createEnvironmentSessionAtoms(runtime);
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: sessionAtoms.initialConfigValueAtom,
  });
  const shell = createEnvironmentShellAtoms(runtime);
  const snapshotAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(get(shell.stateValueAtom(id)).snapshot)),
  );
  const threadShells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog.catalogValueAtom,
    snapshotAtom,
  });
  const serverConfigsAtom = createEnvironmentServerConfigsAtom({
    catalogValueAtom: catalog.catalogValueAtom,
    serverConfigValueAtom: server.configValueAtom,
  });

  return {
    session: options.session,
    environmentId,
    registry,
    runtime,
    connectionStateAtom: catalog.stateAtom(environmentId),
    serverConfigAtom: server.configValueAtom(environmentId),
    serverConfigsAtom,
    shellStateAtom: shell.stateValueAtom(environmentId),
    shellStatusAtom: shell.statusAtom(environmentId),
    hasShellSnapshotAtom: shell.hasSnapshotAtom(environmentId),
    // Thread events keep the projects array, so the sidebar's project list only changes
    // with project events.
    projectsAtom: Atom.make(
      (get): ReadonlyArray<OrchestrationProjectShell> =>
        get(snapshotAtom(environmentId))?.projects ?? NO_PROJECTS,
    ),
    // Shells that leave out older settled threads count them per project.
    olderSettledAtom: Atom.make(
      (get): OrchestrationV2ShellSnapshot["olderSettled"] =>
        get(snapshotAtom(environmentId))?.olderSettled,
    ),
    // Rows keep their identity while only a running thread's streaming fields tick.
    threadShellsAtom: threadShells.quietThreadShellsAtom,
    threadShellAtom: (threadId: ThreadId) =>
      threadShells.quietThreadShellAtom({ environmentId, threadId }),
    retryNow: catalog.retryNow,
    dispose: () => {
      registry.dispose();
      options.session.stop();
    },
  };
}

export type TuiConnection = ReturnType<typeof createTuiConnection>;
