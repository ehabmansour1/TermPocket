'use strict';

/**
 * Minimal in-memory stand-in for the `vscode` module, good enough to activate the extension in plain
 * Node and exercise its RPC surface. Installed with `install()`, which hooks Module._load so that
 * `require('vscode')` anywhere returns this mock.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- events -------------------------------------------------------------------------------------

const listeners = new Map(); // "window.onDidOpenTerminal" -> Set<fn>

function eventFor(name) {
  return (fn, thisArg) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    const bound = thisArg ? fn.bind(thisArg) : fn;
    set.add(bound);
    return { dispose: () => set.delete(bound) };
  };
}

/** Fire a namespace event, e.g. fire('window.onDidStartTerminalShellExecution', e). */
function fire(name, arg) {
  const set = listeners.get(name);
  if (set) for (const fn of [...set]) fn(arg);
}

/** Proxy that invents `onDid*` / `onWill*` event functions for any name not defined explicitly. */
function withEvents(ns, prefix) {
  return new Proxy(ns, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^on(Did|Will)/.test(prop)) {
        target[prop] = eventFor(`${prefix}.${prop}`);
        return target[prop];
      }
      return undefined;
    },
  });
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (fn) => {
      this._listeners.add(fn);
      return { dispose: () => this._listeners.delete(fn) };
    };
  }
  fire(value) {
    for (const fn of [...this._listeners]) fn(value);
  }
  dispose() {
    this._listeners.clear();
  }
}

// ---- Uri / geometry -----------------------------------------------------------------------------

