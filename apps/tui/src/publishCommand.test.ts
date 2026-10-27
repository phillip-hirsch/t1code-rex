import {
  SourceControlRepositoryError,
  type SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import { SourceControlProviderKind, type VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { vcsStatus } from "./gitTestFixtures.ts";
import {
  defaultPublishProvider,
  describePublishConfirmation,
  describePublishFailure,
  describePublishResult,
  parsePublishArgs,
  publishBlockedReason,
  publishReadiness,
  repositoryPathError,
  resolvePublish,
  type PublishArgs,
} from "./publishCommand.ts";
import { discoveryResult, providerAuth, providerDiscovery } from "./sourceControlTestFixtures.ts";

const NO_REMOTE = vcsStatus({ refName: "main", hasPrimaryRemote: false, hasUpstream: false });

function args(text: string): PublishArgs {
  const parsed = parsePublishArgs(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("parsePublishArgs", () => {
  it("defaults to private, SSH and origin, as web and the old TUI did", () => {
    expect(args("octo/app")).toEqual({
      repository: "octo/app",
      provider: null,
      visibility: "private",
      protocol: "ssh",
      remoteName: "origin",
    });
  });

  it("reads visibility, protocol, remote and provider in any order", () => {
    expect(args("PUBLIC https remote=upstream octo/app provider=gh")).toEqual({
      repository: "octo/app",
      provider: "github",
      visibility: "public",
      protocol: "https",
      remoteName: "upstream",
    });
  });

  it("takes the old TUI's bare provider names", () => {
    expect(args("glab group/app").provider).toBe("gitlab");
    expect(args("bb ws/app").provider).toBe("bitbucket");
    expect(args("azure-devops proj/app").provider).toBe("azure-devops");
  });

  it("takes a lone word as the repository, for validation to ask for its owner", () => {
    expect(args("demo public").repository).toBe("demo");
  });

  it("leaves the repository out when only options were typed", () => {
    expect(args("public").repository).toBeNull();
    expect(args("").repository).toBeNull();
  });

  it("rejects what it doesn't know instead of dropping it", () => {
    expect(parsePublishArgs("octo/app privat")).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown option "privat"'),
    });
    expect(parsePublishArgs("octo/app provider=sourceforge")).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown provider "sourceforge"'),
    });
    expect(parsePublishArgs("privat octo/app")).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown option "privat"'),
    });
    expect(parsePublishArgs("octo/a octo/b")).toEqual({
      ok: false,
      error: "One repository at a time: octo/a or octo/b?",
    });
  });

  it("rejects remote names git wouldn't take", () => {
    for (const name of ["", "-x", "a b", "x.lock", "a/b"]) {
      expect(parsePublishArgs(`octo/app remote=${name}`).ok).toBe(false);
    }
  });
});

describe("repositoryPathError", () => {
  it("wants owner/name, in the host's own words", () => {
    expect(repositoryPathError("app", "github")).toBe("Name the repository as owner/repo");
    expect(repositoryPathError("octo/", "github")).toBe("Name the repository as owner/repo");
    expect(repositoryPathError("ws/app", "bitbucket")).toBeNull();
  });

  it("lets only GitLab nest groups", () => {
    expect(repositoryPathError("group/sub/app", "gitlab")).toBeNull();
    expect(repositoryPathError("a/b/c", "github")).toBe("Name the repository as owner/repo");
  });

  it("rejects characters hosts refuse", () => {
    expect(repositoryPathError("octo/my app", "github")).toContain('"my app"');
    expect(repositoryPathError("octo/..", "github")).toContain('".."');
    expect(repositoryPathError("octo/app.v2_x-y", "github")).toBeNull();
  });
});

describe("publishReadiness", () => {
  it("passes a signed-in provider, and one whose sign-in can't be read, as web does", () => {
    expect(publishReadiness(providerDiscovery("github", "GitHub"), "github").ready).toBe(true);
    const unknown = providerDiscovery("bitbucket", "Bitbucket", {
      auth: providerAuth({ status: "unknown" }),
    });
    expect(publishReadiness(unknown, "bitbucket").ready).toBe(true);
  });

  it("says why a provider can't take it", () => {
    expect(publishReadiness(undefined, "github")).toEqual({
      ready: false,
      hint: "This server didn't report GitHub. Open Source Control (⌘K) and refresh.",
    });
    const missing = providerDiscovery("gitlab", "GitLab", {
      status: "missing",
      installHint: "Install glab.",
    });
    expect(publishReadiness(missing, "gitlab").hint).toBe("GitLab isn't installed: Install glab.");
    const signedOut = providerDiscovery("github", "GitHub", {
      auth: providerAuth({ status: "unauthenticated", detail: "Run gh auth login." }),
    });
    expect(publishReadiness(signedOut, "github").hint).toBe(
      "GitHub isn't signed in: Run gh auth login.",
    );
  });
});

