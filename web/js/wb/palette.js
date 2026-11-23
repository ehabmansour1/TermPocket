// Quick input for the desktop workbench (builder C), VS Code's centred quick pick:
//   * Quick Open (Ctrl+P / command centre): files of the window via fs.search, fuzzy scored with
//     highlighted matches, "recently opened" on top, `name:line[:col]` jumps to a position;
//   * Command Palette (Ctrl+Shift+P / F1, prefix ">"): VS Code's commands with human titles,
//     categories and keybindings (commands.list {withTitles}) plus the workbench's own commands,
//     "recently used" on top (localStorage); Enter runs commands.run in that VS Code window, or the
//     local workbench command;
//   * Go to Line (Ctrl+G, prefix ":"), "?" lists the prefixes, "@" explains Go to Symbol;
//   * generic pickers / input boxes for the other workbench parts:
//       wb.quickInput({items, placeholder})   → chosen item | undefined
//       wb.quickInput({input:true, prompt, value, validate}) → string | undefined
//
// Installed with wb.setQuickInput(). Remote strings only reach the DOM as text nodes.

import { h, basename } from '../ui.js';
import {
  ensureCss, useShell, cicon, fileIcon, fuzzyScore, highlighted, keybindingLabel, registerCommand, bindKey,
  windowFolders, relativeTo, local, splitDirBase, errText, reportError, confirm,
  once,
} from './c-common.js';

/**
 * VS Code commands that take the VS Code window (and with it this page's connection to it) away, or
 * stop at a modal prompt on the unattended PC: asked first (the classic Code tab did the same).
 */
const DISRUPTIVE = new Map([
  ['workbench.action.reloadWindow', 'Reload the VS Code window on the PC? Its connection to TermPocket restarts.'],
  ['workbench.action.closeWindow', 'Close the VS Code window on the PC? It cannot be reopened from here.'],
  ['workbench.action.quit', 'Quit VS Code on the PC? It cannot be restarted from here.'],
  ['workbench.action.closeFolder', 'Close the folder in the VS Code window on the PC?'],
  ['workbench.action.reloadWindowWithExtensionsDisabled', 'Reload the VS Code window on the PC with extensions disabled? TermPocket stops working in it.'],
  ['workbench.action.restartExtensionHost', 'Restart the extension host of the VS Code window on the PC? The connection restarts.'],
  ['workbench.extensions.action.disableAll', 'Disable all extensions in the VS Code window on the PC? TermPocket stops working in it.'],
]);

const RECENT_CMDS_KEY = 'recentCommands';
const RECENT_FILES_KEY = 'recentFiles';
const RECENT_CMDS_MAX = 50;
const RECENT_FILES_MAX = 40;
const COMMANDS_TTL_MS = 5 * 60 * 1000;
const SEARCH_DEBOUNCE_MS = 140;
const CALL_TIMEOUT_MS = 15000;
const ROW_H = 22;
const ROW_H2 = 44;
const OVERSCAN = 8;

