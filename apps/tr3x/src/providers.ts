import type { ServerProvider } from "@t3tools/contracts";

/** Upstream web's rule for a provider it will route a run to (`useDraftEnvironmentRouting`). */
export function isUsableProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}
