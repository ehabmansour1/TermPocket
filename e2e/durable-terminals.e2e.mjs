#!/usr/bin/env node
// TermPocket — durable terminals seen from the PWA (PROTOCOL §4.1 "Durable sessions", §5.3 mirror.rebind)
// plus the desktop terminal look, the old-extension banner, the watermark fix and the phone layout.
//
// Everything runs on this machine, localhost only:
//   * the real agent on 127.0.0.1:<free port>, temp TERMPOCKET_HOME, TERMPOCKET_DRYRUN_INPUT=1 and its OWN
//     PTY host pipe (never the user's real terminals host);
//   * ONE isolated VS Code (temp profile, this repo's extension) launched through lib/harness.mjs, which
//     keeps its windows off-screen and un-activated;
//   * the real PWA (web/) in a local HEADLESS Google Chrome (playwright-core channel "chrome").
//
// Flow:
//   1. desktop Code tab → TERMINAL panel → "+" creates a mirrored (phone-visible) terminal; typing in the
//      PWA produces output and starts a full-screen TUI (alternate screen, live counter, key echo);
//   2. the TEST agent process is restarted (its PTY host is kept): the session keeps running in the host
//      (same id, same host pid, pty.list ids stable, new ids continue after the highest), the PWA
//      reconnects and re-attaches with the full scrollback, the TUI is still live and takes keys, the
//      isolated VS Code re-binds its mirror terminal (mirror.rebind) — it shows the output from before
//      and after the restart and accepts typing;
//   3. desktop look of an ordinary terminal (just the xterm: Consolas 14px, no card / keys row / command
//      box), the old-extension banner instead of history, the watermark never over the panel header;
//   4. phone layout (412 px) unchanged: extra keys + command box.
//
// The VS Code-side check reads the mirror terminal with terminals.snapshot, which briefly uses the
// Windows clipboard (its text is restored). When the clipboard holds non-text data, that check is skipped.
//
// Usage:  node durable-terminals.e2e.mjs [--port <n>] [--shots <dir>] [--keep-temp]

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import {
  E2E_DIR, AgentProcess, IsolatedVsCode, PhoneClient, assert, createSandbox, removeSandbox, sleep, waitFor,
  writeWorkspace, isAlive,
} from './lib/harness.mjs';

const argv = process.argv.slice(2);
const option = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const KEEP_TEMP = argv.includes('--keep-temp');
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const SHOTS = path.resolve(option('--shots', process.env.TERMPOCKET_E2E_SHOTS || path.join(ARTIFACTS, 'durable-terminals-shots')));
fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (/^final-.*\.jpg$/.test(f)) fs.rmSync(path.join(SHOTS, f));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const PORT = Number(option('--port', 0)) || (await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const dirs = createSandbox('termpocket-durterm-e2e-');
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'durable-terminals-agent.log') });
const code = new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'durable-terminals-vscode.log') });
const tag = Math.random().toString(36).slice(2, 7);
const results = [];
const problems = [];
let client = null;
let windowId = null;
let browser = null;
let page = null;

