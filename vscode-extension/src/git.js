'use strict';

/**
 * Source control methods (PROTOCOL §5.2 `git.*`) on top of VS Code's built-in Git extension API
 * (`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)`, typings: extensions/git/src/api/git.d.ts):
 *
 *  - `repository.add(paths)`    = `git add -A -- paths`          → git.stage
 *  - `repository.revert(paths)` = `git reset -q HEAD -- paths`   → git.unstage (the API's "revert" UNSTAGES)
 *  - `repository.clean(paths)`  = discard working-tree changes: untracked files are deleted (to the OS
 *                                 trash while `git.discardUntrackedChangesToTrash` is on, VS Code's
 *                                 default), tracked ones are checked out from the index → git.discard
 *  - `repository.show(ref, absPath)`, `repository.commit(message, {all})`, `repository.state` (+ onDidChange).
 *
 * The git extension runs in the workspace extension host. This extension is a UI extension, so in a
 * remote window (SSH / WSL / container) the git API lives on the other side and is not reachable:
 * `git.status` then answers `{available:false, reason}` instead of failing.
 */

const vscode = require('vscode');
const { errMsg, debounce, requireString, requireStringArray, withDeadline } = require('./util');
const { resolveUri, toPath, uriKey } = require('./workspace');

// git.d.ts `const enum Status`
const Status = {
  INDEX_MODIFIED: 0, INDEX_ADDED: 1, INDEX_DELETED: 2, INDEX_RENAMED: 3, INDEX_COPIED: 4,
  MODIFIED: 5, DELETED: 6, UNTRACKED: 7, IGNORED: 8, INTENT_TO_ADD: 9, INTENT_TO_RENAME: 10, TYPE_CHANGED: 11,
  ADDED_BY_US: 12, ADDED_BY_THEM: 13, DELETED_BY_US: 14, DELETED_BY_THEM: 15, BOTH_ADDED: 16, BOTH_DELETED: 17, BOTH_MODIFIED: 18,
};

/** Status → the letter VS Code's Source Control view shows (conflicts: '!'; type changes shown as 'M'). */
const LETTER = {
  [Status.INDEX_MODIFIED]: 'M', [Status.MODIFIED]: 'M', [Status.TYPE_CHANGED]: 'M',
  [Status.INDEX_ADDED]: 'A', [Status.INTENT_TO_ADD]: 'A',
  [Status.INDEX_DELETED]: 'D', [Status.DELETED]: 'D',
  [Status.INDEX_RENAMED]: 'R', [Status.INTENT_TO_RENAME]: 'R',
  [Status.INDEX_COPIED]: 'C',
  [Status.UNTRACKED]: 'U',
};
const CONFLICTS = new Set([
  Status.ADDED_BY_US, Status.ADDED_BY_THEM, Status.DELETED_BY_US, Status.DELETED_BY_THEM,
  Status.BOTH_ADDED, Status.BOTH_DELETED, Status.BOTH_MODIFIED,
]);

const ACTIVATE_DEADLINE_MS = 8000;
const INIT_WAIT_MS = 4000;
const OP_DEADLINE_MS = 20000;
const COMMIT_DEADLINE_MS = 25000;
const CHANGES_CAP = 5000; // per repository
const SHOW_CAP = 2 * 1024 * 1024;
const CHANGED_DEBOUNCE_MS = 500;
const START_PROBE_MS = 5000; // start(): look for a running Git extension every 5 s …
const START_PROBES = 12; // … for one minute
// The Git extension only re-reads `git status` while its window is focused (it waits for "idle and
// focused"), so a VS Code window in the background on the PC would show stale changes to the phone.
// While unfocused we ask the repositories to refresh ourselves: after file changes in the workspace
// (debounced) and before answering git.status — at most once per FORCE_MIN_MS.
const KICK_DEBOUNCE_MS = 800;
const FORCE_MIN_MS = 2000;
const FORCE_DEADLINE_MS = 4000;

class GitUnavailable extends Error {}

