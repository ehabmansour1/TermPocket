#!/usr/bin/env node
// TermPocket — README screenshots and the GitHub social preview, reproducibly.
//
//   cd e2e && npm run screenshots            (writes docs/images/)
//
// Everything shown is demo data, so the images never contain anything from this PC:
//   * the agent runs in demo mode (TERMPOCKET_DEMO=1: host "DEV-PC", user "you", sample IPs, the
//     synthetic desktop from agent/demo/ instead of a screen capture, input always dry-run) on a free
//     127.0.0.1 port with a temp TERMPOCKET_HOME and its own PTY host pipe;
//   * an isolated VS Code (temp profile, parked off-screen by lib/harness.mjs) opens a sample project
//     "my-app" (screenshots/demo-workspace.mjs) written to C:\dev\my-app — a neutral path, because
//     prompts, terminal subtitles and the Code tab show the folder. The folder is created for the run
//     and removed afterwards (a folder that is not ours is never touched: use --workspace);
//   * the terminals run screenshots/demo-session.mjs: canned, colourful sessions (an AI coding agent,
//     a dev server, a test run). No AI service is called, nothing is built;
//   * shells start with -NoProfile, and the VS Code terminal snapshot (which uses the clipboard) is off.
// Before every capture the page text is checked for this PC's name, user name, home and temp paths and
// IP addresses; a hit fails the run instead of writing the image.
//
// Headless Google Chrome only (playwright-core, channel "chrome"). Nothing acts on the real desktop.
//
// Usage: node screenshots.mjs [--out <dir>] [--workspace <dir>] [--only a,b] [--headed] [--keep-temp]
//   --only   capture only these shots (names as in SHOTS below); compose steps reuse existing files.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import {
  E2E_DIR, ROOT, AgentProcess, IsolatedVsCode, PhoneClient, createSandbox, removeSandbox, sleep, waitFor,
} from './lib/harness.mjs';
import { writeDemoWorkspace } from './screenshots/demo-workspace.mjs';
import { optimizePng } from './screenshots/png.mjs';
import { dataUrl, renderHero, renderSocial, renderTray, trayData } from './screenshots/compose.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const HEADED = flag('--headed');
const KEEP_TEMP = flag('--keep-temp');
const OUT = path.resolve(option('--out', path.join(ROOT, 'docs', 'images')));
const WORKSPACE = path.resolve(option('--workspace', 'C:\\dev\\my-app'));
const ONLY = option('--only', '') ? new Set(option('--only', '').split(',').map((s) => s.trim())) : null;
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const SESSION = path.join(E2E_DIR, 'screenshots', 'demo-session.mjs');
const MARKER = path.join(WORKSPACE, '.git', 'termpocket-screenshots'); // "this folder is ours"
const want = (name) => !ONLY || ONLY.has(name);
// Only the composed images: no agent / VS Code needed, the shots already in --out are reused.
const COMPOSE_ONLY = !!ONLY && [...ONLY].every((n) => n === 'social-preview' || n === 'hero' || n === 'logo');

const PHONE = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: 'dark' };
const LAPTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false, colorScheme: 'dark' };

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/* ------------------------------------------------------------------------------------ privacy */

/** Strings that must never appear in an image: this PC's identity, paths and addresses. */
function forbiddenStrings(tmpRoot) {
  const out = new Set();
  const add = (s) => { if (s && String(s).length >= 3) out.add(String(s).toLowerCase()); };
  add(os.hostname());
  const user = os.userInfo().username;
  add(user);
  for (const part of user.split(/\s+/)) if (part.length >= 4) add(part);
  add(os.homedir());
  add(os.homedir().replace(/\\/g, '/'));
  add(fs.realpathSync.native(os.tmpdir()));
  add(os.tmpdir());
  add(tmpRoot);
  add(path.basename(tmpRoot));
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && a.family === 'IPv4') add(a.address);
  }
  for (const k of ['COMPUTERNAME', 'USERDOMAIN', 'USERNAME']) add(process.env[k]);
  // hardware / OS details that would identify the machine (demo mode reports a sample machine)
  add((os.cpus()[0]?.model || '').trim());
  add(os.release());
  return [...out];
}

let FORBIDDEN = [];

