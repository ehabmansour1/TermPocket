// VS Code hub (PROTOCOL.md §4.2, §5): registry of extension windows on /vscode, `vsc.*` relay for
// phones, event forwarding, and the agent side of mirrored terminals (§5.3).

import { RpcTimeoutError } from './rpc.js';

const CALL_TIMEOUT_MS = 30_000;
const MIRROR_OPEN_TIMEOUT_MS = 30_000;
/** Most mirror terminals one window may re-bind in one request. */
const MAX_REBIND = 200;

/** Extension events that are internal plumbing and are not forwarded to phones as vsc.event. */
const INTERNAL_EVENTS = new Set(['window.update', 'mirror.input', 'mirror.resize', 'mirror.closed']);

/**
 * Clipboard formats a text-only restore brings back faithfully. Anything else (an image, copied files, rich
 * text, …) makes `clipboard.info` answer restorable:false, so the extension's terminal snapshot — which
 * borrows the clipboard — leaves it alone.
 */
export const RESTORABLE_CLIP_FORMATS = /^(UnicodeText|Text|OEMText|Locale|System\.String|CanIncludeInClipboardHistory|CanUploadToCloudClipboard|ExcludeClipboardContentFromMonitorProcessing|Chromium internal source .*)$/;

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []);

/**
 * @param {object} opts
 * @param {object} [opts.log]
 * @param {object} opts.registry       phone registry (broadcast)
 * @param {object} opts.pty            PTY manager (createPtyManager)
 * @param {string} opts.version        agent version (hello result)
 * @param {number} [opts.callTimeoutMs]
 * @param {() => Promise<{formats: string[]}>} [opts.clipboardFormats]  Windows clipboard formats (or set it
 *        later with setClipboardFormats, once the windows helper exists)
 */
