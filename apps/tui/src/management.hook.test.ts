import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
  type OrchestrationProjectShell,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerSend } from "./composerSend.ts";
import { createComposerSender, type ComposerCommandResult } from "./composerSender.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore } from "./composerStore.ts";
import type { TuiActionResult } from "./connection/tuiConnection.ts";
import { renderHook } from "./hookTestRenderer.ts";
import type { T1Logger } from "./log.ts";
import { useManagement, type ManagementConnection } from "./management.ts";
import type { TuiPrefs } from "./prefs.ts";
import { presentedThread, projectShell, threadRow } from "./shellTestFixtures.ts";
import { useSidebarController } from "./sidebarController.ts";

const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

function send(threadId: string, id: string, text: string): ComposerSend {
  return {
    target: { kind: "thread", threadId: ThreadId.make(threadId), projectId: ProjectId.make("p") },
    commandId: CommandId.make(`cmd-${id}`),
    messageId: MessageId.make(`msg-${id}`),
    text,
    attachments: [],
    dispatch: "queue",
    settings,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
}

const settle = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const unused = (): Promise<never> => Promise.reject(new Error("not used by this test"));
const done = <A>(value: A): Promise<TuiActionResult<A>> => Promise.resolve({ ok: true, value });

/**
 * The real management and sidebar hooks, the real sender and composer store; the server's
 * side is scripted: archived threads, folder listings, and deletes that succeed.
 */
function setup(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly archived?: TuiActionResult<OrchestrationV2ArchivedShellSnapshot>;
  readonly folders?: Record<string, ReadonlyArray<string>>;
}) {
  const prefs: { current: TuiPrefs } = { current: {} };
  const store = createComposerStore({
    initialPrefs: {},
    persist: (patch) => {
      const next: Record<string, unknown> = { ...prefs.current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      prefs.current = JSON.parse(JSON.stringify(next)) as TuiPrefs;
    },
  });
  const never = new Promise<ComposerCommandResult>(() => undefined);
  const replies: Array<ComposerCommandResult | Promise<ComposerCommandResult>> = [];
  const startTurns: Array<string> = [];
  const sender = createComposerSender({
    store,
    startTurn: (turn) => {
      startTurns.push(turn.commandId ?? "");
      return Promise.resolve(replies.shift() ?? never);
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    resumeQueue: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  const deletedThreads: Array<string> = [];
  const deletedProjects: Array<string> = [];
  const browsed: Array<string> = [];
  const browseAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<FilesystemBrowseResult>>>();
  const connection: ManagementConnection = {
    projectClonesAtom: Atom.make(AsyncResult.initial()),
    browseAtom: (browse: FilesystemBrowseInput) => {
      browsed.push(browse.partialPath);
      const existing = browseAtoms.get(browse.partialPath);
      if (existing) return existing;
      const atom = Atom.make(
        AsyncResult.success({
          parentPath: browse.partialPath,
          entries: (input.folders?.[browse.partialPath] ?? []).map((name) => ({
            name,
            fullPath: `${browse.partialPath}${name}`,
          })),
        }),
      );
      browseAtoms.set(browse.partialPath, atom);
      return atom;
    },
    archiveThread: unused,
    unarchiveThread: unused,
    deleteThread: (thread) => {
      deletedThreads.push(thread.threadId);
      return done({ sequence: 1 });
    },
    refreshArchivedThreads: () => undefined,
    fetchArchivedShellSnapshot: () =>
      Promise.resolve(
        input.archived ?? {
          ok: true,
          value: { schemaVersion: 1, snapshotSequence: 1, projects: [], threads: [] },
        },
      ),
    pinThread: unused,
    unpinThread: unused,
    settleThread: unused,
    unsettleThread: unused,
    updateThreadMetadata: unused,
    openInEditor: unused,
    createProject: unused,
    updateProject: unused,
    deleteProject: (project) => {
      deletedProjects.push(project.projectId);
      return done({ ...projectShell(project.projectId), deletedAt: "2026-10-27T10:00:00.000Z" });
    },
    startProjectClone: unused,
    cloneRepository: unused,
  };
  const registry = AtomRegistry.make();
  const source = {
    projectsAtom: Atom.make(input.projects),
    threadShellsAtom: Atom.make(input.threads),
    hasShellSnapshotAtom: Atom.make(true),
    olderSettledAtom: Atom.make<OrchestrationV2ShellSnapshot["olderSettled"]>(undefined),
  };
  const initialPrefs: TuiPrefs = {};
  const statuses: Array<string> = [];
  const logger: T1Logger = { log: () => undefined };
  const hook = renderHook(() => {
    const sidebar = useSidebarController({
      connection: source,
      initialPrefs,
      prefsWriter: null,
      launch: null,
      cwd: "/nowhere",
    });
    return useManagement({
      connection,
      sidebar,
      serverConfig: null,
      composerStore: store,
      sender,
      logger,
      setStatus: (status) => statuses.push(status),
      openNewThread: () => undefined,
    });
  }, registry);
  cleanups.push(() => {
    hook.unmount();
    sender.dispose();
    registry.dispose();
  });
  return {
    hook,
    store,
    sender,
    prefs,
    replies,
    startTurns,
    deletedThreads,
    deletedProjects,
    browsed,
    statuses,
  };
}

describe("thread and project management, PR 15 Sol audit round 1", () => {
  it("S1: deleting a thread with a held message says so, and quit then saves nothing for it", async () => {
    const { hook, store, sender, prefs, replies, deletedThreads } = setup({
      projects: [projectShell("p")],
      threads: [presentedThread("t1", "p")],
    });
    replies.push({ ok: true });
    await sender.send(send("t1", "1", "first"));
    void sender.send(send("t1", "2", "held"));
    sender.hold("t1");
    await settle();
    expect(sender.pendingCount({ threadIds: ["t1"] })).toBe(1);

    hook.act(() => hook.current.requestDelete(["t1"]));
    expect(hook.current.confirm?.steps[0]?.body).toBe(
      "This permanently clears the thread's conversation history. 1 unsent message is discarded too.",
    );
    await hook.actAsync(async () => {
      hook.current.pressConfirm("confirm");
      await settle();
    });
    expect(deletedThreads).toEqual(["t1"]);
    expect(sender.pendingCount()).toBe(0);
    expect(store.snapshot("t1").sends).toEqual([]);

    sender.handOff();
    store.flush();
    expect(prefs.current.composerDraftsByThreadId).toBeUndefined();
    expect(prefs.current.composerUnconfirmedSends).toBeUndefined();
  });

  it("S1: removing a project drops its threads' queued messages and its new-thread draft", async () => {
    const { hook, store, sender, deletedProjects } = setup({
      projects: [projectShell("p")],
      threads: [presentedThread("t1", "p")],
    });
    void sender.send(send("t1", "1", "in flight"));
    const draft = store.openNewThreadDraft(ProjectId.make("p"), () => ThreadId.make("draft-1"));
    store.setDraftText(draft.threadId, "unsent idea");
    await settle();
    await hook.actAsync(() => hook.current.requestRemoveProject("p"));
    expect(hook.current.confirm?.steps.at(-1)?.body).toContain(
      "1 unsent message is discarded too.",
    );
    hook.act(() => hook.current.pressConfirm("confirm"));
    await hook.actAsync(async () => {
      hook.current.pressConfirm("confirm");
      await settle();
    });
    expect(deletedProjects).toEqual(["p"]);
    expect(sender.pendingCount()).toBe(0);
    expect(store.getNewThreadDraft("p")).toBeUndefined();
    expect(store.getDraft("draft-1").text).toBe("");
  });

  it("S6: a project with only archived threads takes both confirm steps", async () => {
    const { hook } = setup({
      projects: [projectShell("p")],
      threads: [],
      archived: {
        ok: true,
        value: {
          schemaVersion: 1,
          snapshotSequence: 1,
          projects: [projectShell("p")],
          threads: [
            threadRow("a1", "p", { archivedAt: threadRow("a1", "p").createdAt }),
            threadRow("a2", "p", { archivedAt: threadRow("a2", "p").createdAt }),
            threadRow("other", "q", { archivedAt: threadRow("other", "q").createdAt }),
          ],
        },
      },
    });
    await hook.actAsync(() => hook.current.requestRemoveProject("p"));
    expect(hook.current.confirm?.steps.map((step) => step.title)).toEqual([
      'Remove project "p"?',
      'Remove project "p" and 2 threads?',
    ]);
  });

  it("S6: when the archived threads can't be counted, it still takes both steps", async () => {
    const { hook } = setup({
      projects: [projectShell("p")],
      threads: [],
      archived: { ok: false, error: new Error("offline"), interrupted: false },
    });
    await hook.actAsync(() => hook.current.requestRemoveProject("p"));
    expect(hook.current.confirm?.steps.map((step) => step.confirmLabel)).toEqual([
      "Continue",
      "Remove project",
    ]);
  });

  it("S6: an empty project, archived threads counted, asks once", async () => {
    const { hook } = setup({ projects: [projectShell("p")], threads: [] });
    await hook.actAsync(() => hook.current.requestRemoveProject("p"));
    expect(hook.current.confirm?.steps.map((step) => step.confirmLabel)).toEqual(["Remove"]);
  });

  it("S7: folder suggestions disappear as soon as the path changes, so a quick Tab can't apply a stale one", async () => {
    const { hook } = setup({
      projects: [],
      threads: [],
      folders: { "/repo/": ["alpha", "beta"], "/repo/alpha/": [] },
    });
    // The prompt waits for a pause in typing before it lists a folder.
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    hook.act(() => hook.current.openAddProject());
    hook.act(() => hook.current.setPromptValue("/repo/"));
    hook.act(() => vi.advanceTimersByTime(100));
    expect(hook.current.suggestions.map((entry) => entry.name)).toEqual(["alpha", "beta"]);

    hook.act(() => hook.current.pickSuggestion(0));
    expect(hook.current.prompt?.value).toBe("/repo/alpha/");
    // Before the pause ends, the listing on screen is still /repo/'s: none of it applies now.
    expect(hook.current.suggestions).toEqual([]);
    hook.act(() => hook.current.pickSuggestion(0));
    expect(hook.current.prompt?.value).toBe("/repo/alpha/");
  });
});
