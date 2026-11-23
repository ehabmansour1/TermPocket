// Local monitor support: log ring buffer with secret redaction, the /status snapshot, the
// /status/selftest checks and the /monitor dashboard files (agent/monitor/).
//
// Everything here is served by server.js to direct loopback requests only (the /pair rule) — see
// isMonitorRequest() in server.js. Nothing in this module is reachable from a phone.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

export const MONITOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'monitor');

/** Files of the dashboard: request path → [file in agent/monitor, content type]. */
const MONITOR_FILES = {
  '/monitor': ['index.html', 'text/html; charset=utf-8'],
  '/monitor/': ['index.html', 'text/html; charset=utf-8'],
  '/monitor/monitor.css': ['monitor.css', 'text/css; charset=utf-8'],
  '/monitor/monitor.js': ['monitor.js', 'text/javascript; charset=utf-8'],
  '/monitor/icon.svg': ['icon.svg', 'image/svg+xml'],
};

/** Strict CSP for the dashboard: only its own files, fetches to this agent, nothing external. */
export const MONITOR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Returns {file, type} for a dashboard path, or null. */
export function monitorAsset(pathname) {
  const hit = MONITOR_FILES[pathname];
  return hit ? { file: path.join(MONITOR_ROOT, hit[0]), type: hit[1] } : null;
}

// ------------------------------------------------------------------------------------------------
// Redaction
// ------------------------------------------------------------------------------------------------

const REDACTED = '[redacted]';

/** Pattern-based redaction: pairing links, token/key query or JSON fields, bearer credentials. */
const SECRET_PATTERNS = [
  [/(#token=)[^\s&"'<>\\]+/gi, `$1${REDACTED}`],
  [/([?&](?:token|key|access_token)=)[^\s&"'<>\\]+/gi, `$1${REDACTED}`],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/("(?:token|key|relayKey|proof)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
];

/**
 * Removes secrets from a string: every occurrence of the given literal secrets (the token, the relay
 * key) and, unless `patterns` is false, anything that looks like a pairing link / token field.
 * (`patterns: false` is used on serialised JSON: replacing base64url literals cannot break escaping.)
 */
export function redactSecrets(text, secrets = [], { patterns = true } = {}) {
  let s = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && s.includes(secret)) s = s.split(secret).join(REDACTED);
  }
  if (patterns) for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

// ------------------------------------------------------------------------------------------------
// Log ring buffer
// ------------------------------------------------------------------------------------------------

/**
 * The last `max` log lines as {at, level, scope, msg}, already redacted. `addSecret()` registers a
 * literal secret (token, relay key) that must never be shown.
 */
export function createLogRing(max = 200) {
  const lines = [];
  const secrets = new Set();
  return {
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 8) secrets.add(secret);
    },
    push(level, scope, msg) {
      let sc = String(scope || '');
      let text = String(msg ?? '');
      // Unscoped modules prefix their lines themselves ("[winhelper] …", "[screen] …").
      if (!sc) {
        const m = /^\[([A-Za-z0-9_:.-]{1,40})\]\s*/.exec(text);
        if (m) {
          sc = m[1];
          text = text.slice(m[0].length);
        } else sc = 'agent';
      }
      if (text.length > 2000) text = `${text.slice(0, 2000)}…`;
      lines.push({ at: Date.now(), level: String(level).trim().toUpperCase(), scope: sc, msg: redactSecrets(text, [...secrets]) });
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    entries() {
      return lines.map((l) => ({ ...l }));
    },
    get secrets() {
      return [...secrets];
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Self-test
// ------------------------------------------------------------------------------------------------

export const SELFTEST_BUDGET_MS = 14_500;

/** Marks the self-test's own phone connections so /status and the tray do not list them as phones. */
export function createSelftestMarkers() {
  const live = new Set();
  return {
    create() {
      const m = `selftest-${crypto.randomBytes(12).toString('base64url')}`;
      live.add(m);
      return m;
    },
    release(m) {
      live.delete(m);
    },
    /** True only for a marker this process issued and has not released yet. */
    has(name) {
      return typeof name === 'string' && live.has(name);
    },
  };
}

function remainingMs(deadline, cap) {
  return Math.max(0, Math.min(cap, deadline - Date.now()));
}

async function timedStep(steps, name, deadline, cap, fn) {
  const t0 = Date.now();
  const budget = remainingMs(deadline, cap);
  let ok = false;
  let detail = '';
  if (budget < 200) {
    detail = 'skipped: self-test time budget used up';
  } else {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(budget / 100) / 10} s`)), budget);
      });
      detail = await Promise.race([fn(budget), timeout]);
      ok = true;
    } catch (err) {
      detail = err?.message || String(err);
    } finally {
      clearTimeout(timer);
    }
  }
  const step = { name, ok, ms: Date.now() - t0, detail: String(detail ?? '') };
  steps.push(step);
  return step;
}

async function getJson(url, timeoutMs, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', redirect: 'error' });
  } catch (err) {
    // undici reports "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND, certificate…) is the cause.
    const cause = err?.cause;
    let why = cause?.message || cause?.code || err?.message || 'network error';
    if (cause?.code && !why.includes(cause.code)) why += ` (${cause.code})`;
    if (err?.name === 'TimeoutError') why = `no answer within ${Math.round(timeoutMs / 100) / 10} s`;
    throw new Error(`cannot reach ${new URL(url).host}: ${why}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}

/**
 * Opens a phone WebSocket, authenticates with the real token and does one `method` round trip.
 * Resolves with a short human description; rejects with the failure reason.
 */
export function wsRoundTrip({ url, token, clientName, origin, host, method = 'sys.info', timeoutMs }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const t0 = Date.now();
    let ws;
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: Math.max(500, timeoutMs), perMessageDeflate: false });
    } catch (err) {
      reject(err);
      return;
    }
    let done = false;
    let authMs = 0;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000, 'self-test done');
      } catch {
        ws.terminate();
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(authMs ? `${method} did not answer in time` : 'no answer to auth in time'));
      try { ws.terminate(); } catch { /* ignore */ }
    }, timeoutMs);
    ws.on('unexpected-response', (_req, res) => finish(new Error(`HTTP ${res.statusCode} on WebSocket upgrade`)));
    ws.on('error', (err) => finish(new Error(err.message || 'socket error')));
    ws.on('close', (code, reason) => {
      const why = reason?.toString() || '';
      finish(new Error(`socket closed (${code}${why ? `: ${why}` : ''})`));
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'req', id: 1, m: 'auth', p: { token, client: clientName } }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.t !== 'res') return;
      if (msg.id === 1) {
        if (!msg.ok) return finish(new Error(`auth refused: ${msg.e || 'unknown error'}`));
        authMs = Date.now() - t0;
        ws.send(JSON.stringify({ t: 'req', id: 2, m: method, p: {} }));
      } else if (msg.id === 2) {
        if (!msg.ok) return finish(new Error(`${method} failed: ${msg.e || 'unknown error'}`));
        const r = msg.r && typeof msg.r === 'object' ? msg.r : {};
        const what = method === 'sys.info' && r.hostname ? ` (${r.hostname})` : '';
        finish(null, `auth ${authMs} ms, ${method}${what} ${Date.now() - t0 - authMs} ms`);
      }
    });
  });
}

