'use strict';

/**
 * Unit tests of the live view of ordinary VS Code terminals (src/live.js) and of the settings service
 * (src/settings.js), with `vscode` replaced by the in-memory mock and a fake connection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { install } = require('./vscode-mock');
const vscode = install();

const { LiveTerminals, RawRing, safeCut, escEnd, ATTACH_IDLE_MS, RAW_BATCH_MS } = require('../src/live');
const { SettingsService, MIRROR_PROFILE_TITLE } = require('../src/settings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.events = [];
    this.connected = true;
  }
  notify(ev, p) {
    if (!this.connected) return false;
    this.events.push({ ev, p });
    return true;
  }
  of(ev) {
    return this.events.filter((e) => e.ev === ev).map((e) => e.p);
  }
}

const log = { info() {}, warn() {}, error() {}, debug() {} };

function fakeTerminal(extra = {}) {
  return Object.assign(
    {
      name: 'pwsh',
      sent: [],
      shellIntegration: { cwd: undefined },
      dimensions: { columns: 120, rows: 30 },
      sendText(text, addNewLine = true) {
        this.sent.push({ text, addNewLine });
      },
    },
    extra
  );
}

/** A LiveTerminals over fake terminals, with a controllable clock. */
function setup({ ringCap, mirrors = new Set() } = {}) {
  const conn = new FakeConnection();
  const terms = new Map();
  let clock = 1_000_000;
  const live = new LiveTerminals({
    connection: conn,
    log,
    getTerminal: (tid) => {
      const t = terms.get(tid);
      if (!t) throw new Error(`unknown terminal: ${tid}`);
      return t;
    },
    ptyIdOf: (t) => (mirrors.has(t) ? 'p1' : null),
    ringCap: ringCap ? () => ringCap : undefined,
    now: () => clock,
  });
  live.start();
  // Not a restored terminal: pretend the extension started long ago.
  live.startedAt = clock - 60_000;
  const add = (tid, t = fakeTerminal(), opts) => {
    terms.set(tid, t);
    live.track(tid, t, opts);
    return t;
  };
  return {
    conn,
    live,
    add,
    advance: (ms) => (clock += ms),
    now: () => clock,
  };
}

// ---- ring ---------------------------------------------------------------------------------------

test('escEnd parses CSI, OSC (BEL / ST), charset and incomplete sequences', () => {
  assert.equal(escEnd('\x1b[1;31mX', 0), 7);
  assert.equal(escEnd('\x1b]0;title\x07X', 0), 10);
  assert.equal(escEnd('\x1b]633;C\x1b\\X', 0), 9);
  assert.equal(escEnd('\x1b(BX', 0), 3);
  assert.equal(escEnd('\x1b[1;3', 0), -1);
  assert.equal(escEnd('\x1b]0;never ends', 0), -1);
  assert.equal(escEnd('\x1b', 0), -1);
});

test('safeCut prefers a nearby line start, never splits an escape sequence or a surrogate pair', () => {
  // a newline shortly after the cut point → start right after it
  assert.equal(safeCut('aaaa\nbbbb', 2), 5);
  // already at a line start
  assert.equal(safeCut('aaaa\nbbbb', 5), 5);
  // no newline nearby: the cut lands inside "\x1b[38;5;196m" → moved past it
  const big = 'x'.repeat(9000);
  const s = big + '\x1b[38;5;196m' + big;
  const cut = safeCut(s, 9000 + 4);
  assert.equal(cut, 9000 + '\x1b[38;5;196m'.length);
  // cut inside an OSC string → moved past its terminator
  const o = big + '\x1b]8;;https://example.com/very/long\x1b\\' + big;
  assert.equal(safeCut(o, 9000 + 10), 9000 + '\x1b]8;;https://example.com/very/long\x1b\\'.length);
  // cut on the low half of a surrogate pair → moved one forward
  const e = big + '\u{1F600}' + big; // 😀 = 😀
  assert.equal(safeCut(e, 9001), 9002);
  // a complete sequence before the cut does not move it
  const c = big + '\x1b[0m' + big;
  assert.equal(safeCut(c, 9000 + 4 + 10), 9014);
});

