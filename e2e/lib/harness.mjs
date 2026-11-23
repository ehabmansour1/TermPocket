// Shared plumbing for the TermPocket end-to-end scripts:
//   * a temp sandbox (TERMPOCKET_HOME, workspace, isolated VS Code profile),
//   * the real agent (dry-run input, restartable on the same port and config),
//   * an isolated VS Code instance with the extension loaded from source,
//   * a tiny phone-socket client used for set-up and cross-checks,
//   * Windows process helpers that only ever touch processes this harness started.
//
// Nothing here acts on the user's desktop: the agent runs with TERMPOCKET_DRYRUN_INPUT=1 so mouse,
// keyboard, power, proc.kill, clip.set and sys.open are only logged as "[dryrun] …" lines.

import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { shutdownPtyHost } from '../../agent/src/ptyhostClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const ROOT = path.resolve(E2E_DIR, '..');
export const AGENT_ENTRY = path.join(ROOT, 'agent', 'src', 'index.js');
export const EXTENSION_DIR = path.join(ROOT, 'vscode-extension');
export const isWin = process.platform === 'win32';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Poll `fn` until it returns a truthy value (returned) or the timeout expires. */
export async function waitFor(fn, { timeout = 10000, interval = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${lastErr ? ` (${lastErr.message})` : ''}`);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Windows process helpers (cleanup of our own processes only)                                  */
/* ------------------------------------------------------------------------------------------- */

function psJson(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
      (err, stdout) => {
        const text = String(stdout || '').trim();
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
export async function listProcesses() {
  const rows = await psJson(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
  );
  return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, cmd: r.CommandLine || '', exe: r.ExecutablePath || '' }));
}

/** Transitive descendants of rootPid in a process snapshot. */
export function descendantsOf(procs, rootPid) {
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

export function taskkill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Sandbox                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Keeps every top-level window of the isolated test VS Code (process `pid`) off-screen and
 * un-activated, so test runs never pop up on the user's desktop. A hidden PowerShell watcher moves
 * any visible window of that process to (-32000, -32000) without activating it, every 250 ms, and
 * exits when the process exits. Set TERMPOCKET_E2E_SHOW_VSCODE=1 to watch the window instead.
 */
export function parkWindowsOffscreen(pid) {
  if (process.platform !== 'win32' || !pid) return;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class VscE2EPark {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Park(uint target) {
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        if (r.L > -30000) SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010); // NOSIZE|NOZORDER|NOACTIVATE
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
$target = ${Number(pid)}
while (Get-Process -Id $target -ErrorAction SilentlyContinue) { [VscE2EPark]::Park([uint32]$target); Start-Sleep -Milliseconds 250 }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: 'ignore', detached: true, windowsHide: true,
  });
  watcher.unref();
}

export function createSandbox(prefix = 'termpocket-pwa-e2e-') {
  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  const dirs = {
    tmpRoot,
    home: path.join(tmpRoot, 'home'),
    workspace: path.join(tmpRoot, 'workspace'),
    userData: path.join(tmpRoot, 'vscode-user-data'),
    extDir: path.join(tmpRoot, 'vscode-extensions'),
    profile: path.join(tmpRoot, 'userprofile'),
    codeShadow: path.join(tmpRoot, 'code-shadow'),
  };
  for (const d of [dirs.home, dirs.workspace, dirs.userData, dirs.extDir, dirs.profile]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** Small workspace with a deliberately broken file (for diagnostics) and a sub folder. */
export function writeWorkspace(dirs) {
  const ws = dirs.workspace;
  fs.writeFileSync(path.join(ws, 'hello.js'), "function greet(name) {\n  return 'Hello ' + name;\n}\n\nmodule.exports = { greet };\n");
  fs.writeFileSync(path.join(ws, 'broken.js'), "const value = {;\nfunction (\n  return 1\n");
  fs.writeFileSync(path.join(ws, 'README.md'), '# PWA e2e workspace\n\nCreated by e2e/pwa.e2e.mjs.\n');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sub', 'data.txt'), 'line one\r\nline two\r\n');
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
  fs.mkdirSync(path.join(dirs.userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(dirs.userData, 'User', 'settings.json'), JSON.stringify(userSettings, null, 2));
}

export function removeSandbox(dirs) {
  try {
    fs.rmSync(dirs.tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Agent                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * The real agent as a child process. `start()` can be called again after `stop()` (same port,
 * same TERMPOCKET_HOME → same token), which is how the reconnect test restarts it.
 */
export class AgentProcess {
  constructor({ home, port, logFile }) {
    this.home = home;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.logFile = logFile;
    this.proc = null;
    this.output = '';
    this.log = logFile ? fs.createWriteStream(logFile, { flags: 'w' }) : null;
    this.runs = 0;
    // Its own PTY host pipe (never the user's real host). The host outlives the agent process (durable
    // terminals, PROTOCOL §4.1); stop() shuts it down too unless {keepPtyHost: true}.
    this.ptyHostPipe = isWin ? String.raw`\\.\pipe\termpocket-ptyhost-e2e-` + `${process.pid}-${port}-${Date.now().toString(36)}` : path.join(os.tmpdir(), `termpocket-ptyhost-e2e-${process.pid}-${port}.sock`);
  }

  get token() {
    return JSON.parse(fs.readFileSync(path.join(this.home, 'config.json'), 'utf8')).token;
  }

  get running() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  async start() {
    const env = {
      ...process.env,
      TERMPOCKET_HOME: this.home,
      TERMPOCKET_PORT: String(this.port),
      TERMPOCKET_HOST: '127.0.0.1',
      TERMPOCKET_DRYRUN_INPUT: '1', // never inject real input / power / kill / clipboard writes
      TERMPOCKET_PTYHOST_PIPE: this.ptyHostPipe,
    };
    for (const k of Object.keys(env)) if (k.startsWith('VSCONTROL_')) delete env[k]; // pre-rename names would still apply
    delete env.TERMPOCKET_PUBLIC_URL;
    delete env.TERMPOCKET_PTYHOST;
    this.runs++;
    const marker = `\n----- agent run ${this.runs} -----\n`;
    this.output += marker;
    this.log?.write(marker);
    const proc = spawn(process.execPath, [AGENT_ENTRY], { env, cwd: path.join(ROOT, 'agent'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const onData = (chunk) => {
      const s = chunk.toString();
      this.output += s;
      if (this.output.length > 4_000_000) this.output = this.output.slice(-2_000_000);
      this.log?.write(s);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => this.log?.write(`\n[e2e] agent exited (${code})\n`));
    const startLen = this.output.length;
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Error(`agent exited early (${proc.exitCode}):\n${this.output.slice(-2000)}`);
        const r = await fetch(`${this.base}/healthz`).catch(() => null);
        return r && r.ok;
      },
      { timeout: 30000, what: 'agent /healthz' },
    );
    await waitFor(() => /ready \(features/.test(this.output.slice(startLen - marker.length)), { timeout: 15000, what: 'agent ready line' });
    return proc.pid;
  }

  /**
   * Stop the agent and anything it spawned (helper PowerShell, ConPTY hosts, shells). Its PTY host
   * (and every terminal in it) is shut down too, unless `keepPtyHost` — then terminals survive like
   * they do for a real agent restart.
   */
  async stop({ keepPtyHost = false } = {}) {
    let hostNote = '';
    if (!keepPtyHost) {
      hostNote = await shutdownPtyHost({ pipe: this.ptyHostPipe, configDir: this.home })
        .then((had) => (had ? '; pty host shut down' : ''))
        .catch((err) => `; pty host shutdown failed: ${err.message}`);
    }
    if (!this.running) return `not running${hostNote}`;
    const pid = this.proc.pid;
    const tree = isWin ? descendantsOf(await listProcesses(), pid) : [];
    this.proc.kill();
    await waitFor(() => !this.running, { timeout: 10000, what: 'agent exit' }).catch(() => {});
    let leftovers = [];
    for (let i = 0; i < 20; i++) {
      leftovers = tree.filter((p) => isAlive(p.pid));
      if (!leftovers.length) break;
      await sleep(250);
    }
    if (leftovers.length) {
      const now = await listProcesses();
      for (const p of leftovers) {
        const cur = now.find((x) => x.pid === p.pid);
        if (cur && cur.name === p.name) taskkill(p.pid); // same pid AND name → still ours
      }
    }
    return `agent ${pid} stopped (${tree.length} child process(es), ${leftovers.length} needed a kill)${hostNote}`;
  }

  /** Parsed "[dryrun] <method> <json>" lines logged since output offset `since`. */
  dryRuns(since = 0) {
    const out = [];
    const re = /\[dryrun\] (\S+) (\{.*\})\s*$/gm;
    const text = this.output.slice(since);
    let m;
    while ((m = re.exec(text))) {
      try {
        out.push({ method: m[1], args: JSON.parse(m[2]) });
      } catch {
        out.push({ method: m[1], args: null, raw: m[2] });
      }
    }
    return out;
  }

  mark() {
    return this.output.length;
  }

  close() {
    this.log?.end();
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Isolated VS Code                                                                              */
/* ------------------------------------------------------------------------------------------- */

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
    const m = /\.\.\\([0-9a-f]{6,})\\resources\\app\\out\\cli\.js/i.exec(fs.readFileSync(cmd, 'utf8'));
    return { installDir, exe, versionDir: m ? m[1] : null };
  }
  throw new Error('Code.exe not found (set TERMPOCKET_E2E_CODE)');
}

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
 * A pending background update of the user's VS Code holds a mutex that makes every NEW instance
 * refuse to start. As in integration.mjs, the isolated instance then runs from a hard-linked shadow
 * of the installed build whose own product.json skips that check (the real install is untouched:
 * product.json is unlinked before being rewritten).
 */
function prepareCodeExe(dirs) {
  const inst = findCodeInstall();
  const pending = fs.existsSync(path.join(inst.installDir, 'updating_version'));
  if (!pending || !inst.versionDir) return { exe: inst.exe, note: 'installed Code.exe' };
  fs.mkdirSync(dirs.codeShadow, { recursive: true });
  fs.linkSync(inst.exe, path.join(dirs.codeShadow, 'Code.exe'));
  const n = 1 + linkTree(path.join(inst.installDir, inst.versionDir), path.join(dirs.codeShadow, inst.versionDir));
  const pj = path.join(dirs.codeShadow, inst.versionDir, 'resources', 'app', 'product.json');
  const product = JSON.parse(fs.readFileSync(pj, 'utf8'));
  product.win32VersionedUpdate = false;
  fs.unlinkSync(pj);
  fs.writeFileSync(pj, JSON.stringify(product, null, '\t'));
  return { exe: path.join(dirs.codeShadow, 'Code.exe'), note: `hard-linked shadow (${n} links) because a VS Code update is pending` };
}

export class IsolatedVsCode {
  constructor(dirs, { port, logFile }) {
    this.dirs = dirs;
    this.port = port;
    this.logFile = logFile;
    this.proc = null;
    this.note = '';
  }

  launch() {
    const { exe, note } = prepareCodeExe(this.dirs);
    this.note = note;
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(VSCODE_|ELECTRON_|TERM_PROGRAM)/i.test(k)) continue; // never route into the user's VS Code
      env[k] = v;
    }
    env.USERPROFILE = this.dirs.profile;
    env.HOME = this.dirs.profile;
    env.PSExecutionPolicyPreference = 'RemoteSigned'; // shell integration under Windows PowerShell 5.1
    for (const k of Object.keys(env)) if (k.startsWith('VSCONTROL_')) delete env[k]; // pre-rename names would still apply
    env.TERMPOCKET_HOME = this.dirs.home;
    env.TERMPOCKET_PORT = String(this.port);
    env.TERMPOCKET_HOST = '127.0.0.1';
    const args = [
      '--user-data-dir', this.dirs.userData,
      '--extensions-dir', this.dirs.extDir,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
      '--disable-telemetry',
      '--extensionDevelopmentPath', EXTENSION_DIR,
      // The window is parked off-screen (below); keep it rendering at full speed anyway.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--new-window',
      this.dirs.workspace,
    ];
    const logFd = fs.openSync(this.logFile, 'w');
    this.proc = spawn(exe, args, { env, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: false });
    fs.closeSync(logFd);
    this.proc.unref();
    if (process.env.TERMPOCKET_E2E_SHOW_VSCODE !== '1') parkWindowsOffscreen(this.proc.pid);
    return note;
  }

  /** Every process of the isolated instance: its tree plus anything naming our temp dirs. */
  async processes() {
    const procs = await listProcesses();
    const set = new Map();
    if (this.proc && this.proc.pid) {
      const main = procs.find((p) => p.pid === this.proc.pid && /code\.exe$/i.test(p.name));
      if (main) {
        set.set(main.pid, main);
        for (const p of descendantsOf(procs, this.proc.pid)) set.set(p.pid, p);
      }
    }
    const markers = [this.dirs.userData, this.dirs.codeShadow].map((m) => m.toLowerCase());
    for (const p of procs) {
      const hay = `${p.cmd}\n${p.exe}`.toLowerCase();
      if (markers.some((m) => hay.includes(m))) set.set(p.pid, p);
    }
    return [...set.values()];
  }

  /** Kill leftovers — only processes whose command line/exe names our temp --user-data-dir or shadow. */
  async killLeftovers() {
    const rest = await this.processes();
    const markers = [this.dirs.userData, this.dirs.codeShadow].map((m) => m.toLowerCase());
    let n = 0;
    for (const p of rest) {
      const hay = `${p.cmd}\n${p.exe}`.toLowerCase();
      const ours = markers.some((m) => hay.includes(m)) || (this.proc && p.pid === this.proc.pid);
      if (ours && taskkill(p.pid)) n++;
    }
    return n;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Phone socket client (set-up and cross-checks)                                                 */
/* ------------------------------------------------------------------------------------------- */

export class PhoneClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.once('open', () => resolve(this));
      ws.once('error', reject);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.t === 'res') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.r);
          else p.reject(new Error(msg.e));
        } else if (msg.t === 'evt') {
          for (const l of [...this.listeners]) if (l.ev === msg.ev) l.fn(msg.p);
        } else if (msg.t === 'req') {
          ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: `unknown method: ${msg.m}` }));
        }
      });
      ws.on('close', () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('socket closed'));
        }
        this.pending.clear();
      });
    });
  }

  static async open(port, token) {
    const c = await new PhoneClient(`ws://127.0.0.1:${port}/ws`).connect();
    await c.request('auth', { token, client: 'pwa' });
    return c;
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
        this.ws.send(JSON.stringify({ t: 'req', id, m, p }));
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

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
