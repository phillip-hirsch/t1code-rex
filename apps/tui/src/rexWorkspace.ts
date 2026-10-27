import { execFile } from "node:child_process";

/**
 * Thin client for the Rex terminal multiplexer CLI. T1Code uses it to open
 * threads, terminals, and diffs as Rex tabs and panes when it runs inside Rex.
 */

export interface RexContext {
  readonly bin: string;
  readonly sessionId: string;
  readonly blockId: string | null;
}

export type RexSplitDirection = "right" | "left" | "above" | "below";

export interface RexTerminalSpec {
  readonly label: string;
  readonly cwd?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly keepOpen?: boolean | undefined;
  readonly focus?: boolean | undefined;
}

export interface RexSplitSpec extends RexTerminalSpec {
  readonly anchorBlockId?: string | null | undefined;
  readonly direction: RexSplitDirection;
  readonly ratio?: number | undefined;
}

export interface RexWindowRef {
  readonly windowId: string;
  readonly blockId: string;
}

export type RexRunner = (bin: string, args: readonly string[]) => Promise<string>;

export function resolveRexContext(env: NodeJS.ProcessEnv = process.env): RexContext | null {
  const sessionId = env.REX_SESSION?.trim();
  if (!sessionId) return null;
  return {
    bin: env.T1CODE_REX_BIN?.trim() || "rex",
    sessionId,
    blockId: env.REX_BLOCK?.trim() || null,
  };
}

function terminalArgs(spec: RexTerminalSpec): string[] {
  return [
    ...(spec.cwd ? ["-c", spec.cwd] : []),
    ...(spec.keepOpen ? ["--keep-open"] : []),
    `--focus=${spec.focus ?? true}`,
    "--json",
    ...(spec.command?.length ? ["--", ...spec.command] : []),
  ];
}

export function buildWindowNewArgs(ctx: RexContext, spec: RexTerminalSpec): string[] {
  return ["window", "new", "-s", ctx.sessionId, spec.label, ...terminalArgs(spec)];
}

export function buildSplitArgs(ctx: RexContext, spec: RexSplitSpec): string[] {
  const anchor = spec.anchorBlockId === undefined ? ctx.blockId : spec.anchorBlockId;
  return [
    "split",
    "-s",
    ctx.sessionId,
    ...(anchor ? ["-b", anchor] : []),
    `--split=${spec.direction}`,
    ...(spec.ratio !== undefined ? ["--ratio", String(Math.round(spec.ratio))] : []),
    "--label",
    spec.label,
    ...terminalArgs(spec),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJson(output: string, command: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`rex ${command} returned invalid JSON.`);
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(`rex ${command} returned an unexpected result.`);
  return record;
}

function firstBlockId(record: Record<string, unknown>, command: string): string {
  const blockIds = record.block_ids;
  const blockId = Array.isArray(blockIds) ? blockIds[0] : undefined;
  if (typeof blockId !== "string") throw new Error(`rex ${command} did not return a block.`);
  return blockId;
}

export function parseWindowNewResult(output: string): RexWindowRef {
  const record = parseJson(output, "window new");
  if (typeof record.window_id !== "string") {
    throw new Error("rex window new did not return a window.");
  }
  return { windowId: record.window_id, blockId: firstBlockId(record, "window new") };
}

export function parseSplitResult(output: string): { readonly blockId: string } {
  return { blockId: firstBlockId(parseJson(output, "split"), "split") };
}

export function parseWindowIds(output: string): ReadonlySet<string> {
  const windows = parseJson(output, "window ls").windows;
  const ids = new Set<string>();
  if (!Array.isArray(windows)) return ids;
  for (const window of windows) {
    const id = asRecord(window)?.window_id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

export const execRex: RexRunner = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim() || error.message;
        reject(new Error(`rex ${args.slice(0, 2).join(" ")} failed: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
  });

export interface RexClient {
  readonly context: RexContext;
  openWindow(spec: RexTerminalSpec): Promise<RexWindowRef>;
  split(spec: RexSplitSpec): Promise<{ readonly blockId: string }>;
  listWindowIds(): Promise<ReadonlySet<string>>;
  focus(target: string): Promise<void>;
}

export function createRexClient(context: RexContext, run: RexRunner = execRex): RexClient {
  return {
    context,
    async openWindow(spec) {
      return parseWindowNewResult(await run(context.bin, buildWindowNewArgs(context, spec)));
    },
    async split(spec) {
      return parseSplitResult(await run(context.bin, buildSplitArgs(context, spec)));
    },
    async listWindowIds() {
      return parseWindowIds(
        await run(context.bin, ["window", "ls", "-s", context.sessionId, "--json"]),
      );
    },
    async focus(target) {
      await run(context.bin, ["focus", "-s", context.sessionId, target]);
    },
  };
}

/**
 * Opens a tab once per key and focuses it again on later calls. If the user
 * closed the tab, a new one is opened.
 */
export function createRexWindowRegistry(client: RexClient) {
  const windowIdsByKey = new Map<string, string>();
  return {
    async openOrFocus(
      key: string,
      open: () => Promise<RexWindowRef>,
    ): Promise<{ readonly windowId: string; readonly reused: boolean }> {
      const known = windowIdsByKey.get(key);
      if (known && (await client.listWindowIds()).has(known)) {
        await client.focus(known);
        return { windowId: known, reused: true };
      }
      const { windowId } = await open();
      windowIdsByKey.set(key, windowId);
      return { windowId, reused: false };
    },
  };
}

export function rexTabLabel(title: string, maxLength = 32): string {
  const normalized = title.replace(/\s+/gu, " ").trim() || "Thread";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
