// Desktop workbench — shared building blocks (builder B): real VS Code codicons (the glyph font that
// ships inside Monaco's editor.main.css), Seti-style file icons, a VS Code context menu, modal
// dialog, notifications, inline input box, quick pick and key-combo helpers.
//
// Security: remote strings (file names, paths, messages) only ever go through textContent (h()
// children). SVG markup in this file is static and trusted; it never contains remote data.

import { h, setChildren, clamp, basename } from '../ui.js';

/* ----------------------------------------------------------------------------- stylesheet */

const linked = new Set();
/** Add a stylesheet link once (resolved against this module). */
export function linkCss(rel) {
  const href = new URL(rel, import.meta.url).href;
  if (linked.has(href)) return;
  linked.add(href);
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
  document.head.append(h('link', { rel: 'stylesheet', href }));
}

/** Monaco's stylesheet (also defines the `codicon` @font-face the workbench uses for its icons). */
export const MONACO_BASE = new URL('../../vendor/monaco/vs', import.meta.url).href;
export function linkMonacoCss() {
  const href = `${MONACO_BASE}/editor/editor.main.css`;
  if (linked.has(href)) return;
  linked.add(href);
  document.head.append(h('link', { rel: 'stylesheet', href, 'data-name': 'vs/editor/editor.main' }));
}

/* ------------------------------------------------------------------------------- codicons */

// Code points of the codicon font bundled with Monaco 0.57 (read from the font's own glyph names).
const CODICONS = {
  files: 0xeaf0, search: 0xea6d, 'source-control': 0xea68, 'git-branch': 0xea68, extensions: 0xeae6,
  'debug-alt': 0xeb91, 'chevron-right': 0xeab6, 'chevron-down': 0xeab4, 'chevron-up': 0xeab7,
  'chevron-left': 0xeab5, close: 0xea76, ellipsis: 0xea7c, 'new-file': 0xea7f, 'new-folder': 0xea80,
  refresh: 0xeb37, 'collapse-all': 0xeac5, error: 0xea87, warning: 0xea6c, info: 0xea74, bell: 0xeaa2,
  'bell-dot': 0xeb9a, remote: 0xeb3a, 'layout-sidebar-left': 0xebf3, 'layout-sidebar-left-off': 0xec02,
  'layout-panel': 0xebf2, 'layout-panel-off': 0xec01, 'layout-sidebar-right': 0xebf4,
  'layout-sidebar-right-off': 0xec00, layout: 0xebeb, 'arrow-left': 0xea9b, 'arrow-right': 0xea9c,
  'circle-filled': 0xea71, 'primitive-dot': 0xea71, 'settings-gear': 0xeb51, account: 0xeb99,
  terminal: 0xea85, add: 0xea60, trash: 0xea81, 'go-to-file': 0xea94, 'clear-all': 0xeabf,
  'split-horizontal': 0xeb56, 'close-all': 0xeac1, 'save-all': 0xeb49, sync: 0xea77, check: 0xeab2,
  copy: 0xebcc, 'link-external': 0xeb14, folder: 0xea83, 'folder-opened': 0xeaf7, file: 0xea7b,
  'kebab-vertical': 0xeb10, 'git-compare': 0xeafd, discard: 0xeae2, edit: 0xea73, pin: 0xeb2b,
  pinned: 0xeba0, 'screen-full': 0xeb4c, 'word-wrap': 0xeb80, 'open-preview': 0xeb28, window: 0xeaae,
  home: 0xeb06, 'file-media': 0xeaea, 'file-zip': 0xeaef, 'file-binary': 0xeae8, 'file-code': 0xeae9,
  'file-symlink-file': 0xeaee, 'file-symlink-directory': 0xeaed, 'git-commit': 0xeafc, eye: 0xea70,
  'eye-closed': 0xeae7, link: 0xeb15, 'chrome-maximize': 0xeab9, 'chrome-restore': 0xeabb,
  'loading': 0xeb19, 'circle-large-outline': 0xebb5, 'list-tree': 0xeb86, 'list-flat': 0xeb84,
  menu: 0xeb94, 'debug-disconnect': 0xead0, vm: 0xea7a, 'lock': 0xea75, 'go-to-search': 0xec32, 'arrow-up': 0xeaa1,
  'arrow-down': 0xea9a, filter: 0xeaf1, 'run-all': 0xeb9e, 'cloud-upload': 0xeb9f,
};

/** VS Code codicon as a <span class="codicon"> (needs Monaco's CSS for the font). */
export function ci(name, { cls = '', title } = {}) {
  const cp = CODICONS[name];
  // Own class names (not .codicon-*): Monaco injects `.codicon-<name>:before` rules that would draw a second glyph.
  const el = h('span', { class: ['wb-ci', `wb-ci-${name}`, cls], 'aria-hidden': 'true', title: title || null });
  if (cp) el.textContent = String.fromCodePoint(cp);
  return el;
}
export const hasCodicon = (name) => name in CODICONS;

