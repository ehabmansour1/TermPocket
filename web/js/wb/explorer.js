// EXPLORER view of the desktop workbench (builder B): OPEN EDITORS + the workspace folder tree.
//
// * Lazy: a folder is listed (fs.list) when it is expanded; expansion state is remembered per
//   VS Code window. Every load ends in a rendered state (rows, an error row with retry, or an
//   empty folder) — the explorer can never stay on "Loading…".
// * Mouse: click selects (files open in a preview tab), double-click pins, folders toggle;
//   right-click context menu. Keyboard (VS Code list navigation): ↑ ↓ ← → Home End PageUp/Down,
//   Enter (open / toggle), Space (preview), F2 rename, Delete, Ctrl+C copy path, type-to-find.
// * File operations (fs.write / fs.mkdir / fs.rename / fs.delete / fs.stat) with VS Code's inline
//   input boxes and its delete confirmation; open editors follow renames and deletions.
// * Decorations: VS Code problems (red / yellow names with counts) and Git status letters.
// * Auto-reveal of the active editor's file (explorer.autoReveal).
//
// Remote strings (names, paths, errors) are rendered with textContent only.

import { h, setChildren, store, debounce, basename, copyText } from '../ui.js';
import {
  ci, fileIcon, contextMenu, dialog, notify, inlineInput, progressBar, actionBtn, pathKey, isUnder, join, relativeTo,
} from './base.js';

const ROW_H = 22;
const INDENT = 8;
const LIST_CAP = 5000; // rows per folder rendered (huge folders: the rest behind a "show more" row)
// VS Code's default "files.exclude" (hidden in its explorer too).
const EXCLUDED = new Set(['.git', '.svn', '.hg', 'cvs', '.ds_store', 'thumbs.db']);

