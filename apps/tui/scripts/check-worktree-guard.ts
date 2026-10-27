// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off nodeBuiltinImport:off -- A Bun check script against a real server; it runs outside the Effect runtime.
/**
 * The worktree guard on a real server: a /tmp repo whose post-checkout hook fails makes a
 * failed worktree preparation, with a run held behind it. Sends and resumes from the sender
 * must start nothing until a retry makes the worktree.  bun apps/tui/scripts/check-worktree-guard.ts
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  buildStartTurnInput,
  createComposerSend,
  type ComposerDispatch,
} from "../src/composerSend.ts";
import { createComposerSender } from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { resolveComposerSlashAction } from "../src/composerSlashCommands.ts";
import { createComposerStore } from "../src/composerStore.ts";
import { createTuiConnection } from "../src/connection/tuiConnection.ts";
import { buildGitMenuItems } from "../src/gitMenu.ts";
import { managedServerSession, startManagedServer } from "../src/serverLauncher.ts";
import { deriveWorktreeLaunch, WORKTREE_FAILED_NOTICE } from "../src/worktreeLaunch.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (want ${String(expected)})`}`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A throwaway repo with a local bare origin; nothing here touches a real remote.
const root = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-wtguard-")),
);
const repo = NodePath.join(root, "repo");
const origin = NodePath.join(root, "origin.git");
const failFlag = NodePath.join(root, "fail-checkout");
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
NodeFS.mkdirSync(repo);
git(root, "init", "-q", "--bare", "-b", "main", origin);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "check@example.com");
git(repo, "config", "user.name", "check");
git(repo, "config", "commit.gpgsign", "false");
NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# guard check\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-q", "origin", "main");
const hook = NodePath.join(repo, ".git", "hooks", "post-checkout");
NodeFS.writeFileSync(
  hook,
  `#!/bin/sh\nif [ -f "${failFlag}" ]; then echo "check: checkout refused" >&2; exit 1; fi\nexit 0\n`,
);
NodeFS.chmodSync(hook, 0o755);

const server = await startManagedServer({
  baseDir: NodePath.join(root, "home"),
  cwd: repo,
  restartOnExit: false,
});
const connection = createTuiConnection({
  session: managedServerSession(server),
  appVersion: "check",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A check script with no Effect runtime to inject it.
  platformOs: NodeOS.platform(),
});
const { registry } = connection;
const mounts = [
  registry.mount(connection.connectionStateAtom),
  registry.mount(connection.shellStateAtom),
  registry.mount(connection.hasShellSnapshotAtom),
  registry.mount(connection.projectsAtom),
];

type Projection = OrchestrationV2ThreadProjection;

/** Keeps the thread live and waits for its projection to satisfy `ready`. */
async function waitFor(
  threadId: ThreadId,
  label: string,
  ready: (projection: Projection) => boolean,
  timeoutMs = 90_000,
): Promise<Projection> {
  const atom = connection.thread(threadId).stateAtom;
  const unmount = registry.mount(atom);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = registry.get(atom);
      const projection = Option.getOrNull(state.data);
      if (state.status === "live" && projection !== null && ready(projection)) return projection;
      await sleep(100);
    }
    const last = Option.getOrNull(registry.get(atom).data);
    throw new Error(
      `Timed out waiting for ${label}: worktree ${last?.thread.worktreePath ?? null}, runs ${JSON.stringify(
        last?.runs.map((run) => [run.ordinal, run.status, run.queueHeld ?? false]),
      )}, errors ${JSON.stringify(
        last?.turnItems.flatMap((item) => (item.type === "error" ? [item.failure.message] : [])),
      )}`,
    );
  } finally {
    // Unmounted a beat later, so the next wait reuses the live subscription.
    setTimeout(unmount, 2_000);
  }
}

const CODEX_FAILING: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "no-such-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
// The thread that gets retried runs for real, so the runs held behind it can follow.
const HAIKU: ComposerSettings = {
  ...CODEX_FAILING,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
};
const OK_PROMPT = "Reply with the single word ok and nothing else. Do not use any tools.";
let settings = CODEX_FAILING;
let projectId = ProjectId.make("pending");

const message = (threadId: ThreadId, text: string, dispatch: ComposerDispatch, draft = false) =>
  createComposerSend({
    target: { kind: draft ? "draft" : "thread", threadId, projectId },
    text,
    attachments: [],
    dispatch,
    settings,
    ...(draft
      ? { worktree: { projectCwd: repo, baseBranch: "main", startFromOrigin: false } }
      : {}),
  });

