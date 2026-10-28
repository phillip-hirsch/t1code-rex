# tr3x

tr3x will put T3 Code's orchestration v2 in Rex: every thread in a Rex tab, with model and provider switching mid-thread.

It's an early work in progress. The design is in [PR #24](https://github.com/phillip-hirsch/tr3x/pull/24).

The `tr3x` CLI in `apps/tr3x` runs on [Bun](https://bun.sh) 1.3.14 or later: `bun apps/tr3x/src/cli.ts daemon`, then `bun apps/tr3x/src/cli.ts doctor`. `bun apps/tr3x/src/cli.ts view --new` starts a thread in the current directory, and `view <threadId>` opens one; switch model or provider between runs with ctrl+p. The T3 server it starts runs on Node (`node` on `PATH`, or `TR3X_NODE_BIN`), in `~/.tr3x` (or `TR3X_HOME`), never T3 Code's `~/.t3`.

<sub>Built on [T3 Code](https://github.com/pingdotgg/t3code) by [@t3dotgg](https://github.com/t3dotgg) and [@juliusmarminge](https://github.com/juliusmarminge), and forked from [t1code](https://github.com/maria-rcks/t1code) by [@maria-rcks](https://github.com/maria-rcks).</sub>
