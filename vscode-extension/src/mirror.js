'use strict';

/**
 * Mirrored terminals (PROTOCOL §5.3): the PTY lives in the agent, VS Code shows it through a
 * `vscode.Pseudoterminal`, and the phone attaches to the same PTY.
 *
 * Two ways a mirror comes to life:
 *  1. The agent sends `mirror.open {session, buffer}` (a phone called `pty.create` with our windowId, or
 *     we asked for `pty.create` via `terminals.create`) → we create a terminal around a bound MirrorPty.
 *  2. The user opens a "TermPocket (mirrored)" terminal (profile / command) → a *lazy* MirrorPty is
 *     created by VS Code and on `open(dims)` it requests `pty.create`. The agent answers with the Session
 *     FIRST and only then sends `mirror.open` for it (§5.3), so the lazy pty is bound by session id from
 *     the response and the later `mirror.open` finds it — never by guessing: a `mirror.open` that arrives
 *     while our request is still pending belongs to someone else (a phone's pty.create, terminals.create).
 *
 * Wire events: in  `mirror.data {ptyId,d}`, `mirror.exit {ptyId,exitCode}`
 *              out `mirror.input {ptyId,d}`, `mirror.resize {ptyId,cols,rows}`, `mirror.closed {ptyId}`
 *
 * Agent restarts (§5.3): the PTYs live in the agent's durable PTY host and survive the agent. When the
 * connection drops, mirrors are NOT ended: they show a dim "[TermPocket: reconnecting…]" line and ignore
 * input; after the next hello the extension sends `mirror.rebind {ptyIds}` and replays each PTY's
 * buffer (reset + buffer), so the VS Code terminal shows exactly what the PTY shows. A PTY that is gone
 * shows "[process ended]". Against an agent without `mirror.rebind` the old behaviour applies
 * ("[TermPocket agent disconnected]", terminal dead).
 */

const vscode = require('vscode');
const { errMsg } = require('./util');

const DISCONNECTED_MSG = '\r\n[TermPocket agent disconnected]\r\n';
const RECONNECTING_MSG = '\r\n\x1b[2m[TermPocket: reconnecting\u2026]\x1b[22m\r\n';
const ENDED_MSG = '\r\n[process ended]\r\n';
/** Full reset (RIS) + clear scrollback, used before replaying a re-bound PTY's buffer. */
const RESET_ALL = '\x1bc\x1b[3J';
/** How long mirror.rebind may take before the mirrors fall back to "reconnecting" (retried next connect). */
const REBIND_TIMEOUT_MS = 20000;
const exitMsg = (code) => `\r\n[process exited with code ${code === null || code === undefined ? '?' : code}]\r\n`;
/** Clear screen + scrollback, used before replaying a buffer into a revived terminal. */
const CLEAR_ALL = '\x1b[2J\x1b[3J\x1b[H';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** How long a lazily created pty waits for the agent connection before giving up. */
const LAZY_CONNECT_WAIT_MS = 15000;
/** How long we hold PTY output for a bound pty while waiting for its `mirror.open` (which carries the buffer). */
const OPEN_WAIT_MS = 3000;
/** Max input chunks queued while a lazy pty is still being created. */
const MAX_QUEUED_INPUT = 1000;
/** Delay before telling the agent a mirror was closed (lets VS Code report whether it is shutting down). */
const CLOSE_DECIDE_MS = 150;
/** How long we remember a session whose terminal the user closed while it was being created. */
const ABANDONED_TTL_MS = 30000;

let ptySeq = 0;

/**
 * One VS Code side of a mirrored terminal.
 * state: 'pending' (lazy, no PTY yet) | 'alive' | 'exited' | 'reconnecting' (agent connection down, the PTY
 * presumably still running) | 'rebinding' (mirror.rebind in flight) | 'dead' (PTY gone / failed) |
 * 'closed' (terminal closed)
 */
