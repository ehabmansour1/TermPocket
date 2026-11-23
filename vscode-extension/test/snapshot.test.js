'use strict';

/**
 * Unit tests of the terminal screen snapshot (src/snapshot.js, PROTOCOL §5.2 `terminals.snapshot`) and of
 * the `snapshot` field of terminals.attach (src/live.js), with `vscode` replaced by the in-memory mock.
 *
 * The fake workbench below models what VS Code does: `terminal.show()` makes it the active terminal (a
 * little later, like the real round trip), selectAll / copySelection act on the ACTIVE terminal, and the
 * clipboard is one shared string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { install } = require('./vscode-mock');
const vscode = install();

const { TerminalSnapshots, cleanText, CMD_SELECT_ALL, CMD_COPY, CMD_CLEAR } = require('../src/snapshot');
const { LiveTerminals, NOTE_SNAPSHOT_STATIC } = require('../src/live');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A fake workbench: terminals with screen text, an active terminal, a clipboard and the three commands. */
function workbench({ clipboard = 'user clipboard text', activateDelayMs = 5 } = {}) {
  const wb = { clip: clipboard, calls: [], selection: null, failCopy: false, copyNothing: false, slowCommand: null };
  vscode._state.activeTerminal = undefined;
  vscode.env.clipboard = {
    readText: async () => {
      wb.calls.push('clipboard.read');
      return wb.clip;
    },
    writeText: async (t) => {
      wb.calls.push(`clipboard.write:${t.includes('termpocket-snapshot') ? '<marker>' : t}`);
      wb.clip = t;
    },
  };
  const cmd = (id, fn) => vscode.commands.registerCommand(id, async () => {
    const active = vscode._state.activeTerminal;
    wb.calls.push(`${id}@${active ? active.name : 'none'}`);
    if (wb.slowCommand === id) await sleep(1500);
    return fn(active);
  });
  wb.subs = [
    cmd(CMD_SELECT_ALL, (t) => {
      wb.selection = t ? t.screen : null;
    }),
    cmd(CMD_COPY, () => {
      if (wb.failCopy) throw new Error('copy failed');
      if (!wb.copyNothing && wb.selection !== null) wb.clip = wb.selection;
    }),
    cmd(CMD_CLEAR, () => {
      wb.selection = null;
    }),
  ];
  wb.terminal = (name, screen, extra = {}) =>
    Object.assign(
      {
        name,
        screen,
        dimensions: { columns: 80, rows: 24 },
        exitStatus: undefined,
        shown: [],
        show(preserveFocus) {
          this.shown.push(preserveFocus);
          wb.calls.push(`show:${name}:${preserveFocus}`);
          if (activateDelayMs < 0) return; // never becomes active
          setTimeout(() => {
            vscode._state.activeTerminal = this;
          }, activateDelayMs);
        },
      },
      extra
    );
  wb.dispose = () => wb.subs.forEach((s) => s.dispose());
  return wb;
}

test('cleanText: CRLF → LF, trailing spaces and trailing blank lines removed', () => {
  assert.deepEqual(cleanText('a  \r\nb\r\n\r\n   \n\n'), ['a', 'b']);
  assert.deepEqual(cleanText(''), []);
  assert.deepEqual(cleanText('\n\nx'), ['', '', 'x'], 'leading blank lines are kept');
});

test('snapshot: command order, text, dims; clipboard and the previously active terminal restored', async () => {
  const wb = workbench();
  try {
    const prev = wb.terminal('editor-term', 'PREV');
    vscode._state.activeTerminal = prev;
    const t = wb.terminal('claude', 'PS> claude\r\n* Vibing…   \r\n> \r\n\r\n\r\n');
    const snaps = new TerminalSnapshots({ log, now: () => 1234 });
    const r = await snaps.take(t);
    assert.deepEqual(r, { text: 'PS> claude\n* Vibing…\n>', cols: 80, rows: 24, lines: 3, at: 1234 });
    assert.deepEqual(wb.calls, [
      'clipboard.read', // 1. the user's clipboard text first
      'clipboard.write:<marker>', // 2. a marker, to tell "copy did nothing" from copied text
      'show:claude:true', // 3. reveal with preserveFocus
      `${CMD_SELECT_ALL}@claude`, // 4. on the right (now active) terminal
      `${CMD_COPY}@claude`,
      'clipboard.read',
      `${CMD_CLEAR}@claude`, // 5. put everything back
      'clipboard.write:user clipboard text',
      'show:editor-term:true',
    ]);
    assert.equal(wb.clip, 'user clipboard text');
    assert.equal(wb.selection, null, 'selection cleared');
    assert.deepEqual(prev.shown, [true], 'previous terminal re-shown without taking focus');
    assert.equal(snaps.running, 0);
  } finally {
    wb.dispose();
  }
});

