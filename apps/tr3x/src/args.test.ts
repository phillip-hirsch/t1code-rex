import { describe, expect, it } from "vite-plus/test";

import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("reads each command and refuses anything else", () => {
    expect(parseArgs(["daemon"], "/w")).toEqual({ kind: "daemon" });
    expect(parseArgs(["view", "thread-1"], "/w")).toEqual({ kind: "view", threadId: "thread-1" });
    expect(parseArgs(["view", "--new"], "/w")).toEqual({ kind: "new", cwd: "/w" });
    expect(parseArgs(["view", "--new", "--cwd", "/repo"], "/w")).toEqual({
      kind: "new",
      cwd: "/repo",
    });
    expect(parseArgs(["view"], "/w")).toBeNull();
    expect(parseArgs(["view", "--cwd", "/repo"], "/w")).toBeNull();
    expect(parseArgs(["view", "a", "b"], "/w")).toBeNull();
    expect(parseArgs(["doctor", "--verbose"], "/w")).toBeNull();
  });
});
