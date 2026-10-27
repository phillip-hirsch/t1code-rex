import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  SourceControlProviderKind,
  type SourceControlCloneProtocol,
  type SourceControlDiscoveryResult,
  type SourceControlProviderDiscoveryItem,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryVisibility,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

/**
 * `/publish owner/repo [public|private] [ssh|https|auto] [remote=<name>] [provider=<kind>]`,
 * as the old TUI took it. Private and SSH are the defaults, as on web.
 */
export interface PublishArgs {
  /** As typed; null when only options were given, so the composer asks for one. */
  readonly repository: string | null;
  /** A provider kind named on the command line; null picks the first ready one. */
  readonly provider: string | null;
  readonly visibility: SourceControlRepositoryVisibility;
  readonly protocol: SourceControlCloneProtocol;
  readonly remoteName: string;
}

export type Parsed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/** Short names the old TUI took for providers, beside each provider's own kind. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gh: "github",
  glab: "gitlab",
  bb: "bitbucket",
  az: "azure-devops",
  azure: "azure-devops",
  fj: "forgejo",
  gitea: "forgejo",
  cafe: "gitcafe",
};

const KNOWN_KINDS: ReadonlySet<string> = new Set(
  sourceControlClients.definitions.map((definition) => definition.kind),
);

/** A provider kind from what was typed: a kind, or one of the old TUI's aliases. */
export function normalizePublishProvider(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (KNOWN_KINDS.has(lower)) return lower;
  return PROVIDER_ALIASES[lower] ?? null;
}

const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

export const PUBLISH_USAGE =
  "/publish owner/repo [public] [https] [remote=<name>] [provider=<kind>]";

export function parsePublishArgs(args: string): Parsed<PublishArgs> {
  let repository: string | null = null;
  let provider: string | null = null;
  let visibility: SourceControlRepositoryVisibility = "private";
  let protocol: SourceControlCloneProtocol = "ssh";
  let remoteName = "origin";
  let bare: string | null = null;
  for (const token of args.trim().split(/\s+/u).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === "private" || lower === "public") {
      visibility = lower;
    } else if (lower === "ssh" || lower === "https" || lower === "auto") {
      protocol = lower;
    } else if (lower.startsWith("remote=")) {
      remoteName = token.slice("remote=".length);
      if (!REMOTE_NAME.test(remoteName) || remoteName.endsWith(".lock")) {
        return { ok: false, error: `"${remoteName}" isn't a valid remote name` };
      }
    } else if (lower.startsWith("provider=")) {
      const named = token.slice("provider=".length);
      provider = normalizePublishProvider(named);
      if (provider === null) return { ok: false, error: unknownProvider(named) };
    } else if (token.includes("/")) {
      if (repository !== null) {
        return { ok: false, error: `One repository at a time: ${repository} or ${token}?` };
      }
      repository = token;
    } else {
      const named = normalizePublishProvider(token);
      if (named !== null) provider = named;
      else if (bare === null) bare = token;
      else return { ok: false, error: unknownOption(token) };
    }
  }
  // A lone word is a repository missing its owner, unless an owner/name was typed too.
  if (bare !== null && repository !== null) return { ok: false, error: unknownOption(bare) };
  repository ??= bare;
  return { ok: true, value: { repository, provider, visibility, protocol, remoteName } };
}

function unknownOption(token: string): string {
  return `Unknown option "${token}". ${PUBLISH_USAGE}`;
}

function unknownProvider(named: string): string {
  const kinds = sourceControlClients.definitions.map((definition) => definition.kind).join(", ");
  return `Unknown provider "${named}". Try ${kinds}`;
}

/** Why a repository path can't be published as typed, or null when it can. */
export function repositoryPathError(repository: string, providerKind: string): string | null {
  const segments = repository.split("/");
  const hint = sourceControlClients.get(providerKind).repositoryPathHint;
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    return `Name the repository as ${hint}`;
  }
  // GitLab groups nest; every other host has one owner.
  if (segments.length > 2 && providerKind !== "gitlab") {
    return `Name the repository as ${hint}`;
  }
  const bad = segments.find(
    (segment) => !PATH_SEGMENT.test(segment) || segment === "." || segment === "..",
  );
  if (bad !== undefined) {
    return `"${bad}" can't be part of a repository name: use letters, digits, ".", "-" or "_"`;
  }
  return null;
}

export interface PublishReadiness {
  readonly ready: boolean;
  /** Why it isn't ready, in the server's words where it has some. */
  readonly hint: string | null;
}

const OPEN_SOURCE_CONTROL = "Open Source Control (⌘K) to see what it needs.";

