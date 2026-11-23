// Tests for the tray monitor's classification and alert logic (scripts/monitor-tray.ps1).
// Run from agent/:  node --test test/monitor-tray.test.mjs
//
// A tiny fake agent serves /status, /healthz and a fake public /healthz; the monitor is run in its test
// mode (powershell -File monitor-tray.ps1 -Once -Json) against it with a temporary config dir and a
// previous-state file. Nothing here touches the real agent, its config or the desktop.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'monitor-tray.ps1');
const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// fake agent + fake public relay
// ---------------------------------------------------------------------------------------------
const fake = {
  status: null,        // object served by /status (null => 404, like an old agent)
  statusCode: 200,
  healthz: true,       // agent /healthz answers?
  publicHealth: { ok: true, relay: 'x', pcOnline: true },
  publicCode: 200,
  hits: [],
};
let server;
let base;
let tmp;

function baseStatus(over = {}) {
  return {
    ok: true, version: '0.2.0', pid: 4242, startedAt: Date.now() - 7380_000, uptimeSec: 7380, now: Date.now(),
    listen: { host: '127.0.0.1', port: 8765 }, publicUrl: null,
    relay: { configured: false, url: null, connected: false, since: null, sessions: 0, lastError: null, reconnects: 0 },
    phones: [], vscode: [], terminals: [], screen: { streams: 0 },
    helper: { running: false, pid: null, restarts: 0, lastError: null },
    security: { authFailures: 0, rateLimitedIps: 0, lastAuthFailure: null },
    log: [],
    ...over,
  };
}
const phone = (id, ip, via = 'relay') => ({ id, ip, client: 'pwa', via, connectedAt: Date.now(), attached: [], streaming: false });
const relayUp = { configured: true, url: 'wss://relay.example', connected: true, since: Date.now(), sessions: 1, lastError: null, reconnects: 0 };
const relayDown = { ...relayUp, connected: false, since: null, lastError: 'socket hang up' };

