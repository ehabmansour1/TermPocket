// TermPocket Monitor — polls the agent's loopback-only GET /status every 2 s and renders it.
// All data is rendered with textContent / DOM APIs, never parsed as HTML. No external resources.

const POLL_MS = 2000;
const FETCH_TIMEOUT_MS = 4000;
const SELFTEST_TIMEOUT_MS = 25_000;
const RECENT_MS = 10 * 60_000;

const $ = (id) => document.getElementById(id);

/** createElement helper: el('td', 'mono', 'text') or el('div', {class, title}, child, child…). */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (typeof attrs === 'string') node.className = attrs;
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const paths = {
    good: ['M5 12.5l4.5 4.5L19 7.5'],
    degraded: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17.6v.1'],
    down: ['M7 7l10 10', 'M17 7L7 17'],
    unknown: ['M12 6v6l4 2'],
  }[kind] ?? [];
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const FAVICON_COLORS = { good: '#6ee7a8', degraded: '#f6c177', down: '#ff6b81', unknown: '#6b7387' };
function setFavicon(state) {
  const c = FAVICON_COLORS[state] ?? FAVICON_COLORS.unknown;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="5" width="26" height="18" rx="4" fill="#0b0d12" stroke="${c}" stroke-width="2.5"/><path d="M11 28h10" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="14" r="4.5" fill="${c}"/></svg>`;
  $('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ------------------------------------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------------------------------------

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? fmtClock(ms) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(ms)}`;
}
/** "3m 12s ago", relative to the agent's own clock (`now` from /status). */
function ago(ms, now) {
  if (!Number.isFinite(ms)) return '—';
  return `${fmtDuration((now - ms) / 1000)} ago`;
}
const CLIENT_NAMES = { pwa: 'TermPocket app', selftest: 'Self-test' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

let status = null;          // last good /status
let lastOkAt = 0;           // browser time of the last good poll
let failing = false;        // last poll failed
let failCount = 0;
let lastError = '';
let paused = false;
let pollTimer = null;
let lastSelftest = null;    // {ok, steps, at}
let selftestBusy = false;

const logView = { level: 'ALL', query: '', follow: true, key: '' };

// ------------------------------------------------------------------------------------------------
// Overall evaluation
// ------------------------------------------------------------------------------------------------

/** → {state: good|degraded|down|unknown, title, reason, issues:[{sev: down|warn|info, text}]} */
function evaluate() {
  if (failing || !status) {
    if (!status && !failing) return { state: 'unknown', title: 'Checking…', reason: 'Contacting the TermPocket agent on this PC.', issues: [] };
    const seen = lastOkAt ? ` Last answer ${fmtDuration((Date.now() - lastOkAt) / 1000)} ago.` : '';
    return {
      state: 'down',
      title: 'DOWN',
      reason: 'Agent not responding — the TermPocket agent is not running on this PC, so no phone or laptop can connect.',
      issues: [
        { sev: 'down', text: `Retrying every ${POLL_MS / 1000} s.${seen}${lastError ? ` (${lastError})` : ''}` },
        { sev: 'info', text: 'To start it: right-click the TermPocket Monitor tray icon → Start agent, or run  Start-ScheduledTask "TermPocket Agent". Why it stopped: %APPDATA%\\TermPocket\\agent.log' },
      ],
    };
  }
  const s = status;
  const now = s.now;
  const issues = [];
  const r = s.relay ?? {};
  if (r.configured && !r.connected) {
    // Same severity as the tray (amber): the agent works, only the public path is broken.
    issues.push({ sev: 'warn', text: `Relay disconnected — phones can't reach this PC from outside${r.lastError ? ` (${r.lastError})` : ''}` });
  }
  if (!r.configured && !s.publicUrl) {
    issues.push({ sev: 'info', text: 'No public access configured — phones can only reach this PC on the local network or Tailscale.' });
  }
  const h = s.helper ?? {};
  if (!h.running && h.lastError) {
    issues.push({ sev: 'warn', text: `Windows helper is not running: ${h.lastError} — screen view, mouse and keyboard may fail (it restarts on next use).` });
  }
  const ph = s.ptyHost ?? {};
  if (ph.mode === 'inprocess') {
    issues.push({ sev: 'info', text: `Terminals run inside the agent${ph.lastError ? ` (terminals host unavailable: ${ph.lastError})` : ''} — they end when the agent restarts.` });
  }
  const sec = s.security ?? {};
  if (sec.rateLimitedIps > 0) {
    issues.push({ sev: 'warn', text: `${plural(sec.rateLimitedIps, 'address', 'addresses')} locked out after repeated wrong tokens — someone may be guessing your pairing token.` });
  } else if (sec.lastAuthFailure && now - sec.lastAuthFailure.at < RECENT_MS) {
    issues.push({ sev: 'info', text: `Wrong-token attempt from ${sec.lastAuthFailure.ip} ${ago(sec.lastAuthFailure.at, now)}.` });
  }
  if (lastSelftest && !lastSelftest.ok && Date.now() - lastSelftest.at < RECENT_MS) {
    const failed = lastSelftest.steps.filter((x) => !x.ok).map((x) => x.name);
    issues.push({ sev: 'warn', text: `Last self-test failed: ${failed.join('; ') || 'see the self-test card'}.` });
  }
  const recentErrors = (s.log ?? []).filter((l) => l.level === 'ERROR' && now - l.at < RECENT_MS).length;
  if (recentErrors) issues.push({ sev: 'info', text: `${plural(recentErrors, 'error')} logged in the last 10 minutes — see the live log.` });

  const order = { down: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  const worst = issues[0]?.sev;
  if (worst === 'down') return { state: 'down', title: 'DOWN', reason: issues[0].text, issues: issues.slice(1) };
  if (worst === 'warn') return { state: 'degraded', title: 'DEGRADED', reason: issues[0].text, issues: issues.slice(1) };
  const phones = s.phones?.length ?? 0;
  const loopbackOnly = /^(127\.|::1$|localhost$)/.test(String(s.listen?.host ?? ''));
  const where = r.configured
    ? `phones can reach this PC through ${s.publicUrl || r.url}`
    : s.publicUrl
      ? `phones can reach this PC at ${s.publicUrl}`
      : loopbackOnly
        ? 'it only accepts connections from this PC'
        : 'phones can reach this PC on the local network';
  return {
    state: 'good',
    title: 'ALL GOOD',
    reason: `Agent is running and ${where}. ${phones ? `${plural(phones, 'device')} connected now.` : 'No device connected right now.'}`,
    issues,
  };
}

// ------------------------------------------------------------------------------------------------
// Status history (the timeline in the banner): 60 slots of 30 s = the last 30 minutes, worst state
// per slot. Recorded by this page while it is open; kept in localStorage so a reload keeps it.
// ------------------------------------------------------------------------------------------------

const SLOT_MS = 30_000;
const SLOTS = 60;
const RANK = { good: 1, degraded: 2, down: 3 };
const HISTORY_KEY = `termpocket.monitor.history.${location.port || '80'}`;
const history = loadHistory(); // {slotIndex: state}

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  } catch {
    return {};
  }
}

