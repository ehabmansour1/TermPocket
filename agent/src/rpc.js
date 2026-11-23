// Symmetric JSON RPC over a WebSocket (PROTOCOL.md §3).
//
//   request  {"t":"req","id":7,"m":"pty.create","p":{...}}
//   response {"t":"res","id":7,"ok":true,"r":<any>} | {"t":"res","id":7,"ok":false,"e":"message"}
//   event    {"t":"evt","ev":"pty.data","p":{...}}
//
// Either side may send requests; ids are per-sender integers. Malformed frames are ignored.

import { WebSocket } from 'ws';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Parse a text frame; returns null for anything that is not a well-formed envelope object. */
export function parseFrame(data, isBinary = false) {
  if (isBinary) return null;
  let text;
  if (typeof data === 'string') text = data;
  else if (Buffer.isBuffer(data)) text = data.toString('utf8');
  else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8');
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
  else return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null;
  switch (msg.t) {
    case 'req':
      if (!isValidId(msg.id) || typeof msg.m !== 'string' || !msg.m) return null;
      return msg;
    case 'res':
      if (!isValidId(msg.id) || typeof msg.ok !== 'boolean') return null;
      return msg;
    case 'evt':
      if (typeof msg.ev !== 'string' || !msg.ev) return null;
      return msg;
    default:
      return null;
  }
}

function isValidId(id) {
  return (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0 && id.length <= 64);
}

/** Error raised when a request is not answered in time (`err.code === 'ETIMEDOUT'`). */
export class RpcTimeoutError extends Error {
  constructor(method, ms) {
    super(`timeout: ${method} (${ms} ms)`);
    this.name = 'RpcTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/** Error raised for pending requests when the socket closes (`err.code === 'ECONNCLOSED'`). */
export class RpcClosedError extends Error {
  constructor(method) {
    super(`connection closed${method ? ` (${method})` : ''}`);
    this.name = 'RpcClosedError';
    this.code = 'ECONNCLOSED';
  }
}

function errorMessage(err) {
  if (err instanceof Error) return err.message || err.name || 'error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Wrap a `ws` WebSocket in an RPC connection.
 *
 * @param {import('ws').WebSocket} ws
 * @param {{log?: object, defaultTimeoutMs?: number, label?: string}} [opts]
 */
export function makeConn(ws, { log, defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, label = 'conn' } = {}) {
  let nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, m: string}>} */
  const pending = new Map();
  let requestHandler = null;
  const eventHandlers = new Set();
  const closeHandlers = new Set();
  let closed = ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED;

  const debug = (msg) => log?.debug?.(`${label}: ${msg}`);

  function isOpen() {
    return ws.readyState === WebSocket.OPEN;
  }

  function sendJson(obj) {
    if (!isOpen()) return false;
    let text;
    try {
      text = JSON.stringify(obj);
    } catch (err) {
      debug(`cannot serialise outgoing frame: ${err.message}`);
      return false;
    }
    ws.send(text, (err) => {
      if (err) debug(`send failed: ${err.message}`);
    });
    return true;
  }

  function sendBinary(buf) {
    if (!isOpen()) return false;
    ws.send(buf, { binary: true, compress: false }, (err) => {
      if (err) debug(`binary send failed: ${err.message}`);
    });
    return true;
  }

  function respond(id, ok, value) {
    if (ok) {
      const frame = { t: 'res', id, ok: true, r: value === undefined ? null : value };
      if (!sendJson(frame) && isOpen()) {
        // The result was not JSON-serialisable: report that instead of leaving the caller hanging.
        sendJson({ t: 'res', id, ok: false, e: 'result is not JSON-serialisable' });
      }
    } else {
      sendJson({ t: 'res', id, ok: false, e: value });
    }
  }

  async function handleRequest(msg) {
    if (!requestHandler) {
      respond(msg.id, false, `unknown method: ${msg.m}`);
      return;
    }
    try {
      const result = await requestHandler(msg.m, msg.p === undefined ? {} : msg.p, msg);
      respond(msg.id, true, result);
    } catch (err) {
      respond(msg.id, false, errorMessage(err));
    }
  }

  function handleResponse(msg) {
    const entry = pending.get(msg.id);
    if (!entry) return; // late / unknown response: ignore
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.r === undefined ? null : msg.r);
    else {
      const err = new Error(typeof msg.e === 'string' && msg.e ? msg.e : 'request failed');
      err.remote = true;
      entry.reject(err);
    }
  }

  function handleEvent(msg) {
    for (const h of eventHandlers) {
      try {
        const r = h(msg.ev, msg.p === undefined ? {} : msg.p, msg);
        if (r && typeof r.catch === 'function') r.catch((err) => debug(`event handler for ${msg.ev} failed: ${errorMessage(err)}`));
      } catch (err) {
        debug(`event handler for ${msg.ev} failed: ${errorMessage(err)}`);
      }
    }
  }

  function onMessage(data, isBinary) {
    const msg = parseFrame(data, isBinary);
    if (!msg) {
      debug('ignored malformed frame');
      return;
    }
    if (msg.t === 'req') handleRequest(msg);
    else if (msg.t === 'res') handleResponse(msg);
    else handleEvent(msg);
  }

  function onClose(code, reason) {
    if (closed && pending.size === 0 && closeHandlers.size === 0) return;
    closed = true;
    ws.off('message', onMessage);
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcClosedError(entry.m));
    }
    pending.clear();
    const handlers = [...closeHandlers];
    closeHandlers.clear();
    for (const h of handlers) {
      try {
        h(code, reason?.toString?.() ?? '');
      } catch (err) {
        debug(`close handler failed: ${errorMessage(err)}`);
      }
    }
  }

  ws.on('message', onMessage);
  ws.once('close', onClose);

  const conn = {
    ws,
    /** Send a request; resolves with `r`, rejects with Error(e) / RpcTimeoutError / RpcClosedError. */
    request(m, p, timeoutMs = defaultTimeoutMs) {
      if (closed || !isOpen()) return Promise.reject(new RpcClosedError(m));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new RpcTimeoutError(m, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer, m });
        const frame = { t: 'req', id, m };
        if (p !== undefined) frame.p = p;
        if (!sendJson(frame)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new RpcClosedError(m));
        }
      });
    },
    /** Fire-and-forget event. Returns false if the socket is not open. */
    notify(ev, p) {
      const frame = { t: 'evt', ev };
      if (p !== undefined) frame.p = p;
      return sendJson(frame);
    },
    /** handler(m, p, rawMsg) → result | Promise<result>; throw to answer ok:false with err.message. */
    onRequest(handler) {
      requestHandler = handler;
    },
    /** handler(ev, p, rawMsg); several handlers may be registered. Returns an unsubscribe function. */
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    /** handler(code, reason) once the socket has closed (pending requests already rejected). */
    onClose(handler) {
      if (closed && ws.readyState === WebSocket.CLOSED) {
        queueMicrotask(() => handler(1006, ''));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    respond,
    sendJson,
    sendBinary,
    isOpen,
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    close(code = 1000, reason = '') {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
  };
  return conn;
}
