// The link-preview card — public/og.png, the picture Discord and Slack and
// iMessage put under a shared link. They all read Open Graph tags and none of
// them will render an SVG in an embed, so the one drawing this project owns has
// to arrive as pixels. Rather than check in a PNG that nobody can regenerate,
// this draws it: same locomotive as the marker and the brand mark, same
// coordinates, so the card cannot drift away from the artwork it depicts.
//
// Nothing here is clever. A shape is an inside-test in the icon's own 72×48
// space, coverage comes from supersampling that test, and the PNG is assembled
// by hand because zlib is in the standard library and a rasteriser is not worth
// a dependency. It knows nothing about the game.
//
//   npm run og
//
// Re-run it after changing the icon in client/tiles.ts, and commit the result.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 1200×630 is what every scraper crops to, and the size the tags below promise.
const W = 1200, H = 630;

type RGB = readonly [number, number, number];
const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as unknown as RGB;

const BG = hex('#0b0e14');       // the app's own ground
const GOLD = hex('#f0b429');
const RAIL = hex('#262d3d');     // --line, for the track running off both edges

// The icon is 72 wide; this leaves it a comfortable margin on a wide card.
const SCALE = 8.2;
const TX = (W - 72 * SCALE) / 2, TY = (H - 48 * SCALE) / 2;

const pixels = new Uint8Array(W * H * 3);

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function blend(x: number, y: number, c: RGB, alpha: number): void {
  const i = (y * W + x) * 3;
  for (let k = 0; k < 3; k++) pixels[i + k] = Math.round(pixels[i + k] + (c[k] - pixels[i + k]) * alpha);
}

// ── shapes ───────────────────────────────────────────────────────────────────
// Each returns a predicate in icon coordinates. Everything in the drawing is a
// rounded rectangle or a circle, which is why the whole rasteriser fits here.

type Hit = (x: number, y: number) => boolean;

const rrect = (x: number, y: number, w: number, h: number, r: number): Hit => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  // Nearest point of the inner rectangle the corner radii sweep around.
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

const ring = (cx: number, cy: number, r: number, hole: number): Hit => (px, py) => {
  const d = (px - cx) ** 2 + (py - cy) ** 2;
  return d <= r * r && d > hole * hole;
};

const any = (...hs: Hit[]): Hit => (x, y) => hs.some((h) => h(x, y));
const cut = (a: Hit, b: Hit): Hit => (x, y) => a(x, y) && !b(x, y);

// The locomotive from client/tiles.ts, shape for shape. It is drawn as one
// union rather than as nine separate fills: painting overlapping pieces one at
// a time leaves a pale hairline everywhere two anti-aliased edges meet.
const LOCO = any(
  rrect(3, 32, 66, 5, 2.5),                                  // the rail it stands on
  rrect(7, 16, 36, 16, 8),                                   // boiler
  rrect(27, 11.5, 8, 6.5, 3.2),                              // steam dome
  rrect(14, 9, 6.6, 8, 1),                                   // funnel
  rrect(11.6, 4.6, 11.4, 4.6, 1.7),                          // funnel cap
  rrect(37.5, 7.4, 29, 5, 2.2),                              // cab roof
  cut(rrect(40, 8, 24, 24, 3), rrect(45, 15, 14, 10, 2)),    // cab, window cut through
  rrect(28.5, 42.2, 23, 2.2, 1.1),                           // coupling rod
  ring(29.5, 40, 6, 1.8),
  ring(51, 40, 6, 1.8),
  ring(13, 41.6, 4.4, 1.4),
);

// Track running the full width, behind everything: the card is wider than the
// icon, and a train whose rail stops short of the frame looks derailed.
const TRACK = rrect(-200, 32, 400, 5, 2.5);

// ── painting ─────────────────────────────────────────────────────────────────

const SS = 4;   // 4×4 samples a pixel; the wheels are the test, and they pass

function coverage(hit: Hit, x: number, y: number): number {
  let n = 0;
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) {
      if (hit((x + (j + 0.5) / SS - TX) / SCALE, (y + (i + 0.5) / SS - TY) / SCALE)) n++;
    }
  }
  return n / (SS * SS);
}

function paint(hit: Hit, color: RGB, top: number, bottom: number, fade: (x: number) => number = () => 1): void {
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(H, Math.ceil(bottom)); y++) {
    for (let x = 0; x < W; x++) {
      const a = coverage(hit, x, y) * fade(x);
      if (a > 0) blend(x, y, color, a);
    }
  }
}

// The track only shows beyond the locomotive's own rail, and a hard stub of it
// against the frame reads as a mistake — so it thins away towards both edges.
const offFrame = (x: number): number => Math.min(1, (0.5 - Math.abs(x / W - 0.5)) * 3.2);

// A wash of the gold behind the train, strongest at its middle. Subtle enough
// to read as depth rather than as a light source: the drawing is a silhouette
// and stays one.
function background(): void {
  const cx = W / 2, cy = H / 2, reach = W * 0.42;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / reach) ** 2;
      blend(x, y, mix(BG, GOLD, t * 0.14), 1);
    }
  }
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, sum]);
}

// Filter 1 (Sub) rather than none: most of this image is a smooth horizontal
// gradient, where the difference from the pixel to the left is nearly always
// zero and deflate can say so in a fraction of the bytes.
function scanlines(): Buffer {
  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let i = 0; i < stride; i++) raw[row + 1 + i] = pixels[y * stride + i] - (i >= 3 ? pixels[y * stride + i - 3] : 0);
  }
  return raw;
}

function png(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bits a channel
  ihdr[9] = 2;    // truecolour, no alpha — the card is opaque
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

background();
paint(TRACK, RAIL, TY + 32 * SCALE, TY + 37 * SCALE, offFrame);
paint(LOCO, GOLD, TY, TY + 48 * SCALE);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og.png');
const buf = png();
writeFileSync(out, buf);
console.log(`${out}  ${W}×${H}  ${(buf.length / 1024).toFixed(1)} KB`);
