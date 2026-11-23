#!/usr/bin/env node
// TermPocket PTY host (PROTOCOL §4.1 "Durable sessions", §7): a small long-lived process that owns the
// terminal processes (ConPTY via @lydell/node-pty), their scrollback and metadata, so terminals keep
// running when the agent exits or is restarted (tray Restart/Stop, crash, update). The agent spawns it
// detached (outside the agent's job object) and talks to it over a local named pipe:
//
//   \\.\pipe\termpocket-ptyhost-<hash of user name + config dir>   (override: TERMPOCKET_PTYHOST_PIPE)
//
// Every connection must authenticate first, with a mutual HMAC challenge-response keyed by a random
// secret that the host writes to <configDir>\ptyhost.json (user-only file). Wire format: JSON lines.
//
//   client → host  {"op":"hello","nonce":cn}
//   host → client  {"t":"hello","nonce":sn,"proof":HMAC(secret,"termpocket-ptyhost\n"+cn+"\n"+sn),"pid":…,"protocol":1}
//   client → host  {"op":"auth","proof":HMAC(secret,"termpocket-ptyclient\n"+sn+"\n"+cn)}
//   host → client  {"t":"ready","pid":…,"version":…,"protocol":1,"startedAt":…,"sessions":[Meta…],"nextId":n}
//   then requests  {"id":n,"op":"spawn|input|resize|kill|buffer|meta|list|status|shutdown", …args}
//        replies   {"t":"res","id":n,"ok":true,"r":…} | {"t":"res","id":n,"ok":false,"e":"…"}
//        (a request without "id" gets no reply — used for input / resize)
//        events    {"t":"evt","ev":"data|exit|pid|meta","sid":"p1",…}
//
// The host exits when it has had no running sessions AND no authenticated client for `idleMs` (10 min), or on
// the `shutdown` op (used by uninstall and tests), which also ends every session.

import './legacyEnv.js'; // first: old VSCONTROL_* variables → TERMPOCKET_* (when run as the host process)
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPtyCore } from './ptycore.js';
import { getConfigDir } from './config.js';

export const PTYHOST_PROTOCOL = 1;
export const PTYHOST_VERSION = '1.0.0';
export const PTYHOST_INFO_FILE = 'ptyhost.json';
const IDLE_MS_DEFAULT = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = 5000;
const MAX_LINE = 8 * 1024 * 1024;
/** Unauthenticated connections may not buffer more than this without a line end. */
const MAX_PREAUTH_LINE = 4096;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;

export const hostProof = (secret, cn, sn) => hmac(secret, 'termpocket-ptyhost', cn, sn);
export const clientProof = (secret, cn, sn) => hmac(secret, 'termpocket-ptyclient', sn, cn);

function hmac(secret, label, a, b) {
  return crypto.createHmac('sha256', String(secret)).update(`${label}\n${a}\n${b}`, 'utf8').digest('base64url');
}

export function proofEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Default pipe name: per Windows user and per config dir (test homes never meet the real host). */
export function defaultPipeName(configDir, user = safeUserName()) {
  const h = crypto
    .createHash('sha256')
    .update(`${String(user).toLowerCase()}\n${path.resolve(String(configDir || '.')).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\termpocket-ptyhost-${h}` : path.join(os.tmpdir(), `termpocket-ptyhost-${h}.sock`);
}

function safeUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || 'user';
  }
}

export const hostInfoPath = (configDir) => path.join(configDir, PTYHOST_INFO_FILE);

/**
 * Refuse to take over a ptyhost.json that belongs to another LIVE host on a different pipe (e.g. a test
 * that set TERMPOCKET_PTYHOST_PIPE but not TERMPOCKET_HOME): overwriting it would leave that host — and every
 * terminal it runs — unreachable for its agent forever.
 */
function assertInfoFileFree(configDir, pipe) {
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(hostInfoPath(configDir), 'utf8').replace(/^﻿/, ''));
  } catch {
    return; // none / unreadable: ours to write
  }
  if (!cur || typeof cur.pipe !== 'string' || cur.pipe === pipe) return;
  const pid = Number(cur.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  if (alive) {
    throw Object.assign(new Error(`${hostInfoPath(configDir)} belongs to the pty host ${pid} on another pipe (${cur.pipe}); use a separate TERMPOCKET_HOME`), { code: 'EOWNED' });
  }
}

