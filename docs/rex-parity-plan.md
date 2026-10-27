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

Phase 1 (PR #2) ships step 1 only. Steps 2 to 4 come later, each in a new base branch.

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