test('snapshot never touches a clipboard holding an image / files / rich text (clipboard.info), nor an unknown empty one', async () => {
  const wb = workbench();
  try {
    const t = wb.terminal('T', 'screen');
    // The agent says: not text-only → rejected before anything is read, written or shown.
    await assert.rejects(new TerminalSnapshots({ log, clipboardRestorable: async () => false }).take(t), /image, files or rich text/);
    assert.deepEqual(wb.calls, []);
    assert.deepEqual(t.shown, []);
    // Unknown (older agent) and the text read is empty: it may be an image → left alone too.
    wb.clip = '';
    await assert.rejects(new TerminalSnapshots({ log }).take(t), /may hold an image/);
    assert.deepEqual(wb.calls, ['clipboard.read'], 'only read');
    assert.deepEqual(t.shown, []);
    // The agent says text-only (here: empty) → the snapshot runs and the empty text is restored.
    wb.calls.length = 0;
    const r = await new TerminalSnapshots({ log, clipboardRestorable: async () => true }).take(t);
    assert.equal(r.text, 'screen');
    assert.equal(wb.clip, '');
    // The check failing or hanging counts as unknown (non-empty text → snapshot allowed).
    wb.clip = 'abc';
    const r2 = await new TerminalSnapshots({ log, clipboardRestorable: () => new Promise(() => {}) }).take(t);
    assert.equal(r2.text, 'screen');
    assert.equal(wb.clip, 'abc');
  } finally {
    wb.dispose();
  }
});

test('snapshot: no previously active terminal → nothing to re-show; the same terminal is not re-shown', async () => {
  const wb = workbench();
  try {
    const t = wb.terminal('only', 'hello');
    const r = await new TerminalSnapshots({ log }).take(t);
    assert.equal(r.text, 'hello');
    assert.deepEqual(t.shown, [true], 'shown once');
    // Already active: still works, not re-shown at the end.
    const r2 = await new TerminalSnapshots({ log }).take(t);
    assert.equal(r2.text, 'hello');
    assert.deepEqual(t.shown, [true, true]);
  } finally {
    wb.dispose();
  }
});

test('snapshot mutex: concurrent snapshots run one after another and never interleave', async () => {
  const wb = workbench({ activateDelayMs: 15 });
  try {
    const a = wb.terminal('A', 'screen A');
    const b = wb.terminal('B', 'screen B');
    const c = wb.terminal('C', 'screen C');
    const snaps = new TerminalSnapshots({ log });
    const [ra, rb, rc] = await Promise.all([snaps.take(a), snaps.take(b), snaps.take(c)]);
    assert.equal(ra.text, 'screen A');
    assert.equal(rb.text, 'screen B');
    assert.equal(rc.text, 'screen C');
    // Each snapshot's sequence is contiguous: from its first clipboard read to its clipboard restore
    // (and the re-show of the previously active terminal) nothing of another snapshot happens.
    const runs = [];
    let cur = null;
    for (const c of wb.calls) {
      if (!cur || (cur.done && c === 'clipboard.read')) {
        assert.equal(c, 'clipboard.read', `a snapshot starts by reading the clipboard (got ${c})`);
        cur = [c];
        runs.push(cur);
      } else if (cur.done) {
        assert.match(c, /^show:/, 'after the restore only the previous terminal is re-shown');
        cur.push(c);
        cur = null;
      } else {
        cur.push(c);
        if (c === 'clipboard.write:user clipboard text') cur.done = true;
      }
    }
    assert.equal(runs.length, 3);
    runs.forEach((r, k) => {
      const name = 'ABC'[k];
      assert.deepEqual(
        r.filter((c) => !c.startsWith('clipboard')).slice(0, 4),
        [`show:${name}:true`, `${CMD_SELECT_ALL}@${name}`, `${CMD_COPY}@${name}`, `${CMD_CLEAR}@${name}`],
      );
    });
    assert.equal(wb.clip, 'user clipboard text');
    // A failure does not break the queue.
    const dead = wb.terminal('dead', 'x', { exitStatus: { code: 0 } });
    const [rd, re] = await Promise.allSettled([snaps.take(dead), snaps.take(a)]);
    assert.equal(rd.status, 'rejected');
    assert.match(rd.reason.message, /closed/);
    assert.equal(re.status, 'fulfilled');
  } finally {
    wb.dispose();
  }
});

test('snapshot failures restore the clipboard: copy throws, nothing copied, terminal never active, slow command', async () => {
  const wb = workbench();
  try {
    const snaps = new TerminalSnapshots({ log });
    const t = wb.terminal('t', 'text');

    wb.failCopy = true;
    await assert.rejects(snaps.take(t), /copy failed/);
    assert.equal(wb.clip, 'user clipboard text');
    assert.equal(wb.selection, null, 'selection cleared after a failure too');
    wb.failCopy = false;

    wb.copyNothing = true;
    await assert.rejects(snaps.take(t), /nothing was copied/);
    assert.equal(wb.clip, 'user clipboard text');
    wb.copyNothing = false;

    wb.slowCommand = CMD_SELECT_ALL;
    const t0 = Date.now();
    await assert.rejects(snaps.take(t), /timed out/);
    assert.ok(Date.now() - t0 < 2000, 'bounded (~1 s budget)');
    assert.equal(wb.clip, 'user clipboard text');
    wb.slowCommand = null;
    assert.equal(snaps.running, 0);
  } finally {
    wb.dispose();
  }

  const wb2 = workbench({ activateDelayMs: -1 });
  try {
    const t = wb2.terminal('never', 'x');
    await assert.rejects(new TerminalSnapshots({ log }).take(t), /did not become active/);
    assert.ok(!wb2.calls.some((c) => c.startsWith(CMD_SELECT_ALL)), 'no select-all on whatever terminal happens to be active');
    assert.equal(wb2.clip, 'user clipboard text');
  } finally {
    wb2.dispose();
  }
});

