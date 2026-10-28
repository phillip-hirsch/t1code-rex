#!/usr/bin/env bun
import { describeError } from "./redact.ts";
import { runCli } from "./runCli.ts";

runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  bunVersion: process.versions.bun,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`tr3x: ${describeError(error)}\n`);
    process.exit(1);
  },
);
