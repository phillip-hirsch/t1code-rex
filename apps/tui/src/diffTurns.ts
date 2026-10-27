import type { OrchestrationV2Checkpoint, OrchestrationV2Run } from "@t3tools/contracts";

/** A turn whose changes the server can diff: a ready checkpoint of a completed run. */
export interface DiffTurn {
  readonly turnCount: number;
  readonly runId: string;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * What the panel shows. "latest" follows each new checkpoint as runs finish; a picked turn
 * stays put; "all" is the whole thread up to its latest checkpoint. "run" is one run's turn,
 * opened from its changed-files row: it shows that run's diff once it has one, never another's.
 */
export type DiffScope =
  | { readonly kind: "latest" }
  | { readonly kind: "turn"; readonly turnCount: number }
  | { readonly kind: "run"; readonly runId: string; readonly turnCount: number | null }
  | { readonly kind: "all" };

export const LATEST_DIFF_SCOPE: DiffScope = { kind: "latest" };

/** A run with a checkpoint but no diff the server will give, and why. */
export interface UndiffableRun {
  readonly turnCount: number | null;
  readonly reason: string;
}

export interface DiffTurns {
  /** Diffable turns, oldest first. */
  readonly turns: ReadonlyArray<DiffTurn>;
  /** By run id. */
  readonly undiffable: ReadonlyMap<string, UndiffableRun>;
}

export const NO_DIFF_TURNS: DiffTurns = { turns: [], undiffable: new Map() };

const RUN_STATUS_REASON: Partial<Record<OrchestrationV2Run["status"], string>> = {
  interrupted: "it was interrupted, and only completed runs have diffs",
  cancelled: "it was cancelled, and only completed runs have diffs",
  failed: "it failed, and only completed runs have diffs",
  rolled_back: "it was rolled back",
};

function undiffableReason(
  checkpointStatus: OrchestrationV2Checkpoint["status"],
  runStatus: OrchestrationV2Run["status"] | undefined,
): string {
  if (runStatus === undefined) return "its run isn't loaded";
  const byRun = RUN_STATUS_REASON[runStatus];
  if (byRun !== undefined) return byRun;
  if (runStatus !== "completed") return "it hasn't finished yet";
  return `its checkpoint is ${checkpointStatus}`;
}

/** Mirrors the server's checks in CheckpointDiffQuery, so the panel never asks for a range it rejects. */
export function deriveDiffTurns(projection: {
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationV2Checkpoint, "appRunOrdinal" | "runId" | "status" | "files">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
}): DiffTurns {
  const runStatus = new Map<string, OrchestrationV2Run["status"]>(
    projection.runs.map((run) => [run.id, run.status]),
  );
  const byTurn = new Map<number, DiffTurn>();
  const undiffable = new Map<string, UndiffableRun>();
  for (const checkpoint of projection.checkpoints) {
    const turnCount = checkpoint.appRunOrdinal;
    const runId = checkpoint.runId;
    if (runId === null) continue;
    const status = runStatus.get(runId);
    if (turnCount === null || checkpoint.status !== "ready" || status !== "completed") {
      undiffable.set(runId, {
        turnCount,
        reason:
          turnCount === null
            ? "its checkpoint has no turn"
            : undiffableReason(checkpoint.status, status),
      });
      continue;
    }
    let additions = 0;
    let deletions = 0;
    for (const file of checkpoint.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    byTurn.set(turnCount, {
      turnCount,
      runId,
      fileCount: checkpoint.files.length,
      additions,
      deletions,
    });
  }
  if (byTurn.size === 0 && undiffable.size === 0) return NO_DIFF_TURNS;
  return {
    turns: [...byTurn.values()].toSorted((left, right) => left.turnCount - right.turnCount),
    undiffable,
  };
}

export interface DiffRange {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}

/** The turn a scope shows, or null for "all" and for a turn or run that isn't diffable (yet). */
export function scopeTurn(scope: DiffScope, turns: ReadonlyArray<DiffTurn>): DiffTurn | null {
  switch (scope.kind) {
    case "all":
      return null;
    case "latest":
      return turns.at(-1) ?? null;
    case "turn":
      return turns.find((turn) => turn.turnCount === scope.turnCount) ?? null;
    case "run":
      return turns.find((turn) => turn.runId === scope.runId) ?? null;
  }
}

export function resolveDiffRange(
  scope: DiffScope,
  turns: ReadonlyArray<DiffTurn>,
): DiffRange | null {
  const latest = turns.at(-1);
  if (latest === undefined) return null;
  if (scope.kind === "all") return { fromTurnCount: 0, toTurnCount: latest.turnCount };
  const turn = scopeTurn(scope, turns);
  return turn === null ? null : { fromTurnCount: turn.turnCount - 1, toTurnCount: turn.turnCount };
}

/**
 * The scope for a run's turn, e.g. from its changed-files row; latest when it's the newest.
 * A run with no diff keeps its own scope, so the panel says so instead of showing another run.
 */
export function scopeForRun(runId: string, diffTurns: DiffTurns): DiffScope {
  const { turns } = diffTurns;
  const turn = turns.find((entry) => entry.runId === runId);
  if (turn === undefined) {
    return { kind: "run", runId, turnCount: diffTurns.undiffable.get(runId)?.turnCount ?? null };
  }
  if (turn === turns.at(-1)) return LATEST_DIFF_SCOPE;
  return { kind: "turn", turnCount: turn.turnCount };
}

/** Why a "run" scope shows nothing, or null when it has a diff. */
export function undiffableRunMessage(scope: DiffScope, diffTurns: DiffTurns): string | null {
  if (scope.kind !== "run" || scopeTurn(scope, diffTurns.turns) !== null) return null;
  const reason = diffTurns.undiffable.get(scope.runId)?.reason;
  return reason === undefined ? "No diff for this run." : `No diff for this run: ${reason}.`;
}

/** One turn earlier or later; stepping past the newest turn lands on "latest" again. */
export function stepDiffScope(
  scope: DiffScope,
  turns: ReadonlyArray<DiffTurn>,
  delta: -1 | 1,
): DiffScope {
  if (turns.length === 0) return scope;
  const turn = scope.kind === "all" ? null : scopeTurn(scope, turns);
  let next: number;
  if (turn === null && scope.kind === "run" && scope.turnCount !== null) {
    // From a run without a diff, to the nearest diffable turn on that side.
    const anchor = scope.turnCount;
    next =
      delta < 0
        ? turns.findLastIndex((entry) => entry.turnCount < anchor)
        : turns.findIndex((entry) => entry.turnCount > anchor);
    if (next === -1) return scope;
  } else {
    const current = turn === null ? turns.length - 1 : turns.indexOf(turn);
    next = Math.max(0, Math.min(turns.length - 1, current + delta));
  }
  if (next === turns.length - 1) return LATEST_DIFF_SCOPE;
  const target = turns[next];
  return target === undefined ? scope : { kind: "turn", turnCount: target.turnCount };
}

/** "Turn 2 of 3 (latest)", or "Turn 2/3" when `compact`. */
export function describeDiffScope(
  scope: DiffScope,
  turns: ReadonlyArray<DiffTurn>,
  compact = false,
): string {
  if (scope.kind === "all") return "All turns";
  const turn = scopeTurn(scope, turns);
  if (turn === null) {
    if (scope.kind === "turn") return `Turn ${scope.turnCount}`;
    return scope.kind === "run" ? "This run" : "Latest turn";
  }
  const index = turns.indexOf(turn) + 1;
  if (compact) return `Turn ${index}/${turns.length}`;
  const position = `Turn ${index} of ${turns.length}`;
  return scope.kind === "latest" ? `${position} (latest)` : position;
}
