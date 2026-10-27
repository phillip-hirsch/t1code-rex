import type {
  EnvironmentThreadState,
  ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { describeSendFailure } from "../composerSend.ts";
import type { WorkspaceBlock, WorkspaceGuard } from "../composerSender.ts";
import {
  confirmedWorktreeBlock,
  worktreeBlockOf,
  type ServerLaunchView,
} from "../worktreeLaunch.ts";

export interface WorkspaceGuardOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  /** The thread's live state; kept mounted until the guard is disposed. */
  readonly stateAtom: Atom.Atom<EnvironmentThreadState>;
  /** The thread as the server has it now, over HTTP; "unavailable" is tried again later. */
  readonly loadSnapshot: () => Promise<ThreadSnapshotLoadResult>;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
}

/** The waits between snapshot attempts; once all are spent, the guard gives up. */
export const SNAPSHOT_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

export const checkFailedNotice = (reason: string) =>
  `Couldn't check the thread's worktree: ${reason}. Send again to retry`;

type Loaded = Exclude<ThreadSnapshotLoadResult, { readonly _tag: "unavailable" }>;

/**
 * Watches a thread for the composer sender. A warm remount shows old state as live before
 * its replay, so live state counts once it agrees with the server's snapshot, is newer, or
 * has synchronized since watching started; until then an ask waits, or gets a reason.
 */
export function createWorkspaceGuard(options: WorkspaceGuardOptions): WorkspaceGuard {
  const { registry, stateAtom } = options;
  let disposed = false;
  let server: ServerLaunchView | undefined;
  /** Why the snapshot couldn't be loaded, once every attempt failed. */
  let failure: string | undefined;
  /**
   * A replay ran since watching started: the server marks the thread as synchronizing until
   * it has caught up, so live after that is the server's state.
   */
  let replayed = false;
  let attempts = 0;
  let cancelRetry = () => {};
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const check of waiters) check();
  };

  const unsubscribe = registry.subscribe(
    stateAtom,
    (state) => {
      if (state.status === "synchronizing") replayed = true;
      changed();
    },
    { immediate: true },
  );

  const load = () => {
    attempts += 1;
    options.loadSnapshot().then(
      (result) => settle(result._tag === "unavailable" ? "the server didn't send it" : result),
      (error: unknown) => settle(describeSendFailure(error)),
    );
  };
  const settle = (result: Loaded | string) => {
    if (disposed) return;
    if (typeof result === "string") {
      const delay = SNAPSHOT_RETRY_MS[attempts - 1];
      if (delay !== undefined) {
        cancelRetry = options.schedule(load, delay);
        return;
      }
      failure = checkFailedNotice(result);
    } else {
      server =
        result._tag === "missing"
          ? result
          : { _tag: "present", projection: result.snapshot.projection };
    }
    changed();
  };
  load();

  /** The answer now, or `waiting` while one is on its way. */
  const decide = (): { readonly value: WorkspaceBlock; readonly waiting: boolean } => {
    if (disposed) return { value: undefined, waiting: false };
    const live = registry.get(stateAtom);
    if (replayed && live.status === "live" && Option.isSome(live.data)) {
      return { value: worktreeBlockOf(live.data.value), waiting: false };
    }
    const value = confirmedWorktreeBlock(live, server);
    if (value !== undefined) return { value, waiting: false };
    // Offline: the sender waits for the connection, and its replay settles it.
    if (live.status !== "live" && live.status !== "synchronizing") {
      return { value: undefined, waiting: false };
    }
    // Live, and the snapshot to compare it with never came: a replay may never show.
    if (live.status === "live" && server === undefined && failure !== undefined) {
      return { value: failure, waiting: false };
    }
    return { value: undefined, waiting: true };
  };

  return {
    blockedReason: () => {
      const now = decide();
      if (!now.waiting) return now.value;
      return new Promise<WorkspaceBlock>((resolve) => {
        const check = () => {
          const next = decide();
          if (next.waiting) return;
          waiters.delete(check);
          resolve(next.value);
        };
        waiters.add(check);
      });
    },
    dispose: () => {
      disposed = true;
      cancelRetry();
      changed();
      unsubscribe();
    },
  };
}
