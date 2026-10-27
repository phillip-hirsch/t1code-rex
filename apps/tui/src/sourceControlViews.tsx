import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useImperativeHandle, useRef, type Ref } from "react";

import type { TuiConnection } from "./connection/tuiConnection.ts";
import { describeError } from "./management.ts";
import { Modal } from "./managementViews.tsx";
import { describeSourceControl, type SourceControlTone } from "./sourceControlView.ts";
import type { TuiColor, TuiTheme } from "./theme.ts";

/** What the view reads; the TUI's connection, or fixed atoms in checks. */
export type SourceControlSource = Pick<
  TuiConnection,
  "sourceControlDiscoveryAtom" | "refreshSourceControlDiscovery"
>;

export interface SourceControlViewHandle {
  /** Keys while the view is open; it uses every one. */
  readonly handleKey: (key: KeyEvent) => void;
}

const VIEW_WIDTH = 96;

function toneColor(theme: TuiTheme, tone: SourceControlTone): TuiColor {
  if (tone === "success") return theme.palette.success;
  if (tone === "warning") return theme.palette.warning;
  return theme.palette.subtle;
}

/**
 * The server's version-control tools and hosting providers with their sign-in state, as web's
 * Settings → Source control lists them, from `server.discoverSourceControl`. `r` scans again.
 */
export function SourceControlView(props: {
  readonly source: SourceControlSource;
  readonly theme: TuiTheme;
  /** Rows the list may take before it scrolls. */
  readonly height: number;
  readonly onClose: () => void;
  readonly ref?: Ref<SourceControlViewHandle>;
}) {
  const { theme, source, height, onClose, ref } = props;
  const palette = theme.palette;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const result = useAtomValue(source.sourceControlDiscoveryAtom);
  const discovery = Option.getOrNull(AsyncResult.value(result));
  const scanning = result.waiting || AsyncResult.isInitial(result);
  const error = AsyncResult.isFailure(result) ? describeError(Cause.squash(result.cause)) : null;
  const sections = discovery === null ? [] : describeSourceControl(discovery);

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      const scrollbox = scrollRef.current;
      const page = Math.max(1, (scrollbox?.viewport.height ?? height) - 2);
      if (key.name === "escape" || (key.ctrl && key.name === "c")) onClose();
      else if (key.name === "r" && !key.ctrl && !key.meta) source.refreshSourceControlDiscovery();
      else if (key.name === "up" || key.name === "k") scrollbox?.scrollBy(-1);
      else if (key.name === "down" || key.name === "j") scrollbox?.scrollBy(1);
      else if (key.name === "pageup") scrollbox?.scrollBy(-page);
      else if (key.name === "pagedown" || key.name === "space") scrollbox?.scrollBy(page);
    },
  }));

  return (
    <Modal theme={theme} borderColor={palette.accent} onDismiss={onClose} width={VIEW_WIDTH}>
      <box style={{ flexDirection: "row", height: 1, marginTop: 1 }}>
        <text wrapMode="none" content="Source Control" style={{ fg: palette.text, flexGrow: 1 }} />
        <text
          wrapMode="none"
          content={scanning ? (discovery === null ? "Scanning…" : "Refreshing…") : "r refresh"}
          style={{ fg: palette.subtle }}
        />
      </box>
      <text
        wrapMode="word"
        content="What this server can use for git and hosted repositories. Sign-in happens on the server host."
        style={{ fg: palette.subtle, marginBottom: 1 }}
      />
      {error === null ? null : (
        <text
          wrapMode="word"
          content={`󰀦 Couldn't scan the server: ${error}`}
          style={{ fg: palette.warning }}
        />
      )}
      <scrollbox
        ref={scrollRef}
        focusable={false}
        style={{ height: Math.max(4, height), flexShrink: 1 }}
      >
        {discovery === null && error === null ? (
          <text content="Scanning git and hosting providers…" style={{ fg: palette.muted }} />
        ) : null}
        {sections.map((section) => (
          <box key={section.title} style={{ flexDirection: "column", marginBottom: 1 }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              <text
                wrapMode="none"
                content={section.title}
                style={{ fg: palette.accent, flexGrow: 1 }}
              />
              <text wrapMode="none" content={section.count} style={{ fg: palette.subtle }} />
            </box>
            {section.rows.length === 0 ? (
              <text content="Nothing found on this server." style={{ fg: palette.muted }} />
            ) : null}
            {section.rows.map((row) => (
              <box key={row.key} style={{ flexDirection: "column", marginTop: 1, paddingLeft: 1 }}>
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text wrapMode="none" content="● " style={{ fg: toneColor(theme, row.tone) }} />
                  <text wrapMode="none" content={row.label} style={{ fg: palette.text }} />
                  {row.version === null ? null : (
                    <text
                      wrapMode="none"
                      truncate
                      content={`  ${row.version}`}
                      style={{ fg: palette.subtle, flexShrink: 1 }}
                    />
                  )}
                  {row.badge === null ? null : (
                    <text
                      wrapMode="none"
                      content={`  ${row.badge}`}
                      style={{ fg: row.tone === "muted" ? palette.subtle : palette.warning }}
                    />
                  )}
                </box>
                <text
                  wrapMode="word"
                  content={row.summary}
                  style={{ fg: palette.muted, paddingLeft: 2 }}
                />
                {row.details.map((line) => (
                  <text
                    key={line}
                    wrapMode="word"
                    content={line}
                    style={{ fg: palette.subtle, paddingLeft: 2 }}
                  />
                ))}
              </box>
            ))}
          </box>
        ))}
      </scrollbox>
      <text
        wrapMode="none"
        truncate
        content="↑↓ scroll  r refresh  esc close"
        style={{ fg: palette.subtle, marginTop: 1, marginBottom: 1 }}
      />
    </Modal>
  );
}
