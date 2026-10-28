// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import type { AuthGrantScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { resolveServerCommand, stripReservedLaunchEnv } from "./serverLauncher.ts";

/**
 * Mints a scoped, short-lived session through upstream's local auth control
 * plane (`t3 auth session issue`), so no long-lived bearer is stored anywhere.
 * The token comes back on the child's stdout, never in argv.
 */

const IssuedSession = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
});
export type IssuedSession = typeof IssuedSession.Type;

const decodeIssuedSession = Schema.decodeUnknownSync(Schema.fromJsonString(IssuedSession));

export interface IssueLocalSessionInput {
  readonly baseDir: string;
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  /** Upstream's duration syntax, e.g. `2m`. */
  readonly ttl: string;
  readonly label: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function issueLocalSession(input: IssueLocalSessionInput): Promise<IssuedSession> {
  const { command, args: entryArgs, cwd } = resolveServerCommand(input.env);
  const args = [
    ...entryArgs,
    "auth",
    "session",
    "issue",
    "--base-dir",
    input.baseDir,
    ...input.scopes.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    input.ttl,
    "--label",
    input.label,
    "--json",
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { cwd, env: stripReservedLaunchEnv(input.env), timeout: 20_000, encoding: "utf8" },
      (error, out, err) => {
        if (error) {
          // A Node that can't run says so in the spawn error, not on stderr.
          const detail =
            err.trim().split("\n").at(-1) ||
            (error.code === "ENOENT" || error.code === "EACCES"
              ? `${command} can't run (${error.code}). Set TR3X_NODE_BIN to a Node binary.`
              : error.killed
                ? "it took too long"
                : undefined);
          // Not "session: …": redaction reads that as a credential and hides the reason.
          reject(new Error(`Could not issue a session.${detail ? ` ${detail}` : ""}`));
        } else resolve(out);
      },
    );
  });
  return decodeIssuedSession(stdout.trim());
}