/** Throw if any visible text, input value or title in the page contains a forbidden string. */
async function privacyCheck(page, label) {
  const text = await page.evaluate(() => {
    const parts = [document.body ? document.body.innerText : '', document.title];
    for (const el of document.querySelectorAll('input, textarea')) parts.push(el.value || '');
    for (const el of document.querySelectorAll('[title]')) parts.push(el.getAttribute('title'));
    for (const el of document.querySelectorAll('.xterm-rows')) parts.push(el.textContent);
    return parts.join('\n').toLowerCase();
  });
  const hits = FORBIDDEN.filter((s) => text.includes(s));
  if (hits.length) throw new Error(`privacy check failed for ${label}: page shows ${hits.map((h) => JSON.stringify(h)).join(', ')}`);
}

/* -------------------------------------------------------------------------------------- shots */

const written = []; // {file, what, bytes}

// Blinking bits (the ">_" logo's cursor) are frozen visible, so every shot shows the same thing.
const FREEZE_CSS = '.brand-mark i, .pair-cursor { animation: none !important; opacity: 1 !important; }';

async function settle(page) {
  if (await page.$('.brand-mark i, .pair-cursor')) await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  // toasts ("Paired with …") fade out by themselves
  await page.waitForFunction(() => !document.querySelector('#toasts .toast'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 4000 }).catch(() => {});
  await sleep(250);
}

/**
 * Capture the page (or a clip) to OUT/<name>.png, palette-optimized; JPEG when asked.
 * `what` is the one-line description listed in the summary.
 */
async function capture(page, name, what, { clip, jpeg = false, quality = 88, check = true } = {}) {
  await settle(page);
  if (check) await privacyCheck(page, name);
  const file = path.join(OUT, `${name}.${jpeg ? 'jpg' : 'png'}`);
  if (jpeg) {
    await page.screenshot({ path: file, type: 'jpeg', quality, clip });
  } else {
    const buf = await page.screenshot({ type: 'png', clip });
    fs.writeFileSync(file, await optimizePng(buf));
  }
  const bytes = fs.statSync(file).size;
  written.push({ file, what, bytes });
  console.log(`  shot ${path.basename(file)} — ${(bytes / 1024).toFixed(0)} KB`);
  return file;
}

/* -------------------------------------------------------------------------------- environment */

