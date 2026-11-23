// Live view of an ordinary (non-mirrored) VS Code terminal (PROTOCOL §5.2 terminals.attach /
// term.raw, §6).
//
// The extension keeps a raw output ring per terminal (fed by shell integration). This view seeds an
// xterm with that ring and then follows the live `term.raw` stream, so full-screen programs (Claude
// Code, vim, htop…) look like they do in VS Code. The xterm grid is pinned to the VS Code terminal's
// own size — we never resize the PC terminal — and the font is scaled so its columns fit the space
// we have (pinch / Ctrl+wheel / ± zoom in further and scroll). Keystrokes go back raw via
// `terminals.input`. A second tab shows the per-command history (execlog.js).
//
// Streaming only runs while the Live tab is actually on screen: hidden (other tab, other deck tab,
// app in background, view closed) → `terminals.detach` after a short grace period; shown again or
// reconnected → re-attach (the ring is replayed into a reset xterm).
//
// "Exactly as running": when the ring cannot tell what the terminal shows (capturing:false, nothing
// captured yet) the extension adds a `snapshot` of the VS Code terminal's screen + scrollback as text
// to the attach result (PROTOCOL §5.2.1); it is written first, then the live stream. The History tab
// is only ever a secondary view: an extension without terminals.attach gets a "reload that VS Code
// window" banner in the terminal area instead.
//
// Desktop (embedded, ctx.look 'vscode'): the terminal looks like VS Code's integrated terminal —
// Dark Modern colours, Consolas 14 px, steady block cursor, no extra keys / command box (toggles in
// the menus). Phones keep the app theme, the extra-keys row and the command box.

import {
  h, iconBtn, btn, store, toast, toastError, openView, actionSheet, sheet, segmented, promptDialog,
  copyText, readClipboard, clamp, haptic, banner, setChildren, TERM_THEME, MONO_FONT, debounce,
  confirmDialog, VSCODE_TERM_THEME, VSCODE_TERM_FONT, VSCODE_TERM_LOOK,
} from './ui.js';
import { icon } from './icons.js';
import { createKeyBar, createCmdLine } from './termkeys.js';
import { openExecLog } from './execlog.js';
import { isDesktop } from './layout.js';

export const MIRROR_PROFILE = 'TermPocket (mirrored)';

