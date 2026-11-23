'use strict';

/**
 * Human titles, categories and default keybindings for `commands.list {withTitles:true}` (PROTOCOL §5.2).
 *
 * Sources, best first:
 *  1. `contributes.commands` of every installed extension (`vscode.extensions.all`, built-in ones such as
 *     vscode.git included) — exactly the titles VS Code's Command Palette shows for them;
 *     `contributes.keybindings` for their default keys; `contributes.menus.commandPalette` entries with
 *     `"when": "false"` hide a command from the palette (VS Code does the same).
 *  2. A curated map of common built-in workbench / editor commands. Those are registered by VS Code
 *     itself (no package.json), and the stable API exposes neither their titles nor their keybindings.
 *     Keybindings are VS Code's defaults (the user's keybindings.json is not readable through the API).
 */

const IS_MAC = process.platform === 'darwin';
const PLATFORM_KEY = process.platform === 'win32' ? 'win' : IS_MAC ? 'mac' : 'linux';

// [id, title, category|null, default keybinding (Windows/Linux)|null]
const CURATED = [
  // File
  ['workbench.action.files.newUntitledFile', 'New Untitled Text File', 'File', 'Ctrl+N'],
  ['workbench.action.files.openFile', 'Open File...', 'File', 'Ctrl+O'],
  ['workbench.action.files.openFolder', 'Open Folder...', 'File', 'Ctrl+K Ctrl+O'],
  ['workbench.action.openRecent', 'Open Recent...', 'File', 'Ctrl+R'],
  ['workbench.action.files.save', 'Save', 'File', 'Ctrl+S'],
  ['workbench.action.files.saveAs', 'Save As...', 'File', 'Ctrl+Shift+S'],
  ['workbench.action.files.saveAll', 'Save All', 'File', 'Ctrl+K S'],
  ['workbench.action.files.saveWithoutFormatting', 'Save without Formatting', 'File', 'Ctrl+K Ctrl+Shift+S'],
  ['workbench.action.files.revert', 'Revert File', 'File', null],
  ['workbench.files.action.refreshFilesExplorer', 'Refresh Explorer', 'File', null],
  ['workbench.files.action.showActiveFileInExplorer', 'Reveal Active File in Explorer View', 'File', null],
  ['workbench.files.action.collapseExplorerFolders', 'Collapse Folders in Explorer', 'File', null],
  ['workbench.action.files.copyPathOfActiveFile', 'Copy Path of Active File', 'File', 'Ctrl+K P'],
  ['workbench.action.files.revealActiveFileInWindows', 'Reveal Active File in File Explorer', 'File', 'Ctrl+K R'],
  ['workbench.action.closeFolder', 'Close Folder', 'Workspaces', 'Ctrl+K F'],
  ['workbench.action.newWindow', 'New Window', null, 'Ctrl+Shift+N'],
  // Go / quick access
  ['workbench.action.quickOpen', 'Go to File...', null, 'Ctrl+P'],
  ['workbench.action.showCommands', 'Show All Commands', null, 'Ctrl+Shift+P'],
  ['workbench.action.gotoLine', 'Go to Line/Column...', null, 'Ctrl+G'],
  ['workbench.action.gotoSymbol', 'Go to Symbol in Editor...', null, 'Ctrl+Shift+O'],
  ['workbench.action.showAllSymbols', 'Go to Symbol in Workspace...', null, 'Ctrl+T'],
  ['workbench.action.navigateBack', 'Go Back', null, 'Alt+LeftArrow'],
  ['workbench.action.navigateForward', 'Go Forward', null, 'Alt+RightArrow'],
  // Search
  ['workbench.action.findInFiles', 'Find in Files', 'Search', 'Ctrl+Shift+F'],
  ['workbench.action.replaceInFiles', 'Replace in Files', 'Search', 'Ctrl+Shift+H'],
  // Preferences
  ['workbench.action.openSettings', 'Open Settings (UI)', 'Preferences', 'Ctrl+,'],
  ['workbench.action.openSettingsJson', 'Open User Settings (JSON)', 'Preferences', null],
  ['workbench.action.openGlobalKeybindings', 'Open Keyboard Shortcuts', 'Preferences', 'Ctrl+K Ctrl+S'],
  ['workbench.action.selectTheme', 'Color Theme', 'Preferences', 'Ctrl+K Ctrl+T'],
  ['workbench.action.selectIconTheme', 'File Icon Theme', 'Preferences', null],
  // View / layout
  ['workbench.action.toggleSidebarVisibility', 'Toggle Primary Side Bar Visibility', 'View', 'Ctrl+B'],
  ['workbench.action.toggleAuxiliaryBar', 'Toggle Secondary Side Bar Visibility', 'View', 'Ctrl+Alt+B'],
  ['workbench.action.togglePanel', 'Toggle Panel Visibility', 'View', 'Ctrl+J'],
  ['workbench.action.toggleMaximizedPanel', 'Toggle Maximized Panel', 'View', null],
  ['workbench.action.toggleStatusbarVisibility', 'Toggle Status Bar Visibility', 'View', null],
  ['workbench.action.toggleZenMode', 'Toggle Zen Mode', 'View', 'Ctrl+K Z'],
  ['workbench.action.toggleFullScreen', 'Toggle Full Screen', 'View', 'F11'],
  ['workbench.action.zoomIn', 'Zoom In', 'View', 'Ctrl+='],
  ['workbench.action.zoomOut', 'Zoom Out', 'View', 'Ctrl+-'],
  ['workbench.action.zoomReset', 'Reset Zoom', 'View', 'Ctrl+NumPad0'],
  ['workbench.action.splitEditor', 'Split Editor', 'View', 'Ctrl+\\'],
  ['workbench.action.editorLayoutTwoColumns', 'Two Columns Editor Layout', 'View', null],
  ['workbench.action.nextEditor', 'Open Next Editor', 'View', 'Ctrl+PageDown'],
  ['workbench.action.previousEditor', 'Open Previous Editor', 'View', 'Ctrl+PageUp'],
  ['workbench.action.closeActiveEditor', 'Close Editor', 'View', 'Ctrl+W'],
  ['workbench.action.closeAllEditors', 'Close All Editors', 'View', 'Ctrl+K Ctrl+W'],
  ['workbench.action.closeOtherEditors', 'Close Other Editors in Group', 'View', null],
  ['workbench.action.reopenClosedEditor', 'Reopen Closed Editor', 'View', 'Ctrl+Shift+T'],
  ['workbench.action.keepEditor', 'Keep Editor', 'View', 'Ctrl+K Enter'],
  ['workbench.action.pinEditor', 'Pin Editor', 'View', 'Ctrl+K Shift+Enter'],
  ['workbench.action.focusActiveEditorGroup', 'Focus Active Editor Group', 'View', null],
  ['workbench.view.explorer', 'Show Explorer', 'View', 'Ctrl+Shift+E'],
  ['workbench.view.search', 'Show Search', 'View', 'Ctrl+Shift+F'],
  ['workbench.view.scm', 'Show Source Control', 'View', 'Ctrl+Shift+G'],
  ['workbench.view.debug', 'Show Run and Debug', 'View', 'Ctrl+Shift+D'],
  ['workbench.view.extensions', 'Show Extensions', 'View', 'Ctrl+Shift+X'],
  ['workbench.actions.view.problems', 'Toggle Problems', 'View', 'Ctrl+Shift+M'],
  ['workbench.action.output.toggleOutput', 'Toggle Output', 'View', 'Ctrl+Shift+U'],
  ['workbench.debug.action.toggleRepl', 'Toggle Debug Console', 'View', 'Ctrl+Shift+Y'],
  ['workbench.action.terminal.toggleTerminal', 'Toggle Terminal', 'View', 'Ctrl+`'],
  ['editor.action.toggleWordWrap', 'Toggle Word Wrap', 'View', 'Alt+Z'],
  ['editor.action.toggleMinimap', 'Toggle Minimap', 'View', null],
  ['editor.action.toggleRenderWhitespace', 'Toggle Render Whitespace', 'View', null],
  // Terminal
  ['workbench.action.terminal.new', 'Create New Terminal', 'Terminal', 'Ctrl+Shift+`'],
  ['workbench.action.terminal.split', 'Split Terminal', 'Terminal', 'Ctrl+Shift+5'],
  ['workbench.action.terminal.kill', 'Kill the Active Terminal Instance', 'Terminal', null],
  ['workbench.action.terminal.clear', 'Clear', 'Terminal', null],
  ['workbench.action.terminal.focus', 'Focus Terminal', 'Terminal', null],
  ['workbench.action.terminal.rename', 'Rename...', 'Terminal', null],
  ['workbench.action.terminal.runSelectedText', 'Run Selected Text In Active Terminal', 'Terminal', null],
  ['workbench.action.terminal.selectDefaultShell', 'Select Default Profile', 'Terminal', null],
  // Tasks / debug
  ['workbench.action.tasks.runTask', 'Run Task', 'Tasks', null],
  ['workbench.action.tasks.build', 'Run Build Task', 'Tasks', 'Ctrl+Shift+B'],
  ['workbench.action.tasks.test', 'Run Test Task', 'Tasks', null],
  ['workbench.action.tasks.restartTask', 'Restart Running Task', 'Tasks', null],
  ['workbench.action.tasks.terminate', 'Terminate Task', 'Tasks', null],
  ['workbench.action.debug.start', 'Start Debugging', 'Debug', 'F5'],
  ['workbench.action.debug.run', 'Start Without Debugging', 'Debug', 'Ctrl+F5'],
  ['workbench.action.debug.stop', 'Stop', 'Debug', 'Shift+F5'],
  ['workbench.action.debug.restart', 'Restart', 'Debug', 'Ctrl+Shift+F5'],
  ['editor.debug.action.toggleBreakpoint', 'Toggle Breakpoint', 'Debug', 'F9'],
  // Developer / extensions
  ['workbench.action.reloadWindow', 'Reload Window', 'Developer', null],
  ['workbench.action.toggleDevTools', 'Toggle Developer Tools', 'Developer', 'Ctrl+Shift+I'],
  ['workbench.extensions.action.showInstalledExtensions', 'Show Installed Extensions', 'Extensions', null],
  // Editor
  ['editor.action.formatDocument', 'Format Document', null, 'Shift+Alt+F'],
  ['editor.action.formatSelection', 'Format Selection', null, 'Ctrl+K Ctrl+F'],
  ['editor.action.organizeImports', 'Organize Imports', null, 'Shift+Alt+O'],
  ['editor.action.commentLine', 'Toggle Line Comment', null, 'Ctrl+/'],
  ['editor.action.blockComment', 'Toggle Block Comment', null, 'Shift+Alt+A'],
  ['editor.action.rename', 'Rename Symbol', null, 'F2'],
  ['editor.action.revealDefinition', 'Go to Definition', null, 'F12'],
  ['editor.action.goToReferences', 'Go to References', null, 'Shift+F12'],
  ['editor.action.peekDefinition', 'Peek Definition', null, 'Alt+F12'],
  ['editor.action.quickFix', 'Quick Fix...', null, 'Ctrl+.'],
  ['editor.action.marker.nextInFiles', 'Go to Next Problem in Files (Error, Warning, Info)', null, 'F8'],
  ['editor.action.marker.prevInFiles', 'Go to Previous Problem in Files (Error, Warning, Info)', null, 'Shift+F8'],
  ['editor.action.triggerSuggest', 'Trigger Suggest', null, 'Ctrl+Space'],
  ['editor.action.showHover', 'Show or Focus Hover', null, 'Ctrl+K Ctrl+I'],
  ['actions.find', 'Find', null, 'Ctrl+F'],
  ['editor.action.startFindReplaceAction', 'Replace', null, 'Ctrl+H'],
  ['editor.action.selectAll', 'Select All', null, 'Ctrl+A'],
  ['editor.action.addSelectionToNextFindMatch', 'Add Selection to Next Find Match', null, 'Ctrl+D'],
  ['editor.action.selectHighlights', 'Select All Occurrences of Find Match', null, 'Ctrl+Shift+L'],
  ['editor.action.insertCursorAbove', 'Add Cursor Above', null, 'Ctrl+Alt+UpArrow'],
  ['editor.action.insertCursorBelow', 'Add Cursor Below', null, 'Ctrl+Alt+DownArrow'],
  ['editor.action.copyLinesDownAction', 'Copy Line Down', null, 'Shift+Alt+DownArrow'],
  ['editor.action.copyLinesUpAction', 'Copy Line Up', null, 'Shift+Alt+UpArrow'],
  ['editor.action.moveLinesUpAction', 'Move Line Up', null, 'Alt+UpArrow'],
  ['editor.action.moveLinesDownAction', 'Move Line Down', null, 'Alt+DownArrow'],
  ['editor.action.deleteLines', 'Delete Line', null, 'Ctrl+Shift+K'],
  ['editor.action.trimTrailingWhitespace', 'Trim Trailing Whitespace', null, 'Ctrl+K Ctrl+X'],
  ['editor.action.transformToUppercase', 'Transform to Uppercase', null, null],
  ['editor.action.transformToLowercase', 'Transform to Lowercase', null, null],
  ['editor.action.sortLinesAscending', 'Sort Lines Ascending', null, null],
  ['editor.action.sortLinesDescending', 'Sort Lines Descending', null, null],
  ['editor.action.indentationToSpaces', 'Convert Indentation to Spaces', null, null],
  ['editor.action.indentationToTabs', 'Convert Indentation to Tabs', null, null],
  ['editor.action.foldAll', 'Fold All', null, 'Ctrl+K Ctrl+0'],
  ['editor.action.unfoldAll', 'Unfold All', null, 'Ctrl+K Ctrl+J'],
  ['workbench.action.editor.changeLanguageMode', 'Change Language Mode', null, 'Ctrl+K M'],
  ['workbench.action.editor.changeEOL', 'Change End of Line Sequence', null, null],
  ['workbench.action.editor.changeEncoding', 'Change File Encoding', null, null],
  ['undo', 'Undo', null, 'Ctrl+Z'],
  ['redo', 'Redo', null, 'Ctrl+Y'],
];

