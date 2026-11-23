# TermPocket end-to-end tests

```bat
cd e2e
npm install            & rem ws + playwright-core (playwright-core never downloads a browser)
npm test               & rem integration.mjs — the phone protocol vs the real agent + isolated VS Code
npm run test:pwa       & rem pwa.e2e.mjs   — the PWA itself in headless Google Chrome (Pixel 7)
npm run test:desktop   & rem desktop.e2e.mjs — desktop layout + Remote Desktop mode (1440×900, mouse)
npm run test:live      & rem vscode-live.e2e.mjs — Live view of ordinary VS Code terminals (desktop + phone)
npm run test:workbench & rem workbench.e2e.mjs — the desktop Code tab as a VS Code workbench
npm run test:durable   & rem durable.e2e.mjs — durable terminals + snapshots (protocol level, no browser)
npm run test:durable-terminals & rem durable-terminals.e2e.mjs — durable terminals through the PWA (agent restart)
npm run screenshots    & rem screenshots.mjs — the README images in docs/images/ (demo data only)
```

The scripts start everything they need in a temporary folder and stop it again. The agent runs with
`TERMPOCKET_DRYRUN_INPUT=1`, so mouse, keyboard, power, process-kill, clipboard-write and open
requests are only logged (`[dryrun] …`) and never act on your desktop.

## Rules for every suite

- **Temporary agent only:** each suite runs its own agent with a temporary `TERMPOCKET_HOME` (own token,
  own terminals host pipe) on a test port, so it never touches an installed TermPocket, its terminals or its
  pairing.
- **Isolated VS Code only, through `lib/harness.mjs`:** temporary `--user-data-dir` / `--extensions-dir`,
  the extension loaded with `--extensionDevelopmentPath`, windows parked off-screen. Never launch VS Code
  any other way from a test, and never drive your own VS Code windows.
- **Headless browsers only:** `playwright-core` with the installed Google Chrome (`channel: 'chrome'`), no
  browser download; `navigator.clipboard` stubbed where the page would use it.
