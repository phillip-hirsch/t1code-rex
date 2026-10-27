import type { TimestampFormat } from "@t3tools/contracts";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(format: TimestampFormat, timeZone: string | undefined): Intl.DateTimeFormat {
  const cacheKey = `${format}:${timeZone ?? ""}`;
  let formatter = formatters.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(format === "locale" ? {} : { hourCycle: format === "12-hour" ? "h12" : "h23" }),
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    formatters.set(cacheKey, formatter);
  }
  return formatter;
}

/** Clock time under a message, honoring the timestamp format setting as before. */
export function formatMessageTimestamp(
  epochMs: number | null,
  format: TimestampFormat,
  timeZone?: string,
): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return "";
  return formatterFor(format, timeZone).format(epochMs);
}