describe("defaultPublishProvider", () => {
  it("picks the first ready provider by label", () => {
    const result = discoveryResult([
      providerDiscovery("gitlab", "GitLab"),
      providerDiscovery("bitbucket", "Bitbucket"),
      providerDiscovery("github", "GitHub", { auth: providerAuth({ status: "unauthenticated" }) }),
    ]);
    expect(defaultPublishProvider(result)?.kind).toBe("bitbucket");
  });

  it("is null when nothing is ready", () => {
    expect(defaultPublishProvider(discoveryResult([]))).toBeNull();
  });

  it("passes over a host that may not keep the visibility while another is ready", () => {
    const result = discoveryResult([
      providerDiscovery("azure-devops", "Azure DevOps"),
      providerDiscovery("gitlab", "GitLab"),
    ]);
    expect(defaultPublishProvider(result)?.kind).toBe("gitlab");
  });
});

describe("publishBlockedReason", () => {
  // Per each provider's createRepository on the server: the visibility is sent to the host
  // (GitHub and Forgejo `private`, GitLab and GitCafe `visibility`, Bitbucket `is_private`);
  // `az repos create` has no visibility flag.
  it.each(["github", "gitlab", "bitbucket", "forgejo", "gitcafe"])(
    "publishes to %s, which keeps the visibility asked for",
    (kind) => {
      expect(publishBlockedReason(kind, "private")).toBeNull();
      expect(publishBlockedReason(kind, "public")).toBeNull();
    },
  );

  it("blocks Azure DevOps, where the project sets visibility", () => {
    expect(publishBlockedReason("azure-devops", "private")).toBe(
      "Azure DevOps sets visibility per project; tr3x can't confirm this repository will be private. Publish it from Azure DevOps.",
    );
  });

  it("blocks a host it doesn't know", () => {
    expect(publishBlockedReason("someday", "private")).toContain(
      "tr3x can't confirm this repository will be private",
    );
  });
});

describe("resolvePublish", () => {
  const resolve = (
    text: string,
    status = NO_REMOTE,
    discovery = discoveryResult(),
    remoteRefs: ReadonlyArray<VcsRef> = [],
  ) => resolvePublish({ args: args(text), cwd: "/repo", status, remoteRefs, discovery });

  it("plans a publish to the first ready provider", () => {
    expect(resolve("sandbox/demo")).toEqual({
      kind: "plan",
      plan: {
        input: {
          cwd: "/repo",
          provider: SourceControlProviderKind.make("bitbucket"),
          repository: "sandbox/demo",
          visibility: "private",
          remoteName: "origin",
          protocol: "ssh",
        },
        providerLabel: "Bitbucket",
        location: "bitbucket.org/sandbox/demo",
        branch: "main",
      },
    });
  });

  it("names a signed-out provider and how to sign in", () => {
    expect(resolve("octo/app provider=github")).toEqual({
      kind: "error",
      message:
        "GitHub isn't signed in: You are not logged into any GitHub hosts. To log in, run: gh auth login",
    });
  });

  it("names a provider that isn't installed", () => {
    expect(resolve("group/app gitlab")).toEqual({
      kind: "error",
      message: "GitLab isn't installed: Install the GitLab CLI (glab).",
    });
  });

  it("says when no provider is ready at all", () => {
    const none = discoveryResult([
      providerDiscovery("github", "GitHub", { auth: providerAuth({ status: "unauthenticated" }) }),
    ]);
    expect(resolve("octo/app", NO_REMOTE, none)).toEqual({
      kind: "error",
      message:
        "No source control provider is signed in on the server. Open Source Control (⌘K) to set one up.",
    });
  });

  it("is only for a repository without a remote", () => {
    expect(resolve("sandbox/demo", vcsStatus({ hasPrimaryRemote: true }))).toEqual({
      kind: "error",
      message:
        'This repository already has a remote ("origin"). Push from the git menu (c) instead.',
    });
    expect(resolve("sandbox/demo", vcsStatus({ isRepo: false })).kind).toBe("error");
  });

  it("sees a remote that isn't origin", () => {
    const upstream: VcsRef = {
      name: "upstream/main",
      isRemote: true,
      remoteName: "upstream",
      current: false,
      isDefault: false,
      worktreePath: null,
    };
    expect(resolve("sandbox/demo remote=hub", NO_REMOTE, discoveryResult(), [upstream])).toEqual({
      kind: "error",
      message:
        'This repository already has a remote ("upstream"). Push from the git menu (c) instead.',
    });
    // An upstream or a host the server read off a remote shows one too, though unnamed.
    expect(resolve("sandbox/demo", { ...NO_REMOTE, hasUpstream: true })).toEqual({
      kind: "error",
      message: "This repository already has a remote. Push from the git menu (c) instead.",
    });
  });

  it("won't plan a publish to Azure DevOps, named or not", () => {
    const azure = discoveryResult([providerDiscovery("azure-devops", "Azure DevOps")]);
    const blocked = {
      kind: "error",
      message:
        "Azure DevOps sets visibility per project; tr3x can't confirm this repository will be private. Publish it from Azure DevOps.",
    };
    expect(resolve("org/demo", NO_REMOTE, azure)).toEqual(blocked);
    expect(resolve("org/demo azure", NO_REMOTE, azure)).toEqual(blocked);
    expect(resolve("az", NO_REMOTE, azure)).toEqual(blocked);
    // Named, it's blocked before readiness: no point setting it up first.
    expect(resolve("org/demo provider=azure-devops")).toEqual(blocked);
  });

  it("checks the path against the chosen host", () => {
    expect(resolve("demo")).toEqual({
      kind: "error",
      message: "Name the repository as workspace/repository",
    });
  });

  it("asks for a repository with the account filled in", () => {
    expect(resolve("public")).toEqual({
      kind: "prefill",
      text: "/publish sandbox/",
      hint: expect.stringContaining("workspace/repository"),
    });
    expect(resolve("provider=bitbucket")).toMatchObject({
      kind: "prefill",
      text: "/publish sandbox/ provider=bitbucket",
    });
  });
});

