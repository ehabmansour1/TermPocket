// Terminals tab: agent PTY sessions + terminals of every connected VS Code window.

import {
  h, btn, iconBtn, toast, toastError, actionSheet, sheet, confirmDialog, promptDialog, setChildren,
  emptyState, spinner, pill, relTime, store, basename, shortPath, layerOpen, resizer, clamp,
} from './ui.js';
import { icon } from './icons.js';
import { openTermView } from './termview.js';
import { openVsTermView, setMirrorDefault, MIRROR_PROFILE } from './vsterm.js';
import { createDeck } from './deck.js';
import { isDesktop, onLayoutChange } from './layout.js';

const SHELLS = [
  { label: 'Default', value: '' },
  { label: 'PowerShell', value: 'powershell.exe' },
  { label: 'PowerShell 7', value: 'pwsh.exe' },
  { label: 'cmd', value: 'cmd.exe' },
  { label: 'WSL', value: 'wsl.exe' },
];

export function createTerminalsTab(panel, app) {
  const { conn, vs } = app;
  let sessions = [];
  let sessionsLoaded = false;
  let sessionsError = null;
  const winTerms = new Map(); // windowId → { terminals, loading, error }
  let openViewRef = null;

  const viewCtx = {
    conn, vs,
    getSession: (id) => sessions.find((s) => s.id === id) || null,
    get windowsPty() { return app.windowsPty; },
    // Desktop: terminals look like VS Code's integrated terminal; phone: the app's own theme.
    get look() { return isDesktop() ? 'vscode' : 'app'; },
    // "Open a phone-visible terminal" from the Live view's notice: a mirrored terminal in that window.
    openPhoneVisible: (windowId) => newMirroredIn(windowId),
    // A VS Code window reloaded from a Live view (older extension) comes back under a new windowId:
    // open the terminal of the same name there. → true when found (the old view then closes).
    reopenAfterReload: async (windowId, name) => {
      for (let i = 0; i < 6; i++) {
        const list = await conn.vsc(windowId, 'terminals.list', {}, { timeout: 8000 }).catch(() => null);
        const t = Array.isArray(list) ? list.find((x) => x && x.name === name) : null;
        if (t) {
          loadWindowTerminals(windowId);
          await openVsTerminal(vs.get(windowId) || { windowId }, t);
          return true;
        }
        await new Promise((r) => setTimeout(r, 1500)); // restored terminals show up a moment later
      }
      return false;
    },
  };

  /* ---------------------------------------------------------------- DOM */

  const ptySection = h('section', { class: 'section' });
  const vsSection = h('div', { class: 'vs-sections' });
  const newBtn = btn('New terminal', { variant: 'primary', iconName: 'plus', onClick: () => newTerminalSheet() });
  // Phone: the list is the whole panel. Desktop (§8.3): list on the left, open terminals as tabs on
  // the right — each tab keeps its own live xterm.
  const side = h('div', { class: 'split-side' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'panel-heading' }, h('h1', { class: 'panel-title' }, 'Terminals'),
        h('div', { class: 'panel-sub' }, 'Live shells on your PC and in VS Code')),
      h('div', { class: 'panel-actions' }, iconBtn('refresh', 'Refresh', () => refresh()), newBtn)),
    ptySection, vsSection);
  const handle = h('div', { class: 'split-handle', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize list' });
  const main = h('div', { class: 'split-main' });
  panel.classList.add('split-panel');
  panel.append(side, handle, main);
  let visible = false;
  /** Terminal tab that was active when the layout switched to phone while another tab was showing
   *  (a PTY id, or { vst } for a VS Code terminal). */
  let reopenOnShow = null;
  let deck = null;
  const sideW = () => clamp(Number(store.get('termSideW', 340)) || 340, 240, 640);
  panel.style.setProperty('--side-w', `${sideW()}px`);
  resizer(handle, {
    get: () => side.getBoundingClientRect().width,
    set: (w) => panel.style.setProperty('--side-w', `${Math.round(w)}px`),
    min: 240, max: 640, onEnd: (w) => store.set('termSideW', Math.round(w)),
  });

  /* ------------------------------------------------------------- events */

  conn.on('pty.changed', (p) => {
    sessions = Array.isArray(p.sessions) ? p.sessions : [];
    sessionsLoaded = true;
    renderSessions();
    app.setBadge('terminals', sessions.filter((s) => !s.exited).length || '');
  });
  conn.on('pty.exit', (p) => {
    const s = sessions.find((x) => x.id === p.id);
    if (s) { s.exited = true; s.exitCode = p.exitCode; renderSessions(); }
  });
  conn.on('vsc.event', ({ windowId, ev, p }) => {
    if (ev !== 'terminals.changed' || !p) return;
    winTerms.set(windowId, { terminals: Array.isArray(p.terminals) ? p.terminals : [], loading: false, error: null });
    renderVs();
  });
  vs.on('windows', (wins) => {
    const ids = new Set(wins.map((w) => w.windowId));
    for (const id of [...winTerms.keys()]) if (!ids.has(id)) winTerms.delete(id);
    for (const w of wins) if (!winTerms.has(w.windowId)) loadWindowTerminals(w.windowId);
    renderVs();
  });
  conn.on('ready', () => refresh());
  conn.on('down', () => { renderSessions(); renderVs(); });

  renderSessions();
  renderVs();

  /* ------------------------------------------------------------- data */

  async function refresh() {
    if (!conn.online) return;
    await Promise.all([loadSessions(), vs.refresh().then((wins) => Promise.all(wins.map((w) => loadWindowTerminals(w.windowId))))]);
  }

  async function loadSessions() {
    try {
      const list = await conn.request('pty.list');
      sessions = Array.isArray(list) ? list : [];
      sessionsError = null;
      app.setBadge('terminals', sessions.filter((s) => !s.exited).length || '');
    } catch (err) {
      sessionsError = err.message;
    }
    sessionsLoaded = true;
    renderSessions();
  }

  async function loadWindowTerminals(windowId) {
    const prev = winTerms.get(windowId);
    winTerms.set(windowId, { terminals: prev ? prev.terminals : [], loading: true, error: null });
    renderVs();
    try {
      const list = await conn.vsc(windowId, 'terminals.list');
      winTerms.set(windowId, { terminals: Array.isArray(list) ? list : [], loading: false, error: null });
    } catch (err) {
      winTerms.set(windowId, { terminals: prev ? prev.terminals : [], loading: false, error: err.message });
    }
    renderVs();
  }

  /* ----------------------------------------------------------- render */

  function renderSessions() {
    const head = h('div', { class: 'section-head' },
      h('h2', null, icon('terminal', { size: 16 }), 'PC terminals'),
      h('span', { class: 'section-count' }, sessionsLoaded ? String(sessions.length) : ''));
    let body;
    if (!sessionsLoaded) body = conn.online ? spinner('Loading terminals…') : h('div', { class: 'muted-note' }, 'Waiting for the PC…');
    else if (sessionsError && !sessions.length) {
      body = emptyState({ iconName: 'alert', title: 'Couldn’t list terminals', text: sessionsError, tone: 'err', action: btn('Retry', { small: true, onClick: loadSessions }) });
    } else if (!sessions.length) {
      body = emptyState({
        iconName: 'terminal', title: 'No terminals yet',
        text: 'Start a shell on your PC. It keeps running when you close the app or lose signal.',
        action: btn('New terminal', { small: true, variant: 'primary', iconName: 'plus', onClick: () => newTerminalSheet() }),
      });
    } else {
      body = h('div', { class: 'list' }, sessions.map(sessionRow));
    }
    setChildren(ptySection, head, body);
  }

  function sessionRow(s) {
    const meta = [];
    if (s.cols && s.rows) meta.push(`${s.cols}×${s.rows}`);
    if (s.pid) meta.push(`pid ${s.pid}`);
    if (s.createdAt) meta.push(relTime(s.createdAt));
    const badges = [];
    if (s.mirror) badges.push(pill(`VS Code · ${vs.label(s.mirror.windowId)}`, 'info'));
    if (s.exited) badges.push(pill(`exited ${s.exitCode ?? ''}`.trim(), s.exitCode === 0 ? 'muted' : 'warn'));
    const key = `pty:${s.id}`;
    const isOpen = !!deck && deck.has(key);
    return h('div', { class: ['row', 'card-row', s.exited && 'dim', isOpen && 'open', isOpen && deck.active === key && 'current'], 'data-pty': s.id },
      h('button', { type: 'button', class: 'row-main', onClick: () => openSession(s) },
        h('span', { class: ['row-ico', s.exited ? 'muted' : 'accent'] }, icon('terminal', { size: 18 })),
        h('span', { class: 'row-text' },
          h('span', { class: 'row-title' }, s.title || s.shell || s.id),
          h('span', { class: 'row-sub mono', title: s.cwd || '' }, [s.shell, s.cwd && shortPath(s.cwd, 28)].filter(Boolean).join(' · ')),
          h('span', { class: 'row-meta' }, meta.join(' · '), badges))),
      iconBtn('more', 'Terminal actions', () => sessionMenu(s), { cls: 'row-more' }));
  }

  function renderVs() {
    const wins = vs.windows;
    const sections = [];
    if (!wins.length) {
      sections.push(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, icon('code', { size: 16 }), 'VS Code')),
        h('div', { class: 'muted-note' }, vs.loaded
          ? 'No VS Code window connected. Install the TermPocket extension and open VS Code on the PC.'
          : (conn.online ? 'Looking for VS Code windows…' : 'Waiting for the PC…'))));
    }
    for (const w of wins) {
      const st = winTerms.get(w.windowId) || { terminals: [], loading: true };
      let body;
      if (st.loading && !st.terminals.length) body = spinner('Loading…');
      else if (st.error && !st.terminals.length) body = h('div', { class: 'muted-note err' }, st.error);
      else if (!st.terminals.length) body = h('div', { class: 'muted-note' }, 'No terminals open in this window.');
      else body = h('div', { class: 'list' }, st.terminals.map((t) => vsRow(w, t)));
      sections.push(h('section', { class: 'section' },
        h('div', { class: 'section-head' },
          h('h2', null, icon('code', { size: 16 }), h('span', { class: 'ellipsis' }, vs.label(w)), w.focused ? pill('focused', 'ok') : null),
          h('div', { class: 'section-actions' },
            iconBtn('refresh', 'Refresh', () => loadWindowTerminals(w.windowId), { cls: 'sm' }),
            iconBtn('plus', 'New terminal in this window', () => newVsTerminalSheet(w), { cls: 'sm' }))),
        body));
    }
    setChildren(vsSection, sections);
  }

  function vsRow(w, t) {
    const badges = [];
    if (t.isMirror) badges.push(pill('mirrored', 'info'));
    if (t.hasShellIntegration) badges.push(pill('shell integration', 'ok'));
    if (t.active) badges.push(pill('active', 'muted'));
    const sub = [t.cwd && shortPath(t.cwd, 28), t.pid ? `pid ${t.pid}` : ''].filter(Boolean).join(' · ');
    const key = t.isMirror && t.ptyId ? `pty:${t.ptyId}` : `vst:${w.windowId}:${t.tid}`;
    const isOpen = !!deck && deck.has(key);
    return h('div', { class: ['row', 'card-row', isOpen && 'open', isOpen && deck.active === key && 'current'] },
      h('button', { type: 'button', class: 'row-main', onClick: () => openVsTerminal(w, t) },
        h('span', { class: ['row-ico', t.isMirror ? 'accent' : 'info'] }, icon(t.isMirror ? 'link' : 'terminal', { size: 18 })),
        h('span', { class: 'row-text' },
          h('span', { class: 'row-title' }, t.name || 'Terminal'),
          sub ? h('span', { class: 'row-sub mono' }, sub) : null,
          h('span', { class: 'row-meta' }, badges))),
      iconBtn('more', 'Terminal actions', () => vsMenu(w, t), { cls: 'row-more' }));
  }

  /* ---------------------------------------------------------- actions */

  async function openSession(s) {
    if (isDesktop()) { await openInDeck(s); return; }
    if (openViewRef && !openViewRef.closed) await openViewRef.close();
    openViewRef = openTermView(viewCtx, { id: s.id, title: s.title });
  }

  /**
   * Ordinary VS Code terminal → live view (Live · History tabs, vsterm.js); mirrored → its agent PTY.
   * tab: 'live' (default) | 'history'.
   */
  async function openVsTerminal(w, t, tab) {
    if (t.isMirror && t.ptyId) {
      openSession(sessions.find((s) => s.id === t.ptyId) || { id: t.ptyId, title: t.name });
      return;
    }
    const windowId = w.windowId || w;
    const opts = { windowId, tid: t.tid, name: t.name, hasShellIntegration: t.hasShellIntegration, tab };
    if (isDesktop()) {
      const key = `vst:${windowId}:${t.tid}`;
      const d = ensureDeck();
      const existing = d.get(key);
      if (existing) {
        d.activate(key);
        if (tab && existing.api && existing.api.selectTab) existing.api.selectTab(tab);
        return;
      }
      d.open(key, {
        title: t.name || 'Terminal', iconName: 'terminal', tooltip: `${t.name || 'Terminal'} · ${vs.label(windowId)} (VS Code terminal)`,
        build: (pane, hooks) => openVsTermView(viewCtx, { ...opts, embed: { host: pane, onClosed: hooks.onClosed }, onTitle: hooks.setTitle, onState: hooks.setState }),
      });
      return;
    }
    if (openViewRef && !openViewRef.closed) await openViewRef.close();
    openViewRef = openVsTermView(viewCtx, opts);
  }

  /* ------------------------------------------------------ desktop deck */

  function ensureDeck() {
    if (deck) return deck;
    deck = createDeck({
      cls: 'term-deck',
      label: 'Open terminals',
      actions: [
        iconBtn('plus', 'New terminal (Ctrl+Shift+T)', () => quickNew(), { cls: 'sm deck-new' }),
        iconBtn('sliders', 'New terminal with options…', () => newTerminalSheet(), { cls: 'sm' }),
      ],
      empty: () => emptyState({
        iconName: 'terminal', title: 'No terminal open',
        text: 'Pick a terminal on the left, or start a new one. Several can stay open side by side in tabs.',
        action: h('div', { class: 'empty-actions' },
          btn('New terminal', { small: true, variant: 'primary', iconName: 'plus', onClick: () => quickNew() }),
          h('span', { class: 'kbd-hint' }, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Shift'), '+', h('kbd', null, 'T'))),
      }),
      onChange: () => { renderSessions(); renderVs(); },
    });
    main.append(deck.el);
    return deck;
  }

  async function openInDeck(s) {
    const d = ensureDeck();
    const key = `pty:${s.id}`;
    const existing = d.get(key);
    // Same id but a different (restarted) shell: replace the dead tab instead of focusing it.
    if (existing && existing.api && existing.api.gone && s.createdAt) { d.remove(key); existing.api.close(); }
    d.open(key, {
      title: s.title || s.shell || s.id, iconName: 'terminal',
      build: (pane, hooks) => openTermView(viewCtx, {
        id: s.id, title: s.title,
        embed: { host: pane, onClosed: hooks.onClosed },
        onTitle: hooks.setTitle, onState: hooks.setState,
      }),
    });
  }

  /** Ctrl+Shift+T / "+": a new terminal with the last used shell & folder, straight into a tab. */
  async function quickNew() {
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    const last = store.get('newTerm', { shell: '', cwd: '', windowId: '' });
    const params = { ...estimateSize() };
    if (last.shell) params.shell = last.shell;
    if (last.cwd) params.cwd = last.cwd;
    if (last.windowId && vs.get(last.windowId)) params.vscodeWindowId = last.windowId;
    try {
      const sess = await conn.request('pty.create', params);
      if (sess && sess.id) {
        if (!sessions.some((x) => x.id === sess.id)) { sessions.push(sess); renderSessions(); }
        openSession(sess);
      }
    } catch (err) {
      toastError(err, 'Could not start terminal');
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!visible || !isDesktop() || document.body.classList.contains('rdp') || layerOpen()) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyT') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) quickNew();
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab' && deck && deck.size > 1) {
      e.preventDefault();
      e.stopPropagation();
      deck.cycle(e.shiftKey ? -1 : 1);
    }
  }, true);

  onLayoutChange((desk) => {
    if (desk) {
      // A full-screen phone terminal becomes a tab.
      if (openViewRef && !openViewRef.closed && openViewRef.id) {
        const id = openViewRef.id;
        openViewRef.close();
        openViewRef = null;
        openSession(sessions.find((s) => s.id === id) || { id });
      } else if (openViewRef && !openViewRef.closed && openViewRef.vst) {
        const v = { ...openViewRef.vst, tab: openViewRef.tab };
        openViewRef.close();
        openViewRef = null;
        reopenVst(v);
      }
    } else if (deck && deck.size) {
      const act = deck.active;
      const actItem = act && deck.get(act);
      const vst = act && act.startsWith('vst:') && actItem && actItem.api && actItem.api.vst
        ? { ...actItem.api.vst, tab: actItem.api.tab } : null;
      deck.closeAll();
      if (vst) { if (visible) reopenVst(vst); else reopenOnShow = { vst }; }
      if (act && act.startsWith('pty:')) {
        const id = act.slice(4);
        // On the phone layout a terminal is a full-screen view: only open it if the Terminals tab is
        // the one showing; otherwise remember it for when the user comes back to this tab.
        if (visible) openSession(sessions.find((s) => s.id === id) || { id });
        else reopenOnShow = id;
      }
    }
    renderSessions();
    renderVs();
  });

  function reopenVst(v) {
    openVsTerminal({ windowId: v.windowId }, { tid: v.tid, name: v.name, hasShellIntegration: v.hasShellIntegration }, v.tab);
  }

  function sessionMenu(s) {
    actionSheet({
      title: s.title || s.id,
      subtitle: [s.shell, s.cwd].filter(Boolean).join(' · '),
      actions: [
        { label: 'Open', iconName: 'terminal', onSelect: () => openSession(s) },
        { label: 'Rename…', iconName: 'edit', onSelect: () => renameSession(s) },
        s.exited
          ? { label: 'Remove from list', iconName: 'trash', danger: true, onSelect: () => killSession(s, false) }
          : { label: 'Kill terminal', iconName: 'trash', danger: true, onSelect: () => killSession(s, true) },
      ],
    });
  }

  async function renameSession(s) {
    const title = await promptDialog({ title: 'Rename terminal', value: s.title || '', confirmText: 'Rename', validate: (v) => (v.trim() ? null : 'Name can’t be empty') });
    if (title == null) return;
    try { await conn.request('pty.rename', { id: s.id, title: title.trim() }); }
    catch (err) { toastError(err, 'Rename failed'); }
  }

  async function killSession(s, ask) {
    if (ask) {
      const ok = await confirmDialog({
        title: 'Kill this terminal?',
        message: `“${s.title || s.id}” and anything running in it will be terminated${s.mirror ? ', and its VS Code terminal closed' : ''}.`,
        confirmText: 'Kill', danger: true, iconName: 'trash',
      });
      if (!ok) return;
    }
    try { await conn.request('pty.kill', { id: s.id }); toast(s.exited ? 'Removed' : 'Terminal killed', { type: 'ok' }); }
    catch (err) { toastError(err, 'Kill failed'); }
  }

  function vsMenu(w, t) {
    actionSheet({
      title: t.name || 'Terminal',
      subtitle: vs.label(w),
      actions: [
        { label: t.isMirror ? 'Open terminal' : 'Open live terminal', sub: t.isMirror ? null : 'See and type into it as in VS Code', iconName: 'terminal', onSelect: () => openVsTerminal(w, t, 'live') },
        t.isMirror ? null : { label: 'Command history', sub: 'Each command with its output and exit code', iconName: 'history', onSelect: () => openVsTerminal(w, t, 'history') },
        { label: 'Send text…', iconName: 'send', onSelect: () => sendTextTo(w, t) },
        { label: 'Show in VS Code', iconName: 'external', onSelect: async () => {
          try { await conn.vsc(w.windowId, 'terminals.show', { tid: t.tid }); toast('Shown in VS Code', { type: 'ok' }); }
          catch (err) { toastError(err); }
        } },
        t.isMirror ? null : { label: 'Make new terminals phone-visible', sub: `New VS Code terminals use the “${MIRROR_PROFILE}” profile`, iconName: 'link', onSelect: () => setMirrorDefault(conn, vs, true, w.windowId) },
        { label: 'Close terminal', iconName: 'trash', danger: true, onSelect: async () => {
          const ok = await confirmDialog({ title: 'Close this VS Code terminal?', message: `“${t.name}” will be closed in ${vs.label(w)}.`, confirmText: 'Close', danger: true });
          if (!ok) return;
          try { await conn.vsc(w.windowId, 'terminals.dispose', { tid: t.tid }); loadWindowTerminals(w.windowId); }
          catch (err) { toastError(err, 'Close failed'); }
        } },
      ],
    });
  }

  async function sendTextTo(w, t) {
    const text = await promptDialog({ title: `Send to “${t.name}”`, message: 'Text is typed into the terminal followed by Enter.', mono: true, multiline: true, confirmText: 'Send' });
    if (text == null || text === '') return;
    try { await conn.vsc(w.windowId, 'terminals.sendText', { tid: t.tid, text, addNewLine: true }); toast('Sent', { type: 'ok' }); }
    catch (err) { toastError(err, 'Send failed'); }
  }

  /* ---------------------------------------------------- new terminal UI */

  function estimateSize() {
    if (isDesktop()) {
      // Desktop terminals use VS Code's look (termview.js): Consolas 14 px, line height 1.
      const fs = Number(store.get('termFontSizeDesk', 14)) || 14;
      const r = (deck ? deck.el.querySelector('.deck-panes') : main).getBoundingClientRect();
      if (r.width > 200 && r.height > 120) {
        return {
          cols: clamp(Math.floor((r.width - 30) / (fs * 0.55)), 40, 400),
          rows: clamp(Math.floor((r.height - 48) / (fs * 1.17)), 12, 200),
        };
      }
    }
    const fs = Number(store.get('termFontSize', 13)) || 13;
    const cols = Math.max(40, Math.floor((window.innerWidth - 12) / (fs * 0.6)));
    const rows = Math.max(12, Math.floor((window.innerHeight - 220) / (fs * 1.2)));
    return { cols, rows };
  }

  function newTerminalSheet() {
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    const last = store.get('newTerm', { shell: '', cwd: '', windowId: '' });
    let shell = last.shell || '';
    const shellChips = h('div', { class: 'chips' });
    const customShell = h('input', { class: 'input mono', type: 'text', placeholder: 'or a custom shell / program path', autocomplete: 'off', spellcheck: false, autocapitalize: 'off' });
    if (shell && !SHELLS.some((x) => x.value === shell)) customShell.value = shell;
    const renderChips = () => setChildren(shellChips, SHELLS.map((o) => h('button', {
      type: 'button', class: ['chip', o.value === shell && !customShell.value && 'active'],
      onClick: () => { shell = o.value; customShell.value = ''; renderChips(); },
    }, o.label)));
    customShell.addEventListener('input', renderChips);
    renderChips();

    const titleIn = h('input', { class: 'input', type: 'text', placeholder: 'Title (optional)', autocomplete: 'off' });
    const cwdIn = h('input', { class: 'input mono', type: 'text', placeholder: 'Working directory (default: home)', autocomplete: 'off', spellcheck: false, autocapitalize: 'off' });
    cwdIn.value = last.cwd || '';
    const folders = [...new Set(vs.windows.flatMap((w) => w.folders || []))];
    const cwdChips = folders.length ? h('div', { class: 'chips' }, folders.slice(0, 6).map((f) =>
      h('button', { type: 'button', class: 'chip mono', title: f, onClick: () => { cwdIn.value = f; } }, basename(f) || f))) : null;

    const winSel = h('select', { class: 'input select' },
      h('option', { value: '' }, 'Phone only (no VS Code window)'),
      vs.windows.map((w) => h('option', { value: w.windowId }, `Also show in: ${vs.label(w)}`)));
    if (last.windowId && vs.get(last.windowId)) winSel.value = last.windowId;

    const createBtn = btn('Create terminal', { variant: 'primary', iconName: 'terminal', cls: 'block' });
    const s = sheet({
      title: 'New terminal',
      subtitle: 'Runs on the PC; survives disconnects',
      content: h('div', { class: 'form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Shell'), shellChips, customShell),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), titleIn),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Folder'), cwdIn, cwdChips),
        vs.windows.length ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'VS Code'), winSel) : null,
        createBtn),
    });
    createBtn.addEventListener('click', async () => {
      const chosenShell = customShell.value.trim() || shell;
      const params = { ...estimateSize() };
      if (chosenShell) params.shell = chosenShell;
      if (titleIn.value.trim()) params.title = titleIn.value.trim();
      if (cwdIn.value.trim()) params.cwd = cwdIn.value.trim();
      if (winSel.value) params.vscodeWindowId = winSel.value;
      createBtn.disabled = true;
      try {
        const sess = await conn.request('pty.create', params);
        store.set('newTerm', { shell: chosenShell, cwd: params.cwd || '', windowId: winSel.value || '' });
        s.close();
        if (sess && sess.id) {
          if (!sessions.some((x) => x.id === sess.id)) { sessions.push(sess); renderSessions(); }
          openSession(sess);
        }
      } catch (err) {
        toastError(err, 'Could not start terminal');
        createBtn.disabled = false;
      }
    });
  }

  function newVsTerminalSheet(w) {
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    const nameIn = h('input', { class: 'input', type: 'text', placeholder: 'Name (optional)', autocomplete: 'off' });
    const cwdIn = h('input', { class: 'input mono', type: 'text', placeholder: 'Folder (default: workspace)', autocomplete: 'off', spellcheck: false, autocapitalize: 'off' });
    let mirror = true;
    const mirrorToggle = h('button', { type: 'button', class: 'toggle on', role: 'switch', 'aria-checked': 'true' }, h('span', { class: 'knob' }));
    mirrorToggle.addEventListener('click', () => {
      mirror = !mirror;
      mirrorToggle.classList.toggle('on', mirror);
      mirrorToggle.setAttribute('aria-checked', String(mirror));
      hint.textContent = mirror
        ? 'Mirrored: one live shell visible in VS Code and on this phone, with full interactive output.'
        : 'Regular VS Code terminal: from the phone you can run commands and see their output via shell integration.';
    });
    const hint = h('div', { class: 'field-hint' }, 'Mirrored: one live shell visible in VS Code and on this phone, with full interactive output.');
    const createBtn = btn('Create in VS Code', { variant: 'primary', iconName: 'plus', cls: 'block' });
    const s = sheet({
      title: 'New VS Code terminal',
      subtitle: vs.label(w),
      content: h('div', { class: 'form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameIn),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Folder'), cwdIn),
        h('div', { class: 'field row-field' }, h('span', { class: 'field-label' }, 'Mirror to phone'), mirrorToggle),
        hint, createBtn),
    });
    createBtn.addEventListener('click', async () => {
      const p = { mirror };
      if (nameIn.value.trim()) p.name = nameIn.value.trim();
      if (cwdIn.value.trim()) p.cwd = cwdIn.value.trim();
      createBtn.disabled = true;
      try {
        const r = await conn.vsc(w.windowId, 'terminals.create', p);
        s.close();
        loadWindowTerminals(w.windowId);
        if (r && r.ptyId) {
          openSession(sessions.find((x) => x.id === r.ptyId) || { id: r.ptyId, title: p.name || 'Terminal' });
        } else if (r && r.tid) {
          toast('Terminal created in VS Code', { type: 'ok' });
        }
      } catch (err) {
        toastError(err, 'Could not create terminal');
        createBtn.disabled = false;
      }
    });
  }

  /** A new mirrored ("phone-visible") terminal in VS Code window `windowId`, opened right away. */
  async function newMirroredIn(windowId) {
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    if (!windowId || !vs.get(windowId)) { toast('That VS Code window is not connected', { type: 'warn' }); return; }
    try {
      const w = vs.get(windowId);
      const p = { mirror: true };
      if (w && Array.isArray(w.folders) && w.folders[0]) p.cwd = w.folders[0];
      const r = await conn.vsc(windowId, 'terminals.create', p);
      loadWindowTerminals(windowId);
      if (r && r.ptyId) openSession(sessions.find((x) => x.id === r.ptyId) || { id: r.ptyId, title: 'Terminal' });
      else toast('Terminal created in VS Code', { type: 'ok' });
    } catch (err) {
      toastError(err, 'Could not create a phone-visible terminal');
    }
  }

  if (isDesktop()) ensureDeck();

  return {
    onShow() {
      visible = true;
      const pending = reopenOnShow;
      reopenOnShow = null;
      if (isDesktop()) { ensureDeck(); requestAnimationFrame(() => deck.focusActive()); }
      if (pending && pending.vst) reopenVst(pending.vst);
      else if (pending && conn.online) openSession(sessions.find((s) => s.id === pending) || { id: pending });
      if (conn.online && !sessionsLoaded) refresh();
    },
    onHide() { visible = false; },
    /** Open a session (desktop: as a tab) — used by the Code tab's "Terminal here". */
    openSession,
  };
}
