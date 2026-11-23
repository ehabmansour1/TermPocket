// TERMINAL panel view (builder C), VS Code style: the active terminal fills the panel, the
// terminal tabs list sits on the right (icon + name, hover trash, context menu, resizable).
// Terminals are THAT VS Code window's (terminals.list / terminals.changed):
//   * mirrored ones (isMirror + ptyId) → the agent PTY view (termview.js, full history, input);
//   * ordinary ones → the Live view (vsterm.js: terminals.attach / term.raw / terminals.input).
// Both views are reused as-is, embedded into a pane (openView embed), with their own header hidden
// by CSS and the Dark Modern terminal colours passed as ctx.termTheme.
// "+" = terminals.create (mirrored by default, so it has its whole history here); the chevron
// offers an ordinary VS Code terminal; trash = terminals.dispose.

import { h, store, clamp, resizer, debounce, VSCODE_TERM_THEME, VSCODE_TERM_FONT } from '../ui.js';
import { openTermView } from '../termview.js';
import { openVsTermView, setMirrorDefault, getMirrorDefault, MIRROR_PROFILE } from '../vsterm.js';
import {
  ensureCss, useShell, cicon, createTree, contextMenu, onVsc, registerCommand, actionBtn, windowFolders, errText,
  notify, reportError, confirm,
  once,
} from './c-common.js';

const TABS_W_KEY = 'wbTermTabsW';
const MIRROR_TIP_KEY = 'wbTermMirrorTip'; // the one-time "make new terminals phone-visible" tip was shown
const CALL_TIMEOUT_MS = 15000;
const NARROW_W = 80;

/** VS Code "Dark Modern" terminal colours (panel background #181818) — shared with the Terminals tab. */
export { VSCODE_TERM_THEME };

