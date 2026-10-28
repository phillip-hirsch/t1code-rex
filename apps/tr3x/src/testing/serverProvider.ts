import { ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

/** A ready, signed-in provider snapshot, as `server.getConfig` reports one. */
export function provider(name: string, overrides: Record<string, unknown> = {}): ServerProvider {
  return decodeProvider({
    instanceId: name,
    driver: name,
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models: [],
    ...overrides,
  });
}
