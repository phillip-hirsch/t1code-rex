import {
  OrchestrationV2ProjectedTurnItemJson,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Wire-shaped turn items for tests, decoded with the contracts schema like the live stream. */

export const TEST_THREAD_ID = "thread-test";
const decodeProjected = Schema.decodeUnknownSync(OrchestrationV2ProjectedTurnItemJson);

export function turnItem(
  id: string,
  fields: Record<string, unknown>,
  position = 0,
): OrchestrationV2ProjectedTurnItem {
  return decodeProjected({
    position,
    visibility: "local",
    sourceThreadId: TEST_THREAD_ID,
    sourceItemId: id,
    item: {
      id,
      threadId: TEST_THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      status: "completed",
      title: null,
      startedAt: "2026-06-20T10:00:00.000Z",
      completedAt: null,
      updatedAt: "2026-06-20T10:00:00.000Z",
      ...fields,
    },
  });
}

export function userMessage(id: string, text: string, extra: Record<string, unknown> = {}) {
  return turnItem(id, {
    type: "user_message",
    messageId: `msg-${id}`,
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    ...extra,
  });
}

export function assistantMessage(id: string, text: string, streaming = false) {
  return turnItem(id, {
    type: "assistant_message",
    messageId: `msg-${id}`,
    text,
    streaming,
    status: streaming ? "running" : "completed",
  });
}

export function command(id: string, input: string, extra: Record<string, unknown> = {}) {
  return turnItem(id, { type: "command_execution", input, ...extra });
}
