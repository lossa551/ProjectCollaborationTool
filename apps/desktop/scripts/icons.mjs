// Draws the Foreus logo (concept D, "Interlock") into the icon files the app
// ships with: build/icon.ico for the installer and the .exe, build/icon.png for
// the window, and build/tray.png + tray@2x.png for the tray. The shapes are a
// few rectangles, so they are rasterized here with supersampling instead of
// pulling in an SVG renderer. build/logo.svg and build/icon.svg are the same
// shapes as vectors. Run with `npm run icons -w @pct/desktop` after changing
// them; the outputs are committed.
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../build/', import.meta.url));

// Colours: people are warm, agents are the app's blue.
const PERSON = [0xf0, 0xa9, 0x48];
const AGENT = [0x6c, 0x9b, 0xf2];
const TILE_TOP = [0x26, 0x2a, 0x33];
const TILE_BOTTOM = [0x16, 0x18, 0x1d];

// The mark, in a 64-unit box. Two pieces keyed together with a constant 4-unit
// gap, clipped by a rounded square.
const PERSON_PIECE = [[6, 6], [24, 6], [24, 26], [36, 26], [36, 38], [24, 38], [24, 58], [6, 58]];
const AGENT_PIECE = [[28, 6], [58, 6], [58, 58], [28, 58], [28, 42], [40, 42], [40, 22], [28, 22]];

function inRoundRect(x, y, left, top, size, radius) {
  if (x < left || y < top || x > left + size || y > top + size) return false;
  const dx = Math.max(left + radius - x, x - (left + size - radius), 0);
  const dy = Math.max(top + radius - y, y - (top + size - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Colour of the mark at (x, y) in its 64-unit box, or null. */
function markAt(x, y) {
  if (!inRoundRect(x, y, 6, 6, 52, 12)) return null;
  if (inPolygon(x, y, PERSON_PIECE)) return PERSON;
  if (inPolygon(x, y, AGENT_PIECE)) return AGENT;
  return null;
}

/** The app icon: the mark on a dark rounded tile, as in the drafts. */
function iconAt(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 14)) return null;
  // The mark sits in a 42-unit box at (11, 11).
  const mark = markAt(((x - 11) * 64) / 42, ((y - 11) * 64) / 42);
  if (mark) return [...mark, 1];
  const t = y / 64;
  const tile = TILE_TOP.map((c, i) => c + (TILE_BOTTOM[i] - c) * t);
  // A faint 1-unit light edge.
  if (!inRoundRect(x, y, 1, 1, 62, 13)) return tile.map((c) => c + (255 - c) * 0.08).concat(1);
  return [...tile, 1];
}

/** The tray glyph: the mark alone, cropped to its rounded square. */
function trayAt(x, y) {
  const mark = markAt(6 + (x * 52) / 64, 6 + (y * 52) / 64);
  return mark ? [...mark, 1] : null;
}

/** Renders a shape function over a 64-unit box into size×size RGBA, 8×8 samples per pixel. */
function render(shape, size) {
  const n = 8;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = shape(((px + (sx + 0.5) / n) * 64) / size, ((py + (sy + 0.5) / n) * 64) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const at = (py * size + px) * 4;
      if (a) rgba.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a * 255) / (n * n))], at);
    }
  }
  return rgba;
}

function png(rgba, size) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A Windows .ico holding one PNG per size (supported since Windows Vista). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((image) => image.data)]);
}

const icon = (size) => png(render(iconAt, size), size);

writeFileSync(`${out}icon.ico`, ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({ size, data: icon(size) }))));
writeFileSync(`${out}icon.png`, icon(512));
writeFileSync(`${out}tray.png`, png(render(trayAt, 16), 16));
writeFileSync(`${out}tray@2x.png`, png(render(trayAt, 32), 32));
console.log(`Icons written to ${out}`);
