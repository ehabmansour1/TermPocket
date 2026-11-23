// Remote Desktop mode (PROTOCOL §8.3) — the Screen tab's canvas fills the window (Fullscreen API)
// and behaves like an RDP client:
//
//   * real mouse: pointermove → input.mouse move (throttled to ~30/s, coalesced, ≤2 in flight);
//     pointerdown/up per button → down/up (drag & drop, selection; the OS builds double-clicks);
//     wheel → scroll with delta/deltaX (pixel & line deltas accumulated, 120 px = 1 notch);
//     context menu and middle-click autoscroll suppressed.
//   * full keyboard: keydown/keyup → input.keyraw {code, down} with preventDefault (auto-repeat is
//     sent as further key-downs, like a real keyboard); navigator.keyboard.lock() in fullscreen so
//     Win / Alt+Tab / Esc reach the PC too. Falls back to input.key / input.text when the agent
//     doesn't know input.keyraw yet.
//   * blur / visibilitychange / leaving → input.releaseAll (fallback: release what we hold).
//   * clipboard sync (secure context, optional): local → PC when the view gains focus, PC → local
//     ~300 ms after Ctrl+C / Ctrl+X. Never blocks when permission is denied.
//   * auto-hiding top toolbar: exit, display, quality, view (fit / fit width / 1:1), Task Manager
//     (Ctrl+Shift+Esc), Win, Alt+Tab, clipboard push/pull, keyboard-lock status, live stats.
//
// screen.js owns the stream, the canvas and its view transform; it hands this module a `host`.

import { h, iconBtn, toast, toastError, popover, popoverOpen, closePopover, layerOpen, store, clamp, setChildren } from './ui.js';
import { icon } from './icons.js';

const MOVE_MS = 33;          // ~30 moves per second
const MAX_MOVES_IN_FLIGHT = 2;
const SCROLL_MS = 33;
const NOTCH = 120;           // px of wheel delta per notch
const LINE_PX = 40;          // deltaMode 1: one line ≈ 40 px (3 lines = 1 notch)
const WHEEL_IDLE_MS = 600;   // a pixel remainder older than this belongs to an earlier gesture

/** Per-surface wheel state for wheelToNotches(). */
export function createWheelAccumulator() {
  return { y: 0, x: 0, at: 0 };
}

/**
 * One wheel event → whole PC wheel notches {y: +up, x: +right} (PROTOCOL §8.3).
 * A classic wheel tick is recognised by its wheelDelta, which Chrome/Edge report as exactly ±120 per
 * physical notch whatever the Windows "lines per notch" setting or the page zoom (deltaY varies with
 * both: ~33 px at 1 line, 200+ px at 6 lines or low zoom) → exactly wheelDelta/120 notches, so one
 * physical notch is one PC notch (the PC then applies its own lines setting once). Everything else
 * (trackpads, smooth / high-resolution wheels) is accumulated at 120 px per notch.
 */
export function wheelToNotches(acc, e, { pagePx = 800, now = performance.now() } = {}) {
  if (now - acc.at > WHEEL_IDLE_MS) { acc.y = 0; acc.x = 0; }
  acc.at = now;
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? Math.max(pagePx, NOTCH) : 1;
  const tick = (wd) => Number.isFinite(wd) && wd !== 0 && wd % NOTCH === 0;
  const out = { y: 0, x: 0 };
  if (tick(e.wheelDeltaY)) { out.y += e.wheelDeltaY / NOTCH; acc.y = 0; } // wheelDeltaY > 0 = up
  else if (e.deltaY) acc.y = accumulate(acc.y, -e.deltaY * unit);
  if (tick(e.wheelDeltaX)) { out.x += -e.wheelDeltaX / NOTCH; acc.x = 0; } // wheelDeltaX > 0 = left
  else if (e.deltaX) acc.x = accumulate(acc.x, e.deltaX * unit);
  while (Math.abs(acc.y) >= NOTCH) { const sg = Math.sign(acc.y); out.y += sg; acc.y -= sg * NOTCH; }
  while (Math.abs(acc.x) >= NOTCH) { const sg = Math.sign(acc.x); out.x += sg; acc.x -= sg * NOTCH; }
  return out;
}

