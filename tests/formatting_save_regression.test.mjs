import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { liveFixture } from './helpers/live-batch.mjs';

const user = { name: '시험 작성자', role: 'admin' };
const blank = () => HwpxDoc.load(fs.readFileSync('server/templates/blank.hwpx'));
const reload = async doc => HwpxDoc.load(await doc.save());
async function tableDocument() {
  const doc = await blank();
  doc.insertTableAfter(0, 0, { rows: [['머리😀', '둘'], ['셋', '넷']], headerRows: 1 }, { author: user.name });
  doc.acceptAll();
  // 중첩 표의 셀·표를 품은 부모 문단까지 같은 일괄 복사에 포함한다.
  const cell = doc.tables()[0].cells[0].refs[0];
  const { sec, p } = doc.resolve(cell);
  const inner = '<hp:tbl id="987" rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>안쪽😀</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr rowAddr="0" colAddr="0"/><hp:cellSpan rowSpan="1" colSpan="1"/></hp:tc></hp:tr></hp:tbl>';
  const at = sec.tokens[p.closeTok].start;
  sec.load(sec.xml.slice(0, at) + `<hp:run charPrIDRef="0">${inner}</hp:run>` + sec.xml.slice(at));
  return doc;
}

test('글자모양 속성 순서만 다르면 변경 없음, 실제 굵게·색·크기·글꼴 변경은 보존', async () => {
  const base = await blank();
  base.mergeParagraphText('s0/p0', '굵게😀', { author: user.name }); base.acceptAll();
  base.formatRange('s0/p0', { start: 0, end: 3, char: { bold: true, italic: true } });
  const head = await reload(base);
  head.header.xml = head.header.xml.replace(/<hh:charPr\b[^>]*>[\s\S]*?<\/hh:charPr>/g, xml => {
    const flags = xml.match(/<hh:(?:bold|italic)\s*\/>/g) || [];
    return xml.replace(/<hh:(?:bold|italic)\s*\/>/g, '').replace('</hh:charPr>', flags.reverse().join('') + '</hh:charPr>');
  });
  assert.equal(base.formattingFingerprint('s0/p0'), head.formattingFingerprint('s0/p0'));
  assert.equal((await diffDocs(base, head)).hunks.length, 0);
  for (const change of [{ bold: false }, { color: '#123456' }, { sizePt: 27 }, { font: '새 글꼴' }]) {
    const changed = await reload(head);
    changed.formatRange('s0/p0', { start: 0, end: 3, char: change });
    assert.equal((await diffDocs(base, changed)).hunks.filter(h => h.type === 'format').length, 1, JSON.stringify(change));
  }
});

test('표 셀·중첩 표·부모의 일괄 서식 복사는 순차 복사와 같은 XML, 구역 재해석 한 번', async () => {
  const base = await tableDocument(); const source = await reload(base); const sequential = await reload(base);
  const pairs = base.paragraphs().map(p => ({ sourceRef: p.ref, targetRef: p.ref }));
  assert.ok(pairs.some(p => /\/n\d+\/n\d+/.test(p.targetRef)));
  for (const p of pairs) source.formatRange(p.sourceRef, { start: 0, end: Array.from(source.text(p.sourceRef)).length, char: { color: '#345678' }, paragraph: { align: 'RIGHT' } });
  for (const p of pairs) sequential.copyFormattingFrom(source, p.sourceRef, p.targetRef);
  const seq = base.sections[0].loadSeq;
  await base.copyFormattingBatch(source, pairs);
  assert.equal(base.sections[0].loadSeq - seq, 1);
  assert.equal(base.header.xml, sequential.header.xml);
  assert.equal(base.sections[0].xml, sequential.sections[0].xml);
  for (const p of pairs) assert.equal(base.formattingFingerprint(p.targetRef), source.formattingFingerprint(p.sourceRef));
});