test('RawRing keeps at most cap characters, trims from the front on a line boundary', () => {
  const ring = new RawRing(100);
  for (let i = 0; i < 50; i++) ring.append(`line ${String(i).padStart(2, '0')}\r\n`); // 9 chars each
  const snap = ring.snapshot();
  assert.ok(snap.length <= 100, `ring too long: ${snap.length}`);
  assert.ok(ring.trimmed);
  assert.match(snap, /^line \d\d\r\n/, 'starts at a line');
  assert.ok(snap.endsWith('line 49\r\n'), 'keeps the newest output');
  // amortized: the ring may grow to cap + cap/4 between snapshots, never more
  const r2 = new RawRing(100);
  for (let i = 0; i < 500; i++) {
    r2.append('abcdefg');
    assert.ok(r2.data.length <= 125);
  }
  assert.equal(new RawRing(100).snapshot(), '');
});

// ---- attach / stream / detach -------------------------------------------------------------------

test('attach returns the buffer + dims; term.raw is batched and only sent while attached', async () => {
  const { conn, live, add } = setup();
  const t = add('t1');
  live.executionStarted('t1');
  live.feed('t1', 'before attach\r\n');
  assert.equal(conn.of('term.raw').length, 0, 'nothing streamed while nobody is attached');

  const r = live.attach({ tid: 't1' });
  assert.deepEqual(
    { ...r },
    {
      tid: 't1',
      buffer: 'before attach\r\n',
      cols: 120,
      rows: 30,
      capturing: true,
      since: r.since,
      truncated: false,
      running: true,
      hasShellIntegration: true,
      isMirror: false,
      ptyId: null,
      aid: r.aid,
    }
  );
  assert.equal(typeof r.since, 'number');
  assert.match(r.aid, /^_[0-9]+$/, 'an attachment id is generated for a client that sends none');
  assert.equal(live.attachedCount('t1'), 1);

  live.feed('t1', 'a');
  live.feed('t1', 'b');
  live.feed('t1', 'c');
  assert.equal(conn.of('term.raw').length, 0, 'batched, not sent per chunk');
  await sleep(RAW_BATCH_MS + 40);
  assert.deepEqual(conn.of('term.raw'), [{ tid: 't1', d: 'abc' }]);

  // a second attach (another phone) gets everything so far, pending data flushed first (no overlap)
  live.feed('t1', 'd');
  const r2 = live.attach({ tid: 't1' });
  assert.equal(r2.buffer, 'before attach\r\nabcd');
  assert.deepEqual(conn.of('term.raw').map((x) => x.d), ['abc', 'd']);
  assert.equal(live.attachedCount('t1'), 2);

  assert.equal(live.detach({ tid: 't1' }), true);
  live.feed('t1', 'e');
  await sleep(RAW_BATCH_MS + 40);
  assert.deepEqual(conn.of('term.raw').map((x) => x.d), ['abc', 'd', 'e'], 'still streaming for the other phone');

  live.detach({ tid: 't1' });
  assert.equal(live.attachedCount('t1'), 0);
  live.feed('t1', 'f');
  await sleep(RAW_BATCH_MS + 40);
  assert.equal(conn.of('term.raw').length, 3, 'stopped after the last detach');
  assert.equal(live.attach({ tid: 't1' }).buffer, 'before attach\r\nabcdef', 'ring still fed while detached');
  live.detach({ tid: 't1' });
  assert.equal(live.detach({ tid: 't1' }), true, 'extra detach is harmless');
  assert.equal(live.attachedCount('t1'), 0);
  assert.equal(live.detach({ tid: 'gone' }), true, 'detach of a closed terminal is harmless');
  live.dispose();
});

test('large output is flushed early; ring trimming applies to the attach buffer', () => {
  const { conn, live, add } = setup({ ringCap: 1000 });
  add('t1');
  live.executionStarted('t1');
  live.attach({ tid: 't1' });
  live.feed('t1', 'z'.repeat(300 * 1024));
  assert.equal(conn.of('term.raw').length, 1, 'flushed at once above 256 K');
  const r = live.attach({ tid: 't1' });
  assert.equal(r.buffer.length, 1000);
  assert.equal(r.truncated, true);
  assert.match(r.note, /redraw/);
  live.dispose();
});

