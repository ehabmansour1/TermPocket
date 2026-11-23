// Shared terminal input chrome (PROTOCOL §6): the extra-keys row with sticky Ctrl/Alt and the
// "command line" box. Used by the agent-PTY view (termview.js) and the live view of ordinary
// VS Code terminals (vsterm.js) — both only differ in where the bytes go.

import { h, iconBtn, store, toast, actionSheet, noFocusSteal, edgeFade, haptic } from './ui.js';
import { icon } from './icons.js';

const HISTORY_KEY = 'cmdHistory';

// Extra-keys row (PROTOCOL §6) + paste & keyboard helpers at the end.
export const XKEYS = [
  { k: 'esc', label: 'Esc' },
  { k: 'tab', label: 'Tab' },
  { k: 'ctrl', label: 'Ctrl', mod: true },
  { k: 'alt', label: 'Alt', mod: true },
  { k: 'up', label: '↑', repeat: true, aria: 'Up' },
  { k: 'down', label: '↓', repeat: true, aria: 'Down' },
  { k: 'left', label: '←', repeat: true, aria: 'Left' },
  { k: 'right', label: '→', repeat: true, aria: 'Right' },
  { k: 'home', label: 'Home' },
  { k: 'end', label: 'End' },
  { k: 'pgup', label: 'PgUp', repeat: true },
  { k: 'pgdn', label: 'PgDn', repeat: true },
  { ch: '|' }, { ch: '~' }, { ch: '/' }, { ch: '-' },
  { k: 'ctrlc', label: '^C', cls: 'hot', aria: 'Control C (interrupt)' },
  { k: 'paste', iconName: 'paste', aria: 'Paste' },
  { k: 'kbd', iconName: 'keyboard', aria: 'Show keyboard' },
];

/** Ctrl+<ch> → control character (or null if there is no mapping). */
export function ctrlChar(ch) {
  if (!ch) return null;
  if (ch >= 'a' && ch <= 'z') return String.fromCharCode(ch.charCodeAt(0) - 96);
  if (ch >= 'A' && ch <= 'Z') return String.fromCharCode(ch.charCodeAt(0) - 64);
  const map = {
    '@': 0, ' ': 0, '2': 0, '[': 27, '3': 27, '\\': 28, '4': 28, ']': 29, '5': 29,
    '^': 30, '6': 30, '_': 31, '-': 31, '7': 31, '?': 127, '8': 127, '/': 31,
  };
  return ch in map ? String.fromCharCode(map[ch]) : null;
}

/**
 * Extra-keys row. Sticky modifiers: tap = next key only, tap again = lock, third tap = off.
 * @param {{ send: (d: string) => void, getTerm: () => any, paste: () => void, focus: () => void }} opts
 *   getTerm() → the xterm instance (or null) — used for application-cursor-keys mode.
 * @returns {{ el: HTMLElement, applyMods: (d: string) => string }}
 *   applyMods() turns typed data into Ctrl/Alt combos while a modifier is armed (wire it into
 *   xterm's onData).
 */