test('실시간 저장은 굵게 태그 위치만 바뀐 내보내기를 커밋하지 않고 실제 셀 글 수정만 반영한다', async () => {
  const base = await tableDocument();
  const shape = base.header.block('charPr', '0');
  base.header.xml = base.header.xml.replace(shape, shape.replace(/<hh:bold\s*\/>/g, '').replace('</hh:charPr>', '<hh:bold/></hh:charPr>'));
  const head = await reload(base); const hs = head.header.block('charPr', '0');
  head.header.xml = head.header.xml.replace(hs, hs.replace(/<hh:bold\s*\/>/g, '').replace(/(<hh:charPr\b[^>]*>)/, '$1<hh:bold/>'));
  const f = await liveFixture(await base.save(), { track: 'final' });
  try {
    const version = f.service._meta(f.id).version;
    const noop = await f.live.push(f.id, await head.save(), { base: version, seq: 1001, user });
    assert.equal(noop.version, version); assert.equal(noop.clean, true);
    assert.deepEqual(noop.applied, { changed: [], inserted: [], deleted: [] });
    const ref = head.tables()[0].cells.at(-1).refs[0];
    head.mergeParagraphText(ref, head.text(ref) + ' ', { author: user.name }); head.acceptAll();
    const edited = await f.live.push(f.id, await head.save(), { base: version, seq: 1002, user });
    assert.deepEqual(edited.applied.changed, [ref]); assert.equal(edited.clean, true);
    assert.equal(edited.formatVersion, undefined, '글 수정은 서식 재열기를 유발하지 않는다');
  } finally { f.close(); }
});

// 한/글이 저장한 '표만 든 문단' 꼴: 표 run 끝의 빈 hp:t + linesegarray. 글자가 없고 run 이 모두 개체라 서식 복사가 빈 run 을
// linesegarray 자리에 넣고, 같은 자리에서 시작하는 linesegarray 지우기와 만난다(2026-11-12 test1 문서 — 일괄 복사 'XML 범위가 겹칩니다',
// 하나씩 복사는 넣은 run 과 줄 정보 앞부분을 지워 구역이 문단 4개로 읽혔다)
async function tableOnlyDocument() {
  const doc = await blank(); const sec = doc.sections[0];
  const table = '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="987" rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>칸</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr rowAddr="0" colAddr="0"/><hp:cellSpan rowSpan="1" colSpan="1"/></hp:tc></hp:tr></hp:tbl><hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="0" flags="393216"/></hp:linesegarray></hp:p>';
  const after = '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>표 뒤 문단</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="0" flags="393216"/></hp:linesegarray></hp:p>';
  const at = sec.bodyParas.at(-1).end;
  sec.load(sec.xml.slice(0, at) + table + after + sec.xml.slice(at));
  return doc;
}

