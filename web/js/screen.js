// Screen tab: remote desktop viewer + mouse/keyboard input (§4.4).
//
// Frames arrive as binary WebSocket messages [0x01][u32 seq][u16 monitor][JPEG…].
// They are decoded with createImageBitmap, drawn on a <canvas>, and acknowledged
// (screen.ack) after drawing so the agent's flow control (≤2 in flight) keeps
// latency low on slow links. Pinch-zoom/pan is a pure client-side view transform.
//
// Gestures
//   Touch mode:    tap = click · double-tap = double-click · long-press = right-click ·
//                  long-press + drag = left-drag · two-finger vertical drag = scroll ·
//                  pinch = zoom · one-finger drag while zoomed = pan
//   Trackpad mode: drag moves the pointer · tap = click · double-tap = double-click ·
//                  two-finger tap = right-click · long-press + drag = left-drag ·
//                  two-finger vertical drag = scroll · pinch = zoom

import {
  h, btn, iconBtn, toast, toastError, actionSheet, sheet, confirmDialog, setChildren, segmented,
  store, clamp, throttle, haptic, noFocusSteal, spinner, edgeFade,
} from './ui.js';
import { icon } from './icons.js';
import { createRdp, createWheelAccumulator, wheelToNotches } from './rdp.js';
import { isDesktop, hasFinePointer } from './layout.js';

const PRESETS = {
  low: { fps: 1, quality: 35, maxWidth: 960 },
  medium: { fps: 2, quality: 50, maxWidth: 1280 },
  high: { fps: 4, quality: 65, maxWidth: 1920 },
  hd: { fps: 10, quality: 65, maxWidth: 1920 }, // §8.2 — desktop / Remote Desktop
};
const PRESET_LABELS = { low: 'Low', medium: 'Medium', high: 'High', hd: 'HD' };
const ALL_DISPLAYS = -1;
const MON_ALL_WIRE = 0xffff; // u16 monitor field of a binary frame for monitor -1

