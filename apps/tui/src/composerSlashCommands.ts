import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

import { parseRuntimeMode } from "./composerSettings.ts";

/**
 * The composer's own slash commands. Anything else that starts with "/" goes to the agent
 * as text, so provider commands such as /compact or /goal keep working.
 */
export interface ComposerSlashCommand {
  readonly command: string;
  readonly usage: string;
  readonly description: string;
  /** What Tab or Enter on the menu puts in the composer. */
  readonly template: string;
}

export const COMPOSER_SLASH_COMMANDS: ReadonlyArray<ComposerSlashCommand> = [
  {
    command: "new",
    usage: "/new",
    description: "Start a new thread in this project",
    template: "/new",
  },
  {
    command: "model",
    usage: "/model",
    description: "Pick the provider and model",
    template: "/model",
  },
  { command: "plan", usage: "/plan", description: "Plan before making changes", template: "/plan" },
  {
    command: "default",
    usage: "/default",
    description: "Chat without a plan step",
    template: "/default",
  },
  {
    command: "runtime",
    usage: "/runtime [approval|edits|auto|full]",
    description: "Set or cycle the runtime mode",
    template: "/runtime ",
  },
  {
    command: "steer",
    usage: "/steer <message>",
    description: "Steer the running turn (what Enter does)",
    template: "/steer ",
  },
  {
    command: "queue",
    usage: "/queue <message>",
    description: "Queue a message after the running turn (⌘Enter)",
    template: "/queue ",
  },
  {
    command: "resume",
    usage: "/resume",
    description: "Send messages held after Stop, or stuck ones",
    template: "/resume",
  },
  {
    command: "discard",
    usage: "/discard",
    description: "Put unsent messages back in the composer",
    template: "/discard",
  },
  {
    command: "clone",
    usage: "/clone owner/repo [destination]",
    description: "Clone a repository and add it as a project",
    template: "/clone ",
  },
  {
    command: "diff",
    usage: "/diff",
    description: "Show or hide the thread's diff",
    template: "/diff",
  },
  {
    command: "git",
    usage: "/git",
    description: "Commit, push, open a PR or pull",
    template: "/git",
  },
  {
    command: "branch",
    usage: "/branch [name]",
    description: "Switch or create a branch",
    template: "/branch ",
  },
  {
    command: "worktree",
    usage: "/worktree",
    description: "Start this new thread in a new worktree, or locally",
    template: "/worktree",
  },
  {
    command: "recover",
    usage: "/recover",
    description: "Put messages whose thread and project are gone here",
    template: "/recover",
  },
];

export const SLASH_MENU_LIMIT = 8;

const COMMAND_NAMES = new Set(COMPOSER_SLASH_COMMANDS.map((entry) => entry.command));

/** The partial command name while the composer holds only "/" and letters, else null. */
export function slashMenuQuery(text: string): string | null {
  const match = /^\/([a-z-]*)$/i.exec(text);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function matchSlashCommands(query: string): ReadonlyArray<ComposerSlashCommand> {
  return COMPOSER_SLASH_COMMANDS.filter((entry) => entry.command.startsWith(query)).slice(
    0,
    SLASH_MENU_LIMIT,
  );
}

export function parseComposerSlashCommand(
  text: string,
): { readonly command: string; readonly args: string } | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = (match[1] ?? "").toLowerCase();
  if (!COMMAND_NAMES.has(command)) return null;
  return { command, args: (match[2] ?? "").trim() };
}

export type ComposerSlashAction =
  | { readonly type: "new-thread" }
  | { readonly type: "open-model-picker" }
  | { readonly type: "set-interaction-mode"; readonly mode: ProviderInteractionMode }
  | { readonly type: "set-runtime-mode"; readonly mode: RuntimeMode | "next" }
  | { readonly type: "send"; readonly dispatch: "steer" | "queue"; readonly text: string }
  | { readonly type: "resume" }
  | { readonly type: "discard" }
  | { readonly type: "recover" }
  | { readonly type: "toggle-diff" }
  | { readonly type: "clone"; readonly args: string }
  | { readonly type: "git-menu" }
  | { readonly type: "branch-picker"; readonly query: string }
  | { readonly type: "toggle-worktree" }
  | { readonly type: "error"; readonly message: string };

/** What a slash command does; null when the text isn't one of ours and should be sent. */
export function resolveComposerSlashAction(text: string): ComposerSlashAction | null {
  const parsed = parseComposerSlashCommand(text);
  if (parsed === null) return null;
  switch (parsed.command) {
    case "new":
      return { type: "new-thread" };
    case "model":
      return { type: "open-model-picker" };
    case "plan":
      return { type: "set-interaction-mode", mode: "plan" };
    case "default":
      return { type: "set-interaction-mode", mode: "default" };
    case "runtime": {
      if (parsed.args.length === 0) return { type: "set-runtime-mode", mode: "next" };
      const mode = parseRuntimeMode(parsed.args);
      return mode === null
        ? { type: "error", message: `Unknown runtime mode "${parsed.args}"` }
        : { type: "set-runtime-mode", mode };
    }
    case "resume":
      return { type: "resume" };
    case "discard":
      return { type: "discard" };
    case "recover":
      return { type: "recover" };
    case "diff":
      return { type: "toggle-diff" };
    case "clone":
      return parsed.args.length === 0
        ? { type: "error", message: "Type owner/repo or a URL after /clone" }
        : { type: "clone", args: parsed.args };
    case "git":
      return { type: "git-menu" };
    case "branch":
      return { type: "branch-picker", query: parsed.args };
    case "worktree":
      return { type: "toggle-worktree" };
    case "steer":
    case "queue":
      return parsed.args.length === 0
        ? { type: "error", message: `Type a message after /${parsed.command}` }
        : { type: "send", dispatch: parsed.command, text: parsed.args };
    default:
      return null;
  }
}
