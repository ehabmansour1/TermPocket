#!/usr/bin/env node
// TermPocket end-to-end integration test (PROTOCOL.md §1–§6).
//
// Acts as the phone: starts the REAL agent in a throw-away TERMPOCKET_HOME (input/power in dry-run
// mode, so nothing touches the real desktop), exercises every phone method over /ws, then launches an
// ISOLATED VS Code instance (temp --user-data-dir / --extensions-dir / USERPROFILE, the extension
// loaded via --extensionDevelopmentPath) and drives it through vsc.call, terminals, exec streaming
// and mirrored terminals, and finally drives the real PWA in a local headless Chrome (phone viewport).
// Everything it starts is stopped again; the user's own VS Code windows are never touched.
//
//   node integration.mjs               full run (agent + isolated VS Code + headless Chrome)
//   node integration.mjs --no-vscode   without VS Code
//   node integration.mjs --no-browser  without the headless-Chrome PWA checks
//   options: --port <n> (default 18765)  --keep-temp (leave the temp dirs)  --trace (log every frame)
//            --shadow-code (always start VS Code from a hard-linked shadow, see prepareCodeExe())
//
// Artefacts (small only): e2e/artifacts/{agent.log, vscode-main.log, results.json, pwa-*.jpg, …}.

import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { shutdownPtyHost } from '../agent/src/ptyhostClient.js';
import { parkWindowsOffscreen } from './lib/harness.mjs';

// ------------------------------------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const AGENT_ENTRY = path.join(ROOT, 'agent', 'src', 'index.js');
const EXTENSION_DIR = path.join(ROOT, 'vscode-extension');
const ARTIFACTS = path.join(HERE, 'artifacts');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(option('--port', process.env.TERMPOCKET_E2E_PORT || 18765));
const WITH_VSCODE = !flag('--no-vscode');
const KEEP_TEMP = flag('--keep-temp');
const WITH_BROWSER = !flag('--no-browser'); // drive the real PWA in a local headless Chrome
const TRACE = flag('--trace'); // log every phone text frame (both directions) to artifacts/trace.log
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === 'win32';

// ------------------------------------------------------------------------------------------------
// Tiny test runner: named steps, results recorded, a failing step does not abort unrelated groups.
// ------------------------------------------------------------------------------------------------

const results = [];

class SkipError extends Error {}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ name, result: 'pass', ms, detail: detail === undefined ? '' : String(detail) });
    console.log(`  ok    ${name} (${ms} ms)${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    if (err instanceof SkipError) {
      results.push({ name, result: 'skip', ms, detail: err.message });
      console.log(`  skip  ${name} — ${err.message}`);
      return false;
    }
    results.push({ name, result: 'fail', ms, detail: err.message });
    console.log(`  FAIL  ${name} (${ms} ms) — ${err.message}`);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Poll `fn` until it returns a truthy value (or throw the last error on timeout). */
async function waitFor(fn, { timeout = 10000, interval = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
    await sleep(interval);
  }
}

const samePath = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ------------------------------------------------------------------------------------------------
// Phone client: symmetric JSON RPC over /ws plus binary screen frames (§3).
// ------------------------------------------------------------------------------------------------

let traceFd = null;
function trace(dir, text) {
  if (!TRACE) return;
  if (traceFd === null) traceFd = fs.openSync(path.join(ARTIFACTS, 'trace.log'), 'w');
  const body = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  fs.writeSync(traceFd, `${new Date().toISOString().slice(11, 23)} ${dir} ${body}\n`);
}

class PhoneClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set(); // {ev, fn}
    this.frames = [];
    this.frameWaiters = [];
    this.closeInfo = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      ws.once('open', () => resolve(this));
      ws.once('error', reject);
      ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        for (const { reject: rej, timer } of this.pending.values()) {
          clearTimeout(timer);
          rej(new Error(`socket closed (${code})`));
        }
        this.pending.clear();
      });
    });
  }

  _onMessage(data, isBinary) {
    if (isBinary) {
      this.frames.push(Buffer.from(data));
      const waiters = this.frameWaiters.splice(0);
      for (const w of waiters) w();
      return;
    }
    const text = data.toString();
    trace('<-', text);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else p.reject(Object.assign(new Error(msg.e), { remote: true }));
    } else if (msg.t === 'evt') {
      for (const l of [...this.listeners]) if (l.ev === msg.ev) l.fn(msg.p);
    } else if (msg.t === 'req') {
      // A phone serves no methods (§3: unknown method).
      this.ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: `unknown method: ${msg.m}` }));
    }
  }

  request(m, p = {}, timeout = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${m}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const frame = JSON.stringify({ t: 'req', id, m, p });
        trace('->', frame);
        this.ws.send(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  vsc(windowId, m, p = {}, timeout = 35000) {
    return this.request('vsc.call', { windowId, m, p }, timeout);
  }

  on(ev, fn) {
    const l = { ev, fn };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Resolve with the first `ev` payload matching `pred` (events received from now on). */
  waitEvent(ev, pred = () => true, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const off = this.on(ev, (p) => {
        let ok = false;
        try {
          ok = pred(p);
        } catch {
          ok = false;
        }
        if (ok) {
          clearTimeout(timer);
          off();
          resolve(p);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for event ${ev}`));
      }, timeout);
    });
  }

  /** Collect text arriving as `pty.data` for `id` until `needle` shows up. */
  waitPtyOutput(id, needle, timeout = 20000) {
    let acc = '';
    return this.waitEvent(
      'pty.data',
      (p) => {
        if (p.id !== id) return false;
        acc += p.d;
        return acc.includes(needle);
      },
      timeout,
    ).then(() => acc);
  }

  async nextFrame(timeout = 15000) {
    const end = Date.now() + timeout;
    while (!this.frames.length) {
      const left = end - Date.now();
      if (left <= 0) throw new Error('timeout waiting for a screen frame');
      await new Promise((r) => {
        const t = setTimeout(r, left);
        this.frameWaiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return this.frames.shift();
  }

  waitClose(timeout = 5000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket did not close')), timeout);
      this.ws.once('close', () => {
        clearTimeout(t);
        resolve(this.closeInfo);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function authedPhone(token) {
  const c = await new PhoneClient(WS_URL).connect();
  const r = await c.request('auth', { token, client: 'pwa' });
  return { c, auth: r };
}

// ------------------------------------------------------------------------------------------------
// Windows process helpers (only ever used to clean up processes this script started).
// ------------------------------------------------------------------------------------------------

function psJson(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const text = stdout.trim();
        if (!text) return resolve([]);
        try {
          const v = JSON.parse(text);
          resolve(Array.isArray(v) ? v : [v]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** All processes as {pid, ppid, name, cmd, exe}. */
async function listProcesses() {
  const rows = await psJson(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
  );
  return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, cmd: r.CommandLine || '', exe: r.ExecutablePath || '' }));
}

/** pid plus all its (transitive) descendants in a process snapshot. */
function descendantsOf(procs, rootPid) {
  const out = new Map();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const p of procs) {
      if (p.ppid === pid && !out.has(p.pid) && p.pid !== rootPid) {
        out.set(p.pid, p);
        queue.push(p.pid);
      }
    }
  }
  return [...out.values()];
}

function taskkill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Temp environment
// ------------------------------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'termpocket-e2e-'));
const HOME_DIR = path.join(tmpRoot, 'home');
const WORKSPACE = path.join(tmpRoot, 'workspace');
const USER_DATA = path.join(tmpRoot, 'vscode-user-data');
const EXT_DIR = path.join(tmpRoot, 'vscode-extensions');
const FAKE_PROFILE = path.join(tmpRoot, 'userprofile'); // USERPROFILE for the isolated VS Code (keeps ~/.vscode-shared etc. away from the real profile)
const CODE_SHADOW = path.join(tmpRoot, 'code-shadow');
for (const d of [HOME_DIR, WORKSPACE, USER_DATA, EXT_DIR, FAKE_PROFILE, ARTIFACTS]) fs.mkdirSync(d, { recursive: true });

/** A decoy WebSocket "agent" that only counts connections (see writeWorkspace). */
const decoy = { port: 0, connections: 0, frames: [], server: null };
async function startDecoy() {
  decoy.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r, j) => { decoy.server.once('listening', r); decoy.server.once('error', j); });
  decoy.port = decoy.server.address().port;
  decoy.server.on('connection', (ws) => {
    decoy.connections++;
    ws.on('message', (d) => decoy.frames.push(String(d).slice(0, 200)));
  });
}

/** Raw HTTP GET with an arbitrary Host header (fetch() does not let us set Host). */
function rawGet(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

/** Status of a WebSocket upgrade (101 = accepted) with the given extra headers. */
function upgradeStatus(urlPath, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${urlPath}`, { headers });
    ws.on('open', () => { ws.terminate(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve(-1));
  });
}

const hmac = (key, msg) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(msg, 'utf8').digest('base64url');

function writeWorkspace() {
  fs.writeFileSync(path.join(WORKSPACE, 'hello.js'), "function greet(name) {\n  return 'Hello ' + name;\n}\n\nmodule.exports = { greet };\n");
  // Deliberate syntax errors for diagnostics.list.
  fs.writeFileSync(path.join(WORKSPACE, 'broken.js'), "const value = {;\nfunction (\n  return 1\n");
  fs.writeFileSync(path.join(WORKSPACE, 'README.md'), '# e2e workspace\n\nCreated by e2e/integration.mjs.\n');
  fs.mkdirSync(path.join(WORKSPACE, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'sub', 'data.txt'), 'line one\r\nline two\r\n');
  // A hostile workspace tries to redirect the extension to a decoy "agent" with its own token. Both
  // settings are application-scoped, so VS Code must ignore them here; the old vscontrol.* names (no longer
  // declared) are only ever read from user settings by the extension (checked in vscodeTests()).
  if (decoy.port) {
    const decoyCfg = path.join(tmpRoot, 'decoy-config.json');
    fs.writeFileSync(decoyCfg, JSON.stringify({ port: decoy.port, host: '127.0.0.1', token: 'decoy-token-decoy-token' }));
    fs.mkdirSync(path.join(WORKSPACE, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE, '.vscode', 'settings.json'), JSON.stringify({
      'termpocket.agentUrl': `ws://127.0.0.1:${decoy.port}/vscode`,
      'termpocket.configPath': decoyCfg,
      // the same settings under their pre-rename names: read only from USER settings, never from here
      'vscontrol.agentUrl': `ws://127.0.0.1:${decoy.port}/vscode`,
      'vscontrol.configPath': decoyCfg,
    }, null, 2));
  }
  // Quiet, prompt-free isolated profile: no updates, telemetry, welcome page or exit confirmations.
  const userSettings = {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'workbench.enableExperiments': false,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'security.workspace.trust.enabled': false,
    'terminal.integrated.defaultProfile.windows': 'PowerShell',
    'terminal.integrated.shellIntegration.enabled': true,
    'terminal.integrated.confirmOnExit': 'never',
    'terminal.integrated.confirmOnKill': 'never',
    'terminal.integrated.enablePersistentSessions': false,
    'window.confirmBeforeClose': 'never',
    'window.restoreWindows': 'none',
    'files.hotExit': 'off',
    'git.enabled': false,
    'chat.disableAIFeatures': true,
  };
  fs.mkdirSync(path.join(USER_DATA, 'User'), { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'User', 'settings.json'), JSON.stringify(userSettings, null, 2));
}

