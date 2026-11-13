// 그림 형식 맞추기: AI 모델이 받지 않는 BMP 를 보기용 PNG 로 바꾼다(문서·첨부의 원본 바이트는 그대로 둔다).
// OpenAI·Claude·Gemini 의 그림 입력은 PNG·JPEG·GIF·WebP 만 받는다 — BMP 를 그대로 보내면 API 가 요청 전체를 400 으로 거절한다.
//   bmpToPng(bytes) → PNG Buffer(무손실). 1·4·8비트 색표, 16·24·32비트(BI_RGB·BITFIELDS), RLE8·RLE4 를 읽는다.
//   imageForModel(bytes, mime) → { bytes, mime, converted? } | null(모델에 보낼 수 없는 형식)
import zlib from 'node:zlib';
import { imageInfo } from '../engine/picture.js';

const MODEL_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_PIXELS = 50 * 1000 * 1000;
const bad = (message = 'BMP 그림을 읽지 못했습니다') => Object.assign(new Error(message), { code: 'BAD_IMAGE' });

/** BMP → { width, height, rgba: Buffer, alpha: boolean } */
export function decodeBmp(input) {
  const b = Buffer.from(input || []);
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) throw bad();
  const dataAt = b.readUInt32LE(10); const hdr = b.readUInt32LE(14);
  const core = hdr === 12;
  if (!core && hdr < 40) throw bad();
  const width = core ? b.readUInt16LE(18) : b.readInt32LE(18);
  const rawH = core ? b.readInt16LE(20) : b.readInt32LE(22);
  const bpp = core ? b.readUInt16LE(24) : b.readUInt16LE(28);
  const compression = core ? 0 : b.readUInt32LE(30);
  const topDown = rawH < 0; const height = Math.abs(rawH);
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) throw bad('BMP 그림 크기가 너무 크거나 잘못되었습니다');
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw bad(`지원하지 않는 BMP 색 깊이입니다(${bpp}비트)`);
  // 색 마스크: BITFIELDS(3)·ALPHABITFIELDS(6) — INFO 머리(40)는 머리 바로 뒤, V4·V5 는 머리 안(같은 자리)
  let masks = null;
  if (compression === 3 || compression === 6) {
    if (b.length < 66) throw bad();
    masks = [b.readUInt32LE(54), b.readUInt32LE(58), b.readUInt32LE(62), hdr >= 56 || compression === 6 ? b.readUInt32LE(66) : 0];
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  else if (compression !== 0 && compression !== 1 && compression !== 2) throw bad('지원하지 않는 BMP 압축 방식입니다');
  // 색표(1·4·8비트): 머리(+INFO 의 마스크 12·16바이트) 뒤
  const palette = [];
  if (bpp <= 8) {
    const entry = core ? 3 : 4;
    const used = !core && b.readUInt32LE(46) ? b.readUInt32LE(46) : 1 << bpp;
    const at = 14 + hdr + (hdr === 40 && compression === 3 ? 12 : hdr === 40 && compression === 6 ? 16 : 0);
    for (let i = 0; i < Math.min(used, 256); i++) {
      const o = at + i * entry;
      if (o + 3 > b.length) break;
      palette.push([b[o + 2], b[o + 1], b[o]]);
    }
    if (!palette.length) throw bad();
  }
  const rgba = Buffer.alloc(width * height * 4);
  const put = (x, y, r, g, bl, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const row = topDown ? y : height - 1 - y; const o = (row * width + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = a;
  };
  const index = (x, y, i) => { const c = palette[i] || [0, 0, 0]; put(x, y, c[0], c[1], c[2]); };
  if (compression === 1 || compression === 2) {
    // RLE: 아래 줄부터(아래→위 BMP 만). 빠진 자리는 색표 0
    if (topDown) throw bad();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) index(x, y, 0);
    const four = compression === 2;
    let i = dataAt; let x = 0; let y = 0;
    while (i + 1 < b.length && y < height) {
      const n = b[i]; const v = b[i + 1]; i += 2;
      if (n > 0) {
        for (let k = 0; k < n; k++) index(x++, y, four ? (k % 2 ? v & 15 : v >> 4) : v);
      } else if (v === 0) { x = 0; y++; }
      else if (v === 1) break;
      else if (v === 2) { if (i + 1 >= b.length) break; x += b[i]; y += b[i + 1]; i += 2; }
      else {
        const bytes = four ? Math.ceil(v / 2) : v;
        for (let k = 0; k < v; k++) {
          const byte = b[i + (four ? k >> 1 : k)];
          index(x++, y, four ? (k % 2 ? byte & 15 : byte >> 4) : byte);
        }
        i += bytes + (bytes % 2);
      }
    }
    return { width, height, rgba, alpha: false };
  }
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataAt + stride * (height - 1) + Math.ceil((bpp * width) / 8) > b.length) throw bad('BMP 그림 자료가 잘렸습니다');
  // 마스크 하나 → (값, 8비트 값)
  const channel = (mask) => {
    if (!mask) return null;
    let shift = 0; while (!((mask >>> shift) & 1)) shift++;
    const max = mask >>> shift;
    return (v) => Math.round((((v & mask) >>> shift) * 255) / max);
  };
  const [cr, cg, cb, ca] = masks ? masks.map(channel) : [];
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = dataAt + y * stride;
    for (let x = 0; x < width; x++) {
      if (bpp <= 8) {
        const bit = x * bpp; const byte = b[row + (bit >> 3)];
        index(x, y, bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1));
      } else if (bpp === 24) {
        const o = row + x * 3; put(x, y, b[o + 2], b[o + 1], b[o]);
      } else if (bpp === 32 && !masks) {
        const o = row + x * 4; const a = b[o + 3]; if (a) anyAlpha = true;
        put(x, y, b[o + 2], b[o + 1], b[o], a);
      } else {
        const v = bpp === 16 ? b.readUInt16LE(row + x * 2) : b.readUInt32LE(row + x * 4);
        const a = ca ? ca(v) : 255; if (ca && a) anyAlpha = true;
        put(x, y, cr(v), cg(v), cb(v), a);
      }
    }
  }
  // 32비트 BI_RGB 의 네 번째 바이트는 대개 쓰지 않는 자리(0) — 모두 0 이면 불투명으로 본다
  const alphaChannel = bpp === 32 && (masks ? !!ca : true);
  if (alphaChannel && !anyAlpha) for (let o = 3; o < rgba.length; o += 4) rgba[o] = 255;
  return { width, height, rgba, alpha: alphaChannel && anyAlpha };
}

/** RGBA → PNG(투명이 없으면 RGB) */
export function encodePng({ width, height, rgba, alpha = true }) {
  const channels = alpha ? 4 : 3; const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const at = y * stride; raw[at] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4; const d = at + 1 + x * channels;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export function bmpToPng(bytes) { return encodePng(decodeBmp(bytes)); }

/**
 * 모델에 보낼 그림: PNG·JPEG·GIF·WebP 는 그대로, BMP 는 PNG 로 → { bytes, mime, converted? }. 보낼 수 없으면 null
 * (mime 은 첨부 기록의 것 — 실제 바이트가 BMP 면 이름과 상관없이 바꾼다)
 */
export function imageForModel(bytes, mime = '') {
  const buf = Buffer.from(bytes || []);
  const info = imageInfo(buf);
  if (info?.ext === 'bmp') {
    try { return { bytes: bmpToPng(buf), mime: 'image/png', converted: 'bmp' }; } catch { return null; }
  }
  if (info) return { bytes: buf, mime: info.ext === 'jpg' ? 'image/jpeg' : info.mime };
  return MODEL_MIMES.has(String(mime)) ? { bytes: buf, mime: String(mime) } : null;
}
