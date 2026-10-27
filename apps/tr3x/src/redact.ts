/**
 * A secret-like key: any name containing one of these words (`refreshToken`,
 * `wsTicket`, `--auth-token`), or exactly `session`, `auth` or `jwt`.
 */
const SECRET_KEY = String.raw`(?:[\w-]*(?:token|ticket|secret|password|passwd|api[_-]?key|credential|cookie)[\w-]*|(?:session|auth|jwt)(?![\w-]))`;
/** What precedes a secret value: `key=`, `key: `, `"key":`, or `--key `. */
const KEY_PREFIX = String.raw`((?<![\w-])(?:${SECRET_KEY}["']?\s*[=:]\s*|--${SECRET_KEY}\s+))`;
/** A quoted value up to its closing quote, or to the end of the line when it has none. */
const QUOTED = String.raw`(["'])(?:\\.|(?!\2)[^\\\n])+\2?`;
/** Where an unquoted value ends: whitespace, `,`, `;`, `&`, a quote or a closing bracket. */
const END = String.raw`[\s,;&"')\]}]`;
/** Counts such as `max_tokens=4096` or `tokensUsed: 99/100` stay readable. */
const NUMBER = String.raw`\d+(?:[./]\d+)*(?:${END}|$)`;
const REDACTED = "[redacted]";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization:` and `Cookie:` headers: the whole value, whatever the scheme.
  [
    new RegExp(
      String.raw`(\b(?:authorization|cookie)["']?\s*[=:]\s*)(?:${QUOTED}|[^\r\n]+)`,
      "giu",
    ),
    `$1$2${REDACTED}$2`,
  ],
  // A quoted value after a secret-like key.
  [new RegExp(String.raw`${KEY_PREFIX}${QUOTED}`, "giu"), `$1$2${REDACTED}$2`],
  // An unquoted value after a secret-like key, unless it's a number.
  [
    new RegExp(String.raw`${KEY_PREFIX}(?!\[redacted\])(?!${NUMBER})((?:(?!${END})\S)+)`, "giu"),
    `$1${REDACTED}`,
  ],
  // `Bearer <value>` anywhere, when the value looks like a token.
  [/\b(Bearer|DPoP)\s+[\w.~+/=-]{16,}/giu, `$1 ${REDACTED}`],
  // A JWT or ticket-shaped `eyJ…` value on its own.
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/gu, REDACTED],
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
