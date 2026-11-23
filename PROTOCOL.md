# TermPocket wire protocol

Architecture and wire protocol of TermPocket: the contract between the PC agent, the VS Code extension
and the phone / laptop app. Three components. **Every component MUST follow this file exactly.** If
something is ambiguous, pick the simplest behaviour consistent with it and note it in the component README.

> **Names.** TermPocket was called "VS Control" before 1.0. The wire protocol is unchanged; only names
> changed: config dir `%APPDATA%\TermPocket` (was `%APPDATA%\VSControl`, copied once on first start, §1),
> env `TERMPOCKET_*` (the old `VSCONTROL_*` names are still accepted), headers `X-TermPocket-*`, VS Code
> settings / commands `termpocket.*` (old `vscontrol.*` user settings are still read), terminal profile
> "TermPocket (mirrored)", handshake labels `termpocket-*` (§5.1, §7), PTY host pipe `termpocket-ptyhost-*`.
> An agent and an extension from before the rename do not authenticate each other (different labels):
> update both.

```
 Android phone (PWA in Chrome)                         Windows PC
 ┌──────────────────────┐   Tailscale (private VPN)    ┌──────────────────────────────────────────┐
 │  web/  (PWA)         │ ── https://<pc>.<tailnet>.ts.net ──► tailscale serve ─► agent :8765     │
 │  xterm.js terminals  │      WebSocket  /ws                 │  agent/ (Node.js 24, ESM, no build) │
 │  code / screen / sys │                                     │   ├─ PTY sessions (@lydell/node-pty)│
 └──────────────────────┘                                     │   ├─ system + screen (PowerShell)   │
                                                              │   └─ VS Code hub  /vscode  ◄────────┤
                                                              │  vscode-extension/ (1 per window)   │
                                                              └──────────────────────────────────────────┘
```

* `agent/`  — Node.js 24, plain ESM JavaScript (`"type":"module"`), **no build step**. Deps allowed:
  `ws`, `@lydell/node-pty` (prebuilt binaries — do NOT use `node-pty`, it needs a compiler), `qrcode-terminal`,
  `@xterm/xterm`, `@xterm/addon-fit` (only to vendor into `web/vendor/`). Nothing else without strong reason.
  Serves `web/` as static files, hosts the phone WebSocket `/ws` and the VS Code WebSocket `/vscode`.
* `vscode-extension/` — plain CommonJS JavaScript (no TypeScript, no bundler), `engines.vscode: ^1.93.0`.
  Uses only the stable VS Code API. Uses Node's global `WebSocket` if present, otherwise the bundled `ws` dep.
  Packaged with `npx @vscode/vsce package` into `vscode-extension/termpocket.vsix`.
* `web/` — the PWA. Vanilla JS ES modules + CSS, **no build step, no framework, no CDN** (everything served
  locally by the agent; phone may be on a slow link). xterm.js is vendored into `web/vendor/` by
  `agent`'s `npm run vendor` (also run in `postinstall`).

Design constraints (do not fight them):
* Antivirus products (Bitdefender, for one) block freshly compiled unsigned `.exe` files → **never
  compile/launch a custom exe**.
  Native Windows work (screen capture, mouse/keyboard injection) is done by ONE long‑lived
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -NoLogo -Command -` helper process that loads C# via
  `Add-Type` (in-memory, verified working: compile ≈250 ms, 1920×1080 grab ≈60 ms) and serves requests
  over stdin/stdout.
* Multi-monitor PCs are normal (e.g. two 1920×1080 monitors at x=0 and x=1920). Call
  `SetProcessDPIAware()` before using coordinates.
* A home PC's upload bandwidth is often limited: screen streaming defaults must be conservative
  (see §6) and only changed frames are sent.

---------------------------------------------------------------------------------------------------

## 1. Config & pairing

Config dir: `%APPDATA%\TermPocket\` (override with env `TERMPOCKET_HOME` — tests use this). One-time
migration: when `TERMPOCKET_HOME` / `VSCONTROL_HOME` is not set, the new dir has no `config.json` and
`%APPDATA%\VSControl\config.json` exists, the agent copies that dir's `*.json` files except `ptyhost.json`
(never overwriting) into the new dir before loading, so the pairing token and `relay.json` stay the same.
`config.json` (created on first run, pretty-printed):

```json
{
  "port": 8765,
  "host": "127.0.0.1",
  "token": "<32 random bytes, base64url>",
  "defaultShell": "powershell.exe",
  "scrollbackBytes": 262144,
  "screen": { "fps": 2, "quality": 50, "maxWidth": 1280 }
}
```

* Env overrides: `TERMPOCKET_PORT`, `TERMPOCKET_HOST`.
* `host` defaults to `127.0.0.1`; the recommended exposure is `tailscale serve --bg 8765`
  (gives `https://<pc>.<tailnet>.ts.net` with a real certificate → PWA installable, service worker works).
  Users may set `"host":"0.0.0.0"` to also reach it on `http://<tailscale-ip>:8765` / LAN.
* On start the agent prints the local URL, the pairing link `<url>/#token=<token>` and a terminal QR code
  of the pairing link (use `TERMPOCKET_PUBLIC_URL` env or `publicUrl` config key as the base if set,
  else `http://<host>:<port>`).
* `GET /pair` — **only when the request's remote address is loopback AND its `Host` is a loopback name
  (`127.0.0.1`, `localhost` or `[::1]`, any port) AND there is no `X-Forwarded-For` /
  `Tailscale-User-Login` header** (tailscale serve proxies from loopback, so the header check matters; the
  Host check defeats DNS rebinding, §1.1):
  returns an HTML page showing the pairing link + QR (QR may be rendered client-side by a tiny vendored
  generator or just show the link/text; keep it simple). Otherwise 404.
* The VS Code extension reads the token directly from `config.json` (same machine). Setting
  `termpocket.agentUrl` (default `ws://127.0.0.1:8765/vscode`) and `termpocket.configPath` override.
  The extension never sends the raw token: `/vscode` uses a mutual challenge-response (§5.1).
* Token comparison: constant-time (`crypto.timingSafeEqual` on equal-length buffers).
* Auth rate limit: max 10 failed auths / 10 min per key → further connections closed with code 4429.
  The limit is checked when the socket connects **and again right before every token/proof check** (so
  parallel sockets opened before the limit was reached get no extra guesses). Keys:
  - request from a loopback proxy (loopback peer with `X-Forwarded-For` or `Tailscale-User-Login`):
    `fwd:<last X-Forwarded-For hop>` — the LAST hop is the one the trusted proxy appended; earlier hops are
    client claims. Namespaced, so a forged/empty hop never shares a key with direct local clients;
  - direct loopback `/vscode` connection: `local:vscode` (nothing on the phone side can lock VS Code out);
  - anything else: the peer IP.
* Optional config key `allowedHosts`: extra host names (or URLs) this PC is reached by, see §1.1.

### 1.1 Host and Origin checks (DNS rebinding / cross-site WebSockets)

Every HTTP request and every WebSocket upgrade must carry a `Host` whose name is one of: an IP literal;
`localhost` / `*.localhost`; `*.ts.net` (Tailscale); this PC's own host name (or `<name>.local`); the host
of `publicUrl` (configured, or the detected tailscale serve URL); a name in `allowedHosts`; the host of the
relay bridge URL (`relay.json` next to `config.json`). Anything else → `421 Misdirected Request` (a page
whose own DNS name was re-pointed at 127.0.0.1 sends that name, so it gets nothing — not even `/pair`).

WebSocket upgrades (`/ws` and `/vscode`) additionally check `Origin`: absent (non-browser clients — the
VS Code extension, the relay bridge) is fine; a browser Origin must be same-origin with the request (equal
to the `Host`, or to `X-Forwarded-Host` when the peer is a loopback proxy) or name one of the configured
hosts above (`publicUrl`, `allowedHosts`, relay). Anything else (other sites, `null`, other local ports)
→ `403` before any auth is attempted, so cross-site pages cannot burn the auth rate limit either.

## 2. HTTP

* `GET /` and static files from `web/` (correct content types incl. `.webmanifest` →
  `application/manifest+json`, `.js` → `text/javascript`, `.svg`, `.png`, `.css`, `.woff2`). No directory
  listing, path traversal protected. `Cache-Control: no-cache` for `index.html`, `sw.js`,
  `manifest.webmanifest`; others may be cached.
* `GET /healthz` → `{"ok":true,"version":"…"}` (no auth).
* `GET /status`, `POST /status/selftest`, `GET /monitor` — the local monitor, see §2.1.
* Everything else is over WebSocket.

### 2.1 Local monitor (`/status`, `/status/selftest`, `/monitor`)

Used by the tray monitor (`scripts/monitor-tray.ps1`) and the dashboard page. **Loopback only**, the
`/pair` rule made stricter: the peer address is loopback AND the `Host` is a loopback name
(`127.0.0.1`, `localhost`, `[::1]`, any port) AND the request carries none of `X-Forwarded-For`,
`Forwarded`, `X-Real-IP`, `Tailscale-User-Login`, `X-Forwarded-Host`, `X-TermPocket-Via`.
Anything else → `404` (a Host that fails §1.1 still gets `421` first). A browser request from another
site (an `Origin` that is not this same `http://<loopback host>:<port>`, or `Sec-Fetch-Site` other than
`same-origin` / `none`) → `403`.

