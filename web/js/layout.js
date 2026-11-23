// Desktop vs phone layout (PROTOCOL §8.3).
//
// "Desktop" = a window at least 900 px wide with a fine pointer (mouse / trackpad). The decision is
// made here with matchMedia and published as the `desk` class on <html> (set before first paint by
// a tiny inline script in index.html with the same rule), so CSS and JS always agree. The user can
// override it in the menu (Auto / Desktop / Phone) — handy for a tablet with a keyboard and mouse.

import { store } from './ui.js';

export const DESKTOP_QUERY = '(min-width: 900px) and (pointer: fine)';
const WIDE_QUERY = '(min-width: 900px)';

const mqDesk = window.matchMedia(DESKTOP_QUERY);
const mqWide = window.matchMedia(WIDE_QUERY);
const listeners = new Set();
let current = compute();
apply();

/** 'auto' | 'desktop' | 'phone' */
export function layoutPref() {
  const v = store.get('layout', 'auto');
  return v === 'desktop' || v === 'phone' ? v : 'auto';
}

function compute() {
  const pref = layoutPref();
  if (pref === 'phone') return false;
  if (pref === 'desktop') return mqWide.matches; // forced, but the window still has to be wide enough
  return mqDesk.matches;
}

function apply() {
  const root = document.documentElement;
  root.classList.toggle('desk', current);
  root.dataset.layout = current ? 'desktop' : 'phone';
}

function update() {
  const next = compute();
  if (next === current) return;
  current = next;
  apply();
  for (const fn of [...listeners]) {
    try { fn(current); } catch (err) { console.error('[termpocket] layout listener failed', err); }
  }
}

mqDesk.addEventListener('change', update);
mqWide.addEventListener('change', update);

/** True when the desktop layout (sidebar, split views) is active. */
export function isDesktop() { return current; }

/** Subscribe to layout changes; returns an unsubscribe function. */
export function onLayoutChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLayoutPref(v) {
  store.set('layout', v);
  update();
}

/** Device has a mouse-like pointer at all (Remote Desktop is offered there). */
export function hasFinePointer() {
  return window.matchMedia('(any-pointer: fine)').matches;
}
