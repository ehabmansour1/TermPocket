#!/usr/bin/env node
// TermPocket — live view of ORDINARY VS Code terminals (PROTOCOL §5.2 terminals.attach / term.raw, §5.2.1, §6).
//
// Everything runs on this machine, localhost only:
//   * the real agent on 127.0.0.1:<free port> in a temp TERMPOCKET_HOME with TERMPOCKET_DRYRUN_INPUT=1,
//   * an isolated VS Code (temp --user-data-dir / --extensions-dir / USERPROFILE, --disable-extensions,
//     the extension from ../vscode-extension via --extensionDevelopmentPath),
//   * the real web/ app in headless Google Chrome (playwright-core, channel "chrome"): desktop 1440×900
//     and phone 412×915 (Pixel 7 emulation).
//
// In the isolated VS Code an ordinary PowerShell terminal (shell integration on) runs a small full-screen
// TUI (tui.js: alternate screen, coloured box, live counter, raw stdin key echo, exits on q / Ctrl+C). The
// PWA must show it in the Live view, take keystrokes (xterm keyboard, extra keys, command box), stop the
// term.raw stream when it is not on screen, keep the VS Code terminal's size, show the not-capturing note
// for a terminal without shell integration, and switch the user's default profile to the mirrored one.
//
// Usage: node vscode-live.e2e.mjs [--port <n>] [--shots <dir>] [--headed] [--keep-temp]

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';
import {
  E2E_DIR, AgentProcess, IsolatedVsCode, PhoneClient, assert, createSandbox, removeSandbox, sleep, waitFor,
  writeWorkspace,
} from './lib/harness.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const HEADED = flag('--headed');
const KEEP_TEMP = flag('--keep-temp');
const SHOTS = path.resolve(option('--shots', process.env.TERMPOCKET_E2E_SHOTS || path.join(E2E_DIR, 'artifacts', 'live-shots')));
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false, colorScheme: 'dark' };
const PHONE = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, colorScheme: 'dark' };
const MIRROR_PROFILE = 'TermPocket (mirrored)';

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.jpg')) fs.rmSync(path.join(SHOTS, f));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const PORT = Number(option('--port', 0)) || await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------------------------------- */
/* Steps                                                                                         */
/* ------------------------------------------------------------------------------------------- */