**`GET /status`** → JSON, `Cache-Control: no-store`:

```jsonc
{ "ok": true, "version": "0.1.0", "pid": 1234, "startedAt": 1795213474000, "uptimeSec": 61, "now": 1795213535000,
  "listen": { "host": "127.0.0.1", "port": 8765 },            // the address actually bound
  "publicUrl": "https://pc.example.com",                      // or null
  "relay": { "configured": true, "url": "wss://pc.example.com", "connected": true,
             "since": 1795213475000,                          // null while disconnected
             "sessions": 1, "lastError": null, "reconnects": 0 }, // lastError cleared on reconnect; never the key
  "phones": [ { "id": 1, "ip": "203.0.113.9", "client": "pwa", "via": "relay",   // or "direct"
                "connectedAt": 1795213477000, "attached": ["p1"], "streaming": false } ],
  "vscode": [ { "windowId": "…", "name": "my-project", "folders": ["e:\src\my-project"], "connectedAt": 1795213477000 } ],
  "terminals": [ { "id": "p1", "title": "pwsh", "pid": 4321, "exited": false, "mirror": false, "attachedClients": 1 } ],
  "screen": { "streams": 0 },
  "helper": { "running": true, "pid": 999, "restarts": 0, "lastError": null }, // the winhelper starts on demand
  "ptyHost": { "mode": "host", "running": true, "pid": 5555, "sessions": 2, "live": 1,  // §4.1 durable sessions
               "startedAt": 1795210000000, "adopted": 2, "reconnects": 0, "lastError": null },
  "security": { "authFailures": 0, "rateLimitedIps": 0, "lastAuthFailure": { "ip": "…", "at": 1795213400000 } }, // or null
  "log": [ { "at": 1795213474000, "level": "INFO", "scope": "relay", "msg": "connected to relay …" } ] // last 200
}
```

* `phones[].id` is the connection's sequence number; `via` is `relay` when the loopback relay bridge
  opened the socket (it adds `X-TermPocket-Via: relay`, trusted from a loopback peer only), else `direct`.
