'use strict';

/**
 * WebSocket client for the agent's `/vscode` endpoint with symmetric JSON RPC (PROTOCOL §3, §5.1).
 *
 *  - request  {"t":"req","id":7,"m":"...","p":{...}}
 *  - response {"t":"res","id":7,"ok":true,"r":...} | {"t":"res","id":7,"ok":false,"e":"..."}
 *  - event    {"t":"evt","ev":"...","p":{...}}
 *
 * Every socket starts with the mutual handshake (§5.1): `hello.challenge` (id 1, the agent proves it
 * knows the token) then `hello` (id 2, carrying our proof — the raw token is never sent). Ids are per
 * connection and per sender. Reconnects forever with exponential backoff 1 s → 30 s while the extension is active.
 *
 * This module deliberately does not depend on `vscode` so it can be unit tested in plain Node.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { errMsg } = require('./util');

// ---- /vscode handshake proofs (PROTOCOL §5.1) — must match agent/src/server.js -----------------

/** HMAC-SHA256(token, label \n a \n b) as base64url. */
function handshakeProof(token, label, a, b) {
  return crypto.createHmac('sha256', String(token)).update(`${label}\n${a}\n${b}`, 'utf8').digest('base64url');
}
/** What the agent must answer to `hello.challenge`. */
const agentProof = (token, clientNonce, serverNonce) => handshakeProof(token, 'termpocket-agent', clientNonce, serverNonce);
/** What we send in `hello` (`proof`) instead of the token. */
const extensionProof = (token, clientNonce, serverNonce) => handshakeProof(token, 'termpocket-ext', serverNonce, clientNonce);

function proofEquals(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const WS_OPEN = 1;
/** After the agent rejects a token (close 4401) do not retry with the same token for this long. */
const BAD_TOKEN_HOLD_MS = 10 * 60 * 1000;
/** After the agent rate-limits us (close 4429) wait at least this long. */
const RATE_LIMIT_HOLD_MS = 60 * 1000;
/**
 * Largest response frame we send (UTF-8 bytes). The agent's /vscode socket accepts frames up to 16 MB
 * (maxPayload) and closes the whole connection on anything bigger.
 */
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

/** UTF-8 size check without encoding small frames (a UTF-16 unit is at most 3 UTF-8 bytes). */
function tooLarge(text, max = MAX_RESPONSE_BYTES) {
  return text.length * 3 > max && Buffer.byteLength(text, 'utf8') > max;
}

/** Node 22+ (VS Code ≥ 1.90 on newer Electron) has a global WebSocket; older hosts use the bundled `ws`. */
function defaultWebSocketImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  return require('ws');
}

class RpcConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => ({url: string|null, token: string|null, configPath?: string, error?: string|null}) | Promise<any>} opts.resolveTarget
   *        called before every connection attempt (re-reads config so late pairing works)
   * @param {() => object} opts.helloParams   extra hello params (windowId, name, folders, vscodeVersion, pid)
   * @param {{info: Function, warn: Function, error: Function, debug?: Function}} [opts.log]
   */
  constructor(opts) {
    super();
    this._resolveTarget = opts.resolveTarget;
    this._helloParams = opts.helloParams || (() => ({}));
    this._log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
    this._WS = opts.WebSocketImpl || defaultWebSocketImpl();
    this._minDelay = opts.minDelayMs || 1000;
    this._maxDelay = opts.maxDelayMs || 30000;
    this._requestTimeout = opts.requestTimeoutMs || 30000;
    this._handshakeTimeout = opts.handshakeTimeoutMs || 10000;
    this._maxResponseBytes = opts.maxResponseBytes || MAX_RESPONSE_BYTES;

    this._methods = new Map(); // name -> async (params) => result
    this._eventHandlers = new Map(); // name -> Set<fn(params)>
    this._pending = new Map(); // id -> {resolve, reject, timer, m}

    this._ws = null;
    this._nextId = 1;
    this._state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this._delay = this._minDelay;
    this._timer = null;
    this._started = false;
    this._stopped = false;
    this._badToken = null; // {token, url, at}
    this._rateLimitedUntil = 0;

    /** Public diagnostics (status bar / info command). */
    this.info = { url: null, configPath: null, agentVersion: null, lastError: null, connectedAt: null };
  }

  // ------------------------------------------------------------------ registration

  /** Register a handler for requests the agent sends to us. */
  register(method, handler) {
    this._methods.set(method, handler);
  }

  /** Register many handlers at once: `{ 'fs.list': fn, ... }`. */
  registerAll(map) {
    for (const [name, fn] of Object.entries(map)) this.register(name, fn);
  }

  /** Subscribe to an event pushed by the agent. Returns an unsubscribe function. */
  onEvent(name, handler) {
    let set = this._eventHandlers.get(name);
    if (!set) this._eventHandlers.set(name, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  // ------------------------------------------------------------------ state

  get state() {
    return this._state;
  }

  get connected() {
    return this._state === 'connected';
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  _setError(message) {
    if (this.info.lastError !== message) {
      this.info.lastError = message;
      if (message) this._log.warn(message);
      this.emit('state', this._state);
    }
  }

  /** Resolves true once connected (immediately if already), false after `timeoutMs`. */
  waitForConnected(timeoutMs) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onConnected = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        resolve(false);
      }, timeoutMs);
      this.once('connected', onConnected);
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    this._scheduleConnect(0);
  }

  /** Drop the current socket (if any) and connect again right away with a fresh backoff. */
  reconnect() {
    if (this._stopped) return;
    this._started = true;
    this._badToken = null;
    this._rateLimitedUntil = 0;
    this._delay = this._minDelay;
    if (this._ws) {
      // Close handler schedules the next attempt with the (reset) minimum delay.
      this._closeSocket(this._ws, 1000, 'reconnect');
    } else {
      this._scheduleConnect(0);
    }
  }

  /** Stop for good (extension deactivation). */
  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    const ws = this._ws;
    if (ws) this._closeSocket(ws, 1000, 'extension deactivated');
    this._failPending(new Error('connection closed'));
  }

  _scheduleConnect(ms) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._connect().catch((err) => {
        this._setError(`connect failed: ${errMsg(err)}`);
        this._retryLater();
      });
    }, ms);
  }

  _retryLater() {
    if (this._stopped) return;
    const ms = this._delay;
    this._delay = Math.min(this._delay * 2, this._maxDelay);
    this._log.debug && this._log.debug(`reconnecting in ${ms} ms`);
    this._scheduleConnect(ms);
  }

  async _connect() {
    if (this._stopped || this._ws) return;

    let target;
    try {
      target = (await this._resolveTarget()) || {};
    } catch (err) {
      target = { error: errMsg(err) };
    }
    if (this._stopped || this._ws) return;
    this.info.url = target.url || null;
    this.info.configPath = target.configPath || null;

    if (target.error || !target.url || !target.token) {
      this._setError(target.error || 'agent URL or token unavailable');
      this._retryLater();
      return;
    }
    const bad = this._badToken;
    if (bad && bad.token === target.token && bad.url === target.url && Date.now() - bad.at < BAD_TOKEN_HOLD_MS) {
      // Do not burn the agent's auth rate limit with a token it already rejected; wait for re-pairing.
      this._setError('agent rejected the pairing token; waiting for config.json to change (or run "TermPocket: Reconnect")');
      this._retryLater();
      return;
    }
    if (Date.now() < this._rateLimitedUntil) {
      this._setError('agent rate-limited this client; waiting');
      this._retryLater();
      return;
    }

    this._setState('connecting');
    let ws;
    try {
      ws = new this._WS(target.url);
    } catch (err) {
      this._setState('disconnected');
      this._setError(`cannot open ${target.url}: ${errMsg(err)}`);
      this._retryLater();
      return;
    }
    this._ws = ws;
    this._nextId = 1; // hello.challenge is id 1, hello id 2 (PROTOCOL §5.1)
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* not supported: binary frames are ignored anyway */
    }

    const ctx = { ws, target, socketError: null };
    // Covers TCP connect + hello round trip.
    ctx.timer = setTimeout(() => {
      if (this._ws === ws && this._state !== 'connected') {
        ctx.socketError = 'handshake timed out';
        this._closeSocket(ws, 4000, 'handshake timeout');
      }
    }, this._handshakeTimeout);

    ws.addEventListener('open', () => this._onOpen(ctx));
    ws.addEventListener('message', (ev) => {
      if (this._ws === ws) this._onMessage(ev.data, ws);
    });
    ws.addEventListener('error', (ev) => {
      ctx.socketError = (ev && (ev.message || (ev.error && ev.error.message))) || 'socket error';
    });
    ws.addEventListener('close', (ev) => this._onClose(ctx, ev ? ev.code : 0, ev ? ev.reason : ''));
  }

  async _onOpen(ctx) {
    const { ws, target } = ctx;
    if (this._ws !== ws) return;
    try {
      // PROTOCOL §5.1 mutual challenge-response: the agent must prove it knows the token BEFORE we
      // prove that we do, and the raw token never goes on the wire (whatever listens on the port
      // may not be the real agent — e.g. another user's process while the agent is down).
      const clientNonce = crypto.randomBytes(32).toString('base64url');
      let ch;
      try {
        ch = await this._sendRequest(ws, 'hello.challenge', { nonce: clientNonce }, this._handshakeTimeout);
      } catch (err) {
        if (/first message must be hello/i.test(errMsg(err))) throw new Error('the TermPocket agent is too old for this extension; update the agent');
        throw err;
      }
      if (this._ws !== ws) return;
      if (!ch || typeof ch.nonce !== 'string' || !proofEquals(agentProof(target.token, clientNonce, ch.nonce), ch.proof)) {
        const e = new Error(`the server at ${target.url} could not prove it is the TermPocket agent (wrong token, or another program on that port); the pairing token was not sent`);
        e.untrustedServer = true;
        throw e;
      }
      const params = Object.assign({}, this._helloParams());
      delete params.token;
      params.proof = extensionProof(target.token, clientNonce, ch.nonce);
      const r = await this._sendRequest(ws, 'hello', params, this._handshakeTimeout);
      if (this._ws !== ws) return;
      clearTimeout(ctx.timer);
      this.info.agentVersion = r && r.version ? String(r.version) : null;
      this.info.connectedAt = Date.now();
      this.info.lastError = null;
      this._delay = this._minDelay;
      this._badToken = null;
      this._log.info(`connected to agent ${this.info.agentVersion || ''} at ${target.url}`);
      this._setState('connected');
      this.emit('connected');
    } catch (err) {
      if (this._ws !== ws) return;
      const msg = errMsg(err);
      if (/bad token/i.test(msg)) this._badToken = { token: target.token, url: target.url, at: Date.now() };
      ctx.socketError = err && err.untrustedServer ? msg : `hello rejected: ${msg}`;
      ctx.untrusted = !!(err && err.untrustedServer);
      this._closeSocket(ws, 1000, 'hello failed');
    }
  }

  _onClose(ctx, code, reason) {
    const { ws, target } = ctx;
    clearTimeout(ctx.timer);
    if (this._ws !== ws) return;
    this._ws = null;
    const wasConnected = this._state === 'connected';
    this._failPending(new Error('connection closed'));

    if (ctx.untrusted) {
      this._setError(ctx.socketError);
    } else if (code === 4401) {
      this._badToken = { token: target.token, url: target.url, at: Date.now() };
      this._setError('agent rejected the pairing token (4401)');
    } else if (code === 4429) {
      this._rateLimitedUntil = Date.now() + RATE_LIMIT_HOLD_MS;
      this._setError('agent rate-limited this client (4429)');
    } else if (ctx.socketError) {
      this._setError(`${target.url}: ${ctx.socketError}`);
    } else if (wasConnected) {
      this._log.info(`disconnected from agent (code ${code}${reason ? `, ${reason}` : ''})`);
    }

    this.info.connectedAt = null;
    this._setState('disconnected');
    if (wasConnected) this.emit('disconnected');
    this._retryLater();
  }

  _closeSocket(ws, code, reason) {
    try {
      // Browser-style WebSocket only accepts 1000 or 3000-4999 from applications.
      ws.close(code, reason);
    } catch {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    // Some implementations never fire `close` for a socket that never opened; make sure we move on.
    const fallback = setTimeout(() => {
      if (this._ws === ws) this._onClose({ ws, target: { token: null, url: this.info.url }, timer: null }, 1006, 'forced');
    }, 3000);
    if (fallback.unref) fallback.unref();
  }

  _failPending(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  // ------------------------------------------------------------------ sending

  _sendRaw(ws, obj) {
    return this._sendText(ws, JSON.stringify(obj));
  }

  _sendText(ws, text) {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch (err) {
      this._log.warn(`send failed: ${errMsg(err)}`);
      return false;
    }
  }

  _sendRequest(ws, m, p, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${m}: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, m });
      if (!this._sendRaw(ws, { t: 'req', id, m, p: p === undefined ? {} : p })) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error('TermPocket agent not connected'));
      }
    });
  }

  /** Send a request to the agent. Rejects when not connected, on timeout, or with the agent's error text. */
  request(m, p, opts = {}) {
    if (!this.connected) return Promise.reject(new Error('TermPocket agent not connected'));
    return this._sendRequest(this._ws, m, p, opts.timeoutMs || this._requestTimeout);
  }

  /** Fire-and-forget event to the agent. Returns false when it could not be sent (not connected). */
  notify(ev, p) {
    if (!this.connected) return false;
    return this._sendRaw(this._ws, { t: 'evt', ev, p: p === undefined ? {} : p });
  }

  // ------------------------------------------------------------------ receiving

  _onMessage(data, ws) {
    if (typeof data !== 'string') {
      // Binary frames are only used agent → phone; tolerate Buffer text frames from odd ws builds.
      if (data && typeof data.toString === 'function' && Buffer.isBuffer(data)) data = data.toString('utf8');
      else return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this._log.warn('ignoring malformed (non-JSON) frame from agent');
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'res': {
        const pending = this._pending.get(msg.id);
        if (!pending) return;
        this._pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.r === undefined ? null : msg.r);
        else pending.reject(new Error(typeof msg.e === 'string' && msg.e ? msg.e : `${pending.m} failed`));
        return;
      }
      case 'req':
        // Never serve the peer before the handshake proved it is the agent (§5.1).
        if (this._state !== 'connected') {
          this._sendRaw(ws, { t: 'res', id: msg.id, ok: false, e: 'not authenticated' });
          return;
        }
        this._handleRequest(msg, ws);
        return;
      case 'evt':
        if (this._state !== 'connected') return;
        this._dispatchEvent(msg.ev, msg.p);
        return;
      default:
        this._log.warn(`ignoring frame with unknown kind: ${String(msg.t)}`);
    }
  }

  async _handleRequest(msg, ws) {
    const { id, m } = msg;
    const handler = typeof m === 'string' ? this._methods.get(m) : undefined;
    if (!handler) {
      this._sendRaw(ws, { t: 'res', id, ok: false, e: `unknown method: ${m}` });
      return;
    }
    try {
      const params = msg.p && typeof msg.p === 'object' ? msg.p : {};
      const r = await handler(params);
      const text = JSON.stringify({ t: 'res', id, ok: true, r: r === undefined ? null : r });
      if (tooLarge(text, this._maxResponseBytes)) {
        // A frame over the agent's maxPayload (16 MB) would make it drop the whole socket (1009) and with
        // it every mirrored terminal of this window: answer with an error instead.
        this._log.warn(`${m}: result too large (${Buffer.byteLength(text, 'utf8')} bytes); not sent`);
        this._sendRaw(ws, { t: 'res', id, ok: false, e: `result too large (${(Buffer.byteLength(text, 'utf8') / 1048576).toFixed(1)} MB; limit ${Math.floor(this._maxResponseBytes / 1048576)} MB)` });
        return;
      }
      if (!this._sendText(ws, text)) {
        this._log.debug && this._log.debug(`dropped response for ${m}: socket closed`);
      }
    } catch (err) {
      const e = errMsg(err);
      this._log.debug && this._log.debug(`${m} failed: ${e}`);
      this._sendRaw(ws, { t: 'res', id, ok: false, e });
    }
  }

  _dispatchEvent(ev, p) {
    const set = this._eventHandlers.get(ev);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        const r = fn(p && typeof p === 'object' ? p : {});
        if (r && typeof r.catch === 'function') r.catch((err) => this._log.error(`event ${ev}: ${errMsg(err)}`));
      } catch (err) {
        this._log.error(`event ${ev}: ${errMsg(err)}`);
      }
    }
  }
}

module.exports = { RpcConnection, defaultWebSocketImpl, agentProof, extensionProof };
