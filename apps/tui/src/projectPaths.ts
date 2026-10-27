import {
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryName,
  normalizePastedCloneUrl,
} from "@t3tools/client-runtime/operations/projects";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import {
  SourceControlProviderKind,
  type FilesystemBrowseEntry,
  type SourceControlCloneProtocol,
} from "@t3tools/contracts";

/**
 * The add-project prompt and `/clone`. Paths are the server's: suggestions come from its
 * `filesystem.browse`, and `~` expands on the server, so an attached TUI adds projects on
 * the machine that runs them.
 */

export const PROJECT_PATH_SUGGESTION_LIMIT = 8;

/** Where the prompt starts: the server's add-project base directory, else the home folder. */
export function initialProjectPath(baseDirectory: string | null | undefined): string {
  return getAddProjectInitialQuery(baseDirectory);
}

/** The directory to list for a draft path, and the name prefix to filter it by. */
export function projectPathBrowseTarget(
  draft: string,
  platform: string,
): { readonly partialPath: string; readonly filter: string } | null {
  const browse = getFilesystemBrowsePath(draft, platform);
  if (!browse.isBrowsing || browse.directoryPath.length === 0) return null;
  return { partialPath: browse.directoryPath, filter: browse.filterQuery };
}

export function projectPathSuggestions(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  filter: string,
): ReadonlyArray<FilesystemBrowseEntry> {
  return filterFilesystemBrowseEntries(entries, filter).visibleEntries.slice(
    0,
    PROJECT_PATH_SUGGESTION_LIMIT,
  );
}

/** Picking a suggestion descends into it, ready to pick the next level or submit. */
export function applyProjectPathSuggestion(draft: string, name: string): string {
  return appendBrowsePathSegment(draft, name);
}

export interface CloneRequest {
  readonly destinationPath: string;
  readonly title: string;
  readonly remoteUrl?: string;
  readonly provider?: SourceControlProviderKind;
  readonly repository?: string;
  readonly protocol?: SourceControlCloneProtocol;
}

export const CLONE_USAGE = "/clone owner/repo|url [destination] [https|ssh] [provider=<host>]";

function isRemoteUrlLike(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^@\s]+@[^:\s]+:\S+$/.test(source);
}

/**
 * Where a clone goes when no destination is given: next to the open project, as before,
 * else in the add-project base directory or the home folder.
 */
export function defaultCloneParent(
  activeProjectRoot: string | null,
  baseDirectory: string | null | undefined,
): string {
  if (activeProjectRoot !== null) {
    const parent = getBrowseParentPath(activeProjectRoot);
    if (parent !== null) return parent;
  }
  return initialProjectPath(baseDirectory);
}

/**
 * `/clone owner/repo`, `/clone <url>`, plus an optional destination, protocol and
 * `provider=` (e.g. gitlab). Shorthand goes to the default host as a URL, as web's paste does,
 * unless a provider is named.
 */
export function parseCloneArgs(
  args: string,
  defaultParent: string,
):
  | { readonly ok: true; readonly request: CloneRequest }
  | { readonly ok: false; readonly error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const source = tokens[0];
  if (source === undefined) return { ok: false, error: `Usage: ${CLONE_USAGE}` };
  let destination: string | null = null;
  let protocol: SourceControlCloneProtocol | undefined;
  let provider: SourceControlProviderKind | undefined;
  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (lower === "ssh" || lower === "https" || lower === "auto") {
      protocol = lower;
    } else if (lower.startsWith("provider=")) {
      const kind = lower.slice("provider=".length);
      if (!/^[a-z][a-z0-9-]*$/.test(kind))
        return { ok: false, error: `Unknown provider "${kind}"` };
      provider = SourceControlProviderKind.make(kind);
    } else if (destination === null) {
      destination = token;
    } else {
      return { ok: false, error: `Unexpected "${token}". Usage: ${CLONE_USAGE}` };
    }
  }
  const directoryName = getCloneDirectoryName(source);
  if (directoryName.length === 0) {
    return { ok: false, error: `Can't tell the folder name from "${source}"` };
  }
  const destinationPath = destination ?? getCloneDestinationPath(defaultParent, directoryName);
  const title = getCloneDirectoryName(destinationPath) || directoryName;
  const base = { destinationPath, title, ...(protocol ? { protocol } : {}) };
  if (provider !== undefined && !isRemoteUrlLike(source)) {
    return { ok: true, request: { ...base, provider, repository: source } };
  }
  return { ok: true, request: { ...base, remoteUrl: normalizePastedCloneUrl(source) } };
}
