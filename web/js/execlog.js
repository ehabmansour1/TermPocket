// "Exec log" view for a regular (non-mirrored) VS Code terminal (§4.2 / §5.2).
//
// VS Code doesn't expose the raw byte stream of ordinary terminals, but with shell
// integration it reports each command execution. We show the history
// (terminals.history) plus the live term.exec.* stream as one block per command
// with an exit-code badge, and let the user run commands (terminals.exec) or send
// raw text (terminals.sendText).

import {
  h, iconBtn, btn, toast, toastError, openView, actionSheet, setChildren, banner, spinner,
  emptyState, renderAnsi, stripAnsi, fmtTime, fmtMs, haptic, store, noFocusSteal, edgeFade, shortPath,
} from './ui.js';
import { icon } from './icons.js';

const MAX_OUTPUT = 256 * 1024;
const MODE_KEY = 'execMode';

/**
 * @param {object} ctx  { conn, vs }
 * @param {{ windowId: string, tid: string, name?: string, hasShellIntegration?: boolean,
 *           embed?: {host: HTMLElement, onClosed?: Function}, onTitle?: (name: string) => void,
 *           bare?: boolean, onRequestClose?: () => void }} t
 *   embed → shown inside a tab pane of the desktop Terminals split view.
 *   bare  → no header and no connection / closed banners: the log is the "History" tab of the live
 *           VS Code terminal view (vsterm.js), which owns the title bar, those states and the menu.
 *           onRequestClose then closes that parent view.
 */
