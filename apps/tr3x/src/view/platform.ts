// @effect-diagnostics effectFnOpportunity:off globalFetch:off nodeBuiltinImport:off -- Thin stubs over client-runtime services for a Bun CLI.
import * as NodeCrypto from "node:crypto";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  CredentialStore,
  makePullRequestRoutingPermissions,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  ProfileStore,
  PullRequestRoutingPermissions,
  Wakeups,
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
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import type { EnvironmentId } from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { describeError } from "../redact.ts";

/**
 * The view talks to exactly one server, the daemon's, chosen before the
 * runtime starts. Stores that web and mobile persist stay in memory.
 */
export interface ViewServer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  /** A bearer for this server; client-runtime asks again when it reconnects. */
  readonly bearerToken: () => Promise<string>;
}

const unsupported = (detail: string) =>
  new ConnectionBlockedError({ reason: "unsupported", detail });

function layerCapabilities(server: ViewServer) {
  return Layer.succeedContext(
    Context.make(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.tryPromise({
          try: server.bearerToken,
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not get a server session: ${describeError(cause)}`,
            }),
        }).pipe(Effect.asSome),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({
          metadata: { label: "tr3x view", deviceType: "desktop", surface: "cli" },
        }),
      ),
      Context.add(
        ClientCapabilities.CloudSession,
        ClientCapabilities.CloudSession.of({
          identity: Effect.succeedNone,
          clerkToken: Effect.fail(unsupported("T3 Connect is not available in tr3x.")),
        }),
      ),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({ deviceId: Effect.succeedNone }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: () => Effect.fail(unsupported("SSH environments are not available in tr3x.")),
          prepare: () => Effect.fail(unsupported("SSH environments are not available in tr3x.")),
          disconnect: () => Effect.void,
        }),
      ),
    ),
  );
}

function layerConnectionSource(server: ViewServer) {
  return Layer.succeed(
    PlatformConnectionSource.PlatformConnectionSource,
    PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.make([
        new PrimaryConnectionRegistration({
          target: new PrimaryConnectionTarget({
            environmentId: server.environmentId,
            label: server.label,
            httpBaseUrl: server.httpBaseUrl,
            wsBaseUrl: server.wsBaseUrl,
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
      write: (permissions) => Effect.sync(() => void (routingPermissions = permissions)),
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

const layerHttpClient = layerRemoteHttpClient((input, init) => fetch(input, init));

const relayUnavailable = () => new Error("T3 Connect is not available in tr3x.");

const layerRelayDpopSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "indexed-db",
        cause: relayUnavailable(),
      }),
    ),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({
          method: input.method,
          url: input.url,
          cause: relayUnavailable(),
        }),
      ),
  }),
);

// A non-https relay URL yields the disabled relay client, so cloud lookups never run.
const layerRelay = ManagedRelay.layer({
  relayUrl: "http://relay.invalid",
  clientId: RelayWebClientId,
}).pipe(Layer.provide(Layer.mergeAll(layerHttpClient, layerRelayDpopSigner)));

const DIGEST_ALGORITHMS: Record<Crypto.DigestAlgorithm, string> = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

// Commands mint ids and receipts with effect/Crypto, as mobile's expo-crypto layer does.
const layerCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(
        () =>
          new Uint8Array(NodeCrypto.createHash(DIGEST_ALGORITHMS[algorithm]).update(data).digest()),
      ),
  }),
);

const layerConnectivity = Connectivity.layer({
  status: Effect.succeed("online"),
  changes: Stream.never,
});
const layerWakeups = Wakeups.layer({ changes: Stream.never });

export function layer(server: ViewServer) {
  return Layer.mergeAll(
    layerCapabilities(server),
    layerConnectivity,
    layerWakeups,
    layerConnectionSource(server),
    layerPersistence,
    Socket.layerWebSocketConstructorGlobal,
    layerCrypto,
    layerHttpClient,
    layerRelayDpopSigner,
    layerRelay,
  );
}
