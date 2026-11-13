import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { HwpDocument } from './helpers/rhwp.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { pasteWithParagraphFormat } from '../studio/build/native-paste.mjs';

test('native paste: empty paragraph imports source style and direct paragraph overrides; occupied paragraph retains its format', async () => {
  const blank = fs.readFileSync(new URL('../server/templates/blank.hwpx', import.meta.url));
  const source = await HwpxDoc.load(blank);
  source.insertTracked('s0/p0', 0, '원본 문단', { author: '시험' }); source.acceptAll();
  source.formatRange('s0/p0', { start: 0, end: 5, paragraph: { lineSpacing: { type: 'PERCENT', value: 137 }, indentPt: 7, spaceBeforePt: 12 } });
  const bytes = new Uint8Array(await source.save());
  for (const occupied of [false, true]) {
    const target = new HwpDocument(blank);
    try {
      if (occupied) target.insertText(0, 0, 0, '기존 ');
      const before = (await HwpxDoc.load(target.exportHwpx())).inspectFormatting('s0/p0').paragraph;
      assert.equal(JSON.parse(pasteWithParagraphFormat(target, HwpDocument, 0, 0, '[]', occupied ? 3 : 0, bytes)).ok, true);
      const after = await HwpxDoc.load(target.exportHwpx());
      assert.deepEqual(after.inspectFormatting('s0/p0').paragraph, occupied ? before : source.inspectFormatting('s0/p0').paragraph);
      assert.equal(after.text('s0/p0'), occupied ? '기존 원본 문단' : '원본 문단');
    } finally { target.free(); }
  }
});

test('native paste: empty document retains unused source style definitions and snapshot undo/redo', async () => {
  const blank = fs.readFileSync(new URL('../server/templates/blank.hwpx', import.meta.url));
  const source = await JSZip.loadAsync(blank);
  const originalHeader = await source.file('Contents/header.xml').async('string');
  const styleNodes = [...originalHeader.matchAll(/<hh:style\b[^>]*\/>/g)];
  assert.ok(styleNodes.length > 1, 'source contains unused style definitions');
  const lastStyle = styleNodes.at(-1)[0];
  const renamed = lastStyle.replace(/\bname="[^"]*"/, 'name="SourceUnusedStyle"')
    .replace(/\bengName="[^"]*"/, 'engName="SourceUnusedStyle"');
  const sourceHeader = originalHeader.replace(lastStyle, renamed);
  source.file('Contents/header.xml', sourceHeader);
  const bytes = await source.generateAsync({ type: 'uint8array' });
  const definitions = header => [...header.matchAll(/<hh:style\b([^>]*?)\/>/g)].map(node =>
    Object.fromEntries([...node[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
  const headerOf = async doc => (await JSZip.loadAsync(doc.exportHwpx())).file('Contents/header.xml').async('string');
  const target = new HwpDocument(blank);
  try {
    const before = target.saveSnapshot();
    assert.equal(JSON.parse(pasteWithParagraphFormat(target, HwpDocument, 0, 0, '[]', 0, bytes)).ok, true);
    const actual = definitions(await headerOf(target));
    assert.equal(actual.length, definitions(sourceHeader).length, 'paste keeps source styles without destination template duplicates');
    assert.deepEqual(actual, definitions(sourceHeader), 'ids, definitions and next-style links remain source-owned');
    const after = target.saveSnapshot();
    target.restoreSnapshot(before);
    assert.deepEqual(definitions(await headerOf(target)), definitions(originalHeader), 'undo restores original styles');
    target.restoreSnapshot(after);
    assert.deepEqual(definitions(await headerOf(target)), definitions(sourceHeader), 'redo restores all source styles');
  } finally { target.free(); }
});
