// Full-screen interactive terminal for an agent PTY (§4.1) rendered with xterm.js.
//
// Features: attach/re-attach with scrollback, extra-keys row with sticky Ctrl/Alt
// (tap = next key only, tap again = lock, third tap = off), key auto-repeat on
// arrows, font size ±, fit-to-screen (pty.resize), a command-line input box,
// paste, copy-out, rename/kill. Falls back to a plain ANSI log if xterm.js is
// missing from web/vendor/.

import {
  h, iconBtn, btn, store, toast, toastError, openView, actionSheet, promptDialog, confirmDialog,
  sheet, copyText, readClipboard, debounce, clamp, haptic, banner, setChildren,
  TERM_THEME, MONO_FONT, renderAnsi, edgeFade, VSCODE_TERM_THEME, VSCODE_TERM_FONT, VSCODE_TERM_FONT_SIZE, VSCODE_TERM_LOOK,
} from './ui.js';
import { createKeyBar, createCmdLine } from './termkeys.js';

const FONT_KEY = 'termFontSize';
const DESK_FONT_KEY = 'termFontSizeDesk'; // desktop (VS Code look): its own size, default 14 like VS Code
const CMDLINE_KEY = 'termCmdline';
const DESK_CMDLINE_KEY = 'termCmdlineDesk';
const DESK_XKEYS_KEY = 'termXkeysDesk';
const MIN_FONT = 8;
const MAX_FONT = 28;
const DESK_MIN_HEIGHT_FONT = 11; // desktop fixed size: rows that don't fit at this size scroll instead

/**
 * Open the terminal view.
 * @param {object} ctx   { conn, getSession(id), windowsPty?, vs, look?: 'vscode'|'app' (default: 'vscode' when embedded,
 *                        i.e. desktop), termTheme? (xterm theme), termFont? (font family) }
 * @param {{ id: string, title?: string, embed?: {host: HTMLElement, onClosed?: Function},
 *           onTitle?: (title: string, tip: string) => void, onState?: (tone: string|null) => void }} opts
 *   embed → desktop split view: the terminal lives in a tab pane, the physical keyboard goes straight
 *   into xterm, the extra-keys row and command line start hidden (toggle in the header / menu).
 */
