// @effect-diagnostics globalFetch:off -- the global fetch backs the HTTP client.
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { issueRemoteWebSocketTicket } from "@t3tools/client-runtime/authorization";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import type { ServerEndpoint } from "./daemon/serverLauncher.ts";

/**
 * One `server.getConfig` call over a short-lived socket. The bearer buys a
 * one-use WebSocket ticket; neither leaves this process.
 */
export const fetchServerConfig = Effect.fn("tr3x.fetchServerConfig")(
  function* (input: ServerEndpoint & { readonly bearerToken: string }) {
    const issued = yield* issueRemoteWebSocketTicket({
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: input.bearerToken,
      use: "rpc",
    });
    const url = new URL("/ws", input.wsBaseUrl);
    url.searchParams.set("wsTicket", issued.ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(url.toString(), { openTimeout: "5 seconds" }).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );
    // Built into this scope: `Effect.provide(layer)` would close the socket once `make` returns.
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
    return yield* client[WS_METHODS.serverGetConfig]({});
  },
  Effect.timeout("10 seconds"),
  Effect.scoped,
  Effect.provide(layerRemoteHttpClient(fetch)),
);
