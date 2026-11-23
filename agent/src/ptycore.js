// PTY session core: owns the ConPTY processes, their scrollback rings and session metadata.
//
// Used in two places:
//   * inside the long-lived PTY host process (ptyhost.js) — the normal setup, so terminals survive an
//     agent restart (PROTOCOL §4.1 "Durable sessions");
//   * in-process in the agent (tests, or when the host cannot be started) — same behaviour, but the
//     sessions die with the agent.
//
// The core is transport-agnostic: `handle(op, args)` runs one operation synchronously and returns its
// result (or throws); `subscribe(listener)` delivers events `{ev, sid, ...}`:
//   data {sid, d} · exit {sid, exitCode} · pid {sid, pid} · meta {session} · removed {sid} (pruned)

import path from 'node:path';

export const BUFFER_LIMIT_MIN = 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const RELEASE_DELAY_MS = 250;
/** ConPTY reports the shell's pid only once its output pipe is connected (asynchronously). */
const PID_WAIT_MS = 3000;
export const MAX_INPUT_CHARS = 1024 * 1024;
/**
 * Exited sessions stay listed (with their scrollback) until someone removes them — but the host outlives
 * agent restarts, so without a cap exited sessions nobody dismissed would pile up for days. Beyond this
 * many, the oldest exited ones are dropped (event `removed`).
 */
export const MAX_EXITED_DEFAULT = 32;

export const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Friendly default title for a shell executable. */
export function shellTitle(shell) {
  const base = path.basename(String(shell)).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  switch (base) {
    case 'powershell':
      return 'PowerShell';
    case 'pwsh':
      return 'PowerShell 7';
    case 'cmd':
      return 'Command Prompt';
    case 'bash':
      return 'Bash';
    case 'wsl':
      return 'WSL';
    default:
      return path.basename(String(shell)).replace(/\.(exe|cmd|bat)$/i, '') || 'Terminal';
  }
}

export function defaultArgs(shell) {
  const base = path.basename(String(shell)).toLowerCase();
  if (base === 'powershell.exe' || base === 'powershell' || base === 'pwsh.exe' || base === 'pwsh') return ['-NoLogo'];
  return [];
}

/** Scrollback ring: keeps the most recent `limit` UTF-8 bytes of output as a list of chunks. */
export class Scrollback {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.bytes = 0;
  }

  push(text) {
    if (!text) return;
    const n = Buffer.byteLength(text, 'utf8');
    this.chunks.push({ text, n });
    this.bytes += n;
    this.trim();
  }

  trim() {
    while (this.bytes > this.limit && this.chunks.length) {
      const first = this.chunks[0];
      const excess = this.bytes - this.limit;
      if (first.n <= excess) {
        this.chunks.shift();
        this.bytes -= first.n;
      } else {
        // Keep only the tail of the first chunk; drop a partial UTF-8 sequence at the cut.
        const buf = Buffer.from(first.text, 'utf8').subarray(excess);
        let text = buf.toString('utf8');
        while (text.charCodeAt(0) === 0xfffd) text = text.slice(1);
        const n = Buffer.byteLength(text, 'utf8');
        this.bytes -= first.n - n;
        if (text) this.chunks[0] = { text, n };
        else this.chunks.shift();
      }
    }
  }

  toString() {
    if (this.chunks.length > 1) {
      // Compact so repeated attaches do not re-join thousands of small chunks.
      const text = this.chunks.map((c) => c.text).join('');
      this.chunks = [{ text, n: this.bytes }];
    }
    return this.chunks.length ? this.chunks[0].text : '';
  }
}

