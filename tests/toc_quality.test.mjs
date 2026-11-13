// 실제 사용자 data/config 대신 tutorial 원본의 메모리 사본과 fixture만 사용한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { tocRegions, physicalParas, regionXml, replaceRegion, docBytesSync, preserveTocFormatting, validateTocQuality } from '../engine/toc.js';
import { refreshTocInEngine, lineCountsInEngine } from '../server/toc-engine.js';

const tutorial = new URL('../tutorial/결과보고서.hwpx', import.meta.url);
function refresh(doc) {
  const reg = tocRegions(doc)[0];
  const out = refreshTocInEngine(docBytesSync(doc), { sec: reg.sec, para: reg.start });
  return HwpxDoc.load(out.bytes).then(source => {
    const preserved = preserveTocFormatting(doc, reg, source, { sec: out.sec, start: out.start, end: out.end });
    replaceRegion(doc, reg, preserved.xml);
    return { out, preserved, reg: tocRegions(doc)[0] };
  });
}
const refs = (doc, reg) => physicalParas(doc.sections[reg.sec]).slice(reg.start, reg.end + 1).map(p => p.rec.ref);

test('실제 tutorial 차례: 공백 없는 차례제목·차례1·차례2를 실제 정의로 복구하고 안내문 서식을 물려주지 않는다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(tutorial));
  const before = doc.inspectFormatting(tocRegions(doc)[0].startRef);
  const { out, preserved, reg } = await refresh(doc);
  assert.ok(preserved.receipt.preserved > 0);
  assert.ok(preserved.receipt.restored > 0);
  assert.deepEqual(validateTocQuality(doc, reg, { expectedEntries: out.entries }), { ok: true, paragraphs: 11, entries: 5, issues: [] });
  const head = doc.inspectFormatting(reg.startRef);
  assert.equal(head.styleId, before.styleId);
  assert.equal(head.paraPrId, before.paraPrId);
  assert.deepEqual(head.runs.map(r => r.charPrId), before.runs.map(r => r.charPrId));
  assert.equal(head.pageBreak, before.pageBreak);
  for (const ref of refs(doc, reg)) {
    const f = doc.inspectFormatting(ref);
    if (/^1\. 사업/.test(f.text)) assert.equal(f.styleId, doc.header.style({ name: '차례1' }).styleId);
    if (/^\d\)/.test(f.text)) assert.equal(f.styleId, doc.header.style({ name: '차례2' }).styleId);
  }
  assert.ok(!regionXml(doc, reg).includes('차례 새로 고침]을 실행'));
  const reopened = await HwpxDoc.load(await doc.save());
  assert.equal(validateTocQuality(reopened, tocRegions(reopened)[0]).ok, true);
});

test('다시 새로 고쳐도 직접 글꼴·혼합 글자 모양·문단·탭·점선은 유지한다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(tutorial));
  let { reg } = await refresh(doc);
  const ref = refs(doc, reg).find(ref => doc.text(ref).startsWith('1. 사업'));
  const length = [...doc.text(ref)].length;
  doc.formatRange(ref, { start: 0, end: length, char: { font: '맑은 고딕', sizePt: 13 }, paragraph: { leftMarginPt: 3, spaceAfterPt: 7 } });
  doc.formatRange(ref, { start: 3, end: 5, char: { bold: true, color: '#123456' } });
  const before = doc.inspectFormatting(ref);
  const regionBefore = regionXml(doc, reg);
  const tabsBefore = [...regionBefore.matchAll(/<hp:tab\b[^>]*\/>/g)].map(m => m[0]);
  ({ reg } = await refresh(doc));
  const afterRef = refs(doc, reg).find(ref => doc.text(ref).startsWith('1. 사업'));
  const after = doc.inspectFormatting(afterRef);
  assert.equal(after.styleId, before.styleId);
  assert.equal(after.paraPrId, before.paraPrId);
  assert.deepEqual(after.runs.map(r => [r.text, r.charPrId]), before.runs.map(r => [r.text, r.charPrId]));
  assert.deepEqual([...regionXml(doc, reg).matchAll(/<hp:tab\b[^>]*\/>/g)].map(m => m[0]), tabsBefore);
  assert.equal(validateTocQuality(doc, reg).ok, true);
});

test('사후검증은 누락된 서식 참조·오른쪽 탭·항목 수·필드 짝을 잡는다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(tutorial));
  const { reg } = await refresh(doc); const good = regionXml(doc, reg);
  const check = (xml, code, options) => {
    replaceRegion(doc, { ...reg }, xml);
    assert.ok(validateTocQuality(doc, reg, options).issues.some(i => i.code === code), code);
    replaceRegion(doc, reg, good);
  };
  check(good.replace('styleIDRef="20"', 'styleIDRef="999999"'), 'FORMAT_REFERENCE');
  check(good.replace(/(<hp:tab\b[^>]*\btype=")2/, '$10'), 'PAGE_ALIGNMENT');
  check(good, 'ENTRY_COUNT', { expectedEntries: 999 });
  check(good.replace(/beginIDRef="1154703689"/, 'beginIDRef="999999"'), 'FIELD_PAIR');
});

test('줄 수 조회 실패를 한 줄로 숨기지 않는다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(tutorial)); const { reg } = await refresh(doc);
  assert.equal(lineCountsInEngine(docBytesSync(doc), reg.sec, reg.start, reg.end).length, reg.end - reg.start + 1);
  assert.throws(() => lineCountsInEngine(docBytesSync(doc), 9999, 0, 0), /줄 수/);
});

test('엔진 생성 단계부터 붙여 쓴 차례 스타일을 사용하고 별칭 이름은 출력에 남기지 않는다', async () => {
  const bytes = fs.readFileSync(tutorial); const doc = await HwpxDoc.load(bytes); const reg = tocRegions(doc)[0];
  const out = refreshTocInEngine(bytes, { sec: reg.sec, para: reg.start }); const result = await HwpxDoc.load(out.bytes);
  assert.equal(out.styleAliases, 3);
  const rr = tocRegions(result)[0];
  const styles = new Map(result.formattingCatalog().styles.map(s => [s.id, s.name]));
  assert.equal(styles.get(result.inspectFormatting(rr.startRef).styleId), '차례제목');
  const entry = refs(result, rr).find(ref => result.text(ref).startsWith('1. 사업'));
  assert.equal(styles.get(result.inspectFormatting(entry).styleId), '차례1');
  assert.ok(![...styles.values()].some(name => /^차례 (?:제목|\d+)$/.test(name)));
  assert.deepEqual(result.formattingCatalog().styles.map(s => s.name), doc.formattingCatalog().styles.map(s => s.name));
  assert.equal(docBytesSync(doc).length > 0, true);
});
