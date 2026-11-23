#!/usr/bin/env node
// TermPocket — PWA end-to-end test.
//
// Drives the real phone app (web/) in a local headless Google Chrome with Pixel 7 emulation
// (playwright-core, channel "chrome": no browser download) against:
//   * the real agent on 127.0.0.1:<port> in a temp TERMPOCKET_HOME with TERMPOCKET_DRYRUN_INPUT=1
//     (mouse/keyboard/power/kill/clipboard-write/open are only logged as "[dryrun] …" lines),
//   * an isolated VS Code instance (temp profile, extension loaded from ../vscode-extension).
//
// It walks every feature of the app and asserts on the DOM, the agent's dry-run log and the PC
// side (files on disk, pty.list, VS Code terminals). Console errors and page errors must be zero.
// Compact JPEG screenshots go to --shots <dir> (default e2e/artifacts/pwa-shots).
//
// Usage:  node pwa.e2e.mjs [--no-vscode] [--port 18766] [--shots <dir>] [--headed] [--keep-temp]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import {
  E2E_DIR, AgentProcess, IsolatedVsCode, PhoneClient, assert, createSandbox, isAlive, removeSandbox,
  sleep, taskkill, waitFor, writeWorkspace,
} from './lib/harness.mjs';

/* ------------------------------------------------------------------------------------------- */
/* Options                                                                                       */
/* ------------------------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(option('--port', process.env.TERMPOCKET_E2E_PORT || 18766));
const WITH_VSCODE = !flag('--no-vscode');
const HEADED = flag('--headed');
const KEEP_TEMP = flag('--keep-temp');
const SHOTS = path.resolve(option('--shots', process.env.TERMPOCKET_E2E_SHOTS || path.join(E2E_DIR, 'artifacts', 'pwa-shots')));
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const MAX_SHOTS = 14;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 } };

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.jpg')) fs.rmSync(path.join(SHOTS, f));

/* ------------------------------------------------------------------------------------------- */
/* Step bookkeeping                                                                              */
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
      try {
        await page?.screenshot({ path: path.join(ARTIFACTS, `pwa-fail-${results.length}.jpg`), type: 'jpeg', quality: 60 });
      } catch { /* page may be gone */ }
      // Everything after this would only time out: the app itself is gone (e.g. Back left it).
      if (page && !page.isClosed() && !page.url().startsWith(BASE)) throw new Error(`the page left the app (now at ${page.url()})`);
      await closeOverlays();
    }
    return false;
  }
}

let shotCount = 0;
async function shot(name, target) {
  if (shotCount >= MAX_SHOTS) return;
  shotCount++;
  const file = path.join(SHOTS, `${String(shotCount).padStart(2, '0')}-${name}.jpg`);
  const p = target || page;
  // Let view/sheet transitions finish so the shot shows the settled UI, not a cross-fade.
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3000 }).catch(() => {});
  await p.screenshot({ path: file, type: 'jpeg', quality: 70 });
}

/* ------------------------------------------------------------------------------------------- */
/* Environment                                                                                   */
/* ------------------------------------------------------------------------------------------- */

const dirs = createSandbox();
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'pwa-agent.log') });
const code = WITH_VSCODE ? new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'pwa-vscode-main.log') }) : null;
let client = null; // our own phone socket for cross-checks
let browser = null;
let context = null;
let page = null;
let windowId = null;
let dummy = null; // a process we start ourselves, for the proc.kill (dry-run) check
const problems = { console: [], pageErrors: [] };

/** Collect console errors / page errors of a page (all must stay empty). */
function watchPage(p, label) {
  p.on('console', (m) => {
    if (m.type() === 'error') problems.console.push(`[${label}] ${m.text()}`);
  });
  p.on('pageerror', (err) => problems.pageErrors.push(`[${label}] ${err.message}`));
}

/** Track every WebSocket the page opens, so tests can see frames and simulate a dropped link. */
const INIT_SCRIPT = () => {
  const Native = window.WebSocket;
  window.__e2e = { sockets: [], block: false, status: [] };
  class E2EWebSocket extends Native {
    constructor(...args) {
      if (window.__e2e.block) throw new Error('e2e: network blocked');
      super(...args);
      window.__e2e.sockets.push(this);
    }
  }
  window.WebSocket = E2EWebSocket;
};

const sentFrames = []; // JSON frames the page sent (for normalized input coordinates)
let binaryFrames = 0;
function watchSockets(p) {
  p.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"input.')) {
        try {
          sentFrames.push(JSON.parse(f.payload));
        } catch { /* ignore */ }
      }
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') binaryFrames++;
    });
  });
}

const sel = {
  status: '#statusPill',
  termView: '#views .term-view',
  execView: '#views .exec-view',
  vstView: '#views .vsterm-view',
  editorView: '#views .editor-view',
  sheet: '#layers .sheet',
  dialog: '#layers .dialog',
};

/** After a failed step: close dialogs, sheets and full-screen views so the next step starts clean. */
async function closeOverlays() {
  if (!page || page.isClosed()) return;
  for (let i = 0; i < 6; i++) {
    const open = await page.evaluate(() => !!document.querySelector('#layers .dialog-backdrop, #layers .sheet-backdrop, #views .view')).catch(() => false);
    if (!open) return;
    await page.evaluate(() => {
      const d = document.querySelector('#layers .dialog .btn.ghost');
      if (d) { d.click(); return; }
      const s = document.querySelector('#layers .sheet-head [aria-label="Close"]');
      if (s) { s.click(); return; }
      const v = [...document.querySelectorAll('#views .view .view-head .back')].pop();
      if (v) v.click();
    }).catch(() => {});
    await sleep(500);
  }
}

async function status() {
  return page.getAttribute(sel.status, 'data-status');
}

async function waitOnline(timeout = 20000) {
  await page.waitForSelector(`${sel.status}[data-status="online"]`, { timeout });
}

async function tab(id) {
  await page.click(`#tab-${id}`);
  await page.waitForSelector(`#panel-${id}.active`);
}

/** Visible rows of the open xterm, as text. */
async function termRows() {
  return page.$$eval(`${sel.termView} .xterm-rows > div`, (rows) => rows.map((r) => r.textContent.replace(/ /g, ' ')));
}

async function waitTermLine(pred, what, timeout = 15000) {
  return waitFor(async () => (await termRows()).some((l) => pred(l.trim())), { timeout, what: `terminal line ${what}` });
}

async function closeView(selector) {
  await page.click(`${selector} .view-head .back`);
  await page.waitForSelector(selector, { state: 'detached', timeout: 5000 });
}

async function sheetAction(label) {
  const item = page.locator(`${sel.sheet} .action-item`, { hasText: label }).first();
  await item.waitFor({ timeout: 5000 });
  await item.click();
}

async function expectToast(re, timeout = 8000) {
  await waitFor(async () => (await page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent))).some((t) => re.test(t)), { timeout, what: `toast ${re}` });
}

/** Elements sticking out of the viewport horizontally (ignoring intentionally scrollable strips). */
async function overflowReport() {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const scrollableX = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed' && r.left >= vw) continue;
      if ((r.right > vw + 1 || r.left < -1) && !scrollableX(el) && !el.closest('.xterm')) {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return { vw, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), offenders: out.slice(0, 8) };
  });
}

