/* Generate a macOS template menu-bar icon (black + alpha only) with no deps. */
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4, 0);
const set = (x, y, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  if (a > px[i + 3]) { px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = a; }
};
// speaker body + cone
for (let y = 12; y < 20; y++) for (let x = 5; x <= 10; x++) set(x, y, 255);
for (let y = 6; y < 26; y++) {
  const half = Math.round((Math.abs(y - 16) <= 10) ? 10 - Math.abs(y - 16) : -1);
  if (half >= 0) for (let x = 10; x <= 10 + (10 - half); x++) set(x, y, 255);
}
// two sound arcs
for (const [r, th] of [[6, 1.6], [9.5, 1.6]]) {
  for (let a = -0.85; a <= 0.85; a += 0.008) {
    const cx = 15 + Math.cos(a) * r, cy = 16 + Math.sin(a) * r;
    for (let dx = -th / 2; dx <= th / 2; dx += 0.4)
      for (let dy = -th / 2; dy <= th / 2; dy += 0.4) set(Math.round(cx + dx), Math.round(cy + dy), 255);
  }
}
// PNG encode
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
let TBL = null;
function crc32(buf) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'assets', 'trayTemplate@2x.png');
fs.writeFileSync(out, png);
fs.writeFileSync(out.replace('@2x', ''), png);
console.log('wrote', out, png.length, 'bytes');
