# tr3x design: a Rex plugin on T3 orchestration v2

Status: proposal, 2026-10-27. Research only; no product code yet.

tr3x becomes a herdr-style multiplexer for coding agents. T3 Code's orchestration v2 server runs the agents, Rex hosts them, and tr3x maps one to the other. Every T3 thread is a Rex tab running one small agent view. Rex's own tab bar and session picker replace a tr3x sidebar.

Evidence markers: **[V]** means verified here by running a command or reading the code at the cited path. **[A]** means an assumption that a PR still has to confirm.

Paths starting with `v2:` are in `origin/orchestration-v2` (upstream T3 Code `5127de8c` plus the abandoned TUI). `rex` means `/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`, version `0.0.1793047680-g2db882`, API revision 7. Rex docs are at <https://www.superlogical.com/rex/docs> (append `.md` to any page).

## Recommendation

```
 Rex app (tab bar, session picker, palette)      Rex server
 ┌───────────────────────────────────────┐   ┌─────────────────────────────┐
 │ session "my-app"                      │   │ init.lua: require("tr3x")   │
 │  tab "Fix login ⠼"   tab "Docs ⚠"     │   │   actions → rex.exec("tr3x")│
 │  ┌───────────────┐                    │   │ events  → tr3x daemon       │
 │  │ tr3x view T1  │── OSC 7501 status ─┼──▶│ program_status per block    │
 │  └───────────────┘                    │   └──────────────┬──────────────┘
 └──────────│────────────────────────────┘                  │ rex CLI: window new/close,
            │ client-runtime (Effect RPC over WS)            │ events --all --json
            │                                  ┌─────────────▼──────────────┐
            │                                  │ tr3x daemon (Node)         │
            │                                  │  shell stream → tab map    │
            │                                  │  issues per-tab bearer     │
            │                                  │  Unix socket for Lua/CLI   │
            │                                  └─────────────┬──────────────┘
            ▼                                                │ client-runtime
 ┌────────────────────────────────────────────────────────────▼──────────────┐
 │ T3 server (upstream apps/server, desktop mode, 127.0.0.1, one per user)   │
 │ orchestration v2: threads, runs, approvals, provider.switch + handoff     │
 └──────────────┬──────────────────────────────┬─────────────────────────────┘
                ▼                              ▼
       Claude Agent SDK                codex app-server
```

1. **T3 server**: upstream `apps/server`, unchanged. There is one per user, in its own base dir, and the daemon starts or attaches to it.
2. **Agent view** (`tr3x view <threadId>`): a small OpenTUI program in each Rex tab. It shows the transcript, the composer, approvals and questions, and a model/provider switch. It reports thread state to Rex with **OSC 7501**, Rex's program-status escape sequence, which drives the tab spinners and the blocked markers.
3. **Daemon** (`tr3x daemon`): subscribes to T3's shell stream and keeps Rex in step. It opens a tab for each thread, labels it, closes it on archive, rebuilds the map after restarts, and mints a bearer token for each tab.
4. **Rex glue** (`tr3x.lua`): the user requires it from `init.lua`. It adds palette actions and keybindings (New Thread, Open Thread…, Next Blocked) that call `tr3x` CLI subcommands, which talk to the daemon.

## 1. Rex extensibility

### What Rex offers

