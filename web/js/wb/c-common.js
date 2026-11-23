// Shared helpers for the workbench parts owned by "builder C" (panel / problems / terminal / palette /
// scm / search / status bar): stylesheet loader, VS Code codicons (the glyph font inside Monaco's CSS),
// the shell's file icons / context menu / notifications / dialogs when it offers them (fallbacks
// otherwise), fuzzy scoring with match positions, a VS Code-like tree, keybinding labels and
// language names.
//
// Security: every remote string goes through textContent (h() children). Icon markup is static.

import { h, setChildren, clamp, basename, toast, toastError, confirmDialog } from '../ui.js';

/* ------------------------------------------------------------------ shell */

let shell = null;
/** Remember the workbench so helpers can use its shared UI (menus, notifications, dialogs, icons). */
export function useShell(wb) { if (wb) shell = wb; return wb; }

/* ------------------------------------------------------------------ stylesheet */

const MONACO_CSS = new URL('../../vendor/monaco/vs/editor/editor.main.css', import.meta.url).href;
let cssLinked = false;
function linkOnce(href, attrs = {}) {
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
  document.head.append(h('link', { rel: 'stylesheet', href, ...attrs }));
}
/** Load wbc.css (next to this module) and Monaco's CSS (it defines the codicon font) once. */
export function ensureCss() {
  if (cssLinked) return;
  cssLinked = true;
  linkOnce(MONACO_CSS, { 'data-name': 'vs/editor/editor.main' });
  linkOnce(new URL('./wbc.css', import.meta.url).href);
}

/* ------------------------------------------------------------------ codicons */

// Code points read from the codicon font that ships with the vendored Monaco (glyph names → cmap).
const CODICON = {
  close: 0xea76, add: 0xea60, remove: 0xeb3b, trash: 0xea81, 'chevron-right': 0xeab6, 'chevron-down': 0xeab4,
  'chevron-up': 0xeab7, ellipsis: 0xea7c, terminal: 0xea85, 'terminal-powershell': 0xebc7, 'terminal-cmd': 0xebc4,
  'terminal-bash': 0xebca, remote: 0xeb3a, error: 0xea87, warning: 0xea6c, info: 0xea74, check: 0xeab2,
  refresh: 0xeb37, 'collapse-all': 0xeac5, 'expand-all': 0xeb95, discard: 0xeae2, 'go-to-file': 0xea94,
  search: 0xea6d, filter: 0xeaf1, 'clear-all': 0xeabf, 'list-tree': 0xeb86, 'list-flat': 0xeb84,
  'git-branch': 0xea68, 'git-commit': 0xeafc, sync: 0xea77, bell: 0xeaa2, 'bell-dot': 0xeb9a,
  'split-horizontal': 0xeb56, 'link-external': 0xeb14, edit: 0xea73, history: 0xea82, copy: 0xebcc,
  folder: 0xea83, 'folder-opened': 0xeaf7, 'source-control': 0xec6f, window: 0xeb7f, 'layout-panel': 0xebf2,
  'case-sensitive': 0xeab1, 'cloud-upload': 0xeac3, 'arrow-up': 0xeaa1, 'arrow-down': 0xea9a,
  'debug-disconnect': 0xead0, loading: 0xeb19, 'circle-filled': 0xea71, 'kebab-vertical': 0xeb10,
  'screen-full': 0xeb4c, 'whole-word': 0xeb7e, regex: 0xeb38, 'word-wrap': 0xeb80, pass: 0xeba4,
  gear: 0xeaf8, 'settings-gear': 0xeb51, 'new-file': 0xea7f, files: 0xeaf0, 'zoom-in': 0xeb81, 'zoom-out': 0xeb82,
};
// Older camelCase names used across these modules → codicon ids.
const ALIAS = {
  chevronRight: 'chevron-right', chevronDown: 'chevron-down', chevronUp: 'chevron-up', terminalPwsh: 'terminal-powershell',
  terminalCmd: 'terminal-cmd', collapseAll: 'collapse-all', expandAll: 'expand-all', goToFile: 'go-to-file',
  clearAll: 'clear-all', listTree: 'list-tree', listFlat: 'list-flat', gitBranch: 'git-branch', gitCommit: 'git-commit',
  bellDot: 'bell-dot', split: 'split-horizontal', maximize: 'chevron-up', restore: 'chevron-down',
  linkExternal: 'link-external', folderOpened: 'folder-opened', sourceControl: 'source-control',
  layoutPanel: 'layout-panel', caseSensitive: 'case-sensitive', cloudUpload: 'cloud-upload',
};

