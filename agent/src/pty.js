// PTY session manager (PROTOCOL.md §4.1, agent side of §5.3).
//
// Sessions are interactive terminals (ConPTY via @lydell/node-pty). The processes, their scrollback
// rings and session metadata live in the PTY host (ptyhost.js, a separate long-lived process), so a
// terminal keeps running when the agent exits or restarts: on start the agent connects to the host
// (spawning it if needed) and ADOPTS its sessions — same ids, same scrollback. This module is the
// agent-side client: it keeps a local view of every session, batches output (≤16 ms) as `pty.data` to
// attached phones and, for mirrored sessions, as `mirror.data` to the VS Code window showing it.
//
// Without `host` (tests) — or when the host cannot be reached — the same core runs in-process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodePty from '@lydell/node-pty';
import { clampInt, createPtyCore, defaultArgs, maxSessionNumber, MAX_INPUT_CHARS, shellTitle } from './ptycore.js';
import { ensurePtyHost, inProcessTransport, resolvePipe } from './ptyhostClient.js';
import { isDemo } from './demo.js';

export { shellTitle };

const BATCH_MS = 16;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** ConPTY reports the shell's pid only once its output pipe is connected (asynchronously). */
const PID_WAIT_MS = 3000;
/** pty.kill: report the exit ourselves if the host never does. */
const KILL_EXIT_FALLBACK_MS = 3000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

/**
 * @param {object} opts
 * @param {object} opts.config     loaded config (defaultShell, scrollbackBytes, configDir)
 * @param {object} [opts.log]
 * @param {object} opts.registry   phone registry (broadcast to all phones)
 * @param {Function} [opts.spawn]  pty spawn implementation for the in-process core (tests)
 * @param {object|string} [opts.host]  'inprocess' (default) or {pipe?, configDir?, autoSpawn?, spawnMethod?,
 *                                     startTimeoutMs?, idleMs?} to use the durable PTY host
 */
