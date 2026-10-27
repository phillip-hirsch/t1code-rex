// @effect-diagnostics effectFnOpportunity:off -- Thin stubs over client-runtime services; the TUI runs on Bun outside the Effect runtime.
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  CredentialStore,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  ProfileStore,
  PullRequestRoutingPermissions,
  Wakeups,
  makePullRequestRoutingPermissions,
  type ConnectionCredential,
  type ConnectionProfile,
  type StoredPullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ClientCapabilities,
  Persistence,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { TuiServerSession } from "../serverLauncher.ts";

/**
 * The TUI talks to exactly one server, chosen before the runtime starts. The
 * catalog therefore holds a single platform-managed primary environment, and
 * every store that web and mobile persist stays in memory for the process.
 */

export interface TuiPlatformOptions {
  readonly session: TuiServerSession;
  readonly appVersion: string;
  readonly platformOs: string;
}

const unsupportedSsh = () =>
  new ConnectionBlockedError({
    reason: "unsupported",
    detail: "SSH environments are not available in the TUI yet.",
  });

function clientMetadata(options: TuiPlatformOptions): AuthClientPresentationMetadata {
  return {
    label: "T1Code",
    deviceType: "desktop",
    os: options.platformOs,
    surface: "cli",
    appVersion: options.appVersion,
  };
}

function layerCapabilities(options: TuiPlatformOptions) {
  return Layer.succeedContext(
    Context.make(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.tryPromise({
          try: () => options.session.getBearerToken(),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not obtain a server credential: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }).pipe(Effect.asSome),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({ metadata: clientMetadata(options) }),
      ),
      Context.add(
        ClientCapabilities.CloudSession,
        ClientCapabilities.CloudSession.of({
          identity: Effect.succeedNone,
          clerkToken: Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              detail: "T3 Connect is not available in the TUI yet.",
            }),
          ),
        }),
      ),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({ deviceId: Effect.succeedNone }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: () => Effect.fail(unsupportedSsh()),
          prepare: () => Effect.fail(unsupportedSsh()),
          disconnect: () => Effect.void,
        }),
      ),
    ),
  );
}

const layerConnectivity = Connectivity.layer({
  status: Effect.succeed("online"),
  changes: Stream.never,
});

const layerWakeups = Wakeups.layer({ changes: Stream.never });

function layerPlatformConnectionSource(session: TuiServerSession) {
  return Layer.succeed(
    PlatformConnectionSource.PlatformConnectionSource,
    PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.make([
        new PrimaryConnectionRegistration({
          target: new PrimaryConnectionTarget({
            environmentId: session.environment.environmentId,
            label: session.environment.label,
            httpBaseUrl: session.httpBaseUrl,
            wsBaseUrl: session.wsBaseUrl,
          }),
        }),
      ]),
    }),
  );
}

function memoryStore<A>() {
  const values = new Map<string, A>();
  return {
    get: (key: string) => Effect.sync(() => Option.fromUndefinedOr(values.get(key))),
    put: (key: string, value: A) => Effect.sync(() => void values.set(key, value)),
    remove: (key: string) => Effect.sync(() => void values.delete(key)),
  };
}

const layerPersistence = Layer.effectContext(
  Effect.gen(function* () {
    const profiles = memoryStore<ConnectionProfile>();
    const credentials = memoryStore<ConnectionCredential>();
    const tokens = memoryStore<TokenStore.RemoteDpopAccessToken>();
    let routingPermissions: ReadonlyArray<StoredPullRequestRoutingPermission> = [];
    const pullRequestRouting = yield* makePullRequestRoutingPermissions({
      read: Effect.sync(() => routingPermissions),
      write: (permissions) =>
        Effect.sync(() => {
          routingPermissions = permissions;
        }),
    });
    return Context.make(
      Persistence.ConnectionTargetStore,
      Persistence.ConnectionTargetStore.of({
        list: Effect.succeed([]),
        listDisabled: Effect.succeed([]),
      }),
    ).pipe(
      Context.add(
        Persistence.ConnectionRegistrationStore,
        Persistence.ConnectionRegistrationStore.of({
          register: () => Effect.void,
          setRoutes: () => Effect.void,
          remove: () => Effect.void,
          setEnabled: () => Effect.void,
        }),
      ),
      Context.add(
        ProfileStore.ConnectionProfileStore,
        ProfileStore.make({
          get: profiles.get,
          put: (profile) => profiles.put(profile.connectionId, profile),
          remove: profiles.remove,
        }),
      ),
      Context.add(CredentialStore.ConnectionCredentialStore, CredentialStore.make(credentials)),
      Context.add(
        TokenStore.RemoteDpopAccessTokenStore,
        TokenStore.make({
          get: tokens.get,
          put: (token) => tokens.put(token.environmentId, token),
          remove: tokens.remove,
        }),
      ),
      Context.add(PullRequestRoutingPermissions, pullRequestRouting),
      Context.add(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
    );
  }),
);

export function layer(options: TuiPlatformOptions) {
  return Layer.mergeAll(
    layerCapabilities(options),
    layerConnectivity,
    layerWakeups,
    layerPlatformConnectionSource(options.session),
    layerPersistence,
  );
}