function recordHistory(state) {
  if (!RANK[state]) return;
  const slot = Math.floor(Date.now() / SLOT_MS);
  const prev = history[slot];
  if (!RANK[prev] || RANK[state] > RANK[prev]) history[slot] = state;
  for (const k of Object.keys(history)) if (!(Number(k) > slot - SLOTS)) delete history[k];
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* private window / storage blocked: the timeline still works for this visit */
  }
}

const SLOT_LABEL = { good: 'working', degraded: 'degraded', down: 'down', none: 'not watched' };

function renderTimeline() {
  const slot = Math.floor(Date.now() / SLOT_MS);
  const bars = [];
  let watched = 0;
  let good = 0;
  let downSlots = 0;
  for (let i = slot - SLOTS + 1; i <= slot; i += 1) {
    const st = RANK[history[i]] ? history[i] : 'none';
    if (st !== 'none') watched += 1;
    if (st === 'good') good += 1;
    if (st === 'down') downSlots += 1;
    bars.push(el('i', { class: st, title: `${fmtClock(i * SLOT_MS)}–${fmtClock((i + 1) * SLOT_MS)}  ${SLOT_LABEL[st]}` }));
  }
  $('timelineBars').replaceChildren(...bars);
  const sum = $('timelineSum');
  if (!watched) {
    sum.textContent = 'collecting…';
    sum.className = 'timeline-sum';
    return;
  }
  const pct = Math.round((good / watched) * 1000) / 10;
  const mins = (n) => `${Math.max(1, Math.round((n * SLOT_MS) / 60_000))} min`;
  const down = downSlots ? `down ~${mins(downSlots)}` : 'no downtime';
  sum.textContent = `all good ${pct}% of the time · ${down} · watched ${mins(watched)}`;
  sum.className = `timeline-sum ${pct === 100 ? 'good' : downSlots ? 'down' : 'degraded'}`;
}

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