- **Screenshots** are compact JPEGs in `artifacts/` (git-ignored). Images for the docs come from demo mode
  (`TERMPOCKET_DEMO=1`, see [CONTRIBUTING.md](../CONTRIBUTING.md#demo-mode-screenshots-and-videos)) so they
  show no real PC, paths or names.

## `integration.mjs` security checks

Against the real agent process: a foreign `Host` gets 421 on `/`, `/pair`, `/healthz` and both WebSocket upgrades
(no token in any body), `localhost` / `*.ts.net` are served, and `/pair` needs a loopback Host. Foreign `Origin`s
(other site, `null`, another local port) get 403 on `/ws` and `/vscode`, while same-origin and no-Origin
upgrades pass and auth still works afterwards. The `/vscode` challenge-response is checked: the agent's proof
verifies and a wrong extension proof gets `bad token` + 4401. The isolated VS Code opens a workspace whose
`.vscode/settings.json` points `termpocket.agentUrl` / `configPath` at a decoy WebSocket server; the decoy must
see no connection, because both settings are application-scoped.

## `pwa.e2e.mjs`

Drives the real `web/` app in the installed Google Chrome (`channel: 'chrome'`, headless, one browser,
Pixel 7 emulation) against the agent on `127.0.0.1:18766` and an isolated VS Code instance (temporary
`--user-data-dir` / `--extensions-dir`, `--disable-extensions`, the extension loaded with
`--extensionDevelopmentPath`). It covers pairing (good and bad token), terminals (xterm, command box,
keyboard, sticky Ctrl, ^C, font size, fit, mirrored and exec-log VS Code terminals), the Code tab
(window picker, browse, edit + save checked on disk, search, tabs, problems, commands, save all),
the Screen tab (frames, stats, presets, tap / double-tap / long-press and keyboard checked against the
agent's dry-run log), the System tab (cards, processes, kill and power confirmations, clipboard read),
reconnecting (dropped link and agent restart), the service worker, the manifest's installability, and
layout at 412 px, 360 px, landscape and in the light theme. Console errors and page errors must be zero.

Options: `--no-vscode` (agent only), `--port <n>` (default 18766), `--shots <dir>` (compact JPEG
screenshots, default `artifacts/pwa-shots`), `--headed`, `--keep-temp`. Results go to
`artifacts/pwa-results.json`, the agent log to `artifacts/pwa-agent.log`.

## `desktop.e2e.mjs`

The same app as a laptop browser (PROTOCOL §8): headless Google Chrome at 1440×900 with a mouse and
no touch, agent on `127.0.0.1:18768`, isolated VS Code. Checks the desktop layout (sidebar with host /
status, Terminals split view with two live xterm tabs — Ctrl+Shift+T, hidden extra keys, close =
detach —, Code tab as a VS Code workbench: explorer, Monaco editor tabs (preview / pinned), edit + Ctrl+S checked on disk, VS Code diagnostics as squiggles, System grid, Screen with
the HD preset) and Remote Desktop mode: fullscreen state, mouse move throttling, left/right/middle
down+up with normalized coordinates under letterboxing (cross-checked against the agent's dry-run
pixels), clicks on the letterbox ignored, wheel notches (vertical + `deltaX`), `input.keyraw`
key-down/up incl. auto-repeat and Ctrl+W / Tab staying in the page, `input.releaseAll` on blur,
toolbar Task Manager / Win / Alt+Tab sequences, clipboard push/pull, 1:1 view edge-panning with
coordinates following the panned picture, "All displays" (monitor -1) with the PC pointer marker
from `screen.meta`, exit (button, Ctrl+Alt+Break) and Ctrl+Alt+Enter, 1280×800 / 1920×1080 layouts and
the Auto / Phone layout setting. `navigator.clipboard` is replaced by a stub in the page, so the
browser never reads or writes your clipboard (the agent's `clip.set` is dry-run; `clip.get` reads).
Every v0.2 input is cross-checked against the agent's dry-run log (keyraw order and scan codes, the keys
`input.releaseAll` released, `deltaX`, monitor -1 pixels on the virtual desktop). The HD stream is measured on
one monitor, in Remote Desktop and on All displays: fps, KB/s, average frame size, `screen.meta` before every
frame with the same seq, and the 0xFFFF monitor header. The numbers go to `hdStream` in the results file. A page
served from another local port must fail to open `/ws` and `/vscode` (Origin check, PROTOCOL §1.1).
Synthetic wheel events from DevTools are classic ticks (wheelDelta ±120 each), so one CDP wheel event is one
notch; trackpad-style deltas are dispatched as constructed `WheelEvent`s.
Options as above (`--port`, default 18768; `--shots`, default `artifacts/desktop-shots`). Results go to
`artifacts/desktop-results.json`.

## `vscode-live.e2e.mjs`

The Live view of ordinary (non-mirrored) VS Code terminals (PROTOCOL §5.2 `terminals.attach` / `term.raw`, §5.2.1, §6).
Agent on a free 127.0.0.1 port (dry-run input), isolated VS Code, headless Google Chrome at 1440×900 (mouse) and
412×915 (Pixel 7). In an ordinary PowerShell terminal it runs `tui.js` (written to the temp workspace): alternate
screen, coloured box, a counter every 250 ms, raw-mode key echo, exits on `q` / Ctrl+C. Checked: attach result
(`capturing`, `cols`/`rows` = what PowerShell and the TUI see), re-attach buffer, no `term.raw` while detached (the
ring still captures), the xterm pinned to the VS Code size and fitted to the pane, typing from the physical keyboard,
the soft keyboard, the extra-keys row and the command box, Ctrl+C / q, History entries with exit badges, no stream
while the History tab or another deck tab is shown or after closing the tab, re-attach redraws the TUI, a Command
Prompt terminal (no shell integration) → `capturing:false` + the note banner, the banner button →
`terminal.integrated.defaultProfile.windows` = "TermPocket (mirrored)" in the isolated user settings.json and the
next VS Code terminal is mirrored, and the settings-menu switch turns it off again (previous "PowerShell" restored).
Options: `--port`, `--shots` (default `artifacts/live-shots`), `--headed`, `--keep-temp`. Results go to
`artifacts/live-results.json`.

## `workbench.e2e.mjs`

The desktop Code tab as a VS Code workbench. Agent on a free 127.0.0.1 port (dry-run input), isolated VS Code
with Git enabled whose workspace is a temporary git repository (`hello.js` committed then modified, `broken.js`
with syntax errors, `README.md`, `sub/data.txt`, `untracked.txt`), headless Google Chrome at 1440×900 and
1920×1080 (and 412×915 for the phone check). Checked: title / activity / status bar geometry and fonts, explorer
icons, expand / collapse with mouse and keyboard, Git decorations; Monaco preview vs pinned tabs, token colours
(Dark Modern), edit → dirty → Ctrl+S on disk, the save-conflict dialog (Cancel keeps the PC's version, Overwrite
writes ours); VS Code diagnostics as squiggles, PROBLEMS grouped by file and a click opening line 3; TERMINAL tabs
= the window's terminals, "+" creates a mirrored terminal fitted to the panel, typing into it and into an ordinary
terminal (Live view), trash = `terminals.dispose`, Ctrl+` toggles the panel; Command Palette finds "File: Save"
with its keybinding and runs "File: New Untitled Text File" in VS Code (recently used on top afterwards); Quick
Open + `:` go to line; Source Control M / U, diff editor, stage, commit (checked with `git log`), commit with nothing
staged = tracked changes only (`untracked.txt` stays out of the commit); New File / Rename / Copy Path (clipboard
stub) / Delete (Recycle Bin, `fs.delete` with trash) on disk, Delete of a file with unsaved edits warns first,
New File never empties an existing file; the status bar items
and colours; no overflow at 1920×1080; the phone layout's classic Code tab (file list, commands) and the live
switch back; tabs restored after a reload; zero console errors.
Options: `--port` (default: a free port), `--shots` (default `artifacts/workbench-shots`, files `final-*.jpg`),
`--headed`, `--keep-temp`. Results go to `artifacts/workbench-results.json`. Delete moves two temp files to your
Recycle Bin.

If a VS Code background update is pending (`updating_version` in the install folder), new VS Code
instances refuse to start; the isolated instance then runs from a hard-linked shadow of the installed
build (see `lib/harness.mjs`). The installed VS Code is never modified.

## `screenshots.mjs` (README images)

`npm run screenshots` regenerates every image in `docs/images/`: phone shots (Pixel 7, 412×915 @2x), laptop
shots (1440×900), the tray icon states, the 1280×640 social preview and the README hero. Everything shown is
demo data: the agent runs with `TERMPOCKET_DEMO=1` (host DEV-PC, user "you", sample IPs and machine, the
synthetic desktop from `agent/demo/`, dry-run input) on a free port with a temp home; the isolated VS Code
opens a made-up project "my-app" (`screenshots/demo-workspace.mjs`: a git repo with staged / unstaged /
untracked changes and one TypeScript error), written to `C:devmy-app` for the run and removed afterwards
(an existing folder that the script did not create is never touched: pass `--workspace <dir>`). The terminals
run canned sessions (`screenshots/demo-session.mjs`: an AI coding-agent session, a dev server, a test run) —
no AI service is called. Shells start with `-NoProfile`, the terminal snapshot (clipboard) is off, and before
each capture the page text is checked for this PC's name, user name, home / temp paths, IP addresses and CPU
model; a hit fails the run. PNGs are palette-optimized by `screenshots/png.mjs` (no external tools). Tray
tooltips and menu lines come from `monitor-tray.ps1 -Once -Json` itself, run against a stand-in for the demo
agent's `/status`.

Options: `--out <dir>` (default `../docs/images`), `--workspace <dir>`, `--only a,b` (e.g.
`--only social-preview,hero` re-composes from the existing shots without starting anything), `--headed`,
`--keep-temp`. The list of files written goes to `artifacts/screenshots-results.json`.
