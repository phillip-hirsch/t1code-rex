import type { BoxRenderable, KeyEvent, MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import type { KeybindingCommand, ThreadId } from "@t3tools/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  activateTerminal,
  addTerminalGroup,
  activeGroupOf,
  canSplitTerminal,
  clampTerminalDrawerHeight,
  createTerminalDrawerStore,
  cycleTerminal,
  hideTerminalDrawer,
  nextTerminalId,
  openTerminalDrawer,
  removeTerminal,
  splitTerminal,
  terminalIdsOf,
  type TerminalGroup,
  type TerminalSplitDirection,
} from "./terminalDrawer.ts";
import type { TerminalBackend } from "./terminalConnection.ts";
import {
  parseHexColor,
  type TerminalColor,
  type TerminalEmulatorTheme,
} from "./terminalEmulator.ts";
import { modShortcutLabel } from "./keybindings.ts";
import { resolveTerminalDrawerKey } from "./terminalKeys.ts";
import { TerminalPaneRenderable } from "./terminalPane.ts";
import type { TuiTheme } from "./theme.ts";

function paneKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

const BLACK: TerminalColor = { r: 0, g: 0, b: 0 };
const WHITE: TerminalColor = { r: 255, g: 255, b: 255 };

/**
 * The drawer's keys as this platform types them, null where there's none. On Windows and
 * Linux Ctrl+D stays the shell's EOF, and Ctrl+Shift+D isn't offered: without the kitty
 * keyboard protocol it arrives as Ctrl+D. Splitting there is in the palette.
 */
function terminalKeyLabels(platform?: NodeJS.Platform) {
  const mod = (key: string) => modShortcutLabel(key, platform);
  const split = mod("d");
  return {
    toggle: mod("j"),
    split,
    splitDown: split === null ? null : `${split.slice(0, -1)}⇧D`,
    newTab: mod("n"),
    close: mod("w"),
  };
}

/** A focused terminal's footer. */
export function terminalFocusHints(platform?: NodeJS.Platform): string {
  const keys = terminalKeyLabels(platform);
  const hint = (label: string | null, action: string) =>
    label === null ? null : `${label} ${action}`;
  return [
    "^] next pane",
    hint(keys.toggle, "hide"),
    hint(keys.split, "split"),
    hint(keys.newTab, "new tab"),
    hint(keys.close, "close"),
    "^⇧←→ switch",
    "^⇧↑↓ resize",
    "⇧PgUp scroll",
  ]
    .filter((entry) => entry !== null)
    .join("  ");
}

export const TERMINAL_FOCUS_HINTS = terminalFocusHints();
const KEYS = terminalKeyLabels();
const inTerminal = (label: string | null) => (label === null ? "" : `${label} in the terminal`);

/** Where the active thread's shells start, or null when it has no folder yet. */
export interface TerminalDrawerTarget {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly projectRoot: string;
}

export interface TerminalDrawerAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

function emulatorTheme(theme: TuiTheme): TerminalEmulatorTheme {
  const palette = theme.palette;
  return {
    foreground: parseHexColor(palette.text, WHITE),
    background: parseHexColor(palette.input, BLACK),
    cursor: parseHexColor(palette.cursor, WHITE),
  };
}

/**
 * The thread's terminal drawer: its keys, palette actions and view. Shells run on
 * the server, so they keep running while another thread is shown and come back
 * with their scrollback when this one is.
 */