function kv(dl, rows) {
  const frag = document.createDocumentFragment();
  for (const [label, value, cls] of rows) {
    const dd = el('dd', cls || '');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    frag.append(el('div', null, el('dt', null, label), dd));
  }
  dl.replaceChildren(frag);
}

function setTag(node, text, tone) {
  node.textContent = text;
  node.className = `tag ${tone || ''}`.trim();
}

function renderBanner() {
  const ev = evaluate();
  const banner = $('banner');
  banner.className = `banner state-${ev.state}`;
  recordHistory(ev.state);
  renderTimeline();
  const stBtn = $('selftestBtn');
  if (!selftestBusy) {
    stBtn.disabled = failing;
    stBtn.title = failing ? 'The agent is not running — start it first' : 'Check the whole phone path (local + public), like a real phone would';
  }
  $('bannerIcon').replaceChildren(svgIcon(ev.state));
  $('bannerTitle').textContent = ev.title;
  $('bannerReason').textContent = ev.reason;
  $('bannerIssues').replaceChildren(...ev.issues.map((i) => el('li', `sev-${i.sev}`, i.text)));
  document.body.classList.toggle('is-down', failing);
  const s = status;
  const facts = [
    ['Phones', s && !failing ? s.phones.length : '—'],
    ['Terminals', s && !failing ? s.terminals.filter((t) => !t.exited).length : '—'],
    ['VS Code', s && !failing ? s.vscode.length : '—'],
    ['Uptime', s && !failing ? fmtDuration(s.uptimeSec) : '—'],
  ];
  $('bannerFacts').replaceChildren(...facts.map(([k, v]) => el('div', null, el('dt', null, k), el('dd', null, String(v)))));
  const prefix = { good: '✓', degraded: '!', down: '✗', unknown: '…' }[ev.state];
  document.title = `${prefix} ${ev.title} — TermPocket Monitor`;
  setFavicon(ev.state);
}

function renderPulse() {
  const pulse = $('pulse');
  const upd = $('updated');
  if (paused) {
    pulse.className = 'pulse paused';
    upd.textContent = 'paused';
  } else if (failing) {
    pulse.className = 'pulse dead';
    upd.textContent = lastOkAt ? `no answer · last ${fmtDuration((Date.now() - lastOkAt) / 1000)} ago` : 'no answer · retrying';
  } else if (status) {
    pulse.className = 'pulse live';
    upd.textContent = `live · ${fmtClock(lastOkAt)}`;
  }
}

function renderAgent(s) {
  $('hostline').textContent = `${location.host} · agent v${s.version} · pid ${s.pid}`;
  setTag($('agentTag'), failing ? 'unreachable' : 'running', failing ? 'err' : 'ok');
  kv($('agentKv'), [
    ['Version', s.version],
    ['Uptime', fmtDuration(s.uptimeSec)],
    ['Started', fmtWhen(s.startedAt)],
    ['PID', s.pid],
    ['Listening', `${s.listen.host}:${s.listen.port}`],
  ]);
}

