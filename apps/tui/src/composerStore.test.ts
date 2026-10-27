import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerSend } from "./composerSend.ts";
import type { ComposerSettings } from "./composerSettings.ts";
import { createComposerStore, mergeRestoredText } from "./composerStore.ts";
import type { TuiPrefs, TuiPrefsPatch } from "./prefs.ts";

const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const image = {
  id: "img-1",
  type: "image" as const,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,AAA=",
};

function setup(initialPrefs: TuiPrefs = {}, saves = true) {
  const writes: TuiPrefsPatch[] = [];
  // A long delay, so only flush() writes and nothing waits on a clock.
  const store = createComposerStore({
    initialPrefs,
    persist: saves ? (patch) => writes.push(patch) : null,
    persistDelayMs: 60_000,
  });
  return { store, writes };
}

function sendFor(threadId: string, text: string): ComposerSend {
  return {
    target: { kind: "thread", threadId: ThreadId.make(threadId), projectId: ProjectId.make("p") },
    commandId: CommandId.make(`cmd-${text}`),
    messageId: MessageId.make(`msg-${text}`),
    text,
    attachments: [image],
    dispatch: "auto",
    settings,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
}

describe("composer drafts", () => {
  it("saves drafts per thread and drops empty ones", () => {
    const { store, writes } = setup();
    store.setDraftText("t1", "half a thought");
    store.addAttachment("t1", image);
    store.setDraftText("t2", "x");
    store.setDraftText("t2", "");
    store.flush();
    expect(writes).toEqual([
      {
        composerDraftsByThreadId: {
          t1: { text: "half a thought", attachments: [image] },
        },
      },
    ]);
    store.clearDraft("t1");
    store.flush();
    expect(writes.at(-1)).toEqual({ composerDraftsByThreadId: undefined });
  });

  it("restores saved drafts and new-thread drafts after a restart", () => {
    const { store } = setup({
      composerDraftsByThreadId: { t1: { text: "saved", attachments: [image] } },
      draftThreadsByProjectId: { p: { id: "new-1", projectId: "p" } },
    });
    expect(store.getDraft("t1")).toEqual({ text: "saved", attachments: [image] });
    expect(store.findNewThreadDraft("new-1")).toEqual({ threadId: "new-1", projectId: "p" });
  });

  it("keeps drafts in memory only in windows that don't save prefs", () => {
    const { store, writes } = setup({}, false);
    store.setDraftText("t1", "typed in a thread tab");
    store.flush();
    expect(writes).toEqual([]);
    expect(store.getDraft("t1").text).toBe("typed in a thread tab");
  });

  it("notifies a thread's composer only for what it shows, not for typing", () => {
    const { store } = setup();
    let calls = 0;
    const unsubscribe = store.subscribeThread("t1", () => (calls += 1));
    const before = store.snapshot("t1");
    store.setDraftText("t1", "typing");
    expect(calls).toBe(0);
    expect(store.snapshot("t1")).toBe(before);
    store.addAttachment("t1", image);
    expect(calls).toBe(1);
    store.addAttachment("t2", image);
    expect(calls).toBe(1);
    unsubscribe();
  });
});

describe("new-thread drafts", () => {
  it("reuses a project's open draft until it launches", () => {
    const { store, writes } = setup();
    let minted = 0;
    const mint = () => ThreadId.make(`new-${(minted += 1)}`);
    const first = store.openNewThreadDraft(ProjectId.make("p"), mint);
    expect(store.openNewThreadDraft(ProjectId.make("p"), mint)).toBe(first);
    store.flush();
    expect(writes.at(-1)).toEqual({
      draftThreadsByProjectId: { p: { id: "new-1", projectId: "p" } },
    });
    store.closeNewThreadDraft("new-1");
    store.flush();
    expect(writes.at(-1)).toEqual({ draftThreadsByProjectId: undefined });
    expect(store.openNewThreadDraft(ProjectId.make("p"), mint).threadId).toBe("new-2");
  });
});

describe("settings picks", () => {
  it("keeps a thread's pick for its next run and makes it the new default", () => {
    const { store, writes } = setup();
    const picked = store.pickSettings("t1", "thread", settings, { interactionMode: "plan" });
    expect(picked.interactionMode).toBe("plan");
    expect(store.getPatch("t1")).toEqual({ interactionMode: "plan" });
    store.pickSettings("t1", "thread", settings, { interactionMode: "default" });
    expect(store.getPatch("t1")).toBeUndefined();
    store.flush();
    expect(writes.at(-1)).toEqual({
      draftProviderInstanceId: "codex",
      draftModel: "gpt-5.5",
      draftRuntimeMode: "full-access",
      draftInteractionMode: "default",
    });
  });

  it("only moves the default for a new-thread draft", () => {
    const { store } = setup();
    store.pickSettings("new-1", "draft", settings, { runtimeMode: "approval-required" });
    expect(store.getPatch("new-1")).toBeUndefined();
    expect(store.getDefaults().draftRuntimeMode).toBe("approval-required");
  });
});

describe("sends", () => {
  it("hands a rejected send back to the composer, ahead of newer text", () => {
    const { store } = setup();
    const rejected = sendFor("t1", "first");
    store.beginSend(rejected);
    store.setDraftText("t1", "second");
    store.restoreSend(rejected, "Model not available");
    expect(store.getDraft("t1")).toEqual({ text: "first\n\nsecond", attachments: [image] });
    const snapshot = store.snapshot("t1");
    expect(snapshot.sends).toEqual([]);
    expect(snapshot.notice).toBe("Model not available");
    expect(snapshot.textRevision).toBe(1);
  });

  it("joins restored text with what was typed since", () => {
    expect(mergeRestoredText("a", "")).toBe("a");
    expect(mergeRestoredText("", "b")).toBe("b");
    expect(mergeRestoredText("a", "b")).toBe("a\n\nb");
  });
});