/** "$(icon) text" → nodes (VS Code label syntax used by status bar / quick input labels). */
export function iconText(text) {
  const out = [];
  const s = String(text ?? '');
  const re = /\$\(([a-z0-9-]+)(~spin)?\)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (hasCodicon(m[1])) out.push(ci(m[1], { cls: m[2] ? 'wb-ci-spin' : '' }));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/* ----------------------------------------------------------------------------- file icons */

// Seti (VS Code's default file icon theme) colours.
const SETI = {
  blue: '#519aba', grey: '#4d5a5e', greyLight: '#6d8086', green: '#8dc149', orange: '#e37933',
  pink: '#f55385', purple: '#a074c4', red: '#cc3e44', white: '#d4d7d6', yellow: '#cbcb41', ignore: '#41535b',
};

// Glyph drawings in a 16×16 box. Letters use the UI font; shapes are paths.
const SVG_NS = 'http://www.w3.org/2000/svg';
const T = (txt, size = 7.6, y = 11.2, weight = 700, spacing = 0) =>
  `<text x="8" y="${y}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="currentColor">${txt}</text>`;
const GLYPH = {
  js: T('JS', 7.4),
  ts: T('TS', 7.4),
  jsx: '<circle cx="8" cy="8" r="1.4" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1"><ellipse cx="8" cy="8" rx="6.6" ry="2.6"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)"/></g>',
  json: T('{ }', 9, 11.4, 700),
  md: '<path fill="currentColor" d="M1.5 4h13a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5zm1.4 6.4h1.3V7.6l1.2 1.6 1.2-1.6v2.8h1.3V5.6H6.6L5.4 7.2 4.2 5.6H2.9zm8.1 0 2-2.4h-1.3V5.6h-1.4V8H9z"/>',
  html: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  css: T('#', 12, 12.6, 700),
  py: '<path fill="currentColor" d="M7.9 1.5c-3.3 0-3.1 1.4-3.1 1.4v1.5h3.2v.5H3.6S1.5 4.7 1.5 8c0 3.3 1.8 3.2 1.8 3.2h1.1V9.6s-.1-1.8 1.8-1.8h3.1s1.7 0 1.7-1.7V3.3S11.3 1.5 7.9 1.5zM6.2 2.5a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2z"/><path fill="currentColor" opacity=".75" d="M8.1 14.5c3.3 0 3.1-1.4 3.1-1.4v-1.5H8v-.5h4.4s2.1.2 2.1-3.1c0-3.3-1.8-3.2-1.8-3.2h-1.1v1.6s.1 1.8-1.8 1.8H6.7S5 8.2 5 9.9v2.8s-.3 1.8 3.1 1.8zm1.7-1a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2z"/>',
  php: '<ellipse cx="8" cy="8" rx="7" ry="4.4" fill="currentColor"/>' + '<text x="8" y="10.1" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="5.6" font-weight="800" fill="#1f1f1f">php</text>',
  db: '<g fill="currentColor"><ellipse cx="8" cy="3.6" rx="5.5" ry="2"/><path d="M2.5 5v2.6c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2z"/><path d="M2.5 9.4V12c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V9.4c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2z"/></g>',
  shell: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m2.5 4.5 3.5 3.5-3.5 3.5M7.5 12h6"/>',
  pwsh: '<path fill="currentColor" d="M2.6 2.5h11.8c.5 0 .8.4.7.9l-1.9 9.3c-.1.5-.5.8-1 .8H.9c-.5 0-.8-.4-.7-.9L2.1 3.3c.1-.5.5-.8 1-.8z"/><path fill="none" stroke="#1f1f1f" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="m4.2 5.3 3 2.6-3.8 2.7M7.8 10.6h3"/>',
  yaml: T('!', 12, 12.8, 800),
  gear: '<path fill="currentColor" d="M8 5.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4zm6.3 3.6-1.4.4-.4 1 .7 1.3-1.3 1.3-1.3-.7-1 .4-.4 1.4H7.2l-.4-1.4-1-.4-1.3.7-1.3-1.3.7-1.3-.4-1-1.4-.4V7.1l1.4-.4.4-1-.7-1.3 1.3-1.3 1.3.7 1-.4.4-1.4h1.8l.4 1.4 1 .4 1.3-.7 1.3 1.3-.7 1.3.4 1 1.4.4z"/>',
  git: '<path fill="currentColor" d="M14.7 7.3 8.7 1.3a1 1 0 0 0-1.4 0L6 2.6l1.6 1.6a1.2 1.2 0 0 1 1.5 1.5l1.6 1.6a1.2 1.2 0 1 1-.7.7L8.5 6.5v4a1.2 1.2 0 1 1-1-.1V6.3a1.2 1.2 0 0 1-.6-1.6L5.3 3.1 1.3 7.3a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0l6-6a1 1 0 0 0 0-1.4z"/>',
  image: '<path fill="currentColor" d="M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.5 8.5h11L10 7l-2.6 3.2L5.6 8.4zM5 6.8a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z"/>',
  xml: '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5 4.5 1.8 8 5 11.5M11 4.5 14.2 8 11 11.5M9.3 3.5l-2.6 9"/>',
  text: '<path fill="currentColor" d="M2.5 4h11v1.3h-11zm0 3h11v1.3h-11zm0 3h7.5v1.3H2.5z"/>',
  lock: '<path fill="currentColor" d="M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7h.8c.4 0 .7.3.7.7v6c0 .4-.3.8-.7.8H3.7c-.4 0-.7-.4-.7-.8v-6c0-.4.3-.7.7-.7zm1.5 0h4V5.2a2 2 0 0 0-4 0z"/>',
  zip: '<path fill="currentColor" d="M3 1.5h10v13H3zm4 1v1h1v-1zm1 1v1h1v-1zm-1 1v1h1v-1zm1 1v1h1v-1zm-1 1v1h1v-1zm0 2v2.5h2V8.5z"/>',
  cs: T('C#', 7.2),
  c: T('C', 10, 12),
  cpp: T('C++', 6.2),
  go: T('GO', 7),
  rs: T('RS', 7),
  java: '<path fill="currentColor" d="M6.3 11.6s-.6.4.4.5c1.3.1 1.9.1 3.3-.1 0 0 .4.2.9.4-3.1 1.3-7-.1-4.6-.8zm-.4-1.7s-.7.5.4.6c1.4.1 2.5.2 4.4-.2 0 0 .3.3.7.4-3.9 1.1-8.2.1-5.5-.8zM9.2 6.9c.8.9-.2 1.7-.2 1.7s2-1 1.1-2.3c-.9-1.2-1.5-1.8 2.1-3.9 0 0-5.7 1.4-3 4.5zm3.3 5.6s.5.4-.5.7c-1.8.5-7.6.7-9.2 0-.6-.2.5-.6.8-.6h.5c-.6-.4-4 .9-1.7 1.2 6.2 1 11.3-.4 10.1-1.3zM6.9 8.3s-2.9.7-1 .9c.8.1 2.3.1 3.8 0 1.2-.1 2.4-.3 2.4-.3l-.7.4c-2.9.8-8.5.4-6.9-.4 1.4-.6 2.4-.6 2.4-.6zm5.2 2.9c3-1.6 1.6-3 .6-2.8l-.3.1s.1-.1.3-.2c1.9-.7 3.4 2-.6 3.1zM9.9 1s1.6 1.6-1.6 4.1C5.8 7.1 7.7 8.2 8.3 9.5 6.8 8.1 5.7 6.9 6.5 5.8 7.6 4.1 10.6 3.3 9.9 1z"/>',
  docker: '<path fill="currentColor" d="M15 7.3c-.4-.3-1.2-.4-1.8-.3-.1-.6-.4-1.1-.9-1.5l-.3-.2-.2.3c-.3.4-.4 1.1-.4 1.6 0 .4.1.8.3 1.1-.4.2-1 .3-1.6.3H1.1l-.1.3c-.1 1.1.1 2.3.6 3.3.5.9 1.3 1.6 2.3 1.9 1.1.4 2.8.5 4.6.2 1.4-.3 2.6-.8 3.6-1.6.8-.7 1.5-1.6 1.9-2.6h.2c.8 0 1.3-.3 1.6-.6l.2-.4zM2.4 7.9h1.3V6.6H2.4zm1.6 0h1.3V6.6H4zm1.7 0H7V6.6H5.7zm1.6 0h1.3V6.6H7.3zm-3.3-1.6h1.3V5H4zm1.7 0H7V5H5.7zm1.6 0h1.3V5H7.3zm0-1.7h1.3V3.3H7.3zm1.7 3.3h1.3V6.6H9z"/>',
  lockfile: '<path fill="currentColor" d="M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7h.8c.4 0 .7.3.7.7v6c0 .4-.3.8-.7.8H3.7c-.4 0-.7-.4-.7-.8v-6c0-.4.3-.7.7-.7zm1.5 0h4V5.2a2 2 0 0 0-4 0z"/>',
  npm: '<path fill="currentColor" d="M1 5h14v5H8v1H5v-1H1zm1 1v3h2V7h1v2h1V6zm5 0v4h2V9h2V6zm2 1h1v1H9zm3-1v3h1V7h1v2h1V6z"/>',
  vsix: '<path fill="currentColor" d="M11.2 1.6 6 6.4 2.9 4.1 1.6 4.8v6.4l1.3.7L6 9.6l5.2 4.8 3.2-1.4V3zM3.1 9.8V6.2L5 8zm8.1 1.2L7.9 8l3.3-3z"/>',
  bat: '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2 3.5h12v9H2zM4.2 6.4l2 1.6-2 1.6M7.6 9.8h3.6"/>',
  license: '<path fill="currentColor" d="M3 1.5h7l3 3v10H3zm2 4v1h6v-1zm0 2.5v1h6V8zm0 2.5v1h4v-1z"/>',
  default: '<path fill="currentColor" d="M3.5 4h9v1.2h-9zm0 2.7h9v1.2h-9zm0 2.7h9v1.2h-9z"/>',
  folder: '<path fill="currentColor" d="M1.5 3.5h4.6l1.5 1.5h6.9c.3 0 .5.2.5.5v7.5c0 .3-.2.5-.5.5h-13c-.3 0-.5-.2-.5-.5v-9c0-.3.2-.5.5-.5z"/>',
  folderOpen: '<path fill="currentColor" d="M1.5 3.5h4.6l1.5 1.5h5.9c.3 0 .5.2.5.5V7H4.3c-.4 0-.7.2-.9.6L1 12.3V4c0-.3.2-.5.5-.5zM4.5 8h10.8c.4 0 .6.4.4.7l-2.3 4.5c-.1.2-.3.3-.5.3H1.6c-.4 0-.6-.4-.4-.7l2.8-4.5c.1-.2.3-.3.5-.3z"/>',
};

const BY_NAME = new Map([
  ['package.json', ['npm', SETI.red]], ['package-lock.json', ['npm', SETI.red]],
  ['.gitignore', ['git', SETI.ignore]], ['.gitattributes', ['git', SETI.ignore]], ['.gitmodules', ['git', SETI.ignore]],
  ['.gitkeep', ['git', SETI.ignore]], ['.npmignore', ['npm', SETI.ignore]], ['.editorconfig', ['gear', SETI.greyLight]],
  ['dockerfile', ['docker', SETI.blue]], ['license', ['license', SETI.yellow]], ['license.md', ['license', SETI.yellow]],
  ['license.txt', ['license', SETI.yellow]], ['yarn.lock', ['lockfile', SETI.greyLight]], ['.env', ['gear', SETI.greyLight]],
  ['tsconfig.json', ['json', SETI.blue]], ['jsconfig.json', ['json', SETI.yellow]], ['makefile', ['gear', SETI.orange]],
]);
const BY_EXT = new Map(Object.entries({
  js: ['js', SETI.yellow], mjs: ['js', SETI.yellow], cjs: ['js', SETI.yellow], ts: ['ts', SETI.blue],
  mts: ['ts', SETI.blue], cts: ['ts', SETI.blue], jsx: ['jsx', SETI.blue], tsx: ['jsx', SETI.blue],
  json: ['json', SETI.yellow], jsonc: ['json', SETI.yellow], json5: ['json', SETI.yellow], webmanifest: ['json', SETI.yellow],
  md: ['md', SETI.blue], markdown: ['md', SETI.blue], html: ['html', SETI.orange], htm: ['html', SETI.orange],
  css: ['css', SETI.blue], scss: ['css', SETI.pink], sass: ['css', SETI.pink], less: ['css', SETI.blue],
  py: ['py', SETI.blue], pyw: ['py', SETI.blue], php: ['php', SETI.purple], sql: ['db', SETI.pink],
  ps1: ['pwsh', SETI.blue], psm1: ['pwsh', SETI.blue], psd1: ['pwsh', SETI.blue], sh: ['shell', SETI.green],
  bash: ['shell', SETI.green], zsh: ['shell', SETI.green], cmd: ['bat', SETI.green], bat: ['bat', SETI.green],
  yml: ['yaml', SETI.purple], yaml: ['yaml', SETI.purple], env: ['gear', SETI.greyLight], ini: ['gear', SETI.greyLight],
  toml: ['gear', SETI.greyLight], cfg: ['gear', SETI.greyLight], conf: ['gear', SETI.greyLight],
  png: ['image', SETI.purple], jpg: ['image', SETI.purple], jpeg: ['image', SETI.purple], gif: ['image', SETI.purple],
  svg: ['image', SETI.purple], ico: ['image', SETI.purple], webp: ['image', SETI.purple], bmp: ['image', SETI.purple],
  xml: ['xml', SETI.orange], xaml: ['xml', SETI.orange], csproj: ['xml', SETI.orange], props: ['xml', SETI.orange],
  cs: ['cs', SETI.blue], c: ['c', SETI.blue], h: ['c', SETI.purple], cpp: ['cpp', SETI.blue], hpp: ['cpp', SETI.purple],
  cc: ['cpp', SETI.blue], go: ['go', SETI.blue], rs: ['rs', SETI.greyLight], java: ['java', SETI.red],
  jar: ['java', SETI.red], lock: ['lockfile', SETI.greyLight], log: ['text', SETI.greyLight], txt: ['text', SETI.white],
  zip: ['zip', SETI.greyLight], '7z': ['zip', SETI.greyLight], gz: ['zip', SETI.greyLight], tar: ['zip', SETI.greyLight],
  vsix: ['vsix', SETI.blue], pem: ['lock', SETI.greyLight], key: ['lock', SETI.greyLight], vue: ['html', SETI.green],
}));

const glyphCache = new Map();
function glyphSvg(kind) {
  let tpl = glyphCache.get(kind);
  if (!tpl) {
    tpl = document.createElementNS(SVG_NS, 'svg');
    tpl.setAttribute('viewBox', '0 0 16 16');
    tpl.setAttribute('width', '16');
    tpl.setAttribute('height', '16');
    tpl.setAttribute('aria-hidden', 'true');
    tpl.setAttribute('focusable', 'false');
    tpl.innerHTML = GLYPH[kind] || GLYPH.default; // static, trusted
    glyphCache.set(kind, tpl);
  }
  return tpl.cloneNode(true);
}

/** [glyph kind, colour] for a file name. */
export function fileKind(name) {
  const base = basename(String(name || '')).toLowerCase();
  if (BY_NAME.has(base)) return BY_NAME.get(base);
  if (/^\.env(\..+)?$/.test(base)) return ['gear', SETI.greyLight];
  if (/^dockerfile/.test(base)) return ['docker', SETI.blue];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : '';
  if (BY_EXT.has(ext)) return BY_EXT.get(ext);
  return ['default', SETI.white];
}

/** Seti-style file icon (16×16) — `{dir, open}` for folders. */
export function fileIcon(name, { dir = false, open = false } = {}) {
  if (dir) {
    return h('span', { class: ['wb-fi', 'dir', open && 'open'], 'aria-hidden': 'true' }, glyphSvg(open ? 'folderOpen' : 'folder'));
  }
  const [kind, color] = fileKind(name);
  return h('span', { class: ['wb-fi', `k-${kind}`], 'aria-hidden': 'true', style: { color } }, glyphSvg(kind));
}

/* ------------------------------------------------------------------------- key combos */

const CODE_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
const KEY_ALIASES = {
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', esc: 'escape', del: 'delete',
  ' ': 'space', spacebar: 'space', return: 'enter', pgup: 'pageup', pgdn: 'pagedown', cmd: 'meta',
  control: 'ctrl', option: 'alt', win: 'meta',
};

/** 'Ctrl+Shift+P' → 'ctrl+shift+p' (modifiers in a fixed order). */
export function normCombo(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim());
  // "Ctrl++" style (plus key) — keep a trailing empty part as '+'
  const keys = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1) keys.push('+');
    else if (parts[i] !== '') keys.push(KEY_ALIASES[parts[i]] || parts[i]);
  }
  const mods = ['ctrl', 'shift', 'alt', 'meta'].filter((m) => keys.includes(m));
  const key = keys.filter((k) => !['ctrl', 'shift', 'alt', 'meta'].includes(k)).pop() || '';
  return [...mods, key].join('+');
}

