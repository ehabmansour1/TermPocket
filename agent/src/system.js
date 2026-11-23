// System methods (PROTOCOL.md §4.3): sys.info, proc.list, proc.kill, power, clip.get, clip.set, sys.open.
//
// Native work goes through the shared PowerShell/C# helper (winhelper.js). Power actions use fixed argument
// arrays with execFile (never a shell string). With TERMPOCKET_DRYRUN_INPUT=1 every state-changing action
// (proc.kill, power, clip.set, sys.open) is validated and recorded in `dryRunLog` instead of executed.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DEMO_IDENTITY, DEMO_SYSTEM, isDemo } from './demo.js';
import {
  dryRunLog,
  invalid,
  isDryRun,
  normalizeLog,
  optEnum,
  optInteger,
  paramsObject,
  recordDryRun,
  sleep,
} from './winhelper.js';

export { dryRunLog };

const POWER_ACTIONS = ['lock', 'sleep', 'hibernate', 'shutdown', 'restart', 'logoff', 'cancel'];
const PROC_SORTS = ['mem', 'cpu', 'name'];
const CLIP_MAX_CHARS = 4 * 1024 * 1024;
const OPEN_MAX_CHARS = 4096;
const CPU_SAMPLE_MS = 500;
// "Unable to abort the system shutdown because no shutdown was in progress." (ERROR_NO_SHUTDOWN_IN_PROGRESS)
const ERROR_NO_SHUTDOWN_IN_PROGRESS = 1116;
// Actions that end the session / network: answer the phone first, then act.
const DEFERRED_ACTION_DELAY_MS = 400;

function system32(exe) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', exe);
}

/** Fixed command lines for each power action (no user input ever reaches these arrays). */
export function powerCommand(action) {
  switch (action) {
    case 'lock':
      return { file: system32('rundll32.exe'), args: ['user32.dll,LockWorkStation'] };
    case 'sleep':
      // Primary path is the helper (Application.SetSuspendState = real sleep); this is the fallback.
      return { file: system32('rundll32.exe'), args: ['powrprof.dll,SetSuspendState', '0,1,0'] };
    case 'hibernate':
      return { file: system32('shutdown.exe'), args: ['/h'] };
    case 'shutdown':
      return { file: system32('shutdown.exe'), args: ['/s', '/t', '30', '/c', 'TermPocket: shutdown requested from phone'] };
    case 'restart':
      return { file: system32('shutdown.exe'), args: ['/r', '/t', '30', '/c', 'TermPocket: restart requested from phone'] };
    case 'logoff':
      return { file: system32('shutdown.exe'), args: ['/l'] };
    case 'cancel':
      return { file: system32('shutdown.exe'), args: ['/a'] };
    default:
      throw invalid(`action must be one of ${POWER_ACTIONS.join('|')}`);
  }
}

function run(file, args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function commandError(action, err) {
  const detail = `${err.stderr || ''} ${err.stdout || ''}`.trim().replace(/\s+/g, ' ') || err.message;
  return new Error(`${action} failed: ${detail}`);
}

/** Average CPU utilisation (0..100) across all cores over `ms`. */
async function sampleCpuLoad(ms = CPU_SAMPLE_MS) {
  const totals = () =>
    os.cpus().reduce(
      (acc, cpu) => {
        const t = cpu.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const a = totals();
  await sleep(ms);
  const b = totals();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  const load = (1 - (b.idle - a.idle) / total) * 100;
  return Math.round(Math.min(100, Math.max(0, load)) * 10) / 10;
}

function isTailscaleIp(ip) {
  // Tailscale uses the CGNAT range 100.64.0.0/10.
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** Non-internal IPv4 addresses, Tailscale (100.64/10) first. */
export function listIps() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.') && !ips.includes(a.address)) ips.push(a.address);
    }
  }
  return ips.sort((x, y) => Number(isTailscaleIp(y)) - Number(isTailscaleIp(x)));
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || '';
  }
}

