import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type { ViewApi } from "./connection.ts";
import { palette } from "./theme.ts";

/** What the view shows until its thread is ready; ctrl+c quits from the first frame. */
export function Startup(props: {
  readonly message: string;
  readonly connection: ViewApi | null;
  readonly onQuit: () => void;
}) {
  useKeyboard((key: KeyEvent) => {
    if (!key.ctrl || key.name !== "c") return;
    key.preventDefault();
    props.onQuit();
  });
  return (
    <box style={{ flexDirection: "column", paddingLeft: 1, paddingTop: 1 }}>
      <text content={props.message} fg={palette.muted} />
      {props.connection ? <RetryReason connection={props.connection} /> : null}
      <text content="^c quit" fg={palette.subtle} style={{ marginTop: 1 }} />
    </box>
  );
}

function RetryReason({ connection }: { readonly connection: ViewApi }) {
  const state = Option.getOrNull(AsyncResult.value(useAtomValue(connection.connectionStateAtom)));
  const detail = state?.lastFailure?.detail;
  return detail ? <text content={`Retrying: ${detail}`} fg={palette.warning} /> : null;
}
