#!/usr/bin/env node
// TermPocket agent entry point: load config, start the HTTP/WebSocket server with all handler sets,
// print the pairing info (URL + QR), and shut down gracefully on SIGINT/SIGTERM.

import './legacyEnv.js'; // first: old VSCONTROL_* variables → TERMPOCKET_* before anything reads them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import { createAgentServer, createPhoneRegistry, pairingLink, VERSION } from './server.js';
import { createPtyManager } from './pty.js';
import { createVscodeHub } from './vscodeHub.js';
import { loadRelayConfig, startRelayClient } from './relayClient.js';
import { createLogRing } from './monitor.js';
import { createDemoHelper, DEMO_IDENTITY, isDemo } from './demo.js';

// ------------------------------------------------------------------------------------------------
// Logging: concise timestamped lines. A logger is {info, warn, error, debug, child(scope)};
// debug lines are printed only when TERMPOCKET_DEBUG=1. INFO/WARN/ERROR lines are also kept (redacted)
// in a 200-line ring buffer for the local monitor (GET /status).
// ------------------------------------------------------------------------------------------------

const DEBUG = /^(1|true|yes)$/i.test(process.env.TERMPOCKET_DEBUG ?? '');
const logRing = createLogRing(200);

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function format(args) {
  return args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope = '') {
  const prefix = scope ? ` [${scope}]` : '';
  const write = (level, args) => {
    const text = format(args);
    const line = `${stamp()} ${level}${prefix} ${text}`;
    if (level !== 'DEBUG') {
      try {
        logRing.push(level, scope, text);
      } catch {
        /* the monitor buffer must never break logging */
      }
    }
    if (level === 'ERROR' || level === 'WARN ') console.error(line);
    else console.log(line);
  };
  return {
    info: (...args) => write('INFO ', args),
    warn: (...args) => write('WARN ', args),
    error: (...args) => write('ERROR', args),
    debug: DEBUG ? (...args) => write('DEBUG', args) : () => {},
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

const log = createLogger();

// ------------------------------------------------------------------------------------------------
// Optional modules (system / screen / winhelper are built separately — degrade gracefully if absent)
// (they prefix their own log lines, e.g. "[screen]", so they get the unscoped logger).
// ------------------------------------------------------------------------------------------------

async function importOptional(spec, exportName) {
  try {
    const mod = await import(spec);
    if (typeof mod[exportName] !== 'function') throw new Error(`${spec} does not export ${exportName}()`);
    return mod[exportName];
  } catch (err) {
    log.warn(`${spec} unavailable (${err.code === 'ERR_MODULE_NOT_FOUND' ? 'module not found' : err.message}); related features disabled`);
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Tailscale detection: if `tailscale serve` already proxies to our port, use its https URL for
// pairing (only when no publicUrl / TERMPOCKET_PUBLIC_URL is configured). Best-effort, 4 s max.
// ------------------------------------------------------------------------------------------------

function execJson(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * `tailscale` on PATH, else the installer's default folder: an agent started by a process that predates
 * the Tailscale install (e.g. the tray's fallback launcher) has a PATH without it.
 */
function tailscaleCandidates(env = process.env) {
  const out = ['tailscale'];
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (base) out.push(path.join(base, 'Tailscale', 'tailscale.exe'));
    }
  }
  return out;
}

async function detectTailscaleUrl(port) {
  let status = null;
  for (const file of tailscaleCandidates()) {
    if (file !== 'tailscale' && !fs.existsSync(file)) continue;
    status = await execJson(file, ['serve', 'status', '--json']);
    if (status) break;
  }
  if (!status || typeof status !== 'object' || !status.Web) return null;
  for (const [hostPort, cfg] of Object.entries(status.Web)) {
    const handlers = cfg?.Handlers ?? {};
    for (const h of Object.values(handlers)) {
      const proxy = typeof h?.Proxy === 'string' ? h.Proxy : '';
      if (new RegExp(`(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy)) {
        const [host, p] = hostPort.split(':');
        return p && p !== '443' ? `https://${host}:${p}` : `https://${host}`;
      }
    }
  }
  return null;
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push({ name, address: a.address, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) });
    }
  }
  return out;
}

function printBanner(config, port, detectedUrl) {
  const base = config.publicUrl || detectedUrl;
  const linkConfig = base ? { ...config, publicUrl: base } : config;
  const link = pairingLink(linkConfig, port);
  const bindHost = config.host;
  const localUrl = `http://${bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost}:${port}`;

  const lines = [];
  lines.push('');
  lines.push(`TermPocket agent ${VERSION} listening on ${bindHost}:${port}`);
  lines.push(`  Local:        ${localUrl}`);
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    for (const a of lanAddresses()) lines.push(`  ${a.tailscale ? 'Tailscale:' : 'LAN:      '}    http://${a.address}:${port}   (${a.name})`);
  }
  if (base) lines.push(`  Public:       ${base}`);
  lines.push(`  Pairing page: ${localUrl}/pair   (open on this PC)`);
  lines.push(`  Config:       ${config.configPath}`);
  lines.push('');
  lines.push('Pairing link (keep it private — it grants full control of this PC):');
  lines.push(`  ${link}`);
  if (!base) {
    lines.push('');
    lines.push('Tip: run scripts\\setup-tailscale.ps1 to expose the agent as https://<pc>.<tailnet>.ts.net,');
    lines.push('     then restart the agent (or set "publicUrl" in config.json) so the QR code uses it.');
  }
  console.log(lines.join('\n'));
  qrcode.generate(link, { small: true }, (qr) => console.log(qr));
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(`cannot load config: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (config.migratedFrom) log.info(`settings copied from the old folder ${config.migratedFrom} (VS Control → TermPocket); the pairing token is unchanged`);
  logRing.addSecret(config.token);
  const startedAt = Date.now();
  const registry = createPhoneRegistry();
  // Terminals live in the durable PTY host (ptyhost.js) so they survive agent restarts; set
  // TERMPOCKET_PTYHOST=inprocess (or "ptyHost": false in config.json) to keep them inside the agent.
  const useHost = config.ptyHost !== false && !/^(0|false|no|off|inprocess)$/i.test(process.env.TERMPOCKET_PTYHOST ?? '');
  const pty = createPtyManager({
    config,
    log: log.child('pty'),
    registry,
    host: useHost ? { configDir: config.configDir, pipe: process.env.TERMPOCKET_PTYHOST_PIPE || undefined } : 'inprocess',
  });
  const hub = createVscodeHub({ log: log.child('vscode'), registry, pty, version: VERSION });

  const [createWinHelper, createSystemHandlers, createScreenHandlers] = await Promise.all([
    importOptional('./winhelper.js', 'createWinHelper'),
    importOptional('./system.js', 'createSystemHandlers'),
    importOptional('./screen.js', 'createScreenHandlers'),
  ]);

  const disposables = [];
  const tryCreate = (name, factory, args) => {
    if (!factory) return null;
    try {
      return factory(args);
    } catch (err) {
      log.error(`${name} failed to initialise: ${err.message}`);
      return null;
    }
  };
  // Demo mode: a stand-in helper that streams the bundled demo desktop (never the real screen).
  const demo = isDemo();
  if (demo) log.warn(`DEMO MODE (TERMPOCKET_DEMO=1): this PC is shown as "${DEMO_IDENTITY.hostname}", the screen as the bundled demo desktop; input and power actions are dry-run`);
  const helper = demo ? tryCreate('demo helper', createDemoHelper, {}) : tryCreate('winhelper', createWinHelper, { log });
  // The extension's terminal snapshot borrows the clipboard: it asks first (clipboard.info) whether the
  // clipboard holds only text. Only the format names are handed out, never the text.
  if (helper) {
    hub.setClipboardFormats(async () => {
      const r = await helper.call('clipGet', {}, { timeoutMs: 3000 });
      return { formats: Array.isArray(r && r.formats) ? r.formats : [] };
    });
  }
  const system = tryCreate('system', createSystemHandlers, { config, log, helper });
  const screen = tryCreate('screen', createScreenHandlers, { config, log, helper });

  const handlerSets = [pty, hub, system, screen].filter(Boolean);
  disposables.push(...handlerSets);

  // Local monitor (/status, /monitor): log tail, windows helper and (once started) the relay bridge.
  const monitor = {
    startedAt,
    log: () => logRing.entries(),
    helper: helper && typeof helper.status === 'function' ? () => helper.status() : null,
    relay: null,
    relayConfigured: false,
    secrets: () => logRing.secrets,
  };
  const server = createAgentServer({ config, log: log.child('server'), handlerSets, registry, monitor });

  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason})`);
    const force = setTimeout(() => {
      log.warn('shutdown timed out; exiting');
      process.exit(code || 1);
    }, 5000);
    force.unref();
    try {
      await server.close();
    } catch (err) {
      log.warn(`server close failed: ${err.message}`);
    }
    for (const d of disposables) {
      try {
        await d.dispose?.();
      } catch (err) {
        log.warn(`dispose failed: ${err.message}`);
      }
    }
    try {
      await helper?.dispose?.();
    } catch (err) {
      log.warn(`helper dispose failed: ${err.message}`);
    }
    clearTimeout(force);
    process.exit(code);
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(sig, () => shutdown(sig));
    } catch {
      /* signal not supported on this platform */
    }
  }
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err);
    shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection:', err instanceof Error ? err : String(err));
  });

  let bound;
  try {
    bound = await server.listen(config.port, config.host);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${config.port} on ${config.host} is already in use — is another agent running? (set TERMPOCKET_PORT to use another port)`);
    } else {
      log.error(`cannot listen on ${config.host}:${config.port}: ${err.message}`);
    }
    await shutdown('listen failed', 1);
    return;
  }

  // Public relay (relay.json in the config dir): outbound bridge so the PC is reachable without
  // opening ports. Its https URL becomes the pairing base unless publicUrl is set explicitly.
  let relay = null;
  try {
    relay = config.configDir ? loadRelayConfig(config.configDir) : null;
  } catch (err) {
    log.error(`relay disabled: ${err.message}`);
    // relay.json exists but is unusable: show it on the monitor (never the key).
    monitor.relayConfigured = true;
    monitor.relay = () => ({ configured: true, url: null, connected: false, since: null, sessions: 0, lastError: `relay disabled: ${err.message}`, reconnects: 0 });
  }
  if (relay) {
    logRing.addSecret(relay.key);
    const relayClient = startRelayClient({ relay, port: bound.port, log: log.child('relay') });
    disposables.push(relayClient);
    monitor.relayConfigured = true;
    monitor.relay = () => relayClient.status();
    if (!config.publicUrl) config.publicUrl = relay.url.replace(/^ws/i, 'http');
  }

  const detected = config.publicUrl ? null : await detectTailscaleUrl(bound.port).catch(() => null);
  if (detected) {
    // Runtime only (not persisted): makes the banner QR and the /pair page use the https URL.
    config.publicUrl = detected;
    log.info(`tailscale serve detected: ${detected}`);
  }
  printBanner(config, bound.port, detected);
  log.info(`ready (features: ${['pty', 'vscode', system && 'sys', screen && 'screen', screen && 'input'].filter(Boolean).join(', ')})`);
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
