import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { DEFAULT_THREAD_TITLE } from "./threadTitle.ts";
import type { TuiTheme } from "./theme.ts";

/** A new-thread draft: no thread on the server yet; the first send launches it. */
export function NewThreadView(props: {
  readonly project: OrchestrationProjectShell | null;
  readonly theme: TuiTheme;
}) {
  const palette = props.theme.palette;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
        <text
          wrapMode="none"
          truncate
          content={DEFAULT_THREAD_TITLE}
          style={{ fg: palette.text }}
        />
        <text
          wrapMode="none"
          truncate
          content={`${props.project?.title ?? "Unknown project"}  ·  draft`}
          style={{ fg: palette.muted }}
        />
      </box>
      <box style={{ flexGrow: 1 }}>
        <text
          content="Send a message to start this thread. Pick a model with ⌘⇧M or /model."
          style={{ fg: palette.subtle }}
        />
      </box>
    </box>
  );
}