* `helper.lastError` is `"windows helper not available"` when the helper module could not load.
* `ptyHost` = where the terminals live (§4.1 Durable sessions). `mode:"host"`: in the separate PTY host
  process `pid` (`running` = the agent is connected to it right now; `false` while reconnecting);
  `mode:"inprocess"`: inside the agent (`pid` = the agent's, `running:true`) — because the host could not be
  reached (`lastError` says why) or it was turned off. `sessions` / `live` = sessions known / not exited;
  `startedAt` = the host's start (`null` in-process); `adopted` = sessions this agent took over from the
  host at start-up or after reconnecting; `reconnects` = host connections re-established.
  If `relay.json` exists but is invalid: `relay.configured: true, connected: false` and the reason in
  `relay.lastError`.
* Log lines are INFO/WARN/ERROR only, redacted when stored: the token, the relay key, `#token=` links,
  `?token=` / `?key=` values, `Bearer` values and JSON `"token"`/`"key"` fields become `[redacted]`. The
  final `/status` and self-test text is scrubbed of the token and relay key again before sending.
* Phone connections are logged at INFO, scope `server`:
  `phone connected: ip=<ip> via=<relay|direct> client=<client>` and `phone disconnected: ip=<ip> after <n>s`.

**`POST /status/selftest`** — also requires the header `X-TermPocket-Monitor: 1` (CSRF guard; without
it → `403`). Body ignored. One run at a time (concurrent callers share it), ≤ 15 s in total (budget
14.5 s). Returns `{ "ok": bool, "steps": [ { "name": "…", "ok": bool, "ms": n, "detail": "…" } ] }`:

1. local `GET /healthz`;
2. local WebSocket `/ws`: `auth` with the real token, then a `sys.info` round trip;
3. if `publicUrl` is set: `GET <publicUrl>/healthz` (must say `pcOnline: true` when the relay is configured);
4. WebSocket to `<publicUrl>/ws` with `Origin: <publicUrl>`, `auth`, `sys.info` — the real phone path end to end.

Without `publicUrl` steps 3–4 are replaced by one passing step "Public access: skipped". The self-test's
sockets authenticate with a one-time marker as `client` (issued and recognised by this process only),
so they are left out of `/status` `phones` and logged as `client=selftest` / `(self-test)`.

**`GET /monitor`** (and `/monitor/`, `/monitor/monitor.css`, `/monitor/monitor.js`, `/monitor/icon.svg`)
— the dashboard, served from `agent/monitor/` (a fixed file list, re-read per request) with
`Cache-Control: no-store` and a strict CSP (`default-src 'none'`; scripts, styles and fetches to
`'self'` only). It is not part of the PWA: `web/sw.js` bypasses `/status` and `/monitor` and never
caches them. It polls `/status` every 2 s.

## 3. WebSocket envelope (both `/ws` and `/vscode`)

All text frames are JSON. Both sides may send requests (symmetric RPC). Ids are per-sender integers.

| kind     | shape |
|----------|-------|
| request  | `{"t":"req","id":7,"m":"pty.create","p":{...}}` |
| response | `{"t":"res","id":7,"ok":true,"r":<any>}` or `{"t":"res","id":7,"ok":false,"e":"human message"}` |
| event    | `{"t":"evt","ev":"pty.data","p":{...}}` |

Binary frames (agent → phone only): byte 0 = type. `0x01` = screen frame:
`[0x01][u32 BE seq][u16 BE monitorIndex][...JPEG bytes]`.

Unknown method → `ok:false, e:"unknown method: <m>"`. Handler exceptions → `ok:false, e:err.message`.
Server pings every 25 s (ws ping); dead sockets terminated.

## 4. Phone socket `/ws`

First message MUST be `{"t":"req","id":1,"m":"auth","p":{"token":"…","client":"pwa"}}` within 10 s,
else close 4401. Wrong token → `ok:false,e:"bad token"` then close 4401. Success result:

```json
{ "version":"0.1.0", "hostname":"PC", "platform":"win32", "user":"…",
  "features":["pty","vscode","sys","screen","input"] }
```

### 4.1 PTY sessions (agent-owned, full interactive terminals)

Session object:
```json
{ "id":"p1", "title":"PowerShell", "shell":"powershell.exe", "cwd":"E:\\x", "cols":120, "rows":30,
  "pid":1234, "createdAt":1732100000000, "exited":false, "exitCode":null,
  "mirror": null | { "windowId":"…" } }
```

| method | params | result |
|---|---|---|
| `pty.list` | – | `Session[]` |
| `pty.create` | `{shell?, args?, cwd?, cols?, rows?, title?, vscodeWindowId?}` | `Session` (if `vscodeWindowId` → also opened as a mirrored terminal in that VS Code window, see §5.3) |
| `pty.attach` | `{id}` | `{session, buffer}` — `buffer` = scrollback string (≤ `scrollbackBytes`, trimmed from the front). After this the client receives `pty.data` for that id. |
| `pty.detach` | `{id}` | `true` |
| `pty.input` | `{id, d}` | `true` |
| `pty.resize` | `{id, cols, rows}` | `true` |
| `pty.kill` | `{id}` | `true` |
| `pty.rename` | `{id, title}` | `true` |

Events: `pty.data {id, d}` (only to attached clients and the mirroring VS Code window; batch output
every ≤16 ms per session), `pty.exit {id, exitCode}` (to all phones), `pty.changed {sessions: Session[]}`
(to all phones, on create/exit/kill/rename/resize). Exited sessions stay listed (with `exited:true`) until
killed/removed via `pty.kill`. Defaults: shell `config.defaultShell`, cwd = user home, 120×30.
Env for spawned shells: inherit `process.env` plus `TERM=xterm-256color`, `COLORTERM=truecolor`.

**Durable sessions (PTY host).** The processes, their scrollback rings and session metadata live in a
separate long-lived **PTY host** process (`agent/src/ptyhost.js`, protocol in §7.1), not in the agent, so a
terminal — e.g. a long Claude Code session — keeps running when the agent exits, crashes, is updated or is
restarted / stopped from the tray. The agent is a client of the host; the table above is unchanged:
* On start the agent connects to the host — starting it first if none runs (Windows: through WMI
  `Win32_Process.Create`, so it is outside the agent's job object, which `Stop-ScheduledTask` ends; fallback
  and elsewhere: `child_process.spawn` detached + `windowsHide`, `unref()`'d) — and **adopts** every
  session the host has: same ids, title, size, pid, scrollback (`pty.list` lists them, `pty.attach` returns
  the full scrollback incl. output produced while no agent was connected). New ids continue after the
  highest adopted one (ids never collide). Adopted sessions start with `mirror:null`; a VS Code window that
  still shows one re-binds it with `mirror.rebind` (§5.3).
* When the agent loses the host connection it reconnects (1 s → 10 s backoff) and re-adopts; meanwhile
  `pty.input` etc. fail with `terminal host is reconnecting; try again in a moment`. Sessions the host no
  longer has are reported as exited (`pty.exit`, `exitCode:null`) and dropped.
* If the host cannot be started / reached within 20 s, or the pipe's owner fails the authentication, the
  agent runs the same session core in-process (terminals then end with the agent); `/status` `ptyHost`
  says which (§2.1). `TERMPOCKET_PTYHOST=inprocess` (or `"ptyHost": false` in `config.json`) forces that.
* Agent shutdown only closes the pipe connection; it never ends host sessions. The host exits when it has
  had **no running sessions AND no agent connection for 10 minutes**, or on the authenticated `shutdown` op (used
  by `scripts/uninstall-autostart.ps1` and tests — that ends every session). The tray's Restart/Stop never
  touches it (§2.1, `scripts/monitor-tray.ps1`: only processes whose command line runs
  `agent\src\index.js`).

### 4.2 VS Code (relayed to an extension window)

| method | params | result |
|---|---|---|
| `vsc.windows` | – | `Window[]` where `Window = {windowId, name, folders:string[], vscodeVersion, focused, connectedAt}` |
| `vsc.call` | `{windowId, m, p}` | whatever the extension returns for method `m` (§5.2); timeout 30 s → error `"vscode timeout"`; unknown window → error `"vscode window not connected"` |

Events to phones: `vsc.windows {windows: Window[]}` on connect/disconnect/update; and every extension
event is forwarded as `vsc.event {windowId, ev, p}`.

### 4.3 System (`sys.*`, `proc.*`, `power`, `clip.*`)

| method | params | result |
|---|---|---|
| `sys.info` | – | `{hostname, user, os, release, arch, uptimeSec, cpuModel, cpuCount, cpuLoad /*0..100, sampled over ~0.5s*/, memTotal, memFree, battery: null \| {percent, charging}, ips: string[], monitors: Monitor[]}` |
| `proc.list` | `{sort?: "mem"\|"cpu"\|"name", limit?: number /*default 150*/}` | `[{pid, name, memMB, cpuSec, title}]` (title = main window title or "") |
| `proc.kill` | `{pid, force?}` | `true` |
| `power` | `{action: "lock"\|"sleep"\|"hibernate"\|"shutdown"\|"restart"\|"logoff"\|"cancel"}` | `true` (shutdown/restart use a 30 s delay `shutdown /s /t 30` so `cancel` = `shutdown /a` can abort; `hibernate` = `shutdown /h`, sent after the reply) |
| `clip.get` | – | `{text}` |
| `clip.set` | `{text}` | `true` |
| `sys.open` | `{target}` | `true` — opens a URL / file / folder / program with the default handler (`Start-Process`). |

### 4.4 Screen & input

`Monitor = {index, name, x, y, width, height, primary}` (physical pixels, virtual-desktop coordinates).

| method | params | result |
|---|---|---|
| `screen.monitors` | – | `Monitor[]` |
| `screen.start` | `{monitor?:0, fps?, quality?, maxWidth?}` | `{monitor: Monitor, fps, quality, maxWidth, stopped?: true}` — starts streaming binary frames to THIS client. Calling again updates settings. A `screen.stop` (or the socket closing) that arrives while the start is still resolving its monitor cancels it: no stream is created and the result has `stopped:true`. |
| `screen.ack` | `{seq}` | `true` — client rendered frame `seq`. Agent keeps ≤ 2 un-acked frames in flight per client (flow control); skips capture while blocked. |
| `screen.stop` | – | `true` (also automatic on socket close) |
| `screen.snapshot` | `{monitor?, quality?, maxWidth?}` | `{mime:"image/jpeg", data:"<base64>", width, height}` |
| `input.mouse` | `{monitor, x, y, action, button?, delta?}` — `x,y` normalized 0..1 within the monitor; `action`: `move`\|`click`\|`dblclick`\|`down`\|`up`\|`scroll`; `button`: `left`\|`right`\|`middle` (default left); `delta`: scroll wheel notches, +up/-down | `true` |
| `input.key` | `{key, mods?: ("ctrl"\|"alt"\|"shift"\|"win")[]}` — `key` is a name: `Enter, Escape, Tab, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, F1..F12, Insert, PrintScreen` or a single character `a`-`z`, `0`-`9` | `true` |
| `input.text` | `{text}` | `true` — types Unicode text via `SendInput` + `KEYEVENTF_UNICODE` (`\n` → Enter) |

Frame pipeline: capture monitor → if `maxWidth` < width, scale down (keep aspect, high-quality bilinear) →
compare with previous frame for that client's settings (cheap hash, e.g. sampled pixels or MD5 of bytes);
if unchanged, don't send (but re-check at the fps rate; send at least one frame every 5 s as keep-alive)
→ JPEG at `quality` → binary frame. Defaults from `config.screen` (fps 2, quality 50, maxWidth 1280).
Clamp: fps 0.2..10, quality 10..90, maxWidth 320..3840. Only capture while ≥1 client is streaming.

## 5. VS Code socket `/vscode` (extension ⇄ agent)

### 5.1 Handshake (mutual challenge-response — the raw token never goes on the wire)

Whatever listens on the agent port may not be the agent (e.g. another local user's process while the agent
is down), so the agent proves it knows the token first, and the extension then proves it too:

1. Extension → `{"t":"req","id":1,"m":"hello.challenge","p":{"nonce":"<cn>"}}` — `cn` = 32 random bytes,
   base64url (agent accepts 22–128 chars of `[A-Za-z0-9_-]`, else error + close 4401).
2. Agent → `{"t":"res","id":1,"ok":true,"r":{"nonce":"<sn>","proof":"<HMAC(token, "termpocket-agent\n"+cn+"\n"+sn)>"}}`
   (`sn` = 32 random bytes base64url; HMAC = HMAC-SHA256 keyed with the UTF-8 token, base64url).
3. Extension verifies the proof (constant time). If it is wrong it closes the socket, sends nothing else and
   reports "the server … could not prove it is the TermPocket agent" (retrying with the normal backoff).
4. Extension → `{"t":"req","id":2,"m":"hello","p":{"proof":"<HMAC(token, "termpocket-ext\n"+sn+"\n"+cn)>",
   "windowId","name","folders","vscodeVersion","pid"}}` → agent `ok:true, r:{version}`, or
   `ok:false,e:"bad token"` + close 4401 (counts as a failed auth, §1).

The two labels make the proofs direction-specific (no reflection). The whole handshake shares the 10 s auth
deadline. Until `hello` succeeded the extension answers any agent request with `ok:false,e:"not
authenticated"` and ignores events. For older extensions the agent still accepts a first `hello` carrying
`token` (raw); after a `hello.challenge` only a `proof` is accepted.
`windowId` = random UUID generated once per extension activation. After `hello` the extension may send
`{"t":"evt","ev":"window.update","p":{name,folders,focused}}` when folders/focus change.
Extension reconnects with backoff 1 s → 30 s max forever while VS Code is open; status bar item shows
`$(remote) TermPocket` (connected) / `$(debug-disconnect) TermPocket` (disconnected); clicking it shows a
quick pick: Reconnect / New mirrored terminal / Make new terminals phone-visible (§5.2 `settings.mirrorDefault`) /
Show pairing info (agent URL & config path).

### 5.2 Methods the agent calls on the extension (`vsc.call` relays `m` and `p` verbatim)

Every handler answers well inside the agent's 30 s `vsc.call` timeout: slow file systems, a hung provider or a slow git hook end in a clear error, never a silent hang.
Paths are absolute file-system paths (Windows style OK). Relative paths resolve against the first
workspace folder. Non-file documents are reported as Uri strings (`untitled:Untitled-1`,
`vscode-userdata:/c%3A/…/settings.json`, `git:/…`); any `scheme:` prefix of 2+ characters is parsed back
as a Uri. A result whose JSON frame would exceed 15 MB is answered with `ok:false, e:"result too large …"`
(the agent's socket limit is 16 MB and an oversized frame would drop the whole window connection).

| m | params | result |
|---|---|---|
| `workspace.info` | – | `{name, folders:[{name,path}], activeFile: string\|null}` |
| `terminals.list` | – | `[{tid, name, pid, hasShellIntegration, isMirror, ptyId, cwd: string\|null, active}]` — `tid` = stable string id the extension assigns per `vscode.Terminal` (WeakMap/Map) |
| `terminals.create` | `{name?, cwd?, mirror?: true}` | if `mirror` (default **true**): extension asks agent `pty.create` (§5.3) and returns `{tid, ptyId}`; else creates a normal `vscode.window.createTerminal` and returns `{tid}` |
| `terminals.sendText` | `{tid, text, addNewLine?: true}` | `true` |
| `terminals.exec` | `{tid, command}` | `{execId}` — uses `terminal.shellIntegration.executeCommand` if available, else `sendText` and returns `{execId:null}` |
| `terminals.history` | `{tid}` | `[{execId, commandLine, cwd, startedAt, endedAt, exitCode, output}]` (last 50 executions per terminal, `output` capped to 64 KB each, ANSI kept) |
| `terminals.show` | `{tid}` | `true` |
| `terminals.dispose` | `{tid}` | `true` |
| `terminals.attach` | `{tid, aid?, replaces?}` | `{tid, buffer, cols, rows, capturing, since, truncated, running, hasShellIntegration, isMirror, ptyId, aid, note?, snapshot?}` — `snapshot` (v0.5, see §5.2.1 Snapshot): `{text, cols, rows, lines, at}` = what the terminal shows right now, or `null` (not needed / turned off / failed); absent for mirrors and from older extensions. **Live view** of an ordinary terminal (§5.2.1): `buffer` = the terminal's raw output ring (ANSI kept), `cols`/`rows` = the VS Code terminal's size (`null` if unknown), `capturing` = output of this terminal can currently be read, `since` = ms timestamp the extension started watching it (`null` without shell integration / for mirrors), `truncated` = older output was dropped from the ring, `running` = a shell-integration execution is in progress, `note` = text to show the user when something is missing, `aid` = id of this attachment (the client's `aid` — a string of 1–64 chars — or one generated for a client that sent none; `null` for a mirror). Starts (or joins) the `term.raw` stream for `tid`; attaching again with an `aid` that is already attached, or with `replaces: <older aid>`, does not add a second attachment (§5.2.1 Lifetime). For a mirrored terminal nothing is streamed: `isMirror:true, ptyId, capturing:false, buffer:""` (use the agent PTY, §4.1) |
| `terminals.snapshot` | `{tid}` | `{text, cols, rows, lines, at}` (v0.5) — the terminal's current screen + scrollback as plain text (no colours; `\n` line ends; trailing spaces and trailing blank lines removed), `cols`/`rows` its size (`null` if unknown), `lines` = number of lines in `text`, `at` = ms timestamp. Works for any terminal, mirrored ones too. Errors: snapshots turned off (`termpocket.terminalSnapshot: false`), terminal closed, or it could not be taken in time (§5.2.1 Snapshot) |
| `terminals.detach` | `{tid, aid?}` | `true` — ends the attachment `aid` (without `aid`: one attachment of `tid`, preferably one that was attached without an `aid`); unknown/closed `tid` or unknown `aid` → still `true` |
| `terminals.keepalive` | `{tid, aid?}` | `{attached}` — renews the lease of attachment `aid` (without `aid`: of every attachment of `tid`); `attached:false` means it already expired → call `terminals.attach` again |
| `terminals.input` | `{tid, d, aid?}` | `true` — `terminal.sendText(d, false)`: raw keystrokes, nothing appended (`"\r"` = Enter, `"\x03"` = Ctrl+C, `"\x1b[A"` = ↑ …); also renews the lease of `aid` (without `aid`: of every attachment of `tid`) |
| `settings.get` | – | `{mirrorDefault, mirrorProfile, overriddenBy?}` — `mirrorDefault` = the USER setting `terminal.integrated.defaultProfile.<this OS>` names `mirrorProfile` (`"TermPocket (mirrored)"`, the profile this extension contributes, §5.3); `overriddenBy` = `"workspace"` / `"workspaceFolder"` when that window's workspace settings set a different value, which wins over the user setting there (never written by the extension) |
| `settings.mirrorDefault` | `{enable: boolean}` | `{enabled, overriddenBy?}` — sets (`enable:true`) or clears the USER-level (`ConfigurationTarget.Global`) `terminal.integrated.defaultProfile.windows` / `.osx` / `.linux` to `"TermPocket (mirrored)"`, so every NEW VS Code terminal is a mirrored one (full live view on the phone, §5.3). Existing terminals are not changed. Turning it off only clears values that still name the profile and restores the user's previous value. Same as the command **TermPocket: Make new terminals phone-visible (mirrored)** (`termpocket.mirrorDefault`) |
| `fs.list` | `{path?}` (default first workspace folder) | `{path, entries:[{name, type:"file"\|"dir"\|"symlink", size, mtime}], truncated?, total?}` dirs first, then alpha (numeric, case-insensitive). Always answers within 20 s: `size`/`mtime` stats still running after 3 s are abandoned (those entries keep `0`); more than 10 000 entries → the first 10 000 + `truncated:true, total`; no `path` in a window without a folder → error `this VS Code window has no folder open …` |
| `fs.read` | `{path}` | `{path, content, languageId, size, mtime, isDirty, truncated, binary, encoding?}` — if the doc is open in VS Code use the **document text** (unsaved edits); cap 2 MB; binary detection (NUL byte in first 8 KB) → `binary:true, content:""`. Files not open are decoded strictly: `encoding` = `"utf8"`, `"utf8bom"` (BOM not part of `content`) or `"windows-1252"` (not valid UTF-8: shown decoded as Windows-1252; clients treat it as read-only). Non-`file:` files (remote windows) over 2 MB are not read at all → `content:"", truncated:true`. |
| `fs.write` | `{path, content}` | `true` — if the document is open: replace full range via `WorkspaceEdit` then `document.save()` (an **untitled** document is only edited, never saved: that would open a Save As dialog on the PC); else `workspace.fs.writeFile` (creates file), keeping a UTF-8 BOM the file had; a file that is not UTF-8 (legacy code page / binary) is refused with an error instead of being re-encoded |
| `fs.search` | `{query, max?: 50}` | `string[]` absolute paths — `workspace.findFiles('**/*' + query + '*', '**/{node_modules,.git}/**', max)` (case as VS Code does); cancelled with a clear error after 20 s |
| `fs.stat` | `{path}` | `{path, exists:false}` or `{path, exists:true, type:"file"\|"dir"\|"symlink", size, mtime, ctime, readonly}` (v0.4) |
| `fs.mkdir` | `{path}` | `{path}` — new folder, parents created too; anything already at `path` → error `… already exists` (v0.4) |
| `fs.rename` | `{from, to, overwrite?: false}` | `{from, to}` — rename / move through a `WorkspaceEdit.renameFile` (open editors, dirty text included, follow the file; rename participants such as TypeScript's import updates run and may ask on the PC); falls back to `workspace.fs.rename` when the edit is refused. Errors: `from` missing, `to` exists (unless `overwrite`), `from` is or contains a workspace folder. A case-only rename is allowed (v0.4) |
| `fs.delete` | `{path, recursive?: false, useTrash?: true}` | `{path, trash}` — `workspace.fs.delete` to the OS trash by default; a non-empty folder needs `recursive:true` (error `… is a folder that is not empty: pass recursive:true`); a path that is or contains a workspace folder, or a drive / file-system root, is refused; when the trash is unavailable it errors instead of deleting permanently (pass `useTrash:false` for that) (v0.4) |
| `editor.open` | `{path, line?, column?, preview?}` | `true` — `showTextDocument` and reveal |
| `editor.tabs` | – | `[{label, path\|null, group, isActive, isDirty, isPinned}]` from `window.tabGroups` |
| `editor.active` | – | `{path, languageId, line, column, selectionText}` or `null` |
| `editor.save` | `{path?}` (omit → `workspace.saveAll(false)`) | `true`; an untitled document → error (it needs a file name chosen on the PC) |
| `editor.close` | `{path}` | `true`; a tab with unsaved changes → error (closing it would raise a modal "Save changes?" dialog on the PC) |
| `diagnostics.list` | `{path?}` | `[{path, severity:"error"\|"warning"\|"info"\|"hint", message, line, column, endLine, endColumn, source, code, tags?}]` (cap 500, most severe kept; 1-based line/column; `endLine`/`endColumn` = end of the range, exclusive like VS Code's — v0.4; `tags` ⊆ `["unnecessary","deprecated"]`, only when present) |
| `commands.list` | `{filter?}` | `string[]` (`vscode.commands.getCommands(true)` filtered, cap 300) |
| `commands.list` | `{withTitles: true, query?, max?: 300}` (v0.4; `filter` is accepted as an alias of `query`) | `[{id, title, category: string\|null, keybinding?}]` — what VS Code's Command Palette shows: titles/categories from every installed extension's `contributes.commands` (built-in ones included; commands hidden with `menus.commandPalette` `when:"false"` and unresolved `%nls%` titles are left out) plus a curated map of ~120 common built-in `workbench.action.*` / `editor.action.*` commands (listed only when registered in that VS Code). `keybinding` = default key in VS Code's display form (`"Ctrl+Shift+P"`, chords `"Ctrl+K Ctrl+S"`) from `contributes.keybindings` or the curated map — the user's `keybindings.json` is not visible to extensions. No `query`: sorted by `"Category: Title"`. With `query` (every whitespace-separated word must occur in the label or the id; title-prefix matches first), untitled internal commands are searchable too (`title` = id). `max` 1–5000. Older extensions ignore `withTitles` and answer `string[]`: clients accept both |
| `commands.run` | `{command, args?: any[]}` | `{result}` — result JSON-safe (try `JSON.parse(JSON.stringify(r))`, else `String(r)`) |
| `git.status` | – | `{available:false, reason, repos:[]}` (no Git extension in this window's extension host — e.g. a remote window —, `git.enabled:false`, still starting) or `{available:true, repos:[Repo]}`; `Repo = {root, branch: string\|null, detached, commit: string\|null, upstream: "remote/name"\|null, ahead: number\|null, behind: number\|null, message /*the SCM input box*/, changes: Change[], truncated?}`; `Change = {path, status:"M"\|"A"\|"D"\|"R"\|"C"\|"U"\|"!", staged: boolean, originalPath? /*R, C*/, conflict?: true /*status "!"*/}` in VS Code's group order: merge conflicts, staged (index), changes (working tree), untracked (`U`). A file both staged and modified appears twice (`staged:true` and `staged:false`). Cap 5000 changes per repository (`truncated:true`). Uses the built-in Git extension API (`vscode.git` `getAPI(1)`), activating it on first use. That extension only re-reads the repository while its window is focused, so in an unfocused window `git.status` first asks the repositories to refresh (at most every 2 s) (v0.4) |
| `git.show` | `{path, ref?: "HEAD"}` | `{path, ref, exists, content, binary, truncated}` — the file at `ref` (`repository.show`); `ref:"~"` = the index (staged) version. Not in `ref` (new / untracked file, no commits yet) → `exists:false, content:""`; NUL in the first 8 KB → `binary:true, content:""`; cap 2 MB (`truncated`) (v0.4) |
| `git.stage` | `{paths: string[]}` | `true` — `repository.add` (`git add -A -- paths`), grouped per repository; a path outside every open repository → error (v0.4) |
| `git.unstage` | `{paths: string[]}` | `true` — `repository.revert` (`git reset -q HEAD -- paths`: the API's "revert" unstages; the working tree is untouched) (v0.4) |
| `git.discard` | `{paths: string[]}` | `{discarded: string[], skipped: string[]}` — VS Code's **Discard Changes** (`repository.clean`): tracked files are restored from the index, untracked files are deleted (to the trash while `git.discardUntrackedChangesToTrash` is on, VS Code's default). Only paths with working-tree / untracked changes are touched; the others (e.g. only staged) come back in `skipped`. Irreversible for tracked files: clients confirm first (v0.4) |
| `git.commit` | `{message, all?: false, root?}` | `{root, commit /*new HEAD sha or null*/}` — `repository.commit(message.trim(), {all: all ? 'tracked' : false})` (`all` = `git add -u` first: changes to tracked files only, never untracked files); nothing staged (or, with `all`, no tracked change) → error; several repositories → pass `root` (else the only one with changes is used). Answers within 25 s even when hooks / signing are slow (the error says it may still complete) (v0.4) |

Events extension → agent (agent forwards to phones as `vsc.event {windowId, ev, p}`):

* `terminals.changed {terminals}` — on open/close/change of active terminal/shell-integration change
* `term.exec.start {tid, execId, commandLine, cwd}`
* `term.exec.data {tid, execId, d}` — streamed from `execution.read()` (batched ≤50 ms)
* `term.exec.end {tid, execId, exitCode}`
* `editor.changed {active, tabs}` — on active editor / tab changes (debounce 300 ms)
* `diagnostics.changed {errors, warnings}` — counts, debounce 1 s
* `term.raw {tid, d}` — raw output of an attached terminal (batched ≤30 ms, early flush at 256 K chars), §5.2.1
* `term.dims {tid, cols, rows}` — an attached terminal's VS Code size changed
* `term.detached {tid, aid, reason:"idle"}` — attachment `aid` of `tid` expired (no attach/keepalive/input for it for 10 min)
* `settings.changed {mirrorDefault, mirrorProfile}` — `settings.mirrorDefault` or the user changed the default profile
* `git.changed {available, repos:[{root, branch, ahead, behind, changes /*count*/}]}` — a repository's state changed (status, HEAD, index…) or a repository was opened / closed (debounce 500 ms); clients re-fetch `git.status`. Flows once the Git extension runs (the extension looks for it during the first minute after start-up, otherwise from the first `git.*` call). In an unfocused window, file changes in the workspace trigger such a refresh too (debounced 800 ms); a self-triggered refresh that changed nothing is not announced (v0.4)

`execId` = extension-assigned string. Shell-integration events: `window.onDidStartTerminalShellExecution`,
`window.onDidEndTerminalShellExecution`, `window.onDidChangeTerminalShellIntegration`
(guard each with `typeof … === 'function'`).

#### 5.2.1 Live view of ordinary VS Code terminals (`terminals.attach`, v0.3 addition, backwards compatible)

* **Source.** VS Code's stable API gives an extension a terminal's output only through shell integration:
  `execution.read()` of every `onDidStartTerminalShellExecution` (called synchronously inside the event —
  VS Code delivers only data that arrives after the first `read()`). The extension concatenates the output
  of all executions of a terminal, in arrival order, into a per-terminal raw ring (default 512 K UTF-16
  characters, user setting `termpocket.liveBufferKB`, 64–8192), trimmed from the front at a line start when
  one is near and never inside an ESC sequence or a surrogate pair. The prompt and keystrokes typed at the
  prompt are **not** readable (no stable API); instead a dim line `ESC[2m$ <commandLine>ESC[22m\r\n` is
  inserted before each execution's output. Inside a running program (e.g. a TUI such as Claude Code)
  everything it draws, including the echo of typed keys, is in the stream. `terminals.history` is
  unchanged (no synthetic lines).
* **Not capturable** (`capturing:false` + `note`): no shell integration in that terminal (cmd.exe, shell
  integration disabled, …); a terminal that was already open when the extension started (e.g. restored
  after a window reload) until the first execution is seen — a program that was already running then
  cannot be streamed until it is started again (its current screen is still shown, see Snapshot below). Mirrored terminals are always fully visible (§5.3),
  hence the "Make new terminals phone-visible" switch (`settings.mirrorDefault`).
* **Dims.** `cols`/`rows` come from `terminal.dimensions` (a stable getter; polled every second while
  attached) and `window.onDidChangeTerminalDimensions` where the host allows it (proposed API in stable VS
  Code — subscribing throws there, which is caught). Clients keep their xterm at exactly `cols`×`rows`
  (never resize the PC's terminal; scale the font instead) and apply `term.dims` as it comes. Output
  written before a size change is flushed before the `term.dims` event.
* **Streaming / ordering.** `term.raw` is sent only for tids with ≥1 active attachment (the agent forwards
  it to all phones as `vsc.event`). On `terminals.attach` the extension first flushes pending output to
  phones already attached, then snapshots the ring, so `buffer` + every `term.raw` received *after* the
  attach response = the exact stream. A client therefore ignores `term.raw` for a tid until its attach
  result arrived, writes `buffer`, then appends `term.raw`.
* **Lifetime.** Each attachment has an id `aid`, chosen by the client (a fresh random one per
  `terminals.attach` call; clients that send none get a generated one, and a `detach` without `aid` ends
  one of those first). The stream for a tid runs while it has ≥ 1 attachment. Each attachment has its own
  lease of **10 minutes**, renewed by `terminals.attach`, `terminals.keepalive {tid, aid}` and
  `terminals.input {…, aid}`; when it runs out that attachment is dropped and
  `term.detached {tid, aid, reason:"idle"}` is sent, so a phone that vanished without detaching (crash,
  lost network) stops costing bandwidth at the latest 10 minutes later, while phones that keep their
  leases are not affected. A client that keeps a live view open sends `terminals.keepalive {tid, aid}`
  every ≤ 4 minutes and re-attaches when it answers `attached:false` or a `term.detached` names its `aid`
  (or names none). A client whose own connection to the agent dropped does not know whether its
  attachment survived: it re-attaches with `replaces: <its previous aid>` (the old attachment is dropped,
  no second one is added), or — if the view is no longer on screen when it is back online — detaches that
  previous `aid`. Every attachment gets at most one `detach`. All attachments are dropped when the
  extension's agent connection goes down; clients re-attach after the window reconnects (new
  `connectedAt`). Clients detach when the view is closed, switched away from, or the page is hidden.
  At most 32 attachments per tid are kept (the least recently renewed one is dropped beyond that).
* **Input.** `terminals.input {tid, d}` → `sendText(d, false)`; xterm's `onData` can be forwarded verbatim.
* **Snapshot ("load it exactly as running", v0.5).** The stable API has no way to read a terminal's buffer,
  so for output that was never captured the extension uses VS Code's own terminal commands
  (`src/snapshot.js`): remember `window.activeTerminal`; read the clipboard text; write a unique marker to
  the clipboard (so "copy did nothing" is detected); `terminal.show(true)` (preserveFocus) and wait (≤ 400 ms)
  until it is the active terminal; `workbench.action.terminal.selectAll`;
  `workbench.action.terminal.copySelection`; read the clipboard; then always
  `workbench.action.terminal.clearSelection`, write the previous clipboard text back and re-show the
  previously active terminal with preserveFocus. Snapshots are serialized (one at a time — they share the
  clipboard and the active terminal), every step is time-limited (whole run ≈ 1.2 s at most), only the
  clipboard's TEXT is restored, and the terminal panel becomes visible on the PC while it runs. User
  setting `termpocket.terminalSnapshot` (default `true`) turns it off.
  Because only text can be restored, the extension first asks the agent `clipboard.info` (§5.3) and takes
  NO snapshot when the clipboard holds anything else (an image, copied files, rich text — `restorable:false`);
  against an agent without `clipboard.info` it also skips the snapshot when the clipboard text reads as empty
  (it may be an image). The attach then has `snapshot:null`.
  `terminals.attach` takes a snapshot automatically — BEFORE it starts the attachment — when the terminal
  is not a mirror and `capturing` is false or the ring holds fewer than 4096 characters, and returns it
  as `snapshot` (when `capturing` is false, `note` then explains that the view shows the screen as it was
  and cannot update by itself). A client that gets a `snapshot` writes its `text` (`\n` → `\r\n`, into
  a reset xterm) **instead of** `buffer` (the snapshot already contains what the ring holds), then appends
  the `term.raw` stream as usual. A `null` snapshot means the extension already tried: do not ask again
  with `terminals.snapshot`; only an attach result without the key (older extension) may be followed by
  a separate `terminals.snapshot`. A "No commands yet" history is never the primary view.

### 5.3 Mirrored terminals (one PTY, visible in VS Code AND on the phone)

The PTY lives in the agent; VS Code shows it through a `vscode.Pseudoterminal`.

* Agent → extension request `mirror.open {session, buffer}` → extension creates
  `vscode.window.createTerminal({name: session.title, pty, iconPath: new ThemeIcon('remote')})`, on
  `open` writes `buffer`, returns `{tid}`. (Sent by the agent when a phone calls `pty.create` with
  `vscodeWindowId`, or when the extension itself requested `pty.create`.)
* Agent → extension events `mirror.data {ptyId, d}` and `mirror.exit {ptyId, exitCode}` (extension writes
  `\r\n[process exited with code N]\r\n` and fires `onDidClose` after the user presses a key or 3 s…
  simplest: keep the terminal open showing the message; closing it is up to the user).
* Extension → agent events: `mirror.input {ptyId, d}`, `mirror.resize {ptyId, cols, rows}`,
  `mirror.closed {ptyId}` (user closed the VS Code terminal → agent kills the PTY).
* Extension → agent request `clipboard.info {}` → `{formats: string[], restorable}` (v0.5): the Windows
  clipboard's format names (from the windows helper; never its text) and whether a text-only restore is
  faithful (`restorable` = every format is text-like: `UnicodeText`, `Text`, `OEMText`, `Locale`,
  `System.String` or clipboard-history flags; an empty clipboard is restorable). Error `clipboard not
  available` without the windows helper. Used by the terminal snapshot (§5.2.1).
* Extension → agent request `pty.create {cwd, title, cols, rows}` (the agent treats it as
  `vscodeWindowId = this window`, spawns the PTY, then sends `mirror.open` back) → result `Session`.
  **Order guarantee:** the agent writes the `pty.create` response *before* that `mirror.open`. The extension
  binds its own pending (lazy) terminal only by the session id from the response; a `mirror.open` for an
  unknown session that arrives while its request is pending belongs to someone else (a phone's
  `pty.create`, `terminals.create`) and gets its own terminal. If the user closed the terminal before the
  response arrived, the extension sends `mirror.closed` and answers that session's `mirror.open` with
  `{tid:null}` (no terminal is re-created).
* Resize policy: the most recent `pty.resize`/`mirror.resize` wins.
* Agent disconnect (v0.5 — the PTYs live in the durable PTY host, §4.1, and survive the agent): the
  extension does NOT end its mirror terminals. Each running one gets a dim line
  `\r\n ESC[2m[TermPocket: reconnecting…]ESC[22m\r\n` and ignores input until it is re-bound (keystrokes typed
  meanwhile are dropped, never replayed later). Exited ones keep showing their exit line.
* Re-bind (v0.5): right after every successful `hello` (to the same or to a NEW agent process — the hello
  registers the window with that agent first) the extension sends the request
  `mirror.rebind {ptyIds: string[]}` with the `ptyId` of every mirror terminal it still has (running ones,
  exited ones, and terminals the user closed while the agent was unreachable). The agent answers
  `{sessions: [{ptyId, ok:true, session, buffer} | {ptyId, ok:false, gone, e}]}` (at most 200 ids; ids that
  are not strings are ignored): `ok` → that session is mirrored to this window again (`session.mirror =
  {windowId}`, `mirror.data` / `mirror.exit` flow from the reply on) and `buffer` = its scrollback at the
  moment of the reply; `gone:true` → no such session (the PTY ended / host restarted); `gone:false` → it
  exists but is shown by another window (`e:"shown in another VS Code window"`), or it is not a mirror of
  this window at all (`e:"not a mirrored terminal of this window"`: a phone's own terminal, or one mirrored
  elsewhere — only the window recorded in the session's `mirrorWindowId` may re-bind it), or another error.
  The extension then, per terminal: `ok` → write `ESC c ESC[3J` (full reset + clear scrollback) + `buffer`
  + any `mirror.data` for it that arrived while the request was in flight, so the VS Code terminal shows
  exactly what the PTY shows; state alive again (input flows, current size re-sent with `mirror.resize`),
  or the exit line if `session.exited`; not `ok` → `\r\n[process ended]\r\n` (or
  `\r\n[TermPocket: <e>]\r\n` when `gone:false`), terminal dead. Terminals closed while offline get
  `mirror.closed` after an `ok` re-bind (→ the agent kills the PTY). If the request fails the terminals stay
  "reconnecting" and are retried on the next connection. Against an older agent (`unknown method:
  mirror.rebind`) the old behaviour applies: `\r\n[TermPocket agent disconnected]\r\n`, terminal dead.
  The agent also accepts `mirror.rebind` from a window it already knew (its extension connection dropped,
  the agent did not restart) — the hub clears a window's mirrors when its socket closes.
* Extension contributes a terminal profile `termpocket.mirroredTerminal` ("TermPocket (mirrored)") via
  `window.registerTerminalProfileProvider` so the user can make every VS Code terminal phone-visible, and
  command `termpocket.newMirroredTerminal`. The profile provider returns `new vscode.TerminalProfile({name,
  pty})` with a pty that lazily requests `pty.create` on `open(dims)`.

## 6. PWA (`web/`)

* Files: `index.html`, `app.js` (entry), modules under `js/`, `styles.css`, `sw.js`,
  `manifest.webmanifest`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/maskable-512.png`,
  `icons/icon.svg`, `vendor/` (xterm, filled by agent's vendor script — reference
  `vendor/xterm.js`, `vendor/xterm.css`, `vendor/addon-fit.js`; these are the UMD builds from
  `@xterm/xterm/lib/xterm.js`, `@xterm/xterm/css/xterm.css`, `@xterm/addon-fit/lib/addon-fit.js`, exposing
  globals `Terminal` and `FitAddon.FitAddon`).
* Connects to `wss://` or `ws://` + `location.host` + `/ws`. Token from `#token=` (then stored in
  `localStorage` and removed from the URL) or entered on the pairing screen. Reconnect with backoff; on
  reconnect re-attach open PTYs and resume screen stream.
* Bottom tab bar: **Terminals · Code · Screen · System**. Mobile-first (360–430 px wide), dark theme
  default, large touch targets, safe-area insets, works in landscape.
* Terminals tab: list of agent PTY sessions (+ "New terminal", optional "open in VS Code window X") and,
  per connected VS Code window, its terminals. Agent PTYs open in a full xterm view with an extra-keys row
  (Esc, Tab, Ctrl (sticky), Alt (sticky), ↑ ↓ ← →, Home, End, PgUp, PgDn, `|` `~` `/` `-`, ^C), font
  size ±, fit-to-screen (sends `pty.resize`), and a "command line" input box (type → Send appends `\r`).
  Mirrored VS Code terminals (`isMirror` + `ptyId`) open that agent PTY view.
  **Non-mirrored VS Code terminals open the live view** (`js/vsterm.js`) with two tabs, **Live · History**:
  - *Live* (default): an xterm whose grid is pinned to the VS Code terminal's `cols`×`rows` (from
    `terminals.attach`, then `term.dims`; 120×30 while unknown) — the PWA never resizes the PC terminal.
    The font is scaled so the columns fit the pane (measured cell width, then corrected against the
    rendered width; capped at 15 px; rows are fitted too unless that would go below 9 px). Pinch (touch),
    Ctrl+wheel and ± zoom past it (the pane then scrolls both ways and follows the cursor while typing);
    "Fit" returns to fit mode. A manual font size is remembered per layout (`vstermFont.phone` / `.desk`).
  - Seeded with the `terminals.attach` `buffer` (written into a reset xterm), then every `term.raw` for
    the tid is written as it arrives. `term.raw` received while this view has no completed attach is
    ignored (the extension flushes pending output *before* taking the snapshot, so snapshot + later
    events = the stream).
  - Input: xterm `onData` (physical keyboard on desktop, IME / soft keyboard on phones), the shared
    extra-keys row (sticky Ctrl/Alt, `js/termkeys.js`, same as the PTY view) and the command-line box
    (text + `\r`) all go to `terminals.input {tid, d}` raw, coalesced per ~6 ms (against an older
    extension: `terminals.sendText` with `addNewLine:false`). Desktop: Ctrl+C copies when text is selected.
  - Attached only while the Live tab is really on screen: switching to History, to another deck tab or
    app tab, or the page being hidden → `terminals.detach` after a 2.5 s grace period; shown again,
    reconnected to the agent (with `replaces` = the attachment from before the drop), or the VS Code
    window reconnected (new `connectedAt`) → attach again. While attached: `terminals.keepalive
    {tid, aid}` every 4 min (`attached:false` → attach again); a `term.detached` for this view's `aid`
    while still on screen → attach again. Closing the view detaches at once. When
    `settings.mirrorDefault` answers `overriddenBy`, the toast says the window's workspace settings
    pick another default profile.
  - When `capturing` is false or nothing was captured yet, a dismissible banner shows `note` with
    **Make new terminals phone-visible** (`settings.mirrorDefault {enable:true}` + a toast that existing
    terminals stay ordinary while new ones are mirrored with full history) and a "Ctrl+L" (redraw)
    button; the title chip reads `live` / `typing only` / `connecting…` / `offline` / `closed`. Output
    that starts flowing later clears that state.
  - Against an extension without `terminals.attach` (`unknown method`) the view opens on History and
    the Live tab shows an "update the extension" banner.
  - *History*: the former "exec log" (`js/execlog.js`, without its own header here): `terminals.history`
    + live `term.exec.*` blocks per command with exit-code badges, a command input (`terminals.exec`) and
    raw "send text". The row menu of the terminal list also opens it directly ("Command history").
  The settings sheet has a **Phone-visible VS Code terminals** switch (`settings.get` → `mirrorDefault`,
  changed with `settings.mirrorDefault`, sent to the focused — else first — connected window); the row
  menu of an ordinary terminal and the live view's menu offer the same action. Phone and desktop layouts
  both use this view (desktop: a deck tab keyed `vst:<windowId>:<tid>`; the deck calls `onDeactivate`
  on the tab it hides).
* Code tab: choose VS Code window → file browser (`fs.list`, breadcrumbs), search (`fs.search`), file
  viewer/editor (monospace textarea with line numbers, Save → `fs.write`, "Open on PC" → `editor.open`),
  open tabs (`editor.tabs`), Problems (`diagnostics.list`), command runner (`commands.list` filter +
  `commands.run`), Save all.
* Screen tab: monitor picker, quality preset (Low: fps 1/q 35/w 960 · Medium: 2/50/1280 · High: 4/65/1920),
  `<canvas>` render from binary frames via `createImageBitmap(blob)`, ack after draw. Pinch-zoom & pan
  (view transform, not server side). Modes: "Touch" (tap = click, double-tap = dblclick, long-press =
  right click, two-finger vertical drag = scroll) and "Trackpad" (drag moves a pointer, tap clicks).
  Keyboard button opens a hidden input → `input.text`; special keys row → `input.key`; Ctrl/Alt/Win
  modifiers. Shows fps/KB/s estimate. Stops streaming when tab hidden (`visibilitychange`).
* System tab: info cards (`sys.info`, refresh), processes (`proc.list`, search, sort, kill with
  confirm), power buttons (confirm dialogs; cancel-shutdown button), clipboard (get → copy to phone,
  set from phone), "Open on PC" (URL/path → `sys.open`).
* `sw.js`: cache-first app shell (all static files incl. vendor) with versioned cache name; never cache
  `/ws` or `/healthz`. `manifest.webmanifest`: name "TermPocket", short_name "TermPocket",
  display `standalone`, `start_url` "./", theme/background colours, the icons above (incl. a
  `purpose:"maskable"` one).

## 7. Agent internal module layout (so several people can build it in parallel)

```
agent/
  package.json            name "termpocket-agent", type module, bin, scripts: start, vendor, postinstall, test
  src/index.js            entry: load config, start http+ws server, print pairing info, graceful shutdown
  src/legacyEnv.js        imported first by index.js / ptyhost.js: old VSCONTROL_* env names → TERMPOCKET_*
  src/config.js           load/create config, one-time migration of the pre-rename config dir (§1)
  src/demo.js             demo mode (§9): fake identity + a stand-in helper serving agent/demo/desktop-*.jpg
  src/rpc.js              envelope helpers: makeConn(ws) → {request(m,p,timeoutMs), notify(ev,p), onRequest(handler), onEvent(handler)}
  src/server.js           HTTP static + /healthz + /pair, WS upgrade routing (/ws, /vscode), auth, rate limit
  src/pty.js              PTY session manager (§4.1, §5.3 agent side) — client of the PTY host, same API
  src/ptycore.js          session core: ConPTY processes, scrollback rings, metadata (used by the host, or in-process)
  src/ptyhost.js          the long-lived PTY host process (§4.1 Durable sessions, §7.1); also `startPtyHost()` for tests
  src/ptyhostClient.js    connect/authenticate to the host, start it if needed, in-process fallback transport
  src/vscodeHub.js        extension connections registry, vsc.* relay, mirror plumbing (§4.2, §5)
  src/system.js           §4.3   ─┐  built by the "system/screen" owner
  src/screen.js           §4.4   ─┤
  src/winhelper.js        spawns & talks to the long-lived PowerShell helper (C# via Add-Type) ─┘
  src/winhelper.ps1 / .cs helper script(s) loaded by winhelper.js
  scripts/vendor.js       copy xterm UMD files into ../web/vendor/
  demo/                   demo desktop (desktop.html → desktop-1920x1080.jpg / desktop-1280x720.jpg, make-demo-desktop.mjs)
  test/*.mjs              node:test tests (node --test)
```

**Module contract between core (server/pty/vscodeHub) and system/screen:**

```js
// src/system.js
export function createSystemHandlers({ config, log, helper }) → {
  methods: { 'sys.info': async (params, client) => result, 'proc.list': …, 'proc.kill': …,
             'power': …, 'clip.get': …, 'clip.set': …, 'sys.open': … },
  onClientClose(client) {},          // optional
  async dispose() {}                 // optional
}
// src/screen.js
export function createScreenHandlers({ config, log, helper }) → {
  methods: { 'screen.monitors', 'screen.start', 'screen.ack', 'screen.stop', 'screen.snapshot',
             'input.mouse', 'input.key', 'input.text' },
  onClientClose(client),             // MUST stop that client's stream
  async dispose()
}
// src/winhelper.js
export function createWinHelper({ log }) → {
  call(op, args, { timeoutMs }) → Promise<result>   // JSON-line request/response to the PowerShell helper
  dispose()
}   // lazily started on first call, auto-restarted if it dies; queue/serialize or id-multiplex requests.
```

`client` (passed by server.js to every handler) is:
`{ id, remote, sendJson(obj), sendBinary(buffer), get bufferedAmount(), isOpen() }`.
server.js merges `methods` maps from pty, vscodeHub, system, screen into one dispatch table and calls every
`onClientClose(client)` when a phone socket closes.

Helper process I/O: requests are single JSON lines on stdin `{"id":1,"op":"grab","args":{…}}`;
responses are single JSON lines on stdout `{"id":1,"ok":true,"r":…}` / `{"id":1,"ok":false,"e":"…"}`.
Binary payloads (JPEG) travel as base64 inside the JSON line (local pipe — fine). Must run in the
interactive user session (the agent is started at logon, not as a service).

### 7.1 PTY host IPC (`ptyhost.js` ⇄ `pty.js`)

* **Process.** `node agent/src/ptyhost.js --pipe <pipe> --home <configDir> [--scrollback N] [--first-id N]
  [--idle-ms N]`, no console, cwd = user home, logs to `<configDir>\ptyhost.log` (rotated at 1 MB). Ignores
  SIGINT/SIGBREAK/SIGHUP and logs uncaught exceptions instead of exiting. A second host on a pipe that is
  already served exits at once (code 3); the agent then connects to the first one.
* **Pipe.** `\\.\pipe\termpocket-ptyhost-<16 hex>` — the hex = SHA-256 of `<user name lower-case>\n<config
  dir resolved, lower-case>`, so each Windows user, and each `TERMPOCKET_HOME` (tests), has its own host. Env
  `TERMPOCKET_PTYHOST_PIPE` overrides it (agent, tests, e2e). (Other OSes: a socket file in the temp dir.)
* **Secret.** On start the host writes `<configDir>\ptyhost.json` = `{pid, pipe, secret, startedAt, version,
  protocol}` (`secret` = 32 random bytes base64url), atomically, then restricts it to the current user
  (`icacls /inheritance:r /grant:r <user>:F`; `chmod 600` elsewhere). It is removed when the host shuts down
  (only if it still holds that host's secret). Nothing else ever shows the secret (the tray reads only `pid`).
* **Handshake** (JSON lines, `\n`-terminated; 5 s deadline; a bad first line closes the connection):
  ```
  client → {"op":"hello","nonce":cn}                         cn: 22–128 chars [A-Za-z0-9_-]
  host   → {"t":"hello","nonce":sn,"proof":HMAC(secret,"termpocket-ptyhost\n"+cn+"\n"+sn),"pid","protocol":1}
  client → {"op":"auth","proof":HMAC(secret,"termpocket-ptyclient\n"+sn+"\n"+cn)}
  host   → {"t":"ready","pid","version","protocol":1,"startedAt","sessions":[Meta…],"nextId"}
  ```
  HMAC = HMAC-SHA256 keyed with the secret string, base64url, compared in constant time. The client checks
  the host's proof first (an impostor on the pipe learns nothing and gets no requests); a wrong client proof
  closes the connection. The host subscribes the connection to events before it builds the `ready` list.
  Before authentication a connection may send at most 4 KiB without a line end. A host never overwrites a
  `ptyhost.json` that belongs to another live host on a different pipe (e.g. a test run that set
  `TERMPOCKET_PTYHOST_PIPE` but not `TERMPOCKET_HOME`): it refuses to start instead, so the real host stays
  reachable.
* **Requests** `{"id":n,"op":…,…args}` → `{"t":"res","id":n,"ok":true,"r":…}` / `{"t":"res","id":n,"ok":false,"e":"…"}`;
  a request without `id` gets no reply (used for `input`, `resize`, `meta`). Replies and events are written in
  the order they happen, so every `data` event sent before a `buffer` reply is part of that buffer.

  | op | args | result |
  |---|---|---|
  | `list` | – | `{sessions: Meta[], nextId}` |
  | `spawn` | `{shell, args, cwd, cols, rows, title, env, mirrorWindowId?}` | `Meta` (new id `p<nextId>`) |
  | `input` | `{sid, d}` | `true` (≤ 1 M chars; exited → error) |
  | `resize` | `{sid, cols, rows}` | `true` |
  | `kill` | `{sid}` | `true` — kills the process and removes the session (an `exit` event follows if it was running) |
  | `buffer` | `{sid}` | `{session: Meta, buffer}` — the scrollback ring (≤ `scrollbackBytes` UTF-8 bytes) |
  | `meta` | `{sid, title?, mirrorWindowId?: string\|null}` | `true` |
  | `status` | – | `{pid, startedAt, version, protocol, sessions, live, clients}` |
  | `shutdown` | – | `true`, then every session is killed and the host exits |

  `Meta = {id, title, shell, cwd, cols, rows, pid, createdAt, exited, exitCode, mirrorWindowId}`
  (`mirrorWindowId` = the window that last showed it — a hint only).
* **Events** `{"t":"evt","ev":…,"sid":…}`: `data {d}`, `exit {exitCode}`, `pid {pid}` (ConPTY reports the pid
  asynchronously), `meta {session: Meta}` (resize / rename), `removed {}` (an old exited session was pruned).
  Sent to every authenticated connection.
* **Lifetime.** The host exits after 10 min with no running sessions and no authenticated connection, or on
  `shutdown`. Exited sessions stay until `kill`ed (like §4.1), but at most the 32 most recent ones: older
  exited sessions are pruned (`removed` event; the agent drops them and broadcasts `pty.changed`).

---------------------------------------------------------------------------------------------------

## 8. Laptop / desktop browser support & "Remote Desktop" mode (v0.2 additions)

The same PWA must work great in a laptop browser (Chrome/Edge, installed as an app or in a tab).
All additions below are **backwards compatible**; existing methods keep working unchanged.

### 8.1 Input additions
* `input.keyraw {code, down}` — `code` is a DOM `KeyboardEvent.code` (`KeyA`…`KeyZ`, `Digit0`…`Digit9`,
  `F1`…`F24`, `Enter`, `Escape`, `Backspace`, `Tab`, `Space`, `Minus`, `Equal`, `BracketLeft`,
  `BracketRight`, `Backslash`, `IntlBackslash`, `Semicolon`, `Quote`, `Backquote`, `Comma`, `Period`, `Slash`,
  `CapsLock`, `ShiftLeft/Right`, `ControlLeft/Right`, `AltLeft/Right`, `MetaLeft/Right`, `ContextMenu`,
  `Insert`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp/Down/Left/Right`, `PrintScreen`,
  `ScrollLock`, `Pause`, `NumLock`, `Numpad0`…`Numpad9`, `NumpadAdd/Subtract/Multiply/Divide/Decimal/Enter`,
  `AudioVolumeMute/Down/Up`, `MediaPlayPause/TrackNext/TrackPrevious/Stop`). The agent maps it to the
  virtual-key + hardware scan code and sends a single key-down or key-up via `SendInput`
  (`KEYEVENTF_SCANCODE` with `KEYEVENTF_EXTENDEDKEY` for extended keys, so the PC's own keyboard layout
  applies — like RDP). Unknown code → error `"unknown key code: X"`. Result `true`.
  The agent tracks which keys/buttons each client holds down.
* `input.releaseAll {}` — releases every key and mouse button this client currently holds (sent by the
  client on blur / visibility change / leaving RDP mode). Also done automatically when the client's
  socket closes or its stream stops. Result `true`. Input of one client runs strictly in order; the
  automatic release is queued *behind* that client's pending input, and once the socket has closed any
  input still queued for it is dropped (a queued key-down never runs after the close).
* `input.mouse` additions: `deltaX` (horizontal wheel notches, +right) for `action:"scroll"` — a scroll carries
  `delta`, `deltaX` or both (at least one);
  `monitor: -1` means the whole virtual desktop (see 8.2). `x`,`y` may be fractional; clamp 0..1.
* In DRY RUN mode (§4.4 rules) the new methods also only log + record.

### 8.2 Screen additions
* `monitor: -1` (for `screen.start`, `screen.snapshot`, `input.mouse`) = the full virtual desktop
  (bounding box of all monitors). In the binary frame header (§3) it is encoded as u16 `0xFFFF`.
  `screen.monitors` is unchanged (real monitors only).
* `screen.start` accepts `fps` up to **15** (clamp 0.2..15) and `maxWidth` up to 3840 (all monitors).
* Before every binary frame the agent sends a JSON event to that client:
  `screen.meta {seq, monitor, width, height, cursor: {x, y, visible} | null}` — cursor normalized 0..1
  within the captured area; `null` when the pointer is outside the captured area, `visible:false` when it
  is inside but hidden. The client draws its own cursor marker
  (the capture does not include the mouse pointer). While flow control holds frames back the agent may
  send pointer-only metas (same `seq` as the last frame, no binary; the client only moves its marker
  and does not ack them) — but only once a frame for the
  current settings has been sent (after a monitor switch the old picture is still shown), and with the
  pointer resolved against the monitor's current rectangle (display changes).
* New preset in the client: **HD** (fps 10, quality 65, maxWidth 1920). Flow control (≤2 frames in flight)
  stays — it is what keeps a slow link usable.

### 8.3 PWA desktop layout (≥ 900 px wide, pointer: fine)
* Left sidebar navigation (Terminals · Code · Screen · System + connection status + host) replaces the
  bottom tab bar; content uses the width: Terminals = session list + terminal side-by-side with terminal
  tabs (several open terminals, Ctrl+Shift+T new, middle-click/close button), Code = file tree + editor
  (+ problems/tabs/commands panel), System = multi-column grid. Phone layout (< 900 px) unchanged.
* Physical keyboard works directly in xterm (no extra-keys row needed on desktop; keep it collapsible).
* **Remote Desktop mode** (Screen tab, button "Remote Desktop" / shortcut): the canvas fills the
  window (Fullscreen API) and behaves like an RDP client:
  - real mouse: `pointermove` (throttled ~30/s, coalesced) → `input.mouse move`; `pointerdown/up` per
    button → `down`/`up` (so drag & drop, selection work); `dblclick` handled by the OS from two clicks
    (don't synthesize); `wheel` → `scroll` with `delta`/`deltaX` (a classic wheel tick — `wheelDelta` a
    non-zero multiple of 120 — is exactly `wheelDelta/120` notches whatever the OS lines-per-notch or page
    zoom; other deltas are accumulated, 120px = 1 notch, for trackpad smooth scroll); context menu
    suppressed; local cursor hidden over the canvas when a remote cursor marker is drawn (option);
  - full keyboard capture: `keydown`/`keyup` → `input.keyraw` with `preventDefault()` (so Ctrl+W, Ctrl+T,
    Tab, F5, Alt+F4 etc. go to the PC); when in fullscreen call `navigator.keyboard.lock()` (if available)
    so Win, Alt+Tab, Esc are captured too (hold Esc to exit — Chrome's own UI); on `blur` /
    `visibilitychange` send `input.releaseAll`;
  - letterboxed aspect-fit with optional 1:1 / fit-width toggle; monitor picker incl. "All displays"
    (monitor -1); HD preset; live stats (fps, KB/s, latency = time from frame receive to ack);
  - clipboard sync (secure context only): when the RDP view gains focus and local clipboard text differs
    from what we last synced, `clip.set` it; after the user presses Ctrl+C / Ctrl+X in RDP mode, wait
    ~300 ms then `clip.get` and write it to the local clipboard with `navigator.clipboard.writeText`.
    Toggle in settings; never block if the permission is denied;
  - a small auto-hiding toolbar at the top (exit, monitor, quality, send Ctrl+Alt+Del is NOT possible —
    instead offer "Ctrl+Shift+Esc (Task Manager)", "Win", "Alt+Tab" buttons, clipboard, keyboard-lock
    status).
* Touch devices keep the existing touch/trackpad modes; Remote Desktop mode is offered on desktops
  (pointer: fine) but may also be used on a tablet with a hardware keyboard.

---------------------------------------------------------------------------------------------------

## 9. Demo mode (`TERMPOCKET_DEMO=1`)

For screenshots, videos and docs. The wire protocol is unchanged; only what the agent reports differs:

* `auth` result and `sys.info`: `hostname` = `"DEV-PC"`, `user` = `"you"`, `ips` =
  `["100.101.102.103", "10.0.0.24"]`.
* The Windows helper is replaced by a stand-in (`src/demo.js`): one 1920×1080 monitor; `screen.start` /
  `screen.snapshot` deliver the bundled synthetic desktop `agent/demo/desktop-<w>x<h>.jpg` (the widest one
  not wider than `maxWidth`; the frame never changes, so streams send only keep-alive frames); a fixed
  pointer position; sample `proc.list`, battery and clipboard-format results. The real screen, clipboard
  and process list are never read.
* Input and actions are **always dry-run** (as with `TERMPOCKET_DRYRUN_INPUT=1`): `input.*`, `power`,
  `clip.set`, `sys.open`, `proc.kill` are only recorded.
* `TERMPOCKET_DEMO_CWD`: default working directory of new terminals (instead of the user's home), so
  prompts show a sample project. Terminals, files and VS Code otherwise stay real.
