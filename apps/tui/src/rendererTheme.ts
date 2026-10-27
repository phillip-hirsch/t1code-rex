import * as NodePerfHooks from "node:perf_hooks";
import type { AppTheme } from "@t3tools/client-core";
import {
  TERMINAL_MATCH_THEME_ID,
  hasUsableTerminalColors,
  type TerminalColors,
  type TuiThemeId,
  type TuiThemeMode,
} from "./theme.ts";

export interface ThemeAwareRenderer {
  readonly themeMode?: unknown;
  getPalette?: (options?: { size?: number; timeout?: number }) => Promise<TerminalColors>;
  clearPaletteCache?: () => void;
}

export interface ResolvedTerminalPalette {
  readonly colors: TerminalColors | null;
  readonly durationMs: number;
}

export function shouldTrackSystemThemeMode(theme: AppTheme | undefined): boolean {
  return theme === "system";
}

export function shouldResolveTerminalPalette(themeId: TuiThemeId): boolean {
  return themeId === TERMINAL_MATCH_THEME_ID;
}

export function shouldListenForRendererThemeChanges(
  theme: AppTheme | undefined,
  themeId: TuiThemeId,
): boolean {
  return shouldTrackSystemThemeMode(theme) || shouldResolveTerminalPalette(themeId);
}

export function normalizeRendererThemeMode(value: unknown): TuiThemeMode | null {
  return value === "light" || value === "dark" ? value : null;
}

export async function resolveTerminalPalette(
  renderer: ThemeAwareRenderer,
  options: { clearCache?: boolean } = {},
): Promise<ResolvedTerminalPalette> {
  if (!renderer.getPalette) {
    return { colors: null, durationMs: 0 };
  }

  const startedAt = NodePerfHooks.performance.now();
  if (options.clearCache) {
    renderer.clearPaletteCache?.();
  }

  try {
    const colors = await renderer.getPalette({ size: 16 });
    return {
      colors: hasUsableTerminalColors(colors) ? colors : null,
      durationMs: NodePerfHooks.performance.now() - startedAt,
    };
  } catch {
    return { colors: null, durationMs: NodePerfHooks.performance.now() - startedAt };
  }
}
