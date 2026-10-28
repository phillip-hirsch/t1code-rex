import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeError } from "../redact.ts";
import { issueLocalSession } from "./localSession.ts";

describe("issueLocalSession", () => {
  it("names the Node it couldn't run, in words redaction keeps", async () => {
    await expect(
      issueLocalSession({
        baseDir: "/nonexistent/tr3x-home",
        scopes: [AuthOrchestrationReadScope],
        ttl: "2m",
        label: "test",
        env: { TR3X_NODE_BIN: "/nonexistent/tr3x-node" },
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(describeError(error)).toBe(
        "Could not issue a session. /nonexistent/tr3x-node can't run (ENOENT). Set TR3X_NODE_BIN to a Node binary.",
      );
      return true;
    });
  });
});
