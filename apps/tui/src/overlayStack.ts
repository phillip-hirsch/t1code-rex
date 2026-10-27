/**
 * The Shell's overlays, top first, as they stack on screen: dialogs, the Source Control and
 * archived views (z 260, later ones drawn over earlier ones), the model picker and palette
 * (z 250), the git overlay (z 245), then the context menu (z 240).
 */
export const OVERLAY_STACK = [
  "dialog",
  "source-control",
  "archived",
  "model-picker",
  "palette",
  "git",
  "context-menu",
] as const;

export type OverlayLayer = (typeof OVERLAY_STACK)[number];

/**
 * The open overlay on top: the one that's drawn and takes the keys. An overlay under it
 * stays open but isn't drawn, so nothing hidden can be confirmed.
 */
export function topOverlay(
  open: Readonly<Partial<Record<OverlayLayer, boolean>>>,
): OverlayLayer | null {
  return OVERLAY_STACK.find((layer) => open[layer] === true) ?? null;
}
