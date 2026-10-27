# Rex parity plan

Goal: a [herdr](https://herdr.dev)-style multiplexer for coding agents. T3 Code's orchestration v2 is the backend, and Rex is the window layer. Each thread runs in its own Rex tab, and T1Code shows which agents are working, idle, or waiting on you.

## Branches

- Each phase gets a base branch and a base PR into `main`. Phase 1 uses `rex-parity` (PR #2).
- Each step is a sub-PR into the base branch. A sub-PR merges once it has proof and a Sol review.
- When every sub-PR is in, the base PR goes through council and then merges into `main`.
- This repo is a fork and doesn't publish to npm.

## Steps

1. **Rex tabs for threads (done, PR #1).** Open a thread, a terminal, or a diff as a Rex tab or pane. Thread tabs attach to the opening window's server.
2. **Orchestration v2 (next).** Port upstream `apps/server/src/orchestration-v2` and the contracts it needs, then move the TUI onto it. Upstream design docs: `docs/orchestration-v2/` in `pingdotgg/t3code`.
3. **herdr-style agent view.** Show every thread's state (working, idle, blocked, waiting for approval) in T1Code, and jump to the Rex tab that needs attention.
4. **Remaining desktop features.** One area per sub-PR, mapping desktop windows onto Rex tabs and panes.

Phase 1 (PR #2) shipped step 1. Steps 3 and 4 come later, each in a new base branch.

## Phase 2: orchestration v2

Base branch `orchestration-v2`, base PR into `main`. Started 2026-10-26.

Approach: re-fork on upstream rather than port orchestration v2 into the old server. The fork's own server changes were almost all older copies of upstream work. Its only TUI-specific server feature, `--mode tui`, behaves like upstream's `--mode desktop`.

1. **Upstream merge (sub-PR).** A real merge of `pingdotgg/t3code` `main` at `5127de8c`. Everything outside `apps/tui`, `packages/client-core`, and a few root files matches upstream. Merge it with a merge commit, never a squash, so later syncs start from this merge base.
2. **Port `packages/client-core` and `apps/tui` onto the upstream server** in sub-PRs, one feature area at a time. The TUI doesn't build against the new server until this lands, so the base PR stays unmerged until the TUI works end to end.

Values this phase depends on:

- Tooling: pnpm `12.14.0` and Vite+ (`vp i`, `vp run <script>`, `vp run --filter <pkg> typecheck`, `vp test run <files>`). The TUI still runs on Bun.
- Node: upstream pins `26.12.1`; local Node `24.22.1` installs and runs the server.
- Server CLI (`node apps/server/src/bin.ts`): no `--auth-token` flag. Secrets go through `--bootstrap-fd`; data dir is `--base-dir` (or `T3CODE_HOME`); `--mode` is `web` or `desktop`; `serve` runs headless.
- Upstream workflows are not carried over. They publish, deploy, or need Blacksmith runners. A fork CI is a follow-up.

## Size of the upstream gap

Measured 2026-10-26 against `pingdotgg/t3code` `main` at `ed44f251d`. The fork point is `b3bca04ca` (2026-03-25), 6,781 commits behind.

| Path                                     | Files changed | Lines added |
| ---------------------------------------- | ------------- | ----------- |
| `apps/server`                            | 1,533         | 492,440     |
| `apps/server/src/orchestration-v2` (new) | 542           | 213,067     |
| `apps/web`                               | 1,759         | 348,571     |
| `apps/desktop`                           | 296           | 70,495      |
| `packages/shared`                        | 217           | 41,551      |
| `packages/contracts`                     | 108           | 27,256      |

Upstream also split providers and source control into about 25 new packages (`packages/provider-*`, `packages/source-control-*`, `packages/ssh`, `packages/tailscale`, `packages/client-runtime`).
