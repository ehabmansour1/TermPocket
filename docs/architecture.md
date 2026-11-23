# TermPocket architecture

How the parts fit together. The exact messages are in [PROTOCOL.md](../PROTOCOL.md), the contract every
part follows.

## Overview

```
 Phone / laptop browser (installed PWA)                            Windows PC (your logon session)
 ┌──────────────────────────┐                     ┌──────────────────────────────────────────────────────────┐
 │ web/   vanilla JS, no    │  Tailscale tailnet  │ tailscale serve (HTTPS, *.ts.net cert)                   │
 │        build, no CDN     │ ══ HTTPS + WSS ═══► │        │                                                 │
 │ Terminals  (xterm.js)    │      /ws            │        ▼                                                 │
 │ Code       (Monaco wb)   │                     │ agent/  Node.js, ESM, 127.0.0.1:8765                     │
 │ Screen     (canvas)      │                     │   ├─ HTTP: app files, /healthz, /pair, /status, /monitor │
 │ System                   │                     │   ├─ /ws    phone RPC (token auth, rate limit)           │
 └──────────────────────────┘                     │   ├─ pty.js ──named pipe (HMAC)──► ptyhost.js            │
            │                                     │   │                       (durable ConPTY terminals)     │
            │ optional: wss to your relay         │   ├─ system.js / screen.js ──stdin/stdout──►             │
            ▼                                     │   │        one PowerShell process with C# (Add-Type)     │
 ┌──────────────────────────┐   outbound wss      │   │        screen capture, SendInput, clipboard, power   │
 │ relay/ on your server    │ ◄════════════════── │   ├─ relayClient.js (only with relay.json)               │
 │ (behind HTTPS proxy)     │   /agent + data      │   └─ /vscode hub ◄──ws (HMAC)── vscode-extension/       │
 └──────────────────────────┘                     │                                  (one per VS Code window)│
                                                  │ scripts/monitor-tray.ps1 ──/status──► tray icon          │
                                                  └──────────────────────────────────────────────────────────┘
```

## Components

### Agent (`agent/`)

Plain ESM JavaScript for Node.js 20+ (tested with 24), no build step. Few dependencies: `ws`,
`@lydell/node-pty` (prebuilt ConPTY binaries, no compiler), `qrcode-terminal`, and xterm.js / Monaco only
to vendor them into `web/vendor/`.

| Module | Role |
|---|---|
| `src/index.js` | Entry: config, server, pairing banner and QR, Tailscale detection, relay client, shutdown |
| `src/config.js` | `config.json` (created on first run), env overrides, migration from the pre-rename folder |
| `src/server.js` | HTTP static files, `/healthz`, `/pair`, `/status`, `/monitor`; WebSocket routing; Host / Origin checks; auth and rate limit; the RPC dispatch table |
| `src/rpc.js` | The JSON envelope: requests, responses, events |
| `src/pty.js` | Terminal sessions as the phone sees them — a client of the terminals host |
| `src/ptycore.js` | Session core: ConPTY processes, scrollback rings, metadata |
| `src/ptyhost.js` / `src/ptyhostClient.js` | The durable terminals host process, and connecting to / starting it |
| `src/vscodeHub.js` | Registry of VS Code windows; relays `vsc.call`; mirrored-terminal plumbing |
| `src/system.js` | `sys.info`, processes, power, clipboard, open |
| `src/screen.js` | Screen streaming with flow control, mouse and keyboard input |
| `src/winhelper.js` + `.ps1` / `.cs` | The long-lived PowerShell helper that compiles C# in memory |
| `src/relayClient.js` | Outbound bridge to the optional relay |
| `src/monitor.js`, `monitor/` | Self-test and the local dashboard |
| `src/demo.js`, `demo/` | Demo mode (made-up PC and desktop for screenshots) |

**Why a PowerShell helper and not a native exe?** Antivirus products block freshly compiled, unsigned
executables. One `powershell.exe -NoProfile` process loads C# with `Add-Type` (compiled in memory in about
250 ms) and serves JSON-line requests on stdin / stdout: screen grabs (about 60 ms for 1920×1080), JPEG
encoding, `SendInput`, clipboard, process and power calls. It starts on first use and restarts if it dies.

**Why the agent is not a service.** Screen capture and input injection need the interactive desktop
session, so the agent runs as you, started at logon by a per-user scheduled task.

### Terminals host (`agent/src/ptyhost.js`)