/** wb.call with a deadline (a stuck window must never leave the palette spinning forever). */
function callT(wb, m, p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`VS Code did not answer ${m} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve().then(() => wb.call(m, p)).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* =================================================================== widget */

let current = null; // the open quick input (only one at a time)

/**
 * Open the quick-input widget.
 * spec:
 *   host           element to append to (the shell's overlay layer), default <body>
 *   value, placeholder, title, selectValue
 *   provider(query, ctl) → { items, message?, tone?, busy? } | Promise
 *   onAccept(item, query, ctl) → truthy to keep the widget open
 *   acceptValue(query) → value to resolve with on Enter (input boxes; null = invalid)
 *   onValue(query, ctl)  called on every change
 *   repeatCombo     the shortcut that opened it: pressing it again moves down (like VS Code)
 * Items: { label, labelHl?, description?, descHl?, detail?, icon?: Node|() => Node, keybinding?,
 *          separator?: 'recently used', buttons?: [{icon, title, run(item, ctl)}], disabled? }
 * → Promise resolving with what ctl.close(value) got (undefined on Escape / click outside).
 */
function openWidget(spec) {
  ensureCss();
  if (current) current.close(undefined, { silent: true });
  const host = spec.host && spec.host.isConnected ? spec.host : document.body;
  const prevFocus = document.activeElement;
  let resolveP;
  const done = new Promise((r) => { resolveP = r; });

  const input = h('input', {
    class: 'wbc-qi-input', type: 'text', spellcheck: false, autocomplete: 'off', autocapitalize: 'off',
    'aria-label': spec.placeholder || 'Type to narrow down results.', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'wbc-qi-list', 'aria-autocomplete': 'list', placeholder: spec.placeholder || '',
  });
  const count = h('span', { class: 'wbc-qi-count' });
  const titleEl = spec.title ? h('div', { class: 'wbc-qi-title' }, spec.title) : null;
  const progress = h('div', { class: 'wbc-qi-progress', 'aria-hidden': 'true' });
  const message = h('div', { class: 'wbc-qi-message', hidden: true, role: 'status' });
  const inner = h('div', { style: { position: 'relative' } });
  const list = h('div', { class: 'wbc-qi-list', id: 'wbc-qi-list', role: 'listbox', tabIndex: -1 }, inner);
  const box = h('div', { class: 'wbc-qi', role: 'dialog', 'aria-label': spec.title || 'Quick input' },
    titleEl,
    h('div', { class: 'wbc-qi-head' }, h('div', { class: 'wbc-qi-input-wrap' }, input, count)),
    progress, message, list);
  const backdrop = h('div', { class: 'wbc-qi-backdrop' });
  host.append(backdrop, box);
  placeBox();

  let items = [];
  let active = -1;
  let seq = 0;
  let closed = false;
  let rowH = ROW_H;
  let rafScroll = 0;

  const ctl = {
    get value() { return input.value; },
    setValue(v, { select = false } = {}) {
      input.value = v;
      if (select) input.select(); else input.setSelectionRange(v.length, v.length);
      refresh();
    },
    setMessage, setBusy, refresh, close,
    setPlaceholder(p) { input.placeholder = p || ''; input.setAttribute('aria-label', p || 'Quick input'); },
    get activeItem() { return items[active] || null; },
    get el() { return box; },
  };

  function placeBox() {
    // Just under the title bar, like VS Code's quick input.
    const tb = document.querySelector('.wb-titlebar');
    const r = tb && tb.getClientRects().length ? tb.getBoundingClientRect() : null;
    box.style.top = `${Math.round((r ? r.bottom : 0) + 6)}px`;
  }

  function setMessage(text, tone = '') {
    message.hidden = !text;
    message.className = `wbc-qi-message${tone ? ` ${tone}` : ''}`;
    message.textContent = text || '';
  }
  function setBusy(on) { progress.classList.toggle('on', !!on); }

  function setItems(next, keepActive) {
    const prevKey = keepActive && items[active] ? items[active].key : null;
    items = Array.isArray(next) ? next.filter(Boolean) : [];
    rowH = items.some((i) => i.detail) ? ROW_H2 : ROW_H;
    let idx = prevKey ? items.findIndex((i) => i.key && i.key === prevKey) : -1;
    if (idx < 0) idx = items.findIndex((i) => !i.disabled);
    active = idx;
    inner.style.height = `${items.length * rowH}px`;
    if (!keepActive) list.scrollTop = 0;
    list.hidden = !items.length;
    count.textContent = '';
    paint();
  }

  function paint() {
    const top = list.scrollTop;
    const viewH = list.clientHeight || 440;
    const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const end = Math.min(items.length, Math.ceil((top + viewH) / rowH) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(renderItem(items[i], i));
    inner.replaceChildren(frag);
    input.setAttribute('aria-activedescendant', active >= 0 ? `wbc-qi-item-${active}` : '');
  }

  function renderItem(it, i) {
    const row = h('div', {
      class: ['wbc-qi-item', rowH === ROW_H2 && 'two', i === active && 'active', it.separator && i > 0 && 'sep-top'],
      role: 'option', id: `wbc-qi-item-${i}`, 'aria-selected': i === active ? 'true' : 'false',
      style: { position: 'absolute', left: '0', right: '0', top: `${i * rowH}px` },
    });
    if (it.icon) {
      const ic = typeof it.icon === 'function' ? it.icon() : it.icon;
      if (ic) row.append(h('span', { class: 'wbc-qi-icon' }, ic));
    }
    const line = h('div', { class: 'wbc-qi-line' },
      h('span', { class: 'wbc-qi-label' }, highlighted(it.label, it.labelHl)),
      it.description ? h('span', { class: 'wbc-qi-desc' }, highlighted(it.description, it.descHl)) : null);
    row.append(h('div', { class: 'wbc-qi-main' }, line,
      it.detail ? h('div', { class: 'wbc-qi-detail' }, highlighted(it.detail, it.detailHl)) : null));
    const right = h('div', { class: 'wbc-qi-right' });
    if (it.separator) right.append(h('span', { class: 'wbc-qi-sep-label' }, it.separator));
    if (it.keybinding) right.append(keybindingLabel(it.keybinding));
    if (Array.isArray(it.buttons) && it.buttons.length) {
      const btns = h('div', { class: 'wbc-qi-btns' });
      for (const b of it.buttons) {
        const bt = h('button', { type: 'button', class: 'wbc-action', title: b.title, 'aria-label': b.title }, cicon(b.icon || 'close'));
        bt.addEventListener('mousedown', (e) => e.preventDefault());
        bt.addEventListener('click', (e) => { e.stopPropagation(); try { b.run(it, ctl); } catch (err) { console.error(err); } });
        btns.append(bt);
      }
      right.append(btns);
    }
    if (right.childNodes.length) row.append(right);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('mousemove', () => { if (active !== i) setActive(i, false); });
    row.addEventListener('click', () => { setActive(i, false); accept(); });
    return row;
  }

  function setActive(i, reveal = true) {
    if (!items.length) { active = -1; return; }
    active = Math.max(0, Math.min(items.length - 1, i));
    if (reveal) {
      const t = active * rowH;
      if (t < list.scrollTop) list.scrollTop = t;
      else if (t + rowH > list.scrollTop + list.clientHeight) list.scrollTop = t + rowH - list.clientHeight;
    }
    paint();
  }

  function move(delta, wrap = true) {
    if (!items.length) return;
    let i = active < 0 ? (delta > 0 ? -1 : items.length) : active;
    i += delta;
    if (wrap && Math.abs(delta) === 1) i = (i + items.length) % items.length;
    setActive(i);
  }

  async function accept() {
    if (spec.acceptValue) {
      const v = spec.acceptValue(input.value);
      if (v !== null && v !== undefined) close(v);
      return;
    }
    const it = items[active];
    if (!it || it.disabled) return;
    try {
      const keep = spec.onAccept ? await spec.onAccept(it, input.value, ctl) : false;
      if (!keep && !closed) close(it.value !== undefined ? it.value : it);
    } catch (err) {
      setMessage(errText(err), 'err');
    }
  }

  async function refresh({ keepActive = false } = {}) {
    const my = ++seq;
    const q = input.value;
    if (spec.onValue) spec.onValue(q, ctl);
    let r;
    try {
      r = spec.provider(q, ctl);
      if (r && typeof r.then === 'function') {
        setBusy(true);
        r = await r;
      }
    } catch (err) {
      r = { items: [], message: errText(err), tone: 'err' };
    }
    if (my !== seq || closed) return;
    setBusy(!!(r && r.busy));
    setMessage(r && r.message ? r.message : '', r && r.tone);
    setItems(r && r.items, keepActive);
  }
  ctl.refresh = (o) => refresh(o);

  const comboOfKey = (e) => {
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : String(e.key || '').toLowerCase();
    return [...parts, k].join('+');
  };
  const onKey = (e) => {
    if (closed) return;
    const k = e.key;
    const combo = comboOfKey(e);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { stop(); close(undefined); return; }
    if (k === 'ArrowDown' || combo === 'ctrl+n') { stop(); move(1); return; }
    if (k === 'ArrowUp' || combo === 'ctrl+shift+n') { stop(); move(-1); return; }
    if (spec.repeatCombo && combo === spec.repeatCombo) { stop(); move(1); return; }
    if (k === 'PageDown') { stop(); move(Math.max(1, Math.floor(list.clientHeight / rowH) - 1), false); return; }
    if (k === 'PageUp') { stop(); move(-Math.max(1, Math.floor(list.clientHeight / rowH) - 1), false); return; }
    if (e.ctrlKey && (k === 'Home' || k === 'End')) { stop(); setActive(k === 'Home' ? 0 : items.length - 1); return; }
    if (k === 'Enter') { stop(); accept(); return; }
    if (k === 'Tab') { stop(); return; }
    // Everything else types into the box; workbench shortcuts must not fire behind the widget.
    if (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(k)) {
      if (['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'ctrl+arrowleft', 'ctrl+arrowright',
        'ctrl+shift+arrowleft', 'ctrl+shift+arrowright', 'ctrl+backspace', 'ctrl+delete'].includes(combo)) { e.stopPropagation(); return; }
      stop();
    }
  };
  // Capture on window so the shell's key bindings never see keys meant for the quick input.
  window.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => refresh());
  list.addEventListener('scroll', () => {
    if (rafScroll) return;
    rafScroll = requestAnimationFrame(() => { rafScroll = 0; paint(); });
  });
  backdrop.addEventListener('mousedown', (e) => { e.preventDefault(); close(undefined); });
  input.addEventListener('blur', () => {
    // Focus moved elsewhere (another window, devtools): close like VS Code does.
    setTimeout(() => { if (!closed && !box.contains(document.activeElement) && document.hasFocus()) close(undefined); }, 0);
  });
  const onResize = () => { placeBox(); paint(); };
  window.addEventListener('resize', onResize);

  function close(value, { silent = false } = {}) {
    if (closed) return;
    closed = true;
    seq++;
    if (current === api) current = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (rafScroll) cancelAnimationFrame(rafScroll);
    box.remove();
    backdrop.remove();
    if (!silent && value === undefined && prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    resolveP(value);
  }

  const api = { close, ctl };
  current = api;
  input.value = spec.value || '';
  input.focus({ preventScroll: true });
  if (spec.selectValue) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
  refresh();
  return done;
}

/* =================================================================== generic pick / input */

function pick(opts, host) {
  const source = opts.items;
  return openWidget({
    host,
    value: opts.value || '',
    placeholder: opts.placeholder || '',
    title: opts.title,
    selectValue: true,
    provider: async (q) => {
      const all = typeof source === 'function' ? await source(q) : source;
      const out = [];
      for (const it of all || []) {
        if (!it) continue;
        const label = String(it.label ?? '');
        const base = { ...it, value: it, label, icon: typeof it.icon === 'string' ? () => cicon(it.icon) : it.icon };
        if (!q) { out.push(base); continue; }
        const m = fuzzyScore(q, label);
        const d = !m && opts.matchOnDescription !== false && it.description ? fuzzyScore(q, String(it.description)) : null;
        const dt = !m && !d && opts.matchOnDetail && it.detail ? fuzzyScore(q, String(it.detail)) : null;
        if (!m && !d && !dt && !it.alwaysShow) continue;
        out.push({ ...base, labelHl: m ? m.matches : [], descHl: d ? d.matches : [], detailHl: dt ? dt.matches : [], _s: m ? m.score + 100 : (d || dt || { score: 0 }).score });
      }
      if (q) out.sort((a, b) => b._s - a._s);
      return { items: out, message: out.length ? '' : (q ? 'No matching results' : (opts.emptyMessage || '')) };
    },
  });
}

function inputBox(opts, host) {
  const hint = "Press 'Enter' to confirm or 'Escape' to cancel";
  return openWidget({
    host,
    value: opts.value || '',
    placeholder: opts.placeholder || '',
    title: opts.title,
    selectValue: true,
    provider: (q) => {
      const problem = opts.validate ? opts.validate(q) : null;
      if (problem) return { items: [], message: problem, tone: 'err' };
      return { items: [], message: opts.prompt ? `${opts.prompt} (${hint})` : hint };
    },
    acceptValue: (q) => (opts.validate && opts.validate(q) ? null : q),
  });
}

/* =================================================================== quick access */

function createQuickAccess(wb) {
  const commandsCache = new Map(); // windowId → { at, items, error, promise }

  /* ---------------------------------------------------------- recent files (per window folder) */
  const winKey = () => String(wb.windowKey || windowFolders(wb)[0] || wb.windowId || 'none').toLowerCase();
  const isFilePath = (p) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('/') || p.startsWith('\\\\');
  function recentFiles() {
    const out = [];
    const seen = new Set();
    const push = (p) => {
      if (typeof p !== 'string' || !isFilePath(p)) return;
      const k = p.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(p);
    };
    try { if (wb.editors && typeof wb.editors.recent === 'function') for (const p of wb.editors.recent() || []) push(p); } catch { /* ignore */ }
    const all = local.get(RECENT_FILES_KEY, {});
    const l = all && typeof all === 'object' ? all[winKey()] : null;
    if (Array.isArray(l)) for (const p of l) push(p);
    return out.slice(0, RECENT_FILES_MAX);
  }
  function noteRecentFile(path) {
    if (!path || !isFilePath(path)) return;
    const all = local.get(RECENT_FILES_KEY, {}) || {};
    const k = winKey();
    const l = (Array.isArray(all[k]) ? all[k] : []).filter((p) => p.toLowerCase() !== path.toLowerCase());
    l.unshift(path);
    all[k] = l.slice(0, RECENT_FILES_MAX);
    const keys = Object.keys(all);
    if (keys.length > 30) delete all[keys[0]];
    local.set(RECENT_FILES_KEY, all);
  }
  const hidden = new Set(); // removed from "recently opened" in this session
  function forgetRecentFile(path) {
    hidden.add(path.toLowerCase());
    const all = local.get(RECENT_FILES_KEY, {}) || {};
    const k = winKey();
    if (Array.isArray(all[k])) { all[k] = all[k].filter((p) => p !== path); local.set(RECENT_FILES_KEY, all); }
    try { if (wb.editors && typeof wb.editors.forgetRecent === 'function') wb.editors.forgetRecent(path); } catch { /* ignore */ }
  }
  try {
    if (wb.editors && typeof wb.editors.onActiveChange === 'function') {
      wb.editors.onActiveChange((a) => { if (a && a.path) { hidden.delete(a.path.toLowerCase()); noteRecentFile(a.path); } });
    }
  } catch (err) { console.warn('[wb] palette: onActiveChange', err); }

  /* ---------------------------------------------------------- recent commands (global) */
  const recentCommands = () => {
    const l = local.get(RECENT_CMDS_KEY, []);
    return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : [];
  };
  function noteRecentCommand(id) {
    const l = recentCommands().filter((x) => x !== id);
    l.unshift(id);
    local.set(RECENT_CMDS_KEY, l.slice(0, RECENT_CMDS_MAX));
  }

  /* ---------------------------------------------------------- commands */

  function localCommands() {
    let list = [];
    try { list = wb.commands && typeof wb.commands.list === 'function' ? wb.commands.list() || [] : []; } catch (err) { console.warn('[wb] commands.list', err); }
    return list.filter((x) => x && x.id && x.title && !x.hidden).map((x) => ({
      id: x.id, title: String(x.title), category: x.category || null, keybinding: x.keybinding || null, local: true,
    }));
  }

  function loadRemoteCommands(force = false) {
    const wid = wb.windowId;
    if (!wid) return Promise.resolve({ items: [], error: 'No VS Code window is selected' });
    const c = commandsCache.get(wid);
    if (c && c.promise) return c.promise;
    if (c && !force && Date.now() - c.at < COMMANDS_TTL_MS && !c.error) return Promise.resolve(c);
    const entry = { at: Date.now(), items: c ? c.items : [], error: null, promise: null };
    entry.promise = (async () => {
      try {
        const r = await callT(wb, 'commands.list', { withTitles: true, max: 5000 });
        const arr = Array.isArray(r) ? r : [];
        entry.items = arr.map((x) => (typeof x === 'string'
          ? { id: x, title: x, category: null, keybinding: null } // older extension: ids only
          : { id: String(x.id), title: String(x.title || x.id), category: x.category ? String(x.category) : null, keybinding: x.keybinding ? String(x.keybinding) : null }));
        entry.error = null;
      } catch (err) {
        entry.error = errText(err);
      } finally {
        entry.at = Date.now();
        entry.promise = null;
      }
      return entry;
    })();
    commandsCache.set(wid, entry);
    return entry.promise;
  }

  const commandLabel = (c) => (c.category ? `${c.category}: ${c.title}` : c.title);

  function commandItems(query, remote, remoteErr) {
    const q = query.trim();
    const byId = new Map();
    for (const c of remote) byId.set(c.id, c);
    for (const c of localCommands()) {
      // A workbench command acts HERE (palette, panel, editor of this page): it wins over VS Code's.
      const r = byId.get(c.id);
      byId.set(c.id, { ...c, keybinding: c.keybinding || (r && r.keybinding) || null });
    }
    const recent = recentCommands();
    const recentRank = new Map(recent.map((id, i) => [id, i]));
    const scored = [];
    for (const c of byId.values()) {
      const label = commandLabel(c);
      let m = null;
      if (q) {
        m = fuzzyScore(q, label);
        if (!m && c.category) {
          // "toggle panel" finds "View: Toggle Panel Visibility" by its title too.
          const t = fuzzyScore(q, c.title);
          if (t) m = { score: t.score, matches: t.matches.map((i) => i + c.category.length + 2) };
        }
        if (!m && q.includes('.')) {
          const byIdM = fuzzyScore(q, c.id);
          if (byIdM) m = { score: byIdM.score - 5, matches: [] };
        }
        if (!m) continue;
      }
      scored.push({ c, label, m, r: recentRank.has(c.id) ? recentRank.get(c.id) : -1 });
    }
    const rec = scored.filter((s) => s.r >= 0).sort((a, b) => a.r - b.r);
    const rest = scored.filter((s) => s.r < 0);
    if (q) rest.sort((a, b) => b.m.score - a.m.score || a.label.localeCompare(b.label));
    else rest.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    const items = [];
    const mk = (s, sep) => ({ key: s.c.id, label: s.label, labelHl: s.m ? s.m.matches : [], keybinding: s.c.keybinding, separator: sep, cmd: s.c });
    rec.forEach((s, i) => items.push(mk(s, i === 0 ? 'recently used' : undefined)));
    rest.forEach((s, i) => items.push(mk(s, i === 0 && rec.length ? 'other commands' : undefined)));
    let message = '';
    let tone = '';
    if (!items.length) message = q ? 'No matching commands' : 'No commands';
    if (remoteErr) { message = `Could not load VS Code's commands: ${remoteErr}`; tone = 'err'; }
    return { items, message, tone };
  }

  async function runCommand(c) {
    noteRecentCommand(c.id);
    if (c.local) {
      try { await wb.commands.run(c.id); } catch (err) { reportError(err, `Command '${commandLabel(c)}' resulted in an error`); }
      return;
    }
    const warn = DISRUPTIVE.get(c.id);
    if (warn && !(await confirm({ message: warn, detail: `Command: ${commandLabel(c)}`, primary: 'Run', type: 'warning' }))) return;
    try {
      await callT(wb, 'commands.run', { command: c.id }, 30000);
    } catch (err) {
      reportError(err, `Command '${commandLabel(c)}' resulted in an error`);
    }
  }

  /* ---------------------------------------------------------- files */

  const searchCache = new Map(); // `${windowId}\n${query}\n${max}` → Promise<string[]>
  function searchFiles(query) {
    const wid = wb.windowId;
    const segs = query.split(/[\\/]+/).filter(Boolean);
    const last = (segs[segs.length - 1] || '').replace(/[[\]{}!,]/g, '');
    if (!last) return Promise.resolve([]);
    // fs.search builds '**/*' + query + '*': letters as [aA] classes and '*' between them make it
    // a case-insensitive subsequence match on the file name ("hejs" finds hello.js).
    const fuzzyGlob = [...last].map((ch) => {
      if (ch === '*' || ch === '?') return ch;
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      return lo !== up ? `[${lo}${up}]` : ch;
    }).join('*');
    const plain = [...last].map((ch) => {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      return lo !== up ? `[${lo}${up}]` : ch;
    }).join('');
    const run = (q, max) => {
      const key = `${wid}\n${q}\n${max}`;
      if (!searchCache.has(key)) {
        const p = callT(wb, 'fs.search', { query: q, max }, 20000).then((r) => (Array.isArray(r) ? r : []));
        p.catch(() => searchCache.delete(key));
        searchCache.set(key, p);
        setTimeout(() => searchCache.delete(key), 30000); // files come and go
      }
      return searchCache.get(key);
    };
    return Promise.allSettled([run(plain, 200), run(fuzzyGlob, 400)]).then(([a, b]) => {
      if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
      const seen = new Set();
      const out = [];
      for (const r of [a, b]) {
        if (r.status !== 'fulfilled') continue;
        for (const p of r.value) {
          const k = String(p).toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(String(p)); }
        }
      }
      return out;
    });
  }

  function fileItem(path, query, roots, recentFlag) {
    const rel = relativeTo(path, roots);
    const { dir, base } = splitDirBase(rel);
    const q = query.replace(/\s+/g, '');
    let labelHl = [];
    let descHl = [];
    let score = 0;
    if (q) {
      const qSegs = q.split(/[\\/]+/).filter(Boolean);
      const qBase = qSegs[qSegs.length - 1] || '';
      const mb = fuzzyScore(qBase, base);
      if (qSegs.length > 1 || !mb) {
        const mp = fuzzyScore(q.replace(/\\/g, '/'), rel.replace(/\\/g, '/'));
        if (!mp) return null;
        score = mp.score + (mb ? mb.score : 0);
        const baseStart = rel.length - base.length;
        labelHl = mp.matches.filter((i) => i >= baseStart).map((i) => i - baseStart);
        descHl = mp.matches.filter((i) => i < dir.length);
      } else {
        score = mb.score * 2 + 50;
        labelHl = mb.matches;
      }
      score -= rel.length * 0.01;
    }
    return {
      key: path.toLowerCase(), label: base, description: dir, labelHl, descHl, _s: score, path,
      icon: () => fileIcon(wb, base),
      buttons: recentFlag ? [{ icon: 'close', title: 'Remove from Recently Opened', run: (it, ctl) => { forgetRecentFile(it.path); ctl.refresh({ keepActive: true }); } }] : undefined,
    };
  }

  function parsePosition(q) {
    const m = /^(.*?)(?::(\d+))?(?::(\d+))?\s*$/.exec(q);
    if (!m || !m[2]) return { name: q, line: null, column: null };
    return { name: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : null };
  }

  /* ---------------------------------------------------------- providers */

  const HELP = [
    { prefix: '', label: '…', desc: 'Go to File', kb: 'Ctrl+P' },
    { prefix: '>', label: '>', desc: 'Show and Run Commands', kb: 'Ctrl+Shift+P' },
    { prefix: ':', label: ':', desc: 'Go to Line/Column', kb: 'Ctrl+G' },
    { prefix: '@', label: '@', desc: 'Go to Symbol in Editor', kb: 'Ctrl+Shift+O' },
    { prefix: '?', label: '?', desc: 'Help', kb: null },
  ];
  const modeOf = (v) => (v.startsWith('>') ? 'commands' : v.startsWith(':') ? 'line' : v.startsWith('@') ? 'symbol' : v.startsWith('?') ? 'help' : 'files');
  const PLACEHOLDER_FILES = 'Search files by name (append : to go to line or @ to go to symbol)';

  function commandsProvider(query, ctl) {
    const wid = wb.windowId;
    const c = wid ? commandsCache.get(wid) : null;
    const fresh = c && !c.error && !c.promise && Date.now() - c.at < COMMANDS_TTL_MS;
    if (!fresh && wid) {
      const p = loadRemoteCommands();
      p.then(() => ctl.refresh({ keepActive: true }));
      if (!c || !c.items.length) {
        // First load: the workbench's own commands right away, VS Code's when they arrive.
        const r = commandItems(query, [], null);
        return { ...r, busy: true, message: r.items.length ? '' : 'Loading commands…', tone: '' };
      }
    }
    const entry = wid ? commandsCache.get(wid) : null;
    const err = !wid ? 'no VS Code window is selected' : entry && entry.error && !entry.promise ? entry.error : null;
    return { ...commandItems(query, entry ? entry.items : [], err), busy: !!(entry && entry.promise) };
  }

  function lineProvider(query) {
    let a = null;
    try { a = wb.editors.active(); } catch { a = null; }
    if (!a || !a.path) return { items: [], message: 'Open a text editor first to go to a line.' };
    const lineCount = Number(a.lineCount) || null;
    const curLine = Number(a.line) || 1;
    const curCol = Number(a.column) || 1;
    const m = /^\s*(\d+)?\s*(?:[:,]\s*(\d+))?\s*$/.exec(query);
    if (!query.trim() || !m || !m[1]) {
      const range = lineCount ? `Type a line number between 1 and ${lineCount} to navigate to.` : 'Type a line number to navigate to.';
      return { items: [], message: `Current Line: ${curLine}, Character: ${curCol}. ${range}` };
    }
    let line = Number(m[1]);
    const col = m[2] ? Number(m[2]) : null;
    if (lineCount) line = Math.max(1, Math.min(lineCount, line));
    const label = col ? `Go to line ${line}, character ${col}.` : `Go to line ${line}.`;
    return { items: [{ key: 'goto', label, goto: { path: a.path, line, column: col } }] };
  }

  let filesSeq = 0;
  async function filesProvider(query) {
    if (!wb.windowId) return { items: [], message: 'No VS Code window is selected.' };
    const roots = windowFolders(wb);
    const pos = parsePosition(query);
    const q = pos.name.trim();
    const recent = recentFiles().filter((p) => !hidden.has(p.toLowerCase()));
    const label = (list, sep) => list.map((it, i) => ({ ...it, separator: i === 0 ? sep : undefined }));
    if (!q) return { items: label(recent.map((p) => fileItem(p, '', roots, true)), 'recently opened') };
    const recentItems = recent.map((p) => fileItem(p, q, roots, true)).filter(Boolean).sort((a, b) => b._s - a._s);
    const my = ++filesSeq;
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS));
    if (my !== filesSeq) return { items: label(recentItems, 'recently opened'), busy: true };
    let paths;
    try {
      paths = await searchFiles(q);
    } catch (err) {
      return { items: label(recentItems, 'recently opened'), message: `File search failed: ${errText(err)}`, tone: 'err' };
    }
    const seen = new Set(recent.map((p) => p.toLowerCase()));
    const found = [];
    for (const p of paths) {
      if (seen.has(p.toLowerCase())) continue;
      const it = fileItem(p, q, roots, false);
      if (it) found.push(it);
    }
    found.sort((a, b) => b._s - a._s || a.label.localeCompare(b.label));
    const items = [...label(recentItems, 'recently opened'), ...label(found.slice(0, 200), recentItems.length ? 'file results' : undefined)];
    return { items, message: items.length ? '' : 'No matching results' };
  }

  async function openAt(path, { line, column } = {}) {
    try {
      const o = { preview: false };
      if (line) { o.line = line; o.column = column || 1; }
      await wb.editors.open(path, o);
    } catch (err) {
      reportError(err, `Could not open ${basename(path)}`);
    }
  }

  function open(value, host) {
    const first = modeOf(value);
    return openWidget({
      host,
      value,
      placeholder: first === 'files' ? PLACEHOLDER_FILES : '',
      repeatCombo: first === 'commands' ? 'ctrl+shift+p' : first === 'files' ? 'ctrl+p' : null,
      onValue: (q, ctl) => ctl.setPlaceholder(modeOf(q) === 'files' ? PLACEHOLDER_FILES : ''),
      provider: (q, ctl) => {
        const m = modeOf(q);
        if (m === 'commands') return commandsProvider(q.slice(1), ctl);
        if (m === 'line') return lineProvider(q.slice(1));
        if (m === 'symbol') {
          return { items: [], message: 'Go to Symbol needs VS Code\'s language features, which are not available in this view. Use Ctrl+Shift+O in VS Code on the PC, or Ctrl+F to find text in the editor.' };
        }
        if (m === 'help') return { items: HELP.map((x) => ({ key: x.desc, label: x.label, description: x.desc, keybinding: x.kb, prefix: x.prefix })) };
        return filesProvider(q);
      },
      onAccept: async (it, q, ctl) => {
        const m = modeOf(q);
        if (m === 'help' && it.prefix !== undefined) { ctl.setValue(it.prefix); return true; }
        if (m === 'commands' && it.cmd) {
          ctl.close(it.cmd.id);
          await runCommand(it.cmd);
          return true;
        }
        if (m === 'line' && it.goto) {
          ctl.close(it.goto);
          await openAt(it.goto.path, { line: it.goto.line, column: it.goto.column || 1 });
          return true;
        }
        if (m === 'files' && it.path) {
          const pos = parsePosition(q);
          ctl.close(it.path);
          noteRecentFile(it.path);
          await openAt(it.path, pos.line ? { line: pos.line, column: pos.column || 1 } : {});
          return true;
        }
        return false;
      },
    });
  }

  // Warm VS Code's command list per window, so the first Ctrl+Shift+P shows it instantly.
  const warm = () => { if (wb.windowId) setTimeout(() => loadRemoteCommands().catch(() => {}), 1500); };
  try { wb.onWindowChange(warm); } catch { /* ignore */ }
  warm();

  return { open, loadRemoteCommands, runCommand, noteRecentFile };
}

