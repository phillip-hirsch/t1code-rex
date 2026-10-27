import {
  type MouseEvent,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  RGBA,
} from "@opentui/core";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputCursor,
} from "@t3tools/client-runtime/state/terminal";

import { scrollbackLabel, terminalRowRuns, type TerminalCellRun } from "./terminalCells.ts";
import type {
  TerminalPaneBuffer,
  TerminalPaneConnection,
  TerminalPaneConnector,
} from "./terminalConnection.ts";
import {
  createTerminalEmulator,
  type TerminalColor,
  type TerminalEmulator,
  type TerminalEmulatorTheme,
  type TerminalSnapshot,
} from "./terminalEmulator.ts";
import { encodeTerminalKey, type TerminalKeyLike } from "./terminalKeys.ts";

const WHEEL_ROWS = 3;

export interface TerminalPaneOptions extends RenderableOptions<TerminalPaneRenderable> {
  readonly connect: TerminalPaneConnector;
  readonly theme: TerminalEmulatorTheme;
  /** Color for the scrollback marker and the startup note. */
  readonly mutedColor: TerminalColor;
  /** The folder the shell was launched in; a pane for another one is a new pane. */
  readonly cwd: string;
}

export interface TerminalPaneHandlers {
  readonly onPress: () => void;
  readonly onFailure: (message: string) => void;
}

function colorKey(color: TerminalColor): number {
  return (color.r << 16) | (color.g << 8) | color.b;
}

/**
 * One terminal pane. While its thread is hidden it's detached, not destroyed, so its
 * screen stays exactly as the emulator laid it out. It draws the emulator's grid straight into OpenTUI's frame
 * buffer: output chunks write to the emulator and ask for a frame, and nothing
 * goes through React. Rows are re-read from the emulator only when they changed.
 */
export class TerminalPaneRenderable extends Renderable {
  private readonly connect: TerminalPaneConnector;
  readonly cwd: string;
  /** Set by whichever view shows the pane now; a hidden pane keeps running without one. */
  handlers: TerminalPaneHandlers | null = null;
  private theme: TerminalEmulatorTheme;
  private mutedColor: TerminalColor;
  private emulator: TerminalEmulator | null = null;
  private connection: TerminalPaneConnection | null = null;
  private unsubscribe: (() => void) | null = null;
  private outputCursor: TerminalOutputCursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  private lastBuffer: TerminalPaneBuffer | null = null;
  private grid: { cols: number; rows: number } | null = null;
  private snapshot: TerminalSnapshot | null = null;
  private rowRuns: Array<ReadonlyArray<TerminalCellRun>> = [];
  private scrollLabel: string | null = null;
  private stale = true;
  private cursorShown = false;
  private failure: string | null = null;
  private readonly colors = new Map<number, RGBA>();