class MirrorPty {
  constructor(manager, { lazy, name, cwd, title }) {
    this.seq = ++ptySeq;
    this.manager = manager;
    this.lazy = !!lazy;
    this.name = name;
    this.cwd = cwd; // requested cwd for lazy creation
    this.title = title; // requested session title for lazy creation
    this.ptyId = null;
    this.session = null;
    this.state = 'pending';
    this.terminal = null;

    this.opened = false; // VS Code called open()
    this.preOpenWrites = []; // writes before open() (VS Code would drop them)
    this.awaitingOpen = false; // bound via pty.create response, `mirror.open` (with buffer) not yet received
    this.held = []; // PTY output held while awaitingOpen
    this.openTimer = null;
    this.inputQueue = []; // input typed while pending
    this.closedEarly = false; // terminal closed while pending
    this.dims = null; // last dimensions VS Code reported
    this.lastSentSize = null; // "cols x rows" last forwarded to the agent
    this.rebindHeld = []; // PTY output that arrived while mirror.rebind was in flight

    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this._writeEmitter.event;
    this.onDidClose = this._closeEmitter.event;
  }

  /** Write to the VS Code terminal (buffered until VS Code has opened the pty). */
  write(data) {
    if (!data || this.state === 'closed') return;
    if (this.opened) this._writeEmitter.fire(data);
    else this.preOpenWrites.push(data);
  }

  // ---- vscode.Pseudoterminal ------------------------------------------------------------------

  open(initialDimensions) {
    this.opened = true;
    const queued = this.preOpenWrites;
    this.preOpenWrites = [];
    for (const d of queued) this._writeEmitter.fire(d);
    if (initialDimensions) this.dims = { columns: initialDimensions.columns, rows: initialDimensions.rows };
    if (this.lazy && this.state === 'pending') {
      this.manager._startLazy(this);
    } else {
      this.manager._sendResize(this);
    }
  }

  close() {
    this.manager._onPtyClosed(this);
  }

  handleInput(data) {
    if (this.state === 'alive') {
      this.manager._sendInput(this, data);
    } else if (this.state === 'pending' && this.inputQueue.length < MAX_QUEUED_INPUT) {
      this.inputQueue.push(data);
    }
    // exited / dead / closed: input ignored (PROTOCOL §5.3)
  }

  setDimensions(dimensions) {
    if (!dimensions) return;
    this.dims = { columns: dimensions.columns, rows: dimensions.rows };
    this.manager._sendResize(this);
  }

  dispose() {
    clearTimeout(this.openTimer);
    this._writeEmitter.dispose();
    this._closeEmitter.dispose();
  }
}

class MirrorManager {
  /**
   * @param {object} deps
   * @param {import('./connection').RpcConnection} deps.connection
   * @param {(terminal: vscode.Terminal) => string} deps.tidOf     tid registry lookup (assigns if missing)
   * @param {() => string|undefined} deps.defaultCwd               local cwd for new PTYs
   * @param {() => string} deps.defaultTitle                        session title for new PTYs
   * @param {() => void} [deps.onChange]                            mirrors changed (→ terminals.changed)
   * @param {object} deps.log
   */
  constructor({ connection, tidOf, defaultCwd, defaultTitle, onChange, log }) {
    this.connection = connection;
    this.tidOf = tidOf;
    this.defaultCwd = defaultCwd;
    this.defaultTitle = defaultTitle;
    this.onChange = onChange || (() => {});
    this.log = log;

    this.byPty = new Map(); // ptyId -> MirrorPty
    this.byTerminal = new WeakMap(); // vscode.Terminal -> MirrorPty
    this.pendingLazy = new Set(); // lazy ptys whose pty.create is in flight (insertion ordered)
    this.openWaiters = new Map(); // ptyId -> Array<() => void>
    this.all = new Set(); // every live MirrorPty (for disposal)
    this.closeTimers = new Set(); // deferred mirror.closed decisions (see _sendClosedUnlessShutdown)
    this.abandoned = new Map(); // ptyId -> timer: closed while pty.create was in flight; its mirror.open must not revive it
    this.closedOffline = new Set(); // ptyIds whose terminal the user closed while the agent was unreachable
    this.disposed = false;

    this._subs = [
      connection.onEvent('mirror.data', (p) => this._onData(p)),
      connection.onEvent('mirror.exit', (p) => this._onExit(p)),
    ];
    this._onDisconnected = () => this._handleDisconnect();
    connection.on('disconnected', this._onDisconnected);
    this._onConnected = () => {
      this._rebindAll().catch((err) => this.log.warn(`mirror.rebind failed: ${errMsg(err)}`));
    };
    connection.on('connected', this._onConnected);
  }

