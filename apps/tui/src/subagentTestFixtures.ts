import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  OrchestrationV2SubagentJson,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { presentedThread } from "./shellTestFixtures.ts";
import { turnItem } from "./turnItemTestFixtures.ts";

/** Wire-shaped subagent records, items and child threads for tests, decoded like the stream. */

const decodeSubagent = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);

export function subagentRecord(
  id: string,
  fields: Record<string, unknown> = {},
): OrchestrationV2Subagent {
  return decodeSubagent({
    id,
    threadId: "parent",
    runId: "run-1",
    parentNodeId: "node-root",
    origin: "provider_native",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    providerThreadId: null,
    childThreadId: `child-${id}`,
    nativeTaskRef: { driver: "claudeAgent", strength: "strong", nativeId: `task-${id}` },
    prompt: "List the files",
    title: "List files",
    model: "claude-haiku-5-5",
    status: "running",
    result: null,
    startedAt: "2026-06-20T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-06-20T10:00:05.000Z",
    ...fields,
  });
}

export function subagentItem(id: string, fields: Record<string, unknown> = {}, position = 0) {
  return turnItem(
    id,
    {
      type: "subagent",
      threadId: "parent",
      subagentId: `sub-${id}`,
      origin: "provider_native",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      childThreadId: `child-${id}`,
      prompt: "List the files",
      result: null,
      title: "List files",
      status: "running",
      ...fields,
    },
    position,
  );
}

/** A subagent child of `parentId`; provider-native unless `creationSource` says otherwise. */
export function childThread(
  id: string,
  projectId: string,
  parentId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): EnvironmentThreadShell {
  return presentedThread(id, projectId, {
    lineage: {
      rootThreadId: ThreadId.make(parentId),
      parentThreadId: ThreadId.make(parentId),
      relationshipToParent: "subagent",
    },
    creationSource: "provider",
    createdBy: "agent",
    ...overrides,
  });
}
