import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { compressHwpx } from '../studio/performance/compress-hwpx.mjs';
import { HwpxDoc } from '../engine/doc.js';

globalThis.measureTextWidth ??= (_font, text) => text.length * 10;
const { default: engine } = await import('./helpers/rhwp.mjs');

for (const file of ['fixtures/tool_memo_tracked.hwpx', 'samples/2025년_전체종합보고서.hwpx']) {
  const url = new URL(file, import.meta.url);
  test(`engine snapshot and worker preserve all package parts: ${file}`, { skip: !fs.existsSync(url) }, async () => {
    const document = new engine.HwpDocument(fs.readFileSync(url));
    let reopened;
    try {
      assert.equal(typeof document.exportHwpxUncompressed, 'function', 'rebuild engine with the new export API');
      const regular = document.exportHwpx();
      const snapshot = document.exportHwpxUncompressed();
      const compressed = await compressHwpx(snapshot);
      const zipA = await JSZip.loadAsync(regular);
      const zipB = await JSZip.loadAsync(compressed);
      assert.deepEqual(Object.keys(zipB.files), Object.keys(zipA.files), 'package order');
      for (const name of Object.keys(zipA.files)) {
        assert.deepEqual(await zipB.files[name].async('uint8array'), await zipA.files[name].async('uint8array'), name);
      }
      const header = Buffer.from(compressed);
      assert.equal(header.readUInt16LE(8), 0);
      assert.equal(header.readUInt16LE(28), 0);
      assert.equal(header.subarray(30, 38).toString(), 'mimetype');
      reopened = new engine.HwpDocument(compressed);
      assert.equal(reopened.getSectionCount(), document.getSectionCount());
      const a = await HwpxDoc.load(regular);
      const b = await HwpxDoc.load(compressed);
      assert.deepEqual(b.paragraphs().map(p => [p.ref, p.text]), a.paragraphs().map(p => [p.ref, p.text]));
    } finally { reopened?.free(); document.free(); }
  });
}
