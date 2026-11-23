// Demo mode (TERMPOCKET_DEMO=1, agent/src/demo.js): a fake identity, the bundled synthetic desktop instead of
// the real screen, and input / power always dry-run. Nothing here reads the real screen or injects input.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { createDemoHelper, demoImages, DEMO_IDENTITY, DEMO_SYSTEM, isDemo } from '../src/demo.js';
import { isDryRun, dryRunLog } from '../src/winhelper.js';
import { createSystemHandlers } from '../src/system.js';
import { createScreenHandlers } from '../src/screen.js';
import { createAgentServer, createPhoneRegistry } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const saved = { demo: process.env.TERMPOCKET_DEMO, dry: process.env.TERMPOCKET_DRYRUN_INPUT };

before(() => {
  process.env.TERMPOCKET_DEMO = '1';
  delete process.env.TERMPOCKET_DRYRUN_INPUT;
});
after(() => {
  for (const [k, v] of [['TERMPOCKET_DEMO', saved.demo], ['TERMPOCKET_DRYRUN_INPUT', saved.dry]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const isJpeg = (b64) => {
  const b = Buffer.from(b64, 'base64');
  return b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
};

describe('demo mode', () => {
  test('isDemo reads TERMPOCKET_DEMO (and the old VSCONTROL_DEMO)', () => {
    assert.equal(isDemo({ TERMPOCKET_DEMO: '1' }), true);
    assert.equal(isDemo({ TERMPOCKET_DEMO: 'yes' }), true);
    assert.equal(isDemo({ VSCONTROL_DEMO: 'true' }), true);
    assert.equal(isDemo({ TERMPOCKET_DEMO: '0' }), false);
    assert.equal(isDemo({}), false);
  });

  test('ships the demo desktop frames (full HD and 1280 px)', () => {
    const sizes = demoImages().map((i) => `${i.width}x${i.height}`);
    assert.deepEqual(sizes, ['1920x1080', '1280x720']);
  });

  test('demo helper: one 1920×1080 monitor, frames by maxWidth, unchanged by hash, no input ops', async () => {
    const h = createDemoHelper();
    assert.deepEqual((await h.call('monitors')).map((m) => [m.width, m.height, m.primary]), [[1920, 1080, true]]);
    const small = await h.call('grab', { monitor: 0, maxWidth: 1280, quality: 50 });
    assert.equal(small.width, 1280);
    assert.equal(small.height, 720);
    assert.ok(isJpeg(small.data), 'JPEG data');
    const again = await h.call('grab', { monitor: 0, maxWidth: 1280, quality: 50, lastHash: small.hash });
    assert.equal(again.unchanged, true);
    assert.equal(again.data, undefined);
    const hd = await h.call('grab', { monitor: -1, maxWidth: 1920, quality: 65 });
    assert.equal(hd.width, 1920);
    assert.notEqual(hd.hash, small.hash);
    assert.equal((await h.call('grab', { monitor: 0, maxWidth: 640 })).width, 1280, 'narrowest frame when none fits');
    await assert.rejects(h.call('grab', { monitor: 3 }), /no such monitor/);
    const cur = await h.call('cursor', { monitor: 0 });
    assert.ok(cur.pointer.x > 0 && cur.pointer.x < 1 && cur.pointer.visible);
    for (const op of ['mouse', 'key', 'keyraw', 'text', 'release', 'clipSet', 'open', 'kill', 'suspend']) {
      await assert.rejects(h.call(op, {}), /demo mode/, op);
    }
    assert.deepEqual(h.status(), { running: true, pid: null, restarts: 0, lastError: null, demo: true });
    await h.dispose();
    await assert.rejects(h.call('monitors'), /disposed/);
  });

  test('demo is always dry-run; sys.info / proc.list / clip.get show sample data only', async () => {
    assert.equal(isDryRun(), true);
    const helper = createDemoHelper();
    const sys = createSystemHandlers({ config: {}, log: quietLog, helper });
    const info = await sys.methods['sys.info']();
    assert.equal(info.hostname, DEMO_IDENTITY.hostname);
    assert.equal(info.user, 'you');
    assert.deepEqual(info.ips, ['100.101.102.103', '10.0.0.24']);
    assert.notEqual(info.hostname, os.hostname());
    // the sample machine, not this PC's OS edition / CPU / memory / uptime
    for (const k of ['os', 'release', 'arch', 'cpuModel', 'cpuCount', 'memTotal', 'memFree', 'uptimeSec']) assert.equal(info[k], DEMO_SYSTEM[k], k);
    assert.ok(info.memFree < info.memTotal);
    assert.equal(info.monitors.length, 1);
    const procs = await sys.methods['proc.list']({});
    assert.ok(procs.length > 5 && procs.every((p) => p.pid > 4000), 'synthetic process list');
    assert.deepEqual(await sys.methods['clip.get'](), { text: 'npm run dev' });
    const before = dryRunLog.length;
    assert.equal(await sys.methods['power']({ action: 'shutdown' }), true);
    assert.equal(await sys.methods['proc.kill']({ pid: 4120 }), true);
    assert.equal(dryRunLog.length, before + 2, 'recorded, not executed');
    await sys.dispose?.();
  });

  test('screen.snapshot / screen.monitors serve the demo desktop', async () => {
    const helper = createDemoHelper();
    const screen = createScreenHandlers({ config: { screen: { fps: 2, quality: 50, maxWidth: 1280 } }, log: quietLog, helper });
    const snap = await screen.methods['screen.snapshot']({ monitor: 0, maxWidth: 1920 });
    assert.equal(snap.mime, 'image/jpeg');
    assert.equal(snap.width, 1920);
    assert.ok(isJpeg(snap.data));
    const mons = await screen.methods['screen.monitors']();
    assert.equal(mons.length >= 1, true);
    await screen.dispose?.();
  });

  test('auth result reports the demo hostname and user', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-demo-'));
    const config = loadConfig({ env: { TERMPOCKET_HOME: home, TERMPOCKET_PORT: '0', TERMPOCKET_HOST: '127.0.0.1' } });
    const server = createAgentServer({ config, log: quietLog, registry: createPhoneRegistry(), handlerSets: [] });
    const { port } = await server.listen(0, '127.0.0.1');
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const res = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d))));
      ws.send(JSON.stringify({ t: 'req', id: 1, m: 'auth', p: { token: config.token, client: 'test' } }));
      const r = await res;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.r.hostname, 'DEV-PC');
      assert.equal(r.r.user, 'you');
      ws.close();
    } finally {
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