export function createKeyBar({ send, getTerm, paste, focus }) {
  const mods = { ctrl: 0, alt: 0 }; // 0 off · 1 one-shot · 2 locked
  const modButtons = {};
  const el = h('div', { class: 'xkeys', role: 'toolbar', 'aria-label': 'Extra keys' }, XKEYS.map((def) => makeKey(def)));
  edgeFade(el);

  function applyMods(d) {
    if (!d || (!mods.ctrl && !mods.alt)) return d;
    let out = d;
    if (mods.ctrl) {
      const c = ctrlChar(d[0]);
      if (c != null) out = c + d.slice(1);
    }
    if (mods.alt) out = '\x1b' + out;
    consumeMods();
    return out;
  }

  function modParam() { return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0); }

  function cursorSeq(letter) {
    const m = modParam();
    consumeMods();
    if (m !== 1) return `\x1b[1;${m}${letter}`;
    const term = getTerm && getTerm();
    const app = term && term.modes && term.modes.applicationCursorKeysMode;
    return (app ? '\x1bO' : '\x1b[') + letter;
  }

  function tildeSeq(n) {
    const m = modParam();
    consumeMods();
    return m === 1 ? `\x1b[${n}~` : `\x1b[${n};${m}~`;
  }

  function withAlt(s) {
    const alt = !!mods.alt;
    consumeMods();
    return alt ? '\x1b' + s : s;
  }

  function cycleMod(name) {
    mods[name] = (mods[name] + 1) % 3;
    renderMods();
  }

  function consumeMods() {
    let changed = false;
    for (const k of Object.keys(mods)) if (mods[k] === 1) { mods[k] = 0; changed = true; }
    if (changed) renderMods();
  }

  function renderMods() {
    for (const [k, b] of Object.entries(modButtons)) {
      b.classList.toggle('once', mods[k] === 1);
      b.classList.toggle('locked', mods[k] === 2);
      b.setAttribute('aria-pressed', String(mods[k] > 0));
    }
  }

  function press(def) {
    haptic(4);
    if (def.ch) { send(applyMods(def.ch)); return; }
    switch (def.k) {
      case 'ctrl': case 'alt': cycleMod(def.k); return;
      case 'esc': send(withAlt('\x1b')); break;
      case 'tab': send(withAlt('\t')); break;
      case 'up': send(cursorSeq('A')); break;
      case 'down': send(cursorSeq('B')); break;
      case 'right': send(cursorSeq('C')); break;
      case 'left': send(cursorSeq('D')); break;
      case 'home': send(cursorSeq('H')); break;
      case 'end': send(cursorSeq('F')); break;
      case 'pgup': send(tildeSeq(5)); break;
      case 'pgdn': send(tildeSeq(6)); break;
      case 'ctrlc': consumeMods(); send('\x03'); break;
      case 'paste': paste(); break;
      case 'kbd': focus(); break;
      default: break;
    }
  }

  function makeKey(def) {
    const b = h('button', {
      type: 'button', class: ['xkey', def.mod && 'mod', def.cls, def.iconName && 'ico-key'],
      'aria-label': def.aria || def.label || def.ch,
    }, def.iconName ? icon(def.iconName, { size: 18 }) : (def.label || def.ch));
    noFocusSteal(b);
    if (def.mod) modButtons[def.k] = b;
    let repeatTimer = 0;
    let repeatInt = 0;
    let repeated = false;
    let sx = 0;
    let sy = 0;
    const stop = () => { clearTimeout(repeatTimer); clearInterval(repeatInt); repeatTimer = repeatInt = 0; };
    b.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY; repeated = false;
      if (def.repeat) {
        repeatTimer = setTimeout(() => {
          repeated = true;
          press(def);
          repeatInt = setInterval(() => press(def), 70);
        }, 420);
      }
    });
    b.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) stop(); });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('click', () => {
      if (repeated) { repeated = false; return; }
      press(def);
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  return { el, applyMods };
}

/**
 * "Command line" box: type → Send. submit(text) returns true when the text was sent (the box is
 * cleared and the command remembered in the shared recent-commands list), false to keep it.
 * @returns {{ form: HTMLFormElement, input: HTMLInputElement }}
 */
export function createCmdLine({ submit, placeholder = 'Type a command…', hidden = false }) {
  const input = h('input', {
    class: 'input mono cmd-input', type: 'text', placeholder,
    autocomplete: 'off', spellcheck: false, autocapitalize: 'off', enterKeyHint: 'send',
    'aria-label': 'Command line',
  });
  const form = h('form', { class: 'cmdline', hidden, onSubmit: (e) => { e.preventDefault(); go(); } },
    iconBtn('history', 'Command history', () => showHistory(), { cls: 'cmd-hist', keepFocus: true }),
    input,
    h('button', { type: 'submit', class: 'btn primary cmd-send', 'aria-label': 'Send command' }, icon('send', { size: 18 })));

  function go() {
    const text = input.value;
    if (!submit(text)) return;
    if (text.trim()) {
      const hist = store.get(HISTORY_KEY, []).filter((x) => x !== text);
      hist.unshift(text);
      store.set(HISTORY_KEY, hist.slice(0, 40));
    }
    input.value = '';
  }

  function showHistory() {
    const hist = store.get(HISTORY_KEY, []);
    if (!hist.length) { toast('No commands sent yet'); return; }
    actionSheet({
      title: 'Recent commands',
      actions: hist.map((cmd) => ({
        label: cmd, iconName: 'terminal',
        onSelect: () => { input.value = cmd; input.focus(); },
      })),
    });
  }

  return { form, input };
}
