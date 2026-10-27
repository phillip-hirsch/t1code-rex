// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Drives the real branch toolbar, git menu, branch picker, worktree setup card and their
 * controller under OpenTUI (Bun only), on fixed atoms plus an in-memory git that records
 * what the controller asks for and updates the atoms the way the server's stream would.
 *   bun apps/tui/scripts/check-git.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { RegistryContext } from "@effect/atom-react";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import {
  EMPTY_VCS_ACTION_STATE,
  type RunVcsStackedActionInput,
  type VcsActionState,
} from "@t3tools/client-runtime/state/vcs";
import {
  ProjectId,
  ThreadId,
  type GitRunStackedActionResult,
  type VcsCreateRefInput,
  type VcsListRefsResult,
  type VcsStatusResult,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useRef, useState } from "react";

import { createComposerStore } from "../src/composerStore.ts";
import type {
  TuiActionResult,
  VcsRefsAtom,
  VcsStatusAtom,
  WorktreeSetupAtom,
} from "../src/connection/tuiConnection.ts";
import { useGitControls, type GitControls, type GitTarget } from "../src/gitController.ts";
import { dirtyTree, vcsRef, vcsRefs, vcsStatus, worktreeSetup } from "../src/gitTestFixtures.ts";
import {
  BranchToolbar,
  GitOverlay,
  WorktreeSetupPanel,
  type GitOverlayHandle,
} from "../src/gitViews.tsx";
import { presentedThread, projectShell } from "../src/shellTestFixtures.ts";
import type { SidebarThread } from "../src/sidebarModel.ts";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (want ${String(expected)})`}`,
  );
}