test('idle expiry: a lease of 10 minutes, renewed by keepalive / input / attach', () => {
  const { conn, live, add, advance } = setup();
  add('t1');
  const { aid } = live.attach({ tid: 't1' });
  assert.ok(live.tickTimer, 'ticker runs while attached');

  advance(ATTACH_IDLE_MS - 1000);
  live._tick();
  assert.equal(live.attachedCount('t1'), 1);
  assert.deepEqual(live.keepalive({ tid: 't1' }), { attached: true });

  advance(ATTACH_IDLE_MS - 1000);
  live._tick();
  assert.equal(live.attachedCount('t1'), 1, 'keepalive renewed the lease');
  live.input({ tid: 't1', d: 'x' });

  advance(ATTACH_IDLE_MS - 1000);
  live._tick();
  assert.equal(live.attachedCount('t1'), 1, 'input renewed the lease');

  advance(2000);
  live._tick();
  assert.equal(live.attachedCount('t1'), 0, 'expired');
  assert.deepEqual(conn.of('term.detached'), [{ tid: 't1', aid, reason: 'idle' }]);
  assert.equal(live.tickTimer, null, 'ticker stops when nothing is attached');
  assert.deepEqual(live.keepalive({ tid: 't1' }), { attached: false }, 'client learns it must re-attach');
  live.feed('t1', 'after expiry');
  assert.equal(conn.of('term.raw').length, 0);
  live.dispose();
});

test('attachment ids: a re-attach after a phone reconnect does not add a second attachment', async () => {
  const { conn, live, add } = setup();
  add('t1');
  live.executionStarted('t1');
  assert.equal(live.attach({ tid: 't1', aid: 'A1' }).aid, 'A1');
  // the phone lost its connection (no detach) and attaches again with the same id …
  live.attach({ tid: 't1', aid: 'A1' });
  assert.equal(live.attachedCount('t1'), 1);
  // … or with a new id that replaces the old one
  live.attach({ tid: 't1', aid: 'A2', replaces: 'A1' });
  assert.equal(live.attachedCount('t1'), 1);
  // one detach then really stops the stream
  live.detach({ tid: 't1', aid: 'A2' });
  assert.equal(live.attachedCount('t1'), 0);
  live.feed('t1', 'x');
  await sleep(RAW_BATCH_MS + 40);
  assert.equal(conn.of('term.raw').length, 0, 'nothing streamed once the only phone left');
  // detaching an unknown / already released id is harmless and does not touch other phones
  live.attach({ tid: 't1', aid: 'B' });
  live.detach({ tid: 't1', aid: 'A2' });
  live.detach({ tid: 't1', aid: 'A1' });
  assert.equal(live.attachedCount('t1'), 1);
  // keepalive per attachment
  assert.deepEqual(live.keepalive({ tid: 't1', aid: 'B' }), { attached: true });
  assert.deepEqual(live.keepalive({ tid: 't1', aid: 'A1' }), { attached: false });
  // a legacy detach (no aid) ends a generated (legacy) attachment first
  const legacy = live.attach({ tid: 't1' }).aid;
  assert.equal(live.attachedCount('t1'), 2);
  live.detach({ tid: 't1' });
  assert.deepEqual([...live.states.get('t1').leases.keys()], ['B']);
  assert.ok(legacy.startsWith('_'));
  // over-long ids are not accepted as given
  const long = 'x'.repeat(65);
  assert.notEqual(live.attach({ tid: 't1', aid: long }).aid, long);
  live.dispose();
});

