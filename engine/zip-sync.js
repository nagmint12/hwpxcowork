// [hwpx-cowork] 동기 ZIP 읽기·쓰기 — 서버가 문서 큐 안(동기 제안 적용 _applyCore)에서 편집기 엔진(rhwp WASM)과 HWPX 를 주고받을 때 쓴다.
// 쓰기는 무압축(STORE — rhwp·한/글 모두 읽는다), 읽기는 무압축·deflate 항목만. 큰 파일(ZIP64)·암호는 다루지 않는다.
import zlib from 'node:zlib';
import { HwpxContainer } from './container.js';

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

/** HwpxContainer → ZIP 바이트(mimetype 먼저, 모두 STORE) */
export function writeZipSync(container) {
  const names = ['mimetype', ...container.order.filter((n) => n !== 'mimetype')].filter((n) => container.files.get(n) != null);
  const local = []; const central = []; let offset = 0;
  for (const name of names) {
    const data = Buffer.from(container.files.get(name));
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** ZIP 바이트 → HwpxContainer(파일 차례 = 중앙 목록 차례) */
export function readZipSync(bytes) {
  const b = Buffer.from(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP 끝 목록을 찾지 못했습니다');
  const count = u16(b, eocd + 10); let p = u32(b, eocd + 16);
  const files = new Map(); const order = [];
  for (let k = 0; k < count; k++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('ZIP 중앙 목록이 깨졌습니다');
    const method = u16(b, p + 10); const csize = u32(b, p + 20); const nlen = u16(b, p + 28); const xlen = u16(b, p + 30); const clen = u16(b, p + 32);
    const at = u32(b, p + 42); const name = b.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const dataAt = at + 30 + u16(b, at + 26) + u16(b, at + 28);
    const raw = b.subarray(dataAt, dataAt + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
    files.set(name, new Uint8Array(data)); order.push(name);
  }
  return new HwpxContainer(files, order);
}
