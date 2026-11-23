// Relay client ("bridge"): keeps an outbound connection to an optional, self-hosted TermPocket relay
// (relay/server.js on your own server, e.g. wss://pc.example.com) so phones/laptops can reach this PC without any
// inbound port. For every client that connects to the relay, it opens a data socket to the relay and a
// local /ws socket to this agent, and splices them. The agent's own token auth still applies end to end.
//
// Enabled when <configDir>/relay.json exists:
//   { "url": "wss://pc.example.com", "key": "<RELAY_KEY>" }
// Relay protocol (control socket /agent, JSON text frames):
//   relay → PC  {t:"hello"} · {t:"open", id, ip, origin, ua} · {t:"cancel", id} · {t:"pong"}
//   PC → relay  {t:"ping", at}
// Data socket: /agent/data?id=<id>, both with header  Authorization: Bearer <key>.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const SILENCE_MS = 70_000;
const PING_MS = 25_000;
// /status reports the control socket as not connected once no pong arrived for this long (a silently
// dropped connection is only torn down after SILENCE_MS; the monitor should not show green until then).
const STALE_MS = PING_MS + 20_000;

/** Reads and validates relay.json; returns null when the relay is not configured. */
export function loadRelayConfig(configDir) {
  const file = path.join(configDir, 'relay.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let cfg;
  try { cfg = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`); }
  const url = String(cfg?.url ?? '').trim().replace(/\/+$/, '');
  const key = String(cfg?.key ?? '');
  if (!/^wss?:\/\//i.test(url)) throw new Error(`${file}: "url" must start with wss:// (or ws:// for local tests)`);
  if (key.length < 32) throw new Error(`${file}: "key" missing or shorter than 32 characters`);
  return { url, key, file };
}

/**
 * @param {{relay: {url: string, key: string}, port: number, log: object, pingMs?: number, silenceMs?: number,
 *          staleMs?: number}} opts   (the timing options exist for tests)
 * @returns {{dispose(): void, status(): {configured: true, url: string, connected: boolean, since: number|null,
 *            sessions: number, lastError: string|null, reconnects: number}}}
 */
export function startRelayClient({ relay, port, log, pingMs = PING_MS, silenceMs = SILENCE_MS, staleMs = STALE_MS }) {
  const RELAY = relay.url;
  const AUTH = { Authorization: `Bearer ${relay.key}` };
  const PUBLIC_HOST = new URL(RELAY.replace(/^ws/i, 'http')).host;
  const LOCAL = `ws://127.0.0.1:${port}/ws`;
  const sessions = new Map(); // id -> { local, data }

  let ctl = null;
  let backoff = 1000;
  let lastPong = Date.now();
  let retryTimer = null;
  let disposed = false;
  let everConnected = false;
  // Local monitor (/status): never includes the key.
  let connectedSince = null;
  let lastError = null;
  let reconnects = 0;

  function connect() {
    if (disposed) return;
    const ws = new WebSocket(`${RELAY}/agent`, { headers: AUTH, handshakeTimeout: 15_000 });
    ctl = ws;
    let refused = false;
    ws.on('open', () => {
      backoff = 1000;
      lastPong = Date.now();
      everConnected = true;
      connectedSince = Date.now();
      lastError = null;
      log.info(`connected to relay ${RELAY}`);
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m?.t === 'open') openSession(m);
      else if (m?.t === 'cancel') closeSession(m.id);
      else if (m?.t === 'pong') lastPong = Date.now();
    });
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('unexpected-response', (_req, res) => {
      lastError = `relay refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (wrong key in relay.json?)' : ''}`;
      log.warn(lastError);
      // With an 'unexpected-response' listener, ws leaves the socket CONNECTING until we abort it: without
      // this, one 502/503 from the relay's proxy (relay restarting) stopped all reconnect attempts for good.
      refused = true;
      try { res.resume(); } catch { /* ignore */ }
      ws.terminate(); // -> 'error' + 'close' -> retry with backoff
    });
    ws.on('error', (e) => { if (refused) return; lastError = `relay socket error: ${e.message}`; if (everConnected || backoff <= 2000) log.warn(`relay socket error: ${e.message}`); });
    ws.on('close', (code) => {
      if (ctl === ws) ctl = null;
      if (disposed) return;
      if (connectedSince !== null && !lastError) lastError = `relay connection closed (${code})`;
      connectedSince = null;
      reconnects += 1;
      log.info(`relay connection closed (${code}); retrying in ${Math.round(backoff / 1000)}s`);
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  }

  // Detect half-open control connections (sleep/resume, NAT rebinding…).
  const pinger = setInterval(() => {
    if (!ctl || ctl.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > silenceMs) {
      lastError = `relay silent for ${Math.round(silenceMs / 1000)} s; reconnecting`;
      log.warn(lastError);
      ctl.terminate();
      return;
    }
    try {
      ctl.ping();
      ctl.send(JSON.stringify({ t: 'ping', at: Date.now() }));
    } catch { /* close handler reconnects */ }
  }, pingMs);
  pinger.unref?.();

  function openSession({ id, ip, origin }) {
    if (typeof id !== 'string' || !id || id.length > 64 || sessions.has(id)) return;
    // The agent keys its auth rate limit on X-Forwarded-For (trusted from loopback): always send a
    // non-empty hop. Host = the relay's public name (allowed via relay.json by the agent's Host
    // policy); Origin = the browser's, so the agent's same-origin check still applies.
    // X-TermPocket-Via marks the socket as relayed for the local monitor (only trusted from loopback).
    const headers = { 'X-Forwarded-For': typeof ip === 'string' && ip ? ip.slice(0, 64) : 'relay-unknown', Host: PUBLIC_HOST, 'X-TermPocket-Via': 'relay' };
    if (typeof origin === 'string' && origin) headers.Origin = origin.slice(0, 200);
    const s = {
      local: new WebSocket(LOCAL, { headers, perMessageDeflate: false }),
      data: new WebSocket(`${RELAY}/agent/data?id=${encodeURIComponent(id)}`, { headers: AUTH, perMessageDeflate: false }),
    };
    sessions.set(id, s);
    splice(s.local, s.data);
    const end = (other) => (code, reason) => {
      if (other.readyState === WebSocket.CONNECTING || other.readyState === WebSocket.OPEN) {
        const c = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
        try { other.close(c, reason); } catch { other.terminate(); }
      }
      if (s.local.readyState >= WebSocket.CLOSING && s.data.readyState >= WebSocket.CLOSING) sessions.delete(id);
    };
    s.local.on('close', end(s.data));
    s.data.on('close', end(s.local));
    s.local.on('error', (e) => log.warn(`local socket for relay client ${id.slice(0, 6)}: ${e.message}`));
    s.data.on('error', (e) => log.warn(`relay data socket ${id.slice(0, 6)}: ${e.message}`));
    log.info(`relay client ${id.slice(0, 6)} from ${headers['X-Forwarded-For']}`);
  }

  /** Pipes a<->b preserving text/binary frames, queueing until both are open, with back-pressure. */
  function splice(a, b) {
    const pump = (src, dst) => {
      const queue = [];
      let queued = 0;
      src.on('message', (d, isBinary) => {
        if (dst.readyState !== WebSocket.OPEN) {
          queued += d.length;
          if (queued > MAX_QUEUED_BYTES) { src.close(1009, 'peer not ready'); return; }
          queue.push([d, isBinary]);
          return;
        }
        dst.send(d, { binary: isBinary });
        if (dst.bufferedAmount > HIGH_WATER && src._socket && !src._vscPaused) {
          src._vscPaused = true;
          src._socket.pause();
          const t = setInterval(() => {
            if (dst.readyState !== WebSocket.OPEN || dst.bufferedAmount < LOW_WATER) {
              clearInterval(t);
              src._vscPaused = false;
              src._socket?.resume();
            }
          }, 50);
        }
      });
      dst.on('open', () => {
        for (const [d, isBinary] of queue.splice(0)) dst.send(d, { binary: isBinary });
        queued = 0;
      });
    };
    pump(a, b);
    pump(b, a);
  }

  function closeSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    for (const w of [s.local, s.data]) { try { w.close(1000); } catch { /* ignore */ } }
    sessions.delete(id);
  }

  connect();

  return {
    status: () => {
      const open = !!ctl && ctl.readyState === WebSocket.OPEN;
      const silentMs = Date.now() - lastPong;
      const stale = open && silentMs > staleMs;
      const connected = open && !stale;
      const err = stale ? `relay not answering (no reply for ${Math.round(silentMs / 1000)} s)` : lastError;
      return { configured: true, url: RELAY, connected, since: connected ? connectedSince : null, sessions: sessions.size, lastError: err, reconnects };
    },
    dispose() {
      disposed = true;
      clearInterval(pinger);
      clearTimeout(retryTimer);
      for (const id of [...sessions.keys()]) closeSession(id);
      try { ctl?.close(1000, 'agent shutting down'); } catch { /* ignore */ }
    },
  };
}