/** KeyboardEvent → normalized combo ('ctrl+shift+p', 'f1', 'ctrl+`'). */
export function comboOf(e) {
  let key;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else {
    key = String(e.key || '').toLowerCase();
    key = KEY_ALIASES[key] || key;
  }
  if (['control', 'shift', 'alt', 'meta', 'ctrl'].includes(key)) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  return [...mods, key].join('+');
}

/** 'ctrl+shift+p' → 'Ctrl+Shift+P' (VS Code label style). Chords: 'ctrl+k ctrl+s'. */
export function kbLabel(combo) {
  if (!combo) return '';
  return String(combo).split(' ').map((part) => normCombo(part).split('+').map((k) => {
    if (k === 'ctrl') return 'Ctrl';
    if (k === 'shift') return 'Shift';
    if (k === 'alt') return 'Alt';
    if (k === 'meta') return 'Win';
    if (k === 'pageup') return 'PageUp';
    if (k === 'pagedown') return 'PageDown';
    if (k === 'escape') return 'Escape';
    if (k === 'delete') return 'Delete';
    if (k === 'enter') return 'Enter';
    if (k === 'space') return 'Space';
    if (k === 'up') return 'UpArrow';
    if (k === 'down') return 'DownArrow';
    if (k === 'left') return 'LeftArrow';
    if (k === 'right') return 'RightArrow';
    if (k === 'tab') return 'Tab';
    if (k === 'backspace') return 'Backspace';
    return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
  }).join('+')).join(' ');
}

