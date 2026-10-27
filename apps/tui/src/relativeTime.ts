/** Compact age for sidebar rows: "now", "5m", "3h", "2d". */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const diffMs = nowMs - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "";
  const minutes = Math.max(Math.floor(diffMs / 60_000), 0);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
