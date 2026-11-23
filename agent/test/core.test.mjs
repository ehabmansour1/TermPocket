// Core agent tests: HTTP, auth, rate limit, RPC, PTY sessions and the VS Code hub (with a fake
// extension). System / screen handler sets are fakes — these tests never touch the real desktop.
//
// Run with: npm test   (node --test test/)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

import { loadConfig, getConfigPath, envValue, applyLegacyEnv, getLegacyConfigDir, migrateLegacyConfigDir } from '../src/config.js';
import crypto from 'node:crypto';
import { createAgentServer, createPhoneRegistry, VERSION, tokenMatches, remoteIpOf, rateLimitKey, createHostPolicy, parseHostHeader, agentProof, extensionProof } from '../src/server.js';
import { createPtyManager } from '../src/pty.js';
import { createVscodeHub } from '../src/vscodeHub.js';
import { makeConn, parseFrame } from '../src/rpc.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_SHELL = process.platform === 'win32' ? 'cmd.exe' : 'sh';

// ------------------------------------------------------------------------------------------------
// Test client: a minimal RPC peer that records everything it receives.
// ------------------------------------------------------------------------------------------------

class Peer {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.binary = [];
    this.waiters = new Set();
    this.requestHandler = null;
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.binary.push(Buffer.from(data));
        this.check();
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.t === 'res') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.r) : p.reject(new Error(msg.e));
        }
      } else if (msg.t === 'evt') {
        this.events.push(msg);
        this.check();
      } else if (msg.t === 'req') {
        this.events.push(msg); // requests from the agent are recorded too (for the fake extension)
        this.check();
        if (this.requestHandler) {
          Promise.resolve()
            .then(() => this.requestHandler(msg.m, msg.p))
            .then(
              (r) => this.send({ t: 'res', id: msg.id, ok: true, r }),
              (err) => this.send({ t: 'res', id: msg.id, ok: false, e: err.message }),
            );
        }
      }
    });
  }

  static open(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const peer = new Peer(ws);
      ws.once('open', () => resolve(peer));
      ws.once('error', reject);
    });
  }

  send(obj) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  request(m, p, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`test timeout waiting for ${m}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ t: 'req', id, m, p });
    });
  }

  notify(ev, p) {
    this.send({ t: 'evt', ev, p });
  }

  check() {
    for (const w of [...this.waiters]) {
      const found = w.find();
      if (found !== undefined) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(found);
      }
    }
  }

  /** Wait for a recorded event/request (t evt|req) matching `ev`/`m` and predicate; consumes it. */
  waitFor(name, pred = () => true, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        find: () => {
          const i = this.events.findIndex((e) => (e.ev ?? e.m) === name && pred(e.p ?? {}));
          if (i === -1) return undefined;
          return this.events.splice(i, 1)[0];
        },
      };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timeout waiting for ${name}`));
      }, timeoutMs);
      this.waiters.add(w);
      this.check();
    });
  }

  /** Accumulate pty.data / mirror.data text for an id until `re` matches. */
  waitForOutput(ev, idKey, id, re, timeoutMs = 15_000) {
    let acc = '';
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        find: () => {
          for (let i = 0; i < this.events.length; i++) {
            const e = this.events[i];
            if (e.ev === ev && e.p?.[idKey] === id) {
              acc += e.p.d;
              this.events.splice(i--, 1);
            }
          }
          return re.test(acc) ? acc : undefined;
        },
      };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timeout waiting for output ${re}; got ${JSON.stringify(acc.slice(-500))}`));
      }, timeoutMs);
      this.waiters.add(w);
      this.check();
    });
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

function httpGet(port, urlPath, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------
// Fixture
// ------------------------------------------------------------------------------------------------

let tmp;
let config;
let server;
let pty;
let hub;
let port;
let wsUrl;
let vscodeUrl;
const closedClients = [];

function makeFakeSets() {
  const system = {
    methods: {
      'sys.info': async () => ({ hostname: 'fake', fake: true }),
      'sys.fail': async () => {
        throw new Error('fake failure');
      },
    },
    onClientClose(client) {
      closedClients.push(client.id);
    },
    async dispose() {},
  };
  const screen = {
    methods: {
      'screen.start': async () => ({ fake: true }),
      'input.mouse': async () => true,
      // Sends a binary frame to the calling client, like the real screen stream does.
      'screen.snapshot': async (_p, client) => {
        const frame = Buffer.from([0x01, 0, 0, 0, 7, 0, 0, 0xff, 0xd8, 0xff]);
        client.sendBinary(frame);
        return { sent: true, bufferedAmountType: typeof client.bufferedAmount, open: client.isOpen() };
      },
    },
    onClientClose() {},
    async dispose() {},
  };
  return { system, screen };
}

async function authedPhone() {
  const phone = await Peer.open(wsUrl);
  const info = await phone.request('auth', { token: config.token, client: 'test' });
  return { phone, info };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-test-'));
  const home = path.join(tmp, 'home');
  const web = path.join(tmp, 'web');
  fs.mkdirSync(path.join(web, 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(web, 'js'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log("app")');
  fs.writeFileSync(path.join(web, 'sw.js'), '// sw');
  fs.writeFileSync(path.join(web, 'manifest.webmanifest'), '{"name":"TermPocket"}');
  fs.writeFileSync(path.join(web, 'vendor', 'xterm.js'), '// xterm');
  fs.writeFileSync(path.join(web, '.secret'), 'dotfile');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP-SECRET');

  config = loadConfig({ env: { ...process.env, TERMPOCKET_HOME: home, TERMPOCKET_PORT: '0', TERMPOCKET_HOST: '127.0.0.1' } });
  config.defaultShell = TEST_SHELL;

  const registry = createPhoneRegistry();
  pty = createPtyManager({ config, log: quietLog, registry });
  hub = createVscodeHub({ log: quietLog, registry, pty, version: VERSION, callTimeoutMs: 400 });
  const { system, screen } = makeFakeSets();
  server = createAgentServer({
    config,
    log: quietLog,
    registry,
    handlerSets: [pty, hub, system, screen],
    webRoot: web,
    authTimeoutMs: 400,
  });
  ({ port } = await server.listen(0, '127.0.0.1'));
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  vscodeUrl = `ws://127.0.0.1:${port}/vscode`;
});

