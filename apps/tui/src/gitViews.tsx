import type { KeyEvent } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import {
  resolveVisibleWorktreeSetup,
  worktreeSetupAgentStarted,
} from "@t3tools/client-runtime/worktree-setup";
import type { ThreadId, VcsListRefsResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo, useImperativeHandle, useState, type Ref } from "react";

import {
  buildBranchPickerItems,
  describeBranchPickerItem,
  type BranchPickerItem,
} from "./branchPicker.ts";
import {
  describeBranchToolbar,
  resolveToolbarBranch,
  type EnvMode,
  type ToolbarSegment,
  type ToolbarTone,
} from "./branchToolbar.ts";
import type { TuiConnection, VcsRefsAtom } from "./connection/tuiConnection.ts";
import { buildGitMenuItems, type GitMenuItem } from "./gitMenu.ts";
import { printableText } from "./sidebarKeys.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";
import { describeWorktreeSetup } from "./worktreeSetupView.ts";

/** What the git views read; the TUI's connection, or fixed atoms in checks. */
export type GitSource = Pick<
  TuiConnection,
  "vcsStatusAtom" | "vcsRefsAtom" | "vcsActionStateAtom" | "worktreeSetupAtom"
>;

const OVERLAY_ROWS_MAX = 12;
// The menu doesn't list refs, so it doesn't ask for them.
const NO_REFS: VcsRefsAtom = Atom.make(AsyncResult.initial<VcsListRefsResult, unknown>());

export function toneColor(theme: TuiTheme, tone: ToolbarTone): TuiColor {
  const { palette } = theme;
  switch (tone) {
    case "text":
      return palette.text;
    case "muted":
      return palette.muted;
    case "success":
      return palette.success;
    case "warning":
      return palette.warning;
    case "info":
      return palette.info;
    case "error":
      return palette.composerStop;
  }
}

function isEnter(name: string): boolean {
  return name === "return" || name === "enter";
}

export interface BranchToolbarProps {
  readonly source: GitSource;
  /** Where git runs: the thread's worktree, else the project's checkout. */
  readonly cwd: string;
  readonly draft: boolean;
  readonly envMode: EnvMode;
  readonly worktreePath: string | null;
  readonly threadBranch: string | null;
  readonly theme: TuiTheme;
  readonly onPress: (action: NonNullable<ToolbarSegment["action"]>) => void;
}

/**
 * The row under the composer: env mode, branch, changes, upstream and PR, live from
 * `subscribeVcsStatus`. It reads the status itself, so an update repaints only this row.
 */
export const BranchToolbar = memo(function BranchToolbar(props: BranchToolbarProps) {
  const { theme } = props;
  const statusResult = useAtomValue(props.source.vcsStatusAtom(props.cwd));
  const action = useAtomValue(props.source.vcsActionStateAtom(props.cwd));
  const segments = describeBranchToolbar({
    draft: props.draft,
    envMode: props.envMode,
    worktreePath: props.worktreePath,
    threadBranch: props.threadBranch,
    status: Option.getOrNull(AsyncResult.value(statusResult)) ?? null,
    statusFailed: AsyncResult.isFailure(statusResult),
    action,
  });
  return (
    <box
      style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, overflow: "hidden" }}
    >
      {segments.map((segment, index) => (
        <box
          key={segment.id}
          style={{ flexDirection: "row", flexShrink: segment.id === "action" ? 1 : 0, minWidth: 0 }}
          onMouseDown={(event) => {
            if (segment.action === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            props.onPress(segment.action);
          }}
        >
          {index > 0 ? (
            <text wrapMode="none" content="  " style={{ fg: theme.palette.subtle }} />
          ) : null}
          <text
            wrapMode="none"
            truncate
            content={segment.text}
            style={{ fg: toneColor(theme, segment.tone) }}
          />
        </box>
      ))}
    </box>
  );
});

export interface GitOverlayHandle {
  /** Keys while the overlay is open; it uses every one. */
  readonly handleKey: (key: KeyEvent) => void;
}

export type GitOverlayMode =
  | { readonly kind: "menu" }
  | { readonly kind: "branches"; readonly initialQuery: string };

