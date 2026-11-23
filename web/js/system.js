// System tab: PC info cards, processes, power, clipboard and "Open on PC" (§4.3).

import {
  h, btn, iconBtn, toast, toastError, actionSheet, confirmDialog, setChildren, segmented,
  emptyState, spinner, banner, store, debounce, fmtBytes, fmtDuration, copyText, readClipboard, clamp,
} from './ui.js';
import { icon } from './icons.js';

const INFO_REFRESH_MS = 5000;

const POWER = [
  { action: 'lock', label: 'Lock', iconName: 'lock', msg: 'Locks the Windows session. Running programs keep running.', danger: false },
  { action: 'sleep', label: 'Sleep', iconName: 'moon', msg: 'The PC goes to sleep — you won’t be able to reach it again until it wakes up.', danger: true },
  { action: 'hibernate', label: 'Hibernate', iconName: 'hibernate', msg: 'Saves everything open to disk and powers the PC off. Nothing is lost, but you can’t reach it again until someone presses the power button.', danger: true },
  { action: 'restart', label: 'Restart', iconName: 'restart', msg: 'Restarts the PC in 30 seconds. You can cancel during that time.', danger: true, delayed: true },
  { action: 'shutdown', label: 'Shut down', iconName: 'power', msg: 'Shuts the PC down in 30 seconds. You can cancel during that time. Unsaved work may be lost.', danger: true, delayed: true },
  { action: 'logoff', label: 'Sign out', iconName: 'logout', msg: 'Signs out of Windows immediately. Unsaved work will be lost and the agent stops.', danger: true },
];