test('idle expiry is per attachment: a crashed phone expires while a live one keeps streaming', async () => {
  const { conn, live, add, advance } = setup();
  add('t1');
  live.executionStarted('t1');
  live.attach({ tid: 't1', aid: 'dead' });
  advance(ATTACH_IDLE_MS / 2);
  live.attach({ tid: 't1', aid: 'alive' });
  advance(ATTACH_IDLE_MS / 2 + 1000);
  live.keepalive({ tid: 't1', aid: 'alive' });
  live._tick();
  assert.deepEqual(conn.of('term.detached'), [{ tid: 't1', aid: 'dead', reason: 'idle' }]);
  assert.equal(live.attachedCount('t1'), 1);
  live.feed('t1', 'still');
  await sleep(RAW_BATCH_MS + 40);
  assert.deepEqual(conn.of('term.raw').map((x) => x.d), ['still']);
  // input renews only the attachment that typed
  advance(ATTACH_IDLE_MS - 1000);
  live.input({ tid: 't1', d: 'x', aid: 'alive' });
  advance(2000);
  live._tick();
  assert.equal(live.attachedCount('t1'), 1);
  advance(ATTACH_IDLE_MS);
  live._tick();
  assert.equal(live.attachedCount('t1'), 0);
  assert.equal(live.tickTimer, null);
  live.dispose();
});

test('a size change first noticed by a new attach is still sent to the phones already attached', () => {
  const { conn, live, add } = setup();
  const t = add('t1');
  live.attach({ tid: 't1', aid: 'A' });
  t.dimensions = { columns: 77, rows: 22 };
  const r = live.attach({ tid: 't1', aid: 'B' });
  assert.equal(r.cols, 77);
  assert.deepEqual(conn.of('term.dims'), [{ tid: 't1', cols: 77, rows: 22 }]);
  live.dispose();
});

test('agent disconnect drops all attachments', () => {
  const { conn, live, add } = setup();
  add('t1');
  add('t2');
  live.attach({ tid: 't1' });
  live.attach({ tid: 't2' });
  conn.emit('disconnected');
  assert.equal(live.attachedCount('t1'), 0);
  assert.equal(live.attachedCount('t2'), 0);
  assert.equal(live.tickTimer, null);
  live.dispose();
});

test('terminals.input sends raw text without a newline', () => {
  const { live, add } = setup();
  const t = add('t1');
  assert.equal(live.input({ tid: 't1', d: 'ls\r' }), true);
  assert.equal(live.input({ tid: 't1', d: '\x03' }), true);
  assert.equal(live.input({ tid: 't1', d: '\x1b[A' }), true);
  assert.equal(live.input({ tid: 't1', d: '' }), true);
  assert.deepEqual(t.sent, [
    { text: 'ls\r', addNewLine: false },
    { text: '\x03', addNewLine: false },
    { text: '\x1b[A', addNewLine: false },
  ]);
  assert.throws(() => live.input({ tid: 't1' }), /parameter: d/);
  assert.throws(() => live.input({ tid: 'nope', d: 'x' }), /unknown terminal/);
  live.dispose();
});

test('term.dims on dimension changes (polled getter and the event when available)', () => {
  const { conn, live, add } = setup();
  const t = add('t1');
  live.feed('t1', 'x');
  // not attached: no event
  t.dimensions = { columns: 90, rows: 20 };
  live._tick();
  assert.equal(conn.of('term.dims').length, 0);

  const r = live.attach({ tid: 't1' });
  assert.equal(r.cols, 90);
  assert.equal(r.rows, 20);

  t.dimensions = { columns: 100, rows: 40 };
  live._tick();
  assert.deepEqual(conn.of('term.dims'), [{ tid: 't1', cols: 100, rows: 40 }]);
  live._tick();
  assert.equal(conn.of('term.dims').length, 1, 'only on change');

  // window.onDidChangeTerminalDimensions (proposed API; the mock provides it)
  vscode._fire('window.onDidChangeTerminalDimensions', { terminal: t, dimensions: { columns: 132, rows: 43 } });
  assert.deepEqual(conn.of('term.dims').at(-1), { tid: 't1', cols: 132, rows: 43 });

  // pending output is sent before the dims change
  live.feed('t1', 'old size');
  vscode._fire('window.onDidChangeTerminalDimensions', { terminal: t, dimensions: { columns: 80, rows: 24 } });
  const idxRaw = conn.events.findIndex((e) => e.ev === 'term.raw' && e.p.d === 'old size');
  const idxDims = conn.events.findIndex((e) => e.ev === 'term.dims' && e.p.cols === 80);
  assert.ok(idxRaw >= 0 && idxRaw < idxDims);

  // dimensions unavailable → null
  const t2 = add('t2', fakeTerminal({ dimensions: undefined }));
  const r2 = live.attach({ tid: 't2' });
  assert.equal(r2.cols, null);
  assert.equal(r2.rows, null);
  // a getter that throws is tolerated
  const t3 = fakeTerminal();
  Object.defineProperty(t3, 'dimensions', {
    get() {
      throw new Error('proposed');
    },
  });
  add('t3', t3);
  assert.equal(live.attach({ tid: 't3' }).cols, null);
  live.dispose();
  assert.ok(t2);
});

