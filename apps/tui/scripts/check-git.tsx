// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Drives the real branch toolbar, git menu, branch picker, worktree setup card and their
 * controller under OpenTUI (Bun only), on fixed atoms plus an in-memory git that records
 * what the controller asks for and updates the atoms the way the server's stream would.
 *   bun apps/tui/scripts/check-git.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { RegistryContext } from "@effect/atom-react";
import { testRender } from "@opentui/react/test-utils";
import {
  EMPTY_VCS_ACTION_STATE,
  type RunVcsStackedActionInput,
  type VcsActionState,
} from "@t3tools/client-runtime/state/vcs";
import {
  ProjectId,
  RunId,
  ThreadId,
  type GitRunStackedActionResult,
  type VcsCreateRefInput,
  type VcsListRefsResult,
  type VcsStatusResult,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useRef, useState } from "react";

import { branchRefsInput, mergeRefPages, type BranchRefPages } from "../src/branchPicker.ts";
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
import { useSyncKeyboard } from "../src/syncKeyboard.ts";
import { routeThreadPaneKey } from "../src/threadPaneKeys.ts";
import { resolveScrollKey } from "../src/threadScroll.ts";
import {
  WORKTREE_FAILED_NOTICE,
  WORKTREE_STOPPED_NOTICE,
  type WorktreeLaunch,
} from "../src/worktreeLaunch.ts";

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
  const refsAtom = Atom.make<VcsListRefsResult>(allRefs).pipe(Atom.keepAlive);
  const refQueries: string[] = [];
  /** `listRefs` as the server answers it: filtered by the query, a page at a time. */
  const listRefs = (all: VcsListRefsResult, cwd: string, query: string, cursor?: number) => {
    const input = branchRefsInput(cwd, query, cursor);
    const matched = all.refs.filter((ref) =>
      ref.name.toLowerCase().includes((input.query ?? "").toLowerCase()),
    );
    const start = input.cursor ?? 0;
    // Pages of 3 here, so a handful of refs already spans several.
    const page = matched.slice(start, start + Math.min(input.limit ?? 100, 3));
    return AsyncResult.success<VcsListRefsResult>({
      ...all,
      refs: page,
      nextCursor: start + page.length < matched.length ? start + page.length : null,
      totalCount: matched.length,
    });
  };
  const refPages = (cwd: string, query: string, pages: number) =>
    Atom.make((get): BranchRefPages => {
      const all = get(refsAtom);
      if (!all.isRepo) return mergeRefPages([AsyncResult.success(all)]);
      refQueries.push(query);
      const results = [];
      let cursor: number | undefined;
      for (let page = 0; page < pages; page += 1) {
        const result = listRefs(all, cwd, query, cursor);
        results.push(result);
        if (result.value.nextCursor === null) break;
        cursor = result.value.nextCursor;
      }
      return mergeRefPages(results);
    });
  const refPageAtoms = new Map<string, Atom.Atom<BranchRefPages>>();
  const launches = new Map<string, Atom.Writable<WorktreeLaunch | null>>();
  const launchAtom = (threadId: string) => {
    let atom = launches.get(threadId);
    if (atom === undefined) {
      atom = Atom.make<WorktreeLaunch | null>(null).pipe(Atom.keepAlive);
      launches.set(threadId, atom);
    }
    return atom;
  };
  const statusAtom = (cwd: string) => {
    let atom = statuses.get(cwd);
    if (atom === undefined) {
      // Kept alive, as the server keeps a checkout's status between reads.
      atom = Atom.make<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>(
        AsyncResult.success(vcsStatus()),
      ).pipe(Atom.keepAlive);
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
    vcsRefsAtom: (cwd: string, query: string, pages: number): VcsRefsAtom => {
      const key = JSON.stringify([cwd, query, pages]);
      let atom = refPageAtoms.get(key);
      if (atom === undefined) {
        atom = refPages(cwd, query, pages);
        refPageAtoms.set(key, atom);
      }
      return atom;
    },
    worktreeLaunchAtom: (threadId: ThreadId) => launchAtom(threadId),
    retryWorkspacePreparation: async (input: { threadId: ThreadId; runId: RunId }) => {
      calls.push(`retryPreparation ${input.threadId} ${input.runId}`);
      registry.set(launchAtom(input.threadId), {
        runId: input.runId,
        status: "preparing",
        baseRef: "main",
        retryable: false,
      });
      return ok({ sequence: 1 });
    },
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
    // Publishing has its own check (check-publish.tsx); these only log if reached.
    discoverSourceControl: async () => {
      calls.push("discoverSourceControl");
      return ok({ versionControlSystems: [], sourceControlProviders: [] });
    },
    lookupRepository: async (input: { repository: string }) => {
      calls.push(`lookupRepository ${input.repository}`);
      return { ok: false as const, error: new Error("not found"), interrupted: false };
    },
    publishRepository: async (input: { repository: string }) => {
      calls.push(`publishRepository ${input.repository}`);
      return { ok: false as const, error: new Error("not in check-git"), interrupted: false };
    },
  };
  return {
    source,
    registry,
    calls,
    localRefreshes: () => refreshes,
    setStatus,
    setRefs: (refs: VcsListRefsResult | null) => registry.set(refsAtom, refs ?? allRefs),
    refQueries,
    setLaunch: (threadId: string, launch: WorktreeLaunch | null) =>
      registry.set(launchAtom(threadId), launch),
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
  readonly project?: typeof PROJECT;
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
  /** What the transcript did with the keys it took. */
  scrolls: string[];
} = { setScene: () => undefined, controls: null, footer: "", scrolls: [] };
const setScene = (scene: Scene) => harness.setScene(scene);

/**
 * The app's wiring of the git pieces: the shell's thread-pane routing (the transcript
 * first, then c and b open the overlays), and w flips a draft's mode.
 */
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
      setNotice: store.setNotice,
      getDraft: store.getDraft,
      restoreDraft: store.restoreDraft,
    },
    target: scene.target,
    thread: scene.thread,
    project: scene.project ?? PROJECT,
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
  // As the shell reads keys: each one renders before the next of the same chunk.
  useSyncKeyboard((key: KeyEvent) => {
    if (controller.handleKey(key)) return;
    if (key.name === "w") {
      controller.toggleWorktree();
      return;
    }
    const routed = routeThreadPaneKey(key, {
      composer: scene.target.kind,
      pane: (paneKey) => {
        const scroll = resolveScrollKey(paneKey, 20);
        if (scroll !== null) harness.scrolls.push(scroll.kind);
        return scroll !== null;
      },
    });
    if (routed === "git-menu") controller.openMenu();
    else if (routed === "branch-picker") controller.openBranchPicker();
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
        setupFailed={controller.setupFailed}
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
          armed={controller.armed}
          setupFailed={controller.setupFailed}
          failure={controller.failure}
          left={0}
          theme={DEFAULT_TUI_THEME}
          onMenuItem={controller.runMenuItem}
          onBranchItem={controller.pickBranch}
          onConfirmPublish={controller.confirmPublish}
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
      else if (key === "escape") setup.mockInput.pressEscape();
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
check("G3: g stays the transcript's jump to the top", harness.scrolls.at(-1), "top");
check("G3: and opens no menu", frame().includes("Git · feature"), false);
await press("c");
check("G3: opening the menu re-reads status", git.localRefreshes() > refreshesBeforeMenu, true);
check("G3: c opens the menu on the branch", frame().includes("Git · feature"), true);
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
await press("c", "down", "down", "down", "RETURN");
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
await press("c");
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
await press("c", "RETURN");
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
act(() =>
  git.setLaunch(draft.threadId, {
    runId: RunId.make("run-launch"),
    status: "preparing",
    baseRef: "main",
    retryable: false,
  }),
);
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

// Sol audit round 1.
const RUN = RunId.make("run-wt");
const REOPENED = ThreadId.make("thread-reopened");
const reopenedScene: Scene = {
  target: { kind: "thread", threadId: REOPENED, projectId: PROJECT.id },
  thread: presentedThread(REOPENED, PROJECT.id, { branch: null }),
};
act(() => git.setStatus("/repo", vcsStatus()));

// S7: a thread this window never launched (the TUI was reopened mid-setup) still shows its
// setup and can cancel it: the server says its run is preparing a worktree.
act(() => setScene(reopenedScene));
act(() => git.setSetup(REOPENED, worktreeSetup({ threadId: REOPENED })));
act(() =>
  git.setLaunch(REOPENED, { runId: RUN, status: "preparing", baseRef: "main", retryable: false }),
);
await render();
check("S7: the setup card shows", frame().includes("Setting up worktree"), true);
check("S7: the toolbar says Worktree", frame().includes("󰙅 Worktree  󰘬 From main"), true);
check(
  "S7: sends wait for the worktree",
  harness.controls?.sendBlockedReason(REOPENED)?.startsWith("The new worktree is still"),
  true,
);
act(() => harness.controls?.cancelWorktreeSetup());
await render();
check("S7: and cancel reaches the server", lastCall(), `cancelSetup ${REOPENED}`);

// S1: the setup failed (or was cancelled) and its worktree is gone: sends are blocked until
// a retry makes it. The server can't move the thread to the project checkout, so the TUI
// doesn't offer to either (round 2, S3).
act(() =>
  git.setLaunch(REOPENED, { runId: RUN, status: "failed", baseRef: "main", retryable: true }),
);
act(() => store.setNotice(REOPENED, WORKTREE_FAILED_NOTICE));
await render();
check(
  "S1: the toolbar keeps the failure in view",
  frame().includes("✗ Worktree setup failed"),
  true,
);
check(
  "S1: a send is blocked",
  harness.controls?.sendBlockedReason(REOPENED),
  WORKTREE_FAILED_NOTICE,
);
await press("c");
check("S1: the menu leads with retry", frame().includes("Retry worktree setup"), true);
check(
  "S3: and no longer offers the project checkout",
  frame().includes("Work in the project checkout"),
  false,
);
await press("RETURN");
check(
  "S1: retry runs the failed preparation again",
  lastCall(),
  `retryPreparation ${REOPENED} ${RUN}`,
);
check("S1: and clears the composer's notice", store.snapshot(REOPENED).notice, null);
check(
  "S1: sends wait while it retries",
  harness.controls?.sendBlockedReason(REOPENED) !== null,
  true,
);
// A preparation that was stopped can't be retried; only a new thread gets past it.
act(() =>
  git.setLaunch(REOPENED, { runId: RUN, status: "failed", baseRef: "main", retryable: false }),
);
await render();
check(
  "S1: a stopped setup blocks sends too",
  harness.controls?.sendBlockedReason(REOPENED),
  WORKTREE_STOPPED_NOTICE,
);
const beforeStoppedRetry = git.calls.length;
act(() => harness.controls?.retrySetup());
await render();
check("S1: and isn't retried", git.calls.length, beforeStoppedRetry);
check(
  "S1: it says what to do",
  harness.footer,
  "This worktree setup can't be retried; start a new thread",
);
// `c` and ⏎ in one stdin chunk: the menu opens and renders before ⏎ picks its retry.
act(() =>
  git.setLaunch(REOPENED, { runId: RUN, status: "failed", baseRef: "main", retryable: true }),
);
await render();
const beforeBurst = git.calls.length;
act(() => {
  setup.renderer.stdin.emit("data", Buffer.from("c\r"));
});
await render();
check(
  "S1: c then ⏎ in one chunk retries",
  git.calls.slice(beforeBurst).join(", "),
  `retryPreparation ${REOPENED} ${RUN}`,
);
act(() => git.setLaunch(REOPENED, null));

// S4: a default-branch push armed in one checkout doesn't run in another one.
const OTHER = projectShell("other", { workspaceRoot: "/other" });
const defaultDirty = vcsStatus({
  refName: "main",
  isDefaultRef: true,
  ...dirtyTree([{ path: "a.ts", insertions: 1, deletions: 0 }]),
});
act(() => git.setStatus("/repo", defaultDirty));
act(() => git.setStatus("/other", defaultDirty));
act(() => setScene(threadScene()));
await render();
const beforeArm = git.calls.length;
await press("c", "RETURN");
check("S4: the first ⏎ asks", frame().includes("This pushes to main, the default branch"), true);
act(() =>
  setScene({
    target: { kind: "thread", threadId: ThreadId.make("thread-other"), projectId: OTHER.id },
    thread: presentedThread(ThreadId.make("thread-other"), OTHER.id, { branch: "main" }),
    project: OTHER,
  }),
);
await render();
check("S4: in another checkout it no longer asks", frame().includes("the default branch"), false);
await press("RETURN");
check("S4: so ⏎ there only asks again", git.calls.length, beforeArm);
check("S4: for that checkout", frame().includes("This pushes to main, the default branch"), true);
await press("RETURN");
check("S4: a second ⏎ there runs it there", lastCall(), "run /other commit_push");
git.takeAction()?.settle({ ok: false, error: new Error("x"), interrupted: true });
act(() => setScene(threadScene()));
act(() => git.setStatus("/repo", vcsStatus()));
await render();

// S3: the server filters refs by what's typed and pages them; "create" waits for every page.
act(() =>
  git.setRefs(
    vcsRefs([
      vcsRef("main", { isDefault: true }),
      vcsRef("feature", { current: true, worktreePath: "/repo" }),
      ...["a-1", "a-2", "a-3", "a-4", "a-5"].map((name) => vcsRef(name)),
      vcsRef("zeta"),
    ]),
  ),
);
await press("b");
await type("zeta");
check("S3: the query goes to the server", git.refQueries.at(-1), "zeta");
check("S3: a ref past the first page is found", frame().includes("zeta"), true);
await press("escape", "b");
await type("a-");
check("S3: more matches than one page", frame().includes("Load more (3 of 5 shown)"), true);
check("S3: so no create yet", frame().includes("Create branch"), false);
await press("down", "down", "down", "RETURN");
check("S3: load more lists the rest", frame().includes("a-5"), true);
check(
  "S3: then the server has confirmed the name is new",
  frame().includes('Create branch "a-"'),
  true,
);
await press("escape", "b");
await type("a-5");
check("S3: an existing name is never offered", frame().includes("Create branch"), false);
await press("escape");
act(() => git.setRefs(null));

// S5: a detached HEAD shows as one, not as the branch the thread last recorded.
act(() => git.setStatus("/repo", vcsStatus({ refName: null })));
await render();
check("S5: detached HEAD", frame().includes("󰘬 Detached HEAD"), true);
act(() => git.setStatus("/repo", vcsStatus()));
await render();

setup.renderer.destroy();
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall git checks passed");
process.exit(0);
