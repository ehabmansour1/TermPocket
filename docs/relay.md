# Self-hosting the TermPocket relay (optional)

**You do not need this if you use Tailscale**, which is the default and recommended way to reach your PC
(see [Connect your phone](../README.md#connect-your-phone)). The relay is for phones or laptops that can't
run Tailscale — a work laptop, a borrowed computer, a network that blocks VPNs. There is no hosted
TermPocket service: you run the relay yourself, on your own server and your own domain.

- [How it works](#how-it-works)
- [What you need](#what-you-need)
- [1. Get the relay and the app files](#1-get-the-relay-and-the-app-files)
- [2. Configure it](#2-configure-it)
- [3. Run it](#3-run-it) — [plain Node](#plain-node) · [systemd](#systemd) · [pm2](#pm2) · [Docker](#docker) · [shared hosting](#shared-hosting-with-a-reserved-port)
- [4. HTTPS reverse proxy](#4-https-reverse-proxy) — [Caddy](#caddy) · [nginx](#nginx)
- [5. Connect the PC](#5-connect-the-pc)
- [Updating](#updating)
- [Security notes](#security-notes)
- [Troubleshooting the relay](#troubleshooting-the-relay)

## How it works

```
 phone / laptop ──wss /ws──────────► relay on your server ◄──wss /agent (control)──── agent on your PC
                                           ▲                ◄──wss /agent/data?id=… ─┘ (one per client)
                                           │                                         │
                                 HTTPS reverse proxy                     local ws://127.0.0.1:8765/ws
                                 (Caddy, nginx, panel)
```

- The agent opens an **outbound** WebSocket (`/agent`) to the relay and keeps it open, so the PC needs no
  open port and no port forwarding.
- When a phone connects to `wss://pc.example.com/ws`, the relay asks the PC to open a data socket
  (`/agent/data?id=…`); the agent opens it plus a local connection to itself and splices the two. The relay
  splices the phone onto that data socket. Every client gets its own pair of sockets.
- The relay is a dumb, authenticated pipe. The PC proves itself with the **relay key**; phones still have
  to log in to the agent with the **pairing token**, exactly as over Tailscale. The relay itself never checks
  or stores the pairing token.
- The relay also serves the app's static files (`web/`), so loading the app does not use the PC's upload.
- TLS ends at your server's reverse proxy. That server can therefore see the traffic it carries, including
  the pairing token in each connection's first message. **Run the relay only on a server you control and
  trust.** (With Tailscale, no server sits in between.)

## What you need

- A server that can run **Node.js 20+** permanently: a small Linux VPS, a home server, or a shared host with
  a Node.js / reserved-port feature.
- A **domain or sub-domain** pointing at it, e.g. `pc.example.com`, with an **HTTPS certificate**
  (Let's Encrypt through Caddy, certbot, or your host's panel).
- A reverse proxy that forwards plain HTTP and **WebSocket upgrades** for `/ws`, `/agent` and
  `/agent/data` to the relay. The relay itself speaks plain HTTP on `127.0.0.1`.

## 1. Get the relay and the app files

```sh
git clone https://github.com/ehabmansour1/TermPocket.git
cd TermPocket

# the app needs its vendored libraries (xterm.js, Monaco) in web/vendor/
cd agent && npm install --ignore-scripts --no-fund --no-audit && node scripts/vendor.js && cd ..

# the relay and the app it serves
cd relay && npm install --omit=dev --no-fund --no-audit
cp -r ../web ./web                # or set WEB_ROOT to ../web
```

`web/vendor/` is not in git, which is why the `agent` step is needed. Simpler: the Windows release zip
(`TermPocket-<version>-win-x64.zip`) already contains `relay\` and a complete `web\` (with `vendor\`) —
upload both to the server, move `web` into `relay/`, and run `npm install --omit=dev` in `relay/`. Use the
same version as the agent on your PC.

## 2. Configure it

The relay reads its settings from the environment or from a `.env` file next to `server.js`
(`relay/.env`). Keep that file private (`chmod 600 .env`); it is ignored by git.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RELAY_KEY` | yes | – | Shared secret the PC presents. At least 32 characters; the relay refuses to start without it. |
| `PORT` | yes | – | The local port the relay listens on (the one your reverse proxy forwards to). |
| `HOST` | no | `127.0.0.1` | Listen address. Keep loopback when the proxy runs on the same machine. |
| `WEB_ROOT` | no | `./web` | Folder with the app's static files (relative to `relay/`). |
| `RELAY_ALLOW_INDEXING` | no | – | By default the relay serves `robots.txt` with `Disallow: /` and an `X-Robots-Tag: noindex` header on every response, so search engines never list your relay's address. Set to `1` to turn that off. |

Make a key:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`relay/.env`:

```ini
RELAY_KEY=<paste the key here>
PORT=8080
# HOST=127.0.0.1
# WEB_ROOT=./web
```

## 3. Run it

### Plain Node

```sh
cd relay
npm start            # = node server.js
```

It logs `TermPocket relay 1.0.0 on 127.0.0.1:8080, web …/relay/web`. Check it locally:

```sh
curl http://127.0.0.1:8080/healthz
# {"ok":true,"relay":"1.0.0","pcOnline":false}
```

Keep it running with one of the options below.

### systemd

`/etc/systemd/system/termpocket-relay.service` (adjust the user and paths):

```ini
[Unit]
Description=TermPocket relay
After=network-online.target
Wants=network-online.target

[Service]
User=termpocket
WorkingDirectory=/opt/TermPocket/relay
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# the relay reads relay/.env itself; EnvironmentFile works too:
# EnvironmentFile=/opt/TermPocket/relay/.env
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now termpocket-relay
journalctl -u termpocket-relay -f
```

### pm2

```sh
cd relay
pm2 start server.js --name termpocket-relay
pm2 save
pm2 startup          # prints the command that starts pm2 at boot
```

### Docker

There is no published image; build a tiny one yourself. `relay/Dockerfile`:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server.js ./
COPY web ./web
ENV HOST=127.0.0.1
USER node
CMD ["node", "server.js"]
```

```sh
cd relay
docker build -t termpocket-relay .
docker run -d --name termpocket-relay --restart unless-stopped \
  --network host --env-file .env termpocket-relay
```

Use `--network host` with the reverse proxy on the same machine. The relay trusts the client address in
`X-Forwarded-For` only when the proxy connects **from loopback**; behind Docker's bridge network (`-p
8080:8080`, `HOST=0.0.0.0`) every phone would appear with the proxy's address, so the per-address limits
(60 new connections a minute, 10 bad relay keys in 10 minutes) would count all clients together. If you
must use a bridge network, bind it to loopback only (`-p 127.0.0.1:8080:8080` with `HOST=0.0.0.0`) and
accept that trade-off.

### Shared hosting with a reserved port

Some shared hosts with a control panel let you run a Node.js process on a **reserved TCP port**
and put their own HTTPS proxy in front of it:

1. Reserve a port in the panel and set `PORT` in `relay/.env` to it. If the host requires the process to
   listen on a specific address instead of `127.0.0.1`, set `HOST` to that.
2. Create the (sub-)domain as a "proxy" / "Node.js" site that forwards to that port, and turn on its
   Let's Encrypt certificate in the panel. Make sure the proxy passes WebSocket upgrades.
3. Start the relay with the host's tools (its Node.js app manager, `pm2`, or a cron `@reboot` entry such as
   `@reboot cd ~/TermPocket/relay && node server.js >> relay.log 2>&1`).
4. If the host's proxy does not connect from `127.0.0.1`, the relay sees every client as the proxy's address
   (see the Docker note above): the limits then apply to all clients together.

## 4. HTTPS reverse proxy

The proxy must: terminate TLS for your domain, forward everything to `http://127.0.0.1:<PORT>`, pass
WebSocket upgrades, keep connections open for hours (the relay pings every 25 s, so a 60 s idle timeout is
enough), and append the client address to `X-Forwarded-For`.

### Caddy

Caddy gets and renews the certificate itself and handles WebSockets and `X-Forwarded-For` by default:

```caddy
pc.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name pc.example.com;

    ssl_certificate     /etc/letsencrypt/live/pc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pc.example.com/privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name pc.example.com;
    return 301 https://$host$request_uri;
}
```

Get the certificate with `sudo certbot --nginx -d pc.example.com` (or `certonly` and the paths above).

Check from anywhere:

```sh
curl https://pc.example.com/healthz
# {"ok":true,"relay":"1.0.0","pcOnline":false}
```

## 5. Connect the PC

Create `%APPDATA%\TermPocket\relay.json` on the PC:

```json
{ "url": "wss://pc.example.com", "key": "<the same RELAY_KEY>" }
```

- `url` must start with `wss://` (`ws://` only for local tests); `key` must be at least 32 characters.
- Restart the agent (tray icon → **Restart agent**). Its log says `connected to relay wss://pc.example.com`,
  `https://pc.example.com/healthz` now says `"pcOnline": true`, and the tray icon turns green.
- The pairing link and QR code (`http://127.0.0.1:8765/pair`) now use `https://pc.example.com`, unless you
  set `publicUrl` yourself. Pair your phone with that link and install the app from it.
- The agent accepts `pc.example.com` as a host name automatically (no `allowedHosts` entry needed).
- If `relay.json` is invalid, the dashboard (`http://127.0.0.1:8765/monitor`) and the tray show why.
- **Run self-test** from the tray: steps 3 and 4 go through the relay, the same path a phone takes.

You can use Tailscale and the relay at the same time: phones on the tailnet keep using the `*.ts.net`
address. To stop using the relay, delete `relay.json` and restart the agent.

## Updating

```sh
cd TermPocket && git pull
cd agent && npm install --ignore-scripts && node scripts/vendor.js && cd ..
rm -rf relay/web && cp -r web relay/web
cd relay && npm install --omit=dev && sudo systemctl restart termpocket-relay   # or pm2 restart / docker build + run
```

Keep `relay/web` at the same version as the agent on your PC.

## Security notes

- **`RELAY_KEY` lets a PC register with the relay; it gives no access to the PC.** Keep it secret anyway:
  with it, someone could take your PC's place on the relay (the newest PC connection replaces the old one)
  and receive your phones' connections — including the pairing token each phone sends first. The tray
  monitor turns amber when your PC loses the relay, and the agent reconnects (replacing the impostor in
  turn), but rotate the key and the token if you suspect it leaked.
- **The pairing token gives full control of the PC.** The relay only forwards it. Anyone who can read the
  relay's traffic (the server, its admin, its proxy) can read it: that is why the relay must run on a
  server you trust.
- **Rotate the relay key:** put a new `RELAY_KEY` in `relay/.env`, restart the relay, put the same key in
  `relay.json` on the PC, restart the agent.
- **Limits built into the relay:** at most 60 new client connections per address per minute, at most 32
  clients at once, 10 bad relay keys per address in 10 minutes, 16 MB per message, 4 MB buffered per client
  while the PC opens its side (15 s). The agent itself additionally locks out an address after 10 failed
  pairing attempts in 10 minutes — it sees the phone's real address, forwarded by the relay.
- The relay compares the key in constant time, serves only files inside `WEB_ROOT` (no dot-files, no path
  traversal) and sends `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and HSTS headers.
- Keep the relay process unprivileged (the systemd unit above), keep Node.js updated, and don't run other
  untrusted sites on the same domain.
- The tray monitor and the dashboard show whether the relay is connected and notify you when a **new
  device** connects through it or someone fails to pair.

More: [security.md](security.md).

## Troubleshooting the relay

| Symptom | Fix |
|---|---|
| Relay exits with `RELAY_KEY missing or too short` / `PORT missing` | `relay/.env` is missing, not next to `server.js`, or the key has fewer than 32 characters. |
| `/healthz` says `"pcOnline": false` | The PC is not connected: check `relay.json` (url, key), restart the agent, look at the dashboard's *Public access* card and `%APPDATA%\TermPocket\agent.log`. |
| Agent log: `401` / `bad relay key` in the relay log | The keys differ. Copy `RELAY_KEY` again (no quotes or spaces). After 10 bad keys the address waits 10 minutes (`429`). |
| The app loads but says offline / reconnecting forever | WebSocket upgrades don't reach the relay: check the proxy's `Upgrade` / `Connection` headers (nginx) and that `/ws` is not blocked. |
| Phone gets close code `4503 PC offline` | The relay runs but the PC isn't connected (see above). |
| Phone gets `4504 PC did not answer` | The PC did not open its data socket within 15 s: the PC is asleep or its connection is very slow. |
| Blank page or missing styles from the relay | `relay/web` is missing or has no `vendor/` folder (see step 1). |
| Connections drop after about a minute | The proxy's idle timeout is too short; set `proxy_read_timeout 3600s` (nginx) or the panel's equivalent. |
