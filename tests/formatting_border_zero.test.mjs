import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { liveFixture } from './helpers/live-batch.mjs';
import * as wasm from '../vendor/rhwp/pkg/rhwp.js';

wasm.initSync({ module: fs.readFileSync('vendor/rhwp/pkg/rhwp_bg.wasm') });
const user = { name: '시험 작성자', role: 'admin' };
async function document() {
  const base = await HwpxDoc.load(fs.readFileSync('server/templates/blank.hwpx'));
  base.insertTableAfter(0, 0, { rows: [['크기😀', '이웃 셀'], ['둘째 줄', '보존']] }, { author: user.name });
  base.acceptAll();
  // HWPX 테두리/채움은 1부터 번호를 붙이고 0은 '없음'이다.
  // 실제 문서처럼 charPr에 0을 참조하되 borderFill 정의 0은 만들지 않는다.
  base.header.xml = base.header.xml.replace(/<hh:charPr\b[^>]*>/g, tag => tag.replace(/height="\d+"/, 'height="1100"').replace(/borderFillIDRef="\d+"/, 'borderFillIDRef="0"'));
  assert.equal(base.header.block('borderFill', '0'), null);
  return base;
}
const sizes = (d, ref) => d.inspectFormatting(ref).runs.map(r => r.char.sizePt);

test('WASM 표 셀 11→12pt가 테두리 없음(0)을 보존하며 실시간 저장되고 재전송은 중복되지 않는다', async () => {
  const base = await document(); const bytes = await base.save(); const table = base.tables()[0];
  const ref = table.cells[0].refs[0], neighbor = table.cells[1].refs[0];
  const w = new wasm.HwpDocument(bytes);
  let head;
  try {
    w.applyCharFormatInCell(0, 1, 0, 0, 0, 0, w.getCellParagraphLength(0, 1, 0, 0, 0), JSON.stringify({ fontSize: 1200 }));
    head = w.exportHwpx();
  } finally { w.free(); }
  const source = await HwpxDoc.load(head); assert.deepEqual(sizes(source, ref), [12]);
  const f = await liveFixture(bytes, { track: 'final' });
  try {
    const version = f.service._meta(f.id).version;
    const result = await f.live.push(f.id, head, { base: version, seq: 1001, user });
    assert.equal(result.clean, true); assert.deepEqual(result.applied.changed, [ref]);
    const saved = await HwpxDoc.load(f.store.currentBytes(f.id));
    assert.deepEqual(sizes(saved, ref), [12]); assert.deepEqual(sizes(saved, neighbor), [11]);
    assert.deepEqual(saved.paragraphs().map(p => p.text), base.paragraphs().map(p => p.text));
    const cp = saved.inspectFormatting(ref).runs[0].charPrId;
    assert.match(saved.header.block('charPr', cp), /borderFillIDRef="0"/);
    assert.equal(saved.header.block('borderFill', '0'), null);
    const again = await f.live.push(f.id, head, { base: version, seq: 1002, user });
    assert.equal(again.version, result.version);
  } finally { f.close(); }
});

test('0 참조의 일괄 복사는 순차 복사와 같고, 실제 누락된 비영(非零) 참조는 여전히 거절한다', async () => {
  const base = await document(); const source = await HwpxDoc.load(await base.save());
  const pairs = base.tables()[0].cells.map(c => ({ sourceRef: c.refs[0], targetRef: c.refs[0] }));
  for (const p of pairs) source.formatRange(p.sourceRef, { start: 0, end: Array.from(source.text(p.sourceRef)).length, char: { sizePt: 12, color: '#123456' } });
  const sequential = await HwpxDoc.load(await base.save());
  for (const p of pairs) sequential.copyFormattingFrom(source, p.sourceRef, p.targetRef);
  await base.copyFormattingBatch(source, pairs);
  assert.equal(base.header.xml, sequential.header.xml); assert.equal(base.sections[0].xml, sequential.sections[0].xml);
  const invalid = await HwpxDoc.load(await source.save());
  const cp = invalid.inspectFormatting(pairs[0].sourceRef).runs[0].charPrId;
  const shape = invalid.header.block('charPr', cp);
  invalid.header.xml = invalid.header.xml.replace(shape, shape.replace('borderFillIDRef="0"', 'borderFillIDRef="999999"'));
  const before = { header: base.header.xml, xml: base.sections[0].xml };
  await assert.rejects(base.copyFormattingBatch(invalid, pairs), { code: 'NO_FORMAT' });
  assert.equal(base.header.xml, before.header); assert.equal(base.sections[0].xml, before.xml);
});

test('대상에 실제 정의 0이 있으면 없음 표식과 혼동하지 않고, 원본의 실제 정의 0은 기존대로 재매핑한다', async () => {
  const source = await document();
  const ref = source.tables()[0].cells[0].refs[0];
  source.formatRange(ref, { start: 0, end: Array.from(source.text(ref)).length, char: { sizePt: 12 } });
  const target = await document(); const fill = target.header.block('borderFill', '1');
  assert.ok(fill);
  target.header.xml = target.header.xml.replace(fill, fill.replace('id="1"', 'id="0"'));
  const before = { header: target.header.xml, xml: target.sections[0].xml };
  assert.throws(() => target.copyFormattingFrom(source, ref, ref), { code: 'FORMAT_UNSUPPORTED' });
  assert.equal(target.header.xml, before.header); assert.equal(target.sections[0].xml, before.xml);
  const real = await HwpxDoc.load(await source.save()); const realFill = real.header.block('borderFill', '1');
  real.header.xml = real.header.xml.replace(realFill, realFill.replace('id="1"', 'id="0"'));
  const destination = await document(); destination.copyFormattingFrom(real, ref, ref);
  assert.equal(destination.formattingFingerprint(ref), real.formattingFingerprint(ref));
  assert.equal(destination.header.block('borderFill', '0'), null);
});