/** VS Code keybinding label boxes (Ctrl + Shift + P). */
export function kbBoxes(combo) {
  const el = h('span', { class: 'wb-kb' });
  const chords = kbLabel(combo).split(' ');
  chords.forEach((chord, ci2) => {
    if (ci2) el.append(h('span', { class: 'wb-kb-sep' }, ' '));
    chord.split('+').forEach((k, i) => {
      if (i) el.append(h('span', { class: 'wb-kb-sep' }, '+'));
      el.append(h('kbd', { class: 'wb-kb-key' }, k));
    });
  });
  return el;
}

/* --------------------------------------------------------------------------- overlays */

let overlayRoot = null;
/** Layer for menus / dialogs / quick input (inside .wb so the theme variables apply). */
export function setOverlayRoot(el) { overlayRoot = el; }
function root() { return overlayRoot || document.body; }

/* --------------------------------------------------------------------------- context menu */

let openMenu = null;
export function closeContextMenu() { if (openMenu) openMenu.close(); }

/**
 * VS Code-style context menu.
 * items: [{ label, kb?, disabled?, checked?, onSelect }] | 'sep'
 * at: {x, y} (client coords) or {anchor: Element}
 */
export function contextMenu(at, items, { onClose, minWidth = 0 } = {}) {
  closeContextMenu();
  const list = items.filter(Boolean);
  // drop leading/trailing/double separators
  const clean = [];
  for (const it of list) {
    if (it === 'sep' && (!clean.length || clean[clean.length - 1] === 'sep')) continue;
    clean.push(it);
  }
  while (clean[clean.length - 1] === 'sep') clean.pop();
  const rows = [];
  const menu = h('div', { class: 'wb-menu', role: 'menu', tabindex: '-1' });
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  for (const it of clean) {
    if (it === 'sep') { menu.append(h('div', { class: 'wb-menu-sep', role: 'separator' })); continue; }
    const row = h('div', {
      class: ['wb-menu-item', it.disabled && 'disabled'], role: 'menuitem', 'aria-disabled': it.disabled ? 'true' : null,
    },
    h('span', { class: 'wb-menu-check' }, it.checked ? ci('check') : null),
    h('span', { class: 'wb-menu-label' }, it.icon || null, it.label),
    h('span', { class: 'wb-menu-kb' }, it.kb ? kbLabel(it.kb) : ''));
    row.addEventListener('mouseenter', () => setActive(rows.indexOf(row)));
    row.addEventListener('mouseleave', () => setActive(-1));
    row.addEventListener('mouseup', (e) => { if (e.button === 0 || e.button === 2) choose(it); });
    row.addEventListener('click', () => choose(it));
    rows.push(row);
    row._item = it;
    menu.append(row);
  }
  const backdrop = h('div', { class: 'wb-menu-backdrop' });
  backdrop.addEventListener('mousedown', (e) => { e.preventDefault(); close(); });
  backdrop.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });
  root().append(backdrop, menu);
  // position
  let x;
  let y;
  if (at && at.anchor) {
    const r = at.anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom;
  } else {
    x = at.x;
    y = at.y;
  }
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  x = clamp(x, 4, window.innerWidth - mw - 4);
  if (y + mh > window.innerHeight - 4) y = Math.max(4, (at && at.anchor ? at.anchor.getBoundingClientRect().top : y) - mh);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  let active = -1;
  const prevFocus = document.activeElement;
  menu.focus({ preventScroll: true });
  function setActive(i) {
    active = i;
    rows.forEach((r, j) => r.classList.toggle('active', j === i));
  }
  function move(d) {
    if (!rows.length) return;
    let i = active;
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (!rows[i]._item.disabled) break;
    }
    setActive(i);
  }
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); restore(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (active >= 0) choose(rows[active]._item); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });
  const onResize = () => close();
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);
  let closed = false;
  function restore() { try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
    backdrop.remove();
    menu.remove();
    if (openMenu === api) openMenu = null;
    if (onClose) onClose();
  }
  function choose(it) {
    if (it.disabled) return;
    close();
    restore();
    try { const r = it.onSelect && it.onSelect(); if (r && r.catch) r.catch((err) => notify(err.message || String(err), { severity: 'error' })); } catch (err) { notify(err.message || String(err), { severity: 'error' }); }
  }
  const api = { close, el: menu };
  openMenu = api;
  return api;
}