/** Largest numeric part of session ids like "p12" (0 when none). */
export function maxSessionNumber(ids) {
  let max = 0;
  for (const id of ids) {
    const m = /^p(\d+)$/.exec(String(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * @param {object} opts
 * @param {Function} opts.spawn            pty spawn implementation (@lydell/node-pty `spawn` or a fake)
 * @param {number} [opts.scrollbackBytes]
 * @param {object} [opts.log]
 * @param {number} [opts.firstId]          first session number (default 1)
 * @param {number} [opts.maxExited]        exited sessions kept before the oldest are pruned
 */
export function createPtyCore({ spawn, scrollbackBytes = 262144, log, firstId = 1, maxExited = MAX_EXITED_DEFAULT }) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const limit = Math.max(BUFFER_LIMIT_MIN, Number(scrollbackBytes) || 262144);
  /** @type {Map<string, object>} */
  const sessions = new Map();
  const listeners = new Set();
  let nextId = Math.max(1, Math.floor(Number(firstId)) || 1);
  let disposed = false;

  const emit = (evt) => {
    for (const fn of [...listeners]) {
      try {
        fn(evt);
      } catch (err) {
        logger.warn(`pty core listener failed: ${err.message}`);
      }
    }
  };

  const meta = (s) => ({
    id: s.id,
    title: s.title,
    shell: s.shell,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    pid: s.pid,
    createdAt: s.createdAt,
    exited: s.exited,
    exitCode: s.exitCode,
    mirrorWindowId: s.mirrorWindowId,
  });

  function get(sid) {
    const s = sessions.get(String(sid));
    if (!s) throw new Error(`no such session: ${sid}`);
    return s;
  }

  function release(s) {
    if (s.released || !s.proc) return;
    s.released = true;
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
  }

  function refreshPid(s) {
    if (s.pid) return false;
    const pid = s.proc && s.proc.pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    s.pid = pid;
    emit({ ev: 'pid', sid: s.id, pid });
    return true;
  }

  function watchPid(s) {
    if (s.pid) return;
    const t0 = Date.now();
    const tick = () => {
      if (refreshPid(s) || s.exited || s.released || Date.now() - t0 >= PID_WAIT_MS) return;
      const t = setTimeout(tick, 10);
      t.unref?.();
    };
    tick();
  }

  function onExit(s, exitCode) {
    if (s.exited) return;
    s.exited = true;
    s.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    // ConPTY keeps its output pipe and worker thread alive after a natural exit until kill() is
    // called; release them shortly after (leaving time for the last output to drain).
    const t = setTimeout(() => release(s), RELEASE_DELAY_MS);
    t.unref?.();
    s.exitedAt = Date.now();
    logger.info(`pty ${s.id} exited (${s.exitCode})`);
    emit({ ev: 'exit', sid: s.id, exitCode: s.exitCode });
    pruneExited();
  }

  function pruneExited() {
    const cap = Math.max(0, Math.floor(Number(maxExited)));
    if (!Number.isFinite(cap)) return;
    const exited = [...sessions.values()].filter((x) => x.exited).sort((a, b) => a.exitedAt - b.exitedAt);
    for (let i = 0; i < exited.length - cap; i++) {
      const x = exited[i];
      sessions.delete(x.id);
      release(x);
      logger.info(`pty ${x.id} pruned (exited; more than ${cap} exited sessions)`);
      emit({ ev: 'removed', sid: x.id });
    }
  }

  const ops = {
    list() {
      return { sessions: [...sessions.values()].map(meta), nextId };
    },

    spawn(a = {}) {
      if (disposed) throw new Error('pty host is shutting down');
      const shell = typeof a.shell === 'string' && a.shell ? a.shell : 'powershell.exe';
      const args = Array.isArray(a.args) ? a.args.map(String) : typeof a.args === 'string' ? a.args : defaultArgs(shell);
      const cwd = String(a.cwd || process.cwd());
      const cols = clampInt(a.cols, 2, 1000, DEFAULT_COLS);
      const rows = clampInt(a.rows, 1, 500, DEFAULT_ROWS);
      const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 200) : shellTitle(shell);
      const baseEnv = a.env && typeof a.env === 'object' ? a.env : process.env;
      const env = { ...baseEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      let proc;
      try {
        proc = spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
      } catch (err) {
        throw new Error(`failed to start ${shell}: ${err.message}`);
      }
      const s = {
        id: `p${nextId++}`,
        title,
        shell,
        cwd,
        cols,
        rows,
        pid: Number.isInteger(proc.pid) && proc.pid > 0 ? proc.pid : null,
        createdAt: Date.now(),
        exited: false,
        exitCode: null,
        mirrorWindowId: typeof a.mirrorWindowId === 'string' && a.mirrorWindowId ? a.mirrorWindowId.slice(0, 200) : null,
        proc,
        scrollback: new Scrollback(limit),
        released: false,
      };
      sessions.set(s.id, s);
      proc.onData((d) => {
        if (typeof d !== 'string') d = String(d);
        refreshPid(s);
        s.scrollback.push(d);
        emit({ ev: 'data', sid: s.id, d });
      });
      proc.onExit(({ exitCode }) => onExit(s, exitCode));
      watchPid(s);
      logger.info(`pty ${s.id} started: ${shell}${s.pid ? ` (pid ${s.pid})` : ''} in ${cwd}`);
      return meta(s);
    },

    input(a) {
      const s = get(a.sid);
      if (typeof a.d !== 'string') throw new Error('d must be a string');
      if (a.d.length > MAX_INPUT_CHARS) throw new Error('input too large');
      if (s.exited || s.released) throw new Error('session has exited');
      s.proc.write(a.d);
      return true;
    },

    resize(a) {
      const s = get(a.sid);
      const c = clampInt(a.cols, 2, 1000, NaN);
      const r = clampInt(a.rows, 1, 500, NaN);
      if (!Number.isFinite(c) || !Number.isFinite(r)) throw new Error('cols and rows must be numbers');
      if (c === s.cols && r === s.rows) return true;
      s.cols = c;
      s.rows = r;
      if (!s.exited && !s.released) {
        try {
          s.proc.resize(c, r);
        } catch (err) {
          logger.debug(`pty ${s.id}: resize failed: ${err.message}`);
        }
      }
      emit({ ev: 'meta', sid: s.id, session: meta(s) });
      return true;
    },

    /** Kill the process (if running) and remove the session. An `exit` event follows if it was running. */
    kill(a) {
      const s = get(a.sid);
      sessions.delete(s.id);
      release(s);
      logger.info(`pty ${s.id} removed`);
      return true;
    },

    /** Scrollback snapshot. Every `data` event sent before this reply is part of `buffer`. */
    buffer(a) {
      const s = get(a.sid);
      return { session: meta(s), buffer: s.scrollback.toString() };
    },

    /** Change metadata: {sid, title?, mirrorWindowId? (string | null)}. */
    meta(a) {
      const s = get(a.sid);
      if (typeof a.title === 'string' && a.title.trim()) s.title = a.title.trim().slice(0, 200);
      if (a.mirrorWindowId === null || typeof a.mirrorWindowId === 'string') s.mirrorWindowId = a.mirrorWindowId ? a.mirrorWindowId.slice(0, 200) : null;
      emit({ ev: 'meta', sid: s.id, session: meta(s) });
      return true;
    },
  };

  return {
    /** Run one operation; returns its result or throws. */
    handle(op, args) {
      const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
      if (!fn) throw new Error(`unknown op: ${op}`);
      return fn(args && typeof args === 'object' ? args : {});
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get size() {
      return sessions.size;
    },
    get liveCount() {
      let n = 0;
      for (const s of sessions.values()) if (!s.exited) n++;
      return n;
    },
    dispose() {
      disposed = true;
      for (const s of sessions.values()) release(s);
      sessions.clear();
      listeners.clear();
    },
  };
}