/** Sends straight to the server, as another client could. */
async function sendDirect(threadId: ThreadId, text: string, dispatch: ComposerDispatch) {
  const result = await connection.startTurn(buildStartTurnInput(message(threadId, text, dispatch)));
  if (!result.ok) throw new Error(`send failed: ${String(result.error)}`);
}

/** Launches a new thread into a new worktree, which the failing hook breaks. */
async function launchFailedWorktreeThread(text: string): Promise<{
  threadId: ThreadId;
  projection: Projection;
}> {
  NodeFS.writeFileSync(failFlag, "");
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const result = await connection.startTurn(
    buildStartTurnInput(message(threadId, text, "steer", true)),
  );
  if (!result.ok) throw new Error(`launch failed: ${String(result.error)}`);
  const projection = await waitFor(
    threadId,
    "the failed preparation",
    (p) => deriveWorktreeLaunch(p)?.status === "failed",
  );
  return { threadId, projection };
}

const heldRuns = (p: Projection) =>
  p.runs.filter((run) => run.status === "queued" && run.queueHeld === true);
const userMessages = (p: Projection) => p.messages.filter((m) => m.role === "user").length;

try {
  // Connected once the shell's first snapshot is in.
  for (let tries = 0; !registry.get(connection.hasShellSnapshotAtom); tries += 1) {
    if (tries > 600) throw new Error("Timed out connecting to the server");
    await sleep(100);
  }
  // The server adds its launch folder (the repo) as a project.
  const project = registry
    .get(connection.projectsAtom)
    .find((candidate) => candidate.workspaceRoot === repo);
  if (project === undefined) throw new Error("The server has no project for the repo");
  projectId = project.id;

  // Control: what the server does on its own after a failed preparation.
  {
    const { threadId } = await launchFailedWorktreeThread("control: add a farewell helper");
    await sendDirect(threadId, "control: queued", "queue");
    const held = await waitFor(threadId, "a held run", (p) => heldRuns(p).length === 1);
    check("control: the server holds a queued message", heldRuns(held).length, 1);
    await sendDirect(threadId, "control: steer", "steer");
    const steered = await waitFor(threadId, "the steer's run", (p) =>
      p.runs.some((run) => run.status !== "queued" && run.workspacePreparation === undefined),
    );
    check(
      "control: but starts a steer at once, with no worktree",
      steered.thread.worktreePath,
      null,
    );
    const resumed = await connection.resumeQueue({ threadId });
    check("control: and accepts queue.resume", resumed.ok, true);
    const released = await waitFor(threadId, "the released run", (p) => heldRuns(p).length === 0);
    check(
      "control: which releases the held run, with no worktree",
      released.thread.worktreePath,
      null,
    );
  }

  // The TUI's sender with the connection's guard, as the shell wires it. It knows nothing of
  // which thread is selected: the guard watches every thread it has jobs for.
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  const sender = createComposerSender({
    store,
    startTurn: connection.startTurn,
    setRuntimeMode: connection.setRuntimeMode,
    setInteractionMode: connection.setInteractionMode,
    resumeQueue: connection.resumeQueue,
    guardWorkspace: connection.guardWorkspace,
    threadSettings: () => settings,
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });

  settings = HAIKU;
  const { threadId } = await launchFailedWorktreeThread(OK_PROMPT);
  await sendDirect(threadId, OK_PROMPT, "queue");
  const before = await waitFor(threadId, "a held run", (p) => heldRuns(p).length === 1);
  check("S3: a real run is held behind the failed preparation", heldRuns(before).length, 1);
  const heldRunId = heldRuns(before)[0]?.id;

  // S1: a steer from the sender, the case the server starts at once.
  const steer = message(threadId, "steer after the failure", "steer");
  await sender.send(steer);
  await sleep(1_500);
  const afterSteer = await waitFor(threadId, "the thread", () => true);
  check("S1: the steer never reaches the server", userMessages(afterSteer), userMessages(before));
  check("S1: no run starts", afterSteer.runs.length, before.runs.length);
  check("S1: the text is back in the composer", store.getDraft(threadId).text, steer.text);
  check("S1: with the reason", store.snapshot(threadId).notice, WORKTREE_FAILED_NOTICE);

  // S2: /resume, which would issue queue.resume and release the held run.
  store.setNotice(threadId, null);
  sender.resume(threadId);
  await sleep(1_500);
  const afterResume = await waitFor(threadId, "the thread", () => true);
  check("S2: the held run stays held", heldRuns(afterResume)[0]?.id, heldRunId);
  check("S2: resume says why", store.snapshot(threadId).notice, WORKTREE_FAILED_NOTICE);
  check("S2: and leaves nothing pending", sender.pendingCount(), 0);

  // S3: there's no "work locally" any more; the server has no way to resolve to it.
  check(
    "S3: /worktree local is gone",
    resolveComposerSlashAction("/worktree local")?.type,
    "error",
  );
  check(
    "S3: the menu offers only retry",
    buildGitMenuItems({ status: null, busy: false, commitModelLabel: "x", setupFailed: true })
      .filter((item) => item.id.startsWith("setup-"))
      .map((item) => item.id)
      .join(","),
    "setup-retry",
  );

  // S3: retry with the hook fixed makes the worktree; the server releases the held run, in order.
  NodeFS.rmSync(failFlag);
  const launch = deriveWorktreeLaunch(afterResume);
  const retried = await connection.retryWorkspacePreparation({
    threadId,
    runId: launch!.runId,
  });
  check("S3: retry is accepted", retried.ok, true);
  const ready = await waitFor(
    threadId,
    "the worktree, and the launch's run to end",
    (p) =>
      p.thread.worktreePath !== null &&
      ["completed", "failed", "interrupted"].includes(
        p.runs.find((run) => run.id === launch!.runId)?.status ?? "",
      ),
  );
  check("S3: the retry made the worktree", ready.thread.worktreePath !== null, true);
  check(
    "S3: and the launch's run started in it",
    ready.runs.find((run) => run.id === launch!.runId)?.startedAt != null,
    true,
  );
  // The retry let the held run follow the launch's run again, and it does, in order.
  const followed = await waitFor(threadId, "the held run to follow", (p) =>
    ["completed", "failed"].includes(p.runs.find((run) => run.id === heldRunId)?.status ?? ""),
  );
  const first = followed.runs.find((run) => run.id === launch!.runId);
  const held = followed.runs.find((run) => run.id === heldRunId);
  check("S3: the launch's run completed", first?.status, "completed");
  check("S3: the held run went out after it", held?.status, "completed");
  check(
    "S3: in order",
    first?.completedAt != null &&
      held?.startedAt != null &&
      DateTime.toEpochMillis(held.startedAt) >= DateTime.toEpochMillis(first.completedAt),
    true,
  );
  check("S3: in the worktree", followed.thread.worktreePath, ready.thread.worktreePath);
  const guard = connection.guardWorkspace(threadId);
  check("S3: the guard lets sends through now", guard.blockedReason(), null);
  guard.dispose();
  const next = message(threadId, OK_PROMPT, "queue");
  await sender.send(next);
  const afterNext = await waitFor(threadId, "the next message", (p) =>
    p.messages.some((m) => m.id === next.messageId),
  );
  check(
    "S3: and the next send goes out",
    afterNext.messages.some((m) => m.id === next.messageId),
    true,
  );
  await waitFor(threadId, "the thread to settle", (p) =>
    p.runs.every((run) => ["completed", "failed", "interrupted", "cancelled"].includes(run.status)),
  );
  sender.dispose();
} catch (error) {
  failures += 1;
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const unmount of mounts) unmount();
  server.stop();
  await new Promise((resolve) => {
    if (server.process.exitCode !== null) resolve(undefined);
    else server.process.once("exit", resolve);
  });
  NodeFS.rmSync(root, { recursive: true, force: true });
  // Claude Code keeps a transcript dir per cwd; drop the ones this run's paths made, again
  // a moment later in case an agent was still writing as the server stopped.
  const claudeProjects = NodePath.join(NodeOS.homedir(), ".claude", "projects");
  const ownPrefix = `${root.replace(/[^a-zA-Z0-9]/g, "-")}-`;
  for (const pass of [0, 1]) {
    if (pass > 0) await sleep(2_000);
    const entries = NodeFS.existsSync(claudeProjects) ? NodeFS.readdirSync(claudeProjects) : [];
    for (const entry of entries.filter((name) => name.startsWith(ownPrefix))) {
      NodeFS.rmSync(NodePath.join(claudeProjects, entry), { recursive: true, force: true });
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall worktree guard checks passed");
process.exit(0);