class GitService {
  constructor({ connection, log }) {
    this.connection = connection;
    this.log = log;
    this.disposables = []; // api-level subscriptions
    this.repoSubs = new Map(); // repository → Disposable
    this._api = null;
    this._apiPromise = null;
    this._exportsSub = null;
    this._startTimer = null;
    this._disposed = false;
    this.emitChanged = debounce(() => this._emitChanged(), CHANGED_DEBOUNCE_MS);
    this._lastForced = 0;
    this._lastSig = '';
    this.kick = debounce(() => { this._refreshIfUnfocused().catch(() => {}); }, KICK_DEBOUNCE_MS);
  }

  start() {
    // Watch repositories as soon as the Git extension is running (it normally starts with the window,
    // possibly after us) so `git.changed` flows without a first git.* call; never activate it just for
    // that — the first git.* call does when needed.
    let tries = 0;
    const probe = () => {
      this._startTimer = null;
      if (this._api || this._disposed) return;
      try {
        const ext = vscode.extensions && typeof vscode.extensions.getExtension === 'function' ? vscode.extensions.getExtension('vscode.git') : undefined;
        if (!ext) return; // not in this extension host (remote window) or removed
        if (ext.isActive) {
          this.api().catch(() => {});
          return;
        }
      } catch {
        return;
      }
      if (++tries < START_PROBES) {
        this._startTimer = setTimeout(probe, START_PROBE_MS);
        if (this._startTimer.unref) this._startTimer.unref();
      }
    };
    probe();
  }

  methods() {
    return {
      'git.status': () => this.status(),
      'git.show': (p) => this.show(p),
      'git.stage': (p) => this.stage(p),
      'git.unstage': (p) => this.unstage(p),
      'git.discard': (p) => this.discard(p),
      'git.commit': (p) => this.commit(p),
    };
  }

  // ---- API access ----------------------------------------------------------------------------

  /** The git API (v1), activated and initialized; throws GitUnavailable with a readable reason. */
  api() {
    if (this._api) return Promise.resolve(this._api);
    if (!this._apiPromise) {
      this._apiPromise = this._loadApi().finally(() => {
        this._apiPromise = null;
      });
    }
    return this._apiPromise;
  }

