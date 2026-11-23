// Client side of the PTY host (ptyhost.js): connect + authenticate over the named pipe, spawn the host
// when it is not running, and an in-process transport with the same interface (tests / fallback).
//
// Transport interface (what pty.js uses):
//   kind                        'host' | 'inprocess'
//   hello                       {pid, version, protocol, startedAt, sessions: Meta[], nextId}
//   request(op, args, onReply?) → Promise<result>. `onReply(result)` runs synchronously when the reply
//                               is dispatched, BEFORE any later message is processed (so a caller can
//                               register state that the following events refer to); its return value
//                               resolves the promise.
//   send(op, args)              fire-and-forget (no reply), keeps order with requests
//   onEvent(fn)                 fn({ev, sid, …}) for data / exit / pid / meta
//   onClose(fn)                 the host went away (not called after close())
//   close()

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn as spawnChild, execFile } from 'node:child_process';
import { envValue } from './config.js';
import { clientProof, defaultPipeName, hostInfoPath, hostProof, proofEquals, PTYHOST_ENTRY } from './ptyhost.js';

export { defaultPipeName, hostInfoPath };

const CONNECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15000;

export function readHostInfo(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(hostInfoPath(configDir), 'utf8').replace(/^﻿/, ''));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** Is a process with this pid alive? */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Connect to a running host and authenticate. Rejects with err.code:
 *   'ENOHOST'  nothing listens on the pipe
 *   'ENOINFO'  ptyhost.json missing/unreadable (cannot authenticate)
 *   'EAUTH'    the pipe's owner could not prove it knows the secret (or refused ours)
 */
export function connectPtyHost({ pipe, configDir, timeoutMs = CONNECT_TIMEOUT_MS, log } = {}) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  return new Promise((resolve, reject) => {
    const info = readHostInfo(configDir);
    const sock = net.connect(pipe);
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(Object.assign(new Error(message), { code }));
    };
    const timer = setTimeout(() => fail('ETIMEDOUT', `pty host on ${pipe} did not answer`), timeoutMs);
    sock.once('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') fail('ENOHOST', `no pty host on ${pipe}`);
      else fail(err.code || 'EIO', `pty host connection failed: ${err.message}`);
    });
    sock.once('close', () => fail('ECLOSED', 'pty host closed the connection during the handshake'));
    sock.once('connect', () => {
      if (!info || typeof info.secret !== 'string') return fail('ENOINFO', `cannot read ${hostInfoPath(configDir)}`);
      const cn = crypto.randomBytes(32).toString('base64url');
      let sn = null;
      const reader = lineReader(sock, (msg) => {
        if (settled) return;
        if (sn === null) {
          if (!msg || msg.t !== 'hello' || typeof msg.nonce !== 'string' || !proofEquals(hostProof(info.secret, cn, msg.nonce), msg.proof)) {
            return fail('EAUTH', 'the process on the pty host pipe could not prove it is the TermPocket pty host');
          }
          sn = msg.nonce;
          sock.write(`${JSON.stringify({ op: 'auth', proof: clientProof(info.secret, cn, sn) })}\n`);
          return;
        }
        if (!msg || msg.t !== 'ready') return fail('EAUTH', 'pty host refused the connection');
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners('close');
        sock.removeAllListeners('error');
        reader.detach();
        resolve(makeSocketTransport(sock, msg, reader.rest(), logger));
      });
      sock.write(`${JSON.stringify({ op: 'hello', nonce: cn })}\n`);
    });
  });
}

