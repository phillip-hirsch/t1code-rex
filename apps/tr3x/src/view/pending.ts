import type { MessageId, RuntimeRequestId } from "@t3tools/contracts";

import type { CommandResult } from "./connection.ts";
import type { Answer, QuestionDraft } from "./requests.ts";

const NO_ANSWERS: ReadonlyMap<string, Answer> = new Map();

/**
 * Work the server hasn't reflected yet. Key handlers read it synchronously,
 * since keys can arrive faster than React renders.
 */
export class PendingWork {
  private launching: Promise<CommandResult> | null = null;
  private switching = false;
  private sends = 0;
  private readonly unseen = new Set<MessageId>();
  private readonly answering = new Set<RuntimeRequestId>();
  private readonly answered = new Set<RuntimeRequestId>();
  private readonly answers = new Map<RuntimeRequestId, Map<string, Answer>>();
  private readonly armedApprovals = new Set<RuntimeRequestId>();
  private readonly drafts = new Map<string, QuestionDraft>();

  private launched: boolean;

  constructor(launched: boolean) {
    this.launched = launched;
  }

  /** Whether the thread exists on the server: it did already, or a launch succeeded. */
  get isLaunched(): boolean {
    return this.launched;
  }

  /**
   * Launches the thread with `start`, once: a call while a launch is in flight
   * waits for it and shares its result. `started` says whether this call launched.
   */
  async launch(
    start: () => Promise<CommandResult>,
  ): Promise<{ readonly result: CommandResult; readonly started: boolean }> {
    if (this.launching !== null) return { result: await this.launching, started: false };
    this.launching = start();
    const result = await this.launching;
    this.launching = null;
    if (result.ok) this.launched = true;
    return { result, started: true };
  }

  beginSwitch(): void {
    this.switching = true;
  }

  endSwitch(): void {
    this.switching = false;
  }

  beginSend(messageId: MessageId): void {
    this.sends += 1;
    this.unseen.add(messageId);
  }

  endSend(messageId: MessageId, ok: boolean): void {
    this.sends -= 1;
    if (!ok) this.unseen.delete(messageId);
  }

  /**
   * A run is on its way: a launch, send or switch is in flight, or a sent
   * message isn't in the thread yet. Once it is, its run (or the run it
   * steered) shows too, and the thread's own state takes over.
   */
  busy(messages: ReadonlyArray<{ readonly id: MessageId }>): boolean {
    for (const id of this.unseen) {
      if (messages.some((message) => message.id === id)) this.unseen.delete(id);
    }
    return this.launching !== null || this.switching || this.sends > 0 || this.unseen.size > 0;
  }

  /** The answers given so far to a request's questions, by question id. */
  answersTo(requestId: RuntimeRequestId): ReadonlyMap<string, Answer> {
    return this.answers.get(requestId) ?? NO_ANSWERS;
  }

  /** Records an answer at once, so the next key moves on to the next question. */
  recordAnswer(requestId: RuntimeRequestId, questionId: string, answer: Answer): void {
    const answers = this.answers.get(requestId) ?? new Map<string, Answer>();
    answers.set(questionId, answer);
    this.answers.set(requestId, answers);
  }

  /** What's picked or highlighted for a question, by `<requestId>:<questionId>`. */
  draftOf(key: string): QuestionDraft | undefined {
    return this.drafts.get(key);
  }

  /** Records a draft at once, so the next key builds on it rather than on the last render. */
  setDraft(key: string, draft: QuestionDraft): void {
    this.drafts.set(key, draft);
  }

  /** The approval has been on screen long enough that a key is meant for it. */
  armApproval(requestId: RuntimeRequestId): void {
    this.armedApprovals.add(requestId);
  }

  isApprovalArmed(requestId: RuntimeRequestId): boolean {
    return this.armedApprovals.has(requestId);
  }

  /** Starts answering, unless an answer to `requestId` is in flight or accepted. */
  beginAnswer(requestId: RuntimeRequestId): boolean {
    if (this.answering.has(requestId) || this.answered.has(requestId)) return false;
    this.answering.add(requestId);
    return true;
  }

  endAnswer(requestId: RuntimeRequestId, ok: boolean): void {
    this.answering.delete(requestId);
    if (ok) this.answered.add(requestId);
  }

  /** The server took the answer; the request clears with the next update. */
  isAnswered(requestId: RuntimeRequestId): boolean {
    return this.answered.has(requestId);
  }
}