export function openTermView(ctx, { id, title, embed, onTitle, onState }) {
  const { conn } = ctx;
  const embedded = !!(embed && embed.host);
  // Desktop terminals look like VS Code's integrated terminal (colours, Consolas 14 px, cursor).
  const vsLook = ctx.look ? ctx.look === 'vscode' : embedded;
  const fontKey = vsLook ? DESK_FONT_KEY : FONT_KEY;
  let session = (ctx.getSession && ctx.getSession(id)) || { id, title: title || id };
  let fitMode = !session.mirror; // mirrored PTYs keep VS Code's size until the user fits
  let userChoseFit = false;
  const defFont = vsLook ? VSCODE_TERM_FONT_SIZE : 13;
  let fontSize = clamp(Number(store.get(fontKey, defFont)) || defFont, MIN_FONT, MAX_FONT);
  let attached = false;
  let exited = !!session.exited;
  let removed = false;
  let lastSent = { cols: session.cols || 0, rows: session.rows || 0 };
  let lastInputErr = 0;
  const cmdKey = embedded ? DESK_CMDLINE_KEY : CMDLINE_KEY;
  let showCmdline = embedded ? store.get(cmdKey, false) === true : store.get(cmdKey, true) !== false;
  let showKeys = embedded ? store.get(DESK_XKEYS_KEY, false) === true : true;
  const offs = [];
  let fitRaf = 0;
  // Desktop, fixed size (a mirrored PTY keeps VS Code's grid): the font shrinks so that grid fits the
  // pane like the Live view does (never above the chosen size; rows that do not fit at >= 11 px
  // scroll, pinned to the cursor row — the prompt or a TUI's input box).
  let shrinkRaf = 0;
  let stickRaf = 0;
  let followOut = true;
  // Identity of the shell behind `id`. A restarted agent numbers its sessions from p1 again, so the
  // id alone could silently re-attach this view to an unrelated new shell after a reconnect.
  let identity = session.createdAt || null;
  const sameShell = (s) => !identity || !s || !s.createdAt || s.createdAt === identity;

  /* ---------------------------------------------------------------- DOM */

  const titleEl = h('div', { class: 'view-title' });
  const subEl = h('div', { class: 'view-sub mono' });
  // Connection state chip next to the title. The full-screen view hides the app's offline bar, so
  // tapping the chip is the way to retry right away instead of waiting for the backoff timer.
  const statusEl = h('button', {
    type: 'button', class: 'term-status', hidden: true, title: 'Reconnect now',
    onClick: () => { if (!conn.online) conn.reconnectNow(); },
  });
  const bannerSlot = h('div', { class: 'banner-slot' });
  const host = h('div', { class: 'term-host' });
  const wrap = h('div', { class: 'term-wrap' }, host);
  const overlay = h('div', { class: 'term-overlay', hidden: true });
  wrap.append(overlay);

  const keyBar = createKeyBar({ send: (d) => sendInput(d), getTerm: () => term, paste: () => paste(), focus: () => focusTerminal() });
  const keysRow = keyBar.el;
  const applyMods = keyBar.applyMods;

  const cmd = createCmdLine({ submit: (text) => submitCmd(text), hidden: !showCmdline });
  const cmdInput = cmd.input;
  const cmdForm = cmd.form;

  keysRow.hidden = !showKeys;
  const keysToggle = embedded
    ? iconBtn('keyboard', 'Extra keys', () => setShowKeys(!showKeys), { keepFocus: true, cls: 'keys-toggle' })
    : null;
  if (keysToggle) keysToggle.setAttribute('aria-pressed', String(showKeys));

  const root = h('section', { class: ['term-view', vsLook && 'vs-look'], 'aria-label': 'Terminal' },
    h('header', { class: 'view-head' },
      embedded ? null : iconBtn('back', 'Back', () => view.back(), { cls: 'back' }),
      h('div', { class: 'view-titles' }, h('div', { class: 'title-row' }, titleEl, statusEl), subEl),
      h('div', { class: 'view-actions' },
        iconBtn('minus', 'Smaller font', () => setFont(fontSize - 1), { keepFocus: true }),
        iconBtn('plus', 'Larger font', () => setFont(fontSize + 1), { keepFocus: true }),
        iconBtn('fit', 'Fit to screen', () => fitNow(), { keepFocus: true }),
        keysToggle,
        iconBtn('more', 'More', () => showMenu()))),
    bannerSlot, wrap, keysRow, cmdForm);

  const view = openView(root, { onClose: cleanup, embed });

  function setShowKeys(on) {
    showKeys = !!on;
    keysRow.hidden = !showKeys;
    if (embedded) store.set(DESK_XKEYS_KEY, showKeys);
    if (keysToggle) { keysToggle.setAttribute('aria-pressed', String(showKeys)); keysToggle.classList.toggle('on', showKeys); }
    if (showKeys) requestAnimationFrame(() => edgeFade(keysRow, { observe: false }));
    scheduleFit();
  }
  if (keysToggle) keysToggle.classList.toggle('on', showKeys);

  /* --------------------------------------------------------------- xterm */

  let term = null;
  let fit = null;
  let fallbackEl = null;
  let fallbackText = '';
  let fallbackRaf = 0;

  if (typeof window.Terminal === 'function') {
    try {
      term = new window.Terminal({
        fontFamily: ctx.termFont || (vsLook ? VSCODE_TERM_FONT : MONO_FONT),
        fontSize,
        lineHeight: 1.12,
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
      if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
        fit = new window.FitAddon.FitAddon();
        term.loadAddon(fit);
      }
      term.open(host);
      term.onData((d) => sendInput(applyMods(d)));
      term.onBinary((d) => sendInput(d));
      if (embedded) term.attachCustomKeyEventHandler(desktopKeys);
    } catch (err) {
      console.error('[termpocket] xterm init failed', err);
      term = null;
    }
  }
  if (!term) {
    fallbackEl = h('pre', { class: 'term-fallback mono' });
    host.append(fallbackEl);
    wrap.classList.add('fallback');
    showBanner(banner('xterm.js was not found in web/vendor — showing plain output. Run “npm run vendor” in agent/.', { tone: 'warn' }));
  }
  if (!fit) wrap.classList.add('fixed');

  updateTitle();
  applyLayoutMode();

  const ro = new ResizeObserver(() => scheduleFit());
  ro.observe(wrap);

  /* ------------------------------------------------------------- events */

  offs.push(conn.on('pty.data', (p) => {
    if (p.id !== id || !attached) return;
    write(p.d);
  }));
  offs.push(conn.on('pty.exit', (p) => {
    if (p.id !== id) return;
    exited = true;
    session = { ...session, exited: true, exitCode: p.exitCode };
    write(`\r\n\x1b[2m[process exited with code ${p.exitCode ?? '?'}]\x1b[0m\r\n`);
    renderState();
  }));
  offs.push(conn.on('pty.changed', (p) => {
    const list = Array.isArray(p.sessions) ? p.sessions : [];
    const s = list.find((x) => x.id === id);
    if (!s || !sameShell(s)) {
      if (!removed) { removed = true; attached = false; renderState(); }
      return;
    }
    const sizeChanged = s.cols !== session.cols || s.rows !== session.rows;
    session = s;
    exited = !!s.exited;
    updateTitle();
    if (sizeChanged && !fitMode) scheduleFit();
    renderState();
  }));
  offs.push(conn.on('ready', () => { attach(); }));
  offs.push(conn.on('down', () => {
    attached = false;
    setStatus('reconnecting…', 'warn');
  }));

  if (conn.online) attach();
  else setStatus('offline', 'warn');

  /* ------------------------------------------------------------ attach */

  async function attach() {
    setOverlay('Attaching…');
    attached = false;
    try {
      const res = await conn.request('pty.attach', { id });
      if (view.closed) { conn.request('pty.detach', { id }).catch(() => {}); return; }
      if (res && res.session && !sameShell(res.session)) {
        // Same id, different shell (the agent restarted): the terminal this view showed is gone.
        conn.request('pty.detach', { id }).catch(() => {});
        setOverlay(null);
        setStatus(null);
        removed = true;
        renderState();
        return;
      }
      session = (res && res.session) || session;
      if (session.createdAt) identity = session.createdAt;
      exited = !!session.exited;
      removed = false;
      if (!userChoseFit && fitMode !== !session.mirror) { fitMode = !session.mirror; applyLayoutMode(); }
      resetScreen();
      if (res && res.buffer) write(res.buffer);
      attached = true;
      lastSent = { cols: session.cols || 0, rows: session.rows || 0 };
      setOverlay(null);
      setStatus(null);
      updateTitle();
      renderState();
      scheduleFit();
    } catch (err) {
      setOverlay(null);
      if (!conn.online) { setStatus('offline', 'warn'); return; }
      removed = true;
      renderState(err.message);
    }
  }

  function resetScreen() {
    if (term) term.reset();
    else { fallbackText = ''; scheduleFallbackRender(); }
  }

  function write(d) {
    if (!d) return;
    if (term) { if (vsLook) term.write(d, scheduleStick); else term.write(d); return; }
    fallbackText += d;
    if (fallbackText.length > 300000) fallbackText = fallbackText.slice(-200000);
    scheduleFallbackRender();
  }

  function scheduleFallbackRender() {
    if (fallbackRaf) return;
    fallbackRaf = requestAnimationFrame(() => {
      fallbackRaf = 0;
      const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60;
      renderAnsi(fallbackEl, fallbackText);
      if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
    });
  }

  /* ------------------------------------------------------------- input */

  function sendInput(d) {
    if (!d) return;
    if (exited || removed) { haptic(20); return; }
    if (!conn.online) {
      if (Date.now() - lastInputErr > 3000) { lastInputErr = Date.now(); toast('Not connected — input dropped', { type: 'warn' }); }
      return;
    }
    conn.request('pty.input', { id, d }).catch((err) => {
      if (Date.now() - lastInputErr > 3000) { lastInputErr = Date.now(); toastError(err, 'Input failed'); }
    });
  }

  /**
   * Desktop clipboard keys, like Windows Terminal: Ctrl+C copies when text is selected (otherwise it
   * is the usual interrupt), Ctrl+Shift+C copies, Ctrl+V / Ctrl+Shift+V paste through the browser's
   * own paste event (xterm turns it into input, honouring bracketed-paste mode).
   */
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
    if (term) term.focus();
    else cmdInput.focus();
  }

  async function paste() {
    let text = await readClipboard();
    if (text == null) {
      text = await promptDialog({ title: 'Paste into terminal', message: 'Clipboard access isn’t available here — paste the text below.', multiline: true, mono: true, confirmText: 'Paste' });
    }
    if (!text) return;
    if (term) term.paste(text); // honours bracketed-paste mode; routes through onData
    else sendInput(text);
  }

  function submitCmd(text) {
    if (exited || removed) { toast('This terminal has exited', { type: 'warn' }); return false; }
    sendInput(text + '\r');
    return true;
  }

  /* --------------------------------------------------------- sizing */

  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => { fitRaf = 0; doFit(false); });
  }

  const sendResize = debounce((cols, rows) => {
    if (!attached || exited || removed || !conn.online) return;
    conn.request('pty.resize', { id, cols, rows }).catch((err) => console.warn('[termpocket] pty.resize failed', err));
  }, 150);

  function doFit(force) {
    if (!term) return;
    // A hidden tab (display:none) has no size: never shrink the PC terminal to nothing.
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    if (fitMode && fit) {
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize; // no shrink while fitting
      let dims;
      try { dims = fit.proposeDimensions(); } catch { dims = null; }
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const cols = clamp(Math.floor(dims.cols), 20, 500);
      const rows = clamp(Math.floor(dims.rows), 4, 300);
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      if (force || cols !== lastSent.cols || rows !== lastSent.rows) {
        lastSent = { cols, rows };
        sendResize(cols, rows);
      }
    } else {
      const cols = session.cols || term.cols;
      const rows = session.rows || term.rows;
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      if (vsLook) scheduleShrink();
    }
    updateSub();
  }

  function scheduleShrink(pass = 0) {
    if (shrinkRaf) return;
    shrinkRaf = requestAnimationFrame(() => { shrinkRaf = 0; shrinkToPane(pass); });
  }

  /** Desktop fixed size: the font that makes the PTY's grid fit the pane (at most fontSize). */
  function shrinkToPane(pass) {
    if (!term || fitMode || view.closed) return;
    const xt = host.querySelector('.xterm');
    const r = xt && xt.getBoundingClientRect();
    if (!r || !r.width || !r.height || !wrap.clientWidth) return;
    const cs = getComputedStyle(wrap);
    const w = wrap.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const hh = wrap.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    const cur = term.options.fontSize || fontSize;
    const byW = (cur * w) / r.width;
    const byH = Math.max((cur * hh) / r.height, Math.min(DESK_MIN_HEIGHT_FONT, fontSize));
    const next = Math.floor(clamp(Math.min(byW, byH, fontSize), MIN_FONT, fontSize) * 4) / 4;
    if (Math.abs(next - cur) >= 0.25) {
      term.options.fontSize = next;
      if (pass < 4) scheduleShrink(pass + 1);
    }
    scheduleStick(pass === 0);
  }

  /** true when the cursor row is inside the wrap's visible area, else {top, ch} of that row. */
  function cursorInView() {
    if (!term) return true;
    const screen = host.querySelector('.xterm-screen');
    const r = screen && screen.getBoundingClientRect();
    if (!r || !r.height) return true;
    const ch = r.height / term.rows;
    const top = r.top - wrap.getBoundingClientRect().top + wrap.scrollTop + term.buffer.active.cursorY * ch;
    return top >= wrap.scrollTop - 1 && top + ch <= wrap.scrollTop + wrap.clientHeight + 1 ? true : { top, ch };
  }

  function scheduleStick(force = false) {
    if (force === true) followOut = true;
    if (stickRaf || !term || fitMode || !vsLook) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      if (!followOut || wrap.scrollHeight <= wrap.clientHeight + 2) return;
      const c = cursorInView();
      if (c !== true) wrap.scrollTop = Math.max(0, c.top + c.ch * 2 - wrap.clientHeight);
    });
  }
  if (vsLook) wrap.addEventListener('scroll', () => { followOut = cursorInView() === true; }, { passive: true });

  function fitNow({ quiet = false } = {}) {
    if (!fit) { if (!quiet) toast('Fit addon missing — cannot fit', { type: 'warn' }); return; }
    fitMode = true;
    userChoseFit = true;
    applyLayoutMode();
    requestAnimationFrame(() => {
      doFit(true);
      if (!quiet) toast(`Resized to ${term.cols}×${term.rows}`, { timeout: 1400 });
    });
  }

  function applyLayoutMode() {
    wrap.classList.toggle('fixed', !fitMode || !fit);
    scheduleFit();
  }

  function setFont(n) {
    const next = clamp(n, MIN_FONT, MAX_FONT);
    if (next === fontSize) return;
    fontSize = next;
    store.set(fontKey, fontSize);
    if (term) term.options.fontSize = fontSize;
    else if (fallbackEl) fallbackEl.style.fontSize = `${fontSize}px`;
    scheduleFit();
  }
  if (fallbackEl) fallbackEl.style.fontSize = `${fontSize}px`;

  /* --------------------------------------------------------- chrome */

  function updateTitle() {
    const t = session.title || session.shell || 'Terminal';
    titleEl.textContent = t;
    updateSub();
    if (onTitle) onTitle(t, [t, session.shell, session.cwd].filter(Boolean).join(' · '));
  }

  function updateSub() {
    const parts = [];
    const cols = term ? term.cols : session.cols;
    const rows = term ? term.rows : session.rows;
    if (cols && rows) parts.push(`${cols}×${rows}`);
    if (session.shell) parts.push(session.shell);
    if (session.mirror) parts.push('mirrored in VS Code');
    if (!fitMode && fit) parts.push('fixed size');
    subEl.textContent = parts.join(' · ');
  }

  function setStatus(text, tone = '') {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.className = `term-status ${tone}`;
  }

  function setOverlay(text) {
    overlay.hidden = !text;
    setChildren(overlay, text ? [h('span', { class: 'spinner' }), h('span', text)] : []);
  }

  function showBanner(node) {
    setChildren(bannerSlot, node);
  }

  function renderState(errMsg) {
    if (onState) onState(removed ? 'err' : exited ? 'exited' : null);
    if (removed) {
      showBanner(banner(errMsg ? `Terminal unavailable: ${errMsg}` : 'This terminal was closed on the PC.', {
        tone: 'err',
        actions: [btn('Close', { small: true, onClick: () => view.close() })],
      }));
      cmdInput.disabled = true;
      return;
    }
    cmdInput.disabled = false;
    if (exited) {
      const code = session.exitCode;
      showBanner(banner(`Process exited${code != null ? ` with code ${code}` : ''}.`, {
        tone: code === 0 ? 'info' : 'warn',
        actions: [
          btn('Remove', { small: true, variant: 'ghost', onClick: () => killSession(false) }),
          btn('Close', { small: true, onClick: () => view.close() }),
        ],
      }));
      return;
    }
    if (!fallbackEl) showBanner(null);
  }

  async function killSession(ask) {
    if (ask) {
      const ok = await confirmDialog({
        title: 'Kill this terminal?',
        message: `“${session.title || id}” and any program running in it will be terminated${session.mirror ? ' (also in VS Code)' : ''}.`,
        confirmText: 'Kill', danger: true, iconName: 'trash',
      });
      if (!ok) return;
    }
    try {
      await conn.request('pty.kill', { id });
      removed = true;
      view.close();
    } catch (err) { toastError(err, 'Kill failed'); }
  }

  async function rename() {
    const name = await promptDialog({ title: 'Rename terminal', value: session.title || '', confirmText: 'Rename', validate: (v) => (v.trim() ? null : 'Name can’t be empty') });
    if (name == null) return;
    try {
      await conn.request('pty.rename', { id, title: name.trim() });
      session = { ...session, title: name.trim() };
      updateTitle();
    } catch (err) { toastError(err, 'Rename failed'); }
  }

  function bufferText(maxLines = 3000) {
    if (!term) return fallbackText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
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
            toast(ok ? 'Copied to phone clipboard' : 'Copy failed', { type: ok ? 'ok' : 'err' });
            if (ok) s.close();
          },
        }))],
    });
    requestAnimationFrame(() => { ta.scrollTop = ta.scrollHeight; });
  }

  function showMenu() {
    actionSheet({
      title: session.title || 'Terminal',
      subtitle: [session.shell, session.cwd, session.pid ? `pid ${session.pid}` : ''].filter(Boolean).join(' · '),
      actions: [
        { label: 'Fit to screen', sub: embedded ? 'Resize the PC terminal to this pane' : 'Resize the PC terminal to this phone', iconName: 'fit', onSelect: fitNow },
        fit && {
          label: fitMode ? 'Keep PC size (stop auto-fit)' : 'Auto-fit on rotate / keyboard',
          iconName: 'maximize',
          onSelect: () => { fitMode = !fitMode; userChoseFit = true; applyLayoutMode(); if (fitMode) doFit(true); else updateSub(); },
        },
        { label: showCmdline ? 'Hide command line' : 'Show command line', iconName: 'type',
          onSelect: () => { showCmdline = !showCmdline; cmdForm.hidden = !showCmdline; store.set(cmdKey, showCmdline); scheduleFit(); } },
        embedded && { label: showKeys ? 'Hide extra keys' : 'Show extra keys', iconName: 'keyboard', onSelect: () => setShowKeys(!showKeys) },
        { label: 'Copy text', sub: term && term.hasSelection() ? 'Copy the current selection' : 'Open the scrollback as text', iconName: 'copy', onSelect: copyOut },
        { label: 'Paste', iconName: 'paste', onSelect: paste },
        { label: 'Clear screen (phone only)', iconName: 'x', onSelect: () => { if (term) term.clear(); else { fallbackText = ''; scheduleFallbackRender(); } } },
        { label: 'Rename…', iconName: 'edit', onSelect: rename, disabled: removed },
        exited
          ? { label: 'Remove from list', iconName: 'trash', danger: true, onSelect: () => killSession(false) }
          : { label: 'Kill terminal', iconName: 'trash', danger: true, onSelect: () => killSession(true), disabled: removed },
      ],
    });
  }

  /* --------------------------------------------------------- teardown */

  function cleanup() {
    for (const off of offs) off();
    ro.disconnect();
    sendResize.cancel();
    if (fitRaf) cancelAnimationFrame(fitRaf);
    if (shrinkRaf) cancelAnimationFrame(shrinkRaf);
    if (stickRaf) cancelAnimationFrame(stickRaf);
    if (fallbackRaf) cancelAnimationFrame(fallbackRaf);
    if (attached && !removed && conn.online) conn.request('pty.detach', { id }).catch(() => {});
    attached = false;
    try { term && term.dispose(); } catch { /* ignore */ }
  }

  return {
    id,
    close: () => view.close(),
    back: () => (view.embedded ? view.back() : (view.back(), true)),
    focus: () => { if (!view.closed) focusTerminal(); },
    onActivate: () => scheduleFit(),
    /** Resize the PTY (and a mirroring VS Code terminal) to this view, like the Fit button. */
    fit: (o) => { if (!view.closed) fitNow(o && typeof o === 'object' ? o : {}); },
    setFont: (n) => { if (!view.closed) setFont(n); },
    /** Extra-keys row (desktop: hidden by default; the workbench panel's "…" menu toggles it). */
    toggleKeys: () => { if (!view.closed) setShowKeys(!showKeys); },
    get keysShown() { return showKeys; },
    get fontSize() { return fontSize; },
    /** The shell behind this view no longer exists (killed, or the agent restarted). */
    get gone() { return removed; },
    get closed() { return view.closed; },
  };
}
