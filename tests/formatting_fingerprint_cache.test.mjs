import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { Header } from '../engine/header.js';
import { HwpxContainer } from '../engine/container.js';
import { formattingChanged } from '../engine/formatting.js';

const ref = 's0/p2'; const author = '지문 캐시 검증';
async function document() {
  const doc = await HwpxDoc.load(fs.readFileSync(new URL('./fixtures/tool_memo_tracked.hwpx', import.meta.url)));
  doc.acceptAll(); return doc;
}
async function assertFresh(doc, target = ref) {
  const actual = doc.formattingFingerprint(target);
  const fresh = await HwpxDoc.load(await doc.save());
  assert.equal(actual, fresh.formattingFingerprint(target));
  return actual;
}

test('서식 지문은 기존 SHA-256 값과 호환되고 반복 조회·비교에서 글자 배열을 다시 만들지 않는다', async t => {
  const doc = await document();
  const visibleChars = Section.visibleChars; let calls = 0;
  t.mock.method(Section, 'visibleChars', (...args) => { calls++; return visibleChars(...args); });
  const fingerprint = doc.formattingFingerprint(ref);
  assert.equal(fingerprint, '65d66d32bdfe3d00b587bcc5f6d40c88191e00eafb1b702ed6f8aa2ede179e3c');
  assert.equal(calls, 1);
  for (let i = 0; i < 50; i++) {
    assert.equal(doc.formattingFingerprint(ref), fingerprint);
    assert.equal(formattingChanged(doc, ref, doc, ref), false);
  }
  assert.equal(calls, 1, '동일한 문단의 최종본 의미값은 한 번만 구성한다');
});

test('글자 수정·서식 변경·쪽 나누기는 구역 재해석 뒤 지문과 서식 비교에 즉시 반영된다', async () => {
  const doc = await document(); const original = await document();
  const before = doc.formattingFingerprint(ref);
  doc.insertTracked(ref, 0, '😀', { author });
  assert.notEqual(doc.formattingFingerprint(ref), before);
  assert.equal(formattingChanged(original, ref, doc, ref), false, '같은 모양의 글 삽입은 서식 변경이 아니다');
  doc.acceptAll(); await assertFresh(doc);
  const textOnly = doc.formattingFingerprint(ref);
  doc.formatRange(ref, { start: 0, end: 1, char: { bold: true } });
  assert.notEqual(doc.formattingFingerprint(ref), textOnly);
  assert.equal(formattingChanged(original, ref, doc, ref), true);
  const formatted = await assertFresh(doc);
  const { sec, p } = doc.resolve(ref);
  sec.load(sec.xml.slice(0, p.start) + sec.xml.slice(p.start, p.end).replace('pageBreak="0"', 'pageBreak="1"') + sec.xml.slice(p.end));
  assert.notEqual(doc.formattingFingerprint(ref), formatted);
  await assertFresh(doc);
});

test('문단 ref가 밀려도 새 문단을 읽고 같은 XML로 교체한 새 구역 객체를 구분한다', async () => {
  const doc = await document(); const before = doc.formattingFingerprint(ref);
  doc.insertParagraphAfter(0, 1, '새 문단', { author }); doc.acceptAll();
  assert.notEqual(doc.formattingFingerprint(ref), before);
  assert.equal(doc.formattingFingerprint('s0/p3'), before);
  const sec = doc.sections[0];
  doc.sections[0] = new Section(sec.xml, sec.index);
  assert.equal(doc.formattingFingerprint('s0/p3'), before);
  const current = doc.resolve('s0/p3');
  current.sec.load(current.sec.xml.slice(0, current.p.start) + current.sec.xml.slice(current.p.start, current.p.end).replace('<hp:t>', '<hp:t>바뀜') + current.sec.xml.slice(current.p.end));
  assert.notEqual(doc.formattingFingerprint('s0/p3'), before);
  await assertFresh(doc, 's0/p3');
  assert.throws(() => doc.formattingFingerprint('s0/p9999'), { code: 'NO_PARAGRAPH' });
});

