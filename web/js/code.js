// Code tab: VS Code window picker, file browser (+breadcrumbs, search), open tabs,
// problems, command runner and Save all — all relayed through vsc.call (§4.2, §5.2).

import {
  h, btn, iconBtn, toast, toastError, actionSheet, sheet, promptDialog, confirmDialog, setChildren,
  segmented, emptyState, spinner, pill, store, debounce, fmtBytes, relTime, basename, dirname,
  splitPath, joinPath, relPath, copyText, resizer, clamp,
} from './ui.js';
import { icon } from './icons.js';
import { openEditor } from './editor.js';
import { openTermView } from './termview.js';
import { createDeck } from './deck.js';
import { isDesktop, onLayoutChange } from './layout.js';

const PANEL_VIEWS = ['tabs', 'problems', 'commands'];

const QUICK_COMMANDS = [
  { id: 'workbench.action.files.saveAll', label: 'Save all' },
  { id: 'editor.action.formatDocument', label: 'Format document' },
  { id: 'workbench.action.terminal.new', label: 'New terminal (in VS Code)' },
  { id: 'workbench.action.closeActiveEditor', label: 'Close active editor' },
  { id: 'workbench.action.reopenClosedEditor', label: 'Reopen closed editor' },
  { id: 'workbench.view.scm', label: 'Show Source Control' },
  { id: 'workbench.action.reloadWindow', label: 'Reload window', confirm: true },
];

