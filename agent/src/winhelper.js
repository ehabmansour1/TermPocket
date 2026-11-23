// Long-lived Windows helper process (PROTOCOL.md §7).
//
// ONE `powershell.exe -File winhelper.ps1` process compiles winhelper.cs in memory (Add-Type, no .exe on disk)
// and then serves JSON-line requests on stdin/stdout:
//   → {"id":1,"op":"grab","args":{…}}
//   ← {"id":1,"ok":true,"r":…} | {"id":1,"ok":false,"e":"…"}
// The first line it prints is a ready handshake {"ready":true,"pid":…}; a startup failure prints {"fatal":"…"}.
//
// This module also hosts the small utilities shared by system.js and screen.js (logging adapter, dry-run log,
// parameter validation) so both modules stay independent of each other.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDemo } from './demo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Path of the PowerShell bootstrap script (it loads winhelper.cs from the same directory). */
export const HELPER_SCRIPT = path.join(HERE, 'winhelper.ps1');

const DEFAULT_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 45_000;      // Add-Type compile is ~250 ms warm, but AV scanning can make a cold start slow
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RUN_MS = 60_000;         // a helper that lived this long resets the crash backoff
const MAX_CONSECUTIVE_TIMEOUTS = 3;   // then the helper is assumed hung and restarted
const MAX_LINE_CHARS = 64 * 1024 * 1024;

// ------------------------------------------------------------------------------------------- shared utilities

/**
 * Adapt whatever logger the core passes in (console-like object, a plain function, or nothing) to
 * `{debug, info, warn, error}`.
 */
export function normalizeLog(log) {
  if (log && typeof log === 'object' && typeof log.info === 'function') {
    const pick = (name, fallback) => (typeof log[name] === 'function' ? log[name].bind(log) : fallback);
    const info = log.info.bind(log);
    return {
      debug: pick('debug', () => {}),
      info,
      warn: pick('warn', info),
      error: pick('error', pick('warn', info)),
    };
  }
  if (typeof log === 'function') {
    return {
      debug: () => {},
      info: (...a) => log(...a),
      warn: (...a) => log(...a),
      error: (...a) => log(...a),
    };
  }
  return {
    debug: () => {},
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
}

/**
 * Actions recorded while TERMPOCKET_DRYRUN_INPUT=1 or TERMPOCKET_DEMO=1 (input.*, power, clip.set, sys.open,
 * proc.kill).
 * Each entry: `{method, params, resolved, at}`. Re-exported by system.js and screen.js.
 */
export const dryRunLog = [];
const DRY_RUN_LOG_MAX = 1000;

/** Read at call time so tests can toggle it. Demo mode is always dry-run. */
export function isDryRun() {
  return process.env.TERMPOCKET_DRYRUN_INPUT === '1' || isDemo();
}

export function recordDryRun(log, method, params, resolved) {
  dryRunLog.push({ method, params, resolved, at: Date.now() });
  if (dryRunLog.length > DRY_RUN_LOG_MAX) dryRunLog.splice(0, dryRunLog.length - DRY_RUN_LOG_MAX);
  log.info(`[dryrun] ${method} ${safeJson(resolved)}`);
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(v);
  }
}

/** Params objects arrive straight from the phone: treat anything that is not a plain object as `{}`. */
export function paramsObject(params) {
  return params && typeof params === 'object' && !Array.isArray(params) ? params : {};
}

