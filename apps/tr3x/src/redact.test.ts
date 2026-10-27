import { describe, expect, it } from "vite-plus/test";

import { redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  it("masks the ticket in a WebSocket error that carries the full URL", () => {
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

  it.each([
    ["refreshToken=abc123", "refreshToken=[redacted]"],
    ["sessionToken: abc123", "sessionToken: [redacted]"],
    ["accessToken=abc123&x=1", "accessToken=[redacted]&x=1"],
    ["apiKey=abc123", "apiKey=[redacted]"],
    ['{"refresh_token":"abc123"}', '{"refresh_token":"[redacted]"}'],
    ["ticket=abc123", "ticket=[redacted]"],
    ["--auth-token abc123 --port 1", "--auth-token [redacted] --port 1"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2lnbmF0dXJl end", "jwt [redacted] end"],
  ])("masks %s", (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it("leaves ordinary text alone", () => {
    const text = "T3 server 0.1.3 (orchestration protocol 2) at http://127.0.0.1:59837";
    expect(redactSecrets(text)).toBe(text);
  });
});