/** Minimal JSON-lines reader; `detach()` stops it, `rest()` returns unparsed buffered text. */
function lineReader(sock, onMsg) {
  let buf = '';
  let active = true;
  sock.setEncoding('utf8');
  const onData = (chunk) => {
    if (!active) {
      buf += chunk;
      return;
    }
    buf += chunk;
    let nl;
    while (active && (nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      onMsg(msg);
    }
  };
  sock.on('data', onData);
  return {
    detach() {
      active = false;
      sock.off('data', onData);
    },
    rest() {
      const r = buf;
      buf = '';
      return r;
    },
  };
}

function makeSocketTransport(sock, hello, initial, logger) {
  const pending = new Map(); // id -> {resolve, reject, onReply, timer}
  const eventFns = new Set();
  const closeFns = new Set();
  let nextId = 1;
  let closed = false;
  let buf = initial || '';

  const dispatch = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'evt') {
      for (const fn of eventFns) {
        try {
          fn(msg);
        } catch (err) {
          logger.warn(`pty host event handler failed: ${err.message}`);
        }
      }
    } else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) {
        let r = msg.r;
        try {
          if (p.onReply) r = p.onReply(r);
        } catch (err) {
          p.reject(err);
          return;
        }
        p.resolve(r);
      } else p.reject(new Error(msg.e || 'pty host error'));
    }
  };

  const drain = () => {
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        logger.warn('pty host sent an invalid line');
      }
      dispatch(msg);
    }
  };

  sock.on('data', (chunk) => {
    buf += chunk;
    drain();
  });
  sock.on('error', (err) => logger.debug(`pty host socket error: ${err.message}`));
  sock.on('close', () => {
    const wasClosed = closed;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('pty host connection closed'), { code: 'ECONNCLOSED' }));
    }
    pending.clear();
    if (!wasClosed) for (const fn of closeFns) fn();
  });
  // Messages that arrived together with the handshake reply.
  if (buf) setImmediate(drain);

  const write = (obj) => {
    if (closed) throw Object.assign(new Error('pty host not connected'), { code: 'ECONNCLOSED' });
    sock.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    kind: 'host',
    hello,
    get closed() {
      return closed;
    },
    request(op, args = {}, onReply) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`pty host did not answer ${op}`));
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve, reject, onReply, timer });
        try {
          write({ ...args, id, op });
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    },
    send(op, args = {}) {
      write({ ...args, op });
    },
    onEvent(fn) {
      eventFns.add(fn);
    },
    onClose(fn) {
      closeFns.add(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      sock.end();
      sock.destroy();
    },
  };
}

/** Transport straight to an in-process core (same semantics; requests answer synchronously). */
export function inProcessTransport(core) {
  const eventFns = new Set();
  let closed = false;
  const unsub = core.subscribe((evt) => {
    if (closed) return;
    for (const fn of eventFns) fn({ t: 'evt', ...evt });
  });
  const { sessions, nextId } = core.handle('list');
  return {
    kind: 'inprocess',
    hello: { pid: process.pid, version: 'in-process', protocol: 1, startedAt: Date.now(), sessions, nextId },
    get closed() {
      return closed;
    },
    request(op, args = {}, onReply) {
      try {
        if (closed) throw new Error('pty manager disposed');
        let r = core.handle(op, args);
        if (onReply) r = onReply(r);
        return Promise.resolve(r);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    send(op, args = {}) {
      if (closed) return;
      try {
        core.handle(op, args);
      } catch {
        /* like the host: errors of fire-and-forget ops are dropped */
      }
    },
    onEvent(fn) {
      eventFns.add(fn);
    },
    onClose() {},
    close() {
      closed = true;
      unsub();
      core.dispose();
    },
  };
}

/**
 * Start a detached host process that is NOT part of the agent's job object, so stopping the agent's
 * scheduled task (which ends every process of the task's job) or closing its console does not end it.
 * method 'wmi' (Windows default): Win32_Process.Create through PowerShell — the new process is created
 * by the WMI service, outside any job; 'node': child_process.spawn detached + windowsHide (fallback,
 * and the default elsewhere).
 */
export async function spawnPtyHostProcess({ pipe, configDir, scrollbackBytes, firstId, idleMs, method, log } = {}) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const args = [PTYHOST_ENTRY, '--pipe', pipe, '--home', configDir];
  if (scrollbackBytes) args.push('--scrollback', String(scrollbackBytes));
  if (firstId) args.push('--first-id', String(firstId));
  if (idleMs) args.push('--idle-ms', String(idleMs));
  const how = method || process.env.TERMPOCKET_PTYHOST_SPAWN || (process.platform === 'win32' ? 'wmi' : 'node');
  if (how === 'wmi' && process.platform === 'win32') {
    try {
      const pid = await spawnViaWmi(process.execPath, args);
      logger.info(`started pty host (pid ${pid}, via WMI) on ${pipe}`);
      return pid;
    } catch (err) {
      logger.warn(`starting the pty host via WMI failed (${err.message}); starting it as a detached child`);
    }
  }
  const child = spawnChild(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd: os.homedir() });
  child.on('error', (err) => logger.warn(`pty host process error: ${err.message}`));
  child.unref();
  logger.info(`started pty host (pid ${child.pid}, detached) on ${pipe}`);
  return child.pid;
}

