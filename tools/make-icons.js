/**
 * Generates the toolbar icons.
 *
 * A script rather than three binary files somebody has to open an editor to
 * change: the icons are a rounded orange square with a white star, and every
 * parameter of that is a constant below.
 *
 * PNG is written by hand — it is a signature, three chunks and a CRC, and
 * that is a smaller thing to carry than an image dependency. The CRC is the
 * same CRC-32 the ZIP writer already implements, so it is borrowed rather
 * than written twice.
 *
 *   node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { crc32 } = require('../lib/zip.js');

const ORANGE = [0xEE, 0x4D, 0x2D];
const WHITE = [0xFF, 0xFF, 0xFF];
const SIZES = [16, 48, 128];
const SAMPLES = 4; // supersampling per axis, so edges are not jagged

/* ------------------------------------------------------------------ *
 * Shapes, in unit coordinates (0..1) so one description fits every size.
 * ------------------------------------------------------------------ */

function insideRoundedSquare(x, y, radius) {
  const nx = Math.min(x, 1 - x);
  const ny = Math.min(y, 1 - y);
  if (nx >= radius || ny >= radius) return nx >= 0 && ny >= 0;
  const dx = radius - nx;
  const dy = radius - ny;
  return dx * dx + dy * dy <= radius * radius;
}

/** Five-pointed star as a polygon, then an ordinary point-in-polygon test. */
function starPoints(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    // -90° so a point faces up rather than right.
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const straddles = (yi > y) !== (yj > y);
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const STAR = starPoints(0.5, 0.5, 0.30, 0.135);

/**
 * Colour and alpha for one pixel, averaged over a grid of samples.
 *
 * At 16 pixels across, a star drawn without this is a grey smudge with
 * staircase edges; the supersampling is what makes the small icon legible.
 */
function pixel(px, py, size) {
  let hits = 0;
  let starHits = 0;

  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = (px + (sx + 0.5) / SAMPLES) / size;
      const y = (py + (sy + 0.5) / SAMPLES) / size;
      if (!insideRoundedSquare(x, y, 0.22)) continue;
      hits += 1;
      if (insidePolygon(x, y, STAR)) starHits += 1;
    }
  }

  const total = SAMPLES * SAMPLES;
  if (hits === 0) return [0, 0, 0, 0];

  const starFraction = starHits / hits;
  const rgb = [0, 1, 2].map((c) =>
    Math.round(ORANGE[c] * (1 - starFraction) + WHITE[c] * starFraction));

  return [rgb[0], rgb[1], rgb[2], Math.round((hits / total) * 255)];
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Each scanline is prefixed with its filter byte; 0 means "no filter",
  // which costs a little size and removes a whole class of mistake.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
      raw[at++] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, png(size));
  console.log('wrote icons/icon' + size + '.png (' + fs.statSync(file).size + ' bytes)');
}
