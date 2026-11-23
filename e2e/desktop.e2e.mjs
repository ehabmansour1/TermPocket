#!/usr/bin/env node
// TermPocket — desktop-browser end-to-end test (PROTOCOL §8).
//
// Drives the real PWA (web/) in a local headless Google Chrome as a laptop browser (1440×900, mouse,
// no touch; playwright-core channel "chrome", no browser download) against:
//   * the real agent on 127.0.0.1:<port> in a temp TERMPOCKET_HOME with TERMPOCKET_DRYRUN_INPUT=1
//     (mouse / keyboard / clipboard-write are only logged as "[dryrun] …" lines — nothing touches
//     the desktop),
//   * an isolated VS Code instance (temp profile, extension loaded from ../vscode-extension).
//
// Covers the desktop layout (sidebar, Terminals split view with several live terminal tabs, Code
// split view, System grid, Screen) and Remote Desktop mode (fullscreen state, mouse move / buttons /
// wheel and keyboard → input.* with normalized coordinates under letterboxing and 1:1 panning,
// releaseAll on blur, toolbar shortcuts, clipboard sync against a stubbed navigator.clipboard so the
// user's clipboard is never read or written by the browser).
//
// The v0.2 agent side (input.keyraw, input.releaseAll, monitor -1, deltaX, screen.meta) is required:
// every input is cross-checked against the agent's dry-run log, and the HD stream is measured
// (fps / KB/s / avg frame / meta-before-frame ordering) and reported.
//
// Usage:  node desktop.e2e.mjs [--no-vscode] [--port 18768] [--shots <dir>] [--headed] [--keep-temp]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  E2E_DIR, AgentProcess, IsolatedVsCode, PhoneClient, assert, createSandbox, removeSandbox,
  sleep, waitFor, writeWorkspace,
} from './lib/harness.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(option('--port', process.env.TERMPOCKET_E2E_DESKTOP_PORT || 18768));
const WITH_VSCODE = !flag('--no-vscode');
const HEADED = flag('--headed');
const KEEP_TEMP = flag('--keep-temp');
const SHOTS = path.resolve(option('--shots', process.env.TERMPOCKET_E2E_SHOTS || path.join(E2E_DIR, 'artifacts', 'desktop-shots')));
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const MAX_SHOTS = 14;
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false, colorScheme: 'dark' };

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.jpg')) fs.rmSync(path.join(SHOTS, f));

/* ------------------------------------------------------------------------------------------- */

const results = [];
class SkipError extends Error {}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: 'pass', ms: Date.now() - t0, detail: detail ?? '' });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const skip = err instanceof SkipError;
    results.push({ name, result: skip ? 'skip' : 'fail', ms: Date.now() - t0, detail: err.message });
    console.log(`  ${skip ? 'skip' : 'FAIL'} ${name} — ${err.message.split('\n')[0]}`);
    if (!skip) {
      try { await page?.screenshot({ path: path.join(ARTIFACTS, `desktop-fail-${results.length}.jpg`), type: 'jpeg', quality: 60 }); } catch { /* ignore */ }
    }
    return false;
  }
}

let shotCount = 0;
async function shot(name) {
  if (shotCount >= MAX_SHOTS || !page) return;
  shotCount++;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `${String(shotCount).padStart(2, '0')}-${name}.jpg`), type: 'jpeg', quality: 72 });
}

/* ------------------------------------------------------------------------------------------- */

const dirs = createSandbox('termpocket-desktop-e2e-');
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'desktop-agent.log') });
const code = WITH_VSCODE ? new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'desktop-vscode-main.log') }) : null;
let client = null;
let browser = null;
let context = null;
let page = null;
let mon = null; // the monitor streamed in RDP mode
const problems = { console: [], pageErrors: [] };

// The browser never touches the real clipboard: navigator.clipboard is replaced by a stub that
// returns a fixed text and only records the LENGTH of what it is asked to write.
const INIT_SCRIPT = () => {
  window.__clip = { local: 'e2e-local-clipboard-text', written: [], reads: 0 };
  window.__wheels = [];
  window.addEventListener('wheel', (e) => window.__wheels.push([e.deltaMode, e.deltaX, e.deltaY, e.wheelDeltaX, e.wheelDeltaY]), { capture: true, passive: true });
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => { window.__clip.reads++; return window.__clip.local; },
        writeText: async (t) => { window.__clip.written.push(String(t).length); },
      },
    });
  } catch { /* ignore */ }
};

const sent = [];      // every JSON request the page sent {m, p}
const metas = [];     // screen.meta events received
const recv = [];      // stream log in arrival order: {k:'meta', seq, mon, w, h, at} | {k:'frame', seq, mon, size, at}
function watch(p) {
  p.on('console', (m) => { if (m.type() === 'error') problems.console.push(m.text()); });
  p.on('pageerror', (err) => problems.pageErrors.push(err.message));
  p.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.startsWith('{"t":"req"')) return;
      try { const j = JSON.parse(f.payload); if (j.m !== 'screen.ack') sent.push({ m: j.m, p: j.p, at: Date.now() }); } catch { /* ignore */ }
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string') {
        if (f.payload.includes('"screen.meta"')) {
          try {
            const m = JSON.parse(f.payload).p;
            metas.push(m);
            recv.push({ k: 'meta', seq: m.seq, mon: m.monitor, w: m.width, h: m.height, at: Date.now() });
          } catch { /* ignore */ }
        }
      } else if (f.payload && f.payload.length > 7 && f.payload[0] === 0x01) {
        const b = f.payload;
        recv.push({ k: 'frame', seq: b.readUInt32BE(1), mon: b.readUInt16BE(5), size: b.length, at: Date.now() });
      }
    });
  });
}
const sentSince = (i, m) => sent.slice(i).filter((x) => !m || x.m === m);

async function tab(id) {
  await page.click(`#tab-${id}`);
  await page.waitForSelector(`#panel-${id}.active`);
}

const activeTermRows = () => page.$$eval('.term-deck .deck-pane:not([hidden]) .xterm-rows > div', (rows) => rows.map((r) => r.textContent.replace(/ /g, ' ').trim()));
async function waitActiveLine(pred, what, timeout = 15000) {
  return waitFor(async () => (await activeTermRows()).some(pred), { timeout, what: `terminal line ${what}` });
}

