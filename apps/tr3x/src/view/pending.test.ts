import { MessageId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CommandResult } from "./connection.ts";
import { PendingWork } from "./pending.ts";

describe("PendingWork", () => {
  it("launches once and shares the result with sends that arrive meanwhile", async () => {
    const pending = new PendingWork(false);
    let finish: (result: CommandResult) => void = () => {};
    let starts = 0;
    const start = () => {
      starts += 1;
      return new Promise<CommandResult>((resolve) => (finish = resolve));
    };
    const first = pending.launch(start);
    const second = pending.launch(start);
    expect(pending.busy([])).toBe(true);
    finish({ ok: true });
    expect(await first).toEqual({ result: { ok: true }, started: true });
    expect(await second).toEqual({ result: { ok: true }, started: false });
    expect(starts).toBe(1);
    expect(pending.isLaunched).toBe(true);
  });

  it("lets a failed launch be tried again", async () => {
    const pending = new PendingWork(false);
    expect((await pending.launch(async () => ({ ok: false, error: "no" }))).started).toBe(true);
    expect(pending.isLaunched).toBe(false);
    expect((await pending.launch(async () => ({ ok: true }))).started).toBe(true);
    expect(pending.isLaunched).toBe(true);
  });

  it("stays busy for a sent message until the thread shows it", () => {
    const pending = new PendingWork(true);
    const id = MessageId.make("m1");
    pending.beginSend(id);
    pending.endSend(id, true);
    expect(pending.busy([])).toBe(true);
    expect(pending.busy([{ id }])).toBe(false);

    const failed = MessageId.make("m2");
    pending.beginSend(failed);
    pending.endSend(failed, false);
    expect(pending.busy([])).toBe(false);
  });

  it("allows one answer per request in flight, and none once accepted", () => {
    const pending = new PendingWork(true);
    const request = RuntimeRequestId.make("r1");
    expect(pending.beginAnswer(request)).toBe(true);
    expect(pending.beginAnswer(request)).toBe(false);
    pending.endAnswer(request, false);
    expect(pending.beginAnswer(request)).toBe(true);
    pending.endAnswer(request, true);
    expect(pending.isAnswered(request)).toBe(true);
    expect(pending.beginAnswer(request)).toBe(false);
  });
});
