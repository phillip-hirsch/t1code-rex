// @effect-diagnostics globalDate:off globalTimers:off -- The TUI runs on Bun outside the Effect runtime.
import type { KeyEvent, PasteEvent } from "@opentui/core";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import { Composer, type ComposerHandle, type ComposerProps } from "./composer.tsx";
import type { ComposerSend } from "./composerSend.ts";
import type { ComposerSender } from "./composerSender.ts";
import { pickActiveRequest } from "./requestPanel.ts";
import type { RequestPanelStore } from "./requestPanelStore.ts";
import { RequestPanel, type RequestPanelHandle } from "./requestPanelView.tsx";
import {
  INITIAL_REQUEST_HOLD,
  requestHoldReleaseAt,
  updateRequestHold,
  type RequestHoldEvent,
  type RequestHoldState,
} from "./requestHold.ts";
import type { PendingRequest } from "./requestQueue.ts";
import { redirectSend } from "./requestRedirect.ts";
import type { RequestResponder } from "./requestResponder.ts";

/** Which of the dock's two parts has the keyboard. */
export type DockFocus = "composer" | "requests";

export interface ComposerDockHandle {
  /** Keys while the dock has focus; true when it used the key. */
  readonly handleKey: (key: KeyEvent) => boolean;
  /** Types text into the composer at its cursor, for keys typed while another pane had focus. */
  readonly insertText: (text: string) => void;
  /** Pastes into the composer, image rules included, for a paste while another pane had focus. */
  readonly paste: (event: PasteEvent) => void;
}

export interface ComposerDockRequests {
  readonly queue: ReadonlyArray<PendingRequest>;
  readonly store: RequestPanelStore;
  readonly responder: RequestResponder;
  /** Where the thread's commands run, shown under a command approval. */
  readonly cwd: string | null;
  /** The run Stop was last sent for. */
  readonly stopSentRunId: string | null;
  /** The footer's key hints while the panel has focus. */
  readonly onHints: (hints: string) => void;
}

export interface ComposerDockProps {
  /** The composer's own props, less what the dock owns. */
  readonly composer: Omit<ComposerProps, "ref" | "focused" | "onFocus" | "sender">;
  readonly sender: ComposerSender;
  /** Null where nothing can be pending, e.g. a new-thread draft. */
  readonly requests: ComposerDockRequests | null;
  /** Null while focus is elsewhere (the sidebar, the thread, a picker). */
  readonly focus: DockFocus | null;
  readonly onFocus: (focus: DockFocus) => void;
  /** Whether the request panel is in view, for the footer. */
  readonly onPanelShown: (shown: boolean) => void;
  readonly ref?: Ref<ComposerDockHandle>;
}

const NO_REQUESTS: ReadonlyArray<PendingRequest> = [];

/** Web's typing guard as React state: requests that arrived mid-typing stay out of view. */
function useRequestHold(requestIds: ReadonlyArray<string>, focused: boolean) {
  const requestsKey = requestIds.join("\n");
  const [snapshot, setSnapshot] = useState(() => ({
    requestsKey,
    focused,
    state: updateRequestHold(
      updateRequestHold(INITIAL_REQUEST_HOLD, { type: focused ? "focus" : "blur" }),
      { type: "requests", requestIds, now: Date.now() },
    ),
  }));
  // Derived during render, as web does, so a request that arrives mid-typing never shows.
  if (snapshot.requestsKey !== requestsKey || snapshot.focused !== focused) {
    setSnapshot((current) => ({
      requestsKey,
      focused,
      state: updateRequestHold(
        updateRequestHold(current.state, { type: focused ? "focus" : "blur" }),
        { type: "requests", requestIds, now: Date.now() },
      ),
    }));
  }
  const dispatch = useMemo(
    () => (event: RequestHoldEvent) =>
      setSnapshot((current) => {
        const state: RequestHoldState = updateRequestHold(current.state, event);
        return state === current.state ? current : { ...current, state };
      }),
    [],
  );
  const releaseAt = requestHoldReleaseAt(snapshot.state);
  useEffect(() => {
    if (releaseAt === null) return;
    const timer = setTimeout(() => dispatch({ type: "idle" }), Math.max(0, releaseAt - Date.now()));
    return () => clearTimeout(timer);
  }, [dispatch, releaseAt]);
  return { held: snapshot.state.held, dispatch };
}

