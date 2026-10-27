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
- Bundled server and web client for local use
- Codex-first workflow tuned for terminal usage

## Rex

When T1Code runs inside a Rex session (`REX_SESSION` is set), the command palette gets a Rex section and the thread menu gets **Open in Rex Tab**:

- **Open thread in Rex tab** starts a second T1Code in a new Rex tab, focused on that thread. Running it again focuses the existing tab.
- **Open terminal in Rex split** opens a shell below T1Code in the thread's worktree or project folder.
- **Open diff in Rex tab** runs `git diff HEAD` for the thread's worktree or project folder.

Thread tabs connect to the server of the window that opened them, so they need that window to stay open. They read your prefs but don't save them. Set `T1CODE_REX_BIN` if `rex` isn't on your `PATH`.

## Source

- Repo: https://github.com/maria-rcks/t1code
- Issues: https://github.com/maria-rcks/t1code/issues

Based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