class Uri {
  constructor(scheme, authority, p, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority || '';
    this.path = p || '/';
    this.query = query;
    this.fragment = fragment;
  }
  static file(fsPath) {
    const abs = path.resolve(fsPath);
    let p = abs.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    return new Uri('file', '', p);
  }
  static parse(value) {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) throw new Error(`bad uri ${value}`);
    return new Uri(m[1], m[2] || '', m[3] || '/', m[4] || '', m[5] || '');
  }
  static joinPath(base, ...segments) {
    if (base.scheme === 'file') return Uri.file(path.join(base.fsPath, ...segments));
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  get fsPath() {
    if (this.scheme !== 'file') return this.path;
    const p = /^\/[a-zA-Z]:/.test(this.path) ? this.path.slice(1) : this.path;
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`;
  }
  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path };
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, text) {
    this.edits.push({ uri, range, text });
  }
  renameFile(oldUri, newUri, options) {
    this.edits.push({ rename: { oldUri, newUri, options: options || {} } });
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  }
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class TerminalProfile {
  constructor(options) {
    this.options = options;
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const FilePermission = { Readonly: 1 };

// ---- state --------------------------------------------------------------------------------------

const state = {
  settings: { agentUrl: '', configPath: '' },
  config: {}, // other sections, full key -> user (global) value, e.g. 'terminal.integrated.defaultProfile.windows'
  configUpdates: [], // {key, value, target} for every WorkspaceConfiguration.update (test helper)
  folders: [],
  commands: new Map(),
  outputLines: [],
  statusItems: [],
  terminals: [],
  activeTerminal: undefined,
  textDocuments: [],
  extensions: [], // {id, packageJSON, isActive, exports, activate()} (test helper: vscode.extensions.all)
  appliedEdits: [], // every WorkspaceEdit passed to workspace.applyEdit (test helper)
  applyEditResult: undefined, // force workspace.applyEdit's result (test helper)
  trashed: [], // paths deleted with useTrash (test helper)
};

// ---- terminals ----------------------------------------------------------------------------------

let pidSeq = 4000;

function createTerminal(nameOrOptions) {
  const options = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions || {};
  const pty = options.pty;
  const terminal = {
    name: options.name || (pty ? 'pty' : 'pwsh'),
    creationOptions: options,
    processId: Promise.resolve(pty ? undefined : ++pidSeq),
    shellIntegration: undefined,
    exitStatus: undefined,
    state: { isInteractedWith: false },
    output: '', // what the pseudoterminal wrote (test helper)
    sent: [], // sendText calls (test helper)
    shown: 0,
    sendText(text, addNewLine = true) {
      const data = addNewLine ? text + '\r' : text;
      this.sent.push(data);
      if (pty) pty.handleInput(data);
    },
    show() {
      this.shown++;
    },
    hide() {},
    dispose() {
      const i = state.terminals.indexOf(terminal);
      if (i < 0) return;
      state.terminals.splice(i, 1);
      if (pty) pty.close();
      fire('window.onDidCloseTerminal', terminal);
    },
  };
  state.terminals.push(terminal);
  if (pty) {
    pty.onDidWrite((d) => {
      terminal.output += d;
    });
    // VS Code opens the pseudoterminal asynchronously once the terminal instance exists.
    setTimeout(() => pty.open({ columns: 100, rows: 25 }), 5);
  }
  fire('window.onDidOpenTerminal', terminal);
  return terminal;
}

// ---- namespaces ---------------------------------------------------------------------------------

const window = withEvents(
  {
    get terminals() {
      return state.terminals;
    },
    get activeTerminal() {
      return state.activeTerminal;
    },
    activeTextEditor: undefined,
    state: { focused: true },
    tabGroups: withEvents({ all: [], activeTabGroup: undefined, close: async () => true }, 'tabGroups'),
    createOutputChannel(name) {
      const add = (lvl) => (m) => state.outputLines.push(`[${lvl}] ${m}`);
      return { name, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug'), trace: add('trace'), appendLine: add('line'), show() {}, dispose() {} };
    },
    createStatusBarItem() {
      const item = { text: '', tooltip: '', command: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      state.statusItems.push(item);
      return item;
    },
    createTerminal,
    registerTerminalProfileProvider(id, provider) {
      state.profileProvider = { id, provider };
      return { dispose() {} };
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({ revealRange() {} }),
  },
  'window'
);

const workspace = withEvents(
  {
    get workspaceFolders() {
      return state.folders.length ? state.folders : undefined;
    },
    get name() {
      return state.folders.length ? state.folders[0].name : undefined;
    },
    get textDocuments() {
      return state.textDocuments;
    },
    getConfiguration(section) {
      if (!section || section === 'termpocket') {
        return {
          get: (key, def) => (key in state.settings ? state.settings[key] : def),
          inspect: (key) => ({ key: `termpocket.${key}`, globalValue: state.settings[key] }),
          async update(key, value) {
            state.configUpdates.push({ key: `termpocket.${key}`, value });
            state.settings[key] = value;
          },
        };
      }
      const full = (key) => `${section}.${key}`;
      return {
        get: (key, def) => (full(key) in state.config ? state.config[full(key)] : def),
        has: (key) => full(key) in state.config,
        inspect: (key) => ({
          key: full(key),
          globalValue: state.config[full(key)],
          workspaceValue: (state.workspaceConfig || {})[full(key)],
        }),
        async update(key, value, target) {
          state.configUpdates.push({ key: full(key), value, target });
          if (value === undefined) delete state.config[full(key)];
          else state.config[full(key)] = value;
          fire('workspace.onDidChangeConfiguration', {
            affectsConfiguration: (s) => full(key) === s || full(key).startsWith(`${s}.`),
          });
        },
      };
    },
    fs: {
      async stat(uri) {
        const st = await fs.promises.lstat(uri.fsPath).catch((e) => {
          throw Object.assign(new Error(`EntryNotFound (FileSystemError): ${uri}`), { code: e.code });
        });
        let type = st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown;
        if (st.isSymbolicLink()) {
          type = FileType.SymbolicLink;
          try {
            const t = await fs.promises.stat(uri.fsPath);
            type |= t.isDirectory() ? FileType.Directory : FileType.File;
          } catch {
            /* broken link */
          }
        }
        return { type, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
      },
      async readDirectory(uri) {
        const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.File]);
      },
      async readFile(uri) {
        return new Uint8Array(await fs.promises.readFile(uri.fsPath));
      },
      async writeFile(uri, data) {
        await fs.promises.writeFile(uri.fsPath, data);
      },
      async createDirectory(uri) {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      },
      async rename(from, to, options = {}) {
        if (!options.overwrite && fs.existsSync(to.fsPath) && from.fsPath.toLowerCase() !== to.fsPath.toLowerCase()) {
          throw Object.assign(new Error(`EntryExists (FileSystemError): ${to}`), { code: 'FileExists' });
        }
        await fs.promises.rename(from.fsPath, to.fsPath);
      },
      async delete(uri, options = {}) {
        const st = await fs.promises.lstat(uri.fsPath).catch(() => {
          throw Object.assign(new Error(`EntryNotFound (FileSystemError): ${uri}`), { code: 'FileNotFound' });
        });
        if (st.isDirectory() && !options.recursive && (await fs.promises.readdir(uri.fsPath)).length) {
          throw new Error(`Unable to delete non-empty folder '${uri.fsPath}'.`);
        }
        if (options.useTrash) state.trashed.push(uri.fsPath);
        await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
      },
    },
    findFiles: async () => [],
    openTextDocument: async () => {
      throw new Error('not supported in mock');
    },
    async applyEdit(edit) {
      state.appliedEdits.push(edit);
      if (state.applyEditResult !== undefined) return state.applyEditResult;
      for (const e of (edit && edit.edits) || []) {
        if (e.rename) await fs.promises.rename(e.rename.oldUri.fsPath, e.rename.newUri.fsPath);
      }
      return true;
    },
    saveAll: async () => true,
  },
  'workspace'
);

const commands = {
  registerCommand(id, fn) {
    state.commands.set(id, fn);
    return { dispose: () => state.commands.delete(id) };
  },
  async executeCommand(id, ...args) {
    if (state.commands.has(id)) return state.commands.get(id)(...args);
    if (id === 'test.echo') return { args, when: new Date(0) };
    throw new Error(`command '${id}' not found`);
  },
  async getCommands() {
    return [...state.commands.keys(), 'test.echo', 'workbench.action.files.save'];
  },
};

const extensions = withEvents(
  {
    get all() {
      return state.extensions;
    },
    getExtension(id) {
      return state.extensions.find((e) => e.id === id);
    },
  },
  'extensions'
);

const languages = withEvents({ getDiagnostics: (uri) => (uri ? [] : []) }, 'languages');

const vscodeMock = {
  version: '1.145.0-mock',
  EventEmitter,
  Uri,
  Position,
  Range,
  Selection: Range,
  WorkspaceEdit,
  ThemeIcon,
  TerminalProfile,
  FileType,
  FilePermission,
  CancellationTokenSource,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  ViewColumn: { Active: -1, One: 1 },
  window,
  workspace,
  commands,
  languages,
  extensions,
  env: { clipboard: { readText: async () => '', writeText: async () => {} }, appName: 'Mock Code' },
  // test helpers (not part of the real API)
  _state: state,
  _fire: fire,
  _setFolders(dirs) {
    state.folders = dirs.map((d, index) => ({ uri: Uri.file(d), name: path.basename(d), index }));
  },
};

let installed = false;
function install() {
  if (installed) return vscodeMock;
  installed = true;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return origLoad.call(this, request, parent, isMain);
  };
  return vscodeMock;
}

module.exports = { install, vscodeMock };