/** VS Code codicon: a 16 px glyph of the codicon font (defined by Monaco's CSS) drawn as text. */
export function cicon(name, { size = 16, cls = '' } = {}) {
  const id = ALIAS[name] || name;
  const cp = CODICON[id] || CODICON.info;
  // Own class names: Monaco's runtime CSS adds .codicon-<name>:before rules that would draw a second glyph.
  const el = h('span', { class: ['wbc-ci', `wbc-ci-${id}`, 'ci', cls], 'aria-hidden': 'true' });
  el.textContent = String.fromCodePoint(cp);
  if (size !== 16) el.style.fontSize = `${size}px`;
  return el;
}

/** Activity-bar icon node (24 px codicon) for activity.register({icon}). */
export function activityIcon(name) {
  return h('span', { class: 'wb-act-icon wbc-act-icon' }, cicon(name, { size: 24 }));
}

/* ------------------------------------------------------------------ file icons */

/** File-type icon: the shell's Seti-style icons (same in explorer, search, SCM, problems, tabs). */
export function fileIcon(wb, name, opts = {}) {
  const s = (wb && typeof wb.fileIcon === 'function') ? wb : shell;
  if (s && typeof s.fileIcon === 'function') {
    try {
      const el = s.fileIcon(name, opts);
      if (el instanceof Node) return el;
    } catch { /* fall back */ }
  }
  if (opts.dir) return h('span', { class: 'wbc-fi dir', 'aria-hidden': 'true' }, cicon(opts.open ? 'folder-opened' : 'folder'));
  return h('span', { class: 'wbc-fi plain', 'aria-hidden': 'true' }, cicon('files'));
}

/* ------------------------------------------------------------------ notifications / dialogs */

/** VS Code notification (shell) or app toast. severity: info | warning | error. */
export function notify(message, severity = 'info', opts = {}) {
  if (shell && typeof shell.notify === 'function') {
    try { return shell.notify(String(message ?? ''), { severity, ...opts }); } catch { /* fall back */ }
  }
  toast(String(message ?? ''), { type: severity === 'error' ? 'err' : severity === 'warning' ? 'warn' : 'info' });
  return null;
}

/** Report an error (shell notification, else app toast). */
export function reportError(err, prefix = '') {
  const msg = errText(err);
  if (shell && typeof shell.notify === 'function') {
    try { shell.notify(prefix ? `${prefix}: ${msg}` : msg, { severity: 'error' }); return; } catch { /* fall back */ }
  }
  try { toastError(err, prefix); } catch { console.error(prefix, err); }
}

/**
 * VS Code modal confirmation → Promise<boolean>.
 * { message, detail, primary: 'Discard File', type: 'warning' }
 */
export async function confirm({ message, detail = '', primary = 'OK', type = 'warning' } = {}) {
  if (shell && typeof shell.dialog === 'function') {
    try {
      const i = await shell.dialog({ message, detail, buttons: [primary, 'Cancel'], type, cancelId: 1 });
      return i === 0;
    } catch { /* fall back */ }
  }
  return confirmDialog({ title: message, message: detail, confirmText: primary, danger: type === 'warning' });
}

/* ------------------------------------------------------------------ fuzzy */

const SEP_RE = /[\\/_\-.\s:]/;

/**
 * Fuzzy match `query` in `target` (subsequence, case-insensitive) like VS Code's quick open:
 * consecutive runs, word / path-segment starts and camelCase humps score higher.
 * → { score, matches: number[] } or null.
 */
