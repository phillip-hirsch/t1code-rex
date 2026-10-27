// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Drives the real Source Control view, `/publish` through the git controller, its
 * confirmation in the git overlay, and the branch toolbar under OpenTUI (Bun only), on fixed
 * atoms and a fake server that records what it's asked. Nothing reaches a real provider.
 *   bun apps/tui/scripts/check-publish.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { RegistryContext } from "@effect/atom-react";
import { testRender } from "@opentui/react/test-utils";
import { EMPTY_VCS_ACTION_STATE, type VcsActionState } from "@t3tools/client-runtime/state/vcs";
import {
  SourceControlRepositoryError,
  ThreadId,
  type SourceControlDiscoveryResult,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
  type VcsRef,
  type VcsStatusResult,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useRef, useState } from "react";

import { createComposerStore } from "../src/composerStore.ts";
import type {
  SourceControlDiscoveryAtom,
  TuiActionResult,
  VcsRefsAtom,
  VcsStatusAtom,
  WorktreeSetupAtom,
} from "../src/connection/tuiConnection.ts";
import { useGitControls, type GitControls, type GitTarget } from "../src/gitController.ts";
import { vcsStatus } from "../src/gitTestFixtures.ts";
import {
  BranchToolbar,
  GitOverlay,
  PUBLISH_ARM_MS,
  type GitOverlayHandle,
} from "../src/gitViews.tsx";
import { topOverlay } from "../src/overlayStack.ts";
import { presentedThread, projectShell } from "../src/shellTestFixtures.ts";
import { discoveryResult, providerDiscovery } from "../src/sourceControlTestFixtures.ts";
import { SourceControlView, type SourceControlViewHandle } from "../src/sourceControlViews.tsx";
import { useSyncKeyboard } from "../src/syncKeyboard.ts";
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
const THREAD_ID = ThreadId.make("thread-publish");
const OTHER_THREAD_ID = ThreadId.make("thread-other");
const NO_REMOTE = vcsStatus({ refName: "main", hasPrimaryRemote: false, hasUpstream: false });

function ok<A>(value: A): TuiActionResult<A> {
  return { ok: true, value };
}
function failed<A>(error: unknown): TuiActionResult<A> {
  return { ok: false, error, interrupted: false };
}

function repository(nameWithOwner: string): SourceControlRepositoryInfo {
  return {
    provider: discoveryResult().sourceControlProviders[2]!.kind,
    nameWithOwner,
    url: `https://bitbucket.org/${nameWithOwner}`,
    sshUrl: `git@bitbucket.org:${nameWithOwner}.git`,
  };
}

