// Any key whose name contains one of these words holds a secret, e.g. `refreshToken`, `wsTicket`, `--auth-token`.
const SECRET_KEY = String.raw`[\w-]*(?:token|ticket|secret|password|passwd|api[_-]?key|credential)[\w-]*`;
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `key=value`, `key: value`, `"key":"value"`
  [new RegExp(String.raw`(${SECRET_KEY}["']?\s*[=:]\s*["']?)[^\s"'&,;}]+`, "giu"), "$1[redacted]"],
  // `--flag value`
  [new RegExp(String.raw`(--${SECRET_KEY}\s+)[^\s"'-][^\s"']*`, "giu"), "$1[redacted]"],
  // `Authorization: <any scheme> value`, or a bare `Bearer value`
  [/(authorization["']?\s*[=:]\s*["']?(?:[a-z]+\s+)?)[^\s"',}]+/giu, "$1[redacted]"],
  [/\b(Bearer|DPoP)\s+(?!\[redacted\])[^\s"',]+/giu, "$1 [redacted]"],
  // A JWT or ticket-shaped `eyJ…` value on its own
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/gu, "[redacted]"],
];

/** Masks credentials in text that tr3x prints, such as server output and error messages. */
export function redactSecrets(text: string): string {
  return PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

/** An error's message, safe to print. */
export function describeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
