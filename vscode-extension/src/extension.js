'use strict';

/**
 * TermPocket — VS Code extension entry point.
 *
 * Connects this window to the local TermPocket agent (`/vscode` WebSocket, PROTOCOL §5) so the phone
 * app can browse/edit files, drive editors, run commands, see problems and use terminals here.
 */

const crypto = require('crypto');
const vscode = require('vscode');
const { RpcConnection } = require('./connection');
const config = require('./config');
const { TerminalService } = require('./terminals');
const { MirrorManager } = require('./mirror');
const { SettingsService } = require('./settings');
const { RING_CAP_DEFAULT } = require('./live');
const { TerminalSnapshots } = require('./snapshot');
const { WorkspaceService, resolveLocalCwd, toPath } = require('./workspace');
const { GitService } = require('./git');
const { errMsg } = require('./util');

const PROFILE_ID = 'termpocket.mirroredTerminal';
const LIVE_BUFFER_KB_MIN = 64;
const LIVE_BUFFER_KB_MAX = 8192;

let liveRingCapCache = 0;

/**
 * Live-view raw ring size per terminal in characters (setting `termpocket.liveBufferKB`, default 512).
 * Called for every output chunk, so the value is cached until the setting changes.
 */
function liveRingCap() {
  if (!liveRingCapCache) liveRingCapCache = readLiveRingCap();
  return liveRingCapCache;
}

function readLiveRingCap() {
  let kb;
  try {
    kb = config.getSetting('liveBufferKB', RING_CAP_DEFAULT / 1024);
  } catch {
    kb = undefined;
  }
  if (typeof kb !== 'number' || !Number.isFinite(kb)) return RING_CAP_DEFAULT;
  return Math.round(Math.min(LIVE_BUFFER_KB_MAX, Math.max(LIVE_BUFFER_KB_MIN, kb))) * 1024;
}

/** @type {{dispose(): void}|null} */
let current = null;

function createLogger() {
  const channel = vscode.window.createOutputChannel('TermPocket', { log: true });
  const isLog = channel && typeof channel.info === 'function';
  const line = (level, msg) => {
    if (isLog) {
      const fn = level === 'debug' ? channel.debug : level === 'warn' ? channel.warn : level === 'error' ? channel.error : channel.info;
      fn.call(channel, msg);
    } else {
      channel.appendLine(`[${new Date().toISOString()}] [${level}] ${msg}`);
    }
  };
  return {
    channel,
    info: (m) => line('info', m),
    warn: (m) => line('warn', m),
    error: (m) => line('error', m),
    debug: (m) => line('debug', m),
  };
}

function windowName() {
  return vscode.workspace.name || 'VS Code';
}

function folderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => toPath(f.uri));
}

/** http(s)://host:port/pair derived from the agent WebSocket URL (the agent serves it to loopback only). */
function pairPageUrl(wsUrl) {
  try {
    const u = new URL(wsUrl || 'ws://127.0.0.1:8765/vscode');
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/pair';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'http://127.0.0.1:8765/pair';
  }
}