| Surface                            | What it does                                                                                                                                                                                                                                                                                                                                   | Persistent?                                                                                  | Evidence                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init.lua` config                  | `rex.bind`, `rex.action` (shows in the palette, binds to keys, `rex do NAME` from the CLI), `rex.exec`, `rex.exec.start{detach=true}`                                                                                                                                                                                                          | Loaded by the server. **No events**: `rex.on` in config only warns                           | [V] `reference/lua.md` (availability table), `customize/actions.md`                                                                                               |
| `rex do script.lua`                | One-shot or long-running Lua 5.1: `rex.on(event)`, timers, `rex.session.*`, `rex.block.call`, `rex.exec`. `--all` hears every session                                                                                                                                                                                                          | Runs only while `rex do` runs, so something external must keep it alive                      | [V] `automate/lua-events.md`. I ran a probe script: `program_status_changed` and `window_closed` arrived                                                          |
| Actions a script defines           | Not registered with the server: `rex actions` doesn't list them, `rex do NAME` fails, the app palette lacks them                                                                                                                                                                                                                               | —                                                                                            | [V] probe: `Error: no action named "tr3x_probe_new_thread"`                                                                                                       |
| Server API (`rex api list`)        | 70 methods, including `session.new_window`, `close_window`, `set_window_label`, `set_block_label`, `focus_window`, `focus_block`, `new_split`, `new_layer` (floating), `view`, `list_blocks`, `data.connect`, `client.perform`, `client.set_script`                                                                                            | Any client can call them                                                                     | [V] `rex api list`                                                                                                                                                |
| Events (`rex events --all --json`) | Session: `window_created/closed`, `window_label_changed`, `active_window_changed`, `block_created/closed`, `session_view_changed`, client attach/detach. Terminal: `program_status_changed/removed`, `title_changed`, `bell`, `desktop_notification`, `child_exited`, `process_changed`. Server: `session_created/destroyed`, `keymap_changed` | A stream, so any process can hold it open                                                    | [V] `reference/events.md`; `rex block types --json` lists the terminal events                                                                                     |
| Client (app) actions               | `session.select`, `client.tab.goto`, `client.sidebar.toggle`, `client.sidebar.activity.toggle`, `client.palette.toggle`, theme and font. **No notification, badge, or menu-item action**                                                                                                                                                       | Through `rex -C CLIENT do …`. The app accepts these from the CLI only with Remote Control on | [V] `rex -C 444425 actions`; Remote Control note in `customize/actions.md`                                                                                        |
| Program Status Protocol (OSC 7501) | A program writes `state=idle\|working\|done\|blocked\|error`, `kind=permission\|question\|auth`, `title`, `msg`, `progress`, and hierarchical `id`s. Rex shows a spinner and blocked symbols on unfocused tab headers, and an indicator in the session picker                                                                                  | Each record belongs to the terminal and is dropped when its process exits                    | [V] spec at `build/program-status.md`. In a probe session I emitted it and read it back with `rex block call … program_status`. [A] Not checked by eye in the app |
| Window title                       | OSC 0/2 from the program, readable with `block call title`                                                                                                                                                                                                                                                                                     | —                                                                                            | [V] probe                                                                                                                                                         |
| Tab label                          | `session.set_window_label`, up to 128 chars, no control characters                                                                                                                                                                                                                                                                             | —                                                                                            | [V] probe call returned `{"revision":2}` and a `window_label_changed` event                                                                                       |
| Block types                        | Only `com.superlogical.terminal.shell` (plus onboarding). No web or HTML block                                                                                                                                                                                                                                                                 | —                                                                                            | [V] `rex block types --json`                                                                                                                                      |

### Answers

- **Title, badge, color, notification, sidebar item, palette command, focus and close hooks.**
  - Tab title: yes, via `set_window_label` [V].
  - Badge or status: yes, but only through OSC 7501 written by the tab's own program. No API lets an outside process set a tab's status. `terminal.write` types _input_, it doesn't inject output [V].
  - Color: only the whole terminal's palette (`terminal.set_theme`); there is no tab color [V].
  - Notification: Rex has no notification action [V]. OSC 9/777 surface as a `desktop_notification` event. Whether the app shows them is [A]. Rex's docs say push notifications for status changes are planned.
  - Sidebar or status-bar item: no API [V]. The app has an "Activity" sidebar (`client.sidebar.activity.toggle`); [A] it lists program-status activity.
  - Palette commands: yes, from `init.lua` only [V].
  - Focus and close: `active_window_changed`, `window_closed`, and `block_closed` events [V].
- **Plugin or daemon?** Rex has no in-process plugin runtime. Config Lua has no events, and scripts stop when `rex do` exits. A persistent integration has to be an **external process**. That process can be a `rex do --all` script kept alive by something else, or any program that streams `rex events --all --json` and calls `rex` or `rex api call` [V].
- **What runs in a block.** Any command. Options: `command` (argv), `shell` (`none` runs it directly), `cwd`, `login`, `path_prepend`, `initial_input`, `exit`, `theme`, `size`. **There is no `env` option** [V] (`block types --json`). Environment comes from the login shell, and Rex adds `REX_SESSION` and `REX_BLOCK` [V] (`automate/cli.md`). To pass values, use an `env K=V … prog` argv prefix or a file. Never put secrets there, because argv is visible in `ps`.

### Ranked options for "show each thread's state" (herdr's sidebar)

1. **OSC 7501 from the agent view** (recommended). The view knows the thread state exactly and writes `working`, `blocked:kind=permission|question`, `idle`, `done`, or `error`, with `title` set to the thread title and `msg` set to the pending prompt or last line. Rex then draws tab spinners, blocked markers, and the session-picker indicator with no extra work [V spec, probe]. Subagents become child records (`id=sub/<n>`), which the protocol supports [V].
2. **Tab labels set by the daemon** (`"⚠ Fix login"`). This works from outside [V], but it's free text: Rex can't sort or filter it, and the user's own renames get overwritten. Use it only for the title.
3. **Notifications from the daemon** (for example `osascript`, as in Rex's own `notify.lua` example) on a change to `blocked` or `done`, rate-limited. Off by default.
4. **A status pane or floating layer** running `tr3x status`. This rebuilds the sidebar we chose not to build. Rejected.

## 2. Switching provider or model mid-thread in T3 v2

**Commands** [V `v2:packages/contracts/src/orchestrationV2.ts:2979, 3211`]:

- `thread.model-selection.set {threadId, modelSelection}` and `provider.switch {threadId, modelSelection}`, where `ModelSelection = {instanceId, model, options?}`. Both go through `orchestration.dispatchCommand`.
- The client helper `updateThreadSettings({modelSelection})` [V `v2:packages/client-runtime/src/operations/commands.ts:632`] always sends `thread.model-selection.set` when the server advertises `serverResolvedCommandContext`, which upstream does [V `v2:apps/server/src/environment/ServerEnvironment.ts:256`]. Otherwise it picks between the two with `modelSelectionCommandType` [V `v2:packages/shared/src/model.ts:17`].
- `message.dispatch` also takes an optional `modelSelection`, used for that run [V `Orchestrator.ts:5195`].

**What the server does** [V `v2:apps/server/src/orchestration-v2/{Orchestrator.ts:3098-3137,3652,3721; ProviderSwitchService.ts; ProviderSessionTransitionPolicy.ts}`]:

- Planning: `ProviderSwitchService.plan` classifies the change as `reuse`, `switch_model_in_session`, `restart_and_resume`, `create_with_handoff`, or `reject` (for example "The target provider instance is unavailable.").
- The command only updates the thread's `modelSelection`/`providerInstanceId` and emits `thread.provider-switched` or `thread.model-selection-updated`. It releases sessions the plan no longer needs.
- The context transfer happens **lazily at the next run**. A `ContextTransfer` of type `provider_handoff` plus a `ContextHandoff` artifact are created. Returning to a provider resumes its old native thread with a delta handoff; a new provider gets a fresh native thread with the full history (design: `v2:docs/orchestration-v2/provider-switching-and-context.md`).
- Supported: Claude and Codex both declare `supportsProviderSwitchingViaHandoff: true` [V `ClaudeAdapterV2.ts:357`, `CodexAdapterV2.ts:240`], and so do opencode, cursor, pi, muse, and ACP.

**Preconditions:**

- The thread must not be deleted, and the target instance must exist and be enabled [V].
- I found no server guard against switching while a run is active. The new selection applies to the next run [V by reading; A whether a mid-run switch behaves well]. **The view should allow switching only when no run is active** (`resolveActiveThreadRun` is null). Web gets the same effect through `threadSupportsProviderHandoff`, which returns false while a run is active and no session exists [V `v2:packages/client-runtime/src/state/threadWorkflows.ts:91`].

**What the user sees:**

- A `handoff` turn item (`fromProviderInstanceIds`, `toProviderInstanceId`, `toModel`, `strategy`, `summary`) [V `orchestrationV2.ts:1588`]. Web draws it as a divider row "from → to" (`EnvironmentHandoffRow`, `v2:apps/web/src/components/chat/V2LifecycleRow.tsx:132`), with endpoints from `resolveHandoffEndpoints` (`v2:packages/client-runtime/src/handoff.ts`).
- In web's picker, a switch is blocked only when the thread lacks handoff support ("Start a new chat to switch providers"; `v2:apps/web/src/components/ChatView.logic.ts:958`).

**How faithful the context carry-over is** [V `v2:packages/provider-core/src/server/handoffBudget.ts`, `ContextHandoffService.ts`]:

- The handoff is **not an LLM summary**. It's a deterministic replay of user and assistant messages, commands with their exit code and output, file-change _names_, proposed plans, and errors.
- Reasoning, tool-call internals, diffs, and images are dropped.
- It's capped at `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, default 16,000, keeping the most recent items. Long Codex → Claude switches lose older detail and native tool state.
- Expected and acceptable, but the view should show the `handoff` row so the user knows a switch happened.

