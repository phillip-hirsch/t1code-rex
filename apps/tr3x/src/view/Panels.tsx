import type { PanelPlan, Tone } from "./panelLines.ts";
import { palette } from "./theme.ts";

const TONES: Record<Tone, string> = {
  text: palette.text,
  warning: palette.warning,
  accent: palette.accent,
  muted: palette.muted,
  subtle: palette.subtle,
};

/** A panel exactly `rows` tall, its lines already cut to fit, so nothing overflows or wraps. */
export function Panel(props: {
  readonly plan: PanelPlan;
  readonly rows: number;
  readonly color: string;
}) {
  // Borders alone say nothing.
  if (props.rows < 3) return null;
  return (
    <box
      border
      borderColor={props.color}
      // oxlint-disable-next-line t3code/no-native-title-tooltip -- OpenTUI's border title.
      title={props.plan.title}
      titleColor={props.color}
      bottomTitle={props.plan.hint}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: props.rows,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {props.plan.lines(props.rows).map((line) => (
        <text key={line.key} content={line.text || " "} fg={TONES[line.tone]} wrapMode="none" />
      ))}
    </box>
  );
}

/** Lines already wrapped to the screen, so none wraps again. */
export function Lines(props: { readonly lines: ReadonlyArray<string>; readonly color: string }) {
  if (props.lines.length === 0) return null;
  return (
    <box style={{ paddingLeft: 1, flexShrink: 0 }}>
      <text content={props.lines.join("\n")} fg={props.color} wrapMode="none" />
    </box>
  );
}

/** Key hints, one per item, wrapping as a whole hint when the line is full. */
export function Footer({ hints }: { readonly hints: ReadonlyArray<string> }) {
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, paddingLeft: 1 }}>
      {hints.map((hint) => (
        <text key={hint} content={hint} fg={palette.subtle} style={{ marginRight: 2 }} />
      ))}
    </box>
  );
}
