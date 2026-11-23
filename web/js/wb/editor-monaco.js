// Editor part of the desktop workbench (builder B): editor tabs + breadcrumbs + Monaco (the editor
// component of VS Code), vendored in web/vendor/monaco/vs and loaded lazily with its AMD loader.
//
// * One text model per file (per VS Code window), one code editor + one diff editor instance; tabs
//   swap models and keep each tab's view state (scroll, cursor, folding) like VS Code.
// * Save (Ctrl+S) = fs.write, after re-reading the file (fs.read) to make sure it was not changed
//   on the PC since it was loaded (otherwise ask before overwriting).
// * VS Code's own diagnostics (diagnostics.list / diagnostics.changed) become Monaco markers;
//   Monaco's built-in TS/JS/JSON/CSS/HTML validation and language workers are switched off.
// * Diff editor for {diffWith: 'HEAD' | '~' (index)} via git.show.
// * Per VS Code window an editor group (tabs, MRU, closed stack) — switching windows swaps groups.

import { h, setChildren, store, debounce, basename, copyText, fmtBytes } from '../ui.js';
import { registerDirtySource } from '../editor.js';
import { ci, fileIcon, notify, dialog, progressBar, pathKey, relativeTo, kbBoxes, MONACO_BASE, contextMenu, actionBtn } from './base.js';
import { createTabStrip, tabContextMenu, createBreadcrumbs } from './tabs.js';

export const THEME = 'termpocket-dark-modern';

/* ======================================================================== Monaco loader */

let monacoPromise = null;

/** Load Monaco once (AMD loader from web/vendor/monaco/vs) → Promise<monaco>. */
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const boot = () => {
      const req = window.require;
      if (!req || typeof req.config !== 'function') { reject(new Error('Monaco AMD loader did not initialise')); return; }
      req.config({ paths: { vs: MONACO_BASE } });
      req(['vs/editor/editor.main'], (mod) => {
        const monaco = window.monaco || mod;
        try { setupMonaco(monaco); } catch (err) { console.warn('[wb] Monaco setup', err); }
        refineGrammars(monaco).catch((err) => console.warn('[wb] grammar refinement', err)).then(() => resolve(monaco));
      }, (err) => reject(new Error(`Monaco failed to load: ${err && err.message ? err.message : err}`)));
    };
    if (window.require && typeof window.require.config === 'function' && window.require.toUrl) { boot(); return; }
    const s = document.createElement('script');
    s.src = `${MONACO_BASE}/loader.js`;
    s.async = true;
    s.onload = boot;
    s.onerror = () => reject(new Error('The Monaco editor is not installed on the PC (web/vendor/monaco). Run "npm install" (or "npm run vendor") in agent/.'));
    document.head.append(s);
  });
  monacoPromise.catch(() => { monacoPromise = null; });
  return monacoPromise;
}