function renderPublic(s) {
  const r = s.relay;
  const url = s.publicUrl;
  let link = null;
  if (url) {
    link = el('a', { href: url, target: '_blank', rel: 'noreferrer noopener' });
    link.textContent = url.replace(/^https?:\/\//, '');
  }
  if (r.configured) {
    setTag($('publicTag'), r.connected ? 'relay connected' : 'relay down', r.connected ? 'ok' : 'err');
    kv($('publicKv'), [
      ['Address', link ?? '—'],
      ['Relay', r.connected ? 'connected' : 'disconnected', r.connected ? 'ok' : 'err'],
      ['Since', r.connected && r.since ? `${fmtWhen(r.since)} (${fmtDuration((s.now - r.since) / 1000)})` : '—'],
      ['Sessions', `${r.sessions} via relay`],
      ['Reconnects', r.reconnects, r.reconnects > 5 ? 'warn' : ''],
      ['Last error', r.lastError ?? 'none', r.lastError ? (r.connected ? 'muted' : 'err') : 'muted'],
    ]);
  } else if (url) {
    setTag($('publicTag'), 'tailscale / url', 'info');
    kv($('publicKv'), [
      ['Address', link],
      ['Relay', 'not configured', 'muted'],
    ]);
  } else {
    setTag($('publicTag'), 'local only', 'plain');
    kv($('publicKv'), [
      ['Address', 'none (no relay.json, no publicUrl)', 'muted'],
      ['Reach', `http://${s.listen.host}:${s.listen.port}`],
    ]);
  }
}

function renderHelper(s) {
  const h = s.helper;
  const unavailable = !h.running && h.lastError === 'windows helper not available';
  const state = h.running ? ['running', 'ok'] : unavailable ? ['unavailable', 'err'] : h.lastError ? ['stopped', 'warn'] : ['idle', 'plain'];
  setTag($('helperTag'), state[0], state[1]);
  kv($('helperKv'), [
    ['State', h.running ? 'running' : h.lastError ? 'not running' : 'idle (starts on demand)', h.running ? 'ok' : h.lastError ? 'warn' : 'muted'],
    ['PID', h.pid ?? '—'],
    ['Restarts', h.restarts, h.restarts > 3 ? 'warn' : ''],
    ['Last error', h.lastError ?? 'none', h.lastError ? (h.running ? 'muted' : 'warn') : 'muted'],
  ]);
}

function renderPtyHost(s) {
  const p = s.ptyHost;
  if (!p || !p.mode) {
    setTag($('ptyHostTag'), 'unknown', 'plain');
    kv($('ptyHostKv'), [['State', 'not reported by this agent version', 'muted']]);
    return;
  }
  const inProc = p.mode === 'inprocess';
  const state = inProc ? ['inside agent', 'warn'] : p.running ? ['running', 'ok'] : ['reconnecting', 'warn'];
  setTag($('ptyHostTag'), state[0], state[1]);
  kv($('ptyHostKv'), [
    ['State', inProc ? 'terminals run inside the agent (they end with it)' : p.running ? 'running — terminals survive agent restarts' : 'reconnecting…', inProc || !p.running ? 'warn' : 'ok'],
    ['PID', p.pid ?? '—'],
    ['Sessions', `${p.sessions} (${p.live} running)`],
    ['Started', p.startedAt ? `${fmtWhen(p.startedAt)} (${fmtDuration((s.now - p.startedAt) / 1000)})` : '—', p.startedAt ? '' : 'muted'],
    ['Adopted', p.adopted ? `${p.adopted} session(s) from before this agent started` : 'none', p.adopted ? '' : 'muted'],
    ['Last error', p.lastError ?? 'none', p.lastError ? 'warn' : 'muted'],
  ]);
}

function renderSecurity(s) {
  const sec = s.security;
  const lf = sec.lastAuthFailure;
  const tone = sec.rateLimitedIps > 0 ? ['under attack?', 'warn'] : lf && s.now - lf.at < RECENT_MS ? ['recent failure', 'info'] : ['quiet', 'ok'];
  setTag($('securityTag'), tone[0], tone[1]);
  kv($('securityKv'), [
    ['Failed logins', sec.authFailures, sec.authFailures ? 'warn' : ''],
    ['Locked-out IPs', sec.rateLimitedIps, sec.rateLimitedIps ? 'err' : ''],
    ['Last failure', lf ? `${lf.ip}` : 'none', lf ? '' : 'muted'],
    ['When', lf ? `${fmtWhen(lf.at)} (${ago(lf.at, s.now)})` : '—', lf ? '' : 'muted'],
  ]);
}

function renderPhones(s) {
  const tbody = $('phonesTbl').tBodies[0];
  const rows = s.phones.map((p) => {
    const name = CLIENT_NAMES[p.client] ?? p.client ?? 'unknown';
    const route = el('span', `pill ${p.via === 'relay' ? 'relay' : 'direct'}`, p.via === 'relay' ? 'relay' : 'direct');
    route.title = p.via === 'relay' ? 'Through the public relay (internet)' : 'Direct: local network, Tailscale or this PC';
    const chips = p.attached.length ? el('div', 'chips', ...p.attached.map((id) => el('span', 'pill', id))) : el('span', 'muted', '—');
    return el(
      'tr',
      null,
      el('td', null, el('span', null, name), el('span', 'sub', `#${p.id}`)),
      el('td', 'mono', p.ip),
      el('td', null, route),
      el('td', null, el('span', null, ago(p.connectedAt, s.now)), el('span', 'sub', `since ${fmtWhen(p.connectedAt)}`)),
      el('td', null, chips),
      el('td', null, p.streaming ? el('span', 'pill ok', 'streaming') : el('span', 'muted', '—')),
    );
  });
  tbody.replaceChildren(...rows);
  $('phonesTbl').classList.toggle('is-empty', rows.length === 0);
  $('phonesEmpty').hidden = rows.length > 0;
  const c = $('phonesCount');
  c.textContent = String(rows.length);
  c.className = `count${rows.length ? ' hot' : ''}`;
}

function renderVscode(s) {
  const items = s.vscode.map((w) =>
    el(
      'li',
      null,
      el('div', 'row1', el('span', { class: 'name', title: w.name }, w.name), el('span', 'when', ago(w.connectedAt, s.now))),
      el('div', { class: 'folders', title: w.folders.join('\n') }, w.folders.length ? w.folders.join('  ·  ') : 'no folder open'),
    ),
  );
  $('vscodeList').replaceChildren(...items);
  $('vscodeEmpty').hidden = items.length > 0;
  const c = $('vscodeCount');
  c.textContent = String(items.length);
  c.className = `count${items.length ? ' hot' : ''}`;
}

function renderTerminals(s) {
  const rows = s.terminals.map((t) =>
    el(
      'tr',
      null,
      el('td', 'mono', t.id),
      el('td', null, el('span', null, t.title || '—'), t.mirror ? el('span', 'sub', 'mirrored in VS Code') : null),
      el('td', 'mono', t.pid ?? '—'),
      el('td', null, el('span', `pill ${t.exited ? 'err' : 'ok'}`, t.exited ? 'exited' : 'running')),
      el('td', 'mono', String(t.attachedClients)),
    ),
  );
  $('terminalsTbl').tBodies[0].replaceChildren(...rows);
  $('terminalsTbl').classList.toggle('is-empty', rows.length === 0);
  $('terminalsEmpty').hidden = rows.length > 0;
  const live = s.terminals.filter((t) => !t.exited).length;
  const c = $('terminalsCount');
  c.textContent = String(s.terminals.length);
  c.title = `${live} running`;
  c.className = `count${live ? ' hot' : ''}`;
}

function renderScreen(s) {
  const n = s.screen?.streams ?? 0;
  const big = $('screenStreams');
  big.textContent = String(n);
  big.className = n ? 'live' : '';
  $('screenLabel').textContent = n === 1 ? 'active stream' : 'active streams';
}

function renderLog() {
  const box = $('log');
  const all = status?.log ?? [];
  const counts = { ALL: all.length, INFO: 0, WARN: 0, ERROR: 0 };
  for (const l of all) if (counts[l.level] !== undefined) counts[l.level] += 1;
  for (const b of $('levelSeg').querySelectorAll('button')) {
    b.querySelector('span').textContent = String(counts[b.dataset.level] ?? 0);
    b.classList.toggle('on', b.dataset.level === logView.level);
  }
  const last = all[all.length - 1];
  const key = `${all.length}|${last?.at}|${last?.msg}|${logView.level}|${logView.query}`;
  if (key === logView.key) return;
  logView.key = key;
  const q = logView.query.toLowerCase();
  const shown = all.filter(
    (l) => (logView.level === 'ALL' || l.level === logView.level) && (!q || `${l.scope} ${l.msg}`.toLowerCase().includes(q)),
  );
  const frag = document.createDocumentFragment();
  for (const l of shown) {
    frag.append(
      el(
        'div',
        `ln ${l.level}`,
        el('span', { class: 't', title: new Date(l.at).toString() }, fmtClock(l.at)),
        el('span', `lv ${l.level}`, l.level),
        el('span', { class: 'sc', title: l.scope }, l.scope),
        el('span', 'm', l.msg),
      ),
    );
  }
  if (!shown.length) frag.append(el('div', 'none', all.length ? 'No lines match the filter.' : 'No log lines yet.'));
  box.replaceChildren(frag);
  if (logView.follow) box.scrollTop = box.scrollHeight;
}

function render() {
  renderPulse();
  renderBanner();
  if (status) {
    renderAgent(status);
    renderPublic(status);
    renderHelper(status);
    renderPtyHost(status);
    renderSecurity(status);
    renderPhones(status);
    renderVscode(status);
    renderTerminals(status);
    renderScreen(status);
    renderLog();
  } else if (failing) {
    setTag($('agentTag'), 'unreachable', 'err');
  }
}

// ------------------------------------------------------------------------------------------------
// Polling
// ------------------------------------------------------------------------------------------------

async function poll() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch('/status', { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    if (!s || s.ok !== true) throw new Error('unexpected answer');
    status = s;
    lastOkAt = Date.now();
    failing = false;
    failCount = 0;
    lastError = '';
  } catch (err) {
    failing = true;
    failCount += 1;
    lastError = err?.name === 'TimeoutError' ? 'timed out' : err?.message === 'Failed to fetch' ? 'connection refused' : err?.message || 'error';
  }
  render();
  if (!paused) pollTimer = setTimeout(poll, POLL_MS);
}

// ------------------------------------------------------------------------------------------------
// Self-test
// ------------------------------------------------------------------------------------------------

function renderSteps(steps, running) {
  const items = steps.map((st) =>
    el(
      'li',
      st.ok ? 'pass' : 'fail',
      el('span', 'mark', st.ok ? '✓' : '✗'),
      el('span', 'sname', st.name),
      el('span', 'sms', `${st.ms} ms`),
      st.detail ? el('span', 'sdetail', st.detail) : null,
    ),
  );
  if (running) items.push(el('li', 'run', el('span', 'mark'), el('span', 'sname', 'Running checks… (up to 15 s)'), el('span', 'sms', '')));
  $('selftestSteps').replaceChildren(...items);
}

async function runSelftest() {
  if (selftestBusy) return;
  selftestBusy = true;
  const btn = $('selftestBtn');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Testing…';
  setTag($('selftestTag'), 'running', 'info');
  $('selftestHint').hidden = true;
  $('selftestMeta').textContent = '';
  renderSteps([], true);
  const t0 = Date.now();
  try {
    const res = await fetch('/status/selftest', {
      method: 'POST',
      headers: { 'X-TermPocket-Monitor': '1' },
      cache: 'no-store',
      signal: AbortSignal.timeout(SELFTEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    const steps = Array.isArray(r.steps) ? r.steps : [];
    lastSelftest = { ok: !!r.ok, steps, at: Date.now() };
    renderSteps(steps, false);
    setTag($('selftestTag'), r.ok ? 'passed' : 'failed', r.ok ? 'ok' : 'err');
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? 'no answer from the agent' : err?.message === 'Failed to fetch' ? 'agent unreachable' : err?.message;
    lastSelftest = { ok: false, steps: [{ name: 'Reach the agent', ok: false, ms: Date.now() - t0, detail: msg }], at: Date.now() };
    renderSteps(lastSelftest.steps, false);
    setTag($('selftestTag'), 'failed', 'err');
  } finally {
    $('selftestMeta').textContent = `Ran at ${fmtClock(Date.now())} · took ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    btn.disabled = failing;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Run self-test';
    selftestBusy = false;
    renderBanner();
  }
}

// ------------------------------------------------------------------------------------------------
// Wiring
// ------------------------------------------------------------------------------------------------

function init() {
  $('selftestBtn').addEventListener('click', runSelftest);
  $('pauseBtn').addEventListener('click', () => {
    paused = !paused;
    $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
    if (paused) clearTimeout(pollTimer);
    else poll();
    renderPulse();
  });
  $('levelSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b) return;
    logView.level = b.dataset.level;
    renderLog();
  });
  $('logSearch').addEventListener('input', (e) => {
    logView.query = e.target.value.trim();
    renderLog();
  });
  $('logFollow').addEventListener('change', (e) => {
    logView.follow = e.target.checked;
    if (logView.follow) $('log').scrollTop = $('log').scrollHeight;
  });
  $('log').addEventListener('scroll', () => {
    const box = $('log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (atBottom !== logView.follow) {
      logView.follow = atBottom;
      $('logFollow').checked = atBottom;
    }
  });
  // Poll right away when the tab comes back (timers are throttled in background tabs).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !paused) poll();
  });
  setFavicon('unknown');
  poll();
}

init();
