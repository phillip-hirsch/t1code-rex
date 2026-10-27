import { describe, expect, it } from "vite-plus/test";

import { redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  it("masks the ticket in a WebSocket error, which Bun prints with the full URL", () => {
    expect(
      redactSecrets(
        "WebSocket connection to 'ws://127.0.0.1:59837/ws?wsTicket=eyJ2IjoxfQ.sig-_x&orchestrationProtocol=2' failed: Expected 101 status code: 426",
      ),
    ).toBe(
      "WebSocket connection to 'ws://127.0.0.1:59837/ws?wsTicket=[redacted]&orchestrationProtocol=2' failed: Expected 101 status code: 426",
    );
  });

  it("masks authorization headers and token fields", () => {
    expect(redactSecrets("authorization: Bearer abc.def-123")).toBe(
      "authorization: Bearer [redacted]",
    );
    expect(redactSecrets('{"access_token":"t0ken","bearerToken": "b3arer","port":1}')).toBe(
      '{"access_token":"[redacted]","bearerToken": "[redacted]","port":1}',
    );
    expect(redactSecrets("pair at http://host/pair#token=abc123")).toBe(
      "pair at http://host/pair#token=[redacted]",
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "T3 server 0.1.3 (orchestration protocol 2) at http://127.0.0.1:59837";
    expect(redactSecrets(text)).toBe(text);
  });
});