async function expectToast(re, timeout = 8000) {
  await waitFor(async () => (await page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent))).some((t) => re.test(t)), { timeout, what: `toast ${re}` });
}

const canvasRect = () => page.evaluate(() => {
  const r = document.querySelector('.screen-canvas').getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
});

async function revealBar() {
  await page.mouse.move(720, 1);
  await page.waitForSelector('.rdp-bar.show', { timeout: 4000 });
}

const near = (a, b, tol = 0.012) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------------------------------- */

/** Stream stats over `ms` from the received meta/frame log; checks meta precedes every frame (same seq). */
const hd = {};
async function measureStream(ms, monIndex) {
  const i0 = recv.length;
  const t0 = Date.now();
  await sleep(ms);
  const dt = (Date.now() - t0) / 1000;
  const log = recv.slice(i0);
  const frames = log.filter((x) => x.k === 'frame');
  const wire = monIndex === -1 ? 0xffff : monIndex;
  for (let i = 0; i < log.length; i++) {
    if (log[i].k !== 'frame') continue;
    const prev = log[i - 1];
    assert(prev && prev.k === 'meta' && prev.seq === log[i].seq, `frame seq ${log[i].seq} not preceded by its screen.meta (prev ${JSON.stringify(prev)})`);
    assert(log[i].mon === wire, `frame header monitor ${log[i].mon}, want ${wire}`);
  }
  const bytes = frames.reduce((a, f) => a + f.size, 0);
  const metaOnly = log.filter((x, i) => x.k === 'meta' && !(log[i + 1] && log[i + 1].k === 'frame' && log[i + 1].seq === x.seq)).length;
  const lastMeta = [...log].reverse().find((x) => x.k === 'meta');
  const stats = await page.evaluate(() => (document.querySelector('.rdp-stats') && document.body.classList.contains('rdp')
    ? document.querySelector('.rdp-stats').textContent : document.querySelector('.stage-stats')?.textContent) || '');
  return {
    seconds: +dt.toFixed(1), frames: frames.length, fps: +(frames.length / dt).toFixed(2),
    kbps: +(bytes / 1024 / dt).toFixed(1), avgKB: frames.length ? +(bytes / 1024 / frames.length).toFixed(1) : 0,
    metaOnly, width: lastMeta ? lastMeta.w : 0, height: lastMeta ? lastMeta.h : 0, clientStats: stats,
  };
}
const fmtStream = (m) => `${m.width}×${m.height}: ${m.fps} fps, ${m.kbps} KB/s, avg ${m.avgKB} KB/frame, ${m.metaOnly} pointer-only metas over ${m.seconds} s (client: "${m.clientStats}")`;

