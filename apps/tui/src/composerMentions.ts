import { detectComposerTrigger, serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/**
 * `@` file mentions, as upstream web does them: typing `@` and a query searches the
 * project's files and folders, and picking one replaces the `@query` with a markdown file
 * link, `[name.ts](src/name.ts)`, which the server reads as a mention.
 */

export const MENTION_SEARCH_LIMIT = 8;
export const MENTION_SEARCH_DEBOUNCE_MS = 120;

export interface MentionQuery {
  /** What follows the `@`. */
  readonly query: string;
  /** UTF-16 units from the `@` to the cursor, which picking an entry replaces. */
  readonly length: number;
}

/** The `@query` the cursor ends, if any. `cursor` counts UTF-16 units; see `textareaOffsets.ts`. */
export function mentionQueryAt(text: string, cursor: number): MentionQuery | null {
  const trigger = detectComposerTrigger(text, cursor);
  if (trigger?.kind !== "path") return null;
  return { query: trigger.query, length: trigger.rangeEnd - trigger.rangeStart };
}

/** What replaces `@query`: the file link and a space to keep typing after it. */
export function mentionReplacement(path: string): string {
  return `${serializeComposerFileLink(path)} `;
}
