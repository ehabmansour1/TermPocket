// Shared UI toolkit: DOM builder, storage, back-button layer stack, toasts,
// dialogs, bottom sheets, formatting helpers and a tiny safe ANSI renderer.
//
// Security rule for the whole app: remote strings are only ever inserted with
// textContent / text nodes (h() does that for every string child). Nothing in
// this file assigns remote data to innerHTML.

import { icon } from './icons.js';

/* ------------------------------------------------------------------------ */
/* DOM                                                                       */
/* ------------------------------------------------------------------------ */

// Keys that must be assigned as DOM properties rather than attributes.
const PROPS = new Set([
  'value', 'checked', 'disabled', 'hidden', 'readOnly', 'selected', 'spellcheck', 'tabIndex',
  'type', 'placeholder', 'autocomplete', 'inputMode', 'enterKeyHint', 'title', 'id', 'name',
  'min', 'max', 'step', 'rows', 'href', 'download', 'target', 'htmlFor', 'multiple', 'wrap',
]);

/**
 * Hyperscript-style element builder.
 *   h('div', { class: 'row', onClick: fn }, 'text', childNode, [more, nodes])
 * String/number children become text nodes (safe for remote data).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children of el. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  return appendChildren(el, children);
}

/** Prevent a button from stealing focus (keeps the soft keyboard open). */
export function noFocusSteal(el) {
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.tabIndex = -1;
  return el;
}

/**
 * Fade the edges of a horizontally scrolling strip (key rows) while more content is hidden
 * on that side, so it is obvious the row scrolls. Toggles .fade-l / .fade-r.
 */
export function edgeFade(el, { observe = true } = {}) {
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-l', el.scrollLeft > 2);
    el.classList.toggle('fade-r', max > 2 && el.scrollLeft < max - 2);
  };
  el.addEventListener('scroll', update, { passive: true });
  // Long-lived strips follow size changes; short-lived ones (re-rendered often) skip the observer.
  if (observe && typeof ResizeObserver === 'function') new ResizeObserver(update).observe(el);
  requestAnimationFrame(update);
  return update;
}

/** Icon-only button with an accessible label. */
export function iconBtn(name, label, onClick, { cls = '', size = 20, keepFocus = false } = {}) {
  const b = h('button', { type: 'button', class: ['icon-btn', cls], 'aria-label': label, title: label },
    icon(name, { size }));
  if (onClick) b.addEventListener('click', onClick);
  if (keepFocus) noFocusSteal(b);
  return b;
}

/** Text button, optionally with a leading icon. variant: primary | ghost | danger | subtle */
export function btn(label, { iconName, variant = '', onClick, cls = '', small = false, title, disabled } = {}) {
  const b = h('button', {
    type: 'button',
    class: ['btn', variant, small && 'sm', cls],
    title,
    disabled,
  }, iconName ? icon(iconName, { size: small ? 16 : 18 }) : null, label ? h('span', label) : null);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Segmented control. Returns { el, set(value) }. */
export function segmented(options, value, onChange, { cls = '' } = {}) {
  const el = h('div', { class: ['seg', cls], role: 'tablist' });
  const buttons = new Map();
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'tab', class: 'seg-btn' },
      o.icon ? icon(o.icon, { size: 16 }) : null, h('span', o.label),
      o.badge ? h('span', { class: 'seg-badge', hidden: true }) : null);
    b.addEventListener('click', () => { if (value !== o.value) { set(o.value); onChange(o.value); } });
    buttons.set(o.value, b);
    el.append(b);
  }
  function set(v) {
    value = v;
    for (const [k, b] of buttons) {
      b.classList.toggle('active', k === v);
      b.setAttribute('aria-selected', String(k === v));
    }
  }
  function badge(v, text) {
    const b = buttons.get(v)?.querySelector('.seg-badge');
    if (!b) return;
    b.hidden = !text;
    b.textContent = text ? String(text) : '';
  }
  set(value);
  return { el, set, badge, get value() { return value; } };
}

export function spinner(label) {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), label ? h('span', label) : null);
}