async function settle(render: () => Promise<void>, passes = 4): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await act(async () => {
      await render();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const PROJECT = projectShell("repo", { workspaceRoot: "/repo" });
const THREAD_ID = ThreadId.make("thread-git");
const WORKTREE = "/repo-wt/login";

function ok<A>(value: A): TuiActionResult<A> {
  return { ok: true, value };
}

/** An in-memory git: atoms the views read, and commands that log and update them. */
function createGit() {
  const registry = AtomRegistry.make();
  const calls: string[] = [];
  let refreshes = 0;
  const statuses = new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>
  >();
  const actions = new Map<string, Atom.Writable<VcsActionState>>();
  const setups = new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, unknown>>
  >();
  const allRefs = vcsRefs([
    vcsRef("main", { isDefault: true }),
    vcsRef("feature", { current: true, worktreePath: "/repo" }),
    vcsRef("feature/login", { worktreePath: WORKTREE }),
    vcsRef("fix-typo"),
  ]);
  // Only the picker reads refs; kept alive so a change made while it's closed sticks.
  const refsAtom = Atom.make<AsyncResult.AsyncResult<VcsListRefsResult, unknown>>(
    AsyncResult.success(allRefs),
  ).pipe(Atom.keepAlive);
  const statusAtom = (cwd: string) => {
    let atom = statuses.get(cwd);
    if (atom === undefined) {
      atom = Atom.make<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>(
        AsyncResult.success(vcsStatus()),
      );
      statuses.set(cwd, atom);
    }
    return atom;
  };
  const actionAtom = (cwd: string) => {
    let atom = actions.get(cwd);
    if (atom === undefined) {
      atom = Atom.make<VcsActionState>(EMPTY_VCS_ACTION_STATE);
      actions.set(cwd, atom);
    }
    return atom;
  };
  const setupAtom = (threadId: string) => {
    let atom = setups.get(threadId);
    if (atom === undefined) {
      atom = Atom.make<AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, unknown>>(
        AsyncResult.success(null),
      );
      setups.set(threadId, atom);
    }
    return atom;
  };
  const setStatus = (cwd: string, status: VcsStatusResult) =>
    registry.set(statusAtom(cwd), AsyncResult.success(status));
  /** The next stacked action's ending; it runs until the check settles it. */
  let pendingAction: {
    input: RunVcsStackedActionInput;
    cwd: string;
    settle: (result: TuiActionResult<GitRunStackedActionResult>) => void;
  } | null = null;

  const source = {
    registry,
    vcsStatusAtom: (cwd: string): VcsStatusAtom => statusAtom(cwd),
    vcsRefsAtom: (_cwd: string): VcsRefsAtom => refsAtom,
    vcsActionStateAtom: (cwd: string): Atom.Atom<VcsActionState> => actionAtom(cwd),
    worktreeSetupAtom: (threadId: ThreadId): WorktreeSetupAtom => setupAtom(threadId),
    switchRef: async (input: { cwd: string; refName: string }) => {
      calls.push(`switchRef ${input.cwd} ${input.refName}`);
      setStatus(input.cwd, vcsStatus({ refName: input.refName }));
      return ok({ refName: input.refName });
    },
    createRef: async (input: VcsCreateRefInput) => {
      calls.push(`createRef ${input.cwd} ${input.refName} switch=${input.switchRef === true}`);
      setStatus(input.cwd, vcsStatus({ refName: input.refName, hasUpstream: false }));
      return ok({ refName: input.refName });
    },
    initRepository: async (input: { cwd: string }) => {
      calls.push(`init ${input.cwd}`);
      setStatus(
        input.cwd,
        vcsStatus({ refName: "main", hasPrimaryRemote: false, hasUpstream: false }),
      );
      return ok(undefined);
    },
    pull: async (input: { cwd: string }) => {
      calls.push(`pull ${input.cwd}`);
      return ok({ status: "pulled" as const, refName: "feature", upstreamRef: null });
    },
    runStackedAction: (cwd: string, input: RunVcsStackedActionInput) => {
      calls.push(`run ${cwd} ${input.action}`);
      registry.set(actionAtom(cwd), {
        ...EMPTY_VCS_ACTION_STATE,
        isRunning: true,
        actionId: input.actionId,
        currentLabel: "Pushing...",
        lastOutputLine: "pre-push: lint ok",
      });
      return new Promise<TuiActionResult<GitRunStackedActionResult>>((resolve) => {
        pendingAction = {
          input,
          cwd,
          settle: (result) => {
            registry.set(actionAtom(cwd), EMPTY_VCS_ACTION_STATE);
            resolve(result);
          },
        };
      });
    },
    refreshVcsStatus: async (cwd: string, localOnly = false) => {
      // The toolbar's own local re-reads aren't actions; only an asked-for refresh is logged.
      if (localOnly) refreshes += 1;
      else calls.push(`refresh ${cwd}`);
      return ok(vcsStatus());
    },
    cancelWorktreeSetup: async (threadId: ThreadId) => {
      calls.push(`cancelSetup ${threadId}`);
      registry.set(
        setupAtom(threadId),
        AsyncResult.success(worktreeSetup({ threadId, phase: "cancelled" })),
      );
      return ok({ cancelled: true });
    },
    stopThreadSession: async (input: { threadId: ThreadId }) => {
      calls.push(`stopSession ${input.threadId}`);
      return ok({ sequence: 1 });
    },
    updateThreadMetadata: async (input: {
      threadId: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
    }) => {
      calls.push(`metadata ${input.threadId} ${input.branch} ${input.worktreePath}`);
      return ok({ sequence: 1 });
    },
  };
  return {
    source,
    registry,
    calls,
    localRefreshes: () => refreshes,
    setStatus,
    setRefs: (refs: VcsListRefsResult | null) =>
      registry.set(refsAtom, AsyncResult.success(refs ?? allRefs)),
    setSetup: (threadId: string, snapshot: WorktreeSetupSnapshot | null) =>
      registry.set(setupAtom(threadId), AsyncResult.success(snapshot)),
    takeAction: () => {
      const action = pendingAction;
      pendingAction = null;
      return action;
    },
  };
}

interface Scene {
  readonly target: GitTarget;
  readonly thread: SidebarThread | null;
}

const git = createGit();
const store = createComposerStore({ initialPrefs: {}, persist: null });
const draft = store.openNewThreadDraft(ProjectId.make(PROJECT.id), () =>
  ThreadId.make("draft-git"),
);
const threadScene = (overrides: Parameters<typeof presentedThread>[2] = {}): Scene => ({
  target: { kind: "thread", threadId: THREAD_ID, projectId: PROJECT.id },
  thread: presentedThread(THREAD_ID, PROJECT.id, { branch: "feature", ...overrides }),
});
const draftScene: Scene = {
  target: { kind: "draft", threadId: draft.threadId, projectId: PROJECT.id },
  thread: null,
};

/** What the checks reach into: the harness's scene setter, controller and status line. */
const harness: {
  setScene: (scene: Scene) => void;
  controls: GitControls | null;
  footer: string;
} = { setScene: () => undefined, controls: null, footer: "" };
const setScene = (scene: Scene) => harness.setScene(scene);

/** The app's wiring of the git pieces: g and b open the overlays, w flips a draft's mode. */
function Harness() {
  const [scene, setSceneState] = useState<Scene>(threadScene());
  const [status, setStatus] = useState("");
  const [, setVersion] = useState(0);
  const overlayRef = useRef<GitOverlayHandle | null>(null);
  const controller = useGitControls({
    connection: git.source,
    store: {
      findNewThreadDraft: store.findNewThreadDraft,
      setNewThreadDraftWorkspace: (threadId, workspace) => {
        store.setNewThreadDraftWorkspace(threadId, workspace);
        setVersion((version) => version + 1);
      },
    },
    target: scene.target,
    thread: scene.thread,
    project: PROJECT,
    defaultEnvMode: "local",
    startFromOrigin: false,
    setStatus,
    onPickCommitModel: () => setStatus("commit model picker"),
    onFocusComposer: () => undefined,
    overlayRef,
  });
  useEffect(() => {
    harness.setScene = setSceneState;
    harness.controls = controller;
    harness.footer = status;
  });
  useKeyboard((key: KeyEvent) => {
    if (controller.handleKey(key)) return;
    if (key.name === "g") controller.openMenu();
    else if (key.name === "b") controller.openBranchPicker();
    else if (key.name === "w") controller.toggleWorktree();
  });
  if (controller.cwd === null || controller.projectCwd === null) return null;
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {controller.setupThreadId !== null ? (
        <WorktreeSetupPanel
          source={git.source}
          threadId={controller.setupThreadId}
          theme={DEFAULT_TUI_THEME}
          onCancel={controller.cancelWorktreeSetup}
        />
      ) : null}
      <box style={{ flexGrow: 1 }} />
      <text content={`status: ${status}`} />
      <BranchToolbar
        source={git.source}
        cwd={controller.cwd}
        draft={controller.draft}
        envMode={controller.envMode}
        worktreePath={controller.worktreePath}
        threadBranch={controller.threadBranch}
        failure={controller.failure}
        theme={DEFAULT_TUI_THEME}
        onPress={controller.pressToolbar}
      />
      {controller.overlay !== null ? (
        <GitOverlay
          ref={overlayRef}
          source={git.source}
          cwd={controller.cwd}
          mode={controller.overlay}
          projectCwd={controller.projectCwd}
          envMode={controller.envMode}
          worktreePath={controller.worktreePath}
          threadBranch={controller.threadBranch}
          pickingWorktreeBase={controller.pickingWorktreeBase}
          commitModelLabel="Claude Haiku 5.5"
          armedId={controller.armedId}
          failure={controller.failure}
          left={0}
          theme={DEFAULT_TUI_THEME}
          onMenuItem={controller.runMenuItem}
          onBranchItem={controller.pickBranch}
          onClose={controller.closeOverlay}
        />
      ) : null}
    </box>
  );
}

const setup = await testRender(
  <RegistryContext.Provider value={git.registry}>
    <Harness />
  </RegistryContext.Provider>,
  { width: 100, height: 30, kittyKeyboard: true },
);
const render = () => settle(setup.renderOnce);
const frame = () => setup.captureCharFrame();
const press = async (...keys: string[]) => {
  for (const key of keys) {
    act(() => {
      if (key === "up" || key === "down") setup.mockInput.pressArrow(key);
      else setup.mockInput.pressKey(key);
    });
    await render();
  }
};
const type = async (text: string) => {
  for (const char of text) await press(char);
};
const lastCall = () => git.calls.at(-1) ?? "";
await render();

// G1: the toolbar shows the checkout's branch and state, and re-reads it once mounted.
check("G1: the toolbar refreshed status on mount", git.localRefreshes() >= 1, true);
check(
  "G1: env, branch, clean, in sync",
  frame().includes("󰉋 Local  󰘬 feature  ✓ clean  ≡ up to date"),
  true,
);

// G2: status streams in without remounting anything: an edit, then a commit.
act(() =>
  git.setStatus("/repo", vcsStatus(dirtyTree([{ path: "a.ts", insertions: 3, deletions: 0 }]))),
);
await render();
check("G2: an edit shows as changes", frame().includes("● 1 file +3 -0"), true);
act(() => git.setStatus("/repo", vcsStatus({ aheadCount: 1 })));
await render();
check("G2: a commit shows as ahead", frame().includes("✓ clean  ↑1"), true);

// G3: the menu's push streams progress into the toolbar, then reports the result.
const refreshesBeforeMenu = git.localRefreshes();
await press("g");
check("G3: opening the menu re-reads status", git.localRefreshes() > refreshesBeforeMenu, true);
check("G3: g opens the menu on the branch", frame().includes("Git · feature"), true);
check("G3: its quick action pushes and opens a PR", frame().includes("Push & create PR"), true);
await press("down", "down", "RETURN");
check("G3: ⏎ on Push runs it", lastCall(), "run /repo push");
check("G3: the menu closed", frame().includes("Git · feature"), false);
check(
  "G3: the toolbar shows the phase and hook output",
  frame().includes("󱦟 Pushing...  pre-push: lint ok"),
  true,
);
const push = git.takeAction();
act(() =>
  push?.settle(
    ok({
      action: "push",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_not_requested" },
      push: { status: "pushed", branch: "feature" },
      pr: { status: "skipped_not_requested" },
      toast: { title: "Pushed feature", cta: { kind: "none" } },
    }),
  ),
);
await render();
check("G3: the result lands in the status line", harness.footer, "Pushed feature");
check("G3: and the toolbar is quiet again", frame().includes("Pushing..."), false);

// G4: a failed PR shows the server's own message.
await press("g", "down", "down", "down", "RETURN");
check("G4: Create PR runs", lastCall(), "run /repo create_pr");
const pr = git.takeAction();
act(() => {
  pr?.input.onProgress?.({
    actionId: pr.input.actionId,
    cwd: "/repo",
    action: "create_pr",
    kind: "action_failed",
    phase: "pr",
    message: "No GitHub repository for remote origin",
  });
  pr?.settle({ ok: false, error: new Error("Source control action failed."), interrupted: false });
});
await render();
check("G4: the toolbar keeps the failure in view", frame().includes("✗ Create PR failed"), true);
await press("g");
check(
  "G4: the menu shows its whole message",
  frame().includes("✗ Create PR failed: No GitHub repository for remote origin"),
  true,
);
await press("escape");
check(
  "G4: the failure names the cause",
  harness.footer,
  "Create PR failed: No GitHub repository for remote origin",
);

// G5: pushing to the default branch takes a second ⏎.
act(() =>
  git.setStatus(
    "/repo",
    vcsStatus({
      refName: "main",
      isDefaultRef: true,
      ...dirtyTree([{ path: "a.ts", insertions: 1, deletions: 0 }]),
    }),
  ),
);
await render();
const before = git.calls.length;
await press("g", "RETURN");
check("G5: the first ⏎ only asks", git.calls.length, before);
check("G5: naming the branch", frame().includes("This pushes to main, the default branch"), true);
await press("RETURN");
check("G5: the second runs it", lastCall(), "run /repo commit_push");
git.takeAction()?.settle({ ok: false, error: new Error("x"), interrupted: true });
await render();
act(() => git.setStatus("/repo", vcsStatus()));
await render();

// G6: the picker filters as you type and switches in place.
await press("b");
check("G6: b opens the picker", frame().includes("Switch branch"), true);
check("G6: tagging the current branch", /● feature\s+current/.test(frame()), true);
await type("fix");
check(
  "G6: typing filters",
  frame().includes("fix-typo") && !frame().includes("feature/login"),
  true,
);
await press("RETURN");
check("G6: it switches the checkout", git.calls.at(-2), "switchRef /repo fix-typo");
check("G6: then points the thread there", lastCall(), "metadata thread-git fix-typo null");
check("G6: and says so", harness.footer, "On fix-typo");

// G7: a name no ref has creates the branch.
await press("b");
await type("new feature");
check("G7: offered as a new branch", frame().includes('Create branch "new-feature"'), true);
await press("RETURN");
check("G7: created and switched", git.calls.at(-2), "createRef /repo new-feature switch=true");
check("G7: the thread follows", lastCall(), "metadata thread-git new-feature null");

// G8: a branch in another worktree moves a running thread there, stopping its session first.
act(() =>
  setScene(
    threadScene({
      status: "running",
      activeRunId: "run-1" as never,
      latestRunId: "run-1" as never,
    }),
  ),
);
await render();
await press("b");
await type("login");
await press("RETURN");
check("G8: the session stops first", git.calls.at(-2), "stopSession thread-git");
check(
  "G8: then the thread moves to the worktree",
  lastCall(),
  `metadata thread-git feature/login ${WORKTREE}`,
);

// G9: a draft picks "New worktree" and its base without touching the checkout.
act(() => git.setStatus("/repo", vcsStatus()));
act(() => setScene(draftScene));
await render();
check("G9: a draft starts local", frame().includes("󰉋 Local  󰘬 feature"), true);
await press("w");
check(
  "G9: w picks a new worktree from the checkout's branch",
  frame().includes("󰙅 New worktree  󰘬 From feature"),
  true,
);
const callsBeforeBase = git.calls.length;
await press("b");
check("G9: the picker names a base", frame().includes("New worktree from…"), true);
await type("main");
check("G9: and offers no new branch", frame().includes("Create branch"), false);
await press("RETURN");
check("G9: picking a base runs no git", git.calls.length, callsBeforeBase);
check("G9: the toolbar shows the base", frame().includes("From main"), true);
check(
  "G9: the first send launches from it",
  JSON.stringify(harness.controls?.launchWorktree()),
  JSON.stringify({ projectCwd: "/repo", baseBranch: "main", startFromOrigin: false }),
);

// G9b: once sent, the thread says "Worktree" while the server still makes it.
act(() =>
  setScene({
    target: { kind: "thread", threadId: draft.threadId, projectId: PROJECT.id },
    thread: presentedThread(draft.threadId, PROJECT.id, { branch: null }),
  }),
);
act(() => git.setSetup(draft.threadId, worktreeSetup({ threadId: draft.threadId })));
await render();
check(
  "G9b: the toolbar shows the launch's base",
  frame().includes("󰙅 Worktree  󰘬 From main"),
  true,
);
check("G9b: and the setup card follows it", frame().includes("Setting up worktree"), true);
act(() => setScene(draftScene));
await render();

// G10: a folder that isn't a repository offers git init.
await press("w");
act(() => setScene(threadScene({ branch: null })));
act(() => git.setStatus("/repo", vcsStatus({ isRepo: false, refName: null })));
act(() => git.setRefs(vcsRefs([], { isRepo: false })));
await render();
check("G10: the toolbar says so", frame().includes("󰘬 Not a git repository"), true);
await press("b");
check("G10: the picker offers init", frame().includes("Initialize a git repository here"), true);
await press("RETURN");
check("G10: which runs git init", lastCall(), "init /repo");
act(() => git.setRefs(null));

// G11: a worktree thread's setup shows stage by stage, and can be cancelled.
act(() => setScene(threadScene({ worktreePath: WORKTREE })));
act(() => git.setSetup(THREAD_ID, worktreeSetup({ threadId: THREAD_ID })));
await render();
check(
  "G11: the card shows setup",
  frame().includes("Setting up worktree on t3/1a2b3c4d from main"),
  true,
);
check("G11: with the running stage's progress", frame().includes("◐ Check out files  40%"), true);
act(() => harness.controls?.cancelWorktreeSetup());
await render();
check("G11: cancel goes to the server", lastCall(), `cancelSetup ${THREAD_ID}`);
check("G11: and the card says it stopped", frame().includes("Worktree setup cancelled"), true);
act(() =>
  git.setSetup(
    THREAD_ID,
    worktreeSetup({
      threadId: THREAD_ID,
      phase: "done",
      stages: worktreeSetup().stages.map((stage) => ({ ...stage, status: "done" })),
    }),
  ),
);
await render();
check("G11: the card goes once the agent started", frame().includes("Worktree ready"), false);

setup.renderer.destroy();
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall git checks passed");
process.exit(0);