test('capturing + note: no shell integration, pre-existing terminal, mirror, empty', () => {
  const mirrors = new Set();
  const { live, add } = setup({ mirrors });

  const noSi = add('a', fakeTerminal({ shellIntegration: undefined }));
  let r = live.attach({ tid: 'a' });
  assert.equal(r.capturing, false);
  assert.equal(r.since, null);
  assert.match(r.note, /shell integration/);
  assert.ok(noSi);

  add('b', fakeTerminal(), { preexisting: true });
  r = live.attach({ tid: 'b' });
  assert.equal(r.capturing, false, 'a program may have been running before we watched');
  assert.match(r.note, /already running/);
  live.executionStarted('b');
  live.feed('b', 'new output');
  r = live.attach({ tid: 'b' });
  assert.equal(r.capturing, true, 'an execution seen since → capturing');
  assert.equal(r.note, undefined);

  add('c');
  r = live.attach({ tid: 'c' });
  assert.equal(r.capturing, true);
  assert.equal(r.buffer, '');
  assert.match(r.note, /Nothing captured yet/);

  const m = fakeTerminal({ shellIntegration: undefined });
  mirrors.add(m);
  add('m', m);
  r = live.attach({ tid: 'm' });
  assert.equal(r.isMirror, true);
  assert.equal(r.ptyId, 'p1');
  assert.equal(r.capturing, false);
  assert.equal(live.attachedCount('m'), 0, 'mirrors are not streamed from here');
  live.dispose();
});

test('a dim "$ <commandLine>" line precedes each execution; running flag', () => {
  const { live, add } = setup();
  add('t1');
  live.executionStarted('t1', 'npm test');
  live.feed('t1', 'progress 50%'); // no trailing newline
  let r = live.attach({ tid: 't1' });
  assert.equal(r.running, true);
  live.executionEnded('t1');
  live.executionStarted('t1', 'echo "a\nb"\x1b[31m');
  r = live.attach({ tid: 't1' });
  assert.equal(
    r.buffer,
    '\x1b[2m$ npm test\x1b[22m\r\nprogress 50%\r\n\x1b[2m$ echo "a ⏎ b"[31m\x1b[22m\r\n',
    'a newline is added when the previous output did not end with one; control characters are dropped'
  );
  live.executionEnded('t1');
  live.executionEnded('t1'); // never below zero
  live.executionStarted('t1', ''); // late / unknown command line: no synthetic line
  live.executionEnded('t1');
  r = live.attach({ tid: 't1' });
  assert.equal(r.running, false);
  assert.ok(r.buffer.endsWith('[31m\x1b[22m\r\n'));
  live.dispose();
});

test('terminals created by the extension are never treated as restored', () => {
  const conn = new FakeConnection();
  const t = fakeTerminal();
  const live = new LiveTerminals({ connection: conn, log, getTerminal: () => t, ptyIdOf: () => null });
  live.track('t1', t, { created: true });
  assert.equal(live.attach({ tid: 't1' }).capturing, true);
  live.dispose();
});