/** Empty / error state block. */
export function emptyState({ iconName = 'info', title, text, action, tone = '' }) {
  return h('div', { class: ['empty', tone] },
    h('div', { class: 'empty-ico' }, icon(iconName, { size: 28 })),
    title ? h('div', { class: 'empty-title' }, title) : null,
    text ? h('div', { class: 'empty-text' }, text) : null,
    action || null);
}

export function banner(text, { tone = 'info', iconName, actions = [] } = {}) {
  const ico = iconName || (tone === 'err' ? 'errorCircle' : tone === 'warn' ? 'alert' : 'info');
  return h('div', { class: ['banner', tone], role: tone === 'err' ? 'alert' : 'status' },
    icon(ico, { size: 18 }), h('div', { class: 'banner-text' }, text),
    actions.length ? h('div', { class: 'banner-actions' }, actions) : null);
}

export function pill(text, tone = 'muted', title) {
  return h('span', { class: ['pill', tone], title }, text);
}

/* ------------------------------------------------------------------------ */
/* Storage (localStorage can throw in private mode / when disabled)          */
/* ------------------------------------------------------------------------ */

export const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem('termpocket.' + key);
      return v == null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('termpocket.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) {
    try { localStorage.removeItem('termpocket.' + key); } catch { /* ignore */ }
  },
};

/* ------------------------------------------------------------------------ */
/* Back-button layer stack (Android back closes the top-most view/sheet)     */
/* ------------------------------------------------------------------------ */

const layers = [];
let ignorePops = 0;
const popWaiters = []; // resolvers for programmatic history.back() calls
// Settles once every programmatic history.back() issued so far has landed (or timed out).
// history.back() is asynchronous: a pushState issued before the traversal lands is popped by it
// instead, which desyncs the stack — the next Back press then leaves the app. So new layers wait.
let popsSettled = Promise.resolve();

/**
 * Register a closable layer. Pushes a history entry so the hardware/gesture
 * back button closes the layer instead of leaving the app.
 * @param {() => (boolean|void|Promise<boolean|void>)} onBack  called when the user
 *   navigates back; return false (or resolve false) to veto (e.g. unsaved changes).
 * @returns {{ back(): void, dismiss(): Promise<void>, readonly open: boolean }}
 *   back()    — user-initiated close (runs onBack, may be vetoed)
 *   dismiss() — programmatic close: removes the layer WITHOUT calling onBack; resolves
 *               once the history entry has been consumed, so a follow-up layer can be
 *               pushed safely (e.g. an action sheet item that opens a dialog)
 */
export function pushLayer(onBack) {
  const entry = { onBack, open: true, pushed: false };
  layers.push(entry);
  const push = () => {
    if (!entry.open || entry.pushed) return;
    entry.pushed = true;
    try { history.pushState({ vscLayer: layers.indexOf(entry) + 1 }, ''); } catch { /* ignore */ }
  };
  if (ignorePops > 0) popsSettled.then(push);
  else push();
  return {
    get open() { return entry.open; },
    back() {
      if (!entry.open) return;
      if (entry.pushed && topPushed() === entry) history.back();
      else runBack(entry);
    },
    dismiss() {
      if (!entry.open) return Promise.resolve();
      entry.open = false;
      const i = layers.indexOf(entry);
      if (entry.pushed && topPushed() === entry) {
        layers.splice(i, 1);
        ignorePops++;
        const done = new Promise((resolve) => {
          const waiter = { resolve, timer: 0 };
          waiter.timer = setTimeout(() => {
            const k = popWaiters.indexOf(waiter);
            if (k >= 0) popWaiters.splice(k, 1);
            resolve();
          }, 350);
          popWaiters.push(waiter);
          history.back();
        });
        popsSettled = Promise.all([popsSettled, done]).then(() => {});
        return done;
      }
      // Not the top history entry (or its pushState is still deferred): just drop it.
      if (i >= 0) layers.splice(i, 1);
      return Promise.resolve();
    },
  };
}

/** The top-most layer that owns a history entry. */
function topPushed() {
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i].pushed) return layers[i];
  return null;
}