// ------------------------------------------------------------------------------------------------
// Agent process
// ------------------------------------------------------------------------------------------------

let agent = null;
let agentLog = null;
let agentOutput = '';

const PTYHOST_PIPE = isWin ? `\\\\.\\pipe\\termpocket-ptyhost-e2e-int-${process.pid}-${Date.now().toString(36)}` : path.join(os.tmpdir(), `termpocket-ptyhost-e2e-int-${process.pid}.sock`);

async function startAgent() {
  agentLog = fs.createWriteStream(path.join(ARTIFACTS, 'agent.log'));
  const env = {
    ...process.env,
    TERMPOCKET_HOME: HOME_DIR,
    TERMPOCKET_PORT: String(PORT),
    TERMPOCKET_HOST: '127.0.0.1',
    TERMPOCKET_DRYRUN_INPUT: '1', // never inject real input / power actions
    TERMPOCKET_PTYHOST_PIPE: PTYHOST_PIPE, // its own durable PTY host (never the user's), shut down in stopAgent()
  };
  for (const k of Object.keys(env)) if (k.startsWith('VSCONTROL_')) delete env[k]; // pre-rename names would still apply
  delete env.TERMPOCKET_PUBLIC_URL;
  delete env.TERMPOCKET_PTYHOST;
  agent = spawn(process.execPath, [AGENT_ENTRY], { env, cwd: path.join(ROOT, 'agent'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    const s = chunk.toString();
    agentOutput += s;
    if (agentOutput.length > 2_000_000) agentOutput = agentOutput.slice(-1_000_000);
    agentLog.write(s);
  };
  agent.stdout.on('data', onData);
  agent.stderr.on('data', onData);
  agent.on('exit', (code) => agentLog.write(`\n[e2e] agent exited (${code})\n`));

  await waitFor(
    async () => {
      if (agent.exitCode !== null) throw new Error(`agent exited early (${agent.exitCode}):\n${agentOutput.slice(-2000)}`);
      const r = await fetch(`${BASE}/healthz`).catch(() => null);
      return r && r.ok;
    },
    { timeout: 30000, interval: 200, what: 'agent /healthz' },
  );
  await waitFor(() => /ready \(features/.test(agentOutput), { timeout: 15000, what: 'agent ready line' });
}

async function stopAgent() {
  // The durable PTY host outlives the agent (PROTOCOL §4.1): end it and its shells first.
  const hostNote = await shutdownPtyHost({ pipe: PTYHOST_PIPE, configDir: HOME_DIR })
    .then((had) => (had ? '; pty host shut down' : ''))
    .catch((err) => `; pty host shutdown failed: ${err.message}`);
  if (!agent || agent.exitCode !== null) return `not running${hostNote}`;
  const pid = agent.pid;
  // Remember the agent's process tree (helper PowerShell, ConPTY hosts, shells) before stopping it.
  const tree = isWin ? descendantsOf(await listProcesses(), pid) : [];
  agent.kill(); // Windows: TerminateProcess (no catchable signal exists for a background node)
  await waitFor(() => agent.exitCode !== null || agent.signalCode !== null, { timeout: 10000, what: 'agent exit' }).catch(() => {});
  // The helper exits on stdin EOF and ConPTY shells exit when their host closes; give them a moment.
  let leftovers = [];
  for (let i = 0; i < 20; i++) {
    leftovers = tree.filter((p) => isAlive(p.pid));
    if (!leftovers.length) break;
    await sleep(250);
  }
  if (leftovers.length) {
    // Re-check identity (pid + name) before killing to avoid any reused pid.
    const now = await listProcesses();
    for (const p of leftovers) {
      const cur = now.find((x) => x.pid === p.pid);
      if (cur && cur.name === p.name) taskkill(p.pid);
    }
  }
  return `agent ${pid} stopped; ${tree.length} child process(es) tracked, ${leftovers.length} needed a kill${hostNote}`;
}

// ------------------------------------------------------------------------------------------------
// Phone-side tests (§2, §4.1, §4.3, §4.4)
// ------------------------------------------------------------------------------------------------

function parseFrame(buf) {
  assert(buf.length > 7, `frame too short (${buf.length})`);
  assert(buf[0] === 0x01, `frame type ${buf[0]} != 0x01`);
  const seq = buf.readUInt32BE(1);
  const monitor = buf.readUInt16BE(5);
  const jpeg = buf.subarray(7);
  assert(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'JPEG SOI marker missing');
  assert(jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9, 'JPEG EOI marker missing');
  return { seq, monitor, jpeg };
}

/** Width/height from a JPEG SOFn marker. */
function jpegSize(jpeg) {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

async function phoneTests(token) {
  console.log('\n== HTTP');
  await step('GET /healthz', async () => {
    const r = await fetch(`${BASE}/healthz`);
    const j = await r.json();
    assert(r.status === 200 && j.ok === true && typeof j.version === 'string', JSON.stringify(j));
    return `version ${j.version}`;
  });
  await step('GET / serves the PWA shell', async () => {
    const r = await fetch(`${BASE}/`);
    const html = await r.text();
    assert(r.status === 200 && /text\/html/.test(r.headers.get('content-type')), `status ${r.status}`);
    assert(/app\.js/.test(html), 'index.html does not reference app.js');
    for (const f of ['vendor/xterm.js', 'vendor/xterm.css', 'vendor/addon-fit.js', 'manifest.webmanifest', 'sw.js']) {
      const x = await fetch(`${BASE}/${f}`);
      assert(x.status === 200, `${f} → ${x.status}`);
      await x.arrayBuffer();
    }
    const m = await fetch(`${BASE}/manifest.webmanifest`);
    assert(/application\/manifest\+json/.test(m.headers.get('content-type')), 'manifest content-type');
    await m.arrayBuffer();
  });
  await step('GET /pair from loopback (200) and with X-Forwarded-For (404)', async () => {
    const a = await fetch(`${BASE}/pair`);
    const body = await a.text();
    assert(a.status === 200 && body.includes(token), `direct /pair ${a.status}`);
    const b = await fetch(`${BASE}/pair`, { headers: { 'X-Forwarded-For': '100.100.1.2' } });
    await b.arrayBuffer();
    assert(b.status === 404, `forwarded /pair ${b.status}`);
  });
  await step('path traversal is blocked', async () => {
    for (const p of ['/..%2f..%2fagent%2fpackage.json', '/%2e%2e/PROTOCOL.md', '/..\\PROTOCOL.md']) {
      const r = await fetch(`${BASE}${p}`);
      const t = await r.text();
      assert(r.status >= 400 && !t.includes('termpocket-agent') && !t.includes('wire protocol'), `${p} → ${r.status}`);
    }
  });

  console.log('\n== Security: Host / Origin (§1.1), /vscode handshake (§5.1)');
  await step('DNS rebinding: a foreign Host gets 421 on /, /pair, /healthz and both upgrades (no token leak)', async () => {
    const evil = { Host: `rebind.evil.example:${PORT}` };
    for (const p of ['/', '/pair', '/healthz', '/app.js']) {
      const r = await rawGet(p, evil);
      assert(r.status === 421 && !r.body.includes(token), `${p} with foreign Host → ${r.status}`);
    }
    for (const h of [`evil.com@127.0.0.1:${PORT}`, `127.0.0.1.evil.com:${PORT}`]) {
      const r = await rawGet('/healthz', { Host: h });
      assert(r.status === 421, `Host ${h} → ${r.status}`);
    }
    assert((await upgradeStatus('/ws', evil)) === 421, '/ws upgrade with foreign Host');
    assert((await upgradeStatus('/vscode', evil)) === 421, '/vscode upgrade with foreign Host');
    const ok = await rawGet('/healthz', { Host: `localhost:${PORT}` });
    const ts = await rawGet('/healthz', { Host: 'mypc.tail1234.ts.net' });
    assert(ok.status === 200 && ts.status === 200, `localhost ${ok.status}, ts.net ${ts.status}`);
    const pairTs = await rawGet('/pair', { Host: 'mypc.tail1234.ts.net' });
    assert(pairTs.status === 404 && !pairTs.body.includes(token), `/pair with a non-loopback Host → ${pairTs.status}`);
    return 'foreign Host → 421; localhost / *.ts.net → 200; /pair needs a loopback Host';
  });
  await step('cross-site WebSocket: a foreign Origin gets 403 before auth; same-origin and no Origin pass', async () => {
    const origins = ['https://evil.example', 'null', `http://127.0.0.1:${PORT + 1}`, `http://localhost.evil.example:${PORT}`];
    for (const o of origins) {
      const a = await upgradeStatus('/ws', { Origin: o });
      const b = await upgradeStatus('/vscode', { Origin: o });
      assert(a === 403 && b === 403, `Origin ${o}: /ws ${a}, /vscode ${b}`);
    }
    assert((await upgradeStatus('/ws', { Origin: BASE })) === 101, 'same-origin /ws refused');
    assert((await upgradeStatus('/ws', {})) === 101, 'no-Origin /ws refused');
    // 403s never reach the auth limiter: the right token still works afterwards.
    const { c } = await authedPhone(token);
    c.close();
    return `${origins.length * 2} foreign-Origin upgrades → 403; same-origin + no Origin → 101; auth unaffected`;
  });
  await step('/vscode challenge-response: agent proves the token; a wrong proof → "bad token" + 4401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/vscode`);
    const frames = [];
    let closeCode = null;
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    const closed = new Promise((r) => ws.on('close', (c) => { closeCode = c; r(); }));
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const cn = crypto.randomBytes(32).toString('base64url');
    ws.send(JSON.stringify({ t: 'req', id: 1, m: 'hello.challenge', p: { nonce: cn } }));
    const r1 = await waitFor(() => frames.find((f) => f.id === 1), { timeout: 5000, what: 'challenge answer' });
    assert(r1.ok && typeof r1.r.nonce === 'string', JSON.stringify(r1));
    assert(r1.r.proof === hmac(token, `termpocket-agent\n${cn}\n${r1.r.nonce}`), 'agent proof does not verify');
    assert(!JSON.stringify(r1).includes(token), 'token on the wire');
    ws.send(JSON.stringify({ t: 'req', id: 2, m: 'hello', p: { proof: hmac('wrong-token', `termpocket-ext\n${r1.r.nonce}\n${cn}`), windowId: 'e2e-impostor', name: 'impostor', folders: [] } }));
    const r2 = await waitFor(() => frames.find((f) => f.id === 2), { timeout: 5000, what: 'hello answer' });
    await Promise.race([closed, sleep(3000)]);
    assert(!r2.ok && r2.e === 'bad token' && closeCode === 4401, `${JSON.stringify(r2)} close ${closeCode}`);
    return 'agent proof verified (HMAC); wrong extension proof rejected with 4401';
  });

  console.log('\n== Auth');
  await step('auth with a bad token → "bad token" then close 4401', async () => {
    const c = await new PhoneClient(WS_URL).connect();
    const err = await c.request('auth', { token: 'definitely-wrong', client: 'pwa' }).then(
      () => null,
      (e) => e,
    );
    assert(err && err.message === 'bad token', `expected "bad token", got ${err && err.message}`);
    const ci = await c.waitClose();
    assert(ci.code === 4401, `close code ${ci.code}`);
  });
  await step('a non-auth first message → close 4401', async () => {
    const c = await new PhoneClient(WS_URL).connect();
    c.request('pty.list', {}).catch(() => {});
    const ci = await c.waitClose();
    assert(ci.code === 4401, `close code ${ci.code}`);
  });

  let phone;
  const ok = await step('auth with the right token', async () => {
    const { c, auth } = await authedPhone(token);
    phone = c;
    assert(auth.version && auth.hostname && auth.platform === process.platform, JSON.stringify(auth));
    const want = ['pty', 'vscode', 'sys', 'screen', 'input'];
    for (const f of want) assert(auth.features.includes(f), `feature ${f} missing (${auth.features})`);
    return `features ${auth.features.join(',')}`;
  });
  if (!ok) throw new Error('cannot continue without an authenticated phone');
  await step('unknown method → "unknown method: <m>"', async () => {
    const e = await phone.request('nope.nothing', {}).then(
      () => null,
      (x) => x,
    );
    assert(e && e.message === 'unknown method: nope.nothing', e && e.message);
  });

  console.log('\n== System (§4.3)');
  await step('sys.info', async () => {
    const r = await phone.request('sys.info');
    for (const k of ['hostname', 'user', 'os', 'release', 'arch', 'uptimeSec', 'cpuModel', 'cpuCount', 'cpuLoad', 'memTotal', 'memFree', 'ips', 'monitors']) {
      assert(k in r, `missing ${k}`);
    }
    assert(r.cpuLoad >= 0 && r.cpuLoad <= 100, `cpuLoad ${r.cpuLoad}`);
    assert(Array.isArray(r.ips) && Array.isArray(r.monitors) && r.monitors.length >= 1, 'ips/monitors');
    assert(r.battery === null || (typeof r.battery.percent === 'number' && typeof r.battery.charging === 'boolean'), 'battery shape');
    return `${r.os} ${r.release}, ${r.cpuCount} CPUs, load ${r.cpuLoad}%, ${r.monitors.length} monitor(s)`;
  });
  await step('proc.list sort/limit', async () => {
    const r = await phone.request('proc.list', { sort: 'mem', limit: 10 });
    assert(Array.isArray(r) && r.length > 0 && r.length <= 10, `length ${r.length}`);
    for (const p of r) assert(Number.isInteger(p.pid) && typeof p.name === 'string' && typeof p.memMB === 'number' && 'cpuSec' in p && typeof p.title === 'string', JSON.stringify(p));
    for (let i = 1; i < r.length; i++) assert(r[i - 1].memMB >= r[i].memMB, 'not sorted by mem');
    const all = await phone.request('proc.list', { sort: 'name', limit: 10000 });
    assert(all.some((p) => p.pid === agent.pid), 'agent process not listed');
    const dflt = await phone.request('proc.list', {});
    assert(dflt.length === Math.min(150, all.length), `default limit: ${dflt.length}`);
    return `${all.length} processes, default limit 150 honoured`;
  });
  await step('clip.get returns {text}', async () => {
    const r = await phone.request('clip.get');
    assert(r && typeof r.text === 'string', JSON.stringify(r));
    return `${r.text.length} chars (content not logged)`;
  });

  // Prove dry-run is really active BEFORE sending any input/power request: proc.kill on a process
  // this script owns must report success while the process keeps running.
  let dryRun = false;
  await step('dry-run is active (proc.kill on our own child is not executed)', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await waitFor(() => child.pid, { what: 'child pid' });
      const r = await phone.request('proc.kill', { pid: child.pid, force: true });
      assert(r === true, `proc.kill → ${r}`);
      await sleep(700);
      assert(child.exitCode === null && isAlive(child.pid), 'child was killed → dry-run NOT active');
      await waitFor(() => /\[dryrun\] proc\.kill/.test(agentOutput), { timeout: 3000, what: '[dryrun] proc.kill log' });
      dryRun = true;
    } finally {
      child.kill();
    }
  });

  console.log('\n== Screen & input (§4.4)');
  let monitors = [];
  await step('screen.monitors', async () => {
    monitors = await phone.request('screen.monitors');
    assert(Array.isArray(monitors) && monitors.length >= 1, 'no monitors');
    monitors.forEach((m, i) => {
      assert(m.index === i && typeof m.name === 'string' && m.width > 0 && m.height > 0 && typeof m.primary === 'boolean', JSON.stringify(m));
    });
    assert(monitors[0].primary === true || monitors.some((m) => m.primary), 'no primary monitor');
    return monitors.map((m) => `${m.index}:${m.width}x${m.height}@${m.x},${m.y}`).join(' ');
  });
  await step('screen.start → ≥2 valid binary frames with acks → screen.stop', async () => {
    phone.frames.length = 0;
    const r = await phone.request('screen.start', { monitor: 0, fps: 4, quality: 40, maxWidth: 640 });
    assert(r.monitor && r.monitor.index === 0 && r.fps === 4 && r.quality === 40 && r.maxWidth === 640, JSON.stringify(r));
    const seen = [];
    let bytes = 0;
    while (seen.length < 3) {
      const f = parseFrame(await phone.nextFrame(15000));
      assert(f.monitor === 0, `monitor ${f.monitor}`);
      if (seen.length) assert(f.seq > seen[seen.length - 1].seq, 'seq not increasing');
      const size = jpegSize(f.jpeg);
      assert(size && size.width <= 640, `width ${size && size.width}`);
      seen.push({ seq: f.seq, ...size });
      bytes += f.jpeg.length;
      assert((await phone.request('screen.ack', { seq: f.seq })) === true, 'ack');
    }
    // Flow control: without acks the agent must stop at 2 frames in flight.
    phone.frames.length = 0;
    await sleep(2500);
    const unacked = phone.frames.length;
    assert(unacked <= 2, `${unacked} frames in flight without acks (max 2)`);
    for (const b of phone.frames.splice(0)) await phone.request('screen.ack', { seq: parseFrame(b).seq });
    assert((await phone.request('screen.stop')) === true, 'stop');
    await sleep(600);
    phone.frames.length = 0;
    await sleep(1500);
    assert(phone.frames.length === 0, `${phone.frames.length} frames after screen.stop`);
    return `${seen.length} frames ${seen[0].width}x${seen[0].height}, avg ${Math.round(bytes / seen.length / 1024)} KB, ${unacked} in flight when not acking`;
  });
  await step('screen.snapshot', async () => {
    const r = await phone.request('screen.snapshot', { monitor: 0, quality: 50, maxWidth: 800 });
    assert(r.mime === 'image/jpeg' && typeof r.data === 'string', 'shape');
    const jpeg = Buffer.from(r.data, 'base64');
    assert(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'not a JPEG');
    const size = jpegSize(jpeg);
    assert(r.width <= 800 && size.width === r.width && size.height === r.height, `${r.width}x${r.height} vs ${size.width}x${size.height}`);
    return `${r.width}x${r.height}, ${Math.round(jpeg.length / 1024)} KB`;
  });
  await step('input.mouse / input.key / input.text / power(cancel) in dry-run', async () => {
    if (!dryRun) throw new SkipError('dry-run not proven; refusing to send input');
    const last = monitors.length - 1;
    const calls = [
      ['input.mouse', { monitor: last, x: 0.5, y: 0.5, action: 'move' }],
      ['input.mouse', { monitor: 0, x: 0.25, y: 0.75, action: 'click', button: 'right' }],
      ['input.mouse', { monitor: 0, x: 0.5, y: 0.5, action: 'scroll', delta: -2 }],
      ['input.key', { key: 'F5', mods: ['ctrl', 'shift'] }],
      ['input.key', { key: 'a' }],
      ['input.text', { text: 'héllo 👋\nworld' }],
      ['power', { action: 'cancel' }],
    ];
    for (const [m, p] of calls) assert((await phone.request(m, p)) === true, `${m} → not true`);
    const bad = await phone.request('input.mouse', { monitor: 0, x: 0.5, y: 0.5, action: 'fly' }).then(
      () => null,
      (e) => e,
    );
    assert(bad, 'invalid action accepted');
    await sleep(200);
    for (const m of ['input.mouse', 'input.key', 'input.text', 'power']) {
      assert(new RegExp(`\\[dryrun\\] ${m.replace('.', '\\.')}`).test(agentOutput), `no [dryrun] log for ${m}`);
    }
    const mon = monitors[last];
    const cx = Math.round(mon.x + 0.5 * (mon.width - 1));
    return `logged as [dryrun]; centre of monitor ${last} ≈ x ${cx}`;
  });

  console.log('\n== PTY sessions (§4.1)');
  await step('pty create / attach / input / output / resize / rename / kill', async () => {
    const changed = phone.waitEvent('pty.changed', (p) => p.sessions.some((s) => s.title === 'e2e-pwsh'));
    const s = await phone.request('pty.create', { shell: 'powershell.exe', cols: 100, rows: 30, title: 'e2e-pwsh', cwd: WORKSPACE });
    assert(/^p\d+$/.test(s.id) && s.cols === 100 && s.rows === 30 && s.exited === false && s.mirror === null && s.pid > 0, JSON.stringify(s));
    assert(samePath(s.cwd, WORKSPACE), `cwd ${s.cwd}`);
    await changed;
    const at = await phone.request('pty.attach', { id: s.id });
    assert(at.session.id === s.id && typeof at.buffer === 'string', 'attach shape');
    const out = phone.waitPtyOutput(s.id, 'e2e-42', 30000);
    await phone.request('pty.input', { id: s.id, d: 'Write-Output ("e2e-" + (6*7))\r' });
    await out;
    const rz = phone.waitEvent('pty.changed', (p) => p.sessions.some((x) => x.id === s.id && x.cols === 90 && x.rows === 25));
    assert((await phone.request('pty.resize', { id: s.id, cols: 90, rows: 25 })) === true, 'resize');
    await rz;
    assert((await phone.request('pty.rename', { id: s.id, title: 'e2e renamed' })) === true, 'rename');
    const list = await phone.request('pty.list');
    const me = list.find((x) => x.id === s.id);
    assert(me && me.title === 'e2e renamed' && me.cols === 90, JSON.stringify(me));
    // Re-attach: the scrollback contains the earlier output.
    const again = await phone.request('pty.attach', { id: s.id });
    assert(again.buffer.includes('e2e-42'), 'scrollback lacks earlier output');
    assert((await phone.request('pty.detach', { id: s.id })) === true, 'detach');
    const exit = phone.waitEvent('pty.exit', (p) => p.id === s.id, 8000);
    assert((await phone.request('pty.kill', { id: s.id })) === true, 'kill');
    await exit;
    const after = await phone.request('pty.list');
    assert(!after.some((x) => x.id === s.id), 'killed session still listed');
    return `${s.id} pid ${s.pid}`;
  });
  await step('pty natural exit keeps the session listed (exitCode 3) until pty.kill', async () => {
    const s = await phone.request('pty.create', { shell: 'cmd.exe', title: 'e2e-cmd' });
    await phone.request('pty.attach', { id: s.id });
    const exit = phone.waitEvent('pty.exit', (p) => p.id === s.id, 15000);
    await phone.request('pty.input', { id: s.id, d: 'exit 3\r' });
    const e = await exit;
    assert(e.exitCode === 3, `exitCode ${e.exitCode}`);
    const listed = (await phone.request('pty.list')).find((x) => x.id === s.id);
    assert(listed && listed.exited === true && listed.exitCode === 3, JSON.stringify(listed));
    const err = await phone.request('pty.input', { id: s.id, d: 'x' }).then(
      () => null,
      (x) => x,
    );
    assert(err, 'input to an exited session accepted');
    await phone.request('pty.kill', { id: s.id });
    assert(!(await phone.request('pty.list')).some((x) => x.id === s.id), 'still listed after kill');
  });
  await step('pty.create errors (bad cwd, unknown VS Code window)', async () => {
    const a = await phone.request('pty.create', { cwd: path.join(tmpRoot, 'does-not-exist') }).then(
      () => null,
      (e) => e,
    );
    assert(a && /cwd/.test(a.message), a && a.message);
    const b = await phone.request('pty.create', { vscodeWindowId: 'no-such-window' }).then(
      () => null,
      (e) => e,
    );
    assert(b && b.message === 'vscode window not connected', b && b.message);
    const c = await phone.request('vsc.call', { windowId: 'no-such-window', m: 'workspace.info', p: {} }).then(
      () => null,
      (e) => e,
    );
    assert(c && c.message === 'vscode window not connected', c && c.message);
  });

  return phone;
}

// ------------------------------------------------------------------------------------------------
// The real PWA (§6) in a local headless Chrome, driven over the DevTools protocol with `ws`.
// Everything stays on 127.0.0.1 (agent and browser run on this PC); only small JPEG screenshots are
// written to e2e/artifacts.
// ------------------------------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.TERMPOCKET_E2E_CHROME,
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Minimal Chrome DevTools Protocol client. */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message}`));
          else res(msg.result);
        } else if (msg.method) {
          for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function pwaBrowserTests(token, phone, { vscodeWindow }) {
  console.log('\n== PWA in headless Chrome (§6, local only)');
  const chromeExe = findChrome();
  let chrome = null;
  let cdp = null;
  const errors = [];
  const profile = path.join(tmpRoot, 'chrome-profile');
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
    fs.writeFileSync(path.join(ARTIFACTS, `pwa-${name}.jpg`), Buffer.from(r.data, 'base64'));
  };
  const waitPage = (expr, what, timeout = 15000) => waitFor(() => cdp.eval(expr), { timeout, interval: 250, what });
  const clickTab = (tab) => cdp.eval(`document.getElementById('tab-${tab}').click(), true`);
  /** Fail if anything makes the page wider than the phone (mobile Chrome would then zoom the layout out). */
  const assertNoOverflow = async (where) => {
    const r = await cdp.eval(`(() => {
      const vw = 412, out = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        // Elements spanning the whole (already widened) layout are effects, not causes.
        if (b.width && b.right > vw + 1 && b.width < innerWidth - 2) {
          let p = el.parentElement, clipped = false;
          while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } p = p.parentElement; }
          if (!clipped) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + '.' + [...el.classList].join('.') + ' right=' + Math.round(b.right));
        }
      }
      return { innerWidth, docWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 30) };
    })()`);
    assert(r.docWidth <= 413 && !r.offenders.length, `${where}: horizontal overflow ${JSON.stringify(r)}`);
  };

  const booted = await step('PWA boots in headless Chrome, pairs from #token and goes online', async () => {
    if (!chromeExe) throw new SkipError('Chrome/Edge not found (set TERMPOCKET_E2E_CHROME)');
    chrome = spawn(
      chromeExe,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
        '--window-size=412,915',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    const portFile = path.join(profile, 'DevToolsActivePort');
    const port = await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0], { timeout: 20000, what: 'DevToolsActivePort' });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    assert(page, 'no page target');
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') errors.push(`log: ${p.entry.text} ${p.entry.url || ''}`);
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Page.navigate', { url: `${BASE}/#token=${encodeURIComponent(token)}` });
    await waitPage(`document.getElementById('statusPill')?.dataset.status === 'online'`, 'status pill "online"');
    const state = await cdp.eval(`({ hash: location.hash, stored: localStorage.getItem('termpocket.token'), sw: 'serviceWorker' in navigator })`);
    assert(state.hash === '', `token left in the URL: ${state.hash}`);
    assert(state.stored === token, 'token not stored in localStorage');
    await sleep(500);
    await shot('terminals');
    await assertNoOverflow('Terminals tab');
    return `${path.basename(chromeExe)}; token moved from URL to localStorage`;
  });

  if (booted) {
    let sid = null;
    await step('Terminals tab: live PTY list → xterm view → output from the PC and typing from the PWA', async () => {
      await clickTab('terminals');
      const s = await phone.request('pty.create', { title: 'e2e-browser', cwd: WORKSPACE, cols: 60, rows: 20 });
      sid = s.id;
      await waitPage(`[...document.querySelectorAll('#panel-terminals button.row-main')].some((b) => b.textContent.includes('e2e-browser'))`, 'e2e-browser in the PTY list');
      await cdp.eval(`[...document.querySelectorAll('#panel-terminals button.row-main')].find((b) => b.textContent.includes('e2e-browser')).click(), true`);
      await waitPage(`!!document.querySelector('#views .xterm-helper-textarea')`, 'xterm view');
      await sleep(600); // auto-fit (agent-only PTY) → pty.resize
      const layout = await cdp.eval(`(() => {
        const wrap = document.querySelector('#views .term-wrap');
        const screen = document.querySelector('#views .xterm-screen');
        return { innerWidth, docWidth: document.documentElement.scrollWidth, vvWidth: visualViewport.width,
                 wrapWidth: wrap.clientWidth, screenWidth: screen ? screen.getBoundingClientRect().width : -1,
                 hostWidth: document.querySelector('#views .term-host').getBoundingClientRect().width };
      })()`);
      const sized = (await phone.request('pty.list')).find((x) => x.id === sid);
      fs.writeFileSync(path.join(ARTIFACTS, 'pwa-xterm-layout.json'), JSON.stringify({ layout, cols: sized.cols, rows: sized.rows }, null, 2));
      assert(layout.docWidth <= layout.innerWidth + 1, `page overflows horizontally: ${JSON.stringify(layout)}`);
      assert(layout.screenWidth <= layout.wrapWidth + 1, `terminal wider than its box: ${JSON.stringify(layout)} cols ${sized.cols}`);
      // Output produced on the PC shows up in the phone's terminal.
      await phone.request('pty.attach', { id: sid });
      await sleep(500); // let the PWA finish its own pty.attach
      await phone.request('pty.input', { id: sid, d: "Write-Output ('from' + '-pc-ok')\r" });
      await waitPage(`(document.querySelector('#views .xterm-rows')?.textContent || '').includes('from-pc-ok')`, 'PC output rendered by xterm');
      // Typing into xterm on the phone reaches the PTY.
      const typed = phone.waitPtyOutput(sid, 'typed-in-pwa', 20000);
      await cdp.eval(`document.querySelector('#views .xterm-helper-textarea').focus(), true`);
      await cdp.send('Input.insertText', { text: "Write-Output ('typed' + '-in-pwa')" });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await typed;
      await waitPage(`(document.querySelector('#views .xterm-rows')?.textContent || '').includes('typed-in-pwa')`, 'typed command output rendered');
      await sleep(400);
      await shot('xterm');
      const rows = await cdp.eval(`[...document.querySelectorAll('#views .xterm-rows > div')].map((r) => r.textContent.replace(/\\s+$/, '')).join('\\n')`);
      fs.writeFileSync(path.join(ARTIFACTS, 'pwa-xterm-rows.txt'), rows);
      await cdp.eval('history.back(), true');
      await sleep(500);
      return sid;
    });
    if (sid) await phone.request('pty.kill', { id: sid }).catch(() => {});

    if (vscodeWindow) {
      await step('Code tab: VS Code window → file browser lists the workspace', async () => {
        await clickTab('code');
        await waitPage(`(document.getElementById('panel-code').innerText || '').includes('hello.js')`, 'hello.js in the Code tab', 20000);
        await shot('code');
      await assertNoOverflow('Code tab');
      });
    }
    await step('Screen tab: frames are drawn to the canvas', async () => {
      await clickTab('screen');
      await waitPage(
        `(() => { const c = document.querySelector('#panel-screen canvas'); return !!c && c.width >= 320 && c.height > 0; })()`,
        'a drawn screen frame',
        20000,
      );
      await sleep(800);
      await shot('screen');
      await assertNoOverflow('Screen tab');
      const dims = await cdp.eval(`(() => { const c = document.querySelector('#panel-screen canvas'); return c.width + 'x' + c.height; })()`);
      await clickTab('system'); // leaving the tab stops the stream
      return `canvas ${dims}`;
    });
    await step('System tab: sys.info cards', async () => {
      await clickTab('system');
      const host = os.hostname();
      await waitPage(`(document.getElementById('panel-system').innerText || '').toLowerCase().includes(${JSON.stringify(host.toLowerCase())})`, 'hostname on the System tab');
      await shot('system');
      await assertNoOverflow('System tab');
    });
    await step('PWA: no uncaught exceptions or console errors', async () => {
      assert(!errors.length, errors.slice(0, 5).join(' | '));
    });
  }

  // Close the browser (and only that browser).
  try {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (chrome && chrome.pid) {
      await waitFor(() => chrome.exitCode !== null, { timeout: 5000, what: 'chrome exit' }).catch(() => taskkill(chrome.pid));
      // Chrome's helper processes (identified by our unique profile dir) may linger for a moment.
      const marker = profile.toLowerCase();
      const ours = async () => (isWin ? (await listProcesses()).filter((p) => p.cmd.toLowerCase().includes(marker)) : []);
      const settled = await waitFor(async () => (await ours()).length === 0, { timeout: 5000, interval: 500, what: 'chrome helpers' })
        .then(() => true)
        .catch(() => false);
      if (!settled) for (const p of await ours()) taskkill(p.pid);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Isolated VS Code (§4.2, §5)
// ------------------------------------------------------------------------------------------------

let code = null; // main Code.exe ChildProcess
let codeNote = '';

/** The installed VS Code: {installDir, exe, versionDir} (versionDir = the per-version folder of newer builds, or null). */
function findCodeInstall() {
  if (process.env.TERMPOCKET_E2E_CODE) {
    const exe = process.env.TERMPOCKET_E2E_CODE;
    return { installDir: path.dirname(exe), exe, versionDir: null };
  }
  const out = execFileSync('where', ['code.cmd'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
  for (const cmd of out) {
    const installDir = path.resolve(path.dirname(cmd), '..');
    const exe = path.join(installDir, 'Code.exe');
    if (!fs.existsSync(exe)) continue;
    // Versioned layout (VS Code ≥ 1.10x on Windows): bin\code.cmd names the folder, e.g. "%~dp0..\a717861c07\resources\app\out\cli.js".
    const m = /\.\.\\([0-9a-f]{6,})\\resources\\app\\out\\cli\.js/i.exec(fs.readFileSync(cmd, 'utf8'));
    return { installDir, exe, versionDir: m ? m[1] : null };
  }
  throw new Error('Code.exe not found (set TERMPOCKET_E2E_CODE)');
}

/** Hard-link every file of `src` into `dst` (no data is copied; the original install is never modified). */
function linkTree(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += linkTree(s, d);
    else if (e.isFile()) {
      fs.linkSync(s, d);
      n++;
    }
  }
  return n;
}

/**
 * A pending background update of the user's VS Code (Inno Setup waiting for the user's instance to
 * close, `updating_version` present) holds the "<mutex>-updating" mutex, and every NEW VS Code
 * instance refuses to start while it is held ("Code is currently being updated"). The user's own
 * instance and the updater must not be touched, so we start the isolated instance from a hard-linked
 * shadow of the installed build whose product.json has `win32VersionedUpdate: false` (the only switch
 * for that check). product.json is unlinked before being rewritten, so the real file is never changed.
 */
function prepareCodeExe() {
  const inst = findCodeInstall();
  const pending = fs.existsSync(path.join(inst.installDir, 'updating_version'));
  if (!(pending || flag('--shadow-code')) || !inst.versionDir) {
    codeNote = 'installed Code.exe';
    return inst.exe;
  }
  const t0 = Date.now();
  fs.mkdirSync(CODE_SHADOW, { recursive: true });
  fs.linkSync(inst.exe, path.join(CODE_SHADOW, 'Code.exe'));
  const n = 1 + linkTree(path.join(inst.installDir, inst.versionDir), path.join(CODE_SHADOW, inst.versionDir));
  const pj = path.join(CODE_SHADOW, inst.versionDir, 'resources', 'app', 'product.json');
  const product = JSON.parse(fs.readFileSync(pj, 'utf8'));
  product.win32VersionedUpdate = false;
  fs.unlinkSync(pj); // break the hard link first: the installed product.json stays untouched
  fs.writeFileSync(pj, JSON.stringify(product, null, '\t'));
  codeNote = `hard-linked shadow of ${inst.versionDir} (${n} links, ${Date.now() - t0} ms) because a VS Code update is pending`;
  return path.join(CODE_SHADOW, 'Code.exe');
}

function launchVsCode() {
  const exe = prepareCodeExe();
  // Clean environment: no ELECTRON_RUN_AS_NODE, and no VSCODE_* variables that could route the launch
  // into the user's running VS Code (e.g. VSCODE_IPC_HOOK_CLI when this runs inside a VS Code terminal).
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_|TERM_PROGRAM)/i.test(k)) continue;
    env[k] = v;
  }
  // Own home folder, so ~/.vscode, ~/.vscode-shared (shared storage) etc. of the real profile are not used.
  env.USERPROFILE = FAKE_PROFILE;
  env.HOME = FAKE_PROFILE;
  // Windows PowerShell 5.1 defaults to the "Restricted" policy, which blocks VS Code's (signed)
  // shell-integration script; RemoteSigned for this instance's shells only (Process scope).
  env.PSExecutionPolicyPreference = 'RemoteSigned';
  for (const k of Object.keys(env)) if (k.startsWith('VSCONTROL_')) delete env[k]; // pre-rename names would still apply
  env.TERMPOCKET_HOME = HOME_DIR;
  env.TERMPOCKET_PORT = String(PORT); // config.json still says 8765: the extension must honour the env override
  env.TERMPOCKET_HOST = '127.0.0.1';
  const args = [
    '--user-data-dir', USER_DATA,
    '--extensions-dir', EXT_DIR,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
    '--disable-telemetry',
    '--extensionDevelopmentPath', EXTENSION_DIR,
    '--new-window',
    WORKSPACE,
  ];
  // Code.exe is launched directly (what bin\code.cmd ends up doing) so we own the main process PID.
  const logFd = fs.openSync(path.join(ARTIFACTS, 'vscode-main.log'), 'w');
  code = spawn(exe, args, { env, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: false });
  fs.closeSync(logFd);
  code.unref();
  // Never on the user's desktop: keep the test window off-screen and un-activated (as e2e/lib/harness.mjs does).
  if (process.env.TERMPOCKET_E2E_SHOW_VSCODE !== '1') parkWindowsOffscreen(code.pid);
  return exe;
}

