# tr3x

Terminal-first T3 Code fork with an OpenTUI client.

## Run

tr3x isn't published to npm. Run it from a clone of the repo:

```bash
vp i
vp run dev:tui
```

Requires Bun `>=1.3.9` and Node 24 or newer.

Linux notes:

- tr3x follows XDG defaults on Linux:
  `XDG_CONFIG_HOME/tr3x` for prefs, `XDG_STATE_HOME/tr3x` for logs and image state, and `XDG_DATA_HOME/tr3x` for app data.
- Opening links uses desktop helpers such as `xdg-open` or `gio open`.
- Clipboard image paste works with `wl-paste` on Wayland or `xclip` on X11.

## What You Get

- Native-feeling terminal UI built on OpenTUI
- Bundled T3 Code server (orchestration v2) for local use
- Codex-first workflow tuned for terminal usage

## Server and data

tr3x starts upstream's T3 Code server in `desktop` mode on `127.0.0.1` and keeps its data under `~/.tr3x` (`TR3X_HOME`), so it never shares a data directory with a T3 Code install in `~/.t3`. The server needs Node 24 or newer on your `PATH`; set `TR3X_NODE_BIN` to use another binary.

To join a server that is already running instead of starting one:

```bash
TR3X_TUI_ATTACH_ONLY=1 TR3X_HOST=127.0.0.1 TR3X_PORT=3773 TR3X_AUTH_TOKEN="$(t3 auth session issue --token-only --base-dir ~/.tr3x)" tr3x
```

`TR3X_AUTH_TOKEN` is a bearer token, never a server bootstrap secret.

## Rex

When tr3x runs inside a Rex session (`REX_SESSION` is set), the command palette (`⌘K`, or `Ctrl+K`) gets a Rex section:

- **Open thread in Rex tab** starts a second tr3x in a new Rex tab, focused on that thread. Running it again focuses the existing tab.

Terminal splits and diff tabs return with the orchestration v2 port (see `docs/rex-parity-plan.md`).

Thread tabs connect to the server of the window that opened them, so they need that window to stay open. They read your prefs but don't save them. Set `TR3X_REX_BIN` if `rex` isn't on your `PATH`.

## Source

- Repo: https://github.com/phillip-hirsch/tr3x
- Issues: https://github.com/phillip-hirsch/tr3x/issues

Based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