async function runBack(entry) {
  let res;
  try { res = await entry.onBack(); } catch (err) { console.error(err); }
  if (res === false) {
    // Vetoed: restore the history entry if it was consumed by a popstate.
    if (!layers.includes(entry)) {
      layers.push(entry);
      entry.pushed = true;
      try { history.pushState({ vscLayer: layers.length }, ''); } catch { /* ignore */ }
    }
    return;
  }
  entry.open = false;
  const i = layers.indexOf(entry);
  if (i >= 0) layers.splice(i, 1);
}

window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops--;
    const waiter = popWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); }
    return;
  }
  // The entry that was just popped belongs to the top-most layer that pushed one.
  const entry = topPushed();
  if (!entry) return;
  layers.splice(layers.indexOf(entry), 1);
  if (entry.open) runBack(entry);
});

/* ------------------------------------------------------------------------ */
/* Toasts                                                                    */
/* ------------------------------------------------------------------------ */

let toastHost = null;
function getToastHost() {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = document.getElementById('toasts') || h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    if (!toastHost.isConnected) document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * Show a transient message.
 * @param {string} message
 * @param {{type?: 'info'|'ok'|'err'|'warn', timeout?: number, action?: {label: string, onClick: Function}}} [opts]
 */
export function toast(message, { type = 'info', timeout, action } = {}) {
  const host = getToastHost();
  const ico = { ok: 'checkCircle', err: 'errorCircle', warn: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: ['toast', type], role: type === 'err' ? 'alert' : 'status' },
    icon(ico, { size: 18 }), h('div', { class: 'toast-text' }, String(message)));
  if (action) {
    el.append(h('button', {
      type: 'button', class: 'toast-action',
      onClick: () => { remove(); action.onClick(); },
    }, action.label));
  }
  el.addEventListener('click', (e) => { if (!e.target.closest('.toast-action')) remove(); });
  host.append(el);
  // Keep at most 3 toasts.
  while (host.children.length > 3) host.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  const ms = timeout ?? (type === 'err' ? 4800 : action ? 6000 : 2600);
  const timer = setTimeout(remove, ms);
  function remove() {
    clearTimeout(timer);
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }
  return remove;
}

/** Toast an error coming from a failed request. */
export function toastError(err, prefix = '') {
  const msg = err && err.message ? err.message : String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, { type: 'err' });
}

/* ------------------------------------------------------------------------ */
/* Dialogs & sheets                                                          */
/* ------------------------------------------------------------------------ */

function layerHost() {
  let host = document.getElementById('layers');
  if (!host) { host = h('div', { id: 'layers' }); document.body.append(host); }
  return host;
}

/**
 * Generic modal dialog. build(close) returns the dialog content nodes.
 * Resolves with whatever value close(value) is called with (undefined on back/backdrop).
 */
function openDialog(build, { cls = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const backdrop = h('div', { class: 'dialog-backdrop' });
    const box = h('div', { class: ['dialog', cls], role: 'dialog', 'aria-modal': 'true' });
    backdrop.append(box);
    const layer = pushLayer(() => { finish(undefined); });
    function finish(value) {
      if (done) return;
      done = true;
      layer.dismiss();
      backdrop.classList.remove('in');
      setTimeout(() => backdrop.remove(), 180);
      resolve(value);
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(undefined); });
    appendChildren(box, [build(finish)]);
    layerHost().append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
    const auto = box.querySelector('[data-autofocus]');
    if (auto) setTimeout(() => auto.focus(), 60);
  });
}

/** Confirmation dialog → Promise<boolean>. */
export async function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, iconName } = {}) {
  const v = await openDialog((close) => [
    h('div', { class: 'dialog-head' },
      iconName ? h('div', { class: ['dialog-ico', danger && 'danger'] }, icon(iconName, { size: 22 })) : null,
      h('div', { class: 'dialog-title' }, title || 'Are you sure?')),
    message ? h('div', { class: 'dialog-msg' }, message) : null,
    h('div', { class: 'dialog-actions' },
      btn(cancelText, { variant: 'ghost', onClick: () => close(false) }),
      btn(confirmText, { variant: danger ? 'danger' : 'primary', onClick: () => close(true) })),
  ]);
  return v === true;
}