A separate, long-lived Node.js process that owns the shells (ConPTY), their scrollback and their metadata.
The agent connects to it over a per-user named pipe authenticated with a secret only your account can read
(HMAC challenge-response). When the agent starts it adopts every session the host has — same ids, same
scrollback — so terminals survive agent restarts, crashes and updates. On Windows the agent starts the host
through WMI, outside the scheduled task's job object, so stopping the task doesn't kill your terminals. The
host exits 10 minutes after its last terminal ended with no agent connected. If it can't be reached, the
agent runs the same session core in-process.

### VS Code extension (`vscode-extension/`)

Plain CommonJS, stable VS Code API only, a UI extension (runs on the local side, also in remote windows).
Every window opens its own connection to `ws://127.0.0.1:8765/vscode`, authenticates with the mutual
challenge-response, and then answers the agent's requests: workspace, files (`fs.*`), editors, diagnostics,
commands, Git (through the built-in Git extension's API), terminals.

- **Ordinary terminals** are read through shell integration (`execution.read()`); output goes into a ring
  per terminal and streams to phones that opened the Live view. Terminals that were never captured are
  shown with a snapshot (VS Code's own *Select All* + *Copy*, clipboard text restored).
- **Mirrored terminals** are agent sessions shown in VS Code through a `Pseudoterminal`; the profile
  *TermPocket (mirrored)* makes them the default.

### App (`web/`)

A PWA in vanilla ES modules and CSS: no framework, no build, no CDN. The agent serves it (or the relay, when
used). A service worker caches the app shell so it starts instantly and offline. The phone layout has four
bottom tabs; at ≥ 900 px with a mouse it switches to a desktop layout with a sidebar, terminal tabs, a VS
Code workbench (Monaco) and Remote Desktop mode. Binary JPEG frames are drawn on a `<canvas>` and acked one by
one (flow control). See [web/README.md](../web/README.md).

### Relay (`relay/`, optional)

A single-file Node.js server you can run on your own server: it serves the app's files and splices each
phone WebSocket onto a data socket the PC opens on request. It authenticates the PC with the relay key and
never sees anything but bytes; the agent's token check still applies end to end. See [relay.md](relay.md).

### Scripts (`scripts/`)

`install-autostart.ps1` / `uninstall-autostart.ps1` (scheduled tasks "TermPocket Agent" and "TermPocket
Monitor" with hidden launchers), `monitor-tray.ps1` (the tray icon: polls `/status`, notifications,
restart / stop / start, self-test), `setup-tailscale.ps1` (`tailscale serve --bg 8765`), `start-agent.cmd`,
`start-monitor.cmd`.

## Wire protocol in one minute

- **Envelope:** JSON text frames `{"t":"req","id":7,"m":"pty.create","p":{…}}`, responses
  `{"t":"res","id":7,"ok":true,"r":…}`, events `{"t":"evt","ev":"pty.data","p":{…}}`. Both sides can send
  requests. Binary frames carry screen JPEGs: `[0x01][u32 seq][u16 monitor][JPEG]`.
- **Phone socket `/ws`:** first message `auth {token}`, then `pty.*` (terminals), `vsc.windows` /
  `vsc.call` (anything the extension offers), `sys.*` / `proc.*` / `power` / `clip.*`, `screen.*` /
  `input.*`.
- **VS Code socket `/vscode`:** `hello.challenge` + `hello` (mutual HMAC), then the agent calls the
  extension's methods and the extension sends events (`terminals.changed`, `term.raw`, `editor.changed`,
  `diagnostics.changed`, `git.changed`, …), which the agent forwards to phones as `vsc.event`.
- **Screen:** at most 2 un-acked frames per client; unchanged frames are not sent; a keep-alive every 5 s.

## A request, end to end

Opening a file on the phone:

1. The app sends `vsc.call {windowId, m: "fs.read", p: {path}}` on `/ws`.
2. The agent finds that window's `/vscode` connection and sends it a request `fs.read {path}`.
3. The extension returns the editor's text if the file is open (unsaved edits included), else reads it from
   disk, detecting binary files and encodings.
4. The agent passes the result back as the response to step 1 (timeout 30 s; the extension always answers
   within its own deadlines).

Typing into a mirrored terminal on the phone: `pty.input {id, d}` → agent → terminals host (pipe) →
ConPTY. Output flows back as `data` events from the host → agent → `pty.data` to every attached phone and
`mirror.data` to the VS Code window showing it.

## Tests

`agent` and `vscode-extension` have `node:test` suites (the extension against a VS Code mock);
`web/tools/check-refs.mjs` checks the app statically; `e2e/` runs the real agent with dry-run input, an
isolated VS Code instance and headless Chrome. See [CONTRIBUTING.md](../CONTRIBUTING.md).
