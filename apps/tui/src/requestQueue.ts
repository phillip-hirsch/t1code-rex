import {
  derivePendingThreadRequests,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";

/** What an approval would let the agent do, read from the tool call it gates. */
export type ApprovalSubject =
  | { readonly type: "command"; readonly command: string }
  | {
      readonly type: "files";
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly additions?: number;
        readonly deletions?: number;
      }>;
    };

/** The run a request belongs to, and whether that run is over (stopped, failed or done). */
export interface RequestRun {
  readonly runId: RunId | null;
  readonly runEnded: boolean;
}

export type PendingRequest = RequestRun &
  (
    | {
        readonly kind: "approval";
        readonly requestId: RuntimeRequestId;
        readonly createdAt: string;
        readonly approval: ThreadPendingApproval;
        readonly subject: ApprovalSubject | null;
        /** Set when a native subagent of this thread asked. */
        readonly subagent: string | null;
      }
    | {
        readonly kind: "question";
        readonly requestId: RuntimeRequestId;
        readonly createdAt: string;
        readonly input: ThreadPendingUserInput;
        readonly subagent: string | null;
      }
  );

/** The slice of a thread projection the queue reads. */
export interface RequestQueueSource {
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly turnItems: ReadonlyArray<ThreadTurnItemLike>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
}

/** Run statuses that can still use an answer. */
const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Client-runtime's structure strips streamed text from some items; the queue never reads it. */
type ThreadTurnItemLike = Parameters<typeof derivePendingThreadRequests>[0]["turnItems"][number];

const SUBAGENT_LABEL_MAX = 48;
const NODE_DEPTH_MAX = 32;

export const NO_PENDING_REQUESTS: ReadonlyArray<PendingRequest> = [];

function flatten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function subjectOf(item: ThreadTurnItemLike | undefined): ApprovalSubject | null {
  if (item?.type === "command_execution" && item.input.trim().length > 0) {
    return { type: "command", command: item.input };
  }
  if (item?.type === "file_change") {
    const paths = item.changes?.map((change) => change.path) ?? [];
    const files =
      paths.length > 1
        ? paths.map((path) => ({ path }))
        : [
            {
              path: paths[0] ?? item.fileName,
              ...(item.additions === undefined ? {} : { additions: item.additions }),
              ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
            },
          ];
    return { type: "files", files };
  }
  return null;
}

/**
 * Every request the thread waits on, oldest first: approvals and questions, each with what
 * it is about. A request asked by one of the thread's native subagents carries its name; it
 * is the thread's own request, so it is answered here.
 */
export function deriveRequestQueue(source: RequestQueueSource): ReadonlyArray<PendingRequest> {
  const { approvals, userInputs } = derivePendingThreadRequests(source);
  if (approvals.length === 0 && userInputs.length === 0) return NO_PENDING_REQUESTS;
  const requestsById = new Map(source.runtimeRequests.map((request) => [request.id, request]));
  const nodesById = new Map(source.nodes.map((node) => [node.id, node]));

  const subagentOf = (requestId: RuntimeRequestId): string | null => {
    let nodeId = requestsById.get(requestId)?.nodeId ?? null;
    for (let depth = 0; nodeId !== null && depth < NODE_DEPTH_MAX; depth += 1) {
      const node = nodesById.get(nodeId);
      if (node === undefined) return null;
      if (node.kind === "subagent") {
        const subagent = source.subagents.find((entry) => entry.id === node.id);
        const label = subagent?.title ?? subagent?.prompt ?? "";
        return label.trim().length > 0 ? flatten(label, SUBAGENT_LABEL_MAX) : "subagent";
      }
      nodeId = node.parentNodeId;
    }
    return null;
  };

  const runOf = (requestId: RuntimeRequestId): RequestRun => {
    let nodeId = requestsById.get(requestId)?.nodeId ?? null;
    for (let depth = 0; nodeId !== null && depth < NODE_DEPTH_MAX; depth += 1) {
      const node = nodesById.get(nodeId);
      if (node === undefined) break;
      if (node.runId !== null) {
        const run = source.runs.find((entry) => entry.id === node.runId);
        return {
          runId: node.runId,
          runEnded: run !== undefined && !LIVE_RUN_STATUSES.has(run.status),
        };
      }
      nodeId = node.parentNodeId;
    }
    return { runId: null, runEnded: false };
  };

  const toolItemOf = (requestId: RuntimeRequestId): ThreadTurnItemLike | undefined => {
    const nodeId = requestsById.get(requestId)?.nodeId;
    const toolNodeId = nodeId === undefined ? null : (nodesById.get(nodeId)?.parentNodeId ?? null);
    if (toolNodeId === null) return undefined;
    return source.turnItems.findLast(
      (item) =>
        item.nodeId === toolNodeId &&
        (item.type === "command_execution" || item.type === "file_change"),
    );
  };

  const queue: Array<PendingRequest> = [
    ...approvals.map((approval): PendingRequest => ({
      kind: "approval",
      requestId: approval.requestId,
      createdAt: approval.createdAt,
      approval,
      subject: subjectOf(toolItemOf(approval.requestId)),
      subagent: subagentOf(approval.requestId),
      ...runOf(approval.requestId),
    })),
    ...userInputs.map((input): PendingRequest => ({
      kind: "question",
      requestId: input.requestId,
      createdAt: input.createdAt,
      input,
      subagent: subagentOf(input.requestId),
      ...runOf(input.requestId),
    })),
  ];
  return queue.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.requestId.localeCompare(right.requestId),
  );
}

