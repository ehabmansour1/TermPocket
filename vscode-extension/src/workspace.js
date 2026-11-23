'use strict';

/**
 * Workspace, file, editor, diagnostics and command methods (PROTOCOL §5.2) plus the
 * `editor.changed`, `diagnostics.changed` and `window.update` events.
 *
 * Paths: everything goes through `vscode.workspace.fs` with Uris so any file system provider works.
 *  - Windows (`C:\x`, `C:/x`), UNC (`\\server\share`) and POSIX absolute paths are file paths
 *    (a POSIX path in a window whose first folder is remote keeps that folder's scheme/authority).
 *  - `scheme://…` strings are parsed as Uris.
 *  - Relative paths resolve against the first workspace folder.
 * Paths we return are `fsPath` for `file:` Uris and the Uri string for anything else.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { errMsg, debounce, jsonSafe, requireString, clampInt, withDeadline } = require('./util');
const { buildCatalog, titledCommands } = require('./commandCatalog');

const READ_CAP = 2 * 1024 * 1024; // fs.read content cap (bytes)
const BINARY_SNIFF = 8 * 1024; // NUL byte in the first 8 KB → binary
const DIAGNOSTICS_CAP = 500;
const COMMANDS_CAP = 300;
const COMMANDS_TITLED_MAX = 5000;
const LIST_CAP = 10000; // fs.list entries (sorted first); more → truncated:true, total
const STAT_BUDGET_MS = 3000; // fs.list: per-entry stats after this are skipped (size/mtime 0)
const LIST_DEADLINE_MS = 20000; // < the agent's 30 s vsc.call timeout: answer with a clear error first
const QUICK_DEADLINE_MS = 10000; // commands.list, fs.stat, fs.mkdir
const SEARCH_DEADLINE_MS = 20000;
const FILE_OP_DEADLINE_MS = 25000; // fs.rename / fs.delete (big folders, rename participants)
const SELECTION_CAP = 64 * 1024;
const STAT_CONCURRENCY = 32;
const IS_WINDOWS = process.platform === 'win32';

const SEVERITY = ['error', 'warning', 'info', 'hint'];

/** Extension → VS Code language id for files that are not open (best effort, no document load). */
const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.jsx': 'javascriptreact',
  '.ts': 'typescript', '.cts': 'typescript', '.mts': 'typescript', '.tsx': 'typescriptreact',
  '.json': 'json', '.jsonc': 'jsonc', '.json5': 'json5', '.md': 'markdown', '.markdown': 'markdown',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.vue': 'vue',
  '.svelte': 'svelte', '.py': 'python', '.pyw': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.dart': 'dart', '.lua': 'lua', '.r': 'r', '.sql': 'sql', '.sh': 'shellscript', '.bash': 'shellscript',
  '.zsh': 'shellscript', '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.bat': 'bat', '.cmd': 'bat', '.xml': 'xml', '.svg': 'xml', '.xaml': 'xml', '.csproj': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini', '.properties': 'properties',
  '.dockerfile': 'dockerfile', '.gradle': 'groovy', '.groovy': 'groovy', '.txt': 'plaintext', '.log': 'log',
  '.env': 'dotenv', '.gitignore': 'ignore', '.vb': 'vb', '.fs': 'fsharp', '.scala': 'scala', '.pl': 'perl',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell', '.clj': 'clojure', '.tex': 'latex',
  '.diff': 'diff', '.patch': 'diff', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'proto3',
};
const LANGUAGE_BY_NAME = {
  dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', '.gitignore': 'ignore',
  '.npmrc': 'properties', '.editorconfig': 'properties', '.env': 'dotenv',
};

// ---- path helpers -----------------------------------------------------------------------------

function firstFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri : null;
}