/** A fake server: atoms the views read, and commands that log what they're asked. */
function createServer() {
  const registry = AtomRegistry.make();
  const calls: string[] = [];
  const statusAtom = Atom.make<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>(
    AsyncResult.success(NO_REMOTE),
  ).pipe(Atom.keepAlive);
  const actionAtom = Atom.make<VcsActionState>(EMPTY_VCS_ACTION_STATE).pipe(Atom.keepAlive);
  const discoveryAtom = Atom.make<AsyncResult.AsyncResult<SourceControlDiscoveryResult, unknown>>(
    AsyncResult.initial(true),
  ).pipe(Atom.keepAlive);
  const noRefs: VcsRefsAtom = Atom.make({ data: null, loading: false, failed: false });
  const noSetup: WorktreeSetupAtom = Atom.make<
    AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, unknown>
  >(AsyncResult.success(null));
  /** What a fresh scan and status read answer, and which repositories already exist. */
  let scan: TuiActionResult<SourceControlDiscoveryResult> = ok(discoveryResult());
  let status: VcsStatusResult = NO_REMOTE;
  let remoteRefs: ReadonlyArray<VcsRef> = [];
  /** Scans wait for `answerChecks` unless this is off; then they answer straight away. */
  let holdChecks = true;
  const existing = new Set(["sandbox/taken"]);
  let pending: {
    input: SourceControlPublishRepositoryInput;
    settle: (result: TuiActionResult<SourceControlPublishRepositoryResult>) => void;
  } | null = null;
  let checks: Array<() => void> = [];

  const source = {
    registry,
    vcsStatusAtom: (_cwd: string): VcsStatusAtom => statusAtom,
    vcsRefsAtom: (): VcsRefsAtom => noRefs,
    vcsActionStateAtom: (_cwd: string): Atom.Atom<VcsActionState> => actionAtom,
    worktreeSetupAtom: (): WorktreeSetupAtom => noSetup,
    worktreeLaunchAtom: () => Atom.make(null),
    refreshVcsStatus: async (cwd: string, localOnly = false) => {
      if (!localOnly) calls.push(`refresh ${cwd}`);
      registry.set(statusAtom, AsyncResult.success(status));
      return ok(status);
    },
    discoverSourceControl: () => {
      calls.push("discover");
      // Held until the check lets it go, so it can move threads mid-check.
      return new Promise<TuiActionResult<SourceControlDiscoveryResult>>((resolve) => {
        if (holdChecks) checks.push(() => resolve(scan));
        else resolve(scan);
      });
    },
    listRemoteRefs: async (cwd: string) => {
      calls.push(`remotes ${cwd}`);
      return ok({
        refs: remoteRefs,
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: remoteRefs.length,
      });
    },
    lookupRepository: async (input: SourceControlRepositoryLookupInput) => {
      calls.push(`lookup ${input.provider} ${input.repository}`);
      return existing.has(input.repository)
        ? ok(repository(input.repository))
        : failed<SourceControlRepositoryInfo>(new Error("Repository not found."));
    },
    publishRepository: (input: SourceControlPublishRepositoryInput) => {
      calls.push(
        `publish ${input.provider} ${input.repository} ${input.visibility} ${input.protocol} ${input.remoteName}`,
      );
      // As the connection tracks it: the checkout's action state shows it running.
      registry.set(actionAtom, {
        ...EMPTY_VCS_ACTION_STATE,
        isRunning: true,
        operation: "publish_repository",
        currentLabel: "Publishing repository",
      });
      return new Promise<TuiActionResult<SourceControlPublishRepositoryResult>>((resolve) => {
        pending = {
          input,
          settle: (result) => {
            registry.set(actionAtom, EMPTY_VCS_ACTION_STATE);
            resolve(result);
          },
        };
      });
    },
    sourceControlDiscoveryAtom: discoveryAtom as SourceControlDiscoveryAtom,
    refreshSourceControlDiscovery: () => {
      calls.push("rescan");
      const current = registry.get(discoveryAtom);
      registry.set(discoveryAtom, AsyncResult.waiting(current));
    },
    // Unused by publishing; here for the controller's type.
    switchRef: async () => ok({ refName: "main" }),
    createRef: async () => ok({ refName: "main" }),
    initRepository: async () => ok(undefined),
    pull: async () =>
      ok({ status: "skipped_up_to_date" as const, refName: "main", upstreamRef: null }),
    runStackedAction: async () => failed<never>(new Error("not here")),
    cancelWorktreeSetup: async () => ok({ cancelled: false }),
    retryWorkspacePreparation: async () => ok({ sequence: 1 }),
    stopThreadSession: async () => ok({ sequence: 1 }),
    updateThreadMetadata: async () => ok({ sequence: 1 }),
  };
  return {
    source,
    registry,
    calls,
    setScan: (next: TuiActionResult<SourceControlDiscoveryResult>) => {
      scan = next;
    },
    setStatus: (next: VcsStatusResult) => {
      status = next;
    },
    setRemoteRefs: (next: ReadonlyArray<VcsRef>) => {
      remoteRefs = next;
    },
    setHoldChecks: (hold: boolean) => {
      holdChecks = hold;
    },
    /** What the status stream shows now. */
    showStatus: (next: VcsStatusResult) => registry.set(statusAtom, AsyncResult.success(next)),
    showDiscovery: (result: AsyncResult.AsyncResult<SourceControlDiscoveryResult, unknown>) =>
      registry.set(discoveryAtom, result),
    /** Lets the scans waiting so far answer. */
    answerChecks: () => {
      const waiting = checks;
      checks = [];
      for (const answer of waiting) answer();
    },
    takePublish: () => {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

const server = createServer();
const store = createComposerStore({ initialPrefs: {}, persist: null });

const harness: {
  controls: GitControls | null;
  footer: string;
  setThread: (threadId: ThreadId) => void;
  setSourceControlOpen: (open: boolean) => void;
} = {
  controls: null,
  footer: "",
  setThread: () => undefined,
  setSourceControlOpen: () => undefined,
};

/**
 * The shell's wiring: the overlay on top (`topOverlay`, as the Shell picks it) is the one
 * drawn and the one that takes keys; with none open, c opens the menu and ⏎ sends a
 * `/publish` typed in the composer, as the composer hands it over.
 */
function Harness() {
  const [threadId, setThreadId] = useState<ThreadId>(THREAD_ID);
  const [status, setStatus] = useState("");
  const [sourceControlOpen, setSourceControlOpen] = useState(false);
  const overlayRef = useRef<GitOverlayHandle | null>(null);
  const viewRef = useRef<SourceControlViewHandle | null>(null);
  const project =
    threadId === THREAD_ID ? PROJECT : projectShell("other", { workspaceRoot: "/other" });
  const target: GitTarget = { kind: "thread", threadId, projectId: project.id };
  const controller = useGitControls({
    connection: server.source,
    store,
    target,
    thread: presentedThread(threadId, project.id, { branch: "main" }),
    project,
    defaultEnvMode: "local",
    startFromOrigin: false,
    setStatus,
    onPickCommitModel: () => undefined,
    onFocusComposer: () => undefined,
    overlayRef,
  });
  useEffect(() => {
    harness.controls = controller;
    harness.footer = status;
    harness.setThread = setThreadId;
    harness.setSourceControlOpen = setSourceControlOpen;
  });
  const top = topOverlay({
    "source-control": sourceControlOpen,
    git: controller.overlay !== null,
  });
  useSyncKeyboard((key: KeyEvent) => {
    if (top === "source-control") {
      viewRef.current?.handleKey(key);
      return;
    }
    if (top === "git" && controller.handleKey(key)) return;
    if (key.name === "c") controller.openMenu();
    else if (key.name === "return") {
      const text = store.getDraft(threadId).text.trim();
      if (!text.startsWith("/publish")) return;
      store.clearDraft(threadId);
      controller.publish(text.slice("/publish".length), text);
    }
  });
  if (controller.cwd === null || controller.projectCwd === null) return null;
  const notice = store.snapshot(threadId).notice;
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexGrow: 1 }} />
      <text content={`notice: ${notice ?? ""}`} />
      <text content={`status: ${status}`} />
      <BranchToolbar
        source={server.source}
        cwd={controller.cwd}
        draft={false}
        envMode={controller.envMode}
        worktreePath={controller.worktreePath}
        threadBranch={controller.threadBranch}
        failure={controller.failure}
        setupFailed={false}
        theme={DEFAULT_TUI_THEME}
        onPress={controller.pressToolbar}
      />
      {top === "git" && controller.overlay !== null ? (
        <GitOverlay
          ref={overlayRef}
          source={server.source}
          cwd={controller.cwd}
          mode={controller.overlay}
          projectCwd={controller.projectCwd}
          envMode={controller.envMode}
          worktreePath={controller.worktreePath}
          threadBranch={controller.threadBranch}
          pickingWorktreeBase={false}
          commitModelLabel="server default"
          armed={controller.armed}
          setupFailed={false}
          failure={controller.failure}
          left={0}
          theme={DEFAULT_TUI_THEME}
          onMenuItem={controller.runMenuItem}
          onBranchItem={controller.pickBranch}
          onConfirmPublish={controller.confirmPublish}
          onClose={controller.closeOverlay}
        />
      ) : null}
      {sourceControlOpen ? (
        <SourceControlView
          ref={viewRef}
          source={server.source}
          theme={DEFAULT_TUI_THEME}
          height={24}
          onClose={() => setSourceControlOpen(false)}
        />
      ) : null}
    </box>
  );
}

