// HTTP + WebSocket server (PROTOCOL.md §1–§4, §7).
//
//  * static files from ../../web (resolved relative to this module), /healthz, loopback-only /pair
//  * WebSocket upgrade routing: /ws (phones) and /vscode (extension windows)
//  * first-message auth (10 s), constant-time token compare, per-IP failed-auth rate limit (4429)
//  * ws ping every 25 s, phone `client` objects (§7), merged dispatch table, onClientClose fan-out

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { makeConn, parseFrame } from './rpc.js';
import { DEMO_IDENTITY, isDemo } from './demo.js';
import { createSelftestMarkers, monitorAsset, MONITOR_CSP, readMonitorFile, redactSecrets, runSelftest } from './monitor.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const VERSION = pkg.version;
export const DEFAULT_WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const RATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_RATE_LIMITED = 4429;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Files that must always be revalidated so PWA updates are picked up promptly (§2). */
const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
/** Rarely-changing folders that may be cached by the browser for a day. */
const LONG_CACHE_DIRS = new Set(['vendor', 'icons']);

// ------------------------------------------------------------------------------------------------
// Phone registry: shared by pty / vscodeHub to reach all authenticated phones.
// ------------------------------------------------------------------------------------------------

/** Registry of authenticated phone clients; `broadcast` sends an event to all of them. */
export function createPhoneRegistry() {
  const clients = new Set();
  return {
    add(client) {
      clients.add(client);
    },
    delete(client) {
      clients.delete(client);
    },
    has(client) {
      return clients.has(client);
    },
    get size() {
      return clients.size;
    },
    clients() {
      return [...clients];
    },
    broadcast(ev, p) {
      // Serialise once, send to everyone.
      const text = JSON.stringify({ t: 'evt', ev, p });
      for (const c of clients) c.sendText(text);
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

export function normalizeIp(addr) {
  if (!addr) return '';
  let a = String(addr).trim();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  return a;
}

export function isLoopback(addr) {
  const a = normalizeIp(addr);
  return a === '::1' || a === 'localhost' || /^127\./.test(a);
}

/**
 * Remote IP of a request. When the peer is loopback and an `X-Forwarded-For` header is present (a local
 * reverse proxy: tailscale serve, the relay bridge), the LAST hop is used: it is the one the trusted
 * proxy appended; earlier hops are whatever the client claimed and must not be trusted.
 */
export function remoteIpOf(req) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (isLoopback(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const hops = xff.split(',').map(normalizeIp).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return peer || 'unknown';
}

/** True when the request came through a local reverse proxy (loopback peer + proxy headers). */
function isProxied(req) {
  return (
    isLoopback(req.socket?.remoteAddress) &&
    (req.headers['x-forwarded-for'] !== undefined || req.headers['tailscale-user-login'] !== undefined)
  );
}

/**
 * Key for the failed-auth rate limiter (§1). Proxied clients are keyed by their forwarded IP in a
 * namespace of their own (a forged or empty hop can never collide with direct local clients), and
 * direct local VS Code windows get their own key, so nothing on the phone side can lock them out.
 */
export function rateLimitKey(req, kind) {
  if (isProxied(req)) return `fwd:${remoteIpOf(req)}`;
  const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (kind === 'vscode' && isLoopback(peer)) return 'local:vscode';
  return peer;
}

/** True only for direct loopback requests that did not come through a proxy (§1 /pair rule). */
export function isDirectLocalRequest(req) {
  return isLoopback(req.socket?.remoteAddress) && !isProxied(req);
}

/** Any header a reverse proxy (tailscale serve, the relay bridge, nginx…) may add. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'x-forwarded-host', 'x-termpocket-via'];

/**
 * Local monitor endpoints (/status, /status/selftest, /monitor): the /pair rule, stricter — a direct
 * loopback peer with no proxy header at all. (The Host check is done by the caller with the host policy.)
 */
export function isDirectLoopbackNoProxy(req) {
  if (!isLoopback(req.socket?.remoteAddress)) return false;
  return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

/**
 * How a phone socket reached the agent: "relay" when the loopback relay bridge opened it (it marks its
 * local sockets with `X-TermPocket-Via: relay`; the header only counts from a loopback peer), else "direct".
 */
export function phoneVia(req) {
  return isLoopback(req.socket?.remoteAddress) && String(req.headers['x-termpocket-via'] ?? '').toLowerCase() === 'relay' ? 'relay' : 'direct';
}

// ------------------------------------------------------------------------------------------------
// Host / Origin policy (§1.1): defeats DNS rebinding and cross-site WebSocket connections.
// ------------------------------------------------------------------------------------------------

const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Parse a `Host` header value ("name:port", "[v6]:port") → {hostname, port, host} (lower-case), or null. */
export function parseHostHeader(value) {
  if (typeof value !== 'string' || !HOST_RE.test(value)) return null;
  let hostname;
  let port;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    hostname = value.slice(1, end);
    port = value.slice(end + 2);
  } else {
    const i = value.lastIndexOf(':');
    hostname = i === -1 ? value : value.slice(0, i);
    port = i === -1 ? '' : value.slice(i + 1);
  }
  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return null;
  return { hostname, port, host: (net.isIPv6(hostname) ? `[${hostname}]` : hostname) + (port ? `:${port}` : '') };
}

/** Hostname (lower-case, no brackets, no trailing dot) of a URL string, or ''. */
function urlHostname(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * Which Host / Origin values the agent accepts (PROTOCOL §1.1). Besides IP literals, localhost,
 * *.ts.net and this PC's own name, it accepts the names in `publicUrl` (configured or detected),
 * `allowedHosts` (config.json) and the relay bridge's public URL (relay.json next to config.json).
 */
export function createHostPolicy({ config, hostname = os.hostname() } = {}) {
  const machine = String(hostname || '').toLowerCase();
  let relayCache = { at: 0, hosts: [] };
  function relayHosts() {
    const now = Date.now();
    if (now - relayCache.at < 10_000) return relayCache.hosts;
    const hosts = [];
    if (config?.configDir) {
      try {
        const text = fs.readFileSync(path.join(config.configDir, 'relay.json'), 'utf8').replace(/^﻿/, '');
        const h = urlHostname(String(JSON.parse(text)?.url ?? '').replace(/^ws/i, 'http'));
        if (h) hosts.push(h);
      } catch {
        /* no relay configured */
      }
    }
    relayCache = { at: now, hosts };
    return hosts;
  }
  /** Explicitly configured / detected public names. */
  function configuredHosts() {
    const out = new Set();
    if (config?.publicUrl) {
      const h = urlHostname(config.publicUrl);
      if (h) out.add(h);
    }
    for (const v of Array.isArray(config?.allowedHosts) ? config.allowedHosts : []) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const h = v.includes('://') ? urlHostname(v.trim()) : parseHostHeader(v.trim())?.hostname;
      if (h) out.add(h);
    }
    for (const h of relayHosts()) out.add(h);
    return out;
  }
  /** Could a browser have reached us under this name without DNS rebinding? */
  function isAllowedHostname(name) {
    if (!name) return false;
    if (net.isIP(name)) return true; // IP literals cannot be rebound
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (name.endsWith('.ts.net')) return true; // Tailscale MagicDNS / serve names
    if (machine && (name === machine || name === `${machine}.local`)) return true;
    return configuredHosts().has(name);
  }
  return {
    isAllowedHostname,
    configuredHosts,
    /** Every HTTP request and upgrade: the Host header must name this agent → parsed host, or null. */
    checkHost(req) {
      const h = parseHostHeader(req.headers.host);
      return h && isAllowedHostname(h.hostname) ? h : null;
    },
    /** `/pair` must be addressed by a loopback name (127.0.0.1, localhost, [::1]). */
    isLoopbackHost(req) {
      const h = parseHostHeader(req.headers.host);
      return !!h && LOOPBACK_HOSTNAMES.has(h.hostname);
    },
    /**
     * WebSocket upgrades: no Origin (a non-browser client — VS Code extension, relay bridge) is fine;
     * a browser Origin must be same-origin with the request (its Host, or the X-Forwarded-Host a local
     * proxy set) or one of the configured public names.
     */
    checkOrigin(req) {
      const origin = req.headers.origin;
      if (origin === undefined) return true;
      let u;
      try {
        u = new URL(String(origin));
      } catch {
        return false;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const oHost = u.host.toLowerCase();
      const host = parseHostHeader(req.headers.host);
      if (host && host.host === oHost) return true;
      const fwd = req.headers['x-forwarded-host'];
      if (isLoopback(req.socket?.remoteAddress) && typeof fwd === 'string') {
        const f = parseHostHeader(fwd.split(',')[0].trim());
        if (f && f.host === oHost && isAllowedHostname(f.hostname)) return true;
      }
      return configuredHosts().has(urlHostname(u.href));
    },
  };
}

/** Constant-time token comparison (hash both sides so lengths are always equal). */
export function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b) && expected.length === given.length;
}

// ------------------------------------------------------------------------------------------------
// /vscode mutual challenge-response (§5.1): neither side ever sends the raw token.
// ------------------------------------------------------------------------------------------------

/** HMAC-SHA256(token, label \n a \n b) as base64url. Labels separate the two directions (no reflection). */
export function handshakeProof(token, label, a, b) {
  return crypto.createHmac('sha256', String(token)).update(`${label}\n${a}\n${b}`, 'utf8').digest('base64url');
}

/** Proof the AGENT returns for `hello.challenge`: label "termpocket-agent", client nonce then server nonce. */
export const agentProof = (token, clientNonce, serverNonce) => handshakeProof(token, 'termpocket-agent', clientNonce, serverNonce);
/** Proof the EXTENSION sends in `hello`: label "termpocket-ext", server nonce then client nonce. */
export const extensionProof = (token, clientNonce, serverNonce) => handshakeProof(token, 'termpocket-ext', serverNonce, clientNonce);

function proofMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Render a QR code as an SVG string using qrcode-terminal's bundled encoder (no extra deps). */
export function qrSvg(text) {
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, QRErrorCorrectLevel.M);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const size = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" width="280" height="280"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch {
    return '';
  }
}

/** Base URL used for the pairing link (§1). */
export function publicBaseUrl(config, port = config.port) {
  if (config.publicUrl) return String(config.publicUrl).replace(/\/+$/, '');
  let host = config.host;
  if (!host || host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${port}`;
}

export function pairingLink(config, port) {
  return `${publicBaseUrl(config, port)}/#token=${encodeURIComponent(config.token)}`;
}

function pairPage(link) {
  const svg = qrSvg(link);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TermPocket pairing</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#111418;color:#e8eaed;display:flex;justify-content:center}
  main{max-width:520px;padding:24px 16px}
  h1{font-size:22px;margin:0 0 8px}
  .qr{background:#fff;padding:12px;border-radius:12px;display:inline-block;margin:16px 0}
  code{display:block;word-break:break-all;background:#1d2228;padding:12px;border-radius:8px;user-select:all}
  p.note{color:#9aa0a6;font-size:14px}
</style></head>
<body><main>
<h1>Pair your phone</h1>
<p>Scan this code with your phone's camera (the phone must be on your Tailscale network), or open the link below.</p>
${svg ? `<div class="qr">${svg}</div>` : ''}
<code>${escapeHtml(link)}</code>
<p class="note">This page is only served to direct requests from this PC. Anyone with this link can control this PC — keep it private.
To revoke access, delete the "token" line from config.json and restart the agent.</p>
</main></body></html>`;
}

// ------------------------------------------------------------------------------------------------
// Rate limiter for failed auth attempts
// ------------------------------------------------------------------------------------------------

function createAuthLimiter({ max, windowMs }) {
  /** @type {Map<string, number[]>} ip → failure timestamps */
  const failures = new Map();
  const prune = (ip, now) => {
    const list = failures.get(ip);
    if (!list) return [];
    const fresh = list.filter((t) => now - t < windowMs);
    if (fresh.length) failures.set(ip, fresh);
    else failures.delete(ip);
    return fresh;
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const ip of [...failures.keys()]) prune(ip, now);
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();
  return {
    isBlocked(ip) {
      return prune(ip, Date.now()).length >= max;
    },
    recordFailure(ip) {
      const now = Date.now();
      const list = prune(ip, now);
      list.push(now);
      failures.set(ip, list);
    },
    /** Number of keys currently locked out (monitor). */
    blockedCount() {
      const now = Date.now();
      let n = 0;
      for (const ip of [...failures.keys()]) if (prune(ip, now).length >= max) n += 1;
      return n;
    },
    dispose() {
      clearInterval(sweep);
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The server
// ------------------------------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.config            loaded config (§1)
 * @param {object} opts.log               logger with info/warn/error/debug
 * @param {object[]} opts.handlerSets     [{methods, onClientClose?, dispose?, handleVscodeConnection?}]
 * @param {object} [opts.registry]        phone registry (createPhoneRegistry); created if omitted
 * @param {string} [opts.webRoot]         static root (default: <repo>/web)
 * @param {number} [opts.authTimeoutMs]   first-message auth timeout (default 10 s)
 * @param {number} [opts.pingIntervalMs]  ws ping interval (default 25 s)
 * @param {{max:number, windowMs:number}} [opts.rateLimit]
 * @param {object} [opts.monitor]         sources for GET /status (all optional; also settable later on
 *                                        `server.monitor`): {log(), relay(), helper(), relayConfigured,
 *                                        startedAt, secrets(), selftestBudgetMs}
 */
export function createAgentServer({
  config,
  log,
  handlerSets = [],
  registry = createPhoneRegistry(),
  webRoot = DEFAULT_WEB_ROOT,
  authTimeoutMs = AUTH_TIMEOUT_MS,
  pingIntervalMs = PING_INTERVAL_MS,
  rateLimit = RATE_LIMIT,
  maxPayload = MAX_PAYLOAD,
  hostPolicy = null,
  monitor = {},
} = {}) {
  if (!config || typeof config.token !== 'string') throw new Error('createAgentServer: config with token required');
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const root = path.resolve(webRoot);
  const sets = handlerSets.filter(Boolean);

  // Merged dispatch table (later sets do not silently override earlier ones).
  const methods = Object.create(null);
  for (const set of sets) {
    for (const [name, fn] of Object.entries(set.methods ?? {})) {
      if (typeof fn !== 'function') continue;
      if (methods[name]) logger.warn(`server: method ${name} defined twice; keeping the first`);
      else methods[name] = fn;
    }
  }
  const vscodeSet = sets.find((s) => typeof s.handleVscodeConnection === 'function') ?? null;

  const features = ['pty', 'vscode'];
  if (methods['sys.info']) features.push('sys');
  if (methods['screen.start']) features.push('screen');
  if (methods['input.mouse']) features.push('input');

  const helloInfo = () => ({
    version: VERSION,
    hostname: isDemo() ? DEMO_IDENTITY.hostname : os.hostname(),
    platform: process.platform,
    user: isDemo() ? DEMO_IDENTITY.user : safeUsername(),
    features: [...features],
  });

  const limiter = createAuthLimiter(rateLimit);
  const policy = hostPolicy ?? createHostPolicy({ config });
  let nextClientId = 1;
  const sockets = new Set();
  let closing = false;

  // Monitor state (GET /status).
  const monitorSources = monitor ?? {};
  if (!monitorSources.startedAt) monitorSources.startedAt = Date.now();
  const selftestMarkers = createSelftestMarkers();
  const security = { authFailures: 0, lastAuthFailure: null };
  let selftestRunning = null;

  // --------------------------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------------------------

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      logger.error(`http: ${req.method} ${req.url} failed: ${err.message}`);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });
  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  function baseHeaders() {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
  }

  function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }

  async function handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    const pathname = url.pathname;

    // DNS rebinding guard (§1.1): a page whose own name was re-pointed at 127.0.0.1 sends its own
    // name as Host — refuse it before serving anything.
    if (!policy.checkHost(req)) {
      logger.warn(`http: refused Host ${JSON.stringify(String(req.headers.host ?? '').slice(0, 100))} from ${remoteIpOf(req)}`);
      return sendText(res, 421, 'Misdirected Request: unknown Host. If this is a name you use for this PC, add it to "allowedHosts" in config.json.');
    }

    if (pathname === '/status' || pathname === '/status/selftest' || pathname === '/monitor' || pathname.startsWith('/monitor/')) {
      return handleMonitor(req, res, pathname);
    }

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' });
      return sendText(res, 200, JSON.stringify({ ok: true, version: VERSION }), 'application/json; charset=utf-8');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' });
    }

    if (pathname === '/pair' || pathname === '/pair/') {
      if (!isDirectLocalRequest(req) || !policy.isLoopbackHost(req)) return sendText(res, 404, 'Not Found');
      const link = pairingLink(config, boundPort());
      return sendText(res, 200, pairPage(link), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    return serveStatic(req, res, pathname);
  }

  // --------------------------------------------------------------------------------------------
  // Local monitor: GET /status, POST /status/selftest, GET /monitor/ (loopback only, like /pair)
  // --------------------------------------------------------------------------------------------

  /** A browser Origin on a monitor request must be this same loopback host (no cross-site use). */
  function monitorOriginOk(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    let u;
    try {
      u = new URL(String(origin));
    } catch {
      return false;
    }
    const host = parseHostHeader(req.headers.host);
    return u.protocol === 'http:' && !!host && u.host.toLowerCase() === host.host;
  }

  async function handleMonitor(req, res, pathname) {
    if (!isDirectLoopbackNoProxy(req) || !policy.isLoopbackHost(req)) return sendText(res, 404, 'Not Found');
    const site = req.headers['sec-fetch-site'];
    if (!monitorOriginOk(req) || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      return sendText(res, 403, 'Forbidden');
    }

    if (pathname === '/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' });
      return sendText(res, 200, statusJson(), 'application/json; charset=utf-8');
    }

    if (pathname === '/status/selftest') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method Not Allowed', undefined, { Allow: 'POST' });
      // CSRF guard: a custom header cannot be sent cross-site without a CORS preflight we never grant.
      if (req.headers['x-termpocket-monitor'] !== '1') return sendText(res, 403, 'Forbidden: X-TermPocket-Monitor: 1 header required');
      req.resume(); // a body, if any, is ignored
      if (!selftestRunning) {
        // One run at a time: concurrent callers share the running test.
        const addr = httpServer.address();
        selftestRunning = runSelftest(
          {
            config,
            port: boundPort(),
            host: addr && typeof addr === 'object' ? addr.address : config.host,
            relayConfigured: relayIsConfigured(),
            markers: selftestMarkers,
            hasMethod: (m) => typeof methods[m] === 'function',
          },
          monitorSources.selftestBudgetMs ? { budgetMs: monitorSources.selftestBudgetMs } : undefined,
        )
          .then((result) => {
            const failed = result.steps.filter((s) => !s.ok).map((s) => s.name);
            if (failed.length) logger.warn(`self-test failed: ${failed.join('; ')}`);
            else logger.info(`self-test passed (${result.steps.length} steps)`);
            return result;
          })
          .finally(() => {
            selftestRunning = null;
          });
      }
      const result = await selftestRunning;
      return sendText(res, 200, redactSecrets(JSON.stringify(result), secretList(), { patterns: false }),'application/json; charset=utf-8');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' });
    const asset = monitorAsset(pathname);
    if (!asset) return sendText(res, 404, 'Not Found');
    let body;
    try {
      body = await readMonitorFile(asset.file);
    } catch {
      return sendText(res, 404, 'Not Found');
    }
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': asset.type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': MONITOR_CSP,
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function relayIsConfigured() {
    const v = monitorSources.relayConfigured;
    return typeof v === 'function' ? !!v() : !!v;
  }

  function secretList() {
    const extra = typeof monitorSources.secrets === 'function' ? monitorSources.secrets() : [];
    return [config.token, ...(Array.isArray(extra) ? extra : [])];
  }

  /** Calls an optional status source; a throwing source never breaks /status. */
  function source(name, fallback) {
    const fn = monitorSources[name];
    if (typeof fn !== 'function') return fallback;
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch (err) {
      logger.debug(`status source ${name} failed: ${err.message}`);
      return fallback;
    }
  }

  /** First handler set whose monitorStatus() provides `key` (pty → terminals, hub → vscode, screen → screen). */
  function fromSets(key, fallback) {
    for (const set of sets) {
      if (typeof set.monitorStatus !== 'function') continue;
      try {
        const part = set.monitorStatus();
        if (part && part[key] !== undefined) return part[key];
      } catch (err) {
        logger.debug(`monitorStatus failed: ${err.message}`);
      }
    }
    return fallback;
  }

  function describePhone(client) {
    const out = {
      id: client.num,
      ip: client.remote,
      client: client.clientName,
      via: client.via,
      connectedAt: client.connectedAt,
      attached: [],
      streaming: false,
    };
    for (const set of sets) {
      if (typeof set.describeClient !== 'function') continue;
      try {
        const d = set.describeClient(client);
        if (d && Array.isArray(d.attached)) out.attached.push(...d.attached);
        if (d && d.streaming) out.streaming = true;
      } catch {
        /* diagnostics only */
      }
    }
    return out;
  }

  function buildStatus() {
    const now = Date.now();
    const startedAt = monitorSources.startedAt;
    const r = source('relay', null);
    const relay = {
      configured: relayIsConfigured() || !!r?.configured,
      url: typeof r?.url === 'string' ? r.url : null,
      connected: !!r?.connected,
      since: Number.isFinite(r?.since) ? r.since : null,
      sessions: Number(r?.sessions) || 0,
      lastError: r?.lastError ? String(r.lastError) : null,
      reconnects: Number(r?.reconnects) || 0,
    };
    const h = source('helper', null);
    const helper = {
      running: !!h?.running,
      pid: Number.isInteger(h?.pid) ? h.pid : null,
      restarts: Number(h?.restarts) || 0,
      lastError: h ? (h.lastError ? String(h.lastError) : null) : 'windows helper not available',
    };
    const ph = fromSets('ptyHost', null);
    const ptyHost = {
      mode: ph?.mode === 'host' || ph?.mode === 'inprocess' ? ph.mode : null,
      running: !!ph?.running,
      pid: Number.isInteger(ph?.pid) ? ph.pid : null,
      sessions: Number(ph?.sessions) || 0,
      live: Number(ph?.live) || 0,
      startedAt: Number.isFinite(ph?.startedAt) ? ph.startedAt : null,
      adopted: Number(ph?.adopted) || 0,
      reconnects: Number(ph?.reconnects) || 0,
      lastError: ph?.lastError ? String(ph.lastError) : null,
    };
    const addr = httpServer.address();
    const log = source('log', []);
    return {
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt,
      uptimeSec: Math.max(0, Math.floor((now - startedAt) / 1000)),
      now,
      listen: { host: addr && typeof addr === 'object' ? addr.address : config.host, port: boundPort() },
      publicUrl: config.publicUrl ? String(config.publicUrl) : null,
      relay,
      phones: registry.clients().filter((c) => !c.selftest).map(describePhone),
      vscode: fromSets('vscode', []),
      terminals: fromSets('terminals', []),
      screen: fromSets('screen', { streams: 0 }),
      helper,
      ptyHost,
      security: {
        authFailures: security.authFailures,
        rateLimitedIps: limiter.blockedCount(),
        lastAuthFailure: security.lastAuthFailure ? { ...security.lastAuthFailure } : null,
      },
      log: Array.isArray(log) ? log.slice(-200) : [],
    };
  }

  /** /status body, with every known secret scrubbed from the final text (defence in depth). */
  function statusJson() {
    return redactSecrets(JSON.stringify(buildStatus()), secretList(), { patterns: false });
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    if (rel.includes('\0')) return sendText(res, 400, 'Bad Request');
    if (rel.endsWith('/')) rel += 'index.html';
    // Normalise both separators, then refuse anything that escapes the root or touches dotfiles.
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    if (segments.some((s) => s === '..' || s.startsWith('.') || s.includes(':'))) return sendText(res, 404, 'Not Found');
    const file = path.resolve(root, ...segments);
    const relToRoot = path.relative(root, file);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return sendText(res, 404, 'Not Found');

    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return sendText(res, 404, 'Not Found');
    }
    if (!stat.isFile()) return sendText(res, 404, 'Not Found'); // no directory listing

    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const base = path.basename(file);
    let cache = 'no-cache';
    if (!NO_CACHE_FILES.has(base) && LONG_CACHE_DIRS.has(segments[0])) cache = 'public, max-age=86400';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...baseHeaders(),
      'Content-Type': type,
      'Cache-Control': cache,
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (base === 'sw.js') headers['Service-Worker-Allowed'] = '/';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file);
      stream.on('error', (err) => {
        logger.warn(`http: read ${relToRoot} failed: ${err.message}`);
        res.destroy();
        resolve();
      });
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  }

  // --------------------------------------------------------------------------------------------
  // WebSocket
  // --------------------------------------------------------------------------------------------

  const phoneWss = new WebSocketServer({
    noServer: true,
    maxPayload,
    clientTracking: false,
    // Terminal output compresses very well; JPEG frames are sent with compress:false.
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 }, serverNoContextTakeover: false },
  });
  const vscodeWss = new WebSocketServer({ noServer: true, maxPayload, clientTracking: false, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (closing) return rejectUpgrade(socket, 503, 'Service Unavailable');
    // §1.1: Host must name this agent (DNS rebinding) and a browser Origin must be our own
    // (cross-site pages may not even attempt an auth — that also keeps them off the rate limiter).
    if (!policy.checkHost(req)) {
      logger.warn(`ws: refused Host ${JSON.stringify(String(req.headers.host ?? '').slice(0, 100))} from ${remoteIpOf(req)}`);
      return rejectUpgrade(socket, 421, 'Misdirected Request');
    }
    if (!policy.checkOrigin(req)) {
      logger.warn(`ws: refused cross-origin upgrade from ${JSON.stringify(String(req.headers.origin).slice(0, 100))} (${remoteIpOf(req)})`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (pathname === '/ws') {
      phoneWss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req, 'phone'));
    } else if (pathname === '/vscode') {
      vscodeWss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req, 'vscode'));
    } else {
      rejectUpgrade(socket, 404, 'Not Found');
    }
  });

  function rejectUpgrade(socket, status, text) {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  }

  function onSocket(ws, req, kind) {
    const remote = remoteIpOf(req);
    ws.isAlive = true;
    sockets.add(ws);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', (err) => logger.debug(`${kind} ${remote}: socket error ${err.message}`));
    ws.once('close', () => sockets.delete(ws));

    const limitKey = rateLimitKey(req, kind);
    const refuseIfBlocked = () => {
      if (!limiter.isBlocked(limitKey)) return false;
      logger.warn(`auth: ${kind} connection from ${remote} refused (rate limited)`);
      ws.close(CLOSE_RATE_LIMITED, 'too many failed auth attempts');
      return true;
    };
    if (refuseIfBlocked()) return;

    // One deadline for the whole handshake (a /vscode challenge round trip included).
    const timer = setTimeout(() => {
      ws.off('message', onFirst);
      logger.info(`auth: ${kind} ${remote} did not authenticate in time`);
      ws.close(CLOSE_UNAUTHORIZED, 'auth timeout');
    }, authTimeoutMs);
    ws.once('close', () => clearTimeout(timer));

    const expectedMethod = kind === 'phone' ? 'auth' : 'hello';
    /** Set after a /vscode `hello.challenge`: {clientNonce, serverNonce}; `hello` must then carry a proof. */
    let challenge = null;

    function onFirst(data, isBinary) {
      ws.isAlive = true;
      const msg = parseFrame(data, isBinary);
      // /vscode step 1 (§5.1): the agent proves it knows the token before the extension reveals anything.
      if (kind === 'vscode' && !challenge && msg?.t === 'req' && msg.m === 'hello.challenge') {
        if (refuseIfBlocked()) return;
        const clientNonce = msg.p && typeof msg.p === 'object' ? msg.p.nonce : undefined;
        if (typeof clientNonce !== 'string' || !NONCE_RE.test(clientNonce)) {
          ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: 'hello.challenge: nonce required' }));
          ws.off('message', onFirst);
          clearTimeout(timer);
          ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        const serverNonce = crypto.randomBytes(32).toString('base64url');
        challenge = { clientNonce, serverNonce };
        ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r: { nonce: serverNonce, proof: agentProof(config.token, clientNonce, serverNonce) } }));
        return; // keep listening for `hello`
      }
      ws.off('message', onFirst);
      clearTimeout(timer);
      if (!msg || msg.t !== 'req' || msg.m !== expectedMethod) {
        if (msg?.t === 'req') ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: `first message must be ${expectedMethod}` }));
        logger.info(`auth: ${kind} ${remote} sent no ${expectedMethod} request`);
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      // Re-check here, not only at connect time: parallel sockets opened before the limit was reached
      // must not each get a guess.
      if (refuseIfBlocked()) return;
      const p = msg.p && typeof msg.p === 'object' ? msg.p : {};
      const ok = challenge
        ? proofMatches(extensionProof(config.token, challenge.clientNonce, challenge.serverNonce), p.proof)
        : tokenMatches(config.token, p.token); // phones; and older extensions that still send the raw token
      if (!ok) {
        limiter.recordFailure(limitKey);
        security.authFailures += 1;
        security.lastAuthFailure = { ip: remote, at: Date.now() };
        logger.warn(`auth: bad token from ${kind} ${remote}`);
        ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: 'bad token' }));
        ws.close(CLOSE_UNAUTHORIZED, 'bad token');
        return;
      }
      // Authenticated — the RPC connection takes over from the next frame on (attached synchronously,
      // so frames that arrived in the same chunk are not lost).
      const conn = makeConn(ws, { log: logger, label: `${kind}:${remote}` });
      if (kind === 'phone') acceptPhone(ws, conn, msg, p, remote, phoneVia(req));
      else acceptVscode(ws, conn, msg, p, remote);
    }
    ws.on('message', onFirst);
  }

  function acceptPhone(ws, conn, msg, p, remote, via = 'direct') {
    const num = nextClientId++;
    // The monitor's self-test connects like a phone. It is recognised only by a one-time marker this
    // process issued, so no real client can hide from /status by picking a client name.
    const selftest = selftestMarkers.has(p.client);
    const client = {
      id: `c${num}`,
      num,
      kind: 'phone',
      remote,
      via,
      connectedAt: Date.now(),
      selftest,
      clientName: selftest ? 'selftest' : typeof p.client === 'string' ? p.client.slice(0, 40) : 'unknown',
      sendJson: (obj) => conn.sendJson(obj),
      sendBinary: (buf) => conn.sendBinary(buf),
      /** Pre-serialised text frame (used by broadcasts). */
      sendText: (text) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(text, (err) => err && logger.debug(`phone ${client.id}: send failed ${err.message}`));
        return true;
      },
      notify: (ev, payload) => conn.notify(ev, payload),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      isOpen: () => ws.readyState === WebSocket.OPEN,
      conn,
    };

    conn.onRequest(async (m, params) => {
      if (m === 'auth') {
        // Re-auth on an authenticated socket: harmless, answer the same info if the token is right.
        if (!tokenMatches(config.token, params?.token)) throw new Error('bad token');
        return helloInfo();
      }
      const fn = methods[m];
      if (!fn) throw new Error(`unknown method: ${m}`);
      return fn(params && typeof params === 'object' ? params : {}, client);
    });

    conn.onClose(() => {
      registry.delete(client);
      logger.info(`phone disconnected: ip=${remote} after ${Math.round((Date.now() - client.connectedAt) / 1000)}s${selftest ? ' (self-test)' : ''}`);
      for (const set of sets) {
        if (typeof set.onClientClose !== 'function') continue;
        try {
          const r = set.onClientClose(client);
          if (r && typeof r.catch === 'function') r.catch((err) => logger.warn(`onClientClose failed: ${err.message}`));
        } catch (err) {
          logger.warn(`onClientClose failed: ${err.message}`);
        }
      }
    });

    registry.add(client);
    conn.respond(msg.id, true, helloInfo());
    logger.info(`phone connected: ip=${remote} via=${via} client=${JSON.stringify(client.clientName).slice(1, -1)}`);
  }

  function acceptVscode(ws, conn, msg, p, remote) {
    if (!vscodeSet) {
      conn.respond(msg.id, false, 'vscode support not available');
      conn.close(1011, 'vscode support not available');
      return;
    }
    try {
      // The hub validates the hello params, registers the window and returns the hello result
      // ({version}); it throws to reject the connection.
      const result = vscodeSet.handleVscodeConnection(conn, p, { remote });
      conn.respond(msg.id, true, result ?? { version: VERSION });
    } catch (err) {
      conn.respond(msg.id, false, err.message);
      conn.close(CLOSE_UNAUTHORIZED, 'bad hello');
    }
  }

  // Liveness: ping every 25 s, terminate sockets that did not answer the previous ping.
  const pingTimer = setInterval(() => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!ws.isAlive) {
        logger.debug('terminating dead socket');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, pingIntervalMs);
  pingTimer.unref?.();

  function boundPort() {
    const addr = httpServer.address();
    return addr && typeof addr === 'object' ? addr.port : config.port;
  }

  return {
    httpServer,
    registry,
    methods,
    /** Mutable /status sources (index.js adds the relay once it has started). */
    monitor: monitorSources,
    /** Current /status snapshot as an object (not redacted; in-process use and tests). */
    status: buildStatus,
    get port() {
      return boundPort();
    },
    /** Start listening; resolves with {host, port}. */
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve({ host, port: boundPort() });
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    /** Close all sockets and the HTTP server (handler sets are disposed by the caller). */
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(pingTimer);
      limiter.dispose();
      for (const ws of sockets) {
        try {
          ws.close(1001, 'agent shutting down');
        } catch {
          ws.terminate();
        }
      }
      await new Promise((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections?.();
        // Give sockets a moment to finish the close handshake, then force everything shut.
        setTimeout(() => {
          for (const ws of sockets) ws.terminate();
          httpServer.closeAllConnections?.();
        }, 500).unref();
      });
      phoneWss.close();
      vscodeWss.close();
    },
  };
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}
