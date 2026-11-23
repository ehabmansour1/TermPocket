#!/usr/bin/env node
// Static self-check for the PWA (Node built-ins only). Rerunnable by the integrator:
//
//   node web/tools/check-refs.mjs            # vendor/* may be missing (warning)
//   node web/tools/check-refs.mjs --strict   # vendor/* must exist too
//
// Verifies that
//   1. every local file referenced from index.html (src/href) exists,
//   2. every file in sw.js CORE/OPTIONAL lists exists,
//   3. every icon in manifest.webmanifest exists and PNG sizes match "sizes",
//   4. the ES-module import graph starting at app.js resolves, and every module
//      in it is pre-cached by sw.js (so the app works offline),
//   5. every .js under web/ (except tools/ and vendor/) passes `node --check`
//      (as an ES module; sw.js as a classic script).
// Exit code 0 = OK, 1 = problems found.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const errors = [];
const warnings = [];
const ok = [];

const rel = (p) => relative(WEB, p).split(sep).join('/');
const isVendor = (p) => p.replace(/^\.\//, '').startsWith('vendor/');
const isLocal = (u) => u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u);

function checkExists(ref, from) {
  const clean = ref.split(/[?#]/)[0];
  if (!clean || clean === './' || clean === '.') return true; // scope root → index.html
  const abs = resolve(WEB, clean);
  if (!abs.startsWith(WEB)) { errors.push(`${from}: "${ref}" points outside web/`); return false; }
  if (existsSync(abs) && statSync(abs).isFile()) return true;
  if (isVendor(clean) && !strict) { warnings.push(`${from}: "${ref}" missing (vendor — filled by agent \`npm run vendor\`)`); return false; }
  errors.push(`${from}: "${ref}" does not exist`);
  return false;
}

/* 1. index.html ------------------------------------------------------------ */
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const htmlRefs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]).filter(isLocal);
for (const r of htmlRefs) checkExists(r, 'index.html');
ok.push(`index.html: ${htmlRefs.length} local references checked`);

/* 2. sw.js ------------------------------------------------------------------ */
const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
function swList(name) {
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(sw);
  if (!m) { errors.push(`sw.js: could not find the ${name} array`); return []; }
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]);
}
const swCore = swList('CORE');
const swOptional = swList('OPTIONAL');
for (const r of [...swCore, ...swOptional]) checkExists(r, 'sw.js');
const swSet = new Set([...swCore, ...swOptional].map((p) => p.replace(/^\.\//, '')));
for (const r of htmlRefs) {
  const clean = r.split(/[?#]/)[0].replace(/^\.\//, '');
  if (!swSet.has(clean)) errors.push(`index.html references "${r}" but sw.js does not cache it`);
}
for (const v of ['vendor/xterm.js', 'vendor/xterm.css', 'vendor/addon-fit.js']) {
  if (!swSet.has(v)) errors.push(`sw.js does not list ${v}`);
}
if (!/\/\(\?:ws\|vscode\|healthz\|pair\)/.test(sw) && !/healthz/.test(sw)) errors.push('sw.js: no bypass for /ws and /healthz found');
ok.push(`sw.js: ${swCore.length} core + ${swOptional.length} optional entries checked`);

/* 3. manifest ---------------------------------------------------------------- */
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(WEB, 'manifest.webmanifest'), 'utf8'));
} catch (err) {
  errors.push(`manifest.webmanifest: invalid JSON (${err.message})`);
}
function pngSize(file) {
  const b = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
if (manifest) {
  for (const k of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color']) {
    if (!(k in manifest)) errors.push(`manifest: missing "${k}"`);
  }
  if (manifest.display !== 'standalone') errors.push('manifest: display must be "standalone"');
  if (!(manifest.icons || []).some((i) => /maskable/.test(i.purpose || ''))) errors.push('manifest: no maskable icon');
  for (const icon of manifest.icons || []) {
    if (!checkExists(icon.src, 'manifest')) continue;
    if (!swSet.has(icon.src)) errors.push(`manifest icon ${icon.src} is not cached by sw.js`);
    if (icon.type === 'image/png') {
      const size = pngSize(join(WEB, icon.src));
      if (!size) { errors.push(`${icon.src}: not a valid PNG`); continue; }
      const want = /^(\d+)x(\d+)$/.exec(icon.sizes || '');
      if (want && (Number(want[1]) !== size.w || Number(want[2]) !== size.h)) {
        errors.push(`${icon.src}: is ${size.w}×${size.h}, manifest says ${icon.sizes}`);
      } else ok.push(`${icon.src}: PNG ${size.w}×${size.h} OK`);
    }
  }
}

/* 4. module graph ------------------------------------------------------------- */
const seen = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!existsSync(file)) { errors.push(`module ${rel(file)} does not exist`); return; }
  const src = readFileSync(file, 'utf8');
  const specs = [
    ...src.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
    ...src.matchAll(/^\s*export\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/gm),
    ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  for (const s of specs) {
    if (!s.startsWith('.')) { errors.push(`${rel(file)}: bare import "${s}" (no bundler — use relative paths)`); continue; }
    walk(resolve(dirname(file), s));
  }
  // The workbench shell loads its optional modules by name (`export const C_MODULES = [...]`,
  // imported as `./<name>.js` next to it): follow them like static imports.
  const hook = /export\s+const\s+C_MODULES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (hook) for (const m of hook[1].matchAll(/['"]([\w-]+)['"]/g)) walk(resolve(dirname(file), `${m[1]}.js`));
}
walk(join(WEB, 'app.js'));
for (const f of seen) {
  const r = rel(f);
  if (!swSet.has(r)) errors.push(`module ${r} is imported but not cached by sw.js`);
}
ok.push(`module graph: ${seen.size} modules resolved from app.js`);

/* 5. syntax check ------------------------------------------------------------- */
function listJs(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['vendor', 'tools', 'node_modules'].includes(ent.name)) continue;
      out.push(...listJs(p));
    } else if (/\.m?js$/.test(ent.name)) out.push(p);
  }
  return out;
}
const jsFiles = listJs(WEB);
for (const f of jsFiles) {
  // sw.js is a classic worker script; everything else is an ES module.
  const isModule = rel(f) !== 'sw.js';
  const res = spawnSync(process.execPath, ['--check', ...(isModule ? ['--input-type=module'] : [])], {
    input: readFileSync(f), encoding: 'utf8',
  });
  if (res.status !== 0) errors.push(`syntax error in ${rel(f)}:\n${(res.stderr || '').trim()}`);
}
for (const f of seen) if (!jsFiles.includes(f)) errors.push(`module ${rel(f)} is outside the checked tree`);
const orphans = jsFiles.filter((f) => rel(f) !== 'sw.js' && !seen.has(f));
for (const f of orphans) warnings.push(`${rel(f)} is not imported by app.js (dead code?)`);
ok.push(`syntax: ${jsFiles.length} files parsed`);

/* report ---------------------------------------------------------------------- */
for (const m of ok) console.log(`  ok    ${m}`);
for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.log(`  FAIL  ${e}`);
console.log(errors.length ? `\n${errors.length} problem(s) found.` : `\nAll references OK${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
process.exit(errors.length ? 1 : 0);
