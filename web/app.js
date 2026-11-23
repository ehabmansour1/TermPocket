// TermPocket PWA — entry point.
// Boots the shell (status pill, tab bar, menu), the connection, the four tabs,
// pairing flow, service worker and viewport handling.

import { Conn, STATUS } from './js/conn.js';
import { captureTokenFromHash, getToken, clearToken, showPairScreen, isPairScreenOpen } from './js/pair.js';
import { createVsState } from './js/vsstate.js';
import { createTerminalsTab } from './js/terminals.js';
import { createCodeTab } from './js/code.js';
import { anyEditorDirty } from './js/editor.js';
import { createScreenTab } from './js/screen.js';
import { createSystemTab } from './js/system.js';
import { h, btn, toast, sheet, confirmDialog, store, setChildren, pill, segmented, toggleSwitch } from './js/ui.js';
import { icon } from './js/icons.js';
import { isDesktop, onLayoutChange, layoutPref, setLayoutPref } from './js/layout.js';
import { getMirrorDefault, setMirrorDefault, MIRROR_PROFILE } from './js/vsterm.js';

const APP_VERSION = '0.2.0';
const TABS = [
  { id: 'terminals', label: 'Terminals', iconName: 'terminal', create: createTerminalsTab },
  { id: 'code', label: 'Code', iconName: 'code', create: createCodeTab },
  { id: 'screen', label: 'Screen', iconName: 'monitor', create: createScreenTab },
  { id: 'system', label: 'System', iconName: 'cpu', create: createSystemTab },
];

/* -------------------------------------------------------------- viewport */