/**
 * The workbench's quick input. Accepts:
 *   undefined | string | { value, mode? }   → Quick Open; the value's prefix picks the provider
 *                                             ('' files, '>' commands, ':' line, '@' symbols, '?' help)
 *   { items, placeholder?, title?, value?, matchOnDescription?, matchOnDetail? }
 *                                           → generic pick; resolves the chosen item (undefined = cancelled)
 *   { input: true, prompt?, value?, placeholder?, validate?(v) → string|null, title? }
 *                                           → input box; resolves the string (undefined = cancelled)
 */
export function createQuickInput(wb) {
  const host = () => (wb.overlay && wb.overlay.isConnected ? wb.overlay : document.body);
  const access = createQuickAccess(wb);
  return function quickInput(opts) {
    const where = host();
    if (opts == null || typeof opts === 'string') return access.open(String(opts || ''), where);
    if (opts.input) return inputBox(opts, where);
    if (opts.items) return pick(opts, where);
    let v = typeof opts.value === 'string' ? opts.value : '';
    if (!v && opts.mode === 'commands') v = '>';
    else if (!v && opts.mode === 'gotoLine') v = ':';
    return access.open(v, where);
  };
}

/* =================================================================== register */

/** Install the quick input on the shell and the palette's extra keys. */
export function register(wb) {
  return once(wb, 'palette', () => registerImpl(wb));
}

