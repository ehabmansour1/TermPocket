// Tests for the Windows system + screen layer (winhelper.js, system.js, screen.js).
// Run from agent/:  node --test test/system.test.mjs
//
// Safety: these tests never inject real input or run power actions. Everything that changes machine state
// (input.*, power, proc.kill, sys.open, clip.set via the handler) runs in DRY RUN mode. The only real write
// is the clipboard round-trip, which saves and restores the user's clipboard text (and is skipped when the
// clipboard holds non-text data that could not be restored).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawn } from 'node:child_process';

process.env.TERMPOCKET_DRYRUN_INPUT = '1';

const { createWinHelper } = await import('../src/winhelper.js');
const { createSystemHandlers, dryRunLog } = await import('../src/system.js');
const screenModule = await import('../src/screen.js');
const { createScreenHandlers, resolveKey, resolveKeyCode, KEY_CODES, virtualDesktop, toDesktopPixels, encodeFrame } = screenModule;

const isWindows = process.platform === 'win32';
const quietLog = { debug() {}, info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
const config = { screen: { fps: 2, quality: 50, maxWidth: 1280 } };

let helper;
let system;
let screen;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function lastDryRun(method) {
  for (let i = dryRunLog.length - 1; i >= 0; i--) if (dryRunLog[i].method === method) return dryRunLog[i];
  return undefined;
}

function fakeClient(id = 'test-client') {
  const frames = [];
  const metas = [];
  const log = []; // everything sent, in order: {kind:'meta', p} | {kind:'frame', seq, buf}
  let open = true;
  return {
    id,
    remote: '127.0.0.1',
    frames,
    metas,
    log,
    sendJson(obj) {
      if (obj && obj.t === 'evt' && obj.ev === 'screen.meta') {
        metas.push(obj.p);
        log.push({ kind: 'meta', p: obj.p });
      }
    },
    sendBinary(buf) {
      frames.push(buf);
      log.push({ kind: 'frame', seq: buf.readUInt32BE(1), buf });
    },
    get bufferedAmount() {
      return 0;
    },
    isOpen() {
      return open;
    },
    close() {
      open = false;
    },
  };
}

function assertFrame(buf, expectedMonitor) {
  assert.ok(Buffer.isBuffer(buf), 'frame is a Buffer');
  assert.ok(buf.length > 7 + 100, 'frame has a JPEG payload');
  assert.equal(buf[0], 0x01, 'type byte');
  const seq = buf.readUInt32BE(1);
  assert.ok(seq >= 1, 'seq starts at 1');
  assert.equal(buf.readUInt16BE(5), expectedMonitor, 'monitor index');
  assert.equal(buf[7], 0xff, 'JPEG SOI byte 1');
  assert.equal(buf[8], 0xd8, 'JPEG SOI byte 2');
  return seq;
}

describe('pure helpers', () => {
  test('resolveKey maps names, letters, digits, punctuation and modifiers', () => {
    assert.deepEqual(resolveKey('Enter'), { vk: 0x0d, mods: [] });
    assert.deepEqual(resolveKey('F5', ['ctrl']), { vk: 0x74, mods: [0x11] });
    assert.deepEqual(resolveKey('F12'), { vk: 0x7b, mods: [] });
    assert.deepEqual(resolveKey('PageDown'), { vk: 0x22, mods: [] });
    assert.deepEqual(resolveKey('a', ['ctrl', 'shift', 'ctrl']), { vk: 0x41, mods: [0x11, 0x10] });
    assert.deepEqual(resolveKey('Z'), { vk: 0x5a, mods: [0x10] });
    assert.deepEqual(resolveKey('7', ['win']), { vk: 0x37, mods: [0x5b] });
    assert.deepEqual(resolveKey('/', ['ctrl']), { char: '/', mods: [0x11] });
    assert.throws(() => resolveKey('NoSuchKey'), /unknown key/);
    assert.throws(() => resolveKey('a', ['hyper']), /unknown modifier/);
    assert.throws(() => resolveKey(''), /key must be/);
  });

  test('toDesktopPixels converts normalized coords and clamps', () => {
    const m1 = { x: 1920, y: 0, width: 1920, height: 1080 };
    assert.deepEqual(toDesktopPixels(m1, 0.5, 0.5), { x: 2880, y: 540 });
    assert.deepEqual(toDesktopPixels(m1, 0, 0), { x: 1920, y: 0 });
    assert.deepEqual(toDesktopPixels(m1, 1, 1), { x: 3839, y: 1079 });
    assert.deepEqual(toDesktopPixels(m1, -3, 7), { x: 1920, y: 1079 });
  });

  test('encodeFrame writes the §3 binary header', () => {
    const f = encodeFrame(0x01020304, 3, Buffer.from([0xff, 0xd8, 0xff]));
    assert.deepEqual([...f], [0x01, 0x01, 0x02, 0x03, 0x04, 0x00, 0x03, 0xff, 0xd8, 0xff]);
  });
});

/** Width/height from a JPEG's SOF marker. */
function jpegSize(jpeg) {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** §8.2: every binary frame is immediately preceded by a screen.meta with the same seq (and the JPEG's size);
 *  a meta not followed by a frame must repeat the seq of the last frame (cursor-only update). */
function assertMetaOrdering(client, expectedMonitor) {
  let lastFrameSeq = 0;
  client.log.forEach((item, i) => {
    if (item.kind === 'frame') {
      const prev = client.log[i - 1];
      assert.ok(prev && prev.kind === 'meta', `frame seq ${item.seq} is preceded by a screen.meta`);
      assert.equal(prev.p.seq, item.seq, 'meta seq matches the frame');
      assert.equal(prev.p.monitor, expectedMonitor, 'meta monitor');
      const size = jpegSize(item.buf.subarray(7));
      assert.ok(size, 'frame carries a parsable JPEG');
      assert.deepEqual({ width: prev.p.width, height: prev.p.height }, size, 'meta size = JPEG size');
      const c = prev.p.cursor;
      assert.ok(c === null || (c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1 && typeof c.visible === 'boolean'), 'cursor shape');
      lastFrameSeq = item.seq;
    } else {
      const next = client.log[i + 1];
      if (!next || next.kind !== 'frame') {
        assert.equal(item.p.seq, lastFrameSeq, 'meta without a frame repeats the last frame seq');
      }
    }
  });
}

/**
 * A scripted stand-in for the Windows helper (never touches the real machine): two 1920×1080 monitors side by
 * side, a static screen and a pointer the test moves by assigning `fake.pointer`.
 */
function fakeHelper() {
  const calls = [];
  const fake = {
    calls,
    pointer: { x: 0.25, y: 0.5, visible: true },
    hash: 'h1',
    async call(op, args = {}) {
      calls.push({ op, args });
      switch (op) {
        case 'monitors':
          return [
            { index: 0, name: 'DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true },
            { index: 1, name: 'DISPLAY2', x: 1920, y: 0, width: 1920, height: 1080, primary: false },
          ];
        case 'grab': {
          const src = args.monitor === -1 ? { w: 3840, h: 1080 } : { w: 1920, h: 1080 };
          const width = Math.min(src.w, args.maxWidth || src.w);
          const height = Math.round((src.h * width) / src.w);
          const r = { monitor: args.monitor, width, height, hash: fake.hash, pointer: fake.pointer };
          if (args.lastHash === fake.hash) return { ...r, unchanged: true };
          // Minimal JPEG-looking payload: SOI + SOF0 with the size + EOI.
          const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255]);
          return { ...r, unchanged: false, data: Buffer.concat([sof, Buffer.alloc(120), Buffer.from([0xff, 0xd9])]).toString('base64') };
        }
        case 'cursor':
          return { monitor: args.monitor, pointer: fake.pointer };
        case 'mouse':
        case 'keyraw':
        case 'release':
        case 'key':
        case 'text':
          return true;
        default:
          throw new Error(`unknown op: ${op}`);
      }
    },
    async dispose() {},
  };
  return fake;
}

/** Run `fn` with real (non-dry-run) dispatch — only ever used together with fakeHelper(). */
async function withoutDryRun(fn) {
  const saved = process.env.TERMPOCKET_DRYRUN_INPUT;
  delete process.env.TERMPOCKET_DRYRUN_INPUT;
  try {
    return await fn();
  } finally {
    process.env.TERMPOCKET_DRYRUN_INPUT = saved;
  }
}

describe('§8 pure helpers', () => {
  test('resolveKeyCode maps KeyboardEvent.code to VK + scan code + extended flag', () => {
    assert.deepEqual(resolveKeyCode('KeyA'), { code: 'KeyA', vk: 0x41, scan: 0x1e, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('ArrowLeft'), { code: 'ArrowLeft', vk: 0x25, scan: 0x4b, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('ControlRight'), { code: 'ControlRight', vk: 0xa3, scan: 0x1d, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('ControlLeft'), { code: 'ControlLeft', vk: 0xa2, scan: 0x1d, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('NumpadEnter'), { code: 'NumpadEnter', vk: 0x0d, scan: 0x1c, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('Enter'), { code: 'Enter', vk: 0x0d, scan: 0x1c, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('MetaLeft'), { code: 'MetaLeft', vk: 0x5b, scan: 0x5b, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('AltRight'), { code: 'AltRight', vk: 0xa5, scan: 0x38, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('NumpadDivide'), { code: 'NumpadDivide', vk: 0x6f, scan: 0x35, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('Digit0'), { code: 'Digit0', vk: 0x30, scan: 0x0b, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('F1'), { code: 'F1', vk: 0x70, scan: 0x3b, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('F12'), { code: 'F12', vk: 0x7b, scan: 0x58, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('Delete'), { code: 'Delete', vk: 0x2e, scan: 0x53, ext: true, vkMode: false });
    assert.deepEqual(resolveKeyCode('Numpad1'), { code: 'Numpad1', vk: 0x61, scan: 0x4f, ext: false, vkMode: false });
    assert.deepEqual(resolveKeyCode('PrintScreen'), { code: 'PrintScreen', vk: 0x2c, scan: 0x37, ext: true, vkMode: false });
    // Media / volume keys go in by virtual key (extended).
    assert.deepEqual(resolveKeyCode('AudioVolumeMute'), { code: 'AudioVolumeMute', vk: 0xad, scan: 0x20, ext: true, vkMode: true });
    assert.deepEqual(resolveKeyCode('MediaPlayPause'), { code: 'MediaPlayPause', vk: 0xb3, scan: 0x22, ext: true, vkMode: true });
    assert.throws(() => resolveKeyCode('KeyÄ'), { message: 'unknown key code: KeyÄ' });
    assert.throws(() => resolveKeyCode('constructor'), { message: 'unknown key code: constructor' });
    assert.throws(() => resolveKeyCode(5), /unknown key code/);
  });

  test('every KeyboardEvent.code listed in PROTOCOL §8.1 is mapped with valid VK/scan values', () => {
    const listed = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
      ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      'Enter', 'Escape', 'Backspace', 'Tab', 'Space', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
      'IntlBackslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'CapsLock', 'ShiftLeft',
      'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu',
      'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'PrintScreen', 'ScrollLock', 'Pause', 'NumLock',
      ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
      'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
      'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious',
      'MediaStop',
    ];
    const scans = new Map();
    for (const code of listed) {
      assert.ok(KEY_CODES.includes(code), `${code} is mapped`);
      const k = resolveKeyCode(code);
      assert.ok(Number.isInteger(k.vk) && k.vk > 0 && k.vk <= 0xfe, `${code} vk`);
      assert.ok(Number.isInteger(k.scan) && k.scan > 0 && k.scan <= 0xff, `${code} scan`);
      const id = `${k.ext ? 'e0' : ''}${k.scan}`;
      if (!k.vkMode) {
        assert.ok(!scans.has(id), `${code} shares scan code ${id} with ${scans.get(id)}`);
        scans.set(id, code);
      }
    }
    // Extended per the task list: arrows, nav block, right Ctrl/Alt, NumpadEnter/Divide, Meta, ContextMenu, PrintScreen.
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp',
      'PageDown', 'ControlRight', 'AltRight', 'NumpadEnter', 'NumpadDivide', 'MetaLeft', 'MetaRight', 'ContextMenu',
      'PrintScreen', 'AudioVolumeUp']) {
      assert.equal(resolveKeyCode(code).ext, true, `${code} is extended`);
    }
    for (const code of ['KeyQ', 'ShiftRight', 'ControlLeft', 'AltLeft', 'Enter', 'Numpad5', 'NumpadAdd', 'Space']) {
      assert.equal(resolveKeyCode(code).ext, false, `${code} is not extended`);
    }
  });

  test('virtualDesktop is the bounding box of all monitors', () => {
    const two = [
      { index: 0, x: 0, y: 0, width: 1920, height: 1080 },
      { index: 1, x: 1920, y: 0, width: 1920, height: 1080 },
    ];
    assert.deepEqual(virtualDesktop(two), { index: -1, name: 'All displays', x: 0, y: 0, width: 3840, height: 1080, primary: false });
    const odd = [
      { x: 0, y: 0, width: 2560, height: 1440 },
      { x: -1280, y: 200, width: 1280, height: 1024 },
    ];
    assert.deepEqual(
      (({ x, y, width, height }) => ({ x, y, width, height }))(virtualDesktop(odd)),
      { x: -1280, y: 0, width: 3840, height: 1440 },
    );
    assert.deepEqual(toDesktopPixels(virtualDesktop(two), 0.75, 0.5), { x: 2880, y: 540 });
    assert.deepEqual(toDesktopPixels(virtualDesktop(two), 1.7, -0.2), { x: 3839, y: 0 });
    assert.deepEqual(toDesktopPixels(virtualDesktop(two), 0.33333, 0.66667), { x: 1279, y: 720 });
  });

  test('encodeFrame encodes monitor -1 as 0xFFFF', () => {
    const f = encodeFrame(9, -1, Buffer.from([0xff, 0xd8]));
    assert.equal(f.readUInt16BE(5), 0xffff);
  });
});

describe('§8 streaming + input with a scripted helper (no real machine access)', () => {
  test('screen.meta precedes every frame; cursor-only moves send meta without a frame (same seq)', { timeout: 20_000 }, async () => {
    const fake = fakeHelper();
    const scr = createScreenHandlers({ config, log: quietLog, helper: fake, keepAliveMs: 60_000 });
    const client = fakeClient('meta-fake');
    try {
      const r = await scr.methods['screen.start']({ monitor: -1, fps: 15, maxWidth: 1920 }, client);
      assert.equal(r.fps, 15);
      assert.deepEqual([r.monitor.index, r.monitor.width, r.monitor.height], [-1, 3840, 1080]);
      assert.ok(await waitFor(() => client.frames.length >= 1, 5_000), 'first frame');
      assert.equal(client.frames[0].readUInt16BE(5), 0xffff, 'monitor -1 in the binary header');
      assert.deepEqual(client.metas[0], { seq: 1, monitor: -1, width: 1920, height: 540, cursor: { x: 0.25, y: 0.5, visible: true } });
      const grabs = fake.calls.filter((c) => c.op === 'grab');
      assert.equal(grabs[0].args.cursor, false, 'pointer is not drawn into streamed frames');

      // Static screen, pointer moves → meta only, same seq, no new frame.
      await scr.methods['screen.ack']({ seq: 1 }, client);
      fake.pointer = { x: 0.8, y: 0.1, visible: true };
      assert.ok(await waitFor(() => client.metas.length >= 2, 3_000), 'cursor-only meta');
      assert.equal(client.frames.length, 1, 'no frame for a cursor-only change');
      assert.deepEqual(client.metas[1], { seq: 1, monitor: -1, width: 1920, height: 540, cursor: { x: 0.8, y: 0.1, visible: true } });

      // Pointer leaves the captured area → cursor null.
      fake.pointer = null;
      assert.ok(await waitFor(() => client.metas.at(-1).cursor === null, 3_000), 'cursor null when outside');
      const metasNow = client.metas.length;
      await sleep(300);
      assert.equal(client.metas.length, metasNow, 'no repeated meta while nothing changes');

      // Screen changes → meta + frame with seq 2.
      fake.hash = 'h2';
      assert.ok(await waitFor(() => client.frames.length >= 2, 3_000), 'second frame');
      assert.equal(client.frames[1].readUInt32BE(1), 2);

      // Flow control: 2 un-acked frames → no more frames, but the pointer still moves (cursor op).
      fake.hash = 'h3';
      assert.ok(await waitFor(() => client.frames.length >= 3, 3_000), 'third frame');
      fake.hash = 'h4';
      await sleep(300);
      assert.equal(client.frames.length, 3, 'held at 2 in flight (seq 2 and 3)');
      fake.pointer = { x: 0.5, y: 0.5, visible: false };
      assert.ok(await waitFor(() => client.metas.at(-1).cursor?.x === 0.5, 3_000), 'cursor meta while blocked');
      assert.equal(client.metas.at(-1).seq, 3);
      assert.equal(client.metas.at(-1).cursor.visible, false);
      assert.ok(fake.calls.some((c) => c.op === 'cursor' && c.args.monitor === -1), 'cursor polled');
      assert.ok(!fake.calls.some((c) => c.op === 'cursor' && 'width' in c.args), 'helper resolves the current rect itself (no stale rect)');
      assertMetaOrdering(client, -1);
    } finally {
      await scr.dispose();
    }
  });

  test('keyraw / mouse buttons are tracked and released through the helper (input.releaseAll, screen.stop, close)', { timeout: 20_000 }, async () => {
    const fake = fakeHelper();
    const scr = createScreenHandlers({ config, log: quietLog, helper: fake });
    const client = fakeClient('held-fake');
    try {
      await withoutDryRun(async () => {
        await scr.methods['input.keyraw']({ code: 'ControlLeft', down: true }, client);
        await scr.methods['input.keyraw']({ code: 'ArrowLeft', down: true }, client);
        await scr.methods['input.keyraw']({ code: 'ArrowLeft', down: false }, client);
        await scr.methods['input.keyraw']({ code: 'ShiftRight', down: true }, client);
        await scr.methods['input.mouse']({ monitor: -1, x: 0.75, y: 0.5, action: 'down', button: 'left' }, client);
        const keyraws = fake.calls.filter((c) => c.op === 'keyraw').map((c) => c.args);
        assert.deepEqual(keyraws[0], { vk: 0xa2, scan: 0x1d, ext: false, vkMode: false, up: false });
        assert.deepEqual(keyraws[1], { vk: 0x25, scan: 0x4b, ext: true, vkMode: false, up: false });
        assert.deepEqual(keyraws[2], { vk: 0x25, scan: 0x4b, ext: true, vkMode: false, up: true });
        const mouse = fake.calls.find((c) => c.op === 'mouse').args;
        assert.deepEqual(mouse, { x: 2880, y: 540, action: 'down', button: 'left', delta: 0, deltaX: 0 });
        assert.deepEqual(scr.heldInput(client), { keys: ['ControlLeft', 'ShiftRight'], buttons: ['left'] });

        await scr.methods['input.releaseAll']({}, client);
        const rel = fake.calls.filter((c) => c.op === 'release');
        assert.equal(rel.length, 1);
        assert.deepEqual(rel[0].args, {
          keys: [
            { vk: 0xa1, scan: 0x36, ext: false, vkMode: false },  // reverse press order
            { vk: 0xa2, scan: 0x1d, ext: false, vkMode: false },
          ],
          buttons: ['left'],
        });
        assert.deepEqual(scr.heldInput(client), { keys: [], buttons: [] });

        // screen.stop releases too.
        await scr.methods['input.keyraw']({ code: 'AltLeft', down: true }, client);
        await scr.methods['screen.stop']({}, client);
        assert.deepEqual(fake.calls.filter((c) => c.op === 'release').at(-1).args.keys.map((k) => k.vk), [0xa4]);

        // Socket close releases (and nothing is sent when nothing is held).
        await scr.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'down', button: 'right' }, client);
        await scr.onClientClose(client);
        assert.deepEqual(fake.calls.filter((c) => c.op === 'release').at(-1).args, { keys: [], buttons: ['right'] });
        const before = fake.calls.length;
        await scr.onClientClose(client);
        assert.equal(fake.calls.length, before, 'nothing to release → no helper call');
      });
    } finally {
      await scr.dispose();
    }
  });

  test('a continuously changing screen streams at the requested fps (capture reuse never drops every other tick)', { timeout: 20_000 }, async () => {
    // Every grab takes ~35 ms (like a real full-HD encode) and returns a new picture. Regression: a cached
    // capture used to count as "fresh" for 0.75 × interval after it FINISHED, so at fps 10 every second tick
    // re-used the frame the client already had and sent nothing → 5 fps.
    const fake = fakeHelper();
    let n = 0;
    const changing = {
      async call(op, args) {
        if (op !== 'grab') return fake.call(op, args);
        await sleep(35);
        fake.hash = `h${++n}`;
        return fake.call(op, args);
      },
      async dispose() {},
    };
    const scr = createScreenHandlers({ config, log: quietLog, helper: changing, keepAliveMs: 60_000 });
    const client = fakeClient('fps');
    const origSend = client.sendBinary;
    client.sendBinary = (buf) => {
      origSend(buf);
      scr.methods['screen.ack']({ seq: buf.readUInt32BE(1) }, client);
    };
    try {
      await scr.methods['screen.start']({ monitor: 0, fps: 10, quality: 65, maxWidth: 1920 }, client);
      assert.ok(await waitFor(() => client.frames.length >= 1, 5_000), 'first frame');
      const f0 = client.frames.length;
      await sleep(2_000);
      const fps = (client.frames.length - f0) / 2;
      assert.ok(fps >= 8.5, `only ${fps} fps for a screen that changes every grab (want ~10)`);
    } finally {
      await scr.methods['screen.stop']({}, client);
      await scr.dispose();
    }
  });

  test('input of one client is executed in arrival order', async () => {
    const order = [];
    const fake = fakeHelper();
    const slowHelper = {
      async call(op, args) {
        if (op === 'monitors') return fake.call(op, args);
        await sleep(op === 'mouse' ? 30 : 0);
        order.push(op === 'keyraw' ? `${args.up ? 'up' : 'down'}` : op);
        return true;
      },
    };
    const scr = createScreenHandlers({ config, log: quietLog, helper: slowHelper });
    const client = fakeClient('order');
    await withoutDryRun(async () => {
      await scr.methods['screen.monitors']();
      await Promise.all([
        scr.methods['input.mouse']({ monitor: 0, x: 0.1, y: 0.1, action: 'down' }, client),
        scr.methods['input.keyraw']({ code: 'KeyC', down: true }, client),
        scr.methods['input.keyraw']({ code: 'KeyC', down: false }, client),
        scr.methods['input.mouse']({ monitor: 0, x: 0.1, y: 0.1, action: 'up' }, client),
      ]);
    });
    assert.deepEqual(order, ['mouse', 'down', 'up', 'mouse']);
    await scr.dispose();
  });
});

describe('windows helper + handlers', { skip: !isWindows && 'Windows only' }, () => {
  before(async () => {
    helper = createWinHelper({ log: quietLog });
    system = createSystemHandlers({ config, log: quietLog, helper });
    screen = createScreenHandlers({ config, log: quietLog, helper, keepAliveMs: 300 });
  });

  after(async () => {
    await screen?.dispose();
    await system?.dispose();
    await helper?.dispose();
  });

  test('helper starts and answers ping', { timeout: 60_000 }, async () => {
    const r = await helper.call('ping', {});
    assert.equal(r.pong, true);
    assert.ok(Number.isInteger(helper.pid));
  });

  test('unknown helper op is rejected', async () => {
    await assert.rejects(helper.call('definitelyNotAnOp', {}), /unknown op/);
  });

  test('monitors have sane bounds', async () => {
    const mons = await screen.methods['screen.monitors']({}, null);
    assert.ok(Array.isArray(mons) && mons.length >= 1, 'at least one monitor');
    mons.forEach((m, i) => {
      assert.equal(m.index, i);
      assert.equal(typeof m.name, 'string');
      for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(m[k]), `${k} integer`);
      assert.ok(m.width >= 320 && m.width <= 16384, 'width sane');
      assert.ok(m.height >= 200 && m.height <= 16384, 'height sane');
      assert.equal(typeof m.primary, 'boolean');
    });
    assert.equal(mons.filter((m) => m.primary).length, 1, 'exactly one primary');
    assert.equal(mons[0].primary, true, 'primary monitor is index 0');
    // Monitors must not overlap in virtual-desktop space.
    for (let i = 0; i < mons.length; i++) {
      for (let j = i + 1; j < mons.length; j++) {
        const a = mons[i];
        const b = mons[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.equal(overlap, false, `monitors ${i} and ${j} overlap`);
      }
    }
    // This machine (DISPLAY1 0,0 1920x1080 primary + DISPLAY2 1920,0 1920x1080) reports exactly 2.
    if (os.hostname() && mons.length !== 2) console.warn(`note: ${mons.length} monitor(s) attached (expected 2 on the dev PC)`);
  });

  test('grab returns a scaled JPEG; repeated grab can report unchanged', { timeout: 30_000 }, async () => {
    const g = await helper.call('grab', { monitor: 0, maxWidth: 640, quality: 40 });
    assert.ok(g.width <= 640 && g.width > 0, `width ${g.width} ≤ 640`);
    assert.ok(g.height > 0);
    assert.equal(g.unchanged, false);
    assert.equal(typeof g.hash, 'string');
    const jpeg = Buffer.from(g.data, 'base64');
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
    assert.equal(jpeg[jpeg.length - 2], 0xff, 'JPEG EOI');
    assert.equal(jpeg[jpeg.length - 1], 0xd9, 'JPEG EOI');

    const g2 = await helper.call('grab', { monitor: 0, maxWidth: 640, quality: 40, lastHash: g.hash });
    assert.equal(typeof g2.unchanged, 'boolean');
    if (g2.unchanged) {
      assert.equal(g2.hash, g.hash);
      assert.equal(g2.data, undefined, 'no image data when unchanged');
    } else {
      assert.ok(g2.data.length > 0);
    }
    // A bogus lastHash always yields data.
    const g3 = await helper.call('grab', { monitor: 0, maxWidth: 640, quality: 40, lastHash: 'nope' });
    assert.equal(g3.unchanged, false);
    assert.ok(g3.data.length > 0);
  });

  test('grab rejects a monitor that does not exist', async () => {
    await assert.rejects(helper.call('grab', { monitor: 99 }), /no such monitor/);
  });

  test('screen.snapshot returns base64 JPEG within maxWidth', { timeout: 30_000 }, async () => {
    const r = await screen.methods['screen.snapshot']({ monitor: 0, maxWidth: 400, quality: 30 }, null);
    assert.equal(r.mime, 'image/jpeg');
    assert.ok(r.width <= 400);
    const jpeg = Buffer.from(r.data, 'base64');
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  });

  test('procs / proc.list include this node process', { timeout: 30_000 }, async () => {
    const raw = await helper.call('procs', {});
    assert.ok(raw.some((p) => p.pid === process.pid), 'raw procs include node');

    const list = await system.methods['proc.list']({ sort: 'name', limit: 10_000 }, null);
    const me = list.find((p) => p.pid === process.pid);
    assert.ok(me, 'proc.list includes node');
    assert.match(me.name, /^node/i);
    assert.equal(typeof me.memMB, 'number');
    assert.ok(me.memMB > 1);
    assert.equal(typeof me.cpuSec, 'number');
    assert.equal(typeof me.title, 'string');

    const top = await system.methods['proc.list']({}, null);
    assert.ok(top.length <= 150, 'default limit 150');
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].memMB >= top[i].memMB, 'sorted by mem desc');

    const byCpu = await system.methods['proc.list']({ sort: 'cpu', limit: 5 }, null);
    assert.equal(byCpu.length, 5);
    for (let i = 1; i < byCpu.length; i++) assert.ok(byCpu[i - 1].cpuSec >= byCpu[i].cpuSec);

    await assert.rejects(system.methods['proc.list']({ sort: 'bogus' }, null), /invalid params/);
    await assert.rejects(system.methods['proc.list']({ limit: 0 }, null), /invalid params/);
  });

  test('clipboard round-trip restores the user clipboard', { timeout: 30_000 }, async (t) => {
    const original = await helper.call('clipGet', {});
    // Only text-like formats can be restored faithfully; never destroy an image / files / rich text.
    const restorable = /^(UnicodeText|Text|OEMText|Locale|System\.String|CanIncludeInClipboardHistory|CanUploadToCloudClipboard|ExcludeClipboardContentFromMonitorProcessing|Chromium internal source .*)$/;
    const unsafe = (original.formats || []).filter((f) => !restorable.test(f));
    if (unsafe.length) {
      t.skip(`clipboard holds non-text data (${unsafe.slice(0, 3).join(', ')}); not touching it`);
      return;
    }
    const probe = `TermPocket test ✓ ${Date.now()} — مرحبا 😀\r\nline 2`;
    const originalText = original.hasText ? original.text : '';
    // Clipboard managers / the live desktop may touch the clipboard concurrently: re-read briefly before failing.
    const readUntil = async (expected) => {
      let r;
      for (let i = 0; i < 10; i++) {
        r = await helper.call('clipGet', {});
        if (r.text === expected) break;
        await sleep(100);
      }
      return r;
    };
    try {
      assert.equal(await helper.call('clipSet', { text: probe }), true);
      const viaHelper = await readUntil(probe);
      assert.equal(viaHelper.text, probe, 'clipGet returns what clipSet wrote');
      assert.equal(viaHelper.hasText, true);
      const viaHandler = await system.methods['clip.get']({}, null);
      assert.deepEqual(viaHandler, { text: probe });
    } finally {
      await helper.call('clipSet', { text: originalText });
    }
    const restored = await readUntil(originalText);
    if (restored.text === probe) {
      await helper.call('clipSet', { text: originalText }); // one more attempt before failing
      assert.fail('the user clipboard text was not restored');
    } else if (restored.text !== originalText) {
      t.diagnostic('clipboard changed by another application during the test; restore not verifiable');
    }
  });

  test('sys.info fields', { timeout: 30_000 }, async () => {
    const info = await system.methods['sys.info']({}, null);
    assert.equal(info.hostname, os.hostname());
    for (const k of ['user', 'os', 'release', 'arch', 'cpuModel']) assert.equal(typeof info[k], 'string', k);
    for (const k of ['uptimeSec', 'cpuCount', 'memTotal', 'memFree']) assert.ok(Number.isFinite(info[k]) && info[k] >= 0, k);
    assert.ok(info.cpuCount >= 1);
    assert.ok(info.cpuLoad >= 0 && info.cpuLoad <= 100, `cpuLoad ${info.cpuLoad}`);
    assert.ok(info.memTotal >= info.memFree);
    assert.ok(info.battery === null || (typeof info.battery.percent === 'number' && typeof info.battery.charging === 'boolean'));
    assert.ok(Array.isArray(info.ips));
    for (const ip of info.ips) assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!info.ips.includes('127.0.0.1'));
    assert.ok(Array.isArray(info.monitors) && info.monitors.length >= 1);
  });

  test('screen.start streams correctly framed frames and respects acks', { timeout: 60_000 }, async () => {
    const client = fakeClient('stream-1');
    const r = await screen.methods['screen.start']({ monitor: 0, fps: 50, quality: 5, maxWidth: 99999 }, client);
    // Clamped to the protocol limits.
    assert.equal(r.fps, 15);
    assert.equal(r.quality, 10);
    assert.equal(r.maxWidth, 3840);
    assert.equal(r.monitor.index, 0);

    assert.ok(await waitFor(() => client.frames.length >= 1, 15_000), 'received a first frame');
    const seq1 = assertFrame(client.frames[0], 0);
    assert.equal(seq1, 1);

    // Without acks, at most 2 frames may be in flight (keep-alive is 300 ms here, so more would come).
    await sleep(1500);
    assert.equal(client.frames.length, 2, 'flow control holds at 2 un-acked frames');
    const seq2 = assertFrame(client.frames[1], 0);
    assert.equal(seq2, 2);

    // Ack both → streaming resumes (keep-alive guarantees a frame even on a static screen).
    await screen.methods['screen.ack']({ seq: seq2 }, client);
    assert.ok(await waitFor(() => client.frames.length >= 3, 10_000), 'stream resumed after ack');
    assertFrame(client.frames[2], 0);
    await assert.rejects(screen.methods['screen.ack']({ seq: 'x' }, client), /invalid params/);

    // Settings update on the same client (monitor 1 if present).
    const mons = await screen.methods['screen.monitors']({}, null);
    const target = mons.length > 1 ? 1 : 0;
    const before = client.frames.length;
    await screen.methods['screen.ack']({ seq: client.frames.at(-1).readUInt32BE(1) }, client);
    const r2 = await screen.methods['screen.start']({ monitor: target, maxWidth: 640 }, client);
    assert.equal(r2.monitor.index, target);
    assert.equal(r2.fps, 15, 'unspecified settings keep the previous value');
    assert.equal(r2.maxWidth, 640);
    assert.ok(await waitFor(() => client.frames.slice(before).some((f) => f.readUInt16BE(5) === target), 10_000));
    assert.equal(screen.activeStreams, 1);

    // screen.stop stops the stream.
    assert.equal(await screen.methods['screen.stop']({}, client), true);
    assert.equal(screen.activeStreams, 0);
    await sleep(400);
    const count = client.frames.length;
    await sleep(800);
    assert.equal(client.frames.length, count, 'no frames after screen.stop');
  });

  test('two clients share captures; onClientClose stops a stream; default settings from config', { timeout: 60_000 }, async () => {
    const a = fakeClient('a');
    const b = fakeClient('b');
    const ra = await screen.methods['screen.start']({}, a);
    assert.deepEqual([ra.fps, ra.quality, ra.maxWidth, ra.monitor.index], [2, 50, 1280, 0]);
    await screen.methods['screen.start']({}, b);
    assert.ok(await waitFor(() => a.frames.length >= 1 && b.frames.length >= 1, 15_000));
    assertFrame(a.frames[0], 0);
    assertFrame(b.frames[0], 0);
    assert.equal(screen.activeStreams, 2);

    screen.onClientClose(a);
    assert.equal(screen.activeStreams, 1);
    // A client whose socket reports closed is dropped on the next tick.
    b.close();
    assert.ok(await waitFor(() => screen.activeStreams === 0, 5_000));
  });

  test('DRY RUN input.mouse resolves normalized coords to desktop pixels', async () => {
    const mons = await screen.methods['screen.monitors']({}, null);
    const idx = mons.length - 1;
    const m = mons[idx];
    await screen.methods['input.mouse']({ monitor: idx, x: 0.5, y: 0.5, action: 'click' }, null);
    const e = lastDryRun('input.mouse');
    assert.ok(e, 'recorded');
    assert.deepEqual(
      { x: e.resolved.x, y: e.resolved.y },
      { x: m.x + Math.floor(m.width / 2), y: m.y + Math.floor(m.height / 2) },
    );
    assert.equal(e.resolved.button, 'left');
    if (idx === 1 && m.x === 1920 && m.y === 0 && m.width === 1920 && m.height === 1080) {
      assert.deepEqual([e.resolved.x, e.resolved.y], [2880, 540]);
    }

    await screen.methods['input.mouse']({ monitor: 0, x: 2, y: -1, action: 'scroll', delta: -3 }, null);
    const s = lastDryRun('input.mouse');
    assert.deepEqual([s.resolved.x, s.resolved.y, s.resolved.delta], [mons[0].x + mons[0].width - 1, mons[0].y, -3]);

    await screen.methods['input.mouse']({ monitor: 0, x: 0.1, y: 0.1, action: 'down', button: 'right' }, null);
    assert.equal(lastDryRun('input.mouse').resolved.button, 'right');

    await assert.rejects(screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'jump' }, null), /invalid params/);
    await assert.rejects(screen.methods['input.mouse']({ monitor: 0, x: '1', y: 0.5, action: 'move' }, null), /invalid params/);
    await assert.rejects(screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'scroll' }, null), /delta/);
    await assert.rejects(screen.methods['input.mouse']({ monitor: 42, x: 0.5, y: 0.5, action: 'move' }, null), /no such monitor/);
  });

  test('DRY RUN input.key / input.text', async () => {
    await screen.methods['input.key']({ key: 'F5', mods: ['ctrl', 'shift'] }, null);
    assert.deepEqual(lastDryRun('input.key').resolved, { vk: 0x74, mods: [0x11, 0x10] });
    await screen.methods['input.key']({ key: 'Escape' }, null);
    assert.deepEqual(lastDryRun('input.key').resolved, { vk: 0x1b, mods: [] });
    await assert.rejects(screen.methods['input.key']({ key: 'Bogus' }, null), /unknown key/);

    await screen.methods['input.text']({ text: 'héllo 😀\nworld' }, null);
    assert.equal(lastDryRun('input.text').resolved.text, 'héllo 😀\nworld');
    await assert.rejects(screen.methods['input.text']({ text: 5 }, null), /invalid params/);
  });

  test('DRY RUN power / proc.kill / sys.open / clip.set', async () => {
    for (const action of ['lock', 'sleep', 'hibernate', 'shutdown', 'restart', 'logoff', 'cancel']) {
      assert.equal(await system.methods.power({ action }, null), true);
      const e = lastDryRun('power');
      assert.equal(e.resolved.action, action);
    }
    const hibernate = dryRunLog.filter((e) => e.method === 'power' && e.resolved.action === 'hibernate').at(-1);
    assert.match(hibernate.resolved.file, /shutdown\.exe$/i);
    assert.deepEqual(hibernate.resolved.args, ['/h']);
    const shutdown = dryRunLog.filter((e) => e.method === 'power' && e.resolved.action === 'shutdown').at(-1);
    assert.match(shutdown.resolved.file, /shutdown\.exe$/i);
    assert.deepEqual(shutdown.resolved.args.slice(0, 3), ['/s', '/t', '30']);
    const cancel = lastDryRun('power');
    assert.deepEqual(cancel.resolved.args, ['/a']);
    await assert.rejects(system.methods.power({ action: 'explode' }, null), /invalid params/);
    await assert.rejects(system.methods.power({}, null), /invalid params/);

    assert.equal(await system.methods['proc.kill']({ pid: 999_999, force: true }, null), true);
    assert.deepEqual(lastDryRun('proc.kill').resolved, { pid: 999_999, force: true });
    await assert.rejects(system.methods['proc.kill']({ pid: 1.5 }, null), /invalid params/);
    await assert.rejects(system.methods['proc.kill']({ pid: '12' }, null), /invalid params/);
    await assert.rejects(system.methods['proc.kill']({ pid: process.pid }, null), /refusing/);
    await assert.rejects(system.methods['proc.kill']({ pid: 4 }, null), /refusing/);

    assert.equal(await system.methods['sys.open']({ target: '  https://example.com  ' }, null), true);
    assert.deepEqual(lastDryRun('sys.open').resolved, { target: 'https://example.com' });
    await assert.rejects(system.methods['sys.open']({ target: '' }, null), /invalid params/);
    await assert.rejects(system.methods['sys.open']({ target: 'a\u0000b' }, null), /invalid params/);

    assert.equal(await system.methods['clip.set']({ text: 'dry' }, null), true);
    assert.deepEqual(lastDryRun('clip.set').resolved, { length: 3 });
    await assert.rejects(system.methods['clip.set']({}, null), /invalid params/);
  });

  test('helper kill terminates a process this test spawned; refuses protected targets', { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      assert.ok(Number.isInteger(child.pid));
      // Not forced: a windowless process cannot be asked to close, so it is terminated.
      assert.equal(await helper.call('kill', { pid: child.pid, force: false }), true);
      const r = await Promise.race([exited, sleep(5000).then(() => null)]);
      assert.ok(r, 'child exited');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await assert.rejects(helper.call('kill', { pid: helper.pid, force: true }), /refusing/);
    await assert.rejects(helper.call('kill', { pid: 4, force: true }), /refusing/);
    await assert.rejects(helper.call('kill', { pid: 2_000_000_000, force: true }), /no such process/);
    // open validates its target before touching the shell.
    await assert.rejects(helper.call('open', { target: '   ' }), /target is required/);
  });

  // ------------------------------------------------------------------------------------------- §8 (v0.2)

  test('§8 grab of monitor -1 covers the whole virtual desktop, scaled to maxWidth', { timeout: 30_000 }, async () => {
    const mons = await screen.methods['screen.monitors']({}, null);
    const vd = virtualDesktop(mons);
    for (const maxWidth of [1920, 3840]) {
      const g = await helper.call('grab', { monitor: -1, maxWidth, quality: 40, cursor: false });
      const width = Math.min(maxWidth, vd.width);
      assert.equal(g.monitor, -1);
      assert.deepEqual([g.x, g.y, g.srcWidth, g.srcHeight], [vd.x, vd.y, vd.width, vd.height], 'captured rect = bounding box');
      assert.deepEqual([g.width, g.height], [width, Math.round((vd.height * width) / vd.width)]);
      const size = jpegSize(Buffer.from(g.data, 'base64'));
      assert.deepEqual(size, { width: g.width, height: g.height }, 'JPEG has the reported size');
      assert.ok(g.pointer === null || (g.pointer.x >= 0 && g.pointer.x <= 1 && typeof g.pointer.visible === 'boolean'));
      if (vd.width === 3840 && vd.height === 1080) {
        // The dev PC: two 1920×1080 monitors side by side.
        assert.deepEqual([g.width, g.height], maxWidth === 1920 ? [1920, 540] : [3840, 1080]);
      }
    }
    const c = await helper.call('cursor', { monitor: -1 });
    assert.equal(c.monitor, -1);
    assert.ok(c.pointer === null || typeof c.pointer.visible === 'boolean');
  });

  test('§8 screen.start monitor -1 streams meta+frame pairs (0xFFFF header, matching seq and size)', { timeout: 60_000 }, async () => {
    const client = fakeClient('vd-stream');
    try {
      const r = await screen.methods['screen.start']({ monitor: -1, fps: 15, quality: 40, maxWidth: 1920 }, client);
      const mons = await screen.methods['screen.monitors']({}, null);
      const vd = virtualDesktop(mons);
      assert.deepEqual(r.monitor, vd);
      assert.equal(r.fps, 15);
      assert.ok(await waitFor(() => client.frames.length >= 2, 15_000), 'two frames (keep-alive 300 ms)');
      await screen.methods['screen.ack']({ seq: client.frames.at(-1).readUInt32BE(1) }, client);
      assert.ok(await waitFor(() => client.frames.length >= 3, 10_000), 'third frame after ack');
      for (const f of client.frames) assertFrame(f, 0xffff);
      assertMetaOrdering(client, -1);
      assert.equal(client.metas[0].width, Math.min(1920, vd.width));
    } finally {
      await screen.methods['screen.stop']({}, client);
    }
    assert.equal(screen.activeStreams, 0);
  });

  test('§8 DRY RUN input.keyraw resolves codes; input.releaseAll releases what this client holds', async () => {
    const c = fakeClient('keyraw');
    const other = fakeClient('keyraw-other');
    const samples = [
      ['KeyA', { vk: 0x41, scan: 0x1e, ext: false }],
      ['ArrowLeft', { vk: 0x25, scan: 0x4b, ext: true }],
      ['ControlRight', { vk: 0xa3, scan: 0x1d, ext: true }],
      ['NumpadEnter', { vk: 0x0d, scan: 0x1c, ext: true }],
      ['MetaLeft', { vk: 0x5b, scan: 0x5b, ext: true }],
    ];
    for (const [code, want] of samples) {
      assert.equal(await screen.methods['input.keyraw']({ code, down: true }, c), true);
      const e = lastDryRun('input.keyraw');
      assert.deepEqual(e.resolved, { code, ...want, vkMode: false, up: false }, code);
    }
    await screen.methods['input.keyraw']({ code: 'KeyA', down: false }, c);
    assert.equal(lastDryRun('input.keyraw').resolved.up, true);
    await screen.methods['input.keyraw']({ code: 'ShiftLeft', down: true }, other);
    await screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'down', button: 'middle' }, c);
    assert.deepEqual(screen.heldInput(c), { keys: ['ArrowLeft', 'ControlRight', 'NumpadEnter', 'MetaLeft'], buttons: ['middle'] });

    await assert.rejects(screen.methods['input.keyraw']({ code: 'NotAKey', down: true }, c), { message: 'unknown key code: NotAKey' });
    await assert.rejects(screen.methods['input.keyraw']({ code: 'KeyA' }, c), /invalid params: down/);
    await assert.rejects(screen.methods['input.keyraw']({ down: true }, c), /invalid params: code/);

    assert.equal(await screen.methods['input.releaseAll']({}, c), true);
    const rel = lastDryRun('input.releaseAll');
    assert.deepEqual(rel.resolved.keys, ['MetaLeft', 'NumpadEnter', 'ControlRight', 'ArrowLeft'], 'reverse press order');
    assert.deepEqual(rel.resolved.buttons, ['middle']);
    assert.deepEqual(screen.heldInput(c), { keys: [], buttons: [] });
    assert.deepEqual(screen.heldInput(other).keys, ['ShiftLeft'], "another client's keys are untouched");
    // Nothing held → still answers true (and records an empty release).
    assert.equal(await screen.methods['input.releaseAll']({}, c), true);
    assert.deepEqual(lastDryRun('input.releaseAll').resolved.keys, []);
    await screen.onClientClose(other);
  });

  test('§8 held keys/buttons are auto-released on client close and on screen.stop (dry run)', { timeout: 30_000 }, async () => {
    const c = fakeClient('auto-release');
    await screen.methods['input.keyraw']({ code: 'AltLeft', down: true }, c);
    await screen.methods['input.keyraw']({ code: 'Tab', down: true }, c);
    await screen.methods['input.mouse']({ monitor: 0, x: 0.2, y: 0.2, action: 'down', button: 'left' }, c);
    const mark = dryRunLog.length;
    await screen.onClientClose(c);
    const rel = dryRunLog.slice(mark).filter((e) => e.method === 'input.releaseAll');
    assert.equal(rel.length, 1, 'one automatic release');
    assert.deepEqual(rel[0].resolved, { keys: ['Tab', 'AltLeft'], buttons: ['left'], reason: 'client closed' });
    assert.deepEqual(screen.heldInput(c), { keys: [], buttons: [] });

    // Closing again (nothing held) records nothing.
    const mark2 = dryRunLog.length;
    await screen.onClientClose(c);
    assert.equal(dryRunLog.slice(mark2).filter((e) => e.method === 'input.releaseAll').length, 0);

    // screen.stop releases as well.
    const s = fakeClient('auto-release-stop');
    await screen.methods['screen.start']({ monitor: 0, maxWidth: 640, quality: 30 }, s);
    await screen.methods['input.keyraw']({ code: 'ShiftLeft', down: true }, s);
    await screen.methods['screen.stop']({}, s);
    const stopRel = lastDryRun('input.releaseAll');
    assert.deepEqual(stopRel.resolved, { keys: ['ShiftLeft'], buttons: [], reason: 'screen.stop' });
    assert.equal(screen.activeStreams, 0);
  });

  test('§8 DRY RUN input.mouse: deltaX passthrough, monitor -1, fractional clamp', async () => {
    const mons = await screen.methods['screen.monitors']({}, null);
    const vd = virtualDesktop(mons);
    await screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'scroll', delta: 1, deltaX: -2.5 }, null);
    let e = lastDryRun('input.mouse');
    assert.deepEqual([e.resolved.delta, e.resolved.deltaX], [1, -2.5]);
    await screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'scroll', deltaX: 3 }, null);
    e = lastDryRun('input.mouse');
    assert.deepEqual([e.resolved.delta, e.resolved.deltaX], [0, 3], 'horizontal-only scroll');
    await assert.rejects(screen.methods['input.mouse']({ monitor: 0, x: 0.5, y: 0.5, action: 'scroll', deltaX: 'x' }, null), /deltaX/);

    await screen.methods['input.mouse']({ monitor: -1, x: 0.75, y: 0.5, action: 'move' }, null);
    e = lastDryRun('input.mouse');
    assert.equal(e.resolved.monitor, -1);
    assert.deepEqual([e.resolved.x, e.resolved.y], [vd.x + Math.floor(0.75 * vd.width), vd.y + Math.floor(0.5 * vd.height)]);
    if (vd.width === 3840 && vd.height === 1080 && vd.x === 0 && vd.y === 0) assert.deepEqual([e.resolved.x, e.resolved.y], [2880, 540]);

    await screen.methods['input.mouse']({ monitor: -1, x: 1.25, y: -0.5, action: 'move' }, null);
    e = lastDryRun('input.mouse');
    assert.deepEqual([e.resolved.x, e.resolved.y], [vd.x + vd.width - 1, vd.y], 'clamped to the desktop');
    await screen.methods['input.mouse']({ monitor: 0, x: 0.123456, y: 0.987654, action: 'move' }, null);
    e = lastDryRun('input.mouse');
    assert.deepEqual([e.resolved.x, e.resolved.y], [mons[0].x + Math.floor(0.123456 * mons[0].width), mons[0].y + Math.floor(0.987654 * mons[0].height)]);
    await assert.rejects(screen.methods['input.mouse']({ monitor: -2, x: 0.5, y: 0.5, action: 'move' }, null), /invalid params/);
  });

  test('§8 helper keyraw/release validate their arguments (no input is injected)', async () => {
    // Only argument errors and empty batches: these never reach SendInput.
    await assert.rejects(helper.call('keyraw', { vk: 0, scan: 0, up: true }), /needs vk or scan/);
    await assert.rejects(helper.call('keyraw', { vk: 0x41, scan: 0x1ff, up: true }), /bad scan code/);
    await assert.rejects(helper.call('release', { keys: [], buttons: ['bogus'] }), /bad button/);
    await assert.rejects(helper.call('release', { keys: [5] }), /keys must be objects/);
    assert.equal(await helper.call('release', { keys: [], buttons: [] }), true);
  });

  test('§8 performance: HD stream (fps 10, maxWidth 1920, quality 65) through the helper', { timeout: 60_000 }, async (t) => {
    // A client that acks every frame as soon as it arrives (like a fast LAN client).
    const perf = createScreenHandlers({ config, log: quietLog, helper, keepAliveMs: 0 });
    const results = [];
    try {
      for (const monitor of [0, -1]) {
        const c = fakeClient(`perf-${monitor}`);
        const origSend = c.sendBinary;
        c.sendBinary = (buf) => {
          origSend.call(c, buf);
          perf.methods['screen.ack']({ seq: buf.readUInt32BE(1) }, c);
        };
        await perf.methods['screen.start']({ monitor, fps: 10, quality: 65, maxWidth: 1920 }, c);
        await waitFor(() => c.frames.length >= 1, 10_000);
        const start = Date.now();
        const n0 = c.frames.length;
        await sleep(3000);
        const n = c.frames.length - n0;
        const secs = (Date.now() - start) / 1000;
        const bytes = c.frames.slice(n0).reduce((s, f) => s + f.length, 0);
        await perf.methods['screen.stop']({}, c);
        results.push({ monitor, fps: n / secs, avgKB: bytes / Math.max(1, n) / 1024 });
      }
    } finally {
      await perf.dispose();
    }
    for (const r of results) {
      t.diagnostic(`stream monitor ${r.monitor}: ${r.fps.toFixed(1)} fps, avg frame ${r.avgKB.toFixed(0)} KB`);
    }
    // Worst case per frame: the screen changed, so capture + hash + scale + JPEG encode all run.
    for (const monitor of [0, -1]) {
      let total = 0;
      let bytes = 0;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const g = await helper.call('grab', { monitor, maxWidth: 1920, quality: 65, cursor: false });
        total += performance.now() - t0;
        bytes += Buffer.byteLength(g.data, 'base64');
      }
      const avg = total / n;
      t.diagnostic(`full-encode grab monitor ${monitor} @1920 q65: ${avg.toFixed(1)} ms/frame (max ${(1000 / avg).toFixed(1)} fps), ${(bytes / n / 1024).toFixed(0)} KB`);
      if (monitor === 0) assert.ok(avg < 100, `a changed 1920-wide frame takes < 100 ms (got ${avg.toFixed(1)})`);
    }
    // keepAliveMs 0 forces a frame every tick, so this measures the full capture+encode pipeline.
    assert.ok(results[0].fps >= 8, `monitor 0 sustains ~10 fps at 1920 (got ${results[0].fps.toFixed(1)})`);
  });

  test('helper auto-restarts after it dies', { timeout: 60_000 }, async () => {
    const oldPid = helper.pid;
    assert.ok(oldPid);
    process.kill(oldPid); // a process this test suite started itself
    assert.ok(await waitFor(() => !helper.running, 5_000), 'helper noticed the exit');
    const r = await helper.call('ping', {});
    assert.equal(r.pong, true);
    assert.notEqual(helper.pid, oldPid);
  });
});

