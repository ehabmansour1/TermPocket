#!/usr/bin/env node
// TermPocket — desktop Code tab = VS Code workbench, end to end.
//
// Drives the real PWA (web/) in a local headless Google Chrome (playwright-core channel "chrome", no
// browser download, localhost only) at 1440×900 and 1920×1080 against:
//   * the real agent on a free 127.0.0.1 port, temp TERMPOCKET_HOME, TERMPOCKET_DRYRUN_INPUT=1;
//   * an isolated VS Code instance (temp profile, built-in Git enabled, this repo's extension) whose
//     workspace is a temp git repository: hello.js (tracked, then modified), broken.js (syntax errors
//     → VS Code diagnostics), README.md, sub/data.txt, untracked.txt.
//
// Covers the explorer tree (expand / collapse, file icons, keyboard), Monaco (content, highlighting,
// preview vs pinned tabs, edit → dirty → Ctrl+S on disk, save conflict dialog, VS Code diagnostics as
// squiggles), PROBLEMS (click opens at the line), TERMINAL (the window's terminals as tabs, "+",
// typing into mirrored and ordinary terminals, Ctrl+` toggles the panel), the Command Palette
// (finds "File: Save" by title, runs a VS Code command), Quick Open (opens a file, ":" go to line),
// Source Control (branch, M/U, diff editor, stage, commit → git log), explorer New File / Rename /
// Delete (on disk; delete = Recycle Bin), the status bar, the phone layout (412 px: classic Code tab)
// and live layout switching. Console errors and page errors must be zero.
//
// Usage:  node workbench.e2e.mjs [--port <n>] [--shots <dir>] [--headed] [--keep-temp]

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const HEADED = flag('--headed');
const KEEP_TEMP = flag('--keep-temp');
const SHOTS = path.resolve(option('--shots', process.env.TERMPOCKET_E2E_SHOTS || path.join(E2E_DIR, 'artifacts', 'workbench-shots')));
const ARTIFACTS = path.join(E2E_DIR, 'artifacts');
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false, colorScheme: 'dark' };

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (/^final-.*\.jpg$/.test(f)) fs.rmSync(path.join(SHOTS, f));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const PORT = Number(option('--port', 0)) || await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------------------------------------- */

const results = [];
class SkipError extends Error {}

/** Close whatever a failed step may have left open (quick input, menu, dialog) so the next starts clean. */
async function settle() {
  if (!page) return;
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => !!document.querySelector('.wbc-qi, .wb-qi, .wb-menu, .wb-dialog')).catch(() => false);
    if (!open) return;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(150);
  }
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await settle();
    const detail = await fn();
    results.push({ name, result: 'pass', ms: Date.now() - t0, detail: detail ?? '' });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const skip = err instanceof SkipError;
    results.push({ name, result: skip ? 'skip' : 'fail', ms: Date.now() - t0, detail: err.message });
    console.log(`  ${skip ? 'skip' : 'FAIL'} ${name} — ${err.message.split('\n')[0]}`);
    if (!skip) {
      try { await page?.screenshot({ path: path.join(ARTIFACTS, `workbench-fail-${results.length}.jpg`), type: 'jpeg', quality: 60 }); } catch { /* ignore */ }
    }
    return false;
  }
}

async function shot(name) {
  if (!page) return;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `final-${name}.jpg`), type: 'jpeg', quality: 70 });
}

/* ------------------------------------------------------------------------------------------- */

const dirs = createSandbox('termpocket-wb-e2e-');
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'workbench-agent.log') });
const code = new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'workbench-vscode-main.log') });
let client = null;
let wid = null;
let browser = null;
let context = null;
let page = null;
const problems = { console: [], pageErrors: [] };
const sent = []; // every JSON request the page sent {m, p}

const ws = () => dirs.workspace;
const git = (...a) => execFileSync('git', a, { cwd: ws(), encoding: 'utf8', windowsHide: true });

/** The workspace as a git repository with a modified tracked file and an untracked one; Git on in VS Code. */
function writeGitWorkspace() {
  writeWorkspace(dirs);
  const sp = path.join(dirs.userData, 'User', 'settings.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  Object.assign(st, { 'git.enabled': true, 'git.autoRepositoryDetection': true, 'git.autofetch': false, 'git.openRepositoryInParentFolders': 'always' });
  fs.writeFileSync(sp, JSON.stringify(st, null, 2));
  git('-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.invalid');
  git('config', 'user.name', 'TermPocket e2e');
  git('config', 'core.autocrlf', 'false');
  // Shells started in the workspace may drop PowerShell's module cache next to it: keep it out of git.
  fs.appendFileSync(path.join(ws(), '.git', 'info', 'exclude'), '\nMicrosoft/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  fs.writeFileSync(path.join(ws(), 'hello.js'), "function greet(name) {\n  return 'Hi ' + name;\n}\n\nmodule.exports = { greet };\n");
  fs.writeFileSync(path.join(ws(), 'untracked.txt'), 'not in git yet\n');
}

// The browser never touches the real clipboard (Copy Path etc.).
const INIT_SCRIPT = () => {
  window.__clip = { written: [] };
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => '', writeText: async (t) => { window.__clip.written.push(String(t)); } },
    });
  } catch { /* ignore */ }
};

function watch(p) {
  p.on('console', (m) => { if (m.type() === 'error') problems.console.push(m.text()); });
  p.on('pageerror', (err) => problems.pageErrors.push(err.message));
  p.on('websocket', (sock) => {
    sock.on('framesent', (f) => {
      if (typeof f.payload !== 'string' || !f.payload.startsWith('{"t":"req"')) return;
      try { const j = JSON.parse(f.payload); sent.push({ m: j.m, p: j.p, at: Date.now() }); } catch { /* ignore */ }
    });
  });
}

