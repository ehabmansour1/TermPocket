'use strict';

/**
 * Live view of ordinary (non-mirrored) VS Code terminals — PROTOCOL §5.2 `terminals.attach` /
 * `terminals.detach` / `terminals.keepalive` / `terminals.input` and the `term.raw` / `term.dims` /
 * `term.detached` events.
 *
 *  - Every terminal gets a raw output ring (default 512 K UTF-16 characters) fed, in arrival order, by the
 *    `execution.read()` streams of all its shell-integration executions (TerminalService calls `feed`).
 *    VS Code's stable API exposes no data outside executions, so the real prompt and keystrokes typed at
 *    the prompt are not in it; instead one dim line "$ <commandLine>" is inserted before each execution's
 *    output. The ring is trimmed from the front on a safe boundary (a line start when one is near, never
 *    inside an ESC sequence or a UTF-16 surrogate pair).
 *  - `term.raw {tid, d}` is streamed (batched ≤ 30 ms) only for terminals with ≥ 1 active attachment.
 *    Each attachment has an id (`aid`, chosen by the client; generated for clients that send none) and
 *    its own lease of 10 minutes, renewed by attach / keepalive / input. A lease that runs out is dropped
 *    (`term.detached {tid, aid, reason:"idle"}`), so a crashed phone cannot keep a stream going forever.
 *    Re-attaching with the same `aid` (or `replaces: <old aid>`) after a phone reconnect does not add a
 *    second attachment. All attachments are dropped when the agent connection goes down (phones
 *    re-attach after reconnecting).
 *  - Dimensions come from `terminal.dimensions` (stable getter) — polled once a second while attached —
 *    and from `window.onDidChangeTerminalDimensions` when the host allows it (it is a proposed API in
 *    stable VS Code: subscribing throws there, which is caught).
 */

const vscode = require('vscode');
const { errMsg, requireString } = require('./util');

const RING_CAP_DEFAULT = 512 * 1024; // characters
const RING_SLACK_DIVISOR = 4; // amortize trimming: trim once the ring exceeds cap + cap/4
const LINE_SEEK = 8 * 1024; // a trim may move forward this far to start at a line
const ESC_SEEK = 4 * 1024; // how far back a trim looks for an escape sequence it might split
const RAW_BATCH_MS = 30;
const RAW_FLUSH_CHARS = 256 * 1024;
const ATTACH_IDLE_MS = 10 * 60 * 1000;
const TICK_MS = 1000;
const RESTORE_WINDOW_MS = 10 * 1000; // terminals opened this soon after start are treated as restored
const AID_MAX = 64; // longest client-chosen attachment id accepted
const LEASES_MAX = 32; // attachments per terminal; the oldest lease is dropped beyond this

const NOTE_MIRROR =
  'This is a mirrored TermPocket terminal: open it as an agent terminal (ptyId) for the full live view.';
const NOTE_NO_SHELL_INTEGRATION =
  "VS Code shell integration isn't active in this terminal, so its output can't be read here (typing still works). " +
  'Use a shell with shell integration (PowerShell, bash, zsh, fish) or make new terminals phone-visible (mirrored) for a full live view.';
const NOTE_PREEXISTING =
  'Output of a program that was already running when TermPocket began watching this terminal ' +
  "(for example a Claude Code session started before VS Code reloaded) can't be read; output appears from the next command on. " +
  'Typing still works. Make new terminals phone-visible (mirrored) to always get the full screen.';
const NOTE_EMPTY = 'Nothing captured yet: output appears here from the next command on.';
const NOTE_SNAPSHOT_STATIC =
  "This is the terminal's screen as it is now (copied from VS Code, without colours). It can't update live here because " +
  'VS Code does not let extensions read output of a program that started before TermPocket watched this terminal (or of a shell without shell integration). ' +
  'Typing still works; reopen the view to refresh it, or make new terminals phone-visible (mirrored) for a full live view.';
/** Attach includes a screen snapshot when the captured ring holds less than this (characters). */
const SNAPSHOT_BELOW_CHARS = 4096;
const NOTE_TRUNCATED =
  'Only the most recent output is kept. If a full-screen app looks garbled, resize the VS Code terminal panel or press Ctrl+L to make it redraw.';