/* -------------------------------------------------------------------------------- dialog */

/**
 * VS Code modal dialog → Promise<number> (index of the chosen button; `cancelId` on Escape).
 * buttons: ['Move to Recycle Bin', 'Cancel'] — the first one is primary.
 */
export function dialog({ message, detail, buttons = ['OK'], type = 'warning', cancelId, checkbox } = {}) {
  return new Promise((resolve) => {
    const cancel = cancelId ?? buttons.length - 1;
    const prevFocus = document.activeElement;
    const btns = buttons.map((label, i) => h('button', {
      type: 'button', class: ['wb-btn', i === 0 ? 'primary' : 'secondary'],
      onClick: () => done(i),
    }, label));
    const box = h('div', { class: 'wb-dialog', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
      h('div', { class: 'wb-dialog-toolbar' }, h('button', { type: 'button', class: 'wb-action', 'aria-label': 'Close Dialog', title: 'Close Dialog', onClick: () => done(cancel) }, ci('close'))),
      h('div', { class: 'wb-dialog-body' },
        h('div', { class: ['wb-dialog-icon', type] }, ci(type === 'error' ? 'error' : type === 'info' ? 'info' : 'warning')),
        h('div', { class: 'wb-dialog-text' },
          h('div', { class: 'wb-dialog-msg' }, message || ''),
          detail ? h('div', { class: 'wb-dialog-detail' }, detail) : null)),
      h('div', { class: 'wb-dialog-buttons' }, btns));
    const shade = h('div', { class: 'wb-dialog-shade' }, box);
    root().append(shade);
    setTimeout(() => btns[0].focus(), 0);
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(cancel); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = btns.indexOf(document.activeElement);
        const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
        btns[n].focus();
        e.preventDefault();
      } else if (e.key === 'Tab') {
        const i = btns.indexOf(document.activeElement);
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
        e.preventDefault();
      }
    });
    function done(i) {
      shade.remove();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      resolve(i);
    }
    void checkbox;
  });
}

