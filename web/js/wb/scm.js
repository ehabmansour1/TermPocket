// SOURCE CONTROL side-bar view (builder C), on the extension's git.* methods (VS Code's own Git
// extension API): commit message box + Commit button (Ctrl+Enter), "Merge Changes", "Staged Changes"
// and "Changes" groups with VS Code's status letters and colours, per-file hover actions (Open File,
// Discard Changes, Stage / Unstage), group actions (Stage All, Unstage All, Discard All), click →
// diff editor against HEAD (wb.editors.open(path, {diffWith:'HEAD'})). Refreshes on git.changed.

import { h, copyText } from '../ui.js';
import {
  ensureCss, useShell, cicon, fileIcon, countBadge, createTree, contextMenu, onVsc, registerCommand, actionBtn,
  activityIcon, relativeTo, splitDirBase, errText, local, notify, reportError, confirm, once, appOn,
} from './c-common.js';

const CALL_TIMEOUT_MS = 20000;
const REFRESH_DEBOUNCE_MS = 250;
const STATUS_TITLE = {
  M: 'Modified', A: 'Index Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', '!': 'Conflict',
};

function callT(wb, m, p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`VS Code did not answer ${m} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve().then(() => wb.call(m, p)).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Shared git model of the workbench (the status bar's branch / sync items use it too).
 * → { status, repos, error, loading, refresh(), refreshSoon(), on(fn) → off, repoFor(path) }
 */
export function gitModel(wb) {
  if (wb.__wbcGit) return wb.__wbcGit;
  const subs = new Set();
  let status = null; // { available, reason?, repos }
  let error = null;
  let loading = false;
  let seq = 0;
  let timer = 0;
  const emit = () => { for (const fn of [...subs]) { try { fn(model); } catch (err) { console.error(err); } } };

  async function refresh() {
    const my = ++seq;
    if (!wb.windowId) { status = null; error = null; loading = false; emit(); return; }
    loading = true;
    emit();
    try {
      const r = await callT(wb, 'git.status', {});
      if (my !== seq) return;
      status = r && typeof r === 'object' ? r : { available: false, reason: 'unexpected answer', repos: [] };
      error = null;
    } catch (err) {
      if (my !== seq) return;
      error = /unknown method/i.test(errText(err))
        ? 'update the TermPocket extension in this VS Code window to use Source Control here.'
        : errText(err);
    }
    loading = false;
    emit();
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS); };

  onVsc(wb, 'git.changed', () => soon());
  try { wb.onWindowChange(() => { status = null; error = null; emit(); refresh(); }); } catch { /* ignore */ }
  try { if (wb.app && wb.app.conn) appOn(wb, wb.app.conn, 'ready', () => soon()); } catch { /* ignore */ }

  const model = {
    get status() { return status; },
    get repos() { return status && Array.isArray(status.repos) ? status.repos : []; },
    get error() { return error; },
    get loading() { return loading; },
    refresh,
    refreshSoon: soon,
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** The repository that contains `path` (longest root wins), else the first one. */
    repoFor(path) {
      const p = String(path || '').toLowerCase().replace(/\//g, '\\');
      let best = null;
      for (const r of model.repos) {
        const root = String(r.root || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
        if ((p === root || p.startsWith(`${root}\\`)) && (!best || root.length > String(best.root).length)) best = r;
      }
      return best || model.repos[0] || null;
    },
  };
  wb.__wbcGit = model;
  refresh();
  return model;
}

/* ------------------------------------------------------------------ view */

function mountScm(wb, container, model, ctx) {
  ensureCss();
  let visible = false;
  let busy = 0;
  const drafts = new Map(); // repo root → message typed here (survives refreshes)
  const collapsedGroups = new Set(local.get('scmCollapsed', []) || []);

  const input = h('textarea', {
    class: 'wbc-scm-input', rows: 1, spellcheck: false, 'aria-label': 'Source Control Input',
    placeholder: 'Message (Ctrl+Enter to commit)',
  });
  const commitBtn = h('button', { type: 'button', class: 'wbc-button', title: 'Commit Changes' }, cicon('check', { size: 16 }), h('span', 'Commit'));
  const top = h('div', { class: 'wbc-side-top scm' }, input, h('div', { class: 'wbc-scm-commit' }, commitBtn));
  const msg = h('div', { class: 'wbc-message', hidden: true });
  const scroller = h('div', { class: 'wbc-scroll' });
  // VS Code shows these in the side bar's title (SOURCE CONTROL ✓ ↻ …).
  const titleActions = h('div', { class: 'wbc-title-actions' },
    actionBtn('check', 'Commit (Ctrl+Enter)', () => commit()),
    actionBtn('refresh', 'Refresh', () => model.refresh()),
    actionBtn('ellipsis', 'More Actions...', (e) => moreMenu(e.currentTarget)));
  const inTitle = !!(ctx && ctx.actions instanceof Element);
  if (inTitle) ctx.actions.append(titleActions);
  const root = h('div', { class: 'wbc-view wbc-side wbc-scm', 'aria-label': 'Source Control' },
    inTitle ? null : h('div', { class: 'wbc-side-toolbar' }, titleActions), top, msg, scroller);
  container.append(root);

  let nodes = [];
  const tree = createTree({
    label: 'Source Control',
    roots: () => nodes,
    rowClass: (n) => (n.kind === 'group' ? 'scm-group' : n.kind === 'repo' ? 'scm-repo' : 'scm-file'),
    renderRow: (n, row) => {
      if (n.kind === 'repo') {
        row.append(
          h('span', { class: 'wbc-label wbc-strong' }, n.repo.name),
          h('span', { class: 'wbc-desc' }, branchText(n.repo)));
        return;
      }
      if (n.kind === 'group') {
        row.title = n.title;
        row.append(
          h('span', { class: 'wbc-label' }, n.title),
          h('span', { class: 'wbc-row-end' },
            h('span', { class: 'wbc-hover-actions wbc-actions' }, ...groupActions(n)),
            countBadge(n.children.length)));
        return;
      }
      const c = n.c;
      const st = c.conflict ? '!' : c.status;
      const cls = c.conflict ? 'git-conflict' : `git-${st}`;
      row.title = `${n.rel} • ${STATUS_TITLE[st] || st}${c.staged ? ' (staged)' : ''}`;
      row.append(
        fileIcon(wb, n.base),
        h('span', { class: ['wbc-label', cls] }, n.base),
        n.dir ? h('span', { class: 'wbc-desc' }, n.dir) : null,
        h('span', { class: 'wbc-row-end' },
          h('span', { class: 'wbc-hover-actions wbc-actions' }, ...fileActions(n)),
          h('span', { class: ['wbc-deco', cls], title: STATUS_TITLE[st] || st }, st)));
    },
    onOpen: (n, { pinned }) => { if (n.kind === 'file') openChange(n, pinned); },
    onToggle: (n, open) => {
      if (n.kind !== 'group') return;
      if (open) collapsedGroups.delete(n.key); else collapsedGroups.add(n.key);
      local.set('scmCollapsed', [...collapsedGroups].slice(-20));
    },
    onContext: (n, e) => {
      if (n.kind === 'file') fileMenu(n, e.clientX, e.clientY);
      else if (n.kind === 'group') groupMenu(n, e.clientX, e.clientY);
    },
    onKey: (n, e) => {
      if (n.kind !== 'file') return false;
      if (e.key === 'Delete') { discard([n]); return true; }
      return false;
    },
  });
  scroller.append(tree.el);

  /* --------------------------------------------------------- building */

  function branchText(r) {
    if (!r) return '';
    let s = r.branch || (r.detached ? (r.commit || '').slice(0, 8) : '');
    if (r.ahead || r.behind) s += ` ${r.behind || 0}↓ ${r.ahead || 0}↑`;
    return s;
  }

  function rebuild() {
    const repos = model.repos;
    const multi = repos.length > 1;
    nodes = [];
    for (const r of repos) {
      const name = splitDirBase(r.root).base || r.root;
      const groups = [];
      const changes = Array.isArray(r.changes) ? r.changes : [];
      const conflicts = changes.filter((c) => c.conflict);
      const staged = changes.filter((c) => c.staged && !c.conflict);
      const work = changes.filter((c) => !c.staged && !c.conflict);
      const mk = (key, title, list, kind) => {
        const gk = `${r.root}\n${key}`;
        return {
          id: `g:${gk}`, key: gk, kind: 'group', group: kind, title, repo: r, expanded: !collapsedGroups.has(gk),
          children: list.map((c) => fileNode(r, c, kind)),
        };
      };
      if (conflicts.length) groups.push(mk('merge', 'Merge Changes', conflicts, 'merge'));
      if (staged.length) groups.push(mk('index', 'Staged Changes', staged, 'index'));
      groups.push(mk('work', 'Changes', work, 'work'));
      if (multi) nodes.push({ id: `r:${r.root}`, kind: 'repo', repo: { ...r, name }, children: groups, expanded: true });
      else nodes.push(...groups);
    }
    tree.render();
    renderTop();
    renderMessage();
  }

  function fileNode(r, c, kind) {
    const rel = relativeTo(c.path, [r.root]);
    const { dir, base } = splitDirBase(rel);
    return { id: `f:${kind}:${c.path}`, kind: 'file', group: kind, c, repo: r, rel, dir, base };
  }

  /** The repository commits go to: the one of the active editor, else the first. */
  function currentRepo() {
    let a = null;
    try { a = wb.editors && wb.editors.active ? wb.editors.active() : null; } catch { a = null; }
    return a && a.path ? model.repoFor(a.path) : model.repos[0] || null;
  }

  function renderTop() {
    const r = currentRepo();
    const show = !!(model.status && model.status.available && r);
    top.hidden = !show;
    titleActions.hidden = !show;
    if (!show) return;
    const branch = r.branch || (r.commit ? r.commit.slice(0, 8) : '');
    input.placeholder = `Message (Ctrl+Enter to commit on '${branch || 'HEAD'}')`;
    if (!drafts.has(r.root) && r.message && !input.value) { input.value = r.message; autoGrow(); }
    const changes = Array.isArray(r.changes) ? r.changes : [];
    commitBtn.title = changes.some((c) => c.staged) ? 'Commit Changes' : 'Commit Changes (stages all tracked changes first)';
    commitBtn.disabled = busy > 0 || !changes.length;
  }

  function renderMessage() {
    let text = '';
    let retry = false;
    if (!wb.windowId) text = 'No VS Code window is selected.';
    else if (model.error) { text = `Source Control is not available: ${model.error} `; retry = true; }
    else if (!model.status) { text = model.loading ? '' : 'Source Control has not loaded yet. '; retry = !model.loading; }
    else if (!model.status.available) text = `Git is not available in this VS Code window${model.status.reason ? `: ${model.status.reason}` : '.'}`;
    else if (!model.repos.length) text = 'The folder currently open doesn\'t have a Git repository.';
    msg.hidden = !text;
    // Every state ends in data, a message, or an error with Retry (never an endless blank / spinner).
    msg.replaceChildren(text, retry ? h('button', { type: 'button', class: 'wbc-link', onClick: () => model.refresh() }, 'Retry') : '');
  }

  /* --------------------------------------------------------- actions */

  function fileActions(n) {
    const acts = [actionBtn('goToFile', 'Open File', () => openFile(n))];
    if (n.group === 'index') acts.push(actionBtn('remove', 'Unstage Changes', () => unstage([n])));
    else {
      acts.push(actionBtn('discard', 'Discard Changes', () => discard([n])));
      acts.push(actionBtn('add', 'Stage Changes', () => stage([n])));
    }
    return acts;
  }

  function groupActions(g) {
    if (g.group === 'index') return [actionBtn('remove', 'Unstage All Changes', () => unstage(g.children))];
    if (g.group === 'merge') return [actionBtn('add', 'Stage All Merge Changes', () => stage(g.children))];
    return [
      actionBtn('discard', 'Discard All Changes', () => discard(g.children)),
      actionBtn('add', 'Stage All Changes', () => stage(g.children)),
    ];
  }

  function openChange(n, pinned) {
    const c = n.c;
    try {
      // A side that does not exist (deleted file, untracked file not in the index) shows empty:
      // git.show answers exists:false and the shell's diff editor renders it as an empty model.
      // Like VS Code: working-tree changes diff against the index ('~'), staged ones against HEAD.
      const o = { preview: !pinned, diffWith: c.staged ? 'HEAD' : '~' };
      const r = wb.editors.open(c.path, o);
      if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, `Could not open ${n.base}`));
    } catch (err) { reportError(err, `Could not open ${n.base}`); }
  }

  function openFile(n) {
    if (n.c.status === 'D' && !n.c.staged) { notify(`${n.base} was deleted.`, 'warning'); return; }
    try {
      const r = wb.editors.open(n.c.path, { preview: false });
      if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, `Could not open ${n.base}`));
    } catch (err) { reportError(err, `Could not open ${n.base}`); }
  }

  async function runOp(label, fn) {
    busy++;
    renderTop();
    try {
      return await fn();
    } catch (err) {
      reportError(err, label);
      return undefined;
    } finally {
      busy--;
      renderTop();
      model.refreshSoon();
    }
  }

  async function stage(list) {
    const paths = list.map((n) => n.c.path);
    if (!paths.length) return undefined;
    // Staging a conflicted file marks the conflict resolved (VS Code asks first as well).
    const conflicted = list.filter((n) => n.c.conflict);
    if (conflicted.length && !(await confirm({
      message: conflicted.length === 1
        ? `Are you sure you want to stage ${conflicted[0].base} with merge conflicts?`
        : `Are you sure you want to stage ${conflicted.length} files with merge conflicts?`,
      detail: 'Staging marks the conflicts as resolved. Check that no conflict markers are left in the file.',
      primary: 'Stage', type: 'warning',
    }))) return undefined;
    return runOp('Git: could not stage', () => callT(wb, 'git.stage', { paths }));
  }

  function unstage(list) {
    const paths = list.map((n) => n.c.path);
    if (!paths.length) return undefined;
    return runOp('Git: could not unstage', () => callT(wb, 'git.unstage', { paths }));
  }

  async function discard(list) {
    const files = list.filter((n) => n.kind === 'file' && n.group !== 'index');
    if (!files.length) return;
    const untracked = files.filter((n) => n.c.status === 'U');
    const tracked = files.filter((n) => n.c.status !== 'U');
    let message;
    let detail = 'This is IRREVERSIBLE!';
    let primary;
    if (files.length === 1) {
      const n = files[0];
      if (n.c.status === 'U') {
        message = `Are you sure you want to DELETE the following untracked file: '${n.base}'?`;
        detail = 'This is IRREVERSIBLE!\nThis file will be moved to the Recycle Bin when possible.';
        primary = 'Delete File';
      } else {
        message = `Are you sure you want to discard changes in '${n.base}'?`;
        detail = 'This is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.';
        primary = 'Discard File';
      }
    } else {
      const parts = [];
      if (tracked.length) parts.push(`discard changes in ${tracked.length} file${tracked.length === 1 ? '' : 's'}`);
      if (untracked.length) parts.push(`DELETE ${untracked.length} untracked file${untracked.length === 1 ? '' : 's'}`);
      message = `Are you sure you want to ${parts.join(' and ')}?`;
      primary = untracked.length ? 'Discard All' : `Discard ${files.length} Files`;
    }
    if (!(await confirm({ message, detail, primary, type: 'warning' }))) return;
    const r = await runOp('Git: could not discard changes', () => callT(wb, 'git.discard', { paths: files.map((n) => n.c.path) }));
    if (r && Array.isArray(r.skipped) && r.skipped.length) {
      notify(`${r.skipped.length} file${r.skipped.length === 1 ? ' has' : 's have'} only staged changes and ${r.skipped.length === 1 ? 'was' : 'were'} not discarded: unstage first.`, 'warning');
    }
  }

  async function commit({ all: forceAll = false } = {}) {
    const r = currentRepo();
    if (!r || busy) return;
    const message = input.value.trim();
    if (!message) {
      notify('Please provide a commit message.', 'warning');
      input.focus();
      return;
    }
    const changes = Array.isArray(r.changes) ? r.changes : [];
    let all = forceAll;
    if (!all && !changes.some((c) => c.staged)) {
      if (!changes.some((c) => c.status !== 'U')) {
        notify('There are no changes to commit: stage the new (untracked) files first.', 'warning');
        return;
      }
      const ok = await confirm({
        message: 'There are no staged changes to commit.',
        detail: 'Would you like to stage all your changes and commit them directly?',
        primary: 'Yes',
        type: 'info',
      });
      if (!ok) return;
      all = true;
    }
    const p = { message, all };
    if (model.repos.length > 1) p.root = r.root;
    const res = await runOp('Git: commit failed', () => callT(wb, 'git.commit', p, 40000));
    // The answer can come after git.changed already refreshed the view (VS Code runs its post-commit
    // work first): clear only the message that was committed, never one typed since.
    if (res && input.value.trim() === message) {
      input.value = '';
      drafts.delete(r.root);
      autoGrow();
    }
  }

  async function copy(text) { if (!(await copyText(text))) notify('Copy failed', 'error'); }

  function fileMenu(n, x, y) {
    const items = [
      { label: 'Open Changes', onSelect: () => openChange(n, true) },
      { label: 'Open File', onSelect: () => openFile(n) },
      'sep',
    ];
    if (n.group === 'index') items.push({ label: 'Unstage Changes', onSelect: () => unstage([n]) });
    else {
      items.push({ label: 'Stage Changes', onSelect: () => stage([n]) });
      items.push({ label: 'Discard Changes', kbd: 'Delete', onSelect: () => discard([n]) });
    }
    items.push('sep',
      { label: 'Copy Path', kbd: 'Shift+Alt+C', onSelect: () => copy(n.c.path) },
      { label: 'Copy Relative Path', onSelect: () => copy(n.rel) });
    contextMenu(x, y, items);
  }

  function groupMenu(g, x, y) {
    const items = g.group === 'index'
      ? [{ label: 'Unstage All Changes', onSelect: () => unstage(g.children) }]
      : [{ label: 'Stage All Changes', onSelect: () => stage(g.children) }, { label: 'Discard All Changes', onSelect: () => discard(g.children) }];
    contextMenu(x, y, items);
  }

  function nodesOf(group) {
    const out = [];
    const walk = (list) => { for (const n of list) { if (n.kind === 'file' && n.group === group) out.push(n); if (n.children) walk(n.children); } };
    walk(nodes);
    return out;
  }

  function moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const repo = currentRepo();
    const changes = repo && Array.isArray(repo.changes) ? repo.changes : [];
    contextMenu(r.left, r.bottom + 2, [
      { label: 'Commit Staged', disabled: !changes.some((c) => c.staged), onSelect: () => commit() },
      { label: 'Commit All', disabled: !changes.length, onSelect: () => commit({ all: true }) },
      'sep',
      { label: 'Stage All Changes', disabled: !nodesOf('work').length, onSelect: () => stage(nodesOf('work')) },
      { label: 'Unstage All Changes', disabled: !nodesOf('index').length, onSelect: () => unstage(nodesOf('index')) },
      'sep',
      { label: 'Refresh', onSelect: () => model.refresh() },
      { label: 'Collapse All', onSelect: () => tree.expandAll(false) },
    ]);
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(134, Math.max(26, input.scrollHeight + 2))}px`;
  }

  input.addEventListener('input', () => {
    const r = currentRepo();
    if (r) drafts.set(r.root, input.value);
    autoGrow();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); commit(); }
  });
  commitBtn.addEventListener('click', () => commit());

  const off = model.on(() => { if (visible) rebuild(); });

  return {
    show(o) {
      visible = true;
      rebuild();
      if (!model.loading) model.refreshSoon();
      if (o && o.focus) requestAnimationFrame(() => { if (!top.hidden) input.focus(); else tree.focus(); });
    },
    hide() { visible = false; },
    focus() { if (!top.hidden) input.focus(); else tree.focus(); },
    dispose() { off(); titleActions.remove(); root.remove(); },
  };
}