const CMDLINE_KEY = 'termCmdline';
const DESK_CMDLINE_KEY = 'termCmdlineDesk';
const DESK_XKEYS_KEY = 'termXkeysDesk';
const ZOOM_KEY = 'vstermFont'; // + '.desk' / '.phone': manual font size, absent = fit
const LINE_HEIGHT = 1.12;
const MIN_FONT = 4.5; // fit may go this small (pinch to zoom in); below that nothing is legible
const MAX_FONT = 28;
const MAX_FIT_FONT = 15; // a narrow VS Code terminal in a wide pane must not get a huge font
const MIN_HEIGHT_FIT = 9; // fitting the rows may shrink the font only down to this — else scroll
// Desktop (VS Code look): never larger than VS Code's own 14 px; rows that do not fit at ≥ 11 px
// scroll (pinned to the bottom, where prompts and TUI input boxes are) instead of shrinking further.
const DESK_MAX_FIT_FONT = 14;
const DESK_MIN_HEIGHT_FIT = 11;
const SNAPSHOT_WAIT_MS = 4000;
const SNAPSHOT_AFTER_INPUT_MS = 1200; // not capturing: re-read the screen this long after typing
// DEC private modes worth carrying over from the raw ring when a snapshot replaces it (cursor keys,
// cursor visibility, autowrap, mouse reporting, focus events, bracketed paste) — never the
// alternate-screen switches: the snapshot is plain text in the normal buffer.
const CARRY_MODES = new Set([1, 7, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
const DETACH_GRACE_MS = 2500;
const KEEPALIVE_MS = 4 * 60 * 1000; // extension expires idle attaches after 10 min (§5.2)
const INPUT_COALESCE_MS = 6;

/* ------------------------------------------------------- mirror default */

/** The VS Code window to talk to for user-level settings: the given one, else focused, else first. */
function settingsWindow(vs, preferred) {
  if (preferred && vs.get(preferred)) return preferred;
  const wins = vs.windows;
  const w = wins.find((x) => x.focused) || wins[0];
  return w ? w.windowId : null;
}

/** → true/false, or null when no window can answer (none connected, or an older extension). */
export async function getMirrorDefault(conn, vs, windowId) {
  const wid = settingsWindow(vs, windowId);
  if (!wid || !conn.online) return null;
  try {
    const r = await conn.vsc(wid, 'settings.get', {}, { timeout: 8000 });
    return r && typeof r.mirrorDefault === 'boolean' ? r.mirrorDefault : null;
  } catch {
    return null;
  }
}

/**
 * Make new VS Code terminals open with the "TermPocket (mirrored)" profile (user setting
 * terminal.integrated.defaultProfile.*). Toasts the outcome; resolves the new state or null.
 */
export async function setMirrorDefault(conn, vs, enable, windowId) {
  const wid = settingsWindow(vs, windowId);
  if (!wid) { toast('Open VS Code with the TermPocket extension first', { type: 'warn' }); return null; }
  if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return null; }
  try {
    const r = await conn.vsc(wid, 'settings.mirrorDefault', { enable: !!enable });
    const on = r && typeof r.enabled === 'boolean' ? r.enabled : !!enable;
    if (on && r && r.overriddenBy) {
      toast(`Saved, but this VS Code window’s ${r.overriddenBy === 'workspaceFolder' ? 'folder' : 'workspace'} settings choose another default terminal profile, so new terminals there are not mirrored. Remove terminal.integrated.defaultProfile from those settings.`, { type: 'warn', timeout: 9000 });
      return on;
    }
    toast(on
      ? `New VS Code terminals now open as “${MIRROR_PROFILE}”: fully visible here, with their whole history. Terminals already open stay ordinary.`
      : 'New VS Code terminals open with your normal default profile again.', { type: 'ok', timeout: on ? 7000 : 3000 });
    return on;
  } catch (err) {
    toastError(err, /unknown method/i.test(err.message) ? 'Update the TermPocket extension' : 'Could not change the setting');
    return null;
  }
}

/** Id of one attachment (PROTOCOL §5.2.1 `aid`): lets the extension tell a re-attach from a new phone. */
function newAid() {
  let rnd = '';
  try { rnd = [...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join(''); } catch { /* old browser */ }
  return `w${rnd || Math.random().toString(36).slice(2)}`.slice(0, 32);
}

/* --------------------------------------------------------- measurement */

let charRatio = 0;
/** Advance width of one monospace cell as a fraction of the font size (≈ 0.55–0.6). */
function cellRatio() {
  if (charRatio) return charRatio;
  const probe = h('span', {
    'aria-hidden': 'true',
    style: { position: 'absolute', left: '-9999px', top: '0', visibility: 'hidden', whiteSpace: 'pre', font: `100px ${MONO_FONT}` },
  }, 'W'.repeat(40));
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 40 / 100;
  probe.remove();
  charRatio = w > 0.3 && w < 1 ? w : 0.6;
  return charRatio;
}

/**
 * @param {object} ctx  { conn, vs, windowsPty?, look?: 'vscode'|'app' (default 'vscode' when embedded = desktop),
 *   termTheme? (xterm theme), termFont? (font family), confirm? ({title, message, confirmText}) → Promise<boolean>,
 *   openPhoneVisible? (windowId) → creates + shows a mirrored terminal in that window }
 * @param {{ windowId: string, tid: string, name?: string, hasShellIntegration?: boolean,
 *           tab?: 'live'|'history', embed?: {host: HTMLElement, onClosed?: Function},
 *           onTitle?: (title: string, tip: string) => void, onState?: (tone: string|null) => void }} t
 */
export function openVsTermView(ctx, t) {
  const { conn, vs } = ctx;
  const { windowId, tid } = t;
  const embedded = !!(t.embed && t.embed.host);
  const vsLook = ctx.look ? ctx.look === 'vscode' : embedded;
  const lineHeight = vsLook ? VSCODE_TERM_LOOK.lineHeight : LINE_HEIGHT;
  const maxFitFont = vsLook ? DESK_MAX_FIT_FONT : MAX_FIT_FONT;
  const minHeightFit = vsLook ? DESK_MIN_HEIGHT_FIT : MIN_HEIGHT_FIT;
  const zoomKey = `${ZOOM_KEY}.${embedded || isDesktop() ? 'desk' : 'phone'}`;
  let name = t.name || 'Terminal';
  let hasSI = t.hasShellIntegration !== false;
  let gone = false;
  let tab = t.tab === 'history' ? 'history' : 'live';
  let liveSupported = null; // null unknown · true · false (extension without terminals.attach)
  let reloadAsked = false; // "Reload window" sent to that VS Code window (old extension)
  let reloadKey = ''; // windowKey() of that window: it comes back under a new windowId
  let reopening = false;
  let attached = false;
  let attaching = false;
  let attachSeq = 0;
  /** The attachment the extension may hold for this view: { aid, released } (released = detach sent). */
  let lease = null;
  let attachErr = null;
  let info = null; // { capturing, since, note, snapshot } from the last attach
  /** While a separately requested snapshot is on its way: live output that arrives meanwhile. */
  let snapQueue = null;
  let snapSeq = 0;
  let snapTimer = 0;
  let snapSupported = null; // terminals.snapshot: null unknown · true · false
  let lastSnapAt = 0;
  let followOut = true; // rows taller than the pane: keep the cursor row (prompt / TUI input) in view
  let stickRaf = 0;
  let modes = new Map(); // DEC private modes the stream set (mode → 'h' | 'l'), see CARRY_MODES
  let hadOutput = false;
  let noteDismissed = false;
  let dims = null; // { cols, rows } of the VS Code terminal, null = unknown
  let manualFont = numOrNull(store.get(zoomKey, null));
  let fontSize = 12;
  let detachTimer = 0;
  let keepTimer = 0;
  let inBuf = '';
  let inTimer = 0;
  let lastInputErr = 0;
  let lastTyped = 0;
  let fitRaf = 0;
  let fitPass = 0;
  let followRaf = 0;
  const cmdKey = embedded ? DESK_CMDLINE_KEY : CMDLINE_KEY;
  let showCmdline = embedded ? store.get(cmdKey, false) === true : store.get(cmdKey, true) !== false;
  let showKeys = embedded ? store.get(DESK_XKEYS_KEY, false) === true : true;
  const offs = [];
  let history = null; // execlog api, built on first use

  /* ---------------------------------------------------------------- DOM */

  const titleEl = h('div', { class: 'view-title' }, name);
  const subEl = h('div', { class: 'view-sub mono' });
  const statusEl = h('button', {
    type: 'button', class: 'term-status', hidden: true,
    onClick: () => { if (!conn.online) conn.reconnectNow(); else if (!attached && tab === 'live') reattach(); },
  });

  const tabs = segmented([
    { value: 'live', label: 'Live', icon: 'terminal' },
    { value: 'history', label: 'History', icon: 'history' },
  ], tab, (v) => selectTab(v), { cls: 'seg-sm vst-seg' });
  const sizeEl = h('span', { class: 'vst-size mono', title: 'Size of the terminal in VS Code (not changed from here)' });
  const zoomOut = iconBtn('minus', 'Zoom out', () => zoomBy(-1), { keepFocus: true, cls: 'sm' });
  const zoomIn = iconBtn('plus', 'Zoom in', () => zoomBy(1), { keepFocus: true, cls: 'sm' });
  const fitBtn = h('button', { type: 'button', class: 'vst-fit', title: 'Fit the VS Code terminal to this view', onClick: () => setManualFont(null) }, icon('fit', { size: 14 }), h('span', 'Fit'));
  const zoomBox = h('div', { class: 'vst-zoom' }, sizeEl, zoomOut, fitBtn, zoomIn);
  const bar = h('div', { class: 'vst-bar' }, tabs.el, zoomBox);

  const bannerSlot = h('div', { class: 'banner-slot' });
  const host = h('div', { class: 'term-host' });
  const wrap = h('div', { class: 'term-wrap fixed vst-wrap' }, host);
  const overlay = h('div', { class: 'term-overlay', hidden: true });
  wrap.append(overlay);

  const keyBar = createKeyBar({ send: (d) => sendInput(d), getTerm: () => term, paste: () => paste(), focus: () => focusTerminal() });
  const keysRow = keyBar.el;
  keysRow.hidden = !showKeys;
  const cmd = createCmdLine({ submit: (text) => submitCmd(text), hidden: !showCmdline, placeholder: 'Type into the VS Code terminal…' });

  // Shown instead of the (empty) xterm when that window's extension has no terminals.attach.
  const oldExtEl = h('div', { class: 'vst-oldext', hidden: true });
  const livePane = h('div', { class: 'vst-pane vst-live' }, bannerSlot, oldExtEl, wrap, keysRow, cmd.form);
  // Desktop: the history is a secondary view — a slim line leads back to the terminal (the workbench
  // panel hides the Live/History switch of the toolbar).
  const histPane = h('div', { class: 'vst-pane vst-history', hidden: true },
    vsLook ? h('div', { class: 'vst-histbar' },
      icon('history', { size: 14 }), h('span', { class: 'vst-histbar-title' }, 'Command history'),
      h('button', { type: 'button', class: 'vst-link', onClick: () => selectTab('live') }, 'Back to the terminal')) : null);

  const keysToggle = embedded
    ? iconBtn('keyboard', 'Extra keys', () => setShowKeys(!showKeys), { keepFocus: true, cls: 'keys-toggle' })
    : null;
  if (keysToggle) { keysToggle.setAttribute('aria-pressed', String(showKeys)); keysToggle.classList.toggle('on', showKeys); }

  // Desktop: one slim toolbar (title · Live/History · size/zoom · actions) above a bare terminal.
  const root = h('section', { class: ['vsterm-view', vsLook && 'vs-look'], 'aria-label': 'VS Code terminal' },
    h('header', { class: 'view-head' },
      embedded ? null : iconBtn('back', 'Back', () => view.back(), { cls: 'back' }),
      h('div', { class: 'view-titles' }, h('div', { class: 'title-row' }, titleEl, statusEl), subEl),
      embedded ? bar : null,
      h('div', { class: 'view-actions' },
        keysToggle,
        iconBtn('external', 'Show in VS Code', () => showOnPc()),
        iconBtn('more', 'More', () => showMenu()))),
    embedded ? null : bar, livePane, histPane);

  const view = openView(root, { onClose: cleanup, embed: t.embed });

  /* --------------------------------------------------------------- xterm */

  let term = null;
  if (typeof window.Terminal === 'function') {
    try {
      term = new window.Terminal({
        fontFamily: ctx.termFont || (vsLook ? VSCODE_TERM_FONT : MONO_FONT),
        fontSize,
        lineHeight,
        cols: 80,
        rows: 24,
        cursorBlink: true,
        cursorStyle: 'block',
        ...(vsLook ? VSCODE_TERM_LOOK : {}),
        scrollback: 5000,
        theme: ctx.termTheme || (vsLook ? VSCODE_TERM_THEME : TERM_THEME),
        macOptionIsMeta: true,
        smoothScrollDuration: 0,
        allowProposedApi: false,
        ...(ctx.windowsPty ? { windowsPty: ctx.windowsPty } : {}),
      });
      term.open(host);
      term.onData((d) => sendInput(keyBar.applyMods(d)));
      term.onBinary((d) => sendInput(d));
      term.onCursorMove(() => scheduleFollow());
      if (embedded) term.attachCustomKeyEventHandler(desktopKeys);
    } catch (err) {
      console.error('[termpocket] xterm init failed', err);
      term = null;
    }
  }
  if (!term) {
    // No xterm: the raw stream of a full-screen program is unreadable as text — offer History.
    liveSupported = false;
    setChildren(wrap, h('div', { class: 'vst-noterm' },
      'xterm.js was not found in web/vendor, so the live terminal can’t be drawn. Run “npm run vendor” in agent/.'));
  }

  /* ------------------------------------------------------------- events */

  offs.push(conn.on('vsc.event', ({ windowId: wid, ev, p }) => {
    if (wid !== windowId || !p) return;
    if (ev === 'term.raw') {
      if (p.tid !== tid || !attached || typeof p.d !== 'string') return;
      write(p.d);
    } else if (ev === 'term.detached') {
      // The extension dropped an attachment of this terminal (its idle lease ran out). Ours (or an
      // extension that does not name it): if we are still on screen, take a fresh one.
      if (p.tid !== tid || !lease) return;
      if (p.aid && p.aid !== lease.aid) return;
      detachLocal();
      syncAttach();
    } else if (ev === 'term.dims') {
      if (p.tid !== tid) return;
      setDims(p.cols, p.rows);
    } else if (ev === 'terminals.changed') {
      const list = Array.isArray(p.terminals) ? p.terminals : [];
      const me = list.find((x) => x.tid === tid);
      const wasGone = gone;
      gone = !me;
      if (me) {
        name = me.name || name;
        hasSI = !!me.hasShellIntegration;
      }
      updateTitle();
      if (gone !== wasGone) syncAttach();
      renderChrome();
    }
  }));
  // A VS Code window that reconnected (extension host restart, agent restart) forgot our attach.
  let winStamp = (vs.get(windowId) || {}).connectedAt || null;
  offs.push(vs.on('windows', () => {
    const w = vs.get(windowId);
    const stamp = w ? w.connectedAt || null : null;
    if (w && stamp !== winStamp) {
      winStamp = stamp;
      // That extension forgot every attachment: start over (a detach could not match anything).
      if (attached || attaching || lease) { attachErr = null; detachLocal(); }
      // An updated extension (window reloaded) may have the live view now: try again.
      if (liveSupported === false && term) { liveSupported = null; attachErr = null; }
    }
    renderChrome();
    syncAttach();
    followReload();
  }));
  offs.push(conn.on('ready', () => { attachErr = null; renderChrome(); syncAttach(); }));
  offs.push(conn.on('down', () => {
    // The extension still holds our attachment (`lease`): the next attach replaces it, or, if the
    // view is no longer on screen by then, it is detached once we are back online.
    attachSeq++;
    attached = false;
    attaching = false;
    stopKeepalive();
    renderChrome();
  }));

  // Rows taller than the pane (desktop keeps ≥ 11 px): output keeps the cursor row in view, unless
  // the user scrolled it out of view (scrolling back to it resumes that).
  wrap.addEventListener('scroll', () => { followOut = cursorInView(); }, { passive: true });

  const onVis = () => syncAttach();
  document.addEventListener('visibilitychange', onVis);
  // Fires when the pane gets a size (shown) or loses it (display:none tab / deck pane / panel).
  const ro = new ResizeObserver(() => { scheduleFit(); syncAttach(); });
  ro.observe(wrap);
  ro.observe(livePane);

  // Pinch (two fingers) and Ctrl+wheel zoom; one finger keeps scrolling xterm / the wrap.
  let pinch = null;
  const touchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinch = { d: touchDist(e) || 1, fs: fontSize }; e.preventDefault(); }
  }, { passive: false, capture: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.round(clamp(pinch.fs * (touchDist(e) / pinch.d), MIN_FONT, MAX_FONT) * 4) / 4;
    if (next !== fontSize) setManualFont(next, { quiet: true });
  }, { passive: false, capture: true });
  const endPinch = (e) => { if (pinch && e.touches.length < 2) { pinch = null; persistZoom(); renderZoom(); } };
  wrap.addEventListener('touchend', endPinch, { capture: true });
  wrap.addEventListener('touchcancel', endPinch, { capture: true });
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    zoomBy(e.deltaY < 0 ? 1 : -1, 0.5);
  }, { passive: false, capture: true });

  updateTitle();
  renderChrome();
  if (tab === 'history') selectTab('history', { initial: true });
  syncAttach();

  /* ------------------------------------------------------------ attach */

  function shown() {
    return !view.closed && tab === 'live' && livePane.getClientRects().length > 0 && document.visibilityState !== 'hidden';
  }

  function wanted() {
    return !!term && liveSupported !== false && !gone && !windowGone() && conn.online && shown();
  }

  /** Attach when the live tab is visible; detach (after a grace period) when it is not. */
  function syncAttach() {
    if (view.closed) return;
    if (wanted()) {
      if (detachTimer) { clearTimeout(detachTimer); detachTimer = 0; }
      if (!attached && !attaching && !attachErr) attach();
      return;
    }
    if ((attached || attaching || (lease && !lease.released)) && !detachTimer) {
      detachTimer = setTimeout(() => { detachTimer = 0; if (!wanted()) detach(); }, DETACH_GRACE_MS);
    }
  }

  /** Tell the extension to end one attachment, at most once per attachment. */
  function release(l) {
    if (!l || l.released || !conn.online) return;
    l.released = true;
    if (lease === l) lease = null;
    conn.vsc(windowId, 'terminals.detach', { tid, aid: l.aid }).catch(() => {});
  }

  async function attach() {
    const seq = ++attachSeq;
    attaching = true;
    if (!hadOutput) setOverlay('Connecting to the VS Code terminal…');
    renderChrome();
    // An attachment the extension may still hold for us (the connection dropped meanwhile) is
    // replaced, not added to: otherwise it would keep the stream running until its lease expires.
    const prev = lease && !lease.released ? lease : null;
    const mine = { aid: newAid(), released: false };
    const params = { tid, aid: mine.aid };
    if (prev) { params.replaces = prev.aid; prev.released = true; }
    lease = mine;
    try {
      const r = await conn.vsc(windowId, 'terminals.attach', params);
      if (seq !== attachSeq || view.closed) {
        // Superseded (hidden / closed meanwhile): release what we just took, unless already done.
        release(mine);
        return;
      }
      liveSupported = true;
      attachErr = null;
      winStamp = (vs.get(windowId) || {}).connectedAt || winStamp;
      info = {
        capturing: !(r && r.capturing === false),
        since: r && r.since != null ? r.since : null,
        note: (r && typeof r.note === 'string' && r.note) || '',
        snapshot: false,
      };
      cancelSnapshot();
      term.reset();
      followOut = true;
      const snap = snapshotOf(r && r.snapshot);
      setDims(r && r.cols != null ? r.cols : snap && snap.cols, r && r.rows != null ? r.rows : snap && snap.rows);
      const buf = r && typeof r.buffer === 'string' ? r.buffer : '';
      modes = new Map();
      trackModes(buf);
      if (snap && snap.text) {
        // What the VS Code terminal shows right now (screen + scrollback as text), then the stream.
        writeSnapshot(snap.text);
        info.snapshot = true;
        hadOutput = true;
      } else {
        hadOutput = buf.length > 0;
        if (buf) term.write(buf, () => { scheduleFollow(true); scheduleStick(); });
      }
      attached = true;
      // An extension that answers attach without the `snapshot` key may still have terminals.snapshot.
      if (!snap && !(r && 'snapshot' in r) && (!info.capturing || !buf)) requestSnapshot({ initial: true });
      setTimeout(maybeHint, 400);
      startKeepalive();
    } catch (err) {
      if (lease === mine && conn.online) lease = null; // refused: the extension holds nothing for us
      if (seq !== attachSeq || view.closed) return;
      if (/unknown method/i.test(err.message || '')) {
        // An older extension in that window: the terminal area says so and offers a reload. The
        // History tab stays a secondary choice — never the view this opens on.
        liveSupported = false;
      } else if (conn.online) {
        attachErr = err.message || String(err);
      }
    } finally {
      if (seq === attachSeq) {
        attaching = false;
        setOverlay(null);
        renderChrome();
      }
    }
  }

  function detach() {
    attachSeq++;
    cancelSnapshot();
    // Releases the current attachment, also one still in flight (the extension handles our calls in
    // order, so this detach lands after that attach); each attachment gets exactly one detach.
    attached = false;
    attaching = false;
    stopKeepalive();
    release(lease);
    renderChrome();
  }

  /** Forget the attach without telling the extension (it no longer knows about it). */
  function detachLocal() {
    attachSeq++;
    cancelSnapshot();
    attached = false;
    attaching = false;
    lease = null;
    stopKeepalive();
  }

  /** "Reload live view": a fresh screen snapshot while output isn't streamed, else a fresh attach. */
  function refreshScreen() {
    if (liveSupported === false) liveSupported = null; // maybe updated meanwhile: try again
    if (attached && snapSupported !== false && info && !info.capturing) { requestSnapshot(); return; }
    reattach();
  }

  function reattach() {
    attachErr = null;
    detach();
    if (detachTimer) { clearTimeout(detachTimer); detachTimer = 0; }
    syncAttach();
  }

  function startKeepalive() {
    stopKeepalive();
    keepTimer = setInterval(() => {
      if (!attached || !conn.online || !lease) return;
      // Renews the 10-minute lease (§5.2); { attached:false } = the extension dropped us → re-attach.
      const seq = attachSeq;
      conn.vsc(windowId, 'terminals.keepalive', { tid, aid: lease.aid }).then((r) => {
        if (seq === attachSeq && attached && r && r.attached === false) { detachLocal(); syncAttach(); }
      }).catch(() => {});
    }, KEEPALIVE_MS);
  }

  function stopKeepalive() { clearInterval(keepTimer); keepTimer = 0; }

  function windowGone() { return vs.loaded && !vs.get(windowId); }

  function write(d) {
    if (!d || !term) return;
    if (snapQueue) { snapQueue.push(d); return; } // the screen snapshot goes first
    trackModes(d);
    if (!hadOutput || (info && !info.capturing)) {
      // Output is flowing (a new command started, so shell integration captures again).
      hadOutput = true;
      if (info) info.capturing = true;
      if (snapTimer) { clearTimeout(snapTimer); snapTimer = 0; }
      renderChrome();
    }
    term.write(d, scheduleStick);
  }

  /* ----------------------------------------------------------- snapshot */

  /** Remember DEC private modes the stream sets, so a snapshot can restore them. */
  function trackModes(d) {
    if (!d || d.indexOf('\x1b[?') < 0) return;
    const re = /\x1b\[\?([\d;]+)([hl])/g;
    let m;
    while ((m = re.exec(d))) {
      for (const n of m[1].split(';')) if (CARRY_MODES.has(Number(n))) modes.set(Number(n), m[2]);
    }
  }

  /** Plain text of the VS Code terminal (\n lines) → the xterm, then the modes the program had set. */
  function writeSnapshot(text) {
    const body = String(text).replace(/\r?\n/g, '\r\n');
    let tail = '';
    for (const [n, hl] of modes) tail += `\x1b[?${n}${hl}`;
    term.write(body + tail, () => { scheduleFollow(true); scheduleStick(true); });
  }

  function cancelSnapshot() {
    snapSeq++;
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = 0; }
    flushSnapQueue();
  }

  function flushSnapQueue() {
    const q = snapQueue;
    snapQueue = null;
    if (q && q.length && attached) for (const d of q) write(d);
  }

  /**
   * Ask the extension for the terminal's current screen (terminals.snapshot). initial: right after
   * an attach that brought none — live output waits until it is written. Otherwise (refresh while
   * the terminal's output is not captured): the snapshot replaces what the xterm shows.
   */
  async function requestSnapshot({ initial = false } = {}) {
    if (snapSupported === false || !attached || !conn.online || view.closed) return;
    const seq = ++snapSeq;
    const aSeq = attachSeq;
    if (initial) {
      snapQueue = [];
      setTimeout(() => { if (seq === snapSeq) flushSnapQueue(); }, SNAPSHOT_WAIT_MS);
    }
    lastSnapAt = Date.now();
    try {
      const r = await conn.vsc(windowId, 'terminals.snapshot', { tid }, { timeout: 10000 });
      if (seq !== snapSeq || aSeq !== attachSeq || view.closed || !attached) return;
      snapSupported = true;
      const snap = snapshotOf(r);
      if (!snap || !snap.text) return;
      if (!initial || !snapQueue) { term.reset(); followOut = true; }
      if (snap.cols && snap.rows) setDims(snap.cols, snap.rows);
      writeSnapshot(snap.text);
      if (info) info.snapshot = true;
      hadOutput = true;
      renderChrome();
    } catch (err) {
      // An older extension, or snapshots turned off there (termpocket.terminalSnapshot): stop asking.
      if (/unknown method|turned off/i.test((err && err.message) || '')) snapSupported = false;
    } finally {
      if (seq === snapSeq) flushSnapQueue();
    }
  }

  /** Not capturing (only keystrokes reach the terminal): re-read the screen shortly after typing. */
  function snapshotSoon() {
    if (!attached || !info || info.capturing || snapSupported === false || !term) return;
    if (snapTimer) clearTimeout(snapTimer);
    const wait = Math.max(SNAPSHOT_AFTER_INPUT_MS, 1500 - (Date.now() - lastSnapAt));
    snapTimer = setTimeout(() => { snapTimer = 0; requestSnapshot(); }, wait);
  }

  /** Top of the cursor row and the row height, in the wrap's scroll coordinates (null if unknown). */
  function cursorRow() {
    const screen = host.querySelector('.xterm-screen');
    if (!screen || !term) return null;
    const r = screen.getBoundingClientRect();
    if (!r.height) return null;
    const ch = r.height / term.rows;
    const top = r.top - wrap.getBoundingClientRect().top + wrap.scrollTop + term.buffer.active.cursorY * ch;
    return { top, ch };
  }

  function cursorInView() {
    const c = cursorRow();
    return !c || (c.top >= wrap.scrollTop - 1 && c.top + c.ch <= wrap.scrollTop + wrap.clientHeight + 1);
  }

  /**
   * Rows taller than the pane at the fitted font (desktop never shrinks below 11 px for height):
   * keep the cursor row — the prompt, or a TUI's input box — in view, as near the bottom as fits.
   */
  function scheduleStick(force = false) {
    if (force === true) followOut = true;
    if (stickRaf || !term || manualFont != null) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      if (!followOut || wrap.scrollHeight <= wrap.clientHeight + 2 || cursorInView()) return;
      const c = cursorRow();
      if (c) wrap.scrollTop = Math.max(0, c.top + c.ch * 2 - wrap.clientHeight);
    });
  }

  /* ------------------------------------------------------------- sizing */

  function setDims(cols, rows) {
    const c = Number(cols);
    const r = Number(rows);
    dims = Number.isFinite(c) && Number.isFinite(r) && c > 0 && r > 0
      ? { cols: clamp(Math.floor(c), 2, 1000), rows: clamp(Math.floor(r), 1, 500) }
      : dims;
    const want = dims || { cols: 120, rows: 30 };
    if (term && (term.cols !== want.cols || term.rows !== want.rows)) {
      try { term.resize(want.cols, want.rows); } catch (err) { console.warn('[termpocket] resize failed', err); }
    }
    fitPass = 0;
    scheduleFit();
    renderZoom();
  }

  function scheduleFit() {
    if (fitRaf || !term) return;
    fitRaf = requestAnimationFrame(() => { fitRaf = 0; layout(); });
  }

  function innerSize() {
    const cs = getComputedStyle(wrap);
    return {
      w: wrap.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0),
      h: wrap.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0),
    };
  }

  /** Font size that makes the VS Code terminal's columns (and, within reason, rows) fit. */
  function fitFont() {
    const { w, h: hh } = innerSize();
    const byW = w / (term.cols * cellRatio());
    const byH = hh / (term.rows * lineHeight * 1.2);
    const f = Math.min(byW, Math.max(byH, minHeightFit));
    return Math.floor(clamp(f, MIN_FONT, maxFitFont) * 4) / 4;
  }

  function layout() {
    if (!term) return;
    const { w, h: hh } = innerSize();
    if (w < 40 || hh < 20) return; // hidden: keep the last size
    applyFont(manualFont != null ? manualFont : fitFont());
    if (manualFont == null) { fitPass = 0; requestAnimationFrame(() => requestAnimationFrame(correctFit)); }
    scheduleStick();
    renderZoom();
  }

  /** The cell-size estimate is close but not exact (device-pixel rounding): measure and shrink. */
  function correctFit() {
    if (!term || manualFont != null || fitPass > 3) return;
    const xt = host.querySelector('.xterm');
    if (!xt) return;
    const { w, h: hh } = innerSize();
    const r = xt.getBoundingClientRect();
    if (!r.width || w < 40) return;
    const byW = w / r.width;
    const heightBound = hh / (term.rows * lineHeight * 1.2) < w / (term.cols * cellRatio())
      && fontSize > minHeightFit + 0.01;
    const byH = heightBound ? hh / r.height : Infinity;
    const scale = Math.min(byW, byH);
    if (scale >= 0.997 || fontSize <= MIN_FONT) return;
    fitPass++;
    let next = Math.floor(fontSize * scale * 4) / 4;
    if (next >= fontSize) next = fontSize - 0.25;
    applyFont(Math.max(MIN_FONT, next));
    requestAnimationFrame(() => requestAnimationFrame(correctFit));
  }

  /** Phones: a wide VS Code terminal fits only at a tiny font — say once that pinch zooms. */
  let hinted = false;
  function maybeHint() {
    if (hinted || manualFont != null || fontSize >= 7.5 || !matchMedia('(pointer: coarse)').matches) return;
    hinted = true;
    if (store.get('vstermPinchHint', 0) >= 3) return;
    store.set('vstermPinchHint', Number(store.get('vstermPinchHint', 0)) + 1);
    const el = h('div', { class: 'vst-hint', role: 'status' }, icon('hand', { size: 15 }), 'Pinch to zoom · drag to scroll');
    wrap.append(el);
    setTimeout(() => el.remove(), 4400);
  }

  function applyFont(fs) {
    if (!term || fs === fontSize) return;
    fontSize = fs;
    term.options.fontSize = fs;
  }

  function setManualFont(fs, { quiet = false } = {}) {
    manualFont = fs == null ? null : Math.round(clamp(fs, MIN_FONT, MAX_FONT) * 4) / 4;
    if (!quiet) persistZoom();
    if (manualFont == null) layout();
    else { applyFont(manualFont); scheduleFollow(true); }
    renderZoom();
  }

  function persistZoom() {
    if (manualFont == null) store.del(zoomKey);
    else store.set(zoomKey, manualFont);
  }

  function zoomBy(dir, step) {
    const s = step || (fontSize < 8 ? 0.5 : 1);
    setManualFont(clamp(fontSize + dir * s, MIN_FONT, MAX_FONT));
  }

  /** Keep the cursor in view when the grid is larger than the pane (zoomed in), while typing. */
  function scheduleFollow(force = false) {
    if (followRaf || !term) return;
    if (!force && Date.now() - lastTyped > 2500) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = 0;
      const screen = host.querySelector('.xterm-screen');
      if (!screen) return;
      if (wrap.scrollWidth <= wrap.clientWidth + 2 && wrap.scrollHeight <= wrap.clientHeight + 2) return;
      const r = screen.getBoundingClientRect();
      const cw = r.width / term.cols;
      const ch = r.height / term.rows;
      const buf = term.buffer.active;
      const x = buf.cursorX * cw;
      const y = buf.cursorY * ch;
      const left = wrap.scrollLeft;
      const top = wrap.scrollTop;
      const margin = cw * 6;
      if (x < left + margin || x > left + wrap.clientWidth - margin) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
      if (y < top || y + ch > top + wrap.clientHeight) wrap.scrollTop = Math.max(0, y + ch * 2 - wrap.clientHeight);
    });
  }

  /* -------------------------------------------------------------- input */

  function sendInput(d) {
    if (!d) return;
    if (gone || windowGone()) { haptic(20); return; }
    if (!conn.online) {
      if (Date.now() - lastInputErr > 3000) { lastInputErr = Date.now(); toast('Not connected — input dropped', { type: 'warn' }); }
      return;
    }
    lastTyped = Date.now();
    inBuf += d;
    if (!inTimer) inTimer = setTimeout(flushInput, INPUT_COALESCE_MS);
  }

  function flushInput() {
    inTimer = 0;
    const d = inBuf;
    inBuf = '';
    if (!d || !conn.online) return;
    const p = { tid, d };
    if (lease && !lease.released) p.aid = lease.aid;
    snapshotSoon();
    conn.vsc(windowId, 'terminals.input', p).catch((err) => {
      if (/unknown method/i.test(err.message || '')) {
        // Older extension: plain sendText without a newline carries the same bytes.
        conn.vsc(windowId, 'terminals.sendText', { tid, text: d, addNewLine: false }).catch(() => {});
        return;
      }
      if (Date.now() - lastInputErr > 3000) { lastInputErr = Date.now(); toastError(err, 'Input failed'); }
    });
  }

  function submitCmd(text) {
    if (gone) { toast('This terminal was closed in VS Code', { type: 'warn' }); return false; }
    sendInput(text + '\r');
    return true;
  }

  /** Desktop clipboard keys like Windows Terminal (see termview.js). */
  function desktopKeys(e) {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    const k = (e.key || '').toLowerCase();
    if (k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) {
        copyText(term.getSelection()).then((ok) => { if (!ok) toast('Copy failed', { type: 'err' }); });
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    if (k === 'v') return false;
    return true;
  }

  function focusTerminal() {
    if (tab !== 'live') { if (history) history.focus(); return; }
    if (term) term.focus();
    else cmd.input.focus();
  }

  async function paste() {
    let text = await readClipboard();
    if (text == null) {
      text = await promptDialog({ title: 'Paste into terminal', message: 'Clipboard access isn’t available here — paste the text below.', multiline: true, mono: true, confirmText: 'Paste' });
    }
    if (!text) return;
    if (term) term.paste(text);
    else sendInput(text);
  }

  function setShowKeys(on) {
    showKeys = !!on;
    keysRow.hidden = !showKeys;
    if (embedded) store.set(DESK_XKEYS_KEY, showKeys);
    if (keysToggle) { keysToggle.setAttribute('aria-pressed', String(showKeys)); keysToggle.classList.toggle('on', showKeys); }
    scheduleFit();
  }

  function setShowCmdline(on) {
    showCmdline = !!on;
    cmd.form.hidden = !showCmdline;
    store.set(cmdKey, showCmdline);
    scheduleFit();
  }

  /* --------------------------------------------------------------- tabs */

  function selectTab(v, { initial = false } = {}) {
    tab = v === 'history' ? 'history' : 'live';
    tabs.set(tab);
    livePane.hidden = tab !== 'live';
    histPane.hidden = tab !== 'history';
    zoomBox.hidden = tab !== 'live' || !term;
    if (tab === 'history' && !history) {
      history = openExecLog(ctx, {
        windowId, tid, name, hasShellIntegration: hasSI, bare: true,
        embed: { host: histPane, onClosed: () => { history = null; } },
        onRequestClose: () => view.close(),
      });
    }
    if (tab === 'live') scheduleFit();
    syncAttach();
    renderChrome();
    if (!initial && embedded) requestAnimationFrame(() => focusTerminal());
  }

  /* ------------------------------------------------------------ chrome */

  function updateTitle() {
    titleEl.textContent = name;
    if (t.onTitle) t.onTitle(name, `${name} · ${vs.label(windowId)} (VS Code terminal)`);
  }

  function renderZoom() {
    const d = term ? `${term.cols}×${term.rows}` : '';
    sizeEl.textContent = dims ? d : (d ? `${d}?` : '');
    sizeEl.title = dims ? `The VS Code terminal is ${d}. It is shown at that size; zoom only changes the font here.` : 'Size not reported by VS Code yet';
    fitBtn.classList.toggle('on', manualFont == null);
    fitBtn.setAttribute('aria-pressed', String(manualFont == null));
    const pct = `${Math.round(fontSize * 10) / 10}px`;
    fitBtn.title = manualFont == null ? `Fitted to this view (${pct})` : `Zoomed (${pct}) — tap to fit the view again`;
    renderSub();
  }

  function renderSub() {
    const parts = [vs.label(windowId)];
    if (tab === 'live' && term) parts.push(manualFont == null ? 'fit' : `${Math.round(fontSize * 10) / 10}px`);
    if (!hasSI) parts.push('no shell integration');
    subEl.textContent = parts.join(' · ');
  }

  function setStatus(text, tone = '', tip = '') {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.className = `term-status ${tone}`;
    statusEl.title = tip || '';
  }

  function setOverlay(text) {
    overlay.hidden = !text;
    setChildren(overlay, text ? [h('span', { class: 'spinner' }), h('span', text)] : []);
  }

  function renderChrome() {
    renderSub();
    const wGone = windowGone();
    if (t.onState) t.onState(gone || wGone ? 'err' : liveSupported === false ? 'warn' : null);

    // Status chip
    if (!conn.online) setStatus('offline', 'warn', 'Reconnect now');
    else if (wGone || gone) setStatus('closed', 'err');
    else if (tab !== 'live') setStatus(null);
    else if (liveSupported === false) setStatus('update needed', 'note', 'That VS Code window runs an older TermPocket extension');
    else if (attaching && !attached) setStatus('connecting…', '');
    else if (attached && info && info.capturing) setStatus('live', 'ok', 'Showing this terminal’s output as it happens');
    else if (attached) {
      setStatus('typing only', 'note', info && info.snapshot
        ? 'Its output isn’t streamed right now: this is its screen, read again after you type'
        : 'Output of this terminal isn’t captured right now — see the note');
    } else setStatus(null);

    // Old extension: say so where the terminal would be, with a reload button.
    const oldExt = liveSupported === false && !!term && !wGone && !gone;
    oldExtEl.hidden = !oldExt;
    wrap.hidden = oldExt;
    if (oldExt) renderOldExt();

    // Banner of the live pane
    let node = null;
    const closeBtn = () => btn('Close', { small: true, onClick: () => view.close() });
    if (wGone) {
      node = banner(reloadAsked ? 'The VS Code window is reloading…' : 'This VS Code window disconnected.', {
        tone: reloadAsked ? 'info' : 'err', actions: [closeBtn()],
      });
    } else if (gone) node = banner('This terminal was closed in VS Code.', { tone: 'err', actions: [closeBtn()] });
    else if (attachErr) {
      node = banner(`Couldn’t open the live terminal: ${attachErr}`, {
        tone: 'err', actions: [btn('Retry', { small: true, onClick: () => reattach() })],
      });
    } else if (attached && !noteDismissed && (!info.capturing || !hadOutput)) {
      node = noteBanner();
    }
    setChildren(bannerSlot, node);
    zoomBox.hidden = tab !== 'live' || !term || oldExt;
  }

  function renderOldExt() {
    setChildren(oldExtEl, h('div', { class: 'vst-oldext-box', role: 'status' },
      h('div', { class: 'vst-oldext-ico' }, reloadAsked ? h('span', { class: 'spinner' }) : icon('refresh', { size: 22 })),
      h('div', { class: 'vst-oldext-title' }, reloadAsked
        ? 'Reloading the VS Code window…'
        : 'This VS Code window is running an older TermPocket extension — reload it to see this terminal live.'),
      h('div', { class: 'vst-oldext-sub' }, reloadAsked
        ? 'This terminal reconnects when the window is back.'
        : 'Terminals keep running: VS Code keeps their sessions across a window reload.'),
      h('div', { class: 'vst-oldext-actions' },
        btn(reloadAsked ? 'Reload again' : 'Reload window', { small: true, variant: reloadAsked ? 'ghost' : 'primary', iconName: 'refresh', onClick: () => reloadWindow() }),
        h('button', { type: 'button', class: 'vst-link', onClick: () => selectTab('history') }, 'Show history'))));
  }

  /** Reload the VS Code window (loads the updated extension) after a confirmation. */
  async function reloadWindow() {
    const ask = ctx.confirm || ((o) => confirmDialog({ ...o, iconName: 'refresh' }));
    const ok = await ask({
      title: 'Reload this VS Code window?',
      message: 'The window restarts its extensions, which loads the updated TermPocket extension, and this terminal then shows live. '
        + 'Running terminals keep running: VS Code keeps terminal sessions and their processes alive across a window reload and reconnects them '
        + '(unless terminal.integrated.enablePersistentSessions is turned off).',
      confirmText: 'Reload window',
    });
    if (!ok || view.closed) return;
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    reloadAsked = true;
    reloadKey = windowKey(vs.get(windowId));
    renderChrome();
    // The window goes away while it answers (or never answers): either way it reloads.
    conn.vsc(windowId, 'commands.run', { command: 'workbench.action.reloadWindow' }, { timeout: 15000 }).catch((err) => {
      if (vs.get(windowId) && !/timeout|closed|disconnect|did not answer/i.test((err && err.message) || '')) {
        reloadAsked = false;
        renderChrome();
        toastError(err, 'Could not reload the VS Code window');
      }
    });
    toast('Reloading the VS Code window…', { timeout: 2500 });
  }

  function noteBanner() {
    let text;
    // With a snapshot on screen our own short text is the accurate one (this view re-reads the screen
    // after typing); the extension's longer note stays available as the tooltip.
    if (info.note && !(info.snapshot && !info.capturing)) text = info.note;
    else if (!info.capturing && !hasSI) {
      text = info.snapshot
        ? 'No shell integration here, so this terminal’s output isn’t streamed: this is its screen, read again after you type.'
        : 'This terminal has no shell integration, so VS Code doesn’t share its output. Your keystrokes still reach it.';
    } else if (!info.capturing) {
      text = info.snapshot
        ? 'Started before TermPocket was watching: this is its screen as of now, read again after you type.'
        : 'What is running now started before TermPocket was watching, so its output appears from now on.';
    } else text = 'Nothing captured yet: output appears here from now on.';
    const dismiss = iconBtn('x', 'Dismiss', () => { noteDismissed = true; renderChrome(); scheduleFit(); }, { cls: 'sm' });
    const openBtn = btn('Open a phone-visible terminal', {
      small: true, variant: vsLook ? 'ghost' : 'primary',
      title: `A new “${MIRROR_PROFILE}” terminal in this window: everything it shows is visible here, with its whole history`,
      onClick: () => openPhoneVisible(),
    });
    // Desktop: one slim line. Phone: room for the "make it the default" switch as well.
    const el = banner(text, {
      tone: info.capturing ? 'info' : 'warn',
      actions: vsLook ? [openBtn, dismiss] : [
        openBtn,
        btn('Make new terminals phone-visible', { small: true, variant: 'ghost', onClick: () => setMirrorDefault(conn, vs, true, windowId) }),
        dismiss,
      ],
    });
    el.classList.add('vst-note');
    if (vsLook) el.classList.add('vst-slim');
    el.title = info.note && info.note !== text ? `${text}\n\n${info.note}` : text;
    return el;
  }

  async function openPhoneVisible() {
    if (typeof ctx.openPhoneVisible === 'function') { ctx.openPhoneVisible(windowId); return; }
    try {
      const w = vs.get(windowId);
      const p = { mirror: true };
      if (w && Array.isArray(w.folders) && w.folders[0]) p.cwd = w.folders[0];
      await conn.vsc(windowId, 'terminals.create', p);
      toast('A phone-visible terminal is open in VS Code', { type: 'ok' });
    } catch (err) { toastError(err, 'Could not create a phone-visible terminal'); }
  }

  /** The window reloaded (it comes back with a new windowId): find this terminal there again. */
  async function followReload() {
    if (!reloadAsked || reopening || !windowGone() || typeof ctx.reopenAfterReload !== 'function') return;
    const next = vs.windows.find((w) => w.windowId !== windowId && windowKey(w) === reloadKey);
    if (!next) return;
    reopening = true;
    try {
      if (await ctx.reopenAfterReload(next.windowId, name)) view.close();
    } catch (err) {
      console.warn('[termpocket] reopen after reload failed', err);
    } finally { reopening = false; }
  }

  /* -------------------------------------------------------------- menu */

  async function showOnPc() {
    try { await conn.vsc(windowId, 'terminals.show', { tid }); toast('Shown in VS Code', { type: 'ok' }); }
    catch (err) { toastError(err); }
  }

  function bufferText(maxLines = 3000) {
    if (!term) return '';
    const buf = term.buffer.active;
    const start = Math.max(0, buf.length - maxLines);
    const lines = [];
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  async function copyOut() {
    if (term && term.hasSelection()) {
      const ok = await copyText(term.getSelection());
      toast(ok ? 'Selection copied' : 'Copy failed', { type: ok ? 'ok' : 'err' });
      return;
    }
    const text = bufferText();
    const ta = h('textarea', { class: 'input textarea mono copy-area', readOnly: true, spellcheck: false });
    ta.value = text;
    const s = sheet({
      title: 'Terminal text',
      subtitle: 'Select a part, or copy everything',
      content: [ta, h('div', { class: 'sheet-actions' },
        btn('Copy all', {
          variant: 'primary', iconName: 'copy',
          onClick: async () => {
            const ok = await copyText(text);
            toast(ok ? 'Copied' : 'Copy failed', { type: ok ? 'ok' : 'err' });
            if (ok) s.close();
          },
        }))],
    });
    requestAnimationFrame(() => { ta.scrollTop = ta.scrollHeight; });
  }

  async function sendTextDialog() {
    const text = await promptDialog({ title: `Send to “${name}”`, message: 'Typed into the terminal followed by Enter.', mono: true, multiline: true, confirmText: 'Send' });
    if (text == null || text === '') return;
    sendInput(text.replace(/\r?\n/g, '\r') + '\r');
  }

  function showMenu() {
    const live = tab === 'live';
    const actions = live ? [
      term && { label: manualFont == null ? 'Fitted to this view' : 'Fit to this view', sub: `Font ${Math.round(fontSize * 10) / 10}px · pinch or Ctrl+wheel to zoom`, iconName: 'fit', onSelect: () => setManualFont(null), disabled: manualFont == null },
      { label: showCmdline ? 'Hide command line' : 'Show command line', iconName: 'type', onSelect: () => setShowCmdline(!showCmdline) },
      embedded && { label: showKeys ? 'Hide extra keys' : 'Show extra keys', iconName: 'keyboard', onSelect: () => setShowKeys(!showKeys) },
      { label: 'Copy text', sub: term && term.hasSelection() ? 'Copy the current selection' : 'Open the screen & scrollback as text', iconName: 'copy', onSelect: copyOut, disabled: !term },
      { label: 'Paste', iconName: 'paste', onSelect: paste },
      { label: 'Send text…', iconName: 'send', onSelect: sendTextDialog },
      liveSupported === false
        ? { label: 'Reload the VS Code window', sub: 'Loads the updated TermPocket extension; terminals keep running', iconName: 'refresh', onSelect: () => reloadWindow(), disabled: !conn.online }
        : { label: 'Reload live view', sub: 'Show what the VS Code terminal shows now', iconName: 'refresh', onSelect: () => refreshScreen(), disabled: !conn.online },
      { label: 'Show command history', sub: 'Each command with its output and exit code', iconName: 'history', onSelect: () => selectTab('history') },
      { label: 'Clear screen (this device only)', iconName: 'x', onSelect: () => { if (term) term.clear(); } },
    ] : (history ? history.menuActions() : []);
    actionSheet({
      title: name,
      subtitle: `${vs.label(windowId)} · VS Code terminal`,
      actions: [
        ...actions,
        { label: 'Show in VS Code', iconName: 'external', onSelect: showOnPc },
        { label: 'Make new terminals phone-visible', sub: `New VS Code terminals use the “${MIRROR_PROFILE}” profile`, iconName: 'link', onSelect: () => setMirrorDefault(conn, vs, true, windowId) },
      ],
    });
  }

  /* ---------------------------------------------------------- teardown */

  const refit = debounce(() => scheduleFit(), 60);
  window.addEventListener('resize', refit);

  function cleanup() {
    for (const off of offs) off();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', refit);
    refit.cancel && refit.cancel();
    ro.disconnect();
    if (fitRaf) cancelAnimationFrame(fitRaf);
    if (followRaf) cancelAnimationFrame(followRaf);
    if (detachTimer) clearTimeout(detachTimer);
    if (inTimer) { clearTimeout(inTimer); flushInput(); }
    detach();
    if (history) { try { history.close(); } catch { /* ignore */ } history = null; }
    try { term && term.dispose(); } catch { /* ignore */ }
  }

  return {
    vst: { windowId, tid, name, hasShellIntegration: hasSI },
    close: () => view.close(),
    back: () => (view.embedded ? view.back() : (view.back(), true)),
    focus: () => { if (!view.closed) focusTerminal(); },
    onActivate: () => { scheduleFit(); syncAttach(); },
    onDeactivate: () => syncAttach(),
    selectTab: (v) => { if (!view.closed && v !== tab) selectTab(v); },
    /** Manual font size (null = fit the VS Code terminal into the view). */
    zoom: (delta) => { if (!view.closed) { if (delta === 0) setManualFont(null); else zoomBy(delta); } },
    /** Extra-keys row (desktop: hidden by default; the workbench panel's "…" menu toggles it). */
    toggleKeys: () => { if (!view.closed) setShowKeys(!showKeys); },
    get keysShown() { return showKeys; },
    /** Show what the VS Code terminal shows now (snapshot, else a fresh attach). */
    refresh: () => { if (!view.closed) refreshScreen(); },
    /** That window's extension has no live view (older version): "Reload window" is offered. */
    get needsReload() { return liveSupported === false; },
    reloadWindow: () => { if (!view.closed) reloadWindow(); },
    get tab() { return tab; },
    get closed() { return view.closed; },
  };
}

/** Same VS Code window across a reload (its windowId changes): first folder, else name. */
function windowKey(w) {
  return w ? String((w.folders && w.folders[0]) || w.name || '').toLowerCase() : '';
}

/** The attach / terminals.snapshot `snapshot`: {text, cols?, rows?, lines?, at?} (or a bare string). */
function snapshotOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return { text: v };
  if (typeof v === 'object' && typeof v.text === 'string') {
    const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
    return { text: v.text, cols: n(v.cols), rows: n(v.rows), lines: n(v.lines), at: v.at || null };
  }
  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : clamp(n, MIN_FONT, MAX_FONT);
}