/** All processes of the isolated instance: the main process tree plus anything naming our temp dirs. */
async function isolatedCodeProcesses() {
  const procs = await listProcesses();
  const set = new Map();
  if (code && code.pid) {
    const main = procs.find((p) => p.pid === code.pid && /code\.exe$/i.test(p.name));
    if (main) {
      set.set(main.pid, main);
      for (const p of descendantsOf(procs, code.pid)) set.set(p.pid, p);
    }
  }
  const markers = [USER_DATA, CODE_SHADOW].map((m) => m.toLowerCase());
  for (const p of procs) {
    const hay = `${p.cmd}\n${p.exe}`.toLowerCase();
    if (markers.some((m) => hay.includes(m))) set.set(p.pid, p);
  }
  return [...set.values()];
}

async function vscodeTests(phone, token) {
  await startDecoy().catch((e) => console.log(`  note: decoy agent not started (${e.message})`));
  writeWorkspace();
  console.log('\n== Isolated VS Code (§4.2, §5)');
  let windowId = null;

  const launched = await step('launch isolated VS Code with the dev extension; window registers via hello', async () => {
    const exe = launchVsCode();
    const evt = phone.waitEvent('vsc.windows', (p) => p.windows.some((w) => w.folders.some((f) => samePath(f, WORKSPACE))), 120000).catch(() => null);
    const w = await waitFor(
      async () => {
        const list = await phone.request('vsc.windows');
        return list.find((x) => x.folders.some((f) => samePath(f, WORKSPACE)));
      },
      { timeout: 120000, interval: 1000, what: 'the isolated window in vsc.windows' },
    );
    windowId = w.windowId;
    assert(typeof w.name === 'string' && /^\d+\.\d+/.test(w.vscodeVersion) && typeof w.focused === 'boolean' && w.connectedAt > 0, JSON.stringify(w));
    await evt;
    return `${codeNote}, pid ${code.pid}; window "${w.name}" VS Code ${w.vscodeVersion}`;
  });
  if (!launched) return;
  const call = (m, p, t) => phone.vsc(windowId, m, p, t);

  await step('workspace settings cannot redirect the extension (agentUrl / configPath are application-scoped)', async () => {
    if (!decoy.port) throw new SkipError('decoy not started');
    await sleep(1500);
    assert(decoy.connections === 0, `the extension connected to the workspace's decoy agent ${decoy.connections}× (${decoy.frames.join(' | ')})`);
    return `.vscode/settings.json points at a decoy on :${decoy.port} — 0 connections; the window registered with the real agent`;
  });

  await step('workspace.info', async () => {
    const r = await call('workspace.info');
    assert(r.folders.length === 1 && samePath(r.folders[0].path, WORKSPACE) && 'activeFile' in r, JSON.stringify(r));
    return r.name;
  });
  await step('fs.list (default folder + subfolder)', async () => {
    const r = await call('fs.list', {});
    assert(samePath(r.path, WORKSPACE), r.path);
    const names = r.entries.map((e) => e.name);
    const firstFile = r.entries.findIndex((e) => e.type !== 'dir');
    assert(r.entries.slice(firstFile).every((e) => e.type !== 'dir'), 'dirs not first');
    for (const n of ['hello.js', 'broken.js', 'README.md', 'sub']) assert(names.includes(n), `missing ${n}`);
    const hello = r.entries.find((e) => e.name === 'hello.js');
    assert(hello.type === 'file' && hello.size > 0 && hello.mtime > 0, JSON.stringify(hello));
    const sub = await call('fs.list', { path: path.join(WORKSPACE, 'sub') });
    assert(sub.entries.length === 1 && sub.entries[0].name === 'data.txt', JSON.stringify(sub.entries));
    return names.join(', ');
  });
  await step('fs.read (text with CRLF, relative path)', async () => {
    const r = await call('fs.read', { path: 'sub/data.txt' });
    assert(r.content === 'line one\r\nline two\r\n' && r.binary === false && r.truncated === false && r.isDirty === false, JSON.stringify(r));
    assert(samePath(r.path, path.join(WORKSPACE, 'sub', 'data.txt')) && typeof r.languageId === 'string', r.path);
  });
  await step('fs.write (new nested file) + fs.read back', async () => {
    const p = path.join(WORKSPACE, 'e2e-tmp', 'written.txt');
    const content = 'written from the phone ✓ 👋\r\nsecond line\n';
    assert((await call('fs.write', { path: p, content })) === true, 'fs.write');
    const r = await call('fs.read', { path: p });
    assert(r.content === content, `read back ${JSON.stringify(r.content)}`);
    assert(fs.readFileSync(p, 'utf8') === content, 'disk content differs');
  });
  await step('fs.read of a missing file is an error', async () => {
    const e = await call('fs.read', { path: path.join(WORKSPACE, 'nope.txt') }).then(
      () => null,
      (x) => x,
    );
    assert(e && e.remote, 'no error');
    return e.message;
  });
  await step('fs.search', async () => {
    const r = await waitFor(
      async () => {
        const x = await call('fs.search', { query: 'hello', max: 10 });
        return x.some((f) => samePath(f, path.join(WORKSPACE, 'hello.js'))) && x;
      },
      { timeout: 20000, interval: 1000, what: 'hello.js in fs.search' },
    );
    return r.map((f) => path.basename(f)).join(', ');
  });
  await step('editor.open + editor.active + editor.tabs', async () => {
    const hello = path.join(WORKSPACE, 'hello.js');
    assert((await call('editor.open', { path: hello, line: 2, column: 3, preview: false })) === true, 'open');
    const active = await waitFor(
      async () => {
        const a = await call('editor.active');
        return a && samePath(a.path, hello) && a;
      },
      { timeout: 10000, what: 'hello.js active' },
    );
    assert(active.languageId === 'javascript' && active.line === 2 && active.column === 3, JSON.stringify(active));
    const tabs = await call('editor.tabs');
    const t = tabs.find((x) => samePath(x.path, hello));
    assert(t && t.isActive === true && typeof t.group === 'number' && t.isDirty === false, JSON.stringify(tabs));
    return `active ${path.basename(active.path)}:${active.line}:${active.column}, ${tabs.length} tab(s)`;
  });
  await step('diagnostics.list reports the syntax errors in broken.js', async () => {
    const broken = path.join(WORKSPACE, 'broken.js');
    await call('editor.open', { path: broken, preview: false });
    const diags = await waitFor(
      async () => {
        const d = await call('diagnostics.list', { path: broken });
        return d.some((x) => x.severity === 'error') && d;
      },
      { timeout: 60000, interval: 1000, what: 'errors for broken.js' },
    );
    const e = diags.find((x) => x.severity === 'error');
    assert(samePath(e.path, broken) && e.line >= 1 && e.column >= 1 && typeof e.message === 'string', JSON.stringify(e));
    const all = await call('diagnostics.list', {});
    assert(all.some((x) => samePath(x.path, broken)), 'unfiltered list lacks broken.js');
    return `${diags.length} diagnostic(s), first: line ${e.line}: ${e.message}`;
  });
  await step('editor.changed / diagnostics.changed events are forwarded as vsc.event', async () => {
    const ev = phone.waitEvent('vsc.event', (p) => p.windowId === windowId && p.ev === 'editor.changed' && p.p && 'active' in p.p && Array.isArray(p.p.tabs), 10000);
    await call('editor.open', { path: path.join(WORKSPACE, 'README.md'), preview: false });
    const e = await ev;
    return `editor.changed active=${e.p.active ? path.basename(e.p.active.path || '') : null}`;
  });
  await step('commands.list + commands.run', async () => {
    const list = await call('commands.list', { filter: 'workbench.action.files.save' });
    assert(list.includes('workbench.action.files.saveAll') && list.length <= 300, `${list.length} commands`);
    const r = await call('commands.run', { command: 'workbench.action.files.saveAll' });
    assert(r && 'result' in r, JSON.stringify(r));
    const bad = await call('commands.run', { command: 'termpocket.e2e.no.such.command' }).then(
      () => null,
      (x) => x,
    );
    assert(bad, 'unknown command did not error');
    return `${list.length} matching commands`;
  });
  await step('editor.save {path} + editor.close', async () => {
    const readme = path.join(WORKSPACE, 'README.md');
    assert((await call('editor.save', { path: readme })) === true, 'save');
    assert((await call('editor.close', { path: readme })) === true, 'close');
    const tabs = await call('editor.tabs');
    assert(!tabs.some((t) => samePath(t.path, readme)), 'README.md tab still open');
  });

  // ---- plain VS Code terminal: shell-integration exec streaming -------------------------------
  let plainTid = null;
  await step('terminals.create {mirror:false} → listed', async () => {
    const r = await call('terminals.create', { name: 'e2e-plain', mirror: false });
    assert(typeof r.tid === 'string' && !('ptyId' in r && r.ptyId), JSON.stringify(r));
    plainTid = r.tid;
    const list = await call('terminals.list');
    const t = list.find((x) => x.tid === plainTid);
    // terminal.name follows the shell's title in current VS Code builds (e.g. "powershell"), so only
    // its presence is checked here.
    assert(t && typeof t.name === 'string' && t.name && t.isMirror === false && t.ptyId === null && 'hasShellIntegration' in t && 'active' in t, JSON.stringify(t));
    return `tid ${plainTid}, name "${t.name}"`;
  });
  let shellIntegration = false;
  await step('shell integration activates in the isolated instance', async () => {
    if (!plainTid) throw new SkipError('no terminal');
    await call('terminals.show', { tid: plainTid });
    await waitFor(
      async () => {
        const list = await call('terminals.list');
        const t = list.find((x) => x.tid === plainTid);
        return t && t.hasShellIntegration && t.pid > 0;
      },
      { timeout: 45000, interval: 1000, what: 'hasShellIntegration' },
    );
    shellIntegration = true;
  });
  await step('terminals.exec "echo vsc-ok" → term.exec.start/data/end + history', async () => {
    if (!plainTid) throw new SkipError('no terminal');
    if (!shellIntegration) {
      // Fallback path: sendText, no execId.
      const r = await call('terminals.exec', { tid: plainTid, command: 'echo vsc-ok' });
      assert(r.execId === null, JSON.stringify(r));
      throw new SkipError('shell integration inactive: verified the sendText fallback (execId null) only');
    }
    let data = '';
    const offData = phone.on('vsc.event', (p) => {
      if (p.windowId === windowId && p.ev === 'term.exec.data' && p.p.tid === plainTid) data += p.p.d;
    });
    try {
      const start = phone.waitEvent('vsc.event', (p) => p.windowId === windowId && p.ev === 'term.exec.start' && p.p.tid === plainTid, 30000);
      const end = phone.waitEvent('vsc.event', (p) => p.windowId === windowId && p.ev === 'term.exec.end' && p.p.tid === plainTid, 30000);
      const r = await call('terminals.exec', { tid: plainTid, command: 'echo vsc-ok' });
      assert(typeof r.execId === 'string', `execId ${r.execId}`);
      const s = await start;
      assert(s.p.execId === r.execId && /echo vsc-ok/.test(s.p.commandLine), JSON.stringify(s.p));
      const e = await end;
      assert(e.p.execId === r.execId && e.p.exitCode === 0, JSON.stringify(e.p));
      assert(data.includes('vsc-ok'), `streamed data ${JSON.stringify(data.slice(0, 200))}`);
      const hist = await call('terminals.history', { tid: plainTid });
      const h = hist.find((x) => x.execId === r.execId);
      assert(h && /echo vsc-ok/.test(h.commandLine) && h.exitCode === 0 && h.output.includes('vsc-ok') && h.endedAt >= h.startedAt, JSON.stringify(h));
      return `execId ${r.execId}, ${data.length} chars streamed`;
    } finally {
      offData();
    }
  });
  await step('terminals.sendText', async () => {
    if (!plainTid) throw new SkipError('no terminal');
    assert((await call('terminals.sendText', { tid: plainTid, text: 'echo sent-ok', addNewLine: true })) === true, 'sendText');
    const e = await call('terminals.sendText', { tid: 't999999', text: 'x' }).then(
      () => null,
      (x) => x,
    );
    assert(e && /unknown terminal/.test(e.message), e && e.message);
  });

  // ---- mirrored terminals (§5.3) ----------------------------------------------------------------
  let phoneMirror = null;
  await step('phone pty.create {vscodeWindowId} → mirrored terminal appears in VS Code', async () => {
    const opened = phone.waitEvent('vsc.event', (p) => p.windowId === windowId && p.ev === 'terminals.changed' && p.p.terminals.some((t) => t.isMirror && t.ptyId), 20000).catch(() => null);
    const s = await phone.request('pty.create', { vscodeWindowId: windowId, title: 'e2e-mirror', cwd: WORKSPACE, cols: 100, rows: 28 });
    phoneMirror = s;
    assert(s.mirror && s.mirror.windowId === windowId, JSON.stringify(s.mirror));
    const t = await waitFor(
      async () => (await call('terminals.list')).find((x) => x.ptyId === s.id),
      { timeout: 20000, what: 'mirror in terminals.list' },
    );
    assert(t.isMirror === true && t.name === 'e2e-mirror', JSON.stringify(t));
    await opened;
    return `${s.id} ↔ ${t.tid}`;
  });
  await step('phone input to the mirrored PTY → output on the phone', async () => {
    if (!phoneMirror) throw new SkipError('no mirror');
    await phone.request('pty.attach', { id: phoneMirror.id });
    const out = phone.waitPtyOutput(phoneMirror.id, 'mirror-ok', 30000);
    // Built from two halves so the echoed command line itself does not match.
    await phone.request('pty.input', { id: phoneMirror.id, d: "Write-Output ('mirror' + '-ok')\r" });
    await out;
  });
  await step('VS Code terminal input (terminals.sendText on the mirror) → mirror.input → PTY → phone', async () => {
    if (!phoneMirror) throw new SkipError('no mirror');
    const t = (await call('terminals.list')).find((x) => x.ptyId === phoneMirror.id);
    const out = phone.waitPtyOutput(phoneMirror.id, 'typed-in-vscode', 30000);
    await call('terminals.sendText', { tid: t.tid, text: "Write-Output ('typed-in' + '-vscode')", addNewLine: true });
    await out;
  });
  await step('mirror.resize from VS Code updates the session size', async () => {
    if (!phoneMirror) throw new SkipError('no mirror');
    // The VS Code pseudoterminal reports its panel size on open/show (most recent resize wins, §5.3).
    const t = (await call('terminals.list')).find((x) => x.ptyId === phoneMirror.id);
    await call('terminals.show', { tid: t.tid });
    await phone.request('pty.resize', { id: phoneMirror.id, cols: 77, rows: 21 });
    const s = (await phone.request('pty.list')).find((x) => x.id === phoneMirror.id);
    assert(s.cols === 77 && s.rows === 21, `${s.cols}x${s.rows}`);
    return 'phone resize applied; VS Code-side sizes arrive as mirror.resize';
  });

  let extMirror = null;
  await step('terminals.create {mirror:true} (extension asks the agent for pty.create)', async () => {
    const r = await call('terminals.create', { name: 'e2e-ext-mirror', cwd: WORKSPACE, mirror: true });
    assert(typeof r.tid === 'string' && typeof r.ptyId === 'string', JSON.stringify(r));
    extMirror = r;
    const s = (await phone.request('pty.list')).find((x) => x.id === r.ptyId);
    assert(s && s.mirror && s.mirror.windowId === windowId && s.title === 'e2e-ext-mirror', JSON.stringify(s));
    const t = (await call('terminals.list')).find((x) => x.tid === r.tid);
    assert(t && t.isMirror === true && t.ptyId === r.ptyId, JSON.stringify(t));
    const list = await call('terminals.list');
    assert(list.filter((x) => x.ptyId === r.ptyId).length === 1, 'duplicate terminals for one PTY');
    await phone.request('pty.attach', { id: r.ptyId });
    const out = phone.waitPtyOutput(r.ptyId, 'ext-mirror-ok', 30000);
    await phone.request('pty.input', { id: r.ptyId, d: "Write-Output ('ext-mirror' + '-ok')\r" });
    await out;
    return `${r.ptyId} ↔ ${r.tid}`;
  });
  await step('closing the VS Code mirror terminal (terminals.dispose) kills the PTY (mirror.closed)', async () => {
    if (!phoneMirror) throw new SkipError('no mirror');
    const t = (await call('terminals.list')).find((x) => x.ptyId === phoneMirror.id);
    const gone = phone.waitEvent('pty.changed', (p) => !p.sessions.some((s) => s.id === phoneMirror.id), 10000);
    assert((await call('terminals.dispose', { tid: t.tid })) === true, 'dispose');
    await gone;
  });

  // ---- the real PWA while a VS Code window is connected ---------------------------------------
  if (WITH_BROWSER) await pwaBrowserTests(token, phone, { vscodeWindow: true });

  // ---- shut the isolated instance down ------------------------------------------------------
  await step('quit isolated VS Code (workbench.action.quit); its PTYs keep running unmirrored', async () => {
    const left = phone.waitEvent('vsc.windows', (p) => !p.windows.some((w) => w.windowId === windowId), 30000);
    await call('commands.run', { command: 'workbench.action.quit' }, 10000).catch(() => {}); // the window may close before replying
    await left;
    const procsGone = await waitFor(async () => (await isolatedCodeProcesses()).length === 0, { timeout: 30000, interval: 1000, what: 'isolated VS Code to exit' })
      .then(() => true)
      .catch(() => false);
    let note = 'exited cleanly';
    if (!procsGone) {
      const rest = await isolatedCodeProcesses();
      for (const p of rest) taskkill(p.pid);
      note = `force-killed ${rest.length} leftover isolated process(es)`;
    }
    if (extMirror) {
      const s = (await phone.request('pty.list')).find((x) => x.id === extMirror.ptyId);
      assert(s && s.mirror === null && s.exited === false, `after window close: ${JSON.stringify(s)}`);
      const out = phone.waitPtyOutput(extMirror.ptyId, 'still-alive', 20000);
      await phone.request('pty.input', { id: extMirror.ptyId, d: "Write-Output ('still' + '-alive')\r" });
      await out;
      await phone.request('pty.kill', { id: extMirror.ptyId });
    }
    return note;
  });
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------

async function main() {
  console.log(`TermPocket e2e — temp ${tmpRoot}, port ${PORT}${WITH_VSCODE ? '' : ' (agent only)'}`);
  let phone = null;
  try {
    await step('start agent (temp TERMPOCKET_HOME, dry-run input)', async () => {
      await startAgent();
      const cfg = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'config.json'), 'utf8'));
      assert(typeof cfg.token === 'string' && cfg.token.length >= 43, 'token');
      return `pid ${agent.pid}, config created with port ${cfg.port} (env override ${PORT})`;
    });
    if (!agent || agent.exitCode !== null) throw new Error('agent did not start');
    const token = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'config.json'), 'utf8')).token;
    phone = await phoneTests(token);
    if (WITH_VSCODE && isWin) await vscodeTests(phone, token);
    else if (WITH_BROWSER) await pwaBrowserTests(token, phone, { vscodeWindow: false });
  } catch (err) {
    results.push({ name: 'fatal', result: 'fail', ms: 0, detail: err.message });
    console.log(`  FATAL ${err.message}`);
  } finally {
    // Clean up everything we started.
    if (phone) {
      try {
        for (const s of await phone.request('pty.list', {}, 5000)) await phone.request('pty.kill', { id: s.id }, 5000).catch(() => {});
      } catch {
        /* agent may be gone */
      }
      phone.close();
    }
    if (code) {
      const rest = await isolatedCodeProcesses();
      for (const p of rest) taskkill(p.pid);
      if (rest.length) console.log(`  cleanup: killed ${rest.length} isolated VS Code process(es)`);
    }
    try { decoy.server?.close(); } catch { /* ignore */ }
    await step('stop agent and its child processes', stopAgent);
    agentLog?.end();
    if (!KEEP_TEMP) {
      await sleep(500);
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (err) {
        console.log(`  note: could not remove ${tmpRoot}: ${err.message}`);
      }
    }
  }

  const pass = results.filter((r) => r.result === 'pass').length;
  const fail = results.filter((r) => r.result === 'fail').length;
  const skip = results.filter((r) => r.result === 'skip').length;
  fs.writeFileSync(path.join(ARTIFACTS, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, skip, results }, null, 2));
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

main();
