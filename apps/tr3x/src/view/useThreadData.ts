import { useAtomValue } from "@effect/atom-react";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import type { ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import type { ViewConnection } from "./connection.ts";

type ThreadAtoms = ReturnType<ViewConnection["thread"]>;

// A thread that isn't launched yet has nothing to subscribe to.
const IDLE: ThreadAtoms = {
  stateAtom: Atom.make(EMPTY_ENVIRONMENT_THREAD_STATE),
  structureAtom: Atom.make(null),
  visibleTurnItemsAtom: Atom.make([]),
  pendingRequestsAtom: Atom.make(null),
  queueAtom: Atom.make(null),
};

/** The thread's live state from `orchestration.subscribeThread`, while `enabled`. */
export function useThreadData(connection: ViewConnection, threadId: ThreadId, enabled: boolean) {
  const atoms = useMemo(
    () => (enabled ? connection.thread(threadId) : IDLE),
    [connection, threadId, enabled],
  );
  const state = useAtomValue(atoms.stateAtom);
  const structure = useAtomValue(atoms.structureAtom);
  return {
    status: state.status,
    history: state.history,
    structure: structure?.projection ?? null,
    items: useAtomValue(atoms.visibleTurnItemsAtom),
    requests: useAtomValue(atoms.pendingRequestsAtom),
    queue: useAtomValue(atoms.queueAtom),
  };
}
