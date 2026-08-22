#!/usr/bin/env node
/* Generate tray and app icons with no image dependencies.
   macOS wants a template icon (black + alpha) which the OS inverts to match the
   menu bar. Windows does no such thing, so a black icon would vanish against a
   dark taskbar - it gets a white glyph with a dark halo, legible on both light
   and dark themes. */
const zlib = require('zlib'), fs = require('fs'), path = require('path');

function canvas(W, H) {
  const px = Buffer.alloc(W * H * 4, 0);
  return {
    W, H, px,
    set(x, y, r, g, b, a) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
      const i = (y * W + x) * 4;
      if (a >= px[i + 3]) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
    },
  };
}

/* Speaker body + cone + two arcs, defined as membership tests in a 32x32 design
   space rather than painted with a brush, so it stays crisp at any output size. */
function inGlyph(x, y, grow) {
  const body = x >= 5 - grow && x <= 10 + grow && y >= 12 - grow && y <= 20 + grow;
  const t = (x - 10) / 7;                       // 0 at the apex, 1 at the mouth
  const cone = t >= -grow / 7 && x <= 17 + grow && Math.abs(y - 16) <= t * 11 + grow;
  const dx = x - 17, dy = y - 16;
  const d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  const arcs = Math.abs(ang) < 0.95 &&
    (Math.abs(d - 6) <= 0.85 + grow || Math.abs(d - 9.5) <= 0.85 + grow);
  return body || cone || arcs;
}

function glyph(c, s, col, grow = 0) {
  const k = s / 32, [r, g, b, a] = col;
  for (let py = 0; py < s; py++) for (let px = 0; px < s; px++)
    if (inGlyph((px + 0.5) / k, (py + 0.5) / k, grow)) c.set(px, py, r, g, b, a);
}

function roundedRect(c, s, rad, col) {
  const [r, g, b, a] = col;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = Math.max(rad - x, x - (s - 1 - rad), 0);
    const dy = Math.max(rad - y, y - (s - 1 - rad), 0);
    if (dx * dx + dy * dy <= rad * rad) c.set(x, y, r, g, b, a);
  }
}

// ---- PNG encoding ----
let TBL = null;
function crc32(buf) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(c) {
  const raw = Buffer.alloc((c.W * 4 + 1) * c.H);
  for (let y = 0; y < c.H; y++) {
    raw[y * (c.W * 4 + 1)] = 0;
    c.px.copy(raw, y * (c.W * 4 + 1) + 1, y * c.W * 4, (y + 1) * c.W * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.W, 0); ihdr.writeUInt32BE(c.H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });
const write = (name, c) => { fs.writeFileSync(path.join(OUT, name), png(c)); console.log('  ' + name); };

// macOS template: black + alpha, the OS inverts it for the menu bar
for (const [name, size] of [['trayTemplate.png', 32], ['trayTemplate@2x.png', 32]]) {
  const c = canvas(size, size); glyph(c, size, [0, 0, 0, 255]); write(name, c);
}
// Windows: white glyph over a soft dark halo so it reads on light AND dark taskbars
{
  const s = 32, c = canvas(s, s);
  glyph(c, s, [0, 0, 0, 120], 1.1);          // halo first
  glyph(c, s, [255, 255, 255, 255], 0);      // glyph on top
  write('tray-win.png', c);
}
// app icon for the taskbar / window / installer
{
  const s = 512, c = canvas(s, s);
  roundedRect(c, s, Math.round(s * 0.22), [47, 109, 246, 255]);
  glyph(c, s, [255, 255, 255, 255], 0.3);
  write('icon.png', c);
}
console.log('icons written');
