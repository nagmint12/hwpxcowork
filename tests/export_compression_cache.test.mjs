import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { compressHwpx, HwpxCompressionCache } from '../studio/performance/compress-hwpx.mjs';

const require = createRequire(import.meta.url);
const pako = require('pako');
async function packageBytes(parts, compression = 'STORE') {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  for (const [name, bytes] of Object.entries(parts)) zip.file(name, bytes, { createFolders: false, compression });
  return zip.generateAsync({ type: 'uint8array' });
}
async function parts(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return Object.fromEntries(await Promise.all(Object.entries(zip.files).map(async ([name, entry]) => [name, await entry.async('uint8array')])));
}
async function countDeflates(fn) {
  const Original = pako.Deflate; let count = 0;
  pako.Deflate = function (...args) { count++; return new Original(...args); };
  pako.Deflate.prototype = Original.prototype;
  try { return { result: await fn(), count }; } finally { pako.Deflate = Original; }
}

test('opening original ZIP primes unchanged image reuse on the first save', async () => {
  const image = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
  const original = await packageBytes({ 'Contents/section0.xml': 'before', 'BinData/image.bmp': image }, 'DEFLATE');
  const snapshot = await packageBytes({ 'Contents/section0.xml': 'after!', 'BinData/image.bmp': image });
  const cache = new HwpxCompressionCache();
  await cache.prime(original);
  const { result, count } = await countDeflates(() => compressHwpx(snapshot, cache));
  assert.equal(count, 1, 'only the changed XML is compressed');
  assert.deepEqual(cache.lastRun, { reusedEntries: 1, compressedEntries: 1 });
  assert.deepEqual(await parts(result), await parts(snapshot));
  // Production transfers result.buffer back to the main thread. The retained
  // compressed payloads must own their memory after that buffer is detached.
  structuredClone(result, { transfer: [result.buffer] });
  assert.equal(result.byteLength, 0);
  const again = await countDeflates(() => compressHwpx(snapshot, cache));
  assert.equal(again.count, 0);
  assert.deepEqual(await parts(again.result), await parts(snapshot));
});

test('equal size/CRC metadata cannot reuse different content; add/remove entries stay exact', async () => {
  const cache = new HwpxCompressionCache();
  const before = await packageBytes({ 'a.xml': 'same-size-before', 'removed.xml': 'remove' });
  await compressHwpx(before, cache);
  const after = await packageBytes({ 'a.xml': 'same-size-after!', 'added.xml': 'added' });
  const incoming = await JSZip.loadAsync(after);
  cache.entries.get('a.xml').compressed.crc32 = incoming.files['a.xml']._data.crc32;
  assert.equal(cache.entries.get('a.xml').raw.length, incoming.files['a.xml']._data.uncompressedSize);
  const { result, count } = await countDeflates(() => compressHwpx(after, cache));
  assert.equal(count, 2);
  assert.deepEqual(await parts(result), await parts(after));
  assert.equal(cache.entries.has('removed.xml'), false);
});

test('cache owns primed input and stays within its raw plus compressed byte limit', async () => {
  const cache = new HwpxCompressionCache({ maxBytes: 300 });
  const original = await packageBytes({ 'a.xml': 'A'.repeat(150), 'b.xml': 'B'.repeat(150) }, 'DEFLATE');
  const snapshot = await packageBytes({ 'a.xml': 'A'.repeat(150), 'b.xml': 'B'.repeat(150) });
  await cache.prime(original);
  original.fill(0);
  assert.equal(cache.stats.entries, 1);
  assert.ok(cache.stats.bytes <= 300);
  const result = await compressHwpx(snapshot, cache);
  assert.deepEqual(await parts(result), await parts(snapshot));
  assert.ok(cache.stats.bytes <= 300);
  cache.clear();
  assert.deepEqual(cache.stats, { entries: 0, bytes: 0, maxBytes: 300 });
});

test('zero cache budget preserves normal compression and invalid prime discards old document', async () => {
  const snapshot = await packageBytes({ 'a.xml': 'payload' });
  const cache = new HwpxCompressionCache({ maxBytes: 0 });
  const first = await compressHwpx(snapshot, cache);
  assert.deepEqual(await parts(first), await parts(snapshot));
  assert.equal(cache.stats.entries, 0);
  await assert.rejects(cache.prime(new Uint8Array([1, 2, 3])));
  assert.equal(cache.stats.entries, 0);
});