class LiveTerminals {
  /**
   * @param {object} deps
   * @param {import('./connection').RpcConnection} deps.connection
   * @param {object} deps.log
   * @param {(tid: string) => any} deps.getTerminal  throws for unknown tids
   * @param {(terminal: any) => string|null} deps.ptyIdOf  ptyId when the terminal is a TermPocket mirror
   * @param {() => number} [deps.ringCap]  ring size in characters (read when a ring is created / trimmed)
   * @param {() => number} [deps.now]
   */
  constructor({ connection, log, getTerminal, ptyIdOf, ringCap, now, snapshots }) {
    this.connection = connection;
    this.log = log;
    this.getTerminal = getTerminal;
    this.ptyIdOf = ptyIdOf || (() => null);
    this.ringCap = ringCap || (() => RING_CAP_DEFAULT);
    this.now = now || Date.now;
    /** @type {import('./snapshot').TerminalSnapshots|null} screen snapshots (terminals.snapshot) */
    this.snapshots = snapshots || null;
    this.startedAt = this.now();
    this.anonSeq = 0;
    /** @type {Map<string, TermState>} */
    this.states = new Map();
    this.tickTimer = null;
    this.disposables = [];
  }

  start() {
    // Proposed API in stable VS Code (`terminalDimensions`): the function exists but throws when called
    // by an extension without the proposal. The `terminal.dimensions` getter itself is not gated.
    const w = vscode.window;
    if (typeof w.onDidChangeTerminalDimensions === 'function') {
      try {
        this.disposables.push(
          w.onDidChangeTerminalDimensions((e) => {
            if (e && e.terminal) this._onDims(e.terminal, e.dimensions);
          })
        );
      } catch {
        /* not available to this extension: polling covers it */
      }
    }
    this.connection.on('disconnected', () => this._dropAll());
  }

  // ---- bookkeeping (called by TerminalService) -------------------------------------------------

  /**
   * Start tracking a terminal. `preexisting`: it was already open when the extension started (a program
   * may be running in it whose output we can never read); `created`: this extension just created it.
   */
  track(tid, terminal, { preexisting = false, created = false } = {}) {
    if (this.states.has(tid)) return this.states.get(tid);
    const now = this.now();
    const st = {
      tid,
      terminal,
      ring: new RawRing(this.ringCap()),
      watchingSince: now,
      preexisting: !created && (preexisting || now - this.startedAt < RESTORE_WINDOW_MS),
      sawExecution: false,
      running: 0,
      /** @type {Map<string, number>} attachment id → lease expiry (ms) */
      leases: new Map(),
      pending: '',
      flushTimer: null,
      dims: null,
    };
    this.states.set(tid, st);
    return st;
  }

  forget(tid) {
    const st = this.states.get(tid);
    if (!st) return;
    if (st.flushTimer) clearTimeout(st.flushTimer);
    this.states.delete(tid);
    this._updateTicker();
  }

  /**
   * A shell-integration execution started in this terminal (its output will be fed). Inserts a dim
   * "$ <commandLine>" line, standing in for the prompt + typed command the API does not expose.
   */
  executionStarted(tid, commandLine) {
    const st = this.states.get(tid);
    if (!st) return;
    st.sawExecution = true;
    st.running += 1;
    const cl = typeof commandLine === 'string' ? sanitizeCommandLine(commandLine) : '';
    if (cl) {
      const pre = st.ring.data && !st.ring.data.endsWith('\n') ? '\r\n' : '';
      this.feed(tid, `${pre}\x1b[2m$ ${cl}\x1b[22m\r\n`);
    }
  }

  /** A shell-integration execution of this terminal ended. */
  executionEnded(tid) {
    const st = this.states.get(tid);
    if (st && st.running > 0) st.running -= 1;
  }

  /** Raw output of an execution, in arrival order. */
  feed(tid, chunk) {
    const st = this.states.get(tid);
    if (!st || typeof chunk !== 'string' || !chunk) return;
    st.ring.cap = this.ringCap();
    st.ring.append(chunk);
    if (st.leases.size === 0) return;
    st.pending += chunk;
    if (st.pending.length >= RAW_FLUSH_CHARS) this._flush(st);
    else if (!st.flushTimer) st.flushTimer = setTimeout(() => this._flush(st), RAW_BATCH_MS);
  }

