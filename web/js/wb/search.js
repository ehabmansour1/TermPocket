// SEARCH side-bar view (builder C): file-name search of the current window (fs.search = VS Code's
// workspace.findFiles, node_modules/.git excluded). Results as a tree grouped by folder (or a flat
// list), match highlighting, "N results in M folders", keyboard navigation; click / Enter opens a
// preview editor, double-click pins it. Ctrl+Shift+F focuses the box.

import { h, copyText } from '../ui.js';
import {
  ensureCss, useShell, cicon, fileIcon, countBadge, createTree, contextMenu, registerCommand, actionBtn,
  activityIcon, windowFolders, relativeTo, splitDirBase, errText, local, notify, reportError, once,
} from './c-common.js';

const MAX_RESULTS = 500;
const DEBOUNCE_MS = 300;
const CALL_TIMEOUT_MS = 25000;

function callT(wb, m, p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`VS Code did not answer ${m} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve().then(() => wb.call(m, p)).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Query → the part fs.search puts into '**' + '/*' + query + '*' (case-insensitive unless matchCase). */
function toGlob(q, matchCase) {
  const clean = q.replace(/[[\]{}!,]/g, '');
  if (matchCase) return clean;
  return [...clean].map((ch) => {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    return lo !== up ? `[${lo}${up}]` : ch;
  }).join('');
}

/** Positions of `q` in `s` (substring, or a simple * / ? glob) for highlighting. */
function matchPositions(q, s, matchCase) {
  if (!q) return [];
  if (!/[*?]/.test(q)) {
    const i = matchCase ? s.indexOf(q) : s.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? [] : Array.from({ length: q.length }, (_, k) => i + k);
  }
  const parts = q.split('');
  const src = parts.map((c) => (c === '*' ? '(.*?)' : c === '?' ? '(.)' : `(${c.replace(/[.+^${}()|[\]\\]/g, '\\$&')})`)).join('');
  const m = new RegExp(src, matchCase ? '' : 'i').exec(s);
  if (!m) return [];
  const out = [];
  let pos = m.index;
  for (let k = 0; k < parts.length; k++) {
    const g = m[k + 1] || '';
    if (parts[k] !== '*') for (let j = 0; j < g.length; j++) out.push(pos + j);
    pos += g.length;
  }
  return out;
}

function mountSearch(wb, container, ctx) {
  ensureCss();
  let query = '';
  let matchCase = !!local.get('searchMatchCase', false);
  let asTree = local.get('searchTree', true) !== false;
  let results = [];
  let error = null;
  let searching = false;
  let seq = 0;
  let timer = 0;
  let lastWin = wb.windowId;

  const input = h('input', {
    class: 'wbc-input', type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'Search files by name',
    'aria-label': 'Search files by name', title: 'Search files by name (* and ? are wildcards)',
  });
  const caseBtn = actionBtn('case-sensitive', 'Match Case (Alt+C)', () => setMatchCase(!matchCase));
  const box = h('div', { class: 'wbc-search-box' }, input, h('div', { class: 'wbc-search-opts' }, caseBtn));
  const msg = h('div', { class: 'wbc-search-msg', hidden: true });
  const scroller = h('div', { class: 'wbc-scroll' });
  const viewBtn = actionBtn(asTree ? 'list-flat' : 'list-tree', asTree ? 'View as List' : 'View as Tree', () => setTreeMode(!asTree));
  const titleActions = h('div', { class: 'wbc-title-actions' },
    actionBtn('refresh', 'Refresh', () => run(true)),
    actionBtn('clear-all', 'Clear Search Results', () => { input.value = ''; query = ''; results = []; error = null; rebuild(); input.focus(); }),
    viewBtn,
    actionBtn('collapse-all', 'Collapse All', () => tree.expandAll(false)));
  const inTitle = !!(ctx && ctx.actions instanceof Element);
  if (inTitle) ctx.actions.append(titleActions);
  const root = h('div', { class: 'wbc-view wbc-side wbc-search', 'aria-label': 'Search' },
    inTitle ? null : h('div', { class: 'wbc-side-toolbar' }, titleActions), box, msg, scroller);
  container.append(root);
  syncCaseBtn();

  function syncCaseBtn() {
    caseBtn.classList.toggle('on', matchCase);
    caseBtn.setAttribute('aria-pressed', String(matchCase));
  }
  function setMatchCase(v) {
    matchCase = !!v;
    local.set('searchMatchCase', matchCase);
    syncCaseBtn();
    run(true);
  }
  function setTreeMode(v) {
    asTree = !!v;
    local.set('searchTree', asTree);
    viewBtn.replaceChildren(cicon(asTree ? 'list-flat' : 'list-tree'));
    viewBtn.title = asTree ? 'View as List' : 'View as Tree';
    viewBtn.setAttribute('aria-label', viewBtn.title);
    rebuild();
  }

  let nodes = [];
  const tree = createTree({
    label: 'Search results',
    roots: () => nodes,
    rowClass: (n) => (n.kind === 'dir' ? 'search-dir' : 'search-file'),
    renderRow: (n, row) => {
      if (n.kind === 'dir') {
        row.title = n.path;
        row.append(
          fileIcon(wb, n.name, { dir: true, open: tree.isExpanded(n) }),
          h('span', { class: 'wbc-label' }, n.name),
          n.desc ? h('span', { class: 'wbc-desc' }, n.desc) : null,
          h('span', { class: 'wbc-row-end' }, countBadge(n.children.length)));
        return;
      }
      row.title = n.path;
      row.append(
        fileIcon(wb, n.base),
        h('span', { class: 'wbc-label wbc-match' }, highlightRun(n.base, matchPositions(query, n.base, matchCase))),
        !asTree && n.dir ? h('span', { class: 'wbc-desc' }, n.dir) : null,
        h('span', { class: 'wbc-row-end wbc-hover-actions' },
          actionBtn('link-external', 'Open in VS Code on the PC', () => openOnPc(n.path))));
    },
    onOpen: (n, { pinned }) => { if (n.kind === 'file') open(n.path, pinned); },
    onContext: (n, e) => {
      if (n.kind !== 'file') return;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open', onSelect: () => open(n.path, true) },
        { label: 'Open in VS Code on the PC', onSelect: () => openOnPc(n.path) },
        'sep',
        { label: 'Copy Path', kbd: 'Shift+Alt+C', onSelect: () => copy(n.path) },
        { label: 'Copy Relative Path', onSelect: () => copy(n.rel) },
      ]);
    },
  });
  scroller.append(tree.el);

  function highlightRun(text, positions) {
    if (!positions.length) return [text];
    const a = positions[0];
    const b = positions[positions.length - 1] + 1;
    return [text.slice(0, a), h('span', { class: 'hl' }, text.slice(a, b)), text.slice(b)];
  }

  async function copy(text) { if (!(await copyText(text))) notify('Copy failed', 'error'); }

  function open(path, pinned) {
    try {
      const r = wb.editors.open(path, { preview: !pinned });
      if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, 'Could not open the file'));
    } catch (err) { reportError(err, 'Could not open the file'); }
  }

  async function openOnPc(path) {
    try { await callT(wb, 'editor.open', { path, preview: false }); } catch (err) { reportError(err, 'Could not open it in VS Code'); }
  }

  function rebuild() {
    const roots = windowFolders(wb);
    const items = results.map((p) => {
      const rel = relativeTo(p, roots);
      const { dir, base } = splitDirBase(rel);
      return { id: `f:${p}`, kind: 'file', path: p, rel, dir, base };
    });
    items.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base', numeric: true }));
    if (asTree) {
      const byDir = new Map();
      for (const it of items) {
        if (!byDir.has(it.dir)) {
          const { dir: parent, base } = splitDirBase(it.dir);
          byDir.set(it.dir, {
            id: `d:${it.dir}`, kind: 'dir', path: splitDirBase(it.path).dir,
            name: it.dir ? base : (roots[0] ? splitDirBase(roots[0]).base : '(root)'), desc: it.dir ? parent : '', children: [],
          });
        }
        byDir.get(it.dir).children.push(it);
      }
      nodes = [...byDir.values()];
    } else {
      nodes = items;
    }
    tree.render();
    renderMsg(items.length, asTree ? nodes.length : new Set(items.map((i) => i.dir)).size);
  }

  function renderMsg(n, folders) {
    let text = '';
    let err = false;
    if (!wb.windowId) text = 'No VS Code window is selected.';
    else if (error) { text = `Search failed: ${error} `; err = true; }
    else if (!query) text = '';
    else if (searching && !n) text = 'Searching…';
    else if (!n) text = 'No files found. node_modules and .git folders are not searched.';
    else text = `${n >= MAX_RESULTS ? `${n}+` : n} result${n === 1 ? '' : 's'} in ${folders} folder${folders === 1 ? '' : 's'}${n >= MAX_RESULTS ? ' (the first 500: be more specific)' : ''}`;
    msg.hidden = !text;
    msg.replaceChildren(text, err ? h('button', { type: 'button', class: 'wbc-link', onClick: () => run(true) }, 'Retry') : '');
    msg.classList.toggle('err', err);
  }

  async function run(force = false) {
    const q = input.value.trim();
    if (!force && q === query && wb.windowId === lastWin && !error) return;
    query = q;
    lastWin = wb.windowId;
    const my = ++seq;
    error = null;
    if (!q || !wb.windowId) { results = []; searching = false; rebuild(); return; }
    searching = true;
    rebuild();
    try {
      const r = await callT(wb, 'fs.search', { query: toGlob(q, matchCase), max: MAX_RESULTS });
      if (my !== seq) return;
      results = Array.isArray(r) ? r.map(String) : [];
      if (matchCase && !/[*?]/.test(q)) results = results.filter((p) => splitDirBase(p).base.includes(q));
    } catch (err) {
      if (my !== seq) return;
      results = [];
      error = errText(err);
    }
    searching = false;
    rebuild();
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(), DEBOUNCE_MS); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); tree.focus(); }
    else if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; run(); }
    else if (e.altKey && !e.ctrlKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); setMatchCase(!matchCase); }
  });

  let offWin = null;
  try { offWin = wb.onWindowChange(() => { results = []; error = null; if (query) run(true); else rebuild(); }); } catch { /* ignore */ }

  rebuild();
  const focus = () => { input.focus(); input.select(); };
  return {
    show(o) {
      if (wb.windowId !== lastWin && query) run(true);
      if (o && o.focus) requestAnimationFrame(focus);
    },
    hide() {},
    focus,
    dispose() { clearTimeout(timer); if (typeof offWin === 'function') offWin(); titleActions.remove(); root.remove(); },
  };
}

export function register(wb) {
  return once(wb, 'search', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  let view = null;
  wb.activity.register({
    id: 'search',
    title: 'Search',
    icon: activityIcon('search'),
    order: 20,
    kb: 'ctrl+shift+f',
    mount(container, ctx) {
      view = mountSearch(wb, container, ctx);
      return view;
    },
  });
  // The shell registers "Show Search" (Ctrl+Shift+F); this fills the gap without it.
  registerCommand(wb, 'workbench.view.search', 'Show Search', () => {
    wb.activity.show('search', { focus: true });
  }, { keybinding: 'ctrl+shift+f', category: 'View', terminal: true });
  void view;
  return {};
}