test('snapshot disabled by termpocket.terminalSnapshot: rejects without touching anything', async () => {
  const wb = workbench();
  try {
    const t = wb.terminal('t', 'text');
    const snaps = new TerminalSnapshots({ log, enabled: () => false });
    await assert.rejects(snaps.take(t), /turned off/);
    assert.equal(await snaps.tryTake(t), null);
    assert.deepEqual(wb.calls, []);
    assert.deepEqual(t.shown, []);
  } finally {
    wb.dispose();
  }
});

// ---- terminals.attach `snapshot` -----------------------------------------------------------------

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.events = [];
  }
  notify(ev, p) {
    this.events.push({ ev, p });
    return true;
  }
}

function liveWith(snapshots, terms, mirrors = new Set()) {
  const live = new LiveTerminals({
    connection: new FakeConnection(),
    log,
    getTerminal: (tid) => {
      const t = terms.get(tid);
      if (!t) throw new Error(`unknown terminal: ${tid}`);
      return t;
    },
    ptyIdOf: (t) => (mirrors.has(t) ? 'p1' : null),
    snapshots,
  });
  live.start();
  live.startedAt = Date.now() - 60_000;
  return live;
}

test('terminals.attach includes the snapshot when not capturing or little was captured, never for mirrors', async () => {
  const wb = workbench();
  try {
    const snaps = new TerminalSnapshots({ log });
    const terms = new Map();
    const mirrors = new Set();
    const live = liveWith(snaps, terms, mirrors);
    const methods = live.methods();

    // Pre-existing terminal running a program TermPocket never saw start: capturing false → snapshot.
    const pre = wb.terminal('pre', 'PS> claude\n* Vibing…', { shellIntegration: { cwd: undefined }, sendText() {} });
    terms.set('a', pre);
    live.track('a', pre, { preexisting: true });
    let r = await methods['terminals.attach']({ tid: 'a', aid: 'x1' });
    assert.equal(r.capturing, false);
    assert.equal(r.snapshot.text, 'PS> claude\n* Vibing…');
    assert.equal(r.snapshot.cols, 80);
    assert.equal(r.note, NOTE_SNAPSHOT_STATIC);
    assert.equal(r.aid, 'x1', 'still a normal attachment');
    assert.equal(live.attachedCount('a'), 1);
    assert.equal(wb.clip, 'user clipboard text');

    // Capturing with plenty of captured output: no snapshot needed (key present, null).
    const cap = wb.terminal('cap', 'irrelevant', { shellIntegration: { cwd: undefined }, sendText() {} });
    terms.set('b', cap);
    live.track('b', cap, { created: true });
    live.executionStarted('b');
    live.feed('b', 'x'.repeat(10000));
    const callsBefore = wb.calls.length;
    r = await methods['terminals.attach']({ tid: 'b' });
    assert.equal(r.capturing, true);
    assert.ok('snapshot' in r);
    assert.equal(r.snapshot, null);
    assert.equal(wb.calls.length, callsBefore, 'no snapshot taken');

    // Capturing but nothing captured yet: snapshot, and the "nothing captured" note goes away.
    const fresh = wb.terminal('fresh', 'PS C:\\> ', { shellIntegration: { cwd: undefined }, sendText() {} });
    terms.set('c', fresh);
    live.track('c', fresh, { created: true });
    r = await methods['terminals.attach']({ tid: 'c' });
    assert.equal(r.capturing, true);
    assert.equal(r.snapshot.text, 'PS C:\\>');
    assert.equal(r.note, undefined);

    // Mirrored terminal: never snapshotted (the agent PTY has the full scrollback); no key.
    const m = wb.terminal('m', 'mirror', { sendText() {} });
    mirrors.add(m);
    terms.set('m', m);
    live.track('m', m);
    r = await methods['terminals.attach']({ tid: 'm' });
    assert.equal(r.isMirror, true);
    assert.ok(!('snapshot' in r));

    // Snapshot fails (turned off / error): attach still works, snapshot null.
    const off = liveWith(new TerminalSnapshots({ log, enabled: () => false }), terms);
    off.track('a', pre, { preexisting: true });
    r = await off.methods()['terminals.attach']({ tid: 'a' });
    assert.equal(r.snapshot, null);
    assert.equal(r.capturing, false);

    // terminals.snapshot on its own.
    const s = await methods['terminals.snapshot']({ tid: 'a' });
    assert.equal(s.text, 'PS> claude\n* Vibing…');
    await assert.rejects(off.methods()['terminals.snapshot']({ tid: 'a' }), /turned off/);
    live.dispose();
    off.dispose();
  } finally {
    wb.dispose();
  }
});