test('terminals restored right after start count as pre-existing', () => {
  const conn = new FakeConnection();
  const t = fakeTerminal();
  const live = new LiveTerminals({ connection: conn, log, getTerminal: () => t, ptyIdOf: () => null });
  live.track('t1', t);
  assert.equal(live.attach({ tid: 't1' }).capturing, false);
  live.dispose();
});

test('forget: a closed terminal stops streaming and frees its ring', async () => {
  const { conn, live, add } = setup();
  add('t1');
  live.attach({ tid: 't1' });
  live.feed('t1', 'x');
  live.forget('t1');
  await sleep(RAW_BATCH_MS + 40);
  assert.equal(conn.of('term.raw').length, 0);
  assert.equal(live.states.size, 0);
  assert.equal(live.tickTimer, null);
  live.dispose();
});

// ---- settings -----------------------------------------------------------------------------------

test('settings.mirrorDefault writes terminal.integrated.defaultProfile.* at ConfigurationTarget.Global', async () => {
  const conn = new FakeConnection();
  const store = new Map();
  const memento = { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) };
  const s = new SettingsService({ connection: conn, log, memento });
  s.start();
  const m = s.methods();
  const st = vscode._state;
  st.config = { 'terminal.integrated.defaultProfile.linux': 'zsh' };
  st.configUpdates = [];

  assert.deepEqual(m['settings.get'](), { mirrorDefault: false, mirrorProfile: MIRROR_PROFILE_TITLE });
  assert.deepEqual(await m['settings.mirrorDefault']({ enable: true }), { enabled: true });
  assert.deepEqual(
    st.configUpdates.map((u) => [u.key, u.value, u.target]),
    [
      ['terminal.integrated.defaultProfile.windows', 'TermPocket (mirrored)', vscode.ConfigurationTarget.Global],
      ['terminal.integrated.defaultProfile.osx', 'TermPocket (mirrored)', vscode.ConfigurationTarget.Global],
      ['terminal.integrated.defaultProfile.linux', 'TermPocket (mirrored)', vscode.ConfigurationTarget.Global],
    ]
  );
  assert.equal(m['settings.get']().mirrorDefault, true);
  assert.equal(conn.of('settings.changed').at(-1).mirrorDefault, true);

  // the user picks another profile on one platform meanwhile: disabling leaves it alone
  st.config['terminal.integrated.defaultProfile.osx'] = 'bash';
  st.configUpdates = [];
  assert.deepEqual(await m['settings.mirrorDefault']({ enable: false }), { enabled: false });
  assert.deepEqual(
    st.configUpdates.map((u) => [u.key, u.value, u.target]),
    [
      ['terminal.integrated.defaultProfile.windows', undefined, vscode.ConfigurationTarget.Global],
      ['terminal.integrated.defaultProfile.linux', 'zsh', vscode.ConfigurationTarget.Global],
    ],
    'cleared, and the previous user value restored'
  );
  assert.equal(st.config['terminal.integrated.defaultProfile.osx'], 'bash');
  assert.equal('terminal.integrated.defaultProfile.windows' in st.config, false);
  assert.equal(conn.of('settings.changed').at(-1).mirrorDefault, false);

  await assert.rejects(async () => m['settings.mirrorDefault']({}), /enable/);
  s.dispose();
});

test('settings report a workspace value that shadows the user default profile (never written)', async () => {
  const conn = new FakeConnection();
  const s = new SettingsService({ connection: conn, log });
  const st = vscode._state;
  st.config = {};
  st.configUpdates = [];
  const key = `terminal.integrated.defaultProfile.${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'}`;
  st.workspaceConfig = { [key]: 'Command Prompt' };
  try {
    const r = await s.setMirrorDefault(true);
    assert.deepEqual(r, { enabled: true, overriddenBy: 'workspace' });
    assert.equal(s.get().overriddenBy, 'workspace');
    assert.ok(st.configUpdates.every((u) => u.target === vscode.ConfigurationTarget.Global), 'only user settings written');
    st.workspaceConfig = { [key]: 'TermPocket (mirrored)' };
    assert.equal(s.get().overriddenBy, undefined, 'same value as the user setting: not an override');
    await s.setMirrorDefault(false);
  } finally {
    st.workspaceConfig = undefined;
  }
});