export interface GitOverlayProps {
  readonly source: GitSource;
  readonly cwd: string;
  readonly mode: GitOverlayMode;
  readonly projectCwd: string;
  readonly envMode: EnvMode;
  readonly worktreePath: string | null;
  readonly threadBranch: string | null;
  /** Picking a new worktree's base names a ref; it never checks one out or creates one. */
  readonly pickingWorktreeBase: boolean;
  readonly commitModelLabel: string;
  /** The menu item waiting for its second ⏎. */
  readonly armedId: string | null;
  /** Left edge, past the sidebar. */
  readonly left: number;
  readonly theme: TuiTheme;
  readonly onMenuItem: (item: GitMenuItem) => void;
  readonly onBranchItem: (item: BranchPickerItem) => void;
  readonly onClose: () => void;
  readonly ref?: Ref<GitOverlayHandle>;
}

/** The git menu or the branch picker, above the branch toolbar. */
export function GitOverlay(props: GitOverlayProps) {
  const { theme, mode, ref } = props;
  const palette = theme.palette;
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState(mode.kind === "branches" ? mode.initialQuery : "");
  const statusResult = useAtomValue(props.source.vcsStatusAtom(props.cwd));
  const status = Option.getOrNull(AsyncResult.value(statusResult)) ?? null;
  const action = useAtomValue(props.source.vcsActionStateAtom(props.cwd));
  const refsResult = useAtomValue(
    mode.kind === "branches" ? props.source.vcsRefsAtom(props.cwd) : NO_REFS,
  );
  const refs = mode.kind === "branches" ? Option.getOrNull(AsyncResult.value(refsResult)) : null;

  const menuItems =
    mode.kind === "menu"
      ? buildGitMenuItems({
          status,
          busy: action.isRunning,
          commitModelLabel: props.commitModelLabel,
        })
      : [];
  const branchItems =
    mode.kind === "branches"
      ? buildBranchPickerItems({
          refs,
          query,
          activeBranch: resolveToolbarBranch({
            envMode: props.envMode,
            worktreePath: props.worktreePath,
            threadBranch: props.threadBranch,
            currentBranch: status?.refName ?? null,
          }),
          projectCwd: props.projectCwd,
          canCreate: !props.pickingWorktreeBase,
        })
      : [];
  const count = mode.kind === "menu" ? menuItems.length : branchItems.length;
  const selected = Math.min(index, Math.max(0, count - 1));
  const windowStart = Math.max(0, selected - OVERLAY_ROWS_MAX + 1);

  const pick = (at: number) => {
    if (mode.kind === "menu") {
      const item = menuItems[at];
      if (item) props.onMenuItem(item);
    } else {
      const item = branchItems[at];
      if (item) props.onBranchItem(item);
    }
  };

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) props.onClose();
      else if (key.name === "up" || (mode.kind === "menu" && key.name === "k"))
        setIndex(Math.max(0, selected - 1));
      else if (key.name === "down" || (mode.kind === "menu" && key.name === "j"))
        setIndex(Math.min(count - 1, selected + 1));
      else if (isEnter(key.name)) {
        if (!key.repeated) pick(selected);
      } else if (mode.kind === "branches") {
        if (key.name === "backspace") {
          setQuery((current) => current.slice(0, -1));
          setIndex(0);
        } else {
          const text = printableText(key);
          if (text !== null) {
            setQuery((current) => current + text);
            setIndex(0);
          }
        }
      }
    },
  }));

  const title =
    mode.kind === "menu"
      ? status?.refName
        ? `Git · ${status.refName}`
        : "Git"
      : props.pickingWorktreeBase
        ? "New worktree from…"
        : "Switch branch";
  const armed =
    mode.kind === "menu" ? (menuItems.find((item) => item.id === props.armedId) ?? null) : null;
  const note =
    mode.kind === "branches"
      ? refs === null
        ? AsyncResult.isFailure(refsResult)
          ? "Couldn't list branches"
          : "Loading branches…"
        : refs.nextCursor !== null
          ? `Showing ${refs.refs.length} of ${refs.totalCount} refs; type to filter`
          : null
      : (armed?.confirm ?? null);

  return (
    <box
      style={{
        position: "absolute",
        bottom: 2,
        left: props.left,
        width: 64,
        flexDirection: "column",
        backgroundColor: palette.popup,
        border: true,
        borderColor: palette.accent,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 245,
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <text wrapMode="none" truncate content={title} style={{ fg: palette.text }} />
      {mode.kind === "branches" ? (
        <text
          wrapMode="none"
          truncate
          content={query.length > 0 ? `› ${query}▏` : "› type to filter or name a new branch"}
          style={{ fg: query.length > 0 ? palette.text : palette.subtle }}
        />
      ) : null}
      {count === 0 && mode.kind === "branches" && refs !== null ? (
        <text content="No matching branches" style={{ fg: palette.muted }} />
      ) : null}
      {(mode.kind === "menu" ? menuItems : branchItems)
        .slice(windowStart, windowStart + OVERLAY_ROWS_MAX)
        .map((item, offset) => {
          const at = windowStart + offset;
          const active = at === selected;
          const row = describeOverlayRow(item);
          return (
            <box
              key={item.id}
              style={{
                flexDirection: "row",
                height: 1,
                backgroundColor: active ? palette.selection : palette.popup,
              }}
              onMouseOver={() => setIndex(at)}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                pick(at);
              }}
            >
              <text
                wrapMode="none"
                truncate
                content={`${row.icon} ${row.label}`}
                style={{ fg: row.disabled ? palette.subtle : palette.text, flexShrink: 1 }}
              />
              <box style={{ flexGrow: 1 }} />
              {row.trailing === null ? null : (
                <text
                  wrapMode="none"
                  content={` ${row.trailing}`}
                  style={{ fg: palette.subtle, flexShrink: 0 }}
                />
              )}
            </box>
          );
        })}
      {mode.kind === "menu" && menuItems[selected]?.disabledReason !== undefined ? (
        <text
          wrapMode="none"
          truncate
          content={menuItems[selected]?.disabledReason ?? ""}
          style={{ fg: palette.muted }}
        />
      ) : null}
      {note === null ? null : (
        <text wrapMode="none" truncate content={note} style={{ fg: palette.warning }} />
      )}
      <text
        wrapMode="none"
        truncate
        content={mode.kind === "menu" ? "↑↓ move  ⏎ run  esc close" : "↑↓ move  ⏎ pick  esc close"}
        style={{ fg: palette.subtle }}
      />
    </box>
  );
}

