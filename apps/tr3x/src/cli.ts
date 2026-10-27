#!/usr/bin/env node
// @effect-diagnostics globalDate:off -- The CLI runs on Node outside the Effect runtime.
import { runDaemon } from "./daemon/daemon.ts";
import { runDoctor } from "./doctor.ts";
import { resolveTr3xPaths } from "./paths.ts";
import { describeError } from "./redact.ts";

const USAGE = `Usage: tr3x <command>

Commands:
  daemon   Start T3's server in TR3X_HOME (default ~/.tr3x), or attach to the daemon that runs it
  doctor   Check the daemon, server, providers, and Rex
`;

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (rest.length > 0 || (command !== "daemon" && command !== "doctor")) {
    process.stderr.write(`tr3x: unknown command "${argv.join(" ")}"\n\n${USAGE}`);
    return 2;
  }
  const paths = resolveTr3xPaths(process.env);
  if (command === "doctor") {
    return await runDoctor({
      paths,
      env: process.env,
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
