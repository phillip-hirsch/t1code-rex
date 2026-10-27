// @effect-diagnostics nodeBuiltinImport:off -- Bun-only loader for the web app's terminal emulator; it runs outside the Effect runtime.
/**
 * Web's libghostty-vt core (`apps/web/src/terminal/ghostty/core.ts`), loaded as is.
 * Web's sources don't typecheck under NodeNext, so it's imported by a URL TypeScript
 * doesn't follow and typed by the slice below; check-terminal.tsx proves the slice.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface TerminalColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TerminalEmulatorTheme {
  readonly foreground: TerminalColor;
  readonly background: TerminalColor;
  readonly cursor: TerminalColor;
}

export interface TerminalCell {
  readonly text: string;
  /** 0 narrow, 1 wide, 2 the spacer after a wide cell, 3 a spacer at a wrapped line's end. */
  readonly wide: number;
  readonly foreground: TerminalColor;
  readonly background: TerminalColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly underline: boolean;
}

export interface TerminalRow {
  readonly cells: ReadonlyArray<TerminalCell>;
}

export interface TerminalSnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly background: TerminalColor;
  readonly cursor: TerminalColor;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorVisible: boolean;
  readonly dirtyRows: ReadonlySet<number>;
  readonly rowData: ReadonlyArray<TerminalRow>;
}

export interface TerminalScrollbar {
  readonly total: number;
  readonly offset: number;
  readonly len: number;
}

/** The DOM KeyboardEvent fields web's key encoder reads. */
export interface TerminalKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  getModifierState(key: string): boolean;
}

/** The part of web's GhosttyTerminalCore the drawer uses. */
export interface TerminalEmulator {
  write(data: string): void;
  resetAndWrite(data: string): void;
  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void;
  setTheme(theme: TerminalEmulatorTheme): void;
  scroll(deltaRows: number): void;
  scrollToBottom(): void;
  scrollbarState(): TerminalScrollbar | null;
  encodeKey(event: TerminalKeyboardEvent): string;
  encodePaste(data: string): string;
  snapshot(): TerminalSnapshot;
  dispose(): void;
}

interface GhosttyCoreModule {
  readonly GhosttyTerminalCore: {
    create(
      cols: number,
      rows: number,
      cellWidth: number,
      cellHeight: number,
      theme: TerminalEmulatorTheme,
      onPtyData: (data: string) => void,
    ): Promise<TerminalEmulator>;
  };
}

// A `string`, not a literal, so TypeScript doesn't follow it into web's sources.
const GHOSTTY_CORE_URL: string = new URL("../../web/src/terminal/ghostty/core.ts", import.meta.url)
  .href;

let corePromise: Promise<GhosttyCoreModule> | null = null;

/** Bun makes web's `…wasm?url` imports plain paths, which `fetch` rejects; these are file URLs. */
async function installWasmUrlPlugin(): Promise<void> {
  const { plugin } = await import("bun");
  plugin({
    name: "tr3x-ghostty-wasm-url",
    setup(builder) {
      builder.onResolve({ filter: /\.wasm\?url/ }, (args) => ({
        path: NodePath.resolve(NodePath.dirname(args.importer), args.path.split("?")[0] ?? ""),
        namespace: "tr3x-wasm-url",
      }));
      builder.onLoad({ filter: /.*/, namespace: "tr3x-wasm-url" }, (args) => ({
        contents: `export default ${JSON.stringify(NodeURL.pathToFileURL(args.path).href)};`,
        loader: "js",
      }));
    },
  });
}

function isGhosttyCoreModule(value: unknown): value is GhosttyCoreModule {
  if (typeof value !== "object" || value === null || !("GhosttyTerminalCore" in value)) {
    return false;
  }
  const core = value.GhosttyTerminalCore;
  return typeof core === "function" && "create" in core && typeof core.create === "function";
}

function loadCore(): Promise<GhosttyCoreModule> {
  corePromise ??= installWasmUrlPlugin()
    .then(() => import(GHOSTTY_CORE_URL))
    .then((module: unknown) => {
      if (!isGhosttyCoreModule(module)) throw new Error("libghostty-vt core has an unknown shape");
      return module;
    })
    .catch((error: unknown) => {
      corePromise = null;
      throw error;
    });
  return corePromise;
}

/**
 * A new emulator. `onReply` gets what the emulator answers on the program's behalf
 * (cursor position and device reports), which belongs on the PTY like typed input.
 */
export async function createTerminalEmulator(input: {
  readonly cols: number;
  readonly rows: number;
  readonly theme: TerminalEmulatorTheme;
  readonly onReply: (data: string) => void;
}): Promise<TerminalEmulator> {
  const { GhosttyTerminalCore } = await loadCore();
  // Cells are terminal cells, so one "pixel" per cell keeps pixel reports in cell units.
  return GhosttyTerminalCore.create(input.cols, input.rows, 1, 1, input.theme, input.onReply);
}

/** `#rrggbb` (or `#rrggbbaa`) as a color; anything else falls back. */
export function parseHexColor(value: string, fallback: TerminalColor): TerminalColor {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/iu.exec(value);
  if (!match) return fallback;
  return {
    r: Number.parseInt(match[1] ?? "0", 16),
    g: Number.parseInt(match[2] ?? "0", 16),
    b: Number.parseInt(match[3] ?? "0", 16),
  };
}
