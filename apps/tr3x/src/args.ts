export const USAGE = `Usage: tr3x <command>

Commands:
  daemon                    Start T3's server in TR3X_HOME (default ~/.tr3x), or attach to the daemon that runs it
  doctor                    Check the daemon, server, providers, and Rex
  view <threadId>           Open a thread in this terminal
  view --new [--cwd <dir>]  Start a thread in <dir> (default: the current directory); the first message launches it
`;

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "daemon" | "doctor" }
  | { readonly kind: "view"; readonly threadId: string }
  | { readonly kind: "new"; readonly cwd: string };

/** The command `argv` names, or null when it names none. */
export function parseArgs(argv: ReadonlyArray<string>, cwd: string): Command | null {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if ((command === "daemon" || command === "doctor") && rest.length === 0) return { kind: command };
  if (command !== "view") return null;
  if (rest[0] === "--new") {
    if (rest.length === 1) return { kind: "new", cwd };
    return rest.length === 3 && rest[1] === "--cwd" && rest[2]
      ? { kind: "new", cwd: rest[2] }
      : null;
  }
  const [threadId] = rest;
  return rest.length === 1 && threadId && !threadId.startsWith("-")
    ? { kind: "view", threadId }
    : null;
}
