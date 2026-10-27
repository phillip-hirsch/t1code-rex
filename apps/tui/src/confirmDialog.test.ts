import { describe, expect, it } from "vite-plus/test";

import {
  archiveThreadsConfirm,
  deleteThreadsConfirm,
  openConfirm,
  projectRemovalSteps,
  reduceConfirmKey,
  type ConfirmDialogState,
  type ConfirmOutcome,
} from "./confirmDialog.ts";

function next(outcome: ConfirmOutcome): ConfirmDialogState {
  if (outcome.type !== "state") throw new Error(`expected a state, got ${outcome.type}`);
  return outcome.state;
}

describe("confirm dialog keys", () => {
  it("starts a destructive step on Cancel, so a stray Enter cancels", () => {
    const dialog = openConfirm([deleteThreadsConfirm(["Fix the bug"])]);
    expect(dialog.focus).toBe("cancel");
    expect(reduceConfirmKey(dialog, { name: "return" })).toEqual({ type: "cancel" });
  });

  it("needs a deliberate move to the confirm button, then Enter", () => {
    const dialog = openConfirm([deleteThreadsConfirm(["Fix the bug"])]);
    const onDelete = next(reduceConfirmKey(dialog, { name: "right" }));
    expect(onDelete.focus).toBe("confirm");
    expect(reduceConfirmKey(onDelete, { name: "return" })).toEqual({ type: "confirm" });
    expect(next(reduceConfirmKey(onDelete, { name: "tab" })).focus).toBe("cancel");
  });

  it("ignores typing and held keys' repeats", () => {
    const onDelete = next(
      reduceConfirmKey(openConfirm([deleteThreadsConfirm(["x"])]), { name: "right" }),
    );
    for (const name of ["y", "d", "space", "1"]) {
      expect(reduceConfirmKey(onDelete, { name })).toEqual({ type: "ignore" });
    }
    expect(reduceConfirmKey(onDelete, { name: "return", repeated: true })).toEqual({
      type: "ignore",
    });
    expect(reduceConfirmKey(onDelete, { name: "c", ctrl: true })).toEqual({ type: "cancel" });
    expect(reduceConfirmKey(onDelete, { name: "escape" })).toEqual({ type: "cancel" });
  });

  it("confirms an archive with Enter, as before, since it can be undone", () => {
    const dialog = openConfirm([archiveThreadsConfirm(["a", "b"])]);
    expect(dialog.steps[0]?.title).toBe("Archive 2 threads?");
    expect(reduceConfirmKey(dialog, { name: "return" })).toEqual({ type: "confirm" });
  });

  it("walks the project removal's two steps, each starting on Cancel", () => {
    const dialog = openConfirm(projectRemovalSteps("alpha", 2));
    const first = next(reduceConfirmKey(dialog, { name: "right" }));
    const second = next(reduceConfirmKey(first, { name: "return" }));
    expect(second.stepIndex).toBe(1);
    expect(second.focus).toBe("cancel");
    expect(second.steps[1]?.title).toBe('Remove project "alpha" and 2 threads?');
    expect(reduceConfirmKey(second, { name: "return" })).toEqual({ type: "cancel" });
    const confirmed = next(reduceConfirmKey(second, { name: "left" }));
    expect(reduceConfirmKey(confirmed, { name: "return" })).toEqual({ type: "confirm" });
  });
});

describe("projectRemovalSteps", () => {
  it("asks once for an empty project and twice when threads go with it", () => {
    expect(projectRemovalSteps("alpha", 0).map((step) => step.confirmLabel)).toEqual(["Remove"]);
    expect(projectRemovalSteps("alpha", 1).map((step) => step.confirmLabel)).toEqual([
      "Continue",
      "Remove project",
    ]);
    expect(projectRemovalSteps("alpha", 1)[1]?.title).toBe('Remove project "alpha" and 1 thread?');
  });
});