  // ---- methods ---------------------------------------------------------------------------------

  methods() {
    return {
      'terminals.attach': (p) => this.attachWithSnapshot(p),
      'terminals.snapshot': (p) => this.snapshot(p),
      'terminals.detach': (p) => this.detach(p),
      'terminals.keepalive': (p) => this.keepalive(p),
      'terminals.input': (p) => this.input(p),
    };
  }

  attach(p) {
    const terminal = this.getTerminal(p.tid);
    const st = this._state(p.tid, terminal);
    const ptyId = this.ptyIdOf(terminal);
    // Whatever is still pending goes out (to phones already attached) before the snapshot, so the
    // snapshot plus the term.raw events after this response are exactly the stream, without overlap.
    this._flush(st);
    // A size change noticed here first must still reach the phones already attached.
    const dims = this._readDims(st, true);
    const hasShellIntegration = !!terminal.shellIntegration;
    const capturing = !ptyId && hasShellIntegration && (st.sawExecution || !st.preexisting);
    const buffer = ptyId ? '' : st.ring.snapshot();
    let aid = null;
    if (!ptyId) {
      aid = validAid(p.aid) || `_${++this.anonSeq}`;
      const replaces = validAid(p.replaces);
      if (replaces && replaces !== aid) st.leases.delete(replaces);
      st.leases.delete(aid); // re-insert: Map order = renewal order (oldest first)
      st.leases.set(aid, this.now() + ATTACH_IDLE_MS);
      while (st.leases.size > LEASES_MAX) st.leases.delete(st.leases.keys().next().value);
      this._updateTicker();
    }
    let note;
    if (ptyId) note = NOTE_MIRROR;
    else if (!hasShellIntegration) note = NOTE_NO_SHELL_INTEGRATION;
    else if (!capturing) note = NOTE_PREEXISTING;
    else if (!buffer) note = NOTE_EMPTY;
    else if (st.ring.trimmed) note = NOTE_TRUNCATED;
    const r = {
      tid: st.tid,
      buffer,
      cols: dims ? dims.cols : null,
      rows: dims ? dims.rows : null,
      capturing,
      since: hasShellIntegration && !ptyId ? st.watchingSince : null,
      truncated: !ptyId && st.ring.trimmed,
      running: !ptyId && st.running > 0,
      hasShellIntegration,
      isMirror: !!ptyId,
      ptyId: ptyId || null,
      aid,
    };
    if (note) r.note = note;
    return r;
  }

  /**
   * terminals.attach as served over the wire: when nothing (or little) of the terminal was captured, the
   * result also carries `snapshot` = what the terminal shows right now (screen + scrollback, plain text),
   * taken BEFORE the attachment starts, so the client writes it (instead of `buffer`, which it already
   * contains) and then the live stream. When snapshots are available the key is always present —
   * `null` = not needed, turned off or failed — so a client knows not to ask again with terminals.snapshot.
   */
  async attachWithSnapshot(p) {
    const terminal = this.getTerminal(p.tid);
    const mirror = !!this.ptyIdOf(terminal);
    let snap = null;
    if (this.snapshots && !mirror) {
      const st = this._state(p.tid, terminal);
      const capturing = !!terminal.shellIntegration && (st.sawExecution || !st.preexisting);
      if (!capturing || st.ring.data.length < SNAPSHOT_BELOW_CHARS) snap = await this.snapshots.tryTake(terminal);
    }
    const r = this.attach(p);
    if (this.snapshots && !mirror) r.snapshot = snap && snap.text ? snap : null;
    if (r.snapshot) {
      if (!r.capturing) r.note = NOTE_SNAPSHOT_STATIC;
      else if (r.note === NOTE_EMPTY) delete r.note;
    }
    return r;
  }

  /** terminals.snapshot {tid} → {text, cols, rows, lines, at} (rejects when it cannot be taken). */
  async snapshot(p) {
    const terminal = this.getTerminal(p.tid);
    if (!this.snapshots) throw new Error('terminal snapshots are not available');
    return this.snapshots.take(terminal);
  }

