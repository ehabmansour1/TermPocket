'use strict';

/**
 * End-to-end tests of the extension's connection + RPC layer against a tiny fake agent
 * (a `ws` WebSocketServer on 127.0.0.1), with `vscode` replaced by an in-memory mock.
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { install } = require('./vscode-mock');
const vscode = install();
const { RECONNECTING_MSG, ENDED_MSG, RESET_ALL } = require('../src/mirror');

const TOKEN = 'test-token-0123456789abcdef';

/** Independent implementation of the §5.1 proof: HMAC-SHA256(token, label \n a \n b), base64url. */
function hmac(token, label, a, b) {
  return crypto.createHmac('sha256', token).update([label, a, b].join('\n'), 'utf8').digest('base64url');
}

// ---- helpers ------------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 3000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** One extension connection as seen by the fake agent. */
class AgentConn {
  constructor(ws, agent) {
    this.ws = ws;
    this.agent = agent;
    this.messages = [];
    this.events = [];
    this.pending = new Map();
    this.nextId = 1;
    this.authed = false;
    this.closed = false;
    this.hello = new Promise((resolve) => (this._helloResolve = resolve));
    ws.on('message', (data) => this._onMessage(String(data)));
    ws.on('close', () => (this.closed = true));
  }

  _onMessage(text) {
    const msg = JSON.parse(text);
    this.messages.push(msg);
    if (!this.authed) {
      // Handshake (PROTOCOL §5.1): hello.challenge (agent proves it knows the token), then hello with
      // the extension's proof. The raw token must never be sent.
      assert.equal(msg.t, 'req');
      assert.ok(!(msg.p && 'token' in msg.p), 'raw token must never be sent');
      if (msg.m === 'hello.challenge') {
        assert.ok(!this.challenge, 'one challenge per socket');
        assert.match(msg.p.nonce, /^[A-Za-z0-9_-]{43}$/);
        this.challenge = { cn: msg.p.nonce, sn: crypto.randomBytes(32).toString('base64url') };
        const proof = hmac(this.agent.token, 'termpocket-agent', this.challenge.cn, this.challenge.sn);
        this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r: { nonce: this.challenge.sn, proof } }));
        return;
      }
      assert.equal(msg.m, 'hello');
      assert.ok(this.challenge, 'hello only after hello.challenge');
      if (!this.agent.rejectHello && msg.p && msg.p.proof === hmac(this.agent.token, 'termpocket-ext', this.challenge.sn, this.challenge.cn)) {
        this.authed = true;
        this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r: { version: 'fake-agent' } }));
      } else {
        this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: 'bad token' }));
        this.ws.close(4401, 'bad token');
      }
      this._helloResolve(msg);
      return;
    }
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    } else if (msg.t === 'evt') {
      this.events.push(msg);
    } else if (msg.t === 'req') {
      const handler = this.agent.handlers[msg.m];
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`unknown method: ${msg.m}`);
          return handler(msg.p, this);
        })
        .then(
          (r) => this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r })),
          (err) => this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: err.message }))
        );
    }
  }

  /** Call a method on the extension; resolves with the raw response envelope. */
  call(m, p) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${m}`)), 5000);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.ws.send(JSON.stringify({ t: 'req', id, m, p }));
    });
  }

  /** Call and assert ok; resolves with `r`. */
  async ok(m, p) {
    const res = await this.call(m, p);
    assert.equal(res.ok, true, `${m} failed: ${res.e}`);
    return res.r;
  }

  emit(ev, p) {
    this.ws.send(JSON.stringify({ t: 'evt', ev, p }));
  }

  waitEvent(ev, pred = () => true, timeoutMs = 3000) {
    return waitFor(() => this.events.find((e) => e.ev === ev && pred(e.p)), timeoutMs, `event ${ev}`);
  }
}

class FakeAgent {
  constructor(token = TOKEN) {
    this.token = token;
    this.conns = [];
    this.handlers = {};
  }

  async listen(port = 0) {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/vscode' });
    await once(this.wss, 'listening');
    this.port = this.wss.address().port;
    this.wss.on('connection', (ws) => this.conns.push(new AgentConn(ws, this)));
    return this;
  }

  /** Wait for the n-th (0-based) connection to finish its hello. */
  async conn(n = 0, timeoutMs = 5000) {
    const c = await waitFor(() => this.conns[n], timeoutMs, `connection #${n}`);
    await c.hello;
    return c;
  }

  async close() {
    for (const c of this.conns) c.ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }
}

function makeContext() {
  return {
    subscriptions: [],
    extension: { packageJSON: require('../package.json') },
  };
}

// ---- fixture ------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-ext-test-'));
const home = path.join(tmp, 'home');
const wsDir = path.join(tmp, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
fs.mkdirSync(path.join(wsDir, 'Zdir'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'b.txt'), 'bee\n');
fs.writeFileSync(path.join(wsDir, 'a.txt'), 'alpha\nline 2\n');
fs.writeFileSync(path.join(wsDir, 'blob.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
vscode._setFolders([wsDir]);
process.env.TERMPOCKET_HOME = home;
delete process.env.TERMPOCKET_PORT;
delete process.env.TERMPOCKET_HOST;

function writeConfig(port, token = TOKEN) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, host: '127.0.0.1', token }, null, 2));
}

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- the extension end to end -------------------------------------------------------------------