describe('§8 races: queued input vs close/stop, stop during start', () => {
  /** fakeHelper whose `mouse` op takes `mouseMs` and whose `monitors` op waits for `gate` (if set). */
  function slowFake(mouseMs = 80) {
    const fake = fakeHelper();
    const inner = fake.call.bind(fake);
    fake.gate = null;
    fake.call = async (op, args, opts) => {
      if (op === 'monitors' && fake.gate) await fake.gate;
      if (op === 'mouse') await sleep(mouseMs);
      return inner(op, args, opts);
    };
    return fake;
  }

  test('a key-down / button-down still queued when the socket closes is never injected', async () => {
    const fake = slowFake();
    const scr = createScreenHandlers({ config, log: quietLog, helper: fake });
    const client = fakeClient('queued-close');
    try {
      await withoutDryRun(async () => {
        await scr.methods['screen.monitors']();
        // Nothing held yet; a slow move is in progress, then a Ctrl-down and a button-down queue behind it.
        const pending = [
          scr.methods['input.mouse']({ monitor: 0, x: 0.2, y: 0.2, action: 'move' }, client),
          scr.methods['input.keyraw']({ code: 'ControlLeft', down: true }, client),
          scr.methods['input.mouse']({ monitor: 0, x: 0.2, y: 0.2, action: 'down', button: 'left' }, client),
        ];
        await sleep(10);
        await scr.onClientClose(client);
        await Promise.all(pending);
        await sleep(50);
      });
      assert.ok(!fake.calls.some((c) => c.op === 'keyraw'), 'queued key-down dropped');
      assert.ok(!fake.calls.some((c) => c.op === 'mouse' && c.args.action === 'down'), 'queued button-down dropped');
      assert.deepEqual(scr.heldInput(client), { keys: [], buttons: [] }, 'nothing recorded for the dead client');
    } finally {
      await scr.dispose();
    }
  });

  test('screen.stop with a key-down still queued: the down runs, then it is released', async () => {
    const fake = slowFake();
    const scr = createScreenHandlers({ config, log: quietLog, helper: fake });
    const client = fakeClient('queued-stop');
    try {
      await withoutDryRun(async () => {
        await scr.methods['screen.monitors']();
        const pending = [
          scr.methods['input.mouse']({ monitor: 0, x: 0.2, y: 0.2, action: 'move' }, client),
          scr.methods['input.keyraw']({ code: 'MetaLeft', down: true }, client),
        ];
        await sleep(10);
        await scr.methods['screen.stop']({}, client);
        await Promise.all(pending);
      });
      const ops = fake.calls.filter((c) => c.op === 'keyraw' || c.op === 'release').map((c) => c.op);
      assert.deepEqual(ops, ['keyraw', 'release'], 'release queued after the down');
      assert.deepEqual(fake.calls.find((c) => c.op === 'release').args.keys.map((k) => k.vk), [0x5b]);
      assert.deepEqual(scr.heldInput(client), { keys: [], buttons: [] });
    } finally {
      await scr.dispose();
    }
  });

  test('screen.stop while screen.start awaits the monitor lookup leaves no stream running', async () => {
    const fake = slowFake();
    let open;
    fake.gate = new Promise((r) => (open = r));
    const scr = createScreenHandlers({ config, log: quietLog, helper: fake });
    const client = fakeClient('stop-during-start');
    try {
      const start = scr.methods['screen.start']({ monitor: 0, fps: 10 }, client);
      await sleep(20);
      assert.equal(await scr.methods['screen.stop']({}, client), true);
      open();
      const r = await start;
      assert.equal(r.stopped, true, 'start reports it was cancelled');
      assert.equal(scr.activeStreams, 0);
      await sleep(300);
      assert.equal(client.frames.length, 0, 'no frames streamed');
      assert.ok(!fake.calls.some((c) => c.op === 'grab'), 'nothing captured');
      // A later start works normally.
      const r2 = await scr.methods['screen.start']({ monitor: 0, fps: 10 }, client);
      assert.equal(r2.stopped, undefined);
      assert.equal(scr.activeStreams, 1);
    } finally {
      await scr.dispose();
    }
  });
});