export function useTerminalDrawer(options: {
  readonly backend: TerminalBackend;
  readonly theme: TuiTheme;
  readonly target: TerminalDrawerTarget | null;
  readonly focused: boolean;
  /** Rows and columns the main column has, the drawer included. */
  readonly area: { readonly cols: number; readonly rows: number };
  readonly onFocus: () => void;
  /** The drawer hid or emptied: focus goes back to where typing goes. */
  readonly onLeave: () => void;
  /** Ctrl+]: focus moves on to the next pane; the drawer stays as it is. */
  readonly onTabOut: () => void;
  readonly onStatus: (status: string) => void;
}): {
  readonly open: boolean;
  readonly handleKey: (key: KeyEvent, shortcut: KeybindingCommand | null) => boolean;
  readonly paste: (text: string) => boolean;
  readonly actions: ReadonlyArray<TerminalDrawerAction>;
  readonly element: ReactNode;
} {
  const { backend, target, focused, area } = options;
  const [store] = useState(() => createTerminalDrawerStore());
  useSyncExternalStore(store.subscribe, store.version);
  // Every pane this window has shown, hidden threads' too; never read during render.
  const [panes] = useState(() => new Map<string, TerminalPaneRenderable>());
  useEffect(
    () => () => {
      for (const pane of panes.values()) pane.destroy();
      panes.clear();
    },
    [panes],
  );
  /** A closed or exited terminal's pane goes; after the event that ended it has run. */
  const disposePane = useCallback(
    (threadId: string, terminalId: string) => {
      const key = paneKey(threadId, terminalId);
      const pane = panes.get(key);
      if (pane === undefined) return;
      panes.delete(key);
      queueMicrotask(() => pane.destroy());
    },
    [panes],
  );
  // Opening a drawer picks up shells that outlived an earlier tr3x.
  useEffect(() => backend.retain(), [backend]);
  /** Closes in flight per thread, by terminal id: those ids aren't reused until they settle. */
  const [closing] = useState(() => new Map<string, Map<string, number>>());
  /** Bumped when a terminal is dropped, so a late close leaves a reopened one with its id be. */
  const [generations] = useState(() => new Map<string, number>());

  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  const state = target === null ? null : store.get(target.threadId);
  const open = state?.open === true;
  const height = clampTerminalDrawerHeight(store.height(), area.rows);
  const activeId = state?.activeTerminalId ?? null;
  const activePane = () =>
    activeId === null ? null : (panes.get(paneKey(target?.threadId ?? "", activeId)) ?? null);

  const serverTerminalIds = backend.runningTerminalIds;
  const closingIds = (threadId: string) => [...(closing.get(threadId)?.keys() ?? [])];
  /** Ids a new terminal can't take: the server's shells and the ones still closing. */
  const takenIds = (threadId: string) => [...serverTerminalIds(threadId), ...closingIds(threadId)];
  const openDrawer = (threadId: string) =>
    store.update(threadId, (entry) =>
      openTerminalDrawer(entry, serverTerminalIds(threadId), closingIds(threadId)),
    );

  const requireTarget = (): TerminalDrawerTarget | null => {
    if (target === null) options.onStatus("Select a thread with a folder to open a terminal");
    return target;
  };

  const toggle = () => {
    const current = requireTarget();
    if (current === null) return;
    const drawer = store.get(current.threadId);
    if (!drawer.open) {
      openDrawer(current.threadId);
      options.onFocus();
    } else if (!focused) {
      options.onFocus();
    } else {
      store.update(current.threadId, hideTerminalDrawer);
      options.onLeave();
    }
  };

  const newTerminal = () => {
    const current = requireTarget();
    if (current === null) return;
    store.update(current.threadId, (entry) =>
      addTerminalGroup(entry, nextTerminalId(entry, takenIds(current.threadId))),
    );
    options.onFocus();
  };

  const split = (direction: TerminalSplitDirection) => {
    const current = requireTarget();
    if (current === null) return;
    const drawer = store.get(current.threadId);
    if (!drawer.open) {
      openDrawer(current.threadId);
    } else if (!canSplitTerminal(drawer, direction, { cols: area.cols, rows: height - 1 })) {
      options.onStatus("No room for another terminal pane");
      return;
    }
    store.update(current.threadId, (entry) =>
      splitTerminal(entry, nextTerminalId(entry, takenIds(current.threadId)), direction),
    );
    options.onFocus();
  };

  /** The drawer drops an ended terminal and hides once it was the last. */
  const dropTerminal = useCallback(
    (threadId: string, terminalId: string) => {
      disposePane(threadId, terminalId);
      // A close and the exit it causes both land here; only the first changes anything.
      if (!terminalIdsOf(store.get(threadId)).includes(terminalId)) return;
      const key = paneKey(threadId, terminalId);
      generations.set(key, (generations.get(key) ?? 0) + 1);
      const next = store.update(threadId, (entry) => removeTerminal(entry, terminalId));
      const now = latest.current;
      if (!next.open && now.target?.threadId === threadId && now.focused) now.onLeave();
    },
    [disposePane, generations, store],
  );

  /** Ends the shell and its history. A failed close keeps the terminal, so closing can retry. */
  const endTerminal = useCallback(
    async (threadId: ThreadId, terminalId: string) => {
      const counts = closing.get(threadId) ?? new Map<string, number>();
      closing.set(threadId, counts);
      counts.set(terminalId, (counts.get(terminalId) ?? 0) + 1);
      try {
        await latest.current.backend.close(threadId, terminalId);
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        latest.current.onStatus(`Couldn't close ${terminalId}: ${reason}`);
        return false;
      } finally {
        const left = (counts.get(terminalId) ?? 1) - 1;
        if (left > 0) counts.set(terminalId, left);
        else counts.delete(terminalId);
        if (counts.size === 0) closing.delete(threadId);
      }
    },
    [closing],
  );

  const close = (terminalId: string | null = activeId) => {
    const current = requireTarget();
    if (current === null || terminalId === null) return;
    const key = paneKey(current.threadId, terminalId);
    const generation = generations.get(key) ?? 0;
    void endTerminal(current.threadId, terminalId).then((closed) => {
      // The shell's exit event may have dropped it first; its id may be another terminal's now.
      if (closed && (generations.get(key) ?? 0) === generation) {
        dropTerminal(current.threadId, terminalId);
      }
    });
  };

  // A shell that exits on its own (`exit`, Ctrl+D) leaves like a closed one.
  const onExit = useCallback(
    (threadId: ThreadId, terminalId: string) => {
      dropTerminal(threadId, terminalId);
      void endTerminal(threadId, terminalId);
    },
    [dropTerminal, endTerminal],
  );

  const setHeight = (next: number) => store.setHeight(clampTerminalDrawerHeight(next, area.rows));

  const handleKey = (key: KeyEvent, shortcut: KeybindingCommand | null): boolean => {
    if (shortcut === "terminal.toggle") {
      toggle();
      return true;
    }
    if (shortcut === "terminal.new") {
      newTerminal();
      return true;
    }
    if (shortcut === "terminal.split" || shortcut === "terminal.splitVertical") {
      split(shortcut === "terminal.split" ? "horizontal" : "vertical");
      return true;
    }
    if (shortcut === "terminal.close" && focused) {
      close();
      return true;
    }
    if (!open || target === null) return false;
    const action = resolveTerminalDrawerKey(key);
    if (action?.type === "resize") {
      setHeight(height + action.delta);
      return true;
    }
    if (!focused) return false;
    if (action?.type === "leave") {
      options.onTabOut();
      return true;
    }
    if (action?.type === "cycle") {
      store.update(target.threadId, (entry) => cycleTerminal(entry, action.delta));
      return true;
    }
    if (action?.type === "scroll") {
      activePane()?.scrollPage(action.to);
      return true;
    }
    // Everything else is the shell's, Ctrl+C and Tab included.
    activePane()?.sendKey(key);
    return true;
  };

  const paste = (text: string): boolean => {
    if (!focused || !open) return false;
    activePane()?.paste(text);
    return true;
  };

  const actions: ReadonlyArray<TerminalDrawerAction> = [
    {
      id: "terminal:toggle",
      label: open ? (focused ? "Hide terminal" : "Focus terminal") : "Open terminal",
      description: target === null ? "Select a thread first" : (KEYS.toggle ?? ""),
      disabled: target === null,
      run: toggle,
    },
    {
      id: "terminal:new",
      label: "New terminal tab",
      description: inTerminal(KEYS.newTab),
      disabled: target === null,
      run: newTerminal,
    },
    {
      id: "terminal:split",
      label: "Split terminal",
      description: inTerminal(KEYS.split),
      disabled: target === null,
      run: () => split("horizontal"),
    },
    {
      id: "terminal:split-vertical",
      label: "Split terminal down",
      description: inTerminal(KEYS.splitDown),
      disabled: target === null,
      run: () => split("vertical"),
    },
    ...(open
      ? [
          {
            id: "terminal:close",
            label: "Close terminal",
            description: [activeId, inTerminal(KEYS.close)].filter(Boolean).join("  "),
            run: () => close(),
          },
        ]
      : []),
  ];

  const element =
    open && state !== null && target !== null ? (
      <TerminalDrawerView
        key={`terminal-drawer:${target.threadId}`}
        backend={backend}
        theme={options.theme}
        target={target}
        groups={state.groups}
        activeTerminalId={activeId}
        focused={focused}
        height={height}
        panes={panes}
        onActivate={(terminalId) => {
          store.update(target.threadId, (entry) => activateTerminal(entry, terminalId));
          options.onFocus();
        }}
        onResize={setHeight}
        onExit={onExit}
        onStatus={options.onStatus}
      />
    ) : null;

  return { open, handleKey, paste, actions, element };
}