/** Quote one argument for a Windows command line (CommandLineToArgvW rules). */
export function quoteWinArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(bs * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(bs) + ch;
    }
    bs = 0;
  }
  return `${out + '\\'.repeat(bs * 2)}"`;
}

function spawnViaWmi(exe, args) {
  const commandLine = [exe, ...args].map(quoteWinArg).join(' ');
  // Pass the command line through an environment variable: no PowerShell quoting of user paths.
  const script = [
    "$ErrorActionPreference='Stop'",
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }', // DETACHED_PROCESS: no console at all
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:TERMPOCKET_PTYHOST_CMD; CurrentDirectory = $env:USERPROFILE; ProcessStartupInformation = $si }",
    "if ($r.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $r.ReturnValue) }",
    '[Console]::Out.Write($r.ProcessId)',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, env: { ...process.env, TERMPOCKET_PTYHOST_CMD: commandLine } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
        const pid = Number(String(stdout).trim());
        if (!Number.isInteger(pid) || pid <= 0) return reject(new Error(`unexpected output: ${String(stdout).slice(0, 100)}`));
        resolve(pid);
      }
    );
  });
}

/**
 * Connect to the host, starting it first when nothing listens on the pipe. Retries until
 * `startTimeoutMs`. Rejects when the host cannot be reached (callers fall back to in-process PTYs).
 */
export async function ensurePtyHost({ pipe, configDir, scrollbackBytes, firstId, idleMs, autoSpawn = true, spawnMethod, startTimeoutMs = 20000, log } = {}) {
  const logger = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const deadline = Date.now() + startTimeoutMs;
  let spawned = false;
  let lastErr = null;
  let delay = 100;
  for (;;) {
    try {
      return await connectPtyHost({ pipe, configDir, log: logger });
    } catch (err) {
      lastErr = err;
      if (err.code === 'EAUTH') throw err; // someone else owns the pipe: never hand them anything
      const hostGone = err.code === 'ENOHOST' || (err.code === 'ENOINFO' && !pidAlive(readHostInfo(configDir)?.pid));
      if (autoSpawn && !spawned && hostGone) {
        spawned = true;
        await spawnPtyHostProcess({ pipe, configDir, scrollbackBytes, firstId, idleMs, method: spawnMethod, log: logger });
      } else if (!autoSpawn && err.code === 'ENOHOST') {
        throw err;
      }
    }
    if (Date.now() >= deadline) throw lastErr || new Error('pty host did not start');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(500, delay * 2);
  }
}

/** Ask a running host to end every session and exit (uninstall / tests). Resolves false if none runs. */
export async function shutdownPtyHost({ pipe, configDir, timeoutMs = 5000 } = {}) {
  let t;
  try {
    t = await connectPtyHost({ pipe, configDir, timeoutMs });
  } catch (err) {
    if (err.code === 'ENOHOST') return false;
    throw err;
  }
  try {
    await t.request('shutdown', {});
  } finally {
    t.close();
  }
  return true;
}

/** Resolve the pipe for a config dir (env TERMPOCKET_PTYHOST_PIPE wins). */
export function resolvePipe(configDir, env = process.env) {
  return envValue(env, 'PTYHOST_PIPE') || defaultPipeName(configDir);
}