/** Text prompt dialog → Promise<string|null> (null when cancelled). */
export async function promptDialog({
  title, message, value = '', placeholder = '', confirmText = 'OK', multiline = false,
  inputMode, mono = false, validate,
} = {}) {
  const v = await openDialog((close) => {
    const input = multiline
      ? h('textarea', { class: ['input', 'textarea', mono && 'mono'], rows: 6, placeholder, spellcheck: false, 'data-autofocus': true })
      : h('input', { class: ['input', mono && 'mono'], type: 'text', placeholder, spellcheck: false, autocomplete: 'off', inputMode, enterKeyHint: 'done', 'data-autofocus': true, autocapitalize: 'off' });
    input.value = value;
    const err = h('div', { class: 'field-error', hidden: true });
    const submit = () => {
      const problem = validate ? validate(input.value) : null;
      if (problem) { err.hidden = false; err.textContent = problem; return; }
      close(input.value);
    };
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    return [
      h('div', { class: 'dialog-head' }, h('div', { class: 'dialog-title' }, title || '')),
      message ? h('div', { class: 'dialog-msg' }, message) : null,
      input, err,
      h('div', { class: 'dialog-actions' },
        btn('Cancel', { variant: 'ghost', onClick: () => close(null) }),
        btn(confirmText, { variant: 'primary', onClick: submit })),
    ];
  });
  return typeof v === 'string' ? v : null;
}

/**
 * Bottom sheet. content: Node | Node[] | (api) => Node|Node[].
 * Returns { el, body, close() }.
 */
export function sheet({ title, subtitle, content, onClose, cls = '', actions } = {}) {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const body = h('div', { class: 'sheet-body' });
  const panel = h('div', { class: ['sheet', cls], role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    title ? h('div', { class: 'sheet-head' },
      h('div', { class: 'sheet-titles' },
        h('div', { class: 'sheet-title' }, title),
        subtitle ? h('div', { class: 'sheet-sub' }, subtitle) : null),
      actions || null,
      iconBtn('x', 'Close', () => api.close())) : null,
    body);
  backdrop.append(panel);
  let closed = false;
  const layer = pushLayer(() => { teardown(); });
  function teardown() {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('in');
    setTimeout(() => backdrop.remove(), 200);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  const api = {
    el: panel,
    body,
    get closed() { return closed; },
    close() {
      if (closed) return Promise.resolve();
      const done = layer.dismiss();
      teardown();
      return done;
    },
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) api.close(); });
  appendChildren(body, [typeof content === 'function' ? content(api) : content]);
  layerHost().append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('in'));
  return api;
}

/**
 * Action sheet: list of actions. Resolves when an action is chosen or dismissed.
 * actions: [{ label, iconName?, danger?, sub?, disabled?, onSelect }]
 */
export function actionSheet({ title, subtitle, actions }) {
  return sheet({
    title, subtitle, cls: 'action-sheet',
    content: (api) => h('div', { class: 'action-list' }, actions.filter(Boolean).map((a) =>
      h('button', {
        type: 'button', class: ['action-item', a.danger && 'danger'], disabled: a.disabled,
        onClick: () => { api.close().then(() => { if (a.onSelect) a.onSelect(); }); },
      },
      a.iconName ? icon(a.iconName, { size: 20 }) : h('span', { class: 'ico-spacer' }),
      h('span', { class: 'action-labels' }, h('span', { class: 'action-label' }, a.label),
        a.sub ? h('span', { class: 'action-sub' }, a.sub) : null)))),
  });
}

/* ------------------------------------------------------------------------ */
/* Full-screen views (terminal, editor, exec log)                            */
/* ------------------------------------------------------------------------ */

/**
 * Open a full-screen view above the tab content.
 * @param {HTMLElement} el      the view root (class "view" is added)
 * @param {{ onBack?: () => (boolean|void|Promise<boolean|void>), onClose?: () => void }} hooks
 *   onBack may veto by returning false; onClose runs once when the view goes away.
 * @returns {{ back(): void, close(): Promise<void>, readonly closed: boolean }}
 */
