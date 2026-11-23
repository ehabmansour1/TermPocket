// TermPocket relay (optional, self-hosted) — runs on a public server you control (a VPS or any host that
// can run Node.js behind an HTTPS reverse proxy) so phones/laptops can reach the PC without opening any
// port at home. Tailscale is the default way to connect; the relay is for devices without Tailscale.
//
//   phone/laptop ──wss /ws──► relay ◄──wss /agent (control)── the agent's relay client (agent/src/relayClient.js) ──► agent :8765/ws
//                                 ◄──wss /agent/data?id=…──┘ (one data socket per client)
//
// The relay is a dumb, authenticated pipe: every client connection is spliced 1:1 onto a data socket
// that the PC bridge opens on request, and the bridge splices that onto a fresh local /ws connection
// to the agent. The agent's own token auth (first message) still protects everything end to end.
// The relay additionally serves the PWA static files so they don't use the PC's upload bandwidth.
//
// Config (env or .env file next to this script):
//   RELAY_KEY   shared secret the PC bridge must present (required, ≥ 32 chars)
//   PORT        listen port (required; the port your reverse proxy forwards to)
//   HOST        listen address (default 127.0.0.1). The relay speaks plain HTTP/WebSocket: put an HTTPS
//               reverse proxy (nginx, Caddy, your host's web panel) in front of it for wss://
//   WEB_ROOT    static PWA dir (default ./web — copy the repository's web/ folder there)
//
// The PC side is configured in <agent config dir>/relay.json: { "url": "wss://pc.example.com", "key": "<RELAY_KEY>" }.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(HERE, '.env'));

const KEY = process.env.RELAY_KEY || '';
const PORT = Number(process.env.PORT || 0);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = path.resolve(HERE, process.env.WEB_ROOT || 'web');
const VERSION = '1.0.0';

if (KEY.length < 32) { console.error('RELAY_KEY missing or too short'); process.exit(1); }
if (!PORT) { console.error('PORT missing'); process.exit(1); }

const MAX_PAYLOAD = 16 * 1024 * 1024;
const PAIR_TIMEOUT_MS = 15_000;          // bridge must open the data socket within this
const MAX_PENDING_BYTES = 4 * 1024 * 1024; // client bytes buffered before the data socket exists
const HIGH_WATER = 8 * 1024 * 1024;      // pause the source when the destination buffers this much
const LOW_WATER = 1 * 1024 * 1024;
const MAX_CLIENTS = 32;
const CONN_RATE = { windowMs: 60_000, max: 60 }; // new client sockets per IP per minute
const AGENT_FAIL_RATE = { windowMs: 600_000, max: 10 };

const log = (lvl, ...a) => console.log(new Date().toISOString(), lvl, ...a);

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* optional */ }
}

function keyMatches(given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// The relay sits behind the host's reverse proxy, so the socket peer is the proxy. Trust only the
// LAST X-Forwarded-For hop (the one the proxy appended) and only when the peer is loopback: earlier
// hops are whatever the client sent and would let it pick its own rate-limit key.
function clientIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loop = peer === '127.0.0.1' || peer === '::1';
  const xff = req.headers['x-forwarded-for'];
  if (loop && typeof xff === 'string' && xff.trim()) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const xri = req.headers['x-real-ip'];
  if (loop && typeof xri === 'string' && xri.trim()) return xri.trim();
  return peer || 'unknown';
}

