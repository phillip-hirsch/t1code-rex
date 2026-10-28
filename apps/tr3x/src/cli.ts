#!/usr/bin/env bun
// @effect-diagnostics globalDate:off -- The CLI runs on Bun outside the Effect runtime.
import { parseArgs, USAGE } from "./args.ts";
import { checkBunRuntime } from "./bunRuntime.ts";
import { runDaemon } from "./daemon/daemon.ts";
import { runDoctor } from "./doctor.ts";
import { resolveTr3xPaths } from "./paths.ts";
import { describeError } from "./redact.ts";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 2;
  }
  const command = parseArgs(argv, process.cwd());
  if (command === null) {
    process.stderr.write(`tr3x: unknown command "${argv.join(" ")}"\n\n${USAGE}`);
    return 2;
  }
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const bun = checkBunRuntime(process.versions.bun);
  if (!bun.ok) {
    process.stderr.write(`tr3x: ${bun.detail}\n`);
    return 1;
  }
  const paths = resolveTr3xPaths(process.env);
  if (command.kind === "view" || command.kind === "new") {
    // Loaded only here, so daemon and doctor never load OpenTUI.
    const { runView } = await import("./view/main.tsx");
    const { ThreadId } = await import("@t3tools/contracts");
    return await runView({
      paths,
      env: process.env,
      target:
        command.kind === "view"
          ? { kind: "thread", threadId: ThreadId.make(command.threadId) }
          : { kind: "new", cwd: command.cwd },
    });
  }
  if (command.kind === "doctor") {
    return await runDoctor({
      paths,
      env: process.env,
      bunVersion: process.versions.bun,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  }
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => controller.abort());
  }
  return await runDaemon({
    paths,
    env: process.env,
    signal: controller.signal,
    log: (line) => process.stdout.write(`${new Date().toISOString()} tr3x daemon: ${line}\n`),
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`tr3x: ${describeError(error)}\n`);
    process.exit(1);
  },
);