  async _loadApi() {
    const ext = vscode.extensions && typeof vscode.extensions.getExtension === 'function' ? vscode.extensions.getExtension('vscode.git') : undefined;
    if (!ext) throw new GitUnavailable('the built-in Git extension is not available in this VS Code window');
    let exports = ext.exports;
    if (!ext.isActive || !exports) {
      try {
        exports = await withDeadline(Promise.resolve(ext.activate()), ACTIVATE_DEADLINE_MS, 'the Git extension is still starting: try again in a moment');
      } catch (err) {
        throw new GitUnavailable(err.code === 'DEADLINE' ? err.message : `the Git extension could not be activated here: ${errMsg(err)}`);
      }
    }
    if (!exports || typeof exports.getAPI !== 'function') {
      throw new GitUnavailable('the Git extension API is not reachable from this window (remote window?)');
    }
    if (exports.enabled === false) throw new GitUnavailable('Git is disabled in VS Code (setting "git.enabled")');
    let api;
    try {
      api = exports.getAPI(1);
    } catch (err) {
      throw new GitUnavailable(`the Git extension API is not available: ${errMsg(err)}`);
    }
    if (!this._exportsSub && typeof exports.onDidChangeEnablement === 'function') {
      this._exportsSub = exports.onDidChangeEnablement(() => this._reset());
    }
    if (api.state === 'uninitialized' && typeof api.onDidChangeState === 'function') {
      await new Promise((resolve) => {
        const timer = setTimeout(done, INIT_WAIT_MS);
        const sub = api.onDidChangeState((s) => {
          if (s === 'initialized') done();
        });
        function done() {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    }
    if (this._disposed) throw new GitUnavailable('TermPocket is shutting down');
    this._attach(api);
    this._api = api;
    this.emitChanged();
    return api;
  }

  _attach(api) {
    const sub = (fn, handler) => {
      if (typeof fn === 'function') this.disposables.push(fn.call(api, handler));
    };
    sub(api.onDidOpenRepository, (repo) => {
      this._watchRepo(repo);
      this.emitChanged();
    });
    sub(api.onDidCloseRepository, (repo) => {
      const d = this.repoSubs.get(repo);
      if (d) d.dispose();
      this.repoSubs.delete(repo);
      this.emitChanged();
    });
    for (const repo of api.repositories || []) this._watchRepo(repo);
    // File changes in the workspace → refresh Git's view while the window is in the background.
    try {
      if (vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === 'function') {
        const w = vscode.workspace.createFileSystemWatcher('**/*');
        const onFile = (uri) => {
          if (uri && /[\\/]\.git(?:[\\/]|$)/.test(uri.fsPath || uri.path || '')) return;
          this.kick();
        };
        this.disposables.push(w, w.onDidChange(onFile), w.onDidCreate(onFile), w.onDidDelete(onFile));
      }
    } catch (err) {
      this.log && this.log.warn && this.log.warn(`git: file watcher unavailable: ${errMsg(err)}`);
    }
  }

  /** Make the Git extension re-read the repositories when this window is not focused (see FORCE_MIN_MS). */
  async _refreshIfUnfocused() {
    const api = this._api;
    if (!api || this._disposed) return;
    const st = vscode.window && vscode.window.state;
    if (!st || st.focused !== false) return; // focused: the Git extension refreshes by itself
    if (Date.now() - this._lastForced < FORCE_MIN_MS) return;
    this._lastForced = Date.now();
    await Promise.all((api.repositories || []).map((r) => (typeof r.status === 'function'
      ? withDeadline(Promise.resolve(r.status()), FORCE_DEADLINE_MS, 'git status took too long').catch(() => {})
      : null)));
  }

  _watchRepo(repo) {
    if (this.repoSubs.has(repo) || !repo || !repo.state || typeof repo.state.onDidChange !== 'function') return;
    this.repoSubs.set(repo, repo.state.onDidChange(() => this.emitChanged()));
  }

  _reset() {
    for (const d of this.repoSubs.values()) safeDispose(d);
    this.repoSubs.clear();
    for (const d of this.disposables) safeDispose(d);
    this.disposables = [];
    this._api = null;
    this.emitChanged();
  }

  /** Repository containing `uri`, or an error naming the path. */
  _repoFor(api, uri) {
    const repo = typeof api.getRepository === 'function' ? api.getRepository(uri) : null;
    if (!repo) throw new Error(`${toPath(uri)} is not inside a Git repository open in this window`);
    return repo;
  }

  /** Group protocol paths by repository: Map repo → Uri[]. */
  _byRepo(api, paths) {
    const groups = new Map();
    for (const p of paths) {
      const uri = resolveUri(p);
      if (uri.scheme !== 'file') throw new Error(`${p} is not a local file (Git works on local files only)`);
      const repo = this._repoFor(api, uri);
      if (!groups.has(repo)) groups.set(repo, []);
      groups.get(repo).push(uri);
    }
    return groups;
  }

  // ---- methods -------------------------------------------------------------------------------

  async status() {
    let api;
    try {
      api = await this.api();
    } catch (err) {
      if (err instanceof GitUnavailable) return { available: false, reason: err.message, repos: [] };
      throw err;
    }
    await this._refreshIfUnfocused().catch(() => {});
    return { available: true, repos: (api.repositories || []).map(repoInfo) };
  }

  async show(p) {
    const api = await this._apiOrThrow();
    const uri = resolveUri(p.path);
    const ref = p.ref === undefined || p.ref === null ? 'HEAD' : String(p.ref);
    // '' / '~' / ':0' = the index (staged) version; anything else must look like a revision.
    const gitRef = ref === '~' || ref === ':0' ? '' : ref;
    if (gitRef && (!/^[\w./~^@{}:+-]+$/.test(gitRef) || gitRef.startsWith('-'))) throw new Error(`invalid ref: ${ref}`);
    const repo = this._repoFor(api, uri);
    const base = { path: toPath(uri), ref };
    let content;
    try {
      content = await withDeadline(repo.show(gitRef, uri.fsPath), OP_DEADLINE_MS, `git show took longer than ${OP_DEADLINE_MS / 1000} s`);
    } catch (err) {
      const text = `${errMsg(err)} ${err && err.stderr ? err.stderr : ''}`;
      // A file that is new (untracked / added), or a repository without commits yet.
      if (/exists on disk, but not in|does not exist in|invalid object name|bad revision|unknown revision|not a valid object|ambiguous argument/i.test(text)) {
        return Object.assign(base, { exists: false, content: '', binary: false, truncated: false });
      }
      throw new Error(`git show ${gitRef || ':'}:${toPath(uri)} failed: ${err && err.stderr ? String(err.stderr).trim() : errMsg(err)}`);
    }
    content = typeof content === 'string' ? content : String(content || '');
    if (content.slice(0, 8192).includes('\0')) return Object.assign(base, { exists: true, content: '', binary: true, truncated: false });
    let truncated = false;
    if (Buffer.byteLength(content, 'utf8') > SHOW_CAP) {
      content = Buffer.from(content, 'utf8').subarray(0, SHOW_CAP).toString('utf8').replace(/�$/, '');
      truncated = true;
    }
    return Object.assign(base, { exists: true, content, binary: false, truncated });
  }

  async stage(p) {
    const paths = requireStringArray(p.paths, 'paths');
    const api = await this._apiOrThrow();
    for (const [repo, uris] of this._byRepo(api, paths)) {
      await withDeadline(repo.add(uris.map((u) => u.fsPath)), OP_DEADLINE_MS, `git add took longer than ${OP_DEADLINE_MS / 1000} s`);
    }
    return true;
  }

  async unstage(p) {
    const paths = requireStringArray(p.paths, 'paths');
    const api = await this._apiOrThrow();
    for (const [repo, uris] of this._byRepo(api, paths)) {
      // git.d.ts Repository.revert(paths) = `git reset -q HEAD -- paths` (what VS Code's "Unstage" runs).
      await withDeadline(repo.revert(uris.map((u) => u.fsPath)), OP_DEADLINE_MS, `git reset took longer than ${OP_DEADLINE_MS / 1000} s`);
    }
    return true;
  }

  /**
   * Discard working-tree changes (VS Code's "Discard Changes"): tracked files are restored from the
   * index, untracked files are deleted (to the trash by default). Paths without working-tree changes
   * (e.g. only staged) are not touched and come back in `skipped` (unstage them first).
   */
  async discard(p) {
    const paths = requireStringArray(p.paths, 'paths');
    const api = await this._apiOrThrow();
    const discarded = [];
    const skipped = [];
    for (const [repo, uris] of this._byRepo(api, paths)) {
      const st = repo.state || {};
      const wt = new Map();
      for (const c of [...(st.workingTreeChanges || []), ...(st.untrackedChanges || [])]) {
        if (c && c.uri && c.status !== Status.IGNORED) wt.set(uriKey(c.uri), c.uri);
      }
      const toClean = [];
      for (const u of uris) {
        const own = wt.get(uriKey(u));
        if (own) {
          toClean.push(own.fsPath); // the repository's own spelling (clean() matches Uris exactly)
          discarded.push(toPath(own));
        } else {
          skipped.push(toPath(u));
        }
      }
      if (toClean.length) await withDeadline(repo.clean(toClean), OP_DEADLINE_MS, `discarding changes took longer than ${OP_DEADLINE_MS / 1000} s`);
    }
    return { discarded, skipped };
  }

  async commit(p) {
    const message = requireString(typeof p.message === 'string' ? p.message.trim() : p.message, 'message');
    const all = p.all === true;
    const api = await this._apiOrThrow();
    const repos = api.repositories || [];
    let repo;
    if (p.root) {
      const key = uriKey(resolveUri(p.root));
      repo = repos.find((r) => uriKey(r.rootUri) === key);
      if (!repo) throw new Error(`${p.root} is not a Git repository open in this window`);
    } else if (repos.length === 1) {
      repo = repos[0];
    } else if (!repos.length) {
      throw new Error('no Git repository is open in this window');
    } else {
      const candidates = repos.filter((r) => hasChanges(r, all));
      if (candidates.length !== 1) throw new Error('this window has several Git repositories: pass root');
      repo = candidates[0];
    }
    if (!hasChanges(repo, all)) {
      throw new Error(all ? 'there are no changes to commit' : 'there are no staged changes to commit: stage changes first (or pass all:true)');
    }
    // git.d.ts CommitOptions.all: `true` runs `git add -A` first, which stages UNTRACKED files too (a
    // stray .env or scratch file would be committed); 'tracked' runs `git add -u` = changes to tracked
    // files only, which is what `all` means in this protocol and what the client's prompt says.
    await withDeadline(
      repo.commit(message, { all: all ? 'tracked' : false }),
      COMMIT_DEADLINE_MS,
      `the commit is taking longer than ${COMMIT_DEADLINE_MS / 1000} s (git hooks or signing?); it may still complete: refresh in a moment`
    );
    const head = repo.state && repo.state.HEAD;
    return { root: toPath(repo.rootUri), commit: (head && head.commit) || null };
  }

  async _apiOrThrow() {
    try {
      return await this.api();
    } catch (err) {
      if (err instanceof GitUnavailable) throw new Error(`Git is not available: ${err.message}`);
      throw err;
    }
  }

  // ---- events --------------------------------------------------------------------------------

  _emitChanged() {
    if (!this.connection.connected) return;
    const repos = this._api ? (this._api.repositories || []).map((r) => {
      const info = repoInfo(r);
      return { root: info.root, branch: info.branch, ahead: info.ahead, behind: info.behind, changes: info.changes.length };
    }) : [];
    // A refresh we forced ourselves that changed nothing is not news (and must not make every client
    // call git.status again, which would force the next refresh …).
    const sig = JSON.stringify([!!this._api, this._api ? (this._api.repositories || []).map(repoInfo) : []]);
    if (sig === this._lastSig && Date.now() - this._lastForced < FORCE_MIN_MS + CHANGED_DEBOUNCE_MS + 1000) return;
    this._lastSig = sig;
    this.connection.notify('git.changed', { available: !!this._api, repos });
  }

  dispose() {
    this._disposed = true;
    if (this._startTimer) clearTimeout(this._startTimer);
    this._startTimer = null;
    this.emitChanged.cancel();
    if (this.kick.cancel) this.kick.cancel();
    for (const d of this.repoSubs.values()) safeDispose(d);
    this.repoSubs.clear();
    for (const d of this.disposables) safeDispose(d);
    this.disposables = [];
    if (this._exportsSub) safeDispose(this._exportsSub);
    this._exportsSub = null;
    this._api = null;
  }
}

function safeDispose(d) {
  try {
    if (d && typeof d.dispose === 'function') d.dispose();
  } catch {
    /* ignore */
  }
}

function hasChanges(repo, all) {
  const st = repo.state || {};
  if ((st.indexChanges || []).length) return true;
  return all && ((st.workingTreeChanges || []).some((c) => c.status !== Status.UNTRACKED && c.status !== Status.IGNORED));
}

function changeInfo(c, staged) {
  const conflict = CONFLICTS.has(c.status);
  const status = conflict ? '!' : LETTER[c.status] || 'M';
  const o = { path: toPath(c.uri), status, staged };
  if (conflict) o.conflict = true;
  if (c.originalUri && (status === 'R' || status === 'C') && uriKey(c.originalUri) !== uriKey(c.uri)) o.originalPath = toPath(c.originalUri);
  return o;
}

function repoInfo(repo) {
  const st = repo.state || {};
  const head = st.HEAD;
  const changes = [];
  let truncated = false;
  const add = (list, staged) => {
    for (const c of list || []) {
      if (!c || !c.uri || c.status === Status.IGNORED) continue;
      if (changes.length >= CHANGES_CAP) {
        truncated = true;
        return;
      }
      changes.push(changeInfo(c, staged));
    }
  };
  add(st.mergeChanges, false);
  add(st.indexChanges, true);
  add(st.workingTreeChanges, false);
  add(st.untrackedChanges, false);
  const upstream = head && head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null;
  const info = {
    root: toPath(repo.rootUri),
    branch: head ? head.name || (head.commit ? head.commit.slice(0, 8) : null) : null,
    detached: !!(head && !head.name && head.commit),
    commit: (head && head.commit) || null,
    upstream,
    ahead: upstream && Number.isInteger(head.ahead) ? head.ahead : null,
    behind: upstream && Number.isInteger(head.behind) ? head.behind : null,
    message: repo.inputBox && typeof repo.inputBox.value === 'string' ? repo.inputBox.value : '',
    changes,
  };
  if (truncated) info.truncated = true;
  return info;
}

module.exports = { GitService, Status, _internals: { repoInfo, changeInfo } };