/* ------------------------------------------------------------------------- notifications */

let toastsEl = null;
/**
 * VS Code notification toast (bottom right). severity: info | warning | error.
 * actions: [{label, run}] → Promise resolves when dismissed.
 */
export function notify(message, { severity = 'info', actions = [], timeout, source } = {}) {
  if (!toastsEl || !toastsEl.isConnected) {
    toastsEl = h('div', { class: 'wb-toasts', 'aria-live': 'polite' });
    root().append(toastsEl);
  }
  const el = h('div', { class: ['wb-toast', severity], role: severity === 'error' ? 'alert' : 'status' },
    h('div', { class: 'wb-toast-main' },
      h('span', { class: ['wb-toast-icon', severity] }, ci(severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info')),
      h('div', { class: 'wb-toast-msg' }, String(message ?? '')),
      h('div', { class: 'wb-toast-tools' }, h('button', { type: 'button', class: 'wb-action', title: 'Clear Notification', 'aria-label': 'Clear Notification', onClick: () => close() }, ci('close')))),
    (source || actions.length) ? h('div', { class: 'wb-toast-foot' },
      h('span', { class: 'wb-toast-source' }, source ? `Source: ${source}` : ''),
      h('div', { class: 'wb-toast-actions' }, actions.map((a, i) => h('button', {
        type: 'button', class: ['wb-btn', i === actions.length - 1 ? 'primary' : 'secondary', 'small'],
        onClick: () => { close(); try { a.run && a.run(); } catch (err) { console.error(err); } },
      }, a.label)))) : null);
  toastsEl.append(el);
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  const t = setTimeout(close, timeout ?? (severity === 'error' ? 12000 : actions.length ? 15000 : 5000));
  function close() { clearTimeout(t); el.remove(); }
  return { close };
}

/* ---------------------------------------------------------------------------- progress */

/** Thin indeterminate progress bar (VS Code's monaco-progress-container). */
export function progressBar() {
  const bar = h('div', { class: 'wb-progress', 'aria-hidden': 'true' }, h('div', { class: 'wb-progress-bit' }));
  let n = 0;
  let t = 0;
  return {
    el: bar,
    /** Show after a short delay (no flicker for fast loads); returns done(). */
    start() {
      n++;
      clearTimeout(t);
      t = setTimeout(() => { if (n > 0) bar.classList.add('active'); }, 120);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        n = Math.max(0, n - 1);
        if (!n) { clearTimeout(t); bar.classList.remove('active'); }
      };
    },
  };
}

/* ------------------------------------------------------------------------------- fuzzy */

/**
 * Small fuzzy matcher (subsequence, case-insensitive; contiguous runs and word starts score
 * higher) → { score, matches: number[] } | null. Used by the fallback quick pick.
 */
export function fuzzy(query, target) {
  const q = String(query || '').toLowerCase();
  const t = String(target || '');
  const tl = t.toLowerCase();
  if (!q) return { score: 0, matches: [] };
  const direct = tl.indexOf(q);
  if (direct >= 0) {
    const matches = [];
    for (let i = 0; i < q.length; i++) matches.push(direct + i);
    return { score: 1000 - direct + (direct === 0 || /[\s\\/._-]/.test(t[direct - 1]) ? 200 : 0), matches };
  }
  const matches = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    let found = -1;
    for (; ti < tl.length; ti++) if (tl[ti] === c) { found = ti; break; }
    if (found < 0) return null;
    score += found === prev + 1 ? 8 : 1;
    if (found === 0 || /[\s\\/._-]/.test(t[found - 1]) || (t[found] !== tl[found] && t[found - 1] === tl[found - 1])) score += 6;
    matches.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score, matches };
}