function accumulate(acc, d) {
  if (acc && Math.sign(acc) !== Math.sign(d)) acc = 0; // direction change: start over
  return acc + d;
}
const EDGE = 36;             // px from the stage edge where 1:1 / fit-width views pan
const BAR_IDLE_MS = 1400;

const MOD_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'NumLock', 'ScrollLock']);

// input.key names for the fallback path (older agents without input.keyraw).
const FALLBACK_KEYS = {
  Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', PrintScreen: 'PrintScreen', Space: 'Space',
};
for (let i = 1; i <= 12; i++) FALLBACK_KEYS[`F${i}`] = `F${i}`;

export const VIEW_MODES = [
  { value: 'fit', label: 'Fit to window', sub: 'Letterboxed, whole screen visible' },
  { value: 'width', label: 'Fit width', sub: 'Fills the width, pan at the top / bottom edge' },
  { value: 'native', label: '1:1 pixels', sub: 'Sharpest; pan by moving to an edge' },
];

const isUnknownMethod = (err) => /unknown method/i.test(String(err && err.message));

/**
 * @param {object} host  provided by screen.js:
 *   conn, app, root (the .screen-tab element), stage, canvas,
 *   monitorIndex(), hasPicture(), stats() → {fps, kbs, latency, w, h},
 *   monitors() → Monitor[], currentMonitor(), selectMonitor(index), monitorLabel(index),
 *   presets, getPreset(), setPreset(name), presetLabel(name),
 *   getViewMode(), setViewMode(mode), panBy(dx, dy) → moved?, overflow() → {x, y},
 *   onEnter(), onExit(), setLocalCursorHidden(bool)
 */
