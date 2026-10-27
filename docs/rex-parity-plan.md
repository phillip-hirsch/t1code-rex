# Rex parity plan

Goal: bring T1Code to feature parity with the latest T3 Code desktop (Electron) app, with Rex as the window layer. T1Code creates threads and opens windows (Rex tabs and panes) where the desktop app opens windows.

## Branches

- Base branch: `rex-parity`. Base PR: `rex-parity` -> `main`.
- Each step is a sub-PR into `rex-parity`. Merge a sub-PR into `rex-parity` once it has proof and a Sol review.
- When every sub-PR is merged, run the base PR through council, then merge it into `main`.
- Merging to `main` runs `.github/workflows/publish-npm.yml`, which publishes `@maria_rcks/t1code` with the `dev` tag.

## Steps

1. Rex adapter (PR #1): open threads, terminals, and diffs as Rex tabs and panes.
2. Upstream catch-up for shared code: `packages/contracts`, `packages/shared`, `apps/server`.
3. Feature parity, one area per sub-PR, mapping desktop windows onto Rex tabs and panes.

## Size of the upstream gap

Measured 2026-10-26 against `pingdotgg/t3code` `main` at `ed44f251d`. The fork point is `b3bca04ca` (2026-03-25), 6,781 commits behind.

| Path | Files changed | Lines added |
| --- | --- | --- |
| `apps/server` | 1,533 | 492,440 |
| `apps/web` | 1,759 | 348,571 |
| `apps/desktop` | 296 | 70,495 |
| `packages/shared` | 217 | 41,551 |
| `packages/contracts` | 108 | 27,256 |

Upstream also split providers and source control into about 25 new packages (`packages/provider-*`, `packages/source-control-*`, `packages/ssh`, `packages/tailscale`, `packages/client-runtime`).