function setupMonaco(monaco) {
  // Only the base editor worker (word suggestions, diff, links): language services are off, so
  // their big workers (ts.worker is ~7 MB) are never downloaded.
  const env = self.MonacoEnvironment;
  const orig = env && typeof env.getWorker === 'function' ? env.getWorker.bind(env) : null;
  self.MonacoEnvironment = {
    getWorker(id, label) {
      if (orig) return orig(id, 'editorWorkerService');
      return new Worker(`${MONACO_BASE}/editor/editor.worker.js`);
    },
  };
  void 0;
  const L = monaco.languages;
  const off = (obj, keys) => Object.fromEntries(keys.map((k) => [k, false]));
  const tsLike = L.typescript || monaco.typescript;
  try {
    for (const d of [tsLike && tsLike.javascriptDefaults, tsLike && tsLike.typescriptDefaults]) {
      if (!d) continue;
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
      if (d.setModeConfiguration) {
        d.setModeConfiguration(off(null, ['completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights',
          'rename', 'diagnostics', 'documentRangeFormattingEdits', 'signatureHelp', 'onTypeFormattingEdits', 'codeActions', 'inlayHints']));
      }
    }
  } catch (err) { console.warn('[wb] ts defaults', err); }
  try {
    const json = (L.json || monaco.json);
    const d = json && json.jsonDefaults;
    if (d) {
      d.setDiagnosticsOptions({ validate: false, allowComments: true, schemas: [], enableSchemaRequest: false });
      if (d.setModeConfiguration) {
        d.setModeConfiguration({ ...off(null, ['documentFormattingEdits', 'documentRangeFormattingEdits', 'completionItems', 'hovers', 'documentSymbols', 'colors', 'foldingRanges', 'diagnostics', 'selectionRanges']), tokens: true });
      }
    }
  } catch (err) { console.warn('[wb] json defaults', err); }
  try {
    const css = (L.css || monaco.css);
    for (const d of [css && css.cssDefaults, css && css.scssDefaults, css && css.lessDefaults]) {
      if (!d) continue;
      if (d.setOptions) d.setOptions({ ...(d.options || {}), validate: false });
      if (d.setModeConfiguration) {
        d.setModeConfiguration(off(null, ['completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights',
          'rename', 'colors', 'foldingRanges', 'diagnostics', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits']));
      }
    }
  } catch (err) { console.warn('[wb] css defaults', err); }
  try {
    const html = (L.html || monaco.html);
    for (const d of [html && html.htmlDefaults, html && html.handlebarDefaults, html && html.razorDefaults]) {
      if (!d || !d.setModeConfiguration) continue;
      d.setModeConfiguration(off(null, ['completionItems', 'hovers', 'documentSymbols', 'links', 'documentHighlights', 'rename', 'colors',
        'foldingRanges', 'diagnostics', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits']));
    }
  } catch (err) { console.warn('[wb] html defaults', err); }

  monaco.editor.defineTheme(THEME, DARK_MODERN);
}

/**
 * Monarch's JS/TS grammar has one "keyword" class; VS Code's TextMate grammar colours control flow
 * (if/return/import…) purple and function names yellow. Re-register both languages with those two
 * distinctions (everything else is Monaco's own grammar).
 */
const CONTROL_KEYWORDS = ['break', 'case', 'catch', 'continue', 'default', 'do', 'else', 'finally', 'for', 'if', 'return',
  'switch', 'throw', 'try', 'while', 'import', 'export', 'from', 'await', 'yield', 'with'];
async function refineGrammars(monaco) {
  for (const id of ['javascript', 'typescript']) {
    const def = monaco.languages.getLanguages().find((l) => l.id === id);
    if (!def || typeof def.loader !== 'function') continue;
    const mod = await def.loader();
    if (!mod || !mod.language || !mod.language.tokenizer || !Array.isArray(mod.language.tokenizer.common)) continue;
    const base = mod.language;
    const common = base.tokenizer.common.slice();
    const word = { cases: { '@controlKeywords': 'keyword.flow', '@keywords': 'keyword', '@default': 'identifier' } };
    const call = { cases: { '@controlKeywords': 'keyword.flow', '@keywords': 'keyword', '@default': 'function' } };
    common.splice(0, 1, [/#?[a-z_$][\w$]*(?=\s*(?:<[^<>()]*>)?\s*\()/, call], [/#?[a-z_$][\w$]*/, word]);
    const language = { ...base, controlKeywords: CONTROL_KEYWORDS, tokenizer: { ...base.tokenizer, common } };
    if (mod.conf) monaco.languages.setLanguageConfiguration(id, mod.conf);
    monaco.languages.setMonarchTokensProvider(id, language);
  }
}

/** VS Code "Dark Modern" for Monaco (Dark+ token colours on Dark Modern chrome). */
const DARK_MODERN = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'CCCCCC' },
    { token: 'comment', foreground: '6A9955' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.flow', foreground: 'C586C0' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'string.escape', foreground: 'D7BA7D' },
    { token: 'string.key.json', foreground: '9CDCFE' },
    { token: 'string.value.json', foreground: 'CE9178' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'regexp', foreground: 'D16969' },
    { token: 'type', foreground: '4EC9B0' },
    { token: 'type.identifier', foreground: '4EC9B0' },
    { token: 'identifier', foreground: '9CDCFE' },
    { token: 'variable', foreground: '9CDCFE' },
    { token: 'variable.predefined', foreground: '4FC1FF' },
    { token: 'variable.parameter', foreground: '9CDCFE' },
    { token: 'constant', foreground: '4FC1FF' },
    { token: 'predefined', foreground: 'DCDCAA' },
    { token: 'function', foreground: 'DCDCAA' },
    { token: 'annotation', foreground: 'DCDCAA' },
    { token: 'delimiter', foreground: 'D4D4D4' },
    { token: 'operator', foreground: 'D4D4D4' },
    { token: 'tag', foreground: '569CD6' },
    { token: 'metatag', foreground: '569CD6' },
    { token: 'attribute.name', foreground: '9CDCFE' },
    { token: 'attribute.value', foreground: 'CE9178' },
    { token: 'attribute.value.number', foreground: 'B5CEA8' },
    { token: 'attribute.value.unit', foreground: 'B5CEA8' },
    { token: 'attribute.value.hex', foreground: 'CE9178' },
    { token: 'tag.css', foreground: 'D7BA7D' },
    { token: 'tag.scss', foreground: 'D7BA7D' },
    { token: 'attribute.name.css', foreground: '9CDCFE' },
    { token: 'key', foreground: '9CDCFE' },
    { token: 'keyword.md', foreground: '569CD6', fontStyle: 'bold' },
    { token: 'keyword.table.header.md', foreground: '569CD6' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'string.link.md', foreground: 'CE9178' },
    { token: 'variable.md', foreground: '3794FF' },
    { token: 'variable.source.md', foreground: 'CE9178' },
    { token: 'invalid', foreground: 'F44747' },
  ],
  colors: {
    'editor.background': '#1F1F1F',
    'editor.foreground': '#CCCCCC',
    'editorLineNumber.foreground': '#6E7681',
    'editorLineNumber.activeForeground': '#CCCCCC',
    'editorCursor.foreground': '#AEAFAD',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editor.selectionHighlightBackground': '#ADD6FF26',
    'editor.wordHighlightBackground': '#575757B8',
    'editor.wordHighlightStrongBackground': '#004972B8',
    'editor.findMatchBackground': '#9E6A03',
    'editor.findMatchHighlightBackground': '#EA5C0055',
    'editor.lineHighlightBorder': '#282828',
    'editor.lineHighlightBackground': '#00000000',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorWhitespace.foreground': '#E3E4E229',
    'editorBracketHighlight.foreground1': '#FFD700',
    'editorBracketHighlight.foreground2': '#DA70D6',
    'editorBracketHighlight.foreground3': '#179FFF',
    'editorBracketMatch.background': '#0064001A',
    'editorBracketMatch.border': '#888888',
    'editorError.foreground': '#F14C4C',
    'editorWarning.foreground': '#CCA700',
    'editorInfo.foreground': '#3794FF',
    'editorGutter.addedBackground': '#2EA043',
    'editorGutter.modifiedBackground': '#0078D4',
    'editorGutter.deletedBackground': '#F85149',
    'editorOverviewRuler.border': '#010409',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#313131',
    'editorWidget.foreground': '#CCCCCC',
    'editorSuggestWidget.background': '#202020',
    'editorSuggestWidget.border': '#454545',
    'editorSuggestWidget.selectedBackground': '#04395E',
    'editorHoverWidget.background': '#202020',
    'editorHoverWidget.border': '#454545',
    'editorStickyScroll.background': '#1F1F1F',
    'editorStickyScrollHover.background': '#2A2D2E',
    'editorGroupHeader.tabsBackground': '#181818',
    'focusBorder': '#0078D4',
    'foreground': '#CCCCCC',
    'widget.shadow': '#0000005C',
    'input.background': '#313131',
    'input.border': '#3C3C3C',
    'input.foreground': '#CCCCCC',
    'input.placeholderForeground': '#989898',
    'inputOption.activeBackground': '#2489DB82',
    'inputOption.activeBorder': '#2488DB',
    'inputValidation.errorBackground': '#5A1D1D',
    'inputValidation.errorBorder': '#BE1100',
    'list.activeSelectionBackground': '#04395E',
    'list.activeSelectionForeground': '#FFFFFF',
    'list.hoverBackground': '#2A2D2E',
    'list.highlightForeground': '#2AAAFF',
    'list.focusOutline': '#0078D4',
    'quickInput.background': '#222222',
    'quickInput.foreground': '#CCCCCC',
    'quickInputList.focusBackground': '#04395E',
    'pickerGroup.border': '#3C3C3C',
    'menu.background': '#1F1F1F',
    'menu.foreground': '#CCCCCC',
    'menu.selectionBackground': '#0078D4',
    'menu.selectionForeground': '#FFFFFF',
    'menu.separatorBackground': '#454545',
    'menu.border': '#454545',
    'scrollbar.shadow': '#000000',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
    'peekView.border': '#3794FF',
    'peekViewEditor.background': '#1F1F1F',
    'peekViewResult.background': '#1F1F1F',
    'peekViewTitle.background': '#252526',
    'diffEditor.insertedTextBackground': '#9CCC2C33',
    'diffEditor.removedTextBackground': '#FF000033',
    'diffEditor.insertedLineBackground': '#9BB95533',
    'diffEditor.removedLineBackground': '#FF000033',
    'diffEditor.diagonalFill': '#CCCCCC33',
    'textLink.foreground': '#4DAAFC',
    'textLink.activeForeground': '#4DAAFC',
    'badge.background': '#616161',
    'badge.foreground': '#F8F8F8',
    'button.background': '#0078D4',
    'button.foreground': '#FFFFFF',
    'button.hoverBackground': '#026EC1',
    'keybindingLabel.foreground': '#CCCCCC',
    'minimap.selectionHighlight': '#264F78',
  },
};

/* ================================================================= languages / helpers */

const VSCODE_TO_MONACO = {
  jsonc: 'json', json5: 'json', jsonl: 'json', shellscript: 'shell', javascriptreact: 'javascript',
  typescriptreact: 'typescript', dotenv: 'ini', properties: 'ini', ignore: 'plaintext', log: 'plaintext',
  'git-commit': 'plaintext', 'git-rebase': 'plaintext', dockercompose: 'yaml', vue: 'html', 'django-html': 'html',
  jinja: 'html', 'cuda-cpp': 'cpp', c: 'cpp', makefile: 'plaintext', 'code-text-binary': 'plaintext', csv: 'plaintext',
  xsl: 'xml', svg: 'xml', toml: 'ini', terraform: 'hcl', 'search-result': 'plaintext', snippets: 'json',
};
const LANG_NAMES = {
  javascript: 'JavaScript', typescript: 'TypeScript', javascriptreact: 'JavaScript JSX', typescriptreact: 'TypeScript JSX',
  json: 'JSON', jsonc: 'JSON with Comments', jsonl: 'JSON Lines', markdown: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS',
  less: 'Less', python: 'Python', powershell: 'PowerShell', shellscript: 'Shell Script', yaml: 'YAML', plaintext: 'Plain Text',
  php: 'PHP', sql: 'SQL', bat: 'Batch', xml: 'XML', ignore: 'Ignore', dotenv: 'Dotenv', ini: 'Ini', csharp: 'C#', cpp: 'C++',
  c: 'C', java: 'Java', go: 'Go', rust: 'Rust', dockerfile: 'Docker', log: 'Log', properties: 'Properties', ruby: 'Ruby',
  'git-commit': 'Git Commit Message', lua: 'Lua', perl: 'Perl', r: 'R', swift: 'Swift', kotlin: 'Kotlin', dart: 'Dart',
  graphql: 'GraphQL', handlebars: 'Handlebars', vue: 'Vue', toml: 'TOML', makefile: 'Makefile', csv: 'CSV', svg: 'SVG',
  'code-text-binary': 'Binary',
};
export function languageName(id) {
  if (!id) return 'Plain Text';
  return LANG_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

function monacoLanguage(monaco, vscodeId, path) {
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  const id = VSCODE_TO_MONACO[vscodeId] || vscodeId;
  if (id && known.has(id)) return id;
  const base = basename(path).toLowerCase();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  for (const l of monaco.languages.getLanguages()) {
    if ((l.filenames || []).some((f) => f.toLowerCase() === base)) return l.id;
    if (ext && (l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
  }
  return 'plaintext';
}

const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
function hashKey(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(36);
}

/* ===================================================================== editor service */

/**
 * @param wb  the workbench API (shell.js)
 * @param part  the editor part element
 */
export function createEditorService(wb, part) {
  const groups = new Map(); // windowKey → {tabs, activeKey, mru, closed}
  const docs = new Map(); // `${winKey}|${pathKey}` → Doc
  const diffOrig = new Map(); // tab key → {model, state, error}
  const activeListeners = new Set();
  const tabsListeners = new Set();
  let monaco = null;
  let codeEditor = null;
  let diffEditor = null;
  let shown = null; // {kind: 'code'|'diff'|'placeholder'|'none', key}
  let followPc = store.get('wb.followPc', false) === true;
  let wordWrap = store.get('wb.wordWrap', 'off') === 'on' ? 'on' : 'off';
  let minimap = store.get('wb.minimap', true) !== false;
  let history = [];
  let histIdx = -1;
  let navigating = false;

  /* ---------------------------------------------------------------------------- DOM */
  const strip = createTabStrip({
    onActivate: (key) => activate(key, { focus: true }),
    onClose: (key) => closeTab(key),
    onPin: (key) => pin(key),
    onReorder: (from, to, after) => reorder(from, to, after),
    onContext: (key, x, y) => tabMenu(key, x, y),
  });
  const followBtn = actionBtn('eye', 'Follow the Active Editor of VS Code on the PC', () => setFollow(!followPc));
  const actions = h('div', { class: 'wb-editor-actions' },
    actionBtn('link-external', 'Open in VS Code on the PC', () => openOnPc()),
    followBtn,
    actionBtn('ellipsis', 'More Actions...', (e) => moreMenu(e.currentTarget)));
  const title = h('div', { class: 'wb-editor-title' }, strip.el, actions);
  const crumbs = createBreadcrumbs(wb, { onPick: (p) => open(p, { preview: true }) });
  const progress = progressBar();
  const host = h('div', { class: 'wb-editor-host' });
  const codeHost = h('div', { class: 'wb-monaco', hidden: true });
  const diffHost = h('div', { class: 'wb-monaco diff', hidden: true });
  const placeholder = h('div', { class: 'wb-editor-placeholder', hidden: true });
  host.append(codeHost, diffHost, placeholder);
  const group = h('div', { class: 'wb-editor-group' }, title, crumbs.el, h('div', { class: 'wb-editor-progress' }, progress.el), host);
  const watermark = h('div', { class: 'wb-watermark' });
  part.append(group, watermark);
  host.addEventListener('contextmenu', (e) => { if (e.target === host || e.target === placeholder) e.preventDefault(); });

  registerDirtySource(() => [...docs.values()].some((d) => d.dirty));

  /* --------------------------------------------------------------------- group state */
  function grp(key = wb.windowKey) {
    const k = key || '';
    let g = groups.get(k);
    if (!g) {
      g = { key: k, tabs: [], activeKey: null, mru: [], closed: [] };
      // Reopen the editors this window had before the page was reloaded (contents load on activation).
      const saved = k ? store.get(`wb.editors.${k}`, null) : null;
      if (saved && Array.isArray(saved.tabs)) {
        for (const t of saved.tabs.slice(0, 40)) {
          if (!t || typeof t.path !== 'string' || !t.path) continue;
          const ref = typeof t.ref === 'string' && t.ref ? t.ref : null;
          const key = ref ? diffTabKey(t.path, ref) : fileTabKey(t.path);
          if (g.tabs.some((x) => x.key === key)) continue;
          g.tabs.push({ key, kind: ref ? 'diff' : 'file', path: t.path, ref, preview: !!t.preview });
        }
        g.activeKey = g.tabs.some((t) => t.key === saved.active) ? saved.active : (g.tabs[0] ? g.tabs[0].key : null);
        g.mru = g.activeKey ? [g.activeKey, ...g.tabs.map((t) => t.key).filter((x) => x !== g.activeKey)] : [];
      }
      groups.set(k, g);
    }
    return g;
  }
  const persistTabs = debounce(() => {
    for (const g of groups.values()) {
      if (!g.key) continue;
      store.set(`wb.editors.${g.key}`, { tabs: g.tabs.map((t) => ({ path: t.path, ref: t.ref || undefined, preview: t.preview || undefined })), active: g.activeKey });
    }
  }, 500);
  const docKey = (path, winKey = wb.windowKey) => `${winKey || ''}|${pathKey(path)}`;
  const fileTabKey = (path) => `file:${pathKey(path)}`;
  const diffTabKey = (path, ref) => `diff:${ref}:${pathKey(path)}`;

  /* ---------------------------------------------------------------------- open */

  /**
   * open(path, {line, column, preview = true, diffWith, focus = true, pinned}) → Promise<void>
   */
  async function open(path, opts = {}) {
    if (!path) return;
    const g = grp();
    const ref = opts.diffWith ? String(opts.diffWith) : null;
    const key = ref ? diffTabKey(path, ref) : fileTabKey(path);
    const preview = opts.pinned ? false : opts.preview !== false;
    let tab = g.tabs.find((t) => t.key === key);
    if (tab) {
      if (!preview && tab.preview) tab.preview = false;
    } else {
      tab = { key, kind: ref ? 'diff' : 'file', path, ref, preview };
      const replace = preview ? g.tabs.find((t) => t.preview && !isTabDirty(t)) : null;
      if (replace) {
        const i = g.tabs.indexOf(replace);
        g.tabs.splice(i, 1, tab);
        releaseTab(replace);
      } else {
        const ai = g.tabs.findIndex((t) => t.key === g.activeKey);
        g.tabs.splice(ai >= 0 ? ai + 1 : g.tabs.length, 0, tab);
      }
    }
    await activate(key, { focus: opts.focus !== false, line: opts.line, column: opts.column });
  }

  async function activate(key, { focus = false, line, column, fromNav = false } = {}) {
    const g = grp();
    const tab = g.tabs.find((t) => t.key === key);
    if (!tab) return;
    saveViewState();
    g.activeKey = key;
    g.mru = [key, ...g.mru.filter((k) => k !== key)];
    if (!fromNav && !navigating) pushHistory(tab);
    renderTabs();
    emitActive();
    await showTab(tab, { focus, line, column });
  }

  function pushHistory(tab) {
    const entry = { key: tab.key, path: tab.path, ref: tab.ref, winKey: wb.windowKey };
    const cur = history[histIdx];
    if (cur && cur.key === entry.key && cur.winKey === entry.winKey) return;
    history = history.slice(0, histIdx + 1);
    history.push(entry);
    if (history.length > 60) history.shift();
    histIdx = history.length - 1;
  }
  async function navigate(d) {
    let i = histIdx + d;
    while (i >= 0 && i < history.length) {
      const e = history[i];
      if (e.winKey === wb.windowKey) {
        histIdx = i;
        navigating = true;
        try {
          if (grp().tabs.some((t) => t.key === e.key)) await activate(e.key, { focus: true, fromNav: true });
          else await open(e.path, { preview: false, diffWith: e.ref || undefined });
        } finally { navigating = false; }
        return;
      }
      i += d;
    }
  }

  /* ---------------------------------------------------------------------- docs */

  function getDoc(path, { create = true } = {}) {
    const k = docKey(path);
    let d = docs.get(k);
    if (!d && create) {
      d = { key: k, path, winKey: wb.windowKey, state: 'new', model: null, meta: null, original: '', savedVersion: 0, dirty: false, readOnly: false, error: '', viewState: null, loading: null, subs: [] };
      docs.set(k, d);
    }
    return d;
  }

  async function ensureMonaco() {
    if (monaco) return monaco;
    monaco = await loadMonaco();
    return monaco;
  }

  function loadDoc(d) {
    if (d.state === 'ready' || d.state === 'binary' || d.state === 'large') return Promise.resolve(d);
    if (d.loading) return d.loading;
    d.state = 'loading';
    const done = progress.start();
    d.loading = (async () => {
      try {
        const [m, r] = await Promise.all([ensureMonaco(), wb.call('fs.read', { path: d.path })]);
        // Closed while loading (and maybe reopened as a new doc): never touch the newer doc's model.
        if (docs.get(d.key) !== d) return d;
        d.meta = r || {};
        if (r && r.path && pathKey(r.path) === pathKey(d.path)) d.path = r.path;
        if (r.binary) { d.state = 'binary'; return d; }
        if (r.truncated && !r.content) { d.state = 'large'; return d; }
        const text = String(r.content ?? '');
        const uri = m.Uri.from({ scheme: 'termpocket', authority: hashKey(d.winKey || 'none'), path: `/${d.path.replace(/\\/g, '/').replace(/^\/+/, '')}` });
        const existing = m.editor.getModel(uri);
        if (existing) existing.dispose();
        d.model = m.editor.createModel(text, monacoLanguage(m, r.languageId, d.path), uri);
        d.original = norm(text);
        d.savedVersion = d.model.getAlternativeVersionId();
        d.readOnly = !!r.truncated || r.encoding === 'windows-1252';
        d.readOnlyReason = r.truncated ? `${basename(d.path)} is larger than 2 MB: only the first part is shown, read-only.`
          : r.encoding === 'windows-1252' ? `${basename(d.path)} is not UTF-8 (Windows 1252): it is shown read-only so its characters are not damaged. Edit it in VS Code on the PC.` : '';
        d.subs.push(d.model.onDidChangeContent(() => onDocEdited(d)));
        d.state = 'ready';
        if (r.isDirty) notify(`${basename(d.path)} has unsaved changes in VS Code on the PC. You are seeing its current text; saving here saves it on the PC.`, { severity: 'info' });
        if (d.readOnlyReason) notify(d.readOnlyReason, { severity: 'warning' });
        refreshMarkers(d);
      } catch (err) {
        d.state = 'error';
        d.error = err && err.message ? err.message : String(err);
      } finally {
        d.loading = null;
        done();
      }
      return d;
    })();
    return d.loading;
  }

  function onDocEdited(d) {
    const dirty = d.model && d.model.getAlternativeVersionId() !== d.savedVersion;
    if (dirty !== d.dirty) {
      d.dirty = dirty;
      // Editing a preview editor pins it (VS Code).
      if (dirty) for (const t of grp(d.winKey).tabs) if (t.preview && t.path && pathKey(t.path) === pathKey(d.path)) t.preview = false;
      renderTabsSoon();
    }
    emitActiveSoon();
  }

  function isTabDirty(t) {
    const d = t.path ? docs.get(docKey(t.path, t.winKey)) : null;
    return !!(d && d.dirty);
  }

  /** Re-read a clean document from the PC (tab brought to front / workbench shown). */
  async function refreshIfClean(d) {
    if (!d || d.state !== 'ready' || d.dirty || d.refreshing || d.saving) return;
    d.refreshing = true;
    try {
      const r = await wb.call('fs.read', { path: d.path });
      if (!r || d.dirty || r.binary || !d.model || d.model.isDisposed()) return;
      if (norm(r.content) === d.original) return;
      applyExternal(d, String(r.content ?? ''));
    } catch { /* keep what we have */ } finally {
      d.refreshing = false;
    }
  }
  function applyExternal(d, text) {
    const m = d.model;
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
    m.pushStackElement();
    d.original = norm(text);
    d.savedVersion = m.getAlternativeVersionId();
    onDocEdited(d);
  }

  /* --------------------------------------------------------------------- showing */

  let showSeq = 0;
  async function showTab(tab, { focus, line, column } = {}) {
    const my = ++showSeq;
    renderCrumbs(tab);
    if (tab.kind === 'diff') { await showDiff(tab, my, { focus, line, column }); return; }
    const d = getDoc(tab.path);
    if (d.state !== 'ready') {
      showPlaceholder('loading');
      await loadDoc(d);
      if (my !== showSeq) return;
    }
    if (d.state !== 'ready') { showPlaceholder(d.state, d); renderTabs(); return; }
    await ensureCodeEditor();
    if (my !== showSeq) return;
    codeHost.hidden = false;
    diffHost.hidden = true;
    placeholder.hidden = true;
    if (codeEditor.getModel() !== d.model) {
      codeEditor.setModel(d.model);
      if (d.viewState) codeEditor.restoreViewState(d.viewState);
    }
    codeEditor.updateOptions({ readOnly: d.readOnly, readOnlyMessage: d.readOnly ? { value: d.readOnlyReason || 'Read-only' } : undefined });
    shown = { kind: 'code', key: tab.key };
    codeEditor.layout();
    if (line) revealPos(codeEditor, line, column);
    if (focus) codeEditor.focus();
    renderTabs();
    emitActive();
    refreshIfClean(d);
  }

  async function showDiff(tab, my, { focus, line, column }) {
    showPlaceholder('loading');
    const d = getDoc(tab.path);
    const done = progress.start();
    try {
      await ensureMonaco();
      let o = diffOrig.get(tab.key);
      if (!o || o.state === 'error') {
        const mine = { state: 'loading', model: null, promise: null };
        diffOrig.set(tab.key, mine);
        mine.promise = (async () => {
          try {
            const r = await wb.call('git.show', { path: tab.path, ref: tab.ref });
            if (diffOrig.get(tab.key) !== mine) return; // the tab was closed meanwhile: no orphan model
            const text = r && r.exists !== false && !r.binary ? String(r.content ?? '') : '';
            mine.model = monaco.editor.createModel(text, monacoLanguage(monaco, null, tab.path));
            mine.binary = !!(r && r.binary);
            mine.state = 'ready';
          } catch (err) {
            mine.state = 'error';
            mine.error = err && err.message ? err.message : String(err);
            throw err;
          }
        })();
        o = mine;
      }
      // A second showTab while the first is still fetching waits for the same original model.
      if (o.state === 'loading') await o.promise;
      if (diffOrig.get(tab.key) !== o || !o.model) { done(); return; }
      if (d.state !== 'ready') await loadDoc(d);
      if (d.state === 'error' && /not found|ENOENT|does not exist|FileNotFound|EntryNotFound/i.test(d.error)) {
        // Deleted in the working tree: compare against an empty, read-only model.
        if (!d.model) {
          d.model = monaco.editor.createModel('', o.model.getLanguageId());
          d.state = 'ready';
          d.readOnly = true;
          d.deleted = true;
          d.original = '';
          d.savedVersion = d.model.getAlternativeVersionId();
        }
      }
    } catch (err) {
      const o = diffOrig.get(tab.key);
      if (o) { o.state = 'error'; o.error = err.message; }
      done();
      if (my === showSeq) showPlaceholder('error', { error: err.message, path: tab.path, retry: () => showTab(tab, { focus }) });
      return;
    }
    done();
    if (my !== showSeq) return;
    if (d.state !== 'ready') { showPlaceholder(d.state, d); return; }
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(diffHost, {
        ...baseOptions(), originalEditable: false, renderSideBySide: true, enableSplitViewResizing: true,
        ignoreTrimWhitespace: true, renderIndicators: true, renderMarginRevertIcon: false, automaticLayout: true,
      });
      wireEditor(diffEditor.getModifiedEditor(), true);
    }
    codeHost.hidden = true;
    placeholder.hidden = true;
    diffHost.hidden = false;
    const o = diffOrig.get(tab.key);
    diffEditor.setModel({ original: o.model, modified: d.model });
    diffEditor.getModifiedEditor().updateOptions({ readOnly: d.readOnly });
    shown = { kind: 'diff', key: tab.key };
    diffEditor.layout();
    if (line) revealPos(diffEditor.getModifiedEditor(), line, column);
    if (focus) diffEditor.getModifiedEditor().focus();
    renderTabs();
    emitActive();
  }

  function revealPos(ed, line, column = 1) {
    const pos = { lineNumber: Math.max(1, line | 0), column: Math.max(1, column | 0) };
    ed.setPosition(pos);
    ed.revealPositionInCenterIfOutsideViewport(pos);
  }

  function showPlaceholder(state, d) {
    codeHost.hidden = true;
    diffHost.hidden = true;
    placeholder.hidden = false;
    shown = { kind: 'placeholder', key: grp().activeKey };
    if (state === 'loading') { setChildren(placeholder); return; }
    const name = d && d.path ? basename(d.path) : '';
    let msg;
    let btns = [];
    if (state === 'binary') {
      msg = 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.';
      btns = [['Open in VS Code on the PC', () => openOnPc(d.path)]];
    } else if (state === 'large') {
      msg = `The file is not displayed in the text editor because it is very large (${fmtBytes((d.meta && d.meta.size) || 0)}).`;
      btns = [['Open in VS Code on the PC', () => openOnPc(d.path)]];
    } else {
      const err = (d && d.error) || 'unknown error';
      const notFound = /not found|ENOENT|does not exist|FileNotFound|EntryNotFound/i.test(err);
      msg = notFound ? `The editor could not be opened because the file was not found.` : `The editor could not be opened due to an unexpected error: ${err}`;
      btns = [['Try Again', () => { if (d && d.retry) d.retry(); else retryDoc(d); }]];
    }
    setChildren(placeholder, h('div', { class: 'wb-placeholder-inner' },
      h('div', { class: 'wb-placeholder-msg' }, msg),
      name ? h('div', { class: 'wb-placeholder-file' }, name) : null,
      h('div', { class: 'wb-placeholder-actions' }, btns.map(([label, fn]) => h('a', { href: '#', class: 'wb-link', onClick: (e) => { e.preventDefault(); fn(); } }, label)))));
  }
  function retryDoc(d) {
    if (!d) return;
    d.state = 'new';
    d.error = '';
    const t = grp().tabs.find((x) => x.key === grp().activeKey);
    if (t) showTab(t, { focus: true });
  }

  function baseOptions() {
    return {
      theme: THEME,
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 19,
      letterSpacing: 0,
      automaticLayout: true,
      minimap: { enabled: minimap, renderCharacters: true, showSlider: 'mouseover', scale: 1 },
      wordWrap,
      glyphMargin: true,
      folding: true,
      showFoldingControls: 'mouseover',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
      stickyScroll: { enabled: true },
      fixedOverflowWidgets: true,
      smoothScrolling: false,
      renderWhitespace: 'selection',
      occurrencesHighlight: 'singleFile',
      wordBasedSuggestions: 'currentDocument',
      'semanticHighlighting.enabled': false,
      scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 10, useShadows: true },
      lineNumbersMinChars: 5,
      lineDecorationsWidth: 10,
      cursorBlinking: 'blink',
      mouseWheelZoom: false,
      contextmenu: true,
      links: true,
      colorDecorators: true,
      dragAndDrop: true,
      tabCompletion: 'off',
    };
  }

  async function ensureCodeEditor() {
    if (codeEditor) return codeEditor;
    await ensureMonaco();
    if (codeEditor) return codeEditor;
    codeEditor = monaco.editor.create(codeHost, { ...baseOptions(), model: null });
    wireEditor(codeEditor, false);
    return codeEditor;
  }

  function wireEditor(ed) {
    ed.onDidChangeCursorSelection(() => emitActiveSoon());
    ed.onDidChangeModelOptions && ed.onDidChangeModelOptions(() => emitActiveSoon());
    ed.onDidFocusEditorWidget && ed.onDidFocusEditorWidget(() => part.classList.add('focused'));
    ed.onDidBlurEditorWidget && ed.onDidBlurEditorWidget(() => part.classList.remove('focused'));
    // Ctrl+S etc. also reach the workbench dispatcher (capture phase); nothing to add here.
  }

  function currentEditor() {
    if (!shown) return null;
    if (shown.kind === 'code') return codeEditor;
    if (shown.kind === 'diff') return diffEditor && diffEditor.getModifiedEditor();
    return null;
  }

  function saveViewState() {
    if (!shown || shown.kind !== 'code' || !codeEditor) return;
    const g = grp();
    const t = g.tabs.find((x) => x.key === shown.key);
    if (!t) return;
    const d = docs.get(docKey(t.path));
    if (d && d.model && codeEditor.getModel() === d.model) d.viewState = codeEditor.saveViewState();
  }

  /* ---------------------------------------------------------------------- tabs */

  function tabInfo(t, g) {
    const d = t.path ? docs.get(docKey(t.path, g.key)) : null;
    const name = basename(t.path);
    const dupes = g.tabs.filter((x) => x !== t && basename(x.path).toLowerCase() === name.toLowerCase());
    let description = '';
    if (dupes.length) {
      const roots = wb.workspace.folders.map((f) => f.path);
      const rel = relativeTo(t.path, roots);
      const dir = (rel != null ? rel : t.path).split(/[\\/]+/).slice(0, -1);
      description = dir.length ? dir[dir.length - 1] : '';
    }
    // The modified (right) side is always the working-tree file, as in VS Code's 'Open Changes'.
    const label = t.kind === 'diff' ? `${name} (Working Tree)` : name;
    return {
      key: t.key, path: t.path, label, description, icon: fileIcon(t.path), dirty: !!(d && d.dirty), preview: t.preview,
      active: t.key === g.activeKey, readOnly: !!(d && d.readOnly && d.state === 'ready'),
      tooltip: t.kind === 'diff' ? `${t.path} (${t.ref === '~' || t.ref === ':0' ? 'Index' : t.ref}) ↔ ${t.path} (Working Tree)` : t.path + (d && d.dirty ? ' • Modified' : ''),
    };
  }

  function renderTabs() {
    const g = grp();
    strip.render(g.tabs.map((t) => tabInfo(t, g)));
    const empty = !g.tabs.length;
    group.hidden = empty;
    watermark.hidden = !empty;
    if (empty) {
      renderWatermark();
      shown = null;
      codeHost.hidden = true;
      diffHost.hidden = true;
      placeholder.hidden = true;
      if (codeEditor) codeEditor.setModel(null);
      if (diffEditor) diffEditor.setModel(null);
    }
    followBtn.classList.toggle('checked', followPc);
    persistTabs();
    for (const fn of [...tabsListeners]) { try { fn(); } catch (err) { console.error(err); } }
  }
  let tabsRaf = 0;
  function renderTabsSoon() {
    if (tabsRaf) return;
    tabsRaf = requestAnimationFrame(() => { tabsRaf = 0; renderTabs(); });
  }

  function renderCrumbs(tab) {
    crumbs.render(tab ? tab.path : null, wb.workspace.folders.map((f) => f.path));
  }

  function pin(key) {
    const t = grp().tabs.find((x) => x.key === key);
    if (t && t.preview) { t.preview = false; renderTabs(); }
  }

  function reorder(from, to, after) {
    const g = grp();
    const a = g.tabs.findIndex((t) => t.key === from);
    if (a < 0) return;
    const [t] = g.tabs.splice(a, 1);
    let b = g.tabs.findIndex((x) => x.key === to);
    if (b < 0) b = g.tabs.length - 1;
    g.tabs.splice(after ? b + 1 : b, 0, t);
    t.preview = false;
    renderTabs();
  }

  /** Close a tab; asks to save a dirty file whose last tab this is. Resolves false if cancelled. */
  async function closeTab(key, { force = false } = {}) {
    const g = grp();
    const t = g.tabs.find((x) => x.key === key);
    if (!t) return true;
    const d = t.path ? docs.get(docKey(t.path)) : null;
    const lastRef = !g.tabs.some((x) => x !== t && x.path && pathKey(x.path) === pathKey(t.path));
    if (!force && d && d.dirty && lastRef) {
      if (g.activeKey !== key) await activate(key);
      const choice = await dialog({
        message: `Do you want to save the changes you made to ${basename(t.path)}?`,
        detail: 'Your changes will be lost if you don\'t save them.',
        buttons: ['Save', 'Don\'t Save', 'Cancel'], type: 'warning', cancelId: 2,
      });
      if (choice === 2) return false;
      if (choice === 0 && !(await saveDoc(d))) return false;
    }
    if (g.activeKey === key) saveViewState();
    const i = g.tabs.indexOf(t);
    g.tabs.splice(i, 1);
    g.mru = g.mru.filter((k) => k !== key);
    g.closed.push({ path: t.path, ref: t.ref });
    if (g.closed.length > 20) g.closed.shift();
    releaseTab(t);
    if (g.activeKey === key) {
      g.activeKey = null;
      const next = g.mru.find((k) => g.tabs.some((x) => x.key === k)) || (g.tabs[Math.min(i, g.tabs.length - 1)] || {}).key;
      if (next) await activate(next, { focus: true });
      else { renderTabs(); emitActive(); renderCrumbs(null); }
    } else renderTabs();
    return true;
  }

  /** Drop model / diff original of a tab that is gone (when no other tab needs them). */
  function releaseTab(t) {
    const g = grp();
    if (t.kind === 'diff') {
      const o = diffOrig.get(t.key);
      if (o) {
        if (shown && shown.key === t.key && diffEditor) diffEditor.setModel(null);
        if (o.model) o.model.dispose();
        diffOrig.delete(t.key);
      }
    }
    if (!t.path) return;
    if (g.tabs.some((x) => x.path && pathKey(x.path) === pathKey(t.path))) return;
    const d = docs.get(docKey(t.path));
    if (!d) return;
    if (codeEditor && codeEditor.getModel() === d.model) codeEditor.setModel(null);
    if (diffEditor) { const m = diffEditor.getModel(); if (m && (m.modified === d.model || m.original === d.model)) diffEditor.setModel(null); }
    for (const s of d.subs) { try { s.dispose(); } catch { /* ignore */ } }
    if (monaco && d.model && !d.model.isDisposed()) monaco.editor.setModelMarkers(d.model, 'vscode', []);
    if (d.model) d.model.dispose();
    docs.delete(d.key);
  }

  async function closeMany(keys) {
    for (const k of keys) { if (!(await closeTab(k))) return false; }
    return true;
  }

  function tabMenu(key, x, y) {
    const g = grp();
    const t = g.tabs.find((z) => z.key === key);
    if (!t) return;
    const i = g.tabs.indexOf(t);
    tabContextMenu(x, y, {
      path: t.path,
      roots: wb.workspace.folders.map((f) => f.path),
      preview: t.preview,
      hasOthers: g.tabs.length > 1,
      hasRight: i < g.tabs.length - 1,
      close: () => closeTab(key),
      closeOthers: () => closeMany(g.tabs.filter((z) => z.key !== key).map((z) => z.key)),
      closeRight: () => closeMany(g.tabs.slice(i + 1).map((z) => z.key)),
      closeSaved: () => closeMany(g.tabs.filter((z) => !isTabDirty(z)).map((z) => z.key)),
      closeAll: () => closeMany(g.tabs.map((z) => z.key)),
      pin: () => pin(key),
      reveal: () => { wb.activity.show('explorer'); if (wb.explorer) wb.explorer.reveal(t.path, { focus: true }); },
      openOnPc: () => openOnPc(t.path),
    });
  }

  function moreMenu(anchor) {
    const g = grp();
    const t = g.tabs.find((x) => x.key === g.activeKey);
    contextMenu({ anchor }, [
      { label: 'Close All', kb: 'ctrl+k w', disabled: !g.tabs.length, onSelect: () => closeMany(g.tabs.map((z) => z.key)) },
      { label: 'Close Saved', kb: 'ctrl+k u', disabled: !g.tabs.length, onSelect: () => closeMany(g.tabs.filter((z) => !isTabDirty(z)).map((z) => z.key)) },
      'sep',
      { label: 'Word Wrap', kb: 'alt+z', checked: wordWrap === 'on', onSelect: () => toggleWordWrap() },
      { label: 'Minimap', checked: minimap, onSelect: () => toggleMinimap() },
      { label: 'Follow Active Editor on PC', checked: followPc, onSelect: () => setFollow(!followPc) },
      'sep',
      { label: 'Revert File', disabled: !t, onSelect: () => revertActive() },
      { label: 'Reveal in Explorer View', disabled: !t, onSelect: () => { wb.activity.show('explorer'); wb.explorer.reveal(t.path, { focus: true }); } },
      t && t.kind === 'diff' ? { label: 'Open File', onSelect: () => open(t.path, { preview: false }) } : null,
    ], { minWidth: 230 });
  }

  /* ---------------------------------------------------------------------- save */

  async function saveDoc(d) {
    if (!d || d.state !== 'ready' || !d.model) return true;
    if (d.readOnly) { notify(d.readOnlyReason || `${basename(d.path)} is read-only here.`, { severity: 'warning' }); return false; }
    if (d.saving) return d.saving;
    d.saving = (async () => {
      const content = d.model.getValue();
      const version = d.model.getAlternativeVersionId();
      const done = progress.start();
      try {
        // fs.write replaces the whole file: make sure nobody changed it on the PC since we loaded it.
        let fresh = null;
        try { fresh = await wb.call('fs.read', { path: d.path }); } catch (err) {
          if (!/not found|ENOENT|does not exist|FileNotFound|EntryNotFound/i.test(err.message)) throw err;
        }
        if (fresh && !fresh.binary && !fresh.truncated && norm(fresh.content) !== d.original) {
          done();
          const choice = await dialog({
            message: `Failed to save '${basename(d.path)}': The content of the file is newer.`,
            detail: 'The file was changed on the PC (in VS Code or another program) since it was opened here. Overwrite those changes with yours?',
            buttons: ['Overwrite', 'Cancel'], type: 'warning', cancelId: 1,
          });
          if (choice !== 0) return false;
        }
        await wb.call('fs.write', { path: d.path, content });
        d.original = norm(content);
        d.savedVersion = version;
        if (d.meta) d.meta.isDirty = false;
        onDocEdited(d);
        renderTabs();
        return true;
      } catch (err) {
        notify(`Failed to save '${basename(d.path)}': ${err.message}`, { severity: 'error' });
        return false;
      } finally {
        done();
        d.saving = null;
      }
    })();
    return d.saving;
  }

  function activeDoc() {
    const g = grp();
    const t = g.tabs.find((x) => x.key === g.activeKey);
    return t && t.path ? docs.get(docKey(t.path)) : null;
  }

  async function saveActive() {
    const d = activeDoc();
    if (!d) return false;
    if (!d.dirty) { const t = grp().tabs.find((x) => x.key === grp().activeKey); if (t) t.preview = false; renderTabs(); return true; }
    return saveDoc(d);
  }
  async function saveAll() {
    let ok = true;
    for (const d of docs.values()) if (d.winKey === wb.windowKey && d.dirty) ok = (await saveDoc(d)) && ok;
    return ok;
  }
  async function revertActive() {
    const d = activeDoc();
    if (!d || d.state !== 'ready') return;
    try {
      const r = await wb.call('fs.read', { path: d.path });
      if (r && !r.binary) applyExternal(d, String(r.content ?? ''));
    } catch (err) { notify(err.message, { severity: 'error' }); }
  }

  async function openOnPc(path) {
    const g = grp();
    const t = g.tabs.find((x) => x.key === g.activeKey);
    const p = path || (t && t.path);
    if (!p) return;
    const ed = currentEditor();
    const pos = !path && ed && ed.getPosition();
    try {
      await wb.call('editor.open', { path: p, line: pos ? pos.lineNumber : undefined, column: pos ? pos.column : undefined, preview: false });
      notify(`Opened ${basename(p)} in VS Code on the PC.`, { severity: 'info', timeout: 2500 });
    } catch (err) { notify(`Could not open ${basename(p)} on the PC: ${err.message}`, { severity: 'error' }); }
  }

  /* ---------------------------------------------------------------------- markers */

  const SEV = { error: 8, warning: 4, info: 2, hint: 1 };
  async function refreshMarkers(d) {
    if (!d || !d.model || !monaco || d.model.isDisposed()) return;
    let list;
    try { list = await wb.call('diagnostics.list', { path: d.path }); } catch { return; }
    if (!d.model || d.model.isDisposed()) return;
    const markers = (Array.isArray(list) ? list : []).filter((x) => pathKey(x.path) === pathKey(d.path)).map((x) => {
      const startLineNumber = Math.max(1, x.line | 0);
      const startColumn = Math.max(1, x.column | 0);
      let endLineNumber = x.endLine ? Math.max(startLineNumber, x.endLine | 0) : startLineNumber;
      let endColumn = x.endColumn ? x.endColumn | 0 : 0;
      if (!endColumn || (endLineNumber === startLineNumber && endColumn <= startColumn)) {
        const word = startLineNumber <= d.model.getLineCount() ? d.model.getWordAtPosition({ lineNumber: startLineNumber, column: startColumn }) : null;
        endLineNumber = startLineNumber;
        endColumn = word ? word.endColumn : startColumn + 1;
      }
      const tags = [];
      if (x.unnecessary || (Array.isArray(x.tags) && x.tags.includes('unnecessary'))) tags.push(1);
      if (x.deprecated || (Array.isArray(x.tags) && x.tags.includes('deprecated'))) tags.push(2);
      const code = x.code && typeof x.code === 'object' ? String(x.code.value ?? '') : x.code != null ? String(x.code) : undefined;
      return { severity: SEV[x.severity] || 2, message: String(x.message || ''), source: x.source || undefined, code, startLineNumber, startColumn, endLineNumber, endColumn, tags };
    });
    monaco.editor.setModelMarkers(d.model, 'vscode', markers);
  }
  const refreshAllMarkers = debounce(() => {
    let n = 0;
    for (const d of docs.values()) if (d.winKey === wb.windowKey && d.state === 'ready' && n++ < 40) refreshMarkers(d);
  }, 700);

  /* ---------------------------------------------------------------------- active */

  function emitActive() {
    const a = active();
    for (const fn of [...activeListeners]) { try { fn(a); } catch (err) { console.error('[wb] active listener failed', err); } }
  }
  let activeRaf = 0;
  function emitActiveSoon() {
    if (activeRaf) return;
    activeRaf = requestAnimationFrame(() => { activeRaf = 0; emitActive(); });
  }

  /** {path, languageId, languageName, line, column, …} of the active editor, or null. */
  function active() {
    const g = grp();
    const t = g.tabs.find((x) => x.key === g.activeKey);
    if (!t) return null;
    const d = docs.get(docKey(t.path));
    const ed = currentEditor();
    const model = d && d.model;
    const pos = ed && model && ed.getModel() === model ? ed.getPosition() : null;
    const sel = ed && model && ed.getModel() === model ? ed.getSelections() || [] : [];
    const opts = model && !model.isDisposed() ? model.getOptions() : null;
    const languageId = (d && d.meta && d.meta.languageId) || (model ? model.getLanguageId() : 'plaintext');
    return {
      path: t.path,
      kind: t.kind,
      ref: t.ref || null,
      languageId,
      languageName: languageName(languageId),
      line: pos ? pos.lineNumber : 1,
      column: pos ? pos.column : 1,
      selectionLength: model ? sel.reduce((n, s) => n + model.getValueLengthInRange(s), 0) : 0,
      selections: sel.length,
      lineCount: model && !model.isDisposed() ? model.getLineCount() : 0,
      eol: model && !model.isDisposed() && model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      tabSize: opts ? opts.tabSize : 4,
      insertSpaces: opts ? opts.insertSpaces : true,
      encoding: (d && d.meta && d.meta.encoding) || 'utf8',
      dirty: !!(d && d.dirty),
      readOnly: !!(d && d.readOnly),
      state: d ? d.state : 'new',
    };
  }

  /* ---------------------------------------------------------------------- watermark */

  function renderWatermark() {
    const entries = [
      ['Show All Commands', 'ctrl+shift+p'],
      ['Go to File', 'ctrl+p'],
      ['Find in Files', 'ctrl+shift+f'],
      ['Toggle Terminal', 'ctrl+`'],
      ['Switch Window', null, 'workbench.action.switchWindow'],
    ];
    setChildren(watermark,
      h('div', { class: 'wb-letterpress', 'aria-hidden': 'true' }, letterpress()),
      h('div', { class: 'wb-watermark-box' }, h('dl', null, entries.map(([label, kb, cmd]) => h('div', { class: 'wb-watermark-entry' },
        h('dt', null, label),
        h('dd', null, kb ? kbBoxes(kb) : h('a', { href: '#', class: 'wb-link', onClick: (e) => { e.preventDefault(); wb.commands.run(cmd); } }, 'Choose…')))))));
  }

  /* ---------------------------------------------------------------------- misc commands */

  function setFollow(on) {
    followPc = !!on;
    store.set('wb.followPc', followPc);
    followBtn.classList.toggle('checked', followPc);
    followBtn.title = followPc ? 'Following the active editor of VS Code on the PC (click to stop)' : 'Follow the Active Editor of VS Code on the PC';
    if (followPc) {
      wb.call('editor.active', {}).then((a) => { if (a && a.path && followPc) followTo(a); }).catch(() => {});
    }
  }
  function followTo(a) {
    const cur = active();
    if (!cur || pathKey(cur.path) !== pathKey(a.path)) open(a.path, { preview: true, focus: false, line: a.line, column: a.column });
  }
  function toggleWordWrap() {
    wordWrap = wordWrap === 'on' ? 'off' : 'on';
    store.set('wb.wordWrap', wordWrap);
    for (const ed of [codeEditor, diffEditor && diffEditor.getModifiedEditor(), diffEditor && diffEditor.getOriginalEditor()]) if (ed) ed.updateOptions({ wordWrap });
  }
  function toggleMinimap() {
    minimap = !minimap;
    store.set('wb.minimap', minimap);
    if (codeEditor) codeEditor.updateOptions({ minimap: { enabled: minimap } });
  }

  // Ctrl+Tab: most recently used editors (hold Ctrl and press Tab again to go further back).
  let cycle = null;
  function cycleMru(dir) {
    const g = grp();
    if (g.tabs.length < 2) return;
    if (!cycle) cycle = { list: g.mru.filter((k) => g.tabs.some((t) => t.key === k)), i: 0 };
    cycle.i = (cycle.i + dir + cycle.list.length) % cycle.list.length;
    const key = cycle.list[cycle.i];
    const t = g.tabs.find((x) => x.key === key);
    if (!t) return;
    saveViewState();
    g.activeKey = key;
    renderTabs();
    showTab(t, { focus: true });
  }
  window.addEventListener('keyup', (e) => {
    if (cycle && (e.key === 'Control' || !e.ctrlKey)) {
      const g = grp();
      const key = cycle.list[cycle.i];
      cycle = null;
      if (key) { g.mru = [key, ...g.mru.filter((k) => k !== key)]; const t = g.tabs.find((x) => x.key === key); if (t) pushHistory(t); }
    }
  }, true);

  function step(d) {
    const g = grp();
    if (!g.tabs.length) return;
    const i = g.tabs.findIndex((t) => t.key === g.activeKey);
    const n = g.tabs[(i + d + g.tabs.length) % g.tabs.length];
    activate(n.key, { focus: true });
  }

  const reg = (id, title, fn, o) => wb.commands.register(id, title, fn, o);
  reg('workbench.action.files.save', 'Save', () => saveActive(), { keybinding: 'ctrl+s', category: 'File', input: true });
  reg('workbench.action.files.saveAll', 'Save All', () => saveAll(), { category: 'File' });
  reg('workbench.action.files.revert', 'Revert File', () => revertActive(), { category: 'File' });
  reg('workbench.action.closeActiveEditor', 'Close Editor', () => { const g = grp(); if (g.activeKey) closeTab(g.activeKey); }, { keybinding: ['ctrl+w', 'ctrl+f4'], category: 'View' });
  reg('workbench.action.closeAllEditors', 'Close All Editors', () => closeMany(grp().tabs.map((t) => t.key)), { category: 'View' });
  reg('workbench.action.closeUnmodifiedEditors', 'Close Saved Editors in Group', () => closeMany(grp().tabs.filter((t) => !isTabDirty(t)).map((t) => t.key)), { category: 'View' });
  reg('workbench.action.reopenClosedEditor', 'Reopen Closed Editor', () => { const c = grp().closed.pop(); if (c) open(c.path, { preview: false, diffWith: c.ref || undefined }); }, { keybinding: 'ctrl+shift+t', category: 'View' });
  reg('workbench.action.nextEditor', 'Open Next Editor', () => step(1), { keybinding: 'ctrl+pagedown', category: 'View' });
  reg('workbench.action.previousEditor', 'Open Previous Editor', () => step(-1), { keybinding: 'ctrl+pageup', category: 'View' });
  reg('workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup', 'Quick Open Previous Recently Used Editor in Group', () => cycleMru(1), { keybinding: 'ctrl+tab', category: 'View' });
  reg('workbench.action.quickOpenLeastRecentlyUsedEditorInGroup', 'Quick Open Least Recently Used Editor in Group', () => cycleMru(-1), { keybinding: 'ctrl+shift+tab', category: 'View' });
  reg('workbench.action.keepEditor', 'Keep Editor', () => { const g = grp(); if (g.activeKey) pin(g.activeKey); }, { category: 'View' });
  reg('workbench.action.navigateBack', 'Go Back', () => navigate(-1), { keybinding: 'alt+left', category: 'Go' });
  reg('workbench.action.navigateForward', 'Go Forward', () => navigate(1), { keybinding: 'alt+right', category: 'Go' });
  reg('editor.action.toggleWordWrap', 'Toggle Word Wrap', () => toggleWordWrap(), { keybinding: 'alt+z', category: 'View', checked: () => wordWrap === 'on' });
  reg('editor.action.toggleMinimap', 'Toggle Minimap', () => toggleMinimap(), { category: 'View' });
  reg('termpocket.toggleFollowPc', 'Toggle Follow Active Editor on PC', () => setFollow(!followPc), { category: 'TermPocket' });
  reg('termpocket.openOnPc', 'Open Active File in VS Code on the PC', () => openOnPc(), { category: 'TermPocket' });
  reg('workbench.action.files.copyPathOfActiveFile', 'Copy Path of Active File', async () => { const a = active(); if (a) await copyText(a.path); }, { keybinding: 'shift+alt+c', category: 'File' });
  reg('workbench.files.action.showActiveFileInExplorer', 'Reveal Active File in Explorer View', () => { const a = active(); if (a) { wb.activity.show('explorer'); wb.explorer.reveal(a.path, { focus: true }); } }, { category: 'File' });
  // Monaco editor actions exposed to the menu bar / palette (run in the active editor).
  const edAct = (id, title, category = 'Edit') => reg(id, title, () => {
    const ed = currentEditor();
    if (!ed) return;
    ed.focus();
    if (id === 'editor.action.undo') ed.trigger('wb', 'undo', null);
    else if (id === 'editor.action.redo') ed.trigger('wb', 'redo', null);
    else if (id === 'editor.action.selectAll') ed.setSelection(ed.getModel().getFullModelRange());
    else { const a = ed.getAction(id); if (a) a.run(); else ed.trigger('wb', id, null); }
  }, { category, hidden: true });
  for (const [id, t] of [['editor.action.undo', 'Undo'], ['editor.action.redo', 'Redo'], ['editor.action.clipboardCutAction', 'Cut'],
    ['editor.action.clipboardCopyAction', 'Copy'], ['editor.action.clipboardPasteAction', 'Paste'], ['actions.find', 'Find'],
    ['editor.action.startFindReplaceAction', 'Replace'], ['editor.action.commentLine', 'Toggle Line Comment'],
    ['editor.action.blockComment', 'Toggle Block Comment'], ['editor.action.selectAll', 'Select All'],
    ['editor.action.smartSelect.expand', 'Expand Selection'], ['editor.action.smartSelect.shrink', 'Shrink Selection'],
    ['editor.action.copyLinesUpAction', 'Copy Line Up'], ['editor.action.copyLinesDownAction', 'Copy Line Down'],
    ['editor.action.moveLinesUpAction', 'Move Line Up'], ['editor.action.moveLinesDownAction', 'Move Line Down'],
    ['editor.action.insertCursorAbove', 'Add Cursor Above'], ['editor.action.insertCursorBelow', 'Add Cursor Below'],
    ['editor.action.addSelectionToNextFindMatch', 'Add Selection To Next Find Match'], ['editor.action.selectHighlights', 'Select All Occurrences of Find Match'],
    ['editor.action.marker.nextInFiles', 'Go to Next Problem in Files (Error, Warning, Info)'], ['editor.action.marker.prevInFiles', 'Go to Previous Problem in Files (Error, Warning, Info)'],
    ['editor.action.formatDocument', 'Format Document']]) edAct(id, t);

  /* ---------------------------------------------------------------------- events */

  wb.onVsc('diagnostics.changed', () => refreshAllMarkers());
  wb.onVsc('editor.changed', (p) => { if (followPc && p && p.active && p.active.path) followTo(p.active); });
  wb.onWindowChange(() => {
    saveViewState();
    cycle = null;
    const g = grp();
    renderTabs();
    const t = g.tabs.find((x) => x.key === g.activeKey);
    if (t) showTab(t, {});
    else { renderCrumbs(null); emitActive(); }
    refreshAllMarkers();
  });
  wb.onWorkspaceChange(() => { const g = grp(); renderCrumbs(g.tabs.find((x) => x.key === g.activeKey) || null); renderTabsSoon(); });
  wb.onVisibilityChange((v) => {
    if (!v) { saveViewState(); return; }
    const d = activeDoc();
    if (d) refreshIfClean(d);
    if (codeEditor) codeEditor.layout();
  });
  wb.app.conn.on('ready', () => refreshAllMarkers());

  renderTabs();
  setFollow(followPc);

  /* ---------------------------------------------------------------------- API */
  return {
    open,
    active,
    onActiveChange(fn) { activeListeners.add(fn); return () => activeListeners.delete(fn); },
    /** Tab list changes (open/close/dirty/activate) — the explorer's OPEN EDITORS section. */
    onTabsChange(fn) { tabsListeners.add(fn); return () => tabsListeners.delete(fn); },
    tabs: () => { const g = grp(); return g.tabs.map((t) => tabInfo(t, g)); },
    activate: (key) => activate(key, { focus: true }),
    closeKey: (key) => closeTab(key),
    saveActive,
    saveAll,
    closeActive: () => { const g = grp(); return g.activeKey ? closeTab(g.activeKey) : Promise.resolve(true); },
    /** Close every tab of a path (after delete); force = drop unsaved edits. */
    async closePath(path, { force = false } = {}) {
      const g = grp();
      for (const t of g.tabs.filter((x) => x.path && (pathKey(x.path) === pathKey(path) || pathKey(x.path).startsWith(pathKey(path) + '\\') || pathKey(x.path).startsWith(pathKey(path) + '/')))) {
        await closeTab(t.key, { force });
      }
    },
    /** A file or folder was renamed: re-key its tabs and models (keeps unsaved edits). */
    renamePath(from, to) {
      const g = grp();
      const fk = pathKey(from);
      const remap = (p) => {
        const k = pathKey(p);
        if (k === fk) return to;
        if (k.startsWith(fk + '\\') || k.startsWith(fk + '/')) return to + p.slice(from.replace(/[\\/]+$/, '').length);
        return null;
      };
      for (const t of g.tabs) {
        const np = t.path && remap(t.path);
        if (!np) continue;
        const d = docs.get(docKey(t.path));
        if (d) { docs.delete(d.key); d.path = np; d.key = docKey(np); docs.set(d.key, d); }
        const oldKey = t.key;
        t.path = np;
        t.key = t.kind === 'diff' ? diffTabKey(np, t.ref) : fileTabKey(np);
        // The diff's original side is keyed by tab: move it (else it leaks and is fetched again).
        const o = diffOrig.get(oldKey);
        if (o && oldKey !== t.key) { diffOrig.delete(oldKey); diffOrig.set(t.key, o); }
        if (g.activeKey === oldKey) g.activeKey = t.key;
        g.mru = g.mru.map((k) => (k === oldKey ? t.key : k));
        if (shown && shown.key === oldKey) shown.key = t.key;
      }
      renderTabs();
      const at = g.tabs.find((x) => x.key === g.activeKey);
      renderCrumbs(at || null);
      emitActive();
    },
    isDirty: (path) => { const d = docs.get(docKey(path)); return !!(d && d.dirty); },
    /** Paths with unsaved edits (this window) that are `path` or inside the folder `path`. */
    dirtyUnder(path) {
      const k = pathKey(path);
      const out = [];
      for (const d of docs.values()) {
        if (d.winKey !== wb.windowKey || !d.dirty) continue;
        const dk = pathKey(d.path);
        if (dk === k || dk.startsWith(k + '\\') || dk.startsWith(k + '/')) out.push(d.path);
      }
      return out;
    },
    /** Most recently used paths of this window's editors (quick open "recently opened"). */
    recent: () => {
      const g = grp();
      const seen = new Set();
      const out = [];
      for (const k of g.mru) { const t = g.tabs.find((x) => x.key === k); if (t && !seen.has(pathKey(t.path))) { seen.add(pathKey(t.path)); out.push(t.path); } }
      for (const t of g.tabs) if (!seen.has(pathKey(t.path))) { seen.add(pathKey(t.path)); out.push(t.path); }
      for (const c of [...g.closed].reverse()) if (!seen.has(pathKey(c.path))) { seen.add(pathKey(c.path)); out.push(c.path); }
      return out;
    },
    focus() { const ed = currentEditor(); if (ed) ed.focus(); },
    /** Reveal a position in the active editor (palette ':' go to line). */
    revealLine(line, column) { const ed = currentEditor(); if (ed) { revealPos(ed, line, column); ed.focus(); } },
    /** Promise<monaco> (loads it). */
    get monaco() { return ensureMonaco(); },
    /** The Monaco editor of the active tab (code editor or the modified side of a diff), or null. */
    get editor() { return currentEditor(); },
    get followPc() { return followPc; },
    setFollowPc: setFollow,
    refreshMarkers: () => refreshAllMarkers(),
  };
}

/** Large grey VS Code-style logo for the empty editor (letterpress). Static markup. */
function letterpress() {
  const tpl = document.createElement('template');
  tpl.innerHTML = '<svg viewBox="0 0 100 100" width="100%" height="100%"><path fill="currentColor" d="M96.5 10.8 75.9.9a6.2 6.2 0 0 0-7.1 1.2L29.4 38 12.2 25a4.2 4.2 0 0 0-5.3.2l-5.5 5a4.2 4.2 0 0 0 0 6.2L16.3 50 1.4 63.6a4.2 4.2 0 0 0 0 6.2l5.5 5a4.2 4.2 0 0 0 5.3.2l17.2-13L68.8 97.9a6.2 6.2 0 0 0 7.1 1.2l20.6-9.9a6.2 6.2 0 0 0 3.5-5.6V16.4a6.2 6.2 0 0 0-3.5-5.6zM75 72.7 45.1 50 75 27.3z"/></svg>';
  return tpl.content.firstElementChild;
}