/** Uri → string returned to the phone. */
function toPath(uri) {
  if (!uri) return null;
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

/** Comparable key for a Uri (case-insensitive drive/path for local Windows files). */
function uriKey(uri) {
  if (uri.scheme === 'file') {
    const p = path.normalize(uri.fsPath);
    return IS_WINDOWS ? p.toLowerCase() : p;
  }
  return uri.toString();
}

/** Resolve a protocol path (absolute, relative or Uri string) into a Uri. */
function resolveUri(p, { allowDefault = false } = {}) {
  if (p === undefined || p === null || p === '') {
    if (!allowDefault) throw new Error('missing or invalid parameter: path');
    const f = firstFolder();
    if (!f) throw new Error('no workspace folder is open');
    return f;
  }
  if (typeof p !== 'string') throw new Error('missing or invalid parameter: path');
  if (/^[a-zA-Z]:([\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p)) return vscode.Uri.file(p);
  // Any "scheme:" prefix (2+ chars, so never a drive letter) is a Uri string: "file://…", "untitled:…",
  // and also authority-less ones VS Code prints with a single slash ("vscode-userdata:/c%3A/…", "git:/…").
  if (/^[a-zA-Z][\w+.-]+:/.test(p)) return vscode.Uri.parse(p, true);
  const folder = firstFolder();
  if (p.startsWith('/')) {
    if (folder && folder.scheme !== 'file') return folder.with({ path: p });
    return vscode.Uri.file(p);
  }
  if (!folder) throw new Error(`relative path "${p}" needs an open workspace folder`);
  const segments = p.split(/[\\/]+/).filter((s) => s && s !== '.');
  return segments.length ? vscode.Uri.joinPath(folder, ...segments) : folder;
}

/** cwd parameter (terminals) → local path string or undefined. */
function resolveLocalCwd(p) {
  try {
    const uri = p ? resolveUri(p) : firstFolder();
    if (uri && uri.scheme === 'file') return uri.fsPath;
  } catch {
    /* fall through */
  }
  return p && path.isAbsolute(p) ? p : undefined;
}

/** vscode.FileSystemError FileNotFound (or a raw ENOENT from a provider). */
function isNotFound(err) {
  if (!err) return false;
  if (err.code === 'FileNotFound' || err.code === 'ENOENT' || err.code === 'EntryNotFound') return true;
  return /(FileNotFound|EntryNotFound|ENOENT)/.test(errMsg(err));
}

function isWorkspaceRoot(uri) {
  const key = uriKey(uri);
  return (vscode.workspace.workspaceFolders || []).some((f) => uriKey(f.uri) === key);
}

/** `uri` is a workspace folder or contains one (deleting / moving it would pull the workspace away). */
function containsWorkspaceFolder(uri) {
  const key = uriKey(uri);
  const sep = uri.scheme === 'file' ? path.sep : '/';
  const prefix = key.endsWith(sep) ? key : key + sep;
  return (vscode.workspace.workspaceFolders || []).some((f) => {
    const k = uriKey(f.uri);
    return k === key || k.startsWith(prefix);
  });
}

function findOpenDocument(uri) {
  const key = uriKey(uri);
  return vscode.workspace.textDocuments.find((d) => !d.isClosed && uriKey(d.uri) === key) || null;
}

function languageFor(uri) {
  const base = path.posix.basename(uri.path).toLowerCase();
  if (LANGUAGE_BY_NAME[base]) return LANGUAGE_BY_NAME[base];
  const ext = path.posix.extname(base);
  return LANGUAGE_BY_EXT[ext] || 'plaintext';
}

function fileTypeName(type) {
  const T = vscode.FileType;
  if (type & T.Directory) return 'dir'; // includes symlinks to directories (navigable)
  if (type & T.SymbolicLink) return 'symlink';
  return 'file';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Read at most `limit` bytes of a file (ranged read for local files). Other schemes (remote windows:
 * vscode-remote:, …) have no ranged read in the API, so a file larger than `limit` (known from `size`)
 * is NOT read at all → null: pulling a multi-GB file into the extension host would stall or crash it.
 */
async function readHead(uri, limit, size) {
  if (uri.scheme === 'file') {
    const fh = await fs.promises.open(uri.fsPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(limit);
      let total = 0;
      while (total < limit) {
        const { bytesRead } = await fh.read(buf, total, limit - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buf.subarray(0, total);
    } finally {
      await fh.close();
    }
  }
  if (!(Number(size) >= 0) || size > limit) return null;
  const data = await vscode.workspace.fs.readFile(uri);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buf.length > limit ? buf.subarray(0, limit) : buf;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Windows-1252 (falls back to Latin-1 where the runtime has no legacy decoders). */
function decodeLegacy(buf) {
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Decode file bytes without losing information: strict UTF-8 (a BOM is reported, not silently dropped);
 * anything that is not valid UTF-8 is shown as Windows-1252 and flagged, so it is never round-tripped
 * through U+FFFD. `partial` = the buffer was cut at a cap (an incomplete last character is fine).
 * @returns {{text: string, encoding: 'utf8'|'utf8bom'|'windows-1252'}}
 */
function decodeText(buf, partial = false) {
  let body = buf;
  let encoding = 'utf8';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    body = buf.subarray(3);
    encoding = 'utf8bom';
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body, { stream: partial }), encoding };
  } catch {
    return { text: decodeLegacy(buf), encoding: 'windows-1252' };
  }
}

function decodeUtf8(buf) {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(buf);
}

/** Truncate a string so its UTF-8 encoding is at most `maxBytes`. */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, size: buf.length };
  return { text: decodeUtf8(buf.subarray(0, maxBytes)).replace(/\uFFFD$/, ''), truncated: true, size: buf.length };
}

// ---- service -----------------------------------------------------------------------------------

class WorkspaceService {
  constructor({ connection, log, windowInfo }) {
    this.connection = connection;
    this.log = log;
    this.windowInfo = windowInfo; // () => {name, folders, focused}
    this.disposables = [];
    this.lastDiagCounts = null;
    this._catalog = null; // commands.list {withTitles} catalog (rebuilt when extensions change)

    this.emitEditorChanged = debounce(() => this._emitEditorChanged(), 300);
    this.emitDiagnosticsChanged = debounce(() => this._emitDiagnosticsChanged(), 1000);
    this.emitWindowUpdate = debounce(() => this._emitWindowUpdate(), 100);
  }

  start() {
    const w = vscode.window;
    const ws = vscode.workspace;
    const sub = (fn, handler) => {
      if (typeof fn === 'function') this.disposables.push(fn(handler));
    };
    sub(w.onDidChangeActiveTextEditor, () => this.emitEditorChanged());
    if (w.tabGroups) {
      sub(w.tabGroups.onDidChangeTabs, () => this.emitEditorChanged());
      sub(w.tabGroups.onDidChangeTabGroups, () => this.emitEditorChanged());
    }
    sub(vscode.languages.onDidChangeDiagnostics, () => this.emitDiagnosticsChanged());
    sub(ws.onDidChangeWorkspaceFolders, () => this.emitWindowUpdate());
    sub(w.onDidChangeWindowState, () => this.emitWindowUpdate());
    if (vscode.extensions) sub(vscode.extensions.onDidChange, () => (this._catalog = null));

    this.connection.on('connected', () => {
      // Agent knows name/folders from hello but not focus; phones want fresh counts.
      this._emitWindowUpdate();
      this.lastDiagCounts = null;
      this._emitDiagnosticsChanged();
    });
  }

  methods() {
    return {
      'workspace.info': () => this.workspaceInfo(),
      'fs.list': (p) => this.fsList(p),
      'fs.read': (p) => this.fsRead(p),
      'fs.write': (p) => this.fsWrite(p),
      'fs.search': (p) => this.fsSearch(p),
      'fs.stat': (p) => this.fsStat(p),
      'fs.mkdir': (p) => this.fsMkdir(p),
      'fs.rename': (p) => this.fsRename(p),
      'fs.delete': (p) => this.fsDelete(p),
      'editor.open': (p) => this.editorOpen(p),
      'editor.tabs': () => this.editorTabs(),
      'editor.active': () => this.editorActive(),
      'editor.save': (p) => this.editorSave(p),
      'editor.close': (p) => this.editorClose(p),
      'diagnostics.list': (p) => this.diagnosticsList(p),
      'commands.list': (p) => this.commandsList(p),
      'commands.run': (p) => this.commandsRun(p),
    };
  }

  // ---- workspace / fs ------------------------------------------------------------------------

  workspaceInfo() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: toPath(f.uri) }));
    const editor = vscode.window.activeTextEditor;
    return {
      name: vscode.workspace.name || null,
      folders,
      activeFile: editor ? toPath(editor.document.uri) : null,
    };
  }

  async fsList(p) {
    if ((p.path === undefined || p.path === null || p.path === '') && !firstFolder()) {
      throw new Error('this VS Code window has no folder open (open a folder on the PC, or pass a path)');
    }
    const uri = resolveUri(p.path, { allowDefault: true });
    return withDeadline(this._fsList(uri), LIST_DEADLINE_MS, `listing ${toPath(uri)} took longer than ${LIST_DEADLINE_MS / 1000} s (slow or unreachable file system?)`);
  }

  async _fsList(uri) {
    const raw = await vscode.workspace.fs.readDirectory(uri);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    let entries = raw.map(([name, type]) => ({ name, type: fileTypeName(type), size: 0, mtime: 0 }));
    entries.sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1;
      const db = b.type === 'dir' ? 0 : 1;
      return da - db || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    // A huge folder (generated files, caches) must not produce a multi-MB answer or stat storm.
    const truncated = entries.length > LIST_CAP;
    if (truncated) entries = entries.slice(0, LIST_CAP);
    // Sizes and dates are a nicety: a slow file system (network share, cloud placeholders, remote
    // window) must not keep the explorer on "Loading…". Stats still running after STAT_BUDGET_MS are
    // abandoned and those entries keep size/mtime 0.
    let stopped = false;
    const stats = mapLimit(entries, STAT_CONCURRENCY, async (e) => {
      if (stopped) return;
      try {
        const st = await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, e.name));
        if (stopped) return;
        e.size = st.size || 0;
        e.mtime = st.mtime || 0;
      } catch {
        /* broken link / permission: keep zeros */
      }
    });
    let budget = null;
    await Promise.race([
      stats,
      new Promise((resolve) => {
        budget = setTimeout(resolve, STAT_BUDGET_MS);
        if (budget.unref) budget.unref();
      }),
    ]);
    clearTimeout(budget);
    stopped = true;
    const out = { path: toPath(uri), entries };
    if (truncated) {
      out.truncated = true;
      out.total = raw.length;
    }
    return out;
  }

  async fsRead(p) {
    const uri = resolveUri(p.path);
    const doc = findOpenDocument(uri);
    let stat = null;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (!doc) throw new Error(`cannot read ${p.path}: ${errMsg(err)}`);
    }
    if (stat && stat.type & vscode.FileType.Directory) throw new Error(`${p.path} is a directory`);

    if (doc) {
      const { text, truncated, size } = truncateUtf8(doc.getText(), READ_CAP);
      return {
        path: toPath(doc.uri),
        content: text,
        languageId: doc.languageId,
        size,
        mtime: stat ? stat.mtime : 0,
        isDirty: doc.isDirty,
        truncated,
        binary: false,
      };
    }

    const size = stat.size || 0;
    const base = { path: toPath(uri), languageId: languageFor(uri), size, mtime: stat.mtime || 0, isDirty: false };
    const head = await readHead(uri, READ_CAP, size);
    if (!head) {
      // Too large to preview in this (remote) window without reading all of it.
      return Object.assign(base, { content: '', truncated: true, binary: false });
    }
    const sniff = head.subarray(0, Math.min(head.length, BINARY_SNIFF));
    if (sniff.includes(0)) {
      return Object.assign(base, { content: '', truncated: false, binary: true });
    }
    // stat size beyond what we read (or an unknown size with a full read) means the cap was hit.
    const truncated = size > head.length || (!size && head.length >= READ_CAP);
    const { text, encoding } = decodeText(head, truncated);
    return Object.assign(base, { content: text, truncated, binary: false, encoding });
  }

  async fsWrite(p) {
    const uri = resolveUri(p.path);
    if (typeof p.content !== 'string') throw new Error('missing or invalid parameter: content');
    const doc = findOpenDocument(uri);
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));
      edit.replace(doc.uri, fullRange, p.content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error(`could not apply edit to ${toPath(doc.uri)}`);
      // An untitled document has no file name: save() would pop a modal Save As dialog on the
      // (unattended) PC and hang this request. Its text is updated; saving it is done on the PC.
      if (doc.isUntitled) return true;
      const saved = await doc.save();
      if (!saved && doc.isDirty) throw new Error(`could not save ${toPath(doc.uri)}`);
      return true;
    }
    // Make sure the parent folder exists (createDirectory is mkdir -p).
    try {
      const parent = vscode.Uri.joinPath(uri, '..');
      await vscode.workspace.fs.createDirectory(parent);
    } catch {
      /* exists or not creatable; writeFile reports the real error */
    }
    let data = Buffer.from(p.content, 'utf8');
    // Keep the file's encoding: re-add a UTF-8 BOM it had; never rewrite a non-UTF-8 (legacy code page)
    // file as UTF-8 — that would silently turn every non-ASCII character into U+FFFD.
    let head = null;
    let partial = false;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (!(st.type & vscode.FileType.Directory)) {
        head = await readHead(uri, READ_CAP, st.size || 0);
        partial = !!head && st.size > head.length;
      }
    } catch {
      /* new file */
    }
    if (head && head.length) {
      const enc = head.subarray(0, Math.min(head.length, BINARY_SNIFF)).includes(0) ? 'binary' : decodeText(head, partial).encoding;
      if (enc === 'windows-1252' || enc === 'binary') {
        throw new Error(`${toPath(uri)} is not UTF-8 text (${enc === 'binary' ? 'binary' : 'legacy code page'}); refusing to overwrite it: edit it in VS Code on the PC`);
      }
      if (enc === 'utf8bom' && !p.content.startsWith('\uFEFF')) data = Buffer.concat([UTF8_BOM, data]);
    }
    await vscode.workspace.fs.writeFile(uri, data);
    return true;
  }

  async fsSearch(p) {
    const query = requireString(p.query, 'query');
    const max = clampInt(p.max, 1, 5000, 50);
    const cts = typeof vscode.CancellationTokenSource === 'function' ? new vscode.CancellationTokenSource() : null;
    try {
      const uris = await withDeadline(
        vscode.workspace.findFiles('**/*' + query + '*', '**/{node_modules,.git}/**', max, cts ? cts.token : undefined),
        SEARCH_DEADLINE_MS,
        `file search took longer than ${SEARCH_DEADLINE_MS / 1000} s (very large workspace?): try a more specific name`
      );
      return uris.map(toPath);
    } finally {
      if (cts) {
        cts.cancel();
        cts.dispose();
      }
    }
  }

  /** `{path, exists:false}` or `{path, exists:true, type, size, mtime, ctime, readonly}`. */
  async fsStat(p) {
    const uri = resolveUri(p.path);
    let st;
    try {
      st = await withDeadline(vscode.workspace.fs.stat(uri), QUICK_DEADLINE_MS, `stat of ${toPath(uri)} timed out`);
    } catch (err) {
      if (isNotFound(err)) return { path: toPath(uri), exists: false };
      throw err;
    }
    const readonly = !!(st.permissions && vscode.FilePermission && st.permissions & vscode.FilePermission.Readonly);
    return { path: toPath(uri), exists: true, type: fileTypeName(st.type), size: st.size || 0, mtime: st.mtime || 0, ctime: st.ctime || 0, readonly };
  }

  /** New folder (parents are created too). Anything already at that path is an error, as in VS Code's explorer. */
  async fsMkdir(p) {
    const uri = resolveUri(p.path);
    if (await this._exists(uri)) throw new Error(`${toPath(uri)} already exists`);
    await withDeadline(vscode.workspace.fs.createDirectory(uri), QUICK_DEADLINE_MS, `creating ${toPath(uri)} timed out`);
    return { path: toPath(uri) };
  }

  /**
   * Rename / move through a WorkspaceEdit so VS Code keeps open editors (and dirty text) on the new
   * name and lets rename participants run (e.g. TypeScript import updates, which ask on the PC);
   * falls back to `workspace.fs.rename` when the edit is refused.
   */
  async fsRename(p) {
    const from = resolveUri(requireString(p.from, 'from'));
    const to = resolveUri(requireString(p.to, 'to'));
    const overwrite = p.overwrite === true;
    if (!(await this._exists(from))) throw new Error(`${toPath(from)} does not exist`);
    const caseOnly = uriKey(from) === uriKey(to);
    if (caseOnly && from.toString() === to.toString()) return { from: toPath(from), to: toPath(to) };
    if (!caseOnly && !overwrite && (await this._exists(to))) throw new Error(`${toPath(to)} already exists`);
    if (containsWorkspaceFolder(from)) throw new Error(`${toPath(from)} ${isWorkspaceRoot(from) ? 'is' : 'contains'} a workspace folder: rename it on the PC`);
    const op = async () => {
      let applied = false;
      if (typeof vscode.WorkspaceEdit === 'function' && typeof vscode.WorkspaceEdit.prototype.renameFile === 'function') {
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(from, to, { overwrite, ignoreIfExists: false });
        try {
          applied = await vscode.workspace.applyEdit(edit);
        } catch (err) {
          this.log.debug && this.log.debug(`fs.rename: workspace edit failed (${errMsg(err)}), using workspace.fs.rename`);
        }
      }
      if (!applied) await vscode.workspace.fs.rename(from, to, { overwrite });
    };
    await withDeadline(op(), FILE_OP_DEADLINE_MS, `renaming ${toPath(from)} is taking longer than ${FILE_OP_DEADLINE_MS / 1000} s (it may still finish)`);
    return { from: toPath(from), to: toPath(to) };
  }

  /** Delete to the OS trash (default). A workspace folder root or a drive root is refused. */
  async fsDelete(p) {
    const uri = resolveUri(p.path);
    if (containsWorkspaceFolder(uri)) throw new Error(`${toPath(uri)} ${isWorkspaceRoot(uri) ? 'is' : 'contains'} a workspace folder: it cannot be deleted from here`);
    if (uri.path === '/' || /^\/[a-zA-Z]:\/?$/.test(uri.path)) throw new Error(`refusing to delete ${toPath(uri)}`);
    if (!(await this._exists(uri))) throw new Error(`${toPath(uri)} does not exist`);
    const useTrash = p.useTrash !== false;
    const recursive = p.recursive === true;
    try {
      await withDeadline(
        vscode.workspace.fs.delete(uri, { recursive, useTrash }),
        FILE_OP_DEADLINE_MS,
        `deleting ${toPath(uri)} is taking longer than ${FILE_OP_DEADLINE_MS / 1000} s (it may still finish)`
      );
    } catch (err) {
      const msg = errMsg(err);
      if (!recursive && /not empty|non-empty|nonempty|ENOTEMPTY|EISDIR|is a directory/i.test(msg)) throw new Error(`${toPath(uri)} is a folder that is not empty: pass recursive:true`);
      // Never silently fall back to a permanent delete when the trash is unavailable.
      if (useTrash && /trash/i.test(msg)) throw new Error(`${toPath(uri)} cannot be moved to the trash here (${msg}); pass useTrash:false to delete it permanently`);
      throw err;
    }
    return { path: toPath(uri), trash: useTrash };
  }

  async _exists(uri) {
    try {
      await withDeadline(vscode.workspace.fs.stat(uri), QUICK_DEADLINE_MS, `stat of ${toPath(uri)} timed out`);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  // ---- editor --------------------------------------------------------------------------------

  async editorOpen(p) {
    const uri = resolveUri(p.path);
    const line = clampInt(p.line, 1, Number.MAX_SAFE_INTEGER, 0);
    const column = clampInt(p.column, 1, Number.MAX_SAFE_INTEGER, 1);
    const options = {};
    if (typeof p.preview === 'boolean') options.preview = p.preview;
    let doc;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      // Binary or otherwise non-text: let VS Code pick an editor (image viewer, hex editor, …).
      await vscode.commands.executeCommand('vscode.open', uri, options);
      return true;
    }
    if (line > 0) {
      const pos = doc.validatePosition(new vscode.Position(line - 1, column - 1));
      options.selection = new vscode.Range(pos, pos);
    }
    const editor = await vscode.window.showTextDocument(doc, options);
    if (options.selection) editor.revealRange(options.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  editorTabs() {
    const out = [];
    const groups = vscode.window.tabGroups;
    if (!groups) return out;
    for (const group of groups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        out.push({
          label: tab.label,
          path: uri ? toPath(uri) : null,
          group: group.viewColumn,
          isActive: !!(tab.isActive && group.isActive),
          isDirty: !!tab.isDirty,
          isPinned: !!tab.isPinned,
        });
      }
    }
    return out;
  }

  editorActive() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const sel = editor.selection;
    let selectionText = sel && !sel.isEmpty ? editor.document.getText(sel) : '';
    if (selectionText.length > SELECTION_CAP) selectionText = selectionText.slice(0, SELECTION_CAP);
    return {
      path: toPath(editor.document.uri),
      languageId: editor.document.languageId,
      line: sel ? sel.active.line + 1 : 1,
      column: sel ? sel.active.character + 1 : 1,
      selectionText,
    };
  }

  async editorSave(p) {
    if (p.path === undefined || p.path === null || p.path === '') {
      await vscode.workspace.saveAll(false);
      return true;
    }
    const doc = findOpenDocument(resolveUri(p.path));
    if (!doc) return true; // not open → nothing unsaved
    if (doc.isUntitled) {
      // save() would open a modal Save As dialog on the unattended PC (and this request would hang).
      throw new Error(`${toPath(doc.uri)} has never been saved: choose a file name on the PC`);
    }
    const saved = await doc.save();
    if (!saved && doc.isDirty) throw new Error(`could not save ${toPath(doc.uri)}`);
    return true;
  }

  async editorClose(p) {
    const key = uriKey(resolveUri(p.path));
    const tabs = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        if (uri && uriKey(uri) === key) tabs.push(tab);
      }
    }
    // Closing a dirty editor makes VS Code show a modal "Save changes?" dialog on the unattended PC
    // (and this request would hang until someone answers it). Refuse instead; the phone can save first.
    if (tabs.some((t) => t.isDirty)) throw new Error(`${toPath(resolveUri(p.path))} has unsaved changes: save it first (or close it on the PC)`);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    return true;
  }

  // ---- diagnostics / commands ----------------------------------------------------------------

  diagnosticsList(p) {
    let pairs;
    if (p.path) {
      const uri = resolveUri(p.path);
      pairs = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      pairs = vscode.languages.getDiagnostics();
    }
    const out = [];
    for (const [uri, diags] of pairs) {
      const filePath = toPath(uri);
      for (const d of diags) {
        out.push({
          path: filePath,
          severity: SEVERITY[d.severity] || 'info',
          message: d.message,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          source: d.source || null,
          code: diagnosticCode(d.code),
          ...diagnosticTags(d.tags),
          _sev: typeof d.severity === 'number' ? d.severity : 2,
        });
      }
    }
    // Keep the most severe ones when capping.
    out.sort((a, b) => a._sev - b._sev || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column);
    return out.slice(0, DIAGNOSTICS_CAP).map((d) => {
      delete d._sev;
      return d;
    });
  }

  async commandsList(p) {
    const all = await withDeadline(vscode.commands.getCommands(true), QUICK_DEADLINE_MS, `VS Code did not list its commands within ${QUICK_DEADLINE_MS / 1000} s`);
    if (p.withTitles === true) {
      const query = typeof p.query === 'string' ? p.query : typeof p.filter === 'string' ? p.filter : '';
      return titledCommands(this._commandCatalog(), all, { query, max: clampInt(p.max, 1, COMMANDS_TITLED_MAX, COMMANDS_CAP) });
    }
    const filter = typeof p.filter === 'string' ? p.filter.trim().toLowerCase() : '';
    const list = filter ? all.filter((c) => c.toLowerCase().includes(filter)) : all.slice();
    list.sort();
    return list.slice(0, COMMANDS_CAP);
  }

  /** Titles/categories/keybindings of every installed extension's commands (+ curated built-ins), cached. */
  _commandCatalog() {
    if (!this._catalog) {
      let exts = [];
      try {
        exts = (vscode.extensions && vscode.extensions.all) || [];
      } catch (err) {
        this.log.warn(`extensions.all failed: ${errMsg(err)}`);
      }
      this._catalog = buildCatalog(exts);
    }
    return this._catalog;
  }

  async commandsRun(p) {
    const command = requireString(p.command, 'command');
    if (p.args !== undefined && p.args !== null && !Array.isArray(p.args)) throw new Error('args must be an array');
    const r = await vscode.commands.executeCommand(command, ...(p.args || []));
    return { result: jsonSafe(r) };
  }

  // ---- events --------------------------------------------------------------------------------

  _emitEditorChanged() {
    if (!this.connection.connected) return;
    try {
      this.connection.notify('editor.changed', { active: this.editorActive(), tabs: this.editorTabs() });
    } catch (err) {
      this.log.warn(`editor.changed failed: ${errMsg(err)}`);
    }
  }

  _emitDiagnosticsChanged() {
    if (!this.connection.connected) return;
    let errors = 0;
    let warnings = 0;
    for (const [, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
    }
    const key = `${errors}/${warnings}`;
    if (key === this.lastDiagCounts) return;
    if (this.connection.notify('diagnostics.changed', { errors, warnings })) this.lastDiagCounts = key;
  }

  _emitWindowUpdate() {
    if (!this.connection.connected) return;
    this.connection.notify('window.update', this.windowInfo());
  }

  dispose() {
    this.emitEditorChanged.cancel();
    this.emitDiagnosticsChanged.cancel();
    this.emitWindowUpdate.cancel();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables = [];
  }
}

function tabUri(tab) {
  const input = tab.input;
  if (!input) return null;
  if (input.uri) return input.uri; // TabInputText, TabInputCustom, TabInputNotebook
  if (input.modified) return input.modified; // TabInputTextDiff, TabInputNotebookDiff
  return null;
}

function diagnosticCode(code) {
  if (code === undefined || code === null) return null;
  if (typeof code === 'object') return code.value === undefined ? null : code.value;
  return code;
}

/** vscode.DiagnosticTag (1 = Unnecessary, 2 = Deprecated) → `{tags: ['unnecessary'|'deprecated']}` or `{}`. */
function diagnosticTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return {};
  const names = [];
  if (tags.includes(1)) names.push('unnecessary');
  if (tags.includes(2)) names.push('deprecated');
  return names.length ? { tags: names } : {};
}

module.exports ={ WorkspaceService, resolveUri, resolveLocalCwd, toPath, uriKey, _internals: { readHead, decodeText } };