  /** Request handlers this module serves. */
  methods() {
    return { 'mirror.open': (p) => this.handleMirrorOpen(p) };
  }

  // ---- terminal bookkeeping ------------------------------------------------------------------

  /** Called for every terminal that opens: links profile-created terminals to their MirrorPty. */
  adopt(terminal) {
    const pty = this.ptyOf(terminal);
    if (pty && !pty.terminal) pty.terminal = terminal;
    return pty;
  }

  /** The MirrorPty behind a terminal, or null. */
  ptyOf(terminal) {
    if (!terminal) return null;
    let pty = this.byTerminal.get(terminal);
    if (pty) return pty;
    const opts = terminal.creationOptions;
    if (opts && opts.pty instanceof MirrorPty) {
      pty = opts.pty;
      this.byTerminal.set(terminal, pty);
      if (!pty.terminal) pty.terminal = terminal;
      return pty;
    }
    return null;
  }

  /** Info used by terminals.list. */
  infoFor(terminal) {
    const pty = this.ptyOf(terminal);
    if (!pty) return null;
    return {
      ptyId: pty.ptyId,
      pid: pty.session && Number.isInteger(pty.session.pid) ? pty.session.pid : null,
      cwd: pty.session && typeof pty.session.cwd === 'string' ? pty.session.cwd : pty.cwd || null,
      state: pty.state,
    };
  }

  _terminalFor(pty) {
    if (pty.terminal) return pty.terminal;
    for (const t of vscode.window.terminals) {
      if (this.ptyOf(t) === pty) return t;
    }
    return null;
  }

  _tidFor(pty) {
    const t = this._terminalFor(pty);
    return t ? this.tidOf(t) : null;
  }

  // ---- creation ------------------------------------------------------------------------------

  _newPty(opts) {
    const pty = new MirrorPty(this, opts);
    this.all.add(pty);
    return pty;
  }

  /** A lazy pty for the terminal profile provider / command. */
  createLazyPty(name) {
    return this._newPty({
      lazy: true,
      name: name || 'TermPocket',
      cwd: this.defaultCwd(),
      title: this.defaultTitle(),
    });
  }

  /** `vscode.TerminalProfile` for `registerTerminalProfileProvider`. */
  provideProfile() {
    const pty = this.createLazyPty('TermPocket');
    return new vscode.TerminalProfile({ name: pty.name, pty, iconPath: new vscode.ThemeIcon('remote') });
  }

  /** Command `termpocket.newMirroredTerminal`. */
  createLazyTerminal(name) {
    const pty = this.createLazyPty(name);
    const terminal = vscode.window.createTerminal({ name: pty.name, pty, iconPath: new vscode.ThemeIcon('remote') });
    pty.terminal = terminal;
    this.byTerminal.set(terminal, pty);
    terminal.show();
    return terminal;
  }

  /** Create the VS Code terminal for a session the agent already owns. */
  _createTerminalForSession(session, buffer) {
    const pty = this._newPty({ lazy: false, name: session.title || 'TermPocket' });
    this._bind(pty, session);
    pty.write(buffer || '');
    if (session.exited) {
      pty.state = 'exited';
      pty.write(exitMsg(session.exitCode));
    }
    const terminal = vscode.window.createTerminal({
      name: session.title || 'TermPocket',
      pty,
      iconPath: new vscode.ThemeIcon('remote'),
    });
    pty.terminal = terminal;
    this.byTerminal.set(terminal, pty);
    return pty;
  }