function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return {
    blocked(k) { const v = hits.get(k); return !!v && Date.now() - v.start <= windowMs && v.n >= max; },
    hit(k) {
      const now = Date.now();
      const v = hits.get(k);
      if (!v || now - v.start > windowMs) hits.set(k, { start: now, n: 1 }); else v.n++;
    },
  };
}
const connLimiter = makeLimiter(CONN_RATE);
const agentFailLimiter = makeLimiter(AGENT_FAIL_RATE);

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // A relay is a private door to someone's PC: keep it out of search engines and link previews.
  // Set RELAY_ALLOW_INDEXING=1 to opt out.
  if (process.env.RELAY_ALLOW_INDEXING !== '1') res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
}

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(s => s === '..' || s.startsWith('.'))) {
    res.writeHead(404).end('not found'); return;
  }
  const file = path.join(WEB_ROOT, pathname);
  if (!file.startsWith(WEB_ROOT + path.sep)) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', NO_CACHE.has(pathname) ? 'no-cache' : 'public, max-age=3600');
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
    res.writeHead(200, { 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- state

let agent = null;               // { ws, ip, since }
const pending = new Map();      // id -> { client, queue: [{data,isBinary}], bytes, timer }
let clientCount = 0;

function sendCtl(obj) {
  if (agent && agent.ws.readyState === 1) agent.ws.send(JSON.stringify(obj));
}

// Splice two sockets with simple back-pressure.
function splice(a, b, label) {
  const pump = (src, dst) => {
    src.on('message', (data, isBinary) => {
      if (dst.readyState !== 1) return;
      dst.send(data, { binary: isBinary });
      if (dst.bufferedAmount > HIGH_WATER && src._socket && !src._paused) {
        src._paused = true; src._socket.pause();
        const t = setInterval(() => {
          if (dst.readyState !== 1 || dst.bufferedAmount < LOW_WATER) {
            clearInterval(t); src._paused = false; if (src._socket) src._socket.resume();
          }
        }, 50);
      }
    });
  };
  pump(a, b); pump(b, a);
  const closeOther = (other) => (code, reason) => {
    if (other.readyState === 0 || other.readyState === 1) {
      const c = (code >= 3000 && code <= 4999) || code === 1000 ? code : 1000;
      try { other.close(c, reason); } catch { other.terminate(); }
    }
  };
  a.on('close', closeOther(b)); b.on('close', closeOther(a));
  a.on('error', () => {}); b.on('error', () => {});
  log('INFO', `spliced ${label}`);
}

// ---------------------------------------------------------------- servers

const server = http.createServer((req, res) => {
  securityHeaders(res);
  const url = req.url || '/';
  if (url === '/healthz' || url.startsWith('/healthz?')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, relay: VERSION, pcOnline: !!agent }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if ((url === '/robots.txt' || url.startsWith('/robots.txt?')) && process.env.RELAY_ALLOW_INDEXING !== '1') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(req.method === 'HEAD' ? undefined : ROBOTS_TXT);
    return;
  }
  serveStatic(req, res);
});

const wssClient = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const wssData = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req);
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };

  if (u.pathname === '/ws') {
    if (connLimiter.blocked(ip)) return reject(429, 'Too Many Requests');
    connLimiter.hit(ip);
    if (clientCount >= MAX_CLIENTS) return reject(503, 'Busy');
    wssClient.handleUpgrade(req, socket, head, ws => onClient(ws, req, ip));
    return;
  }
  if (u.pathname === '/agent' || u.pathname === '/agent/data') {
    if (agentFailLimiter.blocked(ip)) return reject(429, 'Too Many Requests');
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!keyMatches(given)) { agentFailLimiter.hit(ip); log('WARN', `bad relay key from ${ip}`); return reject(401, 'Unauthorized'); }
    if (u.pathname === '/agent') wssAgent.handleUpgrade(req, socket, head, ws => onAgent(ws, ip));
    else wssData.handleUpgrade(req, socket, head, ws => onData(ws, u.searchParams.get('id')));
    return;
  }
  reject(404, 'Not Found');
});

function onClient(ws, req, ip) {
  clientCount++;
  ws.on('close', () => { clientCount--; });
  if (!agent) { ws.close(4503, 'PC offline'); return; }
  const id = crypto.randomBytes(16).toString('base64url');
  const entry = { client: ws, queue: [], bytes: 0, timer: null };
  pending.set(id, entry);
  const onMsg = (data, isBinary) => {
    entry.bytes += data.length;
    if (entry.bytes > MAX_PENDING_BYTES) { ws.close(1009, 'too much data before PC answered'); return; }
    entry.queue.push({ data, isBinary });
  };
  entry.onMsg = onMsg;
  ws.on('message', onMsg);
  ws.on('close', () => { if (pending.get(id) === entry) { clearTimeout(entry.timer); pending.delete(id); sendCtl({ t: 'cancel', id }); } });
  ws.on('error', () => {});
  entry.timer = setTimeout(() => {
    if (pending.get(id) === entry) { pending.delete(id); ws.close(4504, 'PC did not answer'); }
  }, PAIR_TIMEOUT_MS);
  sendCtl({ t: 'open', id, ip, origin: req.headers.origin || '', ua: String(req.headers['user-agent'] || '').slice(0, 200) });
}

function onAgent(ws, ip) {
  if (agent) { log('INFO', 'new PC bridge replaces the old one'); try { agent.ws.close(4000, 'replaced'); } catch {} }
  const me = { ws, ip, since: Date.now(), alive: true };
  agent = me;
  log('INFO', `PC bridge connected from ${ip}`);
  ws.on('pong', () => { me.alive = true; });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m && m.t === 'ping') sendCtl({ t: 'pong', at: m.at });
  });
  ws.on('close', () => {
    if (agent === me) {
      agent = null;
      log('INFO', 'PC bridge disconnected');
      for (const [id, e] of pending) { clearTimeout(e.timer); e.client.close(4503, 'PC offline'); pending.delete(id); }
    }
  });
  ws.on('error', () => {});
  sendCtl({ t: 'hello', relay: VERSION });
}

function onData(ws, id) {
  const entry = id && pending.get(id);
  if (!entry) { ws.close(4404, 'unknown id'); return; }
  pending.delete(id);
  clearTimeout(entry.timer);
  const client = entry.client;
  client.off('message', entry.onMsg);
  if (client.readyState !== 1) { ws.close(1000); return; }
  for (const m of entry.queue) ws.send(m.data, { binary: m.isBinary });
  splice(client, ws, id.slice(0, 6));
}

// Keep-alive: proxies drop idle sockets; also reap dead ones.
setInterval(() => {
  for (const wss of [wssClient, wssAgent, wssData]) {
    for (const ws of wss.clients) {
      if (ws._dead) { ws.terminate(); continue; }
      ws._dead = true;
      ws.once('pong', () => { ws._dead = false; });
      try { ws.ping(); } catch {}
    }
  }
}, 25_000).unref();

server.listen(PORT, HOST, () => log('INFO', `TermPocket relay ${VERSION} on ${HOST}:${PORT}, web ${WEB_ROOT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('INFO', `${sig}, exiting`); process.exit(0); });
process.on('uncaughtException', (e) => log('ERROR', 'uncaught', e && e.stack || e));
