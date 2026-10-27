import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Wire-shaped provider snapshots for composer and picker tests. */

const decodeDriver = Schema.decodeUnknownSync(ProviderDriverKind);

export function testProvider(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly displayName?: string;
  readonly models: ReadonlyArray<string | { readonly slug: string; readonly shortName: string }>;
  readonly enabled?: boolean;
  readonly availability?: "available" | "unavailable";
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: decodeDriver(input.driver ?? input.instanceId),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    availability: input.availability ?? "available",
    models: input.models.map((entry) =>
      typeof entry === "string"
        ? { slug: entry, name: entry, isCustom: false, capabilities: null }
        : {
            slug: entry.slug,
            name: entry.slug,
            shortName: entry.shortName,
            isCustom: false,
            capabilities: null,
          },
    ),
    slashCommands: [],
    skills: [],
    ...(input.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: [...input.supportedRuntimeModes] }),
  };
}
