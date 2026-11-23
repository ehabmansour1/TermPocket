// Pairing: token capture from the URL (#token=…), storage, and the pairing screen.

import { h, btn } from './ui.js';
import { icon } from './icons.js';

const TOKEN_KEY = 'termpocket.token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/**
 * If the page was opened with a pairing link (…/#token=XYZ), store the token and
 * strip it from the address bar so it doesn't linger in history/screenshots.
 * @returns {boolean} true when a token was captured
 */
export function captureTokenFromHash() {
  const hash = location.hash || '';
  const m = /(?:^#|[&?])token=([^&]+)/.exec(hash);
  if (!m) return false;
  let token = '';
  try { token = decodeURIComponent(m[1]).trim(); } catch { token = m[1].trim(); }
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch { /* ignore */ }
  if (!token) return false;
  setToken(token);
  return true;
}

/**
 * Accepts a raw token or a full pairing link and returns the token (or null).
 */
export function parseTokenInput(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /[#&?]token=([^&\s]+)/.exec(s);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  if (/\s/.test(s)) return null;
  return s;
}

let current = null;

/**
 * Show the full-screen pairing screen.
 * @param {{ error?: string, onPaired: (token: string) => void }} opts
 * @returns {{ close(): void }}
 */
export function showPairScreen({ error, onPaired }) {
  if (current) current.close();
  const input = h('input', {
    class: 'input mono', type: 'text', placeholder: 'Paste pairing link or token',
    autocomplete: 'off', spellcheck: false, autocapitalize: 'off', enterKeyHint: 'go',
    'aria-label': 'Pairing link or token',
  });
  const errEl = h('div', { class: 'pair-error', role: 'alert', hidden: !error }, error || '');
  const submit = () => {
    const token = parseTokenInput(input.value);
    if (!token) {
      errEl.hidden = false;
      errEl.textContent = 'That doesn’t look like a pairing link or token.';
      input.focus();
      return;
    }
    setToken(token);
    api.close();
    onPaired(token);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  const host = location.host || 'this PC';
  const el = h('div', { class: 'pair-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pair-title' },
    h('div', { class: 'pair-inner' },
      h('div', { class: 'pair-logo', 'aria-hidden': 'true' }, h('span', { class: 'pair-prompt' }, '>'), h('span', { class: 'pair-cursor' }, '_')),
      h('h1', { id: 'pair-title', class: 'pair-title' }, 'Pair with your PC'),
      h('p', { class: 'pair-lead' }, 'TermPocket drives your terminals, VS Code and desktop from this phone. It needs the one-time pairing token from the agent.'),
      h('ol', { class: 'pair-steps' },
        h('li', null, h('span', { class: 'step-n' }, '1'), h('div', null,
          h('b', null, 'Start the agent on the PC'),
          h('code', { class: 'pair-code' }, 'cd agent && npm start'))),
        h('li', null, h('span', { class: 'step-n' }, '2'), h('div', null,
          h('b', null, 'Scan the QR code it prints'),
          h('span', { class: 'pair-sub' }, 'or open ', h('code', null, 'http://localhost:8765/pair'), ' on the PC and scan that.'))),
        h('li', null, h('span', { class: 'step-n' }, '3'), h('div', null,
          h('b', null, 'Or paste the link here'),
          h('span', { class: 'pair-sub' }, 'Everything after ', h('code', null, '#token='), ' works too.')))),
      h('div', { class: 'pair-form' },
        input,
        btn('Connect', { variant: 'primary', iconName: 'link', onClick: submit, cls: 'pair-go' })),
      errEl,
      h('div', { class: 'pair-foot' }, icon('lock', { size: 14 }),
        h('span', null, 'Token is stored only on this device · ', h('span', { class: 'mono' }, host)))));

  document.body.append(el);
  document.body.classList.add('pairing');
  requestAnimationFrame(() => el.classList.add('in'));
  const api = {
    close() {
      if (current !== api) return;
      current = null;
      document.body.classList.remove('pairing');
      el.remove();
    },
  };
  current = api;
  return api;
}

export function isPairScreenOpen() {
  return current != null;
}