class SkipError extends Error {}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: 'pass', ms: Date.now() - t0, detail: detail || '' });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const skip = err instanceof SkipError;
    results.push({ name, result: skip ? 'skip' : 'fail', ms: Date.now() - t0, detail: skip ? err.message : err.stack || err.message });
    console.log(`  ${skip ? 'skip' : 'FAIL'} ${name} — ${err.message.split('\n')[0]}`);
    if (!skip && page) {
      await page.screenshot({ path: path.join(ARTIFACTS, `durable-terminals-fail-${results.length}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    return false;
  }
}

async function shot(name) {
  if (!page) return;
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, `final-${name}.jpg`), type: 'jpeg', quality: 72 });
}

async function status() {
  const r = await fetch(`${agent.base}/status`);
  return r.json();
}

/** True when the Windows clipboard holds non-text data that a text-only restore would lose. */
function clipboardHasNonText() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $d=[Windows.Forms.Clipboard]::GetDataObject(); if ($d -and ($d.GetDataPresent('Bitmap') -or $d.GetDataPresent('FileDrop') -or $d.GetDataPresent('HTML Format'))) { 'nontext' } else { 'ok' }"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    return /nontext/.test(out);
  } catch {
    return true;
  }
}

// The full-screen program typed into the mirrored terminal (same as vscode-live.e2e.mjs).
const TUI = String.raw`
const out = process.stdout;
let n = 0;
let keys = '';
const W = 38;
const row = (y, s) => '\x1b[' + y + ';3H' + s + '\x1b[K';
const frame = (s) => '\x1b[1;36m|\x1b[0m ' + s;
function draw() {
  const size = (out.columns || 0) + 'x' + (out.rows || 0);
  out.write(
    row(1, '\x1b[1;36m+' + '-'.repeat(W) + '+\x1b[0m') +
    row(2, frame('\x1b[1;33mVSC-TUI demo\x1b[0m  \x1b[32mrunning\x1b[0m')) +
    row(3, frame('tick ' + n)) +
    row(4, frame('keys: ' + keys)) +
    row(5, frame('size ' + size)) +
    row(6, frame('\x1b[2mq quits, Ctrl+C aborts\x1b[0m')) +
    row(7, '\x1b[1;36m+' + '-'.repeat(W) + '+\x1b[0m'));
}
function bye(why, code) {
  clearInterval(timer);
  try { process.stdin.setRawMode(false); } catch {}
  out.write('\x1b[?25h\x1b[?1049l');
  out.write('tui-bye ' + why + '\r\n', () => process.exit(code));
}
out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
draw();
const timer = setInterval(() => { n++; draw(); }, 250);
process.on('SIGINT', () => bye('ctrl-c', 130));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const c of d) {
    if (c === '\x03') return bye('ctrl-c', 130);
    if (c === 'q') return bye('q', 0);
    keys += c < ' ' ? '^' + String.fromCharCode(c.charCodeAt(0) + 64) : c;
  }
  keys = keys.slice(-30);
  draw();
});
`;

// Page stubs: the browser never touches the real clipboard; chosen vsc.call methods can be made to fail
// like an older extension ("unknown method"); commands.run reloadWindow is recorded, never sent.
const INIT_SCRIPT = () => {
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => {} } });
  } catch { /* ignore */ }
  const orig = WebSocket.prototype.send;
  window.__reloadCalls = [];
  WebSocket.prototype.send = function (data) {
    try {
      const fail = JSON.parse(sessionStorage.getItem('__failMethods') || '[]');
      if (typeof data === 'string' && data.includes('"vsc.call"')) {
        const m = JSON.parse(data);
        const reply = (body) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'res', id: m.id, ...body }) })), 30);
        if (m.t === 'req' && m.p && fail.includes(m.p.m)) { reply({ ok: false, e: `unknown method: ${m.p.m}` }); return undefined; }
        if (m.t === 'req' && m.p && m.p.m === 'commands.run' && m.p.p && m.p.p.command === 'workbench.action.reloadWindow') {
          window.__reloadCalls.push(m.p); reply({ ok: true, r: {} }); return undefined;
        }
      }
    } catch { /* ignore */ }
    return orig.call(this, data);
  };
};

function watch(p, label) {
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // While the test agent is deliberately down, the browser logs failed socket / fetch attempts.
    if (restarting && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/i.test(t)) return;
    problems.push(`[${label}] ${t}`);
  });
  p.on('pageerror', (e) => problems.push(`[${label}] pageerror ${e.message}`));
  p.on('websocket', (sock) => {
    sock.on('framesent', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.startsWith('{"t":"req"')) return;
      try { const j = JSON.parse(f.payload); sentFrames.push({ m: j.m, p: j.p, at: Date.now() }); } catch { /* ignore */ }
    });
  });
}
const sentFrames = [];
let restarting = false;

const PANE = '.wbc-term-main .wbc-term-pane:not([hidden])';
const rowsOf = (sel) => page.$$eval(`${sel} .xterm-rows > div`, (rs) => rs.map((r) => r.textContent.replace(/ /g, ' ').trimEnd())).catch(() => []);
const vsc = (m, p = {}, t) => client.vsc(windowId, m, p, t);
/**
 * Whether a PowerShell prompt starts at rows[i]. The prompt holds the temp workspace path, whose length
 * depends on the Windows user name, so it may wrap onto the next row(s) of a narrow panel.
 */
const promptStartsAt = (rows, i) => /^PS [A-Za-z]:\\/.test(rows[i] || '') && /^PS [^>]*>/.test(rows.slice(i, i + 3).join(''));
const hasPrompt = (rows) => rows.some((_, i) => promptStartsAt(rows, i));
const termList = () => vsc('terminals.list');

async function waitOnline(timeout = 30000) {
  await page.waitForSelector('#statusPill[data-status="online"]', { state: 'attached', timeout });
}

async function openPanel() {
  await page.click('#tab-code');
  await page.waitForSelector('.wb.visible .wb-statusbar', { timeout: 30000 });
  await page.waitForSelector('.wb-panel-tab[data-view="terminal"]', { timeout: 15000 });
  if (!(await page.$('.wb-panel-tab.checked[data-view="terminal"]'))) await page.click('.wb-panel-tab[data-view="terminal"]');
  await page.waitForSelector('.wbc-term-tab', { timeout: 20000 });
}

async function typeInTerminal(text, { enter = true } = {}) {
  await page.click(`${PANE} .xterm-screen`);
  await page.keyboard.type(text, { delay: 5 });
  if (enter) await page.keyboard.press('Enter');
}

/* ------------------------------------------------------------------------------------------- */

async function main() {
  console.log(`TermPocket durable terminals (PWA) e2e — port ${PORT}, temp ${dirs.tmpRoot}`);
  writeWorkspace(dirs);
  fs.writeFileSync(path.join(dirs.workspace, 'tui.js'), TUI);

  await step('start agent (temp TERMPOCKET_HOME, own PTY host pipe, dry-run input) → separate PTY host', async () => {
    const pid = await agent.start();
    const s = await waitFor(async () => {
      const st = await status();
      return st.ptyHost && st.ptyHost.mode === 'host' && st.ptyHost.running ? st : null;
    }, { timeout: 30000, what: 'ptyHost running' });
    assert(s.ptyHost.pid && s.ptyHost.pid !== pid, `host pid ${s.ptyHost.pid} vs agent ${pid}`);
    return `agent ${pid}, PTY host ${s.ptyHost.pid}`;
  });
  if (!agent.running) throw new Error('agent did not start');
  client = await PhoneClient.open(PORT, agent.token);

  const up = await step('launch ONE isolated VS Code (off-screen) + an ordinary terminal with output from before any attach', async () => {
    const note = code.launch();
    const wins = await waitFor(async () => {
      const w = await client.request('vsc.windows');
      return w.length ? w : null;
    }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
    windowId = wins[0].windowId;
    const r = await vsc('terminals.create', { name: 'ord-ps', mirror: false });
    await waitFor(async () => (await termList()).find((t) => t.tid === r.tid && t.hasShellIntegration), { timeout: 40000, what: 'shell integration in ord-ps' });
    await vsc('terminals.input', { tid: r.tid, d: `1..30 | % { "ord-before-$_" }\r` });
    await sleep(1000);
    return `${note}; window "${wins[0].name}"`;
  });
  if (!up) throw new Error('no VS Code window');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false, colorScheme: 'dark' });
  await dctx.addInitScript(INIT_SCRIPT);
  dctx.setDefaultTimeout(12000);
  page = await dctx.newPage();
  watch(page, 'desk');

  /* ------------------------------------------------------- 1. mirrored terminal from the panel "+" */

  let ptyId = null;
  let mirTid = null;
  let idsBefore = [];
  let hostPid = null;
  const created = await step('panel "+" → phone-visible (mirrored) terminal; typed output, scrollback and a TUI', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(agent.token)}`);
    await waitOnline();
    await openPanel();
    const before = new Set((await termList()).map((t) => t.tid));
    const t0 = Date.now();
    const sizes = [];
    const offSizes = client.on('pty.changed', (p) => {
      for (const s of p.sessions || []) {
        const k = `${s.id}:${s.cols}x${s.rows}`;
        if (!sizes.length || sizes[sizes.length - 1].k !== k) sizes.push({ k, at: Date.now() - t0 });
      }
    });
    await page.click('.wbc-term-actions [title^="New Terminal"]');
    const t = await waitFor(async () => (await termList()).find((x) => !before.has(x.tid) && x.isMirror && x.ptyId), { timeout: 20000, what: 'new mirrored terminal' });
    ptyId = t.ptyId;
    mirTid = t.tid;
    await waitFor(async () => hasPrompt(await rowsOf(PANE)), { timeout: 30000, what: 'PowerShell prompt in the panel' }).catch(async (e) => {
      const dbg = await page.evaluate(() => ({ panes: document.querySelectorAll('.wbc-term-pane').length, visible: document.querySelectorAll('.wbc-term-main .wbc-term-pane:not([hidden])').length, rows: [...document.querySelectorAll('.wbc-term-pane .xterm-rows > div')].map((r) => r.textContent).filter((t) => t.trim()).slice(-5), text: (document.querySelector('.wbc-term-main') || {}).innerText }));
      await page.screenshot({ path: path.join(SHOTS, 'debug-prompt.jpg'), type: 'jpeg', quality: 60 }).catch(() => {});
      throw new Error(e.message + ' ' + JSON.stringify(dbg).slice(0, 800));
    });
    // The panel fits the new PTY ~0.7 s after opening: let the resize land before typing. 1400 px keeps the
    // PTY narrower than the off-screen VS Code terminal (a wider PTY garbles ConPTY's repaints in the
    // narrower VS Code twin) and avoids PSReadLine 2.0's crash when its prompt exactly fills the width.
    const promptAt = Date.now() - t0;
    await sleep(2000);
    console.log(`       prompt at ${promptAt}ms, typing from ${Date.now() - t0}ms`);
    await typeInTerminal(`Write-Output "durable-before-${tag}"`);
    await waitFor(async () => (await rowsOf(PANE)).some((l) => l === `durable-before-${tag}`), { timeout: 15000, what: 'typed output' });
    await typeInTerminal('1..60 | % { "scroll-line-$_" }');
    await waitFor(async () => (await rowsOf(PANE)).some((l) => l === 'scroll-line-60'), { timeout: 15000, what: 'scrollback lines' });
    await typeInTerminal(`& "${process.execPath}" tui.js`);
    await waitFor(async () => (await rowsOf(PANE)).some((l) => /VSC-TUI demo/.test(l)), { timeout: 20000, what: 'TUI on screen' });
    await sleep(600);
    // Desktop: just the terminal — no card head, no extra keys, no command box; VS Code's font.
    const look = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const vis = (q) => { const e = el.querySelector(q); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; };
      const rows = el.querySelector('.xterm-rows');
      return { xkeys: vis('.xkeys'), cmdline: vis('.cmdline'), head: vis('.view-head'), font: getComputedStyle(rows).fontFamily, size: getComputedStyle(rows).fontSize };
    }, PANE);
    assert(!look.xkeys && !look.cmdline && !look.head && /Consolas/.test(look.font), `desktop look ${JSON.stringify(look)}`);
    await shot('01-desk-mirrored-tui-before-restart');
    offSizes();
    console.log(`       sizes: ${sizes.map((s) => `${s.k}@${s.at}ms`).join(' → ')}`);
    if (process.env.DT_DEBUG) {
      for (const f of sentFrames.filter((x) => x.at >= t0 && /^pty\.(input|resize)$/.test(x.m))) console.log(`       ${f.at - t0}ms ${f.m} ${JSON.stringify(f.p)}`);
      const att = await client.request('pty.attach', { id: ptyId });
      await client.request('pty.detach', { id: ptyId });
      fs.writeFileSync(path.join(ARTIFACTS, 'durable-terminals-raw.txt'), JSON.stringify(att.buffer.slice(0, 6000)).replace(/\\r\\n/g, '\\r\\n\n'));
    }
    idsBefore = (await client.request('pty.list')).map((s) => s.id).sort();
    hostPid = (await status()).ptyHost.pid;
    return `${ptyId} (tid ${mirTid}) in host ${hostPid}; look ${look.size} ${look.font.split(',')[0]}`;
  });
  if (!created) throw new Error('could not create the mirrored terminal');

  /* ------------------------------------------------------- 2. restart the TEST agent */

  await step('restart the test agent (PTY host kept): host pid, pty.list ids and the session survive', async () => {
    restarting = true;
    client.close();
    const stopped = await agent.stop({ keepPtyHost: true });
    assert(isAlive(hostPid), 'PTY host survived the agent');
    await page.waitForSelector('#statusPill:not([data-status="online"])', { state: 'attached', timeout: 15000 }).catch(() => {});
    await sleep(800);
    await shot('02-desk-agent-down');
    await agent.start();
    client = await PhoneClient.open(PORT, agent.token);
    const st = await waitFor(async () => {
      const s = await status();
      return s.ptyHost && s.ptyHost.running ? s : null;
    }, { timeout: 20000, what: 'ptyHost after restart' });
    assert(st.ptyHost.pid === hostPid, `same host pid (${st.ptyHost.pid} vs ${hostPid})`);
    assert(st.ptyHost.adopted >= 1, `adopted ${st.ptyHost.adopted}`);
    const list = await client.request('pty.list');
    const idsAfter = list.map((s) => s.id).sort();
    assert(JSON.stringify(idsAfter) === JSON.stringify(idsBefore), `ids ${idsAfter} vs ${idsBefore}`);
    const s = list.find((x) => x.id === ptyId);
    assert(s && !s.exited, `session ${ptyId} alive`);
    return `${stopped}; ids ${idsAfter.join(',')} stable; adopted ${st.ptyHost.adopted}`;
  });

  await step('PWA reconnects and re-attaches: the TUI is still live (counter moves) and takes keys', async () => {
    await waitOnline(60000);
    restarting = false;
    const tickOf = async () => {
      const l = (await rowsOf(PANE)).find((x) => /\| tick \d+/.test(x));
      return l ? Number(/tick (\d+)/.exec(l)[1]) : null;
    };
    const t1 = await waitFor(tickOf, { timeout: 20000, what: 'TUI after re-attach' });
    await sleep(1200);
    const t2 = await tickOf();
    assert(t2 > t1, `counter moves (${t1} → ${t2})`);
    await page.click(`${PANE} .xterm-screen`);
    await page.keyboard.type('abc');
    await waitFor(async () => (await rowsOf(PANE)).some((l) => /keys: abc/.test(l)), { timeout: 10000, what: 'keys echoed by the TUI' });
    await shot('03-desk-tui-after-restart');
    await page.keyboard.type('q');
    await waitFor(async () => (await rowsOf(PANE)).some((l) => /tui-bye q/.test(l)), { timeout: 10000, what: 'TUI quit' });
    // Leaving the alternate screen brings back the output from before the restart.
    const rows = await rowsOf(PANE);
    assert(rows.some((l) => /scroll-line-60/.test(l)), `normal screen restored: ${rows.slice(-8).join(' | ')}`);
    await typeInTerminal(`Write-Output "after-restart-${tag}"`);
    await waitFor(async () => (await rowsOf(PANE)).some((l) => l === `after-restart-${tag}`), { timeout: 15000, what: 'typed output after the restart' });
    return `tick ${t1} → ${t2}`;
  });

  await step('isolated VS Code re-binds its mirror terminal: typing there works, it shows old + new output', async () => {
    await waitFor(async () => {
      const s = (await client.request('pty.list')).find((x) => x.id === ptyId);
      return s && s.mirror && s.mirror.windowId === windowId;
    }, { timeout: 60000, interval: 500, what: 'session mirrored to the VS Code window again' });
    const t = (await termList()).find((x) => x.ptyId === ptyId);
    assert(t && t.isMirror && t.tid === mirTid, `same mirror terminal ${JSON.stringify(t)}`);
    // Typing in the VS Code terminal (terminal.sendText → Pseudoterminal.handleInput → mirror.input).
    await vsc('terminals.sendText', { tid: mirTid, text: `Write-Output "vscode-typed-${tag}"`, addNewLine: true });
    await waitFor(async () => (await rowsOf(PANE)).some((l) => l === `vscode-typed-${tag}`), { timeout: 15000, what: 'VS Code input shown in the PWA' });
    if (clipboardHasNonText()) throw new SkipError('clipboard holds non-text data; VS Code terminal content not read');
    const snap = await vsc('terminals.snapshot', { tid: mirTid });
    for (const w of [`durable-before-${tag}`, 'scroll-line-60', 'tui-bye q', `after-restart-${tag}`, `vscode-typed-${tag}`]) {
      assert(snap.text.includes(w), `VS Code terminal lacks "${w}": ${snap.text.slice(-600)}`);
    }
    assert(!/\[process ended\]/.test(snap.text), 'no [process ended]');
    return `VS Code terminal shows ${snap.lines} line(s), before + after the restart`;
  });

  await step('fresh attach after the restart has the full scrollback; new ids continue after the highest', async () => {
    const att = await client.request('pty.attach', { id: ptyId });
    await client.request('pty.detach', { id: ptyId });
    for (const w of [new RegExp(`durable-before-${tag}`), /scroll-line-1(?!\d)/, new RegExp(`after-restart-${tag}`)]) assert(w.test(att.buffer), `buffer lacks ${w}`);
    // Reload the page: the panel re-attaches; scrolling up shows the first lines.
    await page.reload();
    await waitOnline();
    await openPanel();
    const mirName = (await termList()).find((t) => t.tid === mirTid)?.name || '';
    await page.locator('.wbc-term-tab', { hasText: mirName }).first().click();
    const tab = await page.$$eval('.wbc-term-tab', (ts) => ts.map((x) => x.textContent.trim()));
    await waitFor(async () => (await rowsOf(PANE)).some((l) => l === `vscode-typed-${tag}`), { timeout: 20000, what: 'mirrored terminal after a page reload' })
      .catch(async (err) => { throw new Error(`${err.message}; tabs ${tab.join('|')}`); });
    const box = await page.$(`${PANE} .xterm-screen`).then((e) => e.boundingBox());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -1200);
    // At the very top of a long scrollback: the first prompt, not the latest output.
    // (xterm 6 scrolls its own way: judge by the rows shown, which held vscode-typed-… a moment ago)
    await waitFor(async () => {
      const rows = await rowsOf(PANE);
      return promptStartsAt(rows, 0) && !rows.some((l) => l === `vscode-typed-${tag}` || /scroll-line-60/.test(l));
    }, { timeout: 8000, what: 'top of the scrollback after scrolling up' });
    await shot('04-desk-scrollback-after-reload');
    await page.mouse.wheel(0, 100000);
    const maxNum = Math.max(...idsBefore.map((x) => Number(String(x).replace(/\D/g, '')) || 0));
    const fresh = await client.request('pty.create', { cols: 80, rows: 24 });
    const freshNum = Number(String(fresh.id).replace(/\D/g, ''));
    await client.request('pty.kill', { id: fresh.id });
    assert(freshNum > maxNum, `new id ${fresh.id} after ${maxNum}`);
    return `buffer ${att.buffer.length} chars; new id ${fresh.id}`;
  });

  /* ------------------------------------------------------- 3. desktop look, banner, watermark */

  await step('desktop ordinary terminal: output from before the attach, just the xterm (Consolas 14px, #181818)', async () => {
    await page.locator('.wbc-term-tab', { hasText: 'ord-ps' }).first().click();
    await waitFor(async () => (await rowsOf(PANE)).some((l) => /ord-before-30/.test(l)), { timeout: 15000, what: 'pre-attach output' });
    await sleep(500);
    const st = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const vis = (q) => { const e = el.querySelector(q); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; };
      const rows = el.querySelector('.xterm-rows');
      const wrap = el.querySelector('.vst-wrap');
      return {
        xkeys: vis('.xkeys'), cmdline: vis('.cmdline'), head: vis('.view-head'), oldext: vis('.vst-oldext'), history: vis('.vst-history'),
        font: getComputedStyle(rows).fontFamily, size: getComputedStyle(rows).fontSize, bg: wrap ? getComputedStyle(wrap).backgroundColor : '',
      };
    }, PANE);
    await shot('05-desk-ordinary-terminal');
    assert(!st.xkeys && !st.cmdline && !st.head && !st.oldext && !st.history, `chrome visible ${JSON.stringify(st)}`);
    // 14px, or smaller when VS Code's grid of this terminal is wider than the pane (it keeps VS Code's size).
    const px = parseFloat(st.size);
    assert(/Consolas/.test(st.font) && px >= 11 && px <= 14, `font ${st.font} ${st.size}`);
    assert(st.bg === 'rgb(24, 24, 24)', `background ${st.bg}`);
    return `${st.size} ${st.font.split(',')[0]} on ${st.bg}`;
  });

  const wmCheck = () => page.evaluate(() => {
    const title = document.querySelector('.wb-panel-title').getBoundingClientRect();
    const pts = [];
    for (let x = title.left + 5; x < title.right; x += 40) for (const y of [title.top + 3, title.top + title.height / 2, title.bottom - 3]) pts.push([x, y]);
    const bleed = pts.filter(([x, y]) => document.elementsFromPoint(x, y).some((e) => e.closest('.wb-watermark'))).length;
    const shown = [...document.querySelectorAll('.wb-watermark-entry, .wb-letterpress')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().height > 0);
    const overlapping = shown.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > title.top + 0.5 && r.top < title.bottom; }).length;
    return { bleed, overlapping, shown: shown.length };
  });

  await step('watermark (no editor open) never covers the panel header: tall, medium and small panel', async () => {
    await page.evaluate(() => { for (const b of document.querySelectorAll('.wb-tab .wb-tab-close, .wb-tab [aria-label^="Close"]')) b.click(); });
    const out = [];
    for (const h of [700, 470, 160]) {
      await page.evaluate((v) => document.querySelector('.wb').style.setProperty('--wb-panel-h', `${v}px`), h);
      await sleep(600);
      const r = await wmCheck();
      if (h === 700) await shot('06-desk-watermark-tall-panel');
      assert(!r.bleed && !r.overlapping, `panel ${h}px: ${JSON.stringify(r)}`);
      out.push(`${h}px: ${r.shown} entries`);
    }
    await page.evaluate(() => document.querySelector('.wb').style.setProperty('--wb-panel-h', '300px'));
    return out.join('; ');
  });

  await step('old extension (terminals.attach unknown) → inline reload banner, never history; reload asks first', async () => {
    await page.evaluate(() => sessionStorage.setItem('__failMethods', JSON.stringify(['terminals.attach', 'settings.get', 'terminals.snapshot'])));
    await page.reload();
    await waitOnline();
    await openPanel();
    await page.locator('.wbc-term-tab', { hasText: 'ord-ps' }).first().click();
    await page.waitForSelector(`${PANE} .vst-oldext:not([hidden])`, { timeout: 15000 });
    const txt = (await page.textContent(`${PANE} .vst-oldext`)).replace(/\s+/g, ' ');
    const hist = await page.$eval(`${PANE} .vst-history`, (e) => !e.hidden && e.getClientRects().length > 0).catch(() => false);
    await shot('07-desk-old-extension-banner');
    assert(!hist, 'history shown as the primary view');
    assert(/older TermPocket extension/.test(txt) && /Reload window/.test(txt) && /Show history/.test(txt), txt);
    await page.click(`${PANE} .vst-oldext .btn`);
    await page.waitForSelector('.wb-dialog', { timeout: 6000 });
    const d = (await page.textContent('.wb-dialog')).replace(/\s+/g, ' ');
    await page.locator('.wb-dialog button', { hasText: 'Cancel' }).click();
    assert(/keep running/i.test(d), `confirm text: ${d}`);
    assert((await page.evaluate(() => window.__reloadCalls.length)) === 0, 'reload sent although cancelled');
    await page.evaluate(() => sessionStorage.removeItem('__failMethods'));
    return txt.slice(0, 120);
  });
  await dctx.close();

  /* ------------------------------------------------------- 4. phone layout */

  const pctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, colorScheme: 'dark' });
  await pctx.addInitScript(INIT_SCRIPT);
  pctx.setDefaultTimeout(12000);
  page = await pctx.newPage();
  watch(page, 'phone');
  const PV = '#views .vsterm-view';
  const back = async () => {
    for (let i = 0; i < 3; i++) {
      const b = await page.$('#views .view .view-head .back');
      if (!b) break;
      await b.click().catch(() => {});
      await sleep(500);
    }
  };

  await step('phone: ordinary terminal keeps the app theme, extra keys and command box (layout unchanged)', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(agent.token)}`);
    await waitOnline();
    await page.click('#tab-terminals');
    const row = page.locator('.vs-sections .row', { hasText: 'ord-ps' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator('.row-main').click();
    await waitFor(async () => (await rowsOf(PV)).some((l) => /ord-before/.test(l)), { timeout: 15000, what: 'output' });
    await sleep(600);
    const st = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const vis = (q) => { const e = el.querySelector(q); return !!e && e.getClientRects().length > 0; };
      return { vsLook: el.classList.contains('vs-look'), xkeys: vis('.xkeys'), cmdline: vis('.cmdline') };
    }, PV);
    await shot('08-phone-ordinary');
    assert(!st.vsLook && st.xkeys && st.cmdline, JSON.stringify(st));
    return JSON.stringify(st);
  });

  await step('phone: the durable mirrored terminal shows the post-restart output, with extra keys', async () => {
    await back();
    const name = (await termList()).find((t) => t.tid === mirTid)?.name || '';
    const row = page.locator('.vs-sections .row', { hasText: name }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator('.row-main').click();
    const TV = '#views .term-view';
    await waitFor(async () => (await rowsOf(TV)).some((l) => l.includes(`vscode-typed-${tag}`)), { timeout: 15000, what: 'mirrored output on the phone' });
    await sleep(500);
    const st = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const vis = (q) => { const e = el.querySelector(q); return !!e && e.getClientRects().length > 0; };
      return { vsLook: el.classList.contains('vs-look'), xkeys: vis('.xkeys') };
    }, TV);
    await shot('09-phone-mirrored');
    assert(!st.vsLook && st.xkeys, JSON.stringify(st));
    return `"${name}" ${JSON.stringify(st)}`;
  });
  await pctx.close();
  page = null;
}

async function teardown() {
  if (browser) await browser.close().catch(() => {});
  if (code.proc) {
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
  const hp = await status().then((s) => s.ptyHost && s.ptyHost.pid).catch(() => null);
  if (client) client.close();
  await step('stop agent and shut its PTY host down', async () => {
    const note = await agent.stop();
    if (hp) await waitFor(() => !isAlive(hp), { timeout: 10000, what: 'PTY host exit' });
    return note;
  });
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
if (problems.length) {
  results.push({ name: 'no console / page errors', result: 'fail', ms: 0, detail: problems.slice(0, 20).join('\n') });
  console.log(`  FAIL console / page errors (${problems.length}):\n    ${problems.slice(0, 10).join('\n    ')}`);
} else results.push({ name: 'no console / page errors', result: 'pass', ms: 0, detail: '' });
fs.writeFileSync(path.join(ARTIFACTS, 'durable-terminals-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.result === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''} — shots in ${SHOTS}`);
process.exit(failed.length || fatal ? 1 : 0);
