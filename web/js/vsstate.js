// Shared, live list of connected VS Code windows (§4.2) used by the Terminals
// and Code tabs. Emits 'windows' (Window[]) whenever the list changes.

import { Emitter } from './conn.js';

export function createVsState(conn) {
  const em = new Emitter();
  let windows = [];
  let loaded = false;

  function set(list) {
    windows = Array.isArray(list) ? list : [];
    loaded = true;
    em.emit('windows', windows);
  }

  let inflight = null;
  /** Fetch the window list (concurrent callers share one request). */
  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        set(await conn.request('vsc.windows'));
      } catch (err) {
        console.warn('[termpocket] vsc.windows failed', err);
      } finally {
        inflight = null;
      }
      return windows;
    })();
    return inflight;
  }

  conn.on('vsc.windows', (p) => set(p.windows));
  conn.on('ready', () => { refresh(); });
  conn.on('down', () => { /* keep last list for display; refreshed on reconnect */ });

  return {
    on: (ev, fn) => em.on(ev, fn),
    refresh,
    get windows() { return windows; },
    get loaded() { return loaded; },
    get(windowId) { return windows.find((w) => w.windowId === windowId) || null; },
    /** Human label for a window: its name, or first folder, or a short id. */
    label(w) {
      if (!w) return 'VS Code';
      if (typeof w === 'string') w = windows.find((x) => x.windowId === w) || { windowId: w };
      return w.name || (w.folders && w.folders[0]) || `Window ${String(w.windowId || '').slice(0, 6)}`;
    },
  };
}