export function createPtyManager({ config, log, registry, spawn = nodePty.spawn, host = 'inprocess' }) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const scrollbackBytes = Math.max(1024, Number(config.scrollbackBytes) || 262144);
  /** @type {Map<string, object>} local view of the host's sessions */
  const sessions = new Map();
  let disposed = false;
  let transport = null;
  let maxSeen = 0; // highest session number seen (ids never repeat within this agent's lifetime)
  const hostState = {
    mode: host && typeof host === 'object' ? 'host' : 'inprocess',
    connected: false,
    pid: null,
    pipe: null,
    startedAt: null,
    version: null,
    lastError: null,
    adopted: 0,
    reconnects: 0,
  };

  /**
   * Mirror sink, installed by the VS Code hub:
   * { hasWindow(windowId), open(windowId, sessionJson, buffer), data(windowId, ptyId, d), exit(windowId, ptyId, exitCode) }
   */
  let mirrorSink = null;

  const toJson = (s) => ({
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
    mirror: s.mirror ? { windowId: s.mirror.windowId } : null,
  });

  const list = () => [...sessions.values()].map(toJson);

  let changedTimer = null;
  /** Broadcast pty.changed (coalesced within the same tick so bursts produce one event). */
  function emitChanged() {
    if (changedTimer || disposed) return;
    changedTimer = setImmediate(() => {
      changedTimer = null;
      registry?.broadcast('pty.changed', { sessions: list() });
    });
  }

  function getSession(id) {
    const s = sessions.get(String(id));
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  // ---- transport ----------------------------------------------------------------------------------

  function newLocal(meta) {
    maxSeen = Math.max(maxSeen, maxSessionNumber([meta.id]));
    return {
      id: meta.id,
      title: meta.title,
      shell: meta.shell,
      cwd: meta.cwd,
      cols: meta.cols,
      rows: meta.rows,
      pid: Number.isInteger(meta.pid) && meta.pid > 0 ? meta.pid : null,
      createdAt: meta.createdAt,
      exited: !!meta.exited,
      exitCode: meta.exitCode ?? null,
      mirror: null,
      mirrorHint: meta.mirrorWindowId || null,
      pending: '',
      flushTimer: null,
      attached: new Set(),
    };
  }

  function applyMeta(s, meta) {
    let changed = false;
    for (const k of ['title', 'cols', 'rows', 'cwd']) {
      if (meta[k] !== undefined && meta[k] !== s[k]) {
        s[k] = meta[k];
        changed = true;
      }
    }
    if (Number.isInteger(meta.pid) && meta.pid > 0 && meta.pid !== s.pid) {
      s.pid = meta.pid;
      changed = true;
    }
    if (meta.mirrorWindowId !== undefined) s.mirrorHint = meta.mirrorWindowId || null;
    return changed;
  }

  /** Make the local view match the host's session list (after (re)connecting). */
  function adopt(hostSessions) {
    const seen = new Set();
    let adopted = 0;
    for (const meta of hostSessions || []) {
      if (!meta || typeof meta.id !== 'string') continue;
      seen.add(meta.id);
      const s = sessions.get(meta.id);
      if (s) {
        applyMeta(s, meta);
        if (meta.exited && !s.exited) onExit(s, meta.exitCode);
      } else {
        sessions.set(meta.id, newLocal(meta));
        adopted++;
      }
    }
    // Sessions the host no longer has (it was restarted / crashed): they are gone.
    for (const s of [...sessions.values()]) {
      if (seen.has(s.id)) continue;
      if (!s.exited) onExit(s, null);
      sessions.delete(s.id);
      s.attached.clear();
    }
    if (adopted) logger.info(`adopted ${adopted} running terminal session(s) from the pty host`);
    hostState.adopted += adopted;
    emitChanged();
  }

  function onHostEvent(msg) {
    const s = typeof msg.sid === 'string' ? sessions.get(msg.sid) : null;
    switch (msg.ev) {
      case 'data':
        // (output of a session that is being killed has no listener any more)
        if (s && typeof msg.d === 'string') onData(s, msg.d);
        return;
      case 'exit': {
        if (s) onExit(s, msg.exitCode);
        else {
          const k = killed.get(msg.sid);
          if (k) {
            killed.delete(msg.sid);
            clearTimeout(k.fallback);
            onExit(k.s, msg.exitCode);
          }
        }
        return;
      }
      case 'pid':
        if (s && !s.pid && Number.isInteger(msg.pid) && msg.pid > 0) {
          s.pid = msg.pid;
          emitChanged();
        }
        return;
      case 'meta':
        if (s && msg.session && applyMeta(s, msg.session)) emitChanged();
        return;
      case 'removed':
        // The host pruned an old exited session (ptycore MAX_EXITED_DEFAULT).
        if (s) {
          flush(s);
          if (!s.exited) onExit(s, null);
          sessions.delete(s.id);
          s.attached.clear();
          emitChanged();
        }
        return;
      default:
    }
  }

  function attachTransport(t) {
    transport = t;
    hostState.connected = true;
    hostState.pid = t.hello?.pid ?? null;
    hostState.startedAt = t.hello?.startedAt ?? null;
    hostState.version = t.hello?.version ?? null;
    hostState.lastError = null;
    t.onEvent(onHostEvent);
    t.onClose(() => {
      if (transport !== t) return;
      transport = null;
      hostState.connected = false;
      if (disposed) return;
      logger.warn('lost the connection to the pty host; reconnecting');
      scheduleReconnect();
    });
    adopt(t.hello?.sessions);
  }

  const hostOpts = host && typeof host === 'object' ? host : null;
  if (hostOpts) {
    hostState.pipe = hostOpts.pipe || resolvePipe(hostOpts.configDir || config.configDir);
  }

  async function connectHost() {
    const t = await ensurePtyHost({
      pipe: hostState.pipe,
      configDir: hostOpts.configDir || config.configDir,
      scrollbackBytes,
      firstId: maxSeen + 1,
      idleMs: hostOpts.idleMs,
      autoSpawn: hostOpts.autoSpawn !== false,
      spawnMethod: hostOpts.spawnMethod,
      startTimeoutMs: hostOpts.startTimeoutMs,
      log: logger,
    });
    if (disposed) {
      t.close();
      throw new Error('pty manager disposed');
    }
    return t;
  }

  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  function scheduleReconnect() {
    if (reconnectTimer || disposed) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        const t = await connectHost();
        hostState.reconnects++;
        reconnectDelay = RECONNECT_MIN_MS;
        attachTransport(t);
        logger.info(`reconnected to the pty host (pid ${hostState.pid})`);
      } catch (err) {
        hostState.lastError = err.message;
        reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
        scheduleReconnect();
      }
    }, reconnectDelay);
    reconnectTimer.unref?.();
  }

  function startInProcess(reason) {
    hostState.mode = 'inprocess';
    attachTransport(inProcessTransport(createPtyCore({ spawn, scrollbackBytes, log: logger, firstId: maxSeen + 1 })));
    hostState.lastError = reason || null;
  }

  /** Resolves once a transport is attached (host or in-process). */
  const ready = (async () => {
    if (!hostOpts) {
      startInProcess(null);
      return;
    }
    try {
      attachTransport(await connectHost());
      logger.info(`using pty host pid ${hostState.pid} (${sessions.size} session(s) adopted)`);
    } catch (err) {
      if (disposed) return;
      logger.warn(`pty host unavailable (${err.message}); terminals run inside the agent and end with it`);
      startInProcess(err.message);
    }
  })();

  async function tx() {
    await ready;
    if (!transport) throw new Error('terminal host is reconnecting; try again in a moment');
    return transport;
  }

  // ---- output ------------------------------------------------------------------------------------

  function flush(s) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (!s.pending) return;
    const d = s.pending;
    s.pending = '';
    if (s.attached.size) {
      const text = JSON.stringify({ t: 'evt', ev: 'pty.data', p: { id: s.id, d } });
      for (const client of s.attached) {
        if (client.isOpen()) {
          if (client.sendText) client.sendText(text);
          else client.sendJson(JSON.parse(text));
        } else s.attached.delete(client);
      }
    }
    if (s.mirror && mirrorSink) {
      try {
        mirrorSink.data(s.mirror.windowId, s.id, d);
      } catch (err) {
        logger.debug(`pty ${s.id}: mirror data failed: ${err.message}`);
      }
    }
  }

  function onData(s, d) {
    s.pending += d;
    if (!s.flushTimer) s.flushTimer = setTimeout(() => flush(s), BATCH_MS);
  }

  function onExit(s, exitCode) {
    if (s.exited) return;
    flush(s);
    s.exited = true;
    s.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    logger.info(`pty ${s.id} exited (${s.exitCode})`);
    registry?.broadcast('pty.exit', { id: s.id, exitCode: s.exitCode });
    if (s.mirror && mirrorSink) {
      try {
        mirrorSink.exit(s.mirror.windowId, s.id, s.exitCode);
      } catch (err) {
        logger.debug(`pty ${s.id}: mirror exit failed: ${err.message}`);
      }
    }
    emitChanged();
  }

  /** Resolve once the session has a real pid (or it exited / the wait timed out). */
  function waitForPid(s, timeoutMs = PID_WAIT_MS) {
    if (s.pid || s.exited) return Promise.resolve(s);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (s.pid || s.exited || !sessions.has(s.id) || Date.now() - t0 >= timeoutMs) resolve(s);
        else setTimeout(tick, 10);
      };
      setTimeout(tick, 10);
    });
  }

  // ---- operations --------------------------------------------------------------------------------

  /**
   * Spawn a new session. `vscodeWindowId` marks it as mirrored into that window (the caller —
   * the method handler or the hub — triggers mirror.open via openMirror()). Resolves with the local session.
   */
  async function create(params = {}) {
    if (disposed) throw new Error('agent is shutting down');
    const shell = typeof params.shell === 'string' && params.shell.trim() ? params.shell.trim() : config.defaultShell;
    let args = defaultArgs(shell);
    if (Array.isArray(params.args)) args = params.args.map((a) => String(a));
    else if (typeof params.args === 'string' && params.args.trim()) args = params.args;

    // Demo mode (TERMPOCKET_DEMO=1): new terminals start in TERMPOCKET_DEMO_CWD, so prompts show a sample
    // project instead of this PC's home folder.
    const home = isDemo() && process.env.TERMPOCKET_DEMO_CWD ? process.env.TERMPOCKET_DEMO_CWD : os.homedir();
    let cwd = typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : home;
    cwd = path.resolve(cwd);
    let st;
    try {
      st = fs.statSync(cwd);
    } catch {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

    const cols = clampInt(params.cols, 2, 1000, DEFAULT_COLS);
    const rows = clampInt(params.rows, 1, 500, DEFAULT_ROWS);
    const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim().slice(0, 200) : shellTitle(shell);
    const windowId = typeof params.vscodeWindowId === 'string' && params.vscodeWindowId ? params.vscodeWindowId : null;
    if (windowId && !(mirrorSink && mirrorSink.hasWindow(windowId))) throw new Error('vscode window not connected');

    const t = await tx();
    const env = { ...process.env };
    // Registered synchronously when the reply is dispatched: the session's first output event may
    // already be queued right behind it.
    const s = await t.request('spawn', { shell, args, cwd, cols, rows, title, env, mirrorWindowId: windowId }, (meta) => {
      const local = newLocal(meta);
      local.mirror = windowId ? { windowId } : null;
      sessions.set(local.id, local);
      return local;
    });
    logger.info(`pty ${s.id} started: ${shell}${s.pid ? ` (pid ${s.pid})` : ''} in ${cwd}${windowId ? ` mirrored to ${windowId}` : ''}`);
    emitChanged();
    return s;
  }

  /** Ask the mirroring window to open its terminal for session `s` (fire-and-forget). */
  function openMirror(s) {
    if (!s.mirror || !mirrorSink) return;
    const windowId = s.mirror.windowId;
    let snapshot = null;
    tx()
      .then((t) =>
        t.request('buffer', { sid: s.id }, (r) => {
          // Output up to this reply is in `buffer`: deliver what is pending now, later output follows mirror.open.
          flush(s);
          snapshot = r;
          return r;
        })
      )
      .then(() => {
        if (!s.mirror || s.mirror.windowId !== windowId) return null;
        return mirrorSink.open(windowId, toJson(s), snapshot ? snapshot.buffer : '');
      })
      .then((r) => {
        if (s.mirror && s.mirror.windowId === windowId && r && typeof r === 'object' && r.tid != null) s.mirror.tid = String(r.tid);
      })
      .catch((err) => {
        logger.warn(`pty ${s.id}: mirror.open in ${windowId} failed: ${err.message}`);
        if (s.mirror && s.mirror.windowId === windowId) {
          s.mirror = null;
          emitChanged();
        }
      });
  }

  /**
   * A VS Code window re-binds one of its mirror terminals to session `id` after (re)connecting
   * (PROTOCOL §5.3 mirror.rebind). Resolves {ptyId, ok:true, session, buffer} or {ptyId, ok:false, gone?, e}.
   */
  async function rebindMirror(windowId, id) {
    const s = sessions.get(String(id));
    if (!s) return { ptyId: String(id), ok: false, gone: true, e: 'no such session' };
    // Only the window the session was mirrored into may re-bind it: a window must never take over a
    // phone's own (unmirrored) terminal or another window's mirror — mirror.closed on it would kill it.
    const owner = s.mirror ? s.mirror.windowId : s.mirrorHint;
    if (owner !== windowId) {
      return { ptyId: s.id, ok: false, gone: false, e: owner ? 'shown in another VS Code window' : 'not a mirrored terminal of this window' };
    }
    if (s.mirror && s.mirror.windowId !== windowId && mirrorSink && mirrorSink.hasWindow(s.mirror.windowId)) {
      return { ptyId: s.id, ok: false, gone: false, e: 'shown in another VS Code window' };
    }
    const t = await tx();
    let r;
    try {
      r = await t.request('buffer', { sid: s.id }, (res) => {
        // Not mirrored while flushing: output up to here is in `buffer`; mirror.data from now on.
        s.mirror = null;
        flush(s);
        s.mirror = { windowId };
        s.mirrorHint = windowId;
        return res;
      });
    } catch (err) {
      if (!sessions.has(s.id)) return { ptyId: s.id, ok: false, gone: true, e: 'no such session' };
      throw err;
    }
    t.send('meta', { sid: s.id, mirrorWindowId: windowId });
    emitChanged();
    return { ptyId: s.id, ok: true, session: toJson(s), buffer: r.buffer };
  }

  function input(id, d) {
    const s = getSession(id);
    if (typeof d !== 'string') throw new Error('d must be a string');
    if (d.length > MAX_INPUT_CHARS) throw new Error('input too large');
    if (s.exited) throw new Error('session has exited');
    if (!transport) throw new Error('terminal host is reconnecting; try again in a moment');
    transport.send('input', { sid: s.id, d });
    return true;
  }

  function resize(id, cols, rows) {
    const s = getSession(id);
    const c = clampInt(cols, 2, 1000, NaN);
    const r = clampInt(rows, 1, 500, NaN);
    if (!Number.isFinite(c) || !Number.isFinite(r)) throw new Error('cols and rows must be numbers');
    if (c === s.cols && r === s.rows) return true;
    s.cols = c;
    s.rows = r;
    if (!s.exited && transport) {
      try {
        transport.send('resize', { sid: s.id, cols: c, rows: r });
      } catch (err) {
        logger.debug(`pty ${s.id}: resize failed: ${err.message}`);
      }
    }
    emitChanged();
    return true;
  }

  /** Sessions removed with pty.kill whose exit is still to be reported: sid -> {s, fallback}. */
  const killed = new Map();

  /** Kill the process (if running) and remove the session from the list. */
  function kill(id) {
    const s = getSession(id);
    flush(s);
    sessions.delete(s.id);
    s.attached.clear();
    if (!s.exited) {
      // Phones learn about the exit when the host reports it — or after a short while regardless.
      const fallback = setTimeout(() => {
        killed.delete(s.id);
        onExit(s, null);
      }, KILL_EXIT_FALLBACK_MS);
      fallback.unref?.();
      killed.set(s.id, { s, fallback });
    }
    if (transport) {
      transport.request('kill', { sid: s.id }).catch((err) => logger.debug(`pty ${s.id}: kill failed: ${err.message}`));
    }
    logger.info(`pty ${s.id} removed`);
    emitChanged();
    return true;
  }

  function rename(id, title) {
    const s = getSession(id);
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
    s.title = title.trim().slice(0, 200);
    if (transport) transport.send('meta', { sid: s.id, title: s.title });
    emitChanged();
    return true;
  }

  /** Called by the hub when a VS Code window goes away: its mirrors keep running unmirrored. */
  function clearMirrorsForWindow(windowId) {
    let changed = false;
    for (const s of sessions.values()) {
      if (s.mirror && s.mirror.windowId === windowId) {
        s.mirror = null; // the host keeps the window id as a hint for the window's mirror.rebind
        changed = true;
      }
    }
    if (changed) emitChanged();
  }

  /** Stop mirroring one session (e.g. before killing it on mirror.closed). */
  function clearMirror(id) {
    const s = sessions.get(String(id));
    if (s && s.mirror) {
      s.mirror = null;
      emitChanged();
    }
  }

  const methods = {
    'pty.list': async () => {
      await ready;
      return list();
    },
    'pty.create': async (p) => {
      const s = await create(p);
      if (s.mirror) openMirror(s);
      await waitForPid(s);
      return toJson(s);
    },
    'pty.attach': async (p, client) => {
      await ready;
      const s = getSession(p.id);
      const t = await tx();
      return t.request('buffer', { sid: s.id }, (r) => {
        // Deliver pending output to existing viewers first: the buffer already contains it, and every
        // event dispatched after this reply goes to the new client too.
        flush(s);
        if (client && sessions.has(s.id)) s.attached.add(client);
        return { session: toJson(s), buffer: r.buffer };
      });
    },
    'pty.detach': async (p, client) => {
      const s = sessions.get(String(p.id));
      if (s && client) s.attached.delete(client);
      return true;
    },
    'pty.input': async (p) => {
      await ready;
      return input(p.id, p.d);
    },
    'pty.resize': async (p) => {
      await ready;
      return resize(p.id, p.cols, p.rows);
    },
    'pty.kill': async (p) => {
      await ready;
      return kill(p.id);
    },
    'pty.rename': async (p) => {
      await ready;
      return rename(p.id, p.title);
    },
  };

  /** Local monitor: where the terminals live. */
  function hostStatus() {
    return {
      mode: hostState.mode, // 'host' | 'inprocess'
      running: hostState.mode === 'host' ? hostState.connected : true,
      pid: hostState.mode === 'host' ? hostState.pid : process.pid,
      sessions: sessions.size,
      live: [...sessions.values()].filter((s) => !s.exited).length,
      startedAt: hostState.mode === 'host' ? hostState.startedAt : null,
      version: hostState.version,
      adopted: hostState.adopted,
      reconnects: hostState.reconnects,
      lastError: hostState.lastError,
    };
  }

  return {
    methods,
    ready,
    onClientClose(client) {
      for (const s of sessions.values()) s.attached.delete(client);
    },
    /** Local monitor (/status): sessions with their attached-client counts, and the PTY host. */
    monitorStatus() {
      return {
        terminals: [...sessions.values()].map((s) => ({
          id: s.id,
          title: s.title,
          pid: s.pid,
          exited: s.exited,
          mirror: !!s.mirror,
          attachedClients: s.attached.size,
        })),
        ptyHost: hostStatus(),
      };
    },
    hostStatus,
    /** Local monitor: the sessions a given phone is attached to. */
    describeClient(client) {
      const attached = [];
      for (const s of sessions.values()) if (s.attached.has(client)) attached.push(s.id);
      return { attached };
    },
    /**
     * Agent shutdown. With the PTY host the sessions keep running (only the connection closes);
     * in-process sessions end here.
     */
    async dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      await ready.catch(() => {});
      if (changedTimer) {
        clearImmediate(changedTimer);
        changedTimer = null;
      }
      for (const s of sessions.values()) {
        if (s.flushTimer) clearTimeout(s.flushTimer);
        s.flushTimer = null;
        s.attached.clear();
      }
      for (const k of killed.values()) clearTimeout(k.fallback);
      killed.clear();
      sessions.clear();
      const t = transport;
      transport = null;
      t?.close();
    },
    // --- API for the VS Code hub ---
    setMirrorSink(sink) {
      mirrorSink = sink;
    },
    create,
    waitForPid,
    openMirror,
    rebindMirror,
    toJson,
    list,
    get(id) {
      return sessions.get(String(id)) ?? null;
    },
    input,
    resize,
    kill,
    clearMirror,
    clearMirrorsForWindow,
  };
}
