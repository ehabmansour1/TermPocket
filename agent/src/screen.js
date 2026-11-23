// Screen streaming + remote input (PROTOCOL.md §4.4 and §8).
//
// Streaming model (per phone/laptop client):
//   every 1/fps s: (skip while ≥ 2 frames are un-acked or the socket is backed up)
//     grab the monitor through the helper (scaled to maxWidth, JPEG at quality, hashed)
//     → if the image changed (or nothing was sent for 5 s — keep-alive):
//         send the JSON event  screen.meta {seq, monitor, width, height, cursor}   and right after it
//         the binary frame     [0x01][u32 BE seq][u16 BE monitor][jpeg]            (same seq)
//     → else if only the mouse pointer moved: send screen.meta alone, carrying the seq of the frame the
//       client already has (META WITHOUT FRAME — clients must accept a screen.meta whose seq equals the last
//       frame's seq and just move their cursor marker; it needs no ack and is not flow-controlled).
//   While flow control holds frames back, the pointer is still polled cheaply (helper op `cursor`) so the
//   client's cursor marker keeps moving on a slow link.
// The capture does NOT include the mouse pointer (§8.2): `cursor` = {x, y, visible} normalized 0..1 within the
// captured area, or null when the pointer is outside it. Monitor -1 = the whole virtual desktop (bounding box
// of all monitors); in the binary header it is encoded as u16 0xFFFF.
// Clients that use the same monitor/quality/maxWidth share captures (a grab younger than ~¾ of the frame
// interval is reused), and the helper skips JPEG encoding when the pixels did not change.
//
// Input: normalized coordinates (0..1 within a monitor, or within the virtual desktop for monitor -1) are
// converted to absolute virtual-desktop pixels. input.keyraw injects DOM KeyboardEvent.code keys as hardware
// scan codes (so the PC's own layout applies, like RDP). Keys/buttons each client holds down are tracked and
// released by input.releaseAll, screen.stop and when the client's socket closes. Input requests of one client
// are executed strictly in arrival order.
// With TERMPOCKET_DRYRUN_INPUT=1, input.* only records what it would do in `dryRunLog`.

import {
  clamp,
  dryRunLog,
  invalid,
  isDryRun,
  normalizeLog,
  optEnum,
  optInteger,
  optNumber,
  paramsObject,
  recordDryRun,
} from './winhelper.js';

export { dryRunLog };

export const FRAME_TYPE_SCREEN = 0x01;
export const FRAME_HEADER_BYTES = 7;

const LIMITS = Object.freeze({
  fps: [0.2, 15],
  quality: [10, 90],
  maxWidth: [320, 3840],
});
const BUILTIN_DEFAULTS = Object.freeze({ fps: 2, quality: 50, maxWidth: 1280 });

const MAX_IN_FLIGHT = 2;               // un-acked frames per client (flow control)
const ACK_TIMEOUT_MS = 10_000;         // an un-acked frame older than this is considered lost
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEPALIVE_MS = 5_000;
const MONITOR_CACHE_MS = 5_000;
const GRAB_TIMEOUT_MS = 10_000;
const MAX_ERROR_BACKOFF_MS = 5_000;
const TEXT_MAX_CHARS = 20_000;
const SCROLL_MAX_NOTCHES = 100;

const MOUSE_ACTIONS = ['move', 'click', 'dblclick', 'down', 'up', 'scroll'];
const MOUSE_BUTTONS = ['left', 'right', 'middle'];
const VIRTUAL_DESKTOP = -1;
const MAX_MONITOR_INDEX = 64;

// ------------------------------------------------------------------------------------------- input.keyraw table

/**
 * DOM KeyboardEvent.code → [virtual key, set-1 scan code, flags]. Scan codes ≥ 0xE000 are E0-prefixed
 * ("extended") keys: they are injected with KEYEVENTF_EXTENDEDKEY. Flag 'vk' = inject by virtual key instead of
 * scan code (media / volume keys and Pause, which have no plain make code a layout maps reliably).
 */
