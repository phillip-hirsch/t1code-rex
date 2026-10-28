// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures on disk, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const MOCK_AGENT = NodeURL.fileURLToPath(
  new URL("../../../server/scripts/acp-mock-agent.ts", import.meta.url),
);

const MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

/** A stand-in Grok CLI: canned `--version` and `models`, and upstream's mock ACP agent for `agent`. */
function writeFakeGrok(directory: string, env: Readonly<Record<string, string>>): string {
  return writeFakeCli({
    directory,
    name: "grok",
    env,
    source: [
      'if (process.argv[2] === "--version") { process.stdout.write("grok 1.0.13\\n"); process.exit(0); }',
      `if (process.argv[2] === "models") { process.stdout.write(${JSON.stringify(MODELS_OUTPUT)}); process.exit(0); }`,
      // Approval modes put `--permission-mode <mode>` before `agent`.
      'if (!process.argv.includes("agent")) process.exit(1);',
      execScriptSource({ scriptPath: MOCK_AGENT }),
    ].join("\n"),
  });
}

export interface FakeProviders {
  /** Raw ACP frames the second provider received, prompts included. */
  readonly secondRequestLog: string;
}

/**
 * Writes the server's settings in `home` so it runs two fake providers and no
 * real ones: "Grok" answers with `firstReply`; "Grok B" asks to run a command,
 * then replies "hello from mock".
 */
export function installFakeProviders(home: string, firstReply: string): FakeProviders {
  const bin = NodePath.join(home, "fake-bin");
  const secondRequestLog = NodePath.join(bin, "grok-b-requests.ndjson");
  // The mock's model option doesn't list Grok's slugs; without it the adapter keeps the default.
  const first = writeFakeGrok(NodePath.join(bin, "a"), {
    T3_ACP_PROMPT_RESPONSE_TEXT: firstReply,
    T3_ACP_OMIT_MODEL_CONFIG_OPTION: "1",
  });
  const second = writeFakeGrok(NodePath.join(bin, "b"), {
    T3_ACP_OMIT_MODEL_CONFIG_OPTION: "1",
    T3_ACP_EMIT_TOOL_CALLS: "1",
    T3_ACP_REQUEST_LOG_PATH: secondRequestLog,
  });
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", enabled: false },
        grok: { driver: "grok", enabled: true, config: { enabled: true, binaryPath: first } },
        grokB: {
          driver: "grok",
          displayName: "Grok B",
          enabled: true,
          config: { enabled: true, binaryPath: second },
        },
      },
    }),
  );
  return { secondRequestLog };
}
