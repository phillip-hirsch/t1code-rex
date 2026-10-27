import { describe, expect, it } from "vite-plus/test";

import {
  matchSlashCommands,
  resolveComposerSlashAction,
  slashMenuQuery,
} from "./composerSlashCommands.ts";

describe("composer slash commands", () => {
  it("opens the menu only while the composer holds a bare command name", () => {
    expect(slashMenuQuery("/")).toBe("");
    expect(slashMenuQuery("/Pl")).toBe("pl");
    expect(slashMenuQuery("/plan now")).toBeNull();
    expect(slashMenuQuery("hello /plan")).toBeNull();
    expect(matchSlashCommands("pl").map((entry) => entry.command)).toEqual(["plan"]);
    expect(matchSlashCommands("").length).toBeGreaterThan(3);
  });

  it("maps the v2 commands to composer actions", () => {
    expect(resolveComposerSlashAction("/new")).toEqual({ type: "new-thread" });
    expect(resolveComposerSlashAction(" /model ")).toEqual({ type: "open-model-picker" });
    expect(resolveComposerSlashAction("/plan")).toEqual({
      type: "set-interaction-mode",
      mode: "plan",
    });
    expect(resolveComposerSlashAction("/default")).toEqual({
      type: "set-interaction-mode",
      mode: "default",
    });
    expect(resolveComposerSlashAction("/runtime")).toEqual({
      type: "set-runtime-mode",
      mode: "next",
    });
    expect(resolveComposerSlashAction("/runtime approval")).toEqual({
      type: "set-runtime-mode",
      mode: "approval-required",
    });
    expect(resolveComposerSlashAction("/runtime warp")).toEqual({
      type: "error",
      message: 'Unknown runtime mode "warp"',
    });
    expect(resolveComposerSlashAction("/steer use tabs\nnot spaces")).toEqual({
      type: "send",
      dispatch: "steer",
      text: "use tabs\nnot spaces",
    });
    expect(resolveComposerSlashAction("/resume")).toEqual({ type: "resume" });
    expect(resolveComposerSlashAction("/discard")).toEqual({ type: "discard" });
    expect(resolveComposerSlashAction("/queue")).toEqual({
      type: "error",
      message: "Type a message after /queue",
    });
  });

  it("sends anything else, provider commands included, as text", () => {
    expect(resolveComposerSlashAction("/compact")).toBeNull();
    expect(resolveComposerSlashAction("/goal ship it")).toBeNull();
    expect(resolveComposerSlashAction("plan this")).toBeNull();
  });
});

describe("/diff", () => {
  it("toggles the diff panel instead of reaching the agent", () => {
    expect(resolveComposerSlashAction("/diff")).toEqual({ type: "toggle-diff" });
  });
});

describe("/clone", () => {
  it("passes its arguments on, and needs a source", () => {
    expect(resolveComposerSlashAction("/clone octo/hello ~/src/hello")).toEqual({
      type: "clone",
      args: "octo/hello ~/src/hello",
    });
    expect(resolveComposerSlashAction("/clone")).toMatchObject({ type: "error" });
  });
});

describe("/git, /branch and /worktree", () => {
  it("open the git menu and branch picker, and flip a draft's env mode", () => {
    expect(resolveComposerSlashAction("/git")).toEqual({ type: "git-menu" });
    expect(resolveComposerSlashAction("/branch")).toEqual({ type: "branch-picker", query: "" });
    expect(resolveComposerSlashAction("/branch feat/x")).toEqual({
      type: "branch-picker",
      query: "feat/x",
    });
    expect(resolveComposerSlashAction("/worktree")).toEqual({ type: "toggle-worktree" });
    expect(resolveComposerSlashAction("/worktree retry")).toEqual({ type: "retry-worktree" });
    // Gone: the server can't resolve a failed worktree setup to the project checkout.
    expect(resolveComposerSlashAction("/worktree local")).toMatchObject({ type: "error" });
    expect(resolveComposerSlashAction("/worktree x")).toMatchObject({ type: "error" });
  });
});
