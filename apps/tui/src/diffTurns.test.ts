import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveDiffTurns,
  describeDiffScope,
  LATEST_DIFF_SCOPE,
  resolveDiffRange,
  scopeForRun,
  stepDiffScope,
  undiffableRunMessage,
  type DiffScope,
} from "./diffTurns.ts";

const file = (additions: number, deletions: number) => ({
  path: "a.ts",
  kind: "modified",
  additions,
  deletions,
});

function checkpoint(
  turnCount: number | null,
  runId: string | null,
  status: "ready" | "missing" | "error" | "stale" = "ready",
) {
  return {
    appRunOrdinal: turnCount,
    runId: runId === null ? null : RunId.make(runId),
    status,
    files: [file(2, 1), file(3, 0)],
  };
}

const runs = [
  { id: RunId.make("r1"), status: "completed" as const },
  { id: RunId.make("r2"), status: "interrupted" as const },
  { id: RunId.make("r3"), status: "completed" as const },
  { id: RunId.make("r4"), status: "completed" as const },
];

describe("deriveDiffTurns", () => {
  it("keeps ready checkpoints of completed runs, in turn order, as the server requires", () => {
    const turns = deriveDiffTurns({
      checkpoints: [
        checkpoint(3, "r3"),
        checkpoint(1, "r1"),
        checkpoint(2, "r2"),
        checkpoint(4, "r4", "missing"),
        checkpoint(null, "r1"),
      ],
      runs,
    });
    expect(turns.turns).toEqual([
      { turnCount: 1, runId: "r1", fileCount: 2, additions: 5, deletions: 1 },
      { turnCount: 3, runId: "r3", fileCount: 2, additions: 5, deletions: 1 },
    ]);
    expect(Object.fromEntries(turns.undiffable)).toEqual({
      r1: { turnCount: null, reason: "its checkpoint has no turn" },
      r2: { turnCount: 2, reason: "it was interrupted, and only completed runs have diffs" },
      r4: { turnCount: 4, reason: "its checkpoint is missing" },
    });
  });
});

describe("diff scopes", () => {
  const diffTurns = deriveDiffTurns({
    checkpoints: [
      checkpoint(1, "r1"),
      checkpoint(2, "r2"),
      checkpoint(3, "r3"),
      checkpoint(4, "r4"),
    ],
    runs,
  });
  const turns = diffTurns.turns;

  it("asks for a turn's own range, or the whole thread up to the latest", () => {
    expect(resolveDiffRange(LATEST_DIFF_SCOPE, turns)).toEqual({
      fromTurnCount: 3,
      toTurnCount: 4,
    });
    expect(resolveDiffRange({ kind: "turn", turnCount: 1 }, turns)).toEqual({
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(resolveDiffRange({ kind: "all" }, turns)).toEqual({ fromTurnCount: 0, toTurnCount: 4 });
    expect(resolveDiffRange({ kind: "turn", turnCount: 2 }, turns)).toBeNull();
    expect(resolveDiffRange(LATEST_DIFF_SCOPE, [])).toBeNull();
  });

  it("follows new checkpoints while on the latest turn, and stays on a picked one", () => {
    const picked: DiffScope = { kind: "turn", turnCount: 3 };
    const later = deriveDiffTurns({
      checkpoints: [checkpoint(1, "r1"), checkpoint(3, "r3"), checkpoint(4, "r4")],
      runs,
    }).turns;
    const earlier = later.slice(0, 2);
    expect(resolveDiffRange(LATEST_DIFF_SCOPE, earlier)?.toTurnCount).toBe(3);
    expect(resolveDiffRange(LATEST_DIFF_SCOPE, later)?.toTurnCount).toBe(4);
    expect(resolveDiffRange(picked, later)?.toTurnCount).toBe(3);
  });

  it("steps between turns and lands on latest at the newest end", () => {
    expect(stepDiffScope(LATEST_DIFF_SCOPE, turns, -1)).toEqual({ kind: "turn", turnCount: 3 });
    expect(stepDiffScope({ kind: "turn", turnCount: 1 }, turns, -1)).toEqual({
      kind: "turn",
      turnCount: 1,
    });
    expect(stepDiffScope({ kind: "turn", turnCount: 3 }, turns, 1)).toBe(LATEST_DIFF_SCOPE);
    expect(stepDiffScope({ kind: "all" }, turns, -1)).toEqual({ kind: "turn", turnCount: 3 });
  });

  it("opens a run's own turn from its changed-files row", () => {
    expect(scopeForRun("r1", diffTurns)).toEqual({ kind: "turn", turnCount: 1 });
    expect(scopeForRun("r4", diffTurns)).toBe(LATEST_DIFF_SCOPE);
  });

  it("keeps an interrupted run's own scope instead of falling back to another run", () => {
    const interrupted = scopeForRun("r2", diffTurns);
    expect(interrupted).toEqual({ kind: "run", runId: "r2", turnCount: 2 });
    expect(resolveDiffRange(interrupted, turns)).toBeNull();
    expect(describeDiffScope(interrupted, turns)).toBe("This run");
    expect(undiffableRunMessage(interrupted, diffTurns)).toBe(
      "No diff for this run: it was interrupted, and only completed runs have diffs.",
    );
    const unknown = scopeForRun("unknown", diffTurns);
    expect(resolveDiffRange(unknown, turns)).toBeNull();
    expect(undiffableRunMessage(unknown, diffTurns)).toBe("No diff for this run.");
    // Steps go to the nearest diffable turn on that side.
    expect(stepDiffScope(interrupted, turns, -1)).toEqual({ kind: "turn", turnCount: 1 });
    expect(stepDiffScope(interrupted, turns, 1)).toEqual({ kind: "turn", turnCount: 3 });
  });

  it("shows a run's diff once it has one", () => {
    const scope: DiffScope = { kind: "run", runId: "r2", turnCount: 2 };
    const finished = deriveDiffTurns({
      checkpoints: [checkpoint(1, "r1"), checkpoint(2, "r2")],
      runs: runs.map((run) => (run.id === "r2" ? { ...run, status: "completed" as const } : run)),
    });
    expect(resolveDiffRange(scope, finished.turns)).toEqual({ fromTurnCount: 1, toTurnCount: 2 });
    expect(undiffableRunMessage(scope, finished)).toBeNull();
    expect(describeDiffScope(scope, finished.turns)).toBe("Turn 2 of 2");
  });

  it("labels turns by position", () => {
    expect(describeDiffScope(LATEST_DIFF_SCOPE, turns)).toBe("Turn 3 of 3 (latest)");
    expect(describeDiffScope({ kind: "turn", turnCount: 3 }, turns)).toBe("Turn 2 of 3");
    expect(describeDiffScope({ kind: "all" }, turns)).toBe("All turns");
    expect(describeDiffScope(LATEST_DIFF_SCOPE, [])).toBe("Latest turn");
    expect(describeDiffScope(LATEST_DIFF_SCOPE, turns, true)).toBe("Turn 3/3");
  });
});
