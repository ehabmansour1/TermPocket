// Relay client (agent/src/relayClient.js) against the REAL relay server (relay/server.js), with a
// stand-in "agent" WebSocket server so this test needs no PTY/helper. Run: node --test test/relay.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { loadRelayConfig, startRelayClient } from '../src/relayClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = path.resolve(HERE, '..', '..', 'relay');
const relayAvailable = fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'ws'));
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('loadRelayConfig validates relay.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-relaycfg-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadRelayConfig(dir), null);
  fs.writeFileSync(path.join(dir, 'relay.json'), '{"url":"https://x","key":"k"}');
  assert.throws(() => loadRelayConfig(dir), /wss:\/\//);
  fs.writeFileSync(path.join(dir, 'relay.json'), '{"url":"wss://pc.example.com/","key":"short"}');
  assert.throws(() => loadRelayConfig(dir), /key/);
  fs.writeFileSync(path.join(dir, 'relay.json'), `﻿{"url":"wss://pc.example.com/","key":"${'k'.repeat(40)}"}`);
  assert.equal(loadRelayConfig(dir).url, 'wss://pc.example.com');
});

test('phone ⇄ relay ⇄ relay client ⇄ local agent splice', { skip: !relayAvailable && 'run npm install in relay/' }, async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const relayPort = await freePort();
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-relayweb-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  const relay = spawn(process.execPath, [path.join(RELAY_DIR, 'server.js')], {
    env: { ...process.env, RELAY_KEY: key, PORT: String(relayPort), HOST: '127.0.0.1', WEB_ROOT: webRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayOut = '';
  relay.stdout.on('data', (d) => { relayOut += d; });
  relay.stderr.on('data', (d) => { relayOut += d; });
  cleanups.push(async () => { relay.kill(); fs.rmSync(webRoot, { recursive: true, force: true }); });
  await waitFor(() => relayOut.includes('TermPocket relay'));

  // Stand-in agent: echoes frames and records the upgrade headers the relay client sends.
  const seen = [];
  const agentHttp = http.createServer();
  const wss = new WebSocketServer({ server: agentHttp, path: '/ws' });
  wss.on('connection', (ws, req) => {
    seen.push({ host: req.headers.host, xff: req.headers['x-forwarded-for'], origin: req.headers.origin, via: req.headers['x-termpocket-via'] });
    ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
  });
  await new Promise((r) => agentHttp.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { wss.close(); agentHttp.close(() => r()); }));

  // Wrong key: relay must refuse the control socket.
  const bad = startRelayClient({ relay: { url: `ws://127.0.0.1:${relayPort}`, key: 'x'.repeat(40) }, port: agentHttp.address().port, log: quiet });
  await waitFor(() => relayOut.includes('bad relay key'));
  bad.dispose();

  const client = startRelayClient({ relay: { url: `ws://127.0.0.1:${relayPort}`, key }, port: agentHttp.address().port, log: quiet });
  cleanups.push(() => client.dispose());
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${relayPort}/healthz`).then((x) => x.json());
    return r.pcOnline;
  });

  // Static files come from the relay itself.
  assert.equal((await fetch(`http://127.0.0.1:${relayPort}/`)).status, 200);

  const phone = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`, { headers: { Origin: 'https://pc.example.com', 'X-Forwarded-For': '203.0.113.9' } });
  const got = [];
  phone.on('message', (d, isBinary) => got.push({ d: Buffer.from(d), isBinary }));
  await new Promise((r, j) => { phone.on('open', r); phone.on('error', j); });
  // Sent immediately — before the bridge has opened its sockets — so this exercises queueing.
  phone.send(JSON.stringify({ t: 'req', id: 1, m: 'auth' }));
  phone.send(Buffer.from([1, 2, 3, 4]), { binary: true });
  await waitFor(() => got.length >= 2);
  assert.equal(got[0].isBinary, false);
  assert.deepEqual(JSON.parse(got[0].d), { t: 'req', id: 1, m: 'auth' });
  assert.equal(got[1].isBinary, true);
  assert.deepEqual([...got[1].d], [1, 2, 3, 4]);

  // Headers the agent relies on: public Host (relay.json host), the browser Origin, a non-empty XFF.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].host, `127.0.0.1:${relayPort}`);
  assert.equal(seen[0].origin, 'https://pc.example.com');
  assert.ok(seen[0].xff && seen[0].xff !== '', 'X-Forwarded-For must be non-empty');
  assert.equal(seen[0].via, 'relay', 'relayed sockets are marked for the local monitor');

  // Closing the phone tears the local socket down too.
  phone.close(1000);
  await waitFor(() => client.status().sessions === 0);
  const st = client.status();
  assert.equal(st.connected, true);
  // Local monitor fields: since/url set while connected, and the relay key never appears.
  assert.equal(st.configured, true);
  assert.equal(st.url, `ws://127.0.0.1:${relayPort}`);
  assert.ok(Number.isFinite(st.since) && st.since <= Date.now());
  assert.equal(st.lastError, null);
  assert.ok(!JSON.stringify(st).includes(key), 'relay key must not appear in status()');
});

test('relay client keeps retrying after an HTTP error on the control socket (relay restarting)', async () => {
  // The first upgrades get "503" (like a proxy in front of a restarting relay), later ones succeed.
  const port = await freePort();
  const srv = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let attempts = 0;
  srv.on('upgrade', (req, sock, head) => {
    attempts += 1;
    if (attempts <= 1) {
      sock.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndown');
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => ws.on('message', () => {}));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const client = startRelayClient({ relay: { url: `ws://127.0.0.1:${port}`, key: 'k'.repeat(40) }, port: 1, log: quiet });
  cleanups.push(async () => { client.dispose(); for (const c of wss.clients) c.terminate(); await new Promise((r) => srv.close(r)); });
  await waitFor(() => client.status().lastError?.includes('HTTP 503'), 4000);
  assert.equal(client.status().connected, false);
  // Before the fix ws left the refused socket CONNECTING forever and never reconnected.
  await waitFor(() => client.status().connected, 6000);
  assert.ok(attempts >= 2);
  assert.equal(client.status().lastError, null);
});

test('relay client status: an open but silent control socket is reported as not connected', async () => {
  const port = await freePort();
  const srv = http.createServer();
  // autoPong off and no {t:"pong"} answers: a half-open connection as seen from the PC.
  const wss = new WebSocketServer({ server: srv, autoPong: false });
  wss.on('connection', (ws) => ws.on('message', () => {}));
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const client = startRelayClient({ relay: { url: `ws://127.0.0.1:${port}`, key: 'k'.repeat(40) }, port: 1, log: quiet, pingMs: 100, silenceMs: 60_000, staleMs: 400 });
  cleanups.push(async () => { client.dispose(); for (const c of wss.clients) c.terminate(); await new Promise((r) => srv.close(r)); });
  await waitFor(() => client.status().connected, 4000);
  const st = await waitFor(() => { const s = client.status(); return s.connected ? null : s; }, 4000);
  assert.match(st.lastError, /not answering/);
  assert.equal(st.since, null);
});