## 3. The shared agent view

### Minimum feature set

| Area       | In scope                                                                                                                                                                                                                                                                                                                                         | Out of scope (for now)                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Transcript | `visibleTurnItems`: user and assistant messages (markdown), collapsed reasoning, one-line tool rows (`command_execution`, `file_change`, `file_search`, `web_search`, `dynamic_tool`), `approval_request` and `user_input_request`, dividers for `handoff`, `compaction`, `error`, and `system_notice`, one-line `subagent` rows, history paging | diffs, checkpoints and revert, PRs, plan editor, images                         |
| Composer   | multiline input; Enter sends `message.dispatch` with `deliveryIntent:"auto"` (the server picks steer or queue); Stop sends `run.interrupt {holdQueue:true}`; queued messages listed with cancel                                                                                                                                                  | queue editor or reorder, @mentions, attachments, slash commands except `/model` |
| Requests   | approve (accept, accept for session, decline) and answer questions (options plus free text, dismiss)                                                                                                                                                                                                                                             | secrets, auth refresh                                                           |
| Switch     | picker over `ServerConfig.providers × models`, disabled while a run is active or when `threadSupportsProviderHandoff` is false; runtime-mode toggle (approval-required or full-access)                                                                                                                                                           | per-model option editors beyond what `providerOptionSelections` covers          |
| Rex        | OSC 7501 root record plus subagent child records; OSC 2 title                                                                                                                                                                                                                                                                                    | —                                                                               |

