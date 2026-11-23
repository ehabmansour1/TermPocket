# Changelog

All notable changes to TermPocket. The VS Code extension has its own, more detailed log in
[vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md); the wire protocol is in
[PROTOCOL.md](PROTOCOL.md).

## Unreleased

## 1.0.0 — 2026-11-23

First public release, under the new name **TermPocket** (formerly *VS Control*).

### Changed

- **Renamed to TermPocket** everywhere: agent, app, tray monitor (scheduled tasks "TermPocket Agent" /
  "TermPocket Monitor"), config folder `%APPDATA%\TermPocket`, environment variables `TERMPOCKET_*`, headers
  `X-TermPocket-*`, VS Code extension `ehabmansour1.termpocket` with `termpocket.*` commands and settings and
  the terminal profile "TermPocket (mirrored)". New icon.
- The `/vscode` and terminals-host handshake labels changed: update the agent and the extension together.
- The relay is now fully configured through environment variables / `.env` (`RELAY_KEY`, `PORT`, `HOST`,
  `WEB_ROOT`) and documented as an optional self-host ([docs/relay.md](docs/relay.md)); Tailscale is the
  default.

### Added

- **Upgrade path from VS Control:** the agent copies `%APPDATA%\VSControl` (token, `relay.json`) once;
  `install-autostart.ps1` removes the old tasks; old `VSCONTROL_*` variables and `vscontrol.*` user settings
  are still read; the app keeps its saved token; old caches are cleaned up.
- **Installer and releases:** `install.ps1` (one-liner `irm …/install.ps1 | iex`, per user, no admin)
  installs the release zip with its own portable Node.js, verifies its SHA-256, registers autostart,
  installs the VS Code extension and adds a *Settings → Apps* entry; `uninstall.ps1` removes it (settings
  kept unless `-Purge`). Release zip, `.vsix` and checksums are built by GitHub Actions. Scoop manifest.
- **Demo mode** (`TERMPOCKET_DEMO=1`): a made-up PC and desktop for screenshots and videos, always dry-run.
- Documentation: new README, [user guide](docs/user-guide.md), [architecture](docs/architecture.md),
  [security model](docs/security.md), [FAQ](docs/faq.md), [troubleshooting](docs/troubleshooting.md),
  [relay guide](docs/relay.md), contributing guide, security policy, code of conduct, issue templates.

### Fixed

- A new mirrored terminal opened in VS Code could stay empty, while a second copy of it opened, when the
  agent's `pty.create` answer and `mirror.open` arrived in one network packet.
- The pairing link now finds `tailscale serve` even when the agent's `PATH` predates the Tailscale install
  (it falls back to `%ProgramFiles%\Tailscale\tailscale.exe`).

## 0.3 (VS Control) — 2026-11-21

- **Durable terminals:** a separate terminals host process (named pipe + HMAC) keeps shells alive across
  agent restarts, crashes and tray Restart / Stop; the agent adopts its sessions on start; mirrored VS Code
  terminals re-bind after a reconnect.
- **Open as running:** ordinary VS Code terminals show what they show right now (snapshot of screen and
  scrollback, clipboard restored).
- **VS Code workbench** for the desktop Code tab: explorer, Monaco editor tabs with VS Code diagnostics,
  diff, PROBLEMS and TERMINAL panel, Command Palette and Quick Open, Search, Source Control (stage, unstage,
  discard, commit), status bar. Extension methods `fs.stat` / `mkdir` / `rename` / `delete`, `git.*`,
  `commands.list {withTitles}`.
- **PC monitor:** tray icon (green / amber / red, new-device and failed-pairing notifications, restart /
  stop / start, self-test) and a loopback-only dashboard with redacted logs.
- **Live view** of ordinary VS Code terminals (raw output at the VS Code size, typing from the phone,
  History) and a "phone-visible terminals" switch.

## 0.2 (VS Control) — 2026-11-21

- Laptop layout (sidebar, terminal tabs, split Code view) and **Remote Desktop mode** (full keyboard
  capture with keyboard lock, real mouse, clipboard sync, HD preset, all displays, PC pointer).
- Security: Host / Origin checks (DNS rebinding, cross-site WebSockets), `/vscode` challenge-response.
- Optional relay server and the agent's built-in relay client.
- Hibernate.

## 0.1 (VS Control) — 2026-11-20

- First version: PC agent with token auth and rate limiting, ConPTY terminals, VS Code hub with mirrored
  terminals, screen / input / system through an in-memory PowerShell / C# helper; VS Code extension;
  installable phone app with Terminals, Code, Screen and System tabs; autostart and Tailscale setup
  scripts; end-to-end tests.