export function createExplorer(wb) {
  const nodes = new Map(); // pathKey → node
  let roots = []; // top-level nodes (folders of the workspace)
  let single = true; // single-folder workspace: the folder's children are the top level
  let selectedKey = null;
  let focusedKey = null;
  let anchorEl = null;
  let mounted = false;
  let shown = false;
  let treeEl = null;
  let edit = null; // {kind:'new'|'rename', type, parentKey, nodeKey}
  let problems = new Map(); // pathKey → {e, w}
  let gitDeco = new Map(); // pathKey → {letter, cls}
  let openSectionCollapsed = store.get('wb.openEditorsCollapsed', false) === true;
  let foldersCollapsed = false;
  const progress = progressBar();
  const refreshSoon = debounce(() => refresh(), 400);

  /* ---------------------------------------------------------------------- DOM */
  const openHeaderActions = h('div', { class: 'wb-pane-actions' },
    actionBtn('save-all', 'Save All', () => wb.commands.run('workbench.action.files.saveAll'), { kb: 'ctrl+k s' }),
    actionBtn('close-all', 'Close All Editors', () => wb.commands.run('workbench.action.closeAllEditors')));
  const openHeader = h('div', { class: 'wb-pane-header', role: 'button', tabindex: '0', 'aria-expanded': 'true' },
    h('span', { class: 'wb-pane-twistie' }, ci('chevron-down')), h('h3', { class: 'wb-pane-title' }, 'Open Editors'), openHeaderActions);
  const openBody = h('div', { class: 'wb-open-editors', role: 'list' });
  const openPane = h('div', { class: 'wb-pane open-editors' }, openHeader, openBody);
  const folderTitle = h('h3', { class: 'wb-pane-title' });
  const folderActions = h('div', { class: 'wb-pane-actions' },
    actionBtn('new-file', 'New File...', () => newEntry('file')),
    actionBtn('new-folder', 'New Folder...', () => newEntry('dir')),
    actionBtn('refresh', 'Refresh Explorer', () => refresh()),
    actionBtn('collapse-all', 'Collapse Folders in Explorer', () => collapseAll()));
  const folderHeader = h('div', { class: 'wb-pane-header', role: 'button', tabindex: '0', 'aria-expanded': 'true' },
    h('span', { class: 'wb-pane-twistie' }, ci('chevron-down')), folderTitle, folderActions);
  const tree = h('div', { class: 'wb-tree', role: 'tree', tabindex: '0', 'aria-label': 'Files Explorer' });
  treeEl = tree;
  const folderBody = h('div', { class: 'wb-pane-body' }, h('div', { class: 'wb-pane-progress' }, progress.el), tree);
  const folderPane = h('div', { class: 'wb-pane folders' }, folderHeader, folderBody);
  const viewEl = h('div', { class: 'wb-explorer' }, openPane, folderPane);

  openHeader.addEventListener('click', (e) => { if (!e.target.closest('.wb-action')) setOpenCollapsed(!openSectionCollapsed); });
  folderHeader.addEventListener('click', (e) => { if (!e.target.closest('.wb-action')) { foldersCollapsed = !foldersCollapsed; syncPanes(); } });
  for (const hd of [openHeader, folderHeader]) hd.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hd.click(); } });

  function setOpenCollapsed(v) {
    openSectionCollapsed = !!v;
    store.set('wb.openEditorsCollapsed', openSectionCollapsed);
    syncPanes();
  }
  function syncPanes() {
    openPane.classList.toggle('collapsed', openSectionCollapsed);
    openHeader.setAttribute('aria-expanded', String(!openSectionCollapsed));
    setChildren(openHeader.querySelector('.wb-pane-twistie'), ci(openSectionCollapsed ? 'chevron-right' : 'chevron-down'));
    folderPane.classList.toggle('collapsed', foldersCollapsed);
    folderHeader.setAttribute('aria-expanded', String(!foldersCollapsed));
    setChildren(folderHeader.querySelector('.wb-pane-twistie'), ci(foldersCollapsed ? 'chevron-right' : 'chevron-down'));
  }
  syncPanes();

  /* ---------------------------------------------------------------------- model */
  const winKey = () => wb.windowKey || '';
  const expandedStoreKey = () => `wb.expanded.${winKey()}`;
  function loadExpanded() {
    const v = store.get(expandedStoreKey(), []);
    return new Set(Array.isArray(v) ? v : []);
  }
  let expandedSet = loadExpanded();
  const saveExpanded = debounce(() => store.set(expandedStoreKey(), [...expandedSet].slice(-400)), 400);

  function makeNode(path, name, type, parent) {
    const key = pathKey(path);
    let n = nodes.get(key);
    if (n) {
      n.name = name;
      n.type = type;
      n.parent = parent;
      n.path = path;
      return n;
    }
    n = { key, path, name, type, parent, depth: parent ? parent.depth + 1 : 0, expanded: expandedSet.has(key), children: null, loading: false, error: '', seq: 0, limit: LIST_CAP };
    nodes.set(key, n);
    return n;
  }
  const isDir = (n) => n.type === 'dir';

  function resetRoots() {
    nodes.clear();
    edit = null;
    expandedSet = loadExpanded();
    const folders = wb.workspace.folders || [];
    single = folders.length <= 1;
    roots = folders.map((f) => {
      const n = makeNode(f.path, f.name || basename(f.path), 'dir', null);
      n.depth = single ? -1 : 0;
      n.isRoot = true;
      if (single) n.expanded = true;
      else if (!expandedSet.size || expandedSet.has(n.key)) n.expanded = true;
      return n;
    });
    const name = wb.workspace.name || (folders[0] && folders[0].name) || '';
    folderTitle.textContent = !wb.windowId ? 'No Folder Opened' : folders.length > 1 ? `${name} (Workspace)` : name || 'No Folder Opened';
    selectedKey = null;
    focusedKey = null;
    render();
    for (const r of roots) if (r.expanded) loadChildren(r);
  }

  /** fs.list a folder. Always ends in loading=false (rows, error or empty). */
  async function loadChildren(n, { force = false } = {}) {
    if (!isDir(n)) return;
    if (n.loading && !force) return n.pending;
    if (n.children && !force) return null;
    const my = ++n.seq;
    const wid = wb.windowId;
    n.loading = true;
    n.error = '';
    if (!n.children) render();
    const done = progress.start();
    const p = (async () => {
      try {
        const r = await wb.call('fs.list', { path: n.path });
        if (my !== n.seq || wid !== wb.windowId) return;
        const entries = ((r && Array.isArray(r.entries)) ? r.entries : []).filter((e) => !EXCLUDED.has(String(e.name).toLowerCase()));
        const keep = new Set();
        n.children = entries.map((e) => {
          const c = makeNode(join(n.path, e.name), e.name, e.type === 'dir' ? 'dir' : e.type === 'symlink' ? 'symlink' : 'file', n);
          c.depth = n.depth + 1;
          keep.add(c.key);
          return c;
        });
        n.truncated = r && r.truncated ? (Number(r.total) || 0) : 0; // the agent lists at most 10 000 entries
        // forget nodes of entries that vanished
        for (const [k, x] of nodes) if (x.parent === n && !keep.has(k)) dropSubtree(x);
        n.error = '';
      } catch (err) {
        if (my !== n.seq) return;
        n.error = err && err.message ? err.message : String(err);
        if (!n.children) n.children = null;
      } finally {
        if (my === n.seq) n.loading = false;
        done();
      }
      render();
      // expanded descendants (remembered state) load too
      if (n.children) for (const c of n.children) if (isDir(c) && c.expanded && !c.children && !c.loading) loadChildren(c);
    })();
    n.pending = p;
    return p;
  }
  function dropSubtree(x) {
    nodes.delete(x.key);
    if (x.children) for (const c of x.children) dropSubtree(c);
  }

  /* ---------------------------------------------------------------------- visible rows */
  function visibleRows() {
    const out = [];
    const walk = (list) => {
      for (const n of list) {
        out.push({ node: n });
        if (edit && edit.kind === 'new' && edit.parentKey === n.key && n.expanded) out.push({ newEntry: true, depth: n.depth + 1, parent: n });
        if (isDir(n) && n.expanded) {
          if (n.error) out.push({ message: n.error, error: true, depth: n.depth + 1, parent: n });
          else if (n.children) {
            walk(n.children.slice(0, n.limit));
            if (n.children.length > n.limit) out.push({ more: true, depth: n.depth + 1, parent: n, count: n.children.length - n.limit });
            if (n.truncated) out.push({ note: `${n.truncated - n.children.length} more items are not listed (folder too large)`, depth: n.depth + 1, parent: n });
          }
        }
      }
    };
    if (single) {
      const r = roots[0];
      if (r) {
        if (edit && edit.kind === 'new' && edit.parentKey === r.key) out.push({ newEntry: true, depth: 0, parent: r });
        if (r.error) out.push({ message: r.error, error: true, depth: 0, parent: r });
        else if (r.children) {
          walk(r.children.slice(0, r.limit));
          if (r.children.length > r.limit) out.push({ more: true, depth: 0, parent: r, count: r.children.length - r.limit });
          if (r.truncated) out.push({ note: `${r.truncated - r.children.length} more items are not listed (folder too large)`, depth: 0, parent: r });
        }
      }
    } else walk(roots);
    return out;
  }
  let rowsCache = [];

  function render() {
    if (!mounted) return;
    const rows = visibleRows();
    rowsCache = rows;
    const frag = [];
    if (!wb.windowId) {
      frag.push(h('div', { class: 'wb-view-message' },
        h('p', null, wb.app.conn.online ? 'No VS Code window is connected.' : 'Not connected to the PC.'),
        h('p', null, 'Open VS Code on the PC with the TermPocket extension installed. Its windows appear here automatically.')));
    } else if (!roots.length) {
      frag.push(h('div', { class: 'wb-view-message' },
        h('p', null, 'You have not yet opened a folder in this VS Code window.'),
        h('p', null, 'Open a folder in VS Code on the PC, or pick another window in the title bar.')));
    } else if (single && roots[0] && roots[0].children === null && !roots[0].error) {
      // first listing still running: VS Code shows just the progress bar
    } else if (single && roots[0] && roots[0].children && !roots[0].children.length && !(edit && edit.kind === 'new')) {
      frag.push(h('div', { class: 'wb-view-message' }, h('p', null, 'This folder is empty.')));
    }
    const used = new Set();
    for (const r of rows) frag.push(renderRow(r, used));
    for (const k of rowEls.keys()) if (!used.has(k)) rowEls.delete(k);
    // Keep row elements that did not change (a double-click must land on the same element twice).
    const old = tree.children;
    if (old.length !== frag.length || frag.some((el, i) => old[i] !== el)) tree.replaceChildren(...frag);
    tree.setAttribute('aria-activedescendant', focusedKey ? `wbx-${hashId(focusedKey)}` : '');
    if (edit) startPendingEdit();
  }

  const rowEls = new Map(); // node key → {sig, el}
  function renderRow(r, used) {
    if (r.newEntry) {
      if (edit.started && edit.rowEl) return edit.rowEl; // keep the live input box across re-renders
      const slot = h('div', { class: 'wb-tree-label' });
      const row = h('div', { class: 'wb-tree-row editing', style: { paddingLeft: `${pad(r.depth)}px` } },
        guides(r.depth), h('span', { class: 'wb-tree-twistie' }), fileIcon(edit.type === 'dir' ? 'folder' : 'file', { dir: edit.type === 'dir' }), slot);
      edit.slot = slot;
      edit.rowEl = row;
      return row;
    }
    if (r.note) {
      return h('div', { class: 'wb-tree-row info', style: { paddingLeft: `${pad(r.depth)}px` } }, guides(r.depth), h('span', { class: 'wb-tree-twistie' }), h('span', { class: 'wb-tree-label' }, r.note));
    }
    if (r.error || r.more) {
      const row = h('div', { class: ['wb-tree-row', 'info', r.error && 'error'], style: { paddingLeft: `${pad(r.depth)}px` }, title: r.message || '' },
        guides(r.depth), h('span', { class: 'wb-tree-twistie' }),
        r.error ? ci('error', { cls: 'wb-tree-erricon' }) : null,
        h('span', { class: 'wb-tree-label' }, r.error ? `${r.message} — click to retry` : `${r.count} more…`));
      row.addEventListener('click', () => {
        if (r.error) { r.parent.error = ''; loadChildren(r.parent, { force: true }); } else { r.parent.limit += LIST_CAP; render(); }
      });
      return row;
    }
    const n = r.node;
    const dir = isDir(n);
    const deco = decoFor(n);
    const renaming = !!(edit && edit.kind === 'rename' && edit.nodeKey === n.key);
    const sig = [n.name, n.depth, dir, n.expanded, !!(n.loading && n.expanded && !n.children), deco.cls, deco.badge, !!n.isRoot, single, n.path].join('|');
    if (renaming && edit.started && edit.rowEl) { used.add(n.key); return edit.rowEl; }
    const cached = !renaming && rowEls.get(n.key);
    used.add(n.key);
    if (cached && cached.sig === sig) {
      cached.el.classList.toggle('selected', n.key === selectedKey);
      cached.el.classList.toggle('focused', n.key === focusedKey);
      cached.el.setAttribute('aria-selected', String(n.key === selectedKey));
      return cached.el;
    }
    const label = h('span', { class: 'wb-tree-label' }, h('span', { class: 'wb-tree-name' }, n.name));
    const row = h('div', {
      class: ['wb-tree-row', dir && 'dir', n.key === selectedKey && 'selected', n.key === focusedKey && 'focused', deco.cls, n.isRoot && 'root'],
      role: 'treeitem', id: `wbx-${hashId(n.key)}`, 'aria-level': String(n.depth + 1), 'aria-expanded': dir ? String(!!n.expanded) : null,
      'aria-selected': String(n.key === selectedKey), title: n.path, 'data-key': n.key, draggable: 'false',
      style: { paddingLeft: `${pad(n.depth)}px` },
    },
    guides(n.depth),
    h('span', { class: ['wb-tree-twistie', dir && 'collapsible', n.expanded && 'expanded'] }, dir ? ci(n.loading && n.expanded && !n.children ? 'loading' : 'chevron-right', { cls: n.loading && n.expanded && !n.children ? 'wb-ci-spin' : '' }) : null),
    n.isRoot && !single ? null : fileIcon(n.name, { dir, open: dir && n.expanded }),
    label,
    deco.badge ? h('span', { class: ['wb-tree-deco', deco.cls] }, deco.badge) : null);
    if (n.isRoot && !single) label.classList.add('root-label');
    if (renaming) { edit.slot = label; edit.rowEl = row; }
    row.addEventListener('mousedown', (e) => { if (e.button === 0 || e.button === 2) { select(n.key, { focus: true }); } });
    row.addEventListener('click', (e) => {
      if (e.detail > 1) return;
      if (dir) toggle(n);
      else openNode(n, { preview: true, focus: false });
    });
    row.addEventListener('dblclick', () => { if (!dir) openNode(n, { preview: false, focus: true }); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); select(n.key, { focus: true }); rowMenu(n, e.clientX, e.clientY); });
    if (!renaming) rowEls.set(n.key, { sig, el: row });
    else rowEls.delete(n.key);
    return row;
  }
  function pad(depth) { return 8 + Math.max(0, depth) * INDENT; }
  function guides(depth) {
    const out = [];
    for (let i = 0; i < Math.max(0, depth); i++) out.push(h('span', { class: 'wb-tree-guide', style: { left: `${8 + i * INDENT + 8}px` } }));
    return out;
  }
  function hashId(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); }

  /* ---------------------------------------------------------------------- decorations */
  function decoFor(n) {
    const k = n.key;
    const p = problems.get(k);
    const g = gitDeco.get(k);
    let cls = '';
    const badge = [];
    if (p && p.e) cls = 'deco-error';
    else if (p && p.w) cls = 'deco-warning';
    else if (g) cls = g.cls;
    if (isDir(n)) {
      if (p && (p.e || p.w)) badge.push('•');
      else if (g) badge.push('•');
    } else {
      if (p && (p.e || p.w)) badge.push(String(p.e || p.w));
      if (g) badge.push(g.letter);
    }
    return { cls, badge: badge.join(', ') };
  }
  function bumpFolders(map, path, fn) {
    // propagate to every ancestor inside the workspace
    for (const r of roots) {
      if (!isUnder(path, r.path)) continue;
      let cur = path;
      for (let i = 0; i < 64; i++) {
        const parent = cur.replace(/[\\/][^\\/]+$/, '');
        if (!parent || parent === cur) break;
        cur = parent;
        if (!isUnder(cur, r.path)) break;
        fn(pathKey(cur));
      }
    }
    void map;
  }
  const loadProblems = debounce(async () => {
    if (!wb.windowId) return;
    let list;
    try { list = await wb.call('diagnostics.list', {}); } catch { return; }
    const m = new Map();
    const add = (k, sev) => {
      const v = m.get(k) || { e: 0, w: 0 };
      if (sev === 'error') v.e++;
      else if (sev === 'warning') v.w++;
      m.set(k, v);
    };
    for (const d of Array.isArray(list) ? list : []) {
      if (d.severity !== 'error' && d.severity !== 'warning') continue;
      add(pathKey(d.path), d.severity);
      bumpFolders(m, d.path, (k) => add(k, d.severity));
    }
    problems = m;
    render();
  }, 900);
  const GIT_CLS = { M: 'deco-modified', A: 'deco-added', D: 'deco-deleted', U: 'deco-untracked', R: 'deco-renamed', C: 'deco-added', '!': 'deco-conflict' };
  let gitAvailable = true;
  let gitRetries = 0;
  let gitRetryT = 0;
  const loadGit = debounce(async () => {
    if (!wb.windowId || !gitAvailable) return;
    let st;
    try { st = await wb.call('git.status', {}); } catch (err) {
      if (/unknown method/i.test(err.message)) gitAvailable = false;
      return;
    }
    // Git not running in that window yet (still starting, or git.enabled turned on later): ask again
    // now and then while the explorer is on screen — git.changed only flows once Git runs there.
    clearTimeout(gitRetryT);
    if (st && st.available === false && gitRetries < 15) {
      gitRetries++;
      gitRetryT = setTimeout(() => { if (shown) loadGit(); }, 20000);
    } else if (st && st.available) gitRetries = 0;
    const m = new Map();
    for (const repo of (st && st.repos) || []) {
      for (const c of repo.changes || []) {
        const letter = c.status;
        const cls = GIT_CLS[letter] || 'deco-modified';
        const k = pathKey(c.path);
        if (!m.has(k) || c.staged === false) m.set(k, { letter, cls });
        bumpFolders(m, c.path, (fk) => { if (!m.has(fk)) m.set(fk, { letter: '', cls: cls === 'deco-deleted' ? 'deco-modified' : cls }); });
      }
    }
    gitDeco = m;
    render();
  }, 600);

  /* ---------------------------------------------------------------------- actions */
  function select(key, { focus = false, scroll = true } = {}) {
    selectedKey = key;
    focusedKey = key;
    for (const el of tree.querySelectorAll('.wb-tree-row.selected, .wb-tree-row.focused')) el.classList.remove('selected', 'focused');
    const el = rowEl(key);
    if (el) {
      el.classList.add('selected', 'focused');
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
    if (focus && document.activeElement !== tree) tree.focus({ preventScroll: true });
  }
  const rowEl = (key) => (key ? tree.querySelector(`.wb-tree-row[data-key="${cssEsc(key)}"]`) : null);
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function toggle(n, force) {
    if (!isDir(n)) return;
    const next = force === undefined ? !n.expanded : !!force;
    if (next === n.expanded && !(next && !n.children && !n.loading)) return;
    n.expanded = next;
    if (next) expandedSet.add(n.key); else expandedSet.delete(n.key);
    saveExpanded();
    render();
    if (next && !n.children && !n.loading) loadChildren(n);
  }
  function openNode(n, { preview, focus }) {
    wb.editors.open(n.path, { preview, focus });
  }
  function collapseAll() {
    for (const n of nodes.values()) if (!n.isRoot || !single) { if (!n.isRoot) n.expanded = false; }
    expandedSet = new Set([...expandedSet].filter((k) => roots.some((r) => r.key === k)));
    saveExpanded();
    render();
  }
  async function refresh() {
    const jobs = [];
    for (const n of nodes.values()) if (isDir(n) && (n.expanded || n.isRoot) && (n.children || n.error)) jobs.push(loadChildren(n, { force: true }));
    if (!jobs.length) for (const r of roots) jobs.push(loadChildren(r, { force: true }));
    await Promise.all(jobs);
    loadProblems();
    loadGit();
  }

  /** Parent folder for new entries: the selected folder, the selected file's folder, or the root. */
  function targetFolder() {
    const n = selectedKey ? nodes.get(selectedKey) : null;
    if (n) return isDir(n) ? n : n.parent || roots[0];
    return roots[0] || null;
  }

  async function newEntry(type, parentNode) {
    const parent = parentNode || targetFolder();
    if (!parent) { notify('Open a folder in VS Code first.', { severity: 'info' }); return; }
    if (wb.activity.active !== 'explorer') wb.activity.show('explorer');
    if (foldersCollapsed) { foldersCollapsed = false; syncPanes(); }
    if (!parent.expanded || !parent.children) { toggle(parent, true); await loadChildren(parent); }
    edit = { kind: 'new', type, parentKey: parent.key, started: false };
    render();
  }
  function renameNode(n) {
    if (!n || n.isRoot) return;
    edit = { kind: 'rename', nodeKey: n.key, started: false };
    render();
  }
  function startPendingEdit() {
    const e = edit;
    if (!e || e.started || !e.slot) return;
    e.started = true;
    if (e.kind === 'new') {
      const parent = nodes.get(e.parentKey);
      inlineInput(e.slot, {
        value: '',
        validate: (v) => validateName(v, parent, null),
      }).then((name) => finishNew(parent, e.type, name));
      e.slot.closest('.wb-tree-row').scrollIntoView({ block: 'nearest' });
    } else {
      const n = nodes.get(e.nodeKey);
      const dot = n.name.lastIndexOf('.');
      inlineInput(e.slot, {
        value: n.name,
        select: [0, !isDir(n) && dot > 0 ? dot : n.name.length],
        validate: (v) => validateName(v, n.parent, n),
      }).then((name) => finishRename(n, name));
    }
  }
  function validateName(v, parent, self) {
    const name = v.trim();
    if (!name) return 'A file or folder name must be provided.';
    if (/[<>:"|?*]/.test(name.replace(/^[A-Za-z]:/, '')) || /(^|[\\/])\.\.?($|[\\/])/.test(name)) return `The name **${name}** is not valid as a file or folder name. Please choose a different name.`;
    if (/[. ]$/.test(name)) return 'Leading or trailing whitespace detected in file or folder name.';
    const first = name.split(/[\\/]/)[0];
    if (parent && parent.children && parent.children.some((c) => c !== self && c.name.toLowerCase() === first.toLowerCase() && !(self && self.name.toLowerCase() === first.toLowerCase()))) {
      if (!(name.includes('/') || name.includes('\\')) || !isDir(parent.children.find((c) => c.name.toLowerCase() === first.toLowerCase()))) {
        return `A file or folder **${first}** already exists at this location. Please choose a different name.`;
      }
    }
    return null;
  }
  /** true / false, or throws when it cannot be told (fs.stat; fs.read on an extension without fs.stat). */
  async function pathExists(full) {
    try {
      const st = await wb.call('fs.stat', { path: full });
      return !!(st && st.exists);
    } catch (err) {
      // A VS Code window still running an older TermPocket extension (not reloaded yet) has no fs.stat.
      if (!/unknown method/i.test(err && err.message)) throw err;
    }
    try {
      await wb.call('fs.read', { path: full });
      return true;
    } catch (err) {
      if (/not found|ENOENT|does not exist|FileNotFound|EntryNotFound/i.test(err && err.message)) return false;
      if (/directory|EISDIR/i.test(err && err.message)) return true;
      throw err;
    }
  }

  async function finishNew(parent, type, name) {
    edit = null;
    if (!name || !parent) { render(); return; }
    const full = join(parent.path, name.replace(/[\\/]+/g, parent.path.includes('\\') ? '\\' : '/'));
    try {
      // fs.write replaces a file: only go on when the path is known NOT to exist (a failed check must
      // never turn "New File" into "empty an existing file").
      if (await pathExists(full)) throw new Error(`A file or folder ${basename(full)} already exists at this location.`);
      if (type === 'dir') await wb.call('fs.mkdir', { path: full });
      else await wb.call('fs.write', { path: full, content: '' });
    } catch (err) {
      notify(`Unable to create ${type === 'dir' ? 'folder' : 'file'} '${basename(full)}': ${err.message}`, { severity: 'error' });
      render();
      return;
    }
    await loadChildren(parent, { force: true });
    // nested path ("a/b.txt"): expand the created folders
    const rel = relativeTo(full, [parent.path]) || '';
    let cur = parent;
    for (const seg of rel.split(/[\\/]+/).slice(0, -1)) {
      const c = cur.children && cur.children.find((x) => x.name.toLowerCase() === seg.toLowerCase());
      if (!c) break;
      toggle(c, true);
      await loadChildren(c);
      cur = c;
    }
    select(pathKey(full), { focus: type === 'dir' });
    if (type !== 'dir') wb.editors.open(full, { preview: false, focus: true });
  }
  async function finishRename(n, name) {
    edit = null;
    if (!name || name === n.name) { render(); tree.focus({ preventScroll: true }); return; }
    const to = join(n.parent ? n.parent.path : n.path.replace(/[\\/][^\\/]+$/, ''), name);
    try {
      await wb.call('fs.rename', { from: n.path, to });
    } catch (err) {
      notify(`Unable to rename '${n.name}': ${err.message}`, { severity: 'error' });
      render();
      return;
    }
    const wasExpanded = n.expanded;
    wb.editors.renamePath(n.path, to);
    if (wasExpanded) { expandedSet.delete(n.key); expandedSet.add(pathKey(to)); saveExpanded(); }
    if (n.parent) await loadChildren(n.parent, { force: true });
    select(pathKey(to), { focus: true });
  }
  async function deleteNode(n) {
    if (!n || n.isRoot) return;
    const dir = isDir(n);
    // Unsaved edits made HERE (Monaco) to the file or to files inside the folder are dropped with
    // their tabs: say so, like VS Code ("You are deleting a file with unsaved changes").
    const dirtyCount = wb.editors.dirtyUnder ? wb.editors.dirtyUnder(n.path).length : 0;
    const choice = await dialog({
      message: dirtyCount
        ? (dir ? `You are deleting a folder with unsaved changes in ${dirtyCount} file${dirtyCount === 1 ? '' : 's'}. Do you want to continue?`
          : `You are deleting '${n.name}' with unsaved changes. Do you want to continue?`)
        : `Are you sure you want to delete '${n.name}'${dir ? ' and its contents' : ''}?`,
      detail: dirtyCount ? 'Your changes will be lost if you don\'t save them. You can restore the file from the Recycle Bin.'
        : 'You can restore this file from the Recycle Bin.',
      buttons: ['Move to Recycle Bin', 'Cancel'], type: 'warning', cancelId: 1,
    });
    if (choice !== 0) { tree.focus({ preventScroll: true }); return; }
    try {
      await wb.call('fs.delete', { path: n.path, recursive: dir, useTrash: true });
    } catch (err) {
      notify(`Failed to delete '${n.name}': ${err.message}`, { severity: 'error' });
      return;
    }
    await wb.editors.closePath(n.path, { force: true });
    const rows = rowsCache.filter((r) => r.node);
    const i = rows.findIndex((r) => r.node === n);
    const next = rows[i + 1] && !isUnder(rows[i + 1].node.path, n.path) ? rows[i + 1].node : rows[i - 1] ? rows[i - 1].node : null;
    if (n.parent) await loadChildren(n.parent, { force: true });
    if (next) select(next.key, { focus: true });
  }
  async function copyPath(n, relative = false) {
    const roots2 = (wb.workspace.folders || []).map((f) => f.path);
    const text = relative ? (relativeTo(n.path, roots2) ?? n.path) : n.path;
    if (!(await copyText(text))) notify('Could not copy to the clipboard.', { severity: 'warning' });
  }
  async function revealOnPc(n) {
    try {
      await wb.app.conn.request('sys.open', { target: isDir(n) ? n.path : n.path.replace(/[\\/][^\\/]+$/, '') });
      notify(`Opened ${isDir(n) ? n.name : 'the containing folder'} in File Explorer on the PC.`, { severity: 'info', timeout: 2500 });
    } catch (err) { notify(`Could not open File Explorer on the PC: ${err.message}`, { severity: 'error' }); }
  }
  async function openOnPc(n) {
    try {
      await wb.call('editor.open', { path: n.path, preview: false });
      notify(`Opened ${n.name} in VS Code on the PC.`, { severity: 'info', timeout: 2500 });
    } catch (err) { notify(`Could not open ${n.name} on the PC: ${err.message}`, { severity: 'error' }); }
  }

  function rowMenu(n, x, y) {
    const dir = isDir(n);
    const term = wb.commands.has('workbench.action.terminal.newInFolder') ? 'workbench.action.terminal.newInFolder' : null;
    contextMenu({ x, y }, [
      { label: 'New File...', onSelect: () => newEntry('file', dir ? n : n.parent) },
      { label: 'New Folder...', onSelect: () => newEntry('dir', dir ? n : n.parent) },
      !dir && { label: 'Open to the Side', disabled: true, onSelect: () => {} },
      !dir && 'sep',
      !dir && { label: 'Open in VS Code on the PC', onSelect: () => openOnPc(n) },
      { label: 'Reveal in File Explorer', kb: 'shift+alt+r', onSelect: () => revealOnPc(n) },
      dir && term ? { label: 'Open in Integrated Terminal', onSelect: () => wb.commands.run(term, n.path) } : null,
      'sep',
      !dir && { label: 'Open Changes', disabled: !gitDeco.has(n.key), onSelect: () => wb.editors.open(n.path, { diffWith: 'HEAD', preview: false }) },
      !dir && 'sep',
      { label: 'Copy Path', kb: 'shift+alt+c', onSelect: () => copyPath(n) },
      { label: 'Copy Relative Path', kb: 'ctrl+k ctrl+shift+c', onSelect: () => copyPath(n, true) },
      'sep',
      !n.isRoot && { label: 'Rename...', kb: 'f2', onSelect: () => renameNode(n) },
      !n.isRoot && { label: 'Delete', kb: 'delete', onSelect: () => deleteNode(n) },
      n.isRoot && { label: 'Refresh', onSelect: () => refresh() },
    ].filter((x) => x !== false));
  }

  tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.wb-tree-row')) return;
    e.preventDefault();
    const r = roots[0];
    if (!r) return;
    contextMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'New File...', onSelect: () => newEntry('file', r) },
      { label: 'New Folder...', onSelect: () => newEntry('dir', r) },
      'sep',
      { label: 'Reveal in File Explorer', onSelect: () => revealOnPc(r) },
      { label: 'Copy Path', onSelect: () => copyPath(r) },
      'sep',
      { label: 'Refresh', onSelect: () => refresh() },
    ]);
  });
  tree.addEventListener('mousedown', (e) => { if (!e.target.closest('.wb-tree-row')) tree.focus({ preventScroll: true }); });
  tree.addEventListener('focus', () => { if (!focusedKey) { const first = rowsCache.find((r) => r.node); if (first) select(first.node.key, { scroll: false }); } });

  /* ---------------------------------------------------------------------- keyboard */
  let typeBuf = '';
  let typeT = 0;
  tree.addEventListener('keydown', (e) => {
    if (e.target !== tree) return;
    const list = rowsCache.filter((r) => r.node).map((r) => r.node);
    if (!list.length) return;
    let i = list.findIndex((n) => n.key === focusedKey);
    const cur = i >= 0 ? list[i] : null;
    const go = (j) => { const n = list[Math.max(0, Math.min(list.length - 1, j))]; if (n) select(n.key); };
    const pageRows = Math.max(1, Math.floor(tree.clientHeight / ROW_H) - 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i < 0 ? 0 : i - 1); break;
      case 'PageDown': go(i + pageRows); break;
      case 'PageUp': go(i - pageRows); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'ArrowRight':
        if (cur && isDir(cur)) {
          if (!cur.expanded) toggle(cur, true);
          else if (cur.children && cur.children.length) select(cur.children[0].key);
        }
        break;
      case 'ArrowLeft':
        if (cur && isDir(cur) && cur.expanded && !(single && cur.isRoot)) toggle(cur, false);
        else if (cur && cur.parent && !(single && cur.parent.isRoot)) select(cur.parent.key);
        break;
      case 'Enter':
        if (cur) { if (isDir(cur)) toggle(cur); else openNode(cur, { preview: false, focus: true }); }
        break;
      case ' ':
        if (cur) { if (isDir(cur)) toggle(cur); else openNode(cur, { preview: true, focus: false }); }
        break;
      case 'F2': if (cur) renameNode(cur); break;
      case 'Delete': if (cur) deleteNode(cur); break;
      case 'Escape': selectedKey = null; render(); break;
      default:
        handled = false;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && cur) { copyPath(cur); handled = true; }
        else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          // type to navigate: next row whose name starts with the typed text
          clearTimeout(typeT);
          typeBuf += e.key.toLowerCase();
          typeT = setTimeout(() => { typeBuf = ''; }, 800);
          const start = typeBuf.length === 1 ? i + 1 : Math.max(0, i);
          for (let k = 0; k < list.length; k++) {
            const n = list[(start + k) % list.length];
            if (n.name.toLowerCase().startsWith(typeBuf)) { select(n.key); break; }
          }
          handled = true;
        }
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  /* ---------------------------------------------------------------------- reveal */
  let revealSeq = 0;
  /** Expand the folders down to `path` (listing them as needed), select and scroll to it. */
  async function reveal(path, { focus = false } = {}) {
    if (!path) return;
    const root = roots.find((r) => isUnder(path, r.path));
    if (!root) return;
    const my = ++revealSeq;
    if (!root.expanded) toggle(root, true);
    if (!root.children) await loadChildren(root);
    let cur = root;
    const rel = relativeTo(path, [root.path]);
    if (rel == null) return;
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (my !== revealSeq) return;
      if (!cur.children) await loadChildren(cur);
      const c = cur.children && cur.children.find((x) => x.name.toLowerCase() === segs[i].toLowerCase());
      if (!c) return;
      if (i < segs.length - 1) {
        if (!c.expanded) { c.expanded = true; expandedSet.add(c.key); saveExpanded(); }
        if (!c.children) await loadChildren(c);
      }
      cur = c;
    }
    if (my !== revealSeq) return;
    render();
    select(cur.key, { focus });
  }

  /* ---------------------------------------------------------------------- open editors */
  function renderOpenEditors() {
    if (!mounted) return;
    const tabs = wb.editors.tabs();
    const roots2 = (wb.workspace.folders || []).map((f) => f.path);
    setChildren(openBody, tabs.map((t) => {
      const rel = relativeTo(t.path, roots2);
      const dirRel = rel != null ? rel.split(/[\\/]+/).slice(0, -1).join(t.path.includes('\\') ? '\\' : '/') : t.path.replace(/[\\/][^\\/]+$/, '');
      const close = h('button', { type: 'button', class: 'wb-oe-close', title: 'Close Editor (Ctrl+W)', 'aria-label': 'Close Editor', tabindex: '-1' },
        ci('close', { cls: 'x' }), ci('circle-filled', { cls: 'dot' }));
      close.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      close.addEventListener('click', (e) => { e.stopPropagation(); wb.editors.closeKey(t.key); });
      const row = h('div', { class: ['wb-oe-row', t.active && 'active', t.dirty && 'dirty', t.preview && 'preview'], role: 'listitem', title: t.tooltip },
        close, t.icon, h('span', { class: 'wb-oe-name' }, t.label), dirRel ? h('span', { class: 'wb-oe-desc' }, dirRel) : null);
      row.addEventListener('mousedown', (e) => { if (e.button === 0) wb.editors.activate(t.key); });
      row.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); wb.editors.closeKey(t.key); } });
      return row;
    }));
    openBody.style.height = `${Math.min(9, Math.max(tabs.length, 0)) * ROW_H}px`;
    openPane.classList.toggle('is-empty', !tabs.length);
  }

  /* ---------------------------------------------------------------------- wiring */
  wb.onWindowChange(() => { problems = new Map(); gitDeco = new Map(); gitAvailable = true; gitRetries = 0; clearTimeout(gitRetryT); });
  wb.onWorkspaceChange(() => { resetRoots(); loadProblems(); loadGit(); });
  wb.onVsc('diagnostics.changed', () => loadProblems());
  wb.onVsc('git.changed', () => loadGit());
  wb.app.conn.on('ready', () => { if (mounted && shown) refresh(); });
  let lastActivePath = null;
  wb.editors.onActiveChange((a) => {
    const p = a ? a.path : null;
    if (pathKey(p) === pathKey(lastActivePath)) return;
    lastActivePath = p;
    if (p && store.get('wb.autoReveal', true) !== false) reveal(p);
  });
  // Deferred: the section changes height when editors open/close, and that must not move the tree
  // under the mouse between the two clicks of a double-click (OPEN EDITORS sits above it).
  const renderOpenEditorsSoon = debounce(() => renderOpenEditors(), 450);
  wb.editors.onTabsChange(() => renderOpenEditorsSoon());

  wb.commands.register('explorer.newFile', 'New File...', () => newEntry('file'), { category: 'File' });
  wb.commands.register('explorer.newFolder', 'New Folder...', () => newEntry('dir'), { category: 'File' });
  wb.commands.register('workbench.files.action.refreshFilesExplorer', 'Refresh Explorer', () => refresh(), { category: 'File' });
  wb.commands.register('workbench.files.action.collapseExplorerFolders', 'Collapse Folders in Explorer', () => collapseAll(), { category: 'File' });

  return {
    /** activity.register mount: build the view into the side bar container. */
    mount(container, ctx) {
      container.append(viewEl);
      if (ctx && ctx.actions) ctx.actions.append(actionBtn('ellipsis', 'Views and More Actions...', (e) => contextMenu({ anchor: e.currentTarget }, [
        { label: 'Open Editors', checked: !openSectionCollapsed, onSelect: () => setOpenCollapsed(!openSectionCollapsed) },
        { label: 'Auto Reveal Active File', checked: store.get('wb.autoReveal', true) !== false, onSelect: () => store.set('wb.autoReveal', store.get('wb.autoReveal', true) === false) },
      ])));
      mounted = true;
      resetRoots();
      renderOpenEditors();
      loadProblems();
      loadGit();
      return {
        show({ focus } = {}) {
          shown = true;
          // pick up files created on the PC meanwhile (cheap: only expanded folders are re-listed)
          if (roots.some((r) => r.children)) refreshSoon();
          if (focus) tree.focus({ preventScroll: true });
        },
        hide() { shown = false; },
        dispose() { mounted = false; viewEl.remove(); },
      };
    },
    reveal,
    refresh,
    collapseAll,
    newFile: () => newEntry('file'),
    newFolder: () => newEntry('dir'),
    focus: () => tree.focus({ preventScroll: true }),
    get selected() { const n = selectedKey && nodes.get(selectedKey); return n ? { path: n.path, type: n.type } : null; },
  };

}