  detach(p) {
    requireString(p.tid, 'tid');
    const st = this.states.get(p.tid);
    if (!st) return true; // closed meanwhile: nothing to do
    const aid = validAid(p.aid);
    if (aid) st.leases.delete(aid);
    else if (st.leases.size) {
      // Legacy client (no aid): end one attachment, preferring one we generated for such a client.
      let victim = null;
      for (const k of st.leases.keys()) {
        if (k.startsWith('_')) {
          victim = k;
          break;
        }
      }
      st.leases.delete(victim != null ? victim : st.leases.keys().next().value);
    }
    if (st.leases.size === 0) this._stopStreaming(st);
    this._updateTicker();
    return true;
  }

  keepalive(p) {
    const terminal = this.getTerminal(p.tid);
    const st = this._state(p.tid, terminal);
    const aid = validAid(p.aid);
    if (aid) {
      if (!st.leases.has(aid)) return { attached: false };
      this._renew(st, aid);
      return { attached: true };
    }
    this._renew(st, null);
    return { attached: st.leases.size > 0 };
  }

  input(p) {
    const terminal = this.getTerminal(p.tid);
    if (typeof p.d !== 'string') throw new Error('missing or invalid parameter: d');
    const st = this.states.get(p.tid);
    if (st) {
      const aid = validAid(p.aid);
      if (!aid) this._renew(st, null);
      else if (st.leases.has(aid)) this._renew(st, aid);
    }
    if (p.d) terminal.sendText(p.d, false);
    return true;
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Renew the lease of one attachment, or of all attachments of the terminal when aid is null. */
  _renew(st, aid) {
    const until = this.now() + ATTACH_IDLE_MS;
    if (aid == null) {
      for (const k of st.leases.keys()) st.leases.set(k, until);
    } else if (st.leases.has(aid)) {
      st.leases.delete(aid);
      st.leases.set(aid, until);
    }
  }

  _state(tid, terminal) {
    return this.states.get(tid) || this.track(tid, terminal);
  }

  _flush(st) {
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = null;
    if (!st.pending) return;
    const d = st.pending;
    st.pending = '';
    this.connection.notify('term.raw', { tid: st.tid, d });
    // Cheap moment to notice a resize that the (gated) event did not report.
    this._readDims(st, true);
  }

  _stopStreaming(st) {
    st.leases.clear();
    st.pending = '';
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = null;
  }

  _dropAll() {
    for (const st of this.states.values()) this._stopStreaming(st);
    this._updateTicker();
  }

  /** Current dims of a terminal ({cols, rows} or null); emits term.dims on change when `emit`. */
  _readDims(st, emit = false) {
    let d;
    try {
      d = st.terminal.dimensions;
    } catch {
      d = undefined;
    }
    if (d && Number.isInteger(d.columns) && Number.isInteger(d.rows) && d.columns > 0 && d.rows > 0) {
      this._setDims(st, { cols: d.columns, rows: d.rows }, emit);
    }
    return st.dims;
  }

  _onDims(terminal, dims) {
    for (const st of this.states.values()) {
      if (st.terminal !== terminal) continue;
      if (dims && Number.isInteger(dims.columns) && Number.isInteger(dims.rows) && dims.columns > 0 && dims.rows > 0) {
        this._setDims(st, { cols: dims.columns, rows: dims.rows }, true);
      }
    }
  }

  _setDims(st, dims, emit) {
    const changed = !st.dims || st.dims.cols !== dims.cols || st.dims.rows !== dims.rows;
    st.dims = dims;
    if (changed && emit && st.leases.size > 0) {
      // Output written at the old size must reach phones before they resize their view.
      this._flushPendingOnly(st);
      this.connection.notify('term.dims', { tid: st.tid, cols: dims.cols, rows: dims.rows });
    }
  }

  _flushPendingOnly(st) {
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = null;
    if (!st.pending) return;
    const d = st.pending;
    st.pending = '';
    this.connection.notify('term.raw', { tid: st.tid, d });
  }

  _tick() {
    const now = this.now();
    for (const st of this.states.values()) {
      if (st.leases.size === 0) continue;
      for (const [aid, until] of [...st.leases]) {
        if (now < until) continue;
        st.leases.delete(aid);
        this.connection.notify('term.detached', { tid: st.tid, aid, reason: 'idle' });
        this.log.info(`live view of ${st.tid} (${aid}) expired (no keepalive for ${ATTACH_IDLE_MS / 60000} min)`);
      }
      if (st.leases.size === 0) {
        this._stopStreaming(st);
        continue;
      }
      this._readDims(st, true);
    }
    this._updateTicker();
  }

  _updateTicker() {
    let any = false;
    for (const st of this.states.values()) {
      if (st.leases.size > 0) {
        any = true;
        break;
      }
    }
    if (any && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        try {
          this._tick();
        } catch (err) {
          this.log.warn(`live tick failed: ${errMsg(err)}`);
        }
      }, TICK_MS);
      if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();
    } else if (!any && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Active attachment count of a tid (tests / diagnostics). */
  attachedCount(tid) {
    const st = this.states.get(tid);
    return st ? st.leases.size : 0;
  }

  dispose() {
    for (const st of this.states.values()) {
      if (st.flushTimer) clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
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

/** A client-chosen attachment id, or null when absent / not acceptable. */
function validAid(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= AID_MAX ? v : null;
}

/** One-line, control-character-free form of a command line (multi-line commands joined with " ⏎ "). */
function sanitizeCommandLine(s) {
  return s
    .replace(/\r?\n/g, ' \u23ce ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
}

// ---- raw ring ----------------------------------------------------------------------------------

class RawRing {
  constructor(cap = RING_CAP_DEFAULT) {
    this.cap = cap;
    this.data = '';
    this.trimmed = false;
  }

  append(chunk) {
    this.data += chunk;
    if (this.data.length > this.cap + Math.floor(this.cap / RING_SLACK_DIVISOR)) this.trim();
  }

  /** Trim to at most `cap` characters, cutting from the front on a safe boundary. */
  trim() {
    if (this.data.length <= this.cap) return;
    const cut = safeCut(this.data, this.data.length - this.cap);
    this.data = this.data.slice(cut);
    this.trimmed = true;
  }

  snapshot() {
    this.trim();
    return this.data;
  }
}

/**
 * Index ≥ `from` at which `s` can be cut so that the rest starts cleanly: the start of a line when one
 * begins within LINE_SEEK characters, else not inside an escape sequence and not on the low half of a
 * surrogate pair.
 */
function safeCut(s, from) {
  if (from <= 0) return 0;
  if (from >= s.length) return s.length;
  if (s.charCodeAt(from - 1) === 0x0a) return from;
  const nl = s.indexOf('\n', from);
  if (nl !== -1 && nl - from < LINE_SEEK) return nl + 1;
  let cut = from;
  const escAt = s.lastIndexOf('\x1b', cut - 1);
  if (escAt !== -1 && cut - escAt <= ESC_SEEK) {
    const end = escEnd(s, escAt);
    if (end > cut) cut = end;
  }
  if (cut < s.length) {
    const c = s.charCodeAt(cut);
    if (c >= 0xdc00 && c <= 0xdfff) cut += 1;
  }
  return Math.min(cut, s.length);
}

/** Index just past the escape sequence that starts at s[i] (an ESC), or -1 when it is incomplete. */
function escEnd(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c = s[i + 1];
  if (c === '[') {
    for (let j = i + 2; j < n; j++) {
      const k = s.charCodeAt(j);
      if (k >= 0x40 && k <= 0x7e) return j + 1;
    }
    return -1;
  }
  if (c === ']' || c === 'P' || c === '_' || c === '^' || c === 'X') {
    // string sequences: terminated by BEL or ST (ESC \)
    for (let j = i + 2; j < n; j++) {
      if (s[j] === '\x07') return j + 1;
      if (s[j] === '\x1b' && s[j + 1] === '\\') return j + 2;
    }
    return -1;
  }
  let j = i + 1;
  while (j < n && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++; // intermediates
  return j < n ? j + 1 : -1;
}

module.exports = {
  LiveTerminals,
  RawRing,
  safeCut,
  escEnd,
  sanitizeCommandLine,
  RING_CAP_DEFAULT,
  RAW_BATCH_MS,
  SNAPSHOT_BELOW_CHARS,
  NOTE_SNAPSHOT_STATIC,
  ATTACH_IDLE_MS,
};
