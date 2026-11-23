// Local monitor tests: GET /status, POST /status/selftest, GET /monitor/ (loopback only), the log
// ring buffer with secret redaction, and the status() hooks of pty / hub / screen / helper / relay.
// Uses fake handler sets and a fake PTY spawn — never touches the real desktop or the live agent.
//
// Run with: npm test   (or node --test test/monitor.test.mjs)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { createAgentServer, createPhoneRegistry, isDirectLoopbackNoProxy, phoneVia, VERSION } from '../src/server.js';
import { createPtyManager } from '../src/pty.js';
import { createVscodeHub } from '../src/vscodeHub.js';
import { createLogRing, redactSecrets, createSelftestMarkers, MONITOR_ROOT } from '../src/monitor.js';
import { createWinHelper } from '../src/winhelper.js';
import { startRelayClient } from '../src/relayClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = crypto.randomBytes(32).toString('base64url');
const RELAY_KEY = crypto.randomBytes(32).toString('base64url');

/** Fake @lydell/node-pty spawn: no real process. */
function fakeSpawn() {
  return {
    pid: 4242,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
}

/** HTTP request with full control over Host and other headers (fetch cannot set Host). */
function request(port, { method = 'GET', pathname = '/status', host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

/** Opens /ws, authenticates; resolves {ws, rpc(m, p)}. */
function phone(port, { token = TOKEN, client = 'pwa', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    let nextId = 1;
    const pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'res' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.r) : p.reject(new Error(msg.e));
      }
    });
    const rpc = (m, p = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ t: 'req', id, m, p }));
      });
    ws.once('error', reject);
    ws.once('open', () => {
      rpc('auth', { token, client }).then(() => resolve({ ws, rpc }), (err) => {
        ws.close();
        reject(err);
      });
    });
  });
}

const closeWs = (ws) =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
    ws.close();
  });

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ------------------------------------------------------------------------------------------------
// A test agent: real server + pty manager (fake spawn) + hub + fake system/screen handler sets.
// ------------------------------------------------------------------------------------------------

