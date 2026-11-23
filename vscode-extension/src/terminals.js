'use strict';

/**
 * VS Code terminals (PROTOCOL §5.2 `terminals.*`) and shell-integration execution tracking.
 *
 *  - Every `vscode.Terminal` gets a stable string id (`tid`, "t1", "t2", …) for its lifetime.
 *  - Executions seen through shell integration are kept in a ring of the last 50 per terminal,
 *    each with its output (ANSI kept) capped to the last 64 KB, and streamed to the agent as
 *    `term.exec.start` / `term.exec.data` (batched ≤ 50 ms) / `term.exec.end`.
 *  - All execution output is also fed, in order, into a per-terminal raw ring for the live view
 *    (`terminals.attach` / `term.raw`, see live.js).
 *  - Shell-integration APIs are guarded with typeof checks so older / odd hosts degrade gracefully.
 */

const path = require('path');
const vscode = require('vscode');
const { errMsg, delay, debounce, requireString } = require('./util');
const { LiveTerminals, RING_CAP_DEFAULT } = require('./live');

const HISTORY_LIMIT = 50;
const OUTPUT_CAP = 64 * 1024; // characters of output kept per execution (tail)
const DATA_BATCH_MS = 50;
const DATA_FLUSH_CHARS = 256 * 1024; // flush early when a batch gets this large
const END_WAIT_FOR_STREAM_MS = 1500; // after "end", wait this long for the output stream to drain
const SHELL_INTEGRATION_WAIT_MS = 3000; // terminals.exec on a young terminal waits for shell integration
const YOUNG_TERMINAL_MS = 15000;
const PID_TIMEOUT_MS = 500;

class TerminalService {
  /**
   * @param {object} deps
   * @param {import('./connection').RpcConnection} deps.connection
   * @param {object} deps.log
   * @param {(p: string|undefined) => string|undefined} deps.resolveCwd  maps a cwd param to a local path
   * @param {() => number} [deps.ringCap]  live-view raw ring size per terminal, in characters
   * @param {import('./snapshot').TerminalSnapshots} [deps.snapshots]  screen snapshots (terminals.snapshot)
   */
  constructor({ connection, log, resolveCwd, ringCap, snapshots }) {
    this.connection = connection;
    this.log = log;
    this.resolveCwd = resolveCwd;
    /** @type {import('./mirror').MirrorManager|null} set by extension.js after construction */
    this.mirrors = null;

    this.tids = new Map(); // vscode.Terminal -> tid
    this.byTid = new Map(); // tid -> vscode.Terminal
    this.openedAt = new WeakMap(); // vscode.Terminal -> ms
    this.history = new Map(); // tid -> ExecRecord[]
    this.execs = new WeakMap(); // vscode.TerminalShellExecution -> ExecRecord
    this.nextTid = 1;
    this.nextExec = 1;
    this.disposables = [];

    this.emitChanged = debounce(() => this._emitChanged(), 100);
    this.live = new LiveTerminals({
      connection,
      log,
      getTerminal: (tid) => this._get(tid),
      ptyIdOf: (t) => {
        const pty = this.mirrors ? this.mirrors.ptyOf(t) : null;
        return pty ? pty.ptyId || 'pending' : null;
      },
      ringCap: ringCap || (() => RING_CAP_DEFAULT),
      snapshots,
    });
  }

  /** Subscribe to VS Code terminal events and register already-open terminals. */
  start() {
    const w = vscode.window;
    this.live.start();
    for (const t of w.terminals) this._register(t, 'existing');

    const on = (eventName, handler) => {
      if (typeof w[eventName] === 'function') {
        this.disposables.push(w[eventName](handler));
      }
    };
    on('onDidOpenTerminal', (t) => {
      this._register(t);
      this.emitChanged();
    });
    on('onDidCloseTerminal', (t) => {
      this._unregister(t);
      this.emitChanged();
    });
    on('onDidChangeActiveTerminal', () => this.emitChanged());
    on('onDidChangeTerminalState', () => this.emitChanged());
    on('onDidChangeTerminalShellIntegration', () => this.emitChanged());
    on('onDidStartTerminalShellExecution', (e) => {
      try {
        if (e && e.terminal && e.execution) this._trackExecution(e.terminal, e.execution);
      } catch (err) {
        this.log.warn(`exec start tracking failed: ${errMsg(err)}`);
      }
    });
    on('onDidEndTerminalShellExecution', (e) => {
      if (e && e.terminal && e.execution) {
        this._endExecution(e.terminal, e.execution, e.exitCode).catch((err) =>
          this.log.warn(`exec end tracking failed: ${errMsg(err)}`)
        );
      }
    });
    // Phones need a fresh list after every (re)connect.
    this.connection.on('connected', () => this.emitChanged());
  }

