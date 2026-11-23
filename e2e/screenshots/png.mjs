// Small PNG optimizer for the README screenshots, Node built-ins only (no pngquant / sharp here).
//
// optimizePng(buf, {budget}) decodes an 8-bit RGB/RGBA PNG (what Chrome writes) and returns the
// smallest good-looking encoding:
//   1. ≤ 256 distinct colours → lossless palette PNG;
//   2. otherwise truecolour with per-row adaptive filters, if that fits the byte budget;
//   3. otherwise a 256-colour palette from median cut + k-means refinement (like pngquant without
//      dithering: UI screenshots are mostly flat colours and anti-aliased text, which survive it well).
// Images with transparency skip step 3.

import { deflateSync, inflateSync } from 'node:zlib';

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

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------------------------ decode */

/** Decode an 8-bit, non-interlaced RGB / RGBA / gray / gray-alpha PNG to RGBA. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels >= 3) { rgba[o] = px[j]; rgba[o + 1] = px[j + 1]; rgba[o + 2] = px[j + 2]; rgba[o + 3] = channels === 4 ? px[j + 3] : 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[j]; rgba[o + 3] = channels === 2 ? px[j + 1] : 255; }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------------------------ encode */

function ihdr(width, height, ctype) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0);
  h.writeUInt32BE(height, 4);
  h[8] = 8; h[9] = ctype; h[10] = 0; h[11] = 0; h[12] = 0;
  return h;
}

/** Filter rows adaptively (minimum sum of absolute differences). */
function filterRows(px, stride, height, bpp) {
  const out = Buffer.alloc((stride + 1) * height);
  const zero = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let p;
        if (f === 0) p = 0;
        else if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else {
          const q = a + b - c;
          const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i] - p) & 255;
        o[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // recompute the winner fully (the loop above may have stopped early for it on a tie)
    const o = out.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    o[0] = best;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let p;
      if (best === 0) p = 0;
      else if (best === 1) p = a;
      else if (best === 2) p = b;
      else if (best === 3) p = (a + b) >> 1;
      else {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      o[i + 1] = (cur[i] - p) & 255;
    }
  }
  return out;
}

