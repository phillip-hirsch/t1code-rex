const AUTHORIZATION = /\b(Bearer|DPoP)\s+[^\s"',]+/giu;
const SECRET_FIELD =
  /\b(wsTicket|token|access_token|subject_token|desktopBootstrapToken|bearerToken)(["']?\s*[=:]\s*["']?)[^\s"'&,}]+/giu;

/** Masks credentials in text that tr3x prints, such as server output and error messages. */
export function redactSecrets(text: string): string {
  return text.replace(AUTHORIZATION, "$1 [redacted]").replace(SECRET_FIELD, "$1$2[redacted]");
}

/** An error's message, safe to print. */
export function describeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
