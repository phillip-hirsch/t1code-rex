import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveDiffTurns,
  describeDiffScope,
  LATEST_DIFF_SCOPE,
  resolveDiffRange,
  scopeForRun,
  stepDiffScope,
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
    expect(turns).toEqual([
      { turnCount: 1, runId: "r1", fileCount: 2, additions: 5, deletions: 1 },
      { turnCount: 3, runId: "r3", fileCount: 2, additions: 5, deletions: 1 },
    ]);
  });
});

describe("diff scopes", () => {
  const turns = deriveDiffTurns({
    checkpoints: [checkpoint(1, "r1"), checkpoint(3, "r3"), checkpoint(4, "r4")],
    runs,
  });

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
    });
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
    expect(scopeForRun("r1", turns)).toEqual({ kind: "turn", turnCount: 1 });
    expect(scopeForRun("r4", turns)).toBe(LATEST_DIFF_SCOPE);
    expect(scopeForRun("unknown", turns)).toBe(LATEST_DIFF_SCOPE);
  });

  it("labels turns by position", () => {
    expect(describeDiffScope(LATEST_DIFF_SCOPE, turns)).toBe("Turn 3 of 3 (latest)");
    expect(describeDiffScope({ kind: "turn", turnCount: 3 }, turns)).toBe("Turn 2 of 3");
    expect(describeDiffScope({ kind: "all" }, turns)).toBe("All turns");
    expect(describeDiffScope(LATEST_DIFF_SCOPE, [])).toBe("Latest turn");
    expect(describeDiffScope(LATEST_DIFF_SCOPE, turns, true)).toBe("Turn 3/3");
  });
});