/** Text with highlighted character positions → nodes. */
export function highlight(text, positions = [], cls = 'wb-hl') {
  const s = String(text ?? '');
  if (!positions || !positions.length) return [s];
  const set = new Set(positions);
  const out = [];
  let buf = '';
  let on = false;
  for (let i = 0; i < s.length; i++) {
    const m = set.has(i);
    if (m !== on) {
      if (buf) out.push(on ? h('span', { class: cls }, buf) : buf);
      buf = '';
      on = m;
    }
    buf += s[i];
  }
  if (buf) out.push(on ? h('span', { class: cls }, buf) : buf);
  return out;
}

/* --------------------------------------------------------------------------- quick pick */

/**
 * Minimal VS Code quick pick (used for window switching and as the fallback when the palette
 * module is not installed). items: [{label, description?, detail?, kb?, icon?, separator?, value}]
 * or an async function (query) → items. Resolves with the chosen item, or null.
 */
export function quickPick(items, { placeholder = '', value = '', title, onType, matchOnDescription = true } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const input = h('input', { class: 'wb-qi-input', type: 'text', placeholder, spellcheck: false, autocomplete: 'off', 'aria-label': placeholder || 'Quick input' });
    input.value = value;
    const list = h('div', { class: 'wb-qi-list', role: 'listbox' });
    const box = h('div', { class: 'wb-qi', role: 'dialog' },
      title ? h('div', { class: 'wb-qi-title' }, title) : null,
      h('div', { class: 'wb-qi-header' }, h('div', { class: 'wb-qi-inputbox' }, input)),
      list);
    const shade = h('div', { class: 'wb-qi-shade' });
    shade.addEventListener('mousedown', (e) => { e.preventDefault(); done(null); });
    root().append(shade, box);
    let shown = [];
    let sel = 0;
    let seq = 0;
    async function refresh() {
      const my = ++seq;
      let src = items;
      if (typeof items === 'function') src = await items(input.value);
      if (my !== seq) return;
      const q = typeof items === 'function' ? '' : input.value.trim();
      let rows = (src || []).map((it) => {
        if (!q) return { it, m: null, dm: null, score: 0 };
        const m = fuzzy(q, it.label);
        const dm = !m && matchOnDescription && it.description ? fuzzy(q, it.description) : null;
        if (!m && !dm) return null;
        return { it, m, dm, score: (m ? m.score : dm.score / 2) };
      }).filter(Boolean);
      if (q) rows.sort((a, b) => b.score - a.score);
      rows = rows.slice(0, 200);
      shown = rows;
      sel = 0;
      render();
      if (onType) onType(input.value);
    }
    function render() {
      setChildren(list, shown.length ? shown.map((r, i) => {
        const it = r.it;
        const row = h('div', { class: ['wb-qi-row', i === sel && 'focused', it.detail && 'has-detail'], role: 'option', 'aria-selected': String(i === sel) },
          h('div', { class: 'wb-qi-row-main' },
            it.icon ? (it.icon instanceof Node ? it.icon : ci(it.icon)) : null,
            h('span', { class: 'wb-qi-label' }, highlight(it.label, r.m ? r.m.matches : [])),
            it.description ? h('span', { class: 'wb-qi-desc' }, highlight(it.description, r.dm ? r.dm.matches : [])) : null,
            h('span', { class: 'wb-qi-right' },
              it.separator && i > 0 && !shown[i - 1].it.separator ? null : null,
              it.kb ? kbBoxes(it.kb) : null)),
          it.detail ? h('div', { class: 'wb-qi-detail' }, it.detail) : null);
        row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
        row.addEventListener('mousedown', (e) => { e.preventDefault(); done(it); });
        return row;
      }) : h('div', { class: 'wb-qi-empty' }, 'No matching results'));
      const f = list.children[sel];
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', () => refresh());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { sel = (sel + 1) % shown.length; render(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { sel = (sel - 1 + shown.length) % shown.length; render(); } }
      else if (e.key === 'PageDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 10); render(); }
      else if (e.key === 'PageUp') { e.preventDefault(); sel = Math.max(0, sel - 10); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); done(shown[sel] ? shown[sel].it : null); }
    });
    function done(v) {
      seq++;
      shade.remove();
      box.remove();
      if (!v) { try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
      resolve(v);
    }
    input.focus();
    if (value) input.setSelectionRange(value.length, value.length);
    refresh();
  });
}

