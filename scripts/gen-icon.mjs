// ============================================================
// 游迹 · 纯 Node 生成应用图标（PNG + ICO + 托盘小图标）
// 运行：node scripts/gen-icon.mjs
// ============================================================
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets');
mkdirSync(OUT, { recursive: true });

// ---------- PNG 编码（RGBA） ----------
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
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- ICO 容器（内嵌 PNG，256px） ----------
function encodeICO(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(1, 4); // count
  const dir = Buffer.alloc(16);
  dir[0] = 0; dir[1] = 0;           // width 256 -> 0
  dir[2] = 0; dir[3] = 0;           // height 256 -> 0
  dir[4] = 0;                        // colors
  dir[5] = 0;                        // reserved
  dir.writeUInt16LE(1, 6);           // planes
  dir.writeUInt16LE(32, 8);          // bpp
  dir.writeUInt32LE(png.length, 12); // size
  dir.writeUInt32LE(22, 16);         // offset (6+16)
  return Buffer.concat([header, dir, png]);
}

// ---------- 绘制辅助 ----------
function px(buf, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w || y >= w) return;
  const i = (y * w + x) * 4;
  // 简单 alpha 混合（覆盖）
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function distToSeg(px_, py_, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px_ - x1) * dx + (py_ - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px_ - cx, py_ - cy);
}
function roundedRectDist(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  const inside = Math.min(Math.max(dx, dy), 0);
  return Math.hypot(ax, ay) + inside - r;
}

// 主图标：圆角渐变方块 + 白色对勾
function drawIcon(size, { glow = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const hw = size * 0.40, hh = size * 0.40, r = size * 0.18;
  const c1 = [79, 124, 255], c2 = [139, 92, 246]; // 蓝 → 紫
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = roundedRectDist(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      if (d <= 1.2) {
        const t = (x + y) / (2 * size);
        const r_ = Math.round(c1[0] + (c2[0] - c1[0]) * t);
        const g_ = Math.round(c1[1] + (c2[1] - c1[1]) * t);
        const b_ = Math.round(c1[2] + (c2[2] - c1[2]) * t);
        const a = d <= 0 ? 255 : Math.round(255 * Math.max(0, 1 - (d - 0) / 1.2));
        px(buf, size, x, y, r_, g_, b_, a);
      } else if (glow && d <= 6) {
        const a = Math.round(90 * Math.max(0, 1 - (d - 1.2) / 4.8));
        px(buf, size, x, y, 99, 138, 255, a);
      }
    }
  }
  // 对勾（两段线，厚度 ~0.07*size）
  const th = Math.max(2, size * 0.07);
  const segs = [
    [size * 0.30, size * 0.52, size * 0.44, size * 0.66],
    [size * 0.44, size * 0.66, size * 0.72, size * 0.36],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [x1, y1, x2, y2] of segs) {
        const d = distToSeg(x + 0.5, y + 0.5, x1, y1, x2, y2);
        if (d <= th / 2) {
          const a = Math.round(255 * Math.min(1, (th / 2 - d) / 1.2 + 0.4));
          px(buf, size, x, y, 255, 255, 255, a);
          break;
        }
      }
    }
  }
  return buf;
}

// 托盘图标：圆形底 + 对勾（透明背景）
function drawTray(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, R = size * 0.46;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= R) {
        const t = (x + y) / (2 * size);
        const r = Math.round(79 + (139 - 79) * t);
        const g = Math.round(124 + (92 - 124) * t);
        const b = Math.round(255 + (246 - 255) * t);
        const a = d <= R - 1 ? 255 : Math.round(255 * (R - d));
        px(buf, size, x, y, r, g, b, a);
      }
    }
  }
  const th = Math.max(2, size * 0.10);
  const segs = [
    [size * 0.28, size * 0.52, size * 0.43, size * 0.68],
    [size * 0.43, size * 0.68, size * 0.74, size * 0.34],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [x1, y1, x2, y2] of segs) {
        if (distToSeg(x + 0.5, y + 0.5, x1, y1, x2, y2) <= th / 2) {
          px(buf, size, x, y, 255, 255, 255, 255);
          break;
        }
      }
    }
  }
  return buf;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const icoParts = [];
for (const s of sizes) icoParts.push(encodePNG(s, s, drawIcon(s)));
// ICO 支持多尺寸：PNG 内嵌需每条 16 字节目录项
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoParts.length, 4);
let offset = 6 + 16 * icoParts.length;
const dirEntries = icoParts.map((png, i) => {
  const s = sizes[i];
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e.writeUInt16LE(1, 6);
  e.writeUInt16LE(32, 8);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...dirEntries, ...icoParts]));
writeFileSync(join(OUT, 'icon.png'), encodePNG(256, 256, drawIcon(256)));
writeFileSync(join(OUT, 'tray.png'), encodePNG(32, 32, drawTray(32)));
console.log('已生成 assets/icon.ico, assets/icon.png, assets/tray.png');