export function createRdp(host) {
  const { conn, root, stage, canvas } = host;
  let active = false;
  let fullscreen = false;
  let kbdLocked = false;
  let keyraw = null;        // null = unknown yet, true = works, false = agent lacks it (fallback)
  let releaseOk = null;
  let notedFallback = false;
  const heldKeys = new Set();
  const heldButtons = new Set();
  let lastPos = { x: 0.5, y: 0.5 };
  let lastClient = null;

  const settings = {
    clipSync: store.get('rdpClipSync', true) !== false,
    hideCursor: store.get('rdpHideCursor', false) === true,
    pinned: store.get('rdpBarPinned', false) === true,
  };

  /* --------------------------------------------------------------- toolbar */

  const statsEl = h('span', { class: 'rdp-stats mono', 'aria-live': 'off' }, '—');
  const lockEl = h('span', { class: 'rdp-lock' });
  const monBtn = barBtn('monitor', 'Display', (b) => monitorMenu(b), { caret: true, cls: 'rdp-mon' });
  const qBtn = barBtn('gauge', 'Quality', (b) => qualityMenu(b), { caret: true, cls: 'rdp-quality' });
  const viewBtn = barBtn('fit', 'View', (b) => viewMenu(b), { caret: true, cls: 'rdp-view' });
  const pinBtn = iconBtn('pin', 'Keep the toolbar visible', () => setPinned(!settings.pinned), { cls: 'rdp-ico rdp-pin', size: 17 });
  const bar = h('div', { class: 'rdp-bar', role: 'toolbar', 'aria-label': 'Remote Desktop' },
    h('div', { class: 'rdp-group' },
      barBtn('minimize', 'Exit', () => exit(), { cls: 'rdp-exit', title: 'Leave Remote Desktop (Ctrl+Alt+Break)' }),
      h('span', { class: 'rdp-sep' }),
      monBtn, qBtn, viewBtn),
    h('div', { class: 'rdp-group' },
      barBtn('activity', 'Task Manager', () => sendCombo(['ControlLeft', 'ShiftLeft', 'Escape']), { title: 'Send Ctrl+Shift+Esc (Ctrl+Alt+Del can’t be sent)', cls: 'rdp-taskmgr' }),
      barBtn('winkey', 'Win', () => sendCombo(['MetaLeft']), { title: 'Send the Windows key', cls: 'rdp-win' }),
      barBtn('swap', 'Alt+Tab', () => sendCombo(['AltLeft', 'Tab']), { title: 'Send Alt+Tab', cls: 'rdp-alttab' }),
      h('span', { class: 'rdp-sep' }),
      barBtn('clipUp', 'To PC', () => pushClipboard(true), { title: 'Send this computer’s clipboard to the PC', cls: 'rdp-clip-push' }),
      barBtn('clipDown', 'From PC', () => pullClipboard(true), { title: 'Copy the PC clipboard to this computer', cls: 'rdp-clip-pull' })),
    h('div', { class: 'rdp-group rdp-end' },
      statsEl, lockEl,
      iconBtn('gear', 'Remote Desktop settings', (e) => settingsMenu(e.currentTarget), { cls: 'rdp-ico rdp-settings', size: 17 }),
      pinBtn));
  const hot = h('div', { class: 'rdp-hot', 'aria-hidden': 'true' });
  bar.hidden = true;
  hot.hidden = true;
  root.append(bar, hot);
  for (const b of bar.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off the bar

  function barBtn(iconName, label, onClick, { caret = false, cls = '', title } = {}) {
    const b = h('button', { type: 'button', class: ['rdp-btn', cls], title: title || label, 'aria-label': title || label },
      icon(iconName, { size: 16 }), h('span', { class: 'rdp-btn-label' }, label), caret ? icon('chevronDown', { size: 13, cls: 'caret' }) : null);
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  let barTimer = 0;
  let overBar = false;
  function showBar(ms = 0) {
    if (!active) return;
    clearTimeout(barTimer);
    bar.classList.add('show');
    renderStats();
    if (ms) barTimer = setTimeout(maybeHideBar, ms);
  }
  function maybeHideBar() {
    clearTimeout(barTimer);
    if (!active || settings.pinned || overBar || popoverOpen()) { if (active && !settings.pinned) barTimer = setTimeout(maybeHideBar, BAR_IDLE_MS); return; }
    bar.classList.remove('show');
  }
  bar.addEventListener('mouseenter', () => { overBar = true; showBar(); });
  bar.addEventListener('mouseleave', () => { overBar = false; barTimer = setTimeout(maybeHideBar, BAR_IDLE_MS); });
  hot.addEventListener('mouseenter', () => showBar(BAR_IDLE_MS * 2));
  hot.addEventListener('click', () => showBar(BAR_IDLE_MS * 2));

  function setPinned(on) {
    settings.pinned = !!on;
    store.set('rdpBarPinned', settings.pinned);
    pinBtn.classList.toggle('on', settings.pinned);
    pinBtn.setAttribute('aria-pressed', String(settings.pinned));
    if (settings.pinned) showBar(); else barTimer = setTimeout(maybeHideBar, BAR_IDLE_MS);
  }
  pinBtn.classList.toggle('on', settings.pinned);

  function renderBar() {
    const m = host.currentMonitor();
    monBtn.querySelector('.rdp-btn-label').textContent = host.monitorLabel(m);
    qBtn.querySelector('.rdp-btn-label').textContent = host.presetLabel(host.getPreset());
    const vm = VIEW_MODES.find((v) => v.value === host.getViewMode()) || VIEW_MODES[0];
    viewBtn.querySelector('.rdp-btn-label').textContent = vm.value === 'native' ? '1:1' : vm.value === 'width' ? 'Fit width' : 'Fit';
    setChildren(lockEl,
      icon(kbdLocked ? 'lock' : 'unlock', { size: 14 }),
      h('span', null, kbdLocked ? 'Keys locked' : fullscreen ? 'Esc exits' : 'Windowed'));
    lockEl.className = `rdp-lock ${kbdLocked ? 'ok' : fullscreen ? 'warn' : 'muted'}`;
    lockEl.title = kbdLocked
      ? 'Keyboard captured: Win, Alt+Tab and Esc go to the PC. Hold Esc to leave full screen.'
      : fullscreen
        ? 'This browser can’t capture system keys: Esc leaves full screen, Win / Alt+Tab stay on this computer.'
        : 'Not full screen. Browser shortcuts may not reach the PC. Ctrl+Alt+Break or the Exit button leaves Remote Desktop.';
    root.dataset.kbdlock = kbdLocked ? 'locked' : 'unlocked';
    root.dataset.fullscreen = fullscreen ? 'yes' : 'no';
  }

  function renderStats() {
    const s = host.stats();
    statsEl.textContent = `${s.fps.toFixed(1)} fps · ${s.kbs.toFixed(s.kbs < 10 ? 1 : 0)} KB/s · ${s.latency ? `${Math.round(s.latency)} ms` : '— ms'}`;
    statsEl.title = `${s.w}×${s.h} frames · latency = frame received → acknowledged`;
  }
  setInterval(() => { if (active && bar.classList.contains('show')) renderStats(); }, 1000);

  function monitorMenu(anchor) {
    const mons = host.monitors();
    const cur = host.currentMonitor();
    const items = mons.map((m) => ({
      label: host.monitorLabel(m.index), sub: `${m.width}×${m.height}${m.primary ? ' · primary' : ''}`,
      checked: m.index === cur, onSelect: () => host.selectMonitor(m.index),
    }));
    if (mons.length > 1) items.push('sep', { label: 'All displays', sub: 'The whole virtual desktop', checked: cur === -1, onSelect: () => host.selectMonitor(-1) });
    if (!items.length) items.push({ label: 'No display list yet', disabled: true });
    popover(anchor, [{ header: 'Display' }, ...items], { onClose: () => showBar(BAR_IDLE_MS) });
  }

  function qualityMenu(anchor) {
    const cur = host.getPreset();
    const order = ['low', 'medium', 'high', 'hd'];
    popover(anchor, [{ header: 'Quality' }, ...order.map((k) => {
      const p = host.presets[k];
      return { label: host.presetLabel(k), sub: `${p.fps} fps · quality ${p.quality} · ${p.maxWidth}px`, checked: k === cur, onSelect: () => host.setPreset(k) };
    })], { onClose: () => showBar(BAR_IDLE_MS) });
  }

  function viewMenu(anchor) {
    const cur = host.getViewMode();
    popover(anchor, [{ header: 'View' }, ...VIEW_MODES.map((v) => ({
      label: v.label, sub: v.sub, checked: v.value === cur, onSelect: () => { host.setViewMode(v.value); renderBar(); },
    }))], { onClose: () => showBar(BAR_IDLE_MS) });
  }

  function settingsMenu(anchor) {
    popover(anchor, [
      { header: 'Remote Desktop' },
      { label: 'Clipboard sync', sub: 'Local → PC on focus, PC → local after Ctrl+C / Ctrl+X', checked: settings.clipSync,
        onSelect: () => setSetting('clipSync', !settings.clipSync) },
      { label: 'Hide local cursor', sub: 'Show only the PC’s pointer over the picture', checked: settings.hideCursor,
        onSelect: () => setSetting('hideCursor', !settings.hideCursor) },
      { label: 'Keep toolbar visible', checked: settings.pinned, onSelect: () => setPinned(!settings.pinned) },
      'sep',
      { label: 'Release all keys & buttons', iconName: 'unlock', onSelect: () => releaseAll() },
    ], { align: 'end', cls: 'rdp-settings-pop', onClose: () => showBar(BAR_IDLE_MS) });
  }

  function setSetting(k, v) {
    settings[k] = v;
    store.set(k === 'clipSync' ? 'rdpClipSync' : 'rdpHideCursor', v);
    if (k === 'hideCursor') host.setLocalCursorHidden(active && v);
    if (k === 'clipSync' && v) clipDenied = false;
  }

  /* ----------------------------------------------------------- enter / exit */

  function enter() {
    if (active) return;
    active = true;
    settings.clipSync = store.get('rdpClipSync', true) !== false; // may have changed in the app menu
    settings.hideCursor = store.get('rdpHideCursor', false) === true;
    heldKeys.clear();
    heldButtons.clear();
    document.body.classList.add('rdp');
    root.classList.add('rdp-on');
    root.dataset.rdp = 'on';
    bar.hidden = false;
    hot.hidden = false;
    host.onEnter();
    host.setLocalCursorHidden(settings.hideCursor);
    fullscreen = false;
    kbdLocked = false;
    renderBar();
    showBar(3200);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    stage.focus({ preventScroll: true });
    // Fullscreen must be requested synchronously inside the user's click.
    const el = document.documentElement;
    let req = null;
    try { req = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null; } catch { req = null; }
    Promise.resolve(req).then(async () => {
      if (!active) return;
      fullscreen = !!document.fullscreenElement;
      if (fullscreen && navigator.keyboard && typeof navigator.keyboard.lock === 'function') {
        try { await navigator.keyboard.lock(); kbdLocked = true; } catch { kbdLocked = false; }
      }
      renderBar();
    }).catch(() => { fullscreen = false; renderBar(); });
    pushClipboard(false);
  }

  function exit({ fromFullscreen = false } = {}) {
    if (!active) return;
    releaseAll();
    active = false;
    clearTimeout(barTimer);
    clearTimeout(moveTimer); moveTimer = 0; pendingMove = null;
    clearTimeout(scrollTimer); scrollTimer = 0; wheel.y = wheel.x = wheel.ny = wheel.nx = 0;
    clearTimeout(clipTimer);
    stopPan();
    closePopover();
    try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch { /* ignore */ }
    kbdLocked = false;
    if (!fromFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    fullscreen = false;
    document.body.classList.remove('rdp');
    root.classList.remove('rdp-on');
    root.dataset.rdp = 'off';
    bar.classList.remove('show');
    bar.hidden = true;
    hot.hidden = true;
    host.setLocalCursorHidden(false);
    host.onExit();
  }

  document.addEventListener('fullscreenchange', () => {
    if (!active) return;
    if (!document.fullscreenElement) {
      if (fullscreen) exit({ fromFullscreen: true }); // Esc / browser UI left full screen → leave RDP mode
    } else {
      fullscreen = true;
      renderBar();
    }
  });

  /* ------------------------------------------------------------------ mouse */

  function mouse(action, pos, extra = {}) {
    if (!conn.online) return Promise.resolve();
    const p = { monitor: host.monitorIndex(), x: round(pos.x), y: round(pos.y), action, ...extra };
    return conn.request('input.mouse', p).catch((err) => {
      if (action !== 'move') noteError(err, 'Mouse');
    });
  }

  const round = (v) => Math.round(clamp(v, 0, 1) * 100000) / 100000;

  /** Client point → normalized position on the captured area (letterbox, zoom and pan aware). */
  function posOf(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const fx = (clientX - r.left) / (r.width || 1);
    const fy = (clientY - r.top) / (r.height || 1);
    return { x: clamp(fx, 0, 1), y: clamp(fy, 0, 1), inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
  }

  let pendingMove = null;
  let moveTimer = 0;
  let movesInFlight = 0;
  let lastMoveAt = 0;

  function queueMove(pos) {
    pendingMove = pos;
    scheduleMove();
  }
  function scheduleMove() {
    if (moveTimer || !pendingMove) return;
    const wait = Math.max(0, MOVE_MS - (performance.now() - lastMoveAt));
    moveTimer = setTimeout(() => { moveTimer = 0; sendMove(); }, wait);
  }
  function sendMove() {
    if (!pendingMove || !active) return;
    if (movesInFlight >= MAX_MOVES_IN_FLIGHT) return; // resumed when one completes (flow control)
    const pos = pendingMove;
    pendingMove = null;
    lastMoveAt = performance.now();
    movesInFlight++;
    lastPos = pos;
    mouse('move', pos).finally(() => {
      movesInFlight--;
      if (pendingMove) scheduleMove();
    });
  }
  /** A button / wheel event carries its own position: an older queued move must not follow it. */
  function dropPendingMove() {
    pendingMove = null;
    clearTimeout(moveTimer);
    moveTimer = 0;
  }

  const BUTTON_BITS = [['left', 1], ['right', 2], ['middle', 4]];
  const BUTTON_OF = { 0: 'left', 1: 'middle', 2: 'right' };

  /** Diff the pointer's pressed-buttons mask against what we hold → down / up per button. */
  function syncButtons(e, pos, extraDown) {
    const want = new Set();
    for (const [name, bit] of BUTTON_BITS) if (e.buttons & bit) want.add(name);
    if (extraDown) want.add(extraDown);
    for (const b of heldButtons) {
      if (!want.has(b)) { heldButtons.delete(b); dropPendingMove(); lastPos = pos; mouse('up', pos, { button: b }); }
    }
    for (const b of want) {
      if (!heldButtons.has(b)) { heldButtons.add(b); dropPendingMove(); lastPos = pos; mouse('down', pos, { button: b }); }
    }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!active) return;
    if (e.target.closest('button, a, input, .stage-msg')) return;
    e.preventDefault();
    if (!host.hasPicture()) return;
    stage.focus({ preventScroll: true });
    const pos = posOf(e.clientX, e.clientY);
    lastClient = { x: e.clientX, y: e.clientY };
    if (!pos.inside && !heldButtons.size) return; // a click on the letterbox bars is not a click on the PC
    const btn = BUTTON_OF[e.button];
    if (!btn) return; // back / forward buttons
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    syncButtons(e, pos, btn);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!active) return;
    lastClient = { x: e.clientX, y: e.clientY };
    const sr = stage.getBoundingClientRect();
    if (e.clientY - sr.top < 6) showBar(BAR_IDLE_MS * 2);
    if (!host.hasPicture()) return;
    edgePan(e.clientX, e.clientY, sr);
    const pos = posOf(e.clientX, e.clientY);
    // Chorded buttons (a 2nd button pressed while one is held) arrive as pointermove, not pointerdown.
    if (e.button !== -1 && e.button != null) syncButtons(e, pos);
    queueMove(pos);
  });

  const onUp = (e) => {
    if (!active) return;
    const pos = posOf(e.clientX, e.clientY);
    if (e.type === 'pointercancel') {
      for (const b of [...heldButtons]) { heldButtons.delete(b); mouse('up', lastPos, { button: b }); }
    } else syncButtons(e, pos);
    try { if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('pointerleave', () => stopPan());
  // Middle button: no browser autoscroll; no synthesized clicks of any kind.
  stage.addEventListener('mousedown', (e) => { if (active && e.button === 1) e.preventDefault(); });
  stage.addEventListener('auxclick', (e) => { if (active) e.preventDefault(); });
  stage.addEventListener('dblclick', (e) => { if (active) e.preventDefault(); });
  stage.addEventListener('dragstart', (e) => { if (active) e.preventDefault(); });

  /* ------------------------------------------------------------------ wheel */

  const wheel = { acc: createWheelAccumulator(), ny: 0, nx: 0, pos: null };
  let scrollTimer = 0;

  stage.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!host.hasPicture()) return;
    const n = wheelToNotches(wheel.acc, e, { pagePx: stage.clientHeight });
    wheel.ny += n.y;
    wheel.nx += n.x;
    wheel.pos = posOf(e.clientX, e.clientY);
    if ((wheel.ny || wheel.nx) && !scrollTimer) scrollTimer = setTimeout(flushScroll, 0);
  }, { passive: false, capture: true });

  let lastScrollAt = 0;
  function flushScroll() {
    scrollTimer = 0;
    if (!active || (!wheel.ny && !wheel.nx)) return;
    const wait = SCROLL_MS - (performance.now() - lastScrollAt);
    if (wait > 0) { scrollTimer = setTimeout(flushScroll, wait); return; }
    lastScrollAt = performance.now();
    const extra = { delta: wheel.ny };
    if (wheel.nx) extra.deltaX = wheel.nx;
    wheel.ny = 0;
    wheel.nx = 0;
    dropPendingMove();
    lastPos = wheel.pos || lastPos;
    mouse('scroll', lastPos, extra);
  }

  /* ---------------------------------------------------------------- edge pan */

  let pan = { vx: 0, vy: 0, raf: 0 };
  function edgePan(cx, cy, sr) {
    const ov = host.overflow();
    let vx = 0;
    let vy = 0;
    if (ov.x) {
      if (cx - sr.left < EDGE) vx = (EDGE - (cx - sr.left)) / EDGE;
      else if (sr.right - cx < EDGE) vx = -(EDGE - (sr.right - cx)) / EDGE;
    }
    if (ov.y) {
      if (cy - sr.top < EDGE && cy - sr.top >= 6) vy = (EDGE - (cy - sr.top)) / EDGE;
      else if (sr.bottom - cy < EDGE) vy = -(EDGE - (sr.bottom - cy)) / EDGE;
    }
    pan.vx = vx * 22;
    pan.vy = vy * 22;
    if ((pan.vx || pan.vy) && !pan.raf) pan.raf = requestAnimationFrame(panStep);
  }
  function panStep() {
    pan.raf = 0;
    if (!active || (!pan.vx && !pan.vy)) return;
    const moved = host.panBy(pan.vx, pan.vy);
    if (moved && lastClient) queueMove(posOf(lastClient.x, lastClient.y)); // same spot, new picture point
    if (moved) pan.raf = requestAnimationFrame(panStep);
  }
  function stopPan() {
    pan.vx = pan.vy = 0;
    if (pan.raf) cancelAnimationFrame(pan.raf);
    pan.raf = 0;
  }

  /* ---------------------------------------------------------------- keyboard */

  function onKey(e) {
    if (!active) return;
    if (popoverOpen() || layerOpen()) {
      // A menu / dialog in front gets the keyboard — but a key the PC already saw go down must still
      // go up there, or it stays held on the PC (Shift held while clicking a toolbar menu).
      if (e.type === 'keyup' && e.code && heldKeys.has(e.code)) {
        heldKeys.delete(e.code);
        sendKey(e.code, false, { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
      }
      return;
    }
    const down = e.type === 'keydown';
    // Ctrl+Alt+Break leaves Remote Desktop (as in mstsc). Never sent to the PC.
    if (down && e.ctrlKey && e.altKey && (e.code === 'Pause' || e.key === 'Cancel')) {
      e.preventDefault();
      e.stopPropagation();
      exit();
      return;
    }
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    const code = e.code;
    if (!code || code === 'Unidentified') return;
    if (down) heldKeys.add(code); else heldKeys.delete(code);
    sendKey(code, down, { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    if (down && !e.repeat && e.ctrlKey && !e.altKey && (code === 'KeyC' || code === 'KeyX')) schedulePull();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  function sendKey(code, down, snap) {
    if (!conn.online) return;
    if (keyraw === false) { if (down) fallbackKey(code, snap); return; }
    conn.request('input.keyraw', { code, down }).then(() => { keyraw = true; }, (err) => {
      if (isUnknownMethod(err)) {
        keyraw = false;
        if (!notedFallback) {
          notedFallback = true;
          toast('This PC agent is older: using basic key input (no key-up, no Win key)', { type: 'warn', timeout: 4200 });
        }
        if (down) fallbackKey(code, snap);
      } else if (!/unknown key code/i.test(err.message)) {
        noteError(err, 'Keyboard');
      }
    });
  }

  function fallbackKey(code, s) {
    if (MOD_CODES.has(code)) return;
    const mods = [];
    if (s.ctrl) mods.push('ctrl');
    if (s.alt) mods.push('alt');
    if (s.shift) mods.push('shift');
    if (s.meta) mods.push('win');
    const plain = !s.ctrl && !s.alt && !s.meta;
    let name = FALLBACK_KEYS[code] || null;
    if (!name && /^Key[A-Z]$/.test(code) && !plain) name = code.slice(3).toLowerCase();
    if (!name && /^Digit\d$/.test(code) && !plain) name = code.slice(5);
    if (name === 'Space' && plain) name = null;
    if (name) { conn.request('input.key', mods.length ? { key: name, mods } : { key: name }).catch((err) => noteError(err, 'Key')); return; }
    if (plain && s.key && s.key.length === 1) conn.request('input.text', { text: s.key }).catch((err) => noteError(err, 'Typing'));
  }

  /** Press the codes in order, release in reverse (toolbar shortcuts). */
  function sendCombo(codes) {
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    if (keyraw === false) {
      const last = codes[codes.length - 1];
      const map = { Escape: 'Escape', Tab: 'Tab' };
      if (!map[last]) { toast('The Win key needs a newer PC agent (input.keyraw)', { type: 'warn' }); return; }
      const mods = codes.slice(0, -1).map((c) => (c.startsWith('Control') ? 'ctrl' : c.startsWith('Shift') ? 'shift' : c.startsWith('Alt') ? 'alt' : 'win'));
      conn.request('input.key', { key: map[last], mods }).catch((err) => noteError(err, 'Shortcut'));
      return;
    }
    const seq = [...codes.map((c) => [c, true]), ...[...codes].reverse().map((c) => [c, false])];
    let fellBack = false;
    for (const [code, down] of seq) {
      conn.request('input.keyraw', { code, down }).then(() => { keyraw = true; }, (err) => {
        if (isUnknownMethod(err)) {
          keyraw = false;
          if (!fellBack) { fellBack = true; sendCombo(codes); }
        } else noteError(err, 'Shortcut');
      });
    }
    stage.focus({ preventScroll: true });
  }

  /** input.releaseAll (fallback: release what this client holds, one by one). */
  function releaseAll() {
    const keys = [...heldKeys];
    const buttons = [...heldButtons];
    heldKeys.clear();
    heldButtons.clear();
    dropPendingMove();
    if (!conn.online) return;
    const manual = () => {
      if (keyraw !== false) for (const code of keys) conn.request('input.keyraw', { code, down: false }).catch(() => {});
      for (const b of buttons) mouse('up', lastPos, { button: b });
    };
    if (releaseOk === false) { manual(); return; }
    conn.request('input.releaseAll', {}).then(() => { releaseOk = true; }, (err) => {
      if (isUnknownMethod(err)) { releaseOk = false; manual(); }
    });
  }

  window.addEventListener('blur', () => { if (active) releaseAll(); });
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.visibilityState !== 'visible') releaseAll();
  });
  window.addEventListener('focus', () => { if (active) pushClipboard(false); });
  // A push that failed while offline is retried once the connection is back (if we still have focus).
  conn.on('ready', () => { if (active && document.hasFocus()) pushClipboard(false); });

  /* --------------------------------------------------------------- clipboard */

  let lastClip = null;
  let clipDenied = false;
  let clipTimer = 0;
  const clipOk = () => window.isSecureContext && navigator.clipboard;

  async function pushClipboard(force) {
    if (!force && (!settings.clipSync || clipDenied)) return;
    if (!clipOk() || typeof navigator.clipboard.readText !== 'function') {
      if (force) toast('Clipboard access needs the app over HTTPS (tailscale serve) or localhost', { type: 'warn' });
      return;
    }
    let text;
    try { text = await navigator.clipboard.readText(); } catch {
      if (force) toast('Clipboard permission denied by the browser', { type: 'warn' });
      else clipDenied = true; // don't keep asking; the toolbar button still works
      return;
    }
    if (typeof text !== 'string') return;
    if (!force && (!text || text === lastClip)) return;
    if (!text) { toast('This computer’s clipboard has no text'); return; }
    const prev = lastClip;
    lastClip = text; // claimed now so a second focus event does not push the same text twice
    try {
      await conn.request('clip.set', { text });
      if (force) toast('Clipboard sent to the PC', { type: 'ok', timeout: 1600 });
    } catch (err) {
      // Not synced (offline, timeout…): forget the claim so the next focus / reconnect tries again.
      if (lastClip === text) lastClip = prev;
      if (force) toastError(err, 'Clipboard');
    }
  }

  async function pullClipboard(force) {
    if (!force && !settings.clipSync) return;
    if (!clipOk() || typeof navigator.clipboard.writeText !== 'function') {
      if (force) toast('Clipboard access needs the app over HTTPS (tailscale serve) or localhost', { type: 'warn' });
      return;
    }
    let r;
    try { r = await conn.request('clip.get'); } catch (err) { if (force) toastError(err, 'Clipboard'); return; }
    const text = r && typeof r.text === 'string' ? r.text : '';
    if (!text) { if (force) toast('The PC clipboard has no text'); return; }
    if (!force && text === lastClip) return;
    try {
      await navigator.clipboard.writeText(text);
      lastClip = text;
      if (force) toast('PC clipboard copied here', { type: 'ok', timeout: 1600 });
    } catch {
      if (force) toast('Clipboard permission denied by the browser', { type: 'warn' });
    }
  }

  function schedulePull() {
    if (!settings.clipSync) return;
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => pullClipboard(false), 300);
  }

  /* ------------------------------------------------------------------ misc */

  let lastErrAt = 0;
  function noteError(err, what) {
    if (Date.now() - lastErrAt < 4000) return;
    lastErrAt = Date.now();
    toastError(err, what);
  }

  return {
    enter,
    exit,
    toggle() { if (active) exit(); else enter(); },
    get active() { return active; },
    refresh() { if (active) renderBar(); },
    /** Test / diagnostics view of the controller state. */
    get state() {
      return { active, fullscreen, kbdLocked, keyraw, releaseOk, heldKeys: [...heldKeys], heldButtons: [...heldButtons], clipSync: settings.clipSync };
    },
  };
}