function callT(wb, m, p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`VS Code did not answer ${m} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve().then(() => wb.call(m, p)).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* ------------------------------------------------------------------ view */

function mountTerminal(wb, container, hooks, panelCtx) {
  ensureCss();
  const app = wb.app;
  const conn = app.conn;
  let terms = [];          // terminals.list of the current window
  let loaded = false;
  let loading = false;
  let listError = null;
  let sessions = [];       // pty.list (for mirrored terminals)
  let activeTid = null;
  let pendingSelect = null; // tid created from here: select it when it shows up
  // The terminal last shown per VS Code window. While the agent restarts the window list empties and
  // the window comes back: the panel then returns to the same terminal (not VS Code's active one).
  const lastActive = new Map(); // windowId → tid
  let restoreTid = null;    // consumed by the first list after a window change
  let visible = false;
  let disposed = false;
  let windowId = wb.windowId;
  let seq = 0;
  const views = new Map(); // tid → { pane, api, kind, state }
  const fitOnOpen = new Set(); // tids of mirrored terminals created here: fit them to the panel once
  const offs = [];

  const ctx = {
    conn,
    vs: app.vs,
    getSession: (id) => sessions.find((s) => s.id === id) || null,
    get windowsPty() { return app.windowsPty; },
    // VS Code's terminal look: Dark Modern colours, the editor font (terminal.integrated.fontFamily
    // falls back to it on Windows) at 14 px, line height 1, a steady block cursor.
    look: 'vscode',
    termTheme: VSCODE_TERM_THEME,
    termFont: VSCODE_TERM_FONT,
    // The Live view's "reload this window" confirmation, in VS Code's modal style.
    confirm: ({ title, message, confirmText }) => confirm({ message: title, detail: message, primary: confirmText, type: 'info' }),
    // "Open a phone-visible terminal" (Live view notice): create a mirrored one here and switch to it.
    openPhoneVisible: () => createTerminal({ mirror: true }),
  };

  /* ---------------------------------------------------------------- DOM */

  const main = h('div', { class: 'wbc-term-main' });
  const empty = h('div', { class: 'wbc-term-empty', hidden: true });
  main.append(empty);
  const sash = h('div', { class: 'wbc-term-sash', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize terminal tabs' });
  const newBtn = actionBtn('add', 'New Terminal (Ctrl+Shift+`)', () => createTerminal({ mirror: true }));
  const moreBtn = actionBtn('chevronDown', 'Launch Profile...', (e) => profileMenu(e.currentTarget));
  const killBtn = actionBtn('trash', 'Kill the Active Terminal Instance', () => { if (activeTid) killTerminal(activeTid); });
  // VS Code shows these in the panel's title bar (next to maximize / close).
  const tabsBar = h('div', { class: 'wbc-panel-actions wbc-term-actions' }, newBtn, moreBtn, killBtn,
    actionBtn('ellipsis', 'Views and More Actions...', (e) => moreMenu(e.currentTarget)));
  const actionsInTitle = !!(panelCtx && panelCtx.actions instanceof Element);
  if (actionsInTitle) panelCtx.actions.append(tabsBar);
  const tabsScroll = h('div', { class: 'wbc-scroll' });
  const tabs = h('div', { class: 'wbc-term-tabs', role: 'region', 'aria-label': 'Terminal tabs' },
    actionsInTitle ? null : h('div', { class: 'wbc-term-tabs-bar' }, tabsBar), tabsScroll);
  const root = h('div', { class: 'wbc-view wbc-term', 'aria-label': 'Terminal' }, main, sash, tabs);
  container.append(root);

  const tabsW = () => clamp(Number(store.get(TABS_W_KEY, 170)) || 170, 46, 480);
  tabs.style.width = `${tabsW()}px`;
  resizer(sash, {
    get: () => tabs.getBoundingClientRect().width,
    set: (w) => { tabs.style.width = `${w}px`; renderTabs(); },
    min: 46,
    max: 480,
    invert: true,
    onEnd: (w) => store.set(TABS_W_KEY, Math.round(w)),
  });

  const tree = createTree({
    label: 'Terminals',
    roots: () => terms.map((t) => ({ id: t.tid, t })),
    twistieless: true,
    rowClass: (n) => ['wbc-term-tab', n.id === activeTid && 'active-term', narrow() && 'narrow'],
    renderRow: (n, row) => {
      const t = n.t;
      const v = views.get(t.tid);
      row.title = tabTooltip(t);
      row.append(
        h('span', { class: 'wbc-term-ico' }, cicon(t.isMirror ? 'remote' : 'terminal', { size: 16 })),
        h('span', { class: 'wbc-label' }, t.name || 'Terminal'),
        v && v.state ? h('span', { class: ['wbc-term-dot', v.state === 'err' ? 'err' : 'warn'], title: v.state === 'err' ? 'Disconnected' : 'Needs attention' }) : null,
        h('span', { class: 'wbc-row-end wbc-hover-actions' },
          actionBtn('trash', 'Kill Terminal', () => killTerminal(t.tid))));
    },
    onOpen: (n) => select(n.id, { focus: true }),
    onContext: (n, e) => tabMenu(n.t, e.clientX, e.clientY),
    onKey: (n, e) => {
      if (e.key === 'Delete') { killTerminal(n.id); return true; }
      if (e.key === 'F2') { renameTerminal(n.t); return true; }
      return false;
    },
  });
  tree.el.classList.add('wbc-term-list');
  tabsScroll.append(tree.el);

  const narrow = () => tabs.getBoundingClientRect().width < NARROW_W && tabs.getBoundingClientRect().width > 0;

  function tabTooltip(t) {
    const lines = [t.name || 'Terminal'];
    if (t.isMirror) lines.push('Phone-visible (mirrored by TermPocket): exactly as in VS Code, with its whole history');
    else lines.push(t.hasShellIntegration ? 'VS Code terminal (live view through shell integration)' : 'VS Code terminal without shell integration: its screen is read on open and after typing');
    if (t.pid) lines.push(`Process ID (PID): ${t.pid}`);
    if (t.cwd) lines.push(`Current working directory: ${t.cwd}`);
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- data */

  async function refresh({ quiet = false } = {}) {
    const my = ++seq;
    const wid = wb.windowId;
    windowId = wid;
    if (!wid) { terms = []; loaded = true; listError = null; render(); return; }
    loading = !quiet;
    if (!quiet) render();
    try {
      const [list, ptys] = await Promise.all([
        callT(wb, 'terminals.list', {}),
        conn.request('pty.list').catch(() => sessions),
      ]);
      if (my !== seq || disposed) return;
      sessions = Array.isArray(ptys) ? ptys : sessions;
      setTerms(Array.isArray(list) ? list : []);
      listError = null;
    } catch (err) {
      if (my !== seq || disposed) return;
      listError = errText(err);
    }
    loaded = true;
    loading = false;
    render();
  }

  function setTerms(list) {
    terms = list.filter((t) => t && t.tid);
    const ids = new Set(terms.map((t) => t.tid));
    for (const [tid, v] of views) {
      if (!ids.has(tid)) closeView(tid, v);
    }
    if (pendingSelect && ids.has(pendingSelect)) {
      const tid = pendingSelect;
      pendingSelect = null;
      activeTid = tid;
    }
    if (restoreTid) {
      if (!activeTid && ids.has(restoreTid)) activeTid = restoreTid;
      restoreTid = null;
    }
    if (!activeTid || !ids.has(activeTid)) {
      const vsActive = terms.find((t) => t.active);
      activeTid = (vsActive || terms[0] || {}).tid || null;
    }
  }

  /* ---------------------------------------------------------------- views */

  function ensureView(t) {
    let v = views.get(t.tid);
    // Mirrored → agent PTY view; a mirrored terminal whose PTY is still starting (no ptyId yet) waits;
    // ordinary → Live view. A view of the wrong kind (or of another PTY) is replaced.
    const kind = t.isMirror ? (t.ptyId ? 'pty' : 'wait') : 'vst';
    if (v && (v.kind !== kind || (kind === 'pty' && v.ptyId !== t.ptyId))) { closeView(t.tid, v); v = null; }
    if (v) return v;
    const pane = h('div', { class: 'wbc-term-pane', hidden: true });
    main.append(pane);
    v = { pane, api: null, kind, ptyId: t.ptyId || null, state: null };
    views.set(t.tid, v);
    if (kind === 'wait') {
      pane.append(h('div', { class: 'wbc-message dim' }, 'Starting the mirrored terminal…'));
      return v;
    }
    const onState = (tone) => {
      const next = tone === 'err' || tone === 'warn' ? tone : null;
      if (next !== v.state) { v.state = next; renderTabs(); }
    };
    try {
      if (v.kind === 'pty') {
        v.api = openTermView(ctx, {
          id: t.ptyId, title: t.name,
          embed: { host: pane, onClosed: () => { if (views.get(t.tid) === v) { views.delete(t.tid); pane.remove(); } } },
          onState,
        });
        // A terminal created from this panel takes the panel's size (resizes its VS Code twin too).
        if (fitOnOpen.delete(t.tid) && v.api && v.api.fit) {
          setTimeout(() => { if (views.get(t.tid) === v && !v.pane.hidden) v.api.fit({ quiet: true }); }, 700);
        }
      } else {
        v.api = openVsTermView(ctx, {
          windowId, tid: t.tid, name: t.name, hasShellIntegration: t.hasShellIntegration,
          embed: { host: pane, onClosed: () => { if (views.get(t.tid) === v) { views.delete(t.tid); pane.remove(); } } },
          onState,
        });
        setTimeout(() => { maybeMirrorTip().catch(() => {}); }, 1500);
      }
    } catch (err) {
      console.error('[wb] terminal view failed', err);
      pane.append(h('div', { class: 'wbc-message' }, `This terminal could not be shown: ${errText(err)}`));
    }
    return v;
  }

  function closeView(tid, v = views.get(tid)) {
    if (!v) return;
    views.delete(tid);
    try { if (v.api) v.api.close(); } catch (err) { console.error(err); }
    v.pane.remove();
  }

  function closeAll() {
    for (const [tid, v] of [...views]) closeView(tid, v);
  }

  function select(tid, { focus = false } = {}) {
    if (!terms.some((t) => t.tid === tid)) return;
    activeTid = tid;
    render();
    if (focus) {
      const v = views.get(tid);
      requestAnimationFrame(() => { try { if (v && v.api) v.api.focus(); } catch { /* ignore */ } });
    }
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    if (disposed) return;
    renderTabs();
    const t = terms.find((x) => x.tid === activeTid) || null;
    const showEmpty = !t;
    empty.hidden = !showEmpty;
    if (showEmpty) renderEmpty();
    killBtn.disabled = !t;
    for (const [tid, v] of views) {
      const on = !!t && tid === t.tid && visible;
      if (v.pane.hidden === !on) continue;
      v.pane.hidden = !on;
      try {
        if (on && v.api && v.api.onActivate) v.api.onActivate();
        if (!on && v.api && v.api.onDeactivate) v.api.onDeactivate();
      } catch (err) { console.error(err); }
    }
    if (t && visible) {
      const v = ensureView(t);
      if (v.pane.hidden) {
        v.pane.hidden = false;
        try { if (v.api && v.api.onActivate) v.api.onActivate(); } catch (err) { console.error(err); }
      }
    }
  }

  function renderTabs() {
    tree.render();
    if (activeTid && tree.selectedId !== activeTid) tree.setFocus(activeTid, { reveal: true });
  }

  function renderEmpty() {
    const kids = [];
    if (!wb.windowId) kids.push(h('div', 'No VS Code window is selected.'));
    else if (!conn.online) kids.push(h('div', 'Not connected to the PC.'));
    else if (listError && !terms.length) {
      kids.push(h('div', `Could not list the terminals of this VS Code window: ${listError}`));
      kids.push(h('button', { type: 'button', class: 'wbc-button', onClick: () => refresh() }, 'Retry'));
    } else if (!loaded || loading) kids.push(h('div', 'Loading terminals…'));
    else {
      kids.push(h('div', 'There are no terminals in this VS Code window.'));
      kids.push(h('button', { type: 'button', class: 'wbc-button', onClick: () => createTerminal({ mirror: true }) }, cicon('add', { size: 16 }), 'New Terminal'));
    }
    empty.replaceChildren(...kids);
  }

  /* ---------------------------------------------------------------- actions */

  async function createTerminal({ mirror = true } = {}) {
    if (!wb.windowId) { notify('Choose a VS Code window first (title bar).', 'warning'); return; }
    const folders = windowFolders(wb);
    const p = { mirror };
    if (folders[0]) p.cwd = folders[0];
    try {
      const r = await callT(wb, 'terminals.create', p, 25000);
      if (r && r.tid) {
        pendingSelect = r.tid;
        if (r.ptyId) fitOnOpen.add(r.tid);
        if (!visible) wb.panel.show('terminal');
        await refresh({ quiet: true });
        select(r.tid, { focus: true });
        // terminals.changed may have created the view before this answer arrived: fit it now.
        const v = views.get(r.tid);
        if (v && v.api && v.api.fit && fitOnOpen.delete(r.tid)) {
          setTimeout(() => { if (views.get(r.tid) === v && !v.pane.hidden) v.api.fit({ quiet: true }); }, 700);
        }
      }
    } catch (err) {
      reportError(err, 'Could not create a terminal');
    }
  }

  async function killTerminal(tid) {
    const t = terms.find((x) => x.tid === tid);
    if (!t) return;
    try {
      await callT(wb, 'terminals.dispose', { tid });
      // terminals.changed follows; drop it locally right away so the panel reacts instantly.
      const idx = terms.findIndex((x) => x.tid === tid);
      terms = terms.filter((x) => x.tid !== tid);
      closeView(tid);
      if (activeTid === tid) activeTid = (terms[Math.min(idx, terms.length - 1)] || {}).tid || null;
      render();
    } catch (err) {
      reportError(err, `Could not kill ${t.name || 'the terminal'}`);
    }
  }

  async function renameTerminal(t) {
    const name = await wb.quickInput({ input: true, value: t.name || '', prompt: 'Enter a new name for the terminal', placeholder: 'Terminal name', validate: (v) => (v.trim() ? null : 'A name is required') });
    if (typeof name !== 'string' || !name.trim() || name.trim() === t.name) return;
    try {
      if (t.isMirror && t.ptyId) {
        await conn.request('pty.rename', { id: t.ptyId, title: name.trim() });
      }
      // VS Code renames its ACTIVE terminal: make this one active first.
      await callT(wb, 'terminals.show', { tid: t.tid });
      await callT(wb, 'commands.run', { command: 'workbench.action.terminal.renameWithArg', args: [{ name: name.trim() }] });
      t.name = name.trim();
      renderTabs();
      setTimeout(() => refresh({ quiet: true }), 400);
    } catch (err) {
      reportError(err, 'Could not rename the terminal');
    }
  }

  async function showOnPc(t) {
    try { await callT(wb, 'terminals.show', { tid: t.tid }); } catch (err) { reportError(err, 'Could not show it in VS Code'); }
  }

  function tabMenu(t, x, y, { keys = false } = {}) {
    const v = views.get(t.tid);
    const items = [
      { label: 'Show in VS Code', onSelect: () => showOnPc(t) },
      'sep',
      { label: 'Rename...', kbd: 'F2', onSelect: () => renameTerminal(t) },
    ];
    if (!t.isMirror && v && v.api && v.api.needsReload) {
      items.push({ label: 'Reload VS Code Window (update TermPocket)', onSelect: () => { select(t.tid); v.api.reloadWindow(); } });
    } else if (!t.isMirror && v && v.api && v.api.refresh) {
      items.push({ label: 'Reload Live View', onSelect: () => { select(t.tid); v.api.refresh(); } });
    }
    if (!t.isMirror && v && v.api && v.api.selectTab) {
      items.push({ label: v.api.tab === 'history' ? 'Show Live Output' : 'Show Command History', onSelect: () => { select(t.tid); v.api.selectTab(v.api.tab === 'history' ? 'live' : 'history'); } });
      if (v.api.zoom) {
        items.push('sep',
          { label: 'Zoom In', kbd: 'Ctrl+Wheel', onSelect: () => v.api.zoom(1) },
          { label: 'Zoom Out', onSelect: () => v.api.zoom(-1) },
          { label: 'Fit to Panel', onSelect: () => v.api.zoom(0) });
      }
    }
    if (t.isMirror && v && v.api && v.api.fit) {
      items.push('sep', { label: 'Fit Terminal to Panel', onSelect: () => { select(t.tid); v.api.fit(); } });
      if (v.api.setFont) {
        items.push({ label: 'Increase Font Size', onSelect: () => v.api.setFont(v.api.fontSize + 1) },
          { label: 'Decrease Font Size', onSelect: () => v.api.setFont(v.api.fontSize - 1) });
      }
    }
    if (keys && v && v.api && v.api.toggleKeys) {
      // Desktop: no extra-keys row by default (a physical keyboard is there); this brings it back.
      items.push('sep', { label: 'Show Extra Keys', checked: !!v.api.keysShown, onSelect: () => { v.api.toggleKeys(); } });
    }
    items.push('sep', { label: 'Kill Terminal', kbd: 'Delete', onSelect: () => killTerminal(t.tid) });
    contextMenu(x, y, items);
  }

  async function profileMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const mirrorDefault = await getMirrorDefault(conn, app.vs, wb.windowId);
    contextMenu(r.left, r.bottom + 2, [
      // Phone-visible (mirrored) = one shell shown in VS Code and here, exactly as it is, with its
      // whole history; an ordinary VS Code terminal is only readable through shell integration.
      { label: 'New Phone-Visible Terminal', kbd: 'Ctrl+Shift+`', onSelect: () => createTerminal({ mirror: true }) },
      { label: 'New VS Code Terminal', onSelect: () => createTerminal({ mirror: false }) },
      'sep',
      {
        label: 'Make New Terminals Phone-Visible',
        checked: mirrorDefault === true,
        disabled: mirrorDefault === null,
        onSelect: () => setMirrorDefault(conn, app.vs, !mirrorDefault, wb.windowId),
      },
      'sep',
      { label: 'Refresh', onSelect: () => refresh() },
    ]);
  }

  /** "…" in the panel title: the active terminal's actions, plus the extra-keys row toggle. */
  function moreMenu(anchor) {
    const t = terms.find((x) => x.tid === activeTid);
    const r = anchor.getBoundingClientRect();
    if (t) tabMenu(t, r.left, r.bottom + 2, { keys: true });
    else profileMenu(anchor);
  }

  /** Once ever: an ordinary terminal opened here while new terminals are not phone-visible → tip. */
  let tipChecked = false;
  async function maybeMirrorTip() {
    if (tipChecked || store.get(MIRROR_TIP_KEY, false)) return;
    tipChecked = true;
    const on = await getMirrorDefault(conn, app.vs, wb.windowId);
    if (on !== false || disposed) return; // already on, or that window can't tell (older extension)
    store.set(MIRROR_TIP_KEY, true);
    notify('Tip: make new VS Code terminals phone-visible. They then show here exactly as in VS Code — '
      + 'full-screen programs such as Claude Code included — with their whole history.', 'info', {
      source: 'TermPocket',
      actions: [
        { label: 'Not Now' },
        { label: 'Make New Terminals Phone-Visible', run: () => setMirrorDefault(conn, app.vs, true, wb.windowId) },
      ],
    });
  }

  /* ---------------------------------------------------------------- events */

  offs.push(onVsc(wb, 'terminals.changed', (p) => {
    if (!p || !Array.isArray(p.terminals)) { refresh({ quiet: true }); return; }
    setTerms(p.terminals);
    loaded = true;
    listError = null;
    render();
  }));
  offs.push(conn.on('pty.changed', (p) => {
    if (p && Array.isArray(p.sessions)) sessions = p.sessions;
  }));
  offs.push(conn.on('ready', () => refresh({ quiet: true })));
  try {
    const off = wb.onWindowChange(() => {
      if (windowId && activeTid) lastActive.set(windowId, activeTid);
      closeAll();
      terms = [];
      activeTid = null;
      pendingSelect = null;
      restoreTid = (wb.windowId && lastActive.get(wb.windowId)) || null;
      loaded = false;
      listError = null;
      refresh();
    });
    if (typeof off === 'function') offs.push(off);
  } catch { /* shell without onWindowChange */ }
  const onResize = debounce(() => { if (visible) renderTabs(); }, 100);
  window.addEventListener('resize', onResize);

  refresh();

  const api = {
    show(o) {
      visible = true;
      hooks.onShown(true);
      render();
      if (!loaded && !loading) refresh();
      if (o && o.focus) requestAnimationFrame(() => requestAnimationFrame(() => api.focus()));
    },
    hide() {
      visible = false;
      hooks.onShown(false);
      render();
    },
    focus() {
      const v = activeTid && views.get(activeTid);
      if (v && v.api) v.api.focus();
      else tree.focus();
    },
    createTerminal,
    killActive() { if (activeTid) killTerminal(activeTid); },
    renameActive() { const t = terms.find((x) => x.tid === activeTid); if (t) renameTerminal(t); },
    showActiveOnPc() { const t = terms.find((x) => x.tid === activeTid); if (t) showOnPc(t); },
    next(delta = 1) {
      if (!terms.length) return;
      const i = terms.findIndex((t) => t.tid === activeTid);
      select(terms[(i + delta + terms.length) % terms.length].tid, { focus: true });
    },
    get visible() { return visible; },
    dispose() {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      window.removeEventListener('resize', onResize);
      closeAll();
      tabsBar.remove();
      root.remove();
    },
  };
  return api;
}