export function fuzzyScore(query, target) {
  const q = String(query || '');
  const t = String(target || '');
  if (!q) return { score: 0, matches: [] };
  const n = q.length;
  const m = t.length;
  if (n > m) return null;
  const ql = q.toLowerCase();
  const tl = t.toLowerCase();
  // Fast reject: subsequence check.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = tl.indexOf(ql[i], j);
    if (j < 0) return null;
  }
  if (m > 512) { // long strings: greedy is good enough
    const matches = [];
    for (let i = 0, j = 0; i < n; i++, j++) { j = tl.indexOf(ql[i], j); matches.push(j); }
    return { score: n, matches };
  }
  // DP: best[i][j] = best score matching q[0..i] with q[i] at t[j].
  const NEG = -1e9;
  const best = new Array(n);
  const from = new Array(n);
  for (let i = 0; i < n; i++) { best[i] = new Float64Array(m).fill(NEG); from[i] = new Int32Array(m).fill(-1); }
  const bonus = (j) => {
    if (j === 0) return 8;
    const prev = t[j - 1];
    if (SEP_RE.test(prev)) return 7;
    if (t[j] !== tl[j] && prev === tl[j - 1] && /[a-z0-9]/.test(prev)) return 6; // camelCase hump
    return 0;
  };
  for (let i = 0; i < n; i++) {
    let runBest = NEG;
    let runIdx = -1;
    for (let j = i; j < m; j++) {
      // Track the best predecessor best[i-1][k] for k < j (with a small gap penalty).
      if (i > 0 && j - 1 >= 0) {
        const k = j - 1;
        const v = best[i - 1][k];
        if (v > NEG) {
          const cand = v - 0.0; // gap penalty applied below
          if (cand > runBest) { runBest = cand; runIdx = k; }
        }
      }
      if (tl[j] !== ql[i]) continue;
      let s = 1 + bonus(j) + (t[j] === q[i] ? 0.5 : 0);
      if (i === 0) {
        best[i][j] = s - j * 0.02;
        continue;
      }
      // consecutive?
      const consec = best[i - 1][j - 1];
      let viaConsec = NEG;
      if (consec > NEG) viaConsec = consec + s + 6;
      let viaGap = NEG;
      if (runIdx >= 0) viaGap = runBest + s - Math.min(3, (j - runIdx - 1) * 0.15);
      if (viaConsec >= viaGap && viaConsec > NEG) { best[i][j] = viaConsec; from[i][j] = j - 1; }
      else if (viaGap > NEG) { best[i][j] = viaGap; from[i][j] = runIdx; }
    }
  }
  let end = -1;
  let top = NEG;
  for (let j = 0; j < m; j++) if (best[n - 1][j] > top) { top = best[n - 1][j]; end = j; }
  if (end < 0) return null;
  const matches = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i--) { matches[i] = j; j = from[i][j]; }
  // Prefix / exact boosts.
  let score = top;
  if (tl.startsWith(ql)) score += 10;
  if (tl === ql) score += 20;
  return { score, matches };
}

/** Text with highlighted character positions → nodes (spans .hl). */
export function highlighted(text, positions = [], cls = 'hl') {
  const s = String(text ?? '');
  if (!positions || !positions.length) return [s];
  const set = new Set(positions);
  const out = [];
  let run = '';
  let inHl = false;
  for (let i = 0; i < s.length; i++) {
    const hl = set.has(i);
    if (hl !== inHl && run) { out.push(inHl ? h('span', { class: cls }, run) : run); run = ''; }
    inHl = hl;
    run += s[i];
  }
  if (run) out.push(inHl ? h('span', { class: cls }, run) : run);
  return out;
}

/* ------------------------------------------------------------------ wb adapters */