export function invalid(message) {
  return new Error(`invalid params: ${message}`);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Optional numeric param: undefined/null → `def`; non-finite or non-number → error; else clamped.
 */
export function optNumber(p, key, def, lo, hi) {
  const v = p[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${key} must be a number`);
  return clamp(v, lo, hi);
}

export function optInteger(p, key, def, lo, hi) {
  const v = p[key];
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v)) throw invalid(`${key} must be an integer`);
  if (v < lo || v > hi) throw invalid(`${key} must be between ${lo} and ${hi}`);
  return v;
}

export function optEnum(p, key, values, def) {
  const v = p[key];
  if (v === undefined || v === null) {
    if (def === undefined) throw invalid(`${key} is required (${values.join('|')})`);
    return def;
  }
  if (typeof v !== 'string' || !values.includes(v)) throw invalid(`${key} must be one of ${values.join('|')}`);
  return v;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------------------------- the helper

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(full)) return full;
  } catch {
    /* fall through */
  }
  return 'powershell.exe';
}

/**
 * @param {{log?: any, scriptPath?: string, defaultTimeoutMs?: number, startTimeoutMs?: number}} [opts]
 * @returns {{call(op: string, args?: object, opts?: {timeoutMs?: number}): Promise<any>, dispose(): Promise<void>,
 *            readonly pid: number|null, readonly running: boolean}}
 */
export function createWinHelper({
  log,
  scriptPath = HELPER_SCRIPT,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const L = normalizeLog(log);

  let child = null;          // ChildProcess once ready (or while starting)
  let childPid = null;       // PID reported by the helper's handshake (the powershell process)
  let ready = false;
  let startPromise = null;
  let disposed = false;
  let nextId = 1;
  const pending = new Map(); // id → {resolve, reject, timer, op}
  let consecutiveTimeouts = 0;
  let failures = 0;          // consecutive crashes / failed starts (drives the backoff)
  let lastFailureAt = 0;
  let startedAt = 0;
  let starts = 0;            // successful starts (restarts = starts - 1) — local monitor
  let lastError = null;      // last start failure / crash / hang (local monitor)

  function backoffDelay() {
    if (failures === 0) return 0;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
    return Math.max(0, lastFailureAt + wait - Date.now());
  }

  function rejectAll(err) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      pending.delete(id);
    }
  }

  function handleMessage(msg, onHandshake) {
    if (msg.ready === true || typeof msg.fatal === 'string') {
      onHandshake(msg);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const entry = pending.get(msg.id);
    if (!entry) return; // late answer to a request that already timed out
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    consecutiveTimeouts = 0;
    if (msg.ok) entry.resolve(msg.r);
    else entry.reject(new Error(typeof msg.e === 'string' && msg.e ? msg.e : `helper op ${entry.op} failed`));
  }

  function spawnHelper() {
    return new Promise((resolve, reject) => {
      const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
      let proc;
      try {
        proc = spawn(powershellPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        reject(new Error(`cannot start windows helper: ${err.message}`));
        return;
      }
      child = proc;

      let settled = false;
      const stderrTail = [];
      const startTimer = setTimeout(() => {
        fail(new Error(`windows helper did not become ready within ${startTimeoutMs} ms`));
        try { proc.kill(); } catch { /* already gone */ }
      }, startTimeoutMs);

      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        reject(err);
      }

      const onHandshake = (msg) => {
        if (settled) return;
        if (typeof msg.fatal === 'string') {
          fail(new Error(`windows helper failed to start: ${msg.fatal}`));
          return;
        }
        settled = true;
        clearTimeout(startTimer);
        childPid = Number.isInteger(msg.pid) ? msg.pid : proc.pid;
        resolve(proc);
      };

      // stdout: newline-delimited JSON. Ignore a BOM, banner text or any other non-JSON noise.
      let chunks = [];
      let chunkLen = 0;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (data) => {
        let start = 0;
        let nl;
        while ((nl = data.indexOf('\n', start)) !== -1) {
          chunks.push(data.slice(start, nl));
          const line = chunks.join('');
          chunks = [];
          chunkLen = 0;
          start = nl + 1;
          processLine(line);
        }
        if (start < data.length) {
          chunks.push(data.slice(start));
          chunkLen += data.length - start;
          if (chunkLen > MAX_LINE_CHARS) {
            L.warn('[winhelper] discarding oversized output line');
            chunks = [];
            chunkLen = 0;
          }
        }
      });

      function processLine(raw) {
        let line = raw.replace(/^\uFEFF/, '').trim();
        if (!line) return;
        if (line[0] !== '{') {
          L.debug(`[winhelper] ${line.slice(0, 300)}`);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          L.debug(`[winhelper] unparsable line: ${line.slice(0, 200)}`);
          return;
        }
        if (msg && typeof msg === 'object') handleMessage(msg, onHandshake);
      }

      proc.stderr.setEncoding('utf8');
      let errBuf = '';
      proc.stderr.on('data', (data) => {
        errBuf += data;
        let nl;
        while ((nl = errBuf.indexOf('\n')) !== -1) {
          const line = errBuf.slice(0, nl).trim();
          errBuf = errBuf.slice(nl + 1);
          if (!line) continue;
          stderrTail.push(line);
          if (stderrTail.length > 10) stderrTail.shift();
          L.warn(`[winhelper] stderr: ${line.slice(0, 500)}`);
        }
        if (errBuf.length > 64 * 1024) errBuf = errBuf.slice(-4096);
      });

      proc.stdin.on('error', (err) => {
        // EPIPE when the helper died: the 'exit' handler takes care of pending requests.
        L.debug(`[winhelper] stdin error: ${err.message}`);
      });

      proc.on('error', (err) => {
        L.error(`[winhelper] process error: ${err.message}`);
        fail(new Error(`cannot start windows helper: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        const tail = stderrTail.length ? ` — ${stderrTail.slice(-3).join(' | ')}` : '';
        fail(new Error(`windows helper exited during startup (code ${code ?? signal})${tail}`));
        if (child === proc) {
          const wasReady = ready;
          child = null;
          childPid = null;
          ready = false;
          rejectAll(new Error(`windows helper exited (code ${code ?? signal})`));
          // Startup failures are counted by start(); here we only account for a running helper dying.
          if (wasReady && !disposed) {
            const ranFor = Date.now() - startedAt;
            if (ranFor >= STABLE_RUN_MS) failures = 0;
            failures += 1;
            lastFailureAt = Date.now();
            lastError = `helper exited (code ${code ?? signal})`;
            L.warn(`[winhelper] helper exited (code ${code ?? signal}); will restart on next request`);
          }
        }
      });
    });
  }

  async function start() {
    const wait = backoffDelay();
    if (wait > 0) {
      L.info(`[winhelper] restarting helper in ${wait} ms`);
      await sleep(wait);
    }
    if (disposed) throw new Error('windows helper disposed');
    const t0 = Date.now();
    try {
      await spawnHelper();
    } catch (err) {
      failures += 1;
      lastFailureAt = Date.now();
      lastError = err?.message || String(err);
      if (child) {
        try { child.kill(); } catch { /* ignore */ }
        child = null;
      }
      throw err;
    }
    if (disposed) {
      killChild();
      throw new Error('windows helper disposed');
    }
    ready = true;
    startedAt = Date.now();
    starts += 1;
    consecutiveTimeouts = 0;
    L.info(`[winhelper] helper ready (pid ${childPid}, ${Date.now() - t0} ms)`);
  }

  function ensureStarted() {
    if (ready && child) return Promise.resolve();
    if (!startPromise) {
      startPromise = start().finally(() => {
        startPromise = null;
      });
    }
    return startPromise;
  }

  function killChild() {
    const proc = child;
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* ignore */ }
    // Give it a moment to exit on stdin EOF, then make sure.
    const t = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
    }, 1000);
    t.unref();
    proc.once('exit', () => clearTimeout(t));
  }

  function restartHung() {
    lastError = 'helper stopped answering (hung); restarted';
    L.warn('[winhelper] helper appears hung; restarting');
    const proc = child;
    if (proc) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  async function call(op, args = {}, { timeoutMs = defaultTimeoutMs } = {}) {
    if (disposed) throw new Error('windows helper disposed');
    if (process.platform !== 'win32') throw new Error('the windows helper is only available on Windows');
    if (typeof op !== 'string' || !op) throw new Error('helper op must be a non-empty string');
    await ensureStarted();
    const proc = child;
    if (!proc || !ready) throw new Error('windows helper is not running');

    const id = nextId++;
    if (nextId > Number.MAX_SAFE_INTEGER - 1) nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        consecutiveTimeouts += 1;
        reject(new Error(`windows helper timeout (${op})`));
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) restartHung();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, op });
      try {
        proc.stdin.write(`${JSON.stringify({ id, op, args: args ?? {} })}\n`);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`cannot write to windows helper: ${err.message}`));
      }
    });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    rejectAll(new Error('windows helper disposed'));
    const proc = child;
    if (!proc) return;
    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    killChild();
    // Bounded wait so shutdown never hangs on a stuck helper (unref: never keeps the event loop alive).
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, 2000);
      timer.unref();
    });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
  }

  return {
    call,
    dispose,
    /** PID of the running helper process (null when not running). */
    get pid() {
      return ready ? childPid : null;
    },
    get running() {
      return ready && child !== null;
    },
    /** Local monitor (/status): {running, pid, restarts, lastError}. Never starts the helper. */
    status() {
      const running = ready && child !== null;
      return { running, pid: running ? childPid : null, restarts: Math.max(0, starts - 1), lastError };
    },
  };
}