  constructor(ctx: RenderContext, options: TerminalPaneOptions) {
    super(ctx, options);
    this.connect = options.connect;
    this.theme = options.theme;
    this.mutedColor = options.mutedColor;
    this.cwd = options.cwd;
    this.onMouseDown = () => this.handlers?.onPress();
    this.onMouseScroll = (event: MouseEvent) => {
      const direction = event.scroll?.direction;
      if (direction === "up") this.scrollBy(-WHEEL_ROWS);
      else if (direction === "down") this.scrollBy(WHEEL_ROWS);
    };
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const emulator = await createTerminalEmulator({
        cols: Math.max(1, this.width),
        rows: Math.max(1, this.height),
        theme: this.theme,
        onReply: (data) => this.connection?.write(data),
      });
      if (this.isDestroyed) {
        emulator.dispose();
        return;
      }
      this.emulator = emulator;
      this.applyGrid();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.handlers?.onFailure(this.failure);
      this.requestRender();
    }
  }

  /** Sizes the emulator to the pane and connects once both are ready. */
  private applyGrid(): void {
    // Fields aren't set yet while Renderable's constructor runs.
    const emulator = this.emulator ?? null;
    const cols = this.width;
    const rows = this.height;
    // Before layout the pane has no size; a shell started then would get one column.
    if (emulator === null || this.isDestroyed || cols < 2 || rows < 1) return;
    if (this.grid?.cols === cols && this.grid.rows === rows && this.connection !== null) return;
    this.grid = { cols, rows };
    emulator.resize(cols, rows, 1, 1);
    this.stale = true;
    if (this.connection === null) {
      this.connection = this.connect({ cols, rows });
      // Read and subscribe in one step so no chunk lands between them.
      this.sync(this.connection.read());
      this.unsubscribe = this.connection.subscribe((buffer) => this.sync(buffer));
    } else {
      this.connection.reportGridSize({ cols, rows });
    }
    this.requestRender();
  }

  private sync(buffer: TerminalPaneBuffer): void {
    const emulator = this.emulator;
    if (emulator === null) return;
    const previous = this.lastBuffer;
    this.lastBuffer = buffer;
    if (buffer.version > 0 && (previous === null || buffer.output !== previous.output)) {
      const update = readTerminalOutputUpdate(buffer.output, this.outputCursor);
      if (update.type === "reset") emulator.resetAndWrite(update.data);
      else if (update.type === "append") emulator.write(update.data);
      this.outputCursor = update.cursor;
    }
    if (buffer.error !== null && buffer.error !== previous?.error) {
      emulator.write(`\r\n[terminal] ${buffer.error}\r\n`);
    }
    this.stale = true;
    this.requestRender();
  }

  setFocusedCursor(shown: boolean): void {
    if (this.cursorShown === shown) return;
    this.cursorShown = shown;
    this.requestRender();
  }

  setTheme(theme: TerminalEmulatorTheme, mutedColor: TerminalColor): void {
    this.theme = theme;
    this.mutedColor = mutedColor;
    this.emulator?.setTheme(theme);
    this.stale = true;
    this.requestRender();
  }

  /** Sends a key press to the shell; false when it sends nothing. */
  sendKey(key: TerminalKeyLike): boolean {
    const emulator = this.emulator;
    if (emulator === null || this.connection === null) return false;
    const data = encodeTerminalKey(emulator, key);
    if (data.length === 0) return false;
    this.sendInput(data);
    return true;
  }

  /** A paste, bracketed when the program asked for that. */
  paste(text: string): void {
    const emulator = this.emulator;
    if (emulator === null || text.length === 0) return;
    this.sendInput(emulator.encodePaste(text));
  }

  private sendInput(data: string): void {
    if (data.length === 0) return;
    // Typing returns to the live screen, like any terminal.
    if (this.scrollLabel !== null) {
      this.emulator?.scrollToBottom();
      this.stale = true;
      this.requestRender();
    }
    this.connection?.write(data);
  }

  scrollBy(rows: number): void {
    this.emulator?.scroll(rows);
    this.stale = true;
    this.requestRender();
  }

  scrollPage(to: "pageUp" | "pageDown" | "top" | "bottom"): void {
    const emulator = this.emulator;
    if (emulator === null) return;
    if (to === "bottom") emulator.scrollToBottom();
    else if (to === "top") emulator.scroll(-(emulator.scrollbarState()?.total ?? 0));
    else emulator.scroll((to === "pageUp" ? -1 : 1) * Math.max(1, this.height - 1));
    this.stale = true;
    this.requestRender();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.applyGrid();
  }

  private rgba(color: TerminalColor): RGBA {
    const key = colorKey(color);
    let rgba = this.colors.get(key);
    if (rgba === undefined) {
      rgba = RGBA.fromInts(color.r, color.g, color.b, 255);
      this.colors.set(key, rgba);
    }
    return rgba;
  }

  private refresh(emulator: TerminalEmulator): TerminalSnapshot {
    const snapshot = emulator.snapshot();
    const full = this.rowRuns.length !== snapshot.rows || this.snapshot?.cols !== snapshot.cols;
    if (full) this.rowRuns = Array.from({ length: snapshot.rows }, () => []);
    snapshot.rowData.forEach((row, index) => {
      if (full || snapshot.dirtyRows.has(index)) this.rowRuns[index] = terminalRowRuns(row);
    });
    this.snapshot = snapshot;
    this.scrollLabel = scrollbackLabel(emulator.scrollbarState());
    this.stale = false;
    return snapshot;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const emulator = this.emulator;
    const background = this.rgba(this.theme.background);
    buffer.fillRect(this.x, this.y, this.width, this.height, background);
    if (emulator === null) {
      const note =
        this.failure === null ? "Starting terminal…" : `Terminal failed: ${this.failure}`;
      buffer.drawText(
        note.slice(0, this.width),
        this.x,
        this.y,
        this.rgba(this.mutedColor),
        background,
      );
      return;
    }
    const snapshot = this.stale || this.snapshot === null ? this.refresh(emulator) : this.snapshot;
    const rows = Math.min(this.height, this.rowRuns.length);
    for (let row = 0; row < rows; row += 1) {
      for (const run of this.rowRuns[row] ?? []) {
        if (run.x >= this.width) break;
        buffer.drawText(
          run.text,
          this.x + run.x,
          this.y + row,
          this.rgba(run.foreground),
          this.rgba(run.background),
          run.attributes,
        );
      }
    }
    const { cursorX, cursorY } = snapshot;
    if (
      this.cursorShown &&
      snapshot.cursorVisible &&
      cursorX >= 0 &&
      cursorY >= 0 &&
      cursorX < this.width &&
      cursorY < this.height
    ) {
      const cell = snapshot.rowData[cursorY]?.cells[cursorX];
      buffer.setCell(
        this.x + cursorX,
        this.y + cursorY,
        cell === undefined || cell.text.length === 0 ? " " : cell.text,
        this.rgba(cell?.background ?? snapshot.background),
        this.rgba(snapshot.cursor),
      );
    }
    if (this.scrollLabel !== null && this.width > this.scrollLabel.length + 2) {
      const label = ` ${this.scrollLabel} `;
      buffer.drawText(
        label,
        this.x + this.width - label.length,
        this.y,
        this.rgba(this.theme.background),
        this.rgba(this.mutedColor),
      );
    }
  }

  protected override destroySelf(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connection?.dispose();
    this.connection = null;
    this.emulator?.dispose();
    this.emulator = null;
    super.destroySelf();
  }
}