export function encodeTruecolor({ width, height, rgba }) {
  const opaque = isOpaque(rgba);
  const ch = opaque ? 3 : 4;
  const px = Buffer.alloc(width * height * ch);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    px[j] = rgba[i * 4]; px[j + 1] = rgba[i * 4 + 1]; px[j + 2] = rgba[i * 4 + 2];
    if (ch === 4) px[j + 3] = rgba[i * 4 + 3];
  }
  const data = filterRows(px, width * ch, height, ch);
  return Buffer.concat([SIG, chunk('IHDR', ihdr(width, height, opaque ? 2 : 6)), chunk('IDAT', deflateSync(data, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIndexed(width, height, indices, palette /* [[r,g,b,a]] */) {
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
  const alpha = palette.some((c) => c[3] !== 255) ? Buffer.from(palette.map((c) => c[3])) : null;
  // Palette images compress best unfiltered or with "up"; pick per image.
  const variants = [0, 2].map((f) => {
    const out = Buffer.alloc((width + 1) * height);
    for (let y = 0; y < height; y++) {
      out[y * (width + 1)] = f;
      for (let x = 0; x < width; x++) {
        const v = indices[y * width + x];
        out[y * (width + 1) + 1 + x] = f === 2 && y ? (v - indices[(y - 1) * width + x]) & 255 : v;
      }
    }
    return deflateSync(out, { level: 9, memLevel: 9 });
  });
  const idat = variants[0].length <= variants[1].length ? variants[0] : variants[1];
  return Buffer.concat([
    SIG, chunk('IHDR', ihdr(width, height, 3)), chunk('PLTE', plte),
    ...(alpha ? [chunk('tRNS', alpha)] : []),
    chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function isOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/* ---------------------------------------------------------------------------------- quantize */

/** Median cut on a 5-bit-per-channel histogram, refined with k-means; returns [[r,g,b]]. */
function buildPalette(rgba, n = 256) {
  const bins = new Map(); // 15-bit key -> {count, r, g, b}
  for (let i = 0; i < rgba.length; i += 4) {
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let b = bins.get(k);
    if (!b) { b = { count: 0, r: 0, g: 0, b: 0 }; bins.set(k, b); }
    b.count++; b.r += rgba[i]; b.g += rgba[i + 1]; b.b += rgba[i + 2];
  }
  const items = [...bins.values()].map((b) => ({ w: b.count, c: [b.r / b.count, b.g / b.count, b.b / b.count] }));
  let boxes = [items];
  const range = (box) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    let w = 0;
    for (const it of box) { w += it.w; for (let d = 0; d < 3; d++) { if (it.c[d] < lo[d]) lo[d] = it.c[d]; if (it.c[d] > hi[d]) hi[d] = it.c[d]; } }
    const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const dim = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    return { w, dim, span: r[dim] };
  };
  while (boxes.length < n) {
    let bi = -1, bestScore = 0, info = null;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const r = range(boxes[i]);
      // favour splitting heavy and wide boxes (sqrt weight keeps rare accent colours alive)
      const score = Math.sqrt(r.w) * r.span;
      if (score > bestScore) { bestScore = score; bi = i; info = r; }
    }
    if (bi < 0) break;
    const box = boxes[bi].sort((a, b) => a.c[info.dim] - b.c[info.dim]);
    let acc = 0, cutAt = 1;
    for (let i = 0; i < box.length - 1; i++) { acc += box[i].w; if (acc >= info.w / 2) { cutAt = i + 1; break; } }
    boxes.splice(bi, 1, box.slice(0, cutAt), box.slice(cutAt));
  }
  let pal = boxes.map((box) => {
    let w = 0; const s = [0, 0, 0];
    for (const it of box) { w += it.w; for (let d = 0; d < 3; d++) s[d] += it.c[d] * it.w; }
    return s.map((v) => v / w);
  });
  // k-means refinement over the histogram
  for (let iter = 0; iter < 4; iter++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const it of items) {
      const j = nearest(pal, it.c[0], it.c[1], it.c[2]);
      acc[j][0] += it.c[0] * it.w; acc[j][1] += it.c[1] * it.w; acc[j][2] += it.c[2] * it.w; acc[j][3] += it.w;
    }
    pal = pal.map((p, j) => (acc[j][3] ? [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]] : p));
  }
  return pal.map((p) => p.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
}

function nearest(pal, r, g, b) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < pal.length; j++) {
    const p = pal[j];
    // weighted RGB distance (green matters most to the eye)
    const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

function quantize({ width, height, rgba }) {
  const pal = buildPalette(rgba);
  const cache = new Map();
  const idx = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    let j = cache.get(key);
    if (j === undefined) { j = nearest(pal, rgba[o], rgba[o + 1], rgba[o + 2]); cache.set(key, j); }
    idx[i] = j;
  }
  return encodeIndexed(width, height, idx, pal.map((p) => [...p, 255]));
}

/** Exact palette when the image has ≤ 256 RGBA colours, else null. */
function exactPalette({ width, height, rgba }) {
  const map = new Map();
  const idx = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const key = rgba.readUInt32BE(o);
    let j = map.get(key);
    if (j === undefined) {
      if (map.size >= 256) return null;
      j = map.size;
      map.set(key, j);
    }
    idx[i] = j;
  }
  const pal = [...map.keys()].map((k) => [(k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255]);
  return encodeIndexed(width, height, idx, pal);
}

/**
 * Smallest acceptable encoding of a PNG (see the file header). `budget` (bytes, default 400 KB) is the
 * size up to which the lossless truecolour version is kept; `lossy: false` never quantizes.
 */
export async function optimizePng(buf, { budget = 400 * 1024, lossy = true } = {}) {
  const img = decodePng(buf);
  const exact = exactPalette(img);
  if (exact) return exact.length < buf.length ? exact : buf;
  const tc = encodeTruecolor(img);
  const best = tc.length < buf.length ? tc : buf;
  if (best.length <= budget || !lossy || !isOpaque(img.rgba)) return best;
  const q = quantize(img);
  return q.length < best.length ? q : best;
}
