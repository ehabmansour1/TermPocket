'use strict';

/**
 * PROTOCOL §5.2 `settings.*`: user-level settings the phone may toggle.
 *
 *  - `mirrorDefault`: make "TermPocket (mirrored)" (the terminal profile this extension contributes) the
 *    default VS Code terminal profile, i.e. the USER setting `terminal.integrated.defaultProfile.<os>` for
 *    windows / osx / linux. VS Code matches a contributed default profile by its title. Turning it off only
 *    clears values that still name our profile and restores what the user had before, if we remembered it.
 *
 * TermPocket used to be called "VS Control": a user default profile that still names the old profile title
 * "VS Control (mirrored)" (which no longer exists) is switched to "TermPocket (mirrored)" once at start-up.
 */

const vscode = require('vscode');

const MIRROR_PROFILE_TITLE = 'TermPocket (mirrored)';
/** The same profile's title before the rename. */
const LEGACY_MIRROR_PROFILE_TITLES = ['VS Control (mirrored)'];
const isLegacyTitle = (v) => typeof v === 'string' && LEGACY_MIRROR_PROFILE_TITLES.includes(v);
const PLATFORM_KEYS = ['windows', 'osx', 'linux'];
const SECTION = 'terminal.integrated';
const PREV_KEY = 'termpocket.previousDefaultProfile'; // globalState: {windows?, osx?, linux?}

function currentPlatformKey() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function globalTarget() {
  return vscode.ConfigurationTarget && vscode.ConfigurationTarget.Global !== undefined ? vscode.ConfigurationTarget.Global : true;
}

class SettingsService {
  /**
   * @param {object} deps
   * @param {import('./connection').RpcConnection} deps.connection
   * @param {object} deps.log
   * @param {{get(key: string): any, update(key: string, value: any): Thenable<void>}|undefined} [deps.memento]
   */
  constructor({ connection, log, memento }) {
    this.connection = connection;
    this.log = log;
    this.memento = memento && typeof memento.get === 'function' && typeof memento.update === 'function' ? memento : null;
    this.disposables = [];
    this._last = null;
  }

  start() {
    this.ready = this.migrateLegacyDefault().catch((err) => {
      this.log.warn(`could not migrate the old mirrored default profile: ${err && err.message ? err.message : err}`);
    });
    const ws = vscode.workspace;
    if (typeof ws.onDidChangeConfiguration === 'function') {
      this.disposables.push(
        ws.onDidChangeConfiguration((e) => {
          if (!e || typeof e.affectsConfiguration !== 'function' || e.affectsConfiguration(`${SECTION}.defaultProfile`)) {
            this._emitIfChanged();
          }
        })
      );
    }
    this.connection.on('connected', () => {
      this._last = null;
    });
  }

  _config() {
    return vscode.workspace.getConfiguration(SECTION);
  }

  /**
   * USER values of terminal.integrated.defaultProfile.<os> that still name the pre-rename profile title
   * ("VS Control (mirrored)") are switched to MIRROR_PROFILE_TITLE, so new terminals stay phone-visible.
   * @returns {Promise<string[]>} the platform keys that were changed
   */
  async migrateLegacyDefault() {
    const changed = [];
    for (const os of PLATFORM_KEYS) {
      if (!isLegacyTitle(this._globalValue(os))) continue;
      await this._config().update(`defaultProfile.${os}`, MIRROR_PROFILE_TITLE, globalTarget());
      changed.push(os);
    }
    if (changed.length) this.log.info(`default terminal profile "${LEGACY_MIRROR_PROFILE_TITLES[0]}" renamed to "${MIRROR_PROFILE_TITLE}" (${changed.join(', ')})`);
    return changed;
  }

  /** User-level (global) value of terminal.integrated.defaultProfile.<os>. */
  _globalValue(os) {
    const cfg = this._config();
    if (typeof cfg.inspect === 'function') {
      const i = cfg.inspect(`defaultProfile.${os}`);
      return i ? i.globalValue : undefined;
    }
    return cfg.get(`defaultProfile.${os}`);
  }

  isMirrorDefault() {
    return this._globalValue(currentPlatformKey()) === MIRROR_PROFILE_TITLE;
  }

  /**
   * A workspace / folder value of this OS's default profile that differs from the user value: it wins
   * over the user setting, so new terminals in this window are not mirrored even when mirrorDefault is
   * on. We never write workspace settings; we only report it.
   */
  overriddenBy() {
    const cfg = this._config();
    if (typeof cfg.inspect !== 'function') return null;
    const i = cfg.inspect(`defaultProfile.${currentPlatformKey()}`);
    if (!i) return null;
    const user = i.globalValue;
    for (const [scope, v] of [['workspaceFolder', i.workspaceFolderValue], ['workspace', i.workspaceValue]]) {
      if (v !== undefined && v !== null && v !== user) return scope;
    }
    return null;
  }

  get() {
    const r = { mirrorDefault: this.isMirrorDefault(), mirrorProfile: MIRROR_PROFILE_TITLE };
    const by = this.overriddenBy();
    if (by) r.overriddenBy = by;
    return r;
  }

  async setMirrorDefault(enable) {
    const cfg = this._config();
    const target = globalTarget();
    const prev = (this.memento && this.memento.get(PREV_KEY)) || {};
    const nextPrev = { ...prev };
    for (const os of PLATFORM_KEYS) {
      const key = `defaultProfile.${os}`;
      const cur = this._globalValue(os);
      if (enable) {
        if (cur === MIRROR_PROFILE_TITLE) continue;
        if (cur !== undefined && cur !== null && !isLegacyTitle(cur)) nextPrev[os] = cur;
        else delete nextPrev[os];
        await cfg.update(key, MIRROR_PROFILE_TITLE, target);
      } else {
        if (cur !== MIRROR_PROFILE_TITLE && !isLegacyTitle(cur)) continue; // the user chose something else meanwhile: leave it
        await cfg.update(key, prev[os] !== undefined ? prev[os] : undefined, target);
        delete nextPrev[os];
      }
    }
    if (this.memento) {
      try {
        await this.memento.update(PREV_KEY, nextPrev);
      } catch {
        /* best effort */
      }
    }
    const enabled = this.isMirrorDefault();
    this.log.info(`mirrored default terminal profile ${enabled ? 'enabled' : 'disabled'}`);
    this._emitIfChanged();
    const r = { enabled };
    const by = this.overriddenBy();
    if (by) r.overriddenBy = by;
    return r;
  }

  _emitIfChanged() {
    const s = this.get();
    if (this._last && this._last.mirrorDefault === s.mirrorDefault) return;
    this._last = s;
    this.connection.notify('settings.changed', s);
  }

  methods() {
    return {
      'settings.get': () => this.get(),
      'settings.mirrorDefault': (p) => {
        if (!p || typeof p.enable !== 'boolean') throw new Error('missing or invalid parameter: enable');
        return this.setMirrorDefault(p.enable);
      },
    };
  }

  dispose() {
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

module.exports = { SettingsService, MIRROR_PROFILE_TITLE, LEGACY_MIRROR_PROFILE_TITLES, PLATFORM_KEYS };