function prepareWorkspace() {
  if (fs.existsSync(WORKSPACE)) {
    if (!fs.existsSync(MARKER)) {
      throw new Error(`${WORKSPACE} exists and was not made by this script; remove it or pass --workspace <new folder>`);
    }
    fs.rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  const parent = path.dirname(WORKSPACE);
  const madeParent = !fs.existsSync(parent);
  writeDemoWorkspace(WORKSPACE);
  fs.writeFileSync(MARKER, 'created by e2e/screenshots.mjs; removed at the end of the run\n');
  return { madeParent, parent };
}

function cleanupWorkspace(ws) {
  if (!fs.existsSync(MARKER)) return 'workspace marker missing: left alone';
  try {
    fs.rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    if (ws.madeParent && fs.existsSync(ws.parent) && !fs.readdirSync(ws.parent).length) fs.rmdirSync(ws.parent);
    return `removed ${WORKSPACE}`;
  } catch (err) {
    return `could not remove ${WORKSPACE}: ${err.message}`;
  }
}

function writeUserSettings(dirs) {
  const settings = {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'workbench.enableExperiments': false,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'security.workspace.trust.enabled': false,
    'terminal.integrated.defaultProfile.windows': 'PowerShell',
    'terminal.integrated.shellIntegration.enabled': true,
    'terminal.integrated.confirmOnExit': 'never',
    'terminal.integrated.confirmOnKill': 'never',
    'terminal.integrated.enablePersistentSessions': false,
    'window.confirmBeforeClose': 'never',
    'window.restoreWindows': 'none',
    'window.title': '${rootName}',
    'files.hotExit': 'off',
    'git.enabled': true,
    'git.autoRepositoryDetection': true,
    'git.autofetch': false,
    'git.openRepositoryInParentFolders': 'always',
    'chat.disableAIFeatures': true,
    'termpocket.terminalSnapshot': false, // the snapshot borrows the clipboard: never in a screenshot run
  };
  fs.mkdirSync(path.join(dirs.userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(dirs.userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
}

/** A shell that runs one scripted session (no user profile, so nothing personal prints). */
const sessionShell = (mode) => ({
  shell: 'powershell.exe',
  args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& node '${SESSION}' ${mode}`],
});

/* ------------------------------------------------------------------------------------- main */

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dirs = createSandbox('termpocket-shots-');
FORBIDDEN = forbiddenStrings(dirs.tmpRoot);
dirs.workspace = WORKSPACE;
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'screenshots-agent.log') });
const code = new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'screenshots-vscode.log') });
let client = null;
let wid = null;
let browser = null;
let wsState = null;
const pty = {}; // name -> session id
const problems = [];

const vsc = (m, p = {}, t) => client.vsc(wid, m, p, t);

function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (err) => problems.push(`[${label}] page error: ${err.message}`));
}

// The browser never touches the real clipboard.
const INIT_SCRIPT = () => {
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => '', writeText: async () => {} },
    });
  } catch { /* ignore */ }
};

async function setup() {
  console.log(`TermPocket screenshots — port ${PORT}, temp ${dirs.tmpRoot}, workspace ${WORKSPACE}`);
  wsState = prepareWorkspace();
  writeUserSettings(dirs);

  // Demo identity + synthetic desktop. The harness passes process.env through to the agent.
  process.env.TERMPOCKET_DEMO = '1';
  process.env.TERMPOCKET_DEMO_CWD = WORKSPACE;
  // Windows PowerShell drops a "Microsoft" module cache folder into the cwd when it can't use its usual
  // place; keep it in the sandbox so the sample project's explorer stays clean.
  process.env.PSModuleAnalysisCachePath = path.join(dirs.tmpRoot, 'ps-module-cache', 'ModuleAnalysisCache');
  console.log(`  agent pid ${await agent.start()} (demo mode)`);
  client = await PhoneClient.open(PORT, agent.token);

  console.log(`  VS Code: ${code.launch()}`);
  const wins = await waitFor(async () => {
    const w = await client.request('vsc.windows');
    return w.length ? w : null;
  }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
  wid = wins[0].windowId;
  await waitFor(async () => {
    const s = await vsc('git.status').catch(() => null);
    return s && s.available && s.repos.length && s.repos[0].changes.length >= 3 ? s : null;
  }, { timeout: 60000, interval: 1000, what: 'git.status with the repository' });
  await vsc('editor.open', { path: path.join(WORKSPACE, 'src', 'api', 'todos.ts') });
  await waitFor(async () => ((await vsc('diagnostics.list')) || []).some((d) => /todos\.ts$/i.test(d.path) && d.severity === 'error'),
    { timeout: 90000, interval: 1000, what: 'TypeScript diagnostics for todos.ts' });
  await vsc('editor.open', { path: path.join(WORKSPACE, 'src', 'server.ts') });
  console.log(`  VS Code window "${wins[0].name}" with git + diagnostics`);

  // Terminals: two mirrored into VS Code (dev, tests), the agent session as an agent terminal (it then fits
  // whichever screen shows it), and one ordinary VS Code terminal.
  const mk = async (name, mode, mirror) => {
    const s = await client.request('pty.create', { ...sessionShell(mode), cwd: WORKSPACE, title: name, cols: 110, rows: 30, ...(mirror ? { vscodeWindowId: wid } : {}) });
    pty[name] = s.id;
    return s;
  };
  await mk('dev', 'dev', true);
  await mk('tests', 'test', true);
  await mk('claude', 'agent', false);
  const ord = await vsc('terminals.create', { name: 'pwsh', mirror: false });
  await sleep(2500);
  await vsc('terminals.sendText', { tid: ord.tid, text: 'git status -sb', addNewLine: true }).catch(() => {});
  await sleep(1500);

  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
}

async function newPage(ctxOpts, label) {
  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(INIT_SCRIPT);
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  watch(page, label);
  return page;
}

/**
 * A mirrored terminal keeps VS Code's grid (the isolated VS Code is off-screen, so that is 80×30). Resize
 * it to what fits the pane at the default font, like a VS Code panel of that size would.
 */
async function fitPtyToPane(page, paneSel, id, font = 14) {
  const list = await client.request('pty.list');
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`pty ${id} not listed`);
  const m = await page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    const screen = pane.querySelector('.xterm-screen');
    const rowsEl = pane.querySelector('.xterm-rows');
    const p = pane.getBoundingClientRect();
    const r = screen.getBoundingClientRect();
    return { pw: p.width, ph: p.height, sw: r.width, sh: r.height, font: parseFloat(getComputedStyle(rowsEl).fontSize) };
  }, paneSel);
  const k = font / m.font;
  const cols = Math.max(20, Math.floor((m.pw - 24) / ((m.sw / s.cols) * k)));
  const rows = Math.max(5, Math.floor((m.ph - 8) / ((m.sh / s.rows) * k)));
  await client.request('pty.resize', { id, cols, rows });
  return { cols, rows };
}

/* ------------------------------------------------------------------------------- phone shots */

async function phoneShots() {
  const page = await newPage(PHONE, 'phone');
  const tab = async (id) => {
    await page.click(`#tab-${id}`);
    await page.waitForSelector(`#panel-${id}.active`);
  };
  await page.goto(`${BASE}/#token=${encodeURIComponent(agent.token)}`);
  await page.waitForSelector('#statusPill[data-status="online"]', { timeout: 20000 });

  // 1. Terminals list
  await tab('terminals');
  await page.locator('#panel-terminals .row', { hasText: 'claude' }).first().waitFor({ timeout: 15000 });
  await page.locator('.vs-sections .row').first().waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(800);
  if (want('phone-terminals')) await capture(page, 'phone-terminals', 'Phone · Terminals tab: agent terminals and the VS Code window\'s terminals (mirrored + ordinary)');

  // 2. A live terminal: the scripted agent session
  if (want('phone-terminal')) {
    await page.locator('#panel-terminals .row', { hasText: 'claude' }).first().locator('.row-main').click();
    await page.waitForSelector('#views .term-view .xterm-rows');
    await waitFor(async () => (await page.textContent('#views .term-view .xterm-rows')).includes('accept edits'), { timeout: 15000, what: 'agent session drawn' });
    await sleep(800);
    await capture(page, 'phone-terminal', 'Phone · a live terminal: an AI coding-agent session (scripted demo) with the extra-keys row and command box');
    await page.click('#views .term-view .view-head .back');
    await page.waitForSelector('#views .term-view', { state: 'detached' });
  }

  // 3. Code tab: open server.ts in the phone editor
  if (want('phone-code')) {
    await tab('code');
    await page.waitForSelector('#panel-code .window-pick-name', { timeout: 15000 });
    await page.click('#panel-code .seg-btn:has-text("Files")');
    await page.waitForSelector('#panel-code .file-row:has-text("src")');
    await page.click('#panel-code .file-row.dir:has-text("src")');
    await page.waitForSelector('#panel-code .file-row:has-text("server.ts")');
    await capture(page, 'phone-code', 'Phone · Code tab: the files of the VS Code window "my-app"');
    await page.click('#panel-code .file-row:has-text("server.ts")');
    await page.waitForSelector('#views .editor-view textarea.code-area, #views .editor-view .code-view', { timeout: 15000 });
    await sleep(800);
    await capture(page, 'phone-editor', 'Phone · editing src/server.ts of the VS Code window');
    await page.click('#views .editor-view .view-head .back').catch(() => {});
    await sleep(500);
  }

  // 4. Screen
  if (want('phone-screen')) {
    await tab('screen');
    await page.click('#panel-screen .seg-btn:has-text("High")');
    await page.waitForFunction(() => {
      const c = document.querySelector('.screen-canvas');
      return c && c.width > 100;
    }, null, { timeout: 20000 });
    await sleep(1500);
    await capture(page, 'phone-screen', 'Phone · Screen tab: the PC desktop (demo desktop) with touch mouse control');
  }

  // 5. System
  if (want('phone-system')) {
    await tab('system');
    await page.waitForSelector('#panel-system .info-card .info-big', { timeout: 20000 });
    await page.waitForSelector('#panel-system .proc-row', { timeout: 20000 }).catch(() => {});
    await sleep(800);
    await capture(page, 'phone-system', 'Phone · System tab: CPU, memory, battery, network, power and processes');
  }
  await page.context().close();

  // 6. Screen, phone turned sideways
  if (want('phone-screen-landscape')) {
    const land = await newPage({ ...PHONE, viewport: { width: 915, height: 412 }, screen: { width: 915, height: 412 } }, 'phone-landscape');
    await land.goto(`${BASE}/#token=${encodeURIComponent(agent.token)}`);
    await land.waitForSelector('#statusPill[data-status="online"]', { timeout: 20000 });
    await land.click('#tab-screen');
    await land.click('#panel-screen .seg-btn:has-text("High")');
    await land.waitForFunction(() => { const c = document.querySelector('.screen-canvas'); return c && c.width > 100; }, null, { timeout: 20000 });
    await sleep(1500);
    await capture(land, 'phone-screen-landscape', 'Phone (landscape) · Screen tab: the PC desktop (demo desktop) with the keyboard row');
    await land.context().close();
  }
}

/* ------------------------------------------------------------------------------ laptop shots */

async function laptopShots() {
  const page = await newPage(LAPTOP, 'laptop');
  const tab = async (id) => {
    await page.click(`#tab-${id}`);
    await page.waitForSelector(`#panel-${id}.active`);
  };
  await page.goto(`${BASE}/#token=${encodeURIComponent(agent.token)}`);
  await page.waitForSelector('#sideFoot[data-status="online"]', { timeout: 20000 });

  // 1. Code workbench with Monaco and the terminal panel
  if (want('laptop-workbench')) {
    await tab('code');
    await page.waitForSelector('.wb.visible .wb-statusbar', { timeout: 30000 });
    const row = (name) => page.locator('.wb-tree-row').filter({ has: page.locator('.wb-tree-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) }).first();
    await row('src').waitFor({ timeout: 30000 });
    await row('src').click();
    await row('server.ts').waitFor();
    await row('api').click();
    await row('todos.ts').waitFor();
    await row('todos.ts').dblclick();
    await row('rateLimit.ts').dblclick();
    await row('server.ts').dblclick();
    await page.waitForSelector('.wb-editor-part .monaco-editor .view-lines');
    await page.waitForSelector('.wb-panel-tab[data-view="terminal"]', { timeout: 15000 });
    await page.click('.wb-panel-tab[data-view="terminal"]');
    await sleep(1500);
    const t = page.locator('.wbc-term-tab', { hasText: 'dev' }).first();
    if (await t.count()) await t.click();
    await page.waitForSelector('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-rows');
    await sleep(800);
    await fitPtyToPane(page, '.wbc-term-main .wbc-term-pane:not([hidden])', pty.dev);
    await sleep(1500);
    await capture(page, 'laptop-workbench', 'Laptop · Code tab = a VS Code workbench: explorer with git status, Monaco editor, terminal panel');
  }

  // 1b. Source Control: changes, the diff editor and VS Code's diagnostics in PROBLEMS
  if (want('laptop-scm')) {
    if (!(await page.$('.wb.visible .wb-statusbar'))) {
      await tab('code');
      await page.waitForSelector('.wb.visible .wb-statusbar', { timeout: 30000 });
    }
    await page.click('.wb-editor-part .monaco-editor .view-lines').catch(() => {});
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('.wbc-scm .scm-file', { timeout: 15000 });
    await page.locator('.wbc-scm .scm-file').filter({ hasText: 'server.ts' }).first().click();
    await page.waitForSelector('.wb-editor-part .monaco-diff-editor', { timeout: 20000 });
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('.wbc-problems .wbc-prob-file', { timeout: 15000 });
    await sleep(1500);
    await capture(page, 'laptop-scm', 'Laptop · Source Control: staged and unstaged changes, the diff editor, and VS Code\'s diagnostics in PROBLEMS');
  }

  // 2. Terminals split view
  if (want('laptop-terminals')) {
    await tab('terminals');
    await page.locator('#panel-terminals .row', { hasText: 'claude' }).first().waitFor({ timeout: 15000 });
    for (const name of ['dev', 'tests', 'claude']) {
      await page.locator(`#panel-terminals .row[data-pty="${pty[name]}"] .row-main`).click();
      await page.waitForSelector('.term-deck .deck-pane:not([hidden]) .xterm-rows');
      await sleep(700);
    }
    await waitFor(async () => (await page.textContent('.term-deck .deck-pane:not([hidden]) .xterm-rows')).includes('accept edits'), { timeout: 15000, what: 'agent session in the deck' });
    await sleep(800);
    await capture(page, 'laptop-terminals', 'Laptop · Terminals: session list + terminal tabs (a scripted AI coding-agent session)');
  }

  // 3. Remote Desktop
  if (want('laptop-remote-desktop')) {
    await tab('screen');
    await page.waitForFunction(() => { const c = document.querySelector('.screen-canvas'); return c && c.width > 100; }, null, { timeout: 20000 });
    await page.click('#panel-screen .rdp-enter');
    await page.waitForSelector('.screen-tab[data-rdp="on"]');
    await sleep(2500);
    await page.mouse.move(720, 40);
    await page.waitForSelector('.rdp-bar.show', { timeout: 4000 }).catch(() => {});
    await sleep(600);
    await capture(page, 'laptop-remote-desktop', 'Laptop · Remote Desktop mode: full-screen PC desktop (demo desktop) with the toolbar');
    await page.click('.rdp-exit').catch(() => {});
    await sleep(500);
  }

  // 4. System
  if (want('laptop-system')) {
    await tab('system');
    await page.waitForSelector('#panel-system .proc-row', { timeout: 20000 });
    await sleep(800);
    await capture(page, 'laptop-system', 'Laptop · System tab: info cards, power, clipboard, processes');
  }
  await page.context().close();

  // 5. Monitor dashboard
  if (want('laptop-monitor')) {
    const mon = await newPage(LAPTOP, 'monitor');
    await mon.goto(`${BASE}/monitor`);
    await mon.waitForSelector('#banner:not(.state-unknown)', { timeout: 20000 });
    await sleep(5000); // a few polls for the timeline
    await capture(mon, 'laptop-monitor', 'Laptop · Monitor dashboard (/monitor): status banner, agent, phones, VS Code windows, terminals, log');
    await mon.context().close();
  }
}

/* ---------------------------------------------------------------------------------- composed */

function record(file, what) {
  const bytes = fs.statSync(file).size;
  written.push({ file, what, bytes });
  console.log(`  made ${path.basename(file)} — ${(bytes / 1024).toFixed(0)} KB`);
}

/** Tray states: needs the running agent (its /status is what the tray classifies). */
async function trayImage() {
  if (!want('tray-states')) return;
  const data = await trayData({ root: ROOT, tmpDir: dirs.tmpRoot, agentBase: BASE });
  const file = path.join(OUT, 'tray-states.png');
  await renderTray(browser, data, file, optimizePng);
  record(file, 'Tray icon (TermPocket Monitor): green / amber / red / gray with their real tooltips, and the right-click menu');
}

/** Social preview + hero, composed from the shots in OUT (works with --only too, reusing older shots). */
async function composed() {
  const shot = (n) => {
    const f = path.join(OUT, `${n}.png`);
    if (!fs.existsSync(f)) throw new Error(`${f} is missing: run without --only first`);
    return dataUrl(f);
  };
  const logo = dataUrl(path.join(ROOT, 'web', 'icons', 'icon.svg'));
  if (want('logo')) {
    // The app icon (drawn by web/tools/make-icons.mjs, same artwork as icon.svg) for the README header.
    for (const [from, to] of [['icon.svg', 'logo.svg'], ['icon-512.png', 'logo-512.png']]) {
      const file = path.join(OUT, to);
      fs.copyFileSync(path.join(ROOT, 'web', 'icons', from), file);
      record(file, `TermPocket logo (copy of web/icons/${from}): ">_" prompt in a stitched pocket`);
    }
  }
  if (want('social-preview')) {
    const file = path.join(OUT, 'social-preview.png');
    await renderSocial(browser, { shots: { workbench: shot('laptop-workbench'), terminal: shot('phone-terminal') }, logo }, file, optimizePng);
    record(file, 'GitHub social preview (1280×640): name, tagline, laptop (Code workbench) + phone (live terminal)');
  }
  if (want('hero')) {
    const file = path.join(OUT, 'hero.png');
    await renderHero(browser, { shots: { workbench: shot('laptop-workbench'), terminal: shot('phone-terminal'), list: shot('phone-terminals') } }, file, optimizePng);
    record(file, 'README hero: laptop with the Code workbench between two phones (Terminals list, live terminal)');
  }
}

/* ---------------------------------------------------------------------------------- cleanup */

async function teardown() {
  try { await browser?.close(); } catch { /* ignore */ }
  try { client?.close(); } catch { /* ignore */ }
  if (COMPOSE_ONLY) { removeSandbox(dirs); return; }
  console.log(`  ${await agent.stop()}`);
  agent.close();
  const killed = await code.killLeftovers();
  if (killed) console.log(`  stopped ${killed} isolated VS Code process(es)`);
  await sleep(1000);
  if (wsState) console.log(`  ${cleanupWorkspace(wsState)}`);
  if (!KEEP_TEMP) removeSandbox(dirs);
}

let failed = null;
try {
  if (COMPOSE_ONLY) {
    browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  } else {
    await setup();
    await phoneShots();
    await laptopShots();
    await trayImage();
  }
  await composed();
} catch (err) {
  failed = err;
  console.error(`FAILED: ${err.stack || err.message}`);
} finally {
  await teardown();
}
console.log('');
for (const w of written) console.log(`${path.relative(ROOT, w.file)}  ${(w.bytes / 1024).toFixed(0)} KB  ${w.what}`);
if (problems.length) console.log(`\npage problems:\n  ${problems.join('\n  ')}`);
fs.writeFileSync(path.join(ARTIFACTS, 'screenshots-results.json'), JSON.stringify({ written, problems, failed: failed?.message ?? null }, null, 2));
process.exit(failed ? 1 : 0);