export function openView(el, { onBack, onClose, embed } = {}) {
  if (embed && embed.host) return openEmbedded(el, { onBack, onClose, embed });
  const host = document.getElementById('views') || document.body;
  el.classList.add('view');
  host.append(el);
  document.body.classList.add('has-view');
  requestAnimationFrame(() => el.classList.add('in'));
  let closed = false;
  const layer = pushLayer(async () => {
    if (onBack) {
      const r = await onBack();
      if (r === false) return false;
    }
    teardown();
  });
  function teardown() {
    if (closed) return;
    closed = true;
    el.classList.remove('in');
    setTimeout(() => {
      el.remove();
      if (!host.querySelector('.view')) document.body.classList.remove('has-view');
    }, 160);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  return {
    back() { layer.back(); },
    close() {
      if (closed) return Promise.resolve();
      const done = layer.dismiss();
      teardown();
      return done;
    },
    get closed() { return closed; },
    embedded: false,
  };
}

/**
 * Desktop variant of openView: the view lives inside `embed.host` (a tab pane of a split
 * view) instead of covering the screen, and owns no history entry.
 * back() runs onBack (which may veto) and resolves true when the view closed.
 */
function openEmbedded(el, { onBack, onClose, embed }) {
  el.classList.add('view', 'embedded', 'in');
  embed.host.append(el);
  let closed = false;
  function teardown() {
    if (closed) return;
    closed = true;
    el.remove();
    try { onClose && onClose(); } catch (err) { console.error(err); }
    try { embed.onClosed && embed.onClosed(); } catch (err) { console.error(err); }
  }
  return {
    async back() {
      if (closed) return true;
      if (onBack) {
        let r;
        try { r = await onBack(); } catch (err) { console.error(err); }
        if (r === false) return false;
      }
      teardown();
      return true;
    },
    close() { teardown(); return Promise.resolve(); },
    get closed() { return closed; },
    embedded: true,
  };
}

/* ------------------------------------------------------------------------ */
/* Desktop popover menus (dropdowns anchored to a button)                    */
/* ------------------------------------------------------------------------ */

let openPop = null;

/** True while a popover menu is open (keyboard capture in Remote Desktop pauses). */
export function popoverOpen() { return !!openPop; }

export function closePopover() { if (openPop) openPop.close(); }

/**
 * Small dropdown menu below (or above) an anchor element.
 * items: [{ label, sub?, iconName?, checked?, danger?, disabled?, kbd?, onSelect }] | 'sep' | { header }
 */
export function popover(anchor, items, { align = 'start', cls = '', onClose } = {}) {
  closePopover();
  const menu = h('div', { class: ['popover', cls], role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === 'sep') { menu.append(h('div', { class: 'pop-sep', role: 'separator' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'pop-head' }, it.header)); continue; }
    const b = h('button', {
      type: 'button', role: it.checked != null ? 'menuitemradio' : 'menuitem',
      class: ['pop-item', it.danger && 'danger', it.checked && 'checked'], disabled: it.disabled,
      'aria-checked': it.checked != null ? String(!!it.checked) : null,
    },
    h('span', { class: 'pop-check', 'aria-hidden': 'true' }, it.checked ? icon('check', { size: 15 }) : null),
    it.iconName ? icon(it.iconName, { size: 16 }) : null,
    h('span', { class: 'pop-labels' }, h('span', { class: 'pop-label' }, it.label), it.sub ? h('span', { class: 'pop-sub' }, it.sub) : null),
    it.kbd ? h('kbd', { class: 'pop-kbd' }, it.kbd) : null);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it was
    b.addEventListener('click', () => { close(); if (it.onSelect) it.onSelect(); });
    menu.append(b);
  }
  layerHost().append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = clamp(left, 8, Math.max(8, vw - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > vh - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  anchor.classList.add('pop-open');
  requestAnimationFrame(() => menu.classList.add('in'));
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const onResize = () => close();
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (openPop === api) openPop = null;
    anchor.classList.remove('pop-open');
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    menu.remove();
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  const api = { el: menu, close };
  openPop = api;
  return api;
}

/** Is any sheet / dialog / popover currently open? */
export function layerOpen() {
  return !!openPop || !!document.querySelector('#layers .sheet-backdrop.in, #layers .dialog-backdrop.in');
}

/**
 * Drag handle that resizes a pane. get() → current size px; set(px) applies it.
 * axis 'x' (drag left/right) or 'y'; invert when dragging towards the start grows the pane.
 */
export function resizer(handle, { axis = 'x', get, set, min = 120, max = 2000, invert = false, onEnd } = {}) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    const start = axis === 'x' ? e.clientX : e.clientY;
    const s0 = get();
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    handle.classList.add('dragging');
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      set(clamp(s0 + (invert ? -d : d), min, max));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      handle.classList.remove('dragging');
      if (onEnd) onEnd(get());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/** On/off switch button (role=switch). Returns { el, set(value), get value() }. */
export function toggleSwitch(value, onChange, { label } = {}) {
  const el = h('button', { type: 'button', class: ['toggle', value && 'on'], role: 'switch', 'aria-checked': String(!!value), 'aria-label': label }, h('span', { class: 'knob' }));
  const set = (v) => { value = !!v; el.classList.toggle('on', value); el.setAttribute('aria-checked', String(value)); };
  el.addEventListener('click', () => { set(!value); onChange(value); });
  return { el, set, get value() { return value; } };
}

/* ------------------------------------------------------------------------ */
/* Clipboard                                                                 */
/* ------------------------------------------------------------------------ */

/** Copy text to the phone clipboard; falls back to execCommand on insecure origins. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = h('textarea', { class: 'offscreen', readOnly: true });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Read text from the phone clipboard; resolves null when unavailable/denied. */
export async function readClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }
  } catch { /* denied */ }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Formatting & small utilities                                              */
/* ------------------------------------------------------------------------ */

export function fmtBytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${mm}m`;
  if (mm) return `${mm}m ${ss}s`;
  return `${ss}s`;
}

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return fmtDuration(ms / 1000);
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 0) return fmtTime(ts);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = performance.now();
          fn(...pendingArgs);
        }, wait);
      }
    }
  };
}

export function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ }
}

/* Paths (Windows or POSIX) ------------------------------------------------- */

export function pathSep(p) {
  return /\\/.test(p) || /^[A-Za-z]:/.test(p) ? '\\' : '/';
}

export function basename(p) {
  if (!p) return '';
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

export function dirname(p) {
  if (!p) return '';
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return '';
  const d = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(d)) return d + '\\';
  return d || trimmed.slice(0, 1);
}

/**
 * Split a path into breadcrumb segments with cumulative paths.
 *   'E:\a\b' → [{name:'E:', path:'E:\'}, {name:'a', path:'E:\a'}, {name:'b', path:'E:\a\b'}]
 */
export function splitPath(p) {
  if (!p) return [];
  const sep = pathSep(p);
  const out = [];
  let rest = p;
  let prefix = '';
  let m;
  if ((m = /^(\\\\[^\\]+\\[^\\]+)(\\|$)/.exec(p))) { // UNC \\server\share
    prefix = m[1] + '\\';
    out.push({ name: m[1], path: prefix });
    rest = p.slice(m[0].length);
  } else if ((m = /^([A-Za-z]:)[\\/]?/.exec(p))) {
    prefix = m[1] + '\\';
    out.push({ name: m[1], path: prefix });
    rest = p.slice(m[0].length);
  } else if (p.startsWith('/')) {
    prefix = '/';
    out.push({ name: '/', path: '/' });
    rest = p.slice(1);
  }
  let acc = prefix;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    acc = acc && !acc.endsWith(sep) ? acc + sep + part : acc + part;
    out.push({ name: part, path: acc });
  }
  return out;
}

export function joinPath(dir, name) {
  if (!dir) return name;
  const sep = pathSep(dir);
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name;
}

/** Display a path relative to one of the given roots when possible. */
/**
 * Compact a long absolute path for one-line display, keeping the end (the part that identifies
 * it): "C:\Users\me\AppData\Local\Temp\proj\src" → "…\proj\src".
 */
export function shortPath(p, max = 32) {
  const s = String(p ?? '');
  if (s.length <= max) return s;
  const sep = pathSep(s);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  // Keep as many trailing folders as fit in `max` (always at least the last one).
  let tail = parts.pop() || '';
  while (parts.length && tail.length + parts[parts.length - 1].length + 3 <= max) tail = `${parts.pop()}${sep}${tail}`;
  return `…${sep}${tail}`;
}

export function relPath(p, roots = []) {
  const lower = p.toLowerCase();
  for (const r of roots) {
    if (!r) continue;
    const rl = r.toLowerCase().replace(/[\\/]+$/, '');
    if (lower === rl) return basename(p);
    if (lower.startsWith(rl + '\\') || lower.startsWith(rl + '/')) return p.slice(rl.length + 1);
  }
  return p;
}

/* ------------------------------------------------------------------------ */
/* Terminal palette (shared by xterm and the ANSI renderer)                  */
/* ------------------------------------------------------------------------ */

export const ANSI16 = [
  '#1b1f27', '#ff6b81', '#7ee2a8', '#f6c177', '#7aa7ff', '#c49bff', '#62d6e8', '#c8ced9',
  '#5c6577', '#ff8c9e', '#a3f0c1', '#ffd79a', '#9dbdff', '#d7b8ff', '#93e6f3', '#f4f6fa',
];

export const TERM_THEME = {
  background: '#0b0d12',
  foreground: '#d7dce5',
  cursor: '#6ef0c2',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(110, 240, 194, 0.28)',
  black: ANSI16[0], red: ANSI16[1], green: ANSI16[2], yellow: ANSI16[3],
  blue: ANSI16[4], magenta: ANSI16[5], cyan: ANSI16[6], white: ANSI16[7],
  brightBlack: ANSI16[8], brightRed: ANSI16[9], brightGreen: ANSI16[10], brightYellow: ANSI16[11],
  brightBlue: ANSI16[12], brightMagenta: ANSI16[13], brightCyan: ANSI16[14], brightWhite: ANSI16[15],
};

export const MONO_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, 'Roboto Mono', 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', monospace";

/**
 * VS Code's integrated terminal on Windows, "Dark Modern" theme: panel background #181818, the
 * editor font (terminal.integrated.fontFamily falls back to it), 14 px, line height 1, a block
 * cursor that does not blink and turns into an outline when the terminal is not focused. Desktop
 * terminals (workbench TERMINAL panel and the Terminals tab) use this so they look like VS Code.
 */
export const VSCODE_TERM_THEME = {
  background: '#181818',
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  selectionInactiveBackground: '#3a3d41',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};
export const VSCODE_TERM_FONT = "Consolas, 'Courier New', monospace";
export const VSCODE_TERM_FONT_SIZE = 14;
/** xterm options that make a terminal look like VS Code's (on top of theme / font). */
export const VSCODE_TERM_LOOK = { lineHeight: 1, cursorBlink: false, cursorStyle: 'block', cursorInactiveStyle: 'outline', letterSpacing: 0 };

function color256(n) {
  if (n < 16) return ANSI16[n];
  if (n < 232) {
    const i = n - 16;
    const c = (x) => (x ? x * 40 + 55 : 0);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const l = (n - 232) * 10 + 8;
  return `rgb(${l},${l},${l})`;
}

/* ------------------------------------------------------------------------ */
/* ANSI → DOM (safe: text nodes + inline styles, never innerHTML)            */
/* ------------------------------------------------------------------------ */

// CSI, OSC (BEL or ST terminated), DCS/APC/PM strings, 2-char escapes, C0 controls except \t \n \r.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Remove all escape sequences and control characters (keeps \t \n \r). */
export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

function styleKey(st) {
  return `${st.fg}|${st.bg}|${st.b}|${st.d}|${st.i}|${st.u}|${st.inv}`;
}

function applySgr(st, params) {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false });
    else if (c === 1) st.b = true;
    else if (c === 2) st.d = true;
    else if (c === 3) st.i = true;
    else if (c === 4) st.u = true;
    else if (c === 7) st.inv = true;
    else if (c === 22) { st.b = false; st.d = false; }
    else if (c === 23) st.i = false;
    else if (c === 24) st.u = false;
    else if (c === 27) st.inv = false;
    else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30];
    else if (c === 39) st.fg = null;
    else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40];
    else if (c === 49) st.bg = null;
    else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 90 + 8];
    else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 100 + 8];
    else if (c === 38 || c === 48) {
      let col = null;
      if (p[i + 1] === 5 && p[i + 2] != null) { col = color256(p[i + 2] & 255); i += 2; }
      else if (p[i + 1] === 2 && p[i + 4] != null) {
        col = `rgb(${p[i + 2] & 255},${p[i + 3] & 255},${p[i + 4] & 255})`; i += 4;
      }
      if (col) { if (c === 38) st.fg = col; else st.bg = col; }
    }
  }
}

/**
 * Parse ANSI text into lines of styled segments. Handles SGR colours/styles,
 * CR overwrite (progress bars), and drops every other control sequence.
 * @returns {Array<Array<{text: string, st: object}>>}
 */
export function parseAnsi(input) {
  const text = String(input ?? '').replace(/\r\n/g, '\n');
  const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false };
  const lines = [[]];
  let crPending = false;
  const pushText = (t) => {
    if (!t) return;
    const parts = t.split(/([\r\n])/);
    for (const part of parts) {
      if (part === '\n') { lines.push([]); crPending = false; continue; }
      if (part === '\r') { crPending = true; continue; }
      if (!part) continue;
      if (crPending) { lines[lines.length - 1] = []; crPending = false; }
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && styleKey(last.st) === styleKey(st)) last.text += part;
      else line.push({ text: part, st: { ...st } });
    }
  };
  let idx = 0;
  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(text))) {
    pushText(text.slice(idx, m.index));
    idx = ANSI_RE.lastIndex;
    if (m[2] === 'm' && m[0].startsWith('\x1b[')) applySgr(st, m[1] || '');
  }
  pushText(text.slice(idx));
  return lines;
}

/**
 * Render ANSI text into a container as styled spans (replaces existing content).
 * @param {HTMLElement} target
 * @param {string} text
 * @param {{maxChars?: number}} [opts]  keep only the tail when the text is huge
 */
export function renderAnsi(target, text, { maxChars = 200000 } = {}) {
  let src = String(text ?? '');
  let clipped = false;
  if (src.length > maxChars) { src = src.slice(src.length - maxChars); clipped = true; }
  const frag = document.createDocumentFragment();
  if (clipped) frag.append(h('span', { class: 'ansi-clip' }, '… output truncated …\n'));
  const lines = parseAnsi(src);
  lines.forEach((line, li) => {
    for (const seg of line) {
      const s = seg.st;
      if (!s.fg && !s.bg && !s.b && !s.d && !s.i && !s.u && !s.inv) {
        frag.append(document.createTextNode(seg.text));
        continue;
      }
      const span = document.createElement('span');
      span.textContent = seg.text;
      let fg = s.fg;
      let bg = s.bg;
      if (s.inv) { [fg, bg] = [bg || TERM_THEME.background, fg || TERM_THEME.foreground]; }
      if (fg) span.style.color = fg;
      if (bg) span.style.backgroundColor = bg;
      if (s.b) span.style.fontWeight = '700';
      if (s.d) span.style.opacity = '0.65';
      if (s.i) span.style.fontStyle = 'italic';
      if (s.u) span.style.textDecoration = 'underline';
      frag.append(span);
    }
    if (li < lines.length - 1) frag.append(document.createTextNode('\n'));
  });
  target.replaceChildren(frag);
}

/** HTML-escape (for the rare places that need a string, e.g. titles in attributes). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
