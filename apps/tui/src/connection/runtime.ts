// @effect-diagnostics effectFnOpportunity:off globalFetch:off nodeBuiltinImport:off -- Thin stubs over client-runtime services; the TUI runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

const relayUnavailable = () => new Error("T3 Connect is not available in the TUI.");

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

// Upstream's commands mint ids and receipts with effect/Crypto, as mobile's expo-crypto layer does.
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

export const layer = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  layerCrypto,
  layerHttpClient,
  layerRelayDpopSigner,
  layerRelay,
);
