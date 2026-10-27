import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Wire-shaped shell rows for tests, presented through client-runtime like the live sidebar. */

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("env-test");
const PROVIDER = ProviderInstanceId.make("codex");

export const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

export function projectShell(
  id: string,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/workspace/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

export function threadRow(
  id: string,
  projectId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make(projectId),
    title: id,
    providerInstanceId: PROVIDER,
    modelSelection: { instanceId: PROVIDER, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at("2026-06-20T00:00:00.000Z"),
    updatedAt: at("2026-06-20T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function presentedThread(
  id: string,
  projectId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): EnvironmentThreadShell {
  return presentThreadShell(TEST_ENVIRONMENT_ID, threadRow(id, projectId, overrides));
}
