// PROBLEMS panel view (builder C): VS Code's real diagnostics of the current window
// (diagnostics.list), grouped by file like VS Code's Problems tree — file rows with icon, name,
// folder and a count badge; marker rows with severity icon, message, source(code) and [Ln, Col].
// Click / Enter opens the file at the position (wb.editors.open). Filter box (text, !exclude),
// collapse all, keyboard navigation. Refreshes on diagnostics.changed and window switches.

import { h, copyText } from '../ui.js';
import {
  ensureCss, useShell, cicon, fileIcon, countBadge, createTree, contextMenu, onVsc, registerCommand,
  windowFolders, relativeTo, splitDirBase, errText, actionBtn, notify, reportError,
  once, appOn,
} from './c-common.js';

const SEV_ORDER = { error: 0, warning: 1, info: 2, hint: 3 };
const SEV_ICON = { error: 'error', warning: 'warning', info: 'info', hint: 'info' };
const REFRESH_DEBOUNCE_MS = 350;
const CALL_TIMEOUT_MS = 15000;

function callT(wb, m, p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`VS Code did not answer ${m} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve().then(() => wb.call(m, p)).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Shared problems model of the workbench (one per wb): the status bar and the panel badge use it too.
 * → { get list(), counts(), refresh(), on(fn) → off }
 */
export function problemsModel(wb) {
  if (wb.__wbcProblems) return wb.__wbcProblems;
  const subs = new Set();
  let list = [];
  let loaded = false;
  let loading = false;
  let error = null;
  let seq = 0;
  let timer = 0;
  let pushed = null; // counts from the last diagnostics.changed (cheap, may be newer than `list`)

  const emit = () => { for (const fn of [...subs]) { try { fn(model); } catch (err) { console.error(err); } } };

  async function refresh() {
    const my = ++seq;
    const wid = wb.windowId;
    if (!wid) { list = []; loaded = true; error = null; loading = false; emit(); return; }
    loading = true;
    emit();
    try {
      const r = await callT(wb, 'diagnostics.list', {});
      if (my !== seq) return;
      list = Array.isArray(r) ? r.filter((d) => d && d.path) : [];
      error = null;
      pushed = null;
    } catch (err) {
      if (my !== seq) return;
      error = errText(err);
    }
    loaded = true;
    loading = false;
    emit();
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS); };

  onVsc(wb, 'diagnostics.changed', (p) => {
    if (p && Number.isFinite(p.errors)) { pushed = { errors: p.errors, warnings: p.warnings | 0 }; emit(); }
    soon();
  });
  try { wb.onWindowChange(() => { list = []; loaded = false; error = null; pushed = null; emit(); refresh(); }); } catch { /* shell without it */ }
  try { if (wb.app && wb.app.conn) appOn(wb, wb.app.conn, 'ready', () => soon()); } catch { /* ignore */ }

  const model = {
    get list() { return list; },
    get loaded() { return loaded; },
    get loading() { return loading; },
    get error() { return error; },
    counts() {
      if (pushed) {
        const infos = list.filter((d) => d.severity === 'info' || d.severity === 'hint').length;
        return { errors: pushed.errors, warnings: pushed.warnings, infos, total: pushed.errors + pushed.warnings + infos };
      }
      let errors = 0; let warnings = 0; let infos = 0;
      for (const d of list) {
        if (d.severity === 'error') errors++;
        else if (d.severity === 'warning') warnings++;
        else infos++;
      }
      return { errors, warnings, infos, total: errors + warnings + infos };
    },
    refresh,
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  wb.__wbcProblems = model;
  refresh();
  return model;
}

/* ------------------------------------------------------------------ view */

function mountProblems(wb, container, model, ctx) {
  ensureCss();
  let filter = '';
  let visible = false;
  const collapsed = new Set(); // file paths collapsed by the user

  const filterInput = h('input', {
    class: 'wbc-input', type: 'text', spellcheck: false, autocomplete: 'off',
    placeholder: 'Filter (e.g. text, **/*.ts, !**/node_modules/**)', 'aria-label': 'Filter problems',
  });
  const summary = h('span', { class: 'wbc-summary' });
  // VS Code puts the filter box and the view actions into the panel's title bar.
  const titleActions = h('div', { class: 'wbc-panel-actions' },
    summary,
    h('div', { class: 'wbc-filter' }, filterInput, cicon('filter', { size: 16 })),
    actionBtn('collapseAll', 'Collapse All', () => { tree.expandAll(false); }),
    actionBtn('refresh', 'Refresh', () => model.refresh()));
  const inTitle = !!(ctx && ctx.actions instanceof Element);
  if (inTitle) ctx.actions.append(titleActions);
  const scroller = h('div', { class: 'wbc-scroll' });
  const msg = h('div', { class: 'wbc-message', hidden: true });
  const root = h('div', { class: 'wbc-view wbc-problems', 'aria-label': 'Problems' },
    inTitle ? null : h('div', { class: 'wbc-problems-bar' }, titleActions), msg, scroller);
  container.append(root);

  let groups = [];
  const tree = createTree({
    label: 'Problems',
    roots: () => groups,
    rowClass: (n) => (n.kind === 'file' ? 'wbc-prob-file' : 'wbc-prob-marker'),
    renderRow: (n, row) => {
      if (n.kind === 'file') {
        row.title = n.path;
        row.append(
          fileIcon(wb, n.base),
          h('span', { class: 'wbc-label' }, n.base),
          n.dir ? h('span', { class: 'wbc-desc' }, n.dir) : null,
          countBadge(n.children.length));
      } else {
        const d = n.d;
        const sev = SEV_ICON[d.severity] ? d.severity : 'info';
        const src = d.source ? `${d.source}${d.code != null && d.code !== '' ? `(${d.code})` : ''}` : (d.code != null && d.code !== '' ? String(d.code) : '');
        row.title = `${d.message}${src ? `\n${src}` : ''}`;
        row.append(
          h('span', { class: ['wbc-sev', sev] }, cicon(SEV_ICON[sev], { size: 16 })),
          h('span', { class: 'wbc-label' }, firstLine(d.message)),
          src ? h('span', { class: 'wbc-desc' }, src) : null,
          h('span', { class: 'wbc-pos' }, `[Ln ${d.line || 1}, Col ${d.column || 1}]`));
      }
    },
    onOpen: (n, { pinned }) => {
      if (n.kind !== 'problem') return;
      openProblem(n.d, pinned);
    },
    onToggle: (n, open) => { if (open) collapsed.delete(n.path); else collapsed.add(n.path); },
    onContext: (n, e) => {
      const items = n.kind === 'problem'
        ? [
          { label: 'Open', onSelect: () => openProblem(n.d, true) },
          'sep',
          { label: 'Copy', onSelect: () => copy(formatProblem(n.d)) },
          { label: 'Copy Message', onSelect: () => copy(n.d.message) },
          { label: 'Copy Path', onSelect: () => copy(n.d.path) },
        ]
        : [
          { label: 'Open File', onSelect: () => wb.editors.open(n.path, { preview: true }) },
          'sep',
          { label: 'Copy', onSelect: () => copy(n.children.map((c) => formatProblem(c.d)).join('\n')) },
          { label: 'Copy Path', onSelect: () => copy(n.path) },
          'sep',
          { label: tree.isExpanded(n) ? 'Collapse' : 'Expand', onSelect: () => tree.toggle(n) },
          { label: 'Collapse All', onSelect: () => tree.expandAll(false) },
        ];
      contextMenu(e.clientX, e.clientY, items);
    },
  });
  scroller.append(tree.el);

  async function copy(text) {
    if (await copyText(text)) return;
    notify('Copy failed', 'error');
  }

  function openProblem(d, pinned) {
    try {
      const r = wb.editors.open(d.path, { line: d.line || 1, column: d.column || 1, preview: !pinned });
      if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, 'Could not open the file'));
    } catch (err) { reportError(err, 'Could not open the file'); }
  }

  function matcher() {
    const terms = filter.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!terms.length) return null;
    const inc = [];
    const exc = [];
    for (const t of terms) {
      if (t.startsWith('!')) { if (t.length > 1) exc.push(globOrText(t.slice(1))); } else inc.push(globOrText(t));
    }
    return (d, rel) => {
      const hay = `${d.message}\n${d.source || ''}\n${d.code ?? ''}`.toLowerCase();
      const path = rel.replace(/\\/g, '/');
      if (exc.some((m) => m(hay, path))) return false;
      return !inc.length || inc.some((m) => m(hay, path));
    };
  }

  function rebuild() {
    const roots = windowFolders(wb);
    const match = matcher();
    const byFile = new Map();
    for (const d of model.list) {
      const rel = relativeTo(d.path, roots);
      if (match && !match(d, rel)) continue;
      let g = byFile.get(d.path);
      if (!g) {
        const { dir, base } = splitDirBase(rel);
        g = { id: `f:${d.path}`, kind: 'file', path: d.path, base, dir, children: [], expanded: !collapsed.has(d.path) };
        byFile.set(d.path, g);
      }
      g.children.push({ id: `p:${d.path}:${d.line}:${d.column}:${g.children.length}`, kind: 'problem', d });
    }
    groups = [...byFile.values()];
    for (const g of groups) g.children.sort((a, b) => (SEV_ORDER[a.d.severity] ?? 9) - (SEV_ORDER[b.d.severity] ?? 9) || (a.d.line - b.d.line) || (a.d.column - b.d.column));
    // VS Code: files with errors first, then by path.
    const worst = (g) => Math.min(...g.children.map((c) => SEV_ORDER[c.d.severity] ?? 9));
    groups.sort((a, b) => worst(a) - worst(b) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
    tree.render();

    const c = model.counts();
    const shown = groups.reduce((n, g) => n + g.children.length, 0);
    summary.textContent = match ? `Showing ${shown} of ${model.list.length}` : '';
    if (!wb.windowId) showMsg('No VS Code window is selected.');
    else if (model.error && !model.list.length) showMsg(`Could not load problems: ${model.error} `, () => model.refresh());
    else if (!model.loaded) showMsg('Loading problems…');
    else if (!model.list.length) showMsg('No problems have been detected in the workspace.');
    else if (!shown) showMsg('No results found with provided filter criteria.');
    else showMsg('');
    void c;
  }

  function showMsg(text, retry) {
    msg.hidden = !text;
    msg.replaceChildren(text, retry ? h('button', { type: 'button', class: 'wbc-link', onClick: () => retry() }, 'Retry') : '');
  }

  let filterTimer = 0;
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filter = filterInput.value; rebuild(); }, 120);
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); tree.focus(); }
    if (e.key === 'Escape' && filterInput.value) { e.preventDefault(); e.stopPropagation(); filterInput.value = ''; filter = ''; rebuild(); }
  });

  const off = model.on(() => { if (visible) rebuild(); });
  rebuild();

  return {
    show(o) { visible = true; rebuild(); if (o && o.focus) requestAnimationFrame(() => tree.focus()); },
    hide() { visible = false; },
    focus() { tree.focus(); },
    focusFilter() { filterInput.focus(); filterInput.select(); },
    dispose() { off(); clearTimeout(filterTimer); titleActions.remove(); root.remove(); },
  };
}

function firstLine(s) {
  const t = String(s ?? '');
  const i = t.indexOf('\n');
  return i < 0 ? t : `${t.slice(0, i)} …`;
}

function formatProblem(d) {
  const src = d.source ? ` ${d.source}${d.code != null && d.code !== '' ? `(${d.code})` : ''}` : '';
  return `${d.path}:${d.line || 1}:${d.column || 1} - ${d.severity}${src}: ${d.message}`;
}

/** Filter term → (haystack, relPath) => bool. Globs (with * or /) match the path, else text. */
function globOrText(term) {
  if (/[*?]/.test(term) || term.includes('/')) {
    // Translate the glob piece by piece: ** (any folders), * (within a segment), ? (one char).
    let src = '';
    const g = term.replace(/\\/g, '/');
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*' && g[i + 1] === '*') { src += '.*'; i++; if (g[i + 1] === '/') i++; }
      else if (ch === '*') src += '[^/]*';
      else if (ch === '?') src += '[^/]';
      else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const re = new RegExp(`(^|/)${src}$`, 'i');
    return (hay, path) => re.test(path);
  }
  const t = term.toLowerCase();
  return (hay, path) => hay.includes(t) || path.toLowerCase().includes(t);
}

/* ------------------------------------------------------------------ register */

export function register(wb) {
  return once(wb, 'problems', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  const model = problemsModel(wb);
  let view = null;
  let badge = '';
  model.on(() => {
    const n = model.counts().total;
    const next = n ? String(n) : '';
    if (next === badge) return;
    badge = next;
    try { if (wb.panel && typeof wb.panel.updateBadges === 'function') wb.panel.updateBadges(); } catch { /* optional */ }
  });
  wb.panel.register({
    id: 'problems',
    title: 'Problems',
    order: 10,
    kb: 'ctrl+shift+m',
    badge: () => { const n = model.counts().total; return n ? String(n) : ''; },
    mount(container, ctx) {
      view = mountProblems(wb, container, model, ctx);
      return view;
    },
  });
  // The shell registers "Focus Problems" (Ctrl+Shift+M) itself; this fills the gap without it.
  registerCommand(wb, 'workbench.actions.view.problems', 'Focus Problems (Errors, Warnings, Infos)', () => {
    wb.panel.show('problems');
    requestAnimationFrame(() => { if (view) view.focus(); });
  }, { keybinding: 'ctrl+shift+m', category: 'View', terminal: true });
  registerCommand(wb, 'workbench.actions.problems.refresh', 'Refresh Problems', () => model.refresh(), { category: 'Problems' });
  registerCommand(wb, 'problems.action.focusFilter', 'Focus Problems Filter', () => {
    wb.panel.show('problems');
    requestAnimationFrame(() => { if (view) view.focusFilter(); });
  }, { category: 'Problems' });
  return { model };
}
