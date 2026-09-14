// 零依赖 PNG 图标生成器:node tools/make-icons.js
// 产出 icons/icon16.png / icon48.png / icon128.png(圆角蓝底 + 白色 "T")
// 原理:手写最小 PNG 编码器(IHDR + IDAT + IEND,CRC32 查表),4x 超采样抗锯齿
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------- PNG 编码 ----------
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// pixelFn(x, y) -> [r, g, b, a]
function encodePNG(size, pixelFn) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter type 0 (none)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = 6;                 // color type: RGBA
  // 10/11/12 = compression/filter/interlace 默认 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 图形绘制(高分辨率坐标系) ----------
const BG = [79, 107, 237]; // #4F6BED

function inRoundRect(x, y, S) {
  const m = S * 0.02;       // 边距
  const r = S * 0.2;        // 圆角半径
  const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 字母 "T":顶横 + 中竖
function inT(x, y, S) {
  const gw = 5, gh = 6.2;        // 字形格子:5 宽 x 6.2 高(单位)
  const u = S * 0.1;             // 单位尺寸
  const x0 = (S - gw * u) / 2;
  const y0 = (S - gh * u) / 2;
  const gx = x - x0, gy = y - y0;
  if (gx < 0 || gy < 0 || gx > gw * u || gy > gh * u) return false;
  const bar = u * 1.35;          // 顶横厚度
  if (gy <= bar) return true;
  const stemW = u * 1.6;         // 竖杠宽度
  const stemX = (gw * u - stemW) / 2;
  return gx >= stemX && gx <= stemX + stemW;
}

// 4x 超采样:每个输出像素采样 16 个高分辨率点,按覆盖率混色
function makePixelFn(size) {
  const SS = 4;
  const S = size * SS;
  return (px, py) => {
    let bg = 0, fg = 0;
    const total = SS * SS;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px * SS + sx + 0.5;
        const y = py * SS + sy + 0.5;
        if (!inRoundRect(x, y, S)) continue;
        bg++;
        if (inT(x, y, S)) fg++;
      }
    }
    if (bg === 0) return [0, 0, 0, 0];
    const a = Math.round((bg / total) * 255);
    const t = fg / bg; // 白字覆盖率
    return [
      Math.round(BG[0] * (1 - t) + 255 * t),
      Math.round(BG[1] * (1 - t) + 255 * t),
      Math.round(BG[2] * (1 - t) + 255 * t),
      a,
    ];
  };
}

// ---------- 输出 ----------
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePNG(size, makePixelFn(size)));
  console.log('written:', file);
}
