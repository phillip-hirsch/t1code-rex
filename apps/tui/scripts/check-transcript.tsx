// @effect-diagnostics globalConsole:off globalTimers:off -- A Bun check script; it runs outside the Effect runtime.
/**
 * Checks the transcript against OpenTUI's real renderer, which needs Bun (Vitest runs on
 * Node). Each check also runs a control without the fix, so it proves the check can fail.
 *
 *   bun apps/tui/scripts/check-transcript.tsx
 */
import { getTreeSitterClient, type ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import {
  act,
  createRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";

import { MessageMarkdown, useMarkdownStyles } from "../src/messageMarkdownView.tsx";
import { DEFAULT_TUI_THEME } from "../src/theme.ts";
import { resolveScrollKey } from "../src/threadScroll.ts";
import { timelineRowId, useTranscriptScrollbox } from "../src/threadScrollbox.ts";
import { useSyncKeyboard } from "../src/syncKeyboard.ts";

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

interface Row {
  readonly key: string;
  readonly text: string;
}

interface TranscriptHandle {
  readonly setRows: (update: (rows: ReadonlyArray<Row>) => ReadonlyArray<Row>) => void;
  readonly setFocus: (area: "thread" | "sidebar") => void;
  readonly scrollbox: () => ScrollBoxRenderable;
}

/** Rows and the app's key handling as in ui.tsx: thread keys only while the thread has focus. */
function useTranscriptHarness(initial: ReadonlyArray<Row>, ref: Ref<TranscriptHandle>) {
  const [rows, setRows] = useState(initial);
  const [focus, setFocus] = useState<"thread" | "sidebar">("thread");
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  useImperativeHandle(ref, () => ({
    setRows,
    setFocus,
    scrollbox: () => {
      if (!scrollRef.current) throw new Error("not mounted");
      return scrollRef.current;
    },
  }));
  useSyncKeyboard((key) => {
    const scrollbox = scrollRef.current;
    if (focus !== "thread" || !scrollbox) return;
    const action = resolveScrollKey(key, scrollbox.viewport.height);
    if (action?.kind === "by") scrollbox.scrollBy(action.rows);
  });
  return { rows, rowKeys, scrollRef };
}

function TranscriptRows({
  rows,
  scrollRef,
}: {
  rows: ReadonlyArray<Row>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  return (
    <scrollbox ref={scrollRef} stickyScroll stickyStart="bottom" style={{ width: 40, height: 10 }}>
      {rows.map((row) => (
        <box key={row.key} id={timelineRowId(row.key)}>
          <text content={row.text} />
        </box>
      ))}
    </scrollbox>
  );
}

interface TranscriptProps {
  readonly initial: ReadonlyArray<Row>;
  readonly ref: Ref<TranscriptHandle>;
}

function WiredTranscript({ initial, ref }: TranscriptProps) {
  const { rows, rowKeys, scrollRef } = useTranscriptHarness(initial, ref);
  useTranscriptScrollbox(scrollRef, rowKeys, "");
  return <TranscriptRows rows={rows} scrollRef={scrollRef} />;
}

function PlainTranscript({ initial, ref }: TranscriptProps) {
  const { rows, scrollRef } = useTranscriptHarness(initial, ref);
  return <TranscriptRows rows={rows} scrollRef={scrollRef} />;
}

async function renderTranscript(wired: boolean, initial: ReadonlyArray<Row>) {
  const ref = createRef<TranscriptHandle>();
  const setup = await testRender(
    wired ? (
      <WiredTranscript initial={initial} ref={ref} />
    ) : (
      <PlainTranscript initial={initial} ref={ref} />
    ),
    { width: 60, height: 12 },
  );
  await settle(setup.renderOnce);
  if (!ref.current) throw new Error("not mounted");
  return { setup, transcript: ref.current, scrollbox: ref.current.scrollbox() };
}

function rowsFrom(first: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `r${first + index}`,
    text: `row ${first + index}`,
  }));
}