async function main() {
  console.log(`TermPocket desktop e2e — port ${PORT}, temp ${dirs.tmpRoot}${WITH_VSCODE ? '' : ' (no VS Code)'}`);
  writeWorkspace(dirs);

  await step('start agent (temp TERMPOCKET_HOME, dry-run input)', async () => `pid ${await agent.start()}`);
  if (!agent.running) throw new Error('agent did not start');
  const token = agent.token;
  client = await PhoneClient.open(PORT, token);

  if (code) {
    await step('launch isolated VS Code with the extension', async () => {
      const note = code.launch();
      const wins = await waitFor(async () => {
        const w = await client.request('vsc.windows');
        return w.length ? w : null;
      }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
      return `${note}; window "${wins[0].name}"`;
    });
  }

  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  context = await browser.newContext(DESKTOP);
  await context.addInitScript(INIT_SCRIPT);
  context.setDefaultTimeout(12000);
  page = await context.newPage();
  watch(page);

  /* ------------------------------------------------------------------ shell */

  const ok = await step('desktop layout: left sidebar with nav + host/status replaces the tab bar', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(token)}`);
    await page.waitForSelector('#sideFoot[data-status="online"]', { timeout: 20000 });
    const info = await client.request('sys.info');
    const r = await page.evaluate(() => {
      const box = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return {
        desk: document.documentElement.classList.contains('desk'),
        layout: document.documentElement.dataset.layout,
        sidebar: box('.sidebar'), panels: box('#panels'),
        tabs: [...document.querySelectorAll('.tab')].map((t) => { const b = t.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y) }; }),
        foot: document.querySelector('#sideFoot').textContent,
        pillShown: document.getElementById('statusPill').getBoundingClientRect().width > 0,
      };
    });
    assert(r.desk && r.layout === 'desktop', `layout ${r.layout}`);
    assert(r.sidebar && r.sidebar.x === 0 && r.sidebar.w >= 200 && r.sidebar.w <= 280 && r.sidebar.h >= 890, `sidebar ${JSON.stringify(r.sidebar)}`);
    assert(r.panels.x >= r.sidebar.w - 1 && r.panels.w > 1100, `panels ${JSON.stringify(r.panels)}`);
    assert(r.tabs.every((t) => t.x === r.tabs[0].x) && r.tabs.every((t, i) => !i || t.y > r.tabs[i - 1].y), `nav not vertical: ${JSON.stringify(r.tabs)}`);
    assert(r.foot.includes(info.hostname) && /Online/.test(r.foot), `sidebar footer "${r.foot}"`);
    assert(!r.pillShown, 'phone status pill still visible');
    return `sidebar ${r.sidebar.w}px; footer "${r.foot}"`;
  });
  if (!ok) throw new Error('desktop layout did not come up; aborting');

  /* -------------------------------------------------------------- terminals */

  let t1 = null;
  let t2 = null;
  await step('Terminals: Ctrl+Shift+T and "+" open two terminals as tabs, each a live xterm', async () => {
    await tab('terminals');
    await page.waitForSelector('.term-deck .deck-empty:not([hidden])');
    await page.click('.term-deck .deck-empty');
    await page.keyboard.press('Control+Shift+T');
    let via = 'Ctrl+Shift+T';
    try {
      await page.waitForSelector('.term-deck .deck-tab', { timeout: 6000 });
    } catch {
      via = '"+" (Ctrl+Shift+T did not reach the page)';
      await page.click('.term-deck .deck-new');
      await page.waitForSelector('.term-deck .deck-tab');
    }
    await page.waitForSelector('.term-deck .deck-pane:not([hidden]) .xterm-rows');
    await waitActiveLine((l) => /^PS .+>/.test(l), 'first prompt', 20000);
    t1 = await page.getAttribute('#panel-terminals .row.current', 'data-pty');
    await page.click('.term-deck .deck-new');
    await waitFor(async () => (await page.$$('.term-deck .deck-tab')).length === 2, { what: 'second tab' });
    await waitFor(async () => { const id = await page.getAttribute('#panel-terminals .row.current', 'data-pty').catch(() => null); return id && id !== t1; }, { what: 'second terminal current' });
    t2 = await page.getAttribute('#panel-terminals .row.current', 'data-pty');
    await waitActiveLine((l) => /^PS .+>/.test(l), 'second prompt', 20000);
    // Physical keyboard straight into xterm (the extra-keys row is hidden on desktop).
    await page.click('.term-deck .deck-pane:not([hidden]) .xterm-screen');
    await page.keyboard.type('echo two-ok');
    await page.keyboard.press('Enter');
    await waitActiveLine((l) => l === 'two-ok', '"two-ok"');
    // The first terminal is hidden but still attached: output produced now must be there later.
    await client.request('pty.input', { id: t1, d: "Write-Output ('bg' + '-ok')\r" });
    await sleep(1500);
    await page.click('.term-deck .deck-tab:first-child');
    await waitActiveLine((l) => l === 'bg-ok', '"bg-ok" written while the tab was hidden');
    await page.keyboard.type('echo one-ok');
    await page.keyboard.press('Enter');
    await waitActiveLine((l) => l === 'one-ok', '"one-ok" typed after switching tabs (focus follows the tab)');
    const xkeysHidden = await page.$eval('.term-deck .deck-pane:not([hidden]) .xkeys', (e) => e.hidden || e.getBoundingClientRect().height === 0);
    assert(xkeysHidden, 'extra-keys row visible by default on desktop');
    const list = await client.request('pty.list');
    assert(list.some((s) => s.id === t1) && list.some((s) => s.id === t2), 'sessions missing in pty.list');
    return `${t1} + ${t2} via ${via}`;
  });

  await step('Terminals: extra-keys row toggles; closing a tab detaches (session keeps running)', async () => {
    const pane = '.term-deck .deck-pane:not([hidden])';
    await page.click(`${pane} .keys-toggle`);
    await page.waitForSelector(`${pane} .xkeys:not([hidden])`);
    await page.click(`${pane} .keys-toggle`);
    await page.waitForSelector(`${pane} .xkeys[hidden]`, { state: 'attached' });
    await page.click('.term-deck .deck-tab:nth-child(2)');
    await shot('desktop-terminals');
    await page.click('.term-deck .deck-tab:nth-child(2) .deck-tab-close');
    await waitFor(async () => (await page.$$('.term-deck .deck-tab')).length === 1, { what: 'tab closed' });
    const list = await client.request('pty.list');
    assert(list.some((s) => s.id === t2 && !s.exited), 'closing the tab killed the session');
    // Re-open from the list → it comes back as a tab.
    await page.click(`#panel-terminals .row[data-pty="${t2}"] .row-main`);
    await waitFor(async () => (await page.$$('.term-deck .deck-tab')).length === 2, { what: 'tab re-opened from the list' });
    return 'toggle ok; close = detach; re-open from list';
  });

  /* ------------------------------------------------------------------- code */

  await step('Code: VS Code workbench — explorer | Monaco editor tabs | panel; edit + Ctrl+S saves; VS Code diagnostics as squiggles', async () => {
    if (!code) throw new SkipError('no VS Code');
    await tab('code');
    const row = (name) => page.locator('.wb-tree-row').filter({ has: page.locator('.wb-tree-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) }).first();
    // Monaco renders spaces as U+00A0 in its view lines.
    const editorText = async () => (await page.textContent('.wb .monaco-editor .view-lines').catch(() => '') || '').replace(/\u00a0/g, ' ');
    await row('hello.js').waitFor({ timeout: 30000 });
    await row('hello.js').dblclick(); // double-click = pinned tab (single click = preview)
    await waitFor(async () => /greet/.test(await editorText()), { timeout: 30000, what: 'hello.js in Monaco' });
    await row('README.md').click();
    await waitFor(async () => (await page.$$('.wb-tab')).length === 2 && /PWA e2e workspace/.test(await editorText()), { what: 'README in a second (preview) tab' });
    assert(await page.$('.wb-tab.active.preview'), 'single click opens a preview (italic) tab');
    await page.click('.wb .monaco-editor .view-lines');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('# Desktop e2e');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Edited in the desktop workbench.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wb-tab.active.dirty:not(.preview)'); // editing pins the preview tab
    await page.keyboard.press('Control+s');
    const next = '# Desktop e2e\n\nEdited in the desktop workbench.\n';
    await waitFor(() => fs.readFileSync(path.join(dirs.workspace, 'README.md'), 'utf8') === next, { timeout: 10000, what: 'README on disk' });
    await page.waitForSelector('.wb-tab.active:not(.dirty)');
    // VS Code analyses broken.js once it is open there; its diagnostics become Monaco markers here.
    await client.vsc((await client.request('vsc.windows'))[0].windowId, 'editor.open', { path: path.join(dirs.workspace, 'broken.js') });
    await row('broken.js').dblclick();
    const n = await waitFor(async () => {
      const c = await page.$$eval('.wb .monaco-editor .squiggly-error', (els) => els.length);
      return c > 0 ? c : null;
    }, { timeout: 30000, interval: 1000, what: 'VS Code errors as squiggles' });
    const geo = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      return { act: b('.wb-activity'), side: b('.wb-sidebar'), editor: b('.wb-editor-part'), panel: b('.wb-panel'), status: b('.wb-statusbar') };
    });
    assert(geo.act.right <= geo.side.left + 1 && geo.side.right <= geo.editor.left + 2 && (!geo.panel || geo.panel.height === 0 || geo.editor.bottom <= geo.panel.top + 2) && geo.status.height === 22, `workbench geometry ${JSON.stringify(geo)}`);
    await shot('desktop-code');
    return `3 editor tabs; ${n} error squiggle(s); side bar ${Math.round(geo.side.width)}px`;
  });

  /* ----------------------------------------------------------------- system */

  await step('System: multi-column grid (cards row, power/clipboard left, processes right)', async () => {
    await tab('system');
    await page.waitForSelector('#panel-system .info-card .info-big', { timeout: 20000 });
    await page.waitForSelector('#panel-system .proc-row', { timeout: 20000 });
    const g = await page.evaluate(() => {
      const p = document.getElementById('panel-system');
      const b = (e) => e.getBoundingClientRect();
      const cards = [...p.querySelectorAll('.info-card')].map((c) => Math.round(b(c).top));
      const secs = [...p.querySelectorAll('.sys-section')];
      return {
        cols: getComputedStyle(p).gridTemplateColumns.split(' ').length,
        firstRow: cards.filter((t) => t === cards[0]).length,
        power: b(secs[0]), procs: b(p.querySelector('.sys-section.procs')),
      };
    });
    assert(g.cols === 2, `grid columns ${g.cols}`);
    assert(g.firstRow >= 4, `only ${g.firstRow} cards in the first row`);
    assert(g.procs.left > g.power.right && Math.abs(g.procs.top - g.power.top) < 4, `processes not beside power: ${JSON.stringify(g)}`);
    await shot('desktop-system');
    return `${g.firstRow} cards per row; 2 columns`;
  });

  /* ----------------------------------------------------------------- screen */

  await step('Screen: large canvas, HD preset (desktop only) streams 1920 px frames', async () => {
    const mons = await client.request('screen.monitors');
    await tab('screen');
    await page.waitForFunction(() => document.querySelector('.screen-canvas').width > 16, null, { timeout: 20000 });
    await page.click('#panel-screen .seg-btn:has-text("HD")');
    const idx = await page.evaluate(() => Number(localStorage.getItem('termpocket.screenMonitor') || 0));
    mon = mons.find((m) => m.index === idx) || mons.find((m) => m.primary) || mons[0];
    const want = Math.min(1920, mon.width);
    await page.waitForFunction((w) => document.querySelector('.screen-canvas').width === w, want, { timeout: 15000 });
    const start = [...sent].reverse().find((x) => x.m === 'screen.start');
    assert(start && start.p.fps === 10 && start.p.quality === 65 && start.p.maxWidth === 1920, `screen.start ${JSON.stringify(start && start.p)}`);
    const r = await canvasRect();
    assert(r.width >= 1000, `canvas only ${r.width}px wide`);
    await shot('desktop-screen');
    hd.main = await measureStream(8000, mon.index);
    assert(hd.main.frames > 0, `no HD frames in 8 s: ${JSON.stringify(hd.main)}`);
    assert(hd.main.width === want, `HD frame width ${hd.main.width} (want ${want})`);
    return `${want}px frames shown ${Math.round(r.width)}×${Math.round(r.height)}; HD stream ${fmtStream(hd.main)}`;
  });

  /* --------------------------------------------------------- remote desktop */

  let entered = false;
  await step('RDP: "Remote Desktop" fills the window (Fullscreen API) with the toolbar shown', async () => {
    await page.click('#panel-screen .rdp-enter');
    await page.waitForSelector('.screen-tab[data-rdp="on"]');
    entered = true;
    await sleep(800);
    const st = await page.evaluate(() => {
      const r = document.querySelector('.screen-tab').getBoundingClientRect();
      return {
        rect: [r.left, r.top, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight,
        body: document.body.classList.contains('rdp'), fs: !!document.fullscreenElement,
        dsFs: document.querySelector('.screen-tab').dataset.fullscreen, lock: document.querySelector('.screen-tab').dataset.kbdlock,
        bar: document.querySelector('.rdp-bar').classList.contains('show'),
        sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
      };
    });
    assert(st.body && st.rect[0] === 0 && st.rect[1] === 0 && st.rect[2] === st.vw && st.rect[3] === st.vh, `rdp view ${JSON.stringify(st)}`);
    assert(st.bar, 'toolbar not shown on entering');
    await page.waitForFunction(() => document.querySelector('.screen-canvas').width > 16 && !document.querySelector('.stage-msg:not([hidden])'), null, { timeout: 15000 });
    await shot('rdp-mode');
    hd.rdp = await measureStream(6000, mon.index);
    return `RDP stream ${fmtStream(hd.rdp)}; fullscreen API ${st.fs ? 'accepted' : 'rejected (headless) — in-page RDP state verified'}; keyboard lock ${st.lock}; ${st.vw}×${st.vh}`;
  });

  await step('RDP: mouse move / left, right, middle down+up map to normalized coords under letterboxing', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    await page.mouse.move(700, 450); // let the toolbar auto-hide away from the top edge
    const r = await canvasRect();
    const vh = 900;
    assert(r.top > 5 || r.left > 5 || r.height < vh - 5 || r.width < 1435, `expected letterboxing, canvas ${JSON.stringify(r)}`);
    const at = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy });
    const i0 = sent.length;
    const mark = agent.mark();
    const p = at(0.25, 0.4);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await waitFor(() => sentSince(i0, 'input.mouse').some((x) => x.p.action === 'move' && near(x.p.x, 0.25) && near(x.p.y, 0.4)), { timeout: 4000, what: 'move frame' });
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.down({ button: 'middle' });
    await page.mouse.up({ button: 'middle' });
    await waitFor(() => sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'up').length >= 3, { timeout: 4000, what: '3 button-ups' });
    const btns = sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'down' || x.p.action === 'up').map((x) => `${x.p.action}/${x.p.button}`);
    assert(JSON.stringify(btns) === JSON.stringify(['down/left', 'up/left', 'down/right', 'up/right', 'down/middle', 'up/middle']), `buttons ${btns}`);
    const down = sentSince(i0, 'input.mouse').find((x) => x.p.action === 'down');
    assert(near(down.p.x, 0.25) && near(down.p.y, 0.4) && down.p.monitor === mon.index, `down ${JSON.stringify(down.p)}`);
    const dry = await waitFor(() => agent.dryRuns(mark).find((d) => d.method === 'input.mouse' && d.args.action === 'down'), { timeout: 5000, what: 'dry-run down' });
    const ex = mon.x + 0.25 * mon.width;
    const ey = mon.y + 0.4 * mon.height;
    assert(Math.abs(dry.args.x - ex) <= mon.width * 0.012 && Math.abs(dry.args.y - ey) <= mon.height * 0.012, `agent pixels ${JSON.stringify(dry.args)} vs ${ex},${ey}`);
    assert(!sentSince(i0).some((x) => x.m === 'input.mouse' && x.p.action === 'dblclick' || x.p && x.p.action === 'click'), 'synthesized click/dblclick sent');
    // A click on the letterbox bar is not a click on the PC.
    const i1 = sent.length;
    const barPt = r.top > 5 ? { x: 40, y: r.top / 2 + 3 } : { x: r.left / 2, y: 450 };
    await page.mouse.click(barPt.x, barPt.y);
    await sleep(400);
    assert(!sentSince(i1, 'input.mouse').some((x) => x.p.action === 'down'), 'click on the letterbox sent a button');
    const moves = sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'move').length;
    return `canvas ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}; down → (${dry.args.x}, ${dry.args.y}) px; ${moves} moves`;
  });

  await step('RDP: mouse moves are throttled (~30/s) and coalesced', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const r = await canvasRect();
    const i0 = sent.length;
    const t0 = Date.now();
    for (let k = 0; k <= 60; k++) await page.mouse.move(r.left + r.width * (0.2 + k / 120), r.top + r.height * 0.5);
    const ms = Date.now() - t0;
    await sleep(200);
    const moves = sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'move');
    const last = moves[moves.length - 1];
    assert(moves.length < 61 && moves.length <= Math.ceil(ms / 33) + 3, `${moves.length} moves for 61 pointer events in ${ms} ms`);
    assert(last && near(last.p.x, 0.7), `last move ${JSON.stringify(last && last.p)} (should end at the final pointer position)`);
    return `61 pointermoves in ${ms} ms → ${moves.length} input.mouse moves`;
  });

  await step('RDP: wheel → scroll notches (120 px = 1), vertical and horizontal', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const r = await canvasRect();
    await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
    const mark = agent.mark();
    let i0 = sent.length;
    await page.evaluate(() => { window.__wheels.length = 0; });
    // CDP wheel events are classic wheel ticks: Chrome gives each one wheelDelta ±120 whatever its
    // deltaY, and the client counts wheelDelta/120 notches (§8.3). So one event = one notch here.
    await page.mouse.wheel(0, -120);
    await page.mouse.wheel(0, -120);
    await waitFor(() => sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'scroll').reduce((a, x) => a + x.p.delta, 0) === 2, { timeout: 4000, what: '+2 notches (up)' })
      .catch(async (err) => {
        throw new Error(`${err.message}; wheel events ${JSON.stringify(await page.evaluate(() => window.__wheels))}; scroll frames ${JSON.stringify(sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'scroll').map((x) => x.p))}`);
      });
    i0 = sent.length;
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(0, 120);
    await waitFor(() => sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'scroll').reduce((a, x) => a + x.p.delta, 0) === -3, { timeout: 4000, what: '-3 notches (down)' });
    // Trackpad-like small pixel deltas (wheelDelta not a multiple of 120) accumulate: 6 × 20 px = 1
    // notch. CDP can't produce those, so these are constructed WheelEvents on the canvas.
    i0 = sent.length;
    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      for (let k = 0; k < 6; k++) {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
    }, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    await waitFor(() => sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'scroll').reduce((a, x) => a + x.p.delta, 0) === 1, { timeout: 4000, what: '6×20px → 1 notch' });
    i0 = sent.length;
    await page.mouse.wheel(120, 0);
    await page.mouse.wheel(120, 0);
    await waitFor(() => sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'scroll').reduce((a, x) => a + (x.p.deltaX || 0), 0) === 2, { timeout: 4000, what: 'deltaX +2 (right)' });
    const dry = await waitFor(() => {
      const d = agent.dryRuns(mark).filter((x) => x.method === 'input.mouse' && x.args.action === 'scroll');
      return d.reduce((a, x) => a + (x.args.deltaX || 0), 0) === 2 ? d : null;
    }, { timeout: 4000, what: 'dry-run deltaX +2' });
    const sumY = dry.reduce((a, d) => a + (d.args.delta || 0), 0);
    assert(sumY === 0 && dry.some((d) => d.args.delta > 0) && dry.some((d) => d.args.delta < 0), `dry-run scrolls ${JSON.stringify(dry.map((d) => [d.args.delta, d.args.deltaX]))}`);
    return `agent scrolled +2, -3, +1 (vertical) and deltaX +2 (horizontal) — ${dry.length} scroll calls`;
  });

  let keyrawSupported = null;
  await step('RDP: keydown/keyup → input.keyraw (preventDefault: Ctrl+W, Tab stay in the page; repeats re-send down)', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const mark = agent.mark();
    const i0 = sent.length;
    await page.keyboard.down('a');
    await page.keyboard.up('a');
    await page.keyboard.down('Control');
    await page.keyboard.press('w');
    await page.keyboard.up('Control');
    await page.keyboard.press('Tab');
    await page.keyboard.down('b');
    await page.keyboard.down('b'); // auto-repeat
    await page.keyboard.up('b');
    await sleep(600);
    const raw = sentSince(i0, 'input.keyraw').map((x) => `${x.p.code}${x.p.down ? '↓' : '↑'}`);
    const want = ['KeyA↓', 'KeyA↑', 'ControlLeft↓', 'KeyW↓', 'KeyW↑', 'ControlLeft↑', 'Tab↓', 'Tab↑', 'KeyB↓', 'KeyB↓', 'KeyB↑'];
    assert(JSON.stringify(raw.slice(0, want.length)) === JSON.stringify(want), `keyraw frames ${raw.join(' ')}`);
    assert(!page.isClosed(), 'Ctrl+W closed the page');
    const focus = await page.evaluate(() => (document.activeElement && document.activeElement.className) || '');
    assert(!/btn|input/.test(focus), `Tab moved focus to "${focus}"`);
    const dry = await waitFor(() => {
      const d = agent.dryRuns(mark).filter((x) => x.method === 'input.keyraw');
      return d.length >= want.length ? d : null;
    }, { timeout: 4000, what: `${want.length} dry-run keyraw records` });
    keyrawSupported = true;
    assert(!sentSince(i0).some((x) => x.m === 'input.key' || x.m === 'input.text'), 'client fell back to input.key / input.text');
    const got = dry.slice(0, want.length).map((d) => `${d.args.code}${d.args.up ? '↑' : '↓'}`);
    assert(JSON.stringify(got) === JSON.stringify(want), `agent order ${got.join(' ')}`);
    const a = dry[0].args;
    const ctl = dry[2].args;
    assert(a.scan === 0x1e && !a.ext && ctl.scan === 0x1d && !ctl.ext, `scan codes KeyA ${JSON.stringify(a)}, ControlLeft ${JSON.stringify(ctl)}`);
    return `${raw.length} keyraw frames, agent ran them in order (KeyA scan 0x1E, ControlLeft 0x1D)`;
  });

  await step('RDP: blur → input.releaseAll (held Shift is released)', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const mark = agent.mark();
    const i0 = sent.length;
    await page.keyboard.down('Shift');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitFor(() => sentSince(i0, 'input.releaseAll').length > 0 || sentSince(i0, 'input.keyraw').some((x) => x.p.code === 'ShiftLeft' && !x.p.down),
      { timeout: 3000, what: 'releaseAll (or manual release)' });
    await page.keyboard.up('Shift');
    await sleep(300);
    const sentRelease = sentSince(i0, 'input.releaseAll').length;
    assert(sentRelease > 0, 'input.releaseAll not sent');
    const rel = await waitFor(() => agent.dryRuns(mark).find((d) => d.method === 'input.releaseAll'), { timeout: 3000, what: 'dry-run input.releaseAll' });
    assert(Array.isArray(rel.args.keys) && rel.args.keys.includes('ShiftLeft'), `agent released ${JSON.stringify(rel.args)} (ShiftLeft was held)`);
    return `releaseAll sent; agent released ${JSON.stringify(rel.args.keys)}`;
  });

  await step('RDP: toolbar — Task Manager / Win / Alt+Tab send keyraw sequences', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const seqOf = (i) => sentSince(i, 'input.keyraw').map((x) => `${x.p.code}${x.p.down ? '↓' : '↑'}`).join(' ');
    await revealBar();
    let i0 = sent.length;
    await page.click('.rdp-taskmgr');
    await waitFor(() => sentSince(i0, 'input.keyraw').length >= 6 || sentSince(i0, 'input.key').length, { timeout: 3000, what: 'task manager keys' });
    const tm = seqOf(i0);
    if (keyrawSupported !== false) assert(tm.startsWith('ControlLeft↓ ShiftLeft↓ Escape↓ Escape↑ ShiftLeft↑ ControlLeft↑'), `task manager: ${tm}`);
    await revealBar();
    i0 = sent.length;
    await page.click('.rdp-win');
    await sleep(300);
    const win = seqOf(i0);
    await revealBar();
    i0 = sent.length;
    await page.click('.rdp-alttab');
    await sleep(300);
    const alt = seqOf(i0);
    assert(win.startsWith('MetaLeft↓ MetaLeft↑'), `win: ${win}`);
    assert(alt.startsWith('AltLeft↓ Tab↓ Tab↑ AltLeft↑'), `alt+tab: ${alt}`);
    assert(keyrawSupported, 'input.keyraw not supported by the agent');
    return `${tm} | ${win} | ${alt}`;
  });

  await step('RDP: clipboard push (stubbed local text → clip.set) and pull (clip.get → writeText)', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const mark = agent.mark();
    await revealBar();
    let i0 = sent.length;
    await page.click('.rdp-clip-push');
    await waitFor(() => sentSince(i0, 'clip.set').length, { timeout: 4000, what: 'clip.set' });
    const set = sentSince(i0, 'clip.set')[0];
    assert(set.p.text === 'e2e-local-clipboard-text', 'clip.set text');
    await waitFor(() => agent.dryRuns(mark).some((d) => d.method === 'clip.set' && d.args.length === 24), { timeout: 4000, what: 'dry-run clip.set' });
    await revealBar();
    i0 = sent.length;
    const before = await page.evaluate(() => window.__clip.written.length);
    await page.click('.rdp-clip-pull');
    await waitFor(() => sentSince(i0, 'clip.get').length, { timeout: 4000, what: 'clip.get' });
    await sleep(500);
    const after = await page.evaluate(() => window.__clip.written.length);
    // Ctrl+C in RDP mode schedules a pull ~300 ms later.
    i0 = sent.length;
    await page.mouse.move(700, 450);
    await page.keyboard.press('Control+c');
    await waitFor(() => sentSince(i0, 'clip.get').length, { timeout: 3000, what: 'clip.get after Ctrl+C' });
    return `push → dry-run clip.set (24 chars); pull → ${after - before ? 'local writeText' : 'PC clipboard empty/non-text'}; Ctrl+C → clip.get`;
  });

  await step('RDP: 1:1 view pans at the window edge and coordinates follow the panned picture', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    await revealBar();
    await page.click('.rdp-view');
    await page.click('.popover .pop-item:has-text("1:1 pixels")');
    await page.mouse.move(700, 450);
    await sleep(400);
    const r0 = await canvasRect();
    assert(Math.round(r0.width) === (await page.evaluate(() => document.querySelector('.screen-canvas').width)), `1:1 width ${r0.width}`);
    if (r0.width <= 1441 && r0.height <= 901) throw new SkipError(`frame ${r0.width}×${r0.height} fits the window — nothing to pan`);
    await page.mouse.move(1437, 450, { steps: 3 });
    await sleep(900);
    const r1 = await canvasRect();
    assert(r1.left < r0.left - 50, `no panning: left ${r0.left} → ${r1.left}`);
    const i0 = sent.length;
    await page.mouse.move(1436, 450);
    await sleep(300);
    const r2 = await canvasRect();
    const mv = sentSince(i0, 'input.mouse').filter((x) => x.p.action === 'move').pop();
    const ex = (1436 - r2.left) / r2.width;
    const ey = (450 - r2.top) / r2.height;
    assert(mv && near(mv.p.x, ex, 0.006) && near(mv.p.y, ey, 0.006), `move ${JSON.stringify(mv && mv.p)} vs ${ex.toFixed(4)},${ey.toFixed(4)}`);
    await page.mouse.move(700, 450);
    await shot('rdp-native-1to1');
    await revealBar();
    await page.click('.rdp-view');
    await page.click('.popover .pop-item:has-text("Fit to window")');
    return `panned ${Math.round(r0.left - r1.left)} px; move x ${mv.p.x} = ${ex.toFixed(4)}`;
  });

  await step('RDP: monitor picker offers "All displays" (monitor -1)', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    const mons = await client.request('screen.monitors');
    if (mons.length < 2) throw new SkipError('single monitor');
    await revealBar();
    await page.click('.rdp-mon');
    await page.waitForSelector('.popover .pop-item:has-text("All displays")');
    const i0 = sent.length;
    await page.click('.popover .pop-item:has-text("All displays")');
    await waitFor(() => sentSince(i0, 'screen.start').some((x) => x.p.monitor === -1), { timeout: 4000, what: 'screen.start monitor -1' });
    const res = await waitFor(async () => {
      const t = await page.$$eval('#toasts .toast', (ts) => ts.map((x) => x.textContent).join('|'));
      if (/all displays at once/.test(t)) return 'unsupported';
      const w = await page.evaluate(() => document.querySelector('.screen-canvas').width);
      return w > 16 && !(await page.$('.stage-msg:not([hidden])')) ? `ok ${w}` : null;
    }, { timeout: 15000, what: 'all-displays frames or fallback' });
    let detail = res;
    assert(res !== 'unsupported', 'agent rejected monitor -1 (client fell back to the primary display)');
    {
      const vx = Math.min(...mons.map((m) => m.x));
      const vy = Math.min(...mons.map((m) => m.y));
      const vw = Math.max(...mons.map((m) => m.x + m.width)) - vx;
      const vh = Math.max(...mons.map((m) => m.y + m.height)) - vy;
      const cw = await page.evaluate(() => document.querySelector('.screen-canvas').width);
      assert(cw === Math.min(1920, vw), `all-displays frame width ${cw} (virtual desktop ${vw}×${vh}, HD maxWidth 1920)`);
      const r = await canvasRect();
      const j0 = sent.length;
      const mark = agent.mark();
      await page.mouse.move(r.left + r.width * 0.75, r.top + r.height * 0.5);
      await waitFor(() => sentSince(j0, 'input.mouse').some((x) => x.p.monitor === -1), { timeout: 3000, what: 'move on monitor -1' });
      const mv = sentSince(j0, 'input.mouse').filter((x) => x.p.monitor === -1 && x.p.action === 'move').pop();
      const dryMv = await waitFor(() => agent.dryRuns(mark).filter((d) => d.method === 'input.mouse' && d.args.monitor === -1).pop(), { timeout: 3000, what: 'dry-run move on monitor -1' });
      const ex = vx + mv.p.x * vw;
      const ey = vy + mv.p.y * vh;
      assert(Math.abs(dryMv.args.x - ex) <= 2 && Math.abs(dryMv.args.y - ey) <= 2, `agent pixels ${JSON.stringify(dryMv.args)} vs virtual-desktop ${ex.toFixed(1)},${ey.toFixed(1)}`);
      detail += `; move (${mv.p.x.toFixed(3)}, ${mv.p.y.toFixed(3)}) → desktop px (${dryMv.args.x}, ${dryMv.args.y}) on the ${vw}×${vh} virtual desktop`;
      hd.all = await measureStream(6000, -1);
      detail += `; stream ${fmtStream(hd.all)}`;
      // The PC pointer is always inside "all displays": its marker must follow screen.meta.
      await sleep(1200);
      const lastAll = [...metas].reverse().find((m) => m && (m.monitor === -1 || m.monitor === 65535));
      if (lastAll && lastAll.cursor && lastAll.cursor.visible !== false) {
        await page.waitForSelector('.pc-pointer:not([hidden])', { timeout: 4000 });
        const pos = await page.evaluate(() => {
          const p = document.querySelector('.pc-pointer').getBoundingClientRect();
          const c = document.querySelector('.screen-canvas').getBoundingClientRect();
          return { x: (p.left - c.left) / c.width, y: (p.top - c.top) / c.height };
        });
        const latest = [...metas].reverse().find((m) => m && (m.monitor === -1 || m.monitor === 65535)).cursor;
        assert(near(pos.x, latest.x, 0.02) && near(pos.y, latest.y, 0.02), `marker ${JSON.stringify(pos)} vs meta ${JSON.stringify(latest)}`);
        detail += `; PC pointer marker at (${latest.x.toFixed(3)}, ${latest.y.toFixed(3)})`;
      }
    }
    // back to the original display
    await revealBar();
    await page.click('.rdp-mon');
    await page.click(`.popover .pop-item >> nth=${mons.findIndex((m) => m.index === mon.index)}`);
    await page.waitForFunction(() => !document.querySelector('.stage-msg:not([hidden])'), null, { timeout: 15000 });
    return detail;
  });

  await step('RDP: screen.meta drives the PC pointer marker', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    await sleep(1500);
    assert(metas.length, 'agent sent no screen.meta');
    const last = metas[metas.length - 1];
    const shown = !!(last && last.cursor && last.cursor.visible !== false);
    await page.waitForFunction((want) => !document.querySelector('.pc-pointer').hidden === want, shown, { timeout: 4000 });
    if (!shown) return `${metas.length} meta events; PC pointer is on another display → marker hidden`;
    const m = await page.evaluate(() => {
      const p = document.querySelector('.pc-pointer').getBoundingClientRect();
      const c = document.querySelector('.screen-canvas').getBoundingClientRect();
      return { x: (p.left - c.left) / c.width, y: (p.top - c.top) / c.height };
    });
    const cur = metas[metas.length - 1].cursor;
    assert(near(m.x, cur.x, 0.02) && near(m.y, cur.y, 0.02), `marker at ${JSON.stringify(m)} vs meta ${JSON.stringify(cur)}`);
    return `${metas.length} meta events; marker at (${cur.x.toFixed(3)}, ${cur.y.toFixed(3)})`;
  });

  await step('RDP: Exit button leaves cleanly (releaseAll, fullscreen off, layout back)', async () => {
    if (!entered) throw new SkipError('not in RDP mode');
    await revealBar();
    const i0 = sent.length;
    await page.click('.rdp-exit');
    await page.waitForSelector('.screen-tab[data-rdp="off"]');
    const st = await page.evaluate(() => ({ body: document.body.classList.contains('rdp'), fs: !!document.fullscreenElement, side: document.querySelector('.sidebar').getBoundingClientRect().width }));
    assert(!st.body && !st.fs && st.side > 200, JSON.stringify(st));
    assert(sentSince(i0, 'input.releaseAll').length > 0, 'no releaseAll on exit');
    // Keyboard is no longer captured.
    const j0 = sent.length;
    await page.keyboard.press('a');
    await sleep(300);
    assert(!sentSince(j0, 'input.keyraw').length, 'keys still captured after exit');
    // Ctrl+Alt+Enter re-enters, Ctrl+Alt+Break leaves again.
    await page.mouse.click(700, 500);
    await page.keyboard.press('Control+Alt+Enter');
    await page.waitForSelector('.screen-tab[data-rdp="on"]', { timeout: 4000 });
    await page.keyboard.press('Control+Alt+Pause');
    await page.waitForSelector('.screen-tab[data-rdp="off"]', { timeout: 4000 });
    entered = false;
    return 'exit button + Ctrl+Alt+Enter / Ctrl+Alt+Break';
  });

  /* ------------------------------------------------------------ other sizes */

  await step('Layout at 1280×800 and 1920×1080 (no overflow; screenshots)', async () => {
    const out = [];
    for (const [w, hh] of [[1280, 800], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: hh });
      for (const t of ['terminals', 'code']) {
        await tab(t);
        await sleep(450);
        const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, vh: document.documentElement.clientHeight }));
        assert(ov.sw <= ov.vw && ov.sh <= ov.vh, `${w}x${hh} ${t}: page scrolls ${JSON.stringify(ov)}`);
        if (t === 'terminals' || code) await shot(`${t}-${w}x${hh}`);
      }
      out.push(`${w}×${hh}`);
    }
    await page.setViewportSize(DESKTOP.viewport);
    return out.join(', ');
  });

  await step('Layout pref "Phone" forces the phone layout; "Auto" restores the sidebar', async () => {
    await page.evaluate(() => localStorage.setItem('termpocket.layout', '"phone"'));
    await page.reload();
    await page.waitForSelector('#statusPill[data-status="online"]', { timeout: 20000 });
    const phone = await page.evaluate(() => ({ desk: document.documentElement.classList.contains('desk'), tabbar: document.querySelector('.tabbar').getBoundingClientRect() }));
    assert(!phone.desk && phone.tabbar.bottom >= 899 && phone.tabbar.width > 1400, `phone layout ${JSON.stringify(phone)}`);
    await page.evaluate(() => localStorage.setItem('termpocket.layout', '"auto"'));
    await page.reload();
    await page.waitForSelector('#sideFoot[data-status="online"]', { timeout: 20000 });
    assert(await page.evaluate(() => document.documentElement.classList.contains('desk')), 'auto did not restore the desktop layout');
  });

  await step('Security: a page on another origin cannot open the agent WebSocket (Origin check, §1.1)', async () => {
    // A real browser page served from a different local port (= a different origin) tries /ws and /vscode.
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>other origin</title>'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const evilPage = await context.newPage();
    try {
      await evilPage.goto(`http://127.0.0.1:${srv.address().port}/`);
      const out = await evilPage.evaluate(async (base) => {
        const tryWs = (u) => new Promise((resolve) => {
          const ws = new WebSocket(u);
          ws.onopen = () => { ws.close(); resolve('open'); };
          ws.onerror = () => resolve('refused');
          setTimeout(() => resolve('timeout'), 5000);
        });
        return { ws: await tryWs(`${base}/ws`), vscode: await tryWs(`${base}/vscode`) };
      }, `ws://127.0.0.1:${PORT}`);
      assert(out.ws === 'refused' && out.vscode === 'refused', `cross-origin sockets: ${JSON.stringify(out)}`);
      // The app's own origin still connects (the main page stayed online).
      assert(await page.$('#sideFoot[data-status="online"]'), 'own page went offline');
      return 'cross-origin /ws and /vscode refused (403); same-origin app online';
    } finally {
      await evilPage.close().catch(() => {});
      srv.close();
    }
  });

  await step('No console errors or uncaught page errors', async () => {
    assert(!problems.console.length && !problems.pageErrors.length,
      `console: ${JSON.stringify(problems.console.slice(0, 6))}; page: ${JSON.stringify(problems.pageErrors.slice(0, 6))}`);
  });
}

