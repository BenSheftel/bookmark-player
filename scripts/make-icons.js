// Generates PNG icons (no dependencies). Usage:
//   node scripts/make-icons.js            -> www/icons/*
//   node scripts/make-icons.js android    -> also overwrites android launcher icons + splash
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x16, 0x1b, 0x22], ACCENT = [0xf5, 0xa5, 0x24], WHITE = [0xff, 0xff, 0xff];

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Shapes in unit space (0..1) around a centred glyph; `scale` shrinks the glyph about the centre.
function sample(u, v, { bg, scale }) {
  // background mask
  let inBg = false;
  if (bg === 'square') inBg = true;
  else if (bg === 'circle') inBg = (u - .5) ** 2 + (v - .5) ** 2 <= .25;
  else if (bg === 'rounded') { const r = .22, dx = Math.max(Math.abs(u - .5) - (.5 - r), 0), dy = Math.max(Math.abs(v - .5) - (.5 - r), 0); inBg = dx * dx + dy * dy <= r * r; }
  // glyph coords
  const x = (u - .5) / scale + .5, y = (v - .5) / scale + .5;
  // play triangle (white) on top of ribbon
  const tri = [[.445, .34], [.445, .52], [.59, .43]];
  const sgn = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d1 = sgn([x, y], tri[0], tri[1]), d2 = sgn([x, y], tri[1], tri[2]), d3 = sgn([x, y], tri[2], tri[0]);
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return WHITE;
  // bookmark ribbon
  if (x >= .34 && x <= .66 && y >= .2) {
    const notch = .80 - .14 * (1 - Math.abs(x - .5) / .16);
    if (y <= notch) return ACCENT;
  }
  return inBg ? BG : null;
}

function render(w, h, opts) {
  const SS = 4, buf = Buffer.alloc(w * h * 4);
  const side = Math.min(w, h), ox = (w - side) / 2, oy = (h - side) / 2;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (px + (sx + .5) / SS - ox) / side, v = (py + (sy + .5) / SS - oy) / side;
      let c = (u >= 0 && u <= 1 && v >= 0 && v <= 1) ? sample(u, v, opts) : null;
      if (!c && opts.fill) c = BG;
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * w + px) * 4, n = SS * SS;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = 255 * a / n; }
  }
  return png(w, h, buf);
}

const root = path.join(__dirname, '..');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); console.log('wrote', path.relative(root, file)); };

for (const s of [180, 192, 512]) write(path.join(root, 'www/icons', `icon-${s}.png`), render(s, s, { bg: 'square', scale: .9 }));

if (process.argv[2] === 'android') {
  const res = path.join(root, 'android/app/src/main/res');
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(res, `mipmap-${d}`);
    write(path.join(dir, 'ic_launcher.png'), render(48 * k, 48 * k, { bg: 'rounded', scale: .9 }));
    write(path.join(dir, 'ic_launcher_round.png'), render(48 * k, 48 * k, { bg: 'circle', scale: .85 }));
    write(path.join(dir, 'ic_launcher_foreground.png'), render(108 * k, 108 * k, { bg: 'none', scale: .62 }));
  }
  // adaptive icon background colour
  const bgXml = path.join(res, 'values/ic_launcher_background.xml');
  write(bgXml, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#161B22</color>\n</resources>\n');
  // splash screens: keep each file's size, replace content
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(res).filter(f => path.basename(f) === 'splash.png')) {
    const b = fs.readFileSync(f), w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    write(f, render(w, h, { bg: 'none', scale: .25, fill: true }));
  }
}