function describeOverlayRow(item: GitMenuItem | BranchPickerItem): {
  readonly icon: string;
  readonly label: string;
  readonly trailing: string | null;
  readonly disabled: boolean;
} {
  if ("command" in item) {
    return {
      icon: item.icon,
      label: item.label,
      trailing: null,
      disabled: item.disabledReason !== undefined,
    };
  }
  return {
    icon: item.kind === "ref" ? (item.selected ? "●" : " ") : item.kind === "create" ? "+" : "󰊢",
    label: describeBranchPickerItem(item),
    trailing: item.kind === "ref" ? item.tag : null,
    disabled: false,
  };
}

export interface WorktreeSetupPanelProps {
  readonly source: GitSource;
  readonly threadId: ThreadId;
  readonly theme: TuiTheme;
  readonly onCancel: () => void;
}

/** A new worktree's setup, stage by stage, until the agent starts in it. */
export const WorktreeSetupPanel = memo(function WorktreeSetupPanel(props: WorktreeSetupPanelProps) {
  const { theme } = props;
  const live = Option.getOrNull(
    AsyncResult.value(useAtomValue(props.source.worktreeSetupAtom(props.threadId))),
  );
  const snapshot = resolveVisibleWorktreeSetup({
    live: live ?? null,
    recorded: null,
    turnStarted: live != null && worktreeSetupAgentStarted(live),
    followUpSent: false,
  });
  if (snapshot === null) return null;
  const view = describeWorktreeSetup(snapshot);
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
        border: true,
        borderStyle: "rounded",
        borderColor: toneColor(theme, view.tone),
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={`󰙅 ${view.title}`}
          style={{ fg: toneColor(theme, view.tone), flexShrink: 1 }}
        />
        <box style={{ flexGrow: 1 }} />
        {view.cancellable ? (
          <text
            wrapMode="none"
            content="[cancel ⌘K]"
            style={{ fg: theme.palette.subtle, flexShrink: 0 }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }}
          />
        ) : null}
      </box>
      {view.lines.map((line) => (
        <text
          key={line.id}
          wrapMode="none"
          truncate
          content={`${line.icon} ${line.text}`}
          style={{ fg: toneColor(theme, line.tone) }}
        />
      ))}
      {view.error === null ? null : (
        <text wrapMode="word" content={view.error} style={{ fg: theme.palette.composerStop }} />
      )}
    </box>
  );
});
