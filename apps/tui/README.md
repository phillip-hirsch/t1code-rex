# t1code

Terminal-first T3 Code fork with an OpenTUI client.

## Install

```bash
bunx @maria_rcks/t1code
```

Requires Bun `>=1.3.9`.

Linux notes:

- T1Code follows XDG defaults on Linux:
  `XDG_CONFIG_HOME/t1code` for prefs, `XDG_STATE_HOME/t1code` for logs and image state, and `XDG_DATA_HOME/t1code` for app data.
- Opening links uses desktop helpers such as `xdg-open` or `gio open`.
- Clipboard image paste works with `wl-paste` on Wayland or `xclip` on X11.

## What You Get

- Native-feeling terminal UI built on OpenTUI
- Bundled T3 Code server (orchestration v2) for local use
- Codex-first workflow tuned for terminal usage

## Server and data

T1Code starts upstream's T3 Code server in `desktop` mode on `127.0.0.1` and keeps its data under `~/.t1` (`T1CODE_HOME`), so it never shares a data directory with a T3 Code install in `~/.t3`. The server needs Node 24 or newer on your `PATH`; set `T1CODE_NODE_BIN` to use another binary.

To join a server that is already running instead of starting one:

```bash
T1CODE_TUI_ATTACH_ONLY=1 T1CODE_HOST=127.0.0.1 T1CODE_PORT=3773 T1CODE_AUTH_TOKEN="$(t3 auth session issue --token-only --base-dir ~/.t1)" t1code
```

`T1CODE_AUTH_TOKEN` is a bearer token, never a server bootstrap secret.

## Rex

When T1Code runs inside a Rex session (`REX_SESSION` is set), the command palette (`⌘K`, or `Ctrl+K`) gets a Rex section:

- **Open thread in Rex tab** starts a second T1Code in a new Rex tab, focused on that thread. Running it again focuses the existing tab.

Terminal splits and diff tabs return with the orchestration v2 port (see `docs/rex-parity-plan.md`).

Thread tabs connect to the server of the window that opened them, so they need that window to stay open. They read your prefs but don't save them. Set `T1CODE_REX_BIN` if `rex` isn't on your `PATH`.

## Source

- Repo: https://github.com/maria-rcks/t1code
- Issues: https://github.com/maria-rcks/t1code/issues

Based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