function registerImpl(wb) {
  ensureCss();
  useShell(wb);
  const quickInput = createQuickInput(wb);
  if (typeof wb.setQuickInput === 'function') wb.setQuickInput(quickInput);
  else wb.quickInput = quickInput;

  // The shell registers Show All Commands / Go to File / Go to Line itself; these only fill gaps.
  const showCommands = registerCommand(wb, 'workbench.action.showCommands', 'Show All Commands', () => quickInput('>'), { keybinding: ['ctrl+shift+p', 'f1'], terminal: true });
  const quickOpen = registerCommand(wb, 'workbench.action.quickOpen', 'Go to File...', () => quickInput(''), { keybinding: 'ctrl+p', terminal: true });
  registerCommand(wb, 'workbench.action.gotoLine', 'Go to Line/Column...', () => quickInput(':'), { keybinding: 'ctrl+g', category: 'Go' });
  registerCommand(wb, 'workbench.action.quickOpenHelp', 'Quick Open Help', () => quickInput('?'), { category: 'Help' });
  bindKey(wb, 'ctrl+e', () => { quickOpen(); });
  void showCommands;
  return { quickInput, dispose() { if (current) current.close(undefined, { silent: true }); } };
}

/** Close an open quick input (e.g. when the workbench unmounts). */
export function closeQuickInput() { if (current) current.close(undefined, { silent: true }); }
