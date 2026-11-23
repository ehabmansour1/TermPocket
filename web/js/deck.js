// Tabbed workspace for the desktop split views (Terminals, Code editors).
//
// Every tab owns a pane that stays in the DOM while other tabs are shown (only hidden), so each
// terminal keeps its own live xterm instance and each editor its unsaved text. Views opened into a
// pane (openView with `embed`) report back through `onClosed`, which removes the tab.

import { h, setChildren } from './ui.js';
import { icon } from './icons.js';

/**
 * @param {{ cls?: string, empty?: () => Node, actions?: Node[], onChange?: () => void, label?: string }} opts
 */
export function createDeck({ cls = '', empty, actions = [], onChange, label = 'Open items' } = {}) {
  const strip = h('div', { class: 'deck-tabs', role: 'tablist', 'aria-label': label });
  const panes = h('div', { class: 'deck-panes' });
  const emptyEl = h('div', { class: 'deck-empty' });
  const bar = h('div', { class: 'deck-bar' }, strip, h('div', { class: 'deck-actions' }, actions));
  const el = h('div', { class: ['deck', cls] }, bar, panes, emptyEl);
  const items = new Map(); // key → item
  let order = [];
  let active = null;

  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  /** Tabs with the same title ("PowerShell", "PowerShell") get a small ordinal: 1, 2, … */
  function renumber() {
    const groups = new Map();
    for (const key of order) {
      const it = items.get(key);
      if (!groups.has(it.title)) groups.set(it.title, []);
      groups.get(it.title).push(it);
    }
    for (const list of groups.values()) list.forEach((it, i) => { it.numEl.textContent = list.length > 1 ? String(i + 1) : ''; });
  }

  function renderEmpty() {
    renumber();
    const none = items.size === 0;
    el.classList.toggle('is-empty', none);
    emptyEl.hidden = !none;
    if (none && empty) setChildren(emptyEl, empty());
  }

  /**
   * Open (or focus) a tab.
   * build(pane, hooks) must return the view api ({ back?(), close(), focus?(), onActivate?(), onDeactivate?() }).
   * hooks: { onClosed(), setTitle(title, sub?), setDirty(bool), setState(tone|null) }
   */
  function open(key, { title = 'Untitled', iconName = 'file', tooltip = '', build, activate: act = true }) {
    if (items.has(key)) { if (act) activate(key); return items.get(key); }
    const pane = h('div', { class: 'deck-pane', role: 'tabpanel', hidden: true });
    const titleEl = h('span', { class: 'deck-tab-title' }, title);
    const numEl = h('span', { class: 'deck-tab-n' });
    const dirtyEl = h('span', { class: 'deck-tab-dirty', hidden: true, title: 'Unsaved changes' });
    const closeBtn = h('span', { class: 'deck-tab-close', role: 'button', 'aria-label': `Close ${title}`, title: 'Close (middle-click)' }, icon('x', { size: 14 }));
    const tab = h('div', {
      class: 'deck-tab', role: 'tab', tabIndex: 0, 'aria-selected': 'false', title: tooltip || title, 'data-key': key,
    }, icon(iconName, { size: 15 }), titleEl, numEl, dirtyEl, closeBtn);
    const item = { key, tab, pane, titleEl, numEl, dirtyEl, closeBtn, api: null, title };
    items.set(key, item);
    order.push(key);
    tab.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); close(key); } });
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.deck-tab-close')) { close(key); return; }
      activate(key);
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(key); }
      else if (e.key === 'Delete') { e.preventDefault(); close(key); }
    });
    strip.append(tab);
    panes.append(pane);
    renderEmpty();
    const hooks = {
      onClosed: () => remove(key),
      setTitle: (t, tip) => {
        item.title = t;
        titleEl.textContent = t;
        closeBtn.setAttribute('aria-label', `Close ${t}`);
        tab.title = tip || t;
        renumber();
      },
      setDirty: (d) => { dirtyEl.hidden = !d; tab.classList.toggle('dirty', !!d); },
      setState: (tone) => { tab.dataset.state = tone || ''; },
    };
    try {
      item.api = build(pane, hooks);
    } catch (err) {
      console.error('[termpocket] could not open tab', err);
      remove(key);
      throw err;
    }
    if (act || !active) activate(key);
    else if (onChange) onChange();
    return item;
  }

  function activate(key) {
    const item = items.get(key);
    if (!item) return;
    const prev = active && items.get(active);
    active = key;
    for (const it of items.values()) {
      const on = it === item;
      it.tab.classList.toggle('active', on);
      it.tab.setAttribute('aria-selected', String(on));
      it.pane.hidden = !on;
    }
    item.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (prev !== item) {
      try { prev && prev.api && prev.api.onDeactivate && prev.api.onDeactivate(); } catch (err) { console.error(err); }
      try { item.api && item.api.onActivate && item.api.onActivate(); } catch (err) { console.error(err); }
    }
    requestAnimationFrame(() => { if (active === key) focusActive(); });
    if (onChange) onChange();
  }

  function focusActive() {
    const item = active && items.get(active);
    try { item && item.api && item.api.focus && item.api.focus(); } catch (err) { console.error(err); }
  }

  /** Ask the tab's view to close (it may veto, e.g. unsaved edits). */
  async function close(key) {
    const item = items.get(key);
    if (!item) return true;
    const api = item.api;
    if (!api) { remove(key); return true; }
    const ok = api.back ? await api.back() : (await api.close(), true);
    if (ok !== false && items.has(key)) remove(key); // the view normally reports onClosed itself
    return ok !== false;
  }

  function remove(key) {
    const item = items.get(key);
    if (!item) return;
    items.delete(key);
    const idx = order.indexOf(key);
    order = order.filter((k) => k !== key);
    item.tab.remove();
    item.pane.remove();
    if (active === key) {
      active = null;
      const next = order[Math.min(idx, order.length - 1)];
      if (next) activate(next);
    }
    renderEmpty();
    if (onChange) onChange();
  }

  /** Close everything without asking (layout switch, teardown). */
  function closeAll() {
    active = null; // nothing gets re-activated (and focused) while everything goes away
    for (const key of [...order]) {
      const item = items.get(key);
      try { item && item.api && item.api.close(); } catch (err) { console.error(err); }
      remove(key);
    }
  }

  function cycle(dir) {
    if (order.length < 2) return;
    const i = order.indexOf(active);
    activate(order[(i + dir + order.length) % order.length]);
  }

  renderEmpty();

  return {
    el,
    open,
    activate,
    close,
    closeAll,
    remove,
    cycle,
    focusActive,
    refreshEmpty: renderEmpty,
    has: (key) => items.has(key),
    get: (key) => items.get(key) || null,
    get active() { return active; },
    get keys() { return [...order]; },
    get size() { return items.size; },
  };
}