  // ---- tid registry ----------------------------------------------------------------------------

  /** @param {'opened'|'existing'|'created'} [origin] existing = open before start(); created = by terminals.create */
  _register(terminal, origin = 'opened') {
    if (this.tids.has(terminal)) return this.tids.get(terminal);
    const tid = `t${this.nextTid++}`;
    this.tids.set(terminal, tid);
    this.byTid.set(tid, terminal);
    this.openedAt.set(terminal, Date.now());
    if (this.mirrors) this.mirrors.adopt(terminal);
    this.live.track(tid, terminal, { preexisting: origin === 'existing', created: origin === 'created' });
    return tid;
  }

  _unregister(terminal) {
    const tid = this.tids.get(terminal);
    if (!tid) return;
    this.tids.delete(terminal);
    this.byTid.delete(tid);
    this.history.delete(tid);
    this.live.forget(tid);
  }

  /** tid of a terminal (assigned on first sight). */
  tidOf(terminal) {
    return this._register(terminal);
  }

  _get(tid) {
    requireString(tid, 'tid');
    const t = this.byTid.get(tid);
    if (!t) throw new Error(`unknown terminal: ${tid}`);
    return t;
  }

  // ---- terminals.list --------------------------------------------------------------------------

  async _describe(terminal) {
    const tid = this.tidOf(terminal);
    const mirror = this.mirrors ? this.mirrors.infoFor(terminal) : null;
    let pid = null;
    let cwd = null;
    if (mirror) {
      pid = mirror.pid;
      cwd = mirror.cwd;
    } else {
      try {
        const p = await Promise.race([Promise.resolve(terminal.processId), delay(PID_TIMEOUT_MS, undefined)]);
        pid = Number.isInteger(p) ? p : null;
      } catch {
        pid = null;
      }
      const si = terminal.shellIntegration;
      if (si && si.cwd) cwd = uriToPath(si.cwd);
    }
    return {
      tid,
      name: terminal.name,
      pid,
      hasShellIntegration: !!terminal.shellIntegration,
      isMirror: !!mirror,
      ptyId: mirror ? mirror.ptyId : null,
      cwd,
      active: vscode.window.activeTerminal === terminal,
    };
  }

  async list() {
    return Promise.all(vscode.window.terminals.map((t) => this._describe(t)));
  }

  async _emitChanged() {
    if (!this.connection.connected) return;
    try {
      const terminals = await this.list();
      this.connection.notify('terminals.changed', { terminals });
    } catch (err) {
      this.log.warn(`terminals.changed failed: ${errMsg(err)}`);
    }
  }

  // ---- methods ---------------------------------------------------------------------------------

  methods() {
    return {
      'terminals.list': () => this.list(),
      'terminals.create': (p) => this.create(p),
      'terminals.sendText': (p) => {
        const t = this._get(p.tid);
        if (typeof p.text !== 'string') throw new Error('missing or invalid parameter: text');
        t.sendText(p.text, p.addNewLine !== false);
        return true;
      },
      'terminals.exec': (p) => this.exec(p),
      'terminals.history': (p) => {
        this._get(p.tid);
        return (this.history.get(p.tid) || []).map(publicRecord);
      },
      'terminals.show': (p) => {
        this._get(p.tid).show(false);
        return true;
      },
      'terminals.dispose': (p) => {
        this._get(p.tid).dispose();
        return true;
      },
      ...this.live.methods(),
    };
  }

  async create(p) {
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined;
    const cwd = this.resolveCwd(typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined);
    if (p.mirror !== false) {
      if (!this.mirrors) throw new Error('mirrored terminals unavailable');
      return this.mirrors.createMirroredViaAgent({ name, cwd });
    }
    const terminal = vscode.window.createTerminal({ name, cwd });
    const tid = this._register(terminal, 'created');
    this.emitChanged();
    return { tid };
  }

  async exec(p) {
    const terminal = this._get(p.tid);
    const command = requireString(p.command, 'command');

    let si = terminal.shellIntegration;
    if (!si && Date.now() - (this.openedAt.get(terminal) || 0) < YOUNG_TERMINAL_MS && !(this.mirrors && this.mirrors.ptyOf(terminal))) {
      si = await waitForShellIntegration(terminal, SHELL_INTEGRATION_WAIT_MS);
    }
    if (si && typeof si.executeCommand === 'function') {
      const execution = si.executeCommand(command);
      const rec = this._trackExecution(terminal, execution, command);
      return { execId: rec.execId };
    }
    terminal.sendText(command, true);
    return { execId: null };
  }

  // ---- execution tracking ----------------------------------------------------------------------