export function openExecLog(ctx, t) {
  const { conn, vs } = ctx;
  const { windowId, tid } = t;
  const bare = !!t.bare;
  const closeOwner = () => (t.onRequestClose ? t.onRequestClose() : view.close());
  let name = t.name || 'Terminal';
  let hasSI = t.hasShellIntegration !== false;
  let gone = false;
  let mode = store.get(MODE_KEY, 'run'); // 'run' (terminals.exec) | 'text' (terminals.sendText)
  let addNewLine = true;
  const blocks = new Map(); // execId → block
  const offs = [];

  /* ---------------------------------------------------------------- DOM */

  const titleEl = h('div', { class: 'view-title' }, name);
  const subEl = h('div', { class: 'view-sub' });
  const bannerSlot = h('div', { class: 'banner-slot' });
  const list = h('div', { class: 'exec-list', role: 'log', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'exec-scroll' }, list);
  const jumpBtn = h('button', { type: 'button', class: 'jump-bottom', hidden: true, 'aria-label': 'Jump to latest', onClick: () => scrollToBottom(true) }, icon('chevronDown', { size: 18 }));

  const input = h('input', {
    class: 'input mono cmd-input', type: 'text', autocomplete: 'off', spellcheck: false,
    autocapitalize: 'off', enterKeyHint: 'send', 'aria-label': 'Command',
  });
  const modeBtn = h('button', { type: 'button', class: 'mode-toggle', onClick: () => setMode(mode === 'run' ? 'text' : 'run') });
  noFocusSteal(modeBtn);
  const nlBtn = h('button', { type: 'button', class: 'nl-toggle', title: 'Append newline', onClick: () => { addNewLine = !addNewLine; renderMode(); } }, '⏎');
  noFocusSteal(nlBtn);
  const form = h('form', { class: 'cmdline exec-cmdline', onSubmit: (e) => { e.preventDefault(); submit(); } },
    modeBtn, input, nlBtn,
    h('button', { type: 'submit', class: 'btn primary cmd-send', 'aria-label': 'Send' }, icon('send', { size: 18 })));

  const quick = h('div', { class: 'xkeys exec-keys' },
    quickKey('^C', 'Interrupt (Ctrl+C)', () => sendRaw('\x03', false), 'hot'),
    quickKey('Enter', 'Send Enter', () => sendRaw('', true)),
    quickKey('↑', 'Previous command (Up)', () => sendRaw('\x1b[A', false)),
    quickKey('y', 'Answer y', () => sendRaw('y', true)),
    quickKey('n', 'Answer n', () => sendRaw('n', true)),
    quickKey('q', 'Send q', () => sendRaw('q', false)),
    quickKey('clear', 'Clear the terminal', () => sendRaw('clear', true)));
  edgeFade(quick);

  const root = h('section', { class: ['exec-view', bare && 'bare'], 'aria-label': 'VS Code terminal log' },
    bare ? null : h('header', { class: 'view-head' },
      t.embed ? null : iconBtn('back', 'Back', () => view.back(), { cls: 'back' }),
      h('div', { class: 'view-titles' }, titleEl, subEl),
      h('div', { class: 'view-actions' },
        iconBtn('refresh', 'Reload history', () => loadHistory()),
        iconBtn('external', 'Show in VS Code', () => showOnPc()),
        iconBtn('more', 'More', () => showMenu()))),
    bannerSlot,
    h('div', { class: 'exec-body' }, scroller, jumpBtn),
    quick, form);

  const view = openView(root, { onClose: cleanup, embed: t.embed });
  renderSub();
  renderMode();
  renderBanner();

  scroller.addEventListener('scroll', () => { jumpBtn.hidden = isNearBottom(); }, { passive: true });

  /* ------------------------------------------------------------- events */

  offs.push(conn.on('vsc.event', ({ windowId: wid, ev, p }) => {
    if (wid !== windowId || !p) return;
    switch (ev) {
      case 'term.exec.start':
        if (p.tid !== tid) return;
        upsertBlock(p.execId, { commandLine: p.commandLine, cwd: p.cwd, startedAt: Date.now(), running: true });
        scrollToBottom();
        break;
      case 'term.exec.data': {
        if (p.tid !== tid) return;
        const b = blocks.get(p.execId) || upsertBlock(p.execId, { commandLine: '', running: true, startedAt: Date.now() });
        appendOutput(b, p.d || '');
        break;
      }
      case 'term.exec.end': {
        if (p.tid !== tid) return;
        const b = blocks.get(p.execId) || upsertBlock(p.execId, { commandLine: '' });
        b.data.exitCode = p.exitCode;
        b.data.endedAt = Date.now();
        b.data.running = false;
        renderBlockHead(b);
        break;
      }
      case 'terminals.changed': {
        const list = Array.isArray(p.terminals) ? p.terminals : [];
        const me = list.find((x) => x.tid === tid);
        if (!me) { gone = true; }
        else {
          gone = false;
          name = me.name || name;
          hasSI = !!me.hasShellIntegration;
          titleEl.textContent = name;
          if (t.onTitle) t.onTitle(name);
        }
        renderBanner();
        break;
      }
      default: break;
    }
  }));
  offs.push(vs.on('windows', (wins) => {
    renderSub();
    renderBanner(!wins.some((w) => w.windowId === windowId));
  }));
  offs.push(conn.on('ready', () => loadHistory()));
  offs.push(conn.on('down', () => renderBanner()));

  loadHistory();

  /* ------------------------------------------------------------ history */

  async function loadHistory() {
    if (!conn.online) { renderBanner(); return; }
    if (!blocks.size) setChildren(list, spinner('Loading history…'));
    try {
      const hist = await conn.vsc(windowId, 'terminals.history', { tid });
      if (view.closed) return;
      blocks.clear();
      list.replaceChildren();
      const items = Array.isArray(hist) ? hist : [];
      for (const e of items) {
        const b = upsertBlock(e.execId || `h${Math.random().toString(36).slice(2)}`, {
          commandLine: e.commandLine, cwd: e.cwd, startedAt: e.startedAt, endedAt: e.endedAt,
          exitCode: e.exitCode, running: !e.endedAt && e.exitCode == null,
        });
        if (e.output) appendOutput(b, e.output, true);
      }
      if (!items.length) renderEmpty();
      scrollToBottom(true);
    } catch (err) {
      if (view.closed) return;
      if (!blocks.size) {
        setChildren(list, emptyState({ iconName: 'alert', title: 'Couldn’t load history', text: err.message, tone: 'err',
          action: btn('Retry', { small: true, onClick: loadHistory }) }));
      } else toastError(err, 'History');
    }
  }

  function renderEmpty() {
    setChildren(list, emptyState({
      iconName: 'history',
      title: 'No command history yet',
      text: hasSI
        ? 'Commands run in this VS Code terminal — from here or on the PC — appear here with their output.'
        : 'This terminal has no shell integration, so output can’t be captured. You can still send commands.',
    }));
  }

  /* ------------------------------------------------------------- blocks */

  function upsertBlock(execId, data) {
    let b = blocks.get(execId);
    if (b) {
      for (const [k, v] of Object.entries(data)) if (v != null && v !== '') b.data[k] = v;
      renderBlockHead(b);
      return b;
    }
    if (!blocks.size) list.replaceChildren();
    const out = h('pre', { class: 'exec-out mono' });
    const head = h('button', { type: 'button', class: 'exec-head' });
    const el = h('article', { class: 'exec-block' }, head, out);
    b = { execId, el, head, out, raw: '', data: { ...data }, raf: 0 };
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    blocks.set(execId, b);
    list.append(el);
    renderBlockHead(b);
    out.hidden = true;
    return b;
  }

  function renderBlockHead(b) {
    const d = b.data;
    let badge;
    if (d.running) badge = h('span', { class: 'pill info pulse' }, 'running');
    else if (d.exitCode === 0) badge = h('span', { class: 'pill ok' }, icon('check', { size: 12 }), ' 0');
    else if (d.exitCode != null) badge = h('span', { class: 'pill err' }, `exit ${d.exitCode}`);
    else badge = h('span', { class: 'pill muted', title: 'Exit code unknown' }, '?');
    // Time and duration first: they are short and must stay visible; the folder may be long.
    const meta = [];
    if (d.startedAt) meta.push(fmtTime(d.startedAt));
    if (d.startedAt && d.endedAt) meta.push(fmtMs(d.endedAt - d.startedAt));
    if (d.cwd) meta.push(shortPath(d.cwd));
    setChildren(b.head,
      h('span', { class: 'exec-prompt mono', 'aria-hidden': 'true' }, '$'),
      h('span', { class: 'exec-titles' },
        h('span', { class: 'exec-cmd mono' }, d.commandLine || '(command)'),
        meta.length ? h('span', { class: 'exec-meta', title: d.cwd || '' }, meta.join(' · ')) : null),
      badge);
    b.el.classList.toggle('running', !!d.running);
    b.el.classList.toggle('failed', !d.running && d.exitCode != null && d.exitCode !== 0);
  }

  function appendOutput(b, d, immediate = false) {
    if (!d) return;
    b.raw += d;
    if (b.raw.length > MAX_OUTPUT) b.raw = b.raw.slice(b.raw.length - MAX_OUTPUT);
    if (immediate) { paint(b); return; }
    if (b.raf) return;
    b.raf = requestAnimationFrame(() => { b.raf = 0; const stick = isNearBottom(); paint(b); if (stick) scrollToBottom(true); });
  }

  function paint(b) {
    const text = b.raw.replace(/\s+$/, '');
    // Commands that print nothing (or only control sequences) get no empty output box.
    b.out.hidden = !stripAnsi(text).trim();
    if (!b.out.hidden) renderAnsi(b.out, text);
  }

  function isNearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  function scrollToBottom(force = false) {
    if (!force && !isNearBottom()) { jumpBtn.hidden = false; return; }
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
      jumpBtn.hidden = true;
    });
  }

  /* -------------------------------------------------------------- input */

  function quickKey(label, aria, fn, cls) {
    const b = h('button', { type: 'button', class: ['xkey', cls], 'aria-label': aria, onClick: () => { haptic(4); fn(); } }, label);
    noFocusSteal(b);
    return b;
  }

  function setMode(m) {
    mode = m;
    store.set(MODE_KEY, m);
    renderMode();
  }

  function renderMode() {
    const run = mode === 'run';
    setChildren(modeBtn, icon(run ? 'terminal' : 'type', { size: 16 }), h('span', run ? 'Run' : 'Text'));
    modeBtn.title = run ? 'Run command (captures output with shell integration)' : 'Send raw text';
    modeBtn.classList.toggle('alt', !run);
    nlBtn.hidden = run;
    nlBtn.classList.toggle('on', addNewLine);
    nlBtn.setAttribute('aria-pressed', String(addNewLine));
    input.placeholder = run ? 'Run a command…' : 'Send text to the terminal…';
  }

  async function submit() {
    const text = input.value;
    if (gone) { toast('This terminal was closed in VS Code', { type: 'warn' }); return; }
    if (mode === 'run') {
      if (!text.trim()) { sendRaw('', true); return; }
      try {
        const r = await conn.vsc(windowId, 'terminals.exec', { tid, command: text });
        input.value = '';
        if (r && r.execId) {
          if (!blocks.has(r.execId)) upsertBlock(r.execId, { commandLine: text, running: true, startedAt: Date.now() });
          scrollToBottom(true);
        } else {
          toast('Sent — no shell integration, so output can’t be captured here', { type: 'warn' });
        }
      } catch (err) { toastError(err, 'Run failed'); }
    } else {
      const ok = await sendRaw(text, addNewLine);
      if (ok) input.value = '';
    }
  }

  async function sendRaw(text, newline) {
    try {
      await conn.vsc(windowId, 'terminals.sendText', { tid, text, addNewLine: newline });
      return true;
    } catch (err) { toastError(err, 'Send failed'); return false; }
  }

  async function showOnPc() {
    try { await conn.vsc(windowId, 'terminals.show', { tid }); toast('Shown in VS Code', { type: 'ok' }); }
    catch (err) { toastError(err); }
  }

  function showMenu() {
    actionSheet({
      title: name,
      subtitle: vs.label(windowId),
      actions: [
        { label: 'Show in VS Code', iconName: 'external', onSelect: showOnPc },
        { label: 'Reload history', iconName: 'refresh', onSelect: loadHistory },
        { label: 'Collapse all', iconName: 'list', onSelect: () => blocks.forEach((b) => b.el.classList.add('collapsed')) },
        { label: 'Expand all', iconName: 'list', onSelect: () => blocks.forEach((b) => b.el.classList.remove('collapsed')) },
        { label: 'Clear view', sub: 'Only clears this phone’s view', iconName: 'x', onSelect: () => { blocks.clear(); renderEmpty(); } },
      ],
    });
  }

  /* ------------------------------------------------------------- chrome */

  function renderSub() {
    subEl.textContent = `${vs.label(windowId)} · ${hasSI ? 'shell integration' : 'no shell integration'}`;
  }

  function renderBanner(windowGone = !vs.get(windowId) && vs.loaded) {
    renderSub();
    let node = null;
    if (!conn.online) node = bare ? null : banner('Offline — reconnecting to the PC…', { tone: 'warn', iconName: 'wifiOff' });
    else if (windowGone) node = bare ? null : banner('This VS Code window disconnected.', { tone: 'err', actions: [btn('Close', { small: true, onClick: closeOwner })] });
    else if (gone) node = bare ? null : banner('This terminal was closed in VS Code.', { tone: 'err', actions: [btn('Close', { small: true, onClick: closeOwner })] });
    else if (!hasSI) node = banner('No shell integration: commands are sent as text and their output isn’t captured. Use a mirrored terminal for full output.', { tone: 'warn' });
    setChildren(bannerSlot, node);
  }

  function cleanup() {
    for (const off of offs) off();
    for (const b of blocks.values()) if (b.raf) cancelAnimationFrame(b.raf);
  }

  return {
    /** Menu entries of this log (the live view merges them into its own menu). */
    menuActions: () => [
      { label: 'Reload history', iconName: 'refresh', onSelect: loadHistory },
      { label: 'Collapse all', iconName: 'list', onSelect: () => blocks.forEach((b) => b.el.classList.add('collapsed')) },
      { label: 'Expand all', iconName: 'list', onSelect: () => blocks.forEach((b) => b.el.classList.remove('collapsed')) },
      { label: 'Clear history view', sub: 'Only clears this device’s view', iconName: 'x', onSelect: () => { blocks.clear(); renderEmpty(); } },
    ],
    reload: () => loadHistory(),
    close: () => view.close(),
    back: () => (view.embedded ? view.back() : (view.back(), true)),
    focus: () => { if (!view.closed && document.activeElement !== input) input.focus({ preventScroll: true }); },
    get closed() { return view.closed; },
  };
}