const KEY_CODE_TABLE = (() => {
  const t = {};
  const add = (code, vk, scan, flag) => {
    t[code] = { vk, scan, flag };
  };
  // Letters (scan codes follow the physical QWERTY rows).
  const letterScans = {
    Q: 0x10, W: 0x11, E: 0x12, R: 0x13, T: 0x14, Y: 0x15, U: 0x16, I: 0x17, O: 0x18, P: 0x19,
    A: 0x1e, S: 0x1f, D: 0x20, F: 0x21, G: 0x22, H: 0x23, J: 0x24, K: 0x25, L: 0x26,
    Z: 0x2c, X: 0x2d, C: 0x2e, V: 0x2f, B: 0x30, N: 0x31, M: 0x32,
  };
  for (const [ch, scan] of Object.entries(letterScans)) add(`Key${ch}`, ch.charCodeAt(0), scan);
  // Digit row: Digit1..Digit9 = 0x02..0x0A, Digit0 = 0x0B.
  for (let d = 1; d <= 9; d++) add(`Digit${d}`, 0x30 + d, 0x01 + d);
  add('Digit0', 0x30, 0x0b);
  // Function keys.
  const fScans = [0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58,
    0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76];
  fScans.forEach((scan, i) => add(`F${i + 1}`, 0x70 + i, scan));
  // Main block.
  add('Escape', 0x1b, 0x01);
  add('Minus', 0xbd, 0x0c);
  add('Equal', 0xbb, 0x0d);
  add('Backspace', 0x08, 0x0e);
  add('Tab', 0x09, 0x0f);
  add('BracketLeft', 0xdb, 0x1a);
  add('BracketRight', 0xdd, 0x1b);
  add('Enter', 0x0d, 0x1c);
  add('ControlLeft', 0xa2, 0x1d);
  add('Semicolon', 0xba, 0x27);
  add('Quote', 0xde, 0x28);
  add('Backquote', 0xc0, 0x29);
  add('ShiftLeft', 0xa0, 0x2a);
  add('Backslash', 0xdc, 0x2b);
  add('Comma', 0xbc, 0x33);
  add('Period', 0xbe, 0x34);
  add('Slash', 0xbf, 0x35);
  add('ShiftRight', 0xa1, 0x36);
  add('AltLeft', 0xa4, 0x38);
  add('Space', 0x20, 0x39);
  add('CapsLock', 0x14, 0x3a);
  add('IntlBackslash', 0xe2, 0x56);
  add('IntlRo', 0xc1, 0x73);
  add('IntlYen', 0xdc, 0x7d);
  // Right-hand modifiers, Windows and menu keys (extended).
  add('ControlRight', 0xa3, 0xe01d);
  add('AltRight', 0xa5, 0xe038);
  add('MetaLeft', 0x5b, 0xe05b);
  add('MetaRight', 0x5c, 0xe05c);
  add('OSLeft', 0x5b, 0xe05b);   // older Firefox name for MetaLeft
  add('OSRight', 0x5c, 0xe05c);
  add('ContextMenu', 0x5d, 0xe05d);
  // Navigation block (extended).
  add('Insert', 0x2d, 0xe052);
  add('Delete', 0x2e, 0xe053);
  add('Home', 0x24, 0xe047);
  add('End', 0x23, 0xe04f);
  add('PageUp', 0x21, 0xe049);
  add('PageDown', 0x22, 0xe051);
  add('ArrowUp', 0x26, 0xe048);
  add('ArrowDown', 0x28, 0xe050);
  add('ArrowLeft', 0x25, 0xe04b);
  add('ArrowRight', 0x27, 0xe04d);
  add('PrintScreen', 0x2c, 0xe037);
  add('ScrollLock', 0x91, 0x46);
  add('Pause', 0x13, 0x45, 'vk');  // real Pause is the E1 1D 45 sequence: inject by VK
  // Numpad. NumLock shares make code 0x45 with Pause; inject it by VK (reported as an extended key).
  add('NumLock', 0x90, 0xe045, 'vk');
  add('Numpad7', 0x67, 0x47);
  add('Numpad8', 0x68, 0x48);
  add('Numpad9', 0x69, 0x49);
  add('NumpadSubtract', 0x6d, 0x4a);
  add('Numpad4', 0x64, 0x4b);
  add('Numpad5', 0x65, 0x4c);
  add('Numpad6', 0x66, 0x4d);
  add('NumpadAdd', 0x6b, 0x4e);
  add('Numpad1', 0x61, 0x4f);
  add('Numpad2', 0x62, 0x50);
  add('Numpad3', 0x63, 0x51);
  add('Numpad0', 0x60, 0x52);
  add('NumpadDecimal', 0x6e, 0x53);
  add('NumpadMultiply', 0x6a, 0x37);
  add('NumpadDivide', 0x6f, 0xe035);
  add('NumpadEnter', 0x0d, 0xe01c);
  add('NumpadEqual', 0x92, 0x59);
  add('NumpadComma', 0x6c, 0x7e);
  // Media / volume: by virtual key (extended), so they produce WM_APPCOMMAND regardless of the layout.
  add('AudioVolumeMute', 0xad, 0xe020, 'vk');
  add('AudioVolumeDown', 0xae, 0xe02e, 'vk');
  add('AudioVolumeUp', 0xaf, 0xe030, 'vk');
  add('VolumeMute', 0xad, 0xe020, 'vk');   // older DOM names
  add('VolumeDown', 0xae, 0xe02e, 'vk');
  add('VolumeUp', 0xaf, 0xe030, 'vk');
  add('MediaTrackNext', 0xb0, 0xe019, 'vk');
  add('MediaTrackPrevious', 0xb1, 0xe010, 'vk');
  add('MediaStop', 0xb2, 0xe024, 'vk');
  add('MediaPlayPause', 0xb3, 0xe022, 'vk');
  return Object.freeze(t);
})();

/** Every KeyboardEvent.code input.keyraw accepts. */
export const KEY_CODES = Object.freeze(Object.keys(KEY_CODE_TABLE));

/**
 * Map a DOM KeyboardEvent.code to the helper's raw key description:
 * `{code, vk, scan (low byte), ext (E0 prefix → KEYEVENTF_EXTENDEDKEY), vkMode}`.
 * Throws `unknown key code: X` for anything not in the table.
 */
