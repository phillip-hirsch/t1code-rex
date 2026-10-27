import type { AdvertisedEndpoint } from "@t3tools/contracts";

export interface TuiServerConnectionInfo {
  readonly host: string;
  readonly port: string;
  readonly bearerToken: string | null;
}

/** Reads host and port from a server's http(s) or ws(s) base URL. */
export function parseTuiServerConnection(
  rawUrl: string,
  bearerToken: string | null = null,
): TuiServerConnectionInfo | null {
  try {
    const parsed = new URL(rawUrl);
    const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
    if (!secure && parsed.protocol !== "http:" && parsed.protocol !== "ws:") {
      return null;
    }
    return {
      host: parsed.hostname,
      port: parsed.port || (secure ? "443" : "80"),
      bearerToken: bearerToken?.trim() || null,
    };
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildTuiAttachCommand(input: TuiServerConnectionInfo): string {
  const env: ReadonlyArray<readonly [string, string]> = [
    ["TR3X_TUI_ATTACH_ONLY", "1"],
    ["TR3X_HOST", input.host],
    ["TR3X_PORT", input.port],
    ...(input.bearerToken ? ([["TR3X_AUTH_TOKEN", input.bearerToken]] as const) : []),
  ];
  return `env ${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} tr3x`;
}

export function formatTuiAttachCommandPreview(input: TuiServerConnectionInfo): string {
  return buildTuiAttachCommand({
    ...input,
    bearerToken: input.bearerToken ? "••••••••" : null,
  });
}

export function formatEndpointStatus(endpoint: AdvertisedEndpoint): string {
  const status =
    endpoint.status === "available"
      ? "Available"
      : endpoint.status === "unavailable"
        ? "Unavailable"
        : "Unknown";
  const reachability =
    endpoint.reachability === "loopback"
      ? "Loopback"
      : endpoint.reachability === "lan"
        ? "LAN"
        : endpoint.reachability === "private-network"
          ? "Private network"
          : "Public";
  return `${status} · ${reachability}`;
}

export function formatEndpointCompatibility(endpoint: AdvertisedEndpoint): string {
  const hosted =
    endpoint.compatibility.hostedHttpsApp === "compatible"
      ? "Hosted HTTPS compatible"
      : endpoint.compatibility.hostedHttpsApp === "mixed-content-blocked"
        ? "Hosted HTTPS blocked"
        : endpoint.compatibility.hostedHttpsApp === "requires-configuration"
          ? "Hosted HTTPS needs setup"
          : "Hosted HTTPS unknown";
  return `${hosted} · Desktop ${endpoint.compatibility.desktopApp}`;
}