async function checkKeys(wired: boolean): Promise<void> {
  const name = wired ? "S1 fixed" : "S1 control";
  const { setup, transcript, scrollbox } = await renderTranscript(wired, rowsFrom(0, 50));
  const focused = () => setup.renderer.currentFocusedRenderable?.constructor.name ?? "none";

  // The scrollbar track, in its own column at the scrollbox's right edge. OpenTUI never
  // focuses on a scrollbar click, with or without the fix.
  const bar = scrollbox.verticalScrollBar;
  await act(() => setup.mockMouse.click(bar.x, bar.y + bar.height - 2));
  check(`${name}: focused after clicking the scrollbar`, focused(), "none");
  await settle(setup.renderOnce);
  let before = scrollbox.scrollTop;
  await act(() => setup.mockInput.pressArrow("up"));
  await settle(setup.renderOnce);
  check(`${name}: one ↑ after clicking the scrollbar moves`, before - scrollbox.scrollTop, 1);

  await act(() => setup.mockMouse.click(5, 5));
  check(
    `${name}: focused after clicking the transcript`,
    focused(),
    wired ? "none" : "ScrollBoxRenderable",
  );
  before = scrollbox.scrollTop;
  await act(() => setup.mockInput.pressArrow("up"));
  await settle(setup.renderOnce);
  check(
    `${name}: one ↑ after clicking the transcript moves`,
    before - scrollbox.scrollTop,
    wired ? 1 : 3,
  );

  act(() => transcript.setFocus("sidebar"));
  const sidebarStart = scrollbox.scrollTop;
  await act(() => setup.mockInput.pressArrow("down"));
  await act(() => setup.mockInput.pressKey("j"));
  await settle(setup.renderOnce);
  check(
    `${name}: sidebar ↓ and j scroll the transcript by`,
    scrollbox.scrollTop - sidebarStart,
    wired ? 0 : 4,
  );
  setup.renderer.destroy();
}

async function checkPrepend(wired: boolean): Promise<void> {
  const name = wired ? "S2 fixed" : "S2 control";
  const { setup, transcript, scrollbox } = await renderTranscript(wired, rowsFrom(10, 30));
  scrollbox.scrollTop = 5;
  await settle(setup.renderOnce);
  const firstVisible = () => setup.captureCharFrame().split("\n")[0]?.trim();
  check(`${name}: reading`, firstVisible(), "row 15");

  // A page of ten rows commits, then a streaming delta grows the last row, before OpenTUI
  // lays out either.
  act(() => transcript.setRows((rows) => [...rowsFrom(0, 10), ...rows]));
  act(() =>
    transcript.setRows((rows) =>
      rows.map((row, index) =>
        index === rows.length - 1 ? { ...row, text: `${row.text}\nstreamed\nmore` } : row,
      ),
    ),
  );
  await setup.renderOnce();
  check(`${name}: scrollTop after one layout`, scrollbox.scrollTop, wired ? 15 : 5);
  check(`${name}: still reading`, firstVisible(), wired ? "row 15" : "row 5");
  setup.renderer.destroy();
}

/** Sol round 2, N1: a few rows above the bottom isn't sticky, so a prepend must hold. */
async function checkPrependNearBottom(): Promise<void> {
  const { setup, transcript, scrollbox } = await renderTranscript(true, rowsFrom(10, 30));
  scrollbox.scrollTop = scrollbox.scrollHeight - scrollbox.viewport.height - 3;
  await settle(setup.renderOnce);
  const firstVisible = () => setup.captureCharFrame().split("\n")[0]?.trim();
  const reading = firstVisible();
  act(() => transcript.setRows((rows) => [...rowsFrom(0, 10), ...rows]));
  await setup.renderOnce();
  check("N1: three rows above the bottom, still reading after a prepend", firstVisible(), reading);
  setup.renderer.destroy();
}

let highlighted = 0;
/** Counts what tree-sitter highlights. A destroyed renderer replaces the shared client. */
function countHighlights(): void {
  const client = getTreeSitterClient();
  const highlightOnce = client.highlightOnce.bind(client);
  client.highlightOnce = (content, filetype) => {
    highlighted += content.length;
    return highlightOnce(content, filetype);
  };
  highlighted = 0;
}

interface ReplyHandle {
  readonly set: (content: string, streaming: boolean) => void;
}