  /**
   * Get or create the record for an execution; emits term.exec.start and starts reading on creation.
   * `late`: first seen at its end (it started before we were watching).
   */
  _trackExecution(terminal, execution, fallbackCommand, late = false) {
    let rec = this.execs.get(execution);
    if (rec) return rec;
    const tid = this.tidOf(terminal);
    rec = {
      execId: `x${this.nextExec++}`,
      tid,
      commandLine: commandLineOf(execution) || fallbackCommand || '',
      cwd: execution && execution.cwd ? uriToPath(execution.cwd) : null,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      output: '',
      pending: '',
      flushTimer: null,
      ended: false,
      readDone: Promise.resolve(),
    };
    this.execs.set(execution, rec);
    let ring = this.history.get(tid);
    if (!ring) this.history.set(tid, (ring = []));
    ring.push(rec);
    if (ring.length > HISTORY_LIMIT) ring.splice(0, ring.length - HISTORY_LIMIT);

    this.connection.notify('term.exec.start', { tid, execId: rec.execId, commandLine: rec.commandLine, cwd: rec.cwd });

    // read() must be called right away (synchronously, from the start event): VS Code only delivers
    // data that arrives after the first read() call. `_pump` calls it before its first await.
    if (execution && typeof execution.read === 'function') {
      this.live.executionStarted(tid, late ? '' : rec.commandLine);
      rec.readDone = this._pump(rec, execution);
    }
    return rec;
  }

  async _pump(rec, execution) {
    try {
      const stream = execution.read();
      for await (const chunk of stream) {
        if (typeof chunk !== 'string' || !chunk) continue;
        this._append(rec, chunk);
      }
    } catch (err) {
      this.log.debug && this.log.debug(`exec ${rec.execId} read failed: ${errMsg(err)}`);
    }
  }

  _append(rec, chunk) {
    this.live.feed(rec.tid, chunk);
    rec.output += chunk;
    if (rec.output.length > OUTPUT_CAP) rec.output = rec.output.slice(rec.output.length - OUTPUT_CAP);
    rec.pending += chunk;
    if (rec.pending.length >= DATA_FLUSH_CHARS) {
      this._flush(rec);
    } else if (!rec.flushTimer) {
      rec.flushTimer = setTimeout(() => this._flush(rec), DATA_BATCH_MS);
    }
  }

  _flush(rec) {
    if (rec.flushTimer) clearTimeout(rec.flushTimer);
    rec.flushTimer = null;
    if (!rec.pending) return;
    const d = rec.pending;
    rec.pending = '';
    this.connection.notify('term.exec.data', { tid: rec.tid, execId: rec.execId, d });
  }

  async _endExecution(terminal, execution, exitCode) {
    const rec = this._trackExecution(terminal, execution, undefined, true);
    if (rec.ended) return;
    rec.ended = true;
    this.live.executionEnded(rec.tid);
    rec.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    rec.endedAt = Date.now();
    const cl = commandLineOf(execution);
    if (cl) rec.commandLine = cl; // confidence is usually higher at the end
    // Let the output stream drain so `end` comes after the last `data`.
    await Promise.race([rec.readDone, delay(END_WAIT_FOR_STREAM_MS)]);
    this._flush(rec);
    this.connection.notify('term.exec.end', { tid: rec.tid, execId: rec.execId, exitCode: rec.exitCode });
  }

  dispose() {
    this.emitChanged.cancel();
    this.live.dispose();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables = [];
  }
}

// ---- helpers -----------------------------------------------------------------------------------

function publicRecord(rec) {
  return {
    execId: rec.execId,
    commandLine: rec.commandLine,
    cwd: rec.cwd,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    exitCode: rec.exitCode,
    output: rec.output,
  };
}

function commandLineOf(execution) {
  if (!execution) return '';
  const cl = execution.commandLine;
  if (typeof cl === 'string') return cl;
  if (cl && typeof cl.value === 'string') return cl.value;
  return '';
}

function uriToPath(uri) {
  if (!uri) return null;
  if (typeof uri === 'string') return uri;
  if (uri.scheme === 'file') return path.normalize(uri.fsPath);
  return typeof uri.toString === 'function' ? uri.toString() : null;
}

/** Resolve with the terminal's shellIntegration once it appears, or undefined after `ms`. */
function waitForShellIntegration(terminal, ms) {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  if (typeof vscode.window.onDidChangeTerminalShellIntegration !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let sub = null;
    const timer = setTimeout(() => {
      if (sub) sub.dispose();
      resolve(terminal.shellIntegration);
    }, ms);
    sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e && e.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration || terminal.shellIntegration);
      }
    });
  });
}

module.exports = { TerminalService, HISTORY_LIMIT, OUTPUT_CAP };
