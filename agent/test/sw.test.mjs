// The PWA's service worker (web/sw.js), run in a vm with a fake ServiceWorkerGlobalScope: Monaco's
// runtime cache must be cache-first WITHOUT touching the network for content-hashed chunks (the PC's
// connection may be slow / metered), and must survive a shell version change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'sw.js');
const ORIGIN = 'https://pc.example.test';

function makeScope() {
  const listeners = {};
  const stores = new Map(); // cache name → Map(url → Response)
  const fetched = [];
  const cacheApi = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(key) { const r = m.get(typeof key === 'string' ? key : key.url); return r ? r.clone() : undefined; },
      async put(key, res) { m.set(typeof key === 'string' ? key : key.url, res); },
      async addAll() { /* install: not exercised */ },
      async keys() { return [...m.keys()].map((url) => new Request(url)); },
    };
  };
  const scope = {
    registration: { scope: `${ORIGIN}/`, navigationPreload: null },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    caches: {
      open: async (name) => cacheApi(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    fetch: async (req, init) => {
      const url = typeof req === 'string' ? req : req.url;
      fetched.push({ url, cache: init && init.cache });
      const res = new Response(`body of ${url}`, { status: 200 });
      Object.defineProperty(res, 'type', { value: 'basic' });
      return res;
    },
    URL, Request, Response, Headers, Promise, Set, Map,
  };
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(SW, 'utf8'), scope, { filename: 'sw.js' });
  return { scope, listeners, stores, fetched };
}

/** Dispatch a fetch event; resolves with {response, waitUntil: Promise[]}. */
async function dispatchFetch(env, url) {
  let responded = null;
  const waits = [];
  const req = new Request(url);
  env.listeners.fetch({ request: req, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
  const response = responded ? await responded : null;
  await Promise.all(waits);
  return { response, responded: !!responded };
}

const CHUNK = `${ORIGIN}/vendor/monaco/vs/editor-BdtEMBbM.js`; // content-hashed
const LOADER = `${ORIGIN}/vendor/monaco/vs/loader.js`; // fixed name

test('sw: a cached content-hashed Monaco chunk is served without any network request', async () => {
  const env = makeScope();
  const first = await dispatchFetch(env, CHUNK);
  assert.equal(first.responded, true);
  assert.equal(await first.response.text(), `body of ${CHUNK}`);
  assert.equal(env.fetched.length, 1, 'first load fetches once');
  const cacheName = [...env.stores.keys()].find((k) => /monaco/.test(k));
  assert.ok(cacheName && env.stores.get(cacheName).has(CHUNK), 'stored in the Monaco cache');

  const second = await dispatchFetch(env, CHUNK);
  assert.equal(await second.response.text(), `body of ${CHUNK}`);
  assert.equal(env.fetched.length, 1, 'second load must not touch the network');
});

test('sw: a cached fixed-name Monaco file is served from cache and revalidated in the background', async () => {
  const env = makeScope();
  await dispatchFetch(env, LOADER);
  assert.equal(env.fetched.length, 1);
  const again = await dispatchFetch(env, LOADER);
  assert.equal(await again.response.text(), `body of ${LOADER}`);
  assert.equal(env.fetched.length, 2, 'background revalidation');
  assert.equal(env.fetched[1].cache, 'no-cache');
});

test('sw: activating a new shell version keeps the Monaco cache', async () => {
  const env = makeScope();
  await dispatchFetch(env, CHUNK);
  env.stores.set('termpocket-shell-v0', new Map());
  let done = null;
  env.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  const names = [...env.stores.keys()];
  assert.ok(!names.includes('termpocket-shell-v0'), 'old shell cache removed');
  assert.ok(names.some((k) => /monaco/.test(k)), 'Monaco cache kept');
});

test('sw: caches from before the rename (vscontrol-*) are removed; their Monaco files are adopted', async () => {
  const env = makeScope();
  const oldChunk = `${ORIGIN}/vendor/monaco/vs/editor-old-ABCDEFGH.js`;
  env.stores.set('vscontrol-shell-v9', new Map([[`${ORIGIN}/index.html`, new Response('old shell')]]));
  env.stores.set('vscontrol-monaco-v1', new Map([[oldChunk, new Response('old monaco chunk')]]));
  let done = null;
  env.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  const names = [...env.stores.keys()];
  assert.ok(!names.some((k) => k.startsWith('vscontrol-')), `legacy caches removed: ${names}`);
  const monaco = names.find((k) => /^termpocket-monaco/.test(k));
  assert.ok(monaco, 'new Monaco cache exists');
  assert.equal(await env.stores.get(monaco).get(oldChunk).clone().text(), 'old monaco chunk');
  // …and is then served from the cache without touching the network.
  const r = await dispatchFetch(env, oldChunk);
  assert.equal(await r.response.text(), 'old monaco chunk');
  assert.equal(env.fetched.length, 0);
});
