// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the real composer under OpenTUI's renderer, which needs Bun (Vitest runs on Node).
 * Keys reach it the way ui.tsx routes them: the shell's keyboard hook calls its handle.
 *
 *   bun apps/tui/scripts/check-composer.tsx
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, createRef, type RefObject } from "react";

import { Composer, type ComposerHandle } from "../src/composer.tsx";
import { createComposerSender } from "../src/composerSender.ts";
import type { ComposerSettings } from "../src/composerSettings.ts";
import { createComposerStore } from "../src/composerStore.ts";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (want ${String(expected)})`}`,
  );
}

async function settle(render: () => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await render();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settings: ComposerSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const threadId = ThreadId.make("t1");

function Harness(props: {
  readonly composer: RefObject<ComposerHandle | null>;
  readonly children: React.ReactNode;
}) {
  useKeyboard((key: KeyEvent) => {
    if (props.composer.current?.handleKey(key)) key.preventDefault();
  });
  return <>{props.children}</>;
}

/** A composer on a running thread, with text and one image, as two quick Enters find it. */
async function checkDoubleEnter(): Promise<void> {
  const store = createComposerStore({ initialPrefs: {}, persist: null });
  store.setDraftText(threadId, "What color is this?");
  store.addAttachment(threadId, {
    id: "img-1",
    type: "image",
    name: "red.png",
    mimeType: "image/png",
    sizeBytes: 68,
    dataUrl: "data:image/png;base64,AAAA",
  });
  const sent: Array<StartThreadTurnInput> = [];
  const sender = createComposerSender({
    store,
    startTurn: (input) => {
      sent.push(input);
      return Promise.resolve({ ok: true });
    },
    setRuntimeMode: () => Promise.resolve({ ok: true }),
    setInteractionMode: () => Promise.resolve({ ok: true }),
    threadSettings: () => settings,
    schedule: () => () => undefined,
  });
  let stops = 0;
  const composer = createRef<ComposerHandle>();
  const setup = await testRender(
    <Harness composer={composer}>
      <Composer
        ref={composer}
        target={{ kind: "thread", threadId, projectId: ProjectId.make("p") }}
        store={store}
        sender={sender}
        theme={DEFAULT_TUI_THEME}
        focused
        baseSettings={settings}
        modelLabel={() => "Claude Haiku 5.5"}
        providerBadge={() => ({ icon: "✱", color: "#ffffff" })}
        running
        stopRequested={false}
        clipboardDir="/tmp"
        onFocus={() => undefined}
        onStop={() => {
          stops += 1;
        }}
        onExit={() => undefined}
        onNewThread={() => undefined}
        onOpenModelPicker={() => undefined}
        onSetInteractionMode={() => undefined}
        onSetRuntimeMode={() => undefined}
        onStatus={() => undefined}
      />
    </Harness>,
    { width: 70, height: 12 },
  );
  await settle(setup.renderOnce);
  // Both Enters land before React renders again.
  act(() => {
    setup.mockInput.pressEnter();
    setup.mockInput.pressEnter();
  });
  await settle(setup.renderOnce);
  check("S2: two quick Enters send one message", sent.length, 1);
  check("S2: the message carries its image once", sent[0]?.message.attachments.length, 1);
  check(
    "S2: no second message, empty or not",
    sent.filter((input) => input.message.attachments.length > 0).length,
    1,
  );
  check("S2: the second Enter doesn't stop the run", stops, 0);
  check("S2: the composer is empty after", store.getDraft(threadId).attachments.length, 0);

  // Control: Enter on a composer that showed empty during a run still stops it.
  act(() => setup.mockInput.pressEnter());
  await settle(setup.renderOnce);
  check("S2 control: Enter on an empty composer stops the run", stops, 1);
  setup.renderer.destroy();
  sender.dispose();
}

await checkDoubleEnter();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
