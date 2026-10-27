import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { describeSourceControl } from "./sourceControlView.ts";
import { discoveryResult, providerAuth, providerDiscovery } from "./sourceControlTestFixtures.ts";

describe("describeSourceControl", () => {
  const [vcs, providers] = describeSourceControl(discoveryResult());

  it("lists version control with what's ready and what's coming", () => {
    expect(vcs?.count).toBe("1/2 available");
    expect(vcs?.rows.map((row) => [row.label, row.tone, row.badge, row.summary])).toEqual([
      ["Git", "success", null, "Available"],
      ["Jujutsu", "muted", "Coming soon", "Support for Jujutsu is coming soon."],
    ]);
  });

  it("gives each provider its sign-in state, in web's words", () => {
    expect(providers?.count).toBe("1/3 signed in");
    expect(providers?.rows.map((row) => [row.label, row.tone, row.badge, row.summary])).toEqual([
      [
        "GitHub",
        "warning",
        "Not authenticated",
        "GitHub is not authenticated on this server. Sign in or configure credentials with the gh tool on the server host to enable change request features.",
      ],
      [
        "GitLab",
        "warning",
        "Not installed",
        "Not available on this server: Install the GitLab CLI (glab).",
      ],
      ["Bitbucket", "success", null, "Authenticated as sandbox on bitbucket.org"],
    ]);
  });

  it("shows how to sign GitHub in, as web's settings do, without running a login", () => {
    expect(providers?.rows[0]?.details).toEqual([
      "Sign in with `gh auth login` on the server host, then refresh (r).",
      "Or set GH_TOKEN on the server; give the token read and write access to pull requests and contents.",
      "New token: https://github.com/settings/personal-access-tokens/new",
    ]);
  });

  it("keeps a server hint that says more than the login command", () => {
    const [, rows] = describeSourceControl(
      discoveryResult([
        providerDiscovery("bitbucket", "Bitbucket", {
          auth: providerAuth({
            status: "unauthenticated",
            detail: "Set the T3CODE_BITBUCKET_* environment variables on the server.",
          }),
        }),
      ]),
    );
    expect(rows?.rows[0]?.summary).toBe("Available. Install the Bitbucket CLI.");
    expect(rows?.rows[0]?.details).toEqual([
      "Set the T3CODE_BITBUCKET_* environment variables on the server.",
    ]);
  });

  it("lists each account the server found for a host", () => {
    const [, rows] = describeSourceControl(
      discoveryResult([
        providerDiscovery("github", "GitHub", {
          version: Option.some("gh version 2.83.0"),
          auth: providerAuth({
            status: "authenticated",
            account: "octo",
            host: "github.com",
            accounts: [
              { host: "github.com", account: "octo", active: true, authenticated: true },
              {
                host: "ghe.example.com",
                account: "octo-work",
                active: false,
                authenticated: false,
                error: "token expired",
                environmentVariable: "GH_ENTERPRISE_TOKEN",
              },
            ],
          }),
        }),
      ]),
    );
    expect(rows?.rows[0]).toMatchObject({
      version: "gh version 2.83.0",
      badge: null,
      summary: "Authenticated as octo on github.com",
      details: [
        "● octo on github.com · signed in",
        "○ octo-work on ghe.example.com via GH_ENTERPRISE_TOKEN · token expired",
      ],
    });
  });
});

describe("probe errors", () => {
  it("leaves out a probe's raw error, as web does", () => {
    const [, rows] = describeSourceControl(
      discoveryResult([
        providerDiscovery("gitlab", "GitLab", {
          status: "missing",
          installHint: "Install glab.",
          detail: Option.some(
            "VCS process failed to spawn in source-control.discovery.probe: glab",
          ),
          auth: providerAuth({ status: "unknown" }),
        }),
      ]),
    );
    expect(rows?.rows[0]).toMatchObject({
      summary: "Not available on this server: Install glab.",
      details: [],
    });
  });
});
