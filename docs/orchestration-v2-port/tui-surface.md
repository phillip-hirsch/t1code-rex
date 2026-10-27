# T1Code TUI surface: server and shared dependencies

Snapshot: `origin/main` = `8c79236ab` ("feat(tui): open threads as Rex tabs…", #2). All `file:line` references are at that commit. Paths are relative to the repo root; `ui.tsx` means `apps/tui/src/ui.tsx` (17,582 lines).

Scope: `apps/tui` and `packages/client-core`. The goal is a checklist for porting both onto upstream T3 Code (`t3up/main`, orchestration v2).

Note: `t3up/main` now resolves to `5127de8c29`, and `ed44f251d` is an ancestor of it. The remote has moved since the brief was written. The upstream notes at the end were spot-checked against `t3up/main`. They are not a full mapping.

---

## 0. Architecture in one paragraph

The TUI spawns (or attaches to) the fork's Node server, then opens one WebSocket through `client-core`'s hand-rolled `WsTransport`. The wire protocol is the old T3 one: request `{id, body: {_tag: method, ...params}}`, response `{id, result?, error?: {message}}`, push `{type: "push", sequence, channel, data}` (`packages/contracts/src/ws.ts`). `createTransportNativeApi` wraps it as a `NativeApi` object.

**The TUI does not apply domain events incrementally.** Every `orchestration.domainEvent` push only triggers a coalesced full `orchestration.getSnapshot` re-fetch (`ui.tsx:5042-5045`, `snapshotRefresh.ts`). All UI state is derived from the full `OrchestrationReadModel` (every project and every thread, with all messages and activities) plus a few side RPCs. This is the main thing orchestration v2 breaks, because v2 has no `getSnapshot`.

---

## 1. RPC methods called

### 1a. Transport and adapter (client-core)

| Layer                      | File                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WsTransport`              | `packages/client-core/src/wsTransport.ts`      | Envelope `{id, body:{_tag}}` (`:107-111`). Default timeout 60 s, reconnect backoff 0.5–8 s (`:53-54`). Decodes inbound messages with `WsResponse` from contracts (`:55`, `:259`). Queues outbound messages until open. Rejects all pending requests on close. Caches the latest push per channel (`getLatestPush`). Uses `globalThis.WebSocket`; the TUI runs on Bun, which provides it. |
| `createTransportNativeApi` | `packages/client-core/src/nativeApi.ts:46-205` | Maps `NativeApi` (type from `@t3tools/contracts` `ipc.ts`) to `WS_METHODS` / `ORCHESTRATION_WS_METHODS`. `git.runStackedAction`, `sourceControl.cloneRepository` and `sourceControl.publishRepository` have no timeout (`timeoutMs: null`). `dialogs`, `shell.openExternal` and `contextMenu` are local stubs. The TUI passes none of them.                                              |

The TUI builds the transport at `ui.tsx:4921` and the adapter at `ui.tsx:4927`. One call bypasses the adapter: `getSnapshot` goes straight through `transport.request` with a 5 s timeout (`ui.tsx:4946-4950`).

### 1b. Methods the TUI calls

| Wire method                                                                   | Adapter call                           | Call site(s)                                                                                                                                             | UI feature                                                                                                                              |
| ----------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration.getSnapshot`                                                   | `transport.request`                    | `ui.tsx:4946`                                                                                                                                            | Everything. Runs on boot, on welcome, on every domain event, and retries every 1 s on failure (`ui.tsx:4931-4973`).                     |
| `orchestration.dispatchCommand` `{command}`                                   | `api.orchestration.dispatchCommand`    | `ui.tsx:8669-8673` (single `dispatch()` helper)                                                                                                          | All mutations (§4)                                                                                                                      |
| `orchestration.getFullThreadDiff` `{threadId, toTurnCount, ignoreWhitespace}` | `api.orchestration.getFullThreadDiff`  | `ui.tsx:6686`                                                                                                                                            | Full diff view. `toTurnCount = thread.checkpoints.length`; skipped when 0. Reads `result.diff` (a unified diff string, parsed locally). |
| `server.getConfig`                                                            | `api.server.getConfig`                 | `ui.tsx:4975`                                                                                                                                            | Providers, editors, keybindings, environment, observability                                                                             |
| `server.getSettings`                                                          | `api.server.getSettings`               | `ui.tsx:4987`                                                                                                                                            | Settings screens, provider install forms                                                                                                |
| `server.updateSettings` (patch)                                               | `api.server.updateSettings`            | `ui.tsx:4396` (helper `updateServerSettings`). Callers: `4598, 4613, 4631, 4645, 4661, 5700, 9094, 9211, 9240, 9256, 9295, 9414, 9454, 9489, 9641, 9671` | General settings, provider settings and instances, git text-gen model                                                                   |
| `server.refreshProviders` `{instanceId?}`                                     | `api.server.refreshProviders`          | `ui.tsx:4416`                                                                                                                                            | Providers screen "Refresh". Reads `payload.providers` into `serverConfig.providerInstances`.                                            |
| `server.updateProvider` `{provider: driver, instanceId}`                      | `api.server.updateProvider`            | `ui.tsx:4443`                                                                                                                                            | Provider CLI update notice and button. Reads `payload.providers[].updateState.message`.                                                 |
| `server.getProcessDiagnostics`                                                | `api.server.getProcessDiagnostics`     | `ui.tsx:4477`                                                                                                                                            | Diagnostics view (process tree)                                                                                                         |
| `server.signalProcess` `{pid, signal}`                                        | `api.server.signalProcess`             | `ui.tsx:4539`                                                                                                                                            | Diagnostics: kill or interrupt a child process                                                                                          |
| `server.getTraceDiagnostics`                                                  | `api.server.getTraceDiagnostics`       | `ui.tsx:4508`                                                                                                                                            | Diagnostics: local trace records                                                                                                        |
| `server.getAdvertisedEndpoints`                                               | `api.server.getAdvertisedEndpoints`    | `ui.tsx:4493`                                                                                                                                            | Connections view. Reads `result.endpoints: AdvertisedEndpoint[]`.                                                                       |
| `server.discoverSourceControl`                                                | `api.server.discoverSourceControl`     | `ui.tsx:4524`                                                                                                                                            | Source Control view (VCS and provider auth discovery)                                                                                   |
| `shell.openInEditor` `{cwd, editor}`                                          | `api.shell.openInEditor(path, editor)` | `ui.tsx:7572` (open in editor), `7593` (`"file-manager"`), `9698` (keybindings file), `9717` (logs dir)                                                  | Sidebar context menu, Keybindings view, Diagnostics                                                                                     |
| `projects.searchEntries` `{cwd, query, limit}`                                | `api.projects.searchEntries`           | `ui.tsx:11763`                                                                                                                                           | Composer `@path` mention autocomplete. Reads `result.entries: ProjectEntry[]`.                                                          |
| `git.status` `{cwd}`                                                          | `api.git.status`                       | `ui.tsx:11003`, `11237`                                                                                                                                  | Branch toolbar, git quick-action menu                                                                                                   |
| `git.listBranches` `{cwd}`                                                    | `api.git.listBranches`                 | `ui.tsx:11004`                                                                                                                                           | Branch picker                                                                                                                           |
| `git.checkout` `{cwd, branch}`                                                | `api.git.checkout`                     | `ui.tsx:11234`                                                                                                                                           | Branch picker select                                                                                                                    |
| `git.createWorktree` `{cwd, branch, newBranch, path: null}`                   | `api.git.createWorktree`               | `ui.tsx:10451`                                                                                                                                           | Composer send in "New worktree" env mode. Reads `result.worktree.{branch,path}`.                                                        |
| `git.pull` `{cwd}`                                                            | `api.git.pull`                         | `ui.tsx:11294`                                                                                                                                           | Git menu "Pull". Reads `result.status === "pulled"`.                                                                                    |
| `git.runStackedAction` `{actionId, cwd, action, textGenerationModel}`         | `api.git.runStackedAction`             | `ui.tsx:11266`                                                                                                                                           | Git menu: commit, push, create PR (`GitStackedAction`)                                                                                  |
| `sourceControl.publishRepository` `{cwd, ...parsedArgs}`                      | `api.sourceControl.publishRepository`  | `ui.tsx:11357`                                                                                                                                           | `/publish` command. Reads `status`, `repository.nameWithOwner`, `branch`, `remoteName`.                                                 |
| `sourceControl.cloneRepository`                                               | `api.sourceControl.cloneRepository`    | `ui.tsx:11396`                                                                                                                                           | `/clone` command. Reads `result.cwd`, `repository?.nameWithOwner`, `remoteUrl`, then dispatches `project.create`.                       |
| `terminal.open`                                                               | `api.terminal.open`                    | `ui.tsx:8752` (run project script), `8833` (open drawer)                                                                                                 | Terminal drawer, Scripts                                                                                                                |
| `terminal.restart`                                                            | `api.terminal.restart`                 | `ui.tsx:8832`                                                                                                                                            | Terminal drawer "restart"                                                                                                               |
| `terminal.write` `{threadId, terminalId, data}`                               | `api.terminal.write`                   | `ui.tsx:8760` (script command + `\r`), `8910` (drawer input line)                                                                                        | Terminal drawer, Scripts                                                                                                                |
| `terminal.close`                                                              | `api.terminal.close`                   | `ui.tsx:8879`                                                                                                                                            | Terminal drawer close-session                                                                                                           |
| `terminal.clear`                                                              | `api.terminal.clear`                   | `ui.tsx:8891`                                                                                                                                            | Terminal drawer clear                                                                                                                   |

Terminal open input (`ui.tsx:8820-8829`): `{threadId, terminalId: DEFAULT_TERMINAL_ID, cwd: gitCwd, cols, rows, env: {T3CODE_PROJECT_ROOT}}`. Scripts pass `env: projectScriptRuntimeEnv(...)` instead, with fixed cols and rows. The TUI only ever uses `DEFAULT_TERMINAL_ID`, so there is one terminal per thread.

### 1c. Methods present in the adapter but never called by the TUI

`orchestration.getTurnDiff`, `orchestration.replayEvents`, `terminal.resize` (the drawer never resizes the PTY), `projects.writeFile`, `git.init`, `git.createBranch`, `git.removeWorktree`, `git.resolvePullRequest`, `git.preparePullRequestThread`, `sourceControl.lookupRepository`, `server.upsertKeybinding`, `dialogs.*`, `contextMenu.show`. These can be dropped from the port.

### 1d. Non-WebSocket HTTP

| What                                | Where                                                                                                    | Notes                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET {httpOrigin}/attachments/{id}` | `apps/tui/src/terminalImages.ts:278-301` (`cacheRemoteAttachmentToFile`), called from `ui.tsx:6987-7000` | Image preview for persisted message attachments. Sends **no auth header or token**. `httpOrigin` comes from the WS URL (`resolveHttpOriginFromWsUrl`, `ui.tsx:4925`). Files are cached in `<stateHome>/images/preview-cache`. |

---

## 2. Push channels

All subscriptions are made in the boot effect, `ui.tsx:5017-5067`. They are torn down at `5071-5081`.

| Channel                                               | Subscribe API                                                         | Site                 | Consumption                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.welcome` (`WsWelcomePayload`)                 | `nativeBridge.events.onServerWelcome` (replays the latest push)       | `ui.tsx:5017-5041`   | Logs the payload. On first welcome, selects `bootstrapProjectId` / `bootstrapThreadId` unless something is already selected (`shouldApplyWelcomeBootstrapSelection`, `threadSelection.ts`). Triggers `refresh("welcome")`. Reads only `bootstrapProjectId` and `bootstrapThreadId`; `environment`, `cwd` and `projectName` are logged only.                                                                         |
| `orchestration.domainEvent` (`OrchestrationEvent`)    | `api.orchestration.onDomainEvent`                                     | `ui.tsx:5042-5045`   | **Payload ignored**. Triggers a coalesced full snapshot refresh.                                                                                                                                                                                                                                                                                                                                                    |
| `server.configUpdated` (`ServerConfigUpdatedPayload`) | `nativeBridge.events.onServerConfigUpdated` (replays the latest push) | `ui.tsx:5046-5059`   | Merges `issues`, `providers` and `providerInstances?` into the `serverConfig` state                                                                                                                                                                                                                                                                                                                                 |
| `terminal.event` (`TerminalEvent`)                    | `api.terminal.onEvent`                                                | `ui.tsx:5060-5067`   | Ignored unless `event.threadId` matches the drawer's thread. Reduced by `applyTerminalEventToSession` (`terminalDrawer.ts:47-110`). Event types: `started`/`restarted` (`snapshot`), `output` (`data`; ANSI is stripped and output is trimmed), `exited` (`exitCode`, `exitSignal`), `error` (`message`), `cleared`, and an activity event (`hasRunningSubprocess`). Every event uses `createdAt` and `terminalId`. |
| `git.actionProgress` (`GitActionProgressEvent`)       | `api.git.onActionProgress`                                            | `ui.tsx:11034-11070` | Filtered by `event.cwd === gitCwd` and `event.actionId`. Kinds: `action_started`, `phase_started` (`label`), `hook_output` (`text`), `action_failed`, plus completion. Drives the git busy spinner and status text.                                                                                                                                                                                                 |

---

## 3. Read-model fields used, by feature

Types come from `packages/contracts/src/orchestration.ts`: `OrchestrationReadModel` `:347`, `OrchestrationThread` `:321`, `OrchestrationProject` `:189`, `OrchestrationMessage` `:204`, `OrchestrationProposedPlan` `:219`, `OrchestrationSession` `:248`, `OrchestrationCheckpointSummary` `:271`, `OrchestrationThreadActivity` `:290`, `OrchestrationLatestTurn` `:310`. The TUI aliases them as `ThreadReadModel` and `ProjectReadModel` (`ui.tsx:424-425`). `snapshotSequence` and `updatedAt` on the root are **not** used.

### 3a. Sidebar (projects and threads)

- Visible projects: `project.deletedAt === null` (`ui.tsx:5164`). Fields: `id`, `title`, `workspaceRoot`, `createdAt`, `updatedAt`, `scripts`.
- Visible threads: `deletedAt === null && archivedAt === null` (`ui.tsx:5167-5173`). Grouped by `projectId`.
- Sorting (`client-core/sidebarSort.ts`): thread `messages[].createdAt` (latest user message), `createdAt`, `updatedAt`; project `createdAt`, `updatedAt`, `title`.
- Status pill (`ui.tsx:2593-2626`, `client-core/sidebarStatus.ts`): thread `interactionMode`, `latestTurn.{turnId,startedAt,completedAt}`, `proposedPlans` (for "Plan Ready"), `session.{status, activeTurnId}`, and `derivePendingApprovals` / `derivePendingUserInputs` over `activities`. The TUI rewrites `session.status: "starting"` to `"connecting"`. `lastVisitedAt` is **local** TUI state; no server field or command exists for it.
- Pulse animation: `isThreadSessionActivelyWorking(thread.session)` (`client-core/sessionLogic.ts:142`), which uses `session.status` (or `orchestrationStatus`) and `activeTurnId`.
- Project status dot: `resolveProjectStatusIndicator` over its threads' pills (`ui.tsx:12286`).
- Context menu (`sidebarContextMenu.ts`, typed on `OrchestrationReadModel`): `rename`, `archive`, `unarchive`, `delete`, `mark-unread` (local only), `copy-path`, `copy-thread-id`, `open-editor`, `open-folder`, `open-rex-tab`. Workspace path is `thread.worktreePath ?? project.workspaceRoot` (`ui.tsx:7600`).
- Thread lookups by id: `ui.tsx:7340`, `8162`, `17286`. Selection pruning uses live thread ids (`ui.tsx:6580-6601`).

### 3b. Timeline (active thread)

- `messages[]`: `id`, `role` (`user` | `assistant` | `system`), `text`, `attachments?` (`id`, `name`, `mimeType`, `sizeBytes`, `type: "image"`), `createdAt`. Cast to client-core's `ChatMessage` (`ui.tsx:5337-5342`). `streaming`, `turnId` and `updatedAt` are not read directly; the typing indicator comes from session state and pending sends.
- `proposedPlans[]`: `id`, `turnId`, `planMarkdown`, `implementedAt`, `implementationThreadId`, `createdAt`, `updatedAt` (`findLatestProposedPlan`, `hasActionableProposedPlan`, timeline rows).
- `activities[]` (`OrchestrationThreadActivity`): `id`, `kind`, `tone`, `summary`, `payload`, `turnId`, `sequence?`, `createdAt`. Activity kinds and payload fields that client-core interprets:
  - Work log (`deriveWorkLogEntries`, `sessionLogic.ts:521`): excludes `tool.started`, `task.started`, `task.completed`, `context-window.updated`. Collapses consecutive `tool.updated`/`tool.completed`. Payload fields: `detail` (strips `<exited with exit code N>`; `ExitPlanMode:` prefix is hidden), `title`, `itemType` (`isToolLifecycleItemType`), `requestKind` / `requestType`, command fields (`extractToolCommand`), and changed files from `payload.data` (keys `path`, `filePath`, `relativePath`, `filename`, `newPath`, `oldPath`, nested under `item`, `result`, `input`, `data`, `changes`, `files`, `edits`, `patch`, `patches`, `operations`).
  - Ordering: `sequence`, then `createdAt`, then a lifecycle rank inferred from the kind suffix (`.started`, `.updated`/`.progress`, `.completed`/`.resolved`).
  - Active plan (`deriveActivePlanState`, `:400`): kind `turn.plan.updated`, `payload.plan[].{step,status}`, `payload.explanation`, filtered by `latestTurn.turnId`.
  - Context window meter (`client-core/contextWindow.ts:33`): kind `context-window.updated`, `payload.usedTokens`, `payload.maxTokens`.
- `latestTurn`: `turnId`, `startedAt`, `completedAt` (settled check, plan follow-up prompt, work timer, `ui.tsx:5359-5371`).
- `session`: `status` (including `"stopped"`, `"starting"`), `activeTurnId`, `providerName`, `providerInstanceId`.
- Pending-send reconciliation (`ui.tsx:6446-6467`): optimistic user bubbles are dropped once `thread.messages` contains the client-generated `messageId`, or once an assistant message newer than the send exists. **This depends on the server keeping the client-supplied `messageId`.**
- Env lock (`ui.tsx:5268-5272`): `messages.length > 0`, or a session exists with `status !== "stopped"`.

### 3c. Composer

- Thread `model`, `runtimeMode`, `interactionMode` are compared with the drafts before every turn (`persistThreadSettingsForNextTurn`, `ui.tsx:9906-9947`).
- Thread `branch` and `worktreePath` drive the branch toolbar and `gitCwd`.
- Provider and model menus come from `serverConfig.providerInstances` (`ServerProvider`: `instanceId`, `driver`, `displayName`, `accentColor`, `enabled`, `installed`, `status`, `availability`, `models`, `version`, `checkedAt`, `continuation.groupKey`, `updateState.{status,message,finishedAt}`). Read in `apps/tui/src/providerInstances.ts` and `providerUpdateNotifications.ts`.
- Model option descriptors come from `@t3tools/shared/model` (`getProviderOptionDescriptors`, etc.) over provider model capabilities.

### 3d. Approvals and user-input requests

All derived from `activities` (`sessionLogic.ts:246-398`):

- Approval open and close: `approval.requested` / `approval.resolved` / `provider.approval.respond.failed`. Payload: `requestId`, `requestKind` (`command` | `file-read` | `file-change`) or `requestType` (codex names such as `exec_command_approval`, `apply_patch_approval`, `file_read_approval`, …), `detail`. Stale-request failure messages are matched by text.
- User input: `user-input.requested` (payload `requestId`, `questions: UserInputQuestion[]`), `user-input.resolved`, `provider.user-input.respond.failed`.
- Only the first pending item is shown (`ui.tsx:5310-5311`). `/approve accept|acceptForSession|decline|cancel` and `/answer` are routed from the composer (`ui.tsx:2649+`, `10162`, `10171`).

### 3e. Diff panel

- `thread.checkpoints.length` is used only as `toTurnCount` (`ui.tsx:6672`). No other checkpoint fields are read.
- `getFullThreadDiff` result `.diff`, parsed into files and hunks locally. The panel has unified and split views, word wrap (`appSettings.diffWordWrap`), `ignoreWhitespace` (`appSettings.diffIgnoreWhitespace`), and collapsible files.
- Rex alternative: opens `git diff HEAD` in a new Rex tab (`ui.tsx:7662-7674`). It needs no server.

### 3f. Terminal drawer

The terminal RPCs and `terminal.event` (§1b, §2) plus `TerminalSessionSnapshot` (via `terminalSessionFromSnapshot`, `terminalDrawer.ts`). The drawer is line-oriented: output text has ANSI stripped, and input is sent as a line. It is not a real PTY renderer.

### 3g. Settings, Providers, Keybindings screens

- `ServerConfig`: `providerInstances`, `providers`, `issues`, `availableEditors`, `keybindings` (`ResolvedKeybindingsConfig`), `keybindingsConfigPath`, `environment.{environmentId,label,…}` (`formatEnvironmentPlatform`, `formatEnvironmentCapabilities`), `observability.{logsDirectoryPath, localTracingEnabled}`.
- `ServerSettings` read: `enableAssistantStreaming`, `defaultThreadEnvMode`, `addProjectBaseDirectory`, `automaticGitFetchInterval`, `observability.{otlpTracesUrl,otlpMetricsUrl}`, `textGenerationModelSelection.{instanceId,model,options}`, `providers.{codex,claudeAgent,cursor,opencode}` (`binaryPath`, `homePath`, custom models, …), `providerInstances` (`ProviderInstanceConfig`, including env variables).
- Patches written (`ServerSettingsPatch`): all of the above. Patch builders live in `apps/tui/src/providerSettings.ts:257-421` (default instance update, reset, custom models, duplicate, delete, instance update) and use `DEFAULT_SERVER_SETTINGS`, `ClaudeSettings`, `CodexSettings`, `CursorSettings`, `OpenCodeSettings`, `ProviderSettingsFormAnnotation`.
- Local-only `AppSettings` (client-core `appSettings.ts`, persisted in `prefs.json`): theme, timestamp format, sidebar sort orders and preview count, diff options, confirm-delete, custom models, `getProviderStartOptions` (sent as `providerOptions` on `thread.turn.start`).
- Keybindings: the view is read-only, plus "open keybindings file in editor". It never calls `server.upsertKeybinding`.

### 3h. Source control

- `GitStatusResult`: `branch`, `hasWorkingTreeChanges`, `hasUpstream`, `aheadCount`, `behindCount`, `pr.state` (in `client-core/gitQuickAction.ts` `resolveQuickAction` / `buildGitActionMenuItems`).
- `GitListBranchesResult`: `isRepo`, `hasOriginRemote`, `branches[].{name,current,isDefault,isRemote,remoteName,worktreePath}`.
- `SourceControlDiscoveryResult` (Source Control view): `VcsDiscoveryItem`, `SourceControlProviderDiscoveryItem`, `SourceControlProviderAuth`, `SourceControlProviderKind`.
- `/publish` and `/clone` arguments are parsed locally (`parsePublishCommandArgs`, `parseCloneCommandArgs`) into `SourceControlPublishRepositoryInput` / `SourceControlCloneRepositoryInput` (`SourceControlCloneProtocol`, `SourceControlRepositoryVisibility`).

### 3i. Scripts

`project.scripts: ProjectScript[]` (`id`, `name`, `command`, `icon: ProjectScriptIcon`, run-on-worktree flags). Helpers from `@t3tools/shared/projectScripts`: `nextProjectScriptId`, `primaryProjectScript`, `projectScriptCwd`, `projectScriptRuntimeEnv`. Saved via `project.meta.update {scripts}`. Run via `terminal.open` + `terminal.write`.

### 3j. Connections

`server.getAdvertisedEndpoints` → `AdvertisedEndpoint[]` (rendered by `apps/tui/src/connectionsPanel.ts`). Also shows `serverConfig.environment` and the local HTTP origin.

### 3k. Diagnostics

`ServerProcessDiagnosticsResult` (process tree, `error?.message`), `ServerTraceDiagnosticsResult` (`error?.message`, records), `ServerProcessSignal`. Also `serverConfig.observability`.

### 3l. Archive

Threads with `archivedAt !== null && deletedAt === null`, sorted by `archivedAt ?? createdAt` (`ui.tsx:5174-5186`). Actions: unarchive and delete, singly or in bulk.

---

## 4. Commands dispatched (`ClientOrchestrationCommand`)

Every command carries `commandId: newCommandId()` (client-core `ids.ts`). IDs are generated on the client: `newThreadId`, `newProjectId`, `newMessageId`.

| Command `type`                        | Site(s)                                                                       | Payload fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Feature                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `project.create`                      | `ui.tsx:9767`                                                                 | `projectId`, `title` (basename), `workspaceRoot`, `defaultModel` (`DEFAULT_MODEL_BY_PROVIDER.codex`), `createdAt`                                                                                                                                                                                                                                                                                                                                                                       | Add project (Ctrl+P / `/project`), after `/clone`            |
| `project.meta.update`                 | `ui.tsx:8678`                                                                 | `projectId`, `scripts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Scripts editor                                               |
| `project.delete`                      | `ui.tsx:7544`                                                                 | `projectId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Remove project                                               |
| `thread.create`                       | `ui.tsx:9875`                                                                 | `threadId`, `projectId`, `title`, `model`, `runtimeMode`, `interactionMode`, `branch`, `worktreePath`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                      | New thread (Ctrl+N), first send from a draft thread          |
| `thread.meta.update`                  | `ui.tsx:7715` (`title`), `9920` (`model`), `10687` (`branch`, `worktreePath`) | `threadId` + changed fields                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Rename, model switch, branch or worktree switch              |
| `thread.runtime-mode.set`             | `ui.tsx:9929`                                                                 | `threadId`, `runtimeMode`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Runtime toggle before a turn                                 |
| `thread.interaction-mode.set`         | `ui.tsx:9939`                                                                 | `threadId`, `interactionMode`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                              | Plan/default toggle before a turn                            |
| `thread.turn.start`                   | `ui.tsx:10513` (normal send), `10355` (plan follow-up)                        | `threadId`, `message: {messageId, role: "user", text, attachments: [{type:"image", name, mimeType, sizeBytes, dataUrl}]}`, `provider` (legacy `ProviderKind`), `modelSelection` (`createModelSelection(instanceId, model, optionSelections)`), `model`, `modelOptions?`, `providerOptions?` (`getProviderStartOptions(appSettings)`), `assistantDeliveryMode` (`"streaming"` \| `"buffered"`), `runtimeMode`, `interactionMode`, `sourceProposedPlan?: {threadId, planId}`, `createdAt` | Composer send; implement plan                                |
| `thread.turn.interrupt`               | `ui.tsx:10576`                                                                | `threadId`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Stop (Esc/Ctrl+C while running)                              |
| `thread.session.stop`                 | `ui.tsx:10674`                                                                | `threadId`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Before changing the worktree of a thread with a live session |
| `thread.approval.respond`             | `ui.tsx:9958`                                                                 | `threadId`, `requestId`, `decision: ProviderApprovalDecision`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                              | Approval bar, `/approve`                                     |
| `thread.user-input.respond`           | `ui.tsx:10029`, `10213`                                                       | `threadId`, `requestId`, `answers` (`buildPendingUserInputAnswers`), `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                        | User-input questionnaire, `/answer`                          |
| `thread.archive` / `thread.unarchive` | `ui.tsx:7492`, `7507` / `7522`, `7533`                                        | `threadId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sidebar, Archive view (bulk = sequential loop)               |
| `thread.delete`                       | `ui.tsx:7459`, `7476`                                                         | `threadId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sidebar delete (bulk = sequential loop)                      |

Notes:

- Inline images in the prompt text are read from disk and converted to data URLs (`apps/tui/src/composerSubmit.ts`). Clipboard images are handled by `clipboardImage.ts`. Mentions are sent as `@path` text prefixes, not structured data.
- Sending in "New worktree" mode runs `git.createWorktree`, then `thread.create` with the new branch and path, then `thread.turn.start` (`ui.tsx:10436-10531`).
- No command is sent for "mark read" or "visited". It is local only.

---

## 5. Imports from `@t3tools/*`

### 5a. `apps/tui/src/ui.tsx`

- **`@t3tools/contracts`** (`ui.tsx:23-73`): `ApprovalRequestId`, `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL`, `DEFAULT_TERMINAL_ID`, `DEFAULT_GIT_TEXT_GENERATION_MODEL`, `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_SERVER_SETTINGS`, `MODEL_OPTIONS_BY_PROVIDER`, `ORCHESTRATION_WS_METHODS`, `defaultInstanceIdForDriver`. Types: `ClaudeCodeEffort`, `CodexReasoningEffort`, `ClientOrchestrationCommand`, `EditorId`, `GitActionProgressEvent`, `GitListBranchesResult`, `GitStackedAction`, `GitStatusResult`, `OrchestrationReadModel`, `ProjectEntry`, `ProjectScript`, `ProjectScriptIcon`, `ProviderApprovalDecision`, `ProviderDriverKind`, `ProviderInstanceConfig`, `ProviderInstanceEnvironmentVariable`, `ProviderInstanceId`, `ProviderInteractionMode`, `ProviderKind`, `ProviderModelOptions`, `ProviderOptionDescriptor`, `ProviderOptionSelection`, `RuntimeMode`, `ServerConfig`, `AdvertisedEndpoint`, `ServerProcessDiagnosticsResult`, `ServerProcessSignal`, `ServerProvider`, `ServerSettings`, `ServerSettingsPatch`, `ResolvedKeybindingsConfig`, `ServerTraceDiagnosticsResult`, `SourceControlCloneRepositoryInput`, `SourceControlCloneProtocol`, `SourceControlDiscoveryResult`, `SourceControlProviderAuth`, `SourceControlProviderDiscoveryItem`, `SourceControlProviderKind`, `SourceControlRepositoryVisibility`, `VcsDiscoveryItem`.
- **`@t3tools/client-core`** (`ui.tsx:74-138`): `DEFAULT_AUTO_OPEN_PLAN_SIDEBAR`, `DEFAULT_APP_SETTINGS`, `DEFAULT_APP_THEME`, `DEFAULT_DIFF_WORD_WRAP`, `DEFAULT_SIDEBAR_PROJECT_SORT_ORDER`, `DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT`, `DEFAULT_SIDEBAR_THREAD_SORT_ORDER`, `DEFAULT_TIMESTAMP_FORMAT`, `MAX_/MIN_SIDEBAR_THREAD_PREVIEW_COUNT`, `MAX_CUSTOM_MODEL_LENGTH`, `MODEL_PROVIDER_SETTINGS`, `PROVIDER_OPTIONS`, `SLASH_COMMAND_DEFINITIONS`, `buildPendingUserInputAnswers`, `buildGitActionMenuItems`, `buildPlanImplementationPrompt`, `getAppModelOptions`, `getCustomModelsForProvider`, `getProviderStartOptions`, `rankModelPickerItems`, `normalizeAppSettings`, `normalizeCustomModelSlugs`, `patchCustomModels`, `sortProjectsForSidebar`, `sortThreadsForSidebar`, `createTransportNativeApi`, `deriveActivePlanState`, `deriveLatestContextWindowSnapshot`, `derivePendingApprovals`, `derivePendingUserInputProgress`, `derivePendingUserInputs`, `deriveTimelineEntries`, `deriveWorkLogEntries`, `findLatestProposedPlan`, `hasActionableProposedPlan`, `newCommandId`, `newMessageId`, `newProjectId`, `newThreadId`, `parseSlashCommandInput`, `proposedPlanTitle`, `resolvePlanFollowUpSubmission`, `resolveProjectStatusIndicator`, `resolveQuickAction`, `resolveThreadStatusPill`, `stripDisplayedPlanMarkdown`, `WsTransport`, `formatContextWindowTokens`. Types: `AppSettings`, `AppTheme`, `PendingUserInputDraftAnswer`, `SidebarProjectSortOrder`, `SidebarThreadSortOrder`, `TimestampFormat`, `ActivePlanState`, `ChatAttachment`, `GitActionMenuItem`, `LatestProposedPlanState`, `ThreadStatusPill`, `TimelineEntry`, `ContextWindowSnapshot`, `SlashCommandDefinition`.
- **`@t3tools/shared/model`** (`ui.tsx:139-156`): `applyClaudePromptEffortPrefix`, `createModelSelection`, `getDefaultReasoningEffort`, `getModelOptions`, `getProviderOptionCurrentValue`, `getProviderOptionDescriptors`, `getReasoningEffortOptions`, `isClaudeUltrathinkPrompt`, `normalizeModelSlug`, `normalizeClaudeModelOptions`, `normalizeCodexModelOptions`, `resolveReasoningEffortForProvider`, `resolveSelectableModel`, `supportsClaudeFastMode`, `supportsClaudeThinkingToggle`, `supportsClaudeUltrathinkKeyword`.
- **`@t3tools/shared/projectScripts`** (`ui.tsx:157-162`): `nextProjectScriptId`, `primaryProjectScript`, `projectScriptCwd`, `projectScriptRuntimeEnv`.

### 5b. Other TUI modules

| File                             | Module                   | Symbols                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composerCommands.ts`            | contracts                | `ProviderApprovalDecision`                                                                                                                                                                                                                                                        |
| `composerSlashMenu.ts`           | client-core              | `extractSlashCommandQuery`, `matchSlashCommands`, `SlashCommandDefinition`                                                                                                                                                                                                        |
| `connectionsPanel.ts`            | contracts                | `AdvertisedEndpoint`                                                                                                                                                                                                                                                              |
| `keybindings.ts`                 | contracts                | `MODEL_PICKER_JUMP_KEYBINDING_COMMANDS`, `THREAD_JUMP_KEYBINDING_COMMANDS`, `KeybindingCommand`, `KeybindingShortcut`, `KeybindingWhenNode`, `ModelPickerJumpKeybindingCommand`, `ResolvedKeybindingsConfig`, `ThreadJumpKeybindingCommand`                                       |
| `prefs.ts`                       | client-core / contracts  | `AppSettings` / `ProjectEntry`, `ProviderInstanceId`, `ProviderKind`, `ProviderModelOptions`, `ProviderOptionSelection`, `RuntimeMode`                                                                                                                                            |
| `providerInstances.ts`           | contracts                | `defaultInstanceIdForDriver`, `ProviderDriverKind`, `ProviderKind`, `ProviderInstanceId`, `ServerProvider`, `ServerProviderModel`, `ServerProviderState`                                                                                                                          |
| `providerOptionSelections.ts`    | contracts / shared/model | `ProviderKind`, `ProviderModelOptions`, `ProviderOptionDescriptor`, `ProviderOptionSelection` / `getProviderOptionCurrentLabel`, `getProviderOptionCurrentValue`, `isClaudeUltrathinkPrompt`                                                                                      |
| `providerSettings.ts`            | contracts                | `ClaudeSettings`, `CodexSettings`, `CursorSettings`, `OpenCodeSettings`, `DEFAULT_SERVER_SETTINGS`, `ProviderDriverKind`, `ProviderInstanceId`, `defaultInstanceIdForDriver`, `ProviderSettingsFormAnnotation`, `ProviderInstanceConfig`, `ServerSettings`, `ServerSettingsPatch` |
| `providerUpdateNotifications.ts` | contracts                | `defaultInstanceIdForDriver`, `ProviderDriverKind`, `ServerProvider`                                                                                                                                                                                                              |
| `rendererTheme.ts`, `theme.ts`   | client-core              | `AppTheme`                                                                                                                                                                                                                                                                        |
| `sidebarContextMenu.ts`          | contracts                | `OrchestrationReadModel`                                                                                                                                                                                                                                                          |
| `terminalDrawer.ts`              | contracts                | `TerminalEvent`, `TerminalSessionSnapshot`                                                                                                                                                                                                                                        |
| `workEntryIcons.ts`              | client-core              | `WorkLogEntry`                                                                                                                                                                                                                                                                    |
| `index.tsx`                      | client-core              | `DEFAULT_APP_THEME`                                                                                                                                                                                                                                                               |

### 5c. `packages/client-core` imports

| File                             | Module                        | Symbols                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appSettings.ts`                 | contracts / shared/model      | `DEFAULT_GIT_TEXT_GENERATION_MODEL`, `ProviderInstanceId`, `TrimmedNonEmptyString`, `ProviderKind`, `ProviderStartOptions` / `getDefaultModel`, `getModelOptions`, `normalizeModelSlug`, `resolveSelectableModel`                                                                                                                                                             |
| `advertisedEndpoint.ts`          | shared                        | `export * from "@t3tools/shared/advertisedEndpoint"`                                                                                                                                                                                                                                                                                                                          |
| `contextWindow.ts`               | contracts                     | `OrchestrationThreadActivity`, `ThreadTokenUsageSnapshot`                                                                                                                                                                                                                                                                                                                     |
| `gitQuickAction.ts`              | contracts                     | `GitStackedAction`, `GitStatusResult`                                                                                                                                                                                                                                                                                                                                         |
| `ids.ts`                         | contracts                     | `CommandId`, `MessageId`, `ProjectId`, `ThreadId`                                                                                                                                                                                                                                                                                                                             |
| `knownEnvironment.ts`            | contracts                     | `EnvironmentId`, `ExecutionEnvironmentDescriptor` (not used by the TUI)                                                                                                                                                                                                                                                                                                       |
| `nativeApi.ts`                   | contracts                     | `ContextMenuItem`, `GitActionProgressEvent`, `NativeApi`, `ORCHESTRATION_WS_CHANNELS`, `ORCHESTRATION_WS_METHODS`, `ServerConfigUpdatedPayload`, `ServerSignalProcessInput`, `ServerProviderUpdateInput`, `ServerRefreshProvidersInput`, `SourceControl{Clone,Publish}RepositoryInput`, `SourceControlRepositoryLookupInput`, `WS_CHANNELS`, `WS_METHODS`, `WsWelcomePayload` |
| `pendingUserInput.ts`            | contracts                     | `UserInputQuestion`                                                                                                                                                                                                                                                                                                                                                           |
| `scoped.ts`                      | contracts                     | `EnvironmentId`, `ProjectId`, `ScopedProjectRef`, `ScopedThreadRef`, `ThreadId` (not used by the TUI)                                                                                                                                                                                                                                                                         |
| `sessionLogic.ts`                | contracts                     | `ApprovalRequestId`, `isToolLifecycleItemType`, `OrchestrationLatestTurn`, `OrchestrationProposedPlanId`, `OrchestrationThreadActivity`, `ProviderKind`, `ThreadId`, `ToolLifecycleItemType`, `TurnId`, `UserInputQuestion`                                                                                                                                                   |
| `sidebarStatus.ts`               | contracts                     | `OrchestrationLatestTurn`, `OrchestrationProposedPlan`, `ProviderInteractionMode`                                                                                                                                                                                                                                                                                             |
| `sourceControlDiscoveryState.ts` | contracts (+ effect `Atom`)   | `SourceControlDiscoveryResult` (not used by the TUI)                                                                                                                                                                                                                                                                                                                          |
| `types.ts`                       | contracts                     | `CheckpointRef`, `MessageId`, `OrchestrationLatestTurn`, `OrchestrationProposedPlanId`, `OrchestrationSessionStatus`, `OrchestrationThreadActivity`, `ProjectId`, `ProjectScript`, `ProviderInteractionMode`, `ProviderKind`, `RuntimeMode`, `ThreadId`, `TurnId`                                                                                                             |
| `wsTransport.ts`                 | contracts / shared/schemaJson | `WsPush`, `WsPushChannel`, `WsPushMessage`, `WebSocketResponse`, `WsResponse` / `decodeUnknownJsonResult`, `formatSchemaError`                                                                                                                                                                                                                                                |

`@t3tools/shared` subpaths used in total: `model`, `projectScripts`, `schemaJson`, `advertisedEndpoint`.

Modules the TUI never uses: `knownEnvironment`, `scoped`, `sourceControlDiscoveryState`, `advertisedEndpoint`, `modelPickerSearch`, apart from `rankModelPickerItems`, which it does use. They can be dropped or replaced by upstream equivalents.

---

## 6. Server launch and packaging

### 6a. `apps/tui/src/serverSupervisor.ts`

- Entry resolution (`:212-224`): use the bundled `dist/server/index.js` next to the TUI if it exists. Otherwise, in production, use `apps/server/dist/index.mjs`. In development, run `bun run apps/server/src/index.ts`. The runtime is `T1CODE_BUN_BIN` / `T1CODE_NODE_BIN`, or the current Bun, or `bun`.
- Spawn args (`:255-271`): `--mode tui --auto-bootstrap-project-from-cwd --host <host> --port <port> --auth-token <token> --home-dir <paths.homeDir> --no-browser`. `cwd` is `process.cwd()`. Every env var prefixed `T1CODE_*` or `T3CODE_*` is **stripped** (`:153-157`).
- The port comes from reserving loopback port 0 (`:159-179`). Host defaults to `127.0.0.1`. The token is 16 random bytes in hex.
- Readiness check is a TCP connect poll every 100 ms, with a 10 s timeout (`:181-210`). The server is auto-restarted on exit after 750 ms unless it was stopped or hit a fatal startup error (EACCES/EPERM sniffed from stdout and stderr, `:67-77`).
- WS URL: `ws://host:port/?token=<authToken>` (`buildServerWsUrl`, `:123-125`). **Auth is a query-string token.**
- Attach-only mode (`resolveAttachedServerConnection`, `:127-151`): `T1CODE_TUI_ATTACH_ONLY=1`, `T1CODE_HOST`, `T1CODE_PORT`, `T1CODE_AUTH_TOKEN`.
- Thread windows (`threadWindowLaunch.ts`): a second TUI process in a Rex tab attaches to the first one's server through a 0600 one-shot JSON file named by `T1CODE_THREAD_WINDOW_FILE` (`{server:{host,port,authToken}, projectId, threadId}`). Built in `ui.tsx:7624-7647` with `buildThreadWindowCommand`.
- Wiring in the UI: `ui.tsx:4879-4914` (`serverConnectionRef` holds host, port and token for thread windows).

### 6b. Paths (`apps/tui/src/config.ts`)

- `homeDir` is passed as `--home-dir`: `T1CODE_HOME`, else `~/.t1` (macOS) or `$XDG_DATA_HOME/t1code` (Linux).
- `configHomeDir`: `T1CODE_CONFIG_HOME`, else `$XDG_CONFIG_HOME/t1code` or `~/.config/t1code`. Holds `prefs.json`.
- `stateHomeDir`: `T1CODE_STATE_HOME`, else the XDG state dir or `configHomeDir`. Holds `tui.log`, `images/`, `thread-windows/`.

### 6c. Build and packaging

- `apps/tui/package.json` `build` runs `bun run scripts/build-runtime.mjs && node scripts/bundle-server-dist.mjs`.
- `scripts/build-runtime.mjs`: `bun build src/index.tsx --target bun` to `dist/index.mjs`. Adds a shebang, rewrites the `@opentui/core-${platform}-${arch}` native specifier, and copies OpenTUI `parser.worker.js`.
- `scripts/bundle-server-dist.mjs`: runs `bun run build` in `apps/server`, then `bun build src/index.ts --target=node --format=esm --splitting --packages=bundle --external node-pty --external ws` to `apps/tui/dist/server/`. Copies `apps/server/dist/client` (the **web app build served by the server**) to `dist/server/client`. Copies `node-pty` runtime files (`lib`, `prebuilds`, …) from `node_modules` or the Bun store to `dist/server/node_modules/node-pty`.
- `prepare-package-json.mjs` / `restore-package-json.mjs`: strip workspace devDependencies for publishing. The `@t3tools/*` packages are bundled (`tsdown.config.ts` `noExternal`). npm publishing is disabled in this fork (commit `c360c6ddf`).
- `bin/t1code.js`: re-execs under Bun when started from Node (`T1CODE_BUN_BIN`).

---

## 7. TUI feature list (verification checklist)

Boot and connection

- [ ] Launch in any directory; the server starts and auto-bootstraps a project (and thread) for the cwd, which gets selected.
- [ ] Attach-only mode via the `T1CODE_TUI_ATTACH_ONLY` env vars.
- [ ] Server crash: auto-restart, WS reconnect, snapshot re-fetch; status shows Reconnecting, Restarting, Ready or Disconnected.
- [ ] A startup permission error shows a startup issue screen.

Sidebar

- [ ] Projects list with expand and collapse; threads per project with preview count; sort orders for projects and threads.
- [ ] Thread status pills: Working (pulsing), Connecting, Completed (unread), Pending Approval, Awaiting Input, Plan Ready. Project status dot.
- [ ] Multi-select threads (Shift+↑/↓), bulk archive and delete.
- [ ] Context menu: rename, archive, unarchive, delete (with confirm), mark unread, copy path, copy thread id, open in editor, open folder, open in Rex tab.
- [ ] Add project by path (Ctrl+P, `~` expansion, base directory setting); remove project.
- [ ] Command palette (projects, threads, views).
- [ ] Responsive layout: sidebar overlay on narrow terminals (Ctrl+B).

Threads and composer

- [ ] New thread (Ctrl+N). Draft threads that are not yet on the server; first send creates the thread.
- [ ] Send a message with streaming or buffered delivery; optimistic user bubble and typing indicator.
- [ ] Interrupt a running turn.
- [ ] Provider instance and model picker (Codex, Claude, custom instances, custom models), reasoning effort, Claude fast mode, thinking, ultrathink, provider option descriptors.
- [ ] Runtime mode (full-access or approval) and interaction mode (default or plan) toggles, persisted per thread before each turn.
- [ ] Env mode: local or new worktree; base branch picker; branch checkout, including remote branches.
- [ ] `@path` mention autocomplete (`projects.searchEntries`).
- [ ] Image attachments from the clipboard or inline image paths; remove the last attachment.
- [ ] Slash commands: `/help`, `/project`, `/clone`, `/thread`, `/provider`, `/runtime`, `/interaction`, `/diff`, `/publish`, `/implement-plan`, `/approve`, `/answer`.
- [ ] Per-thread composer drafts are preserved.
- [ ] Context window usage meter.

Timeline

- [ ] User and assistant markdown with code blocks (tree-sitter highlighting) and copy-code.
- [ ] Work log entries (tool calls with command, changed files, icons, collapsed lifecycle).
- [ ] Active plan steps panel and proposed plan cards; plan follow-up prompt; implement plan (`sourceProposedPlan`).
- [ ] Image attachment preview (Kitty graphics), including downloading persisted attachments over HTTP.
- [ ] Scroll, scroll-to-bottom indicator, timestamps (format setting).

Approvals and user input

- [ ] Approval bar for command, file-read and file-change requests: accept, accept for session, decline.
- [ ] Multi-question user-input flow with progress and answers.

Diff

- [ ] Full thread diff view (unified or split, word wrap, ignore whitespace, collapse files).
- [ ] Open a diff in a Rex tab (`git diff HEAD`).

Terminal

- [ ] Per-thread terminal drawer: open, input line, clear, restart, close session; exit and error display.
- [ ] Open a terminal as a Rex split.

Git and source control

- [ ] Git quick-action menu: commit, push, create PR (stacked action with progress), pull.
- [ ] `/publish` and `/clone`.
- [ ] Source Control view: discovery of VCS and provider auth.
- [ ] Automatic git status refresh interval setting.

Settings views

- [ ] General: theme (TUI themes, terminal palette, system light or dark), timestamp format, assistant streaming, default env mode, add-project base directory, confirm delete, diff defaults, sidebar sort and preview count, OTLP URLs, git text-generation model.
- [ ] Providers: install and binary paths for Codex, Claude, Cursor and OpenCode; provider instances (duplicate, delete, env vars, accent color, enable); custom models; refresh; update CLI with notification.
- [ ] Keybindings: guide, open the keybindings file in an editor, server-resolved keybindings (thread jump and model picker jump).
- [ ] Scripts: create, edit and delete project scripts; run in the terminal; primary script.
- [ ] Connections: environment identity, backend URL copy, advertised endpoints.
- [ ] Diagnostics: process tree with signals, trace records, open logs folder.
- [ ] Archive: list archived threads, restore, delete.

Rex integration

- [ ] Open a thread in its own Rex tab (thread window attaching to the same server); reuse or focus an existing tab.
- [ ] Terminal split, diff tab.

Exit

- [ ] Ctrl+C quit prompt (double Ctrl+C), SIGINT/SIGTERM/SIGHUP handling, server stopped on exit.

---

## 8. Riskiest dependencies for the orchestration v2 port

These are spot checks against `t3up/main` (`packages/contracts/src/rpc.ts`, `orchestrationV2.ts`, `apps/server/src/cli/config.ts`). The upstream-mapping agent should confirm them.

1. **Full-snapshot model.** The TUI relies on `orchestration.getSnapshot` plus a payload-less `orchestration.domainEvent` ping. Upstream has neither. `ORCHESTRATION_V2_WS_METHODS` has `subscribeShell`, `subscribeThread`, `getThreadProjection`, `getArchivedShellSnapshot`, and so on. The sidebar (shell) and the active thread (thread projection) need to be rebuilt on these streams. This is the largest change.
2. **Read-model shape.** Timeline, approvals, user input, plans, context window, and work log are all derived from `thread.activities[]` with **untyped `payload` keys** (`requestId`, `requestKind`/`requestType`, `questions`, `plan`, `usedTokens`/`maxTokens`, `detail`, `itemType`, `data.*`) and from `messages`, `proposedPlans`, `latestTurn`, `session.status`/`activeTurnId`, `checkpoints.length`. If v2 has turn items or projections instead of activities, most of client-core's `sessionLogic.ts`, `sidebarStatus.ts` and `contextWindow.ts` must be rewritten against the v2 types.
3. **Wire protocol.** `WsTransport` speaks the old `{id, body:{_tag}}` / `{type:"push", channel}` envelope and decodes with `WsResponse`/`WsPush` from contracts `ws.ts`. Upstream uses an Effect RPC group (`rpc.ts`) with streaming `subscribe*` methods. The transport probably needs replacing with upstream's RPC client (or a port of what `apps/web` uses), not patching.
4. **Commands.** The TUI sends 14 command types (§4), including the legacy `provider` + `model` + `modelOptions` alongside `modelSelection`, `assistantDeliveryMode`, `sourceProposedPlan`, client-generated `threadId`/`messageId` (pending-send reconciliation depends on the server keeping `messageId`), and `thread.session.stop`. Check each against the v2 `ClientOrchestrationCommand`. Upstream also has `launchThread`, which may replace `thread.create` + `turn.start`.
5. **Renamed or removed RPCs.** Upstream renamed `git.status`/`listBranches`/`checkout`/`pull`/`createWorktree` to `vcs.refreshStatus`/`listRefs`/`switchRef`/`pull`/`createWorktree`, and adds `subscribeVcsStatus`. `git.actionProgress`, `terminal.event`, `server.configUpdated` and `server.welcome` push channels become `subscribe*` streams (`subscribeTerminalEvents`, `subscribeServerConfig`, `subscribeServerLifecycle`). `server.getAdvertisedEndpoints` is not an upstream WS method: upstream contracts only have `getAdvertisedEndpoints` on the desktop IPC bridge (`ipc.ts:1077`). `getSnapshot` and `server.welcome` appear nowhere in upstream contracts. `getFullThreadDiff` still exists.
6. **Server CLI flags.** Upstream `cli/config.ts` has `--mode` with `RuntimeMode = "web" | "desktop"` (no `"tui"`), `--base-dir` (no `--home-dir`), no `--auth-token` flag (upstream auth is session/`EnvironmentAuth`, possibly with `--bootstrap-fd`), and still has `--auto-bootstrap-project-from-cwd` and `--no-browser`. `serverSupervisor.ts` spawn args and the `?token=` WS auth must be reworked, along with attach-only and thread-window launch files, which pass `authToken`.
7. **Welcome bootstrap.** Initial project and thread selection depends on `server.welcome.bootstrapProjectId/ThreadId`. Upstream needs an equivalent, such as a lifecycle stream or `projects.ensureScratch`.
8. **Attachments.** `/attachments/{id}` is fetched without credentials. Upstream has `AttachmentUpload.ts`, `assets.createUrl` and `attachments.createUploadUrl`. Inline `dataUrl` attachments on `turn.start` may no longer be accepted.
9. **Packaging.** `bundle-server-dist.mjs` assumes `apps/server` `bun run build` produces `dist/` + `dist/client`, a bundlable `src/index.ts`, and `node-pty` as the only native dependency besides `ws`. Upstream's server likely has more native or external modules. **Resolved:** `bundle-server-dist.mjs` now packs the server with upstream's externals list and stages them with upstream's `stageRuntimeExternals` (from `scripts/build-cli-archive.ts`), without the web client.
10. **Lower risk.** These are mostly type renames: settings and providers (`ServerSettings`, `ServerProvider`, `ProviderInstanceConfig`, patch builders in `providerSettings.ts`), `@t3tools/shared/model` helpers, and `projectScripts`.
