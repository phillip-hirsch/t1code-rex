import {
  SourceControlProviderKind,
  type SourceControlDiscoveryResult,
  type SourceControlProviderAuth,
  type SourceControlProviderDiscoveryItem,
  type VcsDiscoveryItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

/** Auth as discovery reports it; `account`, `host` and `detail` are optional strings here. */
export function providerAuth(input: {
  readonly status: SourceControlProviderAuth["status"];
  readonly account?: string;
  readonly host?: string;
  readonly detail?: string;
  readonly accounts?: SourceControlProviderAuth["accounts"];
}): SourceControlProviderAuth {
  return {
    status: input.status,
    account: Option.fromNullishOr(input.account),
    host: Option.fromNullishOr(input.host),
    detail: Option.fromNullishOr(input.detail),
    ...(input.accounts === undefined ? {} : { accounts: input.accounts }),
  };
}

/** Git, installed, and jj, not yet supported, as a server reports them. */
export function vcsDiscovery(): ReadonlyArray<VcsDiscoveryItem> {
  return [
    {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.50.1"),
      installHint: "Install Git.",
      detail: Option.none(),
    },
    {
      kind: "jj",
      label: "Jujutsu",
      executable: "jj",
      implemented: false,
      status: "missing",
      version: Option.none(),
      installHint: "Install Jujutsu.",
      detail: Option.none(),
    },
  ];
}

const EXECUTABLES: Readonly<Record<string, string>> = { github: "gh", gitlab: "glab" };

export function providerDiscovery(
  kind: string,
  label: string,
  overrides: Partial<Omit<SourceControlProviderDiscoveryItem, "kind" | "label">> = {},
): SourceControlProviderDiscoveryItem {
  return {
    kind: SourceControlProviderKind.make(kind),
    label,
    // Bitbucket is reached by API alone; the others through their CLIs.
    executable: EXECUTABLES[kind],
    status: "available",
    version: Option.none(),
    installHint: `Install the ${label} CLI.`,
    detail: Option.none(),
    auth: providerAuth({ status: "authenticated", account: "octo", host: "example.com" }),
    ...overrides,
  };
}

/** GitHub signed out, GitLab not installed, Bitbucket signed in as `sandbox`. */
export function discoveryResult(
  providers: ReadonlyArray<SourceControlProviderDiscoveryItem> = [
    providerDiscovery("github", "GitHub", {
      version: Option.some("gh version 2.83.0"),
      auth: providerAuth({
        status: "unauthenticated",
        detail: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
      }),
    }),
    providerDiscovery("gitlab", "GitLab", {
      status: "missing",
      installHint: "Install the GitLab CLI (glab).",
      auth: providerAuth({ status: "unknown" }),
    }),
    providerDiscovery("bitbucket", "Bitbucket", {
      auth: providerAuth({ status: "authenticated", account: "sandbox", host: "bitbucket.org" }),
    }),
  ],
): SourceControlDiscoveryResult {
  return { versionControlSystems: vcsDiscovery(), sourceControlProviders: providers };
}