const setup = await testRender(
  <RegistryContext.Provider value={server.registry}>
    <Harness />
  </RegistryContext.Provider>,
  { width: 120, height: 40, kittyKeyboard: true },
);
const render = () => settle(setup.renderOnce);
const frame = () => setup.captureCharFrame();
const press = async (...keys: string[]) => {
  for (const key of keys) {
    act(() => {
      if (key === "up" || key === "down") setup.mockInput.pressArrow(key);
      else if (key === "escape") setup.mockInput.pressEscape();
      else if (key === "enter") setup.mockInput.pressEnter();
      else setup.mockInput.pressKey(key);
    });
    await render();
  }
};
const controls = () => {
  if (harness.controls === null) throw new Error("no controller");
  return harness.controls;
};
/** `/publish <args>` as the composer hands it over, with the checks answered. */
const publish = async (args: string) => {
  const before = server.calls.length;
  act(() => controls().publish(args, `/publish ${args}`.trim()));
  await render();
  await act(async () => server.answerChecks());
  await render();
  return server.calls.slice(before);
};
const draftText = () => store.getDraft(THREAD_ID).text;
/** Waits out the confirmation's guard, so ⏎ is taken. */
const waitArm = async () => {
  await act(() => new Promise((resolve) => setTimeout(resolve, PUBLISH_ARM_MS + 100)));
  await render();
};
const published = () => server.calls.filter((call) => call.startsWith("publish"));
const clearComposer = () => act(() => store.clearDraft(THREAD_ID));
await render();

