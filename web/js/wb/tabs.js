// Editor tab strip and breadcrumbs of the desktop workbench (builder B).
//
// Tabs: preview tabs in italics (replaced by the next preview open), double-click pins, dirty dot
// that turns into × on hover, middle-click closes, drag to reorder, wheel scrolls horizontally,
// context menu (Close / Close Others / Close to the Right / Close Saved / Close All / Keep Open /
// Copy Path / Copy Relative Path / Reveal in Explorer View / Open on PC).
// Breadcrumbs: workspace-relative path; each segment opens a picker of that folder (fs.list).

import { h, setChildren, copyText } from '../ui.js';
import { ci, fileIcon, contextMenu, relativeTo, join, sepOf, notify } from './base.js';

/**
 * @param {object} o
 * @param {(key:string)=>void} o.onActivate
 * @param {(key:string)=>void} o.onClose
 * @param {(key:string)=>void} o.onPin
 * @param {(from:string,to:string,after:boolean)=>void} o.onReorder
 * @param {(key:string, x:number, y:number)=>void} o.onContext
 */
export function createTabStrip({ onActivate, onClose, onPin, onReorder, onContext }) {
  const strip = h('div', { class: 'wb-tabs', role: 'tablist', 'aria-label': 'Editors' });
  const scroller = h('div', { class: 'wb-tabs-scroll' }, strip);
  let dragKey = null;

  scroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { scroller.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  /**
   * tabs: [{key, label, description?, path?, icon?(Node), dirty, preview, active, tooltip, italic?, readOnly?}]
   */
  function render(tabs) {
    const nodes = tabs.map((t) => {
      const close = h('button', { type: 'button', class: 'wb-tab-close', title: 'Close (Ctrl+W)', 'aria-label': 'Close', tabindex: '-1' },
        ci('close', { cls: 'x' }), ci('circle-filled', { cls: 'dot' }));
      close.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
      close.addEventListener('click', (e) => { e.stopPropagation(); onClose(t.key); });
      const el = h('div', {
        class: ['wb-tab', t.active && 'active', t.dirty && 'dirty', t.preview && 'preview'],
        role: 'tab', 'aria-selected': String(!!t.active), title: t.tooltip || '', draggable: 'true', 'data-key': t.key,
      },
      t.icon || null,
      h('span', { class: 'wb-tab-label' },
        h('span', { class: 'wb-tab-name' }, t.label),
        t.description ? h('span', { class: 'wb-tab-desc' }, t.description) : null),
      t.readOnly ? ci('lock', { cls: 'wb-tab-lock', title: 'Read-only' }) : null,
      close);
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); return; }
        if (e.button === 0) onActivate(t.key);
      });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); onClose(t.key); } });
      el.addEventListener('dblclick', () => onPin(t.key));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(t.key, e.clientX, e.clientY); });
      el.addEventListener('dragstart', (e) => {
        dragKey = t.key;
        el.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.path || t.label); } catch { /* ignore */ }
      });
      el.addEventListener('dragend', () => { dragKey = null; el.classList.remove('dragging'); clearDrop(); });
      el.addEventListener('dragover', (e) => {
        if (!dragKey || dragKey === t.key) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        clearDrop();
        el.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-after', 'drop-before'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = el.classList.contains('drop-after');
        clearDrop();
        if (dragKey && dragKey !== t.key) onReorder(dragKey, t.key, after);
      });
      return el;
    });
    setChildren(strip, nodes);
    const act = strip.querySelector('.wb-tab.active');
    if (act) {
      const sr = scroller.getBoundingClientRect();
      const ar = act.getBoundingClientRect();
      if (ar.left < sr.left) scroller.scrollLeft -= sr.left - ar.left;
      else if (ar.right > sr.right) scroller.scrollLeft += ar.right - sr.right;
    }
  }
  function clearDrop() { for (const x of strip.querySelectorAll('.drop-after, .drop-before')) x.classList.remove('drop-after', 'drop-before'); }

  return { el: scroller, render };
}