function TerminalDrawerView(props: {
  readonly backend: TerminalBackend;
  readonly theme: TuiTheme;
  readonly target: TerminalDrawerTarget;
  readonly groups: ReadonlyArray<TerminalGroup>;
  readonly activeTerminalId: string | null;
  readonly focused: boolean;
  readonly height: number;
  readonly panes: Map<string, TerminalPaneRenderable>;
  readonly onActivate: (terminalId: string) => void;
  readonly onResize: (height: number) => void;
  readonly onExit: (threadId: ThreadId, terminalId: string) => void;
  readonly onStatus: (status: string) => void;
}) {
  const { theme, target, groups, activeTerminalId, focused, height } = props;
  const palette = theme.palette;
  const activeGroup = activeGroupOf({ open: true, groups, activeTerminalId }) ?? groups[0] ?? null;
  const drag = useRef<{ readonly y: number; readonly height: number } | null>(null);
  return (
    <box style={{ flexDirection: "column", height, flexShrink: 0, marginTop: 1 }}>
      <box
        style={{ flexDirection: "row", height: 1, backgroundColor: palette.surface }}
        onMouseDown={(event: MouseEvent) => {
          drag.current = { y: event.y, height };
        }}
        onMouseDrag={(event: MouseEvent) => {
          const start = drag.current;
          if (start !== null) props.onResize(start.height + (start.y - event.y));
        }}
        onMouseDragEnd={() => {
          drag.current = null;
        }}
      >
        <text wrapMode="none" content=" Terminal " style={{ fg: palette.subtle }} />
        {groups.map((group, index) => {
          const active = group === activeGroup;
          const label =
            group.terminalIds.length > 1
              ? `${group.terminalIds.length} panes`
              : group.terminalIds[0];
          return (
            <box
              key={group.id}
              style={{
                height: 1,
                paddingLeft: 1,
                paddingRight: 1,
                backgroundColor: active ? palette.controlActive : palette.surface,
              }}
              onMouseDown={(event: MouseEvent) => {
                event.stopPropagation();
                const first = group.terminalIds[0];
                if (first !== undefined) props.onActivate(first);
              }}
            >
              <text
                wrapMode="none"
                content={`${index + 1} ${label ?? ""}`}
                style={{ fg: active ? palette.text : palette.muted }}
              />
            </box>
          );
        })}
        <box style={{ flexGrow: 1 }} />
        <text
          wrapMode="none"
          truncate
          content={`${target.cwd} `}
          style={{ fg: palette.subtle, flexShrink: 1 }}
        />
      </box>
      {activeGroup === null ? null : (
        <box
          key={activeGroup.id}
          style={{
            flexGrow: 1,
            minHeight: 0,
            flexDirection: activeGroup.direction === "horizontal" ? "row" : "column",
          }}
        >
          {activeGroup.terminalIds.map((terminalId, index) => (
            <TerminalPaneHost
              key={`${target.threadId}:${terminalId}`}
              backend={props.backend}
              theme={theme}
              target={target}
              terminalId={terminalId}
              titled={activeGroup.terminalIds.length > 1}
              divider={index > 0 ? activeGroup.direction : null}
              active={terminalId === activeTerminalId}
              focused={focused && terminalId === activeTerminalId}
              panes={props.panes}
              onActivate={props.onActivate}
              onExit={props.onExit}
              onStatus={props.onStatus}
            />
          ))}
        </box>
      )}
    </box>
  );
}

