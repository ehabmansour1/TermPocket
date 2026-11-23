// Phone-side file editor for VS Code windows: fs.read / fs.write / editor.open (§5.2).
// A monospace textarea with a synced line-number gutter, EOL preservation,
// unsaved-change protection, a coding-symbols key row and "Open on PC".

import {
  h, iconBtn, btn, toast, toastError, openView, actionSheet, confirmDialog, promptDialog, setChildren,
  banner, spinner, emptyState, copyText, fmtBytes, basename, dirname, store, clamp, noFocusSteal, haptic, edgeFade, shortPath,
} from './ui.js';
import { icon } from './icons.js';

const FONT_KEY = 'editorFontSize';
const WRAP_KEY = 'editorWrap';
/** Every editor that is open (desktop keeps several alive as tabs) — for the unload guard. */
const liveEditors = new Set();

/** Other editors (the desktop workbench's Monaco models) report unsaved edits through these. */
const dirtySources = new Set();
/** register(() => boolean) → unregister. Used by js/wb/editor-monaco.js. */
export function registerDirtySource(fn) {
  dirtySources.add(fn);
  return () => dirtySources.delete(fn);
}

/** True while any open editor has unsaved edits (beforeunload / "Reload" for an app update). */
export function anyEditorDirty() {
  for (const ed of liveEditors) {
    if (ed.closed) { liveEditors.delete(ed); continue; }
    if (ed.dirty) return true;
  }
  for (const fn of dirtySources) {
    try { if (fn()) return true; } catch { /* ignore */ }
  }
  return false;
}

const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');

const SYMBOLS = ['Tab', '{', '}', '(', ')', '[', ']', ';', ':', '=', '"', "'", '`', '<', '>', '/', '\\', '|', '&', '$', '#', '_', '-', '+', '*', '!', '?'];

/**
 * @param {object} ctx  { conn, vs }
 * @param {{ windowId: string, path: string, line?: number, column?: number,
 *           embed?: {host: HTMLElement, onClosed?: Function}, onDirty?: (dirty: boolean) => void,
 *           onTitle?: (name: string, path: string) => void }} opts
 *   embed → desktop split view: the editor lives in a tab pane (no back button, no symbol row).
 */