test('extension: hello, RPC, terminals, mirrors, reconnect', async (t) => {
  let agent = await new FakeAgent().listen();
  writeConfig(agent.port);

  const ext = require('../src/extension');
  const api = ext.activate(makeContext());
  let conn;

  try {
    await t.test('hello handshake', async () => {
      conn = await agent.conn(0);
      const challenge = conn.messages[0];
      assert.equal(challenge.t, 'req');
      assert.equal(challenge.id, 1);
      assert.equal(challenge.m, 'hello.challenge');
      const hello = conn.messages[1];
      assert.equal(hello.t, 'req');
      assert.equal(hello.id, 2);
      assert.equal(hello.m, 'hello');
      assert.equal(hello.p.token, undefined, 'raw token is never sent');
      assert.equal(typeof hello.p.proof, 'string');
      assert.equal(hello.p.windowId, api.windowId);
      assert.match(hello.p.windowId, /^[0-9a-f-]{36}$/);
      assert.equal(hello.p.name, 'project');
      assert.deepEqual(hello.p.folders, [path.resolve(wsDir)]);
      assert.equal(hello.p.vscodeVersion, vscode.version);
      assert.equal(hello.p.pid, process.pid);
      await waitFor(() => api.connection.connected, 2000, 'connected state');
      const status = vscode._state.statusItems[0];
      assert.equal(status.text, '$(remote) TermPocket');
      const upd = await conn.waitEvent('window.update');
      assert.deepEqual(upd.p, { name: 'project', folders: [path.resolve(wsDir)], focused: true });
    });

    await t.test('request / response', async () => {
      const info = await conn.ok('workspace.info');
      assert.deepEqual(info, { name: 'project', folders: [{ name: 'project', path: path.resolve(wsDir) }], activeFile: null });

      const list = await conn.ok('fs.list', {});
      assert.equal(list.path, path.resolve(wsDir));
      assert.deepEqual(
        list.entries.map((e) => `${e.type}:${e.name}`),
        ['dir:sub', 'dir:Zdir', 'file:a.txt', 'file:b.txt', 'file:blob.dat']
      );
      assert.ok(list.entries.find((e) => e.name === 'a.txt').size > 0);

      const read = await conn.ok('fs.read', { path: 'a.txt' });
      assert.equal(read.content, 'alpha\nline 2\n');
      assert.equal(read.binary, false);
      assert.equal(read.truncated, false);
      assert.equal(read.isDirty, false);
      assert.equal(read.languageId, 'plaintext');
      assert.equal(read.path, path.join(path.resolve(wsDir), 'a.txt'));

      const bin = await conn.ok('fs.read', { path: path.join(wsDir, 'blob.dat') });
      assert.equal(bin.binary, true);
      assert.equal(bin.content, '');

      assert.equal(await conn.ok('fs.write', { path: 'new/deep/file.js', content: 'x = 1\n' }), true);
      assert.equal(fs.readFileSync(path.join(wsDir, 'new', 'deep', 'file.js'), 'utf8'), 'x = 1\n');
      const back = await conn.ok('fs.read', { path: 'new/deep/file.js' });
      assert.equal(back.languageId, 'javascript');

      const run = await conn.ok('commands.run', { command: 'test.echo', args: [1, 'two'] });
      assert.deepEqual(run, { result: { args: [1, 'two'], when: '1970-01-01T00:00:00.000Z' } });
      const cmds = await conn.ok('commands.list', { filter: 'termpocket' });
      assert.ok(cmds.includes('termpocket.reconnect'));
      assert.deepEqual(await conn.ok('diagnostics.list', {}), []);
      assert.equal(await conn.ok('editor.active'), null);
    });

    await t.test('encodings survive a phone read/write; legacy code pages are never rewritten', async () => {
      const bomFile = path.join(wsDir, 'bom.ps1');
      fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-Host "é"\r\n', 'utf8')]));
      const r = await conn.ok('fs.read', { path: bomFile });
      assert.equal(r.content, 'Write-Host "é"\r\n');
      assert.equal(r.encoding, 'utf8bom');
      assert.equal(await conn.ok('fs.write', { path: bomFile, content: 'Write-Host "è"\r\n' }), true);
      assert.deepEqual([...fs.readFileSync(bomFile).subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
      assert.equal(fs.readFileSync(bomFile, 'utf8'), '\uFEFFWrite-Host "è"\r\n');

      const latin = path.join(wsDir, 'legacy.bat');
      const bytes = Buffer.from([0x61, 0xe9, 0x62, 0x0d, 0x0a]); // "aéb" in Windows-1252
      fs.writeFileSync(latin, bytes);
      const lr = await conn.ok('fs.read', { path: latin });
      assert.equal(lr.encoding, 'windows-1252');
      assert.equal(lr.content, 'aéb\r\n', 'shown correctly, not as U+FFFD');
      const w = await conn.call('fs.write', { path: latin, content: 'aéb changed\r\n' });
      assert.equal(w.ok, false);
      assert.match(w.e, /not UTF-8/);
      assert.deepEqual(fs.readFileSync(latin), bytes, 'file untouched');

      const plain = await conn.ok('fs.read', { path: 'a.txt' });
      assert.equal(plain.encoding, 'utf8');
    });

    await t.test('untitled documents and dirty tabs never raise modal dialogs on the PC', async () => {
      const untitledUri = vscode.Uri.parse('untitled:Untitled-1');
      let saves = 0;
      const doc = {
        uri: untitledUri, isClosed: false, isUntitled: true, isDirty: true, lineCount: 1, languageId: 'plaintext',
        getText: () => 'draft', validateRange: (r) => r, save: async () => { saves++; return false; },
      };
      vscode._state.textDocuments.push(doc);
      try {
        assert.equal(await conn.ok('fs.write', { path: 'untitled:Untitled-1', content: 'new text' }), true);
        assert.equal(saves, 0, 'fs.write did not call save() on an untitled doc');
        const s = await conn.call('editor.save', { path: 'untitled:Untitled-1' });
        assert.equal(s.ok, false);
        assert.match(s.e, /never been saved/);
        assert.equal(saves, 0);
      } finally {
        vscode._state.textDocuments.splice(vscode._state.textDocuments.indexOf(doc), 1);
      }

      const groups = vscode.window.tabGroups;
      const closed = [];
      const savedAll = groups.all;
      const savedClose = groups.close;
      const settingsUri = vscode.Uri.parse('vscode-userdata:/c%3A/Users/x/AppData/Roaming/Code/User/settings.json');
      groups.all = [{ viewColumn: 1, isActive: true, tabs: [
        { label: 'a.txt', isDirty: true, input: { uri: vscode.Uri.file(path.join(wsDir, 'a.txt')) } },
        { label: 'settings.json', isDirty: false, input: { uri: settingsUri } },
      ] }];
      groups.close = async (tabs) => { closed.push(...tabs.map((t2) => t2.label)); return true; };
      try {
        const c = await conn.call('editor.close', { path: 'a.txt' });
        assert.equal(c.ok, false);
        assert.match(c.e, /unsaved changes/);
        assert.deepEqual(closed, []);
        // Authority-less Uri strings (single slash) resolve as Uris, not as workspace-relative paths.
        assert.equal(await conn.ok('editor.close', { path: 'vscode-userdata:/c%3A/Users/x/AppData/Roaming/Code/User/settings.json' }), true);
        assert.deepEqual(closed, ['settings.json']);
      } finally {
        groups.all = savedAll;
        groups.close = savedClose;
      }
      const { resolveUri } = require('../src/workspace');
      assert.equal(resolveUri('git:/c%3A/repo/a.ts?{"ref":"HEAD"}').scheme, 'git');
      assert.equal(resolveUri('C:\\x\\y.txt').scheme, 'file');
      assert.equal(resolveUri('sub/a.txt').scheme, 'file');
    });

    await t.test('errors: unknown method and handler exceptions', async () => {
      const res = await conn.call('nope.nothing', {});
      assert.deepEqual(res, { t: 'res', id: res.id, ok: false, e: 'unknown method: nope.nothing' });
      const bad = await conn.call('terminals.show', { tid: 't999' });
      assert.equal(bad.ok, false);
      assert.equal(bad.e, 'unknown terminal: t999');
      const missing = await conn.call('fs.read', { path: 'does-not-exist.txt' });
      assert.equal(missing.ok, false);
      assert.match(missing.e, /does-not-exist/);
    });

    let plainTid;
    await t.test('plain terminals + shell integration exec tracking', async () => {
      const created = await conn.ok('terminals.create', { name: 'build', mirror: false });
      assert.match(created.tid, /^t\d+$/);
      plainTid = created.tid;
      const list = await conn.ok('terminals.list');
      const entry = list.find((x) => x.tid === plainTid);
      assert.equal(entry.name, 'build');
      assert.equal(entry.isMirror, false);
      assert.equal(entry.ptyId, null);
      assert.equal(typeof entry.pid, 'number');
      await conn.waitEvent('terminals.changed', (p) => p.terminals.some((x) => x.tid === plainTid));

      const term = vscode._state.terminals.find((x) => x.name === 'build');
      assert.equal(await conn.ok('terminals.sendText', { tid: plainTid, text: 'echo hi' }), true);
      assert.deepEqual(term.sent, ['echo hi\r']);

      // Fake shell integration: executeCommand returns an execution whose output streams in chunks.
      let release;
      const gate = new Promise((r) => (release = r));
      const execution = {
        commandLine: { value: 'npm test', confidence: 2, isTrusted: true },
        cwd: vscode.Uri.file(wsDir),
        async *read() {
          yield '\x1b[32mok 1\x1b[0m\r\n';
          await gate;
          yield 'ok 2\r\n';
        },
      };
      term.shellIntegration = { cwd: vscode.Uri.file(wsDir), executeCommand: () => execution };
      const { execId } = await conn.ok('terminals.exec', { tid: plainTid, command: 'npm test' });
      assert.match(execId, /^x\d+$/);
      // VS Code also fires the start event for the same execution: must not create a duplicate.
      vscode._fire('window.onDidStartTerminalShellExecution', { terminal: term, execution, shellIntegration: term.shellIntegration });

      const start = await conn.waitEvent('term.exec.start', (p) => p.execId === execId);
      assert.deepEqual(start.p, { tid: plainTid, execId, commandLine: 'npm test', cwd: path.resolve(wsDir) });
      await conn.waitEvent('term.exec.data', (p) => p.execId === execId && p.d.includes('ok 1'));
      release();
      vscode._fire('window.onDidEndTerminalShellExecution', { terminal: term, execution, exitCode: 0, shellIntegration: term.shellIntegration });
      const end = await conn.waitEvent('term.exec.end', (p) => p.execId === execId);
      assert.deepEqual(end.p, { tid: plainTid, execId, exitCode: 0 });
      // all data events precede end
      const idxEnd = conn.events.indexOf(end);
      const data = conn.events.filter((e) => e.ev === 'term.exec.data' && e.p.execId === execId);
      assert.ok(data.every((e) => conn.events.indexOf(e) < idxEnd));
      assert.equal(data.map((e) => e.p.d).join(''), '\x1b[32mok 1\x1b[0m\r\nok 2\r\n');
      assert.equal(conn.events.filter((e) => e.ev === 'term.exec.start' && e.p.execId === execId).length, 1);

      const history = await conn.ok('terminals.history', { tid: plainTid });
      assert.equal(history.length, 1);
      assert.equal(history[0].execId, execId);
      assert.equal(history[0].exitCode, 0);
      assert.equal(history[0].output, '\x1b[32mok 1\x1b[0m\r\nok 2\r\n');
      assert.ok(history[0].endedAt >= history[0].startedAt);

      // without shell integration → sendText fallback
      term.shellIntegration = undefined;
      vscode._state.terminals; // eslint-disable-line no-unused-expressions
      const fb = await conn.ok('terminals.exec', { tid: plainTid, command: 'dir' });
      assert.deepEqual(fb, { execId: null });
    });

    await t.test('live view of an ordinary terminal: attach, term.raw, input, dims, detach', async () => {
      // created through terminals.create → never treated as restored, even right after activation
      const { tid } = await conn.ok('terminals.create', { name: 'claude', mirror: false });
      const term = vscode._state.terminals.find((x) => x.name === 'claude');
      term.dimensions = { columns: 132, rows: 40 };
      term.shellIntegration = { cwd: vscode.Uri.file(wsDir) };

      // A full-screen app started through shell integration: read() is called synchronously from the
      // start event, all its output goes into the raw ring.
      let readCalledSync = false;
      let push;
      const queue = [];
      let wake = null;
      push = (d) => {
        queue.push(d);
        if (wake) wake();
      };
      const execution = {
        commandLine: { value: 'claude', confidence: 2, isTrusted: true },
        cwd: vscode.Uri.file(wsDir),
        read() {
          readCalledSync = true;
          return (async function* () {
            for (;;) {
              while (queue.length) {
                const d = queue.shift();
                if (d === null) return;
                yield d;
              }
              await new Promise((r) => (wake = r));
              wake = null;
            }
          })();
        },
      };
      vscode._fire('window.onDidStartTerminalShellExecution', { terminal: term, execution, shellIntegration: term.shellIntegration });
      assert.equal(readCalledSync, true, 'read() called synchronously inside the start event');
      push('\x1b[?25l\x1b[2J\x1b[H╭─ Claude Code ─╮\r\n');
      await waitFor(() => api.terminals.live.states.get(tid).ring.data.includes('Claude Code'), 2000, 'ring fed');

      const r = await conn.ok('terminals.attach', { tid });
      assert.equal(r.tid, tid);
      // a dim "$ <commandLine>" line stands in for the prompt, then the program's output
      assert.equal(r.buffer, '\x1b[2m$ claude\x1b[22m\r\n\x1b[?25l\x1b[2J\x1b[H╭─ Claude Code ─╮\r\n');
      assert.equal(r.running, true);
      assert.equal(r.cols, 132);
      assert.equal(r.rows, 40);
      assert.equal(r.capturing, true);
      assert.equal(typeof r.since, 'number');
      assert.equal(r.note, undefined);

      push('> progress?');
      const raw = await conn.waitEvent('term.raw', (p) => p.tid === tid && p.d.includes('progress?'));
      assert.equal(raw.p.d, '> progress?');

      assert.equal(await conn.ok('terminals.input', { tid, d: 'hi\r' }), true);
      assert.equal(await conn.ok('terminals.input', { tid, d: '\x1b[A' }), true);
      assert.deepEqual(term.sent.slice(-2), ['hi\r', '\x1b[A'], 'sendText(d, false): no newline added');

      term.dimensions = { columns: 100, rows: 30 };
      const dims = await conn.waitEvent('term.dims', (p) => p.tid === tid, 3000);
      assert.deepEqual(dims.p, { tid, cols: 100, rows: 30 });

      assert.deepEqual(await conn.ok('terminals.keepalive', { tid }), { attached: true });
      assert.equal(await conn.ok('terminals.detach', { tid }), true);
      const before = conn.events.filter((e) => e.ev === 'term.raw').length;
      push('after detach');
      await sleep(100);
      assert.equal(conn.events.filter((e) => e.ev === 'term.raw').length, before, 'no stream after detach');
      push(null);
      vscode._fire('window.onDidEndTerminalShellExecution', { terminal: term, execution, exitCode: 0, shellIntegration: term.shellIntegration });

      // per-execution history is unchanged (no synthetic command line in it)
      const hist = await conn.ok('terminals.history', { tid });
      assert.equal(hist.length, 1);
      assert.ok(hist[0].output.startsWith('\x1b[?25l'));
      assert.ok(hist[0].output.endsWith('> progress?after detach'));
      await waitFor(() => api.terminals.live.states.get(tid).running === 0, 3000, 'execution ended');
      assert.equal((await conn.ok('terminals.attach', { tid })).running, false);
      await conn.ok('terminals.detach', { tid });
      assert.equal(api.terminals.live.attachedCount(tid), 0);

      const err = await conn.call('terminals.attach', { tid: 't999' });
      assert.equal(err.ok, false);
      assert.match(err.e, /unknown terminal/);
    });

    await t.test('settings.get / settings.mirrorDefault and the palette command', async () => {
      vscode._state.config = {};
      vscode._state.configUpdates = [];
      assert.deepEqual(await conn.ok('settings.get'), { mirrorDefault: false, mirrorProfile: 'TermPocket (mirrored)' });
      assert.deepEqual(await conn.ok('settings.mirrorDefault', { enable: true }), { enabled: true });
      assert.equal(vscode._state.config['terminal.integrated.defaultProfile.windows'], 'TermPocket (mirrored)');
      assert.ok(vscode._state.configUpdates.every((u) => u.target === vscode.ConfigurationTarget.Global));
      await conn.waitEvent('settings.changed', (p) => p.mirrorDefault === true);
      assert.deepEqual(await conn.ok('settings.mirrorDefault', { enable: false }), { enabled: false });
      assert.deepEqual(vscode._state.config, {});
      // the contributed profile title the setting must name
      const pkg = require('../package.json');
      assert.equal(pkg.contributes.terminal.profiles[0].title, 'TermPocket (mirrored)');
      assert.ok(pkg.contributes.commands.some((c) => c.command === 'termpocket.mirrorDefault'));
      await vscode.commands.executeCommand('termpocket.mirrorDefault');
      assert.equal(vscode._state.config['terminal.integrated.defaultProfile.windows'], 'TermPocket (mirrored)');
      await conn.ok('settings.mirrorDefault', { enable: false });
    });

    const session = (id, extra = {}) =>
      Object.assign(
        { id, title: 'PowerShell', shell: 'powershell.exe', cwd: wsDir, cols: 120, rows: 30, pid: 999, createdAt: Date.now(), exited: false, exitCode: null, mirror: { windowId: api.windowId } },
        extra
      );

    await t.test('mirrored terminal via terminals.create (pty.create + mirror.open)', async () => {
      agent.handlers['pty.create'] = (p, c) => {
        assert.equal(p.title, 'phone term');
        assert.equal(p.cwd, path.resolve(wsDir));
        // Agent spawns the PTY, answers, then sends mirror.open back (PROTOCOL §5.3).
        setTimeout(() => c.call('mirror.open', { session: session('p7', { title: p.title }), buffer: 'PS> ' }), 20);
        return session('p7', { title: p.title });
      };
      const r = await conn.ok('terminals.create', { name: 'phone term' });
      assert.equal(r.ptyId, 'p7');
      assert.match(r.tid, /^t\d+$/);
      const term = vscode._state.terminals.find((x) => x.name === 'phone term');
      assert.ok(term, 'terminal created');
      await waitFor(() => term.output.includes('PS> '), 2000, 'buffer replay');

      conn.emit('mirror.data', { ptyId: 'p7', d: 'hello from pty' });
      await waitFor(() => term.output.includes('hello from pty'), 2000, 'mirror.data');

      term.sendText('dir');
      await conn.waitEvent('mirror.input', (p) => p.ptyId === 'p7' && p.d === 'dir\r');
      // VS Code opened it at 100x25 while the PTY is 120x30 → resize forwarded.
      await conn.waitEvent('mirror.resize', (p) => p.ptyId === 'p7' && p.cols === 100 && p.rows === 25);

      const list = await conn.ok('terminals.list');
      const entry = list.find((x) => x.tid === r.tid);
      assert.equal(entry.isMirror, true);
      assert.equal(entry.ptyId, 'p7');
      assert.equal(entry.pid, 999);

      conn.emit('mirror.exit', { ptyId: 'p7', exitCode: 3 });
      await waitFor(() => term.output.includes('\r\n[process exited with code 3]\r\n'), 2000, 'exit message');
      const before = conn.events.filter((e) => e.ev === 'mirror.input').length;
      term.sendText('ignored');
      await sleep(50);
      assert.equal(conn.events.filter((e) => e.ev === 'mirror.input').length, before, 'input ignored after exit');

      term.dispose();
      await conn.waitEvent('mirror.closed', (p) => p.ptyId === 'p7');
    });

    await t.test('mirror.open from a phone-created PTY', async () => {
      const r = await conn.ok('mirror.open', { session: session('p8', { title: 'from phone' }), buffer: 'scrollback\r\n' });
      assert.match(r.tid, /^t\d+$/);
      const term = vscode._state.terminals.find((x) => x.name === 'from phone');
      await waitFor(() => term.output.includes('scrollback'), 2000, 'buffer');
    });

    await t.test('lazy mirrored terminal (profile/command): pty.create result, then mirror.open (agent order, §5.3)', async () => {
      const count = vscode._state.terminals.length;
      agent.handlers['pty.create'] = async (p, c) => {
        assert.equal(p.cols, 100);
        assert.equal(p.rows, 25);
        const s = session('p9', { title: p.title, cols: p.cols, rows: p.rows });
        // Like the agent: the response is written first, mirror.open right after it.
        setTimeout(() => c.call('mirror.open', { session: s, buffer: 'LAZY> ' }).then((opened) => assert.equal(opened.ok, true)), 0);
        return s;
      };
      await vscode.commands.executeCommand('termpocket.newMirroredTerminal');
      const term = vscode._state.terminals[vscode._state.terminals.length - 1];
      await waitFor(() => term.output.includes('LAZY> '), 3000, 'lazy buffer');
      await sleep(100);
      assert.equal(vscode._state.terminals.length, count + 1, 'no duplicate terminal');
      assert.equal(term.shown, 1);
      term.sendText('ls');
      await conn.waitEvent('mirror.input', (p) => p.ptyId === 'p9' && p.d === 'ls\r');

      // Profile provider hands out a TerminalProfile with a pty.
      const profile = vscode._state.profileProvider.provider.provideTerminalProfile();
      assert.equal(vscode._state.profileProvider.id, 'termpocket.mirroredTerminal');
      assert.ok(profile.options.pty && typeof profile.options.pty.open === 'function');
    });

    await t.test('lazy mirrored terminal: pty.create result and mirror.open in ONE TCP chunk still bind to it', async () => {
      // ws / undici emit every frame of a chunk synchronously, so mirror.open can be handled before the
      // pty.create response's await continuation has bound the lazy pty. It must not become a 2nd terminal.
      const count = vscode._state.terminals.length;
      agent.handlers['pty.create'] = async (p, c) => {
        const s = session('p9b', { title: p.title, cols: p.cols, rows: p.rows });
        const sock = c.ws._socket;
        sock.cork(); // the response (sent after this handler resolves) and mirror.open leave together
        setTimeout(() => {
          c.call('mirror.open', { session: s, buffer: 'ONECHUNK> ' });
          process.nextTick(() => sock.uncork());
        }, 0);
        return s;
      };
      await vscode.commands.executeCommand('termpocket.newMirroredTerminal');
      const term = vscode._state.terminals[vscode._state.terminals.length - 1];
      await waitFor(() => term.output.includes('ONECHUNK> '), 3000, 'one-chunk buffer');
      await sleep(100);
      assert.equal(vscode._state.terminals.length, count + 1, 'no duplicate terminal');
      term.sendText('pwd');
      await conn.waitEvent('mirror.input', (p) => p.ptyId === 'p9b' && p.d === 'pwd\r');
    });

    /** pty.create handler that waits for `release()`; then answers `id` and sends its mirror.open. */
    const gatedCreate = (id, buffer) => {
      const g = { requested: null, opened: null };
      const gate = new Promise((r) => (g.release = r));
      agent.handlers['pty.create'] = async (p, c) => {
        g.requested = p;
        await gate;
        const s = session(id, { title: p.title, cols: p.cols, rows: p.rows });
        g.opened = new Promise((r) => setTimeout(() => c.call('mirror.open', { session: s, buffer }).then(r), 0));
        return s;
      };
      return g;
    };

    await t.test('closing a lazy terminal while its pty.create is in flight leaves no ghost terminal', async () => {
      const count = vscode._state.terminals.length;
      const g = gatedCreate('p10', 'GHOST> ');
      await vscode.commands.executeCommand('termpocket.newMirroredTerminal');
      const term = vscode._state.terminals[vscode._state.terminals.length - 1];
      await waitFor(() => g.requested, 2000, 'pty.create requested');
      term.dispose(); // user closes it before the agent answered
      g.release();
      await conn.waitEvent('mirror.closed', (p) => p.ptyId === 'p10');
      await waitFor(() => g.opened, 2000, 'mirror.open sent');
      const res = await g.opened;
      assert.deepEqual({ ok: res.ok, r: res.r }, { ok: true, r: { tid: null } });
      await sleep(50);
      assert.equal(vscode._state.terminals.length, count, 'no terminal came back');
    });

    await t.test('a foreign mirror.open while a lazy pty.create is pending gets its own terminal (no guess-binding)', async () => {
      const count = vscode._state.terminals.length;
      const g = gatedCreate('p12', 'OWN> ');
      await vscode.commands.executeCommand('termpocket.newMirroredTerminal');
      const lazyTerm = vscode._state.terminals[vscode._state.terminals.length - 1];
      await waitFor(() => g.requested, 2000, 'pty.create requested');
      // A phone creates a mirrored terminal in this window meanwhile — even with the very same title.
      const r = await conn.ok('mirror.open', { session: session('p11', { title: g.requested.title }), buffer: 'PHONE> ' });
      assert.match(r.tid, /^t\d+$/);
      assert.equal(vscode._state.terminals.length, count + 2, 'phone session in its own terminal');
      const phoneTerm = vscode._state.terminals[vscode._state.terminals.length - 1];
      assert.notEqual(phoneTerm, lazyTerm);
      await waitFor(() => phoneTerm.output.includes('PHONE> '), 2000, 'phone buffer');
      assert.ok(!lazyTerm.output.includes('PHONE> '), 'lazy terminal not hijacked');
      g.release();
      await waitFor(() => lazyTerm.output.includes('OWN> '), 3000, 'lazy terminal got its own session');
      await sleep(50);
      assert.equal(vscode._state.terminals.length, count + 2, 'no extra terminal for the lazy session');
      lazyTerm.sendText('x');
      await conn.waitEvent('mirror.input', (p) => p.ptyId === 'p12' && p.d === 'x\r');
      phoneTerm.sendText('y');
      await conn.waitEvent('mirror.input', (p) => p.ptyId === 'p11' && p.d === 'y\r');
    });

    await t.test('agent restart without mirror.rebind (older agent): mirrors show "reconnecting", then end', async () => {
      const port = agent.port;
      const mirrorTerm = vscode._state.terminals.find((x) => x.name === 'from phone');
      await agent.close();
      await waitFor(() => !api.connection.connected, 2000, 'disconnected');
      await waitFor(() => mirrorTerm.output.endsWith(RECONNECTING_MSG), 2000, 'dim reconnecting line');
      assert.ok(!mirrorTerm.output.includes('[TermPocket agent disconnected]'), 'not ended on a mere disconnect');
      assert.equal(vscode._state.statusItems[0].text, '$(debug-disconnect) TermPocket');
      const sentBefore = mirrorTerm.sent.length;
      mirrorTerm.sendText('dead input'); // ignored, must not throw
      assert.equal(mirrorTerm.sent.length, sentBefore + 1);

      agent = await new FakeAgent().listen(port); // no mirror.rebind handler → "unknown method"
      const conn2 = await agent.conn(0, 8000);
      assert.equal(conn2.messages[0].m, 'hello.challenge');
      const hello = conn2.messages[1];
      assert.equal(hello.id, 2);
      assert.equal(hello.m, 'hello');
      assert.equal(hello.p.windowId, api.windowId, 'same windowId across reconnects');
      await waitFor(() => api.connection.connected, 2000, 'connected again');
      await waitFor(() => conn2.messages.some((m) => m.m === 'mirror.rebind'), 2000, 'mirror.rebind requested right after hello');
      await waitFor(() => mirrorTerm.output.endsWith('\r\n[TermPocket agent disconnected]\r\n'), 2000, 'old-agent fallback');
      assert.ok(!conn2.events.some((e) => e.ev === 'mirror.input' && e.p.d === 'dead input'), 'input typed while offline is not replayed');
      const info = await conn2.ok('workspace.info');
      assert.equal(info.name, 'project');

      // Agent re-opens the mirror after reconnect → terminal revived with the replayed buffer.
      await conn2.ok('mirror.open', { session: session('p8', { title: 'from phone' }), buffer: 'replayed' });
      await waitFor(() => mirrorTerm.output.endsWith('\x1b[2J\x1b[3J\x1b[Hreplayed'), 2000, 'revived');
      conn = conn2;
    });

    await t.test('agent restart with durable PTYs: mirrors re-bind on reconnect and replay exactly what the PTY shows', async () => {
      const port = agent.port;
      const mirrorTerm = vscode._state.terminals.find((x) => x.name === 'from phone'); // p8, alive again
      // One more mirror that the user closes while the agent is away.
      await conn.ok('mirror.open', { session: session('p20', { title: 'closed offline' }), buffer: '' });
      const closedTerm = vscode._state.terminals.find((x) => x.name === 'closed offline');
      const liveIds = [...api.mirrors.byPty.values()].filter((p) => p.state === 'alive').map((p) => p.ptyId);
      assert.ok(liveIds.includes('p8') && liveIds.includes('p20'), `alive mirrors ${liveIds}`);

      await agent.close();
      await waitFor(() => !api.connection.connected, 2000, 'disconnected');
      await waitFor(() => mirrorTerm.output.endsWith(RECONNECTING_MSG), 2000, 'dim reconnecting line');
      mirrorTerm.sendText('typed while offline');
      closedTerm.dispose(); // user closes it while the agent is unreachable
      await sleep(250);

      const rebinds = [];
      agent = new FakeAgent();
      agent.handlers['mirror.rebind'] = async (p, c) => {
        rebinds.push(p.ptyIds);
        // Output produced after the agent took the buffer snapshot arrives BEFORE the reply: held, then appended.
        c.emit('mirror.data', { ptyId: 'p8', d: '<after-snapshot>' });
        await sleep(30);
        return {
          sessions: p.ptyIds.map((id) =>
            id === 'p8' || id === 'p20'
              ? { ptyId: id, ok: true, session: session(id, { title: id === 'p8' ? 'from phone' : 'closed offline', cols: 120, rows: 30 }), buffer: id === 'p8' ? 'PS> claude\r\n* Vibing...' : '' }
              : { ptyId: id, ok: false, gone: true, e: 'no such session' }
          ),
        };
      };
      await agent.listen(port);
      const conn3 = await agent.conn(0, 8000);
      await waitFor(() => rebinds.length === 1, 3000, 'mirror.rebind');
      assert.ok(rebinds[0].includes('p8'));
      assert.ok(rebinds[0].includes('p20'), 'a terminal closed while offline is re-bound so it can be closed');
      for (const id of liveIds) assert.ok(rebinds[0].includes(id), `rebind asks for ${id}`);

      await waitFor(() => mirrorTerm.output.endsWith(`${RESET_ALL}PS> claude\r\n* Vibing...<after-snapshot>`), 3000, 'reset + buffer + held output');
      assert.ok(!conn3.events.some((e) => e.ev === 'mirror.input' && e.p.d === 'typed while offline\r'), 'offline input dropped');
      await conn3.waitEvent('mirror.closed', (p) => p.ptyId === 'p20');

      // Live again: output, input and resize flow.
      conn3.emit('mirror.data', { ptyId: 'p8', d: 'next line' });
      await waitFor(() => mirrorTerm.output.endsWith('next line'), 2000, 'mirror.data after rebind');
      mirrorTerm.sendText('y');
      await conn3.waitEvent('mirror.input', (p) => p.ptyId === 'p8' && p.d === 'y\r');
      await conn3.waitEvent('mirror.resize', (p) => p.ptyId === 'p8' && p.cols === 100 && p.rows === 25);

      // PTYs that are gone show "[process ended]" and ignore input.
      for (const id of liveIds.filter((x) => x !== 'p8' && x !== 'p20')) {
        const pty = api.mirrors.byPty.get(id);
        assert.equal(pty.state, 'dead');
        const term = vscode._state.terminals.find((x) => api.mirrors.ptyOf(x) === pty);
        assert.ok(term.output.endsWith(ENDED_MSG), `${id} shows [process ended]`);
        term.sendText('z');
      }
      await sleep(50);
      assert.ok(!conn3.events.some((e) => e.ev === 'mirror.input' && e.p.d === 'z\r'));
      const list = await conn3.ok('terminals.list');
      assert.ok(list.some((x) => x.ptyId === 'p8' && x.isMirror));
      conn = conn3;
    });
  } finally {
    ext.deactivate();
    await agent.close();
  }
});

// ---- connection layer with the `ws` fallback implementation --------------------------------------

test('RpcConnection over the bundled ws package: symmetric RPC, bad token hold, reconnect', async () => {
  const { RpcConnection } = require('../src/connection');
  const WS = require('ws');
  let agent = await new FakeAgent().listen();
  let token = TOKEN;
  let attempts = 0;
  const conn = new RpcConnection({
    WebSocketImpl: WS,
    minDelayMs: 50,
    maxDelayMs: 200,
    resolveTarget: () => {
      attempts++;
      return { url: `ws://127.0.0.1:${agent.port}/vscode`, token, configPath: 'mem' };
    },
    helloParams: () => ({ windowId: 'w1', name: 'n', folders: [], vscodeVersion: 'x', pid: 1 }),
  });
  conn.register('echo', async (p) => ({ echoed: p.v }));
  conn.register('boom', async () => {
    throw new Error('kaboom');
  });
  const seen = [];
  conn.onEvent('mirror.data', (p) => seen.push(p));

  try {
    conn.start();
    let c = await agent.conn(0);
    await waitFor(() => conn.connected, 2000, 'connected');
    assert.equal(conn.info.agentVersion, 'fake-agent');

    assert.deepEqual((await c.call('echo', { v: 42 })).r, { echoed: 42 });
    assert.deepEqual(await c.call('boom', {}), { t: 'res', id: 2, ok: false, e: 'kaboom' });
    assert.equal((await c.call('missing', {})).e, 'unknown method: missing');

    agent.handlers['pty.create'] = (p) => ({ id: 'p1', cols: p.cols });
    assert.deepEqual(await conn.request('pty.create', { cols: 80 }), { id: 'p1', cols: 80 });
    agent.handlers['fails'] = () => {
      throw new Error('nope');
    };
    await assert.rejects(conn.request('fails', {}), /nope/);

    c.emit('mirror.data', { ptyId: 'p1', d: 'x' });
    await waitFor(() => seen.length === 1, 1000, 'event');
    assert.equal(conn.notify('mirror.input', { ptyId: 'p1', d: 'y' }), true);
    await c.waitEvent('mirror.input', (p) => p.d === 'y');

    // restart → reconnects
    const port = agent.port;
    await agent.close();
    await waitFor(() => !conn.connected, 2000, 'disconnected');
    assert.equal(conn.notify('x', {}), false);
    await assert.rejects(conn.request('x', {}), /not connected/);
    agent = await new FakeAgent().listen(port);
    c = await agent.conn(0, 4000);
    assert.equal(c.messages[0].id, 1);
    await waitFor(() => conn.connected, 2000, 'reconnected');

    // A server that does not know our token (another program on the port, or an agent re-paired
    // with a new token) cannot prove itself: we drop it after hello.challenge and never send hello.
    const port2 = agent.port;
    await agent.close();
    agent = await new FakeAgent('another-token').listen(port2);
    await waitFor(() => agent.conns.length >= 1 && agent.conns[0].closed, 4000, 'refused attempt');
    for (const c2 of agent.conns) assert.deepEqual(c2.messages.map((m) => m.m), ['hello.challenge']);
    assert.match(conn.info.lastError, /could not prove/);
    assert.equal(conn.connected, false);
    const attemptsAfterReject = attempts;
    await sleep(300);
    assert.ok(attempts > attemptsAfterReject, 'config is still re-read while waiting');
    token = 'another-token'; // "re-paired"
    await waitFor(() => conn.connected, 4000, 'connected with new token');

    // Real agent says "bad token" (4401) → the same token is not retried until it changes.
    const port3 = agent.port;
    await agent.close();
    agent = await new FakeAgent('another-token').listen(port3);
    agent.rejectHello = true;
    await waitFor(() => agent.conns.length === 1 && agent.conns[0].closed, 4000, 'rejected attempt');
    await sleep(600);
    assert.equal(agent.conns.length, 1, 'no retry with a rejected token');
    token = 'third-token';
    agent.token = 'third-token';
    agent.rejectHello = false;
    await waitFor(() => conn.connected, 4000, 'connected after re-pairing');
  } finally {
    conn.stop();
    await agent.close();
  }
});

// ---- security: the extension never trusts or serves an unproven server (PROTOCOL §5.1) ----------

test('impostor on the agent port: no token leak, no requests served, proofs match the agent', async () => {
  const { RpcConnection, agentProof, extensionProof } = require('../src/connection');
  const WS = require('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/vscode' });
  await once(wss, 'listening');
  const received = [];
  let ran = 0;
  wss.on('connection', (ws) => {
    // Try to drive the extension before (and instead of) proving anything.
    ws.send(JSON.stringify({ t: 'req', id: 1, m: 'echo', p: {} }));
    ws.send(JSON.stringify({ t: 'evt', ev: 'mirror.data', p: { ptyId: 'p1', d: 'x' } }));
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      received.push(msg);
      if (msg.t === 'req' && msg.m === 'hello.challenge') {
        ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, r: { nonce: 'n'.repeat(43), proof: 'forged' } }));
      }
    });
  });
  const conn = new RpcConnection({
    WebSocketImpl: WS,
    minDelayMs: 50,
    maxDelayMs: 100,
    resolveTarget: () => ({ url: `ws://127.0.0.1:${wss.address().port}/vscode`, token: TOKEN, configPath: 'mem' }),
    helloParams: () => ({ windowId: 'w1', name: 'n', folders: [], vscodeVersion: 'x', pid: 1 }),
  });
  conn.register('echo', async () => {
    ran++;
    return 'served';
  });
  const events = [];
  conn.onEvent('mirror.data', (p) => events.push(p));
  try {
    conn.start();
    await waitFor(() => received.filter((m) => m.m === 'hello.challenge').length >= 2, 4000, 'two attempts');
    assert.equal(conn.connected, false);
    assert.equal(ran, 0, 'no handler ran for the impostor');
    assert.equal(events.length, 0, 'no event dispatched for the impostor');
    const text = JSON.stringify(received);
    assert.ok(!text.includes(TOKEN), 'token never sent');
    assert.ok(!received.some((m) => m.m === 'hello'), 'hello never sent to an unproven server');
    const res = received.find((m) => m.t === 'res' && m.id === 1);
    assert.deepEqual(res && { ok: res.ok, e: res.e }, { ok: false, e: 'not authenticated' });
    assert.match(conn.info.lastError, /could not prove/);
  } finally {
    conn.stop();
    await new Promise((r) => wss.close(r));
  }

  // The extension's proof functions must match the agent's (same formula on both sides).
  const agentServer = path.join(__dirname, '..', '..', 'agent', 'src', 'server.js');
  if (fs.existsSync(agentServer)) {
    const mod = await import(require('url').pathToFileURL(agentServer).href);
    assert.equal(agentProof(TOKEN, 'cn', 'sn'), mod.agentProof(TOKEN, 'cn', 'sn'));
    assert.equal(extensionProof(TOKEN, 'cn', 'sn'), mod.extensionProof(TOKEN, 'cn', 'sn'));
    assert.notEqual(agentProof(TOKEN, 'cn', 'sn'), extensionProof(TOKEN, 'cn', 'sn'));
  }
});