// SC1: the Source Control view scans, then lists tools and providers with sign-in state.
act(() => harness.setSourceControlOpen(true));
await render();
check(
  "SC1: scanning before the first answer",
  frame().includes("Scanning git and hosting providers…"),
  true,
);
act(() => server.showDiscovery(AsyncResult.success(discoveryResult())));
await render();
const view = frame();
check("SC1: git and its version", view.includes("Git  git version 2.50.1"), true);
check("SC1: jj is coming soon", view.includes("Jujutsu  Coming soon"), true);
check("SC1: providers counted", view.includes("1/3 signed in"), true);
check("SC1: GitHub flagged", view.includes("GitHub  gh version 2.83.0  Not authenticated"), true);
check(
  "SC1: GitHub sign-in instructions",
  view.includes("Sign in with `gh auth login` on the server host"),
  true,
);
check("SC1: GitHub token instructions", view.includes("Or set GH_TOKEN on the server"), true);
check("SC1: GitLab not installed", view.includes("GitLab  Not installed"), true);
check("SC1: Bitbucket signed in", view.includes("Authenticated as sandbox on bitbucket.org"), true);

// SC2: r scans again; the list stays up while it refreshes.
await press("r");
check("SC2: r asks for a rescan", server.calls.at(-1), "rescan");
check(
  "SC2: refreshing, list kept",
  frame().includes("Refreshing…") && frame().includes("Bitbucket"),
  true,
);

// SC3: a failed scan says so.
await act(async () =>
  server.showDiscovery(AsyncResult.failure(Cause.fail(new Error("scan timed out")))),
);
await render();
check(
  "SC3: scan failure shown",
  frame().includes("Couldn't scan the server: scan timed out"),
  true,
);
await press("escape");
check("SC3: esc closes the view", frame().includes("Source Control"), false);