export function resolveKeyCode(code) {
  const e = typeof code === 'string' && Object.hasOwn(KEY_CODE_TABLE, code) ? KEY_CODE_TABLE[code] : undefined;
  if (!e) throw new Error(`unknown key code: ${typeof code === 'string' ? code.slice(0, 64) : String(code)}`);
  return { code, vk: e.vk, scan: e.scan & 0xff, ext: e.scan > 0xff, vkMode: e.flag === 'vk' };
}

/** Bounding box of all monitors = what monitor -1 captures / addresses. */
export function virtualDesktop(monitors) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const m of monitors) {
    l = Math.min(l, m.x);
    t = Math.min(t, m.y);
    r = Math.max(r, m.x + m.width);
    b = Math.max(b, m.y + m.height);
  }
  return { index: VIRTUAL_DESKTOP, name: 'All displays', x: l, y: t, width: r - l, height: b - t, primary: false };
}

// Virtual-key codes for named keys (case-insensitive). The protocol names come first; a few aliases and
// extra keys (media, volume, caps lock…) are accepted too.
const NAMED_KEYS = (() => {
  const map = {
    enter: 0x0d, return: 0x0d,
    escape: 0x1b, esc: 0x1b,
    tab: 0x09,
    backspace: 0x08,
    delete: 0x2e, del: 0x2e,
    up: 0x26, arrowup: 0x26,
    down: 0x28, arrowdown: 0x28,
    left: 0x25, arrowleft: 0x25,
    right: 0x27, arrowright: 0x27,
    home: 0x24,
    end: 0x23,
    pageup: 0x21, pgup: 0x21,
    pagedown: 0x22, pgdn: 0x22,
    space: 0x20,
    insert: 0x2d, ins: 0x2d,
    printscreen: 0x2c, prtsc: 0x2c,
    capslock: 0x14,
    numlock: 0x90,
    scrolllock: 0x91,
    pause: 0x13,
    contextmenu: 0x5d, apps: 0x5d, menu: 0x5d,
    volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf,
    medianext: 0xb0, mediaprev: 0xb1, mediaprevious: 0xb1, mediastop: 0xb2, mediaplaypause: 0xb3,
  };
  for (let i = 1; i <= 24; i++) map[`f${i}`] = 0x6f + i; // F1 = 0x70
  return Object.freeze(map);
})();

const MODIFIER_KEYS = Object.freeze({
  ctrl: 0x11, control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b, meta: 0x5b,
});

/**
 * Resolve an input.key `key` + `mods` to helper args: `{vk, mods}` or `{char, mods}` (punctuation and other
 * characters are resolved by the helper through the active keyboard layout).
 */
export function resolveKey(key, mods) {
  if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string');
  if (mods !== undefined && mods !== null && !Array.isArray(mods)) throw invalid('mods must be an array');
  const modVks = [];
  for (const m of mods || []) {
    const vk = typeof m === 'string' ? MODIFIER_KEYS[m.toLowerCase()] : undefined;
    if (vk === undefined) throw invalid(`unknown modifier: ${String(m)} (ctrl|alt|shift|win)`);
    if (!modVks.includes(vk)) modVks.push(vk);
  }

  const codePoints = [...key];
  if (codePoints.length === 1) {
    const c = codePoints[0];
    if (c >= 'a' && c <= 'z') return { vk: 0x41 + c.charCodeAt(0) - 97, mods: modVks };
    if (c >= 'A' && c <= 'Z') {
      if (!modVks.includes(MODIFIER_KEYS.shift)) modVks.push(MODIFIER_KEYS.shift);
      return { vk: 0x41 + c.charCodeAt(0) - 65, mods: modVks };
    }
    if (c >= '0' && c <= '9') return { vk: 0x30 + c.charCodeAt(0) - 48, mods: modVks };
    if (c === ' ') return { vk: NAMED_KEYS.space, mods: modVks };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(c)) throw invalid('key must not be a control character');
    return { char: c, mods: modVks };
  }
  const vk = NAMED_KEYS[key.toLowerCase()];
  if (vk === undefined) throw invalid(`unknown key: ${key}`);
  return { vk, mods: modVks };
}

/** Normalized (0..1) → absolute virtual-desktop pixel inside `monitor`. */
export function toDesktopPixels(monitor, x, y) {
  const px = monitor.x + clamp(Math.floor(clamp(x, 0, 1) * monitor.width), 0, monitor.width - 1);
  const py = monitor.y + clamp(Math.floor(clamp(y, 0, 1) * monitor.height), 0, monitor.height - 1);
  return { x: px, y: py };
}

/** Build the binary screen frame: [0x01][u32 BE seq][u16 BE monitor][jpeg]. */
export function encodeFrame(seq, monitorIndex, jpeg) {
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt8(FRAME_TYPE_SCREEN, 0);
  header.writeUInt32BE(seq >>> 0, 1);
  header.writeUInt16BE(monitorIndex & 0xffff, 5);
  return Buffer.concat([header, jpeg]);
}

