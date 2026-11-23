// Desktop Code tab = a VS Code workbench (Dark Modern) for one VS Code window at a time.
//
//   title bar   app icon · menu bar · window switcher | ← → · command center | layout toggles
//   activity bar (Explorer + registered views) · side bar host · editor part (tabs, breadcrumbs,
//   Monaco) · panel (registered views: Problems, Terminal …) · status bar (registered items)
//
// createWorkbench(rootEl, app) → wb (the shared workbench API, see web/js/wb/README in the
// structured notes / web/README.md). Builder C's modules (palette, status bar, problems, terminal,
// SCM, search, panel helpers) are loaded at the hook point below; each exports register(wb) and
// is optional: the shell works without any of them.
//
// Remote strings are rendered with textContent only (h() children).

import { h, setChildren, store, clamp, debounce, resizer } from '../ui.js';
import {
  linkCss, linkMonacoCss, ci, iconText, fileIcon, comboOf, normCombo, kbLabel, contextMenu, closeContextMenu,
  dialog, notify, quickPick, setOverlayRoot, actionBtn, pathKey,
} from './base.js';
import { createExplorer } from './explorer.js';
import { createEditorService } from './editor-monaco.js';

/* ======================================================================================
 * HOOK POINT (builder C): optional workbench modules, loaded in this order. Each module is
 * `web/js/wb/<name>.js` exporting `register(wb)`. A missing or failing module is skipped.
 * ==================================================================================== */
export const C_MODULES = ['palette', 'statusbar', 'problems', 'panel', 'wbterminal', 'scm', 'search'];

const SIDEBAR_MIN = 170;
const PANEL_MIN = 80;
const S = (k, d) => store.get(`wb.${k}`, d);
const W = (k, v) => store.set(`wb.${k}`, v);

