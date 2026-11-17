// 한/글 2022 CreatePageImage 독립 기준: 같은 90mm 표, inline pos.CENTER만으로는 x=113px,
// 소유 문단까지 CENTER이면 x=227px. 서버 표 편집 뒤 편집기와 같은 WASM 소비 경로로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';
import { rhwpLayout } from '../scripts/layout-trace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests/fixtures/inline-table-align-20261114');
const oracle = JSON.parse(fs.readFileSync(path.join(dir, 'oracle.json'), 'utf8'));
const baseline = async () => HwpxDoc.load(fs.readFileSync(path.join(dir, 'inline-left.hwpx')));
const align = (doc, value) => doc.formatRange('s0/p1', { start: 0, end: doc.inspectFormatting('s0/p1').length, paragraph: { align: value } });

test('글자처럼 표 align은 소유 문단도 바꾸고 dryRun은 원본을 보존한다', async () => {
  const doc = await baseline(), before = doc.sections[0].xml, header = doc.header.xml;
  const preview = doc.editTable('s0/p1', [{ op: 'table', align: 'CENTER' }], { dryRun: true });
  assert.equal(preview.undo.paragraphAlign.before, 'LEFT'); assert.equal(preview.undo.paragraphAlign.after, 'CENTER');
  assert.equal(doc.sections[0].xml, before); assert.equal(doc.header.xml, header);
  const fonts = doc.inspectFormatting('s0/p1').runs;
  const edited = doc.editTable('s0/p1', [{ op: 'table', align: 'CENTER' }]);
  assert.equal(doc.inspectFormatting('s0/p1').paragraph.align, 'CENTER');
  assert.deepEqual(doc.inspectFormatting('s0/p1').runs, fonts);
  doc.restoreTable('s0/p1', edited.before, edited.undo);
  assert.equal(doc.inspectFormatting('s0/p1').paragraph.align, 'LEFT');
});

test('표 되돌리기는 이후 셀 글·문단 다른 서식을 보존하고 정렬 충돌 때 부분 복원하지 않는다', async () => {
  const doc = await baseline(), edit = doc.editTable('s0/p1', [{ op: 'table', align: 'CENTER' }]);
  const ref = doc.tables()[0].cells[0].refs[0];
  doc.replaceTracked(ref, 0, 1, 'AFTER', { author: 'User' });
  doc.formatRange('s0/p1', { start: 0, end: 0, paragraph: { leftMarginPt: 7 } });
  doc.restoreTable('s0/p1', edit.before, edit.undo);
  assert.equal(doc.text(ref), 'AFTER'); assert.equal(doc.inspectFormatting('s0/p1').paragraph.leftMarginPt, 7);
  assert.equal(doc.inspectFormatting('s0/p1').paragraph.align, 'LEFT');
  const next = doc.editTable('s0/p1', [{ op: 'table', align: 'RIGHT' }]); align(doc, 'CENTER');
  const before = doc.sections[0].xml;
  assert.throws(() => doc.restoreTable('s0/p1', next.before, next.undo), { code: 'STALE' });
  assert.equal(doc.sections[0].xml, before, '문단 충돌이 있으면 표도 바꾸지 않음');
});

test('떠 있는 표와 글자처럼→떠 있는 전환은 표 위치를 쓰고 소유 문단 정렬을 보존한다', async () => {
  const doc = await baseline();
  const result = doc.editTable('s0/p1', [{ op: 'table', align: 'CENTER', treat_as_char: false }]);
  assert.equal(doc.inspectFormatting('s0/p1').paragraph.align, 'LEFT'); assert.equal(result.undo.paragraphAlign, undefined);
  assert.match(result.after, /horzAlign="CENTER"/); assert.match(result.after, /treatAsChar="0"/);
  const back = doc.editTable('s0/p1', [{ op: 'table', align: 'RIGHT', treat_as_char: true }]);
  assert.equal(doc.inspectFormatting('s0/p1').paragraph.align, 'RIGHT'); assert.ok(back.undo.paragraphAlign);
});

test('서버 편집 결과를 WASM이 계산한 표 x/폭이 한/글 독립 기준과 맞는다', async t => {
  const pkg = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
  const wasmHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm'))).digest('hex');
  t.diagnostic(`WASM SHA256 ${wasmHash}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-table-align-'));
  try {
    for (const [id, operation, expectedId] of [['before', null, 'inline-left'], ['after', { align: 'CENTER' }, 'inline-paragraph-center'], ['floating', { align: 'CENTER', treat_as_char: false }, 'floating-pos-center']]) {
      const doc = await baseline(); if (operation) doc.editTable('s0/p1', [{ op: 'table', ...operation }]);
      const file = path.join(work, id + '.hwpx'); fs.writeFileSync(file, await doc.save());
      const view = await rhwpLayout(file, pkg);
      const table = [...view.drawn.values()].flatMap(p => p.objects).find(p => p.type === 'Table');
      const expected = oracle.find(o => o.id === expectedId).tables[0][0];
      assert.ok(table, id + ': 실제 소비 경로에서 표 계산값 필요');
      assert.ok(Math.abs(table.x - expected[0]) <= 1.5, `${id}: x=${table.x}, 한/글=${expected[0]}`);
      assert.ok(Math.abs(table.w - (expected[2] - expected[0])) <= 1.5, `${id}: width=${table.w}, 한/글=${expected[2] - expected[0]}`);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