/* ------------------------------------------------------------------ register */

export function register(wb) {
  return once(wb, 'scm', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  const model = gitModel(wb);
  let view = null;
  const badge = () => {
    const n = model.repos.reduce((s, r) => s + (Array.isArray(r.changes) ? r.changes.length : 0), 0);
    return n ? String(n) : '';
  };
  const reg = wb.activity.register({
    id: 'scm',
    title: 'Source Control',
    icon: activityIcon('source-control'),
    order: 30,
    kb: 'ctrl+shift+g',
    mount(container, ctx) {
      view = mountScm(wb, container, model, ctx);
      return view;
    },
  });
  const setBadge = () => {
    try {
      if (reg && typeof reg.setBadge === 'function') reg.setBadge(badge());
      else if (wb.activity.setBadge) wb.activity.setBadge('scm', badge());
    } catch { /* optional */ }
  };
  model.on(setBadge);
  setBadge();
  // The shell registers "Show Source Control" (Ctrl+Shift+G); this fills the gap without it.
  registerCommand(wb, 'workbench.view.scm', 'Show Source Control', () => {
    wb.activity.show('scm', { focus: true });
  }, { keybinding: 'ctrl+shift+g', category: 'View', terminal: true });
  registerCommand(wb, 'termpocket.scm.refreshView', 'Refresh Source Control View', () => model.refresh(), { category: 'Source Control' });
  return { model };
}