  /**
   * `terminals.create` with mirror: ask the agent for a PTY, wait for its `mirror.open`, return ids.
   */
  async createMirroredViaAgent({ name, cwd }) {
    if (!this.connection.connected) throw new Error('TermPocket agent not connected');
    const connectedAt = this.connection.info && this.connection.info.connectedAt;
    const params = { title: name || this.defaultTitle(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const effectiveCwd = cwd || this.defaultCwd();
    if (effectiveCwd) params.cwd = effectiveCwd;
    const session = await this.connection.request('pty.create', params);
    if (!session || typeof session.id !== 'string') throw new Error('agent returned an invalid session');

    let pty = this.byPty.get(session.id);
    if (!pty) {
      await this._waitForOpen(session.id, 10000);
      pty = this.byPty.get(session.id);
    }
    if (!pty) {
      // The connection dropped meanwhile: the agent unmirrored the session, so a terminal made now
      // would look alive but swallow input forever. (This response cannot be delivered anyway.)
      const sameConnection = this.connection.connected && (!this.connection.info || this.connection.info.connectedAt === connectedAt);
      if (!sameConnection) throw new Error('TermPocket agent disconnected before the mirrored terminal opened');
      // The agent never sent mirror.open: show the PTY anyway (output from now on).
      this.log.warn(`no mirror.open received for ${session.id}; creating the terminal without scrollback`);
      pty = this._createTerminalForSession(session, '');
      this.onChange();
    }
    return { tid: this._tidFor(pty), ptyId: session.id };
  }

  _waitForOpen(ptyId, timeoutMs) {
    return new Promise((resolve) => {
      let list = this.openWaiters.get(ptyId);
      if (!list) this.openWaiters.set(ptyId, (list = []));
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      list.push(done);
    });
  }

  _resolveOpenWaiters(ptyId) {
    const list = this.openWaiters.get(ptyId);
    if (!list) return;
    this.openWaiters.delete(ptyId);
    for (const fn of list) fn();
  }

  /** Lazy pty was opened by VS Code: request a PTY from the agent. */
  async _startLazy(pty) {
    if (!this.connection.connected) {
      pty.write('[TermPocket] waiting for the agent connection...\r\n');
      const ok = await this.connection.waitForConnected(LAZY_CONNECT_WAIT_MS);
      if (pty.state !== 'pending') return; // closed meanwhile
      if (!ok) {
        pty.state = 'dead';
        pty.write('\r\n[TermPocket agent not connected: start the agent, then open a new mirrored terminal]\r\n');
        this.onChange();
        return;
      }
    }
    if (pty.closedEarly) {
      pty.state = 'closed';
      return;
    }

    const cols = (pty.dims && pty.dims.columns) || DEFAULT_COLS;
    const rows = (pty.dims && pty.dims.rows) || DEFAULT_ROWS;
    const params = { title: pty.title, cols, rows };
    if (pty.cwd) params.cwd = pty.cwd;
    this.pendingLazy.add(pty);
    try {
      const session = await this.connection.request('pty.create', params);
      this.pendingLazy.delete(pty);
      if (!session || typeof session.id !== 'string') throw new Error('agent returned an invalid session');
      if (pty.ptyId) return; // already bound by an earlier mirror.open
      const other = this.byPty.get(session.id);
      if (other && other !== pty) {
        // Extremely unlikely race: the session was attached to another terminal.
        pty.state = 'dead';
        pty.write(`\r\n[TermPocket: session ${session.id} is shown in another terminal]\r\n`);
        return;
      }
      this._bind(pty, session);
      if (pty.state === 'alive') {
        // Wait (briefly) for mirror.open, which carries the scrollback for this session.
        pty.awaitingOpen = true;
        pty.openTimer = setTimeout(() => this._finishAwaitingOpen(pty, null), OPEN_WAIT_MS);
      }
      this.onChange();
    } catch (err) {
      this.pendingLazy.delete(pty);
      if (pty.ptyId) return;
      if (pty.closedEarly || pty.state === 'closed') {
        this._forget(pty);
        return;
      }
      pty.state = 'dead';
      pty.write(`\r\n[TermPocket: could not start terminal: ${errMsg(err)}]\r\n`);
      this.onChange();
    }
  }

  /** Attach a pty to an agent session. */
  _bind(pty, session) {
    pty.ptyId = session.id;
    pty.session = session;
    pty.state = session.exited ? 'exited' : 'alive';
    pty.lastSentSize = Number.isInteger(session.cols) && Number.isInteger(session.rows) ? `${session.cols}x${session.rows}` : null;
    this.byPty.set(session.id, pty);
    this.pendingLazy.delete(pty);

    if (pty.closedEarly) {
      // The user closed the terminal while it was being created. The agent's mirror.open for this
      // session is already on the wire: remember the id so it does not resurrect a ghost terminal.
      this._abandon(session.id);
      this.connection.notify('mirror.closed', { ptyId: pty.ptyId });
      this._forget(pty);
      return;
    }
    const queued = pty.inputQueue;
    pty.inputQueue = [];
    if (pty.state === 'alive') {
      for (const d of queued) this._sendInput(pty, d);
      this._sendResize(pty);
    }
  }

  _abandon(ptyId) {
    clearTimeout(this.abandoned.get(ptyId));
    const timer = setTimeout(() => this.abandoned.delete(ptyId), ABANDONED_TTL_MS);
    if (timer.unref) timer.unref();
    this.abandoned.set(ptyId, timer);
  }

  _finishAwaitingOpen(pty, buffer) {
    if (!pty.awaitingOpen) return;
    clearTimeout(pty.openTimer);
    pty.awaitingOpen = false;
    const held = pty.held;
    pty.held = [];
    if (typeof buffer === 'string') {
      // The buffer is a snapshot that already includes everything held so far.
      pty.write(buffer);
    } else {
      for (const d of held) pty.write(d);
    }
  }

  // ---- agent → extension ---------------------------------------------------------------------

  /** Request `mirror.open {session, buffer}` → `{tid}`. */
  handleMirrorOpen(p) {
    const session = p && p.session;
    if (!session || typeof session.id !== 'string') throw new Error('missing or invalid parameter: session');
    if (this.pendingLazy.size > 0 && !this.byPty.has(session.id) && !this.abandoned.has(session.id)) {
      // The agent sends a lazy terminal's pty.create response BEFORE its mirror.open (§5.3), but when both
      // arrive in one TCP chunk the WebSocket emits them back to back, before the response's await
      // continuation in _startLazy() has bound (or abandoned) the pty. Let it run first, or this session
      // would get a second terminal while the lazy one waits for a mirror.open that never comes.
      return new Promise((resolve) => setImmediate(resolve)).then(() => this._openMirror(p));
    }
    return this._openMirror(p);
  }

  _openMirror(p) {
    const session = p.session;
    const buffer = typeof p.buffer === 'string' ? p.buffer : '';
    let pty = this.byPty.get(session.id);

    if (this.abandoned.has(session.id)) {
      // Its terminal was closed while being created (mirror.closed already sent): no ghost terminal.
      clearTimeout(this.abandoned.get(session.id));
      this.abandoned.delete(session.id);
      this._resolveOpenWaiters(session.id);
      return { tid: null };
    }

    if (pty && pty.state === 'closed') {
      this._forget(pty);
      pty = null;
    }

    // Lazy ptys are bound only by the session id in their own pty.create response (which the agent
    // sends before mirror.open, §5.3). An unknown session here is someone else's → its own terminal.
    if (pty) {
      pty.session = Object.assign({}, pty.session, session);
      if (pty.awaitingOpen) {
        this._finishAwaitingOpen(pty, buffer);
        if (session.exited) {
          pty.state = 'exited';
          pty.write(exitMsg(session.exitCode));
        }
      } else if (pty.state === 'dead' || pty.state === 'reconnecting' || pty.state === 'rebinding') {
        // Agent re-opened a mirror after a reconnect: revive with a fresh replay of the scrollback.
        pty.rebindHeld = [];
        pty.write(CLEAR_ALL + buffer);
        pty.state = session.exited ? 'exited' : 'alive';
        if (session.exited) pty.write(exitMsg(session.exitCode));
        pty.lastSentSize = null;
        this._sendResize(pty);
      }
      // else: duplicate mirror.open for a live mirror → nothing to replay.
    } else {
      pty = this._createTerminalForSession(session, buffer);
    }

    this._resolveOpenWaiters(session.id);
    this.onChange();
    return { tid: this._tidFor(pty) };
  }

  _onData(p) {
    const pty = p && typeof p.ptyId === 'string' ? this.byPty.get(p.ptyId) : null;
    if (!pty || typeof p.d !== 'string') return;
    if (pty.awaitingOpen) {
      pty.held.push(p.d);
    } else if (pty.state === 'rebinding') {
      pty.rebindHeld.push(p.d); // sent after the PTY's buffer snapshot: appended once the rebind answers
    } else if (pty.state === 'alive') {
      pty.write(p.d);
    }
  }

  _onExit(p) {
    const pty = p && typeof p.ptyId === 'string' ? this.byPty.get(p.ptyId) : null;
    if (!pty || pty.state === 'closed') return;
    if (pty.awaitingOpen) this._finishAwaitingOpen(pty, null);
    pty.state = 'exited';
    if (pty.session) {
      pty.session.exited = true;
      pty.session.exitCode = p.exitCode === undefined ? null : p.exitCode;
    }
    pty.write(exitMsg(p.exitCode));
    this.onChange();
  }

  _handleDisconnect() {
    let changed = false;
    for (const pty of this.byPty.values()) {
      if (pty.state === 'alive' || pty.state === 'rebinding' || pty.awaitingOpen) {
        // The PTY keeps running in the agent's PTY host: wait for the next connection (input ignored meanwhile).
        if (pty.awaitingOpen) this._finishAwaitingOpen(pty, null);
        if (pty.state !== 'rebinding') pty.write(RECONNECTING_MSG);
        pty.rebindHeld = [];
        pty.state = 'reconnecting';
        changed = true;
      }
      // 'exited' stays exited; it is re-bound too, so closing it later still removes the session.
    }
    if (changed) this.onChange();
  }

  /**
   * After (re)connecting: re-bind every mirror terminal to its PTY (`mirror.rebind`, PROTOCOL §5.3) and
   * replay what the PTY shows. The hello that preceded this registered our windowId with the agent,
   * even when it is a new agent process.
   */
  async _rebindAll() {
    if (this.disposed || !this.connection.connected) return;
    const ptys = [...this.byPty.values()].filter((p) => p.ptyId && (p.state === 'reconnecting' || p.state === 'exited'));
    const closed = [...this.closedOffline];
    this.closedOffline.clear();
    if (!ptys.length && !closed.length) return;
    const connectedAt = this.connection.info && this.connection.info.connectedAt;
    for (const p of ptys) {
      if (p.state === 'reconnecting') {
        p.state = 'rebinding';
        p.rebindHeld = [];
      }
    }
    let result;
    try {
      result = await this.connection.request('mirror.rebind', { ptyIds: ptys.map((p) => p.ptyId).concat(closed) }, { timeoutMs: REBIND_TIMEOUT_MS });
    } catch (err) {
      const msg = errMsg(err);
      const oldAgent = /unknown method/i.test(msg);
      const sameConnection = this.connection.connected && this.connection.info && this.connection.info.connectedAt === connectedAt;
      for (const p of ptys) {
        if (p.state !== 'rebinding') continue;
        p.rebindHeld = [];
        if (oldAgent) {
          // Older agent: its PTYs did not survive the restart, and it cannot re-bind them.
          p.state = 'dead';
          p.write(DISCONNECTED_MSG);
        } else {
          p.state = 'reconnecting'; // retried on the next connection
        }
      }
      if (oldAgent) this.log.info('the agent has no mirror.rebind (older agent): mirrored terminals ended');
      else if (sameConnection) this.log.warn(`mirror.rebind failed: ${msg}`);
      this.onChange();
      return;
    }
    const byId = new Map();
    for (const r of result && Array.isArray(result.sessions) ? result.sessions : []) {
      if (r && typeof r.ptyId === 'string') byId.set(r.ptyId, r);
    }
    let bound = 0;
    for (const p of ptys) {
      if (p.state === 'closed' || this.byPty.get(p.ptyId) !== p) continue;
      const r = byId.get(p.ptyId);
      const wasExited = p.state === 'exited';
      const held = p.rebindHeld;
      p.rebindHeld = [];
      if (r && r.ok && r.session) {
        bound++;
        p.session = Object.assign({}, p.session, r.session);
        if (wasExited) continue; // already shows its final output and exit line
        p.write(RESET_ALL + (typeof r.buffer === 'string' ? r.buffer : '') + held.join(''));
        if (r.session.exited) {
          p.state = 'exited';
          p.write(exitMsg(r.session.exitCode));
        } else {
          p.state = 'alive';
          p.lastSentSize = null;
          this._sendResize(p);
        }
      } else if (!wasExited) {
        p.state = 'dead';
        p.write(r && r.gone === false && r.e ? `\r\n[TermPocket: ${r.e}]\r\n` : ENDED_MSG);
      }
    }
    // Terminals the user closed while we were offline: now that they are ours again, end their PTYs.
    for (const id of closed) if (byId.get(id) && byId.get(id).ok) this.connection.notify('mirror.closed', { ptyId: id });
    if (ptys.length) this.log.info(`re-bound ${bound}/${ptys.length} mirrored terminal(s) after reconnecting`);
    this.onChange();
  }

  // ---- extension → agent ---------------------------------------------------------------------

  _sendInput(pty, data) {
    if (pty.ptyId && typeof data === 'string' && data.length) {
      this.connection.notify('mirror.input', { ptyId: pty.ptyId, d: data });
    }
  }

  _sendResize(pty) {
    if (pty.state !== 'alive' || !pty.ptyId || !pty.dims) return;
    const cols = Math.max(1, pty.dims.columns | 0);
    const rows = Math.max(1, pty.dims.rows | 0);
    const key = `${cols}x${rows}`;
    if (key === pty.lastSentSize) return;
    if (this.connection.notify('mirror.resize', { ptyId: pty.ptyId, cols, rows })) {
      pty.lastSentSize = key;
      if (pty.session) {
        pty.session.cols = cols;
        pty.session.rows = rows;
      }
    }
  }

  /** VS Code closed the terminal (user closed it, or terminals.dispose). */
  _onPtyClosed(pty) {
    if (pty.state === 'closed') return;
    if (pty.state === 'pending' && !pty.ptyId) {
      pty.inputQueue = [];
      if (this.pendingLazy.has(pty)) {
        // pty.create is in flight: _bind() tells the agent to kill the PTY once its id is known.
        pty.closedEarly = true;
      } else {
        this._forget(pty);
      }
      return;
    }
    if (pty.ptyId) this._sendClosedUnlessShutdown(pty.ptyId, this._terminalFor(pty));
    this._forget(pty);
    this.onChange();
  }

  /**
   * `mirror.closed` makes the agent kill the PTY, which is right when the USER closes the terminal
   * (§5.3) but not when VS Code itself shuts down or reloads the window: then the agent should keep
   * the PTY running unmirrored, exactly as for a dropped connection, so the phone keeps it. VS Code
   * calls Pseudoterminal.close() in both cases; the reason (`terminal.exitStatus.reason`) is known only
   * shortly afterwards, so the decision is deferred a little. If the extension host goes away first,
   * nothing is sent and the agent sees a disconnect (PTY kept).
   */
  _sendClosedUnlessShutdown(ptyId, terminal) {
    const timer = setTimeout(() => {
      this.closeTimers.delete(timer);
      if (this.disposed) return;
      const reason = terminal && terminal.exitStatus ? terminal.exitStatus.reason : undefined;
      const R = vscode.TerminalExitReason;
      if (R && reason === R.Shutdown) {
        this.log.info(`mirrored terminal for ${ptyId} closed by window shutdown; PTY kept running in the agent`);
        return;
      }
      if (!this.connection.notify('mirror.closed', { ptyId })) this.closedOffline.add(ptyId); // sent after the next rebind
    }, CLOSE_DECIDE_MS);
    this.closeTimers.add(timer);
  }

  _forget(pty) {
    pty.state = 'closed';
    clearTimeout(pty.openTimer);
    if (pty.ptyId && this.byPty.get(pty.ptyId) === pty) this.byPty.delete(pty.ptyId);
    this.pendingLazy.delete(pty);
    this.all.delete(pty);
  }

  dispose() {
    // Deactivation = window shutdown/reload: pending close decisions are dropped (PTYs stay alive).
    this.disposed = true;
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers.clear();
    for (const t of this.abandoned.values()) clearTimeout(t);
    this.abandoned.clear();
    for (const off of this._subs) off();
    this.connection.off('disconnected', this._onDisconnected);
    this.connection.off('connected', this._onConnected);
    for (const list of this.openWaiters.values()) for (const fn of list) fn();
    this.openWaiters.clear();
    for (const pty of this.all) pty.dispose();
    this.all.clear();
  }
}

module.exports = { MirrorManager, MirrorPty, DISCONNECTED_MSG, RECONNECTING_MSG, ENDED_MSG, RESET_ALL };
