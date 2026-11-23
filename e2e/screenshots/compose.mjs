// Composed README images, rendered with HTML/CSS in the same headless Chrome as the screenshots:
//   * tray-states.png     the tray icon's four states (the real icons from scripts/monitor-tray.ps1
//                         -SaveIconsTo, the real tooltips / menu lines from its -Once classifier) and its
//                         right-click menu;
//   * social-preview.png  1280×640 GitHub social preview: name, tagline, a laptop + phone made of the shots;
//   * hero.png            the README's top image: laptop + two phones made of the shots.
// Nothing here is fetched from the network: fonts are the system's, images are local files.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataUrl = (file) => `data:${file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------------------- shared styles */

const BRAND_BG = `
  background:
    radial-gradient(900px 520px at 82% 18%, rgba(70, 201, 230, 0.20), transparent 62%),
    radial-gradient(760px 520px at 12% 96%, rgba(45, 226, 176, 0.17), transparent 60%),
    linear-gradient(135deg, #0f1823 0%, #0a0d13 55%, #07090d 100%);`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; }
  body { font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; color: #e6e9f0; -webkit-font-smoothing: antialiased; overflow: hidden; }
  .grid-bg { position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(rgba(139, 247, 210, 0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(139, 247, 210, 0.045) 1px, transparent 1px);
    background-size: 40px 40px;
    -webkit-mask-image: radial-gradient(ellipse 70% 70% at 60% 40%, #000 0%, transparent 75%); }

  /* laptop */
  .laptop { position: absolute; }
  .laptop .lid { position: relative; border-radius: 20px 20px 8px 8px; padding: 14px 14px 20px;
    background: linear-gradient(180deg, #1d222b 0%, #101318 100%);
    box-shadow: inset 0 0 0 1px #30374420, inset 0 1px 0 #3a4250, 0 50px 90px -20px rgba(0, 0, 0, 0.75), 0 0 0 1px #262c37; }
  .laptop .lid::before { content: ""; position: absolute; top: 5px; left: 50%; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: #05070a; box-shadow: 0 0 0 1px #1f242d; }
  .laptop .scr { border-radius: 5px; overflow: hidden; background: #000; box-shadow: 0 0 0 1px #000; }
  .laptop .scr img { display: block; width: 100%; }
  .laptop .base { position: relative; height: 18px; margin: 0 -6.5%; border-radius: 3px 3px 22px 22px;
    background: linear-gradient(180deg, #3a414d 0%, #20252e 35%, #12151b 100%);
    box-shadow: 0 24px 40px -8px rgba(0, 0, 0, 0.7), inset 0 1px 0 #555d6a; }
  .laptop .base::after { content: ""; position: absolute; top: 0; left: 50%; width: 15%; height: 7px; transform: translateX(-50%); border-radius: 0 0 9px 9px; background: linear-gradient(#0d1014, #1a1e25); }

  /* phone */
  .phone { position: absolute; border-radius: 50px; padding: 11px;
    background: linear-gradient(150deg, #353c48 0%, #161a21 30%, #0c0e12 100%);
    box-shadow: inset 0 0 0 1.5px #3b4352, 0 40px 80px -10px rgba(0, 0, 0, 0.8), 0 0 0 1px #0a0c10; }
  .phone .scr { position: relative; border-radius: 40px; overflow: hidden; background: #0b0d12; }
  .phone .bar { height: 30px; display: flex; align-items: center; justify-content: space-between; padding: 0 26px 0 30px; background: #0b0d12;
    font: 600 13px "Segoe UI", sans-serif; color: #e6e9f0; letter-spacing: 0.2px; }
  .phone .bar .ic { display: flex; gap: 6px; align-items: center; }
  .phone .bar svg { width: 15px; height: 15px; fill: #e6e9f0; }
  .phone .cam { position: absolute; top: 9px; left: 50%; width: 13px; height: 13px; margin-left: -6.5px; border-radius: 50%; background: #020304; box-shadow: 0 0 0 2px #14171d; }
  .phone .scr img { display: block; width: 100%; }
`;

const STATUS_ICONS = `<span class="ic">
  <svg viewBox="0 0 24 24"><path d="M2 20h3v-4H2zm5 0h3v-8H7zm5 0h3V8h-3zm5 0h3V4h-3z"/></svg>
  <svg viewBox="0 0 24 24"><path d="M12 20.5 1.5 8.6a15 15 0 0 1 21 0z"/></svg>
  <svg viewBox="0 0 24 24"><path d="M7 4h10v17H7z" opacity=".35"/><path d="M7 9h10v12H7zM10 2h4v2h-4z"/></svg>
</span>`;

function phone(img, { left, top, width, z = 2, time = '10:42' }) {
  return `<div class="phone" style="left:${left}px;top:${top}px;width:${width}px;z-index:${z}">
    <div class="scr"><div class="bar"><span>${time}</span>${STATUS_ICONS}</div><div class="cam"></div><img src="${img}"></div></div>`;
}

function laptop(img, { left, top, width, z = 1 }) {
  return `<div class="laptop" style="left:${left}px;top:${top}px;width:${width}px;z-index:${z}">
    <div class="lid"><div class="scr"><img src="${img}"></div></div><div class="base"></div></div>`;
}

async function render(browser, html, { width, height, scale = 1 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))));
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/* ------------------------------------------------------------------------------ tray states */

function runPs(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`powershell timed out: ${err}`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * The tray's real icons and real classification for three situations, computed by monitor-tray.ps1
 * itself (-SaveIconsTo, -Once -Json). The status it classifies is the running demo agent's /status,
 * served by a stand-in server so the "public link" can be shown working (Tailscale) and broken.
 */
export async function trayData({ root, tmpDir, agentBase }) {
  const script = path.join(root, 'scripts', 'monitor-tray.ps1');
  const iconDir = path.join(tmpDir, 'tray-icons');
  const r = await runPs(['-File', script, '-SaveIconsTo', iconDir]);
  if (r.code !== 0) throw new Error(`monitor-tray.ps1 -SaveIconsTo failed: ${r.err || r.out}`);
  const icons = {};
  for (const c of ['green', 'amber', 'red', 'gray']) icons[c] = dataUrl(path.join(iconDir, `monitor-${c}-64.png`));
  const icons32 = {};
  for (const c of ['green', 'amber', 'red', 'gray']) icons32[c] = dataUrl(path.join(iconDir, `monitor-${c}-32.png`));

  const real = await (await fetch(`${agentBase}/status`)).json();
  const publicUrl = 'https://dev-pc.tail1a2b3c.ts.net';
  let publicUp = true;
  const srv = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/status') return send(200, { ...real, now: Date.now(), publicUrl, log: [] });
    if (req.url === '/healthz') return send(200, { ok: true, version: real.version });
    if (req.url === '/public/healthz') return publicUp ? send(200, { ok: true }) : send(502, { ok: false, error: 'Bad Gateway' });
    send(404, {});
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfgDir = path.join(tmpDir, 'tray-config');
  fs.mkdirSync(cfgDir, { recursive: true });
  // the stand-in's own port: the "red" check must never probe a real agent's port
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ port: srv.address().port, publicUrl }));
  const once = async (statusUrl, healthUrl) => {
    const res = await runPs(['-File', script, '-Once', '-Json', '-ConfigDir', cfgDir, '-StatusUrl', statusUrl, '-HealthUrl', healthUrl]);
    try {
      return JSON.parse(res.out);
    } catch {
      throw new Error(`monitor-tray.ps1 -Once printed no JSON: ${res.out} ${res.err}`);
    }
  };
  try {
    const green = await once(`${base}/status`, `${base}/public/healthz`);
    publicUp = false;
    const amber = await once(`${base}/status`, `${base}/public/healthz`);
    srv.close();
    const red = await once(`${base}/status`, `${base}/public/healthz`); // nothing listens any more
    return { icons, icons32, green, amber, red };
  } finally {
    srv.close();
  }
}

export async function renderTray(browser, data, outFile, optimize) {
  const { icons, icons32 } = data;
  const rows = [
    { c: 'green', name: 'Green', color: '#4ade80', tip: data.green.tooltip, desc: 'The agent runs and your phone can reach it.' },
    { c: 'amber', name: 'Amber', color: '#fbbf24', tip: data.amber.tooltip, desc: data.amber.reasons?.[0]?.replace(/:.*$/, '') || 'Something on the way is broken.' },
    { c: 'red', name: 'Red', color: '#f87171', tip: data.red.tooltip, desc: 'The agent is not running or does not answer.' },
    { c: 'gray', name: 'Gray', color: '#9ca3af', tip: 'TermPocket: checking...', desc: 'Just started: the first check is on its way.' },
  ];
  const menuLines = data.green.menu;
  const item = (t, { bold = false, off = false, hot = false } = {}) => `<div class="mi${off ? ' off' : ''}${bold ? ' b' : ''}${hot ? ' hot' : ''}">${esc(t)}</div>`;
  const sep = '<div class="sep"></div>';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { ${BRAND_BG} position: relative; }
    .wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 560px 1fr; gap: 40px; padding: 44px 48px; }
    .states { display: flex; flex-direction: column; gap: 14px; justify-content: center; }
    .state { display: grid; grid-template-columns: 76px 1fr; gap: 18px; align-items: center; padding: 14px 18px; border-radius: 16px;
      background: rgba(19, 23, 31, 0.78); border: 1px solid #232a37; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
    .tile { width: 76px; height: 76px; border-radius: 16px; display: grid; place-items: center; background: #0b0e13; border: 1px solid #232a37; }
    .tile img { width: 48px; height: 48px; image-rendering: auto; }
    .name { font-weight: 700; font-size: 17px; letter-spacing: 0.2px; display: flex; align-items: center; gap: 8px; }
    .name i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
    .tip { margin-top: 6px; display: inline-block; font: 13px "Segoe UI", sans-serif; color: #f3f4f6; background: #2b2b2b; border: 1px solid #3c3c3c; border-radius: 6px; padding: 4px 9px; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
    .desc { margin-top: 7px; font-size: 13.5px; color: #a3abbc; }
    .desk { position: relative; border-radius: 18px; overflow: hidden; border: 1px solid #232a37;
      background: radial-gradient(600px 360px at 70% 20%, rgba(70, 120, 230, 0.35), transparent 70%), radial-gradient(500px 300px at 20% 80%, rgba(45, 226, 176, 0.18), transparent 70%), linear-gradient(160deg, #0d1b3a, #081022 60%, #050913); }
    .taskbar { position: absolute; left: 0; right: 0; bottom: 0; height: 48px; background: rgba(32, 32, 32, 0.92); border-top: 1px solid #3a3a3a;
      display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 0 10px; font: 12px "Segoe UI", sans-serif; color: #fff; }
    .tb-ic { width: 32px; height: 36px; display: grid; place-items: center; border-radius: 5px; color: #fff; }
    .tb-ic svg { width: 16px; height: 16px; fill: none; stroke: #fff; stroke-width: 1.6; }
    .tb-ic.sel { background: rgba(255, 255, 255, 0.09); }
    .tb-ic img { width: 16px; height: 16px; }
    .clock { text-align: right; line-height: 1.25; padding: 0 8px 0 10px; }
    .menu { position: absolute; right: 74px; bottom: 54px; width: 268px; padding: 3px 0; background: #f2f2f2; border: 1px solid #a0a0a0; box-shadow: 2px 3px 10px rgba(0, 0, 0, 0.45);
      font: 12px "Segoe UI", sans-serif; color: #1b1b1b; }
    .mi { padding: 3px 14px 3px 16px; height: 22px; display: flex; align-items: center; }
    .mi.off { color: #8d8d8d; }
    .mi.b { font-weight: 700; }
    .mi.hot { background: #cce8ff; outline: 1px solid #99d1ff; outline-offset: -1px; }
    .sep { height: 1px; background: #d7d7d7; margin: 3px 1px 3px 1px; }
    .cap { position: absolute; left: 22px; top: 18px; font-size: 13px; color: #c8d3e6; letter-spacing: 0.3px; }
    .cap b { color: #fff; }
  </style></head><body><div class="grid-bg"></div><div class="wrap">
    <div class="states">${rows.map((r) => `<div class="state"><div class="tile"><img src="${icons[r.c]}"></div><div>
      <div class="name" style="color:${r.color}"><i style="background:${r.color}"></i>${r.name}</div>
      <div class="tip">${esc(r.tip)}</div><div class="desc">${esc(r.desc)}</div></div></div>`).join('')}</div>
    <div class="desk">
      <div class="cap"><b>Right-click</b> the tray icon · <b>left-click</b> opens the Monitor dashboard</div>
      <div class="menu">
        ${menuLines.map((l) => item(l, { off: true })).join('')}${sep}
        ${item('Open Monitor', { bold: true, hot: true })}${item('Run self-test')}${sep}
        ${item('Restart agent')}${item('Stop agent')}${item('Start agent', { off: true })}${sep}
        ${item('Open log file')}${item('Open pairing page')}${item('Open phone link')}${sep}
        ${item('Exit monitor')}
      </div>
      <div class="taskbar">
        <div class="tb-ic"><svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg></div>
        <div class="tb-ic sel"><img src="${icons32.green}"></div>
        <div class="tb-ic"><svg viewBox="0 0 16 16"><path d="M1.5 6.5a9.5 9.5 0 0 1 13 0M4 9a6 6 0 0 1 8 0M6.5 11.5a2.4 2.4 0 0 1 3 0"/></svg></div>
        <div class="tb-ic"><svg viewBox="0 0 16 16"><path d="M2 6h3l4-3v10l-4-3H2zM11.5 5.5a3.5 3.5 0 0 1 0 5"/></svg></div>
        <div class="tb-ic"><svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="12" height="7" rx="1.5"/><path d="M14.5 7v2"/><rect x="3" y="6" width="7" height="4" fill="#fff" stroke="none"/></svg></div>
        <div class="clock">10:42 AM<br>11/23/2026</div>
      </div>
    </div>
  </div></body></html>`;
  const page = await render(browser, html, { width: 1200, height: 520, scale: 2 });
  const buf = await page.screenshot({ type: 'png' });
  await page.context().close();
  fs.writeFileSync(outFile, await optimize(buf));
}

/* ---------------------------------------------------------------------------- social preview */

export async function renderSocial(browser, { shots, logo }, outFile, optimize) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { ${BRAND_BG} position: relative; }
    .text { position: absolute; left: 64px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; z-index: 5; }
    .brand { display: flex; align-items: center; gap: 20px; }
    .brand img { width: 84px; height: 84px; filter: drop-shadow(0 10px 24px rgba(45, 226, 176, 0.25)); }
    .brand h1 { font-size: 66px; font-weight: 700; letter-spacing: -1.6px; color: #fff; }
    .tag { margin-top: 26px; font-size: 33px; line-height: 1.2; font-weight: 600; letter-spacing: -0.4px; color: #dfe6f0; }
    .tag em { font-style: normal; background: linear-gradient(90deg, #8bf7d2, #46c9e6); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .sub { margin-top: 16px; font-size: 18px; line-height: 1.45; color: #9aa6b8; max-width: 470px; }
    .chips { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 9px; max-width: 500px; }
    .chip { font-size: 14.5px; font-weight: 600; color: #cfeee3; padding: 7px 13px; border-radius: 999px; background: rgba(110, 240, 194, 0.08); border: 1px solid rgba(110, 240, 194, 0.28); }
    .foot { position: absolute; left: 64px; bottom: 34px; font: 14px Consolas, monospace; color: #6f7b8e; z-index: 5; }
  </style></head><body><div class="grid-bg"></div>
    <div class="text">
      <div class="brand"><img src="${logo}"><h1>TermPocket</h1></div>
      <div class="tag">Your PC's terminals &amp; VS Code —<br><em>in your pocket</em></div>
      <div class="sub">Control Windows, VS Code and Claude Code sessions from your Android phone or any browser.</div>
      <div class="chips"><span class="chip">Live terminals</span><span class="chip">VS Code workbench</span><span class="chip">Remote Desktop</span><span class="chip">Tailscale · no open ports</span></div>
    </div>
    <div class="foot">github.com/ehabmansour1/TermPocket · MIT</div>
    ${laptop(shots.workbench, { left: 640, top: 96, width: 720, z: 1 })}
    ${phone(shots.terminal, { left: 572, top: 150, width: 214, z: 3 })}
  </body></html>`;
  const page = await render(browser, html, { width: 1280, height: 640, scale: 1 });
  const buf = await page.screenshot({ type: 'png' });
  await page.context().close();
  fs.writeFileSync(outFile, await optimize(buf, { budget: 900 * 1024 }));
}

/* ------------------------------------------------------------------------------------- hero */

export async function renderHero(browser, { shots }, outFile, optimize) {
  const W = 1600;
  const H = 900;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { ${BRAND_BG} position: relative; }
    .glow { position: absolute; left: 50%; top: 52%; width: 1100px; height: 520px; transform: translate(-50%, -50%); background: radial-gradient(closest-side, rgba(110, 240, 194, 0.16), transparent); filter: blur(10px); }
  </style></head><body><div class="grid-bg"></div><div class="glow"></div>
    ${laptop(shots.workbench, { left: 250, top: 64, width: 1100, z: 1 })}
    ${phone(shots.list, { left: 76, top: 252, width: 250, z: 2, time: '10:41' })}
    ${phone(shots.terminal, { left: 1268, top: 204, width: 268, z: 3 })}
  </body></html>`;
  const page = await render(browser, html, { width: W, height: H, scale: 1 });
  const buf = await page.screenshot({ type: 'png' });
  await page.context().close();
  fs.writeFileSync(outFile, await optimize(buf, { budget: 900 * 1024 }));
}

export { dataUrl };