test('settings.mirrorDefault works without a memento', async () => {
  const conn = new FakeConnection();
  const s = new SettingsService({ connection: conn, log });
  vscode._state.config = {};
  assert.deepEqual(await s.setMirrorDefault(true), { enabled: true });
  assert.deepEqual(await s.setMirrorDefault(true), { enabled: true }, 'idempotent');
  assert.deepEqual(await s.setMirrorDefault(false), { enabled: false });
  assert.deepEqual(vscode._state.config, {});
});

test('a user default profile that still names the pre-rename "VS Control (mirrored)" is switched once', async () => {
  const conn = new FakeConnection();
  const st = vscode._state;
  st.config = {
    'terminal.integrated.defaultProfile.windows': 'VS Control (mirrored)',
    'terminal.integrated.defaultProfile.osx': 'VS Control (mirrored)',
    'terminal.integrated.defaultProfile.linux': 'VS Control (mirrored)',
  };
  st.configUpdates = [];
  const s = new SettingsService({ connection: conn, log });
  s.start();
  await s.ready;
  for (const os of ['windows', 'osx', 'linux']) assert.equal(st.config[`terminal.integrated.defaultProfile.${os}`], MIRROR_PROFILE_TITLE);
  assert.ok(st.configUpdates.every((u) => u.target === vscode.ConfigurationTarget.Global), 'user settings only');
  assert.equal(s.isMirrorDefault(), true);
  // nothing left to migrate the next time
  assert.deepEqual(await s.migrateLegacyDefault(), []);
  s.dispose();

  // Turning it off also clears a value that still names the old title.
  st.config = { 'terminal.integrated.defaultProfile.linux': 'VS Control (mirrored)', 'terminal.integrated.defaultProfile.osx': 'zsh' };
  const s2 = new SettingsService({ connection: conn, log });
  assert.deepEqual(await s2.setMirrorDefault(false), { enabled: false });
  assert.equal('terminal.integrated.defaultProfile.linux' in st.config, false);
  assert.equal(st.config['terminal.integrated.defaultProfile.osx'], 'zsh');
  st.config = {};
});

test('termpocket.* settings fall back to the old vscontrol.* USER settings only', () => {
  const config = require('../src/config');
  const st = vscode._state;
  const savedSettings = st.settings;
  st.settings = {};
  st.config = { 'vscontrol.agentUrl': 'ws://127.0.0.1:1234/vscode', 'vscontrol.liveBufferKB': 1024 };
  try {
    assert.equal(config.readSettings().agentUrl, 'ws://127.0.0.1:1234/vscode', 'old user setting used');
    assert.equal(config.getSetting('liveBufferKB', 512), 1024);
    assert.equal(config.getSetting('terminalSnapshot', true), true, 'default when neither is set');
    st.settings = { agentUrl: 'ws://127.0.0.1:5678/vscode' };
    assert.equal(config.readSettings().agentUrl, 'ws://127.0.0.1:5678/vscode', 'the new setting wins');
    // A workspace (.vscode/settings.json) value of the old, undeclared key is never used.
    st.settings = {};
    st.config = {};
    st.workspaceConfig = { 'vscontrol.agentUrl': 'ws://evil.example:1/vscode' };
    assert.equal(config.readSettings().agentUrl, '');
  } finally {
    st.settings = savedSettings;
    st.workspaceConfig = undefined;
    st.config = {};
  }
});

test('TERMPOCKET_* env variables fall back to the old VSCONTROL_* names', () => {
  const config = require('../src/config');
  const saved = { ...process.env };
  try {
    delete process.env.TERMPOCKET_PORT;
    process.env.VSCONTROL_PORT = '4321';
    assert.equal(config.envValue('PORT'), '4321');
    process.env.TERMPOCKET_PORT = '5432';
    assert.equal(config.envValue('PORT'), '5432');
  } finally {
    for (const k of ['TERMPOCKET_PORT', 'VSCONTROL_PORT']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