/* ------------------------------------------------------------------ register */

export function register(wb) {
  return once(wb, 'terminal', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  let view = null;
  let shown = false;
  const hooks = { onShown: (on) => { shown = on; } };
  wb.panel.register({
    id: 'terminal',
    title: 'Terminal',
    order: 30,
    kb: 'ctrl+`',
    mount(container, ctx) {
      view = mountTerminal(wb, container, hooks, ctx);
      return view;
    },
  });

  const focusTerminal = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (view) view.focus(); }));
  const show = () => { wb.panel.show('terminal', { focus: true }); };
  // The shell owns "Toggle Terminal" (Ctrl+`); this only fills the gap without it.
  registerCommand(wb, 'workbench.action.terminal.toggleTerminal', 'Toggle Terminal', () => {
    if (wb.panel.isVisible() && shown) { wb.panel.toggle(); return; }
    show();
    focusTerminal();
  }, { keybinding: 'ctrl+`', category: 'View', terminal: true });
  registerCommand(wb, 'workbench.action.terminal.new', 'Create New Terminal', () => {
    show();
    if (view) view.createTerminal({ mirror: true });
  }, { keybinding: 'ctrl+shift+`', category: 'Terminal', terminal: true });
  registerCommand(wb, 'workbench.action.terminal.newOrdinary', 'Create New Ordinary VS Code Terminal', () => {
    show();
    if (view) view.createTerminal({ mirror: false });
  }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.focus', 'Focus Terminal', () => { show(); focusTerminal(); }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.kill', 'Kill the Active Terminal Instance', () => { if (view) view.killActive(); }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.rename', 'Rename...', () => { if (view) view.renameActive(); }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.focusNext', 'Focus Next Terminal Group', () => { if (view) { show(); view.next(1); } }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.focusPrevious', 'Focus Previous Terminal Group', () => { if (view) { show(); view.next(-1); } }, { category: 'Terminal' });
  registerCommand(wb, 'workbench.action.terminal.showInVsCode', 'Show Active Terminal in VS Code on the PC', () => { if (view) view.showActiveOnPc(); }, { category: 'Terminal' });
  return { get view() { return view; } };
}
