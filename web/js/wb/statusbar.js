// Status bar items (builder C), laid out like VS Code's (the shell sorts each side by `order`,
// ascending left → right):
//   left:  [remote "TermPocket"] [branch*] [sync ↓↑] [errors / warnings]
//   right: [Ln, Col (n selected)] [Spaces: n] [UTF-8] [CRLF] [language mode] [bell]
// Texts use VS Code's "$(icon) text" syntax (rendered by the shell). Data: the shared problems and
// git models, wb.editors.active() (+ onActiveChange / onCursorChange) and the connection state.

import { ensureCss, useShell, languageName, registerCommand, once, appOn } from './c-common.js';
import { problemsModel } from './problems.js';
import { gitModel } from './scm.js';

const ENC_NAMES = { utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', 'windows-1252': 'Windows 1252', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE' };

export function register(wb) {
  return once(wb, 'statusbar', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  const conn = wb.app.conn;
  const problems = problemsModel(wb);
  const git = gitModel(wb);
  const items = {};
  const add = (spec) => {
    try { return wb.status.add(spec); } catch (err) { console.warn('[wb] status.add', spec.id, err); return { set() {}, remove() {} }; }
  };
  const run = (id) => { try { return wb.commands.run(id); } catch { return undefined; } };

  /* ---------------------------------------------------------- left */

  items.remote = add({
    id: 'status.host', side: 'left', order: 0, kind: 'remote',
    text: '$(remote) TermPocket', tooltip: 'TermPocket', onClick: () => remoteMenu(),
  });
  items.branch = add({ id: 'status.scm.branch', side: 'left', order: 10, text: '', tooltip: '', onClick: () => run('workbench.view.scm') });
  items.sync = add({ id: 'status.scm.sync', side: 'left', order: 11, text: '', tooltip: '', onClick: () => run('workbench.view.scm') });
  items.problems = add({
    id: 'status.problems', side: 'left', order: 20, text: '$(error) 0  $(warning) 0', tooltip: 'No Problems',
    onClick: () => { try { wb.panel.toggle('problems'); } catch { /* ignore */ } },
  });

  /* ---------------------------------------------------------- right */

  items.position = add({
    id: 'status.editor.selection', side: 'right', order: 10, text: '', tooltip: 'Go to Line/Column',
    onClick: () => { try { wb.quickInput(':'); } catch { /* ignore */ } },
  });
  items.indent = add({ id: 'status.editor.indentation', side: 'right', order: 20, text: '', tooltip: 'Select Indentation' });
  items.encoding = add({ id: 'status.editor.encoding', side: 'right', order: 30, text: '', tooltip: 'Select Encoding' });
  items.eol = add({ id: 'status.editor.eol', side: 'right', order: 40, text: '', tooltip: 'Select End of Line Sequence' });
  items.language = add({ id: 'status.editor.mode', side: 'right', order: 50, text: '', tooltip: 'Select Language Mode' });
  items.bell = add({
    id: 'status.notifications', side: 'right', order: 100, text: '$(bell)', tooltip: 'No Notifications',
    onClick: () => { try { if (typeof wb.notify === 'function') wb.notify('No new notifications', { severity: 'info', timeout: 2500 }); } catch { /* ignore */ } },
  });

  /* ---------------------------------------------------------- updates */

  function renderRemote() {
    const online = conn.online;
    const host = (conn.info && conn.info.hostname) || 'the PC';
    let win = '';
    try {
      const w = wb.app.vs && wb.windowId ? wb.app.vs.get(wb.windowId) : null;
      win = w ? wb.app.vs.label(w) : '';
    } catch { /* ignore */ }
    items.remote.set({
      text: online ? '$(remote) TermPocket' : '$(sync~spin) TermPocket',
      tooltip: online
        ? `TermPocket — connected to ${host}${win ? `\nVS Code window: ${win}` : '\nNo VS Code window selected'}`
        : 'TermPocket — reconnecting to the PC…',
    });
  }

  function safeActive() {
    try { return wb.editors && typeof wb.editors.active === 'function' ? wb.editors.active() : null; } catch { return null; }
  }

  function renderGit() {
    const a = safeActive();
    const r = a && a.path ? git.repoFor(a.path) : git.repos[0];
    if (!r || !(git.status && git.status.available)) {
      items.branch.set({ text: '', tooltip: '' });
      items.sync.set({ text: '', tooltip: '' });
      return;
    }
    const name = r.branch || (r.commit ? r.commit.slice(0, 8) : '');
    const dirty = r.changes.some((c) => !c.staged) ? '*' : r.changes.some((c) => c.staged) ? '+' : '';
    const repoName = splitName(r.root);
    items.branch.set({
      text: `$(${r.detached ? 'git-commit' : 'git-branch'}) ${name}${dirty}`,
      tooltip: `${repoName} (Git) - ${name}${dirty ? ', Uncommitted changes' : ''}`,
    });
    if (r.upstream) {
      const behind = r.behind || 0;
      const ahead = r.ahead || 0;
      items.sync.set({
        text: behind || ahead ? `$(sync) ${behind}$(arrow-down) ${ahead}$(arrow-up)` : '$(sync)',
        tooltip: behind || ahead
          ? `${repoName} (Git) - Synchronize Changes: ${behind} incoming, ${ahead} outgoing (${r.upstream})`
          : `${repoName} (Git) - In sync with ${r.upstream}`,
      });
    } else {
      items.sync.set({ text: name ? '$(cloud-upload)' : '', tooltip: name ? `${repoName} (Git) - Publish Branch (do it in VS Code on the PC)` : '' });
    }
  }

  function renderProblems() {
    const c = problems.counts();
    const parts = [];
    if (c.errors) parts.push(`Errors: ${c.errors}`);
    if (c.warnings) parts.push(`Warnings: ${c.warnings}`);
    if (c.infos) parts.push(`Infos: ${c.infos}`);
    items.problems.set({
      text: `$(error) ${c.errors}  $(warning) ${c.warnings}${c.infos ? `  $(info) ${c.infos}` : ''}`,
      tooltip: parts.length ? parts.join(', ') : 'No Problems',
    });
  }

  function renderEditor(a = safeActive()) {
    if (!a || !a.path) {
      for (const k of ['position', 'indent', 'encoding', 'eol', 'language']) items[k].set({ text: '' });
      return;
    }
    const sel = Number(a.selectionLength || 0);
    const cursors = Number(a.cursorCount || a.selections || 0);
    items.position.set({
      text: cursors > 1 ? `${cursors} selections${sel ? ` (${sel} characters selected)` : ''}` : `Ln ${a.line || 1}, Col ${a.column || 1}${sel ? ` (${sel} selected)` : ''}`,
    });
    items.indent.set({ text: a.tabSize ? (a.insertSpaces === false ? `Tab Size: ${a.tabSize}` : `Spaces: ${a.tabSize}`) : '' });
    const enc = a.encoding ? ENC_NAMES[a.encoding] || String(a.encoding).toUpperCase() : 'UTF-8';
    items.encoding.set({ text: enc });
    const eol = a.eol === 'CRLF' || a.eol === '\r\n' ? 'CRLF' : a.eol === 'LF' || a.eol === '\n' ? 'LF' : '';
    items.eol.set({ text: eol });
    const lang = a.languageName || languageName(a.languageId);
    items.language.set({
      text: lang || '',
      tooltip: lang ? `Select Language Mode${a.languageId ? ` (${a.languageId})` : ''}` : 'Select Language Mode',
    });
  }

  function remoteMenu() {
    const host = (conn.info && conn.info.hostname) || 'the PC';
    const opts = [
      { label: conn.online ? `Reconnect to ${host}` : 'Reconnect Now', description: conn.online ? 'TermPocket' : 'the connection is down', run: () => conn.reconnectNow() },
      { label: 'Switch VS Code Window...', run: () => run('workbench.action.switchWindow') },
      { label: 'Show All Commands', description: 'Ctrl+Shift+P', run: () => wb.quickInput('>') },
    ];
    Promise.resolve(wb.quickInput({ items: opts, placeholder: 'Select an option to open a Remote Window' })).then((it) => {
      if (it && typeof it.run === 'function') it.run();
    }).catch(() => {});
  }

  problems.on(renderProblems);
  git.on(renderGit);
  appOn(wb, conn, 'status', renderRemote);
  appOn(wb, conn, 'ready', renderRemote);
  try { if (wb.app.vs) appOn(wb, wb.app.vs, 'windows', renderRemote); } catch { /* ignore */ }
  try { wb.onWindowChange(() => { renderRemote(); renderGit(); renderEditor(); }); } catch { /* ignore */ }
  const ed = wb.editors || {};
  try { if (typeof ed.onActiveChange === 'function') ed.onActiveChange((a) => { renderEditor(a && typeof a === 'object' ? a : undefined); renderGit(); }); } catch { /* ignore */ }
  try { if (typeof ed.onCursorChange === 'function') ed.onCursorChange(() => renderEditor()); } catch { /* ignore */ }

  renderRemote();
  renderProblems();
  renderGit();
  renderEditor();

  registerCommand(wb, 'workbench.action.focusStatusBar', 'Focus Status Bar', () => {
    const el = document.querySelector('.wb-statusbar .wb-status-item:not([hidden])');
    if (el) el.focus();
  }, { category: 'View' });
  return { items };
}

function splitName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? s : s.slice(i + 1);
}
