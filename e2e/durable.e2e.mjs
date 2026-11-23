#!/usr/bin/env node
// TermPocket — durable terminals and "load it exactly as running" (PROTOCOL §4.1 durable sessions,
// §5.2 terminals.snapshot, §5.2.1 attach `snapshot`, §5.3 mirror.rebind). Protocol level only: no browser.
//
// Everything runs on this machine, localhost only:
//   * the real agent on 127.0.0.1:<free port> in a temp TERMPOCKET_HOME with TERMPOCKET_DRYRUN_INPUT=1 and
//     its OWN PTY host pipe (never the user's real terminals host),
//   * ONE isolated VS Code (temp --user-data-dir / --extensions-dir / USERPROFILE, the extension from
//     ../vscode-extension), its windows kept off-screen and un-activated by the harness.
//
// Checks:
//   1. the agent starts a separate PTY host process (/status ptyHost);
//   2. an ordinary VS Code terminal WITHOUT shell integration (Command Prompt) that printed output BEFORE
//      anyone attached: terminals.attach carries a `snapshot` with that output (capturing:false), and
//      terminals.snapshot works on its own; the clipboard text is the same afterwards;
//   3. an ordinary PowerShell terminal: output from before the attach is in snapshot / buffer;
//   4. a mirrored terminal survives an agent restart: same id, same host pid, scrollback kept, input
//      works, and the VS Code window re-binds it (mirror.rebind) so its terminal shows old + new output.
//
// The snapshot briefly uses the Windows clipboard (select all → copy → restore the text). When the
// clipboard holds something other than text (an image, files), steps 2–4's snapshot parts are skipped
// so nothing of the user's is lost.
//
// Usage: node durable.e2e.mjs [--port <n>] [--keep-temp]

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
fs.mkdirSync(ARTIFACTS, { recursive: true });

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
const dirs = createSandbox('termpocket-durable-e2e-');
const agent = new AgentProcess({ home: dirs.home, port: PORT, logFile: path.join(ARTIFACTS, 'durable-agent.log') });
const code = new IsolatedVsCode(dirs, { port: PORT, logFile: path.join(ARTIFACTS, 'durable-vscode.log') });
const results = [];
let client = null;
let windowId = null;
const tag = Math.random().toString(36).slice(2, 8);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ name, result: detail === 'SKIP' ? 'skip' : 'pass', ms, detail: detail || '' });
    console.log(`  ${detail === 'SKIP' ? 'SKIP' : 'ok  '} ${name} (${ms} ms)${detail && detail !== 'SKIP' ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    results.push({ name, result: 'fail', ms, detail: err.stack || err.message });
    console.log(`  FAIL ${name} (${ms} ms) — ${err.message}`);
    return false;
  }
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
    return true; // unknown → be careful
  }
}

async function terminalsList() {
  return client.vsc(windowId, 'terminals.list');
}

async function main() {
  console.log(`TermPocket durable-terminals e2e — port ${PORT}, temp ${dirs.tmpRoot}`);
  writeWorkspace(dirs);

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

  const up = await step('launch ONE isolated VS Code (off-screen) and wait for its window', async () => {
    const note = code.launch();
    const wins = await waitFor(async () => {
      const w = await client.request('vsc.windows');
      return w.length ? w : null;
    }, { timeout: 90000, interval: 1000, what: 'VS Code window to connect' });
    windowId = wins[0].windowId;
    return `${note}; window "${wins[0].name}"`;
  });
  if (!up) throw new Error('no VS Code window');

  const skipSnapshots = clipboardHasNonText();
  if (skipSnapshots) console.log('  note: the clipboard holds non-text data — snapshot checks are skipped to keep it intact');

  /* ------------------------------------------------- 2. snapshot of a terminal without shell integration */

  let cmdTid = null;
  await step('Command Prompt with output from BEFORE the attach → attach carries a snapshot of it; clipboard text unchanged', async () => {
    const before = new Set((await terminalsList()).map((t) => t.tid));
    await client.vsc(windowId, 'commands.run', { command: 'workbench.action.terminal.newWithProfile', args: [{ profileName: 'Command Prompt' }] });
    const t = await waitFor(async () => (await terminalsList()).find((x) => !before.has(x.tid)), { timeout: 15000, what: 'Command Prompt terminal' });
    cmdTid = t.tid;
    await sleep(1500);
    await client.vsc(windowId, 'terminals.sendText', { tid: cmdTid, text: `echo BEFORE-ATTACH-${tag}-cmd`, addNewLine: true });
    await sleep(1500);
    if (skipSnapshots) return 'SKIP';
    const clipBefore = (await client.request('clip.get')).text;
    const t0 = Date.now();
    const a = await client.vsc(windowId, 'terminals.attach', { tid: cmdTid, aid: `e2e-${tag}` });
    const ms = Date.now() - t0;
    await client.vsc(windowId, 'terminals.detach', { tid: cmdTid, aid: `e2e-${tag}` });
    assert(a.capturing === false, `capturing ${a.capturing}`);
    assert(a.snapshot && typeof a.snapshot.text === 'string', `snapshot missing: ${JSON.stringify(a).slice(0, 400)}`);
    assert(a.snapshot.text.includes(`BEFORE-ATTACH-${tag}-cmd`), `snapshot text: ${a.snapshot.text.slice(-400)}`);
    assert(!/\n$/.test(a.snapshot.text), 'trailing blank lines trimmed');
    assert(a.snapshot.cols > 0 && a.snapshot.rows > 0 && a.snapshot.lines > 0, JSON.stringify({ ...a.snapshot, text: undefined }));
    const clipAfter = (await client.request('clip.get')).text;
    assert(clipAfter === clipBefore, 'clipboard text restored');
    return `attach+snapshot in ${ms} ms, ${a.snapshot.lines} line(s)`;
  });

  await step('terminals.snapshot on its own: what the terminal shows now (also later output)', async () => {
    if (skipSnapshots || !cmdTid) return 'SKIP';
    await client.vsc(windowId, 'terminals.sendText', { tid: cmdTid, text: `echo LATER-${tag}`, addNewLine: true });
    await sleep(1200);
    const t0 = Date.now();
    const s = await client.vsc(windowId, 'terminals.snapshot', { tid: cmdTid });
    const ms = Date.now() - t0;
    assert(s.text.includes(`BEFORE-ATTACH-${tag}-cmd`) && s.text.includes(`LATER-${tag}`), s.text.slice(-400));
    assert(Number.isFinite(s.at), 'at');
    return `${ms} ms`;
  });

  /* ------------------------------------------------- 3. ordinary PowerShell terminal */

  await step('ordinary PowerShell terminal: output from before the attach is shown on open', async () => {
    const r = await client.vsc(windowId, 'terminals.create', { name: `ps-${tag}`, mirror: false });
    await sleep(4000); // shell integration + prompt
    await client.vsc(windowId, 'terminals.sendText', { tid: r.tid, text: `Write-Output "PS-BEFORE-${tag}"`, addNewLine: true });
    await sleep(2000);
    const a = await client.vsc(windowId, 'terminals.attach', { tid: r.tid, aid: `e2e-ps-${tag}` });
    await client.vsc(windowId, 'terminals.detach', { tid: r.tid, aid: `e2e-ps-${tag}` });
    const shown = a.snapshot && a.snapshot.text ? a.snapshot.text : a.buffer;
    if (skipSnapshots && !a.capturing) return 'SKIP';
    assert(shown.includes(`PS-BEFORE-${tag}`), `capturing ${a.capturing}; shown: ${String(shown).slice(-300)}`);
    return `capturing ${a.capturing}, from ${a.snapshot && a.snapshot.text ? 'snapshot' : 'ring buffer'}`;
  });

  /* ------------------------------------------------- 4. mirrored terminal across an agent restart */

  let mir = null;
  let hostPid = null;
  const ok = await step('mirrored terminal: output before the restart', async () => {
    mir = await client.vsc(windowId, 'terminals.create', { name: `durable-${tag}`, mirror: true });
    assert(mir.ptyId && mir.tid, JSON.stringify(mir));
    await sleep(2500);
    await client.request('pty.input', { id: mir.ptyId, d: `Write-Output "ONE-${tag}"\r` });
    await waitFor(async () => {
      const att = await client.request('pty.attach', { id: mir.ptyId });
      await client.request('pty.detach', { id: mir.ptyId });
      return att.buffer.includes(`ONE-${tag}`);
    }, { timeout: 20000, interval: 500, what: 'ONE in the scrollback' });
    hostPid = (await status()).ptyHost.pid;
    return `${mir.ptyId} in host ${hostPid}`;
  });

  if (ok) {
    await step('agent restart (PTY host kept): same session id, host pid, scrollback; input works', async () => {
      client.close();
      const stopped = await agent.stop({ keepPtyHost: true });
      assert(isAlive(hostPid), 'PTY host survived the agent');
      await agent.start();
      client = await PhoneClient.open(PORT, agent.token);
      const st = await waitFor(async () => {
        const s = await status();
        return s.ptyHost && s.ptyHost.running ? s : null;
      }, { timeout: 20000, what: 'ptyHost after restart' });
      assert(st.ptyHost.pid === hostPid, `same host pid (${st.ptyHost.pid} vs ${hostPid})`);
      assert(st.ptyHost.adopted >= 1, `adopted ${st.ptyHost.adopted}`);
      const list = await client.request('pty.list');
      const s = list.find((x) => x.id === mir.ptyId);
      assert(s && !s.exited, `session ${mir.ptyId} listed: ${JSON.stringify(list)}`);
      const att = await client.request('pty.attach', { id: mir.ptyId });
      assert(att.buffer.includes(`ONE-${tag}`), 'scrollback from before the restart');
      let out = '';
      const off = client.on('pty.data', (p) => { if (p.id === mir.ptyId) out += p.d; });
      await client.request('pty.input', { id: mir.ptyId, d: `Write-Output "TWO-${tag}"\r` });
      await waitFor(() => out.includes(`TWO-${tag}`), { timeout: 15000, what: 'TWO via pty.data' });
      off();
      await client.request('pty.detach', { id: mir.ptyId });
      return `${stopped}; adopted ${st.ptyHost.adopted}`;
    });

    await step('the VS Code window re-binds its mirror (mirror.rebind): the terminal shows old + new output', async () => {
      const wins = await waitFor(async () => {
        const w = await client.request('vsc.windows');
        return w.find((x) => x.windowId === windowId) ? w : null;
      }, { timeout: 60000, interval: 500, what: 'window reconnect (same windowId)' });
      assert(wins.length >= 1);
      await waitFor(async () => {
        const s = (await client.request('pty.list')).find((x) => x.id === mir.ptyId);
        return s && s.mirror && s.mirror.windowId === windowId;
      }, { timeout: 20000, what: 'session mirrored to the window again' });
      const t = (await terminalsList()).find((x) => x.ptyId === mir.ptyId);
      assert(t && t.isMirror, 'still a mirror terminal in VS Code');
      // Output after the rebind reaches VS Code too.
      await client.request('pty.input', { id: mir.ptyId, d: `Write-Output "THREE-${tag}"\r` });
      await sleep(1500);
      if (skipSnapshots) return 'SKIP';
      const snap = await client.vsc(windowId, 'terminals.snapshot', { tid: t.tid });
      for (const w of [`ONE-${tag}`, `TWO-${tag}`, `THREE-${tag}`]) assert(snap.text.includes(w), `VS Code terminal lacks ${w}: ${snap.text.slice(-500)}`);
      assert(!snap.text.includes('[process ended]') && !snap.text.includes('[TermPocket agent disconnected]'), snap.text.slice(-300));
      return `VS Code terminal shows ${snap.lines} line(s) incl. pre- and post-restart output`;
    });
  }
}

async function teardown() {
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
  const hostPid = await status().then((s) => s.ptyHost && s.ptyHost.pid).catch(() => null);
  if (client) client.close();
  await step('stop agent and shut its PTY host down', async () => {
    const note = await agent.stop();
    if (hostPid) await waitFor(() => !isAlive(hostPid), { timeout: 10000, what: 'PTY host exit' });
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
fs.writeFileSync(path.join(ARTIFACTS, 'durable-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.result === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`);
process.exit(failed.length || fatal ? 1 : 0);
