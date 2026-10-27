// @effect-diagnostics effectFnOpportunity:off globalFetch:off -- Thin stubs over client-runtime services; the TUI runs on Bun outside the Effect runtime.
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { RelayWebClientId } from "@t3tools/contracts/relay";
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

export const layer = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  layerHttpClient,
  layerRelayDpopSigner,
  layerRelay,
);