function screenDefaults(config) {
  const s = config && typeof config.screen === 'object' && config.screen ? config.screen : {};
  const pick = (key) => {
    const v = Number(s[key]);
    return Number.isFinite(v) ? clamp(v, LIMITS[key][0], LIMITS[key][1]) : BUILTIN_DEFAULTS[key];
  };
  return {
    fps: pick('fps'),
    quality: Math.round(pick('quality')),
    maxWidth: Math.round(pick('maxWidth')),
  };
}

export function createScreenHandlers({ config, log, helper, keepAliveMs = DEFAULT_KEEPALIVE_MS } = {}) {
  const L = normalizeLog(log);
  if (!helper) throw new Error('createScreenHandlers requires a helper (createWinHelper)');
  const defaults = screenDefaults(config);

  /** @type {Map<object, StreamState>} */
  const streams = new Map();
  /** Shared capture results keyed by `${monitor}|${maxWidth}|${quality}`. */
  const captures = new Map();
  let disposed = false;

  // ------------------------------------------------------------------------------------------- monitors

  let monitorCache = { list: null, at: 0 };
  let monitorFetch = null;

  function fetchMonitors() {
    if (!monitorFetch) {
      monitorFetch = helper
        .call('monitors', {}, { timeoutMs: 10_000 })
        .then((list) => {
          if (!Array.isArray(list) || list.length === 0) throw new Error('no monitors reported');
          monitorCache = { list, at: Date.now() };
          return list;
        })
        .finally(() => {
          monitorFetch = null;
        });
    }
    return monitorFetch;
  }

  async function getMonitors({ fresh = false } = {}) {
    if (!fresh && monitorCache.list && Date.now() - monitorCache.at < MONITOR_CACHE_MS) return monitorCache.list;
    return fetchMonitors();
  }

  async function resolveMonitor(index) {
    let list = await getMonitors();
    if (index === VIRTUAL_DESKTOP) return virtualDesktop(list);
    if (index >= list.length) list = await getMonitors({ fresh: true }); // a monitor may have been plugged in
    const mon = list[index];
    if (!mon) throw new Error(`no such monitor: ${index} (have ${list.length})`);
    return mon;
  }

  function monitorParam(p, def = 0) {
    return optInteger(p, 'monitor', def, VIRTUAL_DESKTOP, MAX_MONITOR_INDEX);
  }

  // ------------------------------------------------------------------------------------------- capture

  /**
   * Grab a frame for these settings, reusing a capture (made for another client) that STARTED less than
   * `maxAgeMs` ago, or one in progress. A cached frame whose hash is `seenHash` (the caller already has it)
   * is never reused: that would turn every other tick into a no-op and halve the frame rate.
   * Returns `{hash, data: Buffer, width, height, cursor}`.
   */
  function capture(monitor, maxWidth, quality, maxAgeMs, seenHash = null) {
    const key = `${monitor}|${maxWidth}|${quality}`;
    let entry = captures.get(key);
    if (!entry) {
      entry = { hash: null, data: null, width: 0, height: 0, cursor: null, at: 0, inflight: null };
      captures.set(key, entry);
    }
    if (entry.inflight) return entry.inflight;
    if (entry.data && Date.now() - entry.at <= maxAgeMs && entry.hash !== seenHash) return Promise.resolve(frameOf(entry));

    const e = entry;
    const startedAt = Date.now(); // the pixels' age counts from the start of the grab, not its end
    e.inflight = helper
      .call(
        'grab',
        // cursor:false → the pointer is NOT drawn into the image; the client draws it from screen.meta (§8.2).
        { monitor, maxWidth, quality, cursor: false, lastHash: e.data ? e.hash : undefined },
        { timeoutMs: GRAB_TIMEOUT_MS },
      )
      .then((r) => {
        if (!r || typeof r.hash !== 'string') throw new Error('bad grab result');
        if (!r.unchanged) {
          if (typeof r.data !== 'string' || !r.data) throw new Error('grab returned no image data');
          e.data = Buffer.from(r.data, 'base64');
        } else if (!e.data) {
          throw new Error('grab reported unchanged without a cached frame');
        }
        e.hash = r.hash;
        e.width = r.width;
        e.height = r.height;
        e.cursor = normalizeCursor(r.pointer);
        e.at = startedAt;
        return frameOf(e);
      })
      .finally(() => {
        e.inflight = null;
      });
    return e.inflight;
  }

  function frameOf(entry) {
    return { hash: entry.hash, data: entry.data, width: entry.width, height: entry.height, cursor: entry.cursor };
  }

  /** Drop cached captures no active stream uses any more (frees the JPEG buffers). */
  function pruneCaptures() {
    const live = new Set();
    for (const s of streams.values()) live.add(`${s.monitor}|${s.maxWidth}|${s.quality}`);
    for (const [key, entry] of captures) {
      if (!live.has(key) && !entry.inflight) captures.delete(key);
    }
  }

  // ------------------------------------------------------------------------------------------- streaming

  /**
   * @typedef {object} StreamState
   * @property {object} client
   * @property {number} monitor  @property {object} monitorInfo
   * @property {number} fps  @property {number} quality  @property {number} maxWidth
   * @property {number} seq  @property {Map<number, number>} inFlight  seq → sentAt
   * @property {string|null} lastHash  @property {number} lastSentAt
   * @property {number} lastWidth  @property {number} lastHeight  size of the last frame sent
   * @property {string|undefined} lastCursorKey  cursor last reported in a screen.meta
   * @property {boolean} cursorPolling
   * @property {NodeJS.Timeout|null} timer  @property {boolean} busy  @property {boolean} blocked
   * @property {boolean} stopped  @property {number} errorStreak
   */

  function interval(state) {
    return 1000 / state.fps;
  }

  function schedule(state, delayMs) {
    if (state.stopped || disposed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      tick(state);
    }, Math.max(0, Math.round(delayMs)));
  }

  /** client → stop generation: bumped by screen.stop / close so a screen.start still resolving its monitor knows it was cancelled. */
  const stopGens = new WeakMap();
  const stopGen = (client) => stopGens.get(client) ?? 0;

  function stopStream(client, reason) {
    if (client) stopGens.set(client, stopGen(client) + 1);
    const state = streams.get(client);
    if (!state) return false;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    streams.delete(client);
    pruneCaptures();
    L.debug(`[screen] stream stopped for client ${client.id ?? '?'}${reason ? ` (${reason})` : ''}`);
    return true;
  }

  function clientOpen(client) {
    try {
      return typeof client.isOpen !== 'function' || client.isOpen();
    } catch {
      return false;
    }
  }

  function bufferedAmount(client) {
    try {
      return Number(client.bufferedAmount) || 0;
    } catch {
      return 0;
    }
  }

  async function tick(state) {
    if (state.stopped || disposed || state.busy) return;
    const { client } = state;
    if (!clientOpen(client)) {
      stopStream(client, 'socket closed');
      return;
    }

    const now = Date.now();
    for (const [seq, sentAt] of state.inFlight) {
      if (now - sentAt > ACK_TIMEOUT_MS) state.inFlight.delete(seq); // lost ack: don't stall forever
    }
    const backedUp = bufferedAmount(client) > MAX_BUFFERED_BYTES;
    if (state.inFlight.size >= MAX_IN_FLIGHT || backedUp) {
      // Flow control: skip capturing; an ack wakes us up early, otherwise re-check next interval.
      // The pointer is still polled (cheap, tiny event) unless the socket itself is backed up.
      state.blocked = true;
      if (!backedUp) pollCursor(state);
      schedule(state, interval(state));
      return;
    }
    state.blocked = false;

    state.busy = true;
    const startedAt = Date.now();
    // Deadline-based cadence: Windows timers fire up to ~15 ms late, so a plain "interval - elapsed" delay
    // drifts below the requested fps. Late wake-ups are made up on the next frame (never by bursting:
    // when we are more than one interval behind, the schedule restarts from now).
    if (!state.nextAt || startedAt - state.nextAt > interval(state)) state.nextAt = startedAt;
    state.nextAt += interval(state);
    const settingsKey = `${state.monitor}|${state.maxWidth}|${state.quality}`;
    let delay = interval(state);
    try {
      // Reuse a capture another client made very recently with the same settings.
      const frame = await capture(state.monitor, state.maxWidth, state.quality, interval(state) * 0.75, state.lastHash);
      if (state.stopped || disposed) return;
      if (settingsKey !== `${state.monitor}|${state.maxWidth}|${state.quality}`) {
        delay = 0; // screen.start changed the settings while we were capturing: grab again right away
      } else {
        const sentLongAgo = Date.now() - state.lastSentAt >= keepAliveMs;
        if (frame.hash !== state.lastHash || sentLongAgo) sendFrame(state, frame);
        else maybeSendCursor(state, frame.cursor);
        delay = state.nextAt - Date.now();
      }
      if (state.errorStreak > 0) L.info(`[screen] capture recovered after ${state.errorStreak} error(s)`);
      state.errorStreak = 0;
    } catch (err) {
      state.errorStreak += 1;
      // Typical cause: the secure desktop (UAC prompt / lock screen) cannot be captured. Keep retrying.
      if (state.errorStreak === 1 || state.errorStreak % 30 === 0) {
        L.warn(`[screen] capture failed (${state.errorStreak}x): ${err.message}`);
      }
      delay = Math.min(MAX_ERROR_BACKOFF_MS, interval(state) * 2 ** Math.min(state.errorStreak, 6));
      state.nextAt = 0;
    } finally {
      state.busy = false;
    }
    schedule(state, Math.max(delay === 0 ? 0 : 5, delay));
  }

  function cursorKey(cursor) {
    return cursor ? `${cursor.x},${cursor.y},${cursor.visible ? 1 : 0}` : 'null';
  }

  /** JSON event screen.meta to this client. Returns false when the socket refused it. */
  function sendMeta(state, seq, width, height, cursor) {
    try {
      state.client.sendJson({
        t: 'evt',
        ev: 'screen.meta',
        p: { seq, monitor: state.monitor, width, height, cursor },
      });
    } catch (err) {
      stopStream(state.client, `send failed: ${err.message}`);
      return false;
    }
    state.lastCursorKey = cursorKey(cursor);
    return true;
  }

  /** Cursor-only update: re-send screen.meta for the frame the client already has (same seq, no binary). */
  function maybeSendCursor(state, cursor) {
    // Only once a frame for the CURRENT settings is on the client: a pointer-only meta must describe the
    // image the client is showing (after a monitor switch the old image is still up until the next frame).
    if (state.stopped || state.seq === 0 || !state.frameCurrent) return;
    if (cursorKey(cursor) === state.lastCursorKey) return;
    sendMeta(state, state.seq, state.lastWidth, state.lastHeight, cursor);
  }

  function pollCursor(state) {
    if (state.cursorPolling || state.seq === 0 || !state.frameCurrent) return;
    state.cursorPolling = true;
    // Only {monitor}: the helper resolves the CURRENT rect itself, exactly like a grab does, so the marker
    // stays right after a resolution / layout change (a rect cached at screen.start would go stale).
    helper
      .call('cursor', { monitor: state.monitor }, { timeoutMs: 2_000 })
      .then((r) => {
        if (!state.stopped && !disposed && r && r.monitor === state.monitor) {
          maybeSendCursor(state, normalizeCursor(r.pointer));
        }
      })
      .catch((err) => L.debug(`[screen] cursor poll failed: ${err.message}`))
      .finally(() => {
        state.cursorPolling = false;
      });
  }

  function sendFrame(state, frame) {
    const seq = state.seq >= 0xffffffff ? 1 : state.seq + 1;
    // §8.2: the meta event goes out right before its binary frame (same socket → same order on arrival).
    if (!sendMeta(state, seq, frame.width, frame.height, frame.cursor)) return;
    state.seq = seq;
    const buf = encodeFrame(seq, state.monitor, frame.data);
    try {
      state.client.sendBinary(buf);
    } catch (err) {
      stopStream(state.client, `send failed: ${err.message}`);
      return;
    }
    const now = Date.now();
    state.inFlight.set(seq, now);
    state.lastHash = frame.hash;
    state.lastSentAt = now;
    state.lastWidth = frame.width;
    state.lastHeight = frame.height;
    state.frameCurrent = true;
  }

  function streamSettings(p, previous) {
    const base = previous || defaults;
    return {
      fps: optNumber(p, 'fps', base.fps, ...LIMITS.fps),
      quality: Math.round(optNumber(p, 'quality', base.quality, ...LIMITS.quality)),
      maxWidth: Math.round(optNumber(p, 'maxWidth', base.maxWidth, ...LIMITS.maxWidth)),
    };
  }

  // ------------------------------------------------------------------------------------------- held input

  /** client → {keys: Map<code, resolvedKey>, buttons: Set<'left'|'right'|'middle'>} (what it holds down). */
  const held = new Map();
  /** client → tail promise of its input queue (input requests of one client run strictly in order). */
  const inputChains = new Map();

  function heldFor(client) {
    let h = held.get(client);
    if (!h) {
      h = { keys: new Map(), buttons: new Set() };
      held.set(client, h);
    }
    return h;
  }

  function trackKey(client, key, down) {
    if (!client) return;
    if (down) {
      const h = heldFor(client);
      h.keys.delete(key.code); // re-insert: release order = reverse press order
      h.keys.set(key.code, key);
    } else {
      const h = held.get(client);
      if (h) h.keys.delete(key.code);
    }
  }

  function trackButton(client, button, action) {
    if (!client) return;
    if (action === 'down') heldFor(client).buttons.add(button);
    else if (action === 'up') {
      const h = held.get(client);
      if (h) h.buttons.delete(button);
    }
  }

  /** Clients whose socket closed: input still queued for them is dropped (a queued key-down must not run after the close). */
  const closedClients = new WeakSet();
  /** Release jobs in flight (close / stop / dispose) — dispose() waits for them. */
  const pendingReleases = new Set();

  /**
   * Run `fn` after every earlier input request of this client has finished (whatever its outcome).
   * Once the client has closed, queued input is skipped (resolves false) unless `always` (the release).
   */
  function serialized(client, fn, always = false) {
    if (!client) return fn();
    const prev = inputChains.get(client) || Promise.resolve();
    const run = prev.then(() => (closedClients.has(client) && !always ? false : fn()));
    const tail = run.then(
      () => {},
      () => {},
    );
    inputChains.set(client, tail);
    tail.then(() => {
      if (inputChains.get(client) === tail) inputChains.delete(client);
    });
    return run;
  }

  /**
   * Release everything `client` holds: key-ups (reverse press order) and button-ups, without moving the pointer.
   * `explicit` = input.releaseAll (always recorded in dry-run, even when nothing is held).
   */
  async function releaseHeld(client, reason, explicit = false, params = undefined) {
    const h = client ? held.get(client) : undefined;
    if (h) held.delete(client);
    const keys = h ? [...h.keys.values()].reverse() : [];
    const buttons = h ? [...h.buttons] : [];
    if (!explicit && keys.length === 0 && buttons.length === 0) return false;
    if (isDryRun()) {
      recordDryRun(L, 'input.releaseAll', params ?? { reason }, { keys: keys.map((k) => k.code), buttons, reason });
      return true;
    }
    if (keys.length === 0 && buttons.length === 0) return true;
    if (!explicit) L.info(`[screen] releasing ${keys.length} key(s) / ${buttons.length} button(s) held by client ${client?.id ?? '?'} (${reason})`);
    await helper.call(
      'release',
      { keys: keys.map(({ vk, scan, ext, vkMode }) => ({ vk, scan, ext, vkMode })), buttons },
      { timeoutMs: 5_000 },
    );
    return true;
  }

  /**
   * Release what the client holds. Always queued behind the client's pending input (and `held` is checked
   * when its turn comes, not now): a key-down still queued when the socket closes or the stream stops is
   * either dropped (closed client) or executed first and then released here.
   */
  function autoRelease(client, reason) {
    if (!client) return Promise.resolve(false);
    if (!held.has(client) && !inputChains.has(client)) return Promise.resolve(false);
    const job = serialized(client, () => (held.has(client) ? releaseHeld(client, reason) : false), true).catch((err) => {
      L.warn(`[screen] could not release held input (${reason}): ${err.message}`);
      return false;
    });
    pendingReleases.add(job);
    job.finally(() => pendingReleases.delete(job));
    return job;
  }

  // ------------------------------------------------------------------------------------------- methods

  const methods = {
    async 'screen.monitors'() {
      return getMonitors({ fresh: true });
    },

    async 'screen.start'(params, client) {
      if (disposed) throw new Error('screen module disposed');
      if (!client || typeof client.sendBinary !== 'function') throw new Error('screen.start requires a client socket');
      const p = paramsObject(params);
      const previous = streams.get(client);
      const monitor = monitorParam(p, previous ? previous.monitor : 0);
      const settings = streamSettings(p, previous);
      const gen = stopGen(client);
      const monitorInfo = await resolveMonitor(monitor);
      if (disposed) throw new Error('screen module disposed');
      // A screen.stop (or the socket closing) arrived while we were resolving the monitor: requests run
      // concurrently, so honour it instead of starting a stream nothing would ever stop.
      if (stopGen(client) !== gen || !clientOpen(client)) {
        L.debug(`[screen] screen.start for client ${client.id ?? '?'} cancelled by a stop during monitor lookup`);
        return { monitor: monitorInfo, ...settings, stopped: true };
      }

      let state = streams.get(client);
      if (state) {
        // Update in place; force a fresh frame (and meta) for the new settings.
        Object.assign(state, settings, { monitor, monitorInfo, lastHash: null, lastCursorKey: undefined, nextAt: 0, frameCurrent: false });
        pruneCaptures();
      } else {
        state = {
          client,
          monitor,
          monitorInfo,
          ...settings,
          seq: 0,
          inFlight: new Map(),
          lastHash: null,
          lastSentAt: 0,
          lastWidth: 0,
          lastHeight: 0,
          lastCursorKey: undefined,
          frameCurrent: false,
          cursorPolling: false,
          nextAt: 0,
          timer: null,
          busy: false,
          blocked: false,
          stopped: false,
          errorStreak: 0,
        };
        streams.set(client, state);
        L.debug(`[screen] stream started for client ${client.id ?? '?'}`);
      }
      if (!state.busy) schedule(state, 0);
      return { monitor: monitorInfo, fps: state.fps, quality: state.quality, maxWidth: state.maxWidth };
    },

    async 'screen.ack'(params, client) {
      const p = paramsObject(params);
      if (!Number.isInteger(p.seq) || p.seq < 0) throw invalid('seq must be a non-negative integer');
      const state = client ? streams.get(client) : undefined;
      if (!state) return true;
      // Cumulative: acking seq N also releases every earlier frame.
      for (const seq of state.inFlight.keys()) {
        if (seq <= p.seq) state.inFlight.delete(seq);
      }
      if (state.blocked && !state.busy && state.inFlight.size < MAX_IN_FLIGHT) {
        state.blocked = false;
        const due = Math.max(0, state.lastSentAt + interval(state) - Date.now());
        schedule(state, due);
      }
      return true;
    },

    async 'screen.stop'(params, client) {
      if (client) {
        stopStream(client, 'screen.stop');
        await autoRelease(client, 'screen.stop'); // §8.1: stopping the stream releases held keys/buttons
      }
      return true;
    },

    async 'screen.snapshot'(params) {
      const p = paramsObject(params);
      const monitor = monitorParam(p);
      const quality = Math.round(optNumber(p, 'quality', defaults.quality, ...LIMITS.quality));
      const maxWidth = Math.round(optNumber(p, 'maxWidth', defaults.maxWidth, ...LIMITS.maxWidth));
      await resolveMonitor(monitor);
      // Snapshots keep the pointer drawn into the image (there is no meta event to carry it).
      const r = await helper.call('grab', { monitor, maxWidth, quality }, { timeoutMs: GRAB_TIMEOUT_MS });
      if (!r || typeof r.data !== 'string') throw new Error('capture failed');
      return { mime: 'image/jpeg', data: r.data, width: r.width, height: r.height };
    },

    async 'input.mouse'(params, client) {
      const p = paramsObject(params);
      const monitor = monitorParam(p);
      for (const k of ['x', 'y']) {
        if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw invalid(`${k} must be a number (0..1)`);
      }
      const action = optEnum(p, 'action', MOUSE_ACTIONS);
      const button = optEnum(p, 'button', MOUSE_BUTTONS, 'left');
      let delta = 0;
      let deltaX = 0;
      if (action === 'scroll') {
        const hasY = p.delta !== undefined && p.delta !== null;
        const hasX = p.deltaX !== undefined && p.deltaX !== null;
        if (!hasY && !hasX) throw invalid('delta must be a number for scroll (or deltaX)');
        if (hasY) {
          if (typeof p.delta !== 'number' || !Number.isFinite(p.delta)) throw invalid('delta must be a number for scroll');
          delta = clamp(p.delta, -SCROLL_MAX_NOTCHES, SCROLL_MAX_NOTCHES);
        }
        if (hasX) {
          if (typeof p.deltaX !== 'number' || !Number.isFinite(p.deltaX)) throw invalid('deltaX must be a number');
          deltaX = clamp(p.deltaX, -SCROLL_MAX_NOTCHES, SCROLL_MAX_NOTCHES);
        }
      }
      return serialized(client, async () => {
        const mon = await resolveMonitor(monitor);
        const { x, y } = toDesktopPixels(mon, p.x, p.y);
        const args = { x, y, action, button, delta, deltaX };
        trackButton(client, button, action);
        if (isDryRun()) {
          recordDryRun(L, 'input.mouse', p, { monitor, ...args });
          return true;
        }
        await helper.call('mouse', args, { timeoutMs: 5_000 });
        return true;
      });
    },

    async 'input.key'(params, client) {
      const p = paramsObject(params);
      const resolved = resolveKey(p.key, p.mods);
      return serialized(client, async () => {
        if (isDryRun()) {
          recordDryRun(L, 'input.key', p, resolved);
          return true;
        }
        await helper.call('key', resolved, { timeoutMs: 5_000 });
        return true;
      });
    },

    async 'input.keyraw'(params, client) {
      const p = paramsObject(params);
      if (typeof p.code !== 'string' || !p.code) throw invalid('code must be a non-empty string (KeyboardEvent.code)');
      if (typeof p.down !== 'boolean') throw invalid('down must be a boolean');
      const key = resolveKeyCode(p.code);
      return serialized(client, async () => {
        trackKey(client, key, p.down);
        const args = { vk: key.vk, scan: key.scan, ext: key.ext, vkMode: key.vkMode, up: !p.down };
        if (isDryRun()) {
          recordDryRun(L, 'input.keyraw', p, { code: key.code, ...args });
          return true;
        }
        await helper.call('keyraw', args, { timeoutMs: 5_000 });
        return true;
      });
    },

    async 'input.releaseAll'(params, client) {
      const p = paramsObject(params);
      await serialized(client, () => releaseHeld(client, 'input.releaseAll', true, p));
      return true;
    },

    async 'input.text'(params, client) {
      const p = paramsObject(params);
      if (typeof p.text !== 'string') throw invalid('text must be a string');
      if (p.text.length > TEXT_MAX_CHARS) throw invalid(`text is too long (max ${TEXT_MAX_CHARS} characters)`);
      return serialized(client, async () => {
        if (isDryRun()) {
          recordDryRun(L, 'input.text', p, { text: p.text, length: p.text.length });
          return true;
        }
        if (!p.text) return true;
        await helper.call('text', { text: p.text }, { timeoutMs: 10_000 + p.text.length * 5 });
        return true;
      });
    },
  };

  return {
    methods,
    onClientClose(client) {
      if (client) closedClients.add(client);
      stopStream(client, 'client closed');
      // §8.1: never leave a key / button stuck down on the PC when a client disappears mid-drag or mid-chord.
      return autoRelease(client, 'client closed');
    },
    async dispose() {
      disposed = true;
      for (const client of [...streams.keys()]) stopStream(client, 'dispose');
      captures.clear();
      // Best effort, bounded: release whatever is still held before the helper goes away.
      for (const client of [...held.keys()]) autoRelease(client, 'dispose');
      const pending = [...pendingReleases];
      if (pending.length) {
        let timer;
        await Promise.race([
          Promise.all(pending),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 2_000);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      }
    },
    /** Local monitor (/status): number of active streams. */
    monitorStatus() {
      return { screen: { streams: streams.size } };
    },
    /** Local monitor: is this phone streaming the screen? */
    describeClient(client) {
      const s = streams.get(client);
      return { streaming: !!s && !s.stopped };
    },
    /** Number of active streams (diagnostics / tests). */
    get activeStreams() {
      return streams.size;
    },
    /** Keys / buttons a client currently holds (diagnostics / tests). */
    heldInput(client) {
      const h = held.get(client);
      return { keys: h ? [...h.keys.keys()] : [], buttons: h ? [...h.buttons] : [] };
    },
  };
}

/** Helper `pointer` → protocol `cursor` ({x, y, visible} clamped 0..1) or null. */
function normalizeCursor(p) {
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1), visible: p.visible !== false };
}