**client-runtime pieces it needs** [V that the files exist in `v2:packages/client-runtime/src`]:

- Connection: `rpc/*`, `connection/*` (through the TUI's platform layer), `state/server`, `state/models`, `state/providerInstanceDisplay`.
- Thread state and transcript: `state/threads` (`makeEnvironmentThreadState`), `state/orchestrationV2Projection`, `state/threadHistoryController`, `state/threadRequests`, `state/threadWorkflows`, `state/threadSubagents`, `state/turnItemPresentation`, `work-log/*`, `handoff.ts`.
- Commands: `operations/commands` (`startThreadTurn`, `interruptThreadTurn`, `respondToThreadApproval`, `respondToThreadUserInput`, `dismissThreadUserInput`, `updateThreadSettings`, `setThreadRuntimeMode`, `cancelQueuedRun`).
- New-thread launch: the `orchestration.launchThread` RPC.

### Could we avoid a custom renderer?

No. I checked each cheaper option:

- `t3 thread list|start|send|show` exists upstream [V `v2:apps/server/src/cli/thread.ts:499-702`]. It's one-shot and runs over the server's `/mcp` endpoint: no live stream, no approvals UI, no switch.
- Rex has no web block that could host the web UI [V].
- Running native `claude` or `codex` CLIs in tabs skips T3, which rules out the provider switch (decision 1).

The CLI is still useful to the daemon for scripting.

### Size and reuse

Target: about **4–5k non-test lines** for the view, against 25k for the abandoned TUI (`v2:apps/tui/src`, `wc -l`). About 60% of it can be ported.

| Reuse as-is or lightly trimmed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rewrite, smaller                                                                                                                                                                                                                                                                                                                | Delete                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serverLauncher.ts` (542, moves to the daemon), `connection/platform.ts` and `runtime.ts`, `threadWindowLaunch.ts` (169; drop `view:"diff"`), `rexWorkspace.ts` (210, daemon), `messageMarkdown*.ts(x)` and `codeBlockParsers.ts`, `threadTimeline.ts` (439), `threadScroll*.ts`, `questionAnswers.ts`, `requestResponder.ts`, `requestQueue.ts`, `requestHold.ts`, `modelPicker.ts`, `providerInstances.ts`, `providerOptionSelections.ts`, `composerKeys.ts`, `textareaOffsets.ts`, `sidebarStatus.ts` (becomes the thread-to-OSC 7501 mapping), `workEntryIcons.ts`, `duration.ts`, `relativeTime.ts`, `theme.ts` (trimmed) | `ui.tsx` (2,136 → ~300 single-view shell), `composer.tsx` (1,063 → ~400), `composerSender.ts` (724 → ~150, since the server resolves steer or queue), `threadView.tsx` (588, mostly kept), `requestPanelView.tsx` (719 → ~400), `connection/tuiConnection.ts` (530 → ~200, thread and server atoms only), `modelPickerView.tsx` | `sidebar*`, `management*`, `diff*`, `git*`, `branch*`, `terminal*`, `worktree*`, `archivedThreads`, `connectionsPanel`, `commandPaletteProjects`, `providerUpdateNotifications`, `newThreadView` |

## 4. The mapping service (daemon)

**Topology.**

- One T3 server per user, because the server is multi-project and one server owns each base dir. A second server exits with code 78 [V `upstream-v2-api.md` §5.1, `desktopBootstrap.ts:6`].
- The daemon starts it in desktop mode with the bootstrap over stdin, or attaches to it through `server-runtime.json`. `serverLauncher.ts` already does both [V].
- One Rex **session per T3 project** (session label = project title) and one **tab per open thread**. The daemon is a single Node process; any `tr3x` command starts it if it isn't running, the way `rex --autostart` starts the Rex server.
- Its control socket is `$XDG_STATE_HOME/tr3x/daemon.sock`, mode 0600.

**Thread → tab** (the daemon owns every tab change):

| Event                                                                                       | Action                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A thread appears in `subscribeShell` and is opened (by the user, or by a new-thread action) | `rex window new -s <project session> "<title>" --shell=none --json -- env TR3X_LAUNCH=<file> tr3x view`, then `set_block_label tr3x:<threadId>` so it can be found again |
| The thread title changes                                                                    | `set_window_label` (truncated, `rexTabLabel`)                                                                                                                            |
| Open or focus                                                                               | `session.focus_window`, then the client action `session.select` when Remote Control is on [V both exist]                                                                 |
| `thread.archived`, `thread.deleted`                                                         | `session.close_window`, then revoke the tab's session                                                                                                                    |
| The user closes the tab (`window_closed`)                                                   | Revoke the tab's bearer and mark the thread _hidden_. Don't archive it (open question 2)                                                                                 |
| A thread is blocked and has no tab                                                          | Open the tab in the background (`--focus=false`) so its blocked marker shows                                                                                             |

**New thread from Rex.** `tr3x.lua` adds `tr3x_new_thread` (for example on `cmd+shift+t`). It runs `rex.exec{"tr3x","new","--cwd",<focused pwd>}`, and the daemon opens a tab running `tr3x view --new --project <id>`. The composer _is_ the prompt box, and the first send calls `orchestration.launchThread`. `Open Thread…` opens a floating layer (`session.new_layer` [V]) running `tr3x pick`, a fuzzy list of hidden and archived threads. Rex has no custom picker API [V].

**Subagents.**

- Provider-native subagents are child threads (`lineage.relationshipToParent="subagent"`) and are read-only [V `upstream-v2-api.md` §2.3].
- Default: no tabs. The parent view lists them, and each running child becomes an OSC 7501 child record on the parent's terminal, so the parent's tab shows their state.
- `o` on a subagent row splits a read-only `tr3x view <child>` pane into the parent's tab (`session.new_split`).
- App-owned delegated threads that accept messages may get their own tabs (open question 4).

**Restart and reconnect.**

- **Daemon restart**: rebuilds the map from `rex session view` and blocks labeled `tr3x:*`, with no state file and no duplicate tabs. It replays the shell stream from its snapshot.
- **View**: client-runtime supervision retries the socket. `subscribeThread` resumes from `afterSequence`, and the client dedupes by sequence [V spec §2.2]. While disconnected, the view keeps its last status and shows "reconnecting".
- **T3 server restart**: the daemon restarts it and the views reconnect. Their bearer sessions survive because they're stored in the base dir [A].
- **Rex server restart**: tabs are gone, so the daemon reopens tabs for threads that were open and are active or blocked [A whether Rex restores sessions itself].

**Security.**

- The daemon holds the only long-lived bearer. For each tab it issues a scoped session (`orchestration:read orchestration:operate`, `providers:manage` only if the view does provider auth) through `EnvironmentAuth.issueSession`, the same call `t3 auth session issue` makes [V `v2:apps/server/src/cli/auth.ts:159`].
- It writes `{server, threadId, bearer}` to a one-shot launch file: mode 0600, in a 0700 directory, opened with `wx`, deleted by the view on read, and expired by the daemon after 60 s. This is `threadWindowLaunch.ts` as it exists today [V].
- Only the file path goes in argv. Rex can't pass env [V], so tokens would otherwise end up in `ps`.
- The daemon revokes the session on `window_closed` or `block_closed`.
- The T3 server listens on loopback only, and the daemon socket is 0600. OSC 7501 `msg` text is untrusted model output: the view strips control characters before base64 (the protocol refuses them anyway [V]).

## 5. Repo plan

**Bringing back upstream.** `origin/orchestration-v2` contains `1256e7938 chore: merge upstream T3 Code (orchestration v2)`. Its parents are `8c79236ab`, which is current `origin/main`, and upstream `5127de8c` [V `git log -1 --format=%P`].

- So main can take that merge as a fast-forward, then merge current `t3up/main` (`02329327c`, 100 commits newer [V `git rev-list --count`]).
- This keeps upstream history intact, so later merges stay cheap.
- Don't cherry-pick the TUI commits that came after (`9b5eae364` onward).
- Whether `1256e7938` passes typecheck by itself is [A]; the PR verifies it.

**Deletions.**

- The v1 TUI `apps/tui` (78 files on main [V]) and `packages/client-core` (31 files [V]).
- `docs/rex-parity-plan.md` (superseded).
- Upstream's `apps/web`, `apps/desktop`, `apps/mobile`, and `apps/marketing` stay in the tree, untouched, so upstream merges stay clean. CI doesn't build the apps tr3x doesn't ship (open question 5).

**New layout.**

```
apps/server              upstream, untouched
apps/web, desktop, …     upstream, untouched, not built in tr3x CI
apps/tr3x                Node package, bin "tr3x"
  src/daemon/            shell stream → Rex map, server launcher, bearer issuing, control socket
  src/rex/               rex CLI client, events stream, labels (from rexWorkspace.ts)
  src/view/              agent view (OpenTUI + client-runtime + @effect/atom-react)
  src/status/            thread state → OSC 7501 / OSC 2
  src/cli.ts             tr3x daemon | view | new | open | pick | doctor | setup rex
  rex/tr3x.lua           palette actions and keybindings for init.lua
packages/contracts, client-runtime, shared, provider-*   upstream
```

### Proposed PRs, each off the previous one

1. **`chore: merge upstream T3 Code with orchestration v2 into main`**
   - Scope: fast-forward to `1256e7938`, then merge `t3up/main`. Keep this fork's CI change (`c360c6ddf`, no npm publish).
   - Acceptance: `vp i`, the filtered typecheck, `vp lint`, `vp fmt --check` and the package tests pass. `node apps/server/src/bin.ts --mode desktop --bootstrap-fd 0` serves `/.well-known/t3/environment` with `orchestrationProtocolVersion: 2`.
2. **`chore: remove the v1 TUI and client-core, add the tr3x package skeleton`**
   - Scope: delete `apps/tui` and `packages/client-core`. Add `apps/tr3x` with `serverLauncher`, the `connection/` platform layer, and `tr3x daemon` (start or attach, health) plus `tr3x doctor`.
   - Acceptance: checks pass. `tr3x daemon` starts a server in the tr3x base dir, a second run attaches instead of failing with 78, and `tr3x doctor` reports the providers.
3. **`feat(tr3x): shared agent view with mid-thread provider switching`**
   - Scope: `tr3x view` with the section 3 feature set, plus OSC 7501 and OSC 2.
   - Acceptance:
     - A scripted check (in the style of the old `check-transcript`) drives a thread against `packages/provider-testing` fakes.
     - A manual run switches Codex → Claude between runs: a `handoff` row appears, and the Claude run can cite an earlier Codex answer.
     - The picker is disabled while a run is active.
     - In a scratch Rex session, `rex block call … program_status` shows `blocked kind=permission` during an approval, then `idle`.
4. **`feat(tr3x): map T3 threads to Rex tabs`**
   - Scope: daemon mapping, launch-file bearer handling and revocation, `tr3x.lua` (New Thread, Open Thread…, Next Blocked), and `tr3x setup rex`, which prints the `require` line and never edits the config.
   - Acceptance, in a scratch Rex session:
     - New Thread opens a tab.
     - Archiving in web closes it.
     - Killing and restarting the daemon creates no duplicate tabs.
     - `ps -o args` shows no token.
     - Closing a tab revokes its session (`t3 auth session list`).
5. **`feat(tr3x): subagent status and blocked notifications`** (optional)
   - Scope: OSC 7501 child records, read-only subagent panes, opt-in rate-limited macOS notifications, packaging.
   - Acceptance: a parent with two running subagents shows three records, and finishing one clears its record.

## Alternatives considered

- **A pure Lua plugin** (`rex do --all` as the mapper). Lua 5.1 has no WebSocket or Effect RPC client, and `io.popen` is disabled, so it would need a helper process anyway [V `reference/lua.md`]. Lua stays as palette glue only.
- **No daemon, each view opens its own tabs.** This is the abandoned design. Nothing would own archive → close, the rebuild after restarts, or bearer revocation, and a new thread from Rex would need a view that's already running.
- **Native agent CLIs in panes with status detection** (herdr's model). It drops T3 orchestration and the provider switch (decision 1).
- **Status in tab labels only.** It works from outside Rex, but it's free text that clobbers user renames and doesn't feed the session picker. Kept for titles only.
- **Connecting the daemon as a Rex client that declares actions** (`client.keymap`/`client.perform`). [A] those actions appear only in that client's own palette, not the app's, so `init.lua` stays the way into the palette.

## Decisions (2026-10-27)

The user answered questions 1–4. Questions 5–8 take the suggested defaults unless the user says otherwise.

1. **Base dir:** tr3x keeps its own server and data in `~/.tr3x`, separate from T3 Code desktop's `~/.t3`.
2. **Closing a tab:** hides the thread; it doesn't archive it. The thread's tab can be reopened.
3. **Rex sessions:** one Rex session per project.
4. **Subagents:** shown as status on the parent tab, with a pane opened on demand.
5. **Upstream apps:** web, desktop, mobile, and marketing stay in the tree, unbuilt, so upstream merges stay cheap.
6. **Merge cadence:** merge `t3up/main` when needed, not on a schedule.
7. **Rex setup:** one `require("tr3x")` line in `init.lua`.
8. **Notifications:** the daemon's macOS notifications are opt-in until Rex ships its own.
9. **Runtime:** the `tr3x` CLI runs on Node, the same runtime as upstream's server, not Bun (PR #26). PR 3 checks whether OpenTUI works on Node 26.4+ with `--experimental-ffi`. If it doesn't, only `tr3x view` falls back to Bun.