/** Context menu of a tab. ctx: {key, path, others, toRight, saved, preview, close*, pin, reveal, openOnPc, roots} */
export function tabContextMenu(x, y, c) {
  const relative = c.path ? relativeTo(c.path, c.roots) : null;
  contextMenu({ x, y }, [
    { label: 'Close', kb: 'ctrl+w', onSelect: c.close },
    { label: 'Close Others', disabled: !c.hasOthers, onSelect: c.closeOthers },
    { label: 'Close to the Right', disabled: !c.hasRight, onSelect: c.closeRight },
    { label: 'Close Saved', kb: 'ctrl+k u', onSelect: c.closeSaved },
    { label: 'Close All', kb: 'ctrl+k w', onSelect: c.closeAll },
    'sep',
    c.path && { label: 'Copy Path', kb: 'shift+alt+c', onSelect: async () => { if (!(await copyText(c.path))) notify('Could not copy to the clipboard.', { severity: 'warning' }); } },
    c.path && relative != null && { label: 'Copy Relative Path', kb: 'ctrl+k ctrl+shift+c', onSelect: () => copyText(relative) },
    'sep',
    c.path && { label: 'Reveal in Explorer View', onSelect: c.reveal },
    c.path && { label: 'Open in VS Code on the PC', onSelect: c.openOnPc },
    'sep',
    { label: 'Keep Open', kb: 'ctrl+k enter', disabled: !c.preview, onSelect: c.pin },
  ]);
}

/**
 * Breadcrumbs bar. render(path, roots, extraLabel?) → folder › sub › file.
 * onPick(path) opens a file picked from a segment's dropdown.
 */
export function createBreadcrumbs(wb, { onPick }) {
  const el = h('div', { class: 'wb-breadcrumbs', role: 'navigation', 'aria-label': 'Breadcrumbs' });
  function render(path, roots = []) {
    if (!path) { setChildren(el); el.hidden = true; return; }
    el.hidden = false;
    const sep = sepOf(path);
    let base = null;
    for (const r of roots) { if (relativeTo(path, [r]) != null) { base = r; break; } }
    const parts = [];
    if (base) {
      const rootName = base.split(/[\\/]/).filter(Boolean).pop() || base;
      const rest = relativeTo(path, [base]).split(/[\\/]+/).filter(Boolean);
      parts.push({ name: rootName, path: base, dir: true });
      let acc = base;
      rest.forEach((seg, i) => { acc = join(acc, seg); parts.push({ name: seg, path: acc, dir: i < rest.length - 1 }); });
      if (roots.length === 1) parts.shift(); // single-folder workspace: VS Code starts at the first sub folder
    } else {
      const segs = path.split(/[\\/]+/).filter(Boolean);
      let acc = /^[\\/]/.test(path) ? sep : '';
      segs.forEach((seg, i) => {
        acc = i === 0 && /^[A-Za-z]:$/.test(seg) ? `${seg}${sep}` : join(acc, seg);
        parts.push({ name: seg, path: acc, dir: i < segs.length - 1 });
      });
    }
    const nodes = [];
    parts.forEach((p, i) => {
      if (i) nodes.push(h('span', { class: 'wb-crumb-sep', 'aria-hidden': 'true' }, ci('chevron-right')));
      const item = h('button', { type: 'button', class: ['wb-crumb', !p.dir && 'file'], title: p.path },
        p.dir ? null : fileIcon(p.name),
        h('span', { class: 'wb-crumb-label' }, p.name));
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => pickFrom(item, p));
      nodes.push(item);
    });
    setChildren(el, nodes);
  }
  async function pickFrom(anchor, part) {
    const dir = part.dir ? part.path : part.path.replace(/[\\/][^\\/]*$/, '');
    let listing;
    anchor.classList.add('active');
    try {
      listing = await wb.call('fs.list', { path: dir });
    } catch (err) {
      anchor.classList.remove('active');
      notify(err.message, { severity: 'error' });
      return;
    }
    anchor.classList.remove('active');
    const entries = (listing && listing.entries) || [];
    contextMenu({ anchor }, entries.slice(0, 400).map((e) => ({
      label: e.name,
      icon: fileIcon(e.name, { dir: e.type === 'dir' }),
      onSelect: () => {
        const full = join(listing.path, e.name);
        if (e.type === 'dir') pickFrom(anchor, { dir: true, path: full, name: e.name });
        else onPick(full);
      },
    })), { minWidth: 220 });
  }
  return { el, render };
}