/* ------------------------------------------------------------------------------------------- */

async function teardown() {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (code && code.proc) {
    await step('quit isolated VS Code (workbench.action.quit), fallback: kill only our instance', async () => {
      let note = 'exited after workbench.action.quit';
      try {
        const wins = client ? await client.request('vsc.windows', {}, 5000) : [];
        for (const w of wins) await client.vsc(w.windowId, 'commands.run', { command: 'workbench.action.quit' }, 8000).catch(() => {});
      } catch { /* agent may be gone */ }
      const gone = await waitFor(async () => (await code.processes()).length === 0, { timeout: 30000, interval: 1000, what: 'VS Code exit' }).then(() => true, () => false);
      if (!gone) note = `force-killed ${await code.killLeftovers()} leftover process(es) of the isolated instance`;
      return note;
    });
  }
  if (client) {
    try {
      for (const s of await client.request('pty.list', {}, 5000)) await client.request('pty.kill', { id: s.id }, 5000).catch(() => {});
    } catch { /* ignore */ }
    client.close();
  }
  await step('stop agent and its child processes', () => agent.stop());
  agent.close();
  if (!KEEP_TEMP) {
    await sleep(500);
    if (!removeSandbox(dirs)) console.log(`  note: could not remove ${dirs.tmpRoot}`);
  }
}

let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err;
  results.push({ name: 'fatal', result: 'fail', ms: 0, detail: err.stack || err.message });
  console.log(`  FATAL ${err.message}`);
} finally {
  await teardown();
}

const pass = results.filter((r) => r.result === 'pass').length;
const fail = results.filter((r) => r.result === 'fail').length;
const skip = results.filter((r) => r.result === 'skip').length;
fs.writeFileSync(path.join(ARTIFACTS, 'desktop-results.json'), JSON.stringify({
  at: new Date().toISOString(), pass, fail, skip, shots: SHOTS, problems, hdStream: hd, results,
}, null, 2));
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped${fatal ? ' (fatal error)' : ''}; screenshots in ${SHOTS}`);
process.exit(fail ? 1 : 0);
