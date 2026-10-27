import { describe, expect, it } from "vite-plus/test";

import {
  buildTuiAttachCommand,
  formatEndpointCompatibility,
  formatEndpointStatus,
  formatTuiAttachCommandPreview,
  parseTuiServerConnection,
} from "./connectionsPanel.ts";

describe("connectionsPanel", () => {
  it("parses server base URLs and keeps the bearer out of the URL", () => {
    expect(parseTuiServerConnection("http://127.0.0.1:3773", "abc")).toEqual({
      host: "127.0.0.1",
      port: "3773",
      bearerToken: "abc",
    });
    expect(parseTuiServerConnection("wss://host.example")).toEqual({
      host: "host.example",
      port: "443",
      bearerToken: null,
    });
    expect(parseTuiServerConnection("file:///tmp")).toBeNull();
  });

  it("builds an attach-only TUI command without rendering the token separately", () => {
    expect(
      buildTuiAttachCommand({
        host: "127.0.0.1",
        port: "3773",
        bearerToken: "secret token",
      }),
    ).toBe(
      "env T1CODE_TUI_ATTACH_ONLY='1' T1CODE_HOST='127.0.0.1' T1CODE_PORT='3773' T1CODE_AUTH_TOKEN='secret token' t1code",
    );
    expect(
      formatTuiAttachCommandPreview({
        host: "127.0.0.1",
        port: "3773",
        bearerToken: "secret token",
      }),
    ).toBe(
      "env T1CODE_TUI_ATTACH_ONLY='1' T1CODE_HOST='127.0.0.1' T1CODE_PORT='3773' T1CODE_AUTH_TOKEN='••••••••' t1code",
    );
  });

  it("formats advertised endpoint metadata", () => {
    const endpoint = {
      id: "local",
      label: "Local backend",
      provider: { id: "core", label: "Core", kind: "core", isAddon: false },
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      reachability: "loopback",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "server",
      status: "available",
    } as const;

    expect(formatEndpointStatus(endpoint)).toBe("Available · Loopback");
    expect(formatEndpointCompatibility(endpoint)).toBe("Hosted HTTPS blocked · Desktop compatible");
  });
});
