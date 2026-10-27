import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderDiscoveryItem,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export type SourceControlTone = "success" | "warning" | "muted";

/** One tool or host in the Source Control view. */
export interface SourceControlRow {
  readonly key: string;
  readonly label: string;
  readonly version: string | null;
  /** The status dot: ready, needs attention, or not offered yet. */
  readonly tone: SourceControlTone;
  /** "Coming soon", "Not authenticated" and the like; null when there's nothing to flag. */
  readonly badge: string | null;
  readonly summary: string;
  /** How to set it up, and the accounts the server found. */
  readonly details: ReadonlyArray<string>;
}

export interface SourceControlSection {
  readonly title: string;
  /** "1/2 available" and the like. */
  readonly count: string;
  readonly rows: ReadonlyArray<SourceControlRow>;
}

// A discovery item's own `detail` is the probe's error ("process failed to spawn…"); web leaves
// it out and so does this view: the summary and install hint say what to do.
function vcsRow(item: VcsDiscoveryItem): SourceControlRow {
  return {
    key: `vcs:${item.kind}`,
    label: item.label,
    version: Option.getOrNull(item.version),
    tone: !item.implemented ? "muted" : item.status === "available" ? "success" : "warning",
    badge: item.implemented ? null : "Coming soon",
    summary: !item.implemented
      ? `Support for ${item.label} is coming soon.`
      : item.status !== "available"
        ? `Not available on this server: ${item.installHint}`
        : "Available",
    details: [],
  };
}

/** The status line under a host's name, in web's words. */
function providerSummary(item: SourceControlProviderDiscoveryItem): string {
  if (item.status !== "available") return `Not available on this server: ${item.installHint}`;
  const { auth } = item;
  const detail = Option.getOrNull(auth.detail);
  if (auth.status === "authenticated") {
    const account = Option.getOrNull(auth.account);
    const host = Option.getOrNull(auth.host);
    return [
      "Authenticated",
      account === null ? null : `as ${account}${host === null ? "" : ` on ${host}`}`,
      detail === null ? null : `· ${detail}`,
    ]
      .filter((part) => part !== null)
      .join(" ");
  }
  if (auth.status === "unauthenticated") {
    if (item.executable === undefined) return `Available. ${item.installHint}`;
    if (auth.accounts?.some((entry) => entry.authenticated) === true) {
      return detail ?? `Every ${item.label} host is turned off.`;
    }
    return `${item.label} is not authenticated on this server. Sign in or configure credentials with the ${item.executable} tool on the server host to enable change request features.`;
  }
  return `Could not verify ${item.label}. ${detail ?? item.installHint}`;
}

/**
 * How to sign a host in, as web's settings page says it: the CLI's login command, or a token
 * in the server's environment. tr3x shows these; it runs no login itself.
 */
function providerDetails(item: SourceControlProviderDiscoveryItem): ReadonlyArray<string> {
  const lines: string[] = [];
  const { auth } = item;
  for (const entry of auth.accounts ?? []) {
    const state = entry.error ?? (entry.authenticated ? "signed in" : "not signed in");
    const via = entry.environmentVariable === undefined ? "" : ` via ${entry.environmentVariable}`;
    lines.push(`${entry.active ? "●" : "○"} ${entry.account} on ${entry.host}${via} · ${state}`);
  }
  const credentials = sourceControlClients.find(item.kind)?.credentials;
  if (auth.status !== "authenticated" && item.status === "available") {
    const detail = Option.getOrNull(auth.detail);
    // The server's own hint, unless it only repeats the login command below.
    if (
      detail !== null &&
      auth.status === "unauthenticated" &&
      (credentials === undefined || !detail.includes(credentials.loginCommand))
    ) {
      lines.push(detail);
    }
    if (credentials !== undefined) {
      lines.push(
        `Sign in with \`${credentials.loginCommand}\` on the server host, then refresh (r).`,
      );
    }
  }
  if (credentials !== undefined && auth.status !== "authenticated") {
    const host = Option.getOrNull(auth.host) ?? sourceControlClients.get(item.kind).publicHost;
    lines.push(
      `Or set ${credentials.tokenEnvVar} on the server; give the token ${credentials.tokenAccess}.`,
    );
    if (host !== null) lines.push(`New token: ${credentials.newTokenUrl(host)}`);
  }
  return lines;
}

function providerRow(item: SourceControlProviderDiscoveryItem): SourceControlRow {
  const ready = item.status === "available" && item.auth.status === "authenticated";
  return {
    key: `provider:${item.kind}`,
    label: item.label,
    version: Option.getOrNull(item.version),
    tone: ready ? "success" : "warning",
    badge:
      item.status !== "available"
        ? "Not installed"
        : item.auth.status === "unauthenticated"
          ? "Not authenticated"
          : item.auth.status === "unknown"
            ? "Status unknown"
            : null,
    summary: providerSummary(item),
    details: providerDetails(item),
  };
}

/** The Source Control view: the server's version-control tools, then its hosting providers. */
export function describeSourceControl(
  result: SourceControlDiscoveryResult,
): ReadonlyArray<SourceControlSection> {
  const vcs = result.versionControlSystems;
  const providers = result.sourceControlProviders;
  return [
    {
      title: "Version control",
      count: `${vcs.filter((item) => item.implemented && item.status === "available").length}/${vcs.length} available`,
      rows: vcs.map(vcsRow),
    },
    {
      title: "Source control providers",
      count: `${providers.filter((item) => item.status === "available" && item.auth.status === "authenticated").length}/${providers.length} signed in`,
      rows: providers.map(providerRow),
    },
  ];
}