const CURATED_MAP = new Map(CURATED.map(([id, title, category, keybinding]) => [id, { title, category, keybinding }]));

/** A manifest string: plain, or a localized `{value, original}` object; unresolved `%nls.key%` → null. */
function manifestString(v) {
  if (v && typeof v === 'object' && typeof v.value === 'string') v = v.value;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /^%[^%\s]+%$/.test(s)) return null;
  return s;
}

const KEY_NAMES = {
  ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', cmd: 'Cmd', meta: IS_MAC ? 'Cmd' : 'Win', win: 'Win',
  up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow',
  pageup: 'PageUp', pagedown: 'PageDown', enter: 'Enter', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', tab: 'Tab', space: 'Space', home: 'Home', end: 'End', insert: 'Insert',
};

/** "ctrl+shift+alt+f ctrl+k" → "Ctrl+Shift+Alt+F Ctrl+K" (the way VS Code displays keybindings). */
function displayKeybinding(key) {
  if (typeof key !== 'string' || !key.trim()) return null;
  return key
    .trim()
    .split(/\s+/)
    .map((chord) =>
      chord
        .split('+')
        .map((part) => {
          const k = part.toLowerCase();
          if (KEY_NAMES[k]) return KEY_NAMES[k];
          if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
          if (/^numpad/.test(k)) return 'NumPad' + part.slice(6);
          return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join('+')
    )
    .join(' ');
}

/** Curated (Windows/Linux) default keybinding in this platform's form. */
function curatedKeybinding(kb) {
  if (!kb) return null;
  return IS_MAC ? kb.replace(/\bCtrl\+/g, 'Cmd+') : kb;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v && typeof v === 'object' ? [v] : [];
}

/**
 * Build the catalog: Map id → {id, title, category, keybinding, hidden, contributed}.
 * @param {Array<{id: string, packageJSON: any}>} extensions  `vscode.extensions.all`
 */
function buildCatalog(extensions) {
  const out = new Map();
  for (const [id, c] of CURATED_MAP) {
    out.set(id, { id, title: c.title, category: c.category, keybinding: curatedKeybinding(c.keybinding), hidden: false, contributed: false });
  }
  for (const ext of extensions || []) {
    const pj = ext && ext.packageJSON;
    const contributes = pj && pj.contributes;
    if (!contributes || typeof contributes !== 'object') continue;
    for (const c of asArray(contributes.commands)) {
      if (!c || typeof c.command !== 'string' || !c.command) continue;
      const title = manifestString(c.title);
      if (!title) continue;
      const prev = out.get(c.command);
      out.set(c.command, {
        id: c.command,
        title,
        category: manifestString(c.category),
        keybinding: prev ? prev.keybinding : null,
        hidden: prev ? prev.hidden : false,
        contributed: true,
      });
    }
    const menus = contributes.menus && typeof contributes.menus === 'object' ? contributes.menus : null;
    for (const m of asArray(menus && menus.commandPalette)) {
      if (m && typeof m.command === 'string' && (m.when === 'false' || m.when === false)) {
        const e = out.get(m.command);
        if (e) e.hidden = true;
        else out.set(m.command, { id: m.command, title: null, category: null, keybinding: null, hidden: true, contributed: true });
      }
    }
    for (const k of asArray(contributes.keybindings)) {
      if (!k || typeof k.command !== 'string' || k.command.startsWith('-')) continue;
      const key = displayKeybinding(k[PLATFORM_KEY] || k.key);
      const e = out.get(k.command);
      if (key && e && !e.keybinding) e.keybinding = key;
    }
  }
  return out;
}

function labelOf(e) {
  return e.category ? `${e.category}: ${e.title}` : e.title;
}

/** Lower score = better match; null = no match. Every whitespace-separated word must match. */
function matchScore(e, query, words) {
  const label = labelOf(e).toLowerCase();
  const title = e.title.toLowerCase();
  const id = e.id.toLowerCase();
  if (!words.every((w) => label.includes(w) || id.includes(w))) return null;
  if (title.startsWith(query) || label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  if (words.every((w) => label.includes(w))) return 2;
  return 3; // id only
}

/**
 * The titled command list for the Command Palette.
 * @param {Map<string, object>} catalog  from buildCatalog
 * @param {Set<string>|string[]} registered  `vscode.commands.getCommands(true)`
 * @param {{query?: string, max: number}} opts
 * @returns {{id, title, category, keybinding?}[]}
 */
function titledCommands(catalog, registered, { query = '', max }) {
  const reg = registered instanceof Set ? registered : new Set(registered);
  const q = String(query || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const items = [];
  const seen = new Set();
  for (const e of catalog.values()) {
    seen.add(e.id);
    if (e.hidden || !e.title) continue;
    // Contributed commands are listed even before their extension registered them (running one
    // activates the extension, as in VS Code); curated built-ins only when this VS Code has them.
    if (!e.contributed && !reg.has(e.id)) continue;
    items.push(e);
  }
  // Untitled (internal) commands never show in VS Code's palette; still findable by an explicit query.
  if (q) {
    for (const id of reg) {
      if (seen.has(id)) continue;
      items.push({ id, title: id, category: null, keybinding: null, untitled: true });
    }
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  let ranked;
  if (q) {
    ranked = [];
    for (const e of items) {
      const s = matchScore(e, q, words);
      if (s !== null) ranked.push({ e, s: e.untitled ? s + 10 : s });
    }
    ranked.sort((a, b) => a.s - b.s || collator.compare(labelOf(a.e), labelOf(b.e)));
    ranked = ranked.map((r) => r.e);
  } else {
    ranked = items.sort((a, b) => collator.compare(labelOf(a), labelOf(b)) || (a.id < b.id ? -1 : 1));
  }
  return ranked.slice(0, max).map((e) => {
    const o = { id: e.id, title: e.title, category: e.category || null };
    if (e.keybinding) o.keybinding = e.keybinding;
    return o;
  });
}

module.exports = { buildCatalog, titledCommands, displayKeybinding, manifestString, CURATED };