test('remote (non-file) files larger than the read cap are not pulled into the extension host', async () => {
  const { _internals } = require('../src/workspace');
  const orig = vscode.workspace.fs.readFile;
  let reads = 0;
  vscode.workspace.fs.readFile = async () => {
    reads++;
    return new Uint8Array(10);
  };
  try {
    const uri = vscode.Uri.parse('vscode-remote://ssh-remote+box/var/log/huge.log');
    assert.equal(await _internals.readHead(uri, 1024, 5 * 1024 * 1024 * 1024), null);
    assert.equal(reads, 0, 'not read at all');
    assert.equal((await _internals.readHead(uri, 1024, 10)).length, 10, 'small remote files are read');
  } finally {
    vscode.workspace.fs.readFile = orig;
  }
  assert.deepEqual(_internals.decodeText(Buffer.from([0xe2, 0x82]), true), { text: '', encoding: 'utf8' }, 'char cut at the cap is fine');
});

test('a result too large for the agent socket is answered with an error, the connection stays up', async () => {
  const { RpcConnection } = require('../src/connection');
  const agent = await new FakeAgent().listen();
  const conn = new RpcConnection({
    WebSocketImpl: require('ws'),
    maxResponseBytes: 4096,
    resolveTarget: () => ({ url: `ws://127.0.0.1:${agent.port}/vscode`, token: TOKEN, configPath: 'mem' }),
    helloParams: () => ({ windowId: 'w-big', name: 'n', folders: [], vscodeVersion: 'x', pid: 1 }),
  });
  conn.register('big', async () => 'x'.repeat(10_000));
  conn.register('small', async () => 'ok');
  try {
    conn.start();
    const c = await agent.conn(0);
    await waitFor(() => conn.connected, 2000, 'connected');
    const res = await c.call('big', {});
    assert.equal(res.ok, false);
    assert.match(res.e, /result too large/);
    assert.equal((await c.call('small', {})).r, 'ok');
    assert.equal(conn.connected, true);
  } finally {
    conn.stop();
    await agent.close();
  }
});
