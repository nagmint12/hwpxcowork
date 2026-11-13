#!/usr/bin/env node
// hwpx-cowork 아이콘 만들기(2026-10-31) — 파란 바탕 위 흰 문서와 보라 ✦(AI). rhwp 아이콘(rhwp-studio/public 의 favicon·icons)은 쓰지 않는다.
//   node scripts/make-icons.mjs
// → web/favicon.ico(16~256) · web/icons/icon.svg · web/icons/icon-{128,192,256,512}.png
// 웹 화면·편집기(/studio/ — scripts/build-studio.mjs 가 이 파일로 바꿔 넣음)·관리자 앱·바로 가기가 모두 이 아이콘을 쓴다.
// 외부 도구 없이 도형을 4×4 표본으로 칠해 PNG 를 만들고, ICO 에는 PNG 를 그대로 담는다(Windows Vista 이상).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');

// ── 도형(0~1 좌표) ─────────────────────────────────────────────────────────
const BLUE = [43, 91, 168]; const FOLD = [201, 214, 238]; const LINE = [157, 179, 218]; const PURPLE = [123, 63, 228]; const WHITE = [255, 255, 255];
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r); const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const polygon = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const star = (cx, cy, R, r) => polygon(Array.from({ length: 8 }, (_, k) => {
  const a = (Math.PI / 4) * k - Math.PI / 2; const rr = k % 2 ? r : R;
  return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
}));
const PAGE = [[0.27, 0.17], [0.6, 0.17], [0.73, 0.3], [0.73, 0.83], [0.27, 0.83]];
// 아래에 있는 것부터
const LAYERS = [
  [roundRect(0.04, 0.04, 0.96, 0.96, 0.2), BLUE],
  [polygon(PAGE), WHITE],
  [polygon([[0.6, 0.17], [0.6, 0.3], [0.73, 0.3]]), FOLD],
  [roundRect(0.35, 0.4, 0.65, 0.445, 0.02), LINE],
  [roundRect(0.35, 0.5, 0.65, 0.545, 0.02), LINE],
  [roundRect(0.35, 0.6, 0.52, 0.645, 0.02), LINE],
  [circle(0.71, 0.73, 0.155), PURPLE],
  [star(0.71, 0.73, 0.1, 0.035), WHITE],
];

function rgba(size) {
  const out = Buffer.alloc(size * size * 4); const S = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = (px + (sx + 0.5) / S) / size; const y = (py + (sy + 0.5) / S) / size;
      let hit = null;
      for (const [test, color] of LAYERS) if (test(x, y)) hit = color;
      if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a += 1; }
    }
    const o = (py * size + px) * 4; const n = S * S;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    out[o + 3] = Math.round((255 * a) / n);
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(size) {
  const px = rgba(size); const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const images = sizes.map((s) => [s, png(s)]);
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length); let offset = 6 + dir.length;
  images.forEach(([s, data], i) => {
    const o = i * 16; dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s; dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12); offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map(([, d]) => d)]);
}

const pts = (list, k = 512) => list.map(([x, y]) => `${Math.round(x * k)},${Math.round(y * k)}`).join(' ');
const starPts = Array.from({ length: 8 }, (_, k) => { const a = (Math.PI / 4) * k - Math.PI / 2; const rr = k % 2 ? 0.035 : 0.1; return [0.71 + rr * Math.cos(a), 0.73 + rr * Math.sin(a)]; });
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect x="20" y="20" width="472" height="472" rx="102" fill="${hex(BLUE)}"/>
<polygon points="${pts(PAGE)}" fill="#fff"/>
<polygon points="${pts([[0.6, 0.17], [0.6, 0.3], [0.73, 0.3]])}" fill="${hex(FOLD)}"/>
<rect x="179" y="205" width="154" height="23" rx="10" fill="${hex(LINE)}"/>
<rect x="179" y="256" width="154" height="23" rx="10" fill="${hex(LINE)}"/>
<rect x="179" y="307" width="87" height="23" rx="10" fill="${hex(LINE)}"/>
<circle cx="364" cy="374" r="79" fill="${hex(PURPLE)}"/>
<polygon points="${pts(starPts)}" fill="#fff"/>
</svg>
`;

fs.mkdirSync(path.join(webDir, 'icons'), { recursive: true });
fs.writeFileSync(path.join(webDir, 'favicon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(webDir, 'icons', 'icon.svg'), svg);
for (const s of [128, 192, 256, 512]) fs.writeFileSync(path.join(webDir, 'icons', `icon-${s}.png`), png(s));
console.log('아이콘: web/favicon.ico · web/icons/icon.svg · web/icons/icon-{128,192,256,512}.png');
