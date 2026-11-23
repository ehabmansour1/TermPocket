// WebSocket client for the agent's phone socket (/ws) — PROTOCOL §3 / §4.
//
//  * First frame is always {"t":"req","id":1,"m":"auth","p":{token, client:"pwa"}}.
//  * Request/response correlation with per-request timeouts (ids restart at 1 per socket).
//  * Server events are re-emitted under their own name (e.g. 'pty.data').
//  * Binary frames are emitted as 'binary' (ArrayBuffer).
//  * Automatic reconnect with exponential backoff + jitter; liveness probing.
//
// Local events:  'status' (status, detail) · 'ready' ({info, reconnect}) · 'down' ·
//                'unauthorized' ({reason}) · 'binary' (ArrayBuffer) · 'evt' (name, payload)

export class Emitter {
  #handlers = new Map();

  on(ev, fn) {
    let set = this.#handlers.get(ev);
    if (!set) this.#handlers.set(ev, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(ev, fn) {
    const off = this.on(ev, (...args) => { off(); fn(...args); });
    return off;
  }

  emit(ev, ...args) {
    const set = this.#handlers.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[termpocket] "${ev}" handler failed`, err); }
    }
  }
}

/** Error returned by the agent ({ok:false, e}). */
export class RpcError extends Error {
  constructor(message, method) {
    super(message);
    this.name = 'RpcError';
    this.method = method;
  }
}

/** Connection-level failure (offline, timeout, socket closed). */
export class ConnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnError';
  }
}

export const STATUS = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  AUTH: 'auth',
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNAUTHORIZED: 'unauthorized',
});

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15000;
const RATE_LIMIT_DELAY = 60000;
const CONNECT_TIMEOUT = 15000;
const IDLE_PROBE_AFTER = 40000;

