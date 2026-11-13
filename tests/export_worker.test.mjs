import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { compressHwpx } from '../studio/performance/compress-hwpx.mjs';

async function assertPartsEqual(left, right) {
  const a = await JSZip.loadAsync(left);
  const b = await JSZip.loadAsync(right);
  assert.deepEqual(Object.keys(b.files).sort(), Object.keys(a.files).sort());
  for (const name of Object.keys(a.files)) {
    assert.deepEqual(await b.files[name].async('uint8array'), await a.files[name].async('uint8array'), name);
  }
  const bytes = Buffer.from(right);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0, 'first entry is STORED');
  const nameLen = bytes.readUInt16LE(26);
  assert.equal(bytes.subarray(30, 30 + nameLen).toString(), 'mimetype');
  assert.equal(bytes.readUInt16LE(28), 0, 'mimetype has no extra field');
}

test('worker compression keeps HWPX parts byte-for-byte and mimetype first/STORED', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file('Contents/section0.xml', '<section>한글 조합·서식·😀</section>', { createFolders: false });
  zip.file('BinData/image1.png', new Uint8Array([0, 255, 4, 128, 0, 5]), { createFolders: false });
  const snapshot = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  await assertPartsEqual(snapshot, await compressHwpx(snapshot));
});

test('worker compression keeps real tracked document fields and package parts', async () => {
  const original = fs.readFileSync(new URL('./fixtures/tool_memo_tracked.hwpx', import.meta.url));
  await assertPartsEqual(original, await compressHwpx(original));
});

test('worker rejects a non-HWPX ZIP', async () => {
  const zip = new JSZip();
  zip.file('document.txt', 'not HWPX');
  await assert.rejects(() => zip.generateAsync({ type: 'uint8array' }).then(compressHwpx), /mimetype/);
});
