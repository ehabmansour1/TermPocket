#!/usr/bin/env node
// Writes a ready-to-use Scoop manifest for one release: packaging/scoop/termpocket.json with the
// version, download URL and SHA-256 of TermPocket-<version>-win-x64.zip filled in. The result is a
// build artifact only (copy it into a bucket yourself); nothing is pushed anywhere.
//
//   node scripts/release/scoop-manifest.mjs <version> <dist dir> [out file]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [verArg, distArg, outArg] = process.argv.slice(2);
const version = String(verArg ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version) || !distArg) {
  console.error('usage: scoop-manifest.mjs <version> <dist dir> [out file]');
  process.exit(2);
}
const zipName = `TermPocket-${version}-win-x64.zip`;
const zip = path.resolve(distArg, zipName);
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging', 'scoop', 'termpocket.json'), 'utf8'));
const tmpl = manifest.autoupdate.architecture['64bit'].url;
manifest.version = version;
manifest.architecture['64bit'].url = tmpl.replaceAll('$version', version);
manifest.architecture['64bit'].hash = hash;

const out = path.resolve(outArg ?? path.join(distArg, 'termpocket.json'));
fs.writeFileSync(out, JSON.stringify(manifest, null, 4) + '\n');
console.log(`scoop manifest: ${out} (${zipName} sha256 ${hash})`);
