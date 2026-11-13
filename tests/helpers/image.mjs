// 시험용 그림 파일: 한 색으로 칠한 PNG(w×h, RGB)와 JPEG·GIF·BMP 머리(크기 읽기 시험용 — 그림 내용은 없다)
import zlib from 'node:zlib';

export function makePng(w, h, rgb = [31, 56, 100]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let i = 0; i < w * 3; i++) row[1 + i] = rgb[i % 3];
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** JPEG 머리: SOI · APP0(JFIF) · SOF0(h, w) — 크기만 읽힌다 */
export function jpegHead(w, h) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

export function gifHead(w, h) { return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]); }

export function bmpHead(w, h) {
  const b = Buffer.alloc(54); b.write('BM', 0, 'latin1'); b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); return b;
}
