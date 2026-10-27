import type {
  EnvironmentThreadState,
  ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { WorkspaceBlock, WorkspaceGuard } from "../composerSender.ts";
import { confirmedWorktreeBlock, type ServerLaunchView } from "../worktreeLaunch.ts";

export interface WorkspaceGuardOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  /** The thread's live state; kept mounted until the guard is disposed. */
  readonly stateAtom: Atom.Atom<EnvironmentThreadState>;
  /** The thread as the server has it now, over HTTP; "unavailable" decides nothing. */
  readonly loadSnapshot: () => Promise<ThreadSnapshotLoadResult>;
}

/**
 * Watches a thread for the composer sender. A warm remount shows the last state as live
 * before its replay, so the guard reads the server's snapshot first and trusts the live
 * state once it agrees or has moved past it. While the replay is on its way, an ask waits.
 */
export function createWorkspaceGuard(options: WorkspaceGuardOptions): WorkspaceGuard {
  const { registry, stateAtom } = options;
  const unmount = registry.mount(stateAtom);
  let disposed = false;
  let server: ServerLaunchView | undefined;
  let loading: Promise<void> | null = null;
  const waiters = new Set<() => void>();

  const load = () =>
    (loading ??= options
      .loadSnapshot()
      .then(
        (result) => {
          if (result._tag === "missing") server = result;
          if (result._tag === "present") {
            server = { _tag: "present", projection: result.snapshot.projection };
          }
        },
        () => undefined,
      )
      .finally(() => {
        loading = null;
      }));

  const read = () => confirmedWorktreeBlock(registry.get(stateAtom), server);
  /** Connected, but not caught up with the snapshot yet: its replay is on its way. */
  const catchingUp = () => {
    const { status } = registry.get(stateAtom);
    return server !== undefined && (status === "live" || status === "synchronizing");
  };

  /** Resolves at the first state change that decides it, or makes it unknowable for now. */
  const waitForReplay = () =>
    new Promise<WorkspaceBlock>((resolve) => {
      const finish = (value: WorkspaceBlock) => {
        unsubscribe();
        waiters.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const unsubscribe = registry.subscribe(stateAtom, () => {
        const value = read();
        if (value !== undefined || !catchingUp()) finish(value);
      });
      waiters.add(cancel);
    });

  return {
    blockedReason: () => {
      const answer = (): WorkspaceBlock | Promise<WorkspaceBlock> => {
        if (disposed) return undefined;
        const value = read();
        return value === undefined && catchingUp() ? waitForReplay() : value;
      };
      return server === undefined ? load().then(answer) : answer();
    },
    dispose: () => {
      disposed = true;
      for (const cancel of waiters) cancel();
      unmount();
    },
  };
}
