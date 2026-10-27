import { describe, expect, it } from "vite-plus/test";

import { redactSecrets } from "./redact.ts";

const BEARER = "Bearer abcdefghij0123456789";

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

  it.each([
    // Quoted values, up to the closing quote
    ['{"password":"correct horse battery"}', '{"password":"[redacted]"}'],
    ["password='correct horse' next", "password='[redacted]' next"],
    ['{"access_token":"t0ken","port":1}', '{"access_token":"[redacted]","port":1}'],
    ['"bearerToken": "b3 ar,er"', '"bearerToken": "[redacted]"'],
    ['"secret": "unterminated value', '"secret": "[redacted]"'],
    // Unquoted values, up to whitespace, `,`, `;`, `&` or a closing bracket
    ["refreshToken=abc123 next", "refreshToken=[redacted] next"],
    ["sessionToken: abc123,x", "sessionToken: [redacted],x"],
    ["accessToken=abc123&x=1", "accessToken=[redacted]&x=1"],
    ["apiKey=abc123;x", "apiKey=[redacted];x"],
    ["{ticket: abc123}", "{ticket: [redacted]}"],
    ["pair at http://host/pair#token=abc123", "pair at http://host/pair#token=[redacted]"],
    ["--auth-token abc123 --port 1", "--auth-token [redacted] --port 1"],
    ["password=12ab", "password=[redacted]"],
    ["sessionCookie=abc123", "sessionCookie=[redacted]"],
    ["session=abc123", "session=[redacted]"],
    ["auth: abc123", "auth: [redacted]"],
    ["jwt=abc123", "jwt=[redacted]"],
    // Fail-safe: a secret-like key followed by prose still masks the next word.
    ["Invalid credentials: user not found", "Invalid credentials: [redacted] not found"],
    // Headers: the whole value, whatever the scheme
    ["Authorization: Custom-1 abc123", "Authorization: [redacted]"],
    ["authorization: abcdef failed badly\nnext", "authorization: [redacted]\nnext"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ['{"Authorization":"Bearer abc","port":1}', '{"Authorization":"[redacted]","port":1}'],
    ["Cookie: a=1; sid=abc", "Cookie: [redacted]"],
    // Bearer values that look like a token
    [`failed with ${BEARER} today`, "failed with Bearer [redacted] today"],
    // Bare JWTs
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2lnbmF0dXJl end", "jwt [redacted] end"],
  ])("masks %j", (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it.each([
    "inputTokens: 1234",
    "max_tokens=4096",
    "tokenCount=42",
    "tokensUsed: 99/100",
    '{"inputTokens": 1234, "outputTokens":7}',
    "Missing bearer token in request",
    "Bearer short",
    "author=ada sessions=3 oauth=on jwtish=1 authority: x",
    "T3 server 0.1.3 (orchestration protocol 2) at http://127.0.0.1:59837",
  ])("leaves %j alone", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});