test('표만 든 문단(한/글 꼴)의 서식 복사: 일괄은 거절하지 않고 하나씩과 같은 XML, 문단 구조를 깨지 않는다', async () => {
  const base = await tableOnlyDocument(); const source = await reload(base);
  const shape = source.header.block('charPr', '0');
  source.header.xml = source.header.xml.replace(shape, shape.replace(/textColor="[^"]*"/, 'textColor="#345678"'));
  const pairs = base.paragraphs().map(p => ({ sourceRef: p.ref, targetRef: p.ref }));
  assert.ok(pairs.some(p => p.targetRef === 's0/p1/n0'));
  const sequential = await reload(base);
  for (const p of pairs) sequential.copyFormattingFrom(source, p.sourceRef, p.targetRef);
  await base.copyFormattingBatch(source, pairs);
  for (const doc of [base, sequential]) {
    assert.equal(doc.sections[0].bodyParas.length, 3);
    assert.equal(doc.text('s0/p2', 'final'), '표 뒤 문단');
    assert.equal(doc.text('s0/p1/n0', 'final'), '칸');
    assert.doesNotMatch(doc.sections[0].xml, /<\/hp:run>[^<]+flags=/, '지운 linesegarray 의 조각이 남지 않는다');
    for (const p of pairs) assert.equal(doc.formattingFingerprint(p.targetRef), source.formattingFingerprint(p.sourceRef));
  }
  assert.equal(base.sections[0].xml, sequential.sections[0].xml);
  assert.equal(base.header.xml, sequential.header.xml);
  assert.equal((await reload(base)).sections[0].bodyParas.length, 3);
});

test('그리지 않는 취소선 모양(한/글 2018 shape="3D")과 NONE 은 같은 서식 — 손대지 않은 편집기 저장은 서식 변경이 아니다', async () => {
  const base = await tableOnlyDocument();
  const shape = base.header.block('charPr', '0');
  base.header.xml = base.header.xml.replace(shape, shape.replace(/<hh:strikeout shape="NONE"/, '<hh:strikeout shape="3D"'));
  assert.match(base.header.block('charPr', '0'), /shape="3D"/);
  const head = await reload(base);
  head.header.xml = head.header.xml.replace(/<hh:strikeout shape="3D"/g, '<hh:strikeout shape="NONE"');
  for (const p of base.paragraphs()) assert.equal(head.formattingFingerprint(p.ref), base.formattingFingerprint(p.ref), p.ref);
  assert.equal((await diffDocs(base, head)).hunks.length, 0);
  // 같은 뜻의 정의는 새 번호로 또 들이지 않는다
  const header = base.header.xml;
  base.copyFormattingFrom(head, 's0/p2', 's0/p2');
  assert.equal(base.header.xml, header);
  // 실제로 그리는 취소선은 여전히 서식 차이
  const solid = await reload(head);
  solid.header.xml = solid.header.xml.replace(/<hh:strikeout shape="NONE"/g, '<hh:strikeout shape="SOLID"');
  assert.notEqual(solid.formattingFingerprint('s0/p2'), base.formattingFingerprint('s0/p2'));
  assert.ok((await diffDocs(base, solid)).hunks.some(h => h.type === 'format'));
});

test('중첩 셀 일괄 복사도 늦은 오류·중복 별칭·동시 변경을 부분 반영하지 않는다', async () => {
  const base = await tableDocument(); const source = await reload(base);
  const pairs = base.paragraphs().filter(p => p.ref.includes('/n')).map(p => ({ sourceRef: p.ref, targetRef: p.ref }));
  const original = { header: base.header.xml, xml: base.sections[0].xml };
  source.mergeParagraphText(pairs.at(-1).sourceRef, '다른 글', { author: user.name });
  await assert.rejects(base.copyFormattingBatch(source, pairs), { code: 'FORMAT_CONFLICT' });
  assert.equal(base.header.xml, original.header); assert.equal(base.sections[0].xml, original.xml);
  const alias = { ...pairs[0], targetRef: pairs[0].targetRef.replace('/n0', '/n00') };
  await assert.rejects(base.copyFormattingBatch(source, [pairs[0], alias]), { code: 'FORMAT_UNSUPPORTED' });
  source.formatRange(pairs[0].sourceRef, { start: 0, end: Array.from(source.text(pairs[0].sourceRef)).length, char: { color: '#123456' } });
  const pending = base.copyFormattingBatch(source, pairs.slice(0, 2));
  base.mergeParagraphText(pairs[0].targetRef, '동시 변경', { author: user.name });
  const modified = base.sections[0].xml;
  await assert.rejects(pending, { code: 'FORMAT_CONFLICT' });
  assert.equal(base.sections[0].xml, modified);
});

test('실시간 저장은 표 셀 서식을 일괄 복사하고 재전송은 새 버전을 만들지 않는다', async () => {
  const base = await tableDocument(); const source = await reload(base);
  for (const p of source.paragraphs()) source.formatRange(p.ref, { start: 0, end: Array.from(p.text).length, char: { color: '#123456' } });
  const f = await liveFixture(await base.save(), { track: 'final' });
  try {
    let batches = 0; const copy = f.live.crs._copyFormattingBatch.bind(f.live.crs);
    f.live.crs._copyFormattingBatch = (...args) => { batches++; return copy(...args); };
    const version = f.service._meta(f.id).version; const bytes = await source.save();
    const result = await f.live.push(f.id, bytes, { base: version, seq: 1001, user });
    assert.equal(batches, 1); assert.equal(result.clean, true);
    const saved = await f.store.doc(f.id);
    for (const p of source.paragraphs()) assert.equal(saved.formattingFingerprint(p.ref), source.formattingFingerprint(p.ref));
    const again = await f.live.push(f.id, bytes, { base: version, seq: 1002, user });
    assert.equal(again.version, result.version); assert.equal(batches, 1);
  } finally { f.close(); }
});