export function createSystemTab(panel, app) {
  const { conn } = app;
  let info = null;
  let infoErr = '';
  let infoAt = 0;
  let infoTimer = 0;
  let visible = false;
  let procs = null;
  let procErr = '';
  let procLoading = false;
  let procSort = store.get('procSort', 'mem');
  let procQuery = '';
  let shutdownAt = 0;
  let shutdownKind = '';
  let countdownTimer = 0;

  /* ---------------------------------------------------------------- DOM */

  const subEl = h('div', { class: 'panel-sub' }, '—');
  const cards = h('div', { class: 'grid-cards' });
  const powerBanner = h('div', { class: 'banner-slot' });
  const powerGrid = h('div', { class: 'power-grid' }, POWER.map((p) => h('button', {
    type: 'button', class: ['power-btn', p.danger && 'danger'], onClick: () => power(p),
  }, icon(p.iconName, { size: 22 }), h('span', null, p.label))));
  const cancelBtn = btn('Cancel shutdown / restart', { variant: 'ghost', iconName: 'x', small: true, onClick: () => cancelShutdown() });

  // Clipboard
  const clipArea = h('textarea', { class: 'input textarea mono clip-area', rows: 4, placeholder: 'Clipboard text…', spellcheck: false, 'aria-label': 'Clipboard text' });
  const clipMeta = h('div', { class: 'field-hint' }, 'Get the PC clipboard, or type / paste here and send it to the PC.');

  // Open on PC
  const openIn = h('input', { class: 'input mono', type: 'text', placeholder: 'https://… or C:\\path\\file or notepad', autocomplete: 'off', spellcheck: false, autocapitalize: 'off', enterKeyHint: 'go', 'aria-label': 'URL, file, folder or program' });
  const openRecent = h('div', { class: 'chips' });
  openIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openOnPc(); } });

  // Processes
  const procSearch = h('input', { class: 'input search-input', type: 'search', placeholder: 'Filter by name, PID or title', autocomplete: 'off', spellcheck: false, autocapitalize: 'off', 'aria-label': 'Filter processes' });
  procSearch.addEventListener('input', debounce(() => { procQuery = procSearch.value.trim().toLowerCase(); renderProcs(); }, 120));
  const sortSeg = segmented([
    { value: 'mem', label: 'Memory' }, { value: 'cpu', label: 'CPU' }, { value: 'name', label: 'Name' },
  ], procSort, (v) => { procSort = v; store.set('procSort', v); loadProcs(); }, { cls: 'seg-sm' });
  const procList = h('div', { class: 'proc-list' });

  panel.append(
    h('div', { class: 'panel-head' },
      h('div', { class: 'panel-heading' }, h('h1', { class: 'panel-title' }, 'System'), subEl),
      h('div', { class: 'panel-actions' }, iconBtn('refresh', 'Refresh', () => { loadInfo(); loadProcs(); }))),
    cards,
    section('Power', 'power', [powerBanner, powerGrid, h('div', { class: 'center-row' }, cancelBtn)]),
    section('Clipboard', 'clipboard', [
      clipArea, clipMeta,
      h('div', { class: 'btn-row' },
        btn('Get from PC', { iconName: 'download', small: true, onClick: clipGet }),
        btn('Copy to phone', { iconName: 'copy', small: true, variant: 'ghost', onClick: clipCopy }),
        btn('Paste here', { iconName: 'paste', small: true, variant: 'ghost', onClick: clipPaste }),
        btn('Send to PC', { iconName: 'upload', small: true, variant: 'primary', onClick: clipSet })),
    ]),
    section('Open on PC', 'external', [
      h('div', { class: 'inline-form' }, openIn, btn('Open', { variant: 'primary', iconName: 'external', small: true, onClick: () => openOnPc() })),
      h('div', { class: 'field-hint' }, 'Opens a URL, file, folder or program with its default handler.'),
      openRecent,
    ]),
    section('Processes', 'list', [
      h('div', { class: 'sub-head' }, sortSeg.el, iconBtn('refresh', 'Refresh processes', () => loadProcs(), { cls: 'sm' })),
      h('div', { class: 'searchbar' }, icon('search', { size: 18 }), procSearch),
      procList,
    ], 'procs'));

  renderInfo();
  renderProcs();
  renderRecent();
  renderPowerState();

  /* ------------------------------------------------------------- events */

  conn.on('ready', () => { if (visible) { loadInfo(); loadProcs(); } });
  conn.on('down', () => renderInfo());
  document.addEventListener('visibilitychange', () => scheduleInfo());

  /* ---------------------------------------------------------------- info */

  function section(title, iconName, children, cls) {
    return h('section', { class: ['section', 'sys-section', cls] },
      h('div', { class: 'section-head' }, h('h2', null, icon(iconName, { size: 16 }), title)),
      children);
  }

  async function loadInfo() {
    if (!conn.online) return;
    try {
      info = await conn.request('sys.info');
      infoErr = '';
      infoAt = Date.now();
      app.noteSysInfo(info);
    } catch (err) {
      infoErr = err.message;
    }
    renderInfo();
    scheduleInfo();
  }

  function scheduleInfo() {
    clearTimeout(infoTimer);
    if (!visible || document.visibilityState !== 'visible') return;
    infoTimer = setTimeout(() => { if (visible && conn.online) loadInfo(); else scheduleInfo(); }, INFO_REFRESH_MS);
  }

  function meter(pct, tone) {
    const v = clamp(Number(pct) || 0, 0, 100);
    const t = tone || (v > 90 ? 'err' : v > 70 ? 'warn' : 'ok');
    return h('div', { class: ['meter', t], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(v)) },
      h('i', { style: `width:${v}%` }));
  }

  function card(title, iconName, big, children, cls) {
    return h('div', { class: ['info-card', cls] },
      h('div', { class: 'info-card-head' }, icon(iconName, { size: 16 }), h('span', null, title)),
      big != null ? h('div', { class: 'info-big mono' }, big) : null,
      children);
  }

  function renderInfo() {
    if (!info) {
      subEl.textContent = conn.online ? 'Loading…' : 'Offline';
      setChildren(cards, infoErr
        ? emptyState({ iconName: 'alert', title: 'Couldn’t read system info', text: infoErr, tone: 'err', action: btn('Retry', { small: true, onClick: loadInfo }) })
        : (conn.online ? spinner('Reading system info…') : h('div', { class: 'muted-note' }, 'Waiting for the PC…')));
      return;
    }
    const i = info;
    subEl.textContent = `${i.hostname || 'PC'} · ${i.user || ''}${conn.online ? '' : ' · offline'}`;
    const memUsed = (i.memTotal || 0) - (i.memFree || 0);
    const memPct = i.memTotal ? (memUsed / i.memTotal) * 100 : 0;
    const load = Number(i.cpuLoad) || 0;
    const nodes = [
      card('CPU', 'cpu', `${Math.round(load)}%`, [meter(load), h('div', { class: 'info-line clamp', title: i.cpuModel || '' }, cpuName(i.cpuModel) || '—'),
        h('div', { class: 'info-line dim' }, `${i.cpuCount || '?'} logical cores`)]),
      card('Memory', 'memory', `${Math.round(memPct)}%`, [meter(memPct), h('div', { class: 'info-line' }, `${fmtBytes(memUsed)} of ${fmtBytes(i.memTotal)}`),
        h('div', { class: 'info-line dim' }, `${fmtBytes(i.memFree)} free`)]),
      card('Uptime', 'clock', fmtDuration(i.uptimeSec), [h('div', { class: 'info-line dim' },
        i.uptimeSec ? `since ${new Date(infoAt - i.uptimeSec * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '')]),
      i.battery
        ? card('Battery', 'battery', `${Math.round(i.battery.percent)}%`, [meter(i.battery.percent, i.battery.percent < 20 ? 'err' : 'ok'),
          h('div', { class: 'info-line dim' }, i.battery.charging ? 'Charging' : 'On battery')])
        : card('Power', 'battery', 'AC', [h('div', { class: 'info-line dim' }, 'Plugged in · no battery')]),
      card('Host', 'user', null, [
        kv('Name', i.hostname), kv('User', i.user), kv('OS', [i.os, i.release].filter(Boolean).join(' ')), kv('Arch', i.arch),
      ], 'wide'),
      card('Network', 'globe', null, [
        (i.ips && i.ips.length) ? h('div', { class: 'ip-list' }, i.ips.map((ip) => h('button', {
          type: 'button', class: 'chip mono', title: 'Copy', onClick: async () => toast((await copyText(ip)) ? `Copied ${ip}` : 'Copy failed'),
        }, ip))) : h('div', { class: 'info-line dim' }, 'No addresses'),
      ], 'wide'),
    ];
    if (Array.isArray(i.monitors) && i.monitors.length) {
      nodes.push(card('Displays', 'monitor', null, i.monitors.map((m) => h('div', { class: 'info-line' },
        h('span', { class: 'mono' }, `#${m.index + 1}`), ` ${m.width}×${m.height} at ${m.x},${m.y}`, m.primary ? h('span', { class: 'pill ok' }, 'primary') : null)), 'wide'));
    }
    setChildren(cards, nodes);
  }

  /** "AMD Ryzen 7 PRO 4750G with Radeon Graphics   " / "Intel(R) Core(TM) i7 CPU @ 3.4GHz" → tidy name. */
  function cpuName(model) {
    return String(model || '').replace(/\((R|TM|C)\)/gi, '').replace(/\s+CPU\b/i, '').replace(/\s+/g, ' ').trim();
  }

  function kv(k, v) {
    return h('div', { class: 'kv' }, h('span', { class: 'kv-k' }, k), h('span', { class: 'kv-v mono' }, v || '—'));
  }

  /* ------------------------------------------------------------ processes */

  async function loadProcs() {
    if (!conn.online || procLoading) return;
    procLoading = true;
    renderProcs();
    try {
      const list = await conn.request('proc.list', { sort: procSort, limit: 150 });
      procs = Array.isArray(list) ? list : [];
      procErr = '';
    } catch (err) {
      procErr = err.message;
    }
    procLoading = false;
    renderProcs();
  }

  function renderProcs() {
    if (!procs) {
      setChildren(procList, procErr
        ? emptyState({ iconName: 'alert', title: 'Couldn’t list processes', text: procErr, tone: 'err', action: btn('Retry', { small: true, onClick: loadProcs }) })
        : procLoading ? spinner('Loading processes…') : btn('Load processes', { small: true, iconName: 'list', onClick: loadProcs }));
      return;
    }
    const q = procQuery;
    const list = q ? procs.filter((p) => String(p.name || '').toLowerCase().includes(q) || String(p.pid).includes(q) || String(p.title || '').toLowerCase().includes(q)) : procs;
    const maxMem = Math.max(1, ...procs.map((p) => p.memMB || 0));
    setChildren(procList,
      h('div', { class: 'list-caption' }, `${list.length} of ${procs.length} processes${procLoading ? ' · refreshing…' : ''}`),
      list.length ? h('div', { class: 'list' }, list.map((p) => h('button', { type: 'button', class: 'proc-row', onClick: () => procMenu(p) },
        h('span', { class: 'proc-main' },
          h('span', { class: 'proc-name' }, p.name || '?'),
          p.title ? h('span', { class: 'proc-title ellipsis' }, p.title) : null),
        h('span', { class: 'proc-stats mono' },
          h('span', { class: 'proc-mem' }, `${(p.memMB ?? 0).toFixed((p.memMB ?? 0) < 10 ? 1 : 0)} MB`),
          h('span', { class: 'proc-cpu' }, `${fmtDuration(p.cpuSec)} cpu · ${p.pid}`)),
        h('span', { class: 'proc-bar', style: `width:${((p.memMB || 0) / maxMem) * 100}%` }))))
        : h('div', { class: 'muted-note' }, 'No matching processes.'));
  }

  function procMenu(p) {
    actionSheet({
      title: p.name,
      subtitle: `PID ${p.pid} · ${(p.memMB ?? 0).toFixed(1)} MB${p.title ? ` · ${p.title}` : ''}`,
      actions: [
        { label: 'End process', sub: 'Ask it to close', iconName: 'x', danger: true, onSelect: () => kill(p, false) },
        { label: 'Force kill', sub: 'Terminate immediately — unsaved data is lost', iconName: 'zap', danger: true, onSelect: () => kill(p, true) },
        { label: 'Copy PID', iconName: 'copy', onSelect: async () => toast((await copyText(String(p.pid))) ? 'PID copied' : 'Copy failed') },
      ],
    });
  }

  async function kill(p, force) {
    const ok = await confirmDialog({
      title: `${force ? 'Force kill' : 'End'} ${p.name}?`,
      message: `PID ${p.pid}${p.title ? ` — “${p.title}”` : ''}. ${force ? 'The process is terminated immediately; unsaved data will be lost.' : 'The process will be asked to close.'}`,
      confirmText: force ? 'Force kill' : 'End process', danger: true, iconName: 'alert',
    });
    if (!ok) return;
    try {
      await conn.request('proc.kill', { pid: p.pid, force: !!force });
      toast(`${p.name} (${p.pid}) ended`, { type: 'ok' });
      procs = procs ? procs.filter((x) => x.pid !== p.pid) : procs;
      renderProcs();
      setTimeout(loadProcs, 800);
    } catch (err) { toastError(err, 'Kill failed'); }
  }

  /* ---------------------------------------------------------------- power */

  async function power(p) {
    const ok = await confirmDialog({
      title: `${p.label}?`, message: p.msg, confirmText: p.label, danger: p.danger, iconName: p.iconName,
    });
    if (!ok) return;
    try {
      await conn.request('power', { action: p.action });
      if (p.delayed) {
        shutdownAt = Date.now() + 30000;
        shutdownKind = p.label.toLowerCase();
        renderPowerState();
        toast(`${p.label} in 30 s`, { type: 'warn', action: { label: 'Cancel', onClick: cancelShutdown }, timeout: 8000 });
      } else {
        toast(`${p.label} sent`, { type: 'ok' });
      }
    } catch (err) { toastError(err, p.label); }
  }

  async function cancelShutdown() {
    try {
      await conn.request('power', { action: 'cancel' });
      shutdownAt = 0;
      renderPowerState();
      toast('Shutdown / restart cancelled', { type: 'ok' });
    } catch (err) { toastError(err, 'Cancel failed'); }
  }

  function renderPowerState() {
    clearInterval(countdownTimer);
    const left = Math.ceil((shutdownAt - Date.now()) / 1000);
    if (!shutdownAt || left <= 0) {
      shutdownAt = 0;
      setChildren(powerBanner);
      cancelBtn.classList.remove('danger', 'primary');
      cancelBtn.classList.add('ghost');
      return;
    }
    const text = h('span', null, `PC will ${shutdownKind === 'restart' ? 'restart' : 'shut down'} in `, h('b', { class: 'mono' }, `${left}s`));
    setChildren(powerBanner, banner(text, { tone: 'err', iconName: 'power', actions: [btn('Cancel', { small: true, variant: 'danger', onClick: cancelShutdown })] }));
    cancelBtn.classList.remove('ghost');
    cancelBtn.classList.add('danger');
    countdownTimer = setInterval(() => {
      const s = Math.ceil((shutdownAt - Date.now()) / 1000);
      const b = powerBanner.querySelector('b');
      if (s <= 0 || !b) { renderPowerState(); return; }
      b.textContent = `${s}s`;
    }, 1000);
  }

  /* ------------------------------------------------------------ clipboard */

  async function clipGet() {
    try {
      const r = await conn.request('clip.get');
      clipArea.value = (r && r.text) || '';
      clipMeta.textContent = clipArea.value ? `PC clipboard · ${clipArea.value.length} characters` : 'PC clipboard is empty (or not text).';
    } catch (err) { toastError(err, 'Clipboard'); }
  }

  async function clipCopy() {
    if (!clipArea.value) { toast('Nothing to copy — get the PC clipboard first'); return; }
    const ok = await copyText(clipArea.value);
    if (ok) toast('Copied to phone clipboard', { type: 'ok' });
    else {
      clipArea.focus();
      clipArea.select();
      toast('Select the text and copy it manually', { type: 'warn' });
    }
  }

  async function clipPaste() {
    const t = await readClipboard();
    if (t == null) {
      clipArea.focus();
      toast('Long-press the box and choose Paste', { type: 'info' });
      return;
    }
    clipArea.value = t;
    clipMeta.textContent = `From phone · ${t.length} characters`;
  }

  async function clipSet() {
    try {
      await conn.request('clip.set', { text: clipArea.value });
      toast('Sent to PC clipboard', { type: 'ok' });
    } catch (err) { toastError(err, 'Clipboard'); }
  }

  /* ---------------------------------------------------------- open on PC */

  async function openOnPc(target = openIn.value.trim()) {
    if (!target) { openIn.focus(); return; }
    try {
      await conn.request('sys.open', { target });
      toast(`Opened on PC`, { type: 'ok' });
      const recent = store.get('openRecent', []).filter((x) => x !== target);
      recent.unshift(target);
      store.set('openRecent', recent.slice(0, 6));
      openIn.value = '';
      renderRecent();
    } catch (err) { toastError(err, 'Open failed'); }
  }

  function renderRecent() {
    const recent = store.get('openRecent', []);
    setChildren(openRecent, recent.map((t) => h('button', { type: 'button', class: 'chip mono', title: t, onClick: () => openOnPc(t) }, t.length > 34 ? `${t.slice(0, 32)}…` : t)));
  }

  return {
    onShow() {
      visible = true;
      if (conn.online) {
        if (!info || Date.now() - infoAt > 3000) loadInfo(); else scheduleInfo();
        if (!procs) loadProcs();
      }
      renderPowerState();
    },
    onHide() {
      visible = false;
      clearTimeout(infoTimer);
    },
  };
}