after(async () => {
  await server?.close();
  await hub?.dispose();
  await pty?.dispose();
  await delay(200); // let ConPTY processes exit before removing the temp dir
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle briefly; the OS temp cleaner will get it */
  }
});

// ------------------------------------------------------------------------------------------------
// Config & helpers
// ------------------------------------------------------------------------------------------------

describe('config', () => {
  test('creates config.json with a random token and defaults', () => {
    const file = getConfigPath({ TERMPOCKET_HOME: path.join(tmp, 'home') });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.port, 8765, 'env overrides are not persisted');
    assert.equal(stored.host, '127.0.0.1');
    assert.match(stored.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(stored.defaultShell, 'powershell.exe');
    assert.equal(stored.scrollbackBytes, 262144);
    assert.deepEqual(stored.screen, { fps: 2, quality: 50, maxWidth: 1280 });
    assert.ok(fs.readFileSync(file, 'utf8').includes('\n  "port"'), 'pretty-printed');
    assert.equal(config.port, 0, 'TERMPOCKET_PORT applied at runtime');
  });

  test('keeps the token across loads, fills missing keys, honours publicUrl', () => {
    const home = path.join(tmp, 'home2');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '\ufeff{"token":"abcdefghijklmnopqrstuvwxyz012345","port":9999,"publicUrl":"https://pc.example.ts.net/"}');
    const c = loadConfig({ env: { TERMPOCKET_HOME: home } });
    assert.equal(c.token, 'abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(c.port, 9999);
    assert.equal(c.publicUrl, 'https://pc.example.ts.net');
    assert.equal(c.defaultShell, 'powershell.exe');
    const c2 = loadConfig({ env: { TERMPOCKET_HOME: home, TERMPOCKET_PUBLIC_URL: 'https://other.ts.net' } });
    assert.equal(c2.publicUrl, 'https://other.ts.net');
  });

  test('refuses to overwrite an invalid config file', () => {
    const home = path.join(tmp, 'home3');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
    assert.throws(() => loadConfig({ env: { TERMPOCKET_HOME: home } }), /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{ not json');
  });

  test('old VSCONTROL_* variables still work; TERMPOCKET_* win when both are set', () => {
    const home = path.join(tmp, 'home-legacy-env');
    const c = loadConfig({ env: { VSCONTROL_HOME: home, VSCONTROL_PORT: '4321', VSCONTROL_PUBLIC_URL: 'https://old.example.com/' } });
    assert.equal(c.configDir, path.resolve(home));
    assert.equal(c.port, 4321);
    assert.equal(c.publicUrl, 'https://old.example.com');
    const c2 = loadConfig({ env: { VSCONTROL_HOME: path.join(tmp, 'nope'), TERMPOCKET_HOME: home, VSCONTROL_PORT: '4321', TERMPOCKET_PORT: '5432' } });
    assert.equal(c2.configDir, path.resolve(home));
    assert.equal(c2.port, 5432);
    assert.equal(envValue({ VSCONTROL_X: 'a' }, 'X'), 'a');
    assert.equal(envValue({ VSCONTROL_X: 'a', TERMPOCKET_X: 'b' }, 'X'), 'b');
    const env = applyLegacyEnv({ VSCONTROL_DRYRUN_INPUT: '1', VSCONTROL_PORT: '1', TERMPOCKET_PORT: '2', OTHER: 'x' });
    assert.equal(env.TERMPOCKET_DRYRUN_INPUT, '1');
    assert.equal(env.TERMPOCKET_PORT, '2', 'an explicit new name is kept');
  });

  test('migrates the pre-rename folder %APPDATA%\\VSControl once (token, relay.json; not ptyhost.json)', () => {
    const appData = path.join(tmp, 'appdata');
    const old = path.join(appData, 'VSControl');
    const neu = path.join(appData, 'TermPocket');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'config.json'), '{"token":"old-token-0123456789abcdefghij","port":8765}');
    fs.writeFileSync(path.join(old, 'relay.json'), '{"url":"wss://pc.example.com","key":"k"}');
    fs.writeFileSync(path.join(old, 'ptyhost.json'), '{"pid":1,"pipe":"old"}');
    fs.writeFileSync(path.join(old, 'agent.log'), 'log');
    // The install script may already have created the new folder (with its launcher) before the agent runs.
    fs.mkdirSync(neu, { recursive: true });
    fs.writeFileSync(path.join(neu, 'termpocket-agent.vbs'), "' launcher");
    assert.equal(getLegacyConfigDir({ APPDATA: appData }), old);

    const c = loadConfig({ env: { APPDATA: appData } });
    assert.equal(c.configDir, neu);
    assert.equal(c.token, 'old-token-0123456789abcdefghij', 'paired phones keep working');
    assert.equal(c.migratedFrom, old);
    assert.deepEqual(fs.readdirSync(neu).sort(), ['config.json', 'relay.json', 'termpocket-agent.vbs']);
    assert.ok(fs.existsSync(path.join(old, 'config.json')), 'the old folder is left in place');

    // Only once: later changes to the old folder are ignored.
    fs.writeFileSync(path.join(old, 'config.json'), '{"token":"changed-later-0123456789abcdef"}');
    const c2 = loadConfig({ env: { APPDATA: appData } });
    assert.equal(c2.token, 'old-token-0123456789abcdefghij');
    assert.equal(c2.migratedFrom, null);
    assert.equal(migrateLegacyConfigDir({ APPDATA: appData }), null);
    // Never with an explicit home.
    assert.equal(migrateLegacyConfigDir({ APPDATA: appData, TERMPOCKET_HOME: path.join(tmp, 'other') }), null);
  });

  test('without an old folder a fresh config is created (no migration)', () => {
    const appData = path.join(tmp, 'appdata-fresh');
    const c = loadConfig({ env: { APPDATA: appData } });
    assert.equal(c.configDir, path.join(appData, 'TermPocket'));
    assert.equal(c.migratedFrom, null);
    assert.match(c.token, /^[A-Za-z0-9_-]{43}$/);
  });

  test('tokenMatches / remoteIpOf / parseFrame', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abd'), false);
    assert.equal(tokenMatches('abc', 'abcd'), false);
    assert.equal(tokenMatches('abc', undefined), false);
    // Last hop = the one the trusted local proxy appended; earlier hops are client claims.
    assert.equal(remoteIpOf({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, 100.64.1.2' } }), '100.64.1.2');
    assert.equal(remoteIpOf({ socket: { remoteAddress: '100.70.0.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } }), '100.70.0.5');
    assert.equal(parseFrame('nope'), null);
    assert.equal(parseFrame('[1,2]'), null);
    assert.equal(parseFrame('{"t":"req","id":1}'), null);
    assert.deepEqual(parseFrame('{"t":"evt","ev":"x","p":1}'), { t: 'evt', ev: 'x', p: 1 });
  });
});

// ------------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------------

describe('http', () => {
  test('/healthz', async () => {
    const r = await httpGet(port, '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, version: VERSION });
  });

  test('static files with content types and cache rules', async () => {
    const index = await httpGet(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.ok(index.body.includes('fixture'));

    const app = await httpGet(port, '/app.js');
    assert.match(app.headers['content-type'], /^text\/javascript/);

    const manifest = await httpGet(port, '/manifest.webmanifest');
    assert.match(manifest.headers['content-type'], /^application\/manifest\+json/);
    assert.equal(manifest.headers['cache-control'], 'no-cache');

    const sw = await httpGet(port, '/sw.js');
    assert.equal(sw.headers['cache-control'], 'no-cache');

    const vendor = await httpGet(port, '/vendor/xterm.js');
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers['cache-control'], /max-age=/);

    const again = await httpGet(port, '/app.js', { headers: { 'if-none-match': app.headers.etag } });
    assert.equal(again.status, 304);

    const head = await httpGet(port, '/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    const post = await httpGet(port, '/app.js', { method: 'POST' });
    assert.equal(post.status, 405);
  });

  test('no directory listing, no traversal, no dotfiles', async () => {
    for (const p of [
      '/js/',
      '/js',
      '/missing.js',
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/vendor/..%5c..%5csecret.txt',
      '/%2e%2e%5c%2e%2e%5csecret.txt',
      '/.secret',
      '/C:%5cWindows%5cwin.ini',
      '/%00index.html',
    ]) {
      const r = await httpGet(port, p);
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
      assert.ok(!r.body.includes('TOP-SECRET') && !r.body.includes('dotfile'), `${p} leaked`);
    }
  });

  test('/pair only for direct loopback requests', async () => {
    const ok = await httpGet(port, '/pair');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes(`#token=${encodeURIComponent(config.token)}`));
    assert.ok(ok.body.includes('<svg'), 'QR code rendered');
    assert.equal((await httpGet(port, '/pair', { headers: { 'X-Forwarded-For': '100.100.1.1' } })).status, 404);
    assert.equal((await httpGet(port, '/pair', { headers: { 'Tailscale-User-Login': 'someone@example.com' } })).status, 404);
  });

  test('unknown websocket path is rejected', async () => {
    await assert.rejects(Peer.open(`ws://127.0.0.1:${port}/nope`));
  });
});

// ------------------------------------------------------------------------------------------------
// Auth & RPC
// ------------------------------------------------------------------------------------------------

describe('auth', () => {
  test('success returns hello info with features', async () => {
    const { phone, info } = await authedPhone();
    assert.equal(info.version, VERSION);
    assert.equal(info.platform, process.platform);
    assert.equal(info.hostname, os.hostname());
    assert.equal(typeof info.user, 'string');
    assert.deepEqual(info.features, ['pty', 'vscode', 'sys', 'screen', 'input']);
    await phone.close();
  });

  test('bad token → error then close 4401', async () => {
    const phone = await Peer.open(wsUrl);
    await assert.rejects(phone.request('auth', { token: 'wrong' }), /bad token/);
    assert.equal((await phone.closed).code, 4401);
  });

  test('no auth within the timeout → close 4401', async () => {
    const phone = await Peer.open(wsUrl);
    const t0 = Date.now();
    assert.equal((await phone.closed).code, 4401);
    assert.ok(Date.now() - t0 >= 300);
  });

  test('first message must be auth', async () => {
    const phone = await Peer.open(wsUrl);
    await assert.rejects(phone.request('pty.list', {}), /first message must be auth/);
    assert.equal((await phone.closed).code, 4401);
  });

  test('rate limit: 10 failures per IP → 4429 (X-Forwarded-For from loopback proxy)', async () => {
    const headers = { 'X-Forwarded-For': '203.0.113.9' };
    for (let i = 0; i < 10; i++) {
      const p = await Peer.open(wsUrl, headers);
      await assert.rejects(p.request('auth', { token: `wrong-${i}` }), /bad token/);
      assert.equal((await p.closed).code, 4401);
    }
    const blocked = await Peer.open(wsUrl, headers);
    assert.equal((await blocked.closed).code, 4429);
    // Another IP (and the direct loopback client) is unaffected.
    const other = await Peer.open(wsUrl, { 'X-Forwarded-For': '203.0.113.10' });
    assert.ok(await other.request('auth', { token: config.token }));
    await other.close();
  });

  test('rpc: unknown method, handler errors, malformed frames, binary frames', async () => {
    const { phone } = await authedPhone();
    phone.send('this is not json');
    phone.send('{"t":"req"}');
    phone.ws.send(Buffer.from([1, 2, 3]));
    await assert.rejects(phone.request('nope.method', {}), /^Error: unknown method: nope.method$/);
    await assert.rejects(phone.request('sys.fail', {}), /fake failure/);
    assert.deepEqual(await phone.request('sys.info'), { hostname: 'fake', fake: true });
    const r = await phone.request('screen.snapshot', {});
    assert.deepEqual(r, { sent: true, bufferedAmountType: 'number', open: true });
    await delay(50);
    assert.equal(phone.binary.length, 1);
    assert.equal(phone.binary[0][0], 0x01);
    assert.equal(phone.binary[0].readUInt32BE(1), 7);
    await phone.close();
  });

  test('onClientClose fan-out when a phone disconnects', async () => {
    const before = closedClients.length;
    const { phone } = await authedPhone();
    await phone.close();
    for (let i = 0; i < 50 && closedClients.length === before; i++) await delay(20);
    assert.equal(closedClients.length, before + 1);
  });

  test('makeConn: symmetric requests, events, timeout and close rejection', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const serverSide = new Promise((r) => wss.once('connection', (ws) => r(makeConn(ws))));
    const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
    await new Promise((r) => ws.once('open', r));
    const a = makeConn(ws);
    const b = await serverSide;

    b.onRequest(async (m, p) => {
      if (m === 'add') return p.x + p.y;
      if (m === 'never') return new Promise(() => {});
      throw new Error(`unknown method: ${m}`);
    });
    a.onRequest(async (m) => (m === 'ping' ? 'pong' : undefined));
    const gotEvent = new Promise((r) => b.onEvent((ev, p) => r({ ev, p })));

    assert.equal(await a.request('add', { x: 2, y: 3 }), 5);
    assert.equal(await b.request('ping'), 'pong');
    await assert.rejects(a.request('zzz'), /unknown method: zzz/);
    await assert.rejects(a.request('never', {}, 100), (err) => err.code === 'ETIMEDOUT');
    a.notify('hello', { n: 1 });
    assert.deepEqual(await gotEvent, { ev: 'hello', p: { n: 1 } });

    const pendingCall = a.request('never', {}, 5000);
    const closed = new Promise((r) => a.onClose(r));
    b.close(1000);
    await assert.rejects(pendingCall, (err) => err.code === 'ECONNCLOSED');
    await closed;
    await assert.rejects(a.request('add', { x: 1, y: 1 }), (err) => err.code === 'ECONNCLOSED');
    await new Promise((r) => wss.close(r));
  });
});

// ------------------------------------------------------------------------------------------------
// PTY sessions
// ------------------------------------------------------------------------------------------------

describe('pty', () => {
  test('create → attach → input → output → resize → rename → kill', async () => {
    const { phone } = await authedPhone();
    const { phone: watcher } = await authedPhone(); // not attached: must not get pty.data

    const s = await phone.request('pty.create', { cols: 80, rows: 24, cwd: tmp, title: 'Test shell' });
    assert.match(s.id, /^p\d+$/);
    assert.equal(s.title, 'Test shell');
    assert.equal(s.shell, TEST_SHELL);
    assert.equal(s.cwd, path.resolve(tmp));
    assert.equal(s.cols, 80);
    assert.equal(s.rows, 24);
    assert.equal(s.exited, false);
    assert.equal(s.exitCode, null);
    assert.equal(s.mirror, null);
    assert.ok(Number.isInteger(s.pid) && s.pid > 0, `pid ${s.pid}`); // ConPTY reports it asynchronously
    await phone.waitFor('pty.changed', (p) => p.sessions.some((x) => x.id === s.id));

    const list = await phone.request('pty.list');
    assert.ok(list.some((x) => x.id === s.id));

    const att = await phone.request('pty.attach', { id: s.id });
    assert.equal(att.session.id, s.id);
    assert.equal(typeof att.buffer, 'string');

    // `echo h^i` prints "hi" while the echoed command line shows "h^i".
    await phone.request('pty.input', { id: s.id, d: 'echo h^i\r' });
    await phone.waitForOutput('pty.data', 'id', s.id, /hi/);

    // Re-attach: scrollback contains the output.
    const att2 = await phone.request('pty.attach', { id: s.id });
    assert.match(att2.buffer, /hi/);

    await phone.request('pty.resize', { id: s.id, cols: 100, rows: 40 });
    await phone.waitFor('pty.changed', (p) => p.sessions.some((x) => x.id === s.id && x.cols === 100 && x.rows === 40));

    await phone.request('pty.rename', { id: s.id, title: 'Renamed' });
    await watcher.waitFor('pty.changed', (p) => p.sessions.some((x) => x.id === s.id && x.title === 'Renamed'));

    await phone.request('pty.detach', { id: s.id });
    await phone.request('pty.kill', { id: s.id });
    const exitEvt = await watcher.waitFor('pty.exit', (p) => p.id === s.id);
    assert.ok('exitCode' in exitEvt.p);
    await watcher.waitFor('pty.changed', (p) => !p.sessions.some((x) => x.id === s.id));
    assert.ok(!watcher.events.some((e) => e.ev === 'pty.data'), 'unattached client got pty.data');

    await assert.rejects(phone.request('pty.input', { id: s.id, d: 'x' }), /no such session/);
    await phone.close();
    await watcher.close();
  });

  test('exited sessions stay listed until killed; bad params are rejected', async () => {
    const { phone } = await authedPhone();
    await assert.rejects(phone.request('pty.create', { cwd: path.join(tmp, 'does-not-exist') }), /cwd does not exist/);
    await assert.rejects(phone.request('pty.create', { vscodeWindowId: 'no-such-window' }), /vscode window not connected/);
    await assert.rejects(phone.request('pty.attach', { id: 'p999' }), /no such session/);

    const s = await phone.request('pty.create', { cwd: tmp });
    await phone.request('pty.attach', { id: s.id });
    await phone.request('pty.input', { id: s.id, d: 'exit 3\r' });
    const ex = await phone.waitFor('pty.exit', (p) => p.id === s.id);
    assert.equal(ex.p.exitCode, 3);
    const after = await phone.request('pty.list');
    const entry = after.find((x) => x.id === s.id);
    assert.equal(entry.exited, true);
    assert.equal(entry.exitCode, 3);
    await assert.rejects(phone.request('pty.input', { id: s.id, d: 'x' }), /exited/);
    await phone.request('pty.kill', { id: s.id });
    assert.ok(!(await phone.request('pty.list')).some((x) => x.id === s.id));
    await phone.close();
  });

  test('scrollback is trimmed from the front to scrollbackBytes', async () => {
    const registry = createPhoneRegistry();
    let onData;
    const fakeSpawn = () => ({
      pid: 42,
      onData: (cb) => (onData = cb),
      onExit: () => {},
      write() {},
      resize() {},
      kill() {},
    });
    const mgr = createPtyManager({ config: { ...config, scrollbackBytes: 1024 }, log: quietLog, registry, spawn: fakeSpawn });
    const s = await mgr.methods['pty.create']({ cwd: tmp });
    for (let i = 0; i < 100; i++) onData(`line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}\r\n`);
    onData('é'.repeat(300)); // multi-byte tail
    const { buffer } = await mgr.methods['pty.attach']({ id: s.id }, null);
    assert.ok(Buffer.byteLength(buffer, 'utf8') <= 1024);
    assert.ok(buffer.endsWith('é'.repeat(300)));
    assert.ok(!buffer.includes('line 000'));
    await mgr.dispose();
  });
});

// ------------------------------------------------------------------------------------------------
// VS Code hub with a fake extension
// ------------------------------------------------------------------------------------------------

/** §5.1 handshake as the real extension does it: hello.challenge, verify the agent, hello with a proof. */
async function vscodeHandshake(ext, token = config.token) {
  const cn = crypto.randomBytes(32).toString('base64url');
  const ch = await ext.request('hello.challenge', { nonce: cn });
  return { cn, sn: ch.nonce, agentOk: ch.proof === agentProof(token, cn, ch.nonce), proof: extensionProof(token, cn, ch.nonce) };
}

async function fakeExtension(windowId, extra = {}) {
  const ext = await Peer.open(vscodeUrl);
  const hs = await vscodeHandshake(ext);
  assert.ok(hs.agentOk, 'agent proved it knows the token');
  const r = await ext.request('hello', {
    proof: hs.proof,
    windowId,
    name: 'my-project',
    folders: ['E:\\my-project'],
    vscodeVersion: '1.145.0',
    pid: 1234,
    ...extra,
  });
  return { ext, hello: r };
}

describe('vscode hub', () => {
  test('hello with a bad token is refused', async () => {
    const ext = await Peer.open(vscodeUrl);
    await assert.rejects(ext.request('hello', { token: 'nope', windowId: 'x' }), /bad token/);
    assert.equal((await ext.closed).code, 4401);
  });

  test('windows registry, vsc.call relay, timeout, errors and event forwarding', async () => {
    const { phone } = await authedPhone();
    const { ext, hello } = await fakeExtension('w-relay');
    assert.deepEqual(hello, { version: VERSION });

    const evt = await phone.waitFor('vsc.windows', (p) => p.windows.some((w) => w.windowId === 'w-relay'));
    const win = evt.p.windows.find((w) => w.windowId === 'w-relay');
    assert.equal(win.name, 'my-project');
    assert.deepEqual(win.folders, ['E:\\my-project']);
    assert.equal(win.vscodeVersion, '1.145.0');
    assert.equal(typeof win.focused, 'boolean');
    assert.equal(typeof win.connectedAt, 'number');

    const wins = await phone.request('vsc.windows');
    assert.ok(wins.some((w) => w.windowId === 'w-relay'));

    ext.notify('window.update', { name: 'renamed', folders: ['E:\\a', 'E:\\b'], focused: true });
    await phone.waitFor('vsc.windows', (p) => p.windows.some((w) => w.windowId === 'w-relay' && w.name === 'renamed' && w.focused && w.folders.length === 2));

    ext.requestHandler = async (m, p) => {
      if (m === 'workspace.info') return { name: 'renamed', folders: [{ name: 'a', path: 'E:\\a' }], activeFile: null, echo: p };
      if (m === 'fs.read') throw new Error('ENOENT: no such file');
      if (m === 'slow') return new Promise(() => {}); // never answers
      throw new Error(`unknown method: ${m}`);
    };
    const info = await phone.request('vsc.call', { windowId: 'w-relay', m: 'workspace.info', p: { x: 1 } });
    assert.deepEqual(info, { name: 'renamed', folders: [{ name: 'a', path: 'E:\\a' }], activeFile: null, echo: { x: 1 } });
    await assert.rejects(phone.request('vsc.call', { windowId: 'w-relay', m: 'fs.read', p: { path: 'x' } }), /ENOENT: no such file/);
    await assert.rejects(phone.request('vsc.call', { windowId: 'w-relay', m: 'slow' }), /vscode timeout/);
    await assert.rejects(phone.request('vsc.call', { windowId: 'nope', m: 'workspace.info' }), /vscode window not connected/);

    ext.notify('terminals.changed', { terminals: [{ tid: 't1', name: 'pwsh' }] });
    const fwd = await phone.waitFor('vsc.event', (p) => p.ev === 'terminals.changed');
    assert.deepEqual(fwd.p, { windowId: 'w-relay', ev: 'terminals.changed', p: { terminals: [{ tid: 't1', name: 'pwsh' }] } });

    // Unknown requests from the extension get the standard error.
    await assert.rejects(ext.request('bogus', {}), /unknown method: bogus/);

    await ext.close();
    await phone.waitFor('vsc.windows', (p) => !p.windows.some((w) => w.windowId === 'w-relay'));
    await phone.close();
  });

  test('mirrored terminal created from the phone', async () => {
    const { phone } = await authedPhone();
    const { ext } = await fakeExtension('w-mirror');
    ext.requestHandler = async (m) => (m === 'mirror.open' ? { tid: 'vt1' } : null);

    const s = await phone.request('pty.create', { cwd: tmp, vscodeWindowId: 'w-mirror', cols: 90, rows: 25 });
    assert.deepEqual(s.mirror, { windowId: 'w-mirror' });
    const open = await ext.waitFor('mirror.open');
    assert.equal(open.p.session.id, s.id);
    assert.deepEqual(open.p.session.mirror, { windowId: 'w-mirror' });
    assert.equal(typeof open.p.buffer, 'string');

    await phone.request('pty.attach', { id: s.id });
    // Input typed in VS Code reaches the PTY; output goes to both VS Code and the attached phone.
    ext.notify('mirror.input', { ptyId: s.id, d: 'echo mir^ror\r' });
    await ext.waitForOutput('mirror.data', 'ptyId', s.id, /mirror/);
    await phone.waitForOutput('pty.data', 'id', s.id, /mirror/);

    ext.notify('mirror.resize', { ptyId: s.id, cols: 70, rows: 20 });
    await phone.waitFor('pty.changed', (p) => p.sessions.some((x) => x.id === s.id && x.cols === 70 && x.rows === 20));

    // Mirror events for sessions this window does not own are ignored.
    ext.notify('mirror.closed', { ptyId: 'p99999' });

    ext.notify('mirror.closed', { ptyId: s.id });
    await phone.waitFor('pty.exit', (p) => p.id === s.id);
    await phone.waitFor('pty.changed', (p) => !p.sessions.some((x) => x.id === s.id));
    assert.ok(!(await phone.request('pty.list')).some((x) => x.id === s.id));
    assert.ok(!ext.events.some((e) => e.ev === 'mirror.exit' && e.p.ptyId === s.id), 'no mirror.exit after mirror.closed');

    await ext.close();
    await phone.close();
  });

  test('mirrored terminal requested by the extension; window disconnect keeps the PTY', async () => {
    const { phone } = await authedPhone();
    const { ext } = await fakeExtension('w-ext');
    ext.requestHandler = async (m) => (m === 'mirror.open' ? { tid: 'vt2' } : null);

    const s = await ext.request('pty.create', { cwd: tmp, title: 'From VS Code', cols: 100, rows: 30 });
    assert.equal(s.title, 'From VS Code');
    assert.deepEqual(s.mirror, { windowId: 'w-ext' });
    const open = await ext.waitFor('mirror.open');
    assert.equal(open.p.session.id, s.id);

    // Exit from the shell → mirror.exit to the window, pty.exit to phones.
    const s2 = await ext.request('pty.create', { cwd: tmp });
    await ext.waitFor('mirror.open', (p) => p.session.id === s2.id);
    ext.notify('mirror.input', { ptyId: s2.id, d: 'exit 5\r' });
    const mex = await ext.waitFor('mirror.exit', (p) => p.ptyId === s2.id);
    assert.equal(mex.p.exitCode, 5);
    await phone.waitFor('pty.exit', (p) => p.id === s2.id && p.exitCode === 5);
    await phone.request('pty.kill', { id: s2.id });

    await ext.close();
    await phone.waitFor('pty.changed', (p) => p.sessions.some((x) => x.id === s.id && x.mirror === null && !x.exited));
    // Still usable from the phone.
    await phone.request('pty.attach', { id: s.id });
    await phone.request('pty.input', { id: s.id, d: 'echo st^ill\r' });
    await phone.waitForOutput('pty.data', 'id', s.id, /still/);
    await phone.request('pty.kill', { id: s.id });
    await phone.close();
  });
});

// ------------------------------------------------------------------------------------------------
// Security: Host / Origin policy, rate-limit keys, /vscode challenge-response (PROTOCOL §1.1, §5.1)
// ------------------------------------------------------------------------------------------------

/** Status code of a WebSocket upgrade attempt (101 when accepted; the socket is then closed). */
function upgradeStatus(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode);
      res.resume();
      ws.terminate();
    });
    ws.once('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.once('error', () => resolve(0));
  });
}

/** A private server (own rate limiter) so lockout tests cannot affect the shared fixture. */
async function privateServer(opts = {}) {
  const registry = createPhoneRegistry();
  const mgr = createPtyManager({ config, log: quietLog, registry });
  const h = createVscodeHub({ log: quietLog, registry, pty: mgr, version: VERSION, callTimeoutMs: 400 });
  const srv = createAgentServer({ config, log: quietLog, registry, handlerSets: [mgr, h], webRoot: path.join(tmp, 'web'), authTimeoutMs: 2000, ...opts });
  const { port: p } = await srv.listen(0, '127.0.0.1');
  return {
    port: p,
    ws: `ws://127.0.0.1:${p}/ws`,
    vscode: `ws://127.0.0.1:${p}/vscode`,
    async close() {
      await srv.close();
      await h.dispose();
      await mgr.dispose();
    },
  };
}

describe('security', () => {
  test('host policy: IP literals, loopback, *.ts.net, own name and configured names only', () => {
    const cfg = { publicUrl: 'https://pc.example.org', allowedHosts: ['lan-box.home:8765', 'https://other.example.net'], configDir: tmp };
    fs.writeFileSync(path.join(tmp, 'relay.json'), JSON.stringify({ url: 'wss://relay.example.com', key: 'x' }));
    const pol = createHostPolicy({ config: cfg, hostname: 'MyPC' });
    const ok = (host) => !!pol.checkHost({ headers: { host }, socket: {} });
    for (const h of ['127.0.0.1:8765', 'localhost:8765', 'LOCALHOST', '[::1]:8765', '100.101.102.103:8765', 'pc.tail1234.ts.net', 'mypc:8765', 'mypc.local', 'pc.example.org', 'lan-box.home', 'other.example.net', 'relay.example.com', 'localhost.:8765']) {
      assert.ok(ok(h), `${h} should be allowed`);
    }
    for (const h of [undefined, '', 'rebind.evil.example:8765', 'evil.com@127.0.0.1', '127.0.0.1.evil.com', 'mypc.evil.com', 'ts.net.evil.com', 'a b', 'example.org']) {
      assert.ok(!ok(h), `${h} should be refused`);
    }
    assert.deepEqual(parseHostHeader('[::1]:80'), { hostname: '::1', port: '80', host: '[::1]:80' });
    fs.rmSync(path.join(tmp, 'relay.json'));

    const origin = (o, host, extra = {}, peer = '127.0.0.1') => pol.checkOrigin({ headers: { origin: o, host, ...extra }, socket: { remoteAddress: peer } });
    assert.equal(pol.checkOrigin({ headers: { host: 'localhost:1' }, socket: {} }), true, 'no Origin = non-browser client');
    assert.equal(origin('http://127.0.0.1:8765', '127.0.0.1:8765'), true);
    assert.equal(origin('https://pc.tail1.ts.net', 'pc.tail1.ts.net'), true);
    assert.equal(origin('https://pc.tail1.ts.net', '127.0.0.1:8765', { 'x-forwarded-host': 'pc.tail1.ts.net' }), true, 'same-origin through a local proxy');
    assert.equal(origin('https://pc.tail1.ts.net', '127.0.0.1:8765', { 'x-forwarded-host': 'pc.tail1.ts.net' }, '100.1.2.3'), false, 'X-Forwarded-Host only from loopback');
    assert.equal(origin('https://pc.example.org', '127.0.0.1:8765'), true, 'configured publicUrl');
    assert.equal(origin('https://evil.example', '127.0.0.1:8765'), false);
    assert.equal(origin('https://evil.tail9.ts.net', '127.0.0.1:8765'), false, 'other tailnets / funnel pages are cross-site');
    assert.equal(origin('http://127.0.0.1:9999', '127.0.0.1:8765'), false, 'other local port');
    assert.equal(origin('null', '127.0.0.1:8765'), false);
    assert.equal(origin('file://', '127.0.0.1:8765'), false);
  });

  test('DNS rebinding: foreign Host gets nothing (static, /pair, upgrades)', async () => {
    const evil = { Host: `rebind.evil.example:${port}` };
    for (const p of ['/', '/pair', '/healthz', '/app.js']) {
      const r = await httpGet(port, p, { headers: evil });
      assert.equal(r.status, 421, p);
      assert.ok(!r.body.includes(config.token), `${p} leaked the token`);
    }
    assert.equal(await upgradeStatus(wsUrl, evil), 421);
    assert.equal(await upgradeStatus(vscodeUrl, evil), 421);
    // /pair needs a loopback Host even though IP literals / ts.net names are fine elsewhere.
    for (const host of [`100.64.0.1:${port}`, 'pc.tail1.ts.net', os.hostname()]) {
      assert.equal((await httpGet(port, '/pair', { headers: { Host: host } })).status, 404, host);
      assert.equal((await httpGet(port, '/', { headers: { Host: host } })).status, 200, host);
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      assert.equal((await httpGet(port, '/pair', { headers: { Host: host } })).status, 200, host);
    }
  });

  test('cross-site pages cannot open sockets, so they cannot burn the rate limit', async () => {
    const srv = await privateServer({ rateLimit: { max: 3, windowMs: 60_000 } });
    try {
      for (const url of [srv.ws, srv.vscode]) {
        for (let i = 0; i < 5; i++) assert.equal(await upgradeStatus(url, { Origin: 'https://evil.example' }), 403);
      }
      // Same-origin browser page (the PWA served by the agent) is fine and still authenticates.
      const phone = await Peer.open(srv.ws, { Origin: `http://127.0.0.1:${srv.port}` });
      assert.ok(await phone.request('auth', { token: config.token }));
      await phone.close();
    } finally {
      await srv.close();
    }
  });

  test('rate-limit keys: proxied hops are namespaced; local VS Code windows have their own key', () => {
    const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
    assert.equal(rateLimitKey(req('127.0.0.1'), 'phone'), '127.0.0.1');
    assert.equal(rateLimitKey(req('127.0.0.1'), 'vscode'), 'local:vscode');
    assert.equal(rateLimitKey(req('::ffff:127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }), 'phone'), 'fwd:127.0.0.1');
    assert.equal(rateLimitKey(req('127.0.0.1', { 'x-forwarded-for': '' }), 'vscode'), 'fwd:127.0.0.1');
    assert.equal(rateLimitKey(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 100.64.1.2' }), 'phone'), 'fwd:100.64.1.2');
    assert.equal(rateLimitKey(req('100.64.1.9', { 'x-forwarded-for': '1.1.1.1' }), 'phone'), '100.64.1.9');
  });

  test('phone-side lockout does not lock out the VS Code extension (and vice versa)', async () => {
    const srv = await privateServer({ rateLimit: { max: 3, windowMs: 60_000 } });
    try {
      for (let i = 0; i < 3; i++) {
        const p = await Peer.open(srv.ws);
        await assert.rejects(p.request('auth', { token: `bad-${i}` }), /bad token/);
      }
      const blocked = await Peer.open(srv.ws);
      assert.equal((await blocked.closed).code, 4429);
      // A forged forwarded hop of 127.0.0.1 is a different key as well.
      for (let i = 0; i < 3; i++) {
        const p = await Peer.open(srv.ws, { 'X-Forwarded-For': '127.0.0.1' });
        await assert.rejects(p.request('auth', { token: `bad-${i}` }), /bad token/);
      }
      const ext = await Peer.open(srv.vscode);
      const hs = await vscodeHandshake(ext);
      assert.ok(hs.agentOk);
      assert.deepEqual(await ext.request('hello', { proof: hs.proof, windowId: 'w-lock' }), { version: VERSION });
      await ext.close();

      for (let i = 0; i < 3; i++) {
        const e = await Peer.open(srv.vscode);
        await vscodeHandshake(e);
        await assert.rejects(e.request('hello', { proof: 'wrong', windowId: 'x' }), /bad token/);
        assert.equal((await e.closed).code, 4401);
      }
      const e2 = await Peer.open(srv.vscode);
      assert.equal((await e2.closed).code, 4429);
      const viaProxy = await Peer.open(srv.ws, { 'X-Forwarded-For': '100.64.7.7' });
      assert.ok(await viaProxy.request('auth', { token: config.token }));
      await viaProxy.close();
    } finally {
      await srv.close();
    }
  });

  test('parallel sockets opened before the limit is reached get no extra guesses', async () => {
    const srv = await privateServer({ rateLimit: { max: 3, windowMs: 60_000 } });
    try {
      const headers = { 'X-Forwarded-For': '198.51.100.7' };
      const peers = await Promise.all(Array.from({ length: 12 }, () => Peer.open(srv.ws, headers)));
      const results = await Promise.all(
        peers.map(async (p, i) => {
          const answer = p.request('auth', { token: `guess-${i}` }).then(
            () => 'ok',
            (e) => e.message,
          );
          const closed = await p.closed;
          return { closed: closed.code, r: await Promise.race([answer, delay(50).then(() => 'no answer')]) };
        }),
      );
      assert.equal(results.filter((x) => x.r === 'bad token').length, 3, JSON.stringify(results));
      assert.equal(results.filter((x) => x.closed === 4429).length, 9);
    } finally {
      await srv.close();
    }
  });

  test('/vscode handshake: agent proves first; bad nonce / proof refused; legacy raw-token hello still accepted', async () => {
    const ext = await Peer.open(vscodeUrl);
    const hs = await vscodeHandshake(ext);
    assert.ok(hs.agentOk, 'agent proof verifies with the shared token');
    assert.notEqual(hs.proof, agentProof(config.token, hs.cn, hs.sn), 'the two directions differ');
    // After a challenge the raw token is not enough: a proof is required.
    await assert.rejects(ext.request('hello', { token: config.token, windowId: 'x' }), /bad token/);
    assert.equal((await ext.closed).code, 4401);

    const bad = await Peer.open(vscodeUrl);
    await assert.rejects(bad.request('hello.challenge', { nonce: 'short' }), /nonce required/);
    assert.equal((await bad.closed).code, 4401);

    const legacy = await Peer.open(vscodeUrl);
    assert.deepEqual(await legacy.request('hello', { token: config.token, windowId: 'w-legacy' }), { version: VERSION });
    await legacy.close();
  });
});