export function createCodeTab(panel, app) {
  const { conn, vs } = app;
  let windowId = null;
  let sub = store.get('codeSub', 'files');
  // Desktop: Files is always the left pane; the bottom panel shows one of Tabs / Problems / Cmds.
  let panelSub = PANEL_VIEWS.includes(store.get('codePanel', 'problems')) ? store.get('codePanel', 'problems') : 'problems';
  let visible = false;
  let wsInfo = null;

  // Files
  let cwd = null;
  let listing = null;
  let filesState = 'idle'; // idle | loading | error
  let filesErr = '';
  let filesSeq = 0; // newest fs.list request; older answers are dropped (never leave 'loading' behind)
  let searchQ = '';
  let searchResults = null;
  let searchState = 'idle';
  let searchSeq = 0;

  // Tabs / active editor
  let tabs = null;
  let tabsErr = '';
  let active = null;

  // Problems
  let problems = null;
  let problemsErr = '';
  let problemsFilter = 'all';
  const diagCounts = new Map(); // windowId → {errors, warnings}

  // Commands
  let cmdFilter = '';
  let cmdList = null;
  let cmdState = 'idle';
  let cmdErr = '';
  let cmdSeq = 0;

  /* ---------------------------------------------------------------- DOM */

  const winBtn = h('button', { type: 'button', class: 'window-pick', onClick: () => chooseWindow() });
  const saveAllBtn = btn('Save all', { iconName: 'saveAll', small: true, variant: 'ghost', onClick: () => saveAll() });
  const seg = segmented([
    { value: 'files', label: 'Files', icon: 'folder' },
    { value: 'tabs', label: 'Tabs', icon: 'layers' },
    { value: 'problems', label: 'Problems', icon: 'alert', badge: true },
    { value: 'commands', label: 'Cmds', icon: 'command' },
  ], sub, (v) => { sub = v; store.set('codeSub', v); renderContent(); loadSub(); }, { cls: 'code-seg' });
  const content = h('div', { class: 'code-content' });
  const top = h('div', { class: 'code-top' }, winBtn, saveAllBtn);

  // Desktop split (§8.3): explorer on the left, editor tabs on the right, Tabs / Problems /
  // Commands in a resizable panel under the editors. On phones only the left part is shown.
  const panelSeg = segmented([
    { value: 'tabs', label: 'Open editors', icon: 'layers' },
    { value: 'problems', label: 'Problems', icon: 'alert', badge: true },
    { value: 'commands', label: 'Commands', icon: 'command' },
  ], panelSub, (v) => { panelSub = v; store.set('codePanel', v); if (panelCollapsed) setPanelCollapsed(false); renderView(v); loadSub(); }, { cls: 'seg-sm code-panel-seg' });
  const panelContent = h('div', { class: 'code-content code-panel-content' });
  let panelCollapsed = store.get('codePanelCollapsed', false) === true;
  const collapseBtn = iconBtn('chevronDown', 'Hide panel', () => setPanelCollapsed(!panelCollapsed), { cls: 'sm panel-collapse' });
  const codePanel = h('section', { class: 'code-panel', 'aria-label': 'Panel' },
    h('div', { class: 'code-panel-bar' }, panelSeg.el, h('div', { class: 'code-panel-actions' },
      iconBtn('refresh', 'Refresh panel', () => loadSub(true), { cls: 'sm' }), collapseBtn)),
    panelContent);
  const deckHost = h('div', { class: 'code-deck-host' });
  const vHandle = h('div', { class: 'split-handle-y', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize panel' });
  const side = h('div', { class: 'split-side code-side' },
    h('div', { class: 'panel-head compact' },
      h('div', { class: 'panel-heading' }, h('h1', { class: 'panel-title' }, 'Code'))),
    top, seg.el, content);
  const handle = h('div', { class: 'split-handle', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize explorer' });
  const main = h('div', { class: 'split-main code-main' }, deckHost, vHandle, codePanel);
  panel.classList.add('split-panel', 'code-split');
  panel.append(side, handle, main);

  // Desktop: a VS Code workbench (js/wb/shell.js + Monaco) replaces this split view. It is loaded on
  // first use; without a vendored Monaco (web/vendor/monaco) the classic desktop view stays.
  const wbHost = h('div', { class: 'wb-host' });
  panel.append(wbHost);
  let wb = null;
  let wbLoading = null;
  let wbUnavailable = false;
  const wbActive = () => isDesktop() && !wbUnavailable;
  const applyWbMode = () => panel.classList.toggle('wb-mode', wbActive());
  applyWbMode();

  async function monacoInstalled() {
    try {
      const r = await fetch('vendor/monaco/vs/loader.js', { method: 'HEAD', cache: 'no-cache' });
      return r.status !== 404; // only "not there" disables it (a proxy may refuse HEAD)
    } catch {
      return true; // offline: try anyway (the service worker may have it cached)
    }
  }

  function ensureWb() {
    if (wb) return Promise.resolve(wb);
    if (!wbLoading) {
      wbLoading = (async () => {
        if (!(await monacoInstalled())) throw new Error('web/vendor/monaco is missing (run npm install in agent/)');
        const mod = await import('./wb/shell.js');
        wb = mod.createWorkbench(wbHost, app);
        return wb;
      })().catch((err) => {
        console.warn('[termpocket] desktop workbench unavailable, using the classic Code view:', err && err.message);
        wbUnavailable = true;
        wbLoading = null;
        applyWbMode();
        if (isDesktop()) ensureDeck();
        renderContent();
        if (visible) loadSub();
        return null;
      });
    }
    return wbLoading;
  }
  function showWb() {
    ensureWb().then((w) => { if (w && visible && wbActive()) w.show(); });
  }
  panel.style.setProperty('--side-w', `${clamp(Number(store.get('codeSideW', 340)) || 340, 240, 640)}px`);
  panel.style.setProperty('--panel-h', `${clamp(Number(store.get('codePanelH', 260)) || 260, 120, 900)}px`);
  resizer(handle, {
    get: () => side.getBoundingClientRect().width,
    set: (w) => panel.style.setProperty('--side-w', `${Math.round(w)}px`),
    min: 240, max: 640, onEnd: (w) => store.set('codeSideW', Math.round(w)),
  });
  resizer(vHandle, {
    axis: 'y', invert: true,
    get: () => codePanel.getBoundingClientRect().height,
    set: (px) => { panel.style.setProperty('--panel-h', `${Math.round(px)}px`); if (panelCollapsed) setPanelCollapsed(false); },
    min: 120, max: 900, onEnd: (px) => store.set('codePanelH', Math.round(px)),
  });
  setPanelCollapsed(panelCollapsed);

  function setPanelCollapsed(on) {
    panelCollapsed = !!on;
    store.set('codePanelCollapsed', panelCollapsed);
    main.classList.toggle('panel-collapsed', panelCollapsed);
    setChildren(collapseBtn, icon(panelCollapsed ? 'up' : 'chevronDown', { size: 18 }));
    collapseBtn.setAttribute('aria-label', panelCollapsed ? 'Show panel' : 'Hide panel');
    collapseBtn.title = panelCollapsed ? 'Show panel' : 'Hide panel';
  }

  let editorDeck = null;
  function ensureDeck() {
    if (editorDeck) return editorDeck;
    editorDeck = createDeck({
      cls: 'editor-deck',
      label: 'Open files',
      empty: () => emptyState({
        iconName: 'fileCode', title: windowId ? 'No file open' : 'No VS Code window',
        text: windowId
          ? 'Open a file from the explorer on the left. Edits are saved straight to the PC (Ctrl+S).'
          : 'Open VS Code on the PC with the TermPocket extension installed.',
      }),
      onChange: () => { if (visible && where('files')) markOpenFiles(); },
    });
    deckHost.append(editorDeck.el);
    return editorDeck;
  }
  if (isDesktop() && !wbActive()) ensureDeck();

  onLayoutChange((desk) => {
    applyWbMode();
    if (wbActive()) { if (visible) showWb(); return; }
    if (wb) wb.hide();
    if (desk) ensureDeck();
    renderContent();
    if (visible) loadSub();
  });

  const editorCtx = { conn, vs };

  /* ------------------------------------------------------------- events */

  vs.on('windows', (wins) => {
    if (!windowId || !wins.some((w) => w.windowId === windowId)) autoPickWindow(wins);
    else renderTop();
  });

  conn.on('vsc.event', ({ windowId: wid, ev, p }) => {
    if (!p) return;
    if (ev === 'diagnostics.changed') {
      diagCounts.set(wid, { errors: p.errors | 0, warnings: p.warnings | 0 });
      if (wid === windowId) {
        renderBadges();
        if (visible && where('problems')) reloadProblemsSoon();
        else problems = null; // stale; refetch when opened
      }
    } else if (ev === 'editor.changed' && wid === windowId) {
      if (Array.isArray(p.tabs)) tabs = p.tabs;
      if ('active' in p) active = p.active;
      if (visible && where('tabs')) renderView('tabs');
    }
  });

  conn.on('ready', () => { if (windowId) { wsInfo = null; loadWorkspace(); if (visible) loadSub(true); } });

  const reloadProblemsSoon = debounce(() => loadProblems(), 600);

  autoPickWindow(vs.windows);

  /* ------------------------------------------------------ window choice */

  function autoPickWindow(wins) {
    if (!wins.length) { selectWindow(null); return; }
    const pref = store.get('codeWindow', '');
    const w = wins.find((x) => vs.label(x) === pref) || wins.find((x) => x.focused) || wins[0];
    selectWindow(w.windowId);
  }

  function selectWindow(id) {
    if (id === windowId && id) { renderTop(); return; }
    windowId = id;
    wsInfo = null; cwd = null; listing = null; filesState = 'idle'; filesErr = ''; filesSeq++;
    searchQ = ''; searchResults = null;
    tabs = null; active = null; problems = null; cmdList = null;
    // A request still running for the previous window must not leave its spinner behind.
    cmdState = 'idle'; cmdErr = ''; cmdSeq++;
    if (id) store.set('codeWindow', vs.label(id));
    renderTop();
    renderBadges();
    renderContent();
    if (id) {
      loadWorkspace();
      if (visible) loadSub(true);
      if (!diagCounts.has(id)) loadProblems(true);
    }
  }

  function chooseWindow() {
    const wins = vs.windows;
    if (!wins.length) { toast('No VS Code window connected', { type: 'warn' }); vs.refresh(); return; }
    actionSheet({
      title: 'VS Code windows',
      actions: wins.map((w) => ({
        label: vs.label(w) + (w.windowId === windowId ? '  ✓' : ''),
        sub: (w.folders || []).join(' · ') || `VS Code ${w.vscodeVersion || ''}`,
        iconName: 'window',
        onSelect: () => selectWindow(w.windowId),
      })),
    });
  }

  function renderTop() {
    const w = windowId ? vs.get(windowId) : null;
    setChildren(winBtn,
      icon('window', { size: 18 }),
      h('span', { class: 'window-pick-text' },
        h('span', { class: 'window-pick-name' }, w ? vs.label(w) : 'No VS Code window'),
        w && (w.folders || [])[0]
          // Folder path cut from the left, so its end (the part that identifies it) stays visible.
          ? h('span', { class: 'window-pick-sub lead-ellipsis', title: w.folders[0] }, `\u200E${w.folders[0]}\u200E`)
          : h('span', { class: 'window-pick-sub' }, w ? 'No folder open' : (conn.online ? 'Open VS Code with the TermPocket extension' : 'Offline'))),
      vs.windows.length > 1 ? pill(String(vs.windows.length), 'muted') : null,
      icon('chevronDown', { size: 16 }));
    saveAllBtn.disabled = !w;
  }

  function renderBadges() {
    const c = windowId ? diagCounts.get(windowId) : null;
    for (const s of [seg, panelSeg]) {
      s.badge('problems', c && (c.errors || c.warnings) ? (c.errors || c.warnings) : '');
      const segBadge = s.el.querySelector('.seg-badge');
      if (segBadge) segBadge.classList.toggle('warn', !!c && !c.errors && !!c.warnings);
    }
    app.setBadge('code', c && c.errors ? c.errors : '');
  }

  /* -------------------------------------------------------------- loading */

  async function loadWorkspace() {
    if (!windowId || !conn.online) return;
    const wid = windowId;
    try {
      const info = await conn.vsc(wid, 'workspace.info');
      if (wid !== windowId) return;
      wsInfo = info;
      if (visible && where('files') && !searchQ) renderView('files');
    } catch (err) {
      console.warn('[termpocket] workspace.info failed', err);
    }
  }

  function loadSub(force = false) {
    if (!windowId || !conn.online || wbActive()) return;
    for (const v of shownViews()) {
      if (v === 'files' && (force || !listing)) loadDir(cwd);
      else if (v === 'tabs' && (force || !tabs)) loadTabs();
      else if (v === 'problems' && (force || !problems)) loadProblems();
      else if (v === 'commands' && (force || !cmdList)) loadCommands();
    }
  }

  async function loadDir(path) {
    const wid = windowId;
    const seq = ++filesSeq;
    filesState = 'loading';
    if (visible && where('files') && !searchQ) renderView('files');
    try {
      if (!wid) throw new Error('No VS Code window is connected');
      const r = await conn.vsc(wid, 'fs.list', path ? { path } : {});
      if (seq !== filesSeq || wid !== windowId) return;
      listing = r;
      cwd = r.path;
      filesState = 'idle';
    } catch (err) {
      if (seq !== filesSeq || wid !== windowId) return;
      filesState = 'error';
      filesErr = err.message;
    }
    if (where('files') && !searchQ) renderView('files');
  }

  async function loadTabs() {
    const wid = windowId;
    tabsErr = '';
    try {
      const [t, a] = await Promise.all([
        conn.vsc(wid, 'editor.tabs'),
        conn.vsc(wid, 'editor.active').catch(() => null),
      ]);
      if (wid !== windowId) return;
      tabs = Array.isArray(t) ? t : [];
      active = a;
    } catch (err) {
      if (wid !== windowId) return;
      tabsErr = err.message;
    }
    if (where('tabs')) renderView('tabs');
  }

  async function loadProblems(countsOnly = false) {
    const wid = windowId;
    if (!wid || !conn.online) return;
    problemsErr = '';
    try {
      const list = await conn.vsc(wid, 'diagnostics.list', {});
      if (wid !== windowId) return;
      problems = Array.isArray(list) ? list : [];
      diagCounts.set(wid, {
        errors: problems.filter((d) => d.severity === 'error').length,
        warnings: problems.filter((d) => d.severity === 'warning').length,
      });
      renderBadges();
    } catch (err) {
      if (wid !== windowId) return;
      problemsErr = err.message;
    }
    if (where('problems') && (!countsOnly || problems || problemsErr)) renderView('problems');
  }

  async function loadCommands() {
    const wid = windowId;
    const seq = ++cmdSeq;
    cmdState = 'loading';
    renderCommandResults();
    try {
      if (!wid) throw new Error('No VS Code window is connected');
      const list = await conn.vsc(wid, 'commands.list', cmdFilter ? { filter: cmdFilter } : {});
      if (seq !== cmdSeq || wid !== windowId) return;
      // A newer extension may answer with {id, title} objects; this list shows ids.
      cmdList = Array.isArray(list) ? list.map((c) => (c && typeof c === 'object' ? String(c.id) : String(c))) : [];
      cmdState = 'idle';
    } catch (err) {
      if (seq !== cmdSeq || wid !== windowId) return;
      cmdState = 'error';
      cmdErr = err.message;
      cmdList = null;
    }
    renderCommandResults();
  }

  /* -------------------------------------------------------------- render */

  /** Sub-views currently on screen: phone → the selected one; desktop → Files + the panel's one. */
  function shownViews() {
    return isDesktop() ? ['files', panelSub] : [sub];
  }

  /** The container a sub-view renders into, or null when it isn't on screen. */
  function where(name) {
    if (isDesktop()) return name === 'files' ? content : name === panelSub ? panelContent : null;
    return name === sub ? content : null;
  }

  function renderView(name) {
    const el = where(name);
    if (!el) return;
    if (!windowId) {
      setChildren(el, el === content ? emptyState({
        iconName: 'code', title: 'No VS Code window',
        text: conn.online
          ? 'Open VS Code on the PC with the TermPocket extension installed. Windows appear here automatically.'
          : 'Waiting for the connection to the PC…',
        action: conn.online ? btn('Check again', { small: true, iconName: 'refresh', onClick: () => vs.refresh() }) : null,
      }) : h('div', { class: 'muted-note' }, 'No VS Code window connected.'));
      return;
    }
    if (name === 'files') renderFiles(el);
    else if (name === 'tabs') renderTabs(el);
    else if (name === 'problems') renderProblems(el);
    else renderCommands(el);
  }

  function renderContent() {
    for (const v of shownViews()) renderView(v);
    if (editorDeck) editorDeck.refreshEmpty();
  }

  /* Files ---------------------------------------------------------------- */

  let searchInput = null;
  let searchClear = null;
  let searchBar = null;
  let filesBody = null;

  function renderFiles(el = content) {
    if (!searchInput) {
      searchInput = h('input', {
        class: 'input search-input', type: 'search', placeholder: 'Search files by name…',
        autocomplete: 'off', spellcheck: false, autocapitalize: 'off', enterKeyHint: 'search',
        'aria-label': 'Search files',
      });
      searchClear = iconBtn('x', 'Clear search', () => {
        searchQ = ''; searchInput.value = ''; searchResults = null; searchSeq++; searchClear.hidden = true; renderFilesBody();
      }, { cls: 'sm' });
      searchInput.addEventListener('input', () => {
        searchQ = searchInput.value.trim();
        searchClear.hidden = !searchQ;
        runSearchSoon();
      });
      searchBar = h('div', { class: 'searchbar' }, icon('search', { size: 18 }), searchInput, searchClear);
    }
    if (searchInput.value.trim() !== searchQ) searchInput.value = searchQ;
    searchClear.hidden = !searchQ;
    filesBody = h('div', { class: 'files-body' });
    setChildren(el, searchBar, filesBody);
    renderFilesBody();
  }

  /** Desktop: highlight explorer rows whose file is open in an editor tab. */
  function markOpenFiles() {
    if (!filesBody) return;
    const deckKeys = new Set(editorDeck ? editorDeck.keys : []);
    const act = editorDeck ? editorDeck.active : null;
    for (const row of filesBody.querySelectorAll('.file-row[data-path]')) {
      const key = fileKey(row.dataset.path);
      row.classList.toggle('is-open', deckKeys.has(key));
      row.classList.toggle('is-current', key === act);
    }
  }

  function fileKey(path) { return `file:${windowId}:${String(path).toLowerCase()}`; }

  function renderFilesBody() {
    if (!filesBody) return;
    if (searchQ) { renderSearchResults(); return; }
    const nodes = [];
    const folders = (wsInfo && wsInfo.folders) || [];
    if (folders.length > 1) {
      nodes.push(h('div', { class: 'chips folder-chips' }, folders.map((f) =>
        h('button', { type: 'button', class: ['chip', cwd && cwd.toLowerCase().startsWith(String(f.path).toLowerCase()) && 'active'], onClick: () => loadDir(f.path) },
          icon('folder', { size: 14 }), f.name || basename(f.path)))));
    }
    if (cwd) nodes.push(crumbs(cwd));
    if (filesState === 'loading' && !listing) nodes.push(spinner('Loading…'));
    else if (filesState === 'idle' && !listing && windowId) {
      // Nothing requested yet (offline, or the window just changed while hidden): never a blank pane.
      nodes.push(emptyState({ iconName: 'folder', title: conn.online ? 'Folder not loaded' : 'Offline', text: conn.online ? '' : 'Not connected to the PC.',
        action: btn('Retry', { small: true, onClick: () => loadDir(cwd) }) }));
    }
    else if (filesState === 'error') {
      nodes.push(emptyState({ iconName: 'alert', title: 'Couldn’t open folder', text: filesErr, tone: 'err',
        action: btn('Retry', { small: true, onClick: () => loadDir(cwd) }) }));
    } else if (listing) {
      const entries = listing.entries || [];
      const list = h('div', { class: ['list', 'file-list', filesState === 'loading' && 'busy'] });
      const segs = splitPath(cwd);
      if (segs.length > 1) {
        list.append(h('button', { type: 'button', class: 'file-row up', onClick: () => loadDir(dirname(cwd)) },
          h('span', { class: 'file-ico' }, icon('folderUp', { size: 18 })), h('span', { class: 'file-name' }, '..')));
      }
      if (!entries.length) list.append(h('div', { class: 'muted-note' }, 'This folder is empty.'));
      for (const e of entries) list.append(fileRow(e));
      nodes.push(list);
    } else if (!conn.online) nodes.push(h('div', { class: 'muted-note' }, 'Offline.'));
    setChildren(filesBody, nodes);
    markOpenFiles();
  }

  function crumbs(path) {
    const segs = splitPath(path);
    const el = h('nav', { class: 'crumbs', 'aria-label': 'Path' },
      iconBtn('home', 'Workspace root', () => loadDir(null), { cls: 'crumb-home sm' }),
      segs.map((s, i) => [
        h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
        h('button', { type: 'button', class: ['crumb', i === segs.length - 1 && 'current'], onClick: () => loadDir(s.path) }, s.name),
      ]));
    requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
    return el;
  }

  function fileRow(e) {
    const full = joinPath(cwd, e.name);
    const isDir = e.type === 'dir';
    const meta = [];
    if (!isDir && e.size != null) meta.push(fmtBytes(e.size));
    if (e.mtime) meta.push(relTime(e.mtime));
    const row = h('div', { class: 'file-row-wrap' },
      h('button', {
        type: 'button', class: ['file-row', isDir && 'dir'], 'data-path': isDir ? null : full, title: full,
        onClick: () => (isDir ? loadDir(full) : e.type === 'symlink' ? openSymlink(full) : openFile(full)),
      },
      h('span', { class: 'file-ico' }, icon(isDir ? 'folder' : e.type === 'symlink' ? 'link2' : 'file', { size: 18 })),
      h('span', { class: 'file-name' }, e.name),
      h('span', { class: 'file-meta' }, meta.join(' · '))),
      iconBtn('more', 'More', () => fileMenu(full, e), { cls: 'row-more sm' }));
    return row;
  }

  async function openSymlink(full) {
    try {
      const r = await conn.vsc(windowId, 'fs.list', { path: full });
      listing = r; cwd = r.path; filesState = 'idle'; renderView('files');
    } catch { openFile(full); }
  }

  function fileMenu(full, e) {
    const isDir = e.type === 'dir';
    actionSheet({
      title: e.name,
      subtitle: full,
      actions: [
        isDir
          ? { label: 'Open folder', iconName: 'folder', onSelect: () => loadDir(full) }
          : { label: isDesktop() ? 'Open in editor' : 'Open in phone editor', iconName: 'edit', onSelect: () => openFile(full) },
        !isDir && { label: 'Open on PC', iconName: 'external', onSelect: () => openOnPc(full) },
        isDir && { label: 'Terminal here', sub: 'New mirrored terminal in this folder', iconName: 'terminal', onSelect: () => terminalHere(full) },
        { label: 'Copy path', iconName: 'copy', onSelect: async () => toast((await copyText(full)) ? 'Path copied' : 'Copy failed') },
      ],
    });
  }

  function openFile(path, line, column) {
    if (!windowId) return;
    if (!isDesktop()) { openEditor(editorCtx, { windowId, path, line, column }); return; }
    const deck = ensureDeck();
    const key = fileKey(path);
    const existing = deck.get(key);
    if (existing) {
      deck.activate(key);
      if (line && existing.api && existing.api.goTo) existing.api.goTo(line, column);
      return;
    }
    const wid = windowId;
    deck.open(key, {
      title: basename(path), iconName: 'fileCode', tooltip: path,
      build: (pane, hooks) => openEditor(editorCtx, {
        windowId: wid, path, line, column,
        embed: { host: pane, onClosed: hooks.onClosed },
        onDirty: hooks.setDirty,
        onTitle: (name, full) => hooks.setTitle(name, full),
      }),
    });
  }

  async function openOnPc(path, line, column) {
    try {
      await conn.vsc(windowId, 'editor.open', { path, line, column, preview: false });
      toast('Opened in VS Code', { type: 'ok', timeout: 1500 });
    } catch (err) { toastError(err, 'Open on PC failed'); }
  }

  async function terminalHere(folder) {
    try {
      const s = await conn.request('pty.create', { cwd: folder, vscodeWindowId: windowId, title: basename(folder) });
      if (isDesktop() && app.openTerminalSession) app.openTerminalSession(s);
      else openTermView({ conn, vs, getSession: () => s, windowsPty: app.windowsPty }, { id: s.id, title: s.title });
    } catch (err) { toastError(err, 'Could not start terminal'); }
  }

  const runSearchSoon = debounce(() => runSearch(), 300);

  async function runSearch() {
    const q = searchQ;
    if (!q) { searchResults = null; renderFilesBody(); return; }
    const seq = ++searchSeq;
    searchState = 'loading';
    renderFilesBody();
    try {
      const r = await conn.vsc(windowId, 'fs.search', { query: q, max: 50 });
      if (seq !== searchSeq) return;
      searchResults = Array.isArray(r) ? r : [];
      searchState = 'idle';
    } catch (err) {
      if (seq !== searchSeq) return;
      searchState = 'error';
      searchResults = null;
      filesErr = err.message;
    }
    renderFilesBody();
  }

  function renderSearchResults() {
    const roots = ((wsInfo && wsInfo.folders) || []).map((f) => f.path);
    if (searchState === 'loading' && !searchResults) { setChildren(filesBody, spinner('Searching…')); return; }
    if (searchState === 'error') { setChildren(filesBody, emptyState({ iconName: 'alert', title: 'Search failed', text: filesErr, tone: 'err' })); return; }
    if (!searchResults) { setChildren(filesBody); return; }
    if (!searchResults.length) { setChildren(filesBody, emptyState({ iconName: 'search', title: 'No matches', text: `No file names contain “${searchQ}”.` })); return; }
    setChildren(filesBody,
      h('div', { class: 'list-caption' }, `${searchResults.length}${searchResults.length >= 50 ? '+' : ''} files`),
      h('div', { class: ['list', 'file-list', searchState === 'loading' && 'busy'] }, searchResults.map((p) => {
        const rel = relPath(p, roots);
        return h('div', { class: 'file-row-wrap' },
          h('button', { type: 'button', class: 'file-row', onClick: () => openFile(p) },
            h('span', { class: 'file-ico' }, icon('file', { size: 18 })),
            h('span', { class: 'file-name' }, basename(p)),
            h('span', { class: 'file-meta mono' }, dirname(rel) === rel ? '' : dirname(rel))),
          iconBtn('external', 'Open on PC', () => openOnPc(p), { cls: 'row-more sm' }));
      })));
  }

  /* Tabs ----------------------------------------------------------------- */

  function renderTabs(el = content) {
    const nodes = [];
    if (active && active.path) {
      nodes.push(h('button', { type: 'button', class: 'active-editor', onClick: () => openFile(active.path, active.line, active.column) },
        h('span', { class: 'active-label' }, 'Active editor'),
        h('span', { class: 'active-file' }, icon('fileCode', { size: 18 }), h('span', { class: 'ellipsis' }, basename(active.path)),
          h('span', { class: 'mono active-pos' }, `${active.line || 1}:${active.column || 1}`)),
        active.selectionText ? h('span', { class: 'active-sel mono' }, String(active.selectionText).slice(0, 200)) : null));
    }
    if (!tabs) nodes.push(tabsErr ? emptyState({ iconName: 'alert', title: 'Couldn’t load tabs', text: tabsErr, tone: 'err', action: btn('Retry', { small: true, onClick: loadTabs }) }) : spinner('Loading tabs…'));
    else if (!tabs.length) nodes.push(emptyState({ iconName: 'layers', title: 'No open editors', text: 'Files you open in VS Code show up here.' }));
    else {
      const groups = new Map();
      for (const t of tabs) {
        const g = t.group ?? 0;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(t);
      }
      for (const [g, list] of groups) {
        if (groups.size > 1) nodes.push(h('div', { class: 'list-caption' }, `Group ${g}`));
        nodes.push(h('div', { class: 'list file-list' }, list.map((t) => h('div', { class: 'file-row-wrap' },
          h('button', {
            type: 'button', class: ['file-row', t.isActive && 'is-active'], disabled: !t.path,
            onClick: () => t.path && openFile(t.path),
          },
          h('span', { class: 'file-ico' }, icon(t.path ? 'fileCode' : 'layers', { size: 18 })),
          h('span', { class: 'file-name' }, t.label || basename(t.path || '')),
          h('span', { class: 'file-meta' },
            t.isDirty ? h('span', { class: 'dirty-dot', title: 'Unsaved' }) : null,
            t.isPinned ? icon('pin', { size: 14 }) : null,
            t.path ? h('span', { class: 'mono' }, basename(dirname(t.path))) : 'not a file')),
          t.path ? iconBtn('more', 'Tab actions', () => tabMenu(t), { cls: 'row-more sm' }) : null))));
      }
    }
    setChildren(el, h('div', { class: 'tabs-body' }, nodes));
  }

  function tabMenu(t) {
    actionSheet({
      title: t.label,
      subtitle: t.path,
      actions: [
        { label: isDesktop() ? 'Open in editor' : 'Open in phone editor', iconName: 'edit', onSelect: () => openFile(t.path) },
        { label: 'Show on PC', iconName: 'external', onSelect: () => openOnPc(t.path) },
        t.isDirty && { label: 'Save on PC', iconName: 'save', onSelect: async () => {
          try { await conn.vsc(windowId, 'editor.save', { path: t.path }); toast('Saved', { type: 'ok' }); } catch (err) { toastError(err, 'Save failed'); }
        } },
        { label: 'Close tab on PC', iconName: 'x', danger: true, onSelect: async () => {
          try { await conn.vsc(windowId, 'editor.close', { path: t.path }); loadTabs(); } catch (err) { toastError(err, 'Close failed'); }
        } },
      ],
    });
  }

  /* Problems ------------------------------------------------------------- */

  function renderProblems(el = content) {
    const filterSeg = segmented([
      { value: 'all', label: 'All' },
      { value: 'error', label: 'Errors' },
      { value: 'warning', label: 'Warnings' },
    ], problemsFilter, (v) => { problemsFilter = v; renderView('problems'); }, { cls: 'seg-sm' });
    const head = h('div', { class: 'sub-head' }, filterSeg.el, iconBtn('refresh', 'Refresh problems', () => loadProblems(), { cls: 'sm' }));
    let body;
    if (!problems) {
      body = problemsErr
        ? emptyState({ iconName: 'alert', title: 'Couldn’t load problems', text: problemsErr, tone: 'err', action: btn('Retry', { small: true, onClick: () => loadProblems() }) })
        : spinner('Loading problems…');
    } else {
      const list = problems.filter((d) => problemsFilter === 'all' || d.severity === problemsFilter);
      if (!list.length) {
        body = emptyState({ iconName: 'checkCircle', title: problemsFilter === 'all' ? 'No problems' : `No ${problemsFilter}s`, text: 'The workspace is clean.', tone: 'ok' });
      } else {
        const byFile = new Map();
        for (const d of list) {
          if (!byFile.has(d.path)) byFile.set(d.path, []);
          byFile.get(d.path).push(d);
        }
        body = h('div', { class: 'problems' }, [...byFile].map(([path, items]) => h('div', { class: 'problem-file' },
          h('div', { class: 'problem-file-head' },
            icon('fileCode', { size: 16 }), h('span', { class: 'ellipsis' }, basename(path)),
            h('span', { class: 'problem-dir mono ellipsis', title: dirname(path) }, relPath(dirname(path), ((wsInfo && wsInfo.folders) || []).map((f) => f.path))),
            pill(String(items.length), items.some((x) => x.severity === 'error') ? 'err' : items.some((x) => x.severity === 'warning') ? 'warn' : 'info')),
          items.map((d) => h('button', { type: 'button', class: ['problem', d.severity], onClick: () => openFile(path, d.line, d.column) },
            h('span', { class: 'sev-ico' }, icon(d.severity === 'error' ? 'errorCircle' : d.severity === 'warning' ? 'alert' : 'info', { size: 16 })),
            h('span', { class: 'problem-text' },
              h('span', { class: 'problem-msg' }, d.message),
              h('span', { class: 'problem-meta mono' },
                `${d.line}:${d.column}`,
                d.source ? `  ${d.source}` : '',
                d.code != null && d.code !== '' ? `(${typeof d.code === 'object' ? (d.code.value ?? '') : d.code})` : '')))))));
        if (problems.length >= 500) body.append(h('div', { class: 'muted-note' }, 'Showing the first 500 problems.'));
      }
    }
    setChildren(el, head, body);
  }

  /* Commands ------------------------------------------------------------- */

  let cmdInput = null;
  let cmdResults = null;
  const loadCommandsSoon = debounce(() => loadCommands(), 280);

  function renderCommands(el = content) {
    if (!cmdInput) {
      cmdInput = h('input', {
        class: 'input search-input mono', type: 'search', placeholder: 'Filter commands, e.g. git.',
        autocomplete: 'off', spellcheck: false, autocapitalize: 'off', enterKeyHint: 'search',
        'aria-label': 'Filter commands',
      });
      cmdInput.addEventListener('input', () => { cmdFilter = cmdInput.value.trim(); loadCommandsSoon(); });
      cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && cmdFilter && cmdList && cmdList.includes(cmdFilter)) runCommand(cmdFilter);
      });
    }
    cmdResults = h('div', { class: 'cmd-results' });
    const recent = store.get('recentCommands', []);
    setChildren(el,
      h('div', { class: 'searchbar' }, icon('command', { size: 18 }), cmdInput),
      !cmdFilter ? h('div', { class: 'quick-cmds' },
        h('div', { class: 'list-caption' }, 'Quick'),
        h('div', { class: 'chips' }, QUICK_COMMANDS.map((c) => h('button', { type: 'button', class: 'chip', title: c.id, onClick: () => runCommand(c.id, undefined, c) }, c.label))),
        recent.length ? h('div', { class: 'list-caption' }, 'Recent') : null,
        recent.length ? h('div', { class: 'chips' }, recent.map((id) => h('button', { type: 'button', class: 'chip mono', onClick: () => runCommand(id) }, id))) : null) : null,
      cmdResults);
    renderCommandResults();
  }

  function renderCommandResults() {
    if (!cmdResults || !where('commands')) return;
    if (cmdState === 'loading' && !cmdList) { setChildren(cmdResults, spinner('Loading commands…')); return; }
    if (cmdState === 'error') {
      setChildren(cmdResults, emptyState({ iconName: 'alert', title: 'Couldn’t load commands', text: cmdErr, tone: 'err',
        action: btn('Retry', { small: true, onClick: () => loadCommands() }) }));
      return;
    }
    if (!cmdList) { setChildren(cmdResults); return; }
    if (!cmdList.length) { setChildren(cmdResults, emptyState({ iconName: 'command', title: 'No commands match', text: cmdFilter })); return; }
    setChildren(cmdResults,
      h('div', { class: 'list-caption' }, `${cmdList.length}${cmdList.length >= 300 ? '+' : ''} commands`),
      h('div', { class: ['list', 'cmd-list', cmdState === 'loading' && 'busy'] }, cmdList.map((id) => h('div', { class: 'file-row-wrap' },
        h('button', { type: 'button', class: 'file-row cmd-row', onClick: () => runCommand(id) },
          h('span', { class: 'file-ico' }, icon('command', { size: 16 })),
          h('span', { class: 'file-name mono' }, id)),
        iconBtn('more', 'Run with arguments', () => runWithArgs(id), { cls: 'row-more sm' })))));
  }

  async function runWithArgs(id) {
    const text = await promptDialog({
      title: 'Run with arguments', message: `${id}\nArguments as a JSON array, e.g. ["value", 1]`,
      value: '[]', mono: true, confirmText: 'Run',
      validate: (v) => { try { return Array.isArray(JSON.parse(v)) ? null : 'Must be a JSON array'; } catch { return 'Invalid JSON'; } },
    });
    if (text == null) return;
    runCommand(id, JSON.parse(text));
  }

  async function runCommand(id, args, meta) {
    if (!windowId) return;
    if (meta && meta.confirm) {
      const ok = await confirmDialog({ title: `${meta.label}?`, message: id, confirmText: 'Run' });
      if (!ok) return;
    }
    const recent = store.get('recentCommands', []).filter((x) => x !== id);
    recent.unshift(id);
    store.set('recentCommands', recent.slice(0, 8));
    try {
      const r = await conn.vsc(windowId, 'commands.run', args ? { command: id, args } : { command: id });
      const result = r ? r.result : undefined;
      if (result === undefined || result === null || result === '') toast(`Ran ${id}`, { type: 'ok', timeout: 1600 });
      else {
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        sheet({ title: 'Command result', subtitle: id, content: h('pre', { class: 'result-pre mono' }, text) });
      }
    } catch (err) { toastError(err, id); }
    if (!cmdFilter && where('commands')) renderView('commands');
  }

  /* Save all ------------------------------------------------------------- */

  async function saveAll() {
    if (!windowId) return;
    try {
      await conn.vsc(windowId, 'editor.save', {});
      toast('All files saved', { type: 'ok' });
      if (where('tabs')) loadTabs();
    } catch (err) { toastError(err, 'Save all failed'); }
  }

  renderTop();
  renderContent();

  return {
    onShow() {
      visible = true;
      applyWbMode();
      if (wbActive()) { showWb(); return; }
      if (!windowId && vs.windows.length) autoPickWindow(vs.windows);
      renderContent();
      loadSub();
    },
    onHide() { visible = false; if (wb) wb.hide(); },
  };
}
