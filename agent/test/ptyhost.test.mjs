// Durable PTY sessions (PROTOCOL §4.1 "Durable sessions", §5.3 mirror.rebind, §7): the PTY host
// process, its authenticated named-pipe protocol, adoption of sessions by a new agent, and the
// agent hub re-binding a VS Code window's mirrors after an agent restart.
//
// Every test uses its own temp config dir and a unique pipe name, so the user's real PTY host
// (if one runs) is never contacted.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createPtyManager } from '../src/pty.js';
import { createPtyCore } from '../src/ptycore.js';
import { startPtyHost, defaultPipeName, hostProof, clientProof } from '../src/ptyhost.js';
import { connectPtyHost, ensurePtyHost, shutdownPtyHost, readHostInfo, pidAlive, quoteWinArg } from '../src/ptyhostClient.js';
import { createVscodeHub } from '../src/vscodeHub.js';
import { createAgentServer, createPhoneRegistry, VERSION, agentProof, extensionProof } from '../src/server.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_SHELL = process.platform === 'win32' ? 'cmd.exe' : 'sh';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp;
let seq = 0;
const pipeName = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\termpocket-ptyhost-test-${process.pid}-${Date.now().toString(36)}-${++seq}`
    : path.join(os.tmpdir(), `termpocket-ptyhost-test-${process.pid}-${++seq}.sock`);
const newHome = () => fs.mkdtempSync(path.join(tmp, 'home-'));

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-ptyhost-'));
});
after(async () => {
  await delay(200);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle briefly */
  }
});

async function waitFor(fn, timeoutMs = 10_000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** A phone stand-in for the pty manager's method handlers: records what it is sent. */
function fakeClient() {
  const c = {
    id: Math.random(),
    events: [],
    isOpen: () => true,
    sendJson: (obj) => c.events.push(obj),
    sendText: (text) => c.events.push(JSON.parse(text)),
    output: (id) => c.events.filter((e) => e.ev === 'pty.data' && e.p.id === id).map((e) => e.p.d).join(''),
  };
  return c;
}

function fakeRegistry() {
  const r = { events: [], broadcast: (ev, p) => r.events.push({ ev, p }) };
  return r;
}

const baseConfig = (configDir) => {
  const c = { defaultShell: TEST_SHELL, scrollbackBytes: 262144 };
  Object.defineProperty(c, 'configDir', { value: configDir, enumerable: false });
  return c;
};

// ------------------------------------------------------------------------------------------------

describe('pty host', () => {
  test('pipe name is per user and per config dir', () => {
    const a = defaultPipeName('C:\\Users\\u\\AppData\\Roaming\\TermPocket', 'u');
    assert.equal(a, defaultPipeName('c:\\users\\U\\appdata\\roaming\\termpocket', 'U'), 'case-insensitive');
    assert.notEqual(a, defaultPipeName('C:\\Temp\\home', 'u'));
    assert.notEqual(a, defaultPipeName('C:\\Users\\u\\AppData\\Roaming\\TermPocket', 'other'));
    if (process.platform === 'win32') assert.match(a, /^\\\\\.\\pipe\\termpocket-ptyhost-[0-9a-f]{16}$/);
    assert.equal(quoteWinArg('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
    assert.equal(quoteWinArg('\\\\.\\pipe\\x'), '\\\\.\\pipe\\x');
    assert.equal(quoteWinArg('C:\\a b\\'), '"C:\\a b\\\\"');
  });

  test('agent restart: a new agent adopts the session with its id and scrollback, input still works', async () => {
    const home = newHome();
    const pipe = pipeName();
    const host = await startPtyHost({ pipe, configDir: home, log: quietLog });
    const info = readHostInfo(home);
    assert.equal(info.pipe, pipe);
    assert.equal(info.pid, process.pid);
    assert.match(info.secret, /^[A-Za-z0-9_-]{43}$/);
    try {
      // ---- agent #1 ----
      const reg1 = fakeRegistry();
      const a1 = createPtyManager({ config: baseConfig(home), log: quietLog, registry: reg1, host: { pipe, configDir: home, autoSpawn: false } });
      await a1.ready;
      assert.equal(a1.hostStatus().mode, 'host');
      assert.equal(a1.hostStatus().running, true);
      const s = await a1.methods['pty.create']({ cwd: tmp, cols: 90, rows: 20, title: 'Long job' });
      assert.equal(s.id, 'p1');
      assert.ok(s.pid > 0);
      const phone1 = fakeClient();
      await a1.methods['pty.attach']({ id: s.id }, phone1);
      await a1.methods['pty.input']({ id: s.id, d: 'echo bef^ore restart\r' });
      await waitFor(() => /before restart/.test(phone1.output(s.id)), 15_000, 'output before restart');
      await a1.methods['pty.rename']({ id: s.id, title: 'Renamed job' });
      await a1.methods['pty.resize']({ id: s.id, cols: 100, rows: 28 });
      await delay(50);

      // "Kill the agent": its connection to the host goes away (dispose closes only the pipe client).
      await a1.dispose();
      await waitFor(() => host.status().clients === 0, 5000, 'host notices the agent left');
      assert.equal(host.status().sessions, 1, 'the session survived the agent');
      // Output produced while no agent is connected is kept in the host's scrollback.
      host.core.handle('input', { sid: s.id, d: 'echo whi^le away\r' });
      await delay(800);

      // ---- agent #2 ----
      const reg2 = fakeRegistry();
      const a2 = createPtyManager({ config: baseConfig(home), log: quietLog, registry: reg2, host: { pipe, configDir: home, autoSpawn: false } });
      await a2.ready;
      const list = await a2.methods['pty.list']();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'p1', 'same id');
      assert.equal(list[0].title, 'Renamed job');
      assert.equal(list[0].cols, 100);
      assert.equal(list[0].rows, 28);
      assert.equal(list[0].pid, s.pid);
      assert.equal(list[0].exited, false);
      assert.equal(list[0].mirror, null);
      assert.equal(a2.hostStatus().adopted, 1);

      const phone2 = fakeClient();
      const att = await a2.methods['pty.attach']({ id: 'p1' }, phone2);
      assert.match(att.buffer, /before restart/, 'scrollback from before the restart');
      assert.match(att.buffer, /while away/, 'output produced while no agent was connected');
      await a2.methods['pty.input']({ id: 'p1', d: 'echo aft^er restart\r' });
      await waitFor(() => /after restart/.test(phone2.output('p1')), 15_000, 'output after restart');

      // New sessions never reuse an adopted id.
      const s2 = await a2.methods['pty.create']({ cwd: tmp });
      assert.equal(s2.id, 'p2');

      // Exit still reaches the phones of the new agent.
      await a2.methods['pty.input']({ id: 'p2', d: 'exit 4\r' });
      await waitFor(() => reg2.events.some((e) => e.ev === 'pty.exit' && e.p.id === 'p2' && e.p.exitCode === 4), 15_000, 'pty.exit');
      await a2.methods['pty.kill']({ id: 'p2' });
      await a2.methods['pty.kill']({ id: 'p1' });
      await waitFor(() => reg2.events.some((e) => e.ev === 'pty.exit' && e.p.id === 'p1'), 5000, 'pty.exit after kill');
      assert.equal(host.status().sessions, 0);
      await a2.dispose();
    } finally {
      await host.close('test done');
    }
    assert.equal(readHostInfo(home), null, 'ptyhost.json removed on shutdown');
  });

  test('pipe authentication: wrong proofs are refused both ways; nothing is sent before auth', async () => {
    const home = newHome();
    const pipe = pipeName();
    const host = await startPtyHost({ pipe, configDir: home, log: quietLog });
    try {
      // A client without the secret gets the challenge only, then is dropped.
      const got = await new Promise((resolve) => {
        const sock = net.connect(pipe);
        let text = '';
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
          text += d;
          if (text.includes('\n') && !sock.sentAuth) {
            sock.sentAuth = true;
            sock.write(`${JSON.stringify({ op: 'auth', proof: 'x'.repeat(43) })}\n`);
            sock.write(`${JSON.stringify({ id: 1, op: 'list' })}\n`);
          }
        });
        sock.on('close', () => resolve(text));
        sock.on('error', () => {});
        sock.write(`${JSON.stringify({ op: 'hello', nonce: crypto.randomBytes(32).toString('base64url') })}\n`);
      });
      const lines = got.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 1, 'only the challenge was answered');
      assert.equal(lines[0].t, 'hello');
      assert.ok(!('sessions' in lines[0]));

      // A request before hello: dropped at once.
      const early = await new Promise((resolve) => {
        const sock = net.connect(pipe);
        let text = '';
        sock.on('data', (d) => (text += d));
        sock.on('close', () => resolve(text));
        sock.on('error', () => {});
        sock.write(`${JSON.stringify({ id: 1, op: 'list' })}\n`);
      });
      assert.equal(early, '');

      // With a wrong secret in ptyhost.json the client refuses the host (EAUTH) — never sends its proof.
      const home2 = newHome();
      fs.writeFileSync(path.join(home2, 'ptyhost.json'), JSON.stringify({ pipe, secret: 'wrong-secret', pid: process.pid }));
      await assert.rejects(connectPtyHost({ pipe, configDir: home2 }), (err) => err.code === 'EAUTH');
      await assert.rejects(ensurePtyHost({ pipe, configDir: home2, autoSpawn: true, startTimeoutMs: 2000 }), (err) => err.code === 'EAUTH');

      // The real secret works.
      const t = await connectPtyHost({ pipe, configDir: home });
      assert.equal(t.kind, 'host');
      assert.deepEqual(t.hello.sessions, []);
      assert.equal((await t.request('status')).clients, 1);
      t.close();
    } finally {
      await host.close();
    }
  });

  test('an impostor on the pipe cannot get the client to authenticate', async () => {
    const home = newHome();
    const pipe = pipeName();
    fs.writeFileSync(path.join(home, 'ptyhost.json'), JSON.stringify({ pipe, secret: 'the-real-secret', pid: process.pid }));
    const received = [];
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        received.push(d);
        const msg = JSON.parse(d.split('\n')[0]);
        if (msg.op === 'hello') sock.write(`${JSON.stringify({ t: 'hello', nonce: crypto.randomBytes(32).toString('base64url'), proof: 'forged' })}\n`);
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => srv.listen(pipe, r));
    try {
      await assert.rejects(connectPtyHost({ pipe, configDir: home }), (err) => err.code === 'EAUTH');
      await delay(50);
      assert.equal(received.join('').split('\n').filter(Boolean).length, 1, 'only the hello was sent');
      assert.ok(!received.join('').includes('auth'));
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // Proof helpers are direction-specific.
    assert.notEqual(hostProof('s', 'a', 'b'), clientProof('s', 'a', 'b'));
  });

  test('idle exit only without sessions AND without an agent', async () => {
    const home = newHome();
    const pipe = pipeName();
    let exited = null;
    let onData;
    const fakeSpawn = () => ({ pid: 77, onData: (cb) => (onData = cb), onExit: () => {}, write() {}, resize() {}, kill() {} });
    const host = await startPtyHost({ pipe, configDir: home, log: quietLog, idleMs: 300, spawn: fakeSpawn, onExit: (r) => (exited = r) });
    const t = await connectPtyHost({ pipe, configDir: home });
    await t.request('spawn', { shell: 'x', cwd: tmp });
    t.close();
    await delay(800);
    assert.equal(exited, null, 'a session keeps the host alive');
    onData('hello');
    const t2 = await connectPtyHost({ pipe, configDir: home });
    assert.equal(t2.hello.sessions.length, 1);
    const b = await t2.request('buffer', { sid: 'p1' });
    assert.equal(b.buffer, 'hello');
    await t2.request('kill', { sid: 'p1' });
    await delay(800);
    assert.equal(exited, null, 'a connected agent keeps the host alive');
    t2.close();
    await waitFor(() => exited, 3000, 'idle exit');
    assert.equal(exited, 'idle');
    assert.equal(readHostInfo(home), null);
    await host.close();
  });

  test('a host never takes over the ptyhost.json of another live host (different pipe)', async () => {
    const home = newHome();
    const pipe1 = pipeName();
    const fakeSpawn = () => ({ pid: 5, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    const host1 = await startPtyHost({ pipe: pipe1, configDir: home, log: quietLog, spawn: fakeSpawn });
    try {
      // Pretend host1 is another process (the guard ignores its own pid, as tests run hosts in-process).
      const info = readHostInfo(home);
      const file = path.join(home, 'ptyhost.json');
      fs.writeFileSync(file, JSON.stringify({ ...info, pid: process.ppid }));
      await assert.rejects(startPtyHost({ pipe: pipeName(), configDir: home, log: quietLog, spawn: fakeSpawn }), (err) => err.code === 'EOWNED');
      assert.equal(readHostInfo(home).secret, info.secret, 'the live host keeps its info file');
      // A stale file (its pid is gone) may be replaced.
      fs.writeFileSync(file, JSON.stringify({ ...info, pid: 2147483646 }));
      const host2 = await startPtyHost({ pipe: pipeName(), configDir: home, log: quietLog, spawn: fakeSpawn });
      assert.notEqual(readHostInfo(home).secret, info.secret);
      await host2.close();
    } finally {
      await host1.close();
    }
  });

  test('an unauthenticated connection cannot make the host buffer much', async () => {
    const home = newHome();
    const pipe = pipeName();
    const host = await startPtyHost({ pipe, configDir: home, log: quietLog, spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) });
    try {
      const sock = net.connect(pipe);
      await new Promise((r) => sock.once('connect', r));
      const closed = new Promise((r) => sock.once('close', r));
      sock.on('error', () => {});
      sock.write('x'.repeat(64 * 1024));
      await Promise.race([closed, delay(3000).then(() => assert.fail('connection not closed'))]);
    } finally {
      await host.close();
    }
  });

  test('old exited sessions are pruned (event "removed"); exited sessions do not keep the host alive', async () => {
    const procs = [];
    const fakeSpawn = () => {
      const p = { pid: 9, cbs: {}, onData: (cb) => (p.cbs.data = cb), onExit: (cb) => (p.cbs.exit = cb), write() {}, resize() {}, kill() {} };
      procs.push(p);
      return p;
    };
    const core = createPtyCore({ spawn: fakeSpawn, log: quietLog, maxExited: 2 });
    const events = [];
    core.subscribe((e) => events.push(e));
    for (let i = 0; i < 4; i++) core.handle('spawn', { shell: 'x', cwd: tmp });
    procs[0].cbs.exit({ exitCode: 0 });
    procs[1].cbs.exit({ exitCode: 0 });
    assert.equal(core.size, 4);
    procs[2].cbs.exit({ exitCode: 0 });
    assert.deepEqual(events.filter((e) => e.ev === 'removed'), [{ ev: 'removed', sid: 'p1' }]);
    assert.deepEqual(core.handle('list').sessions.map((s) => s.id), ['p2', 'p3', 'p4']);
    assert.equal(core.liveCount, 1);
    core.dispose();

    // Agent side: a pruned session disappears from pty.list.
    const home = newHome();
    const pipe = pipeName();
    const hprocs = [];
    const hostSpawn = () => {
      const p = { pid: 10, cbs: {}, onData: (cb) => (p.cbs.data = cb), onExit: (cb) => (p.cbs.exit = cb), write() {}, resize() {}, kill() {} };
      hprocs.push(p);
      return p;
    };
    let exited = null;
    const host = await startPtyHost({ pipe, configDir: home, log: quietLog, spawn: hostSpawn, idleMs: 300, onExit: (r) => (exited = r) });
    try {
      const reg = fakeRegistry();
      const a = createPtyManager({ config: baseConfig(home), log: quietLog, registry: reg, host: { pipe, configDir: home, autoSpawn: false } });
      await a.ready;
      for (let i = 0; i < 34; i++) await a.create({ cwd: tmp });
      for (let i = 0; i < 33; i++) hprocs[i].cbs.exit({ exitCode: 0 });
      await waitFor(async () => (await a.methods['pty.list']()).length === 33, 5000, 'pruned session dropped by the agent');
      assert.ok(!a.get('p1'), 'oldest exited session gone');
      hprocs[33].cbs.exit({ exitCode: 0 });
      await a.dispose();
      // Only exited sessions left and no agent: the host exits after idleMs.
      await waitFor(() => exited, 5000, 'idle exit with only exited sessions');
    } finally {
      await host.close();
    }
  });

  test('host core: data/exit/pid/meta events; numbering starts at firstId', () => {
    const procs = [];
    const fakeSpawn = () => {
      const p = { pid: 0, cbs: {}, onData: (cb) => (p.cbs.data = cb), onExit: (cb) => (p.cbs.exit = cb), write() {}, resize() {}, kill() {} };
      procs.push(p);
      return p;
    };
    const core = createPtyCore({ spawn: fakeSpawn, firstId: 7, log: quietLog });
    const events = [];
    core.subscribe((e) => events.push(e));
    const m = core.handle('spawn', { shell: 'x', cwd: tmp, mirrorWindowId: 'w1' });
    assert.equal(m.id, 'p7');
    assert.equal(m.mirrorWindowId, 'w1');
    procs[0].pid = 1234;
    procs[0].cbs.data('abc');
    assert.deepEqual(events.slice(0, 2), [{ ev: 'pid', sid: 'p7', pid: 1234 }, { ev: 'data', sid: 'p7', d: 'abc' }]);
    core.handle('meta', { sid: 'p7', title: 'T', mirrorWindowId: null });
    assert.equal(events.at(-1).session.title, 'T');
    assert.equal(events.at(-1).session.mirrorWindowId, null);
    procs[0].cbs.exit({ exitCode: 2 });
    assert.deepEqual(events.at(-1), { ev: 'exit', sid: 'p7', exitCode: 2 });
    assert.throws(() => core.handle('input', { sid: 'p7', d: 'x' }), /exited/);
    assert.throws(() => core.handle('nope', {}), /unknown op/);
    assert.equal(core.handle('list').nextId, 8);
    core.dispose();
  });

  test('a real detached host process: spawned on demand, survives its agent, shut down on request', { timeout: 90_000 }, async () => {
    const home = newHome();
    const pipe = pipeName();
    const config = baseConfig(home);
    const method = process.env.TERMPOCKET_TEST_PTYHOST_SPAWN || (process.platform === 'win32' ? 'wmi' : 'node');
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug() {} };
    const a1 = createPtyManager({ config, log, registry: fakeRegistry(), host: { pipe, configDir: home, spawnMethod: method, startTimeoutMs: 30_000, idleMs: 60_000 } });
    await a1.ready;
    const st = a1.hostStatus();
    try {
    assert.equal(st.mode, 'host', `host mode (${st.lastError})`);
    assert.notEqual(st.pid, process.pid, 'a separate process');
    assert.ok(pidAlive(st.pid));
    // Windows: created by the WMI service, outside the agent's job object (Stop-ScheduledTask ends the job).
    if (method === 'wmi') assert.ok(lines.some((l) => /via WMI/.test(l)), lines.join('\n'));
    const s = await a1.methods['pty.create']({ cwd: tmp });
    await a1.methods['pty.input']({ id: s.id, d: 'echo sur^vivor\r' });
    await delay(1500);
    await a1.dispose();

    const a2 = createPtyManager({ config, log: quietLog, registry: fakeRegistry(), host: { pipe, configDir: home, autoSpawn: false } });
    await a2.ready;
    assert.equal(a2.hostStatus().pid, st.pid, 'same host process');
    const att = await a2.methods['pty.attach']({ id: s.id }, fakeClient());
    assert.match(att.buffer, /survivor/);
    await a2.dispose();

    assert.equal(await shutdownPtyHost({ pipe, configDir: home }), true);
    await waitFor(() => !pidAlive(st.pid), 10_000, 'host exit');
    assert.equal(await shutdownPtyHost({ pipe, configDir: home }), false, 'nothing left to shut down');
    } finally {
      // Never leave a detached host (and its shell) behind when an assertion above fails.
      await shutdownPtyHost({ pipe, configDir: home }).catch(() => {});
    }
  });

  test('host unavailable → terminals still work in-process', async () => {
    const home = newHome();
    const a = createPtyManager({ config: baseConfig(home), log: quietLog, registry: fakeRegistry(), host: { pipe: pipeName(), configDir: home, autoSpawn: false, startTimeoutMs: 300 } });
    await a.ready;
    assert.equal(a.hostStatus().mode, 'inprocess');
    assert.ok(a.hostStatus().lastError);
    const s = await a.methods['pty.create']({ cwd: tmp });
    assert.equal(s.exited, false);
    await a.methods['pty.kill']({ id: s.id });
    await a.dispose();
  });
});

// ------------------------------------------------------------------------------------------------
// Hub: a VS Code window re-binds its mirrors to a NEW agent process (§5.3 mirror.rebind)
// ------------------------------------------------------------------------------------------------

class Peer {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.requestHandler = async () => null;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'res') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.r) : p.reject(new Error(msg.e));
        }
      } else if (msg.t === 'evt') this.events.push(msg);
      else if (msg.t === 'req') {
        this.events.push(msg);
        Promise.resolve()
          .then(() => this.requestHandler(msg.m, msg.p))
          .then((r) => ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r })), (err) => ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: err.message })));
      }
    });
  }
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const p = new Peer(ws);
      ws.once('open', () => resolve(p));
      ws.once('error', reject);
    });
  }
  request(m, p) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'req', id, m, p }));
    });
  }
  notify(ev, p) {
    this.ws.send(JSON.stringify({ t: 'evt', ev, p }));
  }
  output(ev, id) {
    return this.events.filter((e) => e.ev === ev && e.p.ptyId === id).map((e) => e.p.d).join('');
  }
  close() {
    this.ws.close();
  }
}

async function startAgent(home, pipe) {
  const config = baseConfig(home);
  config.token = 'tok-0123456789abcdef0123456789abcdef';
  const registry = createPhoneRegistry();
  const pty = createPtyManager({ config, log: quietLog, registry, host: { pipe, configDir: home, autoSpawn: false } });
  const hub = createVscodeHub({ log: quietLog, registry, pty, version: VERSION, callTimeoutMs: 2000 });
  const server = createAgentServer({ config, log: quietLog, registry, handlerSets: [pty, hub], webRoot: tmp, authTimeoutMs: 2000 });
  const { port } = await server.listen(0, '127.0.0.1');
  await pty.ready;
  return {
    config,
    pty,
    hub,
    url: `ws://127.0.0.1:${port}/vscode`,
    async stop() {
      await server.close();
      await hub.dispose();
      await pty.dispose();
    },
  };
}