function windowFocused() {
  return !!(vscode.window.state && vscode.window.state.focused);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const log = createLogger();
  context.subscriptions.push(log.channel);

  // Random per activation (PROTOCOL §5.1); stays the same across reconnects of this window.
  const windowId = crypto.randomUUID();
  const extVersion = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0.0.0';
  log.info(`TermPocket ${extVersion} activating (window ${windowId}, VS Code ${vscode.version})`);

  const connection = new RpcConnection({
    resolveTarget: () => config.loadConnectionSettings(),
    helloParams: () => ({
      windowId,
      name: windowName(),
      folders: folderPaths(),
      vscodeVersion: vscode.version,
      pid: process.pid,
    }),
    log,
  });

  // ---- services ------------------------------------------------------------------------------
  const snapshots = new TerminalSnapshots({
    log,
    // The agent tells whether the Windows clipboard holds only text (PROTOCOL §5.3 clipboard.info): a
    // snapshot borrows the clipboard and can only restore text.
    clipboardRestorable: async () => {
      if (!connection.connected) return null;
      try {
        const r = await connection.request('clipboard.info', {}, { timeoutMs: 1000 });
        return r && typeof r.restorable === 'boolean' ? r.restorable : null;
      } catch {
        return null; // older agent (unknown method) or no clipboard access
      }
    },
    enabled: () => {
      try {
        return config.getSetting('terminalSnapshot', true) !== false;
      } catch {
        return true;
      }
    },
  });
  const terminals = new TerminalService({ connection, log, resolveCwd: resolveLocalCwd, ringCap: liveRingCap, snapshots });
  const mirrors = new MirrorManager({
    connection,
    log,
    tidOf: (t) => terminals.tidOf(t),
    defaultCwd: () => resolveLocalCwd(undefined),
    defaultTitle: () => (vscode.workspace.name ? `${vscode.workspace.name} (VS Code)` : 'VS Code'),
    onChange: () => terminals.emitChanged(),
  });
  terminals.mirrors = mirrors;
  const settings = new SettingsService({ connection, log, memento: context.globalState });
  const workspace = new WorkspaceService({
    connection,
    log,
    windowInfo: () => ({ name: windowName(), folders: folderPaths(), focused: windowFocused() }),
  });

  const git = new GitService({ connection, log });

  connection.registerAll(workspace.methods());
  connection.registerAll(git.methods());
  connection.registerAll(terminals.methods());
  connection.registerAll(mirrors.methods());
  connection.registerAll(settings.methods());
  terminals.start();
  workspace.start();
  git.start();
  settings.start();

  // ---- status bar ----------------------------------------------------------------------------
  const status = vscode.window.createStatusBarItem('termpocket.status', vscode.StatusBarAlignment.Left, 0);
  status.name = 'TermPocket';
  status.command = 'termpocket.showMenu';
  const renderStatus = () => {
    const info = connection.info;
    if (connection.connected) {
      status.text = '$(remote) TermPocket';
      status.tooltip = `TermPocket: connected to agent${info.agentVersion ? ` ${info.agentVersion}` : ''}\n${info.url || ''}`;
      status.backgroundColor = undefined;
    } else {
      status.text = '$(debug-disconnect) TermPocket';
      const what = connection.state === 'connecting' ? 'connecting…' : 'disconnected';
      status.tooltip = `TermPocket: ${what}${info.lastError ? `\n${info.lastError}` : ''}\n${info.url || ''}`;
    }
    status.show();
  };
  connection.on('state', renderStatus);
  renderStatus();
  context.subscriptions.push(status);

  // ---- commands ------------------------------------------------------------------------------
  const showInfo = async () => {
    const info = connection.info;
    const configPath = info.configPath || config.resolveConfigPath();
    let url = info.url;
    if (!url) {
      const s = config.loadConnectionSettings();
      url = s.url;
    }
    const lines = [
      `State: ${connection.state}${info.agentVersion ? ` (agent ${info.agentVersion})` : ''}`,
      `Agent URL: ${url || '(unknown)'}`,
      `Config: ${configPath}`,
      `Window id: ${windowId}`,
    ];
    if (info.lastError && !connection.connected) lines.push(`Last error: ${info.lastError}`);
    log.info(`pairing info:\n  ${lines.join('\n  ')}`);
    const OPEN_CONFIG = 'Open config.json';
    const COPY_URL = 'Copy agent URL';
    const SETTINGS = 'Settings';
    const choice = await vscode.window.showInformationMessage(
      'TermPocket',
      { modal: true, detail: `${lines.join('\n')}\n\nPair your phone with the QR code printed by the agent, or open ${pairPageUrl(url)} in a browser on this PC.` },
      OPEN_CONFIG,
      COPY_URL,
      SETTINGS
    );
    if (choice === OPEN_CONFIG) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showWarningMessage(`TermPocket: cannot open ${configPath}: ${errMsg(err)}`);
      }
    } else if (choice === COPY_URL && url) {
      await vscode.env.clipboard.writeText(url);
    } else if (choice === SETTINGS) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'termpocket');
    }
  };

  const reconnect = () => {
    log.info('reconnect requested');
    connection.reconnect();
  };

  const newMirroredTerminal = () => {
    mirrors.createLazyTerminal('TermPocket');
  };

  const mirrorDefault = async () => {
    try {
      if (settings.isMirrorDefault()) {
        const OFF = 'Turn off';
        const choice = await vscode.window.showInformationMessage(
          'TermPocket: new terminals already open as "TermPocket (mirrored)" (phone-visible).',
          OFF
        );
        if (choice === OFF) {
          await settings.setMirrorDefault(false);
          vscode.window.showInformationMessage('TermPocket: new terminals use your normal default profile again.');
        }
        return;
      }
      await settings.setMirrorDefault(true);
      vscode.window.showInformationMessage(
        'TermPocket: new terminals now open as "TermPocket (mirrored)" and are fully visible on your phone. Existing terminals stay as they are.'
      );
    } catch (err) {
      vscode.window.showWarningMessage(`TermPocket: could not change the default terminal profile: ${errMsg(err)}`);
    }
  };

  const showMenu = async () => {
    const items = [
      { label: '$(refresh) Reconnect', description: connection.connected ? 'connected' : connection.state, run: reconnect },
      { label: '$(terminal) New mirrored terminal', description: 'visible on your phone too', run: newMirroredTerminal },
      {
        label: '$(device-mobile) Make new terminals phone-visible',
        description: settings.isMirrorDefault() ? 'on' : 'default profile: TermPocket (mirrored)',
        run: mirrorDefault,
      },
      { label: '$(info) Show pairing info', description: 'agent URL & config path', run: showInfo },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'TermPocket', placeHolder: connection.info.url || '' });
    if (pick) await pick.run();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('termpocket.reconnect', reconnect),
    vscode.commands.registerCommand('termpocket.newMirroredTerminal', newMirroredTerminal),
    vscode.commands.registerCommand('termpocket.showInfo', showInfo),
    vscode.commands.registerCommand('termpocket.showMenu', showMenu),
    vscode.commands.registerCommand('termpocket.mirrorDefault', mirrorDefault)
  );

  if (typeof vscode.window.registerTerminalProfileProvider === 'function') {
    context.subscriptions.push(
      vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
        provideTerminalProfile: () => mirrors.provideProfile(),
      })
    );
  }

  // Settings changes (agent URL / config path) take effect immediately.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // (vscontrol.* = the same settings under the pre-rename name, still read as a fallback)
      if (e.affectsConfiguration('termpocket.liveBufferKB') || e.affectsConfiguration('vscontrol.liveBufferKB')) liveRingCapCache = 0;
      if (['termpocket.agentUrl', 'termpocket.configPath', 'vscontrol.agentUrl', 'vscontrol.configPath'].some((k) => e.affectsConfiguration(k))) {
        log.info('settings changed, reconnecting');
        connection.reconnect();
      }
    })
  );

  connection.start();

  let disposed = false;
  const disposable = {
    dispose() {
      if (disposed) return;
      disposed = true;
      connection.stop();
      terminals.dispose();
      workspace.dispose();
      git.dispose();
      settings.dispose();
      mirrors.dispose();
    },
  };
  context.subscriptions.push(disposable);
  current = disposable;

  // Small API surface (used by tests and potential companion extensions).
  return { windowId, connection, terminals, mirrors, workspace, settings, git };
}

function deactivate() {
  if (current) {
    current.dispose();
    current = null;
  }
}

module.exports = { activate, deactivate };