const KEY_NAMES = {
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', PrintScreen: 'PrintScreen', ' ': 'Space',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

const SHORTCUTS = [
  { label: 'Copy', key: 'c', mods: ['ctrl'] },
  { label: 'Paste', key: 'v', mods: ['ctrl'] },
  { label: 'Cut', key: 'x', mods: ['ctrl'] },
  { label: 'Undo', key: 'z', mods: ['ctrl'] },
  { label: 'Redo', key: 'y', mods: ['ctrl'] },
  { label: 'Select all', key: 'a', mods: ['ctrl'] },
  { label: 'Save', key: 's', mods: ['ctrl'] },
  { label: 'Find', key: 'f', mods: ['ctrl'] },
  { label: 'Switch window', key: 'Tab', mods: ['alt'] },
  { label: 'Show desktop', key: 'd', mods: ['win'] },
  { label: 'File Explorer', key: 'e', mods: ['win'] },
  { label: 'Run…', key: 'r', mods: ['win'] },
  { label: 'Task Manager', key: 'Escape', mods: ['ctrl', 'shift'] },
  { label: 'Close window', key: 'F4', mods: ['alt'], confirm: true },
];

const SENTINEL = '\u200B\u200B';
const LONG_PRESS_MS = 480;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 270;
const SCROLL_STEP_PX = 36;

export function createScreenTab(panel, app) {
  const { conn } = app;
  let monitors = [];
  let monitorIdx = Number(store.get('screenMonitor', 0)) || 0;
  let preset = PRESETS[store.get('screenPreset', 'medium')] ? store.get('screenPreset', 'medium') : 'medium';
  let mode = store.get('screenMode', 'touch') === 'trackpad' ? 'trackpad' : 'touch';
  let wantPlaying = true;
  let visible = false;
  let streaming = false;
  let starting = false;
  /** Bumped by every startStream/stopStream: a screen.start answer for an older generation is stale. */
  let streamGen = 0;
  let streamMon = null;
  let immersive = false;
  let hasFrame = false;
  // Remote Desktop mode (§8.3)
  let rdpOn = false;
  let rdpPreset = PRESETS[store.get('rdpPreset', 'hd')] ? store.get('rdpPreset', 'hd') : 'hd';
  let viewMode = ['fit', 'width', 'native'].includes(store.get('rdpView', 'fit')) ? store.get('rdpView', 'fit') : 'fit';
  // PC pointer position from screen.meta (the capture itself has no cursor)
  let remoteCur = null;

  // view transform
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let fitScale = 1;
  // trackpad cursor (normalised)
  const cur = { x: 0.5, y: 0.5 };

  // modifiers for keyboard input: 0 off · 1 one-shot · 2 locked
  const mods = { ctrl: 0, alt: 0, shift: 0, win: 0 };

  // stats
  const frameLog = []; // {t, bytes}

  /* ---------------------------------------------------------------- DOM */

  const canvas = h('canvas', { class: 'screen-canvas', width: 16, height: 9, 'aria-label': 'Remote screen' });
  const g2d = canvas.getContext('2d', { alpha: false });
  const placeholder = h('div', { class: 'stage-msg' });
  const cursorEl = h('div', { class: 'remote-cursor', hidden: true, 'aria-hidden': 'true' }, icon('pointer', { size: 22 }));
  const pcPointer = h('div', { class: 'pc-pointer', hidden: true, 'aria-hidden': 'true' }, icon('pointer', { size: 20 }));
  const stats = h('div', { class: 'stage-stats mono', 'aria-live': 'off' });
  const exitImmersive = iconBtn('minimize', 'Exit full screen', () => setImmersive(false), { cls: 'stage-exit' });
  exitImmersive.hidden = true;
  const stage = h('div', { class: 'stage', tabIndex: -1 }, canvas, pcPointer, cursorEl, placeholder, stats, exitImmersive);

  const monitorBtn = h('button', { type: 'button', class: 'chip-btn', onClick: () => chooseMonitor() });
  const presetSeg = segmented([
    { value: 'low', label: 'Low' }, { value: 'medium', label: 'Med' }, { value: 'high', label: 'High' }, { value: 'hd', label: 'HD' },
  ], preset, (v) => { preset = v; store.set('screenPreset', v); if (streaming && !rdpOn) startStream(); }, { cls: 'seg-sm' });
  presetSeg.el.lastElementChild.classList.add('desk-only'); // HD: desktop layout only (phones keep 3 presets)
  presetSeg.el.lastElementChild.title = 'HD: 10 fps, quality 65, 1920 px';
  const modeBtn = h('button', { type: 'button', class: 'chip-btn mode-btn', onClick: () => setMode(mode === 'touch' ? 'trackpad' : 'touch') });
  const playBtn = iconBtn('pause', 'Pause', () => togglePlay());
  const rdpBtn = btn('Remote Desktop', {
    iconName: 'remote', variant: 'primary', small: true, cls: 'rdp-enter desk-only',
    title: 'Full-screen remote control with mouse & keyboard (Ctrl+Alt+Enter)', onClick: () => enterRdp(),
  });
  const bar = h('div', { class: 'screen-bar' },
    monitorBtn, presetSeg.el,
    h('div', { class: 'screen-bar-end' }, modeBtn, playBtn, iconBtn('more', 'More', () => showMenu()), rdpBtn));

  const kbdInput = h('input', {
    class: 'kbd-proxy', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    'aria-label': 'Keyboard input for the PC', enterKeyHint: 'enter',
  });
  kbdInput.setAttribute('autocorrect', 'off');
  const kbdBtn = h('button', { type: 'button', class: 'xkey ico-key kbd-toggle', 'aria-label': 'Keyboard' }, icon('keyboard', { size: 18 }));
  noFocusSteal(kbdBtn);
  kbdBtn.addEventListener('click', () => toggleKeyboard());
  const modBtns = {};
  const keyRow = h('div', { class: 'xkeys screen-keys', role: 'toolbar', 'aria-label': 'Keys' },
    kbdBtn,
    modKey('ctrl', 'Ctrl'), modKey('alt', 'Alt'), modKey('shift', 'Shift'), modKey('win', 'Win'),
    key('Esc', 'Escape'), key('Tab', 'Tab'), key('⏎', 'Enter', 'Enter'), key('⌫', 'Backspace', 'Backspace'), key('Del', 'Delete'),
    key('←', 'Left', 'Left'), key('↑', 'Up', 'Up'), key('↓', 'Down', 'Down'), key('→', 'Right', 'Right'),
    key('Home', 'Home'), key('End', 'End'), key('PgUp', 'PageUp'), key('PgDn', 'PageDown'),
    actionKey('F1–F12', () => fnSheet()), actionKey('Shortcuts', () => shortcutSheet()));
  edgeFade(keyRow);

  const tabRoot = h('div', { class: 'screen-tab', 'data-rdp': 'off' }, bar, stage, keyRow, kbdInput);
  panel.append(tabRoot);

  renderMonitorBtn();
  renderMode();
  renderPlay();
  renderPlaceholder();

  /* ---------------------------------------------------- remote desktop */

  const rdp = createRdp({
    conn, app, root: tabRoot, stage, canvas, presets: PRESETS,
    monitorIndex: () => monitorIndex(),
    hasPicture: () => hasFrame && placeholder.hidden,
    stats: () => statsNow(),
    monitors: () => monitors,
    currentMonitor: () => monitorIdx,
    selectMonitor: (idx) => selectMonitor(idx),
    monitorLabel: (idx) => (idx === ALL_DISPLAYS ? 'All displays' : monitorLabel(monitors.find((m) => m.index === idx) || (streamMon && streamMon.index === idx ? streamMon : { index: idx }))),
    getPreset: () => rdpPreset,
    setPreset: (v) => { if (!PRESETS[v]) return; rdpPreset = v; store.set('rdpPreset', v); rdp.refresh(); if (streaming || starting) startStream(); },
    presetLabel: (v) => PRESET_LABELS[v] || v,
    getViewMode: () => viewMode,
    setViewMode: (m) => { viewMode = m; store.set('rdpView', m); layout(true); },
    panBy: (dx, dy) => {
      const x0 = tx;
      const y0 = ty;
      tx += dx; ty += dy;
      clampView();
      applyView();
      return Math.abs(tx - x0) > 0.01 || Math.abs(ty - y0) > 0.01;
    },
    overflow: () => {
      const { w, h: sh } = stageSize();
      const s = fitScale * zoom;
      return { x: canvas.width * s > w + 1, y: canvas.height * s > sh + 1 };
    },
    setLocalCursorHidden: (on) => stage.classList.toggle('hide-local-cursor', !!on),
    onEnter: () => {
      rdpOn = true;
      wantPlaying = true;
      renderPlay();
      if (immersive) setImmersive(false);
      if (document.activeElement === kbdInput) kbdInput.blur();
      stage.classList.add('rdp');
      if (streaming || starting) startStream(); else ensureStream();
      requestAnimationFrame(() => layout(true));
    },
    onExit: () => {
      rdpOn = false;
      stage.classList.remove('rdp');
      if (streaming || starting) startStream(); else ensureStream();
      requestAnimationFrame(() => layout(true));
    },
  });

  function enterRdp() {
    if (!visible) return;
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    rdp.enter();
  }

  // Ctrl+Alt+Enter (or Ctrl+Alt+Break, as in mstsc) starts Remote Desktop from the Screen tab.
  window.addEventListener('keydown', (e) => {
    if (!visible || rdp.active || !e.ctrlKey || !e.altKey) return;
    if (e.code === 'Enter' || e.code === 'Pause' || e.key === 'Cancel') {
      if (document.querySelector('#layers .sheet-backdrop.in, #layers .dialog-backdrop.in')) return;
      e.preventDefault();
      enterRdp();
    }
  });

  /* -------------------------------------------------------- connection */

  conn.on('binary', onBinary);
  conn.on('ready', () => { streaming = false; loadMonitors(); ensureStream(); });
  conn.on('down', () => { streamGen++; streaming = false; starting = false; remoteCur = null; placePcPointer(); renderPlaceholder(); });
  conn.on('screen.meta', onMeta);
  document.addEventListener('visibilitychange', () => ensureStream());

  async function loadMonitors() {
    try {
      const list = await conn.request('screen.monitors');
      monitors = Array.isArray(list) ? list : [];
      const known = monitors.some((m) => m.index === monitorIdx) || (monitorIdx === ALL_DISPLAYS && monitors.length > 1);
      if (monitors.length && !known) monitorIdx = monitors.find((m) => m.primary)?.index ?? monitors[0].index;
      renderMonitorBtn();
      rdp.refresh();
    } catch (err) {
      console.warn('[termpocket] screen.monitors failed', err);
    }
  }

  /** screen.meta {seq, monitor, width, height, cursor} — sent before every frame, and on its own
   *  when only the pointer moved. Applied at once: the marker may lead the picture slightly. */
  function onMeta(m) {
    if (!m || typeof m !== 'object') return;
    if (m.monitor != null && Number(m.monitor) !== monitorIndex() && !(monitorIndex() === ALL_DISPLAYS && Number(m.monitor) === MON_ALL_WIRE)) return;
    const c = m.cursor;
    remoteCur = c && c.visible !== false && Number.isFinite(c.x) && Number.isFinite(c.y)
      ? { x: clamp(c.x, 0, 1), y: clamp(c.y, 0, 1) } : null;
    placePcPointer();
  }

  function shouldStream() {
    return visible && wantPlaying && conn.online && document.visibilityState === 'visible';
  }

  function ensureStream() {
    if (shouldStream()) { if (!streaming && !starting) startStream(); }
    else if (streaming || starting) stopStream();
    renderPlaceholder();
  }

  async function startStream() {
    if (!conn.online) return;
    starting = true;
    const gen = ++streamGen;
    renderPlaceholder();
    const wantMon = monitorIdx;
    try {
      const r = await conn.request('screen.start', { monitor: wantMon, ...PRESETS[rdpOn ? rdpPreset : preset] });
      if (gen !== streamGen) {
        // stopStream() (or a newer start) ran while this start was in flight. Our screen.stop may have
        // reached the agent before this start began streaming: stop again unless a newer start now owns
        // the stream (the agent updates a stream in place, so stopping would kill the newer one).
        if (!starting && !streaming && !(r && r.stopped) && conn.online) conn.request('screen.stop').catch(() => {});
        return;
      }
      starting = false;
      if (r && r.stopped) { renderPlaceholder(); return; }
      if (!shouldStream()) { stopStream(); return; }
      streaming = true;
      streamMon = r && r.monitor ? r.monitor : streamMon;
      if (streamMon && streamMon.index !== monitorIdx && Number.isInteger(streamMon.index) && wantMon !== ALL_DISPLAYS) monitorIdx = streamMon.index;
      renderMonitorBtn();
      rdp.refresh();
    } catch (err) {
      if (gen !== streamGen) return; // superseded by a stop / newer start
      starting = false;
      streaming = false;
      if (wantMon === ALL_DISPLAYS && conn.online && noAllDisplaysSupport(err)) {
        // Older agents only know real monitors: show the primary one for now, but do not overwrite the
        // saved choice (a transient capture error or timeout must not lose "All displays" for good).
        toast('This PC agent can’t stream all displays at once yet — showing the primary display', { type: 'warn', timeout: 4200 });
        const prim = monitors.find((m) => m.primary) || monitors[0];
        selectMonitor(prim ? prim.index : 0, { persist: false });
        return;
      }
      if (conn.online) toastError(err, 'Screen');
    }
    renderPlaceholder();
  }

  /** Only a validation error about the monitor index (or an unknown method) means "no monitor -1 support". */
  function noAllDisplaysSupport(err) {
    if (!err || err.name !== 'RpcError') return false;
    return /unknown method|monitor must be between 0\b|no such monitor: -1\b/i.test(String(err.message || ''));
  }

  function stopStream() {
    const was = streaming || starting;
    streamGen++;
    streaming = false;
    starting = false;
    if (was && conn.online) conn.request('screen.stop').catch(() => {});
    renderPlaceholder();
  }

  /* ------------------------------------------------------------ frames */

  const queue = [];
  let decoding = false;

  function onBinary(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 0x01) return;
    const seq = dv.getUint32(1, false);
    let mon = dv.getUint16(5, false);
    if (mon === MON_ALL_WIRE) mon = ALL_DISPLAYS;
    queue.push({ seq, mon, bytes: new Uint8Array(buf, 7), size: buf.byteLength, at: performance.now() });
    pump();
  }

  /** A frame belongs to the display we asked for (frames of the previous one are dropped). */
  function frameMatches(mon) {
    if (mon === monitorIdx) return true;
    // "All displays" on an agent that labels the frame differently: there is only one stream per client.
    return monitorIdx === ALL_DISPLAYS && !!streamMon && (streamMon.index === mon || streamMon.index === ALL_DISPLAYS);
  }

  async function pump() {
    if (decoding) return;
    decoding = true;
    try {
      while (queue.length) {
        // Only the newest frame is worth drawing; acknowledge the rest immediately.
        const batch = queue.splice(0, queue.length);
        const frame = batch.pop();
        for (const f of batch) ack(f.seq);
        let drawn = false;
        if (streaming && frameMatches(frame.mon)) {
          try {
            const img = await decode(frame.bytes);
            draw(img);
            if (typeof img.close === 'function') img.close();
            drawn = true;
          } catch (err) {
            console.warn('[termpocket] frame decode failed', err);
          }
        }
        ack(frame.seq);
        // latency = frame received → drawn and acknowledged
        if (drawn) frameLog.push({ t: performance.now(), bytes: frame.size, lat: performance.now() - frame.at });
      }
    } finally {
      decoding = false;
    }
  }

  function ack(seq) {
    if (conn.online) conn.request('screen.ack', { seq }).catch(() => {});
  }

  function decode(bytes) {
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad JPEG')); };
      img.src = url;
    });
  }

  function draw(img) {
    const w = img.width;
    const hgt = img.height;
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
      layout(true);
    }
    g2d.drawImage(img, 0, 0);
    if (!hasFrame) { hasFrame = true; renderPlaceholder(); placePcPointer(); }
  }

  function statsNow() {
    const now = performance.now();
    while (frameLog.length && now - frameLog[0].t > 3000) frameLog.shift();
    const fps = frameLog.length / 3;
    const kbs = frameLog.reduce((a, f) => a + f.bytes, 0) / 3 / 1024;
    const latency = frameLog.length ? frameLog.reduce((a, f) => a + f.lat, 0) / frameLog.length : 0;
    return { fps, kbs, latency, w: canvas.width, h: canvas.height };
  }

  setInterval(() => {
    const s = statsNow();
    if (!streaming) { stats.hidden = true; return; }
    stats.hidden = false;
    stats.textContent = `${s.fps.toFixed(1)} fps · ${s.kbs.toFixed(s.kbs < 10 ? 1 : 0)} KB/s · ${s.w}×${s.h}${s.latency ? ` · ${Math.round(s.latency)} ms` : ''}`;
  }, 1000);

  /* ---------------------------------------------------------- view xf */

  function stageSize() {
    return { w: stage.clientWidth || 1, h: stage.clientHeight || 1 };
  }

  function layout(reset = false) {
    const { w, h: sh } = stageSize();
    if (rdpOn && viewMode === 'native') fitScale = 1 / (window.devicePixelRatio || 1); // 1 frame px = 1 device px
    else if (rdpOn && viewMode === 'width') fitScale = w / canvas.width || 1;
    else fitScale = Math.min(w / canvas.width, sh / canvas.height) || 1;
    if (reset || rdpOn) zoom = 1; // Remote Desktop has no pinch zoom: the view mode decides the scale
    if (reset) { tx = 0; ty = 0; }
    clampView();
    applyView();
  }

  function clampView() {
    const { w, h: sh } = stageSize();
    const s = fitScale * zoom;
    const cw = canvas.width * s;
    const ch = canvas.height * s;
    tx = cw <= w ? (w - cw) / 2 : clamp(tx, w - cw, 0);
    ty = ch <= sh ? (sh - ch) / 2 : clamp(ty, sh - ch, 0);
  }

  function applyView() {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${fitScale * zoom})`;
    placeCursor();
    placePcPointer();
  }

  /** The PC's own pointer (from screen.meta), drawn over the picture. */
  function placePcPointer() {
    const show = !!remoteCur && hasFrame && (rdpOn || mode !== 'trackpad');
    pcPointer.hidden = !show;
    stage.classList.toggle('has-pc-pointer', show);
    if (!show) return;
    const s = fitScale * zoom;
    pcPointer.style.transform = `translate(${tx + remoteCur.x * canvas.width * s}px, ${ty + remoteCur.y * canvas.height * s}px)`;
  }

  function zoomAt(newZoom, cx, cy) {
    const z = clamp(newZoom, 1, 8);
    const s0 = fitScale * zoom;
    const s1 = fitScale * z;
    // keep the image point under (cx, cy) fixed
    const ix = (cx - tx) / s0;
    const iy = (cy - ty) / s0;
    zoom = z;
    tx = cx - ix * s1;
    ty = cy - iy * s1;
    clampView();
    applyView();
  }

  new ResizeObserver(() => layout(false)).observe(stage);

  function placeCursor() {
    cursorEl.hidden = mode !== 'trackpad' || !hasFrame || rdpOn;
    if (cursorEl.hidden) return;
    const s = fitScale * zoom;
    cursorEl.style.transform = `translate(${tx + cur.x * canvas.width * s}px, ${ty + cur.y * canvas.height * s}px)`;
  }

  /** Client coordinates → normalised monitor coordinates (0..1). */
  function toNorm(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp((clientX - r.left) / (r.width || 1), 0, 1),
      y: clamp((clientY - r.top) / (r.height || 1), 0, 1),
    };
  }

  function stagePoint(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /* ------------------------------------------------------------ input */

  function monitorIndex() {
    return streamMon && Number.isInteger(streamMon.index) ? streamMon.index : monitorIdx;
  }

  function mouse(action, pos, extra = {}) {
    if (!conn.online) return Promise.resolve();
    return conn.request('input.mouse', { monitor: monitorIndex(), x: pos.x, y: pos.y, action, ...extra })
      .catch((err) => {
        if (action !== 'move') toastError(err, 'Mouse');
      });
  }

  const sendMove = throttle((pos) => mouse('move', pos), 45);

  function ripple(clientX, clientY, cls = '') {
    const p = stagePoint(clientX, clientY);
    const el = h('span', { class: ['ripple', cls] });
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    stage.append(el);
    setTimeout(() => el.remove(), 500);
  }

  let pendingTap = null;
  function handleTap(pos, clientX, clientY) {
    const now = performance.now();
    if (pendingTap && now - pendingTap.t < DOUBLE_TAP_MS && Math.abs(pendingTap.x - pos.x) < 0.04 && Math.abs(pendingTap.y - pos.y) < 0.04) {
      clearTimeout(pendingTap.timer);
      pendingTap = null;
      ripple(clientX, clientY, 'double');
      mouse('dblclick', pos, { button: 'left' });
      return;
    }
    const tap = { t: now, x: pos.x, y: pos.y, timer: 0 };
    tap.timer = setTimeout(() => {
      if (pendingTap === tap) pendingTap = null;
      mouse('click', pos, { button: 'left' });
    }, DOUBLE_TAP_MS);
    pendingTap = tap;
    ripple(clientX, clientY);
  }

  // Pointer gesture state machine -------------------------------------------
  const pts = new Map(); // pointerId → {x, y, sx, sy}
  let gesture = null;

  stage.addEventListener('pointerdown', (e) => {
    if (rdpOn) return; // Remote Desktop mode has its own mouse handling (rdp.js)
    // Controls inside the stage (exit button, the overlay's Resume button) are not remote input,
    // and nothing is sent while the overlay (paused / offline / waiting) covers the picture.
    // Capturing the pointer here would also swallow those buttons' clicks.
    if (e.target.closest('button, a, input, .stage-msg')) return;
    if (!hasFrame || !placeholder.hidden) return;
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pts.size === 1) {
      gesture = { kind: 'one', t0: performance.now(), moved: false, long: false, drag: false, lpTimer: 0, lastX: e.clientX, lastY: e.clientY };
      const g = gesture;
      g.lpTimer = setTimeout(() => {
        if (gesture === g && !g.moved) { g.long = true; haptic(18); ripple(e.clientX, e.clientY, 'long'); }
      }, LONG_PRESS_MS);
    } else if (pts.size === 2) {
      if (gesture && gesture.kind === 'one') {
        clearTimeout(gesture.lpTimer);
        if (gesture.drag) endDrag();
      }
      const [a, b] = [...pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture = {
        kind: 'two', t0: performance.now(), type: null, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid0: mid, lastMid: mid, zoom0: zoom, acc: 0, scrollPos: mode === 'trackpad' ? { ...cur } : toNorm(mid.x, mid.y),
      };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p || !gesture) return;
    p.x = e.clientX; p.y = e.clientY;
    if (gesture.kind === 'one') oneMove(p, e);
    else if (gesture.kind === 'two' && pts.size >= 2) twoMove();
  });

  const endPointer = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    if (!gesture) return;
    const g = gesture;
    if (g.kind === 'one' && pts.size === 0) {
      clearTimeout(g.lpTimer);
      if (e.type === 'pointercancel') { if (g.drag) endDrag(); gesture = null; return; }
      if (g.drag) endDrag();
      else if (!g.moved) {
        if (g.long) {
          const pos = mode === 'trackpad' ? { ...cur } : toNorm(p.sx, p.sy);
          mouse('click', pos, { button: 'right' });
        } else {
          handleTap(mode === 'trackpad' ? { ...cur } : toNorm(p.sx, p.sy), p.sx, p.sy);
        }
      }
      gesture = null;
    } else if (g.kind === 'two') {
      if (pts.size === 0) {
        if (!g.type && performance.now() - g.t0 < 350 && e.type !== 'pointercancel') {
          // two-finger tap → right click
          const pos = mode === 'trackpad' ? { ...cur } : g.scrollPos;
          ripple(g.mid0.x, g.mid0.y, 'long');
          mouse('click', pos, { button: 'right' });
        }
        gesture = null;
      }
      // one finger remaining: ignore until all lifted
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  function oneMove(p, e) {
    const g = gesture;
    const dist = Math.hypot(p.x - p.sx, p.y - p.sy);
    if (!g.moved && dist < (mode === 'trackpad' ? 4 : TAP_SLOP)) return;
    if (!g.moved) {
      g.moved = true;
      clearTimeout(g.lpTimer);
      if (g.long) startDrag(p);
    }
    const dx = e.clientX - g.lastX;
    const dy = e.clientY - g.lastY;
    g.lastX = e.clientX; g.lastY = e.clientY;
    if (g.drag) {
      if (mode === 'trackpad') moveCursorBy(dx, dy);
      sendMove(mode === 'trackpad' ? { ...cur } : toNorm(e.clientX, e.clientY));
      return;
    }
    if (mode === 'trackpad') {
      moveCursorBy(dx, dy);
      sendMove({ ...cur });
    } else if (zoom > 1.001) {
      tx += dx; ty += dy;
      clampView();
      applyView();
    }
  }

  function moveCursorBy(dx, dy) {
    const r = canvas.getBoundingClientRect();
    const speed = 1.4 + Math.min(1.6, Math.hypot(dx, dy) / 25); // light acceleration
    cur.x = clamp(cur.x + (dx * speed) / (r.width || 1), 0, 1);
    cur.y = clamp(cur.y + (dy * speed) / (r.height || 1), 0, 1);
    placeCursor();
  }

  function startDrag(p) {
    gesture.drag = true;
    const pos = mode === 'trackpad' ? { ...cur } : toNorm(p.sx, p.sy);
    haptic(10);
    mouse('move', pos).then(() => mouse('down', pos, { button: 'left' }));
    gesture.dragPos = pos;
  }

  function endDrag() {
    const g = gesture;
    if (!g || !g.drag) return;
    g.drag = false;
    const last = [...pts.values()][0];
    const pos = mode === 'trackpad' ? { ...cur } : (last ? toNorm(last.x, last.y) : g.dragPos);
    // make sure the trailing throttled move is flushed before releasing
    setTimeout(() => mouse('up', pos || g.dragPos, { button: 'left' }), 60);
  }

  function twoMove() {
    const g = gesture;
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ratio = d / g.d0;
    const mdx = mid.x - g.mid0.x;
    const mdy = mid.y - g.mid0.y;
    if (!g.type) {
      if (Math.abs(ratio - 1) > 0.12) g.type = 'pinch';
      else if (Math.hypot(mdx, mdy) > 14) g.type = Math.abs(mdy) >= Math.abs(mdx) ? 'scroll' : 'pan';
      else return;
    }
    if (g.type === 'pinch') {
      const sp = stagePoint(mid.x, mid.y);
      const lp = stagePoint(g.lastMid.x, g.lastMid.y);
      tx += sp.x - lp.x;
      ty += sp.y - lp.y;
      zoomAt(g.zoom0 * ratio, sp.x, sp.y);
    } else if (g.type === 'pan') {
      tx += mid.x - g.lastMid.x;
      ty += mid.y - g.lastMid.y;
      clampView();
      applyView();
    } else if (g.type === 'scroll') {
      g.acc += mid.y - g.lastMid.y;
      while (Math.abs(g.acc) >= SCROLL_STEP_PX) {
        const dir = g.acc > 0 ? 1 : -1; // fingers down → content moves down → wheel up (+)
        g.acc -= dir * SCROLL_STEP_PX;
        mouse('scroll', g.scrollPos, { delta: dir });
      }
    }
    g.lastMid = mid;
  }

  // Desktop browsers: wheel scrolls the PC, ctrl+wheel zooms the view.
  const wheelAcc = createWheelAccumulator();
  stage.addEventListener('wheel', (e) => {
    if (rdpOn) return;
    if (!hasFrame || !placeholder.hidden) return;
    e.preventDefault();
    if (e.ctrlKey) {
      const sp = stagePoint(e.clientX, e.clientY);
      zoomAt(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), sp.x, sp.y);
      return;
    }
    // Same conversion as Remote Desktop: classic wheel ticks → exact notches, pixel deltas (trackpads,
    // smooth scrolling) accumulated at 120 px per notch; horizontal wheel → deltaX (never "down").
    const n = wheelToNotches(wheelAcc, e, { pagePx: stage.clientHeight });
    if (n.y || n.x) mouse('scroll', toNorm(e.clientX, e.clientY), { delta: n.y, deltaX: n.x });
  }, { passive: false });

  /* ---------------------------------------------------------- keyboard */

  let lastValue = SENTINEL;
  let composing = false;
  kbdInput.value = SENTINEL;

  function toggleKeyboard() {
    if (document.activeElement === kbdInput) kbdInput.blur();
    else { resetProxy(); kbdInput.focus({ preventScroll: true }); }
  }

  function resetProxy() {
    kbdInput.value = SENTINEL;
    lastValue = SENTINEL;
    try { kbdInput.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* ignore */ }
  }

  kbdInput.addEventListener('focus', () => kbdBtn.classList.add('locked'));
  kbdInput.addEventListener('blur', () => kbdBtn.classList.remove('locked'));
  kbdInput.addEventListener('compositionstart', () => { composing = true; });
  kbdInput.addEventListener('compositionend', () => {
    composing = false;
    flushDiff();
    resetProxy();
  });
  kbdInput.addEventListener('input', () => {
    flushDiff();
    if (!composing) resetProxy();
  });
  kbdInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified') return;
    const name = KEY_NAMES[e.key];
    const hasMods = e.ctrlKey || e.altKey || e.metaKey;
    if (name && !(name === 'Space' && !hasMods && !anyMod())) {
      e.preventDefault();
      sendKey(name, modsFromEvent(e));
      return;
    }
    if (hasMods && /^[a-z0-9]$/i.test(e.key)) {
      e.preventDefault();
      sendKey(e.key.toLowerCase(), modsFromEvent(e));
    }
  });

  function modsFromEvent(e) {
    const m = [];
    if (e.ctrlKey) m.push('ctrl');
    if (e.altKey) m.push('alt');
    if (e.shiftKey) m.push('shift');
    if (e.metaKey) m.push('win');
    return m;
  }

  /** Compare the proxy input with its previous value; send the difference. */
  function flushDiff() {
    const v = kbdInput.value;
    if (v === lastValue) return;
    let i = 0;
    while (i < lastValue.length && i < v.length && lastValue[i] === v[i]) i++;
    const removed = lastValue.length - i;
    const added = v.slice(i).replace(/\u200B/g, '');
    lastValue = v;
    for (let k = 0; k < removed; k++) sendKey('Backspace', []);
    if (added) typeText(added);
  }

  function typeText(text) {
    if (anyMod() && text.length === 1 && /^[a-z0-9 ]$/i.test(text)) {
      sendKey(text === ' ' ? 'Space' : text.toLowerCase(), []);
      return;
    }
    if (!conn.online) return;
    conn.request('input.text', { text }).catch((err) => toastError(err, 'Typing'));
  }

  function anyMod() { return Object.values(mods).some((v) => v > 0); }

  /** Send a key with the given + sticky modifiers; consumes one-shot modifiers. */
  function sendKey(name, extraMods = []) {
    const all = new Set(extraMods);
    for (const [k, v] of Object.entries(mods)) if (v) all.add(k);
    for (const k of Object.keys(mods)) if (mods[k] === 1) mods[k] = 0;
    renderMods();
    if (!conn.online) return;
    const p = { key: name };
    if (all.size) p.mods = [...all];
    conn.request('input.key', p).catch((err) => toastError(err, 'Key'));
  }

  function modKey(name, label) {
    const b = h('button', { type: 'button', class: 'xkey mod', 'aria-pressed': 'false' }, label);
    noFocusSteal(b);
    b.addEventListener('click', () => { mods[name] = (mods[name] + 1) % 3; haptic(4); renderMods(); });
    modBtns[name] = b;
    return b;
  }

  function renderMods() {
    for (const [k, b] of Object.entries(modBtns)) {
      b.classList.toggle('once', mods[k] === 1);
      b.classList.toggle('locked', mods[k] === 2);
      b.setAttribute('aria-pressed', String(mods[k] > 0));
    }
  }

  function key(label, name, aria) {
    const b = h('button', { type: 'button', class: 'xkey', 'aria-label': aria || label }, label);
    noFocusSteal(b);
    b.addEventListener('click', () => { haptic(4); sendKey(name); });
    return b;
  }

  function actionKey(label, fn) {
    const b = h('button', { type: 'button', class: 'xkey wide' }, label);
    noFocusSteal(b);
    b.addEventListener('click', fn);
    return b;
  }

  function fnSheet() {
    const s = sheet({
      title: 'Function keys',
      subtitle: anyMod() ? 'Active modifiers are applied' : '',
      content: h('div', { class: 'key-grid' }, Array.from({ length: 12 }, (_, i) => {
        const b = h('button', { type: 'button', class: 'xkey big' }, `F${i + 1}`);
        b.addEventListener('click', () => { sendKey(`F${i + 1}`); s.close(); });
        return b;
      }), ['Insert', 'PrintScreen'].map((k) => {
        const b = h('button', { type: 'button', class: 'xkey big' }, k === 'PrintScreen' ? 'PrtSc' : 'Ins');
        b.addEventListener('click', () => { sendKey(k); s.close(); });
        return b;
      })),
    });
  }

  function shortcutSheet() {
    actionSheet({
      title: 'Shortcuts',
      subtitle: 'Sent to the PC',
      actions: SHORTCUTS.map((sc) => ({
        label: sc.label,
        sub: [...sc.mods.map((m) => m[0].toUpperCase() + m.slice(1)), sc.key.length === 1 ? sc.key.toUpperCase() : sc.key].join(' + '),
        iconName: 'keyboard',
        onSelect: async () => {
          if (sc.confirm) {
            const ok = await confirmDialog({ title: `${sc.label}?`, message: 'Sends Alt+F4 to the window that has focus on the PC.', confirmText: 'Send', danger: true });
            if (!ok) return;
          }
          if (!conn.online) return;
          conn.request('input.key', { key: sc.key, mods: sc.mods }).catch((err) => toastError(err, 'Shortcut'));
        },
      })),
    });
  }

  /* ------------------------------------------------------------ chrome */

  /** Device names like "\\.\DISPLAY1" or "DISPLAY1" mean nothing to people: number them instead. */
  function friendlyName(m) {
    const name = String((m && m.name) || '').trim();
    return name && !/^(\\\\\.\\)?DISPLAY\d+$/i.test(name) ? name : '';
  }

  function monitorLabel(m) {
    if (m && m.index === ALL_DISPLAYS) return 'All displays';
    if (!m) return monitorIdx === ALL_DISPLAYS ? 'All displays' : `Display ${monitorIdx + 1}`;
    return `${friendlyName(m) || `Display ${m.index + 1}`}${m.primary ? ' ★' : ''}`;
  }

  function renderMonitorBtn() {
    if (monitorIdx === ALL_DISPLAYS) {
      setChildren(monitorBtn, icon('monitor', { size: 16 }), h('span', { class: 'mon-name' }, h('span', { class: 'mon-word' }, 'All '), 'displays'),
        icon('chevronDown', { size: 14 }));
      monitorBtn.setAttribute('aria-label', 'Display: All displays');
      return;
    }
    const m = monitors.find((x) => x.index === monitorIdx) || streamMon;
    const idx = m ? m.index : monitorIdx;
    const named = friendlyName(m);
    // Narrow phones hide the word "Display" (CSS) and keep the number and the primary star.
    setChildren(monitorBtn, icon('monitor', { size: 16 }),
      named
        ? h('span', { class: 'mon-name ellipsis' }, named)
        : h('span', { class: 'mon-name' }, h('span', { class: 'mon-word' }, 'Display '), String(idx + 1)),
      m && m.primary ? h('span', { class: 'mon-star', title: 'Primary display' }, '★') : null,
      monitors.length > 1 ? icon('chevronDown', { size: 14 }) : null);
    monitorBtn.setAttribute('aria-label', `Display: ${monitorLabel(m)}`);
  }

  function chooseMonitor() {
    if (!monitors.length) { loadMonitors(); toast('No monitor list yet'); return; }
    const actions = monitors.map((m) => ({
      label: `${monitorLabel(m)}${m.index === monitorIdx ? '  ✓' : ''}`,
      sub: `${m.width}×${m.height} at ${m.x},${m.y}${m.primary ? ' · primary' : ''}`,
      iconName: 'monitor',
      onSelect: () => selectMonitor(m.index),
    }));
    if (monitors.length > 1) {
      const minX = Math.min(...monitors.map((m) => m.x));
      const minY = Math.min(...monitors.map((m) => m.y));
      const w = Math.max(...monitors.map((m) => m.x + m.width)) - minX;
      const hh = Math.max(...monitors.map((m) => m.y + m.height)) - minY;
      actions.push({
        label: `All displays${monitorIdx === ALL_DISPLAYS ? '  ✓' : ''}`,
        sub: `${w}×${hh} · the whole virtual desktop`,
        iconName: 'layers',
        onSelect: () => selectMonitor(ALL_DISPLAYS),
      });
    }
    actionSheet({ title: 'Choose display', actions });
  }

  function selectMonitor(idx, { persist = true } = {}) {
    if (idx === monitorIdx) return;
    monitorIdx = idx;
    if (persist) store.set('screenMonitor', monitorIdx);
    hasFrame = false;
    remoteCur = null;
    placePcPointer();
    renderMonitorBtn();
    rdp.refresh();
    if (streaming || starting) startStream();
    renderPlaceholder();
  }

  function setMode(m) {
    mode = m;
    store.set('screenMode', m);
    renderMode();
    toast(m === 'trackpad' ? 'Trackpad: drag to move the pointer, tap to click' : 'Touch: tap where you want to click', { timeout: 1800 });
  }

  function renderMode() {
    const label = mode === 'touch' ? 'Touch' : 'Trackpad';
    setChildren(modeBtn, icon(mode === 'touch' ? 'hand' : 'mouse', { size: 16 }), h('span', { class: 'mode-label' }, label));
    modeBtn.setAttribute('aria-label', `Input mode: ${label} (tap to switch)`);
    modeBtn.title = `${label} mode — tap to switch`;
    stage.classList.toggle('trackpad', mode === 'trackpad');
    placeCursor();
    placePcPointer();
  }

  function togglePlay() {
    wantPlaying = !wantPlaying;
    renderPlay();
    ensureStream();
  }

  function renderPlay() {
    setChildren(playBtn, icon(wantPlaying ? 'pause' : 'play', { size: 20 }));
    playBtn.setAttribute('aria-label', wantPlaying ? 'Pause stream' : 'Resume stream');
    playBtn.title = wantPlaying ? 'Pause stream' : 'Resume stream';
  }

  function renderPlaceholder() {
    let msg = null;
    if (!conn.online) msg = [icon('wifiOff', { size: 26 }), h('span', null, 'Not connected to the PC')];
    else if (!wantPlaying) {
      msg = [icon('pause', { size: 26 }), h('span', null, 'Stream paused'),
        btn('Resume', { small: true, iconName: 'play', variant: 'primary', onClick: () => togglePlay() })];
    } else if (!hasFrame) msg = [spinner(starting || streaming ? 'Waiting for the first frame…' : 'Starting stream…')];
    placeholder.hidden = !msg;
    if (msg) setChildren(placeholder, msg);
    stage.classList.toggle('dimmed', !!msg && hasFrame);
  }

  function setImmersive(on) {
    immersive = on;
    document.body.classList.toggle('immersive', on);
    exitImmersive.hidden = !on;
    requestAnimationFrame(() => layout(false));
  }

  function snapshot() {
    if (!hasFrame) { toast('No frame yet'); return; }
    canvas.toBlob((blob) => {
      if (!blob) { toast('Snapshot failed', { type: 'err' }); return; }
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const a = h('a', { href: url, download: `screen-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/jpeg', 0.9);
  }

  function showMenu() {
    actionSheet({
      title: 'Screen',
      subtitle: `${PRESETS[preset].fps} fps · quality ${PRESETS[preset].quality} · max ${PRESETS[preset].maxWidth}px`,
      actions: [
        (isDesktop() || hasFinePointer()) && {
          label: 'Remote Desktop', sub: 'Full screen with mouse & hardware keyboard (Ctrl+Alt+Enter)', iconName: 'remote', onSelect: () => enterRdp(),
        },
        { label: immersive ? 'Exit full screen' : 'Full screen view', iconName: immersive ? 'minimize' : 'maximize', onSelect: () => setImmersive(!immersive) },
        { label: 'Reset zoom', iconName: 'fit', onSelect: () => layout(true) },
        { label: mode === 'touch' ? 'Switch to Trackpad mode' : 'Switch to Touch mode', iconName: mode === 'touch' ? 'mouse' : 'hand', onSelect: () => setMode(mode === 'touch' ? 'trackpad' : 'touch') },
        { label: 'Save snapshot', sub: 'Downloads the current frame', iconName: 'camera', onSelect: snapshot },
        { label: 'Gesture help', iconName: 'info', onSelect: () => sheet({
          title: 'Gestures',
          content: h('dl', { class: 'help-list' },
            h('dt', null, 'Touch mode'), h('dd', null, 'Tap = click · double-tap = double-click · long-press = right-click · long-press then drag = drag · two fingers up/down = scroll · pinch = zoom · drag while zoomed = pan'),
            h('dt', null, 'Trackpad mode'), h('dd', null, 'Drag = move pointer · tap = click · double-tap = double-click · two-finger tap = right-click · long-press then drag = drag · two fingers up/down = scroll'),
            h('dt', null, 'Keyboard'), h('dd', null, 'Tap ⌨ and type. Ctrl / Alt / Shift / Win: tap once for the next key, twice to lock.'),
            h('dt', null, 'Bandwidth'), h('dd', null, 'Only changed frames are sent. Use Low on mobile data; streaming pauses when you leave this tab.')),
        }) },
      ],
    });
  }

  return {
    onShow() {
      visible = true;
      if (conn.online && !monitors.length) loadMonitors();
      requestAnimationFrame(() => layout(false));
      ensureStream();
    },
    onHide() {
      visible = false;
      if (rdp.active) rdp.exit();
      if (immersive) setImmersive(false);
      if (document.activeElement === kbdInput) kbdInput.blur();
      ensureStream();
    },
  };
}
