// Config loading / creation (PROTOCOL.md §1).
//
// The config lives in %APPDATA%\TermPocket\config.json (override the directory with TERMPOCKET_HOME).
// It is created on first run with a fresh random token and pretty-printed. Missing keys in an existing
// file are filled with defaults (and the file is rewritten) but user values are never discarded.
// Env overrides (TERMPOCKET_PORT, TERMPOCKET_HOST, TERMPOCKET_PUBLIC_URL) apply at runtime only and are
// never written back to disk.
//
// TermPocket used to be called "VS Control". For existing installs:
//   * every TERMPOCKET_* variable still accepts its old VSCONTROL_* name (envValue / applyLegacyEnv);
//   * the settings in the old folder %APPDATA%\VSControl are copied into %APPDATA%\TermPocket once, on the
//     first start without TERMPOCKET_HOME (config.json with the pairing token, relay.json, ...), so paired
//     phones and the relay keep working (migrateLegacyConfigDir). The old folder is left in place.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULTS = Object.freeze({
  port: 8765,
  host: '127.0.0.1',
  defaultShell: 'powershell.exe',
  scrollbackBytes: 262144,
  screen: Object.freeze({ fps: 2, quality: 50, maxWidth: 1280 }),
});

/** Folder name under %APPDATA% before the rename to TermPocket. */
export const LEGACY_DIR_NAME = 'VSControl';
/** Files of the old folder that are NOT copied: ptyhost.json belongs to the old PTY host and its pipe. */
const MIGRATE_SKIP = new Set(['ptyhost.json']);

/** `TERMPOCKET_<name>`, else the pre-rename `VSCONTROL_<name>` (undefined when neither is set). */
export function envValue(env, name) {
  const v = env[`TERMPOCKET_${name}`];
  return v !== undefined ? v : env[`VSCONTROL_${name}`];
}

/**
 * Copy every VSCONTROL_* variable to its TERMPOCKET_* name unless that is set already, so code that reads
 * process.env.TERMPOCKET_* directly also honours the old names. Called once at process start (legacyEnv.js).
 */
export function applyLegacyEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('VSCONTROL_')) continue;
    const name = `TERMPOCKET_${key.slice('VSCONTROL_'.length)}`;
    if (env[name] === undefined) env[name] = env[key];
  }
  return env;
}

function appDataDir(env) {
  return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Directory holding config.json (and the autostart launcher / log). */
export function getConfigDir(env = process.env) {
  const home = envValue(env, 'HOME');
  if (home) return path.resolve(home);
  return path.join(appDataDir(env), 'TermPocket');
}

/** The pre-rename config folder (%APPDATA%\VSControl). */
export function getLegacyConfigDir(env = process.env) {
  return path.join(appDataDir(env), LEGACY_DIR_NAME);
}

/**
 * One-time migration from the pre-rename folder: when no TERMPOCKET_HOME / VSCONTROL_HOME is set, the new
 * folder has no config.json yet and %APPDATA%\VSControl\config.json exists, copy the old folder's JSON
 * settings (config.json with the pairing token, relay.json, ...; not ptyhost.json, logs or launchers) into
 * the new folder. Files already in the new folder are kept (the install script may have created it, with its
 * launchers, before the agent first ran). config.json is copied last and through a temp file, so a
 * half-finished copy never counts as migrated. Returns {from, to, files} when it copied, else null.
 */
export function migrateLegacyConfigDir(env = process.env) {
  if (envValue(env, 'HOME')) return null;
  const to = getConfigDir(env);
  const from = getLegacyConfigDir(env);
  if (fs.existsSync(path.join(to, 'config.json')) || !fs.existsSync(path.join(from, 'config.json'))) return null;
  const isConfig = (name) => name.toLowerCase() === 'config.json';
  const files = fs
    .readdirSync(from, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.json$/i.test(d.name) && !MIGRATE_SKIP.has(d.name.toLowerCase()))
    .map((d) => d.name)
    .sort((a, b) => Number(isConfig(a)) - Number(isConfig(b)));
  fs.mkdirSync(to, { recursive: true });
  const copied = [];
  for (const name of files) {
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) continue;
    const tmp = `${dest}.${process.pid}.migrating`;
    fs.copyFileSync(path.join(from, name), tmp);
    fs.renameSync(tmp, dest);
    copied.push(name);
  }
  return copied.length ? { from, to, files: copied } : null;
}