const results = [];
class SkipError extends Error {}
let page = null;

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
    if (!skip && page && !page.isClosed()) {
      await page.screenshot({ path: path.join(ARTIFACTS, `live-fail-${results.length}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
      await recover().catch(() => {});
    }
    return false;
  }
}

let shotCount = 0;
async function shot(name) {
  shotCount++;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `${String(shotCount).padStart(2, '0')}-${name}.jpg`), type: 'jpeg', quality: 72 });
}

/* ------------------------------------------------------------------------------------------- */
/* Environment                                                                                   */
/* ------------------------------------------------------------------------------------------- */

const dirs = createSandbox('termpocket-live-e2e-');
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'live-agent.log') });
const code = new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'live-vscode-main.log') });
let client = null;
let browser = null;
let windowId = null;
const problems = { console: [], pageErrors: [] };

/** term.raw / term.dims events seen by our own phone socket, per tid. */
const raw = new Map();
const dimsEvents = [];
function rawOf(tid) {
  if (!raw.has(tid)) raw.set(tid, { n: 0, text: '' });
  return raw.get(tid);
}

// The full-screen program the tests drive: alternate screen, colours, a counter, raw key echo.
const TUI = String.raw`
const out = process.stdout;
let n = 0;
let keys = '';
const W = 38;
const NAMES = { '\x1b[A': '<UP>', '\x1b[B': '<DOWN>', '\x1b[C': '<RIGHT>', '\x1b[D': '<LEFT>', '\r': '<CR>', '\x7f': '<BS>', '\t': '<TAB>' };
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
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === '\x03') return bye('ctrl-c', 130);
    if (c === 'q') return bye('q', 0);
    const seq = d.slice(i, i + 3);
    if (NAMES[seq]) { keys += NAMES[seq]; i += 2; continue; }
    keys += NAMES[c] || (c < ' ' ? '^' + String.fromCharCode(c.charCodeAt(0) + 64) : c);
  }
  keys = keys.slice(-30);
  draw();
});
`;

/** Track the page's WebSockets so a step can drop the link (like a phone losing its network). */
const SOCKET_HOOK = () => {
  const Native = window.WebSocket;
  window.__e2e = { sockets: [] };
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.__e2e.sockets.push(this);
    }
  };
};

function watchPage(p, label) {
  p.on('console', (m) => { if (m.type() === 'error') problems.console.push(`[${label}] ${m.text()}`); });
  p.on('pageerror', (err) => problems.pageErrors.push(`[${label}] ${err.message}`));
}

/* -------------------------------------------------------------- page helpers */

let scope = ''; // selector of the live view currently under test
const vst = () => scope;

/** Visible xterm rows of the live view, as text. */
async function rows() {
  return page.$$eval(`${vst()} .vst-live .xterm-rows > div`, (rs) => rs.map((r) => r.textContent.replace(/ /g, ' ').trimEnd()));
}
async function waitRow(pred, what, timeout = 15000) {
  return waitFor(async () => (await rows()).find((l) => pred(l.trim())) || null, { timeout, what: `live row ${what}` });
}
async function tickNow() {
  for (const l of await rows()) {
    const m = /tick (\d+)/.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}
async function liveStatus() {
  return ((await page.textContent(`${vst()} .term-status`).catch(() => '')) || '').trim();
}
async function waitLive(timeout = 15000) {
  return waitFor(async () => {
    const st = await liveStatus();
    return /^(live|typing only)$/.test(st) ? st : null;
  }, { timeout, what: 'live view attached' });
}
async function cmdBox(text) {
  await page.fill(`${vst()} .vst-live .cmd-input`, text);
  await page.click(`${vst()} .vst-live .cmd-send`);
}
async function xtermSize() {
  return page.evaluate((s) => {
    const el = document.querySelector(`${s} .vst-size`);
    const m = el && /(\d+)×(\d+)/.exec(el.textContent);
    return m ? { cols: +m[1], rows: +m[2], text: el.textContent } : null;
  }, vst());
}
async function seg(label) {
  await page.click(`${vst()} .vst-seg .seg-btn:has-text("${label}")`);
}
async function expectToast(re, timeout = 8000) {
  return waitFor(async () => (await page.$$eval('#toasts .toast', (ts) => ts.map((t) => t.textContent))).find((t) => re.test(t)) || null,
    { timeout, what: `toast ${re}` });
}
async function terminalsList() {
  return client.vsc(windowId, 'terminals.list');
}
function userSettings() {
  const f = path.join(dirs.userData, 'User', 'settings.json');
  const txt = fs.readFileSync(f, 'utf8');
  const m = /"terminal\.integrated\.defaultProfile\.windows"\s*:\s*"([^"]*)"/.exec(txt);
  return m ? m[1] : null;
}
/** Count term.raw events for tid over `ms`. */
async function rawDuring(tid, ms) {
  const before = rawOf(tid).n;
  await sleep(ms);
  return rawOf(tid).n - before;
}

/** After a failed step: close sheets; phone → leave full-screen views; desktop → back to the Live tab. */
async function recover() {
  await page.keyboard.press('Escape').catch(() => {});
  if (scope.startsWith('#views')) {
    for (let i = 0; i < 3; i++) {
      const back = await page.$('#views .view .view-head .back');
      if (!back) break;
      await back.click().catch(() => {});
      await sleep(500);
    }
  } else if (await page.$(`${vst()} .vst-seg`)) {
    await seg('Live').catch(() => {});
  }
}

/** The VS Code terminal's current size, straight from the extension (attach + detach). */
async function vsDims(tid = tuiTid) {
  const a = await client.vsc(windowId, 'terminals.attach', { tid });
  await client.vsc(windowId, 'terminals.detach', { tid });
  return { cols: a.cols, rows: a.rows };
}

async function openRow(name) {
  const row = page.locator('.vs-sections .row', { hasText: name }).filter({ hasNotText: 'mirrored' }).first();
  await row.waitFor({ timeout: 15000 });
  await row.locator('.row-main').click();
}

/* ------------------------------------------------------------------------------------------- */
/* Main                                                                                          */
/* ------------------------------------------------------------------------------------------- */

let tuiTid = null;
let cmdTid = null;
let cmdName = 'cmd';
let attachDims = null;

async function main() {
  console.log(`TermPocket live-terminal e2e — port ${PORT}, temp ${dirs.tmpRoot}`);
  writeWorkspace(dirs);
  fs.writeFileSync(path.join(dirs.workspace, 'tui.js'), TUI);

  await step('start agent (temp TERMPOCKET_HOME, dry-run input)', async () => `pid ${await agent.start()}`);
  if (!agent.running) throw new Error('agent did not start');
  const token = agent.token;
  client = await PhoneClient.open(PORT, token);
  client.on('vsc.event', ({ ev, p }) => {
    if (!p) return;
    if (ev === 'term.raw') { const r = rawOf(p.tid); r.n++; r.text = (r.text + p.d).slice(-200000); }
    if (ev === 'term.dims') dimsEvents.push(p);
  });

  const up = await step('launch isolated VS Code with the extension and wait for its window', async () => {
    const note = code.launch();
    const wins = await waitFor(async () => {
      const w = await client.request('vsc.windows');
      return w.length ? w : null;
    }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
    windowId = wins[0].windowId;
    return `${note}; window "${wins[0].name}"`;
  });
  if (!up) throw new Error('no VS Code window');

  /* --------------------------------------------------------------- protocol */

  await step('ordinary terminal with shell integration: attach → capturing, dims, buffer + term.raw, input', async () => {
    const r = await client.vsc(windowId, 'terminals.create', { name: 'live-tui', mirror: false });
    tuiTid = r.tid;
    await client.vsc(windowId, 'terminals.show', { tid: tuiTid });
    await waitFor(async () => (await terminalsList()).find((t) => t.tid === tuiTid && t.hasShellIntegration), { timeout: 30000, what: 'shell integration in live-tui' });
    const a = await client.vsc(windowId, 'terminals.attach', { tid: tuiTid });
    assert(a.tid === tuiTid && a.capturing === true && a.isMirror === false, `attach: ${JSON.stringify({ ...a, buffer: a.buffer.length })}`);
    assert(Number.isInteger(a.cols) && Number.isInteger(a.rows) && a.cols > 20 && a.rows > 3, `dims ${a.cols}×${a.rows}`);
    attachDims = { cols: a.cols, rows: a.rows };
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: 'Write-Output ("dims=" + [Console]::WindowWidth + "x" + [Console]::WindowHeight)\r' });
    const m = await waitFor(() => /dims=(\d+)x(\d+)/.exec(rawOf(tuiTid).text), { timeout: 20000, what: 'dims= line in term.raw' });
    assert(+m[1] === a.cols && +m[2] === a.rows, `console ${m[1]}x${m[2]} ≠ attach ${a.cols}×${a.rows}`);
    const ka = await client.vsc(windowId, 'terminals.keepalive', { tid: tuiTid });
    assert(ka.attached === true, `keepalive ${JSON.stringify(ka)}`);
    const re = await client.vsc(windowId, 'terminals.attach', { tid: tuiTid });
    assert(/dims=\d+x\d+/.test(re.buffer) && /\$ Write-Output/.test(re.buffer), 're-attach buffer lacks the earlier output / "$ <command>" line');
    await client.vsc(windowId, 'terminals.detach', { tid: tuiTid });
    await client.vsc(windowId, 'terminals.detach', { tid: tuiTid });
    return `${a.cols}×${a.rows} (PowerShell sees the same), buffer ${re.buffer.length} chars`;
  });

  await step('detached → no term.raw for that terminal even while it prints', async () => {
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: '1..6 | % { Write-Output "quiet-$_"; Start-Sleep -Milliseconds 300 }\r' });
    const n = await rawDuring(tuiTid, 3000);
    assert(n === 0, `${n} term.raw event(s) while detached`);
    const a = await client.vsc(windowId, 'terminals.attach', { tid: tuiTid });
    assert(/quiet-6/.test(a.buffer), 'the ring missed output produced while detached');
    await client.vsc(windowId, 'terminals.detach', { tid: tuiTid });
    return 'ring still captured it (quiet-6 in the next attach buffer)';
  });

  await step('terminal without shell integration (Command Prompt) → attach capturing:false + note', async () => {
    const before = new Set((await terminalsList()).map((t) => t.tid));
    await client.vsc(windowId, 'commands.run', { command: 'workbench.action.terminal.newWithProfile', args: [{ profileName: 'Command Prompt' }] });
    const t = await waitFor(async () => (await terminalsList()).find((x) => !before.has(x.tid)), { timeout: 15000, what: 'Command Prompt terminal' });
    cmdTid = t.tid;
    cmdName = t.name || 'cmd';
    await sleep(2500); // give shell integration (which never comes for cmd) a chance
    const a = await client.vsc(windowId, 'terminals.attach', { tid: cmdTid });
    await client.vsc(windowId, 'terminals.detach', { tid: cmdTid });
    assert(a.capturing === false && a.hasShellIntegration === false && typeof a.note === 'string' && a.note, `attach ${JSON.stringify(a)}`);
    await client.vsc(windowId, 'commands.run', { command: 'workbench.action.terminal.focus' }).catch(() => {});
    await client.vsc(windowId, 'terminals.show', { tid: tuiTid });
    return `"${t.name}" ${cmdTid}: ${a.note.slice(0, 60)}…`;
  });

  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });

  /* ---------------------------------------------------------------- desktop */

  const dctx = await browser.newContext(DESKTOP);
  page = await dctx.newPage();
  watchPage(page, 'desktop');
  scope = '.term-deck .deck-pane:not([hidden]) .vsterm-view';

  await step('desktop 1440×900: pair, open the ordinary terminal → Live tab attached at VS Code\'s size', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(token)}`);
    await page.waitForSelector('#statusPill[data-status="online"]', { state: 'attached', timeout: 20000 });
    await page.click('#tab-terminals');
    await openRow('live-tui');
    await page.waitForSelector(`${vst()} .vst-live .xterm-rows`, { timeout: 15000 });
    const st = await waitLive();
    assert(st === 'live', `status chip "${st}"`);
    const sz = await waitFor(xtermSize, { timeout: 5000, what: 'size label' });
    const vd = await vsDims();
    assert(sz.cols === vd.cols && sz.rows === vd.rows, `xterm ${sz.text} ≠ VS Code ${vd.cols}×${vd.rows}`);
    // xterm renders the attach buffer asynchronously (next frames): wait for it rather than sampling once.
    const seeded = await waitFor(async () => (await rows()).some((l) => /quiet-6|dims=/.test(l)) || null, { timeout: 5000, what: 'xterm seeded with the attach buffer' }).catch(() => null);
    assert(seeded, 'xterm not seeded with the attach buffer: ' + JSON.stringify((await rows()).filter(Boolean)).slice(0, 600));
    const fit = await page.evaluate((s) => {
      const wrap = document.querySelector(`${s} .vst-wrap`);
      const x = document.querySelector(`${s} .xterm-screen`).getBoundingClientRect();
      return { wrap: wrap.clientWidth, screen: Math.round(x.width), sw: wrap.scrollWidth };
    }, vst());
    assert(fit.screen <= fit.wrap + 1, `xterm ${fit.screen}px wider than the pane ${fit.wrap}px in fit mode`);
    return `${sz.text}; xterm ${fit.screen}px in ${fit.wrap}px`;
  });

  await step('desktop: type "node tui.js⏎" on the physical keyboard → box, colours and a live counter', async () => {
    await page.click(`${vst()} .xterm-screen`);
    await page.keyboard.type('node tui.js');
    await page.keyboard.press('Enter');
    await waitRow((l) => /VSC-TUI demo/.test(l), 'TUI title', 20000);
    const t0 = await waitFor(tickNow, { what: 'tick' });
    const t1 = await waitFor(async () => { const t = await tickNow(); return t != null && t >= t0 + 3 ? t : null; }, { timeout: 8000, what: 'counter to advance' });
    const size = await waitRow((l) => /size \d+x\d+/.test(l), 'size line');
    const m = /size (\d+)x(\d+)/.exec(size);
    const vd = await vsDims();
    const sz = await xtermSize();
    assert(+m[1] === vd.cols && +m[2] === vd.rows && sz.cols === vd.cols && sz.rows === vd.rows, `TUI sees ${m[1]}x${m[2]}, xterm ${sz.text}, VS Code ${vd.cols}×${vd.rows}`);
    const coloured = await page.$$eval(`${vst()} .xterm-rows span`, (ss) => ss.some((s) => /xterm-fg-|xterm-bold/.test(s.className) || s.style.color));
    assert(coloured, 'no coloured cells in the TUI box');
    await shot('desktop-live-tui');
    return `tick ${t0} → ${t1}; TUI size ${m[1]}x${m[2]}`;
  });

  await step('desktop: physical keyboard typed into xterm and the command box reach the TUI', async () => {
    await page.click(`${vst()} .xterm-screen`);
    await page.keyboard.type('abc');
    await page.keyboard.press('ArrowLeft');
    await waitRow((l) => /keys: abc<LEFT>/.test(l), 'echo of "abc" + ←', 8000);
    // The command box is hidden by default on desktop: turn it on from the view's menu.
    await page.click(`${vst()} .view-head [aria-label="More"]`);
    await page.locator('#layers .sheet .action-item', { hasText: 'Show command line' }).first().click();
    await page.waitForSelector(`${vst()} .vst-live .cmd-input`, { state: 'visible', timeout: 5000 });
    await cmdBox('hi');
    await waitRow((l) => /keys: abc<LEFT>hi<CR>/.test(l), 'echo of command box "hi⏎"', 8000);
    return (await rows()).find((l) => /keys:/.test(l)).trim();
  });

  await step('desktop: History tab → no term.raw while hidden; Live again re-attaches and redraws', async () => {
    await seg('History');
    await page.waitForSelector(`${vst()} .exec-view`);
    await waitFor(async () => /node tui\.js/.test(await page.textContent(`${vst()} .exec-view`)), { timeout: 8000, what: 'node tui.js in History' });
    await sleep(3200); // 2.5 s detach grace
    const n = await rawDuring(tuiTid, 2500);
    assert(n === 0, `${n} term.raw event(s) after the Live tab was left`);
    await seg('Live');
    await waitLive();
    await waitRow((l) => /VSC-TUI demo/.test(l), 'TUI redrawn from the ring', 10000);
    const n2 = await rawDuring(tuiTid, 1500);
    assert(n2 > 0, 'term.raw did not resume after re-attach');
    return `0 events while on History, ${n2} in 1.5 s after re-attach`;
  });

  await step('desktop: Ctrl+C typed into xterm stops the TUI; History lists it', async () => {
    await page.click(`${vst()} .xterm-screen`);
    await page.keyboard.press('Control+c');
    await waitRow((l) => /tui-bye ctrl-c/.test(l), '"tui-bye ctrl-c"', 10000);
    assert(!(await rows()).some((l) => /VSC-TUI demo/.test(l)), 'alternate screen still shown');
    await seg('History');
    const blk = page.locator(`${vst()} .exec-view .exec-block`, { hasText: 'node tui.js' }).last();
    await blk.locator('.pill', { hasText: /exit [1-9]/ }).first().waitFor({ timeout: 10000 });
    await seg('Live');
    return 'exited with ^C';
  });

  await step('desktop: deck tab switch detaches, closing the tab detaches at once', async () => {
    // Open the Command Prompt terminal as a second deck tab; the first one goes to the background.
    await openRow(cmdName);
    await waitFor(async () => (await page.$$('.term-deck .deck-tab')).length === 2, { what: 'second deck tab' });
    await sleep(3200);
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: 'Write-Output "bg-$(1+1)"\r' });
    const n = await rawDuring(tuiTid, 2500);
    assert(n === 0, `${n} term.raw event(s) for the background deck tab`);
    await shot('desktop-banner');
    // Close every deck tab → nothing attached.
    for (let i = 0; i < 3 && (await page.$$('.term-deck .deck-tab')).length; i++) {
      await page.click('.term-deck .deck-tab .deck-tab-close');
      await sleep(300);
    }
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: 'Write-Output "closed-$(1+1)"\r' });
    const n2 = await rawDuring(tuiTid, 2000);
    assert(n2 === 0, `${n2} term.raw event(s) after closing the tabs`);
    return 'no stream in the background or after close';
  });
  await dctx.close();

  /* ------------------------------------------------------------------ phone */

  const pctx = await browser.newContext(PHONE);
  await pctx.addInitScript(SOCKET_HOOK);
  page = await pctx.newPage();
  watchPage(page, 'phone');
  scope = '#views .vsterm-view';

  await step('phone 412×915: open the ordinary terminal → Live view fits VS Code\'s columns', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(token)}`);
    await page.waitForSelector('#statusPill[data-status="online"]', { timeout: 20000 });
    await page.click('#tab-terminals');
    await openRow('live-tui');
    await page.waitForSelector(`${vst()} .vst-live .xterm-rows`, { timeout: 15000 });
    assert((await waitLive()) === 'live', 'not live');
    const sz = await waitFor(xtermSize, { timeout: 5000, what: 'size label' });
    const vd = await vsDims();
    assert(sz.cols === vd.cols && sz.rows === vd.rows, `xterm ${sz.text} ≠ VS Code ${vd.cols}×${vd.rows}`);
    await waitRow((l) => /tui-bye ctrl-c/.test(l), 'earlier output from the ring', 8000);
    const fit = await page.evaluate((s) => {
      const wrap = document.querySelector(`${s} .vst-wrap`);
      const x = document.querySelector(`${s} .xterm-screen`).getBoundingClientRect();
      return { wrap: wrap.clientWidth, screen: Math.round(x.width), doc: document.documentElement.scrollWidth, vw: innerWidth };
    }, vst());
    assert(fit.screen <= fit.wrap + 1, `xterm ${fit.screen}px wider than the pane ${fit.wrap}px`);
    assert(fit.doc <= fit.vw, `page scrolls horizontally (${fit.doc} > ${fit.vw})`);
    return `${sz.text} in ${fit.wrap}px`;
  });

  await step('phone: TUI via command box, soft-keyboard typing, ↑ extra key, then "q" quits', async () => {
    await cmdBox('node tui.js');
    await waitRow((l) => /VSC-TUI demo/.test(l), 'TUI title', 20000);
    const t0 = await waitFor(tickNow, { what: 'tick' });
    await waitFor(async () => ((await tickNow()) ?? 0) >= t0 + 2, { timeout: 8000, what: 'counter to advance' });
    await page.focus(`${vst()} .xterm-helper-textarea`);
    await page.keyboard.type('xyz');
    await waitRow((l) => /keys: xyz/.test(l), 'echo of "xyz"', 8000);
    await page.click(`${vst()} .xkey[aria-label="Up"]`);
    await waitRow((l) => /keys: xyz<UP>/.test(l), 'echo of ↑ extra key', 8000);
    await shot('phone-live-tui');
    await cmdBox('q');
    await waitRow((l) => /tui-bye q/.test(l), '"tui-bye q"', 10000);
    return 'echoed "xyz<UP>", quit with q';
  });

  await step('phone: History tab lists both TUI runs with exit codes', async () => {
    await seg('History');
    await page.waitForSelector(`${vst()} .exec-view`);
    const n = await waitFor(async () => {
      const txt = await page.textContent(`${vst()} .exec-view`);
      const c = (txt.match(/node tui\.js/g) || []).length;
      return c >= 2 ? c : null;
    }, { timeout: 10000, what: 'two node tui.js entries' });
    await seg('Live');
    await waitLive();
    await page.click(`${vst()} .view-head .back`);
    await page.waitForSelector(vst(), { state: 'detached', timeout: 5000 });
    return `${n} entries`;
  });

  await step('phone: link dropped while live → re-attach replaces the old attachment; closing then stops term.raw', async () => {
    await openRow('live-tui');
    assert((await waitLive()) === 'live', 'not live');
    await page.evaluate(() => { for (const ws of window.__e2e.sockets) try { ws.close(4000, 'e2e drop'); } catch { /* ignore */ } });
    await waitFor(async () => /offline|connecting/.test(await liveStatus()) || null, { timeout: 8000, what: 'view noticed the drop' }).catch(() => {});
    await waitFor(async () => (await liveStatus()) === 'live' || null, { timeout: 20000, what: 'live again after reconnect' });
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: 'Write-Output "re-$(2+3)"\r' });
    await waitRow((l) => /^re-5$/.test(l), 'output after re-attach', 10000);
    await page.click(`${vst()} .view-head .back`);
    await page.waitForSelector(vst(), { state: 'detached', timeout: 5000 });
    await sleep(800);
    await client.vsc(windowId, 'terminals.input', { tid: tuiTid, d: '1..5 | % { Write-Output "after-close-$_"; Start-Sleep -Milliseconds 300 }\r' });
    const n = await rawDuring(tuiTid, 3000);
    assert(n === 0, `${n} term.raw event(s) after the view was closed: the pre-drop attachment leaked`);
    return 'no stream after close (the attachment from before the drop was replaced, not leaked)';
  });

  await step('phone: terminal without shell integration → note banner; its button makes new terminals mirrored', async () => {
    await openRow(cmdName);
    await page.waitForSelector(`${vst()} .vst-note`, { timeout: 15000 });
    const st = await liveStatus();
    assert(st === 'typing only', `status chip "${st}"`);
    const text = await page.textContent(`${vst()} .vst-note .banner-text`);
    assert(/shell integration/i.test(text), `note: ${text}`);
    await shot('phone-banner');
    assert(userSettings() === 'PowerShell', `default profile before: ${userSettings()}`);
    await page.click(`${vst()} .vst-note .btn:has-text("Make new terminals phone-visible")`);
    const toast = await expectToast(/TermPocket \(mirrored\)/);
    assert(/already open stay ordinary/i.test(toast), `toast: ${toast}`);
    await waitFor(() => userSettings() === MIRROR_PROFILE, { timeout: 8000, what: 'settings.json default profile' });
    const s = await client.vsc(windowId, 'settings.get');
    assert(s.mirrorDefault === true, `settings.get ${JSON.stringify(s)}`);
    await page.click(`${vst()} .view-head .back`);
    await page.waitForSelector(vst(), { state: 'detached', timeout: 5000 });
    return `settings.json → "${userSettings()}"`;
  });

  await step('a VS Code terminal created afterwards is mirrored; the settings switch shows it and turns it off', async () => {
    const before = new Set((await terminalsList()).map((t) => t.tid));
    await client.vsc(windowId, 'commands.run', { command: 'workbench.action.terminal.new' });
    const t = await waitFor(async () => (await terminalsList()).find((x) => !before.has(x.tid) && x.isMirror && x.ptyId), { timeout: 20000, what: 'new mirrored terminal' });
    await page.click('#menuBtn');
    const sw = page.locator('#layers .sheet .toggle[aria-label="New VS Code terminals are phone-visible"]');
    await sw.waitFor({ timeout: 8000 });
    await waitFor(async () => (await sw.getAttribute('aria-checked')) === 'true' && !(await sw.isDisabled()), { timeout: 8000, what: 'switch on' });
    await sw.click();
    await waitFor(() => userSettings() === 'PowerShell', { timeout: 8000, what: 'previous default profile restored' });
    assert((await sw.getAttribute('aria-checked')) === 'false', 'switch still on');
    await page.keyboard.press('Escape');
    return `${t.tid} "${t.name}" isMirror → ptyId ${t.ptyId}; restored "PowerShell"`;
  });

  await step('no console errors or page errors', async () => {
    assert(!problems.console.length && !problems.pageErrors.length,
      `console: ${JSON.stringify(problems.console.slice(0, 6))}; page: ${JSON.stringify(problems.pageErrors.slice(0, 6))}`);
  });
  await pctx.close();
}

/* ------------------------------------------------------------------------------------------- */
/* Teardown                                                                                      */
/* ------------------------------------------------------------------------------------------- */

async function teardown() {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
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
fs.writeFileSync(path.join(ARTIFACTS, 'live-results.json'), JSON.stringify({ at: new Date().toISOString(), port: PORT, pass, fail, skip, shots: SHOTS, problems, results }, null, 2));
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped${fatal ? ' (fatal error)' : ''}; screenshots in ${SHOTS}`);
process.exit(fail ? 1 : 0);
