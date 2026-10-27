import {
  visibleModelPickerModels,
  type ModelPickerProvider,
  type ModelPickerState,
} from "./modelPicker.ts";
import type { TuiTheme } from "./theme.ts";

const MAX_VISIBLE_MODELS = 12;

/** The provider and model picker overlay; keys go through reduceModelPickerKey. */
export function ModelPickerView(props: {
  readonly providers: ReadonlyArray<ModelPickerProvider>;
  readonly state: ModelPickerState;
  readonly current: { readonly instanceId: string; readonly model: string } | null;
  readonly theme: TuiTheme;
  readonly onPick: (instanceId: ModelPickerProvider["instanceId"], model: string) => void;
}) {
  const { providers, state, theme } = props;
  const palette = theme.palette;
  const models = visibleModelPickerModels(providers, state);
  const start = Math.max(0, Math.min(state.index - MAX_VISIBLE_MODELS + 1, models.length));
  const shown = models.slice(start, start + MAX_VISIBLE_MODELS);
  const searching = state.query.length > 0;
  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: 4,
        right: 4,
        flexDirection: "column",
        backgroundColor: palette.popup,
        border: true,
        borderColor: palette.accent,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 250,
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text content="Model  " style={{ fg: palette.subtle }} />
        {searching ? (
          <text wrapMode="none" content={`Search: ${state.query}▏`} style={{ fg: palette.text }} />
        ) : (
          providers.map((provider) => (
            <text
              key={provider.instanceId}
              wrapMode="none"
              content={` ${provider.label} `}
              style={{
                fg: provider.instanceId === state.instanceId ? palette.text : palette.muted,
                bg: provider.instanceId === state.instanceId ? palette.selection : palette.popup,
                marginRight: 1,
              }}
            />
          ))
        )}
      </box>
      {providers.length === 0 ? (
        <text content="No providers are ready on this server." style={{ fg: palette.muted }} />
      ) : models.length === 0 ? (
        <text content="No models match." style={{ fg: palette.muted }} />
      ) : (
        shown.map((model, offset) => {
          const index = start + offset;
          const selected = index === state.index;
          const isCurrent =
            props.current?.instanceId === model.instanceId && props.current.model === model.slug;
          return (
            <box
              key={`${model.instanceId}:${model.slug}`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onPick(model.instanceId, model.slug);
              }}
              style={{
                flexDirection: "row",
                height: 1,
                backgroundColor: selected ? palette.selection : palette.popup,
              }}
            >
              <text content={isCurrent ? "● " : "  "} style={{ fg: palette.accent }} />
              <text wrapMode="none" content={model.label} style={{ fg: palette.text }} />
              <text
                wrapMode="none"
                truncate
                content={searching ? `  ${model.providerLabel} · ${model.slug}` : `  ${model.slug}`}
                style={{ fg: palette.subtle }}
              />
            </box>
          );
        })
      )}
      <text
        wrapMode="none"
        truncate
        content="←→ provider  ↑↓ move  ⏎ pick  type to search  esc close"
        style={{ fg: palette.subtle, marginTop: 1 }}
      />
    </box>
  );
}