function runMonitor(args, { timeoutMs = 30_000, sta = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', ...(sta ? ['-STA'] : []), '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`monitor timed out\n${out}\n${err}`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** Runs -Once -Json against the fake server; returns the parsed state + exit code. */
async function once({ stateFile, now, health = 'public', statusUrl, configDir } = {}) {
  const args = ['-Once', '-Json', '-ConfigDir', configDir ?? tmp, '-StatusUrl', statusUrl ?? `${base}/status`];
  if (health === 'public') args.push('-HealthUrl', `${base}/public/healthz`);
  else if (health === 'none') args.push('-NoHealth');
  if (stateFile) args.push('-StateFile', stateFile);
  if (now) args.push('-NowMs', String(now));
  const r = await runMonitor(args);
  let json;
  try {
    json = JSON.parse(r.out);
  } catch {
    throw new Error(`monitor did not print JSON (exit ${r.code}):\n${r.out}\n${r.err}`);
  }
  json.exitCode = r.code;
  return json;
}

function freshStateFile(name) {
  const f = path.join(tmp, `${name}.state.json`);
  fs.rmSync(f, { force: true });
  return f;
}

describe('monitor-tray.ps1', { skip: !isWindows && 'Windows PowerShell only' }, () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-monitor-'));
    server = http.createServer((req, res) => {
      fake.hits.push(`${req.method} ${req.url}`);
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.url === '/status') {
        if (!fake.status) return send(404, 'Not Found');
        return send(fake.statusCode, fake.status);
      }
      if (req.url === '/healthz') return fake.healthz ? send(200, { ok: true, version: '0.1.0' }) : send(500, 'down');
      if (req.url === '/public/healthz') return send(fake.publicCode, fake.publicHealth);
      if (req.url === '/status/selftest' && req.method === 'POST') {
        if (req.headers['x-termpocket-monitor'] !== '1') return send(404, 'Not Found'); // CSRF guard of the contract
        return send(200, { ok: true, steps: [{ name: 'local healthz', ok: true, ms: 3, detail: '' }] });
      }
      send(404, 'Not Found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------------------------
  // classification
  // ---------------------------------------------------------------------------------------------
  test('green: agent up, no relay configured', async () => {
    fake.status = baseStatus({ phones: [phone(1, '100.64.0.2', 'direct')], vscode: [{ windowId: 'w1', name: 'a', folders: [], connectedAt: 1 }, { windowId: 'w2', name: 'b', folders: [], connectedAt: 1 }] });
    const s = await once({ health: 'none' });
    assert.equal(s.color, 'green');
    assert.equal(s.exitCode, 0);
    assert.equal(s.tooltip, 'TermPocket: all good · 1 phone');
    assert.deepEqual(s.reasons, []);
    assert.deepEqual(s.menu, ['Agent: running 2h 3m', 'Public: not configured', 'Phones: 1', 'VS Code windows: 2', 'Terminals host: not running']);
    assert.equal(s.phoneCount, 1);
  });

  test('green: relay connected and public healthz says pcOnline', async () => {
    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example', phones: [phone(1, '1.2.3.4'), phone(2, '5.6.7.8')] });
    fake.publicHealth = { ok: true, relay: '1', pcOnline: true };
    const s = await once();
    assert.equal(s.color, 'green');
    assert.equal(s.tooltip, 'TermPocket: all good · 2 phones');
    assert.equal(s.menu[1], 'Public: connected');
    assert.equal(s.publicOk, true);
    assert.equal(s.relayConnected, true);
  });

  test('amber: relay configured but disconnected', async () => {
    fake.status = baseStatus({ relay: relayDown, publicUrl: 'https://relay.example' });
    fake.publicHealth = { ok: true, relay: '1', pcOnline: false };
    const s = await once();
    assert.equal(s.color, 'amber');
    assert.equal(s.exitCode, 1);
    assert.match(s.tooltip, /^TermPocket: relay disconnected/);
    assert.ok(s.tooltip.length <= 63, s.tooltip);
    assert.equal(s.menu[1], 'Public: disconnected');
    assert.ok(s.reasons.some((r) => /relay is disconnected: socket hang up/.test(r)), s.reasons.join('|'));
    assert.ok(s.reasons.some((r) => /says this PC is offline/.test(r)), s.reasons.join('|'));
  });

  test('amber: relay connected but the public link fails (pcOnline false / HTTP error)', async () => {
    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example' });
    fake.publicHealth = { ok: true, relay: '1', pcOnline: false };
    let s = await once();
    assert.equal(s.color, 'amber');
    assert.match(s.tooltip, /public link down/);
    assert.equal(s.menu[1], 'Public: relay connected, link failing');

    fake.publicCode = 502;
    fake.publicHealth = { error: 'bad gateway' };
    s = await once();
    assert.equal(s.color, 'amber');
    assert.ok(s.reasons.some((r) => /HTTP 502/.test(r)), s.reasons.join('|'));
    fake.publicCode = 200;
    fake.publicHealth = { ok: true, relay: '1', pcOnline: true };
  });

  test('amber only when the helper crashed (idle helper is fine)', async () => {
    fake.status = baseStatus({ helper: { running: false, pid: null, restarts: 0, lastError: null } });
    let s = await once({ health: 'none' });
    assert.equal(s.color, 'green');
    fake.status = baseStatus({ helper: { running: false, pid: null, restarts: 3, lastError: 'helper exited (code 1)' } });
    s = await once({ health: 'none' });
    assert.equal(s.color, 'amber');
    assert.match(s.tooltip, /helper down/);
  });

  test('amber: old agent without /status but /healthz answers', async () => {
    fake.status = null;
    fake.healthz = true;
    const s = await once({ health: 'none' });
    assert.equal(s.color, 'amber');
    assert.equal(s.agentUp, true);
    assert.equal(s.menu[0], 'Agent: running');
    assert.match(s.reasons[0], /no \/status page/);
  });

  test('red: nothing listening', async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    const s = await once({ statusUrl: `http://127.0.0.1:${port}/status`, health: 'none' });
    assert.equal(s.color, 'red');
    assert.equal(s.exitCode, 2);
    assert.equal(s.tooltip, 'TermPocket: agent is NOT running');
    assert.equal(s.menu[0], 'Agent: NOT running');
    assert.match(s.reasons[0], /connection refused/);
  });

  test('red: /status returns HTTP 500', async () => {
    fake.status = baseStatus();
    fake.statusCode = 500;
    const s = await once({ health: 'none' });
    fake.statusCode = 200;
    assert.equal(s.color, 'red');
    assert.match(s.reasons[0], /HTTP 500/);
  });

  test('ports and public URL come from config.json / relay.json', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
    fs.writeFileSync(path.join(dir, 'config.json'), '﻿' + JSON.stringify({ port: 18791, token: 'x'.repeat(43) }));
    fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ url: 'wss://relay.example', key: 'k'.repeat(40) }));
    const r = await runMonitor(['-Once', '-Json', '-NoHealth', '-ConfigDir', dir]);
    const s = JSON.parse(r.out);
    assert.equal(s.port, 18791);
    assert.equal(s.statusUrl, 'http://127.0.0.1:18791/status');
    assert.equal(s.publicUrl, 'https://relay.example');
    assert.equal(s.relayConfigured, true);
    assert.equal(s.color, 'red');
    assert.equal(s.menu[1], 'Public: offline (agent not running)');
    assert.ok(!r.out.includes('x'.repeat(43)) && !r.out.includes('k'.repeat(40)), 'never prints secrets');
  });

  // ---------------------------------------------------------------------------------------------
  // alerts (previous-state file)
  // ---------------------------------------------------------------------------------------------
  test('security: new device and failed pairing attempts are detected, with debounce', async () => {
    const sf = freshStateFile('security');
    const t0 = 1_800_000_000_000;
    fake.status = baseStatus({ phones: [phone(1, '100.64.0.2', 'direct')] });
    let s = await once({ stateFile: sf, now: t0, health: 'none' });
    assert.deepEqual(s.alerts, [], 'first sample is the baseline (no alerts for phones already connected)');

    fake.status = baseStatus({
      phones: [phone(1, '100.64.0.2', 'direct'), phone(2, '203.0.113.9', 'relay')],
      security: { authFailures: 3, rateLimitedIps: 0, lastAuthFailure: { ip: '198.51.100.7', at: t0 } },
    });
    s = await once({ stateFile: sf, now: t0 + 5000, health: 'none' });
    const texts = s.alerts.map((a) => a.text);
    assert.ok(texts.includes('New device connected from 203.0.113.9 (via relay)'), texts.join('|'));
    assert.ok(texts.includes('3 failed pairing attempts from 198.51.100.7'), texts.join('|'));
    assert.equal(s.alerts.length, 2);

    // Same device reconnects (new id, same ip) within 30 s and one more failure: new-device suppressed.
    fake.status = baseStatus({
      phones: [phone(1, '100.64.0.2', 'direct'), phone(3, '203.0.113.9', 'relay')],
      security: { authFailures: 4, rateLimitedIps: 0, lastAuthFailure: { ip: '198.51.100.7', at: t0 } },
    });
    s = await once({ stateFile: sf, now: t0 + 10_000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.key), [], 'identical alerts within 30 s are debounced');

    // After 30 s: failed attempts alert again, counting the one held back by the debounce; the same
    // device reconnecting is not "new" (seen < 24 h), but a device from an address never seen before is.
    fake.status = baseStatus({
      phones: [phone(1, '100.64.0.2', 'direct'), phone(4, '203.0.113.9', 'relay'), phone(5, '203.0.113.77', 'relay')],
      security: { authFailures: 5, rateLimitedIps: 0, lastAuthFailure: { ip: '198.51.100.7', at: t0 } },
    });
    s = await once({ stateFile: sf, now: t0 + 50_000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.text).sort(), ['2 failed pairing attempts from 198.51.100.7', 'New device connected from 203.0.113.77 (via relay)']);

    // Attempts from another address within 30 s share the debounce (no balloon per rotating IP).
    fake.status = baseStatus({
      phones: [phone(1, '100.64.0.2', 'direct'), phone(4, '203.0.113.9', 'relay'), phone(5, '203.0.113.77', 'relay')],
      security: { authFailures: 7, rateLimitedIps: 0, lastAuthFailure: { ip: '192.0.2.44', at: t0 } },
    });
    s = await once({ stateFile: sf, now: t0 + 55_000, health: 'none' });
    assert.deepEqual(s.alerts, []);

    // The phone goes away and comes back 2 h later: still known. After more than 24 h away it is new again.
    fake.status = baseStatus({ phones: [] });
    await once({ stateFile: sf, now: t0 + 60_000, health: 'none' });
    fake.status = baseStatus({ phones: [phone(6, '203.0.113.9', 'relay')] });
    s = await once({ stateFile: sf, now: t0 + 2 * 3600_000, health: 'none' });
    assert.deepEqual(s.alerts, [], 'a device seen within 24 h is not announced again');
    fake.status = baseStatus({ phones: [] });
    await once({ stateFile: sf, now: t0 + 2 * 3600_000 + 5000, health: 'none' });
    fake.status = baseStatus({ phones: [phone(7, '100.64.0.2', 'direct')] });
    s = await once({ stateFile: sf, now: t0 + 27 * 3600_000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.text), ['New device connected from 100.64.0.2 (via direct)']);
  });

  test('agent restart: reconnecting phones are not "new devices", counters reset cleanly', async () => {
    const sf = freshStateFile('restart');
    const t0 = 1_800_000_100_000;
    fake.status = baseStatus({ pid: 100, phones: [phone(7, '203.0.113.9', 'relay')], security: { authFailures: 2, rateLimitedIps: 0, lastAuthFailure: null } });
    await once({ stateFile: sf, now: t0, health: 'none' });
    fake.status = baseStatus({ pid: 200, uptimeSec: 4, phones: [phone(1, '203.0.113.9', 'relay')], security: { authFailures: 0, rateLimitedIps: 0, lastAuthFailure: null } });
    const s = await once({ stateFile: sf, now: t0 + 5000, health: 'none' });
    assert.deepEqual(s.alerts, []);
  });

  test('agent down / up and relay lost / restored alerts', async () => {
    const sf = freshStateFile('updown');
    const t0 = 1_800_000_200_000;
    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example' });
    let s = await once({ stateFile: sf, now: t0, health: 'none' });
    assert.deepEqual(s.alerts, []);

    // relay drops on a long-running agent
    fake.status = baseStatus({ relay: relayDown, publicUrl: 'https://relay.example' });
    s = await once({ stateFile: sf, now: t0 + 5000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.key), ['relay-lost']);
    assert.match(s.alerts[0].text, /socket hang up/);

    // still down: no repeat
    s = await once({ stateFile: sf, now: t0 + 60_000, health: 'none' });
    assert.deepEqual(s.alerts, []);

    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example' });
    s = await once({ stateFile: sf, now: t0 + 65_000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.key), ['relay-restored']);

    // agent goes away, then comes back with a new pid; its relay needs a few seconds (grace) -> no relay-lost
    const dead = `http://127.0.0.1:1/status`;
    s = await once({ stateFile: sf, now: t0 + 70_000, health: 'none', statusUrl: dead });
    assert.deepEqual(s.alerts.map((a) => a.key), ['agent-down']);
    assert.equal(s.alerts[0].level, 'error');
    fake.status = baseStatus({ pid: 999, uptimeSec: 3, relay: relayDown, publicUrl: 'https://relay.example' });
    s = await once({ stateFile: sf, now: t0 + 80_000, health: 'none' });
    assert.deepEqual(s.alerts.map((a) => a.key), ['agent-up']);
    assert.equal(s.color, 'amber');
  });

  test('public URL unreachable / restored alerts', async () => {
    const sf = freshStateFile('public');
    const t0 = 1_800_000_300_000;
    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example' });
    fake.publicHealth = { ok: true, pcOnline: true };
    let s = await once({ stateFile: sf, now: t0 });
    assert.deepEqual(s.alerts, []);
    fake.publicHealth = { ok: true, pcOnline: false };
    s = await once({ stateFile: sf, now: t0 + 60_000 });
    assert.deepEqual(s.alerts.map((a) => a.key), ['public-down']);
    assert.match(s.alerts[0].text, /^relay\.example is not reachable/);
    // A sample without a public check keeps the last verdict (no flapping)
    s = await once({ stateFile: sf, now: t0 + 65_000, health: 'none' });
    assert.deepEqual(s.alerts, []);
    fake.publicHealth = { ok: true, pcOnline: true };
    s = await once({ stateFile: sf, now: t0 + 120_000 });
    assert.deepEqual(s.alerts.map((a) => a.key), ['public-up']);
  });

  test('tray loop (invisible icon, smoke mode): polls, alerts, menu, self-test; never controls the agent', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'smoke-'));
    fake.status = baseStatus({ relay: relayUp, publicUrl: 'https://relay.example', phones: [phone(1, '100.64.0.2', 'direct')] });
    fake.publicHealth = { ok: true, pcOnline: true };
    fake.hits = [];
    const run = runMonitor(['-SmokeSeconds', '11', '-StatusUrl', `${base}/status`, '-HealthUrl', `${base}/public/healthz`, '-ConfigDir', dir], { sta: true });
    await new Promise((r) => setTimeout(r, 6000));
    fake.status = baseStatus({
      relay: relayUp, publicUrl: 'https://relay.example',
      phones: [phone(1, '100.64.0.2', 'direct'), phone(2, '203.0.113.50', 'relay')],
      security: { authFailures: 2, rateLimitedIps: 0, lastAuthFailure: { ip: '198.51.100.9', at: Date.now() } },
    });
    const r = await run;
    const out = r.out;
    assert.equal(r.code, 0, out + r.err);
    assert.equal(r.err.trim(), '', r.err);
    assert.match(out, /STATE green \| TermPocket: all good · 1 phone \| Agent: running 2h 3m \/ Public: connected \/ Phones: 1 \/ VS Code windows: 0/);
    assert.match(out, /MENU Agent: running 2h 3m\(off\) \| Public: connected\(off\) \| Phones: 1\(off\) \| VS Code windows: 0\(off\) \| Terminals host: not running\(off\) \| --- \| Open Monitor \| Run self-test \| --- \| Restart agent \| Stop agent \| Start agent\(off\) \| --- \| Open log file\(off\) \| Open pairing page \| Open phone link \| --- \| Exit monitor/);
    assert.ok(out.includes(`OPEN-APP ${base}/monitor`), out);
    assert.ok(out.includes(`OPEN ${base}/pair`), out);
    assert.ok(out.includes('OPEN https://relay.example'), out);
    assert.match(out, /MESSAGE \[Information\] TermPocket self-test: All checks passed/);
    assert.ok(out.includes('ACTION restart refused in smoke mode'), out);
    assert.match(out, /ALERT \[warning\] TermPocket security: New device connected from 203\.0\.113\.50 \(via relay\)/);
    assert.match(out, /2 failed pairing attempts from 198\.51\.100\.9/);
    assert.ok(fake.hits.includes('POST /status/selftest'), fake.hits.join(','));
    assert.ok(fake.hits.filter((h) => h === 'GET /status').length >= 2, 'polls repeatedly');
    assert.ok(fs.existsSync(path.join(dir, 'monitor.log')), 'writes its own log');
  });

  test('terminals host line: from /status ptyHost, else from ptyhost.json', async () => {
    fake.status = baseStatus({ ptyHost: { mode: 'host', running: true, pid: 999, sessions: 2, live: 2 } });
    let s = await once({ health: 'none' });
    assert.equal(s.menu[4], 'Terminals host: running (2 sessions)');
    assert.equal(s.ptyHostRunning, true);
    assert.equal(s.ptyHostSessions, 2);
    fake.status = baseStatus({ ptyHost: { mode: 'host', running: true, pid: 999, sessions: 1 } });
    assert.equal((await once({ health: 'none' })).menu[4], 'Terminals host: running (1 session)');
    fake.status = baseStatus({ ptyHost: { mode: 'inprocess', running: true, pid: 4242, sessions: 0 } });
    assert.equal((await once({ health: 'none' })).menu[4], 'Terminals host: inside the agent (0 sessions)');
    fake.status = baseStatus({ ptyHost: { mode: 'host', running: false, pid: null, sessions: 3 } });
    assert.equal((await once({ health: 'none' })).menu[4], 'Terminals host: reconnecting');

    // Agent down: the host's pid from ptyhost.json (this test runner is a live node.exe); the secret is never shown.
    const dir = fs.mkdtempSync(path.join(tmp, 'ph-'));
    fs.writeFileSync(path.join(dir, 'ptyhost.json'), JSON.stringify({ pid: process.pid, pipe: 'x', secret: 'TOP-SECRET-VALUE' }));
    fake.status = null;
    fake.healthz = false;
    s = await once({ health: 'none', configDir: dir, statusUrl: 'http://127.0.0.1:1/status' });
    fake.healthz = true;
    assert.equal(s.agentUp, false);
    assert.equal(s.menu[4], 'Terminals host: running');
    assert.ok(!JSON.stringify(s).includes('TOP-SECRET-VALUE'));
  });

  test('Stop/Restart agent ends only the agent itself, never processes started from its terminals', async () => {
    const launcher = String.raw`C:\Users\u\AppData\Roaming\TermPocket\termpocket-agent.vbs`;
    const entry = String.raw`"E:\p\TermPocket\agent\src\index.js"`;
    const t = (min) => `2026-11-21T10:${String(min).padStart(2, '0')}:00`;
    const P = (ProcessId, ParentProcessId, Name, CommandLine, min) => ({ ProcessId, ParentProcessId, Name, CommandLine, CreationDate: t(min) });
    const spec = {
      launcher,
      owners: [30],
      processes: [
        P(10, 1, 'wscript.exe', String.raw`"C:\Windows\System32\wscript.exe" "${launcher}"`, 1),
        P(20, 10, 'cmd.exe', `cmd.exe /d /c ""node.exe" ${entry} >> "agent.log" 2>&1"`, 2),
        P(30, 20, 'node.exe', `"node.exe" ${entry}`, 3),
        P(40, 30, 'powershell.exe', 'powershell.exe -NoProfile -File winhelper.ps1', 4), // helper: exits on its own
        P(50, 30, 'cmd.exe', String.raw`C:\Windows\system32\cmd.exe`, 5), // phone terminal shell
        P(60, 50, 'node.exe', 'node server.js', 6), // dev server started from it
        P(61, 50, 'Code.exe', '"Code.exe" .', 6), // VS Code opened with `code .`
        P(62, 50, 'node.exe', `"node.exe" ${entry}`, 6), // a second agent run by hand in a phone terminal
        P(70, 10, 'node.exe', `"node.exe" ${entry}`, 0), // stale parent id (PID reuse)
        P(80, 1, 'node.exe', `"node.exe" ${entry}`, 7), // test agent on another port
        P(90, 1, 'wscript.exe', String.raw`"wscript.exe" "C:\other\thing.vbs"`, 1),
        // The terminals host (owns every terminal): started through WMI (parent WmiPrvSE) or as a detached child.
        P(100, 95, 'node.exe', String.raw`"node.exe" "E:\p\TermPocket\agent\src\ptyhost.js" --pipe \\.\pipe\termpocket-ptyhost-ab --home "C:\Users\u\AppData\Roaming\TermPocket"`, 8),
        P(101, 30, 'node.exe', String.raw`"node.exe" "E:\p\TermPocket\agent\src\ptyhost.js" --pipe x --home y`, 8),
      ],
    };
    const f = path.join(tmp, 'procs.json');
    fs.writeFileSync(f, JSON.stringify(spec));
    const r = await runMonitor(['-ProcessTargetsTest', f]);
    const out = JSON.parse(r.out);
    assert.deepEqual(out.launchers, [10]);
    assert.deepEqual(out.tree, [20, 30]);
    assert.deepEqual(out.portAgents, [30]);
  });

  test('tooltip never exceeds 63 characters', async () => {
    fake.status = baseStatus({
      relay: { ...relayDown, lastError: 'x'.repeat(300) }, publicUrl: 'https://a-very-long-host-name.example.com',
      helper: { running: false, pid: null, restarts: 9, lastError: 'boom' },
      phones: Array.from({ length: 12 }, (_, i) => phone(i + 1, `10.0.0.${i}`)),
    });
    fake.publicHealth = { ok: false };
    const s = await once();
    fake.publicHealth = { ok: true, pcOnline: true };
    assert.equal(s.color, 'amber');
    assert.ok(s.tooltip.length <= 63, `${s.tooltip.length}: ${s.tooltip}`);
    assert.match(s.tooltip, /\(\+2\)/);
  });
});