function Reply({ coalesced, ref }: { coalesced: boolean; ref: Ref<ReplyHandle> }) {
  const [state, setState] = useState({ content: "", streaming: true });
  useImperativeHandle(ref, () => ({
    set: (content, streaming) => setState({ content, streaming }),
  }));
  const styles = useMarkdownStyles(DEFAULT_TUI_THEME);
  return (
    <box style={{ flexDirection: "column", width: 60 }}>
      {coalesced ? (
        // What the view rendered before: one markdown renderable for all the prose.
        <markdown
          content={state.content}
          syntaxStyle={styles.message}
          conceal
          streaming={state.streaming}
          style={{ width: "100%" }}
        />
      ) : (
        <MessageMarkdown content={state.content} styles={styles} streaming={state.streaming} />
      )}
      <text content="TIMESTAMP" />
    </box>
  );
}

const PARAGRAPHS = Array.from(
  { length: 12 },
  (_, index) => `Paragraph ${index + 1} has **some** words and \`code\`, about eighty chars.`,
);

async function renderReply(coalesced: boolean, height: number) {
  const ref = createRef<ReplyHandle>();
  const setup = await testRender(<Reply coalesced={coalesced} ref={ref} />, { width: 60, height });
  if (!ref.current) throw new Error("not mounted");
  return { setup, reply: ref.current };
}

async function checkStreaming(coalesced: boolean): Promise<string> {
  countHighlights();
  const { setup, reply } = await renderReply(coalesced, 60);
  let text = "";
  for (const paragraph of PARAGRAPHS) {
    text += `${text ? "\n\n" : ""}${paragraph}`;
    act(() => reply.set(text, true));
    await settle(setup.renderOnce);
  }
  act(() => reply.set(`${text}\n`, false));
  await settle(setup.renderOnce);
  const name = coalesced ? "S3 control (one block)" : "S3 fixed";
  console.log(`     ${name}: highlighted ${highlighted} chars for a ${text.length}-char reply`);
  if (!coalesced) {
    check(`${name}: highlighted at most the reply once`, highlighted <= text.length, true);
  } else {
    check(
      `${name}: highlighted more than four times the reply`,
      highlighted > 4 * text.length,
      true,
    );
  }
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

/** Sol round 2, N3: blank lines inside an HTML comment don't start a new block. */
async function checkComment(): Promise<void> {
  const { setup, reply } = await renderReply(false, 20);
  act(() => reply.set("<!--\nhello\n\n**literal**\n\n-->\n\nafter", false));
  await settle(setup.renderOnce);
  const frame = setup.captureCharFrame();
  check("N3: comment content stays literal", frame.includes("**literal**"), true);
  setup.renderer.destroy();
}

async function checkFence(): Promise<void> {
  const { setup, reply } = await renderReply(false, 30);
  const message =
    'Here is the program:\n\n```python\ndef hello():\n    print("hello")\n\nhello()\n```\n\nIt prints hello.\n';
  // Small deltas, so the fence is unfinished for most of the stream.
  for (let end = 4; end < message.length; end += 4) {
    act(() => reply.set(message.slice(0, end), true));
    await setup.renderOnce();
  }
  act(() => reply.set(message, false));
  await settle(setup.renderOnce);
  const lines = setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd());
  console.log(
    lines
      .slice(0, 12)
      .map((line) => `     | ${line}`)
      .join("\n"),
  );
  check("S3 fence: language label row", lines[2]?.trim(), "python");
  check("S3 fence: closing paragraph", lines[lines.indexOf("TIMESTAMP") - 1], "It prints hello.");
  setup.renderer.destroy();
}

await checkKeys(false);
await checkKeys(true);
await checkPrepend(false);
await checkPrepend(true);
await checkPrependNearBottom();
const before = await checkStreaming(true);
const after = await checkStreaming(false);
check("S3: same rendered frame as one block", after === before, true);
const afterLines = after.split("\n").map((line) => line.trimEnd());
check(
  "S3: no blank row before the timestamp",
  afterLines[afterLines.indexOf("TIMESTAMP") - 1]?.length !== 0,
  true,
);
await checkFence();
await checkComment();

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