// Keep a CSS variable with the *visible* height so full-screen views shrink
// (instead of being covered) when the on-screen keyboard opens.
let maxViewportH = 0;
let lastOrientation = '';
function syncViewport() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const orientation = window.innerWidth > window.innerHeight ? 'land' : 'port';
  if (orientation !== lastOrientation) { lastOrientation = orientation; maxViewportH = 0; }
  maxViewportH = Math.max(maxViewportH, height, window.innerHeight);
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${Math.round(height)}px`);
  root.style.setProperty('--vvtop', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  // A desktop window that gets shorter is not an on-screen keyboard.
  const desk = document.documentElement.classList.contains('desk');
  document.body.classList.toggle('kbd-open', !desk && height < maxViewportH * 0.78);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
syncViewport();

/* ----------------------------------------------------------------- boot */

const tokenFromLink = captureTokenFromHash();
const conn = new Conn({ getToken });
const vs = createVsState(conn);

const app = {
  conn,
  vs,
  version: APP_VERSION,
  /** xterm `windowsPty` option derived from the PC's Windows build (better reflow with ConPTY). */
  windowsPty: null,
  setBadge,
  noteSysInfo(info) {
    if (!info) return;
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(info.release || ''));
    if (m && /win/i.test(String(info.os || info.platform || 'windows'))) {
      app.windowsPty = { backend: 'conpty', buildNumber: Number(m[3]) };
    }
  },
};

const statusPill = document.getElementById('statusPill');
const statusText = statusPill.querySelector('.status-text');
const offlineBar = document.getElementById('offlineBar');
const menuBtn = document.getElementById('menuBtn');
menuBtn.append(icon('sliders', { size: 20 }));
menuBtn.addEventListener('click', () => showMenu());
const onStatusClick = () => {
  if (conn.status === STATUS.OFFLINE || conn.status === STATUS.IDLE) conn.reconnectNow();
  else if (conn.status === STATUS.UNAUTHORIZED) openPairing();
  else showMenu();
};
statusPill.addEventListener('click', onStatusClick);

// Desktop sidebar footer: host + connection status + settings (§8.3).
const sideFoot = document.getElementById('sideFoot');
const sideHost = h('span', { class: 'side-host ellipsis' }, 'TermPocket');
const sideState = h('span', { class: 'side-state ellipsis' }, 'Starting…');
const sideDot = h('span', { class: 'status-dot', 'aria-hidden': 'true' });
const sideConn = h('button', { type: 'button', class: 'side-conn', title: 'Connection', onClick: onStatusClick },
  sideDot, h('span', { class: 'side-conn-text' }, sideHost, sideState));
setChildren(sideFoot, sideConn,
  h('button', { type: 'button', class: 'icon-btn side-menu', 'aria-label': 'Settings and connection', title: 'Settings', onClick: () => showMenu() }, icon('gear', { size: 18 })));

/* ------------------------------------------------------------------ tabs */

const tabState = new Map(); // id → { button, panel, api }
let activeTab = null;

for (const t of TABS) {
  const button = document.getElementById(`tab-${t.id}`);
  const panel = document.getElementById(`panel-${t.id}`);
  button.prepend(icon(t.iconName, { size: 22 }));
  button.addEventListener('click', () => {
    if (activeTab === t.id) panel.scrollTo({ top: 0, behavior: 'smooth' });
    else showTab(t.id);
  });
  let api = null;
  try {
    api = t.create(panel, app) || {};
  } catch (err) {
    console.error(`[termpocket] failed to init ${t.id} tab`, err);
    panel.append(h('div', { class: 'empty err' }, `This tab failed to load: ${err.message}`));
    api = {};
  }
  tabState.set(t.id, { button, panel, api });
}

/** Open a PTY session in the Terminals tab (desktop: as a tab of its split view). */
app.openTerminalSession = (s) => {
  showTab('terminals');
  const api = tabState.get('terminals').api;
  if (api && api.openSession) api.openSession(s);
};

document.documentElement.classList.toggle('is-touch', !window.matchMedia('(any-pointer: fine)').matches);
onLayoutChange(() => {
  // Panels re-measure (xterm fit, canvas) after the shell switched between sidebar and tab bar.
  const st = activeTab && tabState.get(activeTab);
  requestAnimationFrame(() => { try { st && st.api.onShow && st.api.onShow(); } catch (err) { console.error(err); } });
});

function showTab(id) {
  if (!tabState.has(id)) id = 'terminals';
  if (activeTab === id) return;
  const prev = activeTab && tabState.get(activeTab);
  if (prev) {
    prev.panel.classList.remove('active');
    prev.button.classList.remove('active');
    prev.button.setAttribute('aria-selected', 'false');
    try { prev.api.onHide && prev.api.onHide(); } catch (err) { console.error(err); }
  }
  activeTab = id;
  const next = tabState.get(id);
  next.panel.classList.add('active');
  next.button.classList.add('active');
  next.button.setAttribute('aria-selected', 'true');
  document.body.dataset.tab = id;
  store.set('tab', id);
  try { next.api.onShow && next.api.onShow(); } catch (err) { console.error(err); }
}

function setBadge(tabId, value) {
  const st = tabState.get(tabId);
  if (!st) return;
  const b = st.button.querySelector('.badge');
  if (!b) return;
  const text = value === 0 || value == null ? '' : String(value);
  b.hidden = !text;
  b.textContent = text.length > 3 ? '99+' : text;
}

showTab(store.get('tab', 'terminals'));

/* ---------------------------------------------------------------- status */

let offlineTick = 0;
const offlineText = h('span', { class: 'offline-text' });
setChildren(offlineBar,
  icon('wifiOff', { size: 16 }),
  offlineText,
  h('button', { type: 'button', class: 'offline-retry', onClick: () => conn.reconnectNow() }, 'Retry now'));

function renderStatus() {
  const s = conn.status;
  statusPill.dataset.status = s;
  document.body.dataset.conn = s;
  clearInterval(offlineTick);
  let text;
  switch (s) {
    case STATUS.ONLINE: text = (conn.info && conn.info.hostname) || 'Connected'; break;
    case STATUS.CONNECTING: text = 'Connecting…'; break;
    case STATUS.AUTH: text = 'Authenticating…'; break;
    case STATUS.UNAUTHORIZED: text = 'Not paired'; break;
    case STATUS.OFFLINE: text = 'Offline'; break;
    default: text = 'Disconnected';
  }
  statusText.textContent = text;
  statusPill.title = s === STATUS.ONLINE ? `Connected to ${text}` : text;
  sideFoot.dataset.status = s;
  sideHost.textContent = (conn.info && conn.info.hostname) || 'Your PC';
  sideHost.title = sideHost.textContent;
  sideState.textContent = s === STATUS.ONLINE
    ? `Online${conn.info && conn.info.version ? ` · v${conn.info.version}` : ''}`
    : s === STATUS.OFFLINE ? 'Offline · click to retry' : text;
  sideConn.title = s === STATUS.ONLINE ? `Connected to ${text} (${location.host})` : text;

  const showBar = s === STATUS.OFFLINE;
  offlineBar.hidden = !showBar;
  if (showBar) {
    // Only the countdown text changes every second: rebuilding the Retry button each tick
    // would swallow a tap that lands between pointerdown and click.
    const renderBar = () => {
      const left = Math.max(0, Math.ceil((conn.retryAt - Date.now()) / 1000));
      offlineText.textContent = `${conn.detail ? `${conn.detail} · ` : 'Connection lost · '}${left ? `retrying in ${left}s` : 'retrying…'}`;
    };
    renderBar();
    offlineTick = setInterval(renderBar, 1000);
  }
}


conn.on('status', renderStatus);
let announcePairing = tokenFromLink; // a fresh pairing link: confirm once the PC accepted it
conn.on('ready', ({ info, reconnect }) => {
  renderStatus();
  if (announcePairing) {
    announcePairing = false;
    toast(`Paired with ${info.hostname || 'your PC'}`, { type: 'ok' });
  } else if (reconnect) toast(`Reconnected to ${info.hostname || 'PC'}`, { type: 'ok', timeout: 1600 });
  // Learn the Windows build once for xterm's ConPTY reflow heuristics.
  if (!app.windowsPty && (info.platform === 'win32' || !info.platform)) {
    conn.request('sys.info').then((si) => app.noteSysInfo(si)).catch(() => {});
  }
});
conn.on('unauthorized', ({ reason }) => {
  renderStatus();
  openPairing(reason === 'bad token' ? 'The PC rejected this pairing token. Pair again with the current link.' : undefined);
});

function openPairing(error) {
  if (isPairScreenOpen()) return;
  showPairScreen({
    error,
    onPaired: () => {
      announcePairing = true;
      conn.stop();
      conn.start();
    },
  });
}

renderStatus();
if (getToken()) {
  conn.start();
} else {
  openPairing();
}

/* ------------------------------------------------------------------ menu */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('appinstalled', () => { installPrompt = null; toast('TermPocket installed', { type: 'ok' }); });

function showMenu() {
  const info = conn.info || {};
  const online = conn.online;
  const rows = [
    ['PC', online ? info.hostname : '—'],
    ['User', online ? info.user : '—'],
    ['Agent', info.version ? `v${info.version} · ${info.platform || ''}` : '—'],
    ['Address', location.host],
    ['App', `v${APP_VERSION}`],
  ];
  const s = sheet({
    title: 'TermPocket',
    subtitle: online ? 'Connected' : conn.status === STATUS.UNAUTHORIZED ? 'Not paired' : 'Not connected',
    content: () => h('div', { class: 'menu' },
      h('div', { class: 'menu-card' },
        h('div', { class: 'menu-status' },
          h('span', { class: 'status-dot', 'data-status': conn.status }),
          h('span', { class: 'menu-host' }, online ? (info.hostname || 'PC') : 'Offline')),
        h('dl', { class: 'kv-list' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, v || '—')])),
        Array.isArray(info.features) && info.features.length
          ? h('div', { class: 'chips' }, info.features.map((f) => pill(f, 'muted')))
          : null),
      settingsCard(),
      h('div', { class: 'menu-actions' },
        btn(online ? 'Reconnect' : 'Connect now', {
          iconName: 'refresh',
          onClick: () => { s.close(); if (conn.status === STATUS.UNAUTHORIZED) openPairing(); else { conn.stop(); conn.start(); } },
        }),
        installPrompt ? btn('Install app', {
          iconName: 'download', variant: 'primary',
          onClick: async () => {
            s.close();
            try { await installPrompt.prompt(); } catch { /* ignore */ }
            installPrompt = null;
          },
        }) : null,
        btn('Check for app update', {
          iconName: 'upload', variant: 'ghost',
          onClick: async () => {
            s.close();
            try {
              const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
              if (reg) { await reg.update(); toast('Checked for updates'); }
              else location.reload();
            } catch { location.reload(); }
          },
        }),
        btn('Forget this device', {
          iconName: 'unlink', variant: 'danger',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Forget this device?',
              message: 'The pairing token is removed from this phone. You’ll need the pairing link or QR code to connect again.',
              confirmText: 'Forget', danger: true, iconName: 'unlink',
            });
            if (!ok) return;
            s.close();
            conn.stop();
            clearToken();
            renderStatus();
            openPairing();
          },
        })),
      h('p', { class: 'menu-foot' }, 'Your PC is reached over Tailscale; nothing passes through third-party servers.')),
  });
}

/**
 * "New VS Code terminals are phone-visible": the user-level default terminal profile of VS Code
 * (settings.get / settings.mirrorDefault, §5.2). Asked from a connected window when the menu opens.
 */
function mirrorDefaultField() {
  const hint = h('span', { class: 'field-hint' });
  let busy = false;
  const sw = toggleSwitch(false, async (v) => {
    if (busy) { sw.set(!v); return; }
    busy = true;
    sw.el.disabled = true;
    const r = await setMirrorDefault(conn, vs, v);
    busy = false;
    sw.el.disabled = false;
    sw.set(r == null ? !v : r);
  }, { label: 'New VS Code terminals are phone-visible' });
  const setHint = (text) => { hint.textContent = text; };
  if (!vs.windows.length || !conn.online) {
    sw.el.disabled = true;
    setHint('Needs a VS Code window with the TermPocket extension.');
  } else {
    sw.el.disabled = true;
    setHint('Checking VS Code…');
    getMirrorDefault(conn, vs).then((on) => {
      if (on == null) { setHint('Not available — update the TermPocket extension on the PC.'); return; }
      sw.set(on);
      sw.el.disabled = false;
      setHint(`New terminals open with the “${MIRROR_PROFILE}” profile: full live output and history here. Terminals already open stay ordinary.`);
    });
  }
  return h('div', { class: 'field row-field' },
    h('span', { class: 'setting-text' }, h('span', { class: 'setting-title' }, 'Phone-visible VS Code terminals'), hint),
    sw.el);
}

/** Settings block of the menu: layout override, VS Code terminal default and Remote Desktop options. */
function settingsCard() {
  const layoutSeg = segmented([
    { value: 'auto', label: 'Auto' }, { value: 'desktop', label: 'Desktop' }, { value: 'phone', label: 'Phone' },
  ], layoutPref(), (v) => {
    setLayoutPref(v);
    toast(v === 'auto' ? `Layout follows the window (${isDesktop() ? 'desktop' : 'phone'} now)` : `${v === 'desktop' ? 'Desktop' : 'Phone'} layout`, { timeout: 1800 });
  }, { cls: 'seg-sm' });
  const clip = toggleSwitch(store.get('rdpClipSync', true) !== false, (v) => store.set('rdpClipSync', v), { label: 'Clipboard sync in Remote Desktop' });
  const cursor = toggleSwitch(store.get('rdpHideCursor', false) === true, (v) => store.set('rdpHideCursor', v), { label: 'Hide local cursor in Remote Desktop' });
  return h('div', { class: 'menu-card settings-card' },
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Layout'), layoutSeg.el,
      h('div', { class: 'field-hint' }, 'Auto: sidebar & split views on a wide window with a mouse, tab bar on phones.')),
    mirrorDefaultField(),
    h('div', { class: 'field row-field' },
      h('span', { class: 'setting-text' }, h('span', { class: 'setting-title' }, 'Remote Desktop clipboard sync'),
        h('span', { class: 'field-hint' }, 'Local → PC when the view gets focus, PC → local after Ctrl+C / Ctrl+X')),
      clip.el),
    h('div', { class: 'field row-field' },
      h('span', { class: 'setting-text' }, h('span', { class: 'setting-title' }, 'Hide local cursor'),
        h('span', { class: 'field-hint' }, 'Remote Desktop shows only the PC’s pointer over the picture')),
      cursor.el));
}

/* ------------------------------------------------- unsaved-edit guard */

// Desktop keeps several editor tabs alive: Ctrl+W (VS Code habit), F5 or closing the window must not
// drop their unsaved edits silently.
window.addEventListener('beforeunload', (e) => {
  if (reloadingAnyway || !anyEditorDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

async function reloadForUpdate() {
  if (anyEditorDirty()) {
    const ok = await confirmDialog({
      title: 'Reload and lose unsaved edits?',
      message: 'Some open files have changes that are not saved to the PC yet. Save them first, or reload anyway.',
      confirmText: 'Reload anyway', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    reloadingAnyway = true; // the user chose to discard: beforeunload must not ask a second time
  }
  location.reload();
}
let reloadingAnyway = false;

/* --------------------------------------------------------- service worker */

if ('serviceWorker' in navigator && window.isSecureContext) {
  // Only announce updates when an older worker was already controlling this page.
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated' && hadController) {
            toast('A new version is ready', { action: { label: 'Reload', onClick: reloadForUpdate }, timeout: 10000 });
          }
        });
      });
    }).catch((err) => console.warn('[termpocket] service worker registration failed', err));
  });
}