export interface ApprovalChoice {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly warning?: string;
  /** The letter that picks it, besides its number. */
  readonly key: string;
}

/** Offered when the provider names no options, as web does. */
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve once" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Decline and stop the run" },
];

const DECISION_ORDER: Record<ProviderApprovalDecision, number> = {
  accept: 0,
  acceptForSession: 1,
  acceptAlways: 2,
  decline: 3,
  cancel: 4,
};

const DECISION_KEY: Record<ProviderApprovalDecision, string> = {
  accept: "y",
  acceptForSession: "s",
  acceptAlways: "a",
  decline: "n",
  cancel: "c",
};

/** The decisions an approval offers, approvals first; number N and its letter pick each. */
export function approvalChoices(approval: ThreadPendingApproval): ReadonlyArray<ApprovalChoice> {
  if (approval.responseCapability !== "live") return [];
  const options =
    approval.options === undefined || approval.options.length === 0
      ? DEFAULT_APPROVAL_OPTIONS
      : approval.options;
  const seen = new Set<ProviderApprovalDecision>();
  const choices: Array<ApprovalChoice> = [];
  for (const option of options.toSorted(
    (left, right) => DECISION_ORDER[left.decision] - DECISION_ORDER[right.decision],
  )) {
    if (seen.has(option.decision)) continue;
    seen.add(option.decision);
    choices.push({
      decision: option.decision,
      label: option.label,
      ...(option.warning === undefined ? {} : { warning: option.warning }),
      key: DECISION_KEY[option.decision],
    });
  }
  return choices;
}

const KIND_LABEL: Record<ThreadPendingApproval["requestKind"], string> = {
  command: "Run a command",
  "file-read": "Read files",
  "file-change": "Change files",
  "mcp-elicitation": "App access",
  permission: "App permission",
};

export function approvalTitle(approval: ThreadPendingApproval): string {
  return approval.appName
    ? `${KIND_LABEL[approval.requestKind]} · ${approval.appName}`
    : KIND_LABEL[approval.requestKind];
}

/** Past tense for a sent decision, e.g. "Approved once". */
export function decisionDoneLabel(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "Approved once";
    case "acceptForSession":
      return "Approved for this session";
    case "acceptAlways":
      return "Always approved";
    case "decline":
      return "Declined";
    case "cancel":
      return "Declined and stopped";
  }
}

/**
 * Derives the queue from each projection a thread streams, keeping the previous queue's
 * identity while nothing it shows changed, so streamed text doesn't re-render the panel.
 */
export function createRequestQueueSelector() {
  let previousSource: RequestQueueSource | null = null;
  let previousKey = "";
  let previous: ReadonlyArray<PendingRequest> = NO_PENDING_REQUESTS;
  return (source: RequestQueueSource | null): ReadonlyArray<PendingRequest> => {
    if (
      source === null ||
      !source.runtimeRequests.some((request) => request.status === "pending")
    ) {
      previousSource = source;
      previousKey = "";
      previous = NO_PENDING_REQUESTS;
      return previous;
    }
    if (
      previousSource !== null &&
      previousSource.runtimeRequests === source.runtimeRequests &&
      previousSource.turnItems === source.turnItems &&
      previousSource.nodes === source.nodes &&
      previousSource.subagents === source.subagents &&
      previousSource.runs === source.runs
    ) {
      return previous;
    }
    previousSource = source;
    const next = deriveRequestQueue(source);
    const key = JSON.stringify(next);
    if (key !== previousKey) {
      previousKey = key;
      previous = next;
    }
    return previous;
  };
}
