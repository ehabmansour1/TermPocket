#!/usr/bin/env node
// Renders agent/demo/desktop.html (a made-up Windows desktop, see that file) to the JPEG frames the
// agent's demo mode streams instead of the real screen (TERMPOCKET_DEMO=1, agent/src/demo.js):
//
//   node agent/demo/make-demo-desktop.mjs
//
//   agent/demo/desktop-1920x1080.jpg   full HD (HD / High presets, Remote Desktop)
//   agent/demo/desktop-1280x720.jpg    Medium / Low presets and phone views
//
// Needs the e2e test dependencies (cd e2e && npm install → playwright-core) and an installed Google
// Chrome or Microsoft Edge; it renders a local file only (no network).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'e2e', 'package.json'));
const { chromium } = require('playwright-core');

const SIZES = [
  { width: 1920, height: 1080, quality: 82 },
  { width: 1280, height: 720, quality: 80 },
];

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next one */
    }
  }
  throw new Error('neither Google Chrome nor Microsoft Edge could be started');
}

const browser = await launch();
try {
  for (const s of SIZES) {
    // The page is laid out at 1920×1080 CSS px; smaller frames use a fractional device scale factor.
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: s.width / 1920 });
    await page.goto(pathToFileURL(path.join(HERE, 'desktop.html')).href);
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(HERE, `desktop-${s.width}x${s.height}.jpg`);
    await page.screenshot({ path: out, type: 'jpeg', quality: s.quality });
    await page.close();
    console.log(`wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
} finally {
  await browser.close();
}