function makeAgent({ rateLimit, publicUrl } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-monitor-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    defaultShell: 'cmd.exe',
    scrollbackBytes: 65536,
    configDir: home,
    publicUrl: publicUrl ?? undefined,
  };
  const registry = createPhoneRegistry();
  const pty = createPtyManager({ config, log: quietLog, registry, spawn: fakeSpawn });
  const hub = createVscodeHub({ log: quietLog, registry, pty, version: VERSION });
  const streaming = new Set();
  const system = {
    methods: {
      'sys.info': async () => ({ hostname: 'TESTPC', user: 'tester', os: 'test' }),
    },
  };
  const screen = {
    methods: {
      'screen.start': async (_p, client) => {
        streaming.add(client);
        return { monitor: { index: 0 }, fps: 1, quality: 50, maxWidth: 1280 };
      },
      'screen.stop': async (_p, client) => {
        streaming.delete(client);
        return true;
      },
    },
    onClientClose(client) {
      streaming.delete(client);
    },
    monitorStatus: () => ({ screen: { streams: streaming.size } }),
    describeClient: (client) => ({ streaming: streaming.has(client) }),
  };
  const ring = createLogRing(200);
  ring.addSecret(TOKEN);
  ring.addSecret(RELAY_KEY);
  ring.push('INFO ', 'server', 'ready');
  ring.push('WARN ', '', '[winhelper] helper exited (code 1); will restart on next request');
  ring.push('INFO ', 'relay', `Pairing link: https://pc.example.com/#token=${TOKEN}`);
  ring.push('ERROR', 'relay', `oops Authorization: Bearer ${RELAY_KEY}`);
  const monitor = {
    log: () => ring.entries(),
    helper: () => ({ running: false, pid: null, restarts: 0, lastError: null }),
    relay: null,
    relayConfigured: false,
    secrets: () => ring.secrets,
  };
  const server = createAgentServer({ config, log: quietLog, handlerSets: [pty, hub, system, screen], registry, rateLimit, monitor });
  return {
    config,
    server,
    pty,
    ring,
    monitor,
    async start() {
      const { port } = await server.listen(0, '127.0.0.1');
      return port;
    },
    async stop() {
      await server.close();
      await pty.dispose();
      await hub.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------------------------------------

describe('GET /status', () => {
  let agent;
  let port;
  before(async () => {
    agent = makeAgent({ rateLimit: { max: 2, windowMs: 60_000 } });
    port = await agent.start();
  });
  after(async () => agent.stop());

  test('returns the contract shape with no-store caching', async () => {
    const r = await request(port);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const s = JSON.parse(r.text);
    assert.equal(s.ok, true);
    assert.equal(s.version, VERSION);
    assert.equal(s.pid, process.pid);
    assert.ok(Number.isFinite(s.startedAt) && s.startedAt <= s.now);
    assert.ok(Number.isInteger(s.uptimeSec) && s.uptimeSec >= 0);
    assert.deepEqual(s.listen, { host: '127.0.0.1', port });
    assert.equal(s.publicUrl, null);
    assert.deepEqual(s.relay, { configured: false, url: null, connected: false, since: null, sessions: 0, lastError: null, reconnects: 0 });
    assert.deepEqual(s.phones, []);
    assert.deepEqual(s.vscode, []);
    assert.deepEqual(s.terminals, []);
    assert.deepEqual(s.screen, { streams: 0 });
    assert.deepEqual(s.helper, { running: false, pid: null, restarts: 0, lastError: null });
    assert.deepEqual(s.security, { authFailures: 0, rateLimitedIps: 0, lastAuthFailure: null });
    assert.ok(Array.isArray(s.log) && s.log.length === 4);
    for (const l of s.log) {
      assert.ok(Number.isFinite(l.at));
      assert.ok(['INFO', 'WARN', 'ERROR'].includes(l.level), l.level);
      assert.equal(typeof l.scope, 'string');
      assert.equal(typeof l.msg, 'string');
    }
    // Unscoped "[winhelper] …" lines get their prefix as scope.
    assert.deepEqual(
      s.log.map((l) => [l.level, l.scope]),
      [['INFO', 'server'], ['WARN', 'winhelper'], ['INFO', 'relay'], ['ERROR', 'relay']],
    );
    assert.equal(s.log[1].msg, 'helper exited (code 1); will restart on next request');
  });

  test('the token and the relay key never appear (log, pairing links, any source)', async () => {
    // A source that leaks the token outright is still scrubbed by the final pass.
    agent.monitor.relay = () => ({ configured: true, url: 'wss://pc.example.com', connected: false, lastError: `bad key ${RELAY_KEY} / token ${TOKEN}` });
    try {
      const r = await request(port);
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes(TOKEN), 'token leaked into /status');
      assert.ok(!r.text.includes(RELAY_KEY), 'relay key leaked into /status');
      assert.match(r.text, /#token=\[redacted\]/);
      assert.match(r.text, /Bearer \[redacted\]/);
      const s = JSON.parse(r.text);
      assert.equal(s.relay.configured, true);
      assert.equal(s.relay.url, 'wss://pc.example.com');
    } finally {
      agent.monitor.relay = null;
    }
  });

  test('phones: ip, via, client, attached terminals, streaming; terminals with attached counts', async () => {
    const a = await phone(port, { client: 'pwa' });
    // A relayed socket: loopback peer + X-TermPocket-Via: relay + the relay's X-Forwarded-For hop.
    const b = await phone(port, { client: 'laptop', headers: { 'X-Forwarded-For': '203.0.113.9', 'X-TermPocket-Via': 'relay' } });
    try {
      const sess = await a.rpc('pty.create', { cwd: os.tmpdir(), title: 'Build' });
      await a.rpc('pty.attach', { id: sess.id });
      await b.rpc('screen.start', {});
      const s = JSON.parse((await request(port)).text);
      assert.equal(s.phones.length, 2);
      const pa = s.phones.find((p) => p.client === 'pwa');
      const pb = s.phones.find((p) => p.client === 'laptop');
      assert.ok(Number.isInteger(pa.id) && pa.id !== pb.id);
      assert.equal(pa.ip, '127.0.0.1');
      assert.equal(pa.via, 'direct');
      assert.deepEqual(pa.attached, [sess.id]);
      assert.equal(pa.streaming, false);
      assert.ok(Number.isFinite(pa.connectedAt));
      assert.equal(pb.ip, '203.0.113.9');
      assert.equal(pb.via, 'relay');
      assert.deepEqual(pb.attached, []);
      assert.equal(pb.streaming, true);
      assert.deepEqual(s.screen, { streams: 1 });
      assert.deepEqual(s.terminals, [{ id: sess.id, title: 'Build', pid: 4242, exited: false, mirror: false, attachedClients: 1 }]);
      // Where the terminals live (§2.1 ptyHost): this test agent keeps them in-process.
      assert.equal(s.ptyHost.mode, 'inprocess');
      assert.equal(s.ptyHost.running, true);
      assert.equal(s.ptyHost.pid, process.pid);
      assert.equal(s.ptyHost.sessions, 1);
      assert.equal(s.ptyHost.live, 1);
      assert.equal(s.ptyHost.lastError, null);
    } finally {
      await closeWs(a.ws);
      await closeWs(b.ws);
    }
    await waitFor(async () => JSON.parse((await request(port)).text).phones.length === 0);
    const s = JSON.parse((await request(port)).text);
    assert.equal(s.terminals[0].attachedClients, 0);
    assert.deepEqual(s.screen, { streams: 0 });
  });

  test('X-TermPocket-Via only counts from a loopback peer', () => {
    const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
    assert.equal(phoneVia(req('127.0.0.1', { 'x-termpocket-via': 'relay' })), 'relay');
    assert.equal(phoneVia(req('::ffff:127.0.0.1', { 'x-termpocket-via': 'relay' })), 'relay');
    assert.equal(phoneVia(req('192.168.1.20', { 'x-termpocket-via': 'relay' })), 'direct');
    assert.equal(phoneVia(req('127.0.0.1', {})), 'direct');
  });

  test('security: failed auths and rate-limited IPs are counted', async () => {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(phone(port, { token: 'wrong', headers: { 'X-Forwarded-For': '198.51.100.7' } }), /bad token/);
    }
    const s = JSON.parse((await request(port)).text);
    assert.equal(s.security.authFailures, 2);
    assert.equal(s.security.rateLimitedIps, 1);
    assert.equal(s.security.lastAuthFailure.ip, '198.51.100.7');
    assert.ok(s.security.lastAuthFailure.at <= s.now);
  });

  test('VS Code windows are listed', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode`);
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    const answered = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ t: 'req', id: 1, m: 'hello', p: { token: TOKEN, windowId: 'w-1', name: 'my-project', folders: ['E:\\proj'], vscodeVersion: '1.99.0', pid: 1 } }));
    assert.equal((await answered).ok, true);
    try {
      const s = JSON.parse((await request(port)).text);
      assert.equal(s.vscode.length, 1);
      assert.equal(s.vscode[0].windowId, 'w-1');
      assert.equal(s.vscode[0].name, 'my-project');
      assert.deepEqual(s.vscode[0].folders, ['E:\\proj']);
      assert.ok(Number.isFinite(s.vscode[0].connectedAt));
    } finally {
      await closeWs(ws);
    }
  });
});

describe('loopback-only rules (/status, /status/selftest, /monitor)', () => {
  let agent;
  let port;
  before(async () => {
    agent = makeAgent();
    port = await agent.start();
  });
  after(async () => agent.stop());

  const PATHS = [
    ['GET', '/status'],
    ['POST', '/status/selftest'],
    ['GET', '/monitor'],
    ['GET', '/monitor/'],
    ['GET', '/monitor/monitor.js'],
  ];

  for (const header of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'Tailscale-User-Login', 'X-Forwarded-Host', 'X-TermPocket-Via']) {
    test(`a proxy header (${header}) → 404`, async () => {
      for (const [method, pathname] of PATHS) {
        const value = header === 'Forwarded' ? 'for=203.0.113.9' : header === 'X-TermPocket-Via' ? 'relay' : '203.0.113.9';
        const r = await request(port, { method, pathname, headers: { [header]: value, 'X-TermPocket-Monitor': '1' } });
        assert.equal(r.status, 404, `${method} ${pathname} with ${header}`);
        assert.ok(!r.text.includes('"phones"'));
      }
    });
  }

  test('a foreign Host is refused (421) and a non-loopback allowed name gets 404', async () => {
    for (const [method, pathname] of PATHS) {
      const evil = await request(port, { method, pathname, host: `attacker.example:${port}`, headers: { 'X-TermPocket-Monitor': '1' } });
      assert.equal(evil.status, 421, `${method} ${pathname}`);
      // Allowed by the general host policy (Tailscale name / LAN IP) but not a loopback name.
      for (const host of [`mypc.tail1234.ts.net`, `192.168.1.20:${port}`]) {
        const r = await request(port, { method, pathname, host, headers: { 'X-TermPocket-Monitor': '1' } });
        assert.equal(r.status, 404, `${method} ${pathname} Host ${host}`);
      }
    }
  });

  test('loopback Host names are accepted', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await request(port, { host })).status, 200, host);
    }
  });

  test('non-loopback peers are refused (unit)', () => {
    const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
    assert.equal(isDirectLoopbackNoProxy(req('127.0.0.1')), true);
    assert.equal(isDirectLoopbackNoProxy(req('::1')), true);
    assert.equal(isDirectLoopbackNoProxy(req('::ffff:127.0.0.1')), true);
    assert.equal(isDirectLoopbackNoProxy(req('100.101.102.103')), false);
    assert.equal(isDirectLoopbackNoProxy(req('192.168.1.20')), false);
    assert.equal(isDirectLoopbackNoProxy(req('127.0.0.1', { 'x-real-ip': '1.2.3.4' })), false);
    assert.equal(isDirectLoopbackNoProxy(req('127.0.0.1', { forwarded: 'for=1.2.3.4' })), false);
  });

  test('cross-site browser requests are refused (Origin / Sec-Fetch-Site)', async () => {
    let r = await request(port, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(r.status, 403);
    r = await request(port, { headers: { Origin: `http://localhost:${port + 1}` } });
    assert.equal(r.status, 403);
    r = await request(port, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    r = await request(port, { headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 200);
  });

  test('wrong methods → 405', async () => {
    assert.equal((await request(port, { method: 'POST', pathname: '/status' })).status, 405);
    assert.equal((await request(port, { method: 'GET', pathname: '/status/selftest' })).status, 405);
    assert.equal((await request(port, { method: 'POST', pathname: '/monitor/', headers: { 'X-TermPocket-Monitor': '1' } })).status, 405);
  });

  test('/monitor serves the dashboard with a strict CSP; unknown files 404', async () => {
    for (const pathname of ['/monitor', '/monitor/']) {
      const r = await request(port, { pathname });
      assert.equal(r.status, 200, pathname);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.text, /TermPocket Monitor/);
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      assert.match(r.headers['content-security-policy'], /connect-src 'self'/);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-frame-options'], 'DENY');
    }
    const js = await request(port, { pathname: '/monitor/monitor.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /text\/javascript/);
    const css = await request(port, { pathname: '/monitor/monitor.css' });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal((await request(port, { pathname: '/monitor/icon.svg' })).status, 200);
    assert.equal((await request(port, { pathname: '/monitor/nope.js' })).status, 404);
    assert.equal((await request(port, { pathname: '/monitor/..%2Fsrc%2Fserver.js' })).status, 404);
  });
});

describe('POST /status/selftest', () => {
  let agent;
  let port;
  before(async () => {
    agent = makeAgent();
    port = await agent.start();
  });
  after(async () => agent.stop());

  test('requires the X-TermPocket-Monitor: 1 header', async () => {
    assert.equal((await request(port, { method: 'POST', pathname: '/status/selftest' })).status, 403);
    assert.equal((await request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '0' } })).status, 403);
  });

  test('local steps pass against a running agent; public skipped without a public URL', async () => {
    const r = await request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '1' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(!r.text.includes(TOKEN));
    const out = JSON.parse(r.text);
    assert.equal(out.ok, true, r.text);
    assert.ok(out.steps.length >= 3);
    for (const st of out.steps) {
      assert.equal(typeof st.name, 'string');
      assert.equal(typeof st.ok, 'boolean');
      assert.ok(Number.isFinite(st.ms));
      assert.equal(typeof st.detail, 'string');
    }
    assert.match(out.steps[0].name, /healthz/);
    assert.equal(out.steps[0].ok, true);
    assert.match(out.steps[1].name, /sys\.info/);
    assert.equal(out.steps[1].ok, true);
    assert.match(out.steps[1].detail, /TESTPC/);
    assert.match(out.steps[2].detail, /skipped/);
    // The self-test's own phone connection is never listed as a phone.
    const s = JSON.parse((await request(port)).text);
    assert.deepEqual(s.phones, []);
  });

  test('concurrent runs share one test', async () => {
    const [a, b] = await Promise.all([
      request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '1' } }),
      request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '1' } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(JSON.parse(a.text).ok, true);
    assert.equal(JSON.parse(b.text).ok, true);
  });

  test('a public URL that does not answer fails the public steps within the time budget', async () => {
    // A port nothing listens on: both public steps must fail fast and the whole run stays ≤ 15 s.
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    agent.config.publicUrl = `http://127.0.0.1:${deadPort}`;
    agent.monitor.relayConfigured = true;
    try {
      const t0 = Date.now();
      const r = await request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '1' } });
      assert.ok(Date.now() - t0 < 15_500);
      const out = JSON.parse(r.text);
      assert.equal(out.ok, false);
      assert.equal(out.steps.length, 4);
      assert.deepEqual(out.steps.map((s) => s.ok), [true, true, false, false]);
    } finally {
      agent.config.publicUrl = undefined;
      agent.monitor.relayConfigured = false;
    }
  });

  test('public round trip works through a proxy that behaves like the relay', async () => {
    // A stand-in public endpoint: /healthz says pcOnline:true and /ws is spliced to the agent with
    // the headers the relay bridge sets — proving the "phone path" check end to end.
    const pub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, relay: 'test', pcOnline: true }));
    });
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ server: pub, path: '/ws' });
    let seenOrigin = null;
    wss.on('connection', (client, req) => {
      seenOrigin = req.headers.origin;
      const local = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { 'X-Forwarded-For': '203.0.113.50', 'X-TermPocket-Via': 'relay', Host: `127.0.0.1:${port}`, Origin: req.headers.origin },
      });
      const queue = [];
      client.on('message', (d, bin) => (local.readyState === WebSocket.OPEN ? local.send(d, { binary: bin }) : queue.push([d, bin])));
      local.on('open', () => queue.splice(0).forEach(([d, bin]) => local.send(d, { binary: bin })));
      local.on('message', (d, bin) => client.send(d, { binary: bin }));
      local.on('close', () => client.close());
      client.on('close', () => local.close());
      local.on('error', () => client.terminate());
    });
    await new Promise((r) => pub.listen(0, '127.0.0.1', r));
    const pubUrl = `http://127.0.0.1:${pub.address().port}`;
    agent.config.allowedHosts = [pubUrl];
    agent.config.publicUrl = pubUrl;
    agent.monitor.relayConfigured = true;
    try {
      const r = await request(port, { method: 'POST', pathname: '/status/selftest', headers: { 'X-TermPocket-Monitor': '1' } });
      const out = JSON.parse(r.text);
      assert.equal(out.ok, true, r.text);
      assert.equal(out.steps.length, 4);
      assert.match(out.steps[2].detail, /pcOnline: true/);
      assert.match(out.steps[3].detail, /sys\.info/);
      assert.equal(seenOrigin, pubUrl, 'the public round trip sends Origin = publicUrl');
    } finally {
      agent.config.publicUrl = undefined;
      agent.config.allowedHosts = undefined;
      agent.monitor.relayConfigured = false;
      wss.close();
      await new Promise((r) => pub.close(r));
    }
  });
});

