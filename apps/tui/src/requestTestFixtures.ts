import {
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { RequestQueueSource } from "./requestQueue.ts";

/** Wire-shaped requests, nodes and items for tests, decoded with the contracts schemas. */

export const REQUEST_THREAD_ID = "thread-requests";
const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequestJson);
const decodeNode = Schema.decodeUnknownSync(OrchestrationV2ExecutionNodeJson);
const decodeSubagent = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

function at(second: number): string {
  return `2026-06-20T10:00:${String(second).padStart(2, "0")}.000Z`;
}

export function runtimeRequest(
  id: string,
  kind: string,
  fields: { second?: number; status?: string; capability?: Record<string, unknown> } = {},
): OrchestrationV2RuntimeRequest {
  return decodeRequest({
    id,
    nodeId: `node-${id}`,
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: fields.status ?? "pending",
    responseCapability: fields.capability ?? {
      type: "live",
      providerSessionId: "session-1",
      ...(kind === "user_input" ? {} : { supportsFeedback: true }),
    },
    createdAt: at(fields.second ?? 0),
    resolvedAt: null,
  });
}

export function node(
  id: string,
  kind: string,
  parentNodeId: string | null,
): OrchestrationV2ExecutionNode {
  return decodeNode({
    id,
    threadId: REQUEST_THREAD_ID,
    runId: null,
    parentNodeId,
    rootNodeId: "node-root",
    kind,
    status: "waiting",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: null,
    completedAt: null,
  });
}

export function subagent(id: string, title: string | null, prompt = ""): OrchestrationV2Subagent {
  return decodeSubagent({
    id,
    threadId: REQUEST_THREAD_ID,
    runId: null,
    parentNodeId: "node-root",
    origin: "provider_native",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt,
    title,
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at(0),
  });
}

export function item(
  id: string,
  nodeId: string | null,
  fields: Record<string, unknown>,
): OrchestrationV2TurnItem {
  return decodeItem({
    id,
    threadId: REQUEST_THREAD_ID,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting",
    title: null,
    startedAt: at(0),
    completedAt: null,
    updatedAt: at(0),
    ...fields,
  });
}

export function approvalItem(requestId: string, fields: Record<string, unknown> = {}) {
  return item(`item-${requestId}`, `node-${requestId}`, {
    type: "approval_request",
    requestId,
    requestKind: "command",
    ...fields,
  });
}

export function questionItem(
  requestId: string,
  questions: ReadonlyArray<Record<string, unknown>>,
  fields: Record<string, unknown> = {},
) {
  return item(`item-${requestId}`, `node-${requestId}`, {
    type: "user_input_request",
    requestId,
    questions,
    ...fields,
  });
}

export function question(
  id: string,
  options: ReadonlyArray<string>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: options.map((label) => ({ label, description: `About ${label}` })),
    ...fields,
  };
}

export function source(fields: Partial<RequestQueueSource>): RequestQueueSource {
  return { runtimeRequests: [], turnItems: [], nodes: [], subagents: [], ...fields };
}