/** Subscribe to a vsc.event of the workbench's current window. Returns an unsubscribe function. */
export function onVsc(wb, ev, fn) {
  const life = lifetime(wb);
  const guarded = (p, wid) => { if (!life.check()) fn(p, wid); };
  const off = typeof wb.onVsc === 'function'
    ? wb.onVsc(ev, guarded) || (() => {})
    : wb.app.conn.on('vsc.event', ({ windowId, ev: e, p }) => { if (e === ev && windowId === wb.windowId) guarded(p, windowId); });
  return life.add(off);
}

/**
 * Lifetime of the workbench for app-level listeners (connection, window list): once the shell's
 * root left the document (workbench disposed, e.g. a layout switch re-created it) every listener
 * added here is removed the next time any of them fires, so old models stop making calls.
 */
export function lifetime(wb) {
  if (!wb.__wbcLife) {
    const offs = [];
    let dead = false;
    const life = {
      add(off) { if (typeof off === 'function') { if (dead) off(); else offs.push(off); } return off; },
      check() {
        if (dead) return true;
        const root = wb.root;
        if (root instanceof Element && !root.isConnected) {
          dead = true;
          for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
        }
        return dead;
      },
    };
    Object.defineProperty(wb, '__wbcLife', { value: life, enumerable: false });
  }
  return wb.__wbcLife;
}

/** emitter.on(ev, fn) for app-level emitters (conn, vs), dropped with the workbench (see lifetime). */
export function appOn(wb, emitter, ev, fn) {
  const life = lifetime(wb);
  const off = emitter.on(ev, (...a) => { if (!life.check()) fn(...a); });
  return life.add(off);
}

/**
 * Register a local workbench command; double invocations from the same key press are merged.
 * An id the shell already registered is kept (pass {override:true} to replace it).
 */
export function registerCommand(wb, id, title, fn, opts = {}) {
  let last = 0;
  if (!opts.override && wb.commands && typeof wb.commands.has === 'function' && wb.commands.has(id)) {
    return (...args) => wb.commands.run(id, ...args);
  }
  const run = (...args) => {
    const now = performance.now();
    if (now - last < 40) return undefined;
    last = now;
    return fn(...args);
  };
  const { override, ...rest } = opts;
  void override;
  try { wb.commands.register(id, title, run, rest); } catch (err) { console.warn('[wb] command register failed', id, err); }
  return run;
}

/** Bind a key combo when the shell offers keys.bind (the command registration may already do it). */
export function bindKey(wb, combo, fn, opts) {
  try { if (wb.keys && typeof wb.keys.bind === 'function') return wb.keys.bind(combo, fn, opts); } catch (err) { console.warn('[wb] key bind failed', combo, err); }
  return null;
}

/** Normalised "Ctrl+Shift+P" style combo of a keyboard event. */
export function comboOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  let k = e.key;
  if (e.code === 'Backquote') k = '`';
  else if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (k === ' ') k = 'Space';
  else if (k && k.length === 1) k = k.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return parts.join('+');
  parts.push(k);
  return parts.join('+');
}

/** Keycap nodes for "Ctrl+Shift+P" (chords separated by spaces). */
export function keybindingLabel(kb) {
  if (!kb) return null;
  let label = String(kb);
  if (/[A-Z]/.test(label)) {
    // Already a display label ("Ctrl+Alt+UpArrow", from VS Code's catalog): keep VS Code's spelling.
  } else if (shell && typeof shell.kbLabel === 'function') {
    try { label = shell.kbLabel(label) || label; } catch { /* keep */ }
  } else {
    label = label.split(/\s+/).map((ch) => ch.split('+').map((k) => (k ? k.charAt(0).toUpperCase() + k.slice(1) : k)).join('+')).join(' ');
  }
  const chords = label.split(/\s+/).filter(Boolean);
  const box = h('span', { class: 'wbc-kb' });
  chords.forEach((chord, ci) => {
    if (ci) box.append(h('span', { class: 'wbc-kb-sep' }, ' '));
    chord.split('+').filter(Boolean).forEach((k, ki) => {
      if (ki) box.append(h('span', { class: 'wbc-kb-plus' }, '+'));
      box.append(h('kbd', { class: 'wbc-kbd' }, k));
    });
  });
  return box;
}