describe('log ring, redaction and status hooks', () => {
  test('ring keeps the last 200 lines and redacts secrets and pairing links', () => {
    const ring = createLogRing(200);
    ring.addSecret(TOKEN);
    for (let i = 0; i < 250; i++) ring.push('INFO ', 'pty', `line ${i}`);
    ring.push('INFO ', 'server', `token is ${TOKEN}`);
    ring.push('WARN ', 'server', 'open http://x/#token=abcdefghijklmnop now');
    ring.push('INFO ', 'server', '{"token":"zzzzzzzzzzzz","other":1}');
    const e = ring.entries();
    assert.equal(e.length, 200);
    assert.equal(e[e.length - 1].scope, 'server');
    assert.ok(!JSON.stringify(e).includes(TOKEN));
    assert.equal(e[e.length - 3].msg, 'token is [redacted]');
    assert.equal(e[e.length - 2].msg, 'open http://x/#token=[redacted] now');
    assert.equal(e[e.length - 2].level, 'WARN');
    assert.equal(e[e.length - 1].msg, '{"token":"[redacted]","other":1}');
  });

  test('redactSecrets handles query tokens and bearer credentials', () => {
    assert.equal(redactSecrets('GET /x?token=abc123&y=1'), 'GET /x?token=[redacted]&y=1');
    assert.equal(redactSecrets('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer [redacted]');
    assert.equal(redactSecrets('plain text'), 'plain text');
    // Never eats a JSON escape (that would corrupt serialised output).
    const json = JSON.stringify({ m: 'see "http://x/#token=abc"' });
    assert.deepEqual(JSON.parse(redactSecrets(json)), { m: 'see "http://x/#token=[redacted]"' });
  });

  test('self-test markers are one-time and process-issued', () => {
    const m = createSelftestMarkers();
    const a = m.create();
    assert.ok(m.has(a));
    assert.equal(m.has('selftest-forged'), false);
    m.release(a);
    assert.equal(m.has(a), false);
  });

  test('a phone cannot hide from /status by naming itself like the self-test', async () => {
    const agent = makeAgent();
    const port = await agent.start();
    try {
      const p = await phone(port, { client: 'selftest-AAAAAAAAAAAAAAAA' });
      const s = JSON.parse((await request(port)).text);
      assert.equal(s.phones.length, 1);
      assert.equal(s.phones[0].client, 'selftest-AAAAAAAAAAAAAAAA');
      await closeWs(p.ws);
    } finally {
      await agent.stop();
    }
  });

  test('winhelper status() reports idle without starting the helper', async () => {
    const h = createWinHelper({ log: quietLog });
    assert.deepEqual(h.status(), { running: false, pid: null, restarts: 0, lastError: null });
    await h.dispose();
  });

  test('relay client status() tracks failures and never exposes the key', async () => {
    // Nothing listens on this port: the control socket fails and retries.
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    const client = startRelayClient({ relay: { url: `ws://127.0.0.1:${deadPort}`, key: RELAY_KEY }, port: 1, log: quietLog });
    try {
      await waitFor(() => client.status().reconnects >= 1);
      const st = client.status();
      assert.equal(st.configured, true);
      assert.equal(st.connected, false);
      assert.equal(st.since, null);
      assert.equal(st.url, `ws://127.0.0.1:${deadPort}`);
      assert.match(st.lastError, /relay socket error/);
      assert.ok(!JSON.stringify(st).includes(RELAY_KEY));
    } finally {
      client.dispose();
    }
  });

  test('the dashboard never uses innerHTML and loads nothing external; the PWA service worker bypasses it', () => {
    const files = ['index.html', 'monitor.js', 'monitor.css'].map((f) => fs.readFileSync(path.join(MONITOR_ROOT, f), 'utf8'));
    for (const text of files) {
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text));
      assert.ok(!/(?:src|href)=["']https?:/i.test(text), 'no external resources');
      assert.ok(!/@import|url\(\s*["']?https?:/i.test(text), 'no external css');
    }
    const sw = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'sw.js'), 'utf8');
    const bypass = /const BYPASS = (\/.*\/);/.exec(sw);
    assert.ok(bypass, 'sw.js BYPASS regex');
    // eslint-disable-next-line no-eval
    const re = eval(bypass[1]);
    for (const p of ['/status', '/status/selftest', '/monitor', '/monitor/', '/monitor/monitor.js']) assert.ok(re.test(p), p);
    assert.ok(!re.test('/index.html'));
    assert.ok(!/monitor/.test(sw.slice(sw.indexOf('const CORE'), sw.indexOf('const SCOPE'))), 'monitor files are not in the PWA cache list');
  });
});
