// Demo mode (env TERMPOCKET_DEMO=1) — for screenshots, videos and docs.
//
// The agent then reports a made-up identity instead of this PC's (hostname "DEV-PC", user "you", a
// Tailscale-style IP 100.101.102.103), and the Windows helper is replaced by a stand-in that never
// touches the real desktop:
//   * screen.* streams / snapshots a bundled synthetic desktop (agent/demo/desktop-*.jpg: an
//     HTML-rendered fake Windows desktop with a VS Code-like window, see agent/demo/make-demo-desktop.mjs),
//     never a capture of the real screen;
//   * monitors / cursor / battery / processes / clipboard formats are fixed sample values;
//   * input, power, clipboard-set, open and kill are always dry-run (logged only, PROTOCOL §8), as with
//     TERMPOCKET_DRYRUN_INPUT=1.
// Terminals, files and VS Code stay real: point them at a demo workspace (TERMPOCKET_DEMO_CWD = default
// folder of new terminals; use an isolated VS Code with a sample project).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');

/** Fake identity reported in demo mode. */
export const DEMO_IDENTITY = Object.freeze({
  hostname: 'DEV-PC',
  user: 'you',
  ips: Object.freeze(['100.101.102.103', '10.0.0.24']),
});

/**
 * Sample machine reported by sys.info in demo mode instead of this PC's OS edition, CPU model, memory size
 * and uptime (they would identify the machine in screenshots). CPU load stays live.
 */
export const DEMO_SYSTEM = Object.freeze({
  os: 'Windows 11 Pro',
  release: '10.0.26100',
  arch: 'x64',
  cpuModel: '12th Gen Intel(R) Core(TM) i7-12700H',
  cpuCount: 20,
  memTotal: 32 * 1024 ** 3,
  memFree: 13.6 * 1024 ** 3,
  uptimeSec: 3 * 86400 + 4 * 3600 + 12 * 60,
});

const DEMO_MONITOR = Object.freeze({ index: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true });
/** Where the (not drawn) mouse pointer sits on the demo desktop, normalized 0..1. */
const DEMO_POINTER = Object.freeze({ x: 0.585, y: 0.405, visible: true });

const DEMO_PROCESSES = [
  ['Code', 612.4, 412.6, 'server.ts - my-app - Visual Studio Code'],
  ['chrome', 488.1, 201.3, 'localhost:5173 - Google Chrome'],
  ['node', 156.7, 88.4, ''],
  ['MsMpEng', 141.2, 640.2, ''],
  ['explorer', 118.9, 75.1, ''],
  ['pwsh', 92.3, 12.8, ''],
  ['Code', 88.6, 61.9, ''],
  ['dwm', 81.4, 302.7, ''],
  ['tailscaled', 46.2, 31.5, ''],
  ['WindowsTerminal', 44.8, 9.6, 'my-app'],
  ['node', 41.5, 22.3, ''],
  ['svchost', 38.2, 55.1, ''],
  ['SearchHost', 33.7, 7.4, ''],
  ['Spotify', 31.9, 18.2, 'Lo-fi beats'],
  ['ShellExperienceHost', 22.4, 3.1, ''],
  ['RuntimeBroker', 14.6, 2.2, ''],
  ['conhost', 9.8, 0.6, ''],
].map(([name, memMB, cpuSec, title], i) => ({ pid: 4120 + i * 132, name, mem: Math.round(memMB * 1024 * 1024), cpuSec, title }));

/** True when TERMPOCKET_DEMO (or the pre-rename VSCONTROL_DEMO) is 1 / true / yes. */
export function isDemo(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.TERMPOCKET_DEMO ?? env.VSCONTROL_DEMO ?? ''));
}

/** The bundled demo desktop images, widest first: [{file, width, height}]. */
export function demoImages(dir = DEMO_DIR) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no demo folder */
  }
  for (const name of names) {
    const m = /^desktop-(\d+)x(\d+)\.jpe?g$/i.exec(name);
    if (m) out.push({ file: path.join(dir, name), width: Number(m[1]), height: Number(m[2]) });
  }
  return out.sort((a, b) => b.width - a.width);
}

function demoOnly(op) {
  return new Error(`demo mode: "${op}" is not available (input and actions are dry-run)`);
}

/**
 * Stand-in for createWinHelper() (same {call, dispose, pid, running, status} shape) that serves the demo
 * desktop. It never starts PowerShell and never reads the real screen, clipboard or process list.
 */
export function createDemoHelper({ dir = DEMO_DIR } = {}) {
  const images = demoImages(dir);
  if (!images.length) throw new Error(`demo mode: no demo desktop image (desktop-<w>x<h>.jpg) in ${dir}`);
  const cache = new Map(); // file -> {data (base64), hash}
  const load = (img) => {
    let c = cache.get(img.file);
    if (!c) {
      const buf = fs.readFileSync(img.file);
      c = { data: buf.toString('base64'), hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) };
      cache.set(img.file, c);
    }
    return c;
  };
  /** The widest image not wider than maxWidth (else the narrowest one). */
  const pick = (maxWidth) => images.find((i) => !(maxWidth > 0) || i.width <= maxWidth) || images[images.length - 1];
  let disposed = false;

  const ops = {
    ping: () => ({ pong: true }),
    monitors: () => [{ ...DEMO_MONITOR }],
    cursor: (a) => ({ monitor: Number(a.monitor) || 0, pointer: { ...DEMO_POINTER } }),
    grab: (a) => {
      const monitor = Number.isInteger(a.monitor) ? a.monitor : 0;
      if (monitor !== 0 && monitor !== -1) throw new Error(`no such monitor: ${monitor} (have 1)`);
      const img = pick(Number(a.maxWidth) || 0);
      const { data, hash } = load(img);
      const r = {
        monitor, x: 0, y: 0, srcWidth: DEMO_MONITOR.width, srcHeight: DEMO_MONITOR.height,
        width: img.width, height: img.height, hash, pointer: { ...DEMO_POINTER }, ms: { cap: 0, hash: 0 },
      };
      if (a.lastHash && a.lastHash === hash) return { ...r, unchanged: true };
      return { ...r, unchanged: false, data };
    },
    battery: () => ({ percent: 84, charging: true }),
    procs: () => DEMO_PROCESSES.map((p) => ({ ...p })),
    // Only format names are ever handed out (the extension's terminal snapshot asks for them).
    clipGet: () => ({ hasText: true, text: 'npm run dev', formats: ['UnicodeText', 'Text'] }),
  };

  return {
    async call(op, args = {}) {
      if (disposed) throw new Error('windows helper disposed');
      const fn = ops[op];
      if (!fn) throw demoOnly(op);
      return fn(args ?? {});
    },
    async dispose() {
      disposed = true;
    },
    get pid() {
      return null;
    },
    get running() {
      return !disposed;
    },
    status() {
      return { running: !disposed, pid: null, restarts: 0, lastError: null, demo: true };
    },
  };
}
