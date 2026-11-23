#!/usr/bin/env node
// Prints the release notes for one version: the "## <version>" section of the first changelog that
// has one (CHANGELOG.md at the repository root, else vscode-extension/CHANGELOG.md), followed by the
// install instructions. Used by .github/workflows/release.yml (GitHub appends its generated notes).
//
//   node scripts/release/release-notes.mjs 1.0.0 [--repo owner/name] > notes.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const repo = repoIdx >= 0 ? args.splice(repoIdx, 2)[1] : 'ehabmansour1/TermPocket';
const version = String(args[0] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: release-notes.mjs <version> [--repo owner/name]');
  process.exit(2);
}

/** The body of "## <version>" (also "## v1.0.0", "## [1.0.0] - date") up to the next "## " heading. */
export function extractSection(text, ver) {
  const lines = text.split(/\r?\n/);
  const esc = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

let section = null;
let source = null;
for (const rel of ['CHANGELOG.md', 'vscode-extension/CHANGELOG.md']) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  section = extractSection(fs.readFileSync(file, 'utf8'), version);
  if (section) {
    source = rel;
    break;
  }
}

const out = [];
out.push(`## Install`, '');
out.push('In PowerShell on the Windows PC (per user, no admin rights; brings its own Node.js):', '');
out.push('```powershell', `irm https://github.com/${repo}/releases/download/v${version}/install.ps1 | iex`, '```', '');
out.push(
  `Or download \`TermPocket-${version}-win-x64.zip\`, check it against \`SHA256SUMS.txt\`, unzip it and run ` +
    '`scripts\\install-autostart.ps1`. The VS Code extension is also attached as ' +
    `\`termpocket-${version}.vsix\` (\`code --install-extension termpocket-${version}.vsix\`).`,
  '',
);
out.push(`## What's new in ${version}`, '');
out.push(section || 'See the commits below.');
if (source) out.push('', `<sub>From ${source}.</sub>`);
process.stdout.write(out.join('\n') + '\n');