// P1: validation runs before anything is created, and puts the command back.
let calls = await publish("demo");
check(
  "P1: a lone name asks for its owner",
  harness.footer,
  "Name the repository as workspace/repository",
);
check("P1: the command is back in the composer", draftText(), "/publish demo");
check(
  "P1: notice shown",
  frame().includes("notice: Name the repository as workspace/repository"),
  true,
);
check(
  "P1: nothing looked up or created",
  calls.some((call) => call.startsWith("lookup") || call.startsWith("publish")),
  false,
);
clearComposer();

calls = await publish("octo/app provider=github");
check(
  "P2: a signed-out provider says how to sign in",
  harness.footer.startsWith("GitHub isn't signed in:"),
  true,
);
check("P2: nothing looked up or created", calls.join(","), "discover,remotes /repo");
clearComposer();

calls = await publish("group/app gitlab");
check(
  "P3: a provider that isn't installed",
  harness.footer,
  "GitLab isn't installed: Install the GitLab CLI (glab).",
);
clearComposer();

server.setScan(ok(discoveryResult([discoveryResult().sourceControlProviders[0]!])));
calls = await publish("octo/app");
check(
  "P4: no provider ready",
  harness.footer.startsWith("No source control provider is signed in"),
  true,
);
server.setScan(ok(discoveryResult()));
clearComposer();

calls = await publish("octo/app privat");
check(
  "P5: a typo is caught by the parser, before any scan",
  harness.footer.startsWith('Unknown option "privat"'),
  true,
);
check("P5: no scan for a bad command", calls.length, 0);
clearComposer();

// P6: no repository yet: the account is filled in for you.
calls = await publish("");
check("P6: /publish fills in the account", draftText(), "/publish sandbox/");
check("P6: and says what to type", harness.footer.includes("workspace/repository"), true);
clearComposer();

// P7: a taken name is caught by reading it back; nothing is created.
calls = await publish("sandbox/taken");
check("P7: looked up", calls.includes("lookup bitbucket sandbox/taken"), true);
check(
  "P7: taken",
  harness.footer,
  "bitbucket.org/sandbox/taken already exists. Pick another name.",
);
check(
  "P7: nothing created",
  calls.some((call) => call.startsWith("publish")),
  false,
);
clearComposer();

// P8: a repository that already has a remote isn't published again.
server.setStatus(vcsStatus({ refName: "main" }));
calls = await publish("sandbox/demo");
check(
  "P8: has a remote",
  harness.footer,
  'This repository already has a remote ("origin"). Push from the git menu (c) instead.',
);
server.setStatus(NO_REMOTE);
clearComposer();

// P8b: a remote that isn't origin counts too, even with remote=<another name>.
server.setRemoteRefs([
  {
    name: "upstream/main",
    isRemote: true,
    remoteName: "upstream",
    current: false,
    isDefault: false,
    worktreePath: null,
  },
]);
calls = await publish("sandbox/demo remote=hub");
check(
  "P8b: upstream seen",
  harness.footer,
  'This repository already has a remote ("upstream"). Push from the git menu (c) instead.',
);
check(
  "P8b: nothing looked up or created",
  calls.some((call) => call.startsWith("lookup") || call.startsWith("publish")),
  false,
);
server.setRemoteRefs([]);
clearComposer();

// P8c: Azure DevOps lets the project decide visibility, so it's never offered a "private".
server.setScan(ok(discoveryResult([providerDiscovery("azure-devops", "Azure DevOps")])));
calls = await publish("org/demo");
check(
  "P8c: Azure DevOps blocked",
  harness.footer,
  "Azure DevOps sets visibility per project; tr3x can't confirm this repository will be private. Publish it from Azure DevOps.",
);
check("P8c: no confirmation", frame().includes("Publish to Azure DevOps?"), false);
check(
  "P8c: nothing looked up or created",
  calls.some((call) => call.startsWith("lookup") || call.startsWith("publish")),
  false,
);
server.setScan(ok(discoveryResult()));
clearComposer();