export function defaultSocketUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Conn extends Emitter {
  /**
   * @param {{ getToken: () => string|null, url?: string }} opts
   */
  constructor({ getToken, url = defaultSocketUrl() }) {
    super();
    this.url = url;
    this.getToken = getToken;
    this.status = STATUS.IDLE;
    this.detail = '';
    /** Result of the last successful auth (hostname, version, features…). */
    this.info = null;
    this.retryAt = 0;

    this._ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._attempt = 0;
    this._readyCount = 0;
    this._stopped = true;
    this._retryTimer = null;
    this._connectTimer = null;
    this._lastRx = 0;
    this._probing = false;
    this._authRejected = false;

    this._livenessTimer = setInterval(() => this._checkLiveness(), 10000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.status === STATUS.OFFLINE) this.reconnectNow();
      else if (this.status === STATUS.ONLINE && Date.now() - this._lastRx > 15000) this._probe();
    });
    window.addEventListener('online', () => { if (this.status === STATUS.OFFLINE) this.reconnectNow(); });
  }

  get online() { return this.status === STATUS.ONLINE; }

  /** Start connecting (no-op if already running). */
  start() {
    this._stopped = false;
    if (this._ws) return;
    this._authRejected = false;
    this._attempt = 0;
    this._open();
  }

  /** Close and stop reconnecting. */
  stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    const ws = this._ws;
    if (ws) this._drop(ws, 'stopped', 1000);
    this._setStatus(STATUS.IDLE);
  }

  /** Skip the backoff wait and try again right away. */
  reconnectNow() {
    if (this._stopped) { this.start(); return; }
    if (this._ws) return; // connecting or connected already
    clearTimeout(this._retryTimer);
    this._attempt = 0;
    this._open();
  }

  /**
   * Send a request and await its result.
   * @param {string} m       method
   * @param {object} [p]     params
   * @param {{timeout?: number}} [opts]
   */
  request(m, p, { timeout = 20000 } = {}) {
    const ws = this._ws;
    if (!ws || this.status !== STATUS.ONLINE || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ConnError('Not connected to the PC'));
    }
    return this._rawRequest(ws, m, p, timeout);
  }

  /** Relay a call to a VS Code window (§4.2). The agent itself times out at 30 s. */
  vsc(windowId, m, p, { timeout = 35000 } = {}) {
    return this.request('vsc.call', { windowId, m, p: p ?? {} }, { timeout });
  }

  /** Fire-and-forget event to the agent (symmetric envelope). */
  notify(ev, p) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== STATUS.ONLINE) return false;
    try { ws.send(JSON.stringify({ t: 'evt', ev, p: p ?? {} })); return true; } catch { return false; }
  }

  /** Bytes queued on the socket (useful for input throttling). */
  get bufferedAmount() { return this._ws ? this._ws.bufferedAmount : 0; }

  /* -------------------------------------------------------------- internals */

  _setStatus(status, detail = '') {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.emit('status', status, detail);
  }

  _open() {
    clearTimeout(this._retryTimer);
    const token = this.getToken();
    if (!token) {
      this._setStatus(STATUS.UNAUTHORIZED, 'Not paired');
      this.emit('unauthorized', { reason: 'not paired' });
      return;
    }
    this._setStatus(STATUS.CONNECTING);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.warn('[termpocket] WebSocket construction failed', err);
      this._scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    this._nextId = 1;
    this._lastRx = Date.now();

    this._connectTimer = setTimeout(() => {
      if (this._ws === ws && this.status !== STATUS.ONLINE) this._drop(ws, 'connect timeout');
    }, CONNECT_TIMEOUT);

    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._setStatus(STATUS.AUTH);
      this._rawRequest(ws, 'auth', { token, client: 'pwa' }, 12000).then((info) => {
        if (this._ws !== ws) return;
        clearTimeout(this._connectTimer);
        this.info = info || {};
        this._attempt = 0;
        this._setStatus(STATUS.ONLINE);
        const reconnect = this._readyCount++ > 0;
        this.emit('ready', { info: this.info, reconnect });
      }).catch((err) => {
        if (this._ws !== ws) return;
        if (err instanceof RpcError) {
          // "bad token" — the agent closes with 4401 right after; don't retry.
          this._authRejected = true;
          this._drop(ws, err.message, 1000);
        } else {
          this._drop(ws, err.message);
        }
      });
    };
    ws.onmessage = (e) => this._onMessage(ws, e.data);
    ws.onclose = (e) => this._onClose(ws, e.code, e.reason);
    ws.onerror = () => { /* a close event always follows */ };
  }

  _rawRequest(ws, m, p, timeout) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new ConnError(`Timed out waiting for the PC (${m})`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer, m });
      try {
        ws.send(JSON.stringify({ t: 'req', id, m, p: p ?? {} }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new ConnError(err.message || 'send failed'));
      }
    });
  }

  _onMessage(ws, data) {
    if (ws !== this._ws) return;
    this._lastRx = Date.now();
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) this.emit('binary', data);
      else if (data && typeof data.arrayBuffer === 'function') data.arrayBuffer().then((b) => this.emit('binary', b));
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch {
      console.warn('[termpocket] dropped non-JSON frame');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'res') {
      const pend = this._pending.get(msg.id);
      if (!pend) return;
      this._pending.delete(msg.id);
      clearTimeout(pend.timer);
      if (msg.ok) pend.resolve(msg.r);
      else pend.reject(new RpcError(msg.e || 'request failed', pend.m));
    } else if (msg.t === 'evt') {
      const p = msg.p ?? {};
      this.emit('evt', msg.ev, p);
      if (typeof msg.ev === 'string') this.emit(msg.ev, p);
    } else if (msg.t === 'req') {
      // The phone exposes no methods; answer politely per §3.
      try {
        ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: `unknown method: ${msg.m}` }));
      } catch { /* ignore */ }
    }
  }

  /** Forcefully abandon a socket and run the close logic immediately. */
  _drop(ws, reason, code = 4000) {
    if (ws !== this._ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(code, String(reason).slice(0, 100)); } catch { /* ignore */ }
    this._onClose(ws, this._authRejected ? 4401 : 1006, reason);
  }

  _onClose(ws, code, reason) {
    if (ws !== this._ws) return;
    this._ws = null;
    clearTimeout(this._connectTimer);
    const wasOnline = this.status === STATUS.ONLINE;
    for (const [, pend] of this._pending) {
      clearTimeout(pend.timer);
      pend.reject(new ConnError('Connection to the PC was lost'));
    }
    this._pending.clear();
    if (wasOnline) this.emit('down');

    if (code === 4401 || this._authRejected) {
      this._stopped = true;
      this._setStatus(STATUS.UNAUTHORIZED, 'Pairing token rejected');
      this.emit('unauthorized', { reason: 'bad token' });
      return;
    }
    if (this._stopped) return;
    if (code === 4429) {
      this._scheduleRetry(RATE_LIMIT_DELAY, 'Too many failed attempts — waiting');
      return;
    }
    this._scheduleRetry(undefined, reason && reason !== 'stopped' ? String(reason) : '');
  }

  _scheduleRetry(delay, why = '') {
    clearTimeout(this._retryTimer);
    if (delay == null) {
      const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this._attempt);
      delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this._attempt = Math.min(this._attempt + 1, 10);
    }
    this.retryAt = Date.now() + delay;
    this._setStatus(STATUS.OFFLINE, why);
    this._retryTimer = setTimeout(() => {
      if (!this._stopped && !this._ws) this._open();
    }, delay);
  }

  _checkLiveness() {
    if (this.status !== STATUS.ONLINE || document.visibilityState !== 'visible') return;
    if (Date.now() - this._lastRx > IDLE_PROBE_AFTER) this._probe();
  }

  /** Cheap round-trip to detect half-open sockets (e.g. after a network switch). */
  async _probe() {
    if (this._probing || !this._ws) return;
    const ws = this._ws;
    this._probing = true;
    try {
      await this._rawRequest(ws, 'pty.list', {}, 8000);
    } catch (err) {
      if (err instanceof ConnError && this._ws === ws) this._drop(ws, 'no response');
    } finally {
      this._probing = false;
    }
  }
}
