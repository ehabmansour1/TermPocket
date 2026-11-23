#!/usr/bin/env node
// Copies the UMD builds of xterm.js and its fit addon into ../web/vendor/ so the PWA can load
// them locally (no CDN), plus Monaco's minified AMD build (node_modules/monaco-editor/min/vs →
// ../web/vendor/monaco/vs) for the desktop Code workbench. Run automatically on `npm install`
// (postinstall) or via `npm run vendor`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '..');
const outDir = path.resolve(agentDir, '..', 'web', 'vendor');
const require = createRequire(path.join(agentDir, 'package.json'));

/** [package-relative source, output file name] — names fixed by PROTOCOL.md §6. */
const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

/** Resolve a file inside an installed package without relying on its "exports" map. */
function resolvePackageFile(spec) {
  const parts = spec.split('/');
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
  // Walk node_modules directories upward from the agent dir (handles hoisting).
  let dir = agentDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName, rest);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: Node's resolver (works when the package exposes package.json).
  const pkgJson = require.resolve(`${pkgName}/package.json`);
  return path.join(path.dirname(pkgJson), rest);
}

/**
 * Monaco (optional): copy ONLY monaco-editor/min/vs to web/vendor/monaco/vs. Skipped when the
 * installed version is already there (web/vendor/monaco/VERSION), so re-running is cheap.
 * Returns false when Monaco is installed but could not be copied.
 */
function vendorMonaco() {
  let pkgDir;
  try {
    pkgDir = path.dirname(resolvePackageFile('monaco-editor/package.json'));
  } catch {
    console.warn('vendor: monaco-editor not installed — the desktop Code workbench falls back to the plain editor');
    return true;
  }
  const src = path.join(pkgDir, 'min', 'vs');
  const dest = path.join(outDir, 'monaco', 'vs');
  const stamp = path.join(outDir, 'monaco', 'VERSION');
  try {
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    if (fs.existsSync(path.join(dest, 'loader.js')) && fs.existsSync(stamp)
      && fs.readFileSync(stamp, 'utf8').trim() === version) {
      console.log(`vendor: monaco-editor ${version} already in web/vendor/monaco/vs`);
      return true;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: (f) => !f.endsWith('.map') });
    fs.writeFileSync(stamp, `${version}
`);
    console.log(`vendor: monaco-editor ${version} min/vs -> web/vendor/monaco/vs`);
    return true;
  } catch (err) {
    console.error(`vendor: failed to copy monaco-editor/min/vs: ${err.message}`);
    return false;
  }
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const [src, name] of FILES) {
    try {
      const from = resolvePackageFile(src);
      const to = path.join(outDir, name);
      fs.copyFileSync(from, to);
      console.log(`vendor: ${src} -> ${path.relative(path.resolve(agentDir, '..'), to)}`);
    } catch (err) {
      failed++;
      console.error(`vendor: failed to copy ${src}: ${err.message}`);
    }
  }
  if (!vendorMonaco()) failed++;
  if (failed) {
    console.error(`vendor: ${failed} file(s) could not be copied — is "npm install" complete?`);
    process.exitCode = 1;
  }
}

main();