describe("describePublishConfirmation", () => {
  const plan = (text: string, branch: string | null = "main") => {
    const resolved = resolvePublish({
      args: args(text),
      cwd: "/repo",
      status: { ...NO_REMOTE, refName: branch },
      remoteRefs: [],
      discovery: discoveryResult(),
    });
    if (resolved.kind !== "plan") throw new Error(resolved.kind);
    return resolved.plan;
  };

  it("names the repository, its visibility, the remote and the branch", () => {
    expect(describePublishConfirmation(plan("sandbox/demo"))).toEqual([
      "Creates a private Bitbucket repository:",
      "  bitbucket.org/sandbox/demo",
      'Adds it as remote "origin" (SSH) and pushes main.',
    ]);
  });

  it("calls out a public repository", () => {
    expect(describePublishConfirmation(plan("sandbox/demo public https remote=hub", null))).toEqual(
      [
        "Creates a PUBLIC Bitbucket repository anyone can see:",
        "  bitbucket.org/sandbox/demo",
        'Adds it as remote "hub" (HTTPS).',
      ],
    );
  });
});

describe("describePublishResult", () => {
  const result = (status: SourceControlPublishRepositoryResult["status"]) => ({
    repository: {
      provider: SourceControlProviderKind.make("bitbucket"),
      nameWithOwner: "sandbox/demo",
      url: "https://bitbucket.org/sandbox/demo",
      sshUrl: "git@bitbucket.org:sandbox/demo.git",
    },
    remoteName: "origin",
    remoteUrl: "git@bitbucket.org:sandbox/demo.git",
    branch: "main",
    status,
  });

  it("names the repository, branch and remote", () => {
    expect(describePublishResult(result("pushed"), "Bitbucket")).toBe(
      "Published sandbox/demo on Bitbucket · main → origin",
    );
    expect(describePublishResult(result("remote_added"), "Bitbucket")).toBe(
      "Created sandbox/demo on Bitbucket · remote origin added; commit, then push",
    );
  });
});

describe("describePublishFailure", () => {
  it("shows the server's detail without its preamble", () => {
    const error = new SourceControlRepositoryError({
      provider: SourceControlProviderKind.make("github"),
      operation: "publishRepository",
      detail: "Choose a source control provider before continuing.",
    });
    expect(describePublishFailure(error)).toBe(
      "Choose a source control provider before continuing.",
    );
    expect(describePublishFailure(new Error("socket closed"))).toBe("socket closed");
    expect(describePublishFailure(null)).toBe("Publish failed.");
  });
});
