/** What a key in the thread pane does once the transcript (or the diff) passed on it. */
export type ThreadPaneShortcut = "diff" | "git-menu" | "branch-picker" | "compose" | "parent";

export interface ThreadPaneKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/**
 * The thread pane's single-key shortcuts. They come after the pane's own keys, so none may
 * be one it uses: the transcript scrolls on j/k/g/G/space (vim's g and G stay top and
 * bottom), and the diff takes [ ] n p N , . a v w m r d.
 */
export const THREAD_PANE_SHORTCUT_HINTS = "d diff  c git  b branch  i compose";

export function resolveThreadPaneShortcut(
  key: ThreadPaneKey,
  context: {
    readonly composer: "thread" | "draft" | null;
    /** The thread is a subagent: p opens its parent. */
    readonly parent?: boolean;
  },
): ThreadPaneShortcut | null {
  if (context.composer === null || key.ctrl === true || key.meta === true) return null;
  switch (key.name) {
    case "d":
      return context.composer === "thread" ? "diff" : null;
    case "c":
      return "git-menu";
    case "b":
      return "branch-picker";
    case "p":
      return context.parent === true ? "parent" : null;
    case "i":
    case "return":
    case "enter":
    case "kpenter":
    case "linefeed":
      return "compose";
    default:
      return null;
  }
}

/**
 * Routes a thread-pane key as the shell does: the pane first, then the shortcuts. "pane"
 * means the pane used it.
 */
export function routeThreadPaneKey<K extends ThreadPaneKey>(
  key: K,
  context: {
    readonly composer: "thread" | "draft" | null;
    readonly parent?: boolean;
    readonly pane: ((key: K) => boolean) | null;
  },
): ThreadPaneShortcut | "pane" | null {
  if (context.pane?.(key) === true) return "pane";
  return resolveThreadPaneShortcut(key, context);
}