export function getConfigPath(env = process.env) {
  return path.join(getConfigDir(env), 'config.json');
}

/** 32 random bytes, base64url (43 chars, no padding). */
export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parsePort(value, source) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port ${JSON.stringify(value)} from ${source}`);
  }
  return n;
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Load (creating if needed) the config.
 * @returns {object} config with runtime-only, non-enumerable `configDir` / `configPath` properties.
 */
export function loadConfig({ env = process.env, migrate = true } = {}) {
  const migrated = migrate ? migrateLegacyConfigDir(env) : null;
  const dir = getConfigDir(env);
  const file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });

  let stored = null;
  if (fs.existsSync(file)) {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate a BOM written by Notepad/PowerShell
    try {
      stored = JSON.parse(text);
    } catch (err) {
      // Never overwrite a file the user may have hand-edited; tell them exactly what is wrong.
      throw new Error(`config file ${file} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(stored)) throw new Error(`config file ${file} must contain a JSON object`);
  }

  // Merge defaults under the stored values; remember whether anything had to be filled in.
  const base = stored ? { ...stored } : {};
  let dirty = !stored;
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (base[key] === undefined) {
      base[key] = isPlainObject(value) ? { ...value } : value;
      dirty = true;
    }
  }
  if (isPlainObject(base.screen)) {
    for (const [key, value] of Object.entries(DEFAULTS.screen)) {
      if (base.screen[key] === undefined) {
        base.screen = { ...base.screen, [key]: value };
        dirty = true;
      }
    }
  } else {
    base.screen = { ...DEFAULTS.screen };
    dirty = true;
  }
  if (typeof base.token !== 'string' || base.token.length < 16) {
    base.token = generateToken();
    dirty = true;
  }

  if (dirty) {
    // Keep a stable, readable key order for freshly created files.
    const ordered = {
      port: base.port,
      host: base.host,
      token: base.token,
      defaultShell: base.defaultShell,
      scrollbackBytes: base.scrollbackBytes,
      screen: base.screen,
      ...base,
    };
    writeJsonAtomic(file, ordered);
  }

  // Runtime view: validate and apply env overrides (not persisted).
  const config = structuredClone(base);
  const envPort = envValue(env, 'PORT');
  config.port = parsePort(envPort ?? config.port, envPort != null ? 'TERMPOCKET_PORT' : 'config.port');
  const envHost = envValue(env, 'HOST');
  if (envHost) config.host = envHost;
  if (typeof config.host !== 'string' || !config.host) config.host = DEFAULTS.host;
  const envPublicUrl = envValue(env, 'PUBLIC_URL');
  if (envPublicUrl) config.publicUrl = envPublicUrl;
  if (typeof config.publicUrl === 'string') {
    config.publicUrl = config.publicUrl.trim().replace(/\/+$/, '') || undefined;
  } else {
    delete config.publicUrl;
  }
  const sb = Number(config.scrollbackBytes);
  config.scrollbackBytes = Number.isFinite(sb) && sb >= 1024 ? Math.floor(sb) : DEFAULTS.scrollbackBytes;
  if (typeof config.defaultShell !== 'string' || !config.defaultShell) config.defaultShell = DEFAULTS.defaultShell;

  Object.defineProperty(config, 'configDir', { value: dir, enumerable: false });
  Object.defineProperty(config, 'configPath', { value: file, enumerable: false });
  Object.defineProperty(config, 'migratedFrom', { value: migrated ? migrated.from : null, enumerable: false });
  return config;
}