/* ------------------------------------------------------------------ context menu */

let openMenu = null;
export function closeContextMenu() { if (openMenu) openMenu.close(); }

/**
 * VS Code-style context menu at (x, y).
 * items: [{ label, kbd?, disabled?, onSelect }] | 'sep'
 */
export function contextMenu(x, y, items, { onClose } = {}) {
  ensureCss();
  closeContextMenu();
  if (shell && typeof shell.contextMenu === 'function') {
    const mapped = items.filter(Boolean).map((it) => (it === 'sep' ? 'sep' : { label: it.label, kb: it.kbd || it.kb, disabled: !!it.disabled, checked: it.checked, onSelect: it.onSelect }));
    try {
      const m = shell.contextMenu({ x, y }, mapped, { onClose });
      openMenu = m || null;
      return m;
    } catch (err) { console.warn('[wb] shell context menu failed', err); }
  }
  const prevFocus = document.activeElement;
  const menu = h('div', { class: 'wbc-menu', role: 'menu', tabIndex: -1 });
  const buttons = [];
  for (const it of items.filter(Boolean)) {
    if (it === 'sep') { menu.append(h('div', { class: 'wbc-menu-sep', role: 'separator' })); continue; }
    const b = h('div', { class: ['wbc-menu-item', it.disabled && 'disabled'], role: 'menuitem', 'aria-disabled': it.disabled ? 'true' : null },
      h('span', { class: 'wbc-menu-check' }, it.checked ? cicon('check', { size: 14 }) : null),
      h('span', { class: 'wbc-menu-label' }, it.label),
      it.kbd ? h('span', { class: 'wbc-menu-kbd' }, it.kbd) : null);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('mouseenter', () => setActive(buttons.indexOf(b)));
    b.addEventListener('click', () => { if (it.disabled) return; close(); if (it.onSelect) it.onSelect(); });
    b._item = it;
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.round(clamp(x, 2, Math.max(2, vw - mw - 2)))}px`;
  menu.style.top = `${Math.round(y + mh > vh - 2 ? Math.max(2, y - mh) : y)}px`;
  let active = -1;
  function setActive(i) {
    if (active >= 0 && buttons[active]) buttons[active].classList.remove('active');
    active = i;
    if (active >= 0 && buttons[active]) buttons[active].classList.add('active');
  }
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!buttons.length) return;
      let i = active;
      for (let n = 0; n < buttons.length; n++) {
        i = (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        if (!buttons[i]._item.disabled) break;
      }
      setActive(i);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      if (active >= 0) buttons[active].click();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', () => close(), { once: true });
  window.addEventListener('resize', () => close(), { once: true });
  menu.focus({ preventScroll: true });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (openMenu === api) openMenu = null;
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    menu.remove();
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  const api = { el: menu, close };
  openMenu = api;
  return api;
}

/* ------------------------------------------------------------------ toolbar helpers */

/** Small codicon action button (title bars, hover actions). */
export function actionBtn(name, title, onClick, { cls = '', keepFocus = true } = {}) {
  const b = h('button', { type: 'button', class: ['wbc-action', cls], title, 'aria-label': title }, cicon(name));
  if (keepFocus) b.addEventListener('mousedown', (e) => e.preventDefault());
  if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

/** Twistie for tree rows. */
export function twistie(expanded) {
  return h('span', { class: ['wbc-twistie', expanded ? 'open' : ''], 'aria-hidden': 'true' }, cicon('chevronRight', { size: 16 }));
}

/** Count badge (VS Code's grey pill). */
export function countBadge(n, cls = '') {
  return h('span', { class: ['wbc-badge', cls] }, String(n));
}

/** Replace a host's children with a centred message. */
export function message(host, text, extra) {
  setChildren(host, h('div', { class: 'wbc-message' }, text, extra || null));
}

/* ------------------------------------------------------------------ language names */

const LANG_NAMES = {
  javascript: 'JavaScript', javascriptreact: 'JavaScript JSX', typescript: 'TypeScript', typescriptreact: 'TypeScript JSX',
  json: 'JSON', jsonc: 'JSON with Comments', jsonl: 'JSON Lines', markdown: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  python: 'Python', php: 'PHP', sql: 'SQL', powershell: 'PowerShell', shellscript: 'Shell Script', bat: 'Batch',
  yaml: 'YAML', xml: 'XML', plaintext: 'Plain Text', ini: 'Ini', properties: 'Properties', dotenv: 'Environment Variables',
  ignore: 'Ignore', csharp: 'C#', java: 'Java', go: 'Go', rust: 'Rust', cpp: 'C++', c: 'C', ruby: 'Ruby', lua: 'Lua',
  dockerfile: 'Docker', makefile: 'Makefile', vue: 'Vue', svelte: 'Svelte', log: 'Log', csv: 'CSV', diff: 'Diff',
  'git-commit': 'Git Commit Message', 'code-text-binary': 'Binary', perl: 'Perl', r: 'R', swift: 'Swift', kotlin: 'Kotlin',
  dart: 'Dart', toml: 'TOML', graphql: 'GraphQL', vb: 'Visual Basic', fsharp: 'F#', objc: 'Objective-C', tex: 'TeX', latex: 'LaTeX',
};
export function languageName(id) {
  if (!id) return '';
  return LANG_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

/** Workspace-relative path for display ("src\app.js"), else the absolute path. */
export function relativeTo(p, roots) {
  const s = String(p || '');
  const lower = s.toLowerCase();
  for (const r of roots || []) {
    if (!r) continue;
    const rl = String(r).toLowerCase().replace(/[\\/]+$/, '');
    if (lower.startsWith(rl + '\\') || lower.startsWith(rl + '/')) return s.slice(rl.length + 1);
  }
  return s;
}

/** Workspace folders of the current window (from the shared VS Code window list). */
export function windowFolders(wb) {
  try {
    const ws = wb.workspace;
    if (ws && Array.isArray(ws.folders) && ws.folders.length) return ws.folders.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  } catch { /* ignore */ }
  try {
    const w = wb.app.vs && wb.app.vs.get(wb.windowId);
    return (w && Array.isArray(w.folders)) ? w.folders : [];
  } catch { return []; }
}

/** Safe localStorage JSON (per-viewer conveniences only). */
export const local = {
  get(key, def) {
    try { const v = localStorage.getItem(`termpocket.wb.${key}`); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(`termpocket.wb.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

/* ------------------------------------------------------------------ tree */

const INDENT = 8;
const ROW_PAD = 8;

/**
 * Small VS Code-like tree (list.* colours, 22 px rows, twisties, indent guides on hover,
 * keyboard navigation). Re-rendered from scratch on render(); sizes here stay in the hundreds.
 *
 * opts:
 *   label                aria-label
 *   roots()              → node[]; node = { id, children?: node[] | null, expanded? (default true) }
 *   renderRow(node, row, depth)   append the row's content (after indent + twistie)
 *   rowClass?(node)      extra class(es)
 *   onOpen?(node, { event, keyboard, pinned })   click / Enter (pinned = double-click or Enter)
 *   onContext?(node, event)
 *   onToggle?(node, expanded)
 *   twistieless?         no twistie column when no node has children (flat lists)
 *   openParents?         parents are opened (onOpen) instead of toggled on click
 */
export function createTree(opts) {
  const el = h('div', { class: 'wbc-tree', role: 'tree', tabIndex: 0, 'aria-label': opts.label || 'Tree' });
  const expanded = new Map(); // id → bool (overrides node.expanded)
  let flat = [];              // [{ node, depth, parent }]
  let rows = new Map();       // id → row element
  let focusedId = null;
  let selectedId = null;

  const isOpen = (n) => (expanded.has(n.id) ? expanded.get(n.id) : n.expanded !== false);
  const hasKids = (n) => Array.isArray(n.children) && n.children.length > 0;

  function flatten() {
    const out = [];
    const walk = (list, depth, parent) => {
      for (const n of list || []) {
        out.push({ node: n, depth, parent });
        if (hasKids(n) && isOpen(n)) walk(n.children, depth + 1, n);
      }
    };
    walk(opts.roots() || [], 0, null);
    return out;
  }

  function render() {
    const scroller = el.parentElement;
    const keepScroll = scroller ? scroller.scrollTop : 0;
    flat = flatten();
    rows = new Map();
    const frag = document.createDocumentFragment();
    const anyKids = flat.some((f) => hasKids(f.node));
    for (const f of flat) {
      const { node, depth } = f;
      const kids = hasKids(node);
      const open = kids && isOpen(node);
      const row = h('div', {
        class: ['wbc-row', ...[].concat(opts.rowClass ? opts.rowClass(node) : []), node.id === selectedId && 'selected', node.id === focusedId && 'focused'],
        role: 'treeitem',
        'aria-level': String(depth + 1),
        'aria-expanded': kids ? String(open) : null,
        'aria-selected': node.id === selectedId ? 'true' : 'false',
        style: { paddingLeft: `${ROW_PAD + depth * INDENT}px` },
      });
      row._node = node;
      // renderRow callers pass optional parts as null: never let them become "null" text.
      const nativeAppend = row.append.bind(row);
      row.append = (...kids) => nativeAppend(...kids.filter((k) => k != null && k !== false && k !== true));
      for (let i = 0; i < depth; i++) {
        row.append(h('span', { class: 'wbc-guide', style: { left: `${ROW_PAD + i * INDENT + 8}px` } }));
      }
      if (!(opts.twistieless && !anyKids)) {
        const tw = h('span', { class: ['wbc-twistie', open && 'open', !kids && 'leaf'], 'aria-hidden': 'true' }, cicon('chevronRight', { size: 16 }));
        if (kids) tw.addEventListener('click', (e) => { e.stopPropagation(); setFocus(node.id); toggle(node); });
        row.append(tw);
      }
      opts.renderRow(node, row, depth);
      rows.set(node.id, row);
      frag.append(row);
    }
    el.replaceChildren(frag);
    if (scroller) scroller.scrollTop = keepScroll;
    if (focusedId && !rows.has(focusedId)) focusedId = null;
  }

  function toggle(node, force) {
    if (!hasKids(node)) return;
    const next = force === undefined ? !isOpen(node) : !!force;
    if (next === isOpen(node)) return;
    expanded.set(node.id, next);
    try { if (opts.onToggle) opts.onToggle(node, next); } catch (err) { console.error(err); }
    render();
  }

  function setFocus(id, { select = true, reveal = true } = {}) {
    const prevF = focusedId && rows.get(focusedId);
    if (prevF) prevF.classList.remove('focused');
    focusedId = id;
    const r = id && rows.get(id);
    if (r) r.classList.add('focused');
    if (select) {
      const prevS = selectedId && rows.get(selectedId);
      if (prevS) { prevS.classList.remove('selected'); prevS.setAttribute('aria-selected', 'false'); }
      selectedId = id;
      if (r) { r.classList.add('selected'); r.setAttribute('aria-selected', 'true'); }
    }
    if (r && reveal) r.scrollIntoView({ block: 'nearest' });
  }

  const indexOf = (id) => flat.findIndex((f) => f.node.id === id);
  const rowOf = (e) => {
    const row = e.target.closest('.wbc-row');
    return row && el.contains(row) && row._node ? row : null;
  };

  el.addEventListener('mousedown', (e) => { if (e.button === 1 && rowOf(e)) e.preventDefault(); });
  el.addEventListener('click', (e) => {
    const row = rowOf(e);
    if (!row || e.target.closest('.wbc-action')) return;
    const node = row._node;
    setFocus(node.id, { reveal: false });
    if (hasKids(node) && !opts.openParents) { toggle(node); return; }
    if (opts.onOpen) opts.onOpen(node, { event: e, keyboard: false, pinned: false });
  });
  el.addEventListener('dblclick', (e) => {
    const row = rowOf(e);
    if (!row || e.target.closest('.wbc-action')) return;
    const node = row._node;
    if (hasKids(node) && !opts.openParents) return;
    if (opts.onOpen) opts.onOpen(node, { event: e, keyboard: false, pinned: true });
  });
  el.addEventListener('contextmenu', (e) => {
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    setFocus(row._node.id, { reveal: false });
    if (opts.onContext) opts.onContext(row._node, e);
  });
  el.addEventListener('focus', () => {
    if (!focusedId && flat.length) setFocus(selectedId && rows.has(selectedId) ? selectedId : flat[0].node.id, { select: false });
  });
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || !flat.length || e.altKey || e.metaKey) return;
    if (e.ctrlKey && e.key !== 'Home' && e.key !== 'End') return;
    const i = focusedId ? indexOf(focusedId) : -1;
    const cur = i >= 0 ? flat[i] : null;
    const page = Math.max(1, Math.floor((el.parentElement ? el.parentElement.clientHeight : 220) / 22) - 1);
    const go = (j) => setFocus(flat[clamp(j, 0, flat.length - 1)].node.id);
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i < 0 ? 0 : i - 1); break;
      case 'PageDown': go(i + page); break;
      case 'PageUp': go(i - page); break;
      case 'Home': go(0); break;
      case 'End': go(flat.length - 1); break;
      case 'ArrowRight':
        if (!cur) { go(0); break; }
        if (hasKids(cur.node)) {
          if (!isOpen(cur.node)) { toggle(cur.node, true); setFocus(cur.node.id); } else go(i + 1);
        }
        break;
      case 'ArrowLeft':
        if (!cur) break;
        if (hasKids(cur.node) && isOpen(cur.node)) { toggle(cur.node, false); setFocus(cur.node.id); } else if (cur.parent) setFocus(cur.parent.id);
        break;
      case 'Enter':
      case ' ':
        if (!cur) break;
        if (hasKids(cur.node) && !opts.openParents) toggle(cur.node);
        else if (opts.onOpen) opts.onOpen(cur.node, { event: e, keyboard: true, pinned: e.key === 'Enter' });
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return;
        if (cur && opts.onContext) {
          const r = rows.get(cur.node.id).getBoundingClientRect();
          opts.onContext(cur.node, { clientX: r.left + 24, clientY: r.bottom, preventDefault() {} });
        }
        break;
      default:
        if (opts.onKey && cur && opts.onKey(cur.node, e)) break;
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  return {
    el,
    render,
    toggle,
    setFocus,
    expandAll(v = true) {
      const walk = (list) => { for (const n of list || []) if (hasKids(n)) { expanded.set(n.id, v); walk(n.children); } };
      walk(opts.roots() || []);
      render();
    },
    resetExpansion() { expanded.clear(); },
    isExpanded: (n) => isOpen(n),
    get focusedId() { return focusedId; },
    get selectedId() { return selectedId; },
    get size() { return flat.length; },
    row: (id) => rows.get(id) || null,
    focus() { el.focus({ preventScroll: true }); },
  };
}

/** Folder (trailing separators removed) and base name of a path. */
export function splitDirBase(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? { dir: '', base: s } : { dir: s.slice(0, i), base: s.slice(i + 1) };
}

/** Message of an error, never throws. */
export function errText(err) {
  return (err && (err.message || String(err))) || 'Unknown error';
}


/** Run a module's registration once per workbench (the shell and panel.js may both ask for it). */
export function once(wb, key, fn) {
  if (!wb.__wbcOnce) Object.defineProperty(wb, '__wbcOnce', { value: new Map(), enumerable: false });
  if (!wb.__wbcOnce.has(key)) wb.__wbcOnce.set(key, fn());
  return wb.__wbcOnce.get(key);
}
