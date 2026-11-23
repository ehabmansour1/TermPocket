# Changelog

## 1.0.0

- Renamed from "VS Control" to **TermPocket** (publisher `ehabmansour1`, extension `ehabmansour1.termpocket`):
  commands `termpocket.*`, settings `termpocket.*`, terminal profile "TermPocket (mirrored)"
  (`termpocket.mirroredTerminal`), output channel and status bar "TermPocket".
- Upgrading: the old `vscontrol.*` USER settings are still read when the new ones are not set (never their
  workspace values); a user default terminal profile of "VS Control (mirrored)" is switched to
  "TermPocket (mirrored)" once; `TERMPOCKET_*` env variables fall back to `VSCONTROL_*`; until the agent has
  copied its old folder, the token is read from `%APPDATA%\VSControl\config.json`.
- The `/vscode` handshake labels are now `termpocket-agent` / `termpocket-ext`: update the agent too.
- New icon.
- Fixed: a new mirrored terminal could stay empty, while a second copy of it opened, when the agent's
  `pty.create` answer and `mirror.open` arrived in one network packet.

- Terminal snapshots never borrow the clipboard while it holds an image, copied files or rich text (a
  text-only restore would lose them): the extension asks the agent first (`clipboard.info`, PROTOCOL §5.3);
  against an older agent an empty clipboard text read counts as "maybe an image" and is left alone too.
- Desktop workbench support (PROTOCOL §5.2, v0.4): `fs.stat`, `fs.mkdir`, `fs.rename` (through a
  `WorkspaceEdit` so open editors follow the file), `fs.delete` (to the trash; workspace folders and
  their parents are refused); Source Control on top of the built-in Git extension API: `git.status`,
  `git.show`, `git.stage`, `git.unstage`, `git.discard`, `git.commit` and the `git.changed` event
  (`git.commit {all:true}` stages tracked changes only — the API's `all: 'tracked'`, `git add -u` —
  never untracked files, which the API's `all: true` / `git add -A` would commit too);
  `commands.list {withTitles:true, query?}` returns Command Palette titles, categories and default
  keybindings (installed extensions' manifests + a curated map of common built-in commands);
  `diagnostics.list` rows carry `endLine` / `endColumn` (and `tags`).
- Git in a background window: VS Code's Git extension only re-reads `git status` while its window is
  focused. While the window is not focused, file changes in the workspace (debounced) and `git.status`
  ask the repositories to refresh (at most every 2 s), so the phone sees current changes; a refresh
  that changed nothing is not announced again (no `git.changed` → `git.status` loop).
- Requests always answer in time: `fs.list` abandons slow per-entry stats after 3 s and caps huge
  folders at 10 000 entries, every file-system / git / command call has a deadline below the agent's
  30 s timeout, `fs.search` is cancelled after 20 s, and `fs.list` in a window without a folder
  explains why.
- Live view of ordinary VS Code terminals (PROTOCOL §5.2.1): `terminals.attach` / `detach` /
  `keepalive` / `input` and the `term.raw`, `term.dims`, `term.detached` events. Every
  shell-integration execution's output is kept in a per-terminal raw ring (setting
  `termpocket.liveBufferKB`, default 512 K characters); the VS Code terminal size comes from
  `terminal.dimensions`.
- `settings.get` / `settings.mirrorDefault` (+ `settings.changed` event) and the command
  "TermPocket: Make new terminals phone-visible (mirrored)": makes "TermPocket (mirrored)" the user's
  default terminal profile.
- Changing `termpocket.liveBufferKB` no longer reconnects (only `agentUrl` / `configPath` do).
- Live-view attachments carry an id (`aid`) with their own 10-minute lease: a phone that re-attaches
  after losing its connection (`replaces`) no longer leaves a stale attachment that kept `term.raw`
  streaming after it closed the view; a vanished phone's lease expires without touching others.
  A size change first noticed by a new attach is sent to the phones already attached. The ring size
  setting is cached instead of being read for every output chunk. `settings.*` reports
  `overriddenBy` when workspace settings shadow the user's default terminal profile.

## 0.1.0

- First release.
- Connects each VS Code window to the local TermPocket agent (`/vscode` WebSocket) with a `hello`
  handshake and automatic reconnect (backoff 1 s to 30 s).
- Workspace, file (`fs.*`), editor, diagnostics and command methods for the phone app.
- VS Code terminals: list/create/sendText/exec/history/show/dispose, with shell-integration command
  tracking (`term.exec.*` events).
- Mirrored terminals: agent PTYs shown in VS Code and on the phone at the same time, including the
  "TermPocket (mirrored)" terminal profile and the "New Mirrored Terminal" command.
- Status bar item, quick pick menu and "TermPocket" output channel.
- Mirrored terminals survive a VS Code quit/reload: `mirror.closed` is only sent when the user (or
  an extension) closes the terminal, not on window shutdown.