/**
 * Runs the self-test. `ctx`: {config, port, host, relayConfigured, markers, hasMethod(m)}.
 * Steps: local /healthz · local WS auth + sys.info · public /healthz · public WS round trip.
 */
export async function runSelftest(ctx, { budgetMs = SELFTEST_BUDGET_MS } = {}) {
  const { config, port, markers } = ctx;
  const deadline = Date.now() + budgetMs;
  const steps = [];
  let host = ctx.host;
  if (!host || host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const localBase = `http://${hostPart}:${port}`;
  const method = ctx.hasMethod?.('sys.info') === false ? 'pty.list' : 'sys.info';

  await timedStep(steps, 'Local agent responds (/healthz)', deadline, 3000, async (ms) => {
    const r = await getJson(`${localBase}/healthz`, ms);
    if (r.status !== 200 || r.body?.ok !== true) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    return `HTTP 200, version ${r.body.version}`;
  });

  await timedStep(steps, `Local WebSocket: auth + ${method}`, deadline, 4000, async (ms) => {
    const marker = markers.create();
    try {
      return await wsRoundTrip({ url: `ws://${hostPart}:${port}/ws`, token: config.token, clientName: marker, method, timeoutMs: ms });
    } finally {
      markers.release(marker);
    }
  });

  const publicUrl = String(config.publicUrl || '').replace(/\/+$/, '');
  if (publicUrl && /^https?:\/\//i.test(publicUrl)) {
    const relay = !!ctx.relayConfigured;
    await timedStep(steps, `Public endpoint reachable (${publicUrl}/healthz)`, deadline, 5000, async (ms) => {
      const r = await getJson(`${publicUrl}/healthz`, ms);
      if (r.status !== 200 || !r.body || r.body.ok !== true) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 120) || 'empty response'}`);
      if (relay && r.body.pcOnline !== true) throw new Error('relay is up but reports pcOnline:false — this PC is not connected to it');
      return relay ? `HTTP 200, relay ${r.body.relay ?? '?'}, pcOnline: true` : `HTTP 200, version ${r.body.version ?? '?'}`;
    });
    await timedStep(steps, 'Public round trip (phone path): auth + ' + method, deadline, 8000, async (ms) => {
      const marker = markers.create();
      try {
        return await wsRoundTrip({ url: `${publicUrl.replace(/^http/i, 'ws')}/ws`, token: config.token, clientName: marker, origin: publicUrl, method, timeoutMs: ms });
      } finally {
        markers.release(marker);
      }
    });
  } else {
    steps.push({ name: 'Public access', ok: true, ms: 0, detail: 'skipped: no relay or public URL configured (local network only)' });
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/** Reads a dashboard file (small, read per request so edits show up without restarting). */
export async function readMonitorFile(file) {
  return fs.promises.readFile(file);
}
