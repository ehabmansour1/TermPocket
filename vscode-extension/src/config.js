'use strict';

/**
 * Locating the agent and its pairing token (PROTOCOL §1).
 *
 * The extension runs on the same PC as the agent, so it reads the token straight from the agent's
 * config.json. Everything is re-read on every connection attempt, so pairing / starting the agent
 * after VS Code has started works without reloading the window.
 *
 * Lookup order for config.json:
 *   1. setting `termpocket.configPath` (a file, or a folder containing config.json)
 *   2. `%TERMPOCKET_HOME%\config.json`
 *   3. `%APPDATA%\TermPocket\config.json` (non-Windows fallback: `$XDG_CONFIG_HOME/TermPocket` or `~/.config/TermPocket`)
 *
 * TermPocket used to be called "VS Control": every `termpocket.*` setting falls back to the old
 * `vscontrol.*` USER setting, `TERMPOCKET_*` env variables to `VSCONTROL_*`, and until the agent has
 * copied its old folder (%APPDATA%\VSControl) the token is read from there.
 *
 * Agent URL: setting `termpocket.agentUrl` when non-empty, else `ws://<host>:<port>/vscode` derived from
 * config.json (`TERMPOCKET_PORT` / `TERMPOCKET_HOST` env overrides honoured like the agent does,
 * wildcard hosts mapped to 127.0.0.1).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const SECTION = 'termpocket';
const LEGACY_SECTION = 'vscontrol';
const LEGACY_DIR_NAME = 'VSControl';

/** `TERMPOCKET_<name>`, else the pre-rename `VSCONTROL_<name>`. */
function envValue(name) {
  const v = process.env[`TERMPOCKET_${name}`];
  return v !== undefined ? v : process.env[`VSCONTROL_${name}`];
}

/**
 * Value of setting `termpocket.<key>`. When the user has not set it, the old `vscontrol.<key>` is used,
 * but only its USER (global) value: the old keys are no longer declared, so VS Code would not stop a
 * workspace's .vscode/settings.json from setting them (`termpocket.*` are declared with scope "application").
 */
function getSetting(key, def) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const own = typeof cfg.inspect === 'function' ? cfg.inspect(key) : null;
  const ownSet = own ? own.globalValue !== undefined : cfg.get(key) !== undefined;
  if (!ownSet) {
    try {
      const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
      const i = legacy && typeof legacy.inspect === 'function' ? legacy.inspect(key) : null;
      if (i && i.globalValue !== undefined && i.globalValue !== null) return i.globalValue;
    } catch {
      /* no legacy settings */
    }
  }
  return cfg.get(key, def);
}

/** Expand `~`, `%VAR%` and `${env:VAR}` in a user supplied path. */
function expandPath(p) {
  let out = String(p).trim();
  out = out.replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] || '');
  out = out.replace(/%([^%\\/]+)%/g, (whole, name) => (process.env[name] !== undefined ? process.env[name] : whole));
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return out;
}

/** Folder that holds the agent's config.json when no explicit setting is given. */
function defaultConfigDir() {
  const home = envValue('HOME');
  if (home) return expandPath(home);
  const base = process.env.APPDATA
    ? process.env.APPDATA
    : process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(base, 'TermPocket');
  // Before the agent's one-time copy of the pre-rename folder, the token is still only in the old one.
  const legacy = path.join(base, LEGACY_DIR_NAME);
  if (!fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(legacy, 'config.json'))) return legacy;
  return dir;
}

function readSettings() {
  const str = (key) => {
    const v = getSetting(key);
    return typeof v === 'string' ? v.trim() : '';
  };
  return { agentUrl: str('agentUrl'), configPath: str('configPath') };
}

/** Absolute path of the config.json that will be read. */
function resolveConfigPath(settings = readSettings()) {
  if (settings.configPath) {
    const p = path.resolve(expandPath(settings.configPath));
    try {
      if (fs.statSync(p).isDirectory()) return path.join(p, 'config.json');
    } catch {
      /* not existing yet: treat as a file path unless it clearly names a folder */
      if (!/\.json$/i.test(p)) return path.join(p, 'config.json');
    }
    return p;
  }
  return path.join(defaultConfigDir(), 'config.json');
}

/** Normalise the host the agent listens on into one we can connect to. */
function connectHost(host) {
  const h = typeof host === 'string' ? host.trim() : '';
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]' || h === 'localhost') return DEFAULT_HOST;
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`; // bare IPv6 literal
  return h;
}

/** Normalise a user supplied agent URL (accepts http(s) and converts it to ws(s)). */
function normaliseAgentUrl(raw) {
  let url = raw.trim();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error(`termpocket.agentUrl must start with ws:// or wss:// (got "${raw}")`);
  }
  // Validate it parses.
  // eslint-disable-next-line no-new
  new URL(url);
  return url;
}

/**
 * Everything needed for one connection attempt.
 * Never throws: problems are reported through `error` so the caller can keep retrying.
 * @returns {{configPath: string, url: string|null, token: string|null, error: string|null}}
 */
function loadConnectionSettings() {
  const settings = readSettings();
  const configPath = resolveConfigPath(settings);
  const result = { configPath, url: null, token: null, error: null };

  let config = null;
  try {
    let text = fs.readFileSync(configPath, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM written by some editors
    config = JSON.parse(text);
    if (!config || typeof config !== 'object') throw new Error('not a JSON object');
  } catch (err) {
    result.error =
      err && err.code === 'ENOENT'
        ? `config file not found: ${configPath} (start the TermPocket agent once to create it)`
        : `cannot read ${configPath}: ${err && err.message ? err.message : err}`;
  }

  // URL: explicit setting wins, else derive from config (port/host) with env overrides.
  try {
    if (settings.agentUrl) {
      result.url = normaliseAgentUrl(settings.agentUrl);
    } else {
      const envPort = Number(envValue('PORT'));
      const cfgPort = config ? Number(config.port) : NaN;
      const port = Number.isInteger(envPort) && envPort > 0 ? envPort : Number.isInteger(cfgPort) && cfgPort > 0 ? cfgPort : DEFAULT_PORT;
      const host = connectHost(envValue('HOST') || (config && config.host));
      result.url = `ws://${host}:${port}/vscode`;
    }
  } catch (err) {
    result.error = result.error || (err && err.message ? err.message : String(err));
  }

  if (config) {
    if (typeof config.token === 'string' && config.token.length > 0) {
      result.token = config.token;
    } else if (!result.error) {
      result.error = `no "token" in ${configPath}`;
    }
  }
  return result;
}

module.exports = { loadConnectionSettings, resolveConfigPath, readSettings, defaultConfigDir, expandPath, connectHost, getSetting, envValue };
