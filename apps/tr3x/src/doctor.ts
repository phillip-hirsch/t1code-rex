// @effect-diagnostics nodeBuiltinImport:off -- tr3x runs on Bun outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import {
  AuthOrchestrationReadScope,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type DaemonState,
  isDaemonAlive,
  readDaemonState,
  readRecordedServer,
} from "./daemon/daemonState.ts";
import {
  describeStaleServer,
  type EnvironmentSummary,
  fetchEnvironmentSummary,
} from "./daemon/health.ts";
import { issueLocalSession } from "./daemon/localSession.ts";
import { checkBunRuntime } from "./bunRuntime.ts";
import { checkNodeRuntime } from "./daemon/nodeRuntime.ts";
import { findOnPath, isExecutableFile } from "./executables.ts";
import type { Tr3xPaths } from "./paths.ts";
import { isUsableProvider } from "./providers.ts";
import { describeError } from "./redact.ts";
import { fetchServerConfig } from "./serverConfig.ts";

export const REX_APP_BUNDLE_CLIS = [
  "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
  "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
];

type Status = "ok" | "fail" | "info";

export interface Check {
  readonly status: Status;
  readonly name: string;
  readonly detail: string;
  readonly lines?: ReadonlyArray<string>;
}

export interface DoctorOptions {
  readonly paths: Tr3xPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly rexAppBundleClis?: ReadonlyArray<string>;
  /** The running Bun's version, `process.versions.bun`; undefined outside Bun. */
  readonly bunVersion: string | undefined;
}