test('header 직접 교체·정의 수정·글꼴 변경·빈 문단 모양을 캐시가 가리지 않는다', async () => {
  const doc = await document(); const before = doc.formattingFingerprint(ref);
  const shape = doc.header.block('charPr', '0');
  doc.header.xml = doc.header.xml.replace(shape, shape.replace('height="1000"', 'height="1700"'));
  const resized = doc.formattingFingerprint(ref); assert.notEqual(resized, before); await assertFresh(doc);
  doc.header = new Header(doc.header.xml);
  assert.equal(doc.formattingFingerprint(ref), resized);
  const font = doc.inspectFormatting(ref).runs[0].char.font;
  doc.header.xml = doc.header.xml.replaceAll(`face="${font}"`, 'face="다른 글꼴"');
  assert.notEqual(doc.formattingFingerprint(ref), resized); await assertFresh(doc);
  const empty = doc.insertParagraphAfter(0, 2, '', { author }); doc.acceptAll();
  const emptyBefore = doc.formattingFingerprint(empty);
  doc.formatRange(empty, { start: 0, end: 0, char: { italic: true } });
  assert.notEqual(doc.formattingFingerprint(empty), emptyBefore); await assertFresh(doc, empty);
});

test('표 셀 중첩 문단과 이웃 문단은 각각의 현재 글과 모양으로 지문을 만든다', async () => {
  const doc = await document();
  doc.insertTableAfter(0, 2, { rows: [['첫째 칸', '둘째 칸']] }, { author }); doc.acceptAll();
  const [a, b] = doc.tables().at(-1).cells.map(cell => cell.refs[0]);
  const beforeA = doc.formattingFingerprint(a); const beforeB = doc.formattingFingerprint(b);
  doc.insertTracked(a, 0, '새', { author });
  assert.notEqual(doc.formattingFingerprint(a), beforeA); assert.equal(doc.formattingFingerprint(b), beforeB);
  await assertFresh(doc, a); await assertFresh(doc, b);
});

test('그림을 참조하는 정의는 자원·매니페스트·컨테이너 교체 뒤 다시 평가한다', async () => {
  const doc = await document();
  const manifest = doc.container.getText('Contents/content.hpf').replace('</opf:manifest>', '<opf:item id="cache-fill" href="BinData/cache-fill.png" media-type="image/png"/></opf:manifest>');
  doc.container.setText('Contents/content.hpf', manifest);
  doc.container.setBytes('BinData/cache-fill.png', new Uint8Array([1, 2, 3]));
  const border = doc.header.addItem('borderFills', 'borderFill', '<hh:borderFill id="1"><hc:fillBrush><hc:imgBrush mode="TILE"><hc:img binaryItemIDRef="cache-fill"/></hc:imgBrush></hc:fillBrush></hh:borderFill>');
  const shape = doc.header.block('charPr', '0');
  doc.header.xml = doc.header.xml.replace(shape, shape.replace(/borderFillIDRef="[^"]*"/, `borderFillIDRef="${border}"`));
  const before = doc.formattingFingerprint(ref);
  doc.container.setBytes('BinData/cache-fill.png', new Uint8Array([4, 5, 6]));
  const changed = doc.formattingFingerprint(ref); assert.notEqual(changed, before);
  doc.container.setBytes('BinData/other-fill.png', new Uint8Array([7, 8, 9]));
  doc.container.setText('Contents/content.hpf', manifest.replace('href="BinData/cache-fill.png"', 'href="BinData/other-fill.png"'));
  const remapped = doc.formattingFingerprint(ref); assert.notEqual(remapped, changed);
  const replacement = new HwpxContainer(new Map(doc.container.files), [...doc.container.order]);
  replacement.setBytes('BinData/other-fill.png', new Uint8Array([10, 11, 12]));
  replacement.revision = doc.container.revision;
  doc.container = replacement;
  assert.notEqual(doc.formattingFingerprint(ref), remapped); await assertFresh(doc);
});
