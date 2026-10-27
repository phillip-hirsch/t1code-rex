import { describe, expect, it } from "vite-plus/test";

import { resolveQueueKey } from "./queueKeys.ts";

const key = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  sequence: name.length === 1 ? name : "",
  ...fields,
});

describe("resolveQueueKey", () => {
  it("selects with arrows and j/k, and moves the message with Shift", () => {
    expect(resolveQueueKey(key("up"), false)).toEqual({ type: "select", delta: -1 });
    expect(resolveQueueKey(key("j"), false)).toEqual({ type: "select", delta: 1 });
    expect(resolveQueueKey(key("up", { shift: true }), false)).toEqual({ type: "move", delta: -1 });
    expect(resolveQueueKey(key("j", { shift: true, sequence: "J" }), false)).toEqual({
      type: "move",
      delta: 1,
    });
  });

  it("edits on Enter or e, sends on s, removes on x, Delete or Backspace", () => {
    expect(resolveQueueKey(key("return"), false)).toEqual({ type: "edit" });
    expect(resolveQueueKey(key("e"), false)).toEqual({ type: "edit" });
    expect(resolveQueueKey(key("s"), false)).toEqual({ type: "send" });
    for (const name of ["x", "delete", "backspace"]) {
      expect(resolveQueueKey(key(name), false)).toEqual({ type: "remove" });
    }
  });

  it("leaves on Esc, leaves Tab and Ctrl keys to the shell, and types anything else", () => {
    expect(resolveQueueKey(key("escape"), false)).toEqual({ type: "leave" });
    expect(resolveQueueKey(key("tab"), false)).toBeNull();
    expect(resolveQueueKey(key("c", { ctrl: true }), false)).toBeNull();
    expect(resolveQueueKey(key("h"), false)).toEqual({ type: "type", text: "h" });
    expect(resolveQueueKey(key("s", { shift: true, sequence: "S" }), false)).toEqual({
      type: "type",
      text: "S",
    });
    expect(resolveQueueKey(key("g", { sequence: "G", shift: true }), false)).toEqual({
      type: "type",
      text: "G",
    });
  });

  it("while editing, saves on Enter, cancels on Esc or Ctrl+C, and leaves the rest to the editor", () => {
    expect(resolveQueueKey(key("return"), true)).toEqual({ type: "save" });
    expect(resolveQueueKey(key("return", { shift: true }), true)).toBeNull();
    expect(resolveQueueKey(key("linefeed"), true)).toBeNull();
    expect(resolveQueueKey(key("escape"), true)).toEqual({ type: "cancel-edit" });
    expect(resolveQueueKey(key("c", { ctrl: true }), true)).toEqual({ type: "cancel-edit" });
    expect(resolveQueueKey(key("x"), true)).toBeNull();
    expect(resolveQueueKey(key("up"), true)).toBeNull();
  });
});