/** Whether a provider can take a publish now, as web decides it for its provider cards. */
export function publishReadiness(
  provider: SourceControlProviderDiscoveryItem | undefined,
  kind: string,
): PublishReadiness {
  const label = sourceControlClients.get(kind).label;
  if (provider === undefined) {
    return {
      ready: false,
      hint: `This server didn't report ${label}. Open Source Control (⌘K) and refresh.`,
    };
  }
  if (provider.status !== "available") {
    return {
      ready: false,
      hint: `${provider.label} isn't installed: ${provider.installHint}`,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const detail = Option.getOrNull(provider.auth.detail);
    return {
      ready: false,
      hint: `${provider.label} isn't signed in: ${detail ?? OPEN_SOURCE_CONTROL}`,
    };
  }
  return { ready: true, hint: null };
}

/** The provider to publish to when none was named: the first ready one, by label, as web picks. */
export function defaultPublishProvider(
  discovery: SourceControlDiscoveryResult,
): SourceControlProviderDiscoveryItem | null {
  const ready = discovery.sourceControlProviders
    .filter((item) => publishReadiness(item, item.kind).ready)
    .toSorted((left, right) =>
      sourceControlClients
        .get(left.kind)
        .pickerLabel.localeCompare(sourceControlClients.get(right.kind).pickerLabel),
    );
  return ready[0] ?? null;
}

/** A publish checked and ready to confirm. */
export interface PublishPlan {
  readonly input: SourceControlPublishRepositoryInput;
  readonly providerLabel: string;
  /** Where it will live, as `github.com/owner/repo`. */
  readonly location: string;
  /** The branch the publish pushes; null on a detached HEAD. */
  readonly branch: string | null;
}

export type PublishResolution =
  | { readonly kind: "plan"; readonly plan: PublishPlan }
  | { readonly kind: "error"; readonly message: string }
  /** No repository typed: the composer gets the command back with the account filled in. */
  | { readonly kind: "prefill"; readonly text: string; readonly hint: string };

/**
 * Checks a `/publish` against the checkout and the server's providers before anything is
 * sent: a repository without a remote, a provider that's installed and signed in, and a
 * repository path that host takes.
 */
export function resolvePublish(input: {
  readonly args: PublishArgs;
  readonly cwd: string;
  readonly status: VcsStatusResult;
  readonly discovery: SourceControlDiscoveryResult;
}): PublishResolution {
  const { args, status, discovery } = input;
  if (!status.isRepo) {
    return {
      kind: "error",
      message: "This folder isn't a git repository yet. Pick “git init” in the branch picker (b).",
    };
  }
  if (status.hasPrimaryRemote) {
    return {
      kind: "error",
      message: "This repository already has a remote. Push from the git menu (c) instead.",
    };
  }
  let provider: SourceControlProviderDiscoveryItem;
  if (args.provider !== null) {
    const named = args.provider;
    const found = discovery.sourceControlProviders.find((item) => item.kind === named);
    const readiness = publishReadiness(found, named);
    if (found === undefined || !readiness.ready) {
      return { kind: "error", message: readiness.hint ?? OPEN_SOURCE_CONTROL };
    }
    provider = found;
  } else {
    const first = defaultPublishProvider(discovery);
    if (first === null) {
      return {
        kind: "error",
        message:
          "No source control provider is signed in on the server. Open Source Control (⌘K) to set one up.",
      };
    }
    provider = first;
  }
  const definition = sourceControlClients.get(provider.kind);
  const account = Option.getOrNull(provider.auth.account);
  if (args.repository === null) {
    const providerOption = args.provider === null ? "" : ` provider=${provider.kind}`;
    return {
      kind: "prefill",
      text: `/publish ${account === null ? "" : `${account}/`}${providerOption}`,
      hint: `Type the ${definition.label} repository as ${definition.repositoryPathHint}, then ⏎. Add "public" to make it public`,
    };
  }
  const pathError = repositoryPathError(args.repository, provider.kind);
  if (pathError !== null) return { kind: "error", message: pathError };
  const host = definition.publishHost(Option.getOrNull(provider.auth.host));
  return {
    kind: "plan",
    plan: {
      input: {
        cwd: input.cwd,
        provider: SourceControlProviderKind.make(provider.kind),
        repository: args.repository,
        visibility: args.visibility,
        remoteName: args.remoteName,
        protocol: args.protocol,
      },
      providerLabel: definition.label,
      location: `${host}/${args.repository}`,
      branch: status.refName,
    },
  };
}

/** What the confirmation says will happen. */
export function describePublishConfirmation(plan: PublishPlan): ReadonlyArray<string> {
  const { input } = plan;
  const protocol = input.protocol === "https" ? "HTTPS" : input.protocol === "ssh" ? "SSH" : "auto";
  const remote = input.remoteName ?? "origin";
  return [
    input.visibility === "public"
      ? `Creates a PUBLIC ${plan.providerLabel} repository anyone can see:`
      : `Creates a private ${plan.providerLabel} repository:`,
    `  ${plan.location}`,
    plan.branch === null
      ? `Adds it as remote "${remote}" (${protocol}).`
      : `Adds it as remote "${remote}" (${protocol}) and pushes ${plan.branch}.`,
  ];
}

/** One line for a finished publish: what was created, the branch and the remote. */
export function describePublishResult(
  result: SourceControlPublishRepositoryResult,
  providerLabel: string,
): string {
  const name = result.repository.nameWithOwner;
  return result.status === "pushed"
    ? `Published ${name} on ${providerLabel} · ${result.branch} → ${result.remoteName}`
    : `Created ${name} on ${providerLabel} · remote ${result.remoteName} added; commit, then push`;
}

/** Why a publish failed: the server's detail, without its "operation failed for" preamble. */
export function describePublishFailure(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail.trim() !== "") {
      return error.detail.trim();
    }
    if ("message" in error && typeof error.message === "string" && error.message.trim() !== "") {
      return error.message.trim();
    }
  }
  return "Publish failed.";
}

/** The repository is already there: the server would fail to create it. */
export function repositoryTakenMessage(plan: PublishPlan): string {
  return `${plan.location} already exists. Pick another name.`;
}