function osName() {
  try {
    return typeof os.version === 'function' ? os.version() : os.type();
  } catch {
    return os.type();
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

export function createSystemHandlers({ config, log, helper } = {}) {
  const L = normalizeLog(log);
  void config; // no system-specific config keys today

  if (!helper) throw new Error('createSystemHandlers requires a helper (createWinHelper)');

  async function safeHelper(op, args, fallback, timeoutMs = 10_000) {
    try {
      return await helper.call(op, args, { timeoutMs });
    } catch (err) {
      L.warn(`[system] ${op} unavailable: ${err.message}`);
      return fallback;
    }
  }

  const methods = {
    async 'sys.info'() {
      const cpus = os.cpus();
      const [cpuLoad, battery, monitors] = await Promise.all([
        sampleCpuLoad(),
        safeHelper('battery', {}, null),
        safeHelper('monitors', {}, []),
      ]);
      const demo = isDemo();
      return {
        hostname: demo ? DEMO_IDENTITY.hostname : os.hostname(),
        user: demo ? DEMO_IDENTITY.user : currentUser(),
        os: demo ? DEMO_SYSTEM.os : osName(),
        release: demo ? DEMO_SYSTEM.release : os.release(),
        arch: demo ? DEMO_SYSTEM.arch : os.arch(),
        uptimeSec: demo ? DEMO_SYSTEM.uptimeSec : Math.round(os.uptime()),
        cpuModel: demo ? DEMO_SYSTEM.cpuModel : (cpus[0]?.model || '').trim(),
        cpuCount: demo ? DEMO_SYSTEM.cpuCount : cpus.length,
        cpuLoad,
        memTotal: demo ? DEMO_SYSTEM.memTotal : os.totalmem(),
        memFree: demo ? DEMO_SYSTEM.memFree : os.freemem(),
        battery: battery && typeof battery.percent === 'number'
          ? { percent: battery.percent, charging: !!battery.charging }
          : null,
        ips: demo ? [...DEMO_IDENTITY.ips] : listIps(),
        monitors: Array.isArray(monitors) ? monitors : [],
      };
    },

    async 'proc.list'(params) {
      const p = paramsObject(params);
      const sort = optEnum(p, 'sort', PROC_SORTS, 'mem');
      const limit = optInteger(p, 'limit', 150, 1, 10_000);
      const raw = await helper.call('procs', {}, { timeoutMs: 20_000 });
      const list = (Array.isArray(raw) ? raw : []).map((x) => ({
        pid: x.pid,
        name: String(x.name ?? ''),
        memMB: round1((Number(x.mem) || 0) / (1024 * 1024)),
        cpuSec: round1(Number(x.cpuSec) || 0),
        title: typeof x.title === 'string' ? x.title : '',
      }));
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.pid - b.pid;
      if (sort === 'mem') list.sort((a, b) => b.memMB - a.memMB || byName(a, b));
      else if (sort === 'cpu') list.sort((a, b) => b.cpuSec - a.cpuSec || byName(a, b));
      else list.sort(byName);
      return list.slice(0, limit);
    },

    async 'proc.kill'(params) {
      const p = paramsObject(params);
      const pid = p.pid;
      if (!Number.isInteger(pid) || pid <= 0) throw invalid('pid must be a positive integer');
      if (p.force !== undefined && p.force !== null && typeof p.force !== 'boolean') throw invalid('force must be a boolean');
      const force = p.force === true;
      if (pid <= 4) throw new Error(`refusing to kill system process ${pid}`);
      if (pid === process.pid) throw new Error('refusing to kill the TermPocket agent');
      if (helper.pid && pid === helper.pid) throw new Error('refusing to kill the TermPocket helper');
      if (isDryRun()) {
        recordDryRun(L, 'proc.kill', p, { pid, force });
        return true;
      }
      await helper.call('kill', { pid, force }, { timeoutMs: 15_000 });
      L.info(`[system] killed pid ${pid}${force ? ' (force)' : ''}`);
      return true;
    },

    async power(params) {
      const p = paramsObject(params);
      const action = optEnum(p, 'action', POWER_ACTIONS);
      const cmd = powerCommand(action);
      if (isDryRun()) {
        const resolved = action === 'sleep'
          ? { action, via: 'helper:suspend', fallback: cmd }
          : { action, file: cmd.file, args: cmd.args };
        recordDryRun(L, 'power', p, resolved);
        return true;
      }
      L.info(`[system] power action: ${action}`);

      if (action === 'sleep') {
        // The helper answers immediately and suspends after a short delay so this response gets out.
        try {
          await helper.call('suspend', { delayMs: DEFERRED_ACTION_DELAY_MS }, { timeoutMs: 10_000 });
        } catch (err) {
          L.warn(`[system] helper suspend failed (${err.message}); falling back to rundll32`);
          setTimeout(() => {
            run(cmd.file, cmd.args).catch((e) => L.error(`[system] sleep failed: ${e.message}`));
          }, DEFERRED_ACTION_DELAY_MS);
        }
        return true;
      }

      if (action === 'logoff' || action === 'hibernate') {
        // Logging off ends this process; reply first.
        setTimeout(() => {
          run(cmd.file, cmd.args).catch((e) => L.error(`[system] ${action} failed: ${commandError(action, e).message}`));
        }, DEFERRED_ACTION_DELAY_MS);
        return true;
      }

      try {
        await run(cmd.file, cmd.args);
      } catch (err) {
        if (action === 'cancel') {
          const text = `${err.stdout || ''} ${err.stderr || ''}`;
          if (err.code === ERROR_NO_SHUTDOWN_IN_PROGRESS || text.includes(`(${ERROR_NO_SHUTDOWN_IN_PROGRESS})`)) {
            return true; // nothing to cancel: that is the desired end state
          }
        }
        throw commandError(action, err);
      }
      return true;
    },

    async 'clip.get'() {
      const r = await helper.call('clipGet', {}, { timeoutMs: 10_000 });
      return { text: typeof r?.text === 'string' ? r.text : '' };
    },

    async 'clip.set'(params) {
      const p = paramsObject(params);
      if (typeof p.text !== 'string') throw invalid('text must be a string');
      if (p.text.length > CLIP_MAX_CHARS) throw invalid(`text is too long (max ${CLIP_MAX_CHARS} characters)`);
      if (isDryRun()) {
        recordDryRun(L, 'clip.set', { length: p.text.length }, { length: p.text.length });
        return true;
      }
      await helper.call('clipSet', { text: p.text }, { timeoutMs: 10_000 });
      return true;
    },

    async 'sys.open'(params) {
      const p = paramsObject(params);
      if (typeof p.target !== 'string') throw invalid('target must be a string');
      const target = p.target.trim();
      if (!target) throw invalid('target must not be empty');
      if (target.length > OPEN_MAX_CHARS) throw invalid(`target is too long (max ${OPEN_MAX_CHARS} characters)`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f]/.test(target)) throw invalid('target must not contain control characters');
      if (isDryRun()) {
        recordDryRun(L, 'sys.open', p, { target });
        return true;
      }
      await helper.call('open', { target }, { timeoutMs: 15_000 });
      L.info(`[system] opened ${target}`);
      return true;
    },
  };

  return {
    methods,
    onClientClose() {
      /* no per-client state */
    },
    async dispose() {
      /* the helper is owned (and disposed) by whoever created it */
    },
  };
}
