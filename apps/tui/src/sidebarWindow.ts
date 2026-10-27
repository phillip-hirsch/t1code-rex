import type { SidebarRow } from "./sidebarModel.ts";

/**
 * The sidebar draws only the lines in its viewport, so a long thread list mounts (and
 * subscribes to tickers for) a screenful of rows rather than all of them. A line is a
 * navigable row or a note that closes an expanded project's block.
 */

export interface SidebarNote {
  readonly kind: "note";
  readonly key: string;
  readonly text: string;
}

export type SidebarLine = SidebarRow | SidebarNote;

export function buildSidebarLines(input: {
  readonly rows: ReadonlyArray<SidebarRow>;
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly threadCountByProject: ReadonlyMap<string, number>;
  readonly olderSettledByProject: ReadonlyMap<string, number>;
}): ReadonlyArray<SidebarLine> {
  const lines: SidebarLine[] = [];
  const closeProject = (projectId: string | null) => {
    if (projectId === null || !input.expandedProjectIds.has(projectId)) return;
    if ((input.threadCountByProject.get(projectId) ?? 0) === 0) {
      lines.push({ kind: "note", key: `empty:${projectId}`, text: "No threads yet" });
    }
    const older = input.olderSettledByProject.get(projectId) ?? 0;
    if (older > 0) {
      lines.push({
        kind: "note",
        key: `older:${projectId}`,
        text: `${older} older settled thread${older === 1 ? "" : "s"}`,
      });
    }
  };
  let openProjectId: string | null = null;
  for (const row of input.rows) {
    if (row.kind === "project") {
      closeProject(openProjectId);
      openProjectId = row.projectId;
    }
    lines.push(row);
  }
  closeProject(openProjectId);
  return lines;
}

/** Keeps the first drawn line within the list, with no empty space after its end. */
export function clampScrollTop(scrollTop: number, lineCount: number, viewportHeight: number) {
  return Math.max(0, Math.min(scrollTop, lineCount - viewportHeight));
}

/** The smallest scroll that brings line `index` into view; unchanged when it is visible. */
export function revealLine(scrollTop: number, viewportHeight: number, index: number): number {
  if (index < 0 || viewportHeight <= 0) return scrollTop;
  if (index < scrollTop) return index;
  if (index >= scrollTop + viewportHeight) return index - viewportHeight + 1;
  return scrollTop;
}

/** Scrollbar thumb rows within the viewport, or null when everything fits. */
export function scrollbarThumb(
  lineCount: number,
  viewportHeight: number,
  scrollTop: number,
): { readonly start: number; readonly size: number } | null {
  if (viewportHeight <= 0 || lineCount <= viewportHeight) return null;
  const size = Math.max(1, Math.round((viewportHeight * viewportHeight) / lineCount));
  const maxTop = lineCount - viewportHeight;
  const start = Math.round(
    (clampScrollTop(scrollTop, lineCount, viewportHeight) / maxTop) * (viewportHeight - size),
  );
  return { start, size };
}