export function createWorkbench(rootEl, app) {
  linkCss('./wb.css');
  linkMonacoCss();
  const { conn, vs } = app;

  /* ------------------------------------------------------------------------------ state */
  let windowId = null;
  let visible = false;
  let workspace = { name: '', folders: [] };
  const winListeners = new Set();
  const wsListeners = new Set();
  const visListeners = new Set();

  /* -------------------------------------------------------------------------------- DOM */
  const overlay = h('div', { class: 'wb-overlay' });
  setOverlayRoot(overlay);

  // Title bar
  const winBtn = h('button', { type: 'button', class: 'wb-tb-window', title: 'Switch VS Code Window', onClick: () => switchWindow() });
  const menubar = h('div', { class: 'wb-menubar', role: 'menubar' });
  const ccLabel = h('span', { class: 'wb-cc-label' });
  const commandCenter = h('button', { type: 'button', class: 'wb-cc', title: 'Search files by name (append : to go to line or @ to go to symbol)', onClick: () => quickOpen('') },
    ci('search'), ccLabel);
  const navBack = actionBtn('arrow-left', 'Go Back', () => run('workbench.action.navigateBack'), { kb: 'alt+left', cls: 'wb-tb-nav' });
  const navFwd = actionBtn('arrow-right', 'Go Forward', () => run('workbench.action.navigateForward'), { kb: 'alt+right', cls: 'wb-tb-nav' });
  const tSidebar = actionBtn('layout-sidebar-left', 'Toggle Primary Side Bar', () => run('workbench.action.toggleSidebarVisibility'), { kb: 'ctrl+b' });
  const tPanel = actionBtn('layout-panel', 'Toggle Panel', () => run('workbench.action.togglePanel'), { kb: 'ctrl+j' });
  const titlebar = h('header', { class: 'wb-titlebar' },
    h('div', { class: 'wb-tb-left' }, h('span', { class: 'wb-tb-appicon', 'aria-hidden': 'true' }, appLogo()), menubar),
    h('div', { class: 'wb-tb-center' }, navBack, navFwd, commandCenter),
    h('div', { class: 'wb-tb-right' }, winBtn, h('span', { class: 'wb-tb-sep' }), tSidebar, tPanel));

  // Activity bar + side bar
  const actTop = h('div', { class: 'wb-act-items', role: 'tablist', 'aria-orientation': 'vertical' });
  const actBottom = h('div', { class: 'wb-act-items bottom' });
  const activity = h('nav', { class: 'wb-activity', 'aria-label': 'Activity Bar' }, actTop, actBottom);
  const sideTitle = h('h2', { class: 'wb-side-title-label' });
  const sideActions = h('div', { class: 'wb-side-title-actions' });
  const sideBody = h('div', { class: 'wb-side-body' });
  const sidebar = h('aside', { class: 'wb-sidebar' }, h('div', { class: 'wb-side-title' }, sideTitle, sideActions), sideBody);
  const sideSash = h('div', { class: 'wb-sash vertical', role: 'separator', 'aria-orientation': 'vertical' });

  // Editor part + panel
  const editorPart = h('div', { class: 'wb-editor-part' });
  const panelTabs = h('div', { class: 'wb-panel-tabs', role: 'tablist' });
  const panelViewActions = h('div', { class: 'wb-panel-view-actions' });
  const panelMax = actionBtn('chevron-up', 'Maximize Panel Size', () => togglePanelMax());
  const panelClose = actionBtn('close', 'Hide Panel', () => setPanelVisible(false), { kb: 'ctrl+j' });
  const panelBody = h('div', { class: 'wb-panel-body' });
  const panelEl = h('section', { class: 'wb-panel', 'aria-label': 'Panel' },
    h('div', { class: 'wb-panel-title' }, panelTabs, h('div', { class: 'wb-panel-actions' }, panelViewActions, h('div', { class: 'wb-panel-global' }, panelMax, panelClose))),
    panelBody);
  const panelSash = h('div', { class: 'wb-sash horizontal', role: 'separator', 'aria-orientation': 'horizontal' });
  const main = h('div', { class: 'wb-mainarea' }, editorPart, panelSash, panelEl);

  // Status bar
  const statusLeft = h('div', { class: 'wb-status-left' });
  const statusRight = h('div', { class: 'wb-status-right' });
  const statusbar = h('footer', { class: 'wb-statusbar' }, statusLeft, statusRight);

  const body = h('div', { class: 'wb-body' }, activity, sidebar, sideSash, main);
  const root = h('div', { class: 'wb', tabindex: '-1' }, titlebar, body, statusbar, overlay);
  rootEl.replaceChildren(root);

  /* ------------------------------------------------------------------------- the wb API */
  const wb = {
    app,
    get windowId() { return windowId; },
    get window() { return windowId ? vs.get(windowId) : null; },
    get windowKey() { return windowKeyOf(windowId ? vs.get(windowId) : null); },
    get workspace() { return workspace; },
    get visible() { return visible; },
    get root() { return root; },
    get overlay() { return overlay; },
    onWindowChange(fn) { winListeners.add(fn); return () => winListeners.delete(fn); },
    onWorkspaceChange(fn) { wsListeners.add(fn); return () => wsListeners.delete(fn); },
    onVisibilityChange(fn) { visListeners.add(fn); return () => visListeners.delete(fn); },
    call(m, p) {
      if (!windowId) return Promise.reject(new Error('No VS Code window is connected'));
      return conn.vsc(windowId, m, p || {});
    },
    onVsc(ev, fn) {
      return conn.on('vsc.event', (msg) => {
        if (!msg || msg.ev !== ev || msg.windowId !== windowId) return;
        try { fn(msg.p || {}, msg.windowId); } catch (err) { console.error('[wb] vsc handler failed', ev, err); }
      });
    },
    activity: null,
    panel: null,
    status: null,
    commands: null,
    keys: null,
    editors: null,
    explorer: null,
    quickInput: (opts) => quickInputImpl(opts || {}),
    setQuickInput(fn) { customQuickInput = typeof fn === 'function' ? fn : null; },
    // shared UI helpers (VS Code look) for every workbench module
    codicon: (name, opts) => ci(name, opts),
    iconText,
    fileIcon: (name, opts) => fileIcon(name, opts),
    contextMenu: (at, items, opts) => contextMenu(at, items, opts),
    dialog: (opts) => dialog(opts),
    notify: (msg, opts) => notify(msg, opts),
    quickPick: (items, opts) => quickPick(items, opts),
    kbLabel,
    focusEditor: () => wb.editors && wb.editors.focus(),
    show,
    hide,
    dispose,
  };

  /* ------------------------------------------------------------------- keys + commands */
  const bindings = []; // {combo, fn, opts}
  wb.keys = {
    /** bind('Ctrl+Shift+P', fn, {terminal?: true, input?: true}) → unbind. fn returning false = not handled. */
    bind(combo, fn, opts = {}) {
      const b = { combo: normCombo(combo), fn, opts };
      bindings.push(b);
      return () => { const i = bindings.indexOf(b); if (i >= 0) bindings.splice(i, 1); };
    },
    /** Normalized combo of a KeyboardEvent ('ctrl+shift+p'). */
    comboOf,
  };
  const commands = new Map();
  const cmdListeners = new Set();
  wb.commands = {
    register(id, title, fn, { keybinding, category, terminal, input, hidden, checked } = {}) {
      const unbind = keybinding ? [].concat(keybinding).map((k) => wb.keys.bind(k, () => { runCmd(id); }, { terminal, input })) : [];
      const entry = { id, title, category: category || '', keybinding: Array.isArray(keybinding) ? keybinding[0] : keybinding || '', fn, hidden: !!hidden, checked: typeof checked === 'function' ? checked : null, local: true };
      commands.set(id, entry);
      for (const l of cmdListeners) try { l(); } catch { /* ignore */ }
      return () => { if (commands.get(id) === entry) commands.delete(id); unbind.forEach((u) => u()); };
    },
    run: (id, ...args) => runCmd(id, ...args),
    has: (id) => commands.has(id),
    get: (id) => commands.get(id) || null,
    /** Local workbench commands: [{id, title, category, keybinding}] (palette lists them). */
    list: () => [...commands.values()].filter((c) => !c.hidden).map(({ id, title, category, keybinding }) => ({ id, title, category, keybinding })),
    onChange(fn) { cmdListeners.add(fn); return () => cmdListeners.delete(fn); },
  };
  function runCmd(id, ...args) {
    const c = commands.get(id);
    if (!c) return Promise.resolve(undefined);
    try {
      return Promise.resolve(c.fn(...args)).catch((err) => { notify(err && err.message ? err.message : String(err), { severity: 'error' }); });
    } catch (err) {
      notify(err && err.message ? err.message : String(err), { severity: 'error' });
      return Promise.resolve(undefined);
    }
  }
  const run = (id) => runCmd(id);

  // Commands that keep working while a terminal has focus (VS Code's commandsToSkipShell defaults).
  const TERMINAL_PASS = new Set(['f1', 'ctrl+shift+p', 'ctrl+p', 'ctrl+`', 'ctrl+b', 'ctrl+j', 'ctrl+shift+e', 'ctrl+shift+f', 'ctrl+shift+g', 'ctrl+shift+m', 'ctrl+pageup', 'ctrl+pagedown', 'ctrl+shift+`']);

  function onKeyDown(e) {
    if (!visible || e.isComposing) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && overlay.contains(t)) return; // quick input / menus / dialogs handle their own keys
    // Keys typed elsewhere in the app (sheets, pairing …) are not ours — except from the app's own nav
    // (clicking the Code tab leaves the focus on its button: Ctrl+P must still work right away).
    if (t && !root.contains(t) && t !== document.body && t !== document.documentElement && !t.closest('.tabbar .tab')) return;
    if (document.querySelector('.sheet-backdrop, .dialog-backdrop')) return; // app-level modal (ui.js)
    const combo = comboOf(e);
    if (!combo) return;
    const inTerm = !!(t && t.closest('.xterm'));
    const inInput = !!(t && !t.closest('.monaco-editor') && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i];
      if (b.combo !== combo) continue;
      if (inTerm && !b.opts.terminal && !TERMINAL_PASS.has(combo)) continue;
      if (inInput && !b.opts.input && !/^(ctrl\+|f\d|alt\+)/.test(combo)) continue;
      let r;
      try { r = b.fn(e); } catch (err) { console.error('[wb] key handler failed', combo, err); }
      if (r === false) continue;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  /* ----------------------------------------------------------------- quick input (hook) */
  let customQuickInput = null;
  function quickInputImpl(opts) {
    if (customQuickInput) return Promise.resolve(customQuickInput(opts));
    return fallbackQuickInput(opts);
  }
  function quickOpen(value) { return wb.quickInput({ value, mode: value === '>' ? 'commands' : value === ':' ? 'gotoLine' : 'quickOpen' }); }

  /** Minimal quick open / command palette used when palette.js is not installed. */
  async function fallbackQuickInput({ value = '' } = {}) {
    if (value.startsWith('>')) {
      const it = await quickPick(wb.commands.list().map((c) => ({
        label: c.category ? `${c.category}: ${c.title}` : c.title, kb: c.keybinding, value: c.id,
      })), { placeholder: 'Type the name of a command to run.' });
      if (it) runCmd(it.value);
      return it;
    }
    if (value.startsWith(':')) {
      const a = wb.editors.active();
      const it = await quickPick(async (q) => {
        if (!a) return [{ label: 'Open a text editor first to go to a line.', value: null }];
        const m = /^:?\s*(\d+)(?:\s*[:,]\s*(\d+))?\s*$/.exec(q);
        if (!m) return [{ label: `Current Line: ${a.line}, Character: ${a.column}. Type a line number between 1 and ${a.lineCount || 1} to navigate to.`, value: null }];
        const line = Math.min(Number(m[1]) || 1, a.lineCount || 1);
        return [{ label: m[2] ? `Go to line ${line}, character ${m[2]}.` : `Go to line ${line}.`, value: { line, column: Number(m[2]) || 1 } }];
      }, { value: ':', placeholder: '' });
      if (it && it.value) wb.editors.revealLine(it.value.line, it.value.column);
      return it;
    }
    const roots = workspace.folders.map((f) => f.path);
    const recent = wb.editors.recent().map((p) => ({ label: p.split(/[\\/]/).pop(), description: rel(p, roots), icon: fileIcon(p), value: p }));
    const it = await quickPick(async (q) => {
      const query = q.trim();
      if (!query) return recent;
      let found = [];
      try { found = await wb.call('fs.search', { query, max: 60 }); } catch { found = []; }
      const seen = new Set(recent.map((r) => pathKey(r.value)));
      return [...recent.filter((r) => r.label.toLowerCase().includes(query.toLowerCase())),
        ...(found || []).filter((p) => !seen.has(pathKey(p))).map((p) => ({ label: p.split(/[\\/]/).pop(), description: rel(p, roots), icon: fileIcon(p), value: p }))];
    }, { placeholder: 'Search files by name (append : to go to line or @ to go to symbol)' });
    if (it) wb.editors.open(it.value, { preview: false });
    return it;
  }
  function rel(p, roots) {
    for (const r of roots) {
      const rk = pathKey(r);
      const pk = pathKey(p);
      if (pk.startsWith(rk + '\\') || pk.startsWith(rk + '/')) return p.slice(r.replace(/[\\/]+$/, '').length + 1).replace(/[\\/][^\\/]*$/, '') || '';
    }
    return p.replace(/[\\/][^\\/]*$/, '');
  }

  /* -------------------------------------------------------------- activity bar + sidebar */
  const views = new Map(); // id → {spec, btn, container, handle, actions}
  let activeView = S('activeView', 'explorer');
  let sidebarVisible = S('sidebarVisible', true) !== false;
  root.style.setProperty('--wb-side-w', `${clamp(Number(S('sideW', 300)) || 300, SIDEBAR_MIN, 900)}px`);

  wb.activity = {
    /** register({id, title, icon, order, mount(container, ctx) → {show, hide, dispose}, action?, kb?}) */
    register(spec) {
      if (!spec || !spec.id) throw new Error('activity.register: id required');
      if (views.has(spec.id)) views.get(spec.id).btn.remove();
      const btn = h('button', {
        type: 'button', class: 'wb-act-item', role: 'tab', title: spec.kb ? `${spec.title} (${kbLabel(spec.kb)})` : spec.title,
        'aria-label': spec.title, 'data-view': spec.id,
      }, activityIcon(spec.icon), h('span', { class: 'wb-act-badge', hidden: true }));
      btn.addEventListener('click', () => {
        if (spec.action) { spec.action(); return; }
        if (activeView === spec.id && sidebarVisible) setSidebarVisible(false);
        else wb.activity.show(spec.id);
      });
      const item = { spec, btn, container: null, handle: null, actions: h('div', { class: 'wb-side-view-actions' }) };
      views.set(spec.id, item);
      const ordered = [...views.values()].sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
      for (const v of ordered) actTop.append(v.btn);
      if (spec.id === activeView && !spec.action) wb.activity.show(spec.id, { keepHidden: !sidebarVisible });
      else syncActivity();
      return { setBadge: (t) => setActBadge(spec.id, t), dispose: () => { btn.remove(); views.delete(spec.id); } };
    },
    show(id, { keepHidden = false, focus = false } = {}) {
      const item = views.get(id);
      if (!item || item.spec.action) { if (item) item.spec.action(); return; }
      if (!keepHidden && !sidebarVisible) setSidebarVisible(true, { noShow: true });
      const prev = views.get(activeView);
      if (prev && prev !== item && prev.handle) { try { prev.handle.hide && prev.handle.hide(); } catch (err) { console.error(err); } if (prev.container) prev.container.hidden = true; }
      activeView = id;
      W('activeView', id);
      sideTitle.textContent = item.spec.title;
      setChildren(sideActions, item.actions);
      if (!item.container) {
        item.container = h('div', { class: 'wb-side-view', 'data-view': id });
        sideBody.append(item.container);
        try {
          item.handle = item.spec.mount(item.container, { wb, actions: item.actions, setTitle: (t) => { if (activeView === id) sideTitle.textContent = t; } }) || {};
        } catch (err) {
          console.error('[wb] view mount failed', id, err);
          item.container.append(h('div', { class: 'wb-view-message error' }, `This view failed to load: ${err.message}`));
          item.handle = {};
        }
      }
      item.container.hidden = false;
      if (sidebarVisible && visible) { try { item.handle.show && item.handle.show({ focus }); } catch (err) { console.error(err); } }
      syncActivity();
    },
    get active() { return activeView; },
    setBadge: (id, text) => setActBadge(id, text),
  };
  function setActBadge(id, text) {
    const item = views.get(id);
    if (!item) return;
    const b = item.btn.querySelector('.wb-act-badge');
    const t = text == null || text === 0 || text === '0' ? '' : String(text);
    b.hidden = !t;
    b.textContent = t;
  }
  function syncActivity() {
    for (const [id, v] of views) {
      const on = id === activeView && sidebarVisible && !v.spec.action;
      v.btn.classList.toggle('checked', on);
      v.btn.setAttribute('aria-selected', String(on));
    }
  }
  function activityIcon(icon) {
    if (icon instanceof Node) return icon;
    if (typeof icon === 'string' && icon.trim().startsWith('<svg')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = icon.trim(); // static markup supplied by workbench modules, never remote data
      const svg = tpl.content.firstElementChild;
      return h('span', { class: 'wb-act-icon svg' }, svg);
    }
    return h('span', { class: 'wb-act-icon' }, ci(icon || 'circle-large-outline'));
  }
  function setSidebarVisible(on, { noShow = false } = {}) {
    sidebarVisible = !!on;
    W('sidebarVisible', sidebarVisible);
    root.classList.toggle('no-sidebar', !sidebarVisible);
    setChildren(tSidebar, ci(sidebarVisible ? 'layout-sidebar-left' : 'layout-sidebar-left-off'));
    const item = views.get(activeView);
    if (item && item.handle) {
      try {
        if (sidebarVisible && !noShow && visible) item.handle.show && item.handle.show({});
        else if (!sidebarVisible) item.handle.hide && item.handle.hide();
      } catch (err) { console.error(err); }
    }
    syncActivity();
  }
  // Manage (gear) at the bottom, like VS Code.
  actBottom.append(h('button', {
    type: 'button', class: 'wb-act-item', title: 'Manage', 'aria-label': 'Manage',
    onClick: (e) => contextMenu({ x: e.currentTarget.getBoundingClientRect().right + 2, y: e.currentTarget.getBoundingClientRect().top - 120 }, [
      { label: 'Command Palette...', kb: 'ctrl+shift+p', onSelect: () => quickOpen('>') },
      'sep',
      { label: 'TermPocket Settings', onSelect: () => { const b = document.querySelector('.side-menu'); if (b) b.click(); } },
      { label: 'Keyboard Shortcuts', onSelect: () => quickOpen('>') },
    ]),
  }, h('span', { class: 'wb-act-icon' }, ci('settings-gear'))));

  resizer(sideSash, {
    get: () => sidebar.getBoundingClientRect().width,
    set: (w) => root.style.setProperty('--wb-side-w', `${Math.round(w)}px`),
    min: SIDEBAR_MIN, max: 900, onEnd: (w) => W('sideW', Math.round(w)),
  });

  /* ------------------------------------------------------------------------------ panel */
  const pviews = new Map(); // id → {spec, tab, container, handle, actions}
  let activePanel = S('activePanel', 'terminal');
  let panelVisible = S('panelVisible', true) !== false;
  let panelMaxed = false;
  root.style.setProperty('--wb-panel-h', `${clamp(Number(S('panelH', 260)) || 260, PANEL_MIN, 2000)}px`);

  wb.panel = {
    /** register({id, title, order, badge?:()=>string, mount(container, ctx) → {show, hide, dispose}}) */
    register(spec) {
      if (!spec || !spec.id) throw new Error('panel.register: id required');
      if (pviews.has(spec.id)) pviews.get(spec.id).tab.remove();
      const tab = h('button', { type: 'button', class: 'wb-panel-tab', role: 'tab', 'data-view': spec.id, title: spec.kb ? `${spec.title} (${kbLabel(spec.kb)})` : spec.title },
        h('span', { class: 'wb-panel-tab-label' }, spec.title), h('span', { class: 'wb-panel-badge', hidden: true }));
      tab.addEventListener('click', () => wb.panel.show(spec.id));
      const item = { spec, tab, container: null, handle: null, actions: h('div', { class: 'wb-panel-view-actions-inner' }) };
      pviews.set(spec.id, item);
      const ordered = [...pviews.values()].sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
      for (const v of ordered) panelTabs.append(v.tab);
      if (!pviews.has(activePanel) || activePanel === spec.id) {
        if (!pviews.has(activePanel)) activePanel = spec.id;
        activatePanelView(activePanel);
      }
      updatePanelBadges();
      syncPanelEmpty();
      return { dispose: () => { tab.remove(); pviews.delete(spec.id); syncPanelEmpty(); } };
    },
    show(id, { focus = true } = {}) {
      if (id && pviews.has(id)) activatePanelView(id, { focus });
      if (!panelVisible) setPanelVisible(true, { focus });
    },
    toggle(id) {
      if (id && pviews.has(id)) {
        if (panelVisible && activePanel === id) setPanelVisible(false);
        else wb.panel.show(id);
        return;
      }
      setPanelVisible(!panelVisible);
    },
    hide: () => setPanelVisible(false),
    isVisible: () => panelVisible,
    get active() { return activePanel; },
    has: (id) => pviews.has(id),
    updateBadges: () => updatePanelBadges(),
    toggleMaximized: () => togglePanelMax(),
  };
  function activatePanelView(id, { focus = false } = {}) {
    const item = pviews.get(id);
    if (!item) return;
    const prev = pviews.get(activePanel);
    if (prev && prev !== item && prev.handle) {
      try { prev.handle.hide && prev.handle.hide(); } catch (err) { console.error(err); }
      if (prev.container) prev.container.hidden = true;
    }
    activePanel = id;
    W('activePanel', id);
    for (const [pid, v] of pviews) {
      v.tab.classList.toggle('checked', pid === id);
      v.tab.setAttribute('aria-selected', String(pid === id));
    }
    setChildren(panelViewActions, item.actions);
    if (!item.container) {
      item.container = h('div', { class: 'wb-panel-view', 'data-view': id });
      panelBody.append(item.container);
      try {
        item.handle = item.spec.mount(item.container, { wb, actions: item.actions }) || {};
      } catch (err) {
        console.error('[wb] panel mount failed', id, err);
        item.container.append(h('div', { class: 'wb-view-message error' }, `This view failed to load: ${err.message}`));
        item.handle = {};
      }
    }
    item.container.hidden = false;
    if (panelVisible && visible) { try { item.handle.show && item.handle.show({ focus }); } catch (err) { console.error(err); } }
  }
  function updatePanelBadges() {
    for (const v of pviews.values()) {
      let t = '';
      try { t = v.spec.badge ? String(v.spec.badge() ?? '') : ''; } catch { t = ''; }
      if (t === '0') t = '';
      const b = v.tab.querySelector('.wb-panel-badge');
      b.hidden = !t;
      b.textContent = t;
    }
  }
  function syncPanelEmpty() { panelEl.classList.toggle('is-empty', pviews.size === 0); }
  function setPanelVisible(on, { focus = false } = {}) {
    panelVisible = !!on;
    W('panelVisible', panelVisible);
    root.classList.toggle('no-panel', !panelVisible);
    if (!panelVisible && panelMaxed) togglePanelMax(false);
    setChildren(tPanel, ci(panelVisible ? 'layout-panel' : 'layout-panel-off'));
    const item = pviews.get(activePanel);
    if (item && item.handle) {
      try {
        if (panelVisible && visible) item.handle.show && item.handle.show({ focus });
        else item.handle.hide && item.handle.hide();
      } catch (err) { console.error(err); }
    }
    if (!panelVisible) wb.focusEditor();
  }
  function togglePanelMax(force) {
    panelMaxed = force === undefined ? !panelMaxed : !!force;
    if (panelMaxed && !panelVisible) setPanelVisible(true);
    root.classList.toggle('panel-max', panelMaxed);
    setChildren(panelMax, ci(panelMaxed ? 'chevron-down' : 'chevron-up'));
    panelMax.title = panelMaxed ? 'Restore Panel Size' : 'Maximize Panel Size';
  }
  resizer(panelSash, {
    axis: 'y', invert: true,
    get: () => panelEl.getBoundingClientRect().height,
    set: (px) => { if (panelMaxed) togglePanelMax(false); root.style.setProperty('--wb-panel-h', `${Math.round(px)}px`); },
    min: PANEL_MIN, max: 2000, onEnd: (px) => W('panelH', Math.round(px)),
  });
  panelEl.addEventListener('dblclick', (e) => { if (e.target === panelTabs || e.target.closest('.wb-panel-title') === e.target) togglePanelMax(); });

  /* ------------------------------------------------------------------------- status bar */
  const statusItems = new Map(); // id → {spec, el}
  wb.status = {
    /** add({id, side:'left'|'right', order, text, tooltip?, onClick?, kind?}) → {set(textOrPartial), remove()} */
    add(spec) {
      const id = spec.id || `item${statusItems.size + 1}`;
      if (statusItems.has(id)) statusItems.get(id).el.remove();
      const el = h('div', { class: 'wb-status-item', role: 'button', 'data-id': id, tabindex: '-1' });
      const item = { spec: { side: 'left', order: 50, ...spec, id }, el };
      el.addEventListener('click', (e) => { if (item.spec.onClick) item.spec.onClick(e); });
      statusItems.set(id, item);
      renderStatusItem(item);
      placeStatus(item);
      return {
        set(v) {
          if (typeof v === 'string') item.spec.text = v;
          else if (v && typeof v === 'object') Object.assign(item.spec, v);
          renderStatusItem(item);
        },
        remove() { el.remove(); statusItems.delete(id); },
        get el() { return el; },
      };
    },
    has: (id) => statusItems.has(id),
  };
  function renderStatusItem(item) {
    const s = item.spec;
    item.el.className = ['wb-status-item', s.kind && `kind-${s.kind}`, s.onClick && 'clickable', s.cls].filter(Boolean).join(' ');
    item.el.hidden = !!s.hidden || (!s.text && !s.icon);
    item.el.title = s.tooltip || '';
    setChildren(item.el, iconText(s.text || ''));
  }
  function placeStatus(item) {
    const side = item.spec.side === 'right' ? statusRight : statusLeft;
    const list = [...statusItems.values()].filter((x) => (x.spec.side === 'right') === (item.spec.side === 'right'))
      .sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
    for (const x of list) side.append(x.el);
  }

  /* ---------------------------------------------------------------- windows + workspace */
  function windowKeyOf(w) {
    if (!w) return '';
    return String((w.folders && w.folders[0]) || w.name || w.windowId || '').toLowerCase();
  }

  function pickWindow(wins) {
    if (!wins.length) return null;
    const cur = windowId && wins.find((w) => w.windowId === windowId);
    if (cur) return cur;
    const prefKey = S('windowKey', '');
    return wins.find((w) => windowKeyOf(w) === prefKey) || wins.find((w) => w.focused) || wins[0];
  }

  function setWindow(id) {
    if (id === windowId) { renderWindowBtn(); return; }
    windowId = id;
    const w = id ? vs.get(id) : null;
    if (w) W('windowKey', windowKeyOf(w));
    workspace = w ? { name: w.name || '', folders: (w.folders || []).map((p) => ({ name: p.split(/[\\/]/).filter(Boolean).pop() || p, path: p })) } : { name: '', folders: [] };
    renderWindowBtn();
    for (const fn of [...winListeners]) { try { fn(windowId); } catch (err) { console.error('[wb] window listener failed', err); } }
    emitWorkspace();
    loadWorkspaceInfo();
  }

  let wsSeq = 0;
  async function loadWorkspaceInfo() {
    if (!windowId || !conn.online) return;
    const my = ++wsSeq;
    const wid = windowId;
    try {
      const info = await conn.vsc(wid, 'workspace.info', {});
      if (my !== wsSeq || wid !== windowId || !info) return;
      const folders = Array.isArray(info.folders) ? info.folders.map((f) => ({ name: f.name || f.path, path: f.path })) : [];
      const changed = JSON.stringify(folders) !== JSON.stringify(workspace.folders) || info.name !== workspace.name;
      workspace = { name: info.name || workspace.name, folders, activeFile: info.activeFile || null };
      if (changed) emitWorkspace();
      renderWindowBtn();
    } catch (err) {
      console.warn('[wb] workspace.info failed', err && err.message);
    }
  }
  function emitWorkspace() {
    renderTitle();
    for (const fn of [...wsListeners]) { try { fn(workspace); } catch (err) { console.error('[wb] workspace listener failed', err); } }
  }

  function renderWindowBtn() {
    const w = windowId ? vs.get(windowId) : null;
    setChildren(winBtn,
      ci('window'),
      h('span', { class: 'wb-tb-window-name' }, w ? vs.label(w) : conn.online ? 'No VS Code window' : 'Offline'),
      vs.windows.length > 1 ? h('span', { class: 'wb-tb-window-count' }, String(vs.windows.length)) : null,
      ci('chevron-down'));
    winBtn.classList.toggle('none', !w);
    renderTitle();
  }
  function renderTitle() {
    const w = windowId ? vs.get(windowId) : null;
    ccLabel.textContent = w ? (workspace.name || vs.label(w)) : conn.online ? 'No VS Code window' : 'Offline';
  }

  async function switchWindow() {
    const wins = vs.windows;
    if (!wins.length) { notify('No VS Code window is connected. Open VS Code with the TermPocket extension on the PC.', { severity: 'info' }); vs.refresh(); return; }
    const it = await quickPick(wins.map((w) => ({
      label: vs.label(w),
      description: w.windowId === windowId ? 'current window' : (w.focused ? 'focused on the PC' : ''),
      detail: (w.folders || []).join('  ·  ') || `VS Code ${w.vscodeVersion || ''}`,
      icon: w.windowId === windowId ? 'check' : 'window',
      value: w.windowId,
    })), { placeholder: 'Select a VS Code window to switch to' });
    if (it) setWindow(it.value);
  }

  vs.on('windows', (wins) => {
    const w = pickWindow(wins);
    if ((w && w.windowId) !== windowId) setWindow(w ? w.windowId : null);
    else { renderWindowBtn(); if (w) syncFoldersFromWindow(w); }
  });
  function syncFoldersFromWindow(w) {
    const f = (w.folders || []).map((p) => pathKey(p)).join('|');
    const cur = workspace.folders.map((x) => pathKey(x.path)).join('|');
    if (f !== cur) loadWorkspaceInfo();
  }
  conn.on('ready', () => { renderWindowBtn(); if (windowId) loadWorkspaceInfo(); });
  conn.on('status', () => renderWindowBtn());

  /* -------------------------------------------------------------------- editor + explorer */
  wb.editors = createEditorService(wb, editorPart);
  wb.explorer = createExplorer(wb);
  wb.activity.register({
    id: 'explorer', title: 'Explorer', icon: 'files', order: 0, kb: 'ctrl+shift+e',
    mount: (container, ctx) => wb.explorer.mount(container, ctx),
  });

  /* ------------------------------------------------------------------- built-in commands */
  const reg = wb.commands.register;
  reg('workbench.action.showCommands', 'Show All Commands', () => quickOpen('>'), { keybinding: ['ctrl+shift+p', 'f1'], terminal: true });
  reg('workbench.action.quickOpen', 'Go to File...', () => quickOpen(''), { keybinding: 'ctrl+p', terminal: true });
  reg('workbench.action.gotoLine', 'Go to Line/Column...', () => quickOpen(':'), { keybinding: 'ctrl+g', category: 'Go' });
  reg('workbench.action.switchWindow', 'Switch Window...', () => switchWindow(), { category: 'View' });
  reg('workbench.action.toggleSidebarVisibility', 'Toggle Primary Side Bar Visibility', () => setSidebarVisible(!sidebarVisible), { keybinding: 'ctrl+b', category: 'View', terminal: true });
  reg('workbench.action.togglePanel', 'Toggle Panel Visibility', () => wb.panel.toggle(), { keybinding: 'ctrl+j', category: 'View', terminal: true });
  reg('workbench.action.toggleMaximizedPanel', 'Toggle Maximized Panel', () => togglePanelMax(), { category: 'View' });
  reg('workbench.action.terminal.toggleTerminal', 'Toggle Terminal', () => {
    if (!wb.panel.has('terminal')) { notify('The terminal panel is not available.', { severity: 'info' }); return; }
    const termFocused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.wb-panel');
    if (panelVisible && activePanel === 'terminal' && termFocused) setPanelVisible(false);
    else wb.panel.show('terminal', { focus: true });
  }, { keybinding: 'ctrl+`', category: 'View', terminal: true });
  reg('workbench.view.explorer', 'Show Explorer', () => wb.activity.show('explorer', { focus: true }), { keybinding: 'ctrl+shift+e', category: 'View', terminal: true });
  reg('workbench.view.search', 'Show Search', () => { if (views.has('search')) wb.activity.show('search', { focus: true }); else quickOpen(''); }, { keybinding: 'ctrl+shift+f', category: 'View', terminal: true });
  reg('workbench.view.scm', 'Show Source Control', () => { if (views.has('scm')) wb.activity.show('scm', { focus: true }); }, { keybinding: 'ctrl+shift+g', category: 'View', terminal: true });
  reg('workbench.actions.view.problems', 'Focus Problems (Errors, Warnings, Infos)', () => { if (pviews.has('problems')) wb.panel.show('problems'); }, { keybinding: 'ctrl+shift+m', category: 'View', terminal: true });
  reg('workbench.action.focusActiveEditorGroup', 'Focus Active Editor Group', () => wb.focusEditor(), { category: 'View' });

  /* --------------------------------------------------------------------------- menu bar */
  const MENUS = [
    ['File', [
      ['explorer.newFile', 'New File...'], ['explorer.newFolder', 'New Folder...'], 'sep',
      ['workbench.action.files.save', 'Save'], ['workbench.action.files.saveAll', 'Save All'], 'sep',
      ['workbench.action.files.revert', 'Revert File'], ['workbench.action.closeActiveEditor', 'Close Editor'],
      ['workbench.action.closeAllEditors', 'Close All Editors'], 'sep', ['workbench.action.switchWindow', 'Switch Window...'],
    ]],
    ['Edit', [
      ['editor.action.undo', 'Undo'], ['editor.action.redo', 'Redo'], 'sep',
      ['editor.action.clipboardCutAction', 'Cut'], ['editor.action.clipboardCopyAction', 'Copy'], ['editor.action.clipboardPasteAction', 'Paste'], 'sep',
      ['actions.find', 'Find'], ['editor.action.startFindReplaceAction', 'Replace'], 'sep',
      ['workbench.view.search', 'Find in Files'], 'sep',
      ['editor.action.commentLine', 'Toggle Line Comment'], ['editor.action.blockComment', 'Toggle Block Comment'],
    ]],
    ['Selection', [
      ['editor.action.selectAll', 'Select All'], ['editor.action.smartSelect.expand', 'Expand Selection'], ['editor.action.smartSelect.shrink', 'Shrink Selection'], 'sep',
      ['editor.action.copyLinesUpAction', 'Copy Line Up'], ['editor.action.copyLinesDownAction', 'Copy Line Down'],
      ['editor.action.moveLinesUpAction', 'Move Line Up'], ['editor.action.moveLinesDownAction', 'Move Line Down'], 'sep',
      ['editor.action.insertCursorAbove', 'Add Cursor Above'], ['editor.action.insertCursorBelow', 'Add Cursor Below'],
      ['editor.action.addSelectionToNextFindMatch', 'Add Next Occurrence'], ['editor.action.selectHighlights', 'Select All Occurrences'],
    ]],
    ['View', [
      ['workbench.action.showCommands', 'Command Palette...'], 'sep',
      ['workbench.view.explorer', 'Explorer'], ['workbench.view.search', 'Search'], ['workbench.view.scm', 'Source Control'], 'sep',
      ['workbench.actions.view.problems', 'Problems'], ['workbench.action.terminal.toggleTerminal', 'Terminal'], 'sep',
      ['workbench.action.toggleSidebarVisibility', 'Primary Side Bar'], ['workbench.action.togglePanel', 'Panel'],
      ['editor.action.toggleMinimap', 'Minimap'], ['editor.action.toggleWordWrap', 'Word Wrap'], 'sep',
      ['termpocket.toggleFollowPc', 'Follow Active Editor on PC'],
    ]],
    ['Go', [
      ['workbench.action.navigateBack', 'Back'], ['workbench.action.navigateForward', 'Forward'], 'sep',
      ['workbench.action.nextEditor', 'Next Editor'], ['workbench.action.previousEditor', 'Previous Editor'], 'sep',
      ['workbench.action.quickOpen', 'Go to File...'], ['workbench.action.gotoLine', 'Go to Line/Column...'], 'sep',
      ['editor.action.marker.nextInFiles', 'Next Problem'], ['editor.action.marker.prevInFiles', 'Previous Problem'],
    ]],
    ['Terminal', [
      ['workbench.action.terminal.new', 'New Terminal'], ['workbench.action.terminal.kill', 'Kill Terminal'], 'sep',
      ['workbench.action.terminal.toggleTerminal', 'Toggle Terminal'],
    ]],
    ['Help', [
      ['workbench.action.showCommands', 'Show All Commands'], ['termpocket.openOnPc', 'Open Active File in VS Code on the PC'],
    ]],
  ];
  let menuOpenIdx = -1;
  const menuBtns = MENUS.map(([label, items], i) => {
    const b = h('button', { type: 'button', class: 'wb-menubar-item', role: 'menuitem' }, label);
    b.addEventListener('mousedown', (e) => { e.preventDefault(); openMenuAt(i); });
    b.addEventListener('mouseenter', () => { if (menuOpenIdx >= 0 && menuOpenIdx !== i) openMenuAt(i); });
    void items;
    return b;
  });
  // Menus that do not fit go into "…" (all of them: ☰), like VS Code's menu bar overflow.
  const menuMore = h('button', { type: 'button', class: 'wb-menubar-item wb-menubar-more', title: 'More', 'aria-label': 'More' }, ci('ellipsis'));
  menuMore.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const hidden = menuBtns.map((b, i) => (b.hidden ? i : -1)).filter((i) => i >= 0);
    contextMenu({ anchor: menuMore }, hidden.map((i) => ({ label: MENUS[i][0], onSelect: () => setTimeout(() => openMenuAt(i, menuMore), 0) })), { minWidth: 160 });
  });
  menubar.append(...menuBtns, menuMore);
  const tbLeft = titlebar.querySelector('.wb-tb-left');
  const fitTitle = () => {
    for (const b of menuBtns) b.hidden = false;
    menuMore.hidden = true;
    const over = () => tbLeft.scrollWidth > tbLeft.clientWidth + 1;
    if (!over()) return;
    menuMore.hidden = false;
    for (let i = menuBtns.length - 1; i >= 0 && over(); i--) menuBtns[i].hidden = true;
    const all = menuBtns.every((b) => b.hidden);
    setChildren(menuMore, ci(all ? 'menu' : 'ellipsis'));
    menuMore.title = all ? 'Application Menu' : 'More';
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitTitle()).observe(titlebar);
  function openMenuAt(i, anchorEl) {
    if (menuOpenIdx === i && !anchorEl) { closeContextMenu(); return; }
    const [, items] = MENUS[i];
    const rows = items.map((it) => {
      if (it === 'sep') return 'sep';
      const [id, label] = it;
      const c = commands.get(id);
      if (!c) return null;
      const checked = id === 'workbench.action.toggleSidebarVisibility' ? sidebarVisible
        : id === 'workbench.action.togglePanel' ? panelVisible
          : c.checked ? !!c.checked() : undefined;
      return { label, kb: c.keybinding, checked, onSelect: () => runCmd(id) };
    });
    menuBtns.forEach((b, j) => b.classList.toggle('open', j === i));
    menuOpenIdx = i;
    contextMenu({ anchor: anchorEl || menuBtns[i] }, rows, {
      minWidth: 200,
      onClose: () => { menuBtns.forEach((b) => b.classList.remove('open')); setTimeout(() => { if (!document.querySelector('.wb-menu')) menuOpenIdx = -1; }, 0); },
    });
  }

  /* ---------------------------------------------------------------------- C module hook */
  const loadedModules = new Set();
  const modulesReady = (async () => {
    for (const name of C_MODULES) {
      try {
        const mod = await import(new URL(`./${name}.js`, import.meta.url).href);
        if (mod && typeof mod.register === 'function') {
          await mod.register(wb);
          loadedModules.add(name);
        }
      } catch (err) {
        if (!/Failed to fetch|Importing a module script failed|error loading dynamically imported module/i.test(String(err && err.message))) {
          console.warn(`[wb] module ${name} failed to register`, err);
        }
      }
    }
    if (!loadedModules.has('statusbar')) installFallbackStatus();
    if (!views.has('problems') && pviews.has('problems')) installProblemsShortcut();
    updatePanelBadges();
  })();
  wb.modulesReady = modulesReady;
  wb.hasModule = (name) => loadedModules.has(name);

  /** Activity bar shortcut to the PROBLEMS panel (with the error + warning count as its badge). */
  function installProblemsShortcut() {
    const item = wb.activity.register({
      id: 'problems', title: 'Problems', icon: 'warning', order: 40, kb: 'ctrl+shift+m',
      action: () => { if (panelVisible && activePanel === 'problems') setPanelVisible(false); else wb.panel.show('problems'); },
    });
    const set = (e, w) => item.setBadge(e + w > 0 ? (e + w > 99 ? '99+' : String(e + w)) : '');
    wb.onVsc('diagnostics.changed', (p) => set(p.errors | 0, p.warnings | 0));
    const load = async () => {
      try {
        const list = await wb.call('diagnostics.list', {});
        set(list.filter((d) => d.severity === 'error').length, list.filter((d) => d.severity === 'warning').length);
      } catch { set(0, 0); }
    };
    wb.onWindowChange(() => { set(0, 0); load(); });
    load();
  }

  /** Minimal status bar when statusbar.js is not installed. */
  function installFallbackStatus() {
    const remote = wb.status.add({ id: 'wb.remote', side: 'left', order: 0, kind: 'remote', text: '$(remote)', tooltip: 'TermPocket' });
    const counts = wb.status.add({ id: 'wb.problems', side: 'left', order: 20, text: '$(error) 0  $(warning) 0', tooltip: 'No Problems', onClick: () => run('workbench.actions.view.problems') });
    const pos = wb.status.add({ id: 'wb.pos', side: 'right', order: 10, text: '', onClick: () => quickOpen(':') });
    const indent = wb.status.add({ id: 'wb.indent', side: 'right', order: 20, text: '' });
    const enc = wb.status.add({ id: 'wb.enc', side: 'right', order: 30, text: '' });
    const eol = wb.status.add({ id: 'wb.eol', side: 'right', order: 40, text: '' });
    const lang = wb.status.add({ id: 'wb.lang', side: 'right', order: 50, text: '' });
    wb.status.add({ id: 'wb.bell', side: 'right', order: 100, text: '$(bell)', tooltip: 'No Notifications' });
    const upd = () => {
      const a = wb.editors.active();
      pos.set({ text: a ? `Ln ${a.line}, Col ${a.column}${a.selectionLength ? ` (${a.selectionLength} selected)` : ''}` : '' });
      indent.set({ text: a ? `${a.insertSpaces ? 'Spaces' : 'Tab Size'}: ${a.tabSize}` : '' });
      enc.set({ text: a ? (a.encoding === 'utf8bom' ? 'UTF-8 with BOM' : a.encoding === 'windows-1252' ? 'Windows 1252' : 'UTF-8') : '' });
      eol.set({ text: a ? a.eol : '' });
      lang.set({ text: a ? a.languageName : '' });
    };
    wb.editors.onActiveChange(upd);
    upd();
    const setCounts = (e, w) => counts.set({ text: `$(error) ${e}  $(warning) ${w}`, tooltip: e || w ? `Errors: ${e}, Warnings: ${w}` : 'No Problems' });
    wb.onVsc('diagnostics.changed', (p) => setCounts(p.errors | 0, p.warnings | 0));
    const loadCounts = async () => {
      try {
        const list = await wb.call('diagnostics.list', {});
        setCounts(list.filter((d) => d.severity === 'error').length, list.filter((d) => d.severity === 'warning').length);
      } catch { /* ignore */ }
    };
    wb.onWindowChange(() => { setCounts(0, 0); loadCounts(); });
    loadCounts();
    const setRemote = () => remote.set({ text: conn.online ? '$(remote)' : '$(debug-disconnect) Offline', tooltip: conn.online ? `TermPocket — ${(conn.info && conn.info.hostname) || 'PC'}` : 'Not connected to the PC' });
    conn.on('status', setRemote);
    setRemote();
  }

  /* --------------------------------------------------------------------------- lifecycle */
  function show() {
    if (visible) return;
    visible = true;
    root.classList.add('visible');
    const v = views.get(activeView);
    if (v && v.handle && sidebarVisible) { try { v.handle.show && v.handle.show({}); } catch (err) { console.error(err); } }
    const p = pviews.get(activePanel);
    if (p && p.handle && panelVisible) { try { p.handle.show && p.handle.show({}); } catch (err) { console.error(err); } }
    for (const fn of [...visListeners]) { try { fn(true); } catch (err) { console.error(err); } }
    if (!windowId && vs.windows.length) { const w = pickWindow(vs.windows); if (w) setWindow(w.windowId); }
    else if (windowId) loadWorkspaceInfo();
  }
  function hide() {
    if (!visible) return;
    visible = false;
    root.classList.remove('visible');
    closeContextMenu();
    const v = views.get(activeView);
    if (v && v.handle) { try { v.handle.hide && v.handle.hide(); } catch (err) { console.error(err); } }
    const p = pviews.get(activePanel);
    if (p && p.handle) { try { p.handle.hide && p.handle.hide(); } catch (err) { console.error(err); } }
    for (const fn of [...visListeners]) { try { fn(false); } catch (err) { console.error(err); } }
  }
  function dispose() {
    hide();
    window.removeEventListener('keydown', onKeyDown, true);
    for (const v of views.values()) { try { v.handle && v.handle.dispose && v.handle.dispose(); } catch { /* ignore */ } }
    for (const v of pviews.values()) { try { v.handle && v.handle.dispose && v.handle.dispose(); } catch { /* ignore */ } }
    root.remove();
  }

  /* ------------------------------------------------------------------------------- init */
  setSidebarVisible(sidebarVisible, { noShow: true });
  setPanelVisible(panelVisible);
  syncPanelEmpty();
  root.classList.toggle('no-panel', !panelVisible);
  const first = pickWindow(vs.windows);
  setWindow(first ? first.windowId : null);
  renderWindowBtn();
  window.addEventListener('resize', debounce(() => closeContextMenu(), 50));
  return wb;
}

/** Small VS Code-like app mark for the title bar (static markup). */
function appLogo() {
  const tpl = document.createElement('template');
  tpl.innerHTML = '<svg viewBox="0 0 100 100" width="16" height="16" aria-hidden="true"><path fill="#0065A9" d="M96.5 10.8 75.9.9a6.2 6.2 0 0 0-7.1 1.2L29.4 38 12.2 25a4.2 4.2 0 0 0-5.3.2l-5.5 5a4.2 4.2 0 0 0 0 6.2L16.3 50 1.4 63.6a4.2 4.2 0 0 0 0 6.2l5.5 5a4.2 4.2 0 0 0 5.3.2l17.2-13L68.8 97.9a6.2 6.2 0 0 0 7.1 1.2l20.6-9.9a6.2 6.2 0 0 0 3.5-5.6V16.4a6.2 6.2 0 0 0-3.5-5.6zM75 72.7 45.1 50 75 27.3z"/><path fill="#007ACC" opacity=".9" d="M75 72.7V27.3L45.1 50z"/></svg>';
  return tpl.content.firstElementChild;
}
