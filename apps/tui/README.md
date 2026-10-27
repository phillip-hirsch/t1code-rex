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

## Composer

Keys match upstream T3 Code's web app:

- **Enter** sends. While a run is busy, Enter steers it, the way upstream's default "Follow-up behavior" does. **Cmd+Enter** or **Ctrl+Enter** queues the message behind the run instead. Many terminals only report Cmd or Ctrl with Enter under the kitty keyboard protocol, so **Alt+Enter** queues too. `/steer <message>` and `/queue <message>` do the same from any terminal. Set `"followUpBehavior": "queue"` in `prefs.json` to swap Enter and the alternate key, like upstream's setting.
- **Shift+Enter** or **Ctrl+J** adds a newline.
- **Esc** stops a run. Ctrl+C clears the text, then stops a run, then quits. Enter on an empty composer stops a busy run too.
- After a stop, messages that hadn't gone out yet are held, like the queue the server holds. Enter on the empty composer or `/resume` sends them; `/discard` puts them back in the composer. Sending a new message releases the hold too. Either way, the server's held queue is released first, so messages go out in the order you sent them. If that release fails, the messages stay held and the composer says why. `/resume` with nothing held here just releases the server's queue.
- A message that gets no reply for 30 seconds shows as stuck. `/resume` sends it again with the same ids, so the server doesn't take it twice, and `/discard` puts it back in the composer. If it may already have been sent, the composer says so.
- On quit, unsent messages go back into their thread's composer. A message that went out without a reply yet is saved by id; on the next launch tr3x looks for it on the thread, and if it isn't there, puts it back in the composer with a note that it may not have been sent. tr3x never sends anything again on its own. A window that can't save prefs (a Rex thread tab, or a second main window) asks you to quit again before dropping unsent messages.

## Server and data

tr3x starts upstream's T3 Code server in `desktop` mode on `127.0.0.1` and keeps its data under `~/.tr3x` (`TR3X_HOME`), so it never shares a data directory with a T3 Code install in `~/.t3`. The server needs Node 24 or newer on your `PATH`; set `TR3X_NODE_BIN` to use another binary.

To join a server that is already running instead of starting one, run this from the repo root:

```bash
TR3X_TUI_ATTACH_ONLY=1 TR3X_HOST=127.0.0.1 TR3X_PORT=3773 \
  TR3X_AUTH_TOKEN="$(node apps/server/src/bin.ts auth session issue --token-only --base-dir ~/.tr3x)" \
  bun apps/tui/src/index.tsx
```

`TR3X_AUTH_TOKEN` is a bearer token, never a server bootstrap secret.

Only one main window saves prefs for a config directory. The first one holds an OS file lock on `prefs.lock.db` next to `prefs.json` until it exits. Any other main window reads prefs but doesn't save them, and its footer says "prefs not saved here". The OS releases the lock when the owner dies, even from `kill -9`, so the next window takes it. A `prefs.json.lock` left by an older build is ignored and safe to delete.

## Approvals and questions

When an agent asks for approval or asks a question, a panel shows it above the composer. The composer keeps focus, so typing and Enter work as before.

- **Tab** or a click moves focus to the panel; **Esc** or **Tab** goes back. Focus also goes back when the request changes. If the request appeared less than 0.75 s before, the panel waits for Enter first.
- Approvals: `y`/`1` approve once, `s`/`2` approve for this session, `n` decline, `c` decline and stop the run. Enter never approves. Questions: `↑↓` move, `1-9` or Space pick, `⏎` next or submit, `Ctrl+X` dismisses when the question allows it. `[` and `]` step between requests. Ctrl+C stops the run.
- Holding a key never answers: a held key's repeats only move the cursor.
- As in upstream's web app, sending a message while an approval is on screen declines that approval, then steers the run with your message. The decline waits its turn behind earlier messages, and Stop, `/discard` and quitting cover it like any unsent message. A question on screen is left alone. A request that arrives while you're typing stays out of view until you pause for 1.5 s, send or leave the composer, so that send leaves it alone.
- After a stop, a pending approval can only be declined, to clear it.

## Terminal

Each thread has a terminal drawer below the composer, running shells on the server in the thread's worktree or project folder. Shells keep running while you look at another thread, and switching back shows them as you left them. After a server restart they come back with their scrollback.

- **⌘J** opens the drawer and focuses it; again hides it. From another pane it focuses the open drawer.
- In the terminal, **⌘D** splits, **⌘⇧D** splits downward, **⌘N** opens a tab, **⌘W** closes the shell. These are upstream's keybindings, so `keybindings.json` changes them. On Windows and Linux they're Ctrl keys, except that Ctrl+D (EOF) and Ctrl+U (kill line) stay the shell's: split there from the palette. Ctrl+Shift+D splits downward only in terminals with the kitty keyboard protocol; elsewhere it arrives as Ctrl+D.
- Keys typed while a terminal starts are sent once its shell connects. If the server rejects input, the pane says so and drops what was typed after it; typing again resumes.
- The terminal gets every other key, Ctrl+C, Esc and Tab included. **Ctrl+]** moves focus on to the next pane; **Tab** comes back. A click focuses a pane too.
- **Ctrl+Shift+←/→** switches terminals, **Ctrl+Shift+↑/↓** resizes the drawer (or drag its header), **Shift+PgUp/PgDn** and the mouse wheel scroll back.

## Rex

When tr3x runs inside a Rex session (`REX_SESSION` is set), the command palette (`⌘K`, or `Ctrl+K`) gets a Rex section:

- **Open thread in Rex tab** starts a second tr3x in a new Rex tab, focused on that thread. Running it again focuses the existing tab.
- **Open terminal in Rex split** opens a native Rex split below tr3x, with a shell in the thread's folder.

Diff tabs return with the orchestration v2 port (see `docs/rex-parity-plan.md`).

Thread tabs connect to the server of the window that opened them, so they need that window to stay open. They read your prefs but don't save them. Set `TR3X_REX_BIN` if `rex` isn't on your `PATH`.

## Source

- Repo: https://github.com/phillip-hirsch/tr3x
- Issues: https://github.com/phillip-hirsch/tr3x/issues

Based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
