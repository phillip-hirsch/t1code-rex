import { describe, expect, it } from "vite-plus/test";

import { mentionQueryAt, mentionReplacement } from "./composerMentions.ts";

describe("@ mentions", () => {
  it("finds the @query the cursor ends", () => {
    expect(mentionQueryAt("look at @src/ma", 15)).toEqual({ query: "src/ma", length: 7 });
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", length: 1 });
    expect(mentionQueryAt("look at @src/ma now", 19)).toBeNull();
    expect(mentionQueryAt("mail me@example.com", 19)).toBeNull();
  });

  it("inserts a markdown file link, as web does", () => {
    expect(mentionReplacement("src/main.ts")).toBe("[main.ts](src/main.ts) ");
    expect(mentionReplacement("docs/a b(1).md")).toBe("[a b(1).md](docs/a%20b%281%29.md) ");
  });
});
