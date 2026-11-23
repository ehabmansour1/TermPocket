'use strict';

/**
 * Unit tests of the desktop-workbench additions (PROTOCOL §5.2): fs.stat / fs.mkdir / fs.rename /
 * fs.delete, fs.list robustness, diagnostics ranges, commands.list {withTitles}, and the git.* methods
 * on top of a fake built-in Git extension API (shape of extensions/git/src/api/git.d.ts).
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { install } = require('./vscode-mock');
const vscode = install();

const { WorkspaceService } = require('../src/workspace');
const { GitService, Status } = require('../src/git');
const { withDeadline, requireStringArray } = require('../src/util');
const { buildCatalog, titledCommands, displayKeybinding } = require('../src/commandCatalog');

// ---- fixture ------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpocket-wb-test-'));
const wsDir = path.join(tmp, 'project');
fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(wsDir, 'src', 'main.js'), 'console.log(1)\n');
vscode._setFolders([wsDir]);

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

function fakeConnection() {
  return {
    connected: true,
    events: [],
    notify(ev, p) {
      this.events.push({ ev, p });
      return true;
    },
    on() {},
  };
}

function makeWorkspace() {
  const connection = fakeConnection();
  const svc = new WorkspaceService({ connection, log, windowInfo: () => ({ name: 'project', folders: [wsDir], focused: true }) });
  const m = svc.methods();
  return { svc, connection, call: (name, p = {}) => m[name](p) };
}

const abs = (...p) => path.join(path.resolve(wsDir), ...p);

// ---- util ---------------------------------------------------------------------------------------

test('withDeadline settles with the promise, or rejects with code DEADLINE', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(withDeadline(new Promise(() => {}), 30, 'too slow'), (err) => err.code === 'DEADLINE' && err.message === 'too slow');
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
  assert.deepEqual(requireStringArray(['a'], 'paths'), ['a']);
  assert.throws(() => requireStringArray([], 'paths'), /paths/);
  assert.throws(() => requireStringArray(['a', ''], 'paths'), /paths/);
  assert.throws(() => requireStringArray('a', 'paths'), /paths/);
});

// ---- fs.* ---------------------------------------------------------------------------------------

test('fs.stat / fs.mkdir', async () => {
  const { call } = makeWorkspace();
  const st = await call('fs.stat', { path: 'a.txt' });
  assert.equal(st.path, abs('a.txt'));
  assert.equal(st.exists, true);
  assert.equal(st.type, 'file');
  assert.equal(st.size, 6);
  assert.ok(st.mtime > 0);
  assert.equal(st.readonly, false);
  assert.equal((await call('fs.stat', { path: 'src' })).type, 'dir');
  assert.deepEqual(await call('fs.stat', { path: 'nope.txt' }), { path: abs('nope.txt'), exists: false });
  await assert.rejects(call('fs.stat', {}), /path/);

  assert.deepEqual(await call('fs.mkdir', { path: 'made/inner' }), { path: abs('made', 'inner') });
  assert.ok(fs.statSync(abs('made', 'inner')).isDirectory());
  await assert.rejects(call('fs.mkdir', { path: 'made/inner' }), /already exists/);
  await assert.rejects(call('fs.mkdir', { path: 'a.txt' }), /already exists/);
});

test('fs.rename goes through a WorkspaceEdit (open editors follow), falls back to workspace.fs.rename', async () => {
  const { call } = makeWorkspace();
  fs.writeFileSync(abs('r1.txt'), 'one');
  vscode._state.appliedEdits.length = 0;
  assert.deepEqual(await call('fs.rename', { from: 'r1.txt', to: 'r2.txt' }), { from: abs('r1.txt'), to: abs('r2.txt') });
  assert.equal(fs.readFileSync(abs('r2.txt'), 'utf8'), 'one');
  assert.ok(!fs.existsSync(abs('r1.txt')));
  const edit = vscode._state.appliedEdits.at(-1);
  assert.equal(edit.edits[0].rename.oldUri.fsPath, abs('r1.txt'));
  assert.equal(edit.edits[0].rename.newUri.fsPath, abs('r2.txt'));
  assert.equal(edit.edits[0].rename.options.overwrite, false);

  // Refused edit → workspace.fs.rename.
  vscode._state.applyEditResult = false;
  try {
    await call('fs.rename', { from: abs('r2.txt'), to: abs('src', 'r3.txt') });
  } finally {
    vscode._state.applyEditResult = undefined;
  }
  assert.equal(fs.readFileSync(abs('src', 'r3.txt'), 'utf8'), 'one');

  // Existing target, missing source, workspace root, bad params.
  await assert.rejects(call('fs.rename', { from: 'src/r3.txt', to: 'a.txt' }), /already exists/);
  await assert.rejects(call('fs.rename', { from: 'ghost.txt', to: 'g2.txt' }), /does not exist/);
  await assert.rejects(call('fs.rename', { from: wsDir, to: path.join(tmp, 'other') }), /is a workspace folder/);
  await assert.rejects(call('fs.rename', { from: tmp, to: tmp + '-moved' }), /contains a workspace folder/);
  await assert.rejects(call('fs.rename', { from: 'a.txt' }), /to/);
  // overwrite:true replaces.
  fs.writeFileSync(abs('o1.txt'), 'new');
  fs.writeFileSync(abs('o2.txt'), 'old');
  await call('fs.rename', { from: 'o1.txt', to: 'o2.txt', overwrite: true });
  assert.equal(fs.readFileSync(abs('o2.txt'), 'utf8'), 'new');
});

test('fs.delete moves to the trash, refuses roots and non-empty folders without recursive', async () => {
  const { call } = makeWorkspace();
  fs.writeFileSync(abs('del.txt'), 'x');
  vscode._state.trashed.length = 0;
  assert.deepEqual(await call('fs.delete', { path: 'del.txt' }), { path: abs('del.txt'), trash: true });
  assert.ok(!fs.existsSync(abs('del.txt')));
  assert.deepEqual(vscode._state.trashed, [abs('del.txt')]);

  fs.mkdirSync(abs('full', 'deep'), { recursive: true });
  fs.writeFileSync(abs('full', 'deep', 'f.txt'), 'x');
  await assert.rejects(call('fs.delete', { path: 'full' }), /not empty: pass recursive:true/);
  assert.ok(fs.existsSync(abs('full', 'deep', 'f.txt')));
  await call('fs.delete', { path: 'full', recursive: true });
  assert.ok(!fs.existsSync(abs('full')));

  fs.mkdirSync(abs('empty'));
  await call('fs.delete', { path: 'empty' });
  assert.ok(!fs.existsSync(abs('empty')));

  await assert.rejects(call('fs.delete', { path: wsDir }), /is a workspace folder/);
  await assert.rejects(call('fs.delete', { path: tmp, recursive: true }), /contains a workspace folder/);
  assert.ok(fs.existsSync(wsDir));
  await assert.rejects(call('fs.delete', { path: 'gone.txt' }), /does not exist/);
  await assert.rejects(call('fs.delete', { path: process.platform === 'win32' ? 'C:\\' : '/' }), /refusing|workspace folder/);
  await assert.rejects(call('fs.delete', {}), /path/);
});

test('fs.list answers quickly: no folder → clear error; slow stats are abandoned', async () => {
  const { call } = makeWorkspace();
  vscode._setFolders([]);
  try {
    await assert.rejects(call('fs.list', {}), /no folder open/);
    // An explicit path still works in a window without a folder.
    const r = await call('fs.list', { path: wsDir });
    assert.ok(r.entries.some((e) => e.name === 'a.txt'));
  } finally {
    vscode._setFolders([wsDir]);
  }

  const origStat = vscode.workspace.fs.stat;
  vscode.workspace.fs.stat = () => new Promise(() => {}); // a file system that never answers stats
  const t0 = Date.now();
  try {
    const r = await call('fs.list', {});
    assert.ok(Date.now() - t0 < 6000, 'answered within the stat budget');
    assert.deepEqual(r.entries.slice(0, 1).map((e) => `${e.type}:${e.name}`), ['dir:made']);
    assert.ok(r.entries.every((e) => e.size === 0 && e.mtime === 0));
    assert.equal(r.truncated, undefined);
  } finally {
    vscode.workspace.fs.stat = origStat;
  }

  await assert.rejects(call('fs.list', { path: 'no/such/dir' }));
});

test('diagnostics.list carries the full range and tags (for editor squiggles)', async () => {
  const { call } = makeWorkspace();
  const uri = vscode.Uri.file(abs('a.txt'));
  const orig = vscode.languages.getDiagnostics;
  vscode.languages.getDiagnostics = (u) => {
    const d = [
      { severity: 0, message: 'bad', range: new vscode.Range(1, 2, 1, 9), source: 'ts', code: { value: 2304, target: null } },
      { severity: 3, message: 'unused', range: new vscode.Range(0, 0, 0, 5), source: 'ts', code: 6133, tags: [1] },
    ];
    return u ? d : [[uri, d]];
  };
  try {
    const list = await call('diagnostics.list', {});
    assert.deepEqual(list[0], { path: abs('a.txt'), severity: 'error', message: 'bad', line: 2, column: 3, endLine: 2, endColumn: 10, source: 'ts', code: 2304 });
    assert.deepEqual(list[1].tags, ['unnecessary']);
    assert.equal(list[1].severity, 'hint');
    assert.equal((await call('diagnostics.list', { path: 'a.txt' })).length, 2);
  } finally {
    vscode.languages.getDiagnostics = orig;
  }
});

// ---- commands.list {withTitles} -----------------------------------------------------------------

test('commands.list {withTitles}: titles, categories, keybindings, palette-hidden, server-side query', async () => {
  vscode._state.extensions = [
    {
      id: 'vscode.git',
      packageJSON: {
        contributes: {
          commands: [
            { command: 'git.commit', title: 'Commit', category: 'Git' },
            { command: 'git.hiddenOne', title: 'Hidden', category: 'Git' },
            { command: 'git.untranslated', title: '%command.untranslated%', category: 'Git' },
            { command: 'git.localized', title: { value: 'Stage All Changes', original: 'Stage All Changes' }, category: 'Git' },
          ],
          menus: { commandPalette: [{ command: 'git.hiddenOne', when: 'false' }, { command: 'git.commit', when: 'scmProvider == git' }] },
          keybindings: [{ command: 'git.commit', key: 'ctrl+enter', mac: 'cmd+enter', when: 'scmRepository' }],
        },
      },
    },
  ];
  const { call, svc } = makeWorkspace();
  svc.start();
  try {
    const all = await call('commands.list', { withTitles: true });
    const byId = new Map(all.map((c) => [c.id, c]));
    const kbSave = process.platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S';
    assert.deepEqual(byId.get('workbench.action.files.save'), { id: 'workbench.action.files.save', title: 'Save', category: 'File', keybinding: kbSave });
    assert.deepEqual(byId.get('git.commit'), { id: 'git.commit', title: 'Commit', category: 'Git', keybinding: process.platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter' });
    assert.deepEqual(byId.get('git.localized'), { id: 'git.localized', title: 'Stage All Changes', category: 'Git' });
    assert.ok(!byId.has('git.hiddenOne'), 'commandPalette when:false hides it');
    assert.ok(!byId.has('git.untranslated'), 'unresolved %nls% titles are not shown');
    assert.ok(!byId.has('workbench.action.terminal.new'), 'curated built-ins only when registered in this VS Code');
    assert.ok(!byId.has('test.echo'), 'untitled internal commands are not listed without a query');
    // Sorted by label like the palette.
    const labels = all.map((c) => (c.category ? `${c.category}: ${c.title}` : c.title));
    assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })));

    const q = await call('commands.list', { withTitles: true, query: 'save' });
    assert.equal(q[0].id, 'workbench.action.files.save');
    const byIdQuery = await call('commands.list', { withTitles: true, query: 'test.echo' });
    assert.deepEqual(byIdQuery[0], { id: 'test.echo', title: 'test.echo', category: null });
    assert.deepEqual(await call('commands.list', { withTitles: true, query: 'zzz-nothing' }), []);
    assert.equal((await call('commands.list', { withTitles: true, max: 1 })).length, 1);

    // The plain form is unchanged: string[].
    const plain = await call('commands.list', { filter: 'save' });
    assert.deepEqual(plain, ['workbench.action.files.save']);
  } finally {
    vscode._state.extensions = [];
  }
});

test('command catalog helpers', () => {
  assert.equal(displayKeybinding('ctrl+shift+alt+f'), 'Ctrl+Shift+Alt+F');
  assert.equal(displayKeybinding('ctrl+k ctrl+s'), 'Ctrl+K Ctrl+S');
  assert.equal(displayKeybinding('shift+f12'), 'Shift+F12');
  assert.equal(displayKeybinding(''), null);
  const cat = buildCatalog([]);
  assert.ok(cat.size >= 80, `curated map has ${cat.size} entries`);
  const list = titledCommands(cat, ['workbench.action.terminal.new'], { max: 10 });
  assert.deepEqual(list, [{ id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', keybinding: process.platform === 'darwin' ? 'Cmd+Shift+`' : 'Ctrl+Shift+`' }]);
});

// ---- git.* --------------------------------------------------------------------------------------

function makeGitExtension(repoDir) {
  const subs = { state: new Set(), open: new Set(), close: new Set(), apiState: new Set() };
  const ev = (set) => (fn) => {
    set.add(fn);
    return { dispose: () => set.delete(fn) };
  };
  const U = (rel) => vscode.Uri.file(path.join(repoDir, rel));
  const calls = [];
  const repo = {
    rootUri: vscode.Uri.file(repoDir),
    inputBox: { value: 'wip message' },
    state: {
      HEAD: { name: 'main', commit: '0123456789abcdef', upstream: { remote: 'origin', name: 'main' }, ahead: 2, behind: 1 },
      mergeChanges: [],
      indexChanges: [
        { uri: U('staged.js'), originalUri: U('staged.js'), status: Status.INDEX_MODIFIED },
        { uri: U('new-name.js'), originalUri: U('old-name.js'), renameUri: U('new-name.js'), status: Status.INDEX_RENAMED },
        { uri: U('added.js'), originalUri: U('added.js'), status: Status.INDEX_ADDED },
      ],
      workingTreeChanges: [
        { uri: U('mod.js'), originalUri: U('mod.js'), status: Status.MODIFIED },
        { uri: U('gone.js'), originalUri: U('gone.js'), status: Status.DELETED },
        { uri: U('staged.js'), originalUri: U('staged.js'), status: Status.MODIFIED },
      ],
      untrackedChanges: [{ uri: U('untracked.txt'), originalUri: U('untracked.txt'), status: Status.UNTRACKED }],
      onDidChange: ev(subs.state),
    },
    async add(paths) {
      calls.push(['add', paths]);
    },
    async revert(paths) {
      calls.push(['revert', paths]);
    },
    async clean(paths) {
      calls.push(['clean', paths]);
    },
    async show(ref, p) {
      calls.push(['show', ref, p]);
      if (p.endsWith('added.js')) throw Object.assign(new Error('Failed to execute git'), { stderr: "fatal: path 'added.js' exists on disk, but not in 'HEAD'" });
      if (p.endsWith('bin.dat')) return 'PK\0\x01';
      return ref === '' ? 'index text\n' : 'head text\n';
    },
    async commit(message, opts) {
      calls.push(['commit', message, opts]);
      repo.state.HEAD = { ...repo.state.HEAD, commit: 'fedcba9876543210' };
    },
  };
  const api = {
    state: 'initialized',
    repositories: [repo],
    getRepository(uri) {
      const root = path.resolve(repoDir).toLowerCase();
      const p = path.resolve(uri.fsPath).toLowerCase();
      return p === root || p.startsWith(root + path.sep) ? repo : null;
    },
    onDidOpenRepository: ev(subs.open),
    onDidCloseRepository: ev(subs.close),
    onDidChangeState: ev(subs.apiState),
  };
  const ext = {
    id: 'vscode.git',
    isActive: false,
    exports: undefined,
    packageJSON: {},
    activations: 0,
    async activate() {
      this.activations++;
      this.isActive = true;
      this.exports = { enabled: true, getAPI: (v) => (v === 1 ? api : null), onDidChangeEnablement: () => ({ dispose() {} }) };
      return this.exports;
    },
  };
  const fireState = () => {
    for (const fn of [...subs.state]) fn();
  };
  return { ext, repo, api, calls, fireState, U };
}

test('git.status without a Git extension → available:false (never an error or a hang)', async () => {
  vscode._state.extensions = [];
  const git = new GitService({ connection: fakeConnection(), log });
  try {
    const st = await git.methods()['git.status']({});
    assert.equal(st.available, false);
    assert.deepEqual(st.repos, []);
    assert.match(st.reason, /Git extension/);
    await assert.rejects(git.methods()['git.stage']({ paths: ['a.txt'] }), /Git is not available/);
  } finally {
    git.dispose();
  }
});

test('git.status / show / stage / unstage / discard / commit and git.changed', async () => {
  const repoDir = wsDir;
  const fake = makeGitExtension(repoDir);
  vscode._state.extensions = [fake.ext];
  const connection = fakeConnection();
  const git = new GitService({ connection, log });
  git.start(); // the Git extension is not active yet: nothing is activated by start()
  assert.equal(fake.ext.activations, 0);
  const call = (m, p = {}) => git.methods()[m](p);
  const P = (rel) => path.join(path.resolve(repoDir), rel);
  try {
    const st = await call('git.status');
    assert.equal(fake.ext.activations, 1, 'activated on first use');
    assert.equal(st.available, true);
    assert.equal(st.repos.length, 1);
    const r = st.repos[0];
    assert.equal(r.root, path.resolve(repoDir));
    assert.equal(r.branch, 'main');
    assert.equal(r.ahead, 2);
    assert.equal(r.behind, 1);
    assert.equal(r.upstream, 'origin/main');
    assert.equal(r.commit, '0123456789abcdef');
    assert.equal(r.message, 'wip message');
    assert.deepEqual(r.changes, [
      { path: P('staged.js'), status: 'M', staged: true },
      { path: P('new-name.js'), status: 'R', staged: true, originalPath: P('old-name.js') },
      { path: P('added.js'), status: 'A', staged: true },
      { path: P('mod.js'), status: 'M', staged: false },
      { path: P('gone.js'), status: 'D', staged: false },
      { path: P('staged.js'), status: 'M', staged: false },
      { path: P('untracked.txt'), status: 'U', staged: false },
    ]);

    // show: HEAD by default, '~' = index, new file → exists:false, binary flagged, bad ref refused.
    assert.deepEqual(await call('git.show', { path: 'mod.js' }), { path: P('mod.js'), ref: 'HEAD', exists: true, content: 'head text\n', binary: false, truncated: false });
    assert.deepEqual(fake.calls.at(-1), ['show', 'HEAD', P('mod.js')]);
    assert.equal((await call('git.show', { path: 'mod.js', ref: '~' })).content, 'index text\n');
    assert.deepEqual(fake.calls.at(-1), ['show', '', P('mod.js')]);
    assert.deepEqual(await call('git.show', { path: 'added.js', ref: 'HEAD' }), { path: P('added.js'), ref: 'HEAD', exists: false, content: '', binary: false, truncated: false });
    assert.equal((await call('git.show', { path: 'bin.dat' })).binary, true);
    await assert.rejects(call('git.show', { path: 'mod.js', ref: '--output=x' }), /invalid ref/);
    await assert.rejects(call('git.show', { path: path.join(tmp, 'outside.js') }), /not inside a Git repository/);

    await call('git.stage', { paths: ['mod.js', 'untracked.txt'] });
    assert.deepEqual(fake.calls.at(-1), ['add', [P('mod.js'), P('untracked.txt')]]);
    await call('git.unstage', { paths: ['staged.js'] });
    assert.deepEqual(fake.calls.at(-1), ['revert', [P('staged.js')]]);
    await assert.rejects(call('git.stage', { paths: [] }), /paths/);
    await assert.rejects(call('git.stage', {}), /paths/);

    // discard: only working-tree / untracked paths are cleaned; staged-only ones are skipped.
    const d = await call('git.discard', { paths: ['mod.js', 'untracked.txt', 'added.js'] });
    assert.deepEqual(d, { discarded: [P('mod.js'), P('untracked.txt')], skipped: [P('added.js')] });
    assert.deepEqual(fake.calls.at(-1), ['clean', [P('mod.js'), P('untracked.txt')]]);
    const n = fake.calls.length;
    assert.deepEqual(await call('git.discard', { paths: ['added.js'] }), { discarded: [], skipped: [P('added.js')] });
    assert.equal(fake.calls.length, n, 'clean() not called when nothing applies');

    // commit
    await assert.rejects(call('git.commit', { message: '   ' }), /message/);
    const c = await call('git.commit', { message: '  Fix things \n' });
    assert.deepEqual(fake.calls.at(-1), ['commit', 'Fix things', { all: false }]);
    assert.deepEqual(c, { root: path.resolve(repoDir), commit: 'fedcba9876543210' });
    fake.repo.state.indexChanges = [];
    await assert.rejects(call('git.commit', { message: 'x' }), /no staged changes/);
    await call('git.commit', { message: 'all', all: true });
    // 'tracked' (git add -u), never true (git add -A would also commit untracked files)
    assert.deepEqual(fake.calls.at(-1), ['commit', 'all', { all: 'tracked' }]);

    // git.changed: debounced (500 ms) on repository state changes.
    connection.events.length = 0;
    fake.fireState();
    fake.fireState();
    fake.fireState();
    await new Promise((r) => setTimeout(r, 800));
    const changed = connection.events.filter((e) => e.ev === 'git.changed');
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0].p, { available: true, repos: [{ root: path.resolve(repoDir), branch: 'main', ahead: 2, behind: 1, changes: 4 }] });
  } finally {
    git.dispose();
    vscode._state.extensions = [];
  }
});

test('git: start() attaches to an already running Git extension without a call', async () => {
  const fake = makeGitExtension(wsDir);
  await fake.ext.activate();
  fake.ext.activations = 0;
  vscode._state.extensions = [fake.ext];
  const connection = fakeConnection();
  const git = new GitService({ connection, log });
  try {
    git.start();
    await new Promise((r) => setTimeout(r, 20));
    connection.events.length = 0;
    fake.fireState();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(connection.events.filter((e) => e.ev === 'git.changed').length, 1);
    assert.equal(fake.ext.activations, 0);
  } finally {
    git.dispose();
    vscode._state.extensions = [];
  }
});

test('git: a window in the background refreshes Git itself (git.status, file changes) without an event loop', async () => {
  const fake = makeGitExtension(wsDir);
  let statusCalls = 0;
  fake.repo.status = async () => {
    statusCalls++;
    fake.fireState(); // the Git extension fires a state change after every refresh, even an empty one
  };
  vscode._state.extensions = [fake.ext];
  const connection = fakeConnection();
  const git = new GitService({ connection, log });
  const win = vscode.window.state;
  try {
    // focused: VS Code's Git extension refreshes by itself → no forced refresh
    win.focused = true;
    await git.methods()['git.status']({});
    assert.equal(statusCalls, 0);
    // unfocused: git.status asks the repository to refresh first, at most once per 2 s
    win.focused = false;
    await git.methods()['git.status']({});
    await git.methods()['git.status']({});
    assert.equal(statusCalls, 1);
    // the unchanged state after our own refresh is not announced again (no git.changed → git.status loop)
    await new Promise((r) => setTimeout(r, 700));
    connection.events.length = 0;
    await new Promise((r) => setTimeout(r, 2100));
    await git.methods()['git.status']({});
    assert.equal(statusCalls, 2);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(connection.events.filter((e) => e.ev === 'git.changed').length, 0);
    // a real change after a forced refresh is announced
    fake.repo.state.untrackedChanges = [];
    fake.fireState();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(connection.events.filter((e) => e.ev === 'git.changed').length, 1);
  } finally {
    win.focused = true;
    git.dispose();
    vscode._state.extensions = [];
  }
});
