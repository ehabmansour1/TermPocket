/* TermPocket service worker — versioned, cache-first app shell.
 *
 * - Every static file of the PWA (incl. the vendored xterm files) is pre-cached
 *   on install under a versioned cache name; old versions are deleted on activate.
 * - Requests for shell files are answered from the cache first (instant start,
 *   works when the PC is unreachable) and refreshed in the background
 *   (stale-while-revalidate) so the next launch picks up agent-side updates even
 *   without a version bump.
 * - Never intercepts the WebSocket endpoints (/ws, /vscode), /healthz, /pair or the
 *   PC-local monitor (/status, /monitor/ — served by the agent, never cached here).
 * - Monaco (vendor/monaco/, ~25 MB, desktop Code tab only) is NOT pre-cached: its files are cached
 *   at runtime the first time the workbench loads them (cache-first; content-hashed chunk names
 *   never change, the few fixed names are refreshed in the background).
 * - Other workbench modules under js/wb/ that are not in CORE are cached the same way as the shell.
 * Bump VERSION when the file list changes.
 *
 * TermPocket used to be called "VS Control": its caches ("vscontrol-*") are deleted on activate; the
 * Monaco files in the old Monaco cache are moved into the new one first (no second 4.6 MB download).
 */

const VERSION = 'v10'; // renamed to TermPocket (new cache names, old caches adopted / removed)
const CACHE_PREFIX = 'termpocket-shell-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const MONACO_CACHE = 'termpocket-monaco-v1'; // kept across shell versions
const LEGACY_PREFIX = 'vscontrol-'; // caches of the app before the rename
const MONACO_PATH = /\/vendor\/monaco\//;
const HASHED = /-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const WB_PATH = /\/js\/wb\/[^/]+\.(?:js|css)$/;

const CORE = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'js/conn.js',
  'js/pair.js',
  'js/ui.js',
  'js/icons.js',
  'js/vsstate.js',
  'js/terminals.js',
  'js/termview.js',
  'js/termkeys.js',
  'js/vsterm.js',
  'js/execlog.js',
  'js/code.js',
  'js/editor.js',
  'js/screen.js',
  'js/rdp.js',
  'js/layout.js',
  'js/deck.js',
  'js/system.js',
  'js/wb/shell.js',
  'js/wb/base.js',
  'js/wb/explorer.js',
  'js/wb/tabs.js',
  'js/wb/editor-monaco.js',
  'js/wb/wb.css',
  'js/wb/c-common.js',
  'js/wb/palette.js',
  'js/wb/statusbar.js',
  'js/wb/problems.js',
  'js/wb/panel.js',
  'js/wb/wbterminal.js',
  'js/wb/scm.js',
  'js/wb/search.js',
  'js/wb/wbc.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

// Filled by the agent's vendor script; cached when present, never fatal if missing.
const OPTIONAL = [
  'vendor/xterm.js',
  'vendor/xterm.css',
  'vendor/addon-fit.js',
];

const SCOPE = new URL(self.registration.scope);
const toUrl = (p) => new URL(p, SCOPE).href;
const SHELL = new Set([...CORE, ...OPTIONAL].map(toUrl));
const INDEX_URL = toUrl('index.html');
const BYPASS = /^\/(?:ws|vscode|healthz|pair|status|monitor)(?:[/?#]|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map((p) => new Request(toUrl(p), { cache: 'reload' })));
    await Promise.all(OPTIONAL.map(async (p) => {
      try {
        const res = await fetch(new Request(toUrl(p), { cache: 'reload' }));
        if (res.ok) await cache.put(toUrl(p), res);
      } catch { /* optional */ }
    }));
    await self.skipWaiting();
  })());
});

/** Copy every entry of cache `from` that `to` does not have yet into `to` (best effort). */
async function adoptCache(from, to) {
  try {
    const src = await caches.open(from);
    const dst = await caches.open(to);
    for (const req of await src.keys()) {
      if (await dst.match(req)) continue;
      const res = await src.match(req);
      if (res) await dst.put(req, res);
    }
  } catch { /* the old cache is only an optimisation */ }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    for (const name of keys.filter((k) => k.startsWith(LEGACY_PREFIX) && /monaco/.test(k))) await adoptCache(name, MONACO_CACHE);
    await Promise.all(keys
      .filter((k) => (k.startsWith(CACHE_PREFIX) && k !== CACHE) || k.startsWith(LEGACY_PREFIX))
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin) return;
  if (BYPASS.test(url.pathname)) return;
  if (req.headers.get('upgrade')) return;

  if (req.mode === 'navigate') {
    event.respondWith(cacheFirst(event, INDEX_URL, req));
    return;
  }
  const key = url.origin + url.pathname;
  if (SHELL.has(key)) event.respondWith(cacheFirst(event, key, req));
  else if (MONACO_PATH.test(url.pathname)) event.respondWith(monacoCached(event, key, req, HASHED.test(url.pathname)));
  else if (WB_PATH.test(url.pathname)) event.respondWith(cacheFirst(event, key, req));
  // anything else: default network handling
});

/**
 * Serve from cache, refreshing the entry in the background.
 * Falls back to the network (and caches the result) when not cached yet.
 */
async function cacheFirst(event, key, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key, { ignoreSearch: true });
  const refresh = (async () => {
    try {
      const res = await fetch(key === INDEX_URL && req.mode === 'navigate' ? INDEX_URL : req, { cache: 'no-cache' });
      if (res && res.ok && res.type === 'basic') await cache.put(key, res.clone());
      return res;
    } catch {
      return null;
    }
  })();
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const res = await refresh;
  if (res) return res;
  return new Response('TermPocket is offline and this file is not cached yet.', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Monaco files: cache-first in their own cache; non-hashed names are refreshed in the background. */
async function monacoCached(event, key, req, immutable) {
  const cache = await caches.open(MONACO_CACHE);
  const cached = await cache.match(key, { ignoreSearch: true });
  // Started only when needed: a cached content-hashed chunk must not touch the network at all
  // (an eager fetch here would re-request ~100 chunks every time the workbench loads).
  const refresh = async () => {
    try {
      const res = await fetch(req, { cache: immutable ? 'default' : 'no-cache' });
      if (res && res.ok && res.type === 'basic') await cache.put(key, res.clone());
      return res;
    } catch {
      return null;
    }
  };
  if (cached) {
    if (!immutable) event.waitUntil(refresh());
    return cached;
  }
  const res = await refresh();
  return res || new Response('Monaco is not cached yet and the PC is unreachable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
