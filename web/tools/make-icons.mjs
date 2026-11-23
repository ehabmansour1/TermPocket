#!/usr/bin/env node
// Generates the PWA icons (PNG) with Node built-ins only (zlib + a CRC-32 table).
//
//   node web/tools/make-icons.mjs
//
// Output (relative to web/):
//   icons/icon-192.png     rounded-square icon, transparent corners  (purpose "any")
//   icons/icon-512.png     same at 512 px
//   icons/maskable-512.png full-bleed background, mark inside the 80 % safe zone (purpose "maskable")
//   ../vscode-extension/icon.png  256 px, the VS Code extension's icon
//
// The artwork — the TermPocket mark: a bold ">_" prompt in a stitched pocket on a dark ink
// gradient — is drawn from signed distance functions with 4×4 supersampling for clean
// anti-aliased edges, and it matches icons/icon.svg.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(WEB_DIR, 'icons');

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA8 pixels as a PNG file buffer. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- drawing */

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG_A = hex('#1a2633'); // top-left
const BG_B = hex('#090b10'); // bottom-right
const GLOW = hex('#2de2b0');
const FG_A = hex('#8bf7d2'); // glyph top
const FG_B = hex('#46c9e6'); // glyph bottom
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Distance from p to segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Signed distance to a rounded square centred at .5,.5 with half-size hs and radius r. */
function roundRectDist(px, py, hs, r) {
  const qx = Math.abs(px - 0.5) - (hs - r);
  const qy = Math.abs(py - 0.5) - (hs - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// TermPocket mark: a ">_" prompt tucked into a pocket (flat top with a lip, rounded bottom, dashed
// stitching along the sides and the bottom). Unit space; matches icons/icon.svg.
const POCKET = { l: 0.2, r: 0.8, t: 0.33, b: 0.82, rad: 0.14 };
const GLYPH = { s: 0.6, dy: 0.07 };
const STITCH_INSET = 0.035;

/** Signed distance to the pocket body (only the bottom corners are rounded). */
function pocketDist(px, py) {
  const cx = (POCKET.l + POCKET.r) / 2;
  const cy = (POCKET.t + POCKET.b) / 2;
  const hw = (POCKET.r - POCKET.l) / 2;
  const hh = (POCKET.b - POCKET.t) / 2;
  const r = py > cy ? POCKET.rad : 0;
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Dashed stitch line inside the pocket edge (sides and bottom only). */
function stitchInside(px, py) {
  if (py < POCKET.t + 0.06) return false;
  if (Math.abs(pocketDist(px, py) + STITCH_INSET) > 0.0085) return false;
  // dash along the outline: arc length ≈ distance travelled down the sides plus along the bottom
  const along = Math.abs(px - 0.5) < 0.2 && py > POCKET.b - 0.08 ? Math.abs(px - 0.5) + 1 : py;
  return Math.floor(along / 0.032) % 2 === 0;
}

/** The pocket's top lip: a rounded bar across the opening. */
function lipInside(px, py) {
  return segDist(px, py, POCKET.l, POCKET.t, POCKET.r, POCKET.t) <= 0.024;
}

/** Glyph ">_", scaled by GLYPH.s around the centre and moved down into the pocket. */
function glyphInside(x, y) {
  const gx = (x - 0.5) / GLYPH.s + 0.5;
  const gy = (y - 0.5 - GLYPH.dy) / GLYPH.s + 0.5;
  const w = 0.092 / 2; // stroke half-width (glyph space)
  const d1 = segDist(gx, gy, 0.255, 0.315, 0.455, 0.5);
  const d2 = segDist(gx, gy, 0.455, 0.5, 0.255, 0.685);
  const d3 = segDist(gx, gy, 0.53, 0.685, 0.745, 0.685);
  return Math.min(d1, d2, d3) <= w;
}

/**
 * Render an icon.
 * @param {number} size     pixels
 * @param {boolean} maskable full-bleed background and the mark inside the 80 % safe zone
 */
function render(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling grid
  const k = maskable ? 0.8 : 1.0; // mark scale
  const hs = 0.5;           // half-size of the rounded square
  const radius = 0.225;     // corner radius (unit space)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0;
      let pocketCov = 0;
      let stitchCov = 0;
      let lipCov = 0;
      let fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / size;
          const uy = (y + (sy + 0.5) / SS) / size;
          const inBg = maskable ? true : roundRectDist(ux, uy, hs, radius) <= 0;
          if (!inBg) continue;
          bgCov++;
          const mx = (ux - 0.5) / k + 0.5;
          const my = (uy - 0.5) / k + 0.5;
          if (glyphInside(mx, my)) fgCov++;
          else if (lipInside(mx, my)) lipCov++;
          else if (stitchInside(mx, my)) stitchCov++;
          else if (pocketDist(mx, my) <= 0) pocketCov++;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (!bgCov) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
      const ux = (x + 0.5) / size;
      const uy = (y + 0.5) / size;
      // background: diagonal gradient + soft glow behind the mark
      let c = mix(BG_A, BG_B, clamp01((ux + uy) / 2 * 1.1));
      const gd = Math.hypot(ux - 0.5, uy - 0.56);
      c = mix(c, GLOW, 0.16 * Math.exp(-(gd * gd) / 0.045));
      // faint top highlight for depth
      c = mix(c, [255, 255, 255], 0.05 * clamp01(1 - uy * 3));
      const fg = mix(FG_A, FG_B, clamp01((uy - 0.3) / 0.5));
      const pocket = mix(c, GLOW, 0.1);
      // pocket body, stitching, lip and glyph, composited by their share of the pixel
      let out = c;
      out = mix(out, pocket, (pocketCov + stitchCov + fgCov) / bgCov);
      out = mix(out, mix(pocket, FG_A, 0.55), stitchCov / bgCov);
      out = mix(out, fg, (lipCov + fgCov) / bgCov);
      px[i] = Math.round(out[0]);
      px[i + 1] = Math.round(out[1]);
      px[i + 2] = Math.round(out[2]);
      px[i + 3] = Math.round((bgCov / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

/* ----------------------------------------------------------------- main */

mkdirSync(OUT_DIR, { recursive: true });
const EXT_DIR = join(WEB_DIR, '..', 'vscode-extension');
const jobs = [
  { file: join(OUT_DIR, 'icon-192.png'), size: 192, maskable: false },
  { file: join(OUT_DIR, 'icon-512.png'), size: 512, maskable: false },
  { file: join(OUT_DIR, 'maskable-512.png'), size: 512, maskable: true },
  { file: join(EXT_DIR, 'icon.png'), size: 256, maskable: false }, // VS Code extension (Marketplace / Open VSX)
];
for (const j of jobs) {
  const buf = render(j.size, j.maskable);
  const out = j.file;
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${j.size}×${j.size}, ${buf.length} bytes)`);
}
