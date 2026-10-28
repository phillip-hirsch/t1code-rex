import {
  ContextHandoffId,
  ProviderInstanceId,
  ProviderThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../testing/serverProvider.ts";
import { FIXTURE_THREAD_ID } from "../testing/viewFixture.ts";
import { handoffRow } from "./timeline.ts";

const model = (slug: string, name: string) => ({ slug, name, isCustom: false, capabilities: null });
const claude = provider("claudeAgent", {
  driver: "claudeAgent",
  displayName: "Claude",
  models: [model("claude-opus-5-5", "Claude Opus 5.5")],
});
// A second Grok account the user named, as `providerInstances` allows.
const grokB = provider("grokB", {
  driver: "grok",
  displayName: "Grok B",
  models: [model("grok-4.6", "Grok 4.6")],
});

function handoff(
  from: string,
  fromModel: string,
  to: string,
  toModel: string,
): OrchestrationV2ProjectedTurnItem {
  const now = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
  const id = TurnItemId.make("handoff-1");
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: FIXTURE_THREAD_ID,
    sourceItemId: id,
    item: {
      id,
      threadId: FIXTURE_THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "handoff",
      contextHandoffId: ContextHandoffId.make("context-handoff-1"),
      fromProviderThreadIds: [ProviderThreadId.make("provider-thread-a")],
      toProviderThreadId: ProviderThreadId.make("provider-thread-b"),
      fromProviderInstanceIds: [ProviderInstanceId.make(from)],
      toProviderInstanceId: ProviderInstanceId.make(to),
      fromModelSelections: [{ instanceId: ProviderInstanceId.make(from), model: fromModel }],
      toModel,
      strategy: "full_thread_summary",
    },
  };
}

describe("handoffRow", () => {
  it("names each side by provider and the model's short name, as web does", () => {
    expect(
      handoffRow(
        handoff("grokB", "grok-4.6", "claudeAgent", "claude-opus-5-5"),
        [],
        [claude, grokB],
      ),
    ).toMatchObject({
      kind: "divider",
      text: "Context handoff: Grok B · Grok 4.6 → Claude · Opus 5.5",
    });
  });

  it("falls back to the instance and model ids the server sent", () => {
    expect(
      handoffRow(handoff("gone", "old-model", "claudeAgent", "claude-opus-5-5"), [], [claude]),
    ).toMatchObject({
      text: "Context handoff: gone · old-model → Claude · Opus 5.5",
    });
  });
});