// P9: the confirmation names the repository, its visibility, remote and branch; esc creates nothing.
calls = await publish("sandbox/demo");
let shown = frame();
check("P9: confirmation open", shown.includes("Publish to Bitbucket?"), true);
check("P9: private by default", shown.includes("Creates a private Bitbucket repository:"), true);
check("P9: where", shown.includes("bitbucket.org/sandbox/demo"), true);
check(
  "P9: remote and branch",
  shown.includes('Adds it as remote "origin" (SSH) and pushes main.'),
  true,
);
check(
  "P9: nothing created yet",
  calls.some((call) => call.startsWith("publish")),
  false,
);
await press("escape");
check("P9: esc cancels", frame().includes("Publish to Bitbucket?"), false);
check("P9: and says so", harness.footer, "Publish cancelled; nothing was created");
check(
  "P9: still nothing created",
  server.calls.some((call) => call.startsWith("publish")),
  false,
);

// P10: a public publish says so; ⏎ sends exactly what was confirmed, and the toolbar shows it running.
calls = await publish("sandbox/demo public https remote=hub");
check(
  "P10: public called out",
  frame().includes("Creates a PUBLIC Bitbucket repository anyone can see:"),
  true,
);
await waitArm();
await press("enter");
check(
  "P10: sent as confirmed",
  server.calls.at(-1),
  "publish bitbucket sandbox/demo public https hub",
);
check("P10: toolbar shows it running", frame().includes("Publishing repository"), true);
check("P10: status says where", harness.footer, "Publishing sandbox/demo to Bitbucket…");

// P11: while it runs, another /publish waits.
calls = await publish("sandbox/again");
check("P11: busy", harness.footer, "Wait for the current git action to finish");
check("P11: no second scan", calls.length, 0);
clearComposer();

// P12: a server failure stays in the toolbar; the menu has the whole message.
await act(async () =>
  server.takePublish()?.settle(
    failed(
      new SourceControlRepositoryError({
        provider: discoveryResult().sourceControlProviders[2]!.kind,
        operation: "publishRepository",
        detail: "No bitbucket source control provider is registered.",
      }),
    ),
  ),
);
await render();
check("P12: toolbar shows the failure", frame().includes("✗ Publish failed"), true);
check(
  "P12: footer has the detail",
  harness.footer,
  "Couldn't publish sandbox/demo to Bitbucket: No bitbucket source control provider is registered.",
);
await press("c");
// The menu wraps it: compare without the line breaks and padding.
check(
  "P12: menu shows the whole message",
  frame()
    .replace(/[\s│]+/gu, " ")
    .includes("✗ Publish failed: No bitbucket source control provider is registered."),
  true,
);

// P13: the menu leads with publishing a repository without a remote; ⏎ fills in the command.
check("P13: menu offers publish", frame().includes("Publish repository…"), true);
await press("enter");
await act(async () => server.answerChecks());
await render();
check("P13: menu fills in the command", draftText(), "/publish sandbox/");
clearComposer();

// P14: a publish that lands: the result names repository, branch and remote, and the toolbar
// picks up the new remote and upstream.
calls = await publish("sandbox/demo");
await waitArm();
await press("enter");
check("P14: toolbar before: no remote", frame().includes("no remote"), true);
server.setStatus(vcsStatus({ refName: "main" }));
await act(async () =>
  server.takePublish()?.settle(
    ok({
      repository: repository("sandbox/demo"),
      remoteName: "origin",
      remoteUrl: "git@bitbucket.org:sandbox/demo.git",
      branch: "main",
      upstreamBranch: "origin/main",
      status: "pushed",
    }),
  ),
);
await render();
check("P14: result line", harness.footer, "Published sandbox/demo on Bitbucket · main → origin");
check(
  "P14: toolbar picked up the remote",
  frame().includes("≡ up to date") && !frame().includes("no remote"),
  true,
);
check("P14: failure cleared", frame().includes("✗ Publish failed"), false);
server.setStatus(NO_REMOTE);
act(() => server.showStatus(NO_REMOTE));
await render();