function TerminalPaneHost(props: {
  readonly backend: TerminalBackend;
  readonly theme: TuiTheme;
  readonly target: TerminalDrawerTarget;
  readonly terminalId: string;
  readonly titled: boolean;
  readonly divider: TerminalSplitDirection | null;
  readonly active: boolean;
  readonly focused: boolean;
  readonly panes: Map<string, TerminalPaneRenderable>;
  readonly onActivate: (terminalId: string) => void;
  readonly onExit: (threadId: ThreadId, terminalId: string) => void;
  readonly onStatus: (status: string) => void;
}) {
  const renderer = useRenderer();
  const hostRef = useRef<BoxRenderable | null>(null);
  const paneRef = useRef<TerminalPaneRenderable | null>(null);
  const { backend, target, terminalId, theme, panes } = props;
  const palette = theme.palette;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  // The thread's pane if it has one, else a new one. A layout effect, so the pane is
  // detached before OpenTUI destroys the deleted host box with its children.
  const { threadId, cwd, worktreePath, projectRoot } = target;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const key = paneKey(threadId, terminalId);
    let pane = panes.get(key);
    if (pane === undefined || pane.isDestroyed || pane.cwd !== cwd) {
      pane?.destroy();
      const onExit = latest.current.onExit;
      pane = new TerminalPaneRenderable(renderer, {
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        cwd,
        theme: emulatorTheme(latest.current.theme),
        mutedColor: parseHexColor(latest.current.theme.palette.subtle, WHITE),
        connect: (gridSize) =>
          backend.connect({ threadId, terminalId, cwd, worktreePath, projectRoot }, gridSize, () =>
            onExit(threadId, terminalId),
          ),
      });
      panes.set(key, pane);
    }
    pane.handlers = {
      onPress: () => latest.current.onActivate(terminalId),
      onFailure: (message) => latest.current.onStatus(`Terminal failed: ${message}`),
    };
    pane.setTheme(
      emulatorTheme(latest.current.theme),
      parseHexColor(latest.current.theme.palette.subtle, WHITE),
    );
    host.add(pane);
    paneRef.current = pane;
    const shown = pane;
    return () => {
      paneRef.current = null;
      shown.handlers = null;
      shown.setFocusedCursor(false);
      host.remove(shown.id);
    };
  }, [backend, cwd, panes, projectRoot, renderer, terminalId, threadId, worktreePath]);

  useLayoutEffect(() => {
    paneRef.current?.setFocusedCursor(props.focused);
  }, [props.focused]);
  useEffect(() => {
    paneRef.current?.setTheme(emulatorTheme(theme), parseHexColor(theme.palette.subtle, WHITE));
  }, [theme]);

  return (
    <>
      {props.divider === null ? null : (
        <box
          style={
            props.divider === "horizontal"
              ? { width: 1, flexShrink: 0, backgroundColor: palette.divider }
              : { height: 0, flexShrink: 0 }
          }
        />
      )}
      <box
        style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}
      >
        {props.titled ? (
          <box
            style={{
              height: 1,
              flexShrink: 0,
              paddingLeft: 1,
              backgroundColor: palette.surfaceAlt,
            }}
            onMouseDown={() => props.onActivate(terminalId)}
          >
            <text
              wrapMode="none"
              truncate
              content={`${props.active ? "●" : "○"} ${terminalId}`}
              style={{ fg: props.active ? palette.accent : palette.subtle }}
            />
          </box>
        ) : null}
        <box ref={hostRef} style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }} />
      </box>
    </>
  );
}