/* --------------------------------------------------------------------------- inline input */

/**
 * Inline input box (explorer rename / new file): replaces `host`'s children with an input.
 * validate(value) → message | null (shown as a VS Code validation box under the input).
 * Resolves with the value (Enter / blur) or null (Escape).
 */
export function inlineInput(host, { value = '', select, validate } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'wb-inline-input', type: 'text', spellcheck: false, autocomplete: 'off', 'aria-label': 'Name' });
    input.value = value;
    const msg = h('div', { class: 'wb-inline-msg', hidden: true });
    const wrap = h('div', { class: 'wb-inline' }, input, msg);
    host.replaceChildren(wrap);
    let done = false;
    const check = () => {
      const m = validate ? validate(input.value) : null;
      msg.hidden = !m;
      msg.textContent = m || '';
      wrap.classList.toggle('invalid', !!m);
      return m;
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => setTimeout(() => finish(true, true), 0));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    function finish(accept, fromBlur = false) {
      if (done) return;
      const v = input.value.trim();
      if (accept && v && check()) {
        if (!fromBlur) return; // Enter on an invalid name: keep editing
        accept = false; // focus left with an invalid name: cancel, like VS Code
      }
      done = true;
      resolve(accept && v ? v : null);
    }
    const focusNow = () => {
      if (document.activeElement === input || done) return;
      input.focus();
      if (select) input.setSelectionRange(select[0], select[1]);
      else input.select();
    };
    focusNow(); // at once (typing right after the box appears must not be lost) …
    requestAnimationFrame(focusNow); // … and again once laid out
  });
}

/* ------------------------------------------------------------------------------ misc */

/** Path helpers that work for Windows and POSIX paths (case-insensitive keys on Windows). */
export const pathKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
export function isUnder(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/');
}
export function sepOf(p) { return /\\/.test(p) || /^[A-Za-z]:/.test(p) ? '\\' : '/'; }
export function join(dir, name) {
  if (!dir) return name;
  return /[\\/]$/.test(dir) ? dir + name : dir + sepOf(dir) + name;
}
export function relativeTo(p, roots) {
  for (const r of roots || []) {
    if (!r) continue;
    if (pathKey(p) === pathKey(r)) return '';
    if (isUnder(p, r)) return String(p).slice(String(r).replace(/[\\/]+$/, '').length + 1);
  }
  return null;
}

/** Action button (codicon) as used in title bars / section headers. */
export function actionBtn(icon, title, onClick, { cls = '', kb } = {}) {
  const label = kb ? `${title} (${kbLabel(kb)})` : title;
  const b = h('button', { type: 'button', class: ['wb-action', cls], title: label, 'aria-label': title }, ci(icon));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}