async function extensionHello(agent, windowId) {
  const ext = await Peer.open(agent.url);
  const cn = crypto.randomBytes(32).toString('base64url');
  const ch = await ext.request('hello.challenge', { nonce: cn });
  assert.equal(ch.proof, agentProof(agent.config.token, cn, ch.nonce));
  await ext.request('hello', { proof: extensionProof(agent.config.token, cn, ch.nonce), windowId, name: 'w', folders: [], vscodeVersion: '1', pid: 1 });
  return ext;
}

test('hub: mirror.rebind after an agent restart re-binds the window to its surviving PTYs', { timeout: 60_000 }, async () => {
  const home = newHome();
  const pipe = pipeName();
  const host = await startPtyHost({ pipe, configDir: home, log: quietLog });
  try {
    const agent1 = await startAgent(home, pipe);
    const ext1 = await extensionHello(agent1, 'win-A');
    ext1.requestHandler = async (m) => (m === 'mirror.open' ? { tid: 't1' } : null);
    const s = await ext1.request('pty.create', { cwd: tmp, title: 'Claude', cols: 100, rows: 30 });
    assert.deepEqual(s.mirror, { windowId: 'win-A' });
    await waitFor(() => ext1.events.some((e) => e.m === 'mirror.open'), 5000, 'mirror.open');
    ext1.notify('mirror.input', { ptyId: s.id, d: 'echo one^one\r' });
    await waitFor(() => /oneone/.test(ext1.output('mirror.data', s.id)), 15_000, 'mirror output');
    ext1.close();
    await agent1.stop(); // the agent goes away; the PTY host keeps the session

    const agent2 = await startAgent(home, pipe);
    // The new agent has never seen win-A: the hello registers it, then the rebind is accepted.
    const ext2 = await extensionHello(agent2, 'win-A');
    const r = await ext2.request('mirror.rebind', { ptyIds: [s.id, 'p999', 42] });
    assert.equal(r.sessions.length, 2);
    const ok = r.sessions.find((x) => x.ptyId === s.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.session.id, s.id);
    assert.deepEqual(ok.session.mirror, { windowId: 'win-A' });
    assert.match(ok.buffer, /oneone/, 'buffer = what the PTY shows');
    assert.deepEqual(r.sessions.find((x) => x.ptyId === 'p999'), { ptyId: 'p999', ok: false, gone: true, e: 'no such session' });
    assert.deepEqual(agent2.pty.get(s.id).mirror, { windowId: 'win-A' });

    // Plumbing works again: input from VS Code, output back to VS Code, resize, close → kill.
    ext2.notify('mirror.input', { ptyId: s.id, d: 'echo two^two\r' });
    await waitFor(() => /twotwo/.test(ext2.output('mirror.data', s.id)), 15_000, 'mirror output after rebind');
    assert.ok(!/oneone/.test(ext2.output('mirror.data', s.id)), 'no old output re-sent as mirror.data');
    ext2.notify('mirror.resize', { ptyId: s.id, cols: 80, rows: 24 });
    await waitFor(() => agent2.pty.get(s.id).cols === 80, 5000, 'resize');

    // Another window cannot take over a session that a connected window shows.
    const ext3 = await extensionHello(agent2, 'win-B');
    const r3 = await ext3.request('mirror.rebind', { ptyIds: [s.id] });
    assert.equal(r3.sessions[0].ok, false);
    assert.match(r3.sessions[0].e, /another VS Code window/);
    // …nor a phone's own (unmirrored) terminal: mirror.closed on it would kill the phone's shell.
    const phoneTerm = await agent2.pty.methods['pty.create']({ cwd: tmp });
    const r4 = await ext3.request('mirror.rebind', { ptyIds: [phoneTerm.id] });
    assert.equal(r4.sessions[0].ok, false);
    assert.match(r4.sessions[0].e, /not a mirrored terminal/);
    assert.equal(agent2.pty.get(phoneTerm.id).mirror, null);
    ext3.notify('mirror.closed', { ptyId: phoneTerm.id });
    await delay(200);
    assert.ok(agent2.pty.get(phoneTerm.id), 'the phone terminal survives');
    await agent2.pty.methods['pty.kill']({ id: phoneTerm.id });
    ext3.close();

    ext2.notify('mirror.closed', { ptyId: s.id });
    await waitFor(() => !agent2.pty.get(s.id), 5000, 'session removed');
    await waitFor(() => host.status().sessions === 0, 5000, 'host session removed');
    ext2.close();
    await agent2.stop();
  } finally {
    await host.close();
  }
});