// P15: moving to another thread while the check runs drops the publish.
const before = server.calls.length;
act(() => controls().publish("sandbox/demo", "/publish sandbox/demo"));
await render();
act(() => harness.setThread(OTHER_THREAD_ID));
await render();
await act(async () => server.answerChecks());
await render();
check("P15: dropped", harness.footer, "Publish stopped: the thread changed while checking");
check("P15: no confirmation", frame().includes("Publish to Bitbucket?"), false);
check(
  "P15: nothing looked up or created",
  server.calls.slice(before).join(","),
  "discover,remotes /repo",
);

// P16: checks that finish under the Source Control view leave the confirmation waiting, undrawn;
// ⏎ goes to the view on top. Once shown, ⏎ is taken only after PUBLISH_ARM_MS.
const sentBeforeHidden = published().length;
act(() => harness.setThread(THREAD_ID));
await render();
act(() => controls().publish("sandbox/hidden public", "/publish sandbox/hidden public"));
await render();
act(() => harness.setSourceControlOpen(true));
await render();
await act(async () => server.answerChecks());
await render();
check(
  "P16: confirmation not drawn under the view",
  frame().includes("Publish to Bitbucket?"),
  false,
);
await press("enter");
await waitArm();
await press("enter");
check("P16: ⏎ under the view publishes nothing", published().length, sentBeforeHidden);
await press("escape");
check("P16: shown once the view closes", frame().includes("Publish to Bitbucket?"), true);
await press("enter");
check("P16: ⏎ as it appears publishes nothing", published().length, sentBeforeHidden);
check(
  "P16: still open after that ⏎",
  frame().includes("Creates a PUBLIC Bitbucket repository"),
  true,
);
await waitArm();
await press("enter");
check(
  "P16: ⏎ once shown long enough publishes",
  published().at(-1),
  "publish bitbucket sandbox/hidden public ssh origin",
);
await act(async () => server.takePublish()?.settle(failed(new Error("not this time"))));
await render();

// P17: `/publish …` and ⏎⏎ in one chunk: the first sends the command, the second can't confirm.
server.setHoldChecks(false);
const sentBefore = published().length;
act(() => store.setDraftText(THREAD_ID, "/publish sandbox/burst public"));
await render();
await act(async () => {
  setup.renderer.stdin.emit("data", Buffer.from("\r\r"));
});
await render();
check("P17: confirmation open", frame().includes("bitbucket.org/sandbox/burst"), true);
await act(async () => {
  setup.renderer.stdin.emit("data", Buffer.from("\r"));
});
await render();
check("P17: no ⏎ in flight publishes", published().length, sentBefore);
await press("escape");
server.setHoldChecks(true);
// Without the guard a publish went out here; let it fail so P18 runs on its own.
await act(async () => server.takePublish()?.settle(failed(new Error("not this time"))));
await render();

// P18: switching threads drops an open confirmation for good, and a plan kept from before is
// refused: nothing is sent for /repo while /other is in view.
calls = await publish("sandbox/stale");
const stale = controls().overlay;
check("P18: confirmation open", stale?.kind, "publish");
act(() => harness.setThread(OTHER_THREAD_ID));
await render();
check("P18: dropped on switch", frame().includes("Publish to Bitbucket?"), false);
check(
  "P18: and says so",
  harness.footer,
  "Publish cancelled: the thread changed; nothing was created",
);
if (stale?.kind === "publish") act(() => controls().confirmPublish(stale.plan));
await render();
check("P18: a kept plan isn't sent", published().length, sentBefore);
check("P18: refused", harness.footer, "Publish stopped: the thread changed; nothing was created");
act(() => harness.setThread(THREAD_ID));
await render();
check("P18: not back on return", frame().includes("Publish to Bitbucket?"), false);

setup.renderer.destroy();
if (failures > 0) {
  console.error(`${failures} publish check(s) failed`);
  process.exit(1);
}
console.log("all publish checks passed: SC1–SC3, P1–P18");
process.exit(0);
