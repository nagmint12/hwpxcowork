// PNG는 머리의 크기뿐 아니라 모든 청크 CRC·압축 스트림을 검사한다. 원본은 재인코딩하지 않는다.
import { inflateSync } from 'node:zlib';
import { imageInfo } from '../engine/picture.js';

const bad = () => Object.assign(new Error('그림 파일이 손상됐거나 지원하지 않는 형식입니다. 원본 파일을 다시 전달해 주세요.'), { code: 'BAD_IMAGE' });
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let n = 0; n < 8; n++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); return value >>> 0; });
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; };
export function validateImage(bytes) {
  const b = Buffer.from(bytes || []), info = imageInfo(b);
  if (!info) throw bad();
  if (info.ext !== 'png') return info;
  if (!b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw bad();
  const data = []; let at = 8, ended = false, ihdr = null;
  while (at < b.length) {
    if (at + 12 > b.length) throw bad();
    const n = b.readUInt32BE(at), end = at + n + 12;
    if (end > b.length || n > 10 * 1048576) throw bad();
    const type = b.toString('ascii', at + 4, at + 8);
    if (crc32(b.subarray(at + 4, at + 8 + n)) !== b.readUInt32BE(at + 8 + n)) throw bad();
    if (at === 8 && (type !== 'IHDR' || n !== 13)) throw bad();
    if (type === 'IHDR') { if (ihdr) throw bad(); ihdr = b.subarray(at + 8, at + 8 + n); }
    if (type === 'IDAT') data.push(b.subarray(at + 8, at + 8 + n));
    if (type === 'IEND') { if (n || end !== b.length) throw bad(); ended = true; }
    at = end;
  }
  if (!ended || !ihdr || !data.length) throw bad();
  try {
    const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: 128 * 1048576 });
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr[9]];
    if (!channels || ![1, 2, 4, 8, 16].includes(ihdr[8]) || ihdr[10] || ihdr[11] || ihdr[12] > 1) throw bad();
    if (!ihdr[12]) {
      const stride = Math.ceil(info.width * channels * ihdr[8] / 8) + 1;
      if (decoded.length !== stride * info.height) throw bad();
      for (let i = 0; i < decoded.length; i += stride) if (decoded[i] > 4) throw bad();
    }
  } catch { throw bad(); }
  return info;
}