/* ------------------------------------------------------------------------------- page helpers */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (name) => page.locator('.wb-tree-row').filter({ has: page.locator('.wb-tree-name', { hasText: new RegExp(`^${esc(name)}$`) }) }).first();
const editorText = async () => ((await page.textContent('.wb-editor-part .monaco-editor:not(.monaco-diff-editor *) .view-lines').catch(() => '')) || '').replace(/ /g, ' ');
const tabs = () => page.$$eval('.wb-tab', (ts) => ts.map((t) => ({ label: t.querySelector('.wb-tab-name')?.textContent || t.textContent, active: t.classList.contains('active'), preview: t.classList.contains('preview'), dirty: t.classList.contains('dirty') })));
const statusText = () => page.$eval('.wb-statusbar', (e) => e.innerText.replace(/\s+/g, ' ').trim());
const termRows = () => page.$$eval('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-rows > div', (rs) => rs.map((r) => r.textContent.replace(/ /g, ' ').trim()));
const sentSince = (i, m) => sent.slice(i).filter((x) => !m || x.m === m || (x.m === 'vsc.call' && x.p && x.p.m === m));
const vsc = (m, p = {}, t) => client.vsc(wid, m, p, t);

async function qiOpen(combo, wantValue) {
  await page.keyboard.press(combo);
  await page.waitForSelector('.wbc-qi .wbc-qi-input', { timeout: 5000 });
  if (wantValue != null) await waitFor(async () => (await page.inputValue('.wbc-qi .wbc-qi-input')) === wantValue, { timeout: 3000, what: `quick input value "${wantValue}"` });
}
const qiItems = () => page.$$eval('.wbc-qi .wbc-qi-item', (rs) => rs.map((r) => ({ text: r.innerText.replace(/\s+/g, ' ').trim(), active: r.classList.contains('active') })));

async function menuClick(label) {
  await page.locator('.wb-menu .wb-menu-label', { hasText: new RegExp(`^${esc(label)}$`) }).first().click();
}

async function focusEditor() {
  await page.click('.wb-editor-part .monaco-editor .view-lines');
}

/* ------------------------------------------------------------------------------------------- */

