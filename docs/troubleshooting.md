# Troubleshooting TermPocket

Start with the **tray icon** (green / amber / red, hover for the reason) and the **dashboard** at
`http://127.0.0.1:8765/monitor` on the PC. **Run self-test** there checks the whole phone path step by step.

- [Pairing and connecting](#pairing-and-connecting)
- [Tailscale](#tailscale)
- [VS Code](#vs-code)
- [Terminals](#terminals)
- [Screen and Remote Desktop](#screen-and-remote-desktop)
- [Laptop browser](#laptop-browser)
- [Agent and autostart](#agent-and-autostart)
- [Relay](#relay)
- [Logs and reporting a bug](#logs-and-reporting-a-bug)

## Pairing and connecting

| Symptom | Fix |
|---|---|
| The phone shows the pairing screen again | The token changed or was mistyped. Open the pairing link again (`http://127.0.0.1:8765/pair` on the PC, or tray → *Open pairing page*). |
| "Offline / reconnecting" on the phone | Is Tailscale connected on **both** devices? Is the agent running (tray icon, or `http://127.0.0.1:8765/healthz` on the PC)? Run `tailscale serve status`. Then **Run self-test**. |
| Pairing fails with "too many attempts" / close code `4429` | 10 wrong tokens from that address in 10 minutes. Wait 10 minutes (or restart the agent) and use the current link. |
| Browser shows `421 Misdirected Request` | You opened the agent by a host name it doesn't know (DNS-rebinding protection). Use the `*.ts.net` name or the IP address, or add the name to `allowedHosts` in `config.json` and restart the agent. |
| `403` when opening a WebSocket | The page was served from another origin (another site or port). Open the app from the agent's own address. A reverse proxy in front of the agent must keep the original `Host` or send `X-Forwarded-Host`. |
| `/pair` says 404 | It only opens directly on the PC (`http://127.0.0.1:8765/pair`), never through Tailscale or the relay. |
| Can't install the app / no offline start | You opened `http://…`. Installing needs HTTPS: the `https://<pc>.<tailnet>.ts.net` address from `tailscale serve`, or your relay's `https://` address. |
| The QR code shows `http://127.0.0.1:8765` | The agent didn't find `tailscale serve`. Run `scripts\setup-tailscale.ps1`, then restart the agent — or set `"publicUrl"` in `config.json`. |

## Tailscale

| Symptom | Fix |
|---|---|
| `tailscale serve` fails | Turn on **MagicDNS** and **HTTPS Certificates** in the [admin console → DNS](https://login.tailscale.com/admin/dns), then run `scripts\setup-tailscale.ps1` again. If it prints a link to enable Serve, open it and approve. |
| "Tailscale is installed but not connected" | Open the Tailscale app on the PC and log in (or run `tailscale up`). |
| The phone can't open `*.ts.net` | Tailscale on the phone must be connected (VPN key icon) and signed in to the same tailnet. Check `tailscale status` on the PC lists the phone. |
| It worked, then stopped after a reboot | `tailscale serve --bg` persists; check `tailscale serve status`. If empty, run `scripts\setup-tailscale.ps1` again. |
| To undo the Tailscale setup | `scripts\setup-tailscale.ps1 -Off`. |

## VS Code

| Symptom | Fix |
|---|---|
| A VS Code window is missing on the phone | Check its status bar item (`TermPocket` = connected) and the **TermPocket** output channel. The extension reads `%APPDATA%\TermPocket\config.json`; set `termpocket.configPath` (user settings) if the agent uses another `TERMPOCKET_HOME`. |
| Status bar says the server "could not prove it is the TermPocket agent" | Something else answers on the agent port, or agent and extension are from different versions (VS Control vs TermPocket). Update both and restart the agent. |
| The phone says the extension is too old for a feature | Install the current `termpocket.vsix` and reload the VS Code window. |
| Source Control shows nothing | The window has no Git repository, Git is disabled, or it is a remote window (Git runs on the remote side). |
| Files open read-only | They are not valid UTF-8 (shown decoded as Windows-1252), or larger than 2 MB. |

## Terminals

| Symptom | Fix |
|---|---|
| Live view of a VS Code terminal says "typing only" or stays empty | Its output can't be read: no shell integration in that terminal (next row), or the program was started before the extension was watching (e.g. a terminal restored after a VS Code reload). Start the program again, or make new terminals phone-visible (mirrored). In many full-screen apps **Ctrl+L** (button in the note) or resizing the VS Code terminal panel makes them redraw. |
| No command history / exec falls back to "sent as text" | Shell integration isn't active. Windows PowerShell 5.1 blocks VS Code's (signed) shell-integration script under the default **Restricted** policy: run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use PowerShell 7 (`pwsh`), or a mirrored terminal. cmd.exe has no shell integration. |
| The terminal panel flashes on the PC when I open a terminal | That is the snapshot (VS Code's *Select All* + *Copy*, clipboard restored). Turn it off with `termpocket.terminalSnapshot: false`. |
| "terminal host is reconnecting; try again in a moment" | The agent is reconnecting to the terminals host; it takes a second or two. |
| Terminals ended when the agent restarted | The terminals host could not start (see `%APPDATA%\TermPocket\ptyhost.log` and the dashboard's *Terminals host* card), so the agent ran them in-process. Or `"ptyHost": false` / `TERMPOCKET_PTYHOST=inprocess` is set. |
| Garbled full-screen app after old output was trimmed | Press Ctrl+L in it, or resize the terminal. |

## Screen and Remote Desktop

| Symptom | Fix |
|---|---|
| Screen is black or frozen | A UAC prompt or the lock screen (the secure desktop) can't be captured. Streaming resumes after it closes. |
| Clicks or keys don't reach an app | Windows blocks input into apps running **as administrator** while the agent is not elevated (UIPI). |
| The stream is slow or laggy | Pick a lower preset (Medium / Low). The toolbar latency (`… ms`) tells you when the link is the bottleneck. |
| Win / Alt+Tab / Esc act on the laptop | Keyboard lock needs full screen, Chrome or Edge, and HTTPS. The toolbar shows *Keys locked* when it is active. |
| Clipboard doesn't sync | Needs HTTPS and the browser's clipboard permission (site settings → Clipboard). The toolbar's **To PC** / **From PC** buttons copy by hand. |
| Stuck key on the PC | Leave and re-enter Remote Desktop, or focus another window: the app releases every held key and button. |

## Laptop browser

| Symptom | Fix |
|---|---|
| Ctrl+Shift+T / Ctrl+Tab / Ctrl+W act on the browser | A normal tab keeps these. Install TermPocket as an app (install icon in the address bar), or use the **+** button. |
| The phone layout shows on a laptop | The desktop layout needs ≥ 900 px and a mouse or trackpad. Menu → **Layout** → *Desktop*. |
| The Code tab is a plain split view, not the workbench | Monaco is missing from `web/vendor/monaco` — run `npm install` in `agent/`. |

## Agent and autostart

| Symptom | Fix |
|---|---|
| "port 8765 is already in use" | Another agent is running (maybe the autostart one). Stop it (tray → *Stop agent*), or set `TERMPOCKET_PORT`. |
| "Node.js was not found on PATH" / "Node.js 20+ is required" | Install Node.js 20 or newer from nodejs.org (or use the release zip), then run the script again. |
| The scheduled task can't be created | `install-autostart.ps1` falls back to a Startup-folder shortcut by itself; `-StartupFolder` forces it. |
| Tray icon is amber: "helper" | The screen / input helper (PowerShell) crashed; it restarts on the next request. If it keeps failing, check the log; some security software blocks `Add-Type`. |
| Tray icon is amber but everything works | An older agent without `/status` is running: restart it. |
| Agent console window closed by accident | Use the autostart (hidden), or start it again with `scripts\start-agent.cmd`. |

## Relay

See [relay.md → Troubleshooting](relay.md#troubleshooting-the-relay).

## Logs and reporting a bug

- Agent: `%APPDATA%\TermPocket\agent.log` (autostart) or its console; `TERMPOCKET_DEBUG=1` for verbose logs.
- Terminals host: `%APPDATA%\TermPocket\ptyhost.log`. Tray monitor: `%APPDATA%\TermPocket\monitor.log`.
- VS Code: the **TermPocket** output channel.
- The dashboard shows the last 200 log lines with secrets removed.

When you [open an issue](https://github.com/ehabmansour1/TermPocket/issues/new/choose), include the versions,
what you did, what happened, and the relevant log lines. **Never paste your token, pairing link or relay
key** — the dashboard's log already hides them, raw files may not.