/**
 * The composer, with pending approvals and questions in a panel above it. The composer
 * keeps focus and every key while a request is pending, so Enter still sends. Only Tab or a
 * click moves focus to the panel; Esc, Tab or another request moves it back.
 */
export function ComposerDock(props: ComposerDockProps) {
  const { composer, requests, focus, onFocus, onPanelShown, ref } = props;
  const threadId = composer.target.threadId;
  const queue = requests?.queue ?? NO_REQUESTS;
  const composerRef = useRef<ComposerHandle | null>(null);
  const panelRef = useRef<RequestPanelHandle | null>(null);

  const hold = useRequestHold(
    useMemo(() => queue.map((request) => request.requestId), [queue]),
    focus === "composer",
  );
  const shownQueue = useMemo(
    () =>
      hold.held.size === 0 ? queue : queue.filter((request) => !hold.held.has(request.requestId)),
    [queue, hold.held],
  );
  const shown = requests !== null && shownQueue.length > 0;

  useEffect(() => {
    onPanelShown(shown);
  }, [onPanelShown, shown]);
  useEffect(() => {
    if (!shown && focus === "requests") onFocus("composer");
  }, [focus, onFocus, shown]);

  // Read by a send when it happens, not when the sender was made.
  const live = useRef({ queue, shownQueue });
  useLayoutEffect(() => {
    live.current = { queue, shownQueue };
  });
  const { sender } = props;
  const panelStore = requests?.store ?? null;
  const responder = requests?.responder ?? null;
  const holdDispatch = hold.dispatch;
  const send = useCallback(
    (outgoing: ComposerSend): Promise<void> => {
      // Declines the approval on screen, if any, as a stage of this message's sender job.
      const routed =
        responder === null || panelStore === null
          ? outgoing
          : redirectSend(outgoing, {
              active: pickActiveRequest(
                live.current.shownQueue,
                panelStore.active(threadId),
                responder.status,
              ),
              statusOf: responder.status,
              queue: live.current.queue,
            });
      const sent = sender.send(routed);
      holdDispatch({ type: "send" });
      return sent;
    },
    [holdDispatch, panelStore, responder, sender, threadId],
  );
  const dockSender = useMemo((): ComposerSender => ({ ...sender, send }), [sender, send]);

  useImperativeHandle(ref, () => ({
    handleKey: (key: KeyEvent) => {
      if (focus === "requests" && shown) return panelRef.current?.handleKey(key) ?? false;
      if (focus !== "composer") return false;
      if (key.name !== "tab") hold.dispatch({ type: "type", now: Date.now() });
      if (composerRef.current?.handleKey(key)) return true;
      if (key.name === "tab" && shown && !key.shift && !key.ctrl && !key.meta) {
        // A held Tab's repeats must not flip focus back and forth.
        if (key.repeated) return true;
        onFocus("requests");
        panelRef.current?.enter();
        return true;
      }
      return false;
    },
    insertText: (text: string) => composerRef.current?.insertText(text),
    paste: (event: PasteEvent) => composerRef.current?.paste(event),
  }));

  return (
    <>
      {requests !== null && shown ? (
        <RequestPanel
          ref={panelRef}
          threadId={threadId}
          queue={shownQueue}
          store={requests.store}
          responder={requests.responder}
          theme={composer.theme}
          focused={focus === "requests"}
          cwd={requests.cwd}
          stopSentRunId={requests.stopSentRunId}
          running={composer.running}
          stopRequested={composer.stopRequested}
          onFocus={() => onFocus("requests")}
          onLeave={() => onFocus("composer")}
          onStop={composer.onStop}
          onExit={composer.onExit}
          onStatus={composer.onStatus}
          onHints={requests.onHints}
        />
      ) : null}
      <Composer
        {...composer}
        ref={composerRef}
        sender={dockSender}
        focused={focus === "composer"}
        onFocus={() => onFocus("composer")}
      />
    </>
  );
}