async function expectNoOverflow(label) {
  const r = await overflowReport();
  assert(r.scrollWidth <= r.vw && !r.offenders.length, `${label}: page ${r.scrollWidth}px > ${r.vw}px or offenders ${JSON.stringify(r.offenders)}`);
  return r;
}

/* ------------------------------------------------------------------------------------------- */
/* Main                                                                                          */
/* ------------------------------------------------------------------------------------------- */

async function main() {
  console.log(`TermPocket PWA e2e — port ${PORT}, temp ${dirs.tmpRoot}${WITH_VSCODE ? '' : ' (no VS Code)'}`);
  writeWorkspace(dirs);

  await step('start agent (temp TERMPOCKET_HOME, dry-run input)', async () => `pid ${await agent.start()}`);
  if (!agent.running) throw new Error('agent did not start');
  const token = agent.token;
  client = await PhoneClient.open(PORT, token);

  if (code) {
    await step('launch isolated VS Code with the extension and wait for its window', async () => {
      const note = code.launch();
      const wins = await waitFor(async () => {
        const w = await client.request('vsc.windows');
        return w.length ? w : null;
      }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
      windowId = wins[0].windowId;
      return `${note}; window "${wins[0].name}"`;
    });
  }

  // Dummy process for the proc.kill confirm flow: ~300 MB so it is in the top-150 by memory.
  dummy = spawn(process.execPath, ['-e', "const b = Buffer.alloc(300e6, 1); setInterval(() => b[0]++, 60000)"], { stdio: 'ignore', windowsHide: true });

  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });

  /* ---------------------------------------------------------------- pairing */

  await step('bad token → pairing screen with error; pasting the real link pairs', async () => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
    const p = await ctx.newPage();
    watchPage(p, 'bad-token');
    try {
      await p.goto(`${BASE}/#token=not-the-right-token`);
      await p.waitForSelector('.pair-screen .pair-error:not([hidden])', { timeout: 15000 });
      const err = await p.textContent('.pair-screen .pair-error');
      assert(/rejected/i.test(err), `error text: ${err}`);
      assert(!(await p.evaluate(() => location.hash)), 'token left in URL');
      // Empty / junk input is refused locally.
      await p.fill('.pair-screen input', 'two words');
      await p.click('.pair-screen .pair-go');
      assert(/doesn’t look like/.test(await p.textContent('.pair-screen .pair-error')), 'junk input accepted');
      await shot('pair-bad-token', p);
      await p.fill('.pair-screen input', `${BASE}/#token=${token}`);
      await p.click('.pair-screen .pair-go');
      await p.waitForSelector(`${sel.status}[data-status="online"]`, { timeout: 15000 });
      assert(!(await p.$('.pair-screen')), 'pair screen still open');
      return `"${err.trim()}" → paired by pasting the link`;
    } finally {
      await ctx.close();
    }
  });

  await step('upgrade from VS Control: a token saved under the old "vscontrol.*" keys is adopted (no re-pairing)', async () => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
    await ctx.addInitScript(INIT_SCRIPT);
    try {
      const p = await ctx.newPage();
      watchPage(p, 'legacy');
      await p.goto(`${BASE}/`);
      await p.waitForSelector('.pair-screen', { timeout: 15000 });
      await p.evaluate((t) => { localStorage.setItem('vscontrol.token', t); localStorage.setItem('vscontrol.layout', '"phone"'); }, token);
      await p.reload();
      await p.waitForSelector(`${sel.status}[data-status="online"]`, { timeout: 15000 });
      const st = await p.evaluate(() => ({
        tok: localStorage.getItem('termpocket.token'), layout: localStorage.getItem('termpocket.layout'),
        old: Object.keys(localStorage).filter((k) => k.startsWith('vscontrol.')),
      }));
      assert(st.tok === token && st.layout === '"phone"', `not adopted: ${JSON.stringify(st)}`);
      assert(st.old.length === 0, `old keys left: ${st.old}`);
      assert(!(await p.$('.pair-screen')), 'pair screen still open');
      return 'online with the old token; old keys removed';
    } finally {
      await ctx.close();
    }
  });

  context = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
  await context.addInitScript(INIT_SCRIPT);
  context.setDefaultTimeout(12000);
  page = await context.newPage();
  watchPage(page, 'main');
  watchSockets(page);

  const paired = await step('pairing link #token=… → token stored, stripped from URL, online', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(token)}`);
    await waitOnline();
    const st = await page.evaluate(() => ({ hash: location.hash, href: location.href, tok: localStorage.getItem('termpocket.token') }));
    assert(st.hash === '' && !st.href.includes('token'), `URL still has the token: ${st.href}`);
    assert(st.tok === token, 'token not in localStorage');
    const pill = (await page.textContent(`${sel.status} .status-text`)).trim();
    assert(pill && pill !== 'Connected', `status pill shows "${pill}"`);
    return `status pill "${pill}"`;
  });
  if (!paired) throw new Error('PWA did not pair; aborting');

  /* -------------------------------------------------------------- terminals */

  let ptyId = null;
  await step('Terminals: New terminal sheet → xterm view attaches and shows a prompt', async () => {
    await tab('terminals');
    await page.click('#panel-terminals .panel-actions .btn.primary');
    await page.waitForSelector(`${sel.sheet} .chips`);
    await page.fill(`${sel.sheet} input[placeholder="Title (optional)"]`, 'pwa-term');
    await page.click(`${sel.sheet} .btn.primary.block`);
    await page.waitForSelector(`${sel.termView} .xterm-rows`, { timeout: 10000 });
    await waitTermLine((l) => /^PS .+>/.test(l), 'PowerShell prompt', 20000);
    const s = (await client.request('pty.list')).find((x) => x.title === 'pwa-term');
    assert(s && s.pid > 0, `pty.list: ${JSON.stringify(s)}`);
    ptyId = s.id;
    const sub = await page.textContent(`${sel.termView} .view-sub`);
    return `${s.id} pid ${s.pid}; header "${sub}"`;
  });

  await step('Terminals: command-line box sends "echo pwa-ok" and the output appears', async () => {
    await page.fill(`${sel.termView} .cmd-input`, 'echo pwa-ok');
    await page.click(`${sel.termView} .cmd-send`);
    await waitTermLine((l) => l === 'pwa-ok', '"pwa-ok"');
    assert((await page.inputValue(`${sel.termView} .cmd-input`)) === '', 'command box not cleared');
  });

  await step('Terminals: typing on the xterm keyboard + ↑ extra key recalls the command', async () => {
    await page.focus(`${sel.termView} .xterm-helper-textarea`);
    await page.keyboard.type('echo kbd-ok');
    await page.keyboard.press('Enter');
    await waitTermLine((l) => l === 'kbd-ok', '"kbd-ok"');
    await page.click(`${sel.termView} .xkey[aria-label="Up"]`);
    await waitTermLine((l) => /> ?echo kbd-ok$/.test(l), 'recalled command', 5000);
    await page.focus(`${sel.termView} .xterm-helper-textarea`);
    await page.keyboard.press('Enter');
    await waitFor(async () => (await termRows()).filter((l) => l.trim() === 'kbd-ok').length >= 2, { timeout: 8000, what: 'second kbd-ok' });
  });

  await step('Terminals: sticky Ctrl (once → locked → off) and Ctrl+C / ^C interrupt a running ping', async () => {
    const ctrl = `${sel.termView} .xkey.mod[aria-label="Ctrl"]`;
    const cls = async () => page.getAttribute(ctrl, 'class');
    await page.click(ctrl);
    assert(/\bonce\b/.test(await cls()), 'first tap is not one-shot');
    await page.click(ctrl);
    assert(/\blocked\b/.test(await cls()), 'second tap does not lock');
    await page.click(ctrl);
    assert(!/\b(once|locked)\b/.test(await cls()), 'third tap does not release');

    const countStats = async () => (await termRows()).filter((l) => /Ping statistics for 127\.0\.0\.1/.test(l)).length;
    const runPing = async () => {
      await page.fill(`${sel.termView} .cmd-input`, 'ping -t 127.0.0.1');
      await page.click(`${sel.termView} .cmd-send`);
      await waitTermLine((l) => /^Reply from 127\.0\.0\.1/.test(l), 'ping reply', 15000);
    };
    // Sticky Ctrl + "c" typed on the keyboard → \x03.
    await clearTerm();
    await runPing();
    await page.click(ctrl);
    await page.focus(`${sel.termView} .xterm-helper-textarea`);
    await page.keyboard.type('c');
    await waitFor(async () => (await countStats()) >= 1, { timeout: 8000, what: 'ping stopped by sticky Ctrl + c' });
    assert(!/\b(once|locked)\b/.test(await cls()), 'one-shot Ctrl not consumed');
    // The dedicated ^C key.
    await clearTerm();
    await runPing();
    await page.click(`${sel.termView} .xkey.hot`);
    await waitFor(async () => (await countStats()) >= 1, { timeout: 8000, what: 'ping stopped by ^C key' });
    await waitTermLine((l) => /^PS .+>$/.test(l), 'prompt back', 8000);
  });

  async function clearTerm() {
    await page.fill(`${sel.termView} .cmd-input`, 'clear');
    await page.click(`${sel.termView} .cmd-send`);
    await waitFor(async () => !(await termRows()).some((l) => /Ping statistics/.test(l)), { timeout: 8000, what: 'screen cleared' });
  }

  await step('Terminals: font −/+ re-fits the terminal and Fit sends pty.resize', async () => {
    const dims = async () => {
      const m = /(\d+)×(\d+)/.exec(await page.textContent(`${sel.termView} .view-sub`));
      return m ? { cols: +m[1], rows: +m[2] } : null;
    };
    const d0 = await dims();
    await page.click(`${sel.termView} [aria-label="Larger font"]`);
    await page.click(`${sel.termView} [aria-label="Larger font"]`);
    const d1 = await waitFor(async () => { const d = await dims(); return d && d.cols < d0.cols ? d : null; }, { timeout: 4000, what: 'fewer columns after font +' });
    await page.click(`${sel.termView} [aria-label="Smaller font"]`);
    await page.click(`${sel.termView} [aria-label="Smaller font"]`);
    const d2 = await waitFor(async () => { const d = await dims(); return d && d.cols === d0.cols ? d : null; }, { timeout: 4000, what: 'columns restored after font −' });
    await page.click(`${sel.termView} [aria-label="Fit to screen"]`);
    await expectToast(/Resized to \d+×\d+/);
    const s = await waitFor(async () => {
      const x = (await client.request('pty.list')).find((y) => y.id === ptyId);
      return x && x.cols === d2.cols && x.rows === d2.rows ? x : null;
    }, { timeout: 5000, what: 'pty.list size to match the phone' });
    await waitFor(async () => !(await page.$('#toasts .toast')), { timeout: 5000, what: 'toast gone' }).catch(() => {});
    await shot('terminal-xterm');
    return `${d0.cols}×${d0.rows} → ${d1.cols}×${d1.rows} → ${d2.cols}×${d2.rows}; agent ${s.cols}×${s.rows}`;
  });

  await step('Terminals: back to the list; the session row shows title, shell and size', async () => {
    await closeView(sel.termView);
    const row = page.locator('#panel-terminals .row', { hasText: 'pwa-term' });
    await row.waitFor({ timeout: 5000 });
    const text = await row.textContent();
    assert(/powershell/i.test(text) && /\d+×\d+/.test(text), `row text: ${text}`);
    const badge = await page.textContent('#tab-terminals .badge');
    assert(Number(badge) >= 1, `tab badge "${badge}"`);
  });

  let mirrorId = null;
  await step('Terminals: new terminal opened in the VS Code window (mirrored) works both ways', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('#panel-terminals .panel-actions .btn.primary');
    await page.waitForSelector(`${sel.sheet} select`);
    await page.selectOption(`${sel.sheet} select`, windowId);
    await page.fill(`${sel.sheet} input[placeholder="Title (optional)"]`, 'pwa-mirror');
    await page.click(`${sel.sheet} .btn.primary.block`);
    await page.waitForSelector(`${sel.termView} .xterm-rows`);
    await waitFor(async () => /mirrored in VS Code/.test(await page.textContent(`${sel.termView} .view-sub`)), { timeout: 8000, what: 'mirrored subtitle' });
    const s = (await client.request('pty.list')).find((x) => x.title === 'pwa-mirror');
    assert(s && s.mirror && s.mirror.windowId === windowId, `pty.list: ${JSON.stringify(s)}`);
    mirrorId = s.id;
    const t = await waitFor(async () => (await client.vsc(windowId, 'terminals.list')).find((x) => x.ptyId === s.id), { timeout: 10000, what: 'VS Code mirror terminal' });
    assert(t.isMirror === true, 'not a mirror in VS Code');
    await waitTermLine((l) => /^PS .+>/.test(l), 'mirror prompt', 20000);
    await page.fill(`${sel.termView} .cmd-input`, "Write-Output ('mirror' + '-ok')");
    await page.click(`${sel.termView} .cmd-send`);
    await waitTermLine((l) => l === 'mirror-ok', '"mirror-ok"');
    // Input from the VS Code side reaches the same shell and shows on the phone.
    await client.vsc(windowId, 'terminals.sendText', { tid: t.tid, text: "Write-Output ('from' + '-vscode')", addNewLine: true });
    await waitTermLine((l) => l === 'from-vscode', '"from-vscode" typed in VS Code');
    await closeView(sel.termView);
    const row = page.locator('#panel-terminals .section .row', { hasText: 'pwa-mirror' }).first();
    assert(/VS Code ·/.test(await row.textContent()), 'session row lacks the VS Code pill');
    await page.locator('.vs-sections .row', { hasText: 'mirrored' }).first().waitFor({ timeout: 8000 });
    return `${s.id} ↔ ${t.tid}`;
  });

  await step('Terminals: regular VS Code terminal → exec log runs commands with exit badges', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('.vs-sections [aria-label="New terminal in this window"]');
    await page.waitForSelector(`${sel.sheet} .toggle`);
    await page.fill(`${sel.sheet} input[placeholder="Name (optional)"]`, 'pwa-exec');
    await page.click(`${sel.sheet} .toggle`);
    assert((await page.getAttribute(`${sel.sheet} .toggle`, 'aria-checked')) === 'false', 'mirror toggle still on');
    await page.click(`${sel.sheet} .btn.primary.block`);
    await expectToast(/created in VS Code/);
    const t = await waitFor(async () => (await client.vsc(windowId, 'terminals.list')).find((x) => !x.isMirror && x.hasShellIntegration),
      { timeout: 40000, interval: 1000, what: 'shell integration in the new VS Code terminal' });
    const row = page.locator('.vs-sections .row', { hasText: 'shell integration' }).filter({ hasNotText: 'mirrored' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator('.row-main').click();
    // Ordinary VS Code terminals open in the live view (Live · History); the exec log is its History tab.
    await page.waitForSelector(sel.vstView);
    await page.click(`${sel.vstView} .vst-seg .seg-btn:has-text("History")`);
    await page.waitForSelector(sel.execView);
    await page.fill(`${sel.execView} .cmd-input`, 'echo exec-ok');
    await page.click(`${sel.execView} .cmd-send`);
    const block = page.locator(`${sel.execView} .exec-block`, { hasText: 'echo exec-ok' }).first();
    await block.locator('.pill.ok').waitFor({ timeout: 20000 });
    await waitFor(async () => /exec-ok/.test(await block.locator('.exec-out').textContent()), { timeout: 8000, what: 'exec output' });
    await page.fill(`${sel.execView} .cmd-input`, 'cmd /c exit 3');
    await page.click(`${sel.execView} .cmd-send`);
    const failed = page.locator(`${sel.execView} .exec-block`, { hasText: 'cmd /c exit 3' }).first();
    // VS Code's PowerShell integration reports failure as $? (exit 1), not $LASTEXITCODE: any non-zero badge.
    await failed.locator('.pill.err', { hasText: /exit [1-9]/ }).waitFor({ timeout: 20000 });
    assert(await failed.locator('.exec-out').isHidden(), 'empty output box shown for a silent command');
    await shot('exec-log');
    await closeView(sel.vstView);
    return `tid ${t.tid} "${t.name}"`;
  });

  await step('Terminals: regular VS Code terminal → Live view shows its output and takes keystrokes', async () => {
    if (!code) throw new SkipError('no VS Code');
    const row = page.locator('.vs-sections .row', { hasText: 'pwa-exec' }).filter({ hasNotText: 'mirrored' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator('.row-main').click();
    await page.waitForSelector(sel.vstView);
    const state = await waitFor(async () => {
      if (await page.isVisible(`${sel.vstView} .exec-view`).catch(() => false)) return 'old'; // no terminals.attach
      const st = (await page.textContent(`${sel.vstView} .term-status`).catch(() => '')) || '';
      return /live|typing only/.test(st) ? st : null;
    }, { timeout: 15000, what: 'live view attached' });
    if (state === 'old') throw new SkipError('extension without terminals.attach');
    await page.fill(`${sel.vstView} .vst-live .cmd-input`, "Write-Output ('live' + '-ok')");
    await page.click(`${sel.vstView} .vst-live .cmd-send`);
    await waitFor(async () => (await page.$$eval(`${sel.vstView} .xterm-rows > div`, (rows) => rows.map((r) => r.textContent.replace(/ /g, ' ').trim())))
      .some((l) => l === 'live-ok'), { timeout: 20000, what: '"live-ok" in the live view' });
    await shot('vs-live');
    await closeView(sel.vstView);
    return state;
  });

  await shot('terminals-list');

  /* ------------------------------------------------------------------- code */

  await step('Code: window picker lists the VS Code window; file browser shows the workspace', async () => {
    if (!code) throw new SkipError('no VS Code');
    await tab('code');
    await page.waitForSelector('#panel-code .window-pick-name');
    await page.click('#panel-code .window-pick');
    await page.waitForSelector(`${sel.sheet} .action-item`);
    const items = await page.$$eval(`${sel.sheet} .action-item`, (els) => els.map((e) => e.textContent));
    assert(items.length === 1 && /workspace/.test(items[0]), `windows: ${JSON.stringify(items)}`);
    await page.click(`${sel.sheet} .action-item`);
    await page.waitForSelector(sel.sheet, { state: 'detached' });
    await page.click('#panel-code .seg-btn:has-text("Files")');
    const names = await waitFor(async () => {
      const n = await page.$$eval('#panel-code .file-row .file-name', (els) => els.map((e) => e.textContent));
      return n.includes('hello.js') ? n : null;
    }, { timeout: 15000, what: 'workspace listing' });
    for (const want of ['sub', 'broken.js', 'hello.js', 'README.md']) assert(names.includes(want), `missing ${want} in ${names}`);
    const entries = names.filter((x) => x !== '..'); // ".." (parent folder) row comes first when not at a drive root
    assert(entries[0] === 'sub', `dirs not first: ${names}`);
    await shot('code-files');
    return names.join(', ');
  });

  await step('Code: browse into a folder (breadcrumbs) and back up', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('#panel-code .file-row.dir:has-text("sub")');
    await page.waitForSelector('#panel-code .file-row:has-text("data.txt")');
    assert((await page.textContent('#panel-code .crumb.current')) === 'sub', 'breadcrumb');
    await page.click('#panel-code .file-row.up');
    await page.waitForSelector('#panel-code .file-row:has-text("hello.js")');
  });

  await step('Code: open hello.js, edit, Save → file on disk changed (LF kept); CRLF file keeps CRLF', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('#panel-code .file-row:has-text("hello.js")');
    await page.waitForSelector(`${sel.editorView} textarea.code-area`);
    await waitFor(async () => /greet/.test(await page.inputValue(`${sel.editorView} textarea.code-area`)), { timeout: 10000, what: 'file content' });
    const gutter = await page.textContent(`${sel.editorView} .gutter`);
    assert(gutter.startsWith('1\n2\n3'), 'line numbers');
    const next = "function greet(name) {\n  return 'Hi ' + name; // edited on the phone\n}\n\nmodule.exports = { greet };\n";
    await page.fill(`${sel.editorView} textarea.code-area`, next);
    await page.waitForSelector(`${sel.editorView} .dirty-dot:not([hidden])`);
    await shot('editor');
    await page.click(`${sel.editorView} .save-btn`);
    await expectToast(/Saved hello\.js/);
    await waitFor(() => fs.readFileSync(path.join(dirs.workspace, 'hello.js'), 'utf8') === next, { timeout: 5000, what: 'hello.js on disk' });
    assert(await page.$(`${sel.editorView} .dirty-dot[hidden]`), 'still dirty after save');
    await page.click(`${sel.editorView} [aria-label="Open on PC"]`);
    await expectToast(/Opened in/);
    await closeView(sel.editorView);

    await page.click('#panel-code .file-row.dir:has-text("sub")');
    await page.click('#panel-code .file-row:has-text("data.txt")');
    await page.waitForSelector(`${sel.editorView} textarea.code-area`);
    await waitFor(async () => /line one/.test(await page.inputValue(`${sel.editorView} textarea.code-area`)), { timeout: 10000, what: 'data.txt' });
    assert(/CRLF/.test(await page.textContent(`${sel.editorView} .statusbar`)), 'statusbar EOL');
    await page.fill(`${sel.editorView} textarea.code-area`, 'line one\nline two\nline three\n');
    await page.click(`${sel.editorView} .save-btn`);
    await expectToast(/Saved data\.txt/);
    await waitFor(() => fs.readFileSync(path.join(dirs.workspace, 'sub', 'data.txt'), 'utf8') === 'line one\r\nline two\r\nline three\r\n', { timeout: 5000, what: 'data.txt with CRLF' });
    await closeView(sel.editorView);
    await page.click('#panel-code .crumb-home');
    await page.waitForSelector('#panel-code .file-row:has-text("hello.js")');
  });

  await step('Code: search by file name', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.fill('#panel-code .search-input', 'data');
    await page.waitForSelector('#panel-code .list-caption:has-text("1 files"), #panel-code .list-caption:has-text("1 file")', { timeout: 10000 });
    const hits = await page.$$eval('#panel-code .file-row .file-name', (els) => els.map((e) => e.textContent));
    assert(hits.length === 1 && hits[0] === 'data.txt', `hits ${hits}`);
    await page.fill('#panel-code .search-input', 'zz-no-such-file');
    await page.waitForSelector('#panel-code .empty-title:has-text("No matches")', { timeout: 10000 });
    await page.click('#panel-code .searchbar [aria-label="Clear search"]');
    await page.waitForSelector('#panel-code .file-row:has-text("hello.js")');
  });

  await step('Code: Tabs lists the editors open in VS Code (incl. the active one)', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('#panel-code .seg-btn:has-text("Tabs")');
    await page.waitForSelector('#panel-code .tabs-body .file-row:has-text("hello.js")', { timeout: 10000 });
    const act = await page.textContent('#panel-code .active-editor');
    assert(/hello\.js/.test(act), `active editor: ${act}`);
  });

  await step('Code: Problems shows the syntax errors of broken.js and the tab badge counts them', async () => {
    if (!code) throw new SkipError('no VS Code');
    await client.vsc(windowId, 'editor.open', { path: path.join(dirs.workspace, 'broken.js') }); // make sure diagnostics exist
    await page.click('#panel-code .seg-btn:has-text("Problems")');
    const n = await waitFor(async () => {
      await page.click('#panel-code [aria-label="Refresh problems"]').catch(() => {});
      const c = await page.$$eval('#panel-code .problem.error', (els) => els.length);
      return c > 0 ? c : null;
    }, { timeout: 30000, interval: 1500, what: 'error diagnostics' });
    const head = await page.textContent('#panel-code .problem-file-head');
    assert(/broken\.js/.test(head), `problem file: ${head}`);
    const badge = await page.textContent('#tab-code .badge');
    assert(Number(badge) === n, `tab badge ${badge} vs ${n} errors`);
    await shot('code-problems');
    return `${n} errors`;
  });

  await step('Code: command runner filters commands and runs one; Save all', async () => {
    if (!code) throw new SkipError('no VS Code');
    await page.click('#panel-code .seg-btn:has-text("Cmds")');
    await page.waitForSelector('#panel-code .quick-cmds .chip');
    await page.fill('#panel-code input[aria-label="Filter commands"]', 'workbench.action.files.save');
    await page.waitForSelector('#panel-code .cmd-row:has-text("workbench.action.files.saveAll")', { timeout: 10000 });
    const n = await page.$$eval('#panel-code .cmd-row', (els) => els.length);
    await shot('code-commands');
    await page.click('#panel-code .cmd-row:has-text("workbench.action.files.saveAll")');
    await expectToast(/Ran workbench\.action\.files\.saveAll/);
    await page.click('#panel-code .code-top .btn:has-text("Save all")');
    await expectToast(/All files saved/);
    await page.fill('#panel-code input[aria-label="Filter commands"]', '');
    return `${n} matching commands`;
  });

  /* ----------------------------------------------------------------- screen */

  let mon = null;
  await step('Screen: frames render on the canvas and the fps / KB/s stats update', async () => {
    const mons = await client.request('screen.monitors');
    await tab('screen');
    await page.waitForFunction(() => document.querySelector('.screen-canvas').width > 16, null, { timeout: 20000 });
    // Stats line "<fps> fps · <KB/s> KB/s · WxH" with both numbers above zero.
    await page.waitForFunction(() => {
      const m = /([\d.]+) fps · ([\d.]+) KB\/s · \d+×\d+/.exec(document.querySelector('.stage-stats')?.textContent || '');
      return m && Number(m[1]) > 0 && Number(m[2]) > 0;
    }, null, { timeout: 12000 });
    const stats = await page.textContent('.stage-stats');
    const size = await page.evaluate(() => ({ w: document.querySelector('.screen-canvas').width, h: document.querySelector('.screen-canvas').height }));
    const label = await page.getAttribute('#panel-screen .chip-btn', 'aria-label');
    assert(!/DISPLAY\d/.test(label), `raw device name shown: ${label}`);
    const n = /Display (\d+)/.exec(label);
    mon = (n && mons.find((m) => m.index === Number(n[1]) - 1)) || mons.find((m) => m.primary) || mons[0];
    assert(size.w <= 1280, `medium preset should cap at 1280 (got ${size.w})`);
    // Every control of the bar is visible (nothing pushed off-screen into a hidden scroll area).
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.screen-bar');
      const vw = document.documentElement.clientWidth;
      const clipped = [...b.querySelectorAll('button')].filter((x) => x.getBoundingClientRect().right > vw + 0.5).map((x) => x.getAttribute('aria-label') || x.textContent);
      return { overflow: b.scrollWidth - b.clientWidth, clipped };
    });
    assert(bar.overflow <= 0 && !bar.clipped.length, `screen bar overflows by ${bar.overflow}px; clipped: ${bar.clipped}`);
    await shot('screen');
    return `${size.w}×${size.h}; "${stats}"; ${mons.length} monitor(s); "${label}"`;
  });

  await step('Screen: quality preset Low → 960 px frames, High → full width, back to Med', async () => {
    const width = () => page.evaluate(() => document.querySelector('.screen-canvas').width);
    await page.click('#panel-screen .seg-btn:has-text("Low")');
    await page.waitForFunction(() => document.querySelector('.screen-canvas').width === 960, null, { timeout: 15000 });
    await page.click('#panel-screen .seg-btn:has-text("High")');
    const want = Math.min(1920, mon.width);
    await page.waitForFunction((w) => document.querySelector('.screen-canvas').width === w, want, { timeout: 15000 });
    await page.click('#panel-screen .seg-btn:has-text("Med")');
    await page.waitForFunction(() => document.querySelector('.screen-canvas').width === 1280, null, { timeout: 15000 });
    return `960 → ${want} → ${await width()}`;
  });

  await step('Screen: tap / double-tap / long-press send input.mouse with normalized coords (dry-run)', async () => {
    const box = await page.locator('.screen-canvas').boundingBox();
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    const mark = agent.mark();
    sentFrames.length = 0;
    const p1 = at(0.25, 0.5);
    await page.touchscreen.tap(p1.x, p1.y);
    const click = await waitFor(() => agent.dryRuns(mark).find((d) => d.method === 'input.mouse' && d.args.action === 'click'), { timeout: 5000, what: 'dry-run click' });
    const sent = sentFrames.find((f) => f.m === 'input.mouse' && f.p.action === 'click');
    assert(sent && Math.abs(sent.p.x - 0.25) < 0.02 && Math.abs(sent.p.y - 0.5) < 0.02 && sent.p.button === 'left', `sent ${JSON.stringify(sent && sent.p)}`);
    assert(sent.p.monitor === mon.index, `monitor ${sent.p.monitor} vs ${mon.index}`);
    const ex = mon.x + 0.25 * mon.width;
    const ey = mon.y + 0.5 * mon.height;
    assert(Math.abs(click.args.x - ex) <= mon.width * 0.02 && Math.abs(click.args.y - ey) <= mon.height * 0.02, `pixels ${JSON.stringify(click.args)} vs ${ex},${ey}`);

    // double tap → dblclick
    const p2 = at(0.6, 0.3);
    await page.touchscreen.tap(p2.x, p2.y);
    await sleep(90);
    await page.touchscreen.tap(p2.x, p2.y);
    await waitFor(() => agent.dryRuns(mark).find((d) => d.method === 'input.mouse' && d.args.action === 'dblclick'), { timeout: 5000, what: 'dry-run dblclick' });

    // long press → right click (raw CDP touch events: Playwright has no long-press helper)
    const cdp = await context.newCDPSession(page);
    const p3 = at(0.75, 0.75);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p3.x, y: p3.y }] });
    await sleep(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const right = await waitFor(() => agent.dryRuns(mark).find((d) => d.method === 'input.mouse' && d.args.button === 'right'), { timeout: 5000, what: 'dry-run right click' });
    await cdp.detach();
    const clicks = agent.dryRuns(mark).filter((d) => d.method === 'input.mouse').map((d) => `${d.args.action}/${d.args.button}`);
    assert(clicks.filter((c) => c === 'click/left').length === 1, `exactly one left click expected: ${clicks}`);
    return `click → (${click.args.x}, ${click.args.y}) px on monitor ${mon.index}; right click at (${right.args.x}, ${right.args.y}); ${clicks.join(', ')}`;
  });

  await step('Screen: keyboard button → typed text goes out as input.text, keys as input.key', async () => {
    const mark = agent.mark();
    await page.click('#panel-screen .kbd-toggle');
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('kbd-proxy'));
    await page.keyboard.insertText('hello pc');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.click('#panel-screen .xkey[aria-label="Esc"]');
    await page.click('#panel-screen .xkey.mod:has-text("Ctrl")');
    await page.keyboard.type('s');
    const want = [
      (d) => d.method === 'input.text' && d.args.text === 'hello pc',
      // The agent logs resolved virtual-key codes: Enter 13, Backspace 8, Escape 27, S 83 with Ctrl (17).
      (d) => d.method === 'input.key' && d.args.vk === 13 && !d.args.mods.length,
      (d) => d.method === 'input.key' && d.args.vk === 8,
      (d) => d.method === 'input.key' && d.args.vk === 27,
      (d) => d.method === 'input.key' && d.args.vk === 83 && JSON.stringify(d.args.mods) === '[17]',
    ];
    await waitFor(() => want.every((w) => agent.dryRuns(mark).some(w)), { timeout: 5000, what: 'all keyboard dry-runs' }).catch(() => {
      throw new Error(`dry-run log: ${JSON.stringify(agent.dryRuns(mark))}`);
    });
    const ctrlSent = sentFrames.find((f) => f.m === 'input.key' && f.p.key === 's');
    assert(ctrlSent && JSON.stringify(ctrlSent.p.mods) === '["ctrl"]', `sticky ctrl frame ${JSON.stringify(ctrlSent)}`);
    await page.click('#panel-screen .kbd-toggle');
    return agent.dryRuns(mark).map((d) => d.method).join(', ');
  });

  await step('Screen: pause stops the stream (placeholder), resume restarts it', async () => {
    await page.click('#panel-screen [aria-label="Pause stream"]');
    await page.waitForSelector('#panel-screen .stage-msg:has-text("Stream paused")');
    await sleep(1500);
    const before = binaryFrames;
    await sleep(2500);
    assert(binaryFrames - before <= 1, `frames kept coming while paused (${binaryFrames - before})`);
    await page.click('#panel-screen .stage-msg .btn:has-text("Resume")');
    await page.waitForSelector('#panel-screen .stage-msg', { state: 'hidden', timeout: 10000 });
  });

  /* ----------------------------------------------------------------- system */

  await step('System: info cards are populated', async () => {
    await tab('system');
    await page.waitForSelector('#panel-system .info-card .info-big', { timeout: 20000 });
    const cards = await page.$$eval('#panel-system .info-card', (els) => els.map((e) => e.querySelector('.info-card-head').textContent.trim()));
    for (const c of ['CPU', 'Memory', 'Uptime', 'Host', 'Network']) assert(cards.includes(c), `missing card ${c}: ${cards}`);
    const cpu = await page.textContent('#panel-system .info-card .info-big');
    assert(/^\d+%$/.test(cpu.trim()), `cpu "${cpu}"`);
    const sub = await page.textContent('#panel-system .panel-sub');
    assert(!/Loading|Offline/.test(sub), `sub "${sub}"`);
    await shot('system');
    return cards.join(', ');
  });

  await step('System: process list loads, search by PID, kill shows a confirm dialog (dry-run, process survives)', async () => {
    await page.waitForSelector('#panel-system .proc-row', { timeout: 20000 });
    const total = await page.$$eval('#panel-system .proc-row', (els) => els.length);
    await page.fill('#panel-system input[aria-label="Filter processes"]', String(dummy.pid));
    await waitFor(async () => (await page.$$eval('#panel-system .proc-row', (els) => els.length)) === 1, { timeout: 15000, what: `only pid ${dummy.pid} listed` })
      .catch(async (err) => {
        await page.click('#panel-system [aria-label="Refresh processes"]');
        throw err;
      });
    await page.click('#panel-system .proc-row');
    await sheetAction('End process');
    await page.waitForSelector(sel.dialog);
    const title = await page.textContent(`${sel.dialog} .dialog-title`);
    assert(/End node(\.exe)?\?/i.test(title), `dialog "${title}"`);
    const mark = agent.mark();
    await page.click(`${sel.dialog} .btn.danger`);
    const d = await waitFor(() => agent.dryRuns(mark).find((x) => x.method === 'proc.kill'), { timeout: 5000, what: 'dry-run proc.kill' });
    assert(d.args.pid === dummy.pid && d.args.force === false, JSON.stringify(d.args));
    await sleep(500);
    assert(isAlive(dummy.pid), 'dummy process died (dry-run not honoured!)');
    await page.fill('#panel-system input[aria-label="Filter processes"]', '');
    return `${total} processes; dry-run kill of ${dummy.pid}`;
  });

  await step('System: power button asks for confirmation; Cancel sends nothing; cancel-shutdown is sent', async () => {
    const mark = agent.mark();
    await page.click('#panel-system .power-btn:has-text("Shut down")');
    await page.waitForSelector(sel.dialog);
    assert(/Shut down\?/.test(await page.textContent(`${sel.dialog} .dialog-title`)), 'dialog title');
    await sleep(250);
    await shot('power-confirm');
    await page.click(`${sel.dialog} .btn.ghost`);
    await page.waitForSelector(sel.dialog, { state: 'detached' });
    await sleep(500);
    assert(!agent.dryRuns(mark).some((x) => x.method === 'power'), 'power sent although cancelled');
    await page.click('#panel-system .btn:has-text("Cancel shutdown / restart")');
    await expectToast(/cancelled/);
    const d = agent.dryRuns(mark).find((x) => x.method === 'power');
    assert(d && d.args.action === 'cancel', JSON.stringify(d));
  });

  await step('System: clipboard "Get from PC" (read only)', async () => {
    await page.click('#panel-system .btn:has-text("Get from PC")');
    await waitFor(async () => /PC clipboard/.test(await page.textContent('#panel-system .clip-area + .field-hint')), { timeout: 8000, what: 'clipboard meta' });
    const meta = await page.textContent('#panel-system .clip-area + .field-hint');
    await page.fill('#panel-system .clip-area', ''); // keep the user's clipboard out of screenshots
    return meta.replace(/\d+ characters/, 'N characters');
  });

  /* -------------------------------------------------------------- reconnect */

  await step('Reconnect: dropped link → UI reconnects and re-attaches the open terminal (scrollback kept)', async () => {
    await tab('terminals');
    await page.locator('#panel-terminals .row', { hasText: 'pwa-term' }).locator('.row-main').click();
    await page.waitForSelector(`${sel.termView} .xterm-rows`);
    await page.fill(`${sel.termView} .cmd-input`, 'echo before-drop');
    await page.click(`${sel.termView} .cmd-send`);
    await waitTermLine((l) => l === 'before-drop', 'before-drop');
    await page.evaluate(() => {
      const pill = document.getElementById('statusPill');
      new MutationObserver(() => window.__e2e.status.push(pill.dataset.status)).observe(pill, { attributes: true, attributeFilter: ['data-status'] });
      for (const ws of window.__e2e.sockets) try { ws.close(4000, 'e2e drop'); } catch { /* ignore */ }
    });
    await waitFor(async () => (await page.evaluate(() => window.__e2e.status)).includes('online'), { timeout: 15000, what: 'back online' });
    const seen = await page.evaluate(() => window.__e2e.status.slice());
    assert(seen.includes('offline') || seen.includes('connecting'), `status sequence ${seen}`);
    await waitFor(async () => (await page.$(`${sel.termView} .term-overlay[hidden]`)) && (await page.$(`${sel.termView} .term-status[hidden]`)), { timeout: 10000, what: 'terminal re-attached' });
    assert((await termRows()).some((l) => l.trim() === 'before-drop'), 'scrollback lost after re-attach');
    await page.fill(`${sel.termView} .cmd-input`, 'echo after-drop');
    await page.click(`${sel.termView} .cmd-send`);
    await waitTermLine((l) => l === 'after-drop', 'after-drop');
    return `status ${seen.join(' → ')}`;
  });

  await step('Reconnect: agent restart → offline bar, then online; the dead terminal is reported (no wrong re-attach)', async () => {
    const viewId = ptyId;
    await page.evaluate(() => { window.__e2e.status.length = 0; window.__e2e.block = true; });
    client.close();
    await agent.stop();
    let bar = '';
    try {
      await page.waitForSelector('#offlineBar:not([hidden])', { timeout: 15000 });
      bar = await page.textContent('#offlineBar');
      assert(/retry/i.test(bar), `offline bar "${bar}"`);
      assert(/reconnecting|offline/.test(await page.textContent(`${sel.termView} .term-status`)), 'terminal status not shown');
      await shot('reconnecting');
    } finally {
      await agent.start(); // always bring the agent back, even when an assertion above failed
      client = await PhoneClient.open(PORT, token);
    }
    // The new agent numbers its terminals from p1 again: occupy the id the phone still has open.
    let created = null;
    for (let i = 0; i < 6 && (!created || created.id !== viewId); i++) created = await client.request('pty.create', { title: `restart-${i}` });
    assert(created.id === viewId, `could not recreate id ${viewId}`);
    await page.evaluate(() => { window.__e2e.block = false; });
    // The view covers the app's offline bar: its status chip is the "retry now" control.
    const t0 = Date.now();
    await page.click(`${sel.termView} .term-status`);
    await waitOnline(20000);
    const retryMs = Date.now() - t0;
    await page.waitForSelector(`${sel.termView} .banner:has-text("closed on the PC")`, { timeout: 10000 });
    assert(!(await termRows()).some((l) => /restart-/.test(l)), 'attached to an unrelated new shell');
    await closeView(sel.termView);
    await page.locator('#panel-terminals .row', { hasText: 'restart-0' }).waitFor({ timeout: 8000 });
    for (const s of await client.request('pty.list')) await client.request('pty.kill', { id: s.id });
    if (code) {
      await waitFor(async () => (await client.request('vsc.windows')).length > 0, { timeout: 45000, interval: 1000, what: 'VS Code extension to reconnect' });
      await page.locator('.vs-sections .section-head', { hasText: 'workspace' }).waitFor({ timeout: 15000 });
      windowId = (await client.request('vsc.windows'))[0].windowId;
    }
    const seq = await page.evaluate(() => window.__e2e.status.slice());
    return `status ${[...new Set(seq)].join(' → ')}; bar "${bar.trim()}"; online ${retryMs} ms after tapping the chip`;
  });

  await step('Reconnect: the offline bar counts down and "Retry now" reconnects at once', async () => {
    await tab('terminals');
    await page.evaluate(() => {
      window.__e2e.block = true;
      for (const ws of window.__e2e.sockets) try { ws.close(4000, 'e2e drop'); } catch { /* ignore */ }
    });
    await page.waitForSelector('#offlineBar:not([hidden])', { timeout: 10000 });
    // Let a few blocked attempts grow the backoff so an automatic retry can't explain a quick recovery.
    await waitFor(async () => {
      const m = /retrying in (\d+)s/.exec(await page.textContent('#offlineBar'));
      return m && Number(m[1]) >= 3;
    }, { timeout: 20000, what: 'backoff of 3 s or more' });
    const btn = await page.$('#offlineBar .offline-retry');
    await sleep(1200);
    assert(await btn.evaluate((b) => b.isConnected), 'Retry button was re-created by the countdown');
    await page.evaluate(() => { window.__e2e.block = false; });
    const t0 = Date.now();
    await page.click('#offlineBar .offline-retry');
    await waitOnline(5000);
    const ms = Date.now() - t0;
    assert(ms < 2500, `took ${ms} ms`);
    assert(await page.$('#offlineBar[hidden]'), 'offline bar still visible');
    return `online ${ms} ms after Retry now`;
  });

  await step('Reconnect: screen stream resumes after the restart', async () => {
    await waitOnline(20000);
    await tab('screen');
    const before = binaryFrames;
    await waitFor(() => binaryFrames > before, { timeout: 15000, what: 'a new frame after reconnect' });
    await tab('system');
  });

  /* ------------------------------------------------------------ PWA basics */

  await step('PWA: service worker registers and caches the app shell incl. vendor/xterm', async () => {
    const r = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 10000))]);
      if (!reg) return null;
      const keys = await caches.keys();
      const cached = [];
      for (const k of keys) {
        const c = await caches.open(k);
        cached.push(...(await c.keys()).map((q) => new URL(q.url).pathname));
      }
      return { scope: reg.scope, active: !!reg.active, keys, cached, secure: window.isSecureContext };
    });
    assert(r && r.active, 'no active service worker');
    for (const f of ['/', '/app.js', '/styles.css', '/vendor/xterm.js', '/manifest.webmanifest']) {
      assert(r.cached.includes(f) || (f === '/' && r.cached.includes('/index.html')), `not cached: ${f}`);
    }
    assert(!r.cached.some((p) => p.startsWith('/ws') || p.startsWith('/healthz')), 'cached /ws or /healthz');
    return `${r.keys.join(', ')} (${r.cached.length} entries)`;
  });

  await step('PWA: manifest is valid and installable (Chrome installability check, icon sizes)', async () => {
    const cdp = await context.newCDPSession(page);
    const man = await cdp.send('Page.getAppManifest');
    const inst = await cdp.send('Page.getInstallabilityErrors');
    await cdp.detach();
    assert(!man.errors.length, `manifest errors ${JSON.stringify(man.errors)}`);
    const m = JSON.parse(man.data);
    assert(m.name === 'TermPocket' && m.short_name === 'TermPocket' && m.display === 'standalone' && m.start_url === './', 'manifest fields');
    assert(m.icons.some((i) => i.purpose === 'maskable'), 'no maskable icon');
    for (const i of m.icons.filter((x) => x.type === 'image/png')) {
      const buf = Buffer.from(await (await fetch(new URL(i.src, `${BASE}/`))).arrayBuffer());
      const w = buf.readUInt32BE(16);
      const hgt = buf.readUInt32BE(20);
      assert(i.sizes === `${w}x${hgt}`, `${i.src} is ${w}x${hgt}, manifest says ${i.sizes}`);
    }
    // 'in-incognito' only reflects Playwright's throwaway browser context, not the app.
    const errs = inst.installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
    assert(!errs.length, `installability errors: ${errs}`);
    return `${m.icons.length} icons; installable`;
  });

  /* ---------------------------------------------------------------- layout */

  await step('Layout: no horizontal overflow on any tab at 412 px', async () => {
    for (const t of ['terminals', 'code', 'screen', 'system']) {
      await tab(t);
      await sleep(300);
      await expectNoOverflow(`412px ${t}`);
    }
  });

  await step('Layout: 360 px wide — no horizontal overflow on any tab or in the terminal view', async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const t of ['terminals', 'code', 'screen', 'system']) {
      await tab(t);
      await sleep(350);
      await expectNoOverflow(`360px ${t}`);
      if (t === 'screen') {
        const over = await page.evaluate(() => { const b = document.querySelector('.screen-bar'); return b.scrollWidth - b.clientWidth; });
        assert(over <= 0, `360px: screen bar needs ${over}px of scrolling`);
      }
    }
    await tab('terminals');
    await page.click('#panel-terminals .panel-actions .btn.primary');
    await page.waitForSelector(`${sel.sheet} .chips`);
    await expectNoOverflow('360px new-terminal sheet');
    if (await page.$(`${sel.sheet} select`)) await page.selectOption(`${sel.sheet} select`, ''); // phone-only shell (auto-fit)
    await page.fill(`${sel.sheet} input[placeholder="Title (optional)"]`, 'narrow');
    await page.click(`${sel.sheet} .btn.primary.block`);
    await page.waitForSelector(`${sel.termView} .xterm-rows`);
    await waitTermLine((l) => /^PS .+>/.test(l), 'prompt', 20000);
    await sleep(400);
    await expectNoOverflow('360px terminal view');
    await shot('narrow-360-terminal');
  });

  await step('Layout: landscape (915×412) — tabs reachable, terminal view fits, no overflow', async () => {
    await page.setViewportSize({ width: 915, height: 412 });
    await sleep(500);
    await expectNoOverflow('landscape terminal view');
    const fits = await page.evaluate(() => {
      const v = document.querySelector('#views .term-view').getBoundingClientRect();
      const x = document.querySelector('#views .term-view .xterm-screen').getBoundingClientRect();
      const keys = document.querySelector('#views .term-view .xkeys').getBoundingClientRect();
      return { view: v.height, xterm: x.height, keysBottom: keys.bottom, vh: innerHeight };
    });
    assert(fits.xterm >= 120 && fits.keysBottom <= fits.vh + 1, `landscape terminal ${JSON.stringify(fits)}`);
    await shot('landscape-terminal');
    await closeView(sel.termView);
    for (const t of ['terminals', 'system']) {
      await tab(t);
      await sleep(300);
      await expectNoOverflow(`landscape ${t}`);
    }
    const tb = await page.locator('.tabbar').boundingBox();
    assert(tb && tb.width > 0 && tb.height > 0, 'tab bar hidden in landscape');
    await shot('landscape-system');
    await page.setViewportSize(PHONE.viewport);
    return `xterm ${Math.round(fits.xterm)} px tall`;
  });

  await step('Light theme renders (prefers-color-scheme: light)', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await tab('terminals');
    await sleep(300);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(bg !== 'rgb(11, 13, 18)', `still dark: ${bg}`);
    await shot('light-terminals');
    await page.emulateMedia({ colorScheme: 'dark' });
    return bg;
  });

  await step('No console errors or uncaught page errors', async () => {
    assert(!problems.console.length && !problems.pageErrors.length,
      `console: ${JSON.stringify(problems.console.slice(0, 6))}; page: ${JSON.stringify(problems.pageErrors.slice(0, 6))}`);
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Teardown                                                                                      */
/* ------------------------------------------------------------------------------------------- */

async function teardown() {
  try {
    if (browser) await browser.close();
  } catch { /* ignore */ }
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
  if (dummy && isAlive(dummy.pid)) taskkill(dummy.pid);
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
fs.writeFileSync(path.join(ARTIFACTS, 'pwa-results.json'), JSON.stringify({
  at: new Date().toISOString(), pass, fail, skip, shots: SHOTS, problems, results,
}, null, 2));
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped${fatal ? ' (fatal error)' : ''}; screenshots in ${SHOTS}`);
process.exit(fail ? 1 : 0);
