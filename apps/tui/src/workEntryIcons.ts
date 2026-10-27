/** What a one-line work row shows, which picks its icon. */
export type WorkEntryKind =
  | "command"
  | "change"
  | "read"
  | "search"
  | "web"
  | "image"
  | "tool"
  | "agent"
  | "request"
  | "thinking"
  | "info"
  | "error";

// Nerd Font glyphs from the old work log.
const WORK_ENTRY_ICONS: Record<WorkEntryKind, string> = {
  command: "󰆍",
  change: "󰏫",
  read: "󰈈",
  search: "󰈈",
  web: "󰖟",
  image: "󰋩",
  tool: "󰞷",
  agent: "󰚩",
  request: "󰋗",
  thinking: "󰚩",
  info: "󰄬",
  error: "󰀦",
};

export function resolveWorkEntryIcon(kind: WorkEntryKind): string {
  return WORK_ENTRY_ICONS[kind];
}