test('§8 after a monitor switch, no pointer-only meta until a frame for the new monitor was sent', { timeout: 20_000 }, async () => {
  const fake = fakeHelper();
  const scr = createScreenHandlers({ config, log: quietLog, helper: fake, keepAliveMs: 60_000 });
  const client = fakeClient('switch');
  try {
    await scr.methods['screen.start']({ monitor: 0, fps: 15 }, client);
    assert.ok(await waitFor(() => client.frames.length >= 1, 5_000), 'frame 1');
    fake.hash = 'h-switch-2';
    assert.ok(await waitFor(() => client.frames.length >= 2, 5_000), 'frame 2');
    // Two frames un-acked → flow control blocks; now switch to all displays and move the pointer.
    await scr.methods['screen.start']({ monitor: -1 }, client);
    fake.pointer = { x: 0.9, y: 0.9, visible: true };
    await sleep(400);
    assert.ok(!client.metas.some((m) => m.monitor === -1), 'no meta for monitor -1 before its first frame');
    // Ack → a frame for monitor -1 goes out (meta first), and pointer-only updates resume for it.
    await scr.methods['screen.ack']({ seq: 2 }, client);
    assert.ok(await waitFor(() => client.frames.length >= 3, 5_000), 'frame for monitor -1');
    assert.equal(client.frames[2].readUInt16BE(5), 0xffff);
    fake.pointer = { x: 0.1, y: 0.2, visible: true };
    assert.ok(await waitFor(() => client.metas.at(-1).cursor?.x === 0.1 && client.metas.at(-1).monitor === -1, 3_000), 'pointer meta for -1');
  } finally {
    await scr.dispose();
  }
});
