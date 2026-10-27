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
 * stays put; "all" is the whole thread up to its latest checkpoint.
 */
export type DiffScope =
  | { readonly kind: "latest" }
  | { readonly kind: "turn"; readonly turnCount: number }
  | { readonly kind: "all" };

export const LATEST_DIFF_SCOPE: DiffScope = { kind: "latest" };

export const NO_DIFF_TURNS: ReadonlyArray<DiffTurn> = [];

/** Mirrors the server's checks in CheckpointDiffQuery, so the panel never asks for a range it rejects. */
export function deriveDiffTurns(projection: {
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationV2Checkpoint, "appRunOrdinal" | "runId" | "status" | "files">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
}): ReadonlyArray<DiffTurn> {
  const completed = new Set(
    projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
  );
  const byTurn = new Map<number, DiffTurn>();
  for (const checkpoint of projection.checkpoints) {
    const turnCount = checkpoint.appRunOrdinal;
    const runId = checkpoint.runId;
    if (turnCount === null || runId === null) continue;
    if (checkpoint.status !== "ready" || !completed.has(runId)) continue;
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
  if (byTurn.size === 0) return NO_DIFF_TURNS;
  return [...byTurn.values()].toSorted((left, right) => left.turnCount - right.turnCount);
}

export interface DiffRange {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}

/** The turn a scope shows, or null for "all" and for a turn that isn't diffable (yet). */
export function scopeTurn(scope: DiffScope, turns: ReadonlyArray<DiffTurn>): DiffTurn | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "latest") return turns.at(-1) ?? null;
  return turns.find((turn) => turn.turnCount === scope.turnCount) ?? null;
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

/** The scope for a run's turn, e.g. from its changed-files row; latest when it's the newest. */
export function scopeForRun(runId: string, turns: ReadonlyArray<DiffTurn>): DiffScope {
  const turn = turns.find((entry) => entry.runId === runId);
  if (turn === undefined || turn === turns.at(-1)) return LATEST_DIFF_SCOPE;
  return { kind: "turn", turnCount: turn.turnCount };
}

/** One turn earlier or later; stepping past the newest turn lands on "latest" again. */
export function stepDiffScope(
  scope: DiffScope,
  turns: ReadonlyArray<DiffTurn>,
  delta: -1 | 1,
): DiffScope {
  if (turns.length === 0) return scope;
  const turn = scope.kind === "all" ? null : scopeTurn(scope, turns);
  const current = turn === null ? turns.length - 1 : turns.indexOf(turn);
  const next = Math.max(0, Math.min(turns.length - 1, current + delta));
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
  if (turn === null) return scope.kind === "turn" ? `Turn ${scope.turnCount}` : "Latest turn";
  const index = turns.indexOf(turn) + 1;
  if (compact) return `Turn ${index}/${turns.length}`;
  const position = `Turn ${index} of ${turns.length}`;
  return scope.kind === "latest" ? `${position} (latest)` : position;
}