export function createVscodeHub({ log, registry, pty, version, callTimeoutMs = CALL_TIMEOUT_MS, clipboardFormats = null }) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  let clipFormats = clipboardFormats;
  /** @type {Map<string, {info: object, conn: object, pid: number|null, remote: string}>} */
  const windows = new Map();

  const windowList = () => [...windows.values()].map((w) => ({ ...w.info, folders: [...w.info.folders] }));
  const broadcastWindows = () => registry?.broadcast('vsc.windows', { windows: windowList() });

  function getWindow(windowId) {
    const w = typeof windowId === 'string' ? windows.get(windowId) : undefined;
    if (!w || !w.conn.isOpen()) throw new Error('vscode window not connected');
    return w;
  }

  // ---- mirror sink used by the PTY manager --------------------------------------------------------
  pty.setMirrorSink({
    hasWindow(windowId) {
      const w = windows.get(windowId);
      return !!(w && w.conn.isOpen());
    },
    open(windowId, session, buffer) {
      const w = getWindow(windowId);
      return w.conn.request('mirror.open', { session, buffer }, MIRROR_OPEN_TIMEOUT_MS);
    },
    data(windowId, ptyId, d) {
      windows.get(windowId)?.conn.notify('mirror.data', { ptyId, d });
    },
    exit(windowId, ptyId, exitCode) {
      windows.get(windowId)?.conn.notify('mirror.exit', { ptyId, exitCode });
    },
  });

  /** Is `ptyId` currently mirrored into `windowId`? (Extensions may only drive their own mirrors.) */
  function ownedSession(windowId, ptyId) {
    const s = pty.get(ptyId);
    return s && s.mirror && s.mirror.windowId === windowId ? s : null;
  }

  function onExtensionEvent(windowId, ev, p) {
    const w = windows.get(windowId);
    if (!w) return;
    const params = p && typeof p === 'object' ? p : {};
    switch (ev) {
      case 'window.update': {
        if (typeof params.name === 'string') w.info.name = str(params.name, 200);
        if (Array.isArray(params.folders)) w.info.folders = strArray(params.folders);
        if (typeof params.focused === 'boolean') w.info.focused = params.focused;
        broadcastWindows();
        return;
      }
      case 'mirror.input': {
        const s = ownedSession(windowId, params.ptyId);
        if (s && !s.exited && typeof params.d === 'string') {
          try {
            pty.input(s.id, params.d);
          } catch (err) {
            logger.debug(`vscode ${windowId}: mirror.input failed: ${err.message}`);
          }
        }
        return;
      }
      case 'mirror.resize': {
        const s = ownedSession(windowId, params.ptyId);
        if (s) {
          try {
            pty.resize(s.id, params.cols, params.rows);
          } catch (err) {
            logger.debug(`vscode ${windowId}: mirror.resize failed: ${err.message}`);
          }
        }
        return;
      }
      case 'mirror.closed': {
        // The user closed the VS Code terminal → the PTY goes away too (§5.3).
        const s = ownedSession(windowId, params.ptyId);
        if (s) {
          pty.clearMirror(s.id);
          try {
            pty.kill(s.id);
          } catch (err) {
            logger.debug(`vscode ${windowId}: mirror.closed kill failed: ${err.message}`);
          }
        }
        return;
      }
      default:
        if (INTERNAL_EVENTS.has(ev)) return;
        registry?.broadcast('vsc.event', { windowId, ev, p: p === undefined ? null : p });
    }
  }

  async function onExtensionRequest(windowId, m, p) {
    if (m === 'pty.create') {
      const params = p && typeof p === 'object' ? p : {};
      const s = await pty.create({
        cwd: params.cwd,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
        shell: params.shell,
        args: params.args,
        vscodeWindowId: windowId,
      });
      await pty.waitForPid(s);
      // Send mirror.open right after the pty.create response has been written, so the extension
      // already knows the session id when mirror.open arrives (lets it recognise its own request).
      setImmediate(() => pty.openMirror(s));
      return pty.toJson(s);
    }
    if (m === 'mirror.rebind') {
      // After (re)connecting — also to a NEW agent process, which learned this windowId from the hello
      // that preceded this request — the window re-binds its mirror terminals to their PTYs (§5.3).
      const params = p && typeof p === 'object' ? p : {};
      const ids = Array.isArray(params.ptyIds) ? [...new Set(params.ptyIds.filter((x) => typeof x === 'string' && x).slice(0, MAX_REBIND))] : [];
      const out = [];
      for (const id of ids) {
        const w = windows.get(windowId);
        if (!w || !w.conn.isOpen()) break; // the window went away meanwhile
        try {
          out.push(await pty.rebindMirror(windowId, id));
        } catch (err) {
          out.push({ ptyId: id, ok: false, gone: false, e: err.message });
        }
      }
      if (ids.length) logger.info(`vscode window ${windowId}: re-bound ${out.filter((r) => r.ok).length}/${ids.length} mirrored terminal(s)`);
      return { sessions: out };
    }
    if (m === 'clipboard.info') {
      // Only the format names leave the agent (never the clipboard text).
      if (!clipFormats) throw new Error('clipboard not available');
      const r = await clipFormats();
      const formats = Array.isArray(r && r.formats) ? r.formats.filter((x) => typeof x === 'string').slice(0, 200) : [];
      return { formats, restorable: formats.every((f) => RESTORABLE_CLIP_FORMATS.test(f)) };
    }
    throw new Error(`unknown method: ${m}`);
  }

  /**
   * Called by server.js after the hello token check. Returns the hello result.
   * @param {object} conn   RPC connection (rpc.makeConn)
   * @param {object} hello  hello params {windowId, name, folders, vscodeVersion, pid}
   */
  function handleVscodeConnection(conn, hello, { remote = '' } = {}) {
    const windowId = str(hello.windowId, 200);
    if (!windowId) throw new Error('hello: windowId required');

    const existing = windows.get(windowId);
    if (existing) {
      // Same window reconnecting before its old socket was noticed dead: replace it. Mirrors that
      // were opened over the old socket are dead on the extension side (§5.3), so detach them.
      logger.info(`vscode window ${windowId} reconnected; replacing old connection`);
      windows.delete(windowId);
      pty.clearMirrorsForWindow(windowId);
      existing.conn.close(4409, 'replaced by a new connection');
    }

    const entry = {
      info: {
        windowId,
        name: str(hello.name, 200) || 'VS Code',
        folders: strArray(hello.folders),
        vscodeVersion: str(hello.vscodeVersion, 50),
        focused: typeof hello.focused === 'boolean' ? hello.focused : false,
        connectedAt: Date.now(),
      },
      conn,
      pid: Number.isInteger(hello.pid) ? hello.pid : null,
      remote,
    };
    windows.set(windowId, entry);

    conn.onRequest((m, p) => onExtensionRequest(windowId, m, p));
    conn.onEvent((ev, p) => onExtensionEvent(windowId, ev, p));
    conn.onClose(() => {
      if (windows.get(windowId) !== entry) return; // already replaced
      windows.delete(windowId);
      pty.clearMirrorsForWindow(windowId);
      logger.info(`vscode window "${entry.info.name}" (${windowId}) disconnected`);
      broadcastWindows();
    });

    logger.info(`vscode window "${entry.info.name}" (${windowId}) connected${entry.pid ? `, pid ${entry.pid}` : ''}`);
    setImmediate(broadcastWindows);
    return { version };
  }

  const methods = {
    'vsc.windows': async () => windowList(),
    'vsc.call': async (p) => {
      let windowId = p.windowId;
      // Convenience: with exactly one window connected, windowId may be omitted.
      if (windowId == null && windows.size === 1) windowId = [...windows.keys()][0];
      const w = getWindow(windowId);
      if (typeof p.m !== 'string' || !p.m) throw new Error('m (method name) required');
      try {
        return await w.conn.request(p.m, p.p === undefined ? {} : p.p, callTimeoutMs);
      } catch (err) {
        if (err instanceof RpcTimeoutError) throw new Error('vscode timeout');
        if (err.code === 'ECONNCLOSED') throw new Error('vscode window disconnected');
        throw err;
      }
    },
  };

  return {
    methods,
    handleVscodeConnection,
    /** Late wiring (index.js): the windows helper's clipboard formats, for `clipboard.info`. */
    setClipboardFormats(fn) {
      clipFormats = typeof fn === 'function' ? fn : null;
    },
    windows: windowList,
    /** Local monitor (/status): connected extension windows. */
    monitorStatus() {
      return {
        vscode: [...windows.values()].map((w) => ({
          windowId: w.info.windowId,
          name: w.info.name,
          folders: [...w.info.folders],
          connectedAt: w.info.connectedAt,
        })),
      };
    },
    async dispose() {
      for (const w of windows.values()) w.conn.close(1001, 'agent shutting down');
      windows.clear();
    },
  };
}
