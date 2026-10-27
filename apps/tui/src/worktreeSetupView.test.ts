import { describe, expect, it } from "vite-plus/test";

import { worktreeSetup, worktreeSetupStage } from "./gitTestFixtures.ts";
import { describeWorktreeSetup } from "./worktreeSetupView.ts";

describe("describeWorktreeSetup", () => {
  it("lists stages in order with the running one's progress and last output", () => {
    const view = describeWorktreeSetup(worktreeSetup());
    expect(view.title).toBe("Setting up worktree on t3/1a2b3c4d from main");
    expect(view.cancellable).toBe(true);
    expect(view.lines.map((line) => `${line.icon} ${line.text}`)).toEqual([
      "✓ Fetch base branch",
      "◐ Check out files  40%  › Updating files: 40% (4/10)",
      "– Init submodules",
      "– Run setup script",
      "○ Start agent",
    ]);
  });

  it("names the setup script and shows why setup failed", () => {
    const view = describeWorktreeSetup(
      worktreeSetup({
        phase: "failed",
        setupScript: { name: "Install", command: "bun i", terminalId: "setup" },
        stages: [
          worktreeSetupStage("fetch", "done"),
          worktreeSetupStage("setup-script", "failed", { tail: ["error: lockfile"] }),
        ],
        error: "Setup script exited with 1",
      }),
    );
    expect(view.title).toBe("Worktree setup failed on t3/1a2b3c4d from main");
    expect(view.cancellable).toBe(false);
    expect(view.lines[1]).toMatchObject({
      icon: "✗",
      text: "Run setup script: Install  › error: lockfile",
      tone: "error",
    });
    expect(view.error).toBe("Setup script exited with 1");
  });

  it("says when setup was cancelled or finished", () => {
    expect(describeWorktreeSetup(worktreeSetup({ phase: "cancelled" })).title).toBe(
      "Worktree setup cancelled on t3/1a2b3c4d from main",
    );
    const done = describeWorktreeSetup(
      worktreeSetup({ phase: "done", branch: null, stages: [worktreeSetupStage("agent", "done")] }),
    );
    expect(done).toMatchObject({ title: "Worktree ready from main", tone: "success" });
  });
});
