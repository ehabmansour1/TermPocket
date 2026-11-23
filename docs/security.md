# TermPocket security model

TermPocket is remote control for your PC. Whoever holds the pairing token and can reach the agent can do
anything you can do on that PC. This page explains what protects it, what doesn't, and what you should do.
To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- [What you are protecting](#what-you-are-protecting)
- [The pieces and who can talk to them](#the-pieces-and-who-can-talk-to-them)
- [Defenses](#defenses)
- [What an attacker with the token can do](#what-an-attacker-with-the-token-can-do)
- [What is out of scope](#what-is-out-of-scope)
- [Do and don't](#do-and-dont)
- [Rotate the token (revoke every phone)](#rotate-the-token-revoke-every-phone)
- [If a phone is lost or stolen](#if-a-phone-is-lost-or-stolen)

## What you are protecting

| Secret | Where it lives | What it unlocks |
|---|---|---|
| **Pairing token** (32 random bytes, base64url) | `%APPDATA%\TermPocket\config.json` on the PC; the browser storage of each paired phone / laptop; the pairing link and QR code | **Everything:** terminals, files, VS Code, screen, keyboard and mouse, clipboard, processes, power |
| **Relay key** (`RELAY_KEY`, only with the optional relay) | `relay/.env` on your server; `%APPDATA%\TermPocket\relay.json` on the PC | Registering as "the PC" on your relay — not access to the PC |
| **Terminals host secret** | `%APPDATA%\TermPocket\ptyhost.json`, readable only by your Windows account | Talking to the terminals host on its named pipe |

## The pieces and who can talk to them

```
  your phone ──(Tailscale: WireGuard + HTTPS from tailscale serve)──► 127.0.0.1:8765  agent
  your phone ──(HTTPS to your relay)──► relay ◄──(outbound wss + relay key)── agent
  VS Code extension ──ws://127.0.0.1:8765/vscode (HMAC challenge-response)──► agent
  agent ──\\.\pipe\termpocket-ptyhost-… (HMAC challenge-response)──► terminals host
  tray monitor / dashboard ──http://127.0.0.1:8765/status, /monitor (loopback only)──► agent
```

- The agent **binds to `127.0.0.1`** by default. Nothing outside the PC can connect to it directly.
- **Tailscale** (`tailscale serve`, not `funnel`) proxies `https://<pc>.<tailnet>.ts.net` to it for
  devices on your tailnet only. Traffic between your devices is end-to-end encrypted by WireGuard.
- The optional **relay** is reached by an outbound connection from the agent; see
  [relay.md](relay.md#security-notes) for its own threat model (the relay server can read what it carries).

## Defenses

### Token authentication

- The first WebSocket message must be `auth` with the token, within **10 seconds**, or the socket is
  closed (`4401`).
- The token is compared in **constant time** (`crypto.timingSafeEqual`).
- **Rate limit:** 10 failed attempts in 10 minutes from one address → further connections from it are
  closed with `4429`. The limit is checked when the socket opens and again right before every token check,
  so many parallel sockets get no extra guesses. Clients behind `tailscale serve` or the relay are counted
  by their own forwarded address (only the hop the trusted local proxy appended counts, so a client can't
  pick its own key). The local VS Code extension has its own counter, so failed phone attempts never lock
  VS Code out.
- A wrong token or a rate-limit hit shows up in the dashboard and as a tray notification with the address.
- After pairing, the app removes the token from the address bar and keeps it in its own browser storage.

### Host check (DNS rebinding)

A malicious web page can re-point its own domain at `127.0.0.1` and make your browser talk to the agent.
The agent therefore answers only requests whose `Host` is an IP address, `localhost`, a `*.ts.net` name,
this PC's own name, the host of `publicUrl` (configured or detected from `tailscale serve`), the relay's
host, or a name in `allowedHosts`. Anything else gets **`421 Misdirected Request`** — not even `/pair`,
`/healthz` or a WebSocket upgrade.

### Origin check (cross-site WebSockets)

Browsers let any web page open a WebSocket to `127.0.0.1`. Every upgrade to `/ws` and `/vscode` carrying
a browser `Origin` must be same-origin with the request (or name one of the configured hosts above);
other sites, `null` origins and other local ports get **`403`** before any token check — so a hostile page
can't even burn your rate limit. Non-browser clients send no `Origin` and must still authenticate.

### VS Code extension: challenge-response, never the raw token

Whatever listens on the agent's port might not be the agent (for example a program that grabbed the port
while the agent was down). So the extension never sends the token:

1. The extension sends a random nonce; the agent answers with its own nonce and
   `HMAC-SHA256(token, "termpocket-agent\n" + extensionNonce + "\n" + agentNonce)`.
2. The extension checks that proof in constant time. If it is wrong it disconnects, sends nothing, and
   serves nothing from that window.
3. Only then does it send its own proof (`"termpocket-ext\n" + …`, the other direction). A wrong proof
   counts as a failed login.

The labels make the two proofs direction-specific, so neither can be reflected. The extension reads the
token from `config.json` on the same PC.

**Workspace settings can't redirect it.** `termpocket.agentUrl` and `termpocket.configPath` are
application-scoped: VS Code reads them from your **User** settings only, so a project's
`.vscode/settings.json` can't point the extension (and your files) at another server. The end-to-end tests
check this with a decoy server.

### Local-only pages

- `GET /pair` (the page with the token) is served only when the request comes from loopback, its `Host`
  is a loopback name, and it carries no proxy header (`X-Forwarded-For`, `Tailscale-User-Login`) — so
  neither a tailnet device through `tailscale serve`, nor the relay, nor a rebinding page can open it.
- `/status`, `/status/selftest` and `/monitor` follow the same rule, stricter (no `Forwarded`,
  `X-Real-IP`, `X-Forwarded-Host` or relay marker either), refuse requests from other sites (`Origin` /
  `Sec-Fetch-Site`), and the self-test needs a custom header (CSRF guard). The dashboard has a strict
  Content-Security-Policy (`default-src 'none'`, only its own scripts and styles).
- Log lines kept for the dashboard are **redacted**: the token, the relay key, `#token=` links,
  `?token=` / `?key=` values, `Bearer` values and JSON `token` / `key` fields become `[redacted]`.
- The tray monitor never reads the token or the relay key.

### Terminals host pipe

Durable terminals run in a separate process reached over a named pipe
(`\\.\pipe\termpocket-ptyhost-<hash of your user name and config folder>`). On start the host writes a
random secret to `ptyhost.json` and restricts that file to your Windows account (`icacls`). Agent and host
then prove to each other that they know the secret (HMAC challenge-response, as above, with their own
labels); the agent checks the host's proof first, so an impostor on the pipe learns nothing. Before
authentication a connection may send at most 4 KiB.

### The relay key

The relay requires `Authorization: Bearer <RELAY_KEY>` (≥ 32 characters, compared in constant time) for the
PC's sockets, with 10 failures per address per 10 minutes. Phones don't need the relay key — they still log
in to the agent with the pairing token, end to end. Details: [relay.md](relay.md#security-notes).

### The app

- Everything the PC sends is rendered as text (`textContent`, text nodes); terminal colours are applied as
  styles. No `innerHTML` with remote data.
- The app loads nothing from a CDN: xterm.js and Monaco are served by your own agent.
- Static responses carry `nosniff`, `no-referrer` and `X-Frame-Options: DENY`.

### Safety rails for actions

- Shutdown and restart wait 30 s and can be cancelled (`shutdown /a`); power actions, kill, delete and
  discard are confirmed in the app.
- Remote Desktop releases every held key and mouse button when the window loses focus, the tab is hidden,
  you leave the mode, or the connection drops.
- System calls use argument arrays (`execFile`), never a shell string built from your input.
- `TERMPOCKET_DRYRUN_INPUT=1` (and demo mode) turns every input and state-changing action into a log line —
  that is how the tests run.

## What an attacker with the token can do

Assume someone has your token **and** can reach the agent (they are on your tailnet, on your relay, or on
your LAN when you bound to `0.0.0.0`). They can, as your Windows account:

- open terminals and run any program — so read, change or delete anything your account can, and install
  software that runs as you;
- read and edit files through VS Code, run VS Code commands, commit with your Git identity;
- watch your screen, move the mouse, type, read and set the clipboard;
- list and kill processes, lock, sign out, sleep, hibernate, restart or shut down the PC.

They **cannot**, through TermPocket alone: act as administrator (Windows blocks input into elevated apps
from a non-elevated agent, and UAC prompts on the secure desktop can't be captured or clicked), read
`/pair` or the dashboard, or join your tailnet. A screen or a terminal they open is visible in the
dashboard and the tray shows new devices — but don't count on noticing in time.

So: **the token is as sensitive as your Windows password while you are logged in.**

## What is out of scope

- Malware already running as your Windows user: it can read `config.json` like any of your files.
  TermPocket does not try to protect you from yourself.
- Other administrators on the PC.
- A compromised phone or browser that holds the token.
- A relay server you don't control: it can read the traffic it carries. Use Tailscale, or your own server.
- Physical access to an unlocked PC.

## Do and don't

- ✅ Use **Tailscale** with `tailscale serve`. Keep `"host": "127.0.0.1"`.
- ✅ Treat the pairing link and QR code like a password; don't post screenshots of them.
- ✅ Keep Windows, Node.js, VS Code, Tailscale and TermPocket updated.
- ✅ Watch the tray icon's **new device** and **failed pairing** notifications.
- ✅ Turn Remote Desktop clipboard sync off if your laptop's clipboard holds secrets — and remember that
  Remote Desktop sends everything you type, passwords included, to the PC.
- ❌ **Never port-forward 8765** (or any port) to the agent on your router.
- ❌ Never use `tailscale funnel` for the agent — it publishes it to the whole internet.
- ❌ Don't set `"host": "0.0.0.0"` on untrusted networks (cafés, hotels, work): that exposes the agent over
  plain HTTP to everyone on that network.
- ❌ Don't put the agent behind your own public reverse proxy. If you use another name on a trusted
  network, add it to `allowedHosts`, and make sure the proxy keeps the original `Host` (or sends
  `X-Forwarded-Host`).

## Rotate the token (revoke every phone)

1. Open `%APPDATA%\TermPocket\config.json` and delete the `"token"` line (keep the JSON valid).
2. Restart the agent (tray icon → **Restart agent**, or `scripts\start-agent.cmd`). It writes a new random
   token. Terminals keep running in the terminals host.
3. VS Code windows reconnect by themselves — the extension re-reads `config.json`.
4. Pair your phones and laptops again from `http://127.0.0.1:8765/pair`. Every old pairing is dead.

Menu → **Forget this device** in the app only removes the token from that one browser; it does not revoke
anything.

To rotate the relay key, see [relay.md](relay.md#security-notes).

## If a phone is lost or stolen

1. [Rotate the token](#rotate-the-token-revoke-every-phone).
2. Remove the device from your tailnet in the [Tailscale admin console](https://login.tailscale.com/admin/machines).
3. If you use the relay and the phone could have seen `relay.json`'s key (it can't, normally — phones never
   get it), rotate the relay key too.
4. Look at the dashboard's security card and `%APPDATA%\TermPocket\agent.log` for connections you don't
   recognise.