export function openEditor(ctx, { windowId, path, line, column, embed, onDirty, onTitle }) {
  const embedded = !!(embed && embed.host);
  let lastDirty = false;
  const { conn, vs } = ctx;
  let doc = null;           // last fs.read result
  let original = '';        // textarea-normalised (LF) text as loaded/saved
  let eol = '\n';
  let indentUnit = '  ';
  let readOnly = false;
  let saving = false;
  let wrap = !!store.get(WRAP_KEY, false);
  let fontSize = clamp(Number(store.get(FONT_KEY, 13)) || 13, 9, 24);
  let lineCount = 0;

  /* ---------------------------------------------------------------- DOM */

  const nameEl = h('div', { class: 'view-title' }, basename(path));
  const dirtyDot = h('span', { class: 'dirty-dot', hidden: true, title: 'Unsaved changes' });
  const subEl = h('div', { class: 'view-sub mono', title: dirname(path) }, shortPath(dirname(path), 36));
  const saveBtn = iconBtn('save', 'Save (fs.write)', () => save(), { keepFocus: true, cls: 'save-btn' });
  const bannerSlot = h('div', { class: 'banner-slot' });
  const gutter = h('pre', { class: 'gutter mono', 'aria-hidden': 'true' });
  const ta = h('textarea', {
    class: 'code-area mono', spellcheck: false, autocomplete: 'off', autocapitalize: 'off',
    autocorrect: 'off', wrap: 'off', 'aria-label': `Contents of ${basename(path)}`,
  });
  const editorEl = h('div', { class: 'editor' }, gutter, ta);
  const body = h('div', { class: 'editor-body' }, spinner('Opening file…'));
  const status = h('div', { class: 'statusbar mono' });
  const symRow = h('div', { class: 'xkeys sym-keys', role: 'toolbar', 'aria-label': 'Code symbols' },
    SYMBOLS.map((s) => {
      const b = h('button', { type: 'button', class: 'xkey' }, s);
      noFocusSteal(b);
      b.addEventListener('click', () => { haptic(4); insertText(s === 'Tab' ? indentUnit : s); });
      return b;
    }));
  edgeFade(symRow);

  const root = h('section', { class: 'editor-view', 'aria-label': 'File editor' },
    h('header', { class: 'view-head' },
      embedded ? null : iconBtn('back', 'Back', () => view.back(), { cls: 'back' }),
      h('div', { class: 'view-titles' }, h('div', { class: 'title-row' }, nameEl, dirtyDot), subEl),
      h('div', { class: 'view-actions' },
        saveBtn,
        iconBtn('external', 'Open on PC', () => openOnPc(), { keepFocus: true }),
        iconBtn('more', 'More', () => showMenu()))),
    bannerSlot, body, symRow, status);

  const view = openView(root, {
    onBack: async () => {
      if (!isDirty()) return true;
      const discard = await confirmDialog({
        title: 'Discard unsaved changes?',
        message: `Your edits to ${basename(path)} haven’t been saved to the PC.`,
        confirmText: 'Discard', cancelText: 'Keep editing', danger: true, iconName: 'alert',
      });
      return discard ? true : false;
    },
    embed,
  });

  applyPrefs();
  symRow.hidden = true;
  if (embedded) symRow.remove(); // a physical keyboard has every symbol

  /* ------------------------------------------------------------- events */

  ta.addEventListener('input', onEdit);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; }, { passive: true });
  for (const ev of ['keyup', 'click', 'select', 'focus']) ta.addEventListener(ev, scheduleStatus);
  ta.addEventListener('focus', () => { if (!readOnly) symRow.hidden = false; });
  ta.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== ta) symRow.hidden = true; }, 150); });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !readOnly) { e.preventDefault(); insertText(indentUnit); }
  });

  load();

  /* -------------------------------------------------------------- data */

  async function load() {
    setChildren(body, spinner('Opening file…'));
    setChildren(bannerSlot);
    try {
      const r = await conn.vsc(windowId, 'fs.read', { path });
      if (view.closed) return;
      doc = r || {};
      if (doc.path && doc.path !== path) {
        path = doc.path; nameEl.textContent = basename(path); subEl.textContent = shortPath(dirname(path), 36); subEl.title = dirname(path);
        if (onTitle) onTitle(basename(path), path);
      }
      if (doc.binary) {
        setChildren(body, emptyState({
          iconName: 'file', title: 'Binary file',
          text: `${fmtBytes(doc.size)} — it can’t be shown as text. Open it on the PC instead.`,
          action: btn('Open on PC', { small: true, iconName: 'external', onClick: () => openOnPc() }),
        }));
        readOnly = true;
        saveBtn.disabled = true;
        renderStatus();
        return;
      }
      const raw = String(doc.content ?? '');
      eol = /\r\n/.test(raw) ? '\r\n' : '\n';
      original = raw.replace(/\r\n?/g, '\n');
      indentUnit = /^\t/m.test(original) && !/^ {2,}\S/m.test(original) ? '\t' : (/^ {4}\S/m.test(original) && !/^ {2}\S/m.test(original) ? '    ' : '  ');
      // A legacy code page (not UTF-8) is shown, but saving would re-encode it: VS Code on the PC edits it.
      readOnly = !!doc.truncated || doc.encoding === 'windows-1252';
      ta.value = original;
      ta.readOnly = readOnly;
      saveBtn.disabled = readOnly;
      setChildren(body, editorEl);
      updateGutter(true);
      renderBanners();
      onEdit();
      renderStatus(); // at once (not on the next frame): EOL / language are known now
      if (line) requestAnimationFrame(() => goToLine(line, column));
    } catch (err) {
      if (view.closed) return;
      setChildren(body, emptyState({
        iconName: 'alert', title: 'Couldn’t open file', text: err.message, tone: 'err',
        action: btn('Retry', { small: true, onClick: load }),
      }));
    }
  }

  function renderBanners() {
    const nodes = [];
    if (doc && doc.truncated) {
      nodes.push(banner(doc.content
        ? `File is larger than 2 MB — showing the first part read-only (${fmtBytes(doc.size)}).`
        : `File is too large to preview here (${fmtBytes(doc.size)}). Open it on the PC instead.`, { tone: 'warn' }));
    }
    if (doc && doc.encoding === 'windows-1252') nodes.push(banner('This file is not UTF-8 (legacy Windows code page) — shown read-only so its characters are not damaged. Edit it on the PC.', { tone: 'warn' }));
    if (doc && doc.isDirty) nodes.push(banner('This file has unsaved changes in VS Code — you’re seeing the editor’s current text. Saving here saves it on the PC.', { tone: 'info' }));
    setChildren(bannerSlot, nodes);
  }

  async function save() {
    if (readOnly || saving || !doc) return;
    if (!conn.online) { toast('Not connected to the PC', { type: 'warn' }); return; }
    saving = true;
    saveBtn.classList.add('busy');
    const value = ta.value;
    const content = eol === '\r\n' ? value.replace(/\n/g, '\r\n') : value;
    try {
      // fs.write replaces the whole file: make sure nobody changed it on the PC (VS Code, another tool)
      // since we loaded it — a long-lived desktop tab would otherwise silently overwrite those changes.
      const fresh = await conn.vsc(windowId, 'fs.read', { path });
      if (fresh && !fresh.binary && !fresh.truncated && norm(fresh.content) !== original) {
        const overwrite = await confirmDialog({
          title: 'File changed on the PC',
          message: `${basename(path)} was changed on the PC since you opened it here. Overwrite those changes with yours?`,
          confirmText: 'Overwrite', cancelText: 'Cancel', danger: true, iconName: 'alert',
        });
        if (!overwrite) return;
      }
      if (view.closed) return;
      await conn.vsc(windowId, 'fs.write', { path, content });
      original = value;
      if (doc.isDirty) { doc.isDirty = false; renderBanners(); }
      onEdit();
      toast(`Saved ${basename(path)}`, { type: 'ok', timeout: 1500 });
    } catch (err) {
      toastError(err, 'Save failed');
    } finally {
      saving = false;
      saveBtn.classList.remove('busy');
    }
  }

  /** Re-read the file when this editor has no unsaved edits (a desktop tab coming back to the front). */
  let refreshing = false;
  async function refreshIfClean() {
    if (!doc || doc.binary || saving || refreshing || isDirty() || view.closed || !conn.online) return;
    refreshing = true;
    try {
      const r = await conn.vsc(windowId, 'fs.read', { path });
      if (!r || view.closed || isDirty() || saving || r.binary || r.truncated !== doc.truncated) return;
      if (norm(r.content) === original && !!r.isDirty === !!doc.isDirty) return;
      const { selectionStart, selectionEnd, scrollTop } = ta;
      doc = r;
      original = norm(r.content);
      ta.value = original;
      ta.setSelectionRange(Math.min(selectionStart, original.length), Math.min(selectionEnd, original.length));
      ta.scrollTop = scrollTop;
      updateGutter(true);
      renderBanners();
      onEdit();
    } catch { /* keep what we have */ } finally {
      refreshing = false;
    }
  }

  async function reload() {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Reload from PC?', message: 'Your unsaved edits on this phone will be lost.', confirmText: 'Reload', danger: true });
      if (!ok) return;
    }
    load();
  }

  async function openOnPc() {
    const pos = cursorPos();
    try {
      await conn.vsc(windowId, 'editor.open', { path, line: pos.line, column: pos.col, preview: false });
      toast(`Opened in ${vs.label(windowId)}`, { type: 'ok', timeout: 1600 });
    } catch (err) { toastError(err, 'Open on PC failed'); }
  }

  /* ------------------------------------------------------------ editing */

  function isDirty() {
    return !!doc && !doc.binary && !readOnly && ta.value !== original;
  }

  function onEdit() {
    const dirty = isDirty();
    if (dirty !== lastDirty) { lastDirty = dirty; if (onDirty) onDirty(dirty); }
    dirtyDot.hidden = !dirty;
    saveBtn.classList.toggle('attention', dirty);
    updateGutter(false);
    scheduleStatus();
  }

  function updateGutter(force) {
    if (wrap) return;
    let n = 1;
    const v = ta.value;
    for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) n++;
    if (!force && n === lineCount) return;
    lineCount = n;
    const parts = new Array(n);
    for (let i = 0; i < n; i++) parts[i] = i + 1;
    gutter.textContent = parts.join('\n') + '\n';
    gutter.style.minWidth = `${String(n).length + 1.5}ch`;
    gutter.scrollTop = ta.scrollTop;
  }

  function insertText(s) {
    if (readOnly) return;
    ta.focus();
    // execCommand keeps the native undo stack; fall back to setRangeText.
    let ok = false;
    try { ok = document.execCommand('insertText', false, s); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, 'end');
      onEdit();
    }
  }

  function cursorPos() {
    const pos = ta.selectionStart || 0;
    const before = ta.value.slice(0, pos);
    const lineNo = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    return { line: lineNo, col };
  }

  function goToLine(ln, col = 1) {
    const v = ta.value;
    let offset = 0;
    for (let i = 1; i < ln; i++) {
      const nx = v.indexOf('\n', offset);
      if (nx === -1) break;
      offset = nx + 1;
    }
    const lineEnd = v.indexOf('\n', offset);
    const target = Math.min(offset + Math.max(0, (col || 1) - 1), lineEnd === -1 ? v.length : lineEnd);
    try { ta.setSelectionRange(target, target); } catch { /* ignore */ }
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || fontSize * 1.5;
    ta.scrollTop = Math.max(0, (ln - 1) * lh - ta.clientHeight / 3);
    gutter.scrollTop = ta.scrollTop;
    flashLine(ln, lh);
    scheduleStatus();
  }

  function flashLine(ln, lh) {
    const mark = h('div', { class: 'line-flash' });
    mark.style.top = `${(ln - 1) * lh - ta.scrollTop + parseFloat(getComputedStyle(ta).paddingTop || '0')}px`;
    mark.style.height = `${lh}px`;
    editorEl.append(mark);
    setTimeout(() => mark.remove(), 1400);
  }

  let statusRaf = 0;
  function scheduleStatus() {
    if (statusRaf) return;
    statusRaf = requestAnimationFrame(() => { statusRaf = 0; renderStatus(); });
  }

  function renderStatus() {
    if (!doc) { status.textContent = ''; return; }
    const parts = [];
    if (!doc.binary) {
      const p = cursorPos();
      parts.push(`Ln ${p.line}, Col ${p.col}`);
    }
    if (doc.languageId) parts.push(doc.languageId);
    parts.push(fmtBytes(doc.size));
    if (!doc.binary) parts.push(eol === '\r\n' ? 'CRLF' : 'LF');
    if (readOnly) parts.push('read-only');
    setChildren(status, h('span', null, parts.join('  ·  ')), isDirty() ? h('span', { class: 'status-dirty' }, '● modified') : null);
  }

  function applyPrefs() {
    ta.style.fontSize = `${fontSize}px`;
    gutter.style.fontSize = `${fontSize}px`;
    ta.wrap = wrap ? 'soft' : 'off';
    editorEl.classList.toggle('wrapped', wrap);
    gutter.hidden = wrap;
    if (!wrap) updateGutter(true);
  }

  function showMenu() {
    actionSheet({
      title: basename(path),
      subtitle: path,
      actions: [
        { label: 'Save', iconName: 'save', disabled: readOnly, onSelect: save },
        { label: 'Open on PC at cursor', iconName: 'external', onSelect: openOnPc },
        { label: 'Go to line…', iconName: 'hash', disabled: !doc || doc.binary, onSelect: async () => {
          const v = await promptDialog({ title: 'Go to line', inputMode: 'numeric', placeholder: `1 – ${lineCount || 1}`, confirmText: 'Go',
            validate: (s) => (/^\d+$/.test(s.trim()) ? null : 'Enter a line number') });
          if (v != null) goToLine(parseInt(v, 10));
        } },
        { label: wrap ? 'Disable word wrap' : 'Enable word wrap', iconName: 'wrap', onSelect: () => { wrap = !wrap; store.set(WRAP_KEY, wrap); applyPrefs(); } },
        { label: 'Larger text', iconName: 'plus', onSelect: () => { fontSize = clamp(fontSize + 1, 9, 24); store.set(FONT_KEY, fontSize); applyPrefs(); } },
        { label: 'Smaller text', iconName: 'minus', onSelect: () => { fontSize = clamp(fontSize - 1, 9, 24); store.set(FONT_KEY, fontSize); applyPrefs(); } },
        { label: 'Reload from PC', iconName: 'refresh', onSelect: reload },
        { label: 'Copy path', iconName: 'copy', onSelect: async () => { toast((await copyText(path)) ? 'Path copied' : 'Copy failed'); } },
        { label: 'Copy contents', iconName: 'clipboard', disabled: !doc || doc.binary, onSelect: async () => { toast((await copyText(ta.value)) ? 'Contents copied' : 'Copy failed'); } },
        { label: 'Close in VS Code', iconName: 'x', onSelect: async () => {
          try { await conn.vsc(windowId, 'editor.close', { path }); toast('Closed in VS Code'); } catch (err) { toastError(err); }
        } },
      ],
    });
  }

  const api = {
    /** Deck tab brought to the front: pick up changes made on the PC meanwhile (if no local edits). */
    onActivate: () => { refreshIfClean(); },
    close: () => view.close(),
    back: () => (view.embedded ? view.back() : (view.back(), true)),
    focus: () => { if (!view.closed && doc && !doc.binary && document.activeElement !== ta) ta.focus({ preventScroll: true }); },
    /** Jump to a position (opening a problem / tab of a file that is already open). */
    goTo: (ln, col) => { if (doc && !doc.binary && ln) goToLine(ln, col); },
    get dirty() { return isDirty(); },
    get closed() { return view.closed; },
  };
  liveEditors.add(api);
  return api;
}