test('hub: clipboard.info tells the extension whether a text-only restore is faithful (never the text)', async () => {
  const home = newHome();
  const pipe = pipeName();
  const host = await startPtyHost({ pipe, configDir: home, log: quietLog, spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) });
  try {
    const agent = await startAgent(home, pipe);
    const ext = await extensionHello(agent, 'win-C');
    await assert.rejects(ext.request('clipboard.info', {}), /clipboard not available/);
    let formats = ['UnicodeText', 'Text', 'Locale', 'OEMText'];
    agent.hub.setClipboardFormats(async () => ({ formats, text: 'SECRET-CLIP' }));
    assert.deepEqual(await ext.request('clipboard.info', {}), { formats, restorable: true });
    formats = ['Bitmap', 'DeviceIndependentBitmap'];
    assert.equal((await ext.request('clipboard.info', {})).restorable, false, 'an image');
    formats = ['FileDrop', 'Shell IDList Array'];
    assert.equal((await ext.request('clipboard.info', {})).restorable, false, 'copied files');
    formats = ['HTML Format', 'UnicodeText', 'Text'];
    const r = await ext.request('clipboard.info', {});
    assert.equal(r.restorable, false, 'rich text');
    assert.ok(!JSON.stringify(r).includes('SECRET-CLIP'), 'the text never leaves the agent');
    formats = [];
    assert.equal((await ext.request('clipboard.info', {})).restorable, true, 'empty clipboard');
    ext.close();
    await agent.stop();
  } finally {
    await host.close();
  }
});