/** Prints one line per check and returns the exit code: 1 when a required check fails. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { paths, env } = options;
  const node = checkNodeRuntime(env);
  const bun = checkBunRuntime(options.bunVersion);
  const checks: Check[] = [
    bun.ok
      ? { status: "ok", name: "bun", detail: `Bun ${bun.version} runs tr3x` }
      : { status: "fail", name: "bun", detail: bun.detail },
    node.ok
      ? { status: "ok", name: "node", detail: `${node.node} (${node.version}) runs the T3 server` }
      : { status: "fail", name: "node", detail: node.detail },
  ];
  let state: DaemonState | undefined;
  let refused: string | undefined;
  try {
    state = readDaemonState(paths.daemonStatePath);
  } catch (error) {
    refused = describeError(error);
  }
  const live = state !== undefined && isDaemonAlive(state) ? state : undefined;
  const serverUrl = live?.httpBaseUrl ?? readRecordedServer(paths.serverRuntimeStatePath)?.origin;
  const environment =
    serverUrl === undefined
      ? undefined
      : await fetchEnvironmentSummary(serverUrl).catch(() => undefined);
  // Never send a credential to a server the daemon didn't record.
  const stale =
    live !== undefined && environment !== undefined
      ? describeStaleServer(live, environment)
      : undefined;
  const daemon = stale === undefined ? live : undefined;
  checks.push(
    refused !== undefined
      ? { status: "fail", name: "daemon", detail: `refusing its state file: ${refused}` }
      : stale !== undefined
        ? {
            status: "fail",
            name: "daemon",
            detail: `running (pid ${live?.pid}), but its state is stale: ${stale}`,
          }
        : daemon !== undefined
          ? {
              status: "ok",
              name: "daemon",
              detail: `running (pid ${daemon.pid}, server pid ${daemon.serverPid ?? "unknown"})`,
            }
          : {
              status: "fail",
              name: "daemon",
              detail:
                state === undefined
                  ? "not running. Start it with `tr3x daemon`."
                  : `not running (daemon ${state.pid} exited without cleaning up; the next \`tr3x daemon\` replaces its state). Start it with \`tr3x daemon\`.`,
            },
  );

  checks.push(serverCheck(serverUrl, environment, daemon !== undefined));
  checks.push(
    stale !== undefined
      ? { status: "fail", name: "providers", detail: "skipped: the daemon's state is stale" }
      : await providersCheck(paths, env, daemon, environment),
  );
  checks.push(rexCliCheck(env, options.rexAppBundleClis ?? REX_APP_BUNDLE_CLIS));
  const session = env.REX_SESSION?.trim();
  checks.push({
    status: "info",
    name: "rex session",
    detail: session
      ? `inside Rex (session ${session}${env.REX_BLOCK ? `, block ${env.REX_BLOCK}` : ""})`
      : "not inside Rex (REX_SESSION is unset)",
  });

  options.out(`tr3x doctor: ${paths.home}`);
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    options.out(`  ${check.status.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
    for (const line of check.lines ?? [])
      options.out(`  ${"".padEnd(4)}  ${"".padEnd(width)}    ${line}`);
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  options.out(failed === 0 ? "All required checks passed." : `${failed} required check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

function serverCheck(
  serverUrl: string | undefined,
  environment: EnvironmentSummary | undefined,
  ownedByDaemon: boolean,
): Check {
  if (serverUrl === undefined) return { status: "fail", name: "server", detail: "not running" };
  if (environment === undefined) {
    return { status: "fail", name: "server", detail: `not responding at ${serverUrl}` };
  }
  const protocol = environment.orchestrationProtocolVersion;
  const detail = `T3 ${environment.serverVersion}, orchestration protocol ${protocol ?? "unknown"}, ${serverUrl}${ownedByDaemon ? "" : " (no tr3x daemon started it; stop it, or set TR3X_HOME to another directory)"}`;
  if (protocol !== ORCHESTRATION_PROTOCOL_VERSION) {
    return {
      status: "fail",
      name: "server",
      detail: `${detail}. tr3x needs orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
    };
  }
  return { status: ownedByDaemon ? "ok" : "fail", name: "server", detail };
}

async function providersCheck(
  paths: Tr3xPaths,
  env: NodeJS.ProcessEnv,
  daemon: DaemonState | undefined,
  environment: EnvironmentSummary | undefined,
): Promise<Check> {
  if (daemon === undefined || environment === undefined) {
    return { status: "fail", name: "providers", detail: "unknown: needs a running tr3x daemon" };
  }
  let providers: ReadonlyArray<ServerProvider>;
  try {
    // Its own read-only session, so nothing long-lived is stored or can go stale.
    const session = await issueLocalSession({
      baseDir: paths.home,
      scopes: [AuthOrchestrationReadScope],
      ttl: "2m",
      label: "tr3x doctor",
      env,
    });
    const config = await Effect.runPromise(
      fetchServerConfig({ ...daemon, bearerToken: session.token }),
    );
    providers = config.providers;
  } catch (error) {
    return {
      status: "fail",
      name: "providers",
      detail: `could not read the server config: ${describeError(error)}`,
    };
  }
  return summarizeProviders(providers);
}

export function summarizeProviders(providers: ReadonlyArray<ServerProvider>): Check {
  const usable = providers.filter(isUsableProvider);
  const nameWidth = Math.max(0, ...providers.map((provider) => providerName(provider).length));
  return {
    status: usable.length > 0 ? "ok" : "fail",
    name: "providers",
    detail:
      usable.length > 0
        ? `${usable.length} of ${providers.length} usable`
        : `none of ${providers.length} usable. Install and sign in to Codex or Claude, and enable it in T3 settings.`,
    lines: providers.map((provider) =>
      [
        providerName(provider).padEnd(nameWidth),
        (provider.installed ? "installed" : "not installed").padEnd(13),
        (provider.enabled ? "enabled" : "disabled").padEnd(8),
        provider.status.padEnd(8),
        `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`.padEnd(9),
        ...(provider.auth.status === "unauthenticated" ? ["not signed in"] : []),
      ]
        .join("  ")
        .trimEnd(),
    ),
  };
}

function providerName(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

function rexCliCheck(env: NodeJS.ProcessEnv, appBundleClis: ReadonlyArray<string>): Check {
  const cli = resolveRexCli(env, appBundleClis);
  if (cli === undefined) {
    return {
      status: "fail",
      name: "rex",
      detail: "CLI not found on PATH or in /Applications. Install Rex, or set TR3X_REX_BIN.",
    };
  }
  const version = NodeChildProcess.spawnSync(cli, ["version"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  const firstLine = version.stdout?.trim().split("\n", 1)[0];
  if (version.status !== 0 || !firstLine) {
    const outcome = version.error
      ? version.error.message
      : version.status === null
        ? `stopped by ${version.signal}`
        : version.status === 0
          ? "printed nothing"
          : `exit code ${version.status}`;
    return { status: "fail", name: "rex", detail: `\`${cli} version\` failed (${outcome})` };
  }
  return { status: "ok", name: "rex", detail: `${cli} (${firstLine})` };
}

/** `TR3X_REX_BIN`, then `rex` on PATH, then the CLI inside the macOS app bundle. */
export function resolveRexCli(
  env: NodeJS.ProcessEnv,
  appBundleClis: ReadonlyArray<string> = REX_APP_BUNDLE_CLIS,
): string | undefined {
  const configured = env.TR3X_REX_BIN?.trim();
  if (configured && isExecutableFile(configured)) return configured;
  return findOnPath("rex", env) ?? appBundleClis.find(isExecutableFile);
}
