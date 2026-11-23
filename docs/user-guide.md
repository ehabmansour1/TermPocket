# TermPocket user guide

Everything TermPocket does, in detail. For installing and pairing see the [README](../README.md); for
problems see [troubleshooting](troubleshooting.md).

- [First start and pairing](#first-start-and-pairing)
- [Phone and laptop layouts](#phone-and-laptop-layouts)
- [Terminals](#terminals)
- [VS Code terminals: Live view and mirrored terminals](#vs-code-terminals-live-view-and-mirrored-terminals)
- [The Code tab and the desktop workbench](#the-code-tab-and-the-desktop-workbench)
- [Screen and Remote Desktop mode](#screen-and-remote-desktop-mode)
- [System](#system)
- [Monitor: tray icon, dashboard, self-test](#monitor-tray-icon-dashboard-self-test)
- [Autostart](#autostart)
- [Configuration](#configuration)
- [Bandwidth (screen streaming)](#bandwidth-screen-streaming)
- [Upgrading from VS Control](#upgrading-from-vs-control)

## First start and pairing

- On its first start the agent creates `%APPDATA%\TermPocket\config.json` with a random pairing token
  (32 random bytes).
- It prints a banner with the pairing link (`…/#token=…`) and a QR code in its console (when you start it
  with `scripts\start-agent.cmd`), and `http://127.0.0.1:8765/pair` on the PC shows the same link and QR at
  any time. The tray menu has **Open pairing page** too.
- The pairing link uses, in this order: `publicUrl` from `config.json` (or `TERMPOCKET_PUBLIC_URL`), the
  relay's address when `relay.json` is set, the `https://…ts.net` address when `tailscale serve` proxies to
  the agent, else `http://<host>:<port>`.
- Opening the link saves the token in the app and removes it from the address bar. You can also paste the
  link or just the token into the pairing screen.
- Menu → **Forget this device** removes the token from that one phone or browser.

## Phone and laptop layouts

The same app adapts to the device. The **desktop layout** turns on by itself when the window is at least
900 px wide and you use a mouse or trackpad; menu → **Layout** switches between *Auto*, *Desktop* and
*Phone*.

- **Phone:** bottom tab bar **Terminals · Code · Screen · System**, large touch targets, the Android back
  button closes the top-most sheet or view, landscape works.
- **Desktop:** a sidebar with the four sections, the PC name and the connection status (click the status
  card to reconnect).
- **Install it as an app on a laptop** (the install icon at the right of the address bar, or ⋮ → *Cast,
  save and share* → *Install page as app*). In a normal tab Chrome keeps Ctrl+Shift+T, Ctrl+Tab, Ctrl+W
  and Ctrl+PageUp / PageDown for itself; in the app window they reach TermPocket.
- Use the `https://…ts.net` (or relay) address, not `http://<ip>:8765`: installing, offline start,
  keyboard lock and clipboard sync need HTTPS.

## Terminals

- **New terminal:** Default (`defaultShell` from `config.json`, `powershell.exe` unless you change it),
  PowerShell, PowerShell 7, cmd or WSL, optionally in a folder and optionally opened in a VS Code window
  as a mirrored terminal.
- **Phone view:** xterm.js with an extra-keys row (Esc, Tab, sticky Ctrl and Alt, ↑ ↓ ← →, Home, End,
  PgUp, PgDn, `|` `~` `/` `-`, ^C), font size − / +, *Fit* (resizes the PC terminal to the phone) and a
  command box (sends the text plus Enter). Sticky Ctrl / Alt: tap = next key, tap again = lock, third
  tap = off. Arrow and page keys repeat on long-press.
- **Terminals mirrored in VS Code** keep their PC size (scroll horizontally) until you tap *Fit*, so
  opening one on the phone doesn't reflow the VS Code terminal.
- **Laptop:** session list on the left, terminal tabs on the right; each tab stays live while hidden.
  **Ctrl+Shift+T** opens a new terminal, **Ctrl+Tab** switches, **×** or a middle-click closes a tab.
  The physical keyboard types straight into the terminal; Ctrl+C copies when text is selected (otherwise
  it interrupts) and Ctrl+V pastes. The keyboard button in the terminal header shows the extra-keys row.
- **Closing a tab only detaches it**; the shell keeps running. Kill it from the list.

### Durable terminals (the terminals host)

Terminals opened from the phone and mirrored terminals run in the *terminals host*, a small background
process (`node agent\src\ptyhost.js`) that keeps running when the agent restarts, crashes, is updated or is
stopped from the tray.

- When the agent comes back it adopts every terminal: same ids, same scrollback (including output
  produced while no agent was connected). The phone finds them as it left them.
- VS Code shows a dim `[TermPocket: reconnecting…]` line in mirrored terminals meanwhile and redraws them
  when the agent is back.
- The host quits by itself 10 minutes after its last terminal ended while no agent is connected.
  `scripts\uninstall-autostart.ps1` stops it (and asks first while terminals still run; `-KeepTerminals`
  leaves it running).
- Ended terminals stay listed until you close them, up to the 32 most recent.
- `"ptyHost": false` in `config.json` (or `TERMPOCKET_PTYHOST=inprocess`) keeps terminals inside the agent;
  they then end with it.

## VS Code terminals: Live view and mirrored terminals

Each connected VS Code window lists its terminals in the Terminals tab.

### Live view of ordinary VS Code terminals

Tap an ordinary VS Code terminal (on a laptop it opens as a terminal tab). It opens on **Live**:

- You see the terminal the way VS Code draws it, including full-screen programs like **Claude Code**,
  vim or htop. The view keeps the VS Code terminal's own size (shown as e.g. `108×13`) and never resizes
  it on the PC; the font is scaled so all columns fit. Pinch, Ctrl+wheel or **− / +** zoom in (the view
  then scrolls), **Fit** goes back.
- Type into it as in VS Code: the phone keyboard, the extra-keys row and the command box. On a laptop the
  real keyboard goes straight into the terminal.
- **History** lists each command with its output and exit code, and can run a command.
- Output streams only while the Live tab is on screen. Switching away, hiding the app or closing the view
  stops it; coming back catches up from the captured output (the last 512 K characters per terminal,
  setting `termpocket.liveBufferKB`).

VS Code lets extensions read a terminal's output only through **shell integration**, and only from the
moment the extension started watching. So the Live view shows a note instead of live output when:

- the terminal has no shell integration (cmd.exe, or Windows PowerShell 5.1 under the default execution
  policy, see [troubleshooting](troubleshooting.md)); typing still works;
- a program was already running when the extension started, for example a Claude Code session in a
  terminal VS Code restored after a reload. Its output appears from the next command on. Restart the
  program, or use a mirrored terminal.

Either way, opening the terminal shows what it shows **right now** (screen and scrollback, without
colours): the extension takes a snapshot through VS Code's own *Select All* + *Copy* on that terminal and
puts your clipboard text back afterwards. The terminal panel flashes into view on the PC while it does,
and nothing is taken while the clipboard holds an image, files or rich text. Turn it off with the VS Code
setting `termpocket.terminalSnapshot`.

Prompts and what you type at a shell prompt aren't readable either: each command shows as a dim
`$ <command>` line before its output. Inside a running program you see everything, including your typing.

### Mirrored terminals: make every VS Code terminal phone-visible

The extension adds a **TermPocket (mirrored)** terminal profile. A mirrored terminal is an agent shell
shown in VS Code: the phone sees all of it, from the first line, even after a VS Code reload, and it
survives agent restarts. To make it the default for new terminals, use any of:

- the switch **Phone-visible VS Code terminals** in the app's settings menu, or **Make new terminals
  phone-visible** in a terminal's menu or in the Live view's note;
- the VS Code command **TermPocket: Make new terminals phone-visible (mirrored)** (also in the status-bar
  menu);
- or by hand in your user `settings.json`:

  ```json
  "terminal.integrated.defaultProfile.windows": "TermPocket (mirrored)"
  ```

Terminals that are already open stay ordinary. Turning the switch off restores your previous default
profile.

- When you close a mirrored terminal in VS Code, its shell is closed too.
- When VS Code quits or reloads, the shell keeps running, so the phone can still use it; close it from the
  phone. After a reload VS Code re-binds the terminals it still shows.

## The Code tab and the desktop workbench

**Phone:** pick a VS Code window → file browser with breadcrumbs, file search, an editor with line numbers
(keeps CRLF files CRLF, refuses to save files cut off at 2 MB), *Save*, *Open on PC*, open tabs, Problems,
a command runner and *Save all*.

**Laptop:** the Code tab looks and works like VS Code itself (Dark Modern theme) for the window you pick in
the title bar.

| Part | What it does |
| --- | --- |
| **Title bar** | Menu bar (File / Edit / Selection / View / Go / Terminal / Help), back / forward, the command center (click = Quick Open), the **window switcher** (your connected VS Code windows), side bar / panel toggles. |
| **Activity bar** | Explorer, Search, Source Control, Problems (with counts), Manage. Click the active one to hide the side bar. |
| **Explorer** | OPEN EDITORS and the folder tree (loaded folder by folder), file-type icons, Git and problem colours, keyboard navigation (↑ ↓ ← → Enter, F2, Delete, type to find). Right-click: New File / New Folder (inline), Rename, Delete (to the Recycle Bin, confirmed), Copy Path / Relative Path, Reveal in File Explorer and Open in VS Code on the PC, Open Changes. |
| **Search** | Find files by name in the window's folders. |
| **Source Control** | Branch, Staged Changes / Changes with VS Code's M / A / D / U / R letters; click = diff editor against the index / HEAD; stage, unstage, discard (confirmed) per file or group; commit message box + **Ctrl+Enter**. |
| **Editor** | **Monaco**, VS Code's own editor component: syntax colours, minimap, find / replace (Ctrl+F / Ctrl+H), go to line (Ctrl+G), multi-cursor. Preview tabs (italic) are replaced by the next single click; double-click or typing pins them. A dot marks unsaved changes; **Ctrl+S** saves after checking the file did not change on the PC meanwhile (otherwise it asks before overwriting). The red / yellow squiggles are VS Code's real diagnostics. Breadcrumbs, Ctrl+W, Ctrl+Tab, Ctrl+PageUp / PageDown, middle-click close, drag to reorder, *Follow PC* (open whatever VS Code shows), *Open on PC*. |
| **Panel** | **PROBLEMS** (grouped by file; click jumps to the line) and **TERMINAL**: the window's terminals as tabs. Mirrored terminals open with their full history, ordinary ones in the Live view. **+** creates a new (mirrored) terminal, the trash icon closes one in VS Code. **Ctrl+`** toggles it; drag the edge to resize. |
| **Quick input** | **Ctrl+P** Quick Open (fuzzy, recently opened first, `file:line`), **Ctrl+Shift+P** / **F1** Command Palette (VS Code's commands with their titles, categories and keybindings; Enter runs it in that VS Code window), **Ctrl+G** / `:` go to line, `?` help. |
| **Status bar** | TermPocket · branch and sync · errors / warnings (click = Problems) · Ln / Col · indentation · encoding · CRLF / LF · language · notifications. |

- Monaco (about 4.6 MB) is served by the agent, downloaded only when the desktop Code tab first opens,
  then cached by the app. Highlighting comes from Monaco; errors and warnings only from VS Code.
- VS Code's Git refreshes a window in the background only when asked; the extension asks when files change
  and before answering, so you see current changes.
- Files that are not valid UTF-8 open read-only; untitled documents can be edited but not saved from the
  phone (that would open a Save As dialog on the PC).

## Screen and Remote Desktop mode

### Screen tab

- Monitor picker (each monitor, or **All displays** on a laptop), quality presets (Low / Medium / High,
  plus **HD** on a laptop), pinch-zoom and pan, fps and KB/s.
- **Touch mode:** tap = click, double-tap = double-click, long-press = right-click, long-press + drag =
  drag, two-finger vertical drag = scroll. **Trackpad mode:** drag moves a pointer, tap clicks,
  two-finger tap = right-click.
- Keyboard button for typing (Unicode text) and a special-keys row with Ctrl / Alt / Win.
- The PC's pointer is drawn as a marker on the picture.
- Streaming stops when you leave the tab or the app goes to the background.

### Remote Desktop mode (laptop)

Start it with the **Remote Desktop** button on the Screen tab, from the menu, or with **Ctrl+Alt+Enter**.

- **Full screen and keyboard lock:** the picture fills the screen. In Chrome and Edge, keyboard lock then
  also sends **Win, Alt+Tab, Esc, Ctrl+W, F5, Alt+F4** and so on to the PC instead of your laptop. The
  toolbar shows *Keys locked* when this is active.
- **Leaving:** **hold Esc** for about 2 seconds (Chrome's own exit), press **Ctrl+Alt+Break**, or click
  **Exit** in the toolbar. Leaving full screen also leaves Remote Desktop.
- **Keyboard:** keys are sent as physical key presses, so the PC's own keyboard layout applies (like RDP).
  Held keys repeat. Ctrl+Alt+Del can't be sent by any app; the toolbar has **Task Manager**
  (Ctrl+Shift+Esc), **Win** and **Alt+Tab** buttons instead.
- **Mouse:** moves, all three buttons, drag and drop, and the wheel (vertical and horizontal). *Hide local
  cursor* in the toolbar settings shows only the PC's pointer marker.
- **Nothing stays stuck:** when the window loses focus, the tab is hidden or you leave the mode, the app
  tells the PC to release every key and button it holds. The agent does the same when the connection
  drops.
- **View:** *Fit* (letterboxed), *Fit width* or *1:1 pixels*. In 1:1, holding the mouse at a window edge
  scrolls the picture.
- **Display:** pick a monitor or **All displays**. The quality menu has its own default for Remote
  Desktop (HD).
- **Clipboard sync** (HTTPS only, on by default, toggle in the toolbar settings or the menu):
  - when the Remote Desktop view gets focus and your laptop's clipboard text has changed, it is copied to
    the PC;
  - about 300 ms after you press Ctrl+C or Ctrl+X in Remote Desktop, the PC's clipboard text is copied to
    your laptop;
  - the browser asks once for permission to read the clipboard. If you refuse, only sync stops. The
    toolbar's **To PC** / **From PC** buttons copy by hand.
- Without full screen (if the browser refuses it) the mode still works in the window, but browser
  shortcuts and Esc stay on the laptop.

Remote Desktop sends everything you type to the PC, passwords included. Turn clipboard sync off if you keep
secrets on the laptop's clipboard.

## System

- **Info cards:** host name, user, Windows version, uptime, CPU model and load, memory, battery (on
  laptops), IP addresses, monitors.
- **Processes:** search, sort by memory / CPU / name, kill (confirmed).
- **Power:** lock, sleep, hibernate, sign out, restart, shut down, each confirmed. Restart and shut down
  wait 30 s and can be cancelled from the phone (*Cancel shutdown*) or with `shutdown /a` on the PC.
- **Clipboard:** read the PC's clipboard text to the phone, or send text to it.
- **Open on PC:** a URL, file, folder or program, opened with its default handler.

## Monitor: tray icon, dashboard, self-test

Two things tell you at a glance whether your phone can reach the PC. Both work only on this PC.

### Tray icon (TermPocket Monitor)

`scripts\install-autostart.ps1` starts it at logon (scheduled task "TermPocket Monitor"; `-NoMonitor`
skips it). Start it by hand with `scripts\start-monitor.cmd`. It checks the agent every 5 s and the public
address every 60 s (every 20 s while that fails).

| Dot | Meaning |
|---|---|
| **Green** | The agent runs and your phone can reach it. With the relay: it's connected and the public URL answers. The tooltip shows how many phones are connected. |
| **Amber** | The agent runs, but something on the way is broken: the relay is disconnected, the public URL doesn't answer, or the screen / keyboard helper crashed. Hover for the reason. |
| **Red** | The agent isn't running (or doesn't answer twice in a row). |
| Gray | Checking (just started). |

**Notifications** pop up when the agent stops or starts again; the relay is lost or restored; the public
URL stops or starts answering; a **new device** connects (an address not seen in the last 24 h — your own
phone reconnecting does not count); someone fails to pair (with the count and their IP address). The same
notification is never repeated within 30 s.

**Left-click** (or click a notification) opens the dashboard. **Right-click** menu: status lines (Agent,
Public, Phones, VS Code windows, Terminals host), **Open Monitor**, **Run self-test**, **Restart / Stop /
Start agent** (these end only the agent — terminals keep running in the terminals host), **Open log
file**, **Open pairing page**, **Open phone link**, **Exit monitor**.

`scripts\start-monitor.cmd -Once` prints the current state in the console instead (exit code 0 = green,
1 = amber, 2 = red; add `-Json` for JSON). The monitor's log is `%APPDATA%\TermPocket\monitor.log`. It never
reads the pairing token or the relay key.

### Dashboard

Open **http://127.0.0.1:8765/monitor** on the PC (or left-click the tray icon). It refreshes every 2 s:

- a banner: **ALL GOOD**, **DEGRADED** (with the reason) or **DOWN**, plus a 30-minute timeline;
- the agent (version, uptime, PID, address), public access (relay connected since, sessions, reconnects,
  last error), the terminals host, the Windows helper and security (failed logins, locked-out addresses);
- connected phones and laptops (IP, relay or direct, how long, which terminals they have open, whether
  they watch the screen), VS Code windows, terminals and screen streams;
- the last 200 log lines with level and text filters. Tokens and keys are removed from them.

### Self-test

**Run self-test** (dashboard or tray menu) does what a phone does, in at most 15 s:

1. the local agent answers `/healthz`;
2. a local WebSocket logs in with the real token and gets `sys.info` back;
3. the public address answers `/healthz` (with the relay: `pcOnline: true`);
4. a WebSocket to the **public** address logs in and gets `sys.info` back — the whole internet path.

Steps 3 and 4 are skipped when no relay or `publicUrl` is set. The self-test's connections are not listed
as phones.

## Autostart

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

- Registers a per-user scheduled task **TermPocket Agent** that starts the agent hidden at logon (in your
  desktop session, which screen capture and input need) and restarts it if it crashes.
- If the task can't be registered it falls back to a Startup-folder shortcut; `-StartupFolder` forces
  that. `-NoStart` only registers. `-NoMonitor` skips the tray icon.
- The log goes to `%APPDATA%\TermPocket\agent.log` (rotated at 5 MB).
- `scripts\uninstall-autostart.ps1` removes the autostart, closes the monitor and stops the agent and the
  terminals host (asking first while terminals still run). `-KeepTerminals` leaves the terminals host
  running, `-KeepRunning` leaves the agent running.

## Configuration

`%APPDATA%\TermPocket\config.json` (set `TERMPOCKET_HOME` to use a different folder):

| Key | Default | Meaning |
|---|---|---|
| `port` | `8765` | Agent port (env `TERMPOCKET_PORT`). |
| `host` | `127.0.0.1` | Bind address (env `TERMPOCKET_HOST`). Keep the loopback default when you use `tailscale serve`. |
| `token` | random | Pairing token. Delete the key and restart to generate a new one; this unpairs all phones. |
| `defaultShell` | `powershell.exe` | Shell for new terminals. |
| `scrollbackBytes` | `262144` | Scrollback kept per terminal for re-attaching. |
| `screen` | `{fps: 2, quality: 50, maxWidth: 1280}` | Default screen-stream settings. |
| `publicUrl` | – | Base URL used in the pairing link and QR (env `TERMPOCKET_PUBLIC_URL`). |
| `allowedHosts` | – | Extra host names (or URLs) you open the agent by, e.g. `["mypc.lan"]`. IP addresses, `localhost`, `*.ts.net`, this PC's name, `publicUrl` and the relay URL are always allowed. |
| `ptyHost` | `true` | `false` runs terminals inside the agent instead of the durable terminals host. |

`%APPDATA%\TermPocket\relay.json` enables the [self-hosted relay](relay.md).

The VS Code extension's settings are `termpocket.agentUrl`, `termpocket.configPath`,
`termpocket.liveBufferKB` and `termpocket.terminalSnapshot`. Put them in your **User** settings: VS Code
ignores them in workspace settings, so an opened project can't redirect the extension.

Logs: the agent's console, or `%APPDATA%\TermPocket\agent.log` when it runs from autostart. The terminals
host logs to `%APPDATA%\TermPocket\ptyhost.log`. `TERMPOCKET_DEBUG=1` turns on verbose logging.

## Bandwidth (screen streaming)

The screen view is the only part that uses a lot of data. Terminals, files and system info use very little.

| Preset | fps | JPEG quality | Width |
|---|---|---|---|
| Low | 1 | 35 | 960 px |
| **Medium** (phone default) | 2 | 50 | 1280 px (typically 20–80 KB per frame) |
| High | 4 | 65 | 1920 px |
| **HD** (laptop and Remote Desktop default) | 10 | 65 | 1920 px |

- Only changed frames are sent, plus one keep-alive frame every 5 s.
- At most 2 frames are in flight per client, so a slow link slows the stream instead of queueing it.
- Streaming stops when you leave the Screen tab or the app goes to the background.
- On mobile data, prefer Low.

**HD and Remote Desktop.** A full-HD frame is about 140–180 KB. When the picture changes all the time
(video, scrolling, a game), HD needs up to about **1.8 MB/s (≈ 15 Mbit/s)** at the full 10 fps. A mostly
still desktop (typing, code) needs a small fraction of that. Measured with two 1920×1080 monitors and a
video playing:

| Stream | fps | Data | Avg frame |
|---|---|---|---|
| HD, one 1920×1080 monitor | 10 | 1.4–1.8 MB/s | 140–180 KB |
| HD, All displays (3840×1080 scaled to 1920×540) | 10 | 1.1–1.3 MB/s | 110–127 KB |
| HD, still desktop (only the clock / a cursor blinks) | 0.2–1 | < 0.2 MB/s | – |

On hotel Wi-Fi or a phone hotspot, switch Remote Desktop to **High** or **Medium**; the latency in the
toolbar (`… ms`) tells you when the link is the bottleneck. **All displays** sends both monitors in one
frame at half the height each — less data than one full-HD monitor, but smaller text.

## Upgrading from VS Control

TermPocket was called VS Control before 1.0. Nothing needs to be paired again:

- **Settings and pairing:** on its first start the agent copies the settings from the old folder
  `%APPDATA%\VSControl` (`config.json` with the pairing token, `relay.json`) to `%APPDATA%\TermPocket`.
  The old folder is left alone; delete it when you no longer need it.
- **Autostart:** run `scripts\install-autostart.ps1` again. It stops and removes the old "VS Control
  Agent" / "VS Control Monitor" tasks and launchers and registers "TermPocket Agent" / "TermPocket Monitor".
- **VS Code extension:** install the new one (`termpocket.vsix`, ID `ehabmansour1.termpocket`) and
  uninstall the old one (`code --uninstall-extension vscontrol-local.vscontrol`). Old `vscontrol.*` user
  settings are still read, and a default terminal profile of "VS Control (mirrored)" becomes "TermPocket
  (mirrored)". Agent and extension must both be the new version (their handshake changed).
- **Phone / laptop app:** just reload it. It keeps its saved token and settings.
- **Environment variables:** `TERMPOCKET_*`; the old `VSCONTROL_*` names still work.
- Terminals that were running in the old version's terminals host keep running until they exit, but
  TermPocket starts its own host and does not show them.
