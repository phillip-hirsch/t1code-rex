import { Connection } from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  ShellSnapshotLoader,
  createEnvironmentShellAtoms,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { TuiServerSession } from "../serverLauncher.ts";
import * as Platform from "./platform.ts";
import * as Runtime from "./runtime.ts";

export interface TuiConnectionOptions {
  readonly session: TuiServerSession;
  readonly appVersion: string;
  readonly platformOs: string;
}

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
    retryNow: catalog.retryNow,
    dispose: () => {
      registry.dispose();
      options.session.stop();
    },
  };
}

export type TuiConnection = ReturnType<typeof createTuiConnection>;