/** Write ptyhost.json atomically, readable by the current user only. */
function writeHostInfo(configDir, info, log) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = hostInfoPath(configDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  restrictToUser(file, log);
  return file;
}

/** chmod 600 equivalent on Windows: drop inherited ACEs, grant only the current user (best effort). */
function restrictToUser(file, log) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return;
  }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return;
  execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 10000 }, (err) => {
    if (err) log?.warn?.(`icacls on ${file} failed: ${err.message}`);
  });
}

/**
 * Start a PTY host server.
 * @param {object} opts
 * @param {string} opts.pipe            named pipe path
 * @param {string} opts.configDir       where ptyhost.json goes
 * @param {Function} [opts.spawn]       pty spawn implementation (default: @lydell/node-pty)
 * @param {number} [opts.scrollbackBytes]
 * @param {number} [opts.idleMs]        exit after this long without sessions and clients
 * @param {number} [opts.firstId]       first session number
 * @param {object} [opts.log]
 * @param {Function} [opts.onExit]      called once the host has shut down (main: process.exit)
 * @returns {Promise<{pipe, secret, close(), status()}>}
 */
export async function startPtyHost({ pipe, configDir, spawn, scrollbackBytes, idleMs = IDLE_MS_DEFAULT, firstId = 1, log, onExit } = {}) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  if (!pipe) throw new Error('pipe required');
  if (!configDir) throw new Error('configDir required');
  assertInfoFileFree(configDir, pipe);
  if (!spawn) spawn = (await import('@lydell/node-pty')).default.spawn;
  const core = createPtyCore({ spawn, scrollbackBytes, log: logger, firstId });
  const secret = crypto.randomBytes(32).toString('base64url');
  const startedAt = Date.now();
  const clients = new Set(); // authenticated sockets
  let closing = false;
  let idleSince = null;

  const server = net.createServer((sock) => onConnection(sock));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (err) => logger.error(`pty host server error: ${err.message}`));

  const infoFile = writeHostInfo(configDir, { pid: process.pid, pipe, secret, startedAt, version: PTYHOST_VERSION, protocol: PTYHOST_PROTOCOL }, logger);
  logger.info(`pty host ${process.pid} listening on ${pipe}`);

  const idleTimer = setInterval(checkIdle, Math.max(50, Math.min(30_000, Math.floor(idleMs / 4))));
  idleTimer.unref?.();

  function checkIdle() {
    if (closing) return;
    // Exited sessions do not keep the host alive (nothing runs any more).
    if (core.liveCount === 0 && clients.size === 0) {
      if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleMs) {
        logger.info(`no sessions and no agent for ${Math.round(idleMs / 1000)} s; exiting`);
        close('idle');
      }
    } else idleSince = null;
  }

  function status() {
    return { pid: process.pid, startedAt, version: PTYHOST_VERSION, protocol: PTYHOST_PROTOCOL, sessions: core.size, live: core.liveCount, clients: clients.size };
  }

  function onConnection(sock) {
    sock.setNoDelay?.(true);
    let buf = '';
    let stage = 'hello'; // hello → auth → ready
    let cn = null;
    let sn = null;
    let unsubscribe = null;
    const authTimer = setTimeout(() => sock.destroy(), AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    const send = (obj) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`);
    };

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (stage !== 'ready' && buf.length > MAX_PREAUTH_LINE && buf.indexOf('\n') === -1) {
        sock.destroy();
        return;
      }
      if (buf.length > MAX_LINE && buf.indexOf('\n') === -1) {
        logger.warn('pty host: oversized line; dropping connection');
        sock.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.destroy();
          return;
        }
        if (!msg || typeof msg !== 'object') {
          sock.destroy();
          return;
        }
        onMessage(msg);
        if (sock.destroyed) return;
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(authTimer);
      unsubscribe?.();
      if (clients.delete(sock)) logger.info(`agent disconnected (${clients.size} left)`);
    });

    function onMessage(msg) {
      if (stage === 'hello') {
        if (msg.op !== 'hello' || typeof msg.nonce !== 'string' || !NONCE_RE.test(msg.nonce)) return sock.destroy();
        cn = msg.nonce;
        sn = crypto.randomBytes(32).toString('base64url');
        stage = 'auth';
        return send({ t: 'hello', nonce: sn, proof: hostProof(secret, cn, sn), pid: process.pid, protocol: PTYHOST_PROTOCOL });
      }
      if (stage === 'auth') {
        if (msg.op !== 'auth' || !proofEquals(clientProof(secret, cn, sn), msg.proof)) {
          logger.warn('pty host: client failed to authenticate');
          return sock.destroy();
        }
        clearTimeout(authTimer);
        stage = 'ready';
        clients.add(sock);
        idleSince = null;
        // Subscribe before taking the list so no event can fall between the two.
        unsubscribe = core.subscribe((evt) => send({ t: 'evt', ...evt }));
        const { sessions, nextId } = core.handle('list');
        logger.info(`agent connected (${clients.size} client(s), ${sessions.length} session(s))`);
        return send({ t: 'ready', pid: process.pid, version: PTYHOST_VERSION, protocol: PTYHOST_PROTOCOL, startedAt, sessions, nextId });
      }
      // ready
      const { id, op } = msg;
      const reply = id !== undefined && id !== null;
      try {
        let r;
        if (op === 'status') r = status();
        else if (op === 'shutdown') {
          r = true;
          if (reply) send({ t: 'res', id, ok: true, r });
          setImmediate(() => close('shutdown requested'));
          return;
        } else r = core.handle(op, msg);
        if (reply) send({ t: 'res', id, ok: true, r });
      } catch (err) {
        if (reply) send({ t: 'res', id, ok: false, e: err && err.message ? err.message : String(err) });
        else logger.debug(`pty host: ${op} failed: ${err.message}`);
      }
    }
  }

  async function close(reason = 'closed') {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    logger.info(`pty host shutting down (${reason})`);
    core.dispose();
    for (const s of clients) s.destroy();
    clients.clear();
    await new Promise((r) => server.close(() => r()));
    try {
      // Only remove the info file if it is still ours (a newer host may have replaced it).
      const cur = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (cur && cur.secret === secret) fs.rmSync(infoFile, { force: true });
    } catch {
      /* gone already */
    }
    onExit?.(reason);
  }

  return { pipe, secret, close, status, core };
}

// ---------------------------------------------------------------------------------------------------
// Process entry: node ptyhost.js --pipe <name> --home <configDir> [--scrollback N] [--idle-ms N] [--first-id N]
// ---------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = v;
    }
  }
  return out;
}

function fileLogger(file) {
  const write = (level, msg) => {
    try {
      try {
        if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} [ptyhost ${process.pid}] ${msg}\n`);
    } catch {
      /* logging must never break the host */
    }
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    debug: /^(1|true|yes)$/i.test(process.env.TERMPOCKET_DEBUG ?? '') ? (m) => write('DEBUG', m) : () => {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = args.home ? path.resolve(args.home) : getConfigDir(process.env);
  const pipe = args.pipe || process.env.TERMPOCKET_PTYHOST_PIPE || defaultPipeName(configDir);
  const log = fileLogger(path.join(configDir, 'ptyhost.log'));
  // No console: never let a stray signal or exception end every terminal.
  for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(sig, () => log.info(`ignored ${sig}`));
    } catch {
      /* not supported */
    }
  }
  process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err && err.stack ? err.stack : err}`));
  process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err && err.stack ? err.stack : err}`));
  // Do not hold the repository folder open as the working directory.
  try {
    process.chdir(os.homedir());
  } catch {
    /* keep */
  }
  try {
    await startPtyHost({
      pipe,
      configDir,
      scrollbackBytes: Number(args.scrollback) || undefined,
      idleMs: Number(args['idle-ms']) || IDLE_MS_DEFAULT,
      firstId: Number(args['first-id']) || 1,
      log,
      onExit: () => setTimeout(() => process.exit(0), 50),
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      log.info(`another pty host already listens on ${pipe}; exiting`);
      process.exit(3);
    }
    if (err && err.code === 'EOWNED') {
      log.error(err.message);
      process.exit(4);
    }
    log.error(`pty host failed to start: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) main();

export const PTYHOST_ENTRY = fileURLToPath(import.meta.url);