async function main() {
  console.log(`TermPocket workbench e2e — port ${PORT}, temp ${dirs.tmpRoot}`);
  writeGitWorkspace();

  await step('start agent (temp TERMPOCKET_HOME, dry-run input)', async () => `pid ${await agent.start()}`);
  if (!agent.running) throw new Error('agent did not start');
  const token = agent.token;
  client = await PhoneClient.open(PORT, token);

  const launched = await step('launch isolated VS Code (git repo workspace, Git enabled) with the extension', async () => {
    const note = code.launch();
    const wins = await waitFor(async () => {
      const w = await client.request('vsc.windows');
      return w.length ? w : null;
    }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
    wid = wins[0].windowId;
    // The Git extension needs a moment to open the repository.
    const st = await waitFor(async () => {
      const s = await vsc('git.status').catch(() => null);
      return s && s.available && s.repos.length && s.repos[0].changes.length >= 2 ? s : null;
    }, { timeout: 60000, interval: 1000, what: 'git.status with the repository' });
    // VS Code analyses broken.js once it is open there; its diagnostics become squiggles + Problems.
    await vsc('editor.open', { path: path.join(ws(), 'broken.js') });
    await waitFor(async () => ((await vsc('diagnostics.list')) || []).some((d) => /broken\.js$/i.test(d.path) && d.severity === 'error'), { timeout: 45000, interval: 1000, what: 'diagnostics for broken.js' });
    return `${note}; window "${wins[0].name}"; branch ${st.repos[0].branch}, ${st.repos[0].changes.length} change(s)`;
  });
  if (!launched) throw new Error('VS Code did not come up; aborting');

  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  context = await browser.newContext(DESKTOP);
  await context.addInitScript(INIT_SCRIPT);
  context.setDefaultTimeout(12000);
  page = await context.newPage();
  watch(page);

  /* ------------------------------------------------------------------ shell */

  const up = await step('desktop Code tab = workbench: title bar, activity bar, side bar, editor, panel, 22px status bar', async () => {
    await page.goto(`${BASE}/#token=${encodeURIComponent(token)}`);
    await page.waitForSelector('#sideFoot[data-status="online"]', { timeout: 20000 });
    await page.click('#tab-code');
    await page.waitForSelector('.wb.visible .wb-statusbar', { timeout: 30000 });
    await row('hello.js').waitFor({ timeout: 30000 });
    // builder C's modules (search, SCM, panel views, status bar) register asynchronously
    await page.waitForSelector('.wb-act-item[data-view="scm"]', { timeout: 15000 });
    await page.waitForSelector('.wb-panel-tab[data-view="terminal"]', { timeout: 15000 });
    const geo = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
      return {
        title: b('.wb-titlebar'), act: b('.wb-activity'), side: b('.wb-sidebar'), editor: b('.wb-editor-part'), panel: b('.wb-panel'), status: b('.wb-statusbar'),
        actItems: [...document.querySelectorAll('.wb-act-item[data-view]')].map((e) => e.dataset.view),
        panelTabs: [...document.querySelectorAll('.wb-panel-tab')].map((e) => e.textContent.trim()),
        cc: document.querySelector('.wb-cc')?.textContent.trim(),
        win: document.querySelector('.wb-tb-window')?.textContent.trim(),
        font: getComputedStyle(document.querySelector('.wb')).fontFamily,
      };
    });
    assert(geo.title.h === 35 && geo.status.h === 22 && geo.act.w === 48, `bars ${JSON.stringify({ t: geo.title, s: geo.status, a: geo.act })}`);
    assert(geo.act.right <= geo.side.x + 1 && geo.side.right <= geo.editor.x + 2, `columns ${JSON.stringify(geo)}`);
    for (const v of ['explorer', 'search', 'scm']) assert(geo.actItems.includes(v), `activity bar lacks ${v}: ${geo.actItems}`);
    assert(geo.panelTabs.some((t) => /^Problems/i.test(t)) && geo.panelTabs.some((t) => /^Terminal/i.test(t)), `panel tabs ${geo.panelTabs}`);
    assert(/workspace/.test(geo.cc) && /workspace/.test(geo.win), `command center "${geo.cc}", window switcher "${geo.win}"`);
    assert(/Segoe/.test(geo.font), `UI font ${geo.font}`);
    return `activity ${geo.actItems.join('/')}; panel ${geo.panelTabs.join('/')}; command center "${geo.cc}"`;
  });
  if (!up) throw new Error('workbench did not come up; aborting');

  /* --------------------------------------------------------------- explorer */

  await step('Explorer: tree with Seti-style icons, folder expand / collapse (click + keyboard), git decorations', async () => {
    const icons = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.wb-explorer .wb-tree-row')].map((r) => {
      const fi = r.querySelector('.wb-fi');
      return [r.querySelector('.wb-tree-name')?.textContent, fi ? `${fi.className}|${fi.style.color || getComputedStyle(fi).color}` : ''];
    })));
    assert(/k-js/.test(icons['hello.js']) && /k-(md|markdown)/.test(icons['README.md']) && /\bdir\b/.test(icons.sub), `file icons ${JSON.stringify(icons)}`);
    assert(icons['hello.js'].split('|')[1] !== icons['README.md'].split('|')[1], 'js and md icons have the same colour');
    await row('sub').click();
    await row('data.txt').waitFor({ timeout: 10000 });
    assert(await page.$('.wb-explorer .wb-fi.dir.open'), 'expanded folder shows the open-folder icon');
    // keyboard: ← collapses the focused folder, → expands it again
    await page.keyboard.press('ArrowLeft');
    await row('data.txt').waitFor({ state: 'detached', timeout: 5000 });
    await page.keyboard.press('ArrowRight');
    await row('data.txt').waitFor({ timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    const focused = await page.$eval('.wb-explorer .wb-tree-row.focused .wb-tree-name', (e) => e.textContent).catch(() => '');
    assert(focused === 'data.txt', `↓ focused "${focused}"`);
    await row('sub').click();
    await row('data.txt').waitFor({ state: 'detached', timeout: 5000 });
    const decoOf = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.wb-explorer .wb-tree-row')].map((r) => [r.querySelector('.wb-tree-name')?.textContent, r.innerText.replace(/\s+/g, ' ').trim()])));
    await waitFor(async () => { const d = await decoOf(); return / M$/.test(d['hello.js']) && / U$/.test(d['untracked.txt']); }, { timeout: 15000, what: 'git decorations M / U' })
      .catch(async (err) => { throw new Error(`${err.message}: ${JSON.stringify(await decoOf())}`); });
    await shot('explorer-1440');
    return `icons ok; sub expand/collapse; hello.js M, untracked.txt U`;
  });

  /* ------------------------------------------------------------------ editor */

  await step('Monaco: single click = preview tab (italic, replaced), double click = pinned; syntax highlighting', async () => {
    await row('hello.js').click();
    await waitFor(async () => /greet/.test(await editorText()), { timeout: 45000, what: 'hello.js in Monaco' });
    let t = await tabs();
    assert(t.length === 1 && t[0].preview, `tabs ${JSON.stringify(t)}`);
    await row('README.md').click();
    await waitFor(async () => /PWA e2e workspace/.test(await editorText()), { what: 'README replaces the preview' });
    t = await tabs();
    assert(t.length === 1 && /README/.test(t[0].label) && t[0].preview, `preview replaced: ${JSON.stringify(t)}`);
    const italic = await page.$eval('.wb-tab.preview', (e) => getComputedStyle(e.querySelector('.wb-tab-name') || e).fontStyle);
    assert(italic === 'italic', `preview tab font-style ${italic}`);
    await row('hello.js').dblclick();
    await waitFor(async () => (await tabs()).some((x) => /hello\.js/.test(x.label) && !x.preview), { what: 'hello.js pinned' });
    t = await tabs();
    assert(!t.some((x) => /README/.test(x.label)), `README preview should be replaced by hello.js: ${JSON.stringify(t)}`);
    // Monaco tokenizes once the JavaScript grammar (a lazily loaded chunk) is there.
    const tokenColours = () => page.$$eval('.wb-editor-part .monaco-editor .view-lines span span', (ss) => [...new Set(ss.map((s) => getComputedStyle(s).color))]);
    const colors = await waitFor(async () => { const c = await tokenColours(); return c.length >= 4 ? c : null; }, { timeout: 10000, what: '≥ 4 token colours' })
      .catch(async (err) => { throw new Error(`${err.message}: ${await tokenColours()}`); });
    const kw = await page.evaluate(() => {
      const s = [...document.querySelectorAll('.wb-editor-part .monaco-editor .view-lines span span')].find((e) => e.textContent === 'function');
      return s ? getComputedStyle(s).color : '';
    });
    assert(kw === 'rgb(86, 156, 214)', `"function" colour ${kw} (Dark Modern keyword #569cd6)`);
    const ed = await page.evaluate(() => ({
      font: getComputedStyle(document.querySelector('.wb-editor-part .monaco-editor .view-lines')).fontFamily,
      size: getComputedStyle(document.querySelector('.wb-editor-part .monaco-editor .view-lines')).fontSize,
      bg: getComputedStyle(document.querySelector('.wb-editor-part .monaco-editor .monaco-editor-background')).backgroundColor,
      minimap: !!document.querySelector('.wb-editor-part .monaco-editor .minimap canvas'),
    }));
    assert(/Consolas|Cascadia/i.test(ed.font) && ed.size === '14px' && ed.bg === 'rgb(31, 31, 31)' && ed.minimap, `editor ${JSON.stringify(ed)}`);
    return `${colors.length} token colours, keyword #569cd6, ${ed.size} ${ed.font.split(',')[0]}, minimap`;
  });

  await step('Monaco: edit → dirty dot → Ctrl+S writes the file; changed on disk → conflict dialog', async () => {
    await row('README.md').dblclick();
    await waitFor(async () => /PWA e2e workspace/.test(await editorText()), { what: 'README pinned' });
    await focusEditor();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('# Workbench e2e');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Saved from Monaco.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wb-tab.active.dirty');
    await page.keyboard.press('Control+s');
    const want = '# Workbench e2e\nSaved from Monaco.\n';
    await waitFor(() => fs.readFileSync(path.join(ws(), 'README.md'), 'utf8') === want, { timeout: 10000, what: 'README.md on disk' });
    await page.waitForSelector('.wb-tab.active:not(.dirty)');
    // Conflict: the file changes on the PC while edited here.
    await page.keyboard.type('local edit ');
    await page.waitForSelector('.wb-tab.active.dirty');
    fs.writeFileSync(path.join(ws(), 'README.md'), 'changed on the PC\n');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.wb-dialog', { timeout: 8000 });
    const msg = await page.$eval('.wb-dialog', (e) => e.innerText);
    assert(/newer|changed on the PC/i.test(msg), `dialog "${msg}"`);
    await shot('save-conflict');
    await page.locator('.wb-dialog button', { hasText: /^Cancel$/ }).click();
    assert(fs.readFileSync(path.join(ws(), 'README.md'), 'utf8') === 'changed on the PC\n', 'Cancel still overwrote the file');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.wb-dialog', { timeout: 8000 });
    await page.locator('.wb-dialog button', { hasText: /^Overwrite$/ }).click();
    await waitFor(() => /Saved from Monaco\.\nlocal edit $/.test(fs.readFileSync(path.join(ws(), 'README.md'), 'utf8')), { timeout: 10000, what: 'overwrite on disk' });
    await page.waitForSelector('.wb-tab.active:not(.dirty)');
    return 'saved; conflict → Cancel kept the PC version, Overwrite wrote ours';
  });

  await step('Diagnostics: VS Code errors as Monaco squiggles; PROBLEMS grouped by file; click opens at line', async () => {
    await row('broken.js').dblclick();
    const n = await waitFor(async () => {
      const c = await page.$$eval('.wb-editor-part .monaco-editor .squiggly-error', (els) => els.length);
      return c > 0 ? c : null;
    }, { timeout: 30000, interval: 500, what: 'VS Code errors as squiggles' });
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('.wbc-problems .wbc-prob-file', { timeout: 10000 });
    const file = await page.$eval('.wbc-problems .wbc-prob-file', (e) => e.innerText.replace(/\s+/g, ' ').trim());
    assert(/broken\.js/.test(file) && /\d/.test(file), `problems file row "${file}"`);
    const markers = await page.$$eval('.wbc-problems .wbc-prob-marker', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    assert(markers.length >= 2, `markers ${JSON.stringify(markers)}`);
    // open hello.js so the click has to switch editors
    await row('hello.js').click();
    await waitFor(async () => /greet/.test(await editorText()), { what: 'hello.js active' });
    const target = page.locator('.wbc-problems .wbc-prob-marker', { hasText: /Ln 3/ }).first();
    await target.click();
    await waitFor(async () => (await tabs()).some((x) => /broken\.js/.test(x.label) && x.active), { what: 'broken.js active after the problem click' });
    await waitFor(async () => /Ln 3, Col \d+/.test(await statusText()), { what: 'cursor on line 3' });
    await shot('problems');
    return `${n} squiggle(s); ${markers.length} marker rows; click → broken.js Ln 3`;
  });

  /* ---------------------------------------------------------------- terminal */

  await step('TERMINAL: the window\'s terminals as tabs; "+" creates a mirrored one; typing works', async () => {
    // A terminal VS Code already has before the panel opens.
    await vsc('terminals.create', { name: 'pre-existing', mirror: true });
    await page.click('.wb-panel-tab[data-view="terminal"]');
    await page.waitForSelector('.wbc-term-tab', { timeout: 20000 });
    const before = await page.$$eval('.wbc-term-tab', (rs) => rs.length);
    const list0 = await vsc('terminals.list');
    assert(before === list0.length, `${before} tab(s) for ${list0.length} terminal(s)`);
    await page.click('.wbc-term-actions [title^="New Terminal"]');
    await waitFor(async () => (await page.$$('.wbc-term-tab')).length === before + 1, { timeout: 20000, what: 'new terminal tab' });
    const list1 = await vsc('terminals.list');
    const created = list1.find((t) => !list0.some((o) => o.tid === t.tid));
    assert(created && created.isMirror && created.ptyId, `created ${JSON.stringify(created)}`);
    await page.waitForSelector('.wbc-term-tab.active-term');
    await waitFor(async () => (await termRows()).some((l) => /^PS .+>/.test(l)), { timeout: 30000, what: 'PowerShell prompt' });
    await page.click('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-screen');
    await page.keyboard.type("echo ('mirror' + '-ok')");
    await page.keyboard.press('Enter');
    await waitFor(async () => (await termRows()).some((l) => l === 'mirror-ok'), { timeout: 15000, what: '"mirror-ok" in the terminal' });
    // created here → fitted to the panel (cols follow the panel width)
    const pty = await waitFor(async () => {
      const s = (await client.request('pty.list')).find((x) => x.id === created.ptyId);
      const shown = await page.$$eval('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-rows > div', (rs) => rs.length);
      const fill = await page.evaluate(() => {
        const p = document.querySelector('.wbc-term-main .wbc-term-pane:not([hidden])');
        return p.querySelector('.xterm-screen').getBoundingClientRect().width / p.getBoundingClientRect().width;
      });
      return s && s.rows === shown && fill > 0.9 ? { ...s, fill } : null;
    }, { timeout: 8000, what: 'PTY fitted to the panel' });
    await shot('terminal');
    return `${before} → ${before + 1} tabs; mirrored ${created.ptyId} ${pty.cols}×${pty.rows} fills ${Math.round(pty.fill * 100)}% of the pane; typed + echoed`;
  });

  await step('TERMINAL: ordinary VS Code terminal in the Live view takes input; trash kills it (terminals.dispose)', async () => {
    const r = await vsc('terminals.create', { name: 'ordinary-e2e', mirror: false });
    const tabLoc = page.locator('.wbc-term-tab', { hasText: 'ordinary-e2e' });
    await tabLoc.waitFor({ timeout: 20000 });
    // shell integration needs a moment in a fresh PowerShell
    await waitFor(async () => ((await vsc('terminals.list')).find((t) => t.tid === r.tid) || {}).hasShellIntegration, { timeout: 30000, interval: 500, what: 'shell integration' }).catch(() => {});
    await tabLoc.click();
    await page.waitForSelector('.wbc-term-tab.active-term >> text=ordinary-e2e');
    await sleep(1500);
    const mark = sent.length;
    await page.click('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-screen');
    await page.keyboard.type("echo ('ordinary' + '-ok')");
    await page.keyboard.press('Enter');
    await waitFor(() => sentSince(mark, 'terminals.input').length > 0, { timeout: 5000, what: 'terminals.input sent' });
    await waitFor(async () => (await termRows()).some((l) => /ordinary-ok$/.test(l) && !/echo/.test(l)), { timeout: 20000, what: '"ordinary-ok" output in the Live view' });
    await tabLoc.hover();
    await tabLoc.locator('[title="Kill Terminal"]').click();
    await waitFor(async () => !(await vsc('terminals.list')).some((t) => t.tid === r.tid), { timeout: 15000, what: 'terminal disposed in VS Code' });
    await tabLoc.waitFor({ state: 'detached', timeout: 10000 });
    return 'Live view input → output; trash → terminals.dispose';
  });

  await step('Ctrl+` toggles the panel (terminal focused → hidden, again → shown)', async () => {
    await page.click('.wbc-term-main .wbc-term-pane:not([hidden]) .xterm-screen');
    await page.keyboard.press('Control+Backquote');
    await waitFor(async () => page.evaluate(() => document.querySelector('.wb').classList.contains('no-panel')), { timeout: 4000, what: 'panel hidden' });
    await page.keyboard.press('Control+Backquote');
    await waitFor(async () => page.evaluate(() => !document.querySelector('.wb').classList.contains('no-panel') && !!document.querySelector('.wb-panel-tab.checked[data-view="terminal"]')), { timeout: 4000, what: 'panel shown with TERMINAL' });
    return 'hidden + shown';
  });

  /* ----------------------------------------------------------------- palette */

  await step('Command Palette (Ctrl+Shift+P): "File: Save" by title with keybinding; Enter runs a VS Code command', async () => {
    await row('hello.js').click();
    await focusEditor();
    await qiOpen('Control+Shift+P', '>');
    await page.keyboard.type('file: save');
    await waitFor(async () => (await qiItems()).some((i) => /^File: Save\b/.test(i.text)), { timeout: 20000, what: '"File: Save" listed' });
    const items = await qiItems();
    const first = items[0];
    assert(/^File: Save/.test(first.text) && /Ctrl\s*\+\s*S$/.test(first.text), `first item "${first.text}"`);
    assert(await page.$('.wbc-qi .wbc-qi-item.active .hl, .wbc-qi .wbc-qi-item.active .wbc-hl, .wbc-qi .wbc-qi-item.active b'), 'no highlighted match');
    await shot('palette');
    // Run a real VS Code command: a new untitled editor appears in VS Code's tabs.
    await page.fill('.wbc-qi .wbc-qi-input', '>new untitled text file');
    await waitFor(async () => (await qiItems()).some((i) => /New Untitled Text File/i.test(i.text)), { timeout: 15000, what: '"New Untitled Text File" listed' });
    const idx = (await qiItems()).findIndex((i) => /New Untitled Text File/i.test(i.text));
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
    const mark = sent.length;
    await page.keyboard.press('Enter');
    await waitFor(() => sentSince(mark, 'commands.run').some((x) => x.p.p && /newUntitledFile/i.test(x.p.p.command)), { timeout: 5000, what: 'commands.run sent' });
    await waitFor(async () => ((await vsc('editor.tabs')) || []).some((t) => /^Untitled/i.test(t.label || t.name || '') || /untitled/i.test(t.path || t.uri || '')), { timeout: 10000, what: 'untitled editor in VS Code' });
    // and it is listed under "recently used" next time
    await qiOpen('Control+Shift+P', '>');
    const recent = await qiItems();
    assert(/New Untitled Text File/i.test(recent[0].text), `recently used on top: "${recent[0] && recent[0].text}"`);
    await page.keyboard.press('Escape');
    await vsc('commands.run', { command: 'workbench.action.revertAndCloseActiveEditor' }).catch(() => {});
    return `"${first.text}"; ran workbench.action.files.newUntitledFile in VS Code; recently used on top`;
  });

  await step('Quick Open (Ctrl+P) opens a file; ":" goes to a line', async () => {
    await focusEditor();
    await qiOpen('Control+p', '');
    await page.keyboard.type('data');
    await waitFor(async () => (await qiItems()).some((i) => /data\.txt/.test(i.text)), { timeout: 15000, what: 'data.txt found' });
    await page.keyboard.press('Enter');
    await waitFor(async () => (await tabs()).some((x) => /data\.txt/.test(x.label) && x.active && !x.preview), { what: 'data.txt opened' });
    await waitFor(async () => /line two/.test(await editorText()), { what: 'data.txt content' });
    await qiOpen('Control+g', ':');
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await waitFor(async () => /Ln 2, Col 1/.test(await statusText()), { what: 'Ln 2 after :2' });
    const st = await statusText();
    assert(/CRLF/.test(st) && /Plain Text/.test(st), `status for data.txt "${st}"`);
    return `data.txt (CRLF, Plain Text) → Ln 2`;
  });

  /* --------------------------------------------------------------------- SCM */

  await step('Source Control: branch, Changes with M / U, diff editor vs HEAD, stage → Staged Changes, commit (git log)', async () => {
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('.wbc-scm .scm-file', { timeout: 15000 });
    const srow = (name) => page.locator('.wbc-scm .scm-file').filter({ hasText: name }).first();
    const files = await page.$$eval('.wbc-scm .scm-file', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    assert(files.some((f) => /hello\.js M$/.test(f)) && files.some((f) => /untracked\.txt U$/.test(f)), `changes ${JSON.stringify(files)}`);
    const letters = await page.$$eval('.wbc-scm .scm-file .wbc-deco', (ds) => Object.fromEntries(ds.map((d) => [d.textContent, getComputedStyle(d).color])));
    assert(letters.M && letters.U && letters.M !== letters.U, `status letter colours ${JSON.stringify(letters)}`);
    const st = await statusText();
    assert(/main/.test(st), `status bar branch "${st}"`);
    await srow('hello.js').click();
    await page.waitForSelector('.wb-editor-part .monaco-diff-editor', { timeout: 20000 });
    await waitFor(async () => page.evaluate(() => {
      const t = document.querySelector('.wb-editor-part .monaco-diff-editor')?.innerText.replace(/ /g, ' ') || '';
      return /'Hello '/.test(t) && /'Hi '/.test(t);
    }), { timeout: 15000, what: 'diff shows old and new line' });
    await shot('scm-diff');
    await srow('hello.js').hover();
    await srow('hello.js').locator('[title="Stage Changes"]').click();
    await waitFor(async () => page.evaluate(() => /Staged Changes/.test(document.querySelector('.wbc-scm').innerText)), { timeout: 15000, what: 'Staged Changes group' });
    const staged = await vsc('git.status');
    assert(staged.repos[0].changes.some((c) => /hello\.js$/.test(c.path) && c.staged), `git.status after stage ${JSON.stringify(staged.repos[0].changes)}`);
    await page.click('textarea.wbc-scm-input');
    await page.keyboard.type('Commit from the TermPocket workbench');
    await page.keyboard.press('Control+Enter');
    await waitFor(() => /Commit from the TermPocket workbench/.test(git('log', '-1', '--pretty=%s')), { timeout: 20000, what: 'commit in git log' });
    await waitFor(async () => page.evaluate(() => !/Staged Changes/.test(document.querySelector('.wbc-scm').innerText)), { timeout: 15000, what: 'staged list empties' });
    // git.changed can arrive before git.commit answers (VS Code's post-commit work): the box is
    // cleared when the answer comes.
    await waitFor(async () => (await page.inputValue('textarea.wbc-scm-input')) === '', { timeout: 30000, what: 'message box cleared once git.commit answered' });
    return `M/U listed; diff; staged; commit ${git('log', '-1', '--pretty=%h').trim()}`;
  });

  await step('Source Control: Commit with nothing staged → "stage all" = tracked changes only; untracked files stay out', async () => {
    // README.md (tracked) was modified by the Monaco step; untracked.txt is still untracked.
    const before = git('status', '--porcelain');
    assert(/^ M README\.md$/m.test(before) && /^\?\? untracked\.txt$/m.test(before), `git status before ${JSON.stringify(before)}`);
    await page.keyboard.press('Control+Shift+G');
    await waitFor(async () => page.evaluate(() => {
      const t = document.querySelector('.wbc-scm')?.innerText || '';
      return /README\.md/.test(t) && !/Staged Changes/.test(t);
    }), { timeout: 15000, what: 'README.md listed, nothing staged' });
    await page.click('textarea.wbc-scm-input');
    await page.keyboard.type('Commit tracked changes from the workbench');
    const typed = await page.inputValue('textarea.wbc-scm-input');
    // The previous commit's late answer must not wipe a message typed since (it used to clear the box).
    await sleep(1500);
    assert((await page.inputValue('textarea.wbc-scm-input')) === 'Commit tracked changes from the workbench', `commit message box changed while typing: "${typed}"`);
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.wb-dialog', { timeout: 8000 });
    const msg = await page.$eval('.wb-dialog', (e) => e.innerText);
    assert(/no staged changes/i.test(msg), `smart commit dialog "${msg}"`);
    await page.locator('.wb-dialog button', { hasText: /^Yes$/ }).click();
    try {
      await waitFor(() => /Commit tracked changes from the workbench/.test(git('log', '-1', '--pretty=%s')), { timeout: 20000, what: 'commit in git log' });
    } catch (err) {
      throw new Error(`${err.message}; git log: ${JSON.stringify(git('log', '-3', '--pretty=%h %s'))}; status: ${JSON.stringify(git('status', '--porcelain'))}; ui: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.wb-notification, .wbc-toast, .toast')].map((e) => e.innerText).join(' | ')))}`);
    }
    const files = git('show', '--name-only', '--pretty=format:', 'HEAD').split(/\r?\n/).filter(Boolean);
    assert(files.includes('README.md') && !files.includes('untracked.txt'), `committed files ${JSON.stringify(files)}`);
    assert(/^\?\? untracked\.txt$/m.test(git('status', '--porcelain')), 'untracked.txt must stay untracked');
    return `committed ${JSON.stringify(files)}; untracked.txt still untracked`;
  });

  /* ------------------------------------------------------------- file ops */

  await step('Explorer context menu: New File, Rename (F2 flow), Delete → Recycle Bin (checked on disk)', async () => {
    await page.keyboard.press('Control+Shift+E');
    await row('README.md').waitFor();
    await row('README.md').click({ button: 'right' });
    await page.waitForSelector('.wb-menu');
    const labels = await page.$$eval('.wb-menu .wb-menu-label', (ls) => ls.map((l) => l.textContent));
    for (const l of ['New File...', 'New Folder...', 'Rename...', 'Delete', 'Copy Path']) assert(labels.includes(l), `context menu lacks "${l}": ${labels}`);
    await shot('context-menu');
    await menuClick('New File...');
    await page.waitForSelector('.wb-inline-input, .wb-tree-row.editing input');
    await page.keyboard.type('made-in-e2e.txt');
    await page.keyboard.press('Enter');
    await waitFor(() => fs.existsSync(path.join(ws(), 'made-in-e2e.txt')), { timeout: 10000, what: 'new file on disk' });
    await row('made-in-e2e.txt').waitFor({ timeout: 10000 });
    await row('made-in-e2e.txt').click({ button: 'right' });
    await menuClick('Rename...');
    await page.waitForSelector('.wb-inline-input, .wb-tree-row.editing input');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('renamed-in-e2e.txt');
    await page.keyboard.press('Enter');
    await waitFor(() => fs.existsSync(path.join(ws(), 'renamed-in-e2e.txt')) && !fs.existsSync(path.join(ws(), 'made-in-e2e.txt')), { timeout: 10000, what: 'renamed on disk' });
    await row('renamed-in-e2e.txt').waitFor({ timeout: 10000 });
    // Copy Path goes to the (stubbed) clipboard
    await row('renamed-in-e2e.txt').click({ button: 'right' });
    await menuClick('Copy Path');
    await waitFor(async () => (await page.evaluate(() => window.__clip.written)).some((t) => /renamed-in-e2e\.txt$/.test(t)), { timeout: 4000, what: 'path on the clipboard stub' });
    await row('renamed-in-e2e.txt').click({ button: 'right' });
    await menuClick('Delete');
    await page.waitForSelector('.wb-dialog');
    const msg = await page.$eval('.wb-dialog', (e) => e.innerText);
    assert(/Recycle Bin/i.test(msg), `delete dialog "${msg}"`);
    const mark = sent.length;
    await page.locator('.wb-dialog button', { hasText: /Recycle Bin/ }).click();
    await waitFor(() => !fs.existsSync(path.join(ws(), 'renamed-in-e2e.txt')), { timeout: 10000, what: 'file gone' });
    const del = sentSince(mark, 'fs.delete').find((x) => x.p.m === 'fs.delete');
    assert(del && del.p.p.useTrash !== false, `fs.delete ${JSON.stringify(del && del.p)}`);
    await row('renamed-in-e2e.txt').waitFor({ state: 'detached', timeout: 10000 });
    return `new → rename → copy path → delete (useTrash ${del.p.p.useTrash ?? 'default true'})`;
  });

  await step('Explorer Delete of a file with unsaved edits here warns about them; New File never empties an existing file', async () => {
    fs.writeFileSync(path.join(ws(), 'dirty-del.txt'), 'keep me\n');
    await page.keyboard.press('Control+Shift+E');
    await page.click('.wb-explorer [aria-label="Refresh Explorer"]');
    await row('dirty-del.txt').waitFor({ timeout: 10000 });
    await row('dirty-del.txt').dblclick();
    await waitFor(async () => /keep me/.test(await editorText()), { timeout: 15000, what: 'dirty-del.txt in Monaco' });
    await focusEditor();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('unsaved here');
    await page.waitForSelector('.wb-tab.active.dirty');
    await row('dirty-del.txt').click({ button: 'right' });
    await menuClick('Delete');
    await page.waitForSelector('.wb-dialog');
    const msg = await page.$eval('.wb-dialog', (e) => e.innerText);
    assert(/unsaved changes/i.test(msg), `delete dialog must mention the unsaved changes: "${msg}"`);
    await page.locator('.wb-dialog button', { hasText: /^Cancel$/ }).click();
    assert(fs.existsSync(path.join(ws(), 'dirty-del.txt')), 'Cancel deleted the file');
    assert((await tabs()).some((t) => /dirty-del\.txt/.test(t.label) && t.dirty), 'Cancel must keep the dirty tab');
    await row('dirty-del.txt').click({ button: 'right' });
    await menuClick('Delete');
    await page.waitForSelector('.wb-dialog');
    await page.locator('.wb-dialog button', { hasText: /Recycle Bin/ }).click();
    await waitFor(() => !fs.existsSync(path.join(ws(), 'dirty-del.txt')), { timeout: 10000, what: 'file gone' });
    await waitFor(async () => !(await tabs()).some((t) => /dirty-del\.txt/.test(t.label)), { timeout: 5000, what: 'its tab closed' });
    // New File on a name that exists on disk but is not in the (stale) tree: refused, file untouched.
    fs.writeFileSync(path.join(ws(), 'sub', 'exists-already.txt'), 'precious\n');
    await row('sub').click({ button: 'right' });
    await menuClick('New File...');
    await page.waitForSelector('.wb-inline-input, .wb-tree-row.editing input');
    await page.keyboard.type('exists-already.txt');
    await page.keyboard.press('Enter');
    await sleep(1500);
    assert(fs.readFileSync(path.join(ws(), 'sub', 'exists-already.txt'), 'utf8') === 'precious\n', 'New File emptied an existing file');
    await settle();
    return 'unsaved-changes warning; Cancel keeps file + tab; delete closes the tab; New File refuses an existing name';
  });

  /* ------------------------------------------------------------ status bar */

  await step('Status bar: TermPocket · branch · problems; Ln/Col · indentation · encoding · EOL · language · bell', async () => {
    await row('hello.js').click();
    await waitFor(async () => /JavaScript/.test(await statusText()), { what: 'language in the status bar' });
    const items = await page.$$eval('.wb-statusbar .wb-status-item:not([hidden])', (es) => es.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    const s = items.join(' | ');
    assert(/TermPocket/.test(s) && /main/.test(s) && /Ln \d+, Col \d+/.test(s) && /Spaces: 2/.test(s) && /UTF-8/.test(s) && /\bLF\b/.test(s) && /JavaScript/.test(s), `status items ${s}`);
    const diag = await vsc('diagnostics.list');
    const errs = diag.filter((d) => d.severity === 'error').length;
    assert(items.some((t) => new RegExp(`^${errs}\\s+\\d+$`).test(t.replace(/[^\d\s]/g, '').trim())), `problem counts (${errs} errors) in ${s}`);
    const colors = await page.evaluate(() => ({
      bar: getComputedStyle(document.querySelector('.wb-statusbar')).backgroundColor,
      remote: getComputedStyle(document.querySelector('.wb-status-item.kind-remote')).backgroundColor,
    }));
    assert(colors.bar === 'rgb(24, 24, 24)' && colors.remote === 'rgb(0, 120, 212)', `status colours ${JSON.stringify(colors)}`);
    // problems item → PROBLEMS panel
    await page.click('#tab-code');
    await page.locator('.wb-statusbar .wb-status-item', { hasText: new RegExp(`^\\D*${errs}\\D+\\d+\\D*$`) }).first().click();
    await waitFor(async () => page.evaluate(() => !!document.querySelector('.wb-panel-tab.checked[data-view="problems"]')), { timeout: 4000, what: 'problems panel from the status bar' });
    return s;
  });

  /* ------------------------------------------------------------------ sizes */

  await step('1920×1080: no page overflow, workbench fills the space (screenshot)', async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await sleep(600);
    await page.click('.wb-panel-tab[data-view="terminal"]');
    await sleep(800);
    const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, vh: document.documentElement.clientHeight, wb: document.querySelector('.wb').getBoundingClientRect().width }));
    assert(ov.sw <= ov.vw && ov.sh <= ov.vh && ov.wb > 1600, `overflow ${JSON.stringify(ov)}`);
    await shot('workbench-1920');
    await page.setViewportSize(DESKTOP.viewport);
    await sleep(600);
    await shot('workbench-1440');
    return `workbench ${Math.round(ov.wb)}px wide`;
  });

  await step('Phone layout (412 px): classic Code tab unchanged (no Monaco); live switch back restores the workbench', async () => {
    try {
      await page.setViewportSize({ width: 412, height: 915 });
      await waitFor(async () => page.evaluate(() => !document.documentElement.classList.contains('desk')), { timeout: 4000, what: 'phone layout' });
      await sleep(800);
      const r = await page.evaluate(() => ({
        wbShown: !!document.querySelector('.wb') && document.querySelector('.wb').getBoundingClientRect().width > 0,
        seg: [...document.querySelectorAll('#panel-code .seg-btn, #panel-code [role=tab]')].map((e) => e.textContent.trim()).filter(Boolean),
        list: document.querySelector('#panel-code .file-list')?.innerText || '',
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      assert(!r.wbShown, 'workbench still visible on the phone layout');
      assert(r.seg.some((s) => /Files/.test(s)) && r.seg.some((s) => /Cmds/.test(s)), `phone segments ${JSON.stringify(r.seg)}`);
      await waitFor(async () => /hello\.js/.test(await page.evaluate(() => document.querySelector('#panel-code .file-list')?.innerText || '')), { timeout: 15000, what: 'phone file list' });
      assert(!r.overflow, 'phone layout overflows horizontally');
      await page.locator('#panel-code button', { hasText: /^\s*Cmds/ }).first().click();
      await waitFor(async () => page.evaluate(() => /\d+\+? commands/i.test(document.querySelector('#panel-code').innerText) && !/Loading commands/.test(document.querySelector('#panel-code').innerText)), { timeout: 20000, what: 'phone commands list loaded' });
      await shot('phone-412');
      await page.locator('#panel-code button', { hasText: /^\s*Files/ }).first().click();
      await page.setViewportSize(DESKTOP.viewport);
      await waitFor(async () => page.evaluate(() => document.documentElement.classList.contains('desk') && !!document.querySelector('.wb.visible')), { timeout: 6000, what: 'workbench back' });
      await row('hello.js').waitFor({ timeout: 10000 });
      assert((await tabs()).length >= 2, 'editor tabs lost across the layout switch');
      return 'phone: segments + file list + commands; desktop: workbench + tabs restored';
    } finally {
      await page.setViewportSize(DESKTOP.viewport).catch(() => {});
    }
  });

  await step('Reload keeps the window\'s editor tabs (restored per window)', async () => {
    const before = (await tabs()).map((t) => t.label).sort();
    await page.reload();
    await page.waitForSelector('#sideFoot[data-status="online"]', { timeout: 20000 });
    await page.click('#tab-code');
    await page.waitForSelector('.wb.visible .wb-tab', { timeout: 30000 });
    await waitFor(async () => JSON.stringify((await tabs()).map((t) => t.label).sort()) === JSON.stringify(before), { timeout: 15000, what: `tabs ${before}` });
    return before.join(', ');
  });

  await step('No console errors or uncaught page errors', async () => {
    assert(!problems.console.length && !problems.pageErrors.length,
      `console: ${JSON.stringify(problems.console.slice(0, 6))}; page: ${JSON.stringify(problems.pageErrors.slice(0, 6))}`);
  });
}

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
fs.writeFileSync(path.join(ARTIFACTS, 'workbench-results.json'), JSON.stringify({
  at: new Date().toISOString(), port: PORT, pass, fail, skip, shots: SHOTS, problems, results,
}, null, 2));
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped${fatal ? ' (fatal error)' : ''}; screenshots in ${SHOTS}`);
process.exit(fail ? 1 : 0);
