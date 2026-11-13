import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc, validateFormatSpec, diffDocs } from '../engine/doc.js';
import { projectTextFormats } from '../engine/format-projection.js';
import { escapeText } from '../engine/xmlscan.js';

const author = '서식 시험'; const ref = 's0/p2';
async function document(parts = [{ text: '강조😀 보통 문장' }]) {
  const d = await HwpxDoc.load(fs.readFileSync(new URL('./fixtures/tool_memo_tracked.hwpx', import.meta.url)));
  d.acceptAll();
  const bold = d.header.boldCharPr('0');
  const { sec, p } = d.resolve(ref);
  const xml = `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${parts.map(x => `<hp:run charPrIDRef="${x.bold ? bold : '0'}"><hp:t>${escapeText(x.text)}</hp:t></hp:run>`).join('')}</hp:p>`;
  sec.load(sec.xml.slice(0, p.start) + xml + sec.xml.slice(p.end));
  return d;
}
const reload = async d => HwpxDoc.load(await d.save());
const props = (d, r = ref) => d.inspectFormatting(r).runs.flatMap(x => Array.from(x.text, () => x.char));

test('Hancom 2018 inactive 3D strikeout is not a visible strike; valid line shapes remain active', async () => {
  const d = await document();
  d.formatRange(ref, { start: 0, end: Array.from(d.text(ref)).length, char: { strikeout: true } });
  const original = d.header.xml;
  for (const [shape, active] of [['3D', false], ['NONE', false], ['Ghost', false], ['SOLID', true], ['DOUBLE_WAVE', true]]) {
    d.header.xml = original.replaceAll('shape="SOLID"', `shape="${shape}"`);
    assert.equal(props(d)[0].strikeout, active, shape);
  }
});

test('붙여넣기 스타일: 현재 본문에 쓰이지 않는 정의와 다음 스타일도 보존하고 중복하지 않는다', async () => {
  const target=await document(),source=await reload(target);
  const bold=source.header.boldCharPr('0');
  source.header.addItem('styles','style',`<hh:style id="0" type="CHAR" name="복사 전용 문자 스타일" engName="ClipboardOnlyChar" paraPrIDRef="0" charPrIDRef="${bold}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`);
  const text=target.text(ref);assert.equal(target.formattingCatalog().styles.some(s=>s.name==='복사 전용 문자 스타일'),false);
  assert.equal((await target.copyStyleDefinitionsFrom(source)).changed,true);
  assert.ok(target.formattingCatalog().styles.some(s=>s.name==='복사 전용 문자 스타일'));
  assert.equal(target.text(ref),text);
  const before=target.header.xml;assert.equal((await target.copyStyleDefinitionsFrom(source)).changed,false);assert.equal(target.header.xml,before);
  assert.ok((await reload(target)).formattingCatalog().styles.some(s=>s.name==='복사 전용 문자 스타일'));
});

test('스타일 정의 중 잘못된 참조가 있으면 앞서 준비한 스타일도 원본 문서에 남기지 않는다', async () => {
  const target=await document(),source=await reload(target);const before=target.header.xml;
  source.header.addItem('styles','style','<hh:style id="0" type="PARA" name="정상 새 스타일" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/>');
  source.header.addItem('styles','style','<hh:style id="0" type="PARA" name="잘못된 참조" paraPrIDRef="0" charPrIDRef="987654321" nextStyleIDRef="0"/>');
  await assert.rejects(target.copyStyleDefinitionsFrom(source));assert.equal(target.header.xml,before);
});

test('빈 문서에 styles 목록이 없어도 정의를 만들고 본문과 글꼴을 보존한다', async () => {
  const source=await document(),target=await reload(source);
  target.header.xml=target.header.xml.replace(/<hh:styles\b[\s\S]*?<\/hh:styles>/,'');
  assert.doesNotMatch(target.header.xml,/<hh:styles\b/);const before=target.text(ref);
  assert.equal((await target.copyStyleDefinitionsFrom(source)).changed,true);
  assert.match(target.header.xml,/<hh:styles itemCnt="\d+">/);assert.equal(target.text(ref),before);
  assert.deepEqual(target.formattingCatalog().styles.map(s=>s.name),source.formattingCatalog().styles.map(s=>s.name));
  assert.doesNotThrow(()=>target.inspectFormatting(ref));
});

test('글꼴 조회 색인은 헤더 교체와 문서별 정의를 따르고 공개 목록 수정에 오염되지 않는다', async () => {
  const base = await document(); const head = await reload(base);
  const before = base.inspectFormatting(ref).runs[0].char.font;
  const fingerprint = base.formattingFingerprint(ref);
  const catalog = base.formattingCatalog();
  catalog.fonts.forEach(font => { font.name = '외부 목록 수정'; });
  assert.equal(base.inspectFormatting(ref).runs[0].char.font, before);
  assert.ok(base.formattingCatalog().fonts.every(font => font.name !== '외부 목록 수정'));
  base.formatRange(ref, { start: 0, end: Array.from(base.text(ref)).length, char: { font: '추가된 글꼴 색인 시험' } });
  assert.equal(base.inspectFormatting(ref).runs[0].char.font, '추가된 글꼴 색인 시험');
  assert.notEqual(base.formattingFingerprint(ref), fingerprint);
  assert.equal(head.inspectFormatting(ref).runs[0].char.font, before);
  assert.equal(head.formattingFingerprint(ref), fingerprint);
});

test('여러 문단의 서식 차이는 전체 문단 목록을 한 번만 읽고 같은 cell 정보를 보존한다', async () => {
  const base = await document();
  const { sec, p } = base.resolve(ref);
  const paragraph = sec.xml.slice(p.start, p.end);
  sec.load(sec.xml.slice(0, p.start) + paragraph.repeat(24) + sec.xml.slice(p.end));
  const head = await reload(base);
  // 공통 글자 모양을 바꾸어 문단 여러 개에 실제 서식 차이를 만든다.
  const shape = head.header.block('charPr', '0');
  head.header.xml = head.header.xml.replace(shape, shape.replace(/textColor="[^"]*"/, 'textColor="#123456"'));
  const expected = new Map(base.paragraphs().map(p => [p.ref, p.cell]));
  const paragraphs = base.paragraphs.bind(base); let reads = 0;
  base.paragraphs = (...args) => { reads++; return paragraphs(...args); };
  const diff = await diffDocs(base, head);
  const formats = diff.hunks.filter(h => h.type === 'format');
  assert.ok(formats.length >= 24);
  assert.equal(reads, 1);
  for (const h of formats) assert.deepEqual(h.cell, expected.get(h.ref));
});

async function batchFixture() {
  const base = await document(); const { sec, p } = base.resolve(ref);
  const xml = sec.xml.slice(p.start, p.end);
  sec.load(sec.xml.slice(0, p.start) + xml.repeat(24) + sec.xml.slice(p.end));
  const source = await reload(base); const shape = source.header.block('charPr', '0');
  source.header.xml = source.header.xml.replace(shape, shape.replace(/textColor="[^"]*"/, 'textColor="#123456"'));
  return { base, source, pairs: Array.from({ length: 24 }, (_, i) => ({ sourceRef: `s0/p${i + 2}`, targetRef: `s0/p${i + 2}` })) };
}

test('본문 일괄 서식 복사는 순차 복사와 같은 XML을 만들고 구역을 한 번만 다시 읽는다', async () => {
  const { base, source, pairs } = await batchFixture(); const sequential = await reload(base);
  for (const { sourceRef, targetRef } of pairs) sequential.copyFormattingFrom(source, sourceRef, targetRef);
  const seq = base.sections[0].loadSeq;
  await base.copyFormattingBatch(source, pairs);
  assert.equal(base.sections[0].loadSeq - seq, 1);
  assert.equal(base.header.xml, sequential.header.xml);
  assert.equal(base.sections[0].xml, sequential.sections[0].xml);
  for (const { sourceRef, targetRef } of pairs) assert.equal(base.formattingFingerprint(targetRef), source.formattingFingerprint(sourceRef));
});

test('본문 일괄 서식 복사의 늦은 오류는 부분 반영하지 않고 준비 중 외부 변경을 덮어쓰지 않는다', async () => {
  const { base, source, pairs } = await batchFixture();
  const original = { header: base.header.xml, section: base.sections[0].xml };
  source.mergeParagraphText(pairs.at(-1).sourceRef, '다른 글', { author });
  await assert.rejects(base.copyFormattingBatch(source, pairs), { code: 'FORMAT_CONFLICT' });
  assert.equal(base.header.xml, original.header); assert.equal(base.sections[0].xml, original.section);
  await assert.rejects(base.copyFormattingBatch(source, [pairs[0], pairs[0]]), { code: 'FORMAT_UNSUPPORTED' });
  const pending = base.copyFormattingBatch(source, pairs.slice(0, 2));
  base.mergeParagraphText(pairs[0].targetRef, '동시에 바뀐 글', { author });
  const modifiedHeader = base.header.xml;
  await assert.rejects(pending, { code: 'FORMAT_CONFLICT' });
  assert.equal(base.text(pairs[0].targetRef), '동시에 바뀐 글'); assert.equal(base.header.xml, modifiedHeader);
});

test('한글 2018 문단 번호의 기본 글자모양 표식은 복사하고 실제 누락된 번호는 거절한다', async () => {
  const target = await document(); const source = await reload(target);
  const numberId = source.header.addItem('numberings', 'numbering', '<hh:numbering id="0" start="1"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering>');
  const p = source.header.block('paraPr', '0');
  source.header.xml = source.header.xml.replace(p, p.replace(/<hh:heading\b[^>]*\/>/, `<hh:heading type="NUMBER" idRef="${numberId}" level="0"/>`));
  const text = target.text(ref);
  target.copyFormattingFrom(source, ref, ref);
  assert.equal(target.text(ref), text);
  assert.match(target.header.xml, /charPrIDRef="4294967295"/);
  assert.equal(target.formattingFingerprint(ref), source.formattingFingerprint(ref));
  const before = target.header.xml;
  const numbering = source.header.block('numbering', numberId);
  source.header.xml = source.header.xml.replace(numbering, numbering.replace('charPrIDRef="4294967295"', 'charPrIDRef="987654321"'));
  assert.throws(() => target.copyFormattingFrom(source, ref, ref), { code: 'NO_FORMAT' });
  assert.equal(target.header.xml, before);
});

test('글자모양: 코드포인트 정확 범위·미지정 속성·false 해제·모양 재사용·저장 왕복', async () => {
  const d = await document(); const original = d.text(ref);
  const result = d.formatRange(ref, { start: 2, end: 3, char: { bold: true, sizePt: 14, color: '#a012ff' } });
  assert.equal(result.changed, true); assert.equal(d.text(ref), original);
  const p = props(d); assert.equal(p[2].bold, true); assert.equal(p[2].sizePt, 14); assert.equal(p[2].color, '#A012FF');
  assert.ok(p.filter((_, i) => i !== 2).every(x => !x.bold && x.sizePt === 10));
  const count = d.formattingCatalog().charProperties.length;
  assert.equal(d.formatRange(ref, { start: 2, end: 3, char: { bold: true, sizePt: 14, color: '#a012ff' } }).changed, false);
  assert.equal(d.formattingCatalog().charProperties.length, count);
  d.formatRange(ref, { start: 2, end: 3, char: { bold: false, italic: false, underline: false } });
  assert.equal(props(await reload(d))[2].bold, false); assert.equal(props(d)[2].sizePt, 14);
  assert.match(d.header.block('charPr', d.inspectFormatting(ref).runs[1].charPrId), /<hh:ratio hangul="100"/);
});

test('문단모양: 전체 범위 강제·단위 변환·기존 named style과 shape ID 선택', async () => {
  const d = await document(); const len = Array.from(d.text(ref)).length;
  assert.throws(() => d.formatRange(ref, { start: 1, end: len, paragraph: { align: 'CENTER' } }), { code: 'FORMAT_PARAGRAPH_RANGE' });
  d.formatRange(ref, { start: 0, end: len, styleId: '1', paragraph: { align: 'CENTER', indentPt: -5, spaceBeforePt: 8, lineSpacing: { type: 'FIXED', value: 20 } } });
  const info = d.inspectFormatting(ref); assert.equal(info.styleId, '1'); assert.equal(info.paragraph.align, 'CENTER');
  assert.equal(info.paragraph.indentPt, -5); assert.equal(info.paragraph.spaceBeforePt, 8); assert.deepEqual(info.paragraph.lineSpacing, { type: 'FIXED', value: 20 });
  const shape = d.header.block('paraPr', info.paraPrId);
  assert.match(shape, /<hp:case[^>]*>[\s\S]*?<hc:prev value="800"/); assert.match(shape, /<hp:default>[\s\S]*?<hc:prev value="1600"/);
  assert.match(shape, /<hh:lineSpacing type="FIXED" value="2000"/); assert.match(shape, /<hh:lineSpacing type="FIXED" value="4000"/);
  d.formatRange(ref, { start: 0, end: len, paraPrId: '0', charPrId: '0' }); assert.equal(d.inspectFormatting(ref).paraPrId, '0');
  const charStyle = d.formattingCatalog().styles.find(s => s.type === 'CHAR');
  d.formatRange(ref, { start: 1, end: 2, styleId: charStyle.id }); assert.equal(d.inspectFormatting(ref).styleId, '1');
  assert.equal(d.inspectFormatting(ref).runs.find(r => r.start === 1).charPrId, charStyle.charPrId);
});

test('서식 validation은 오타/잘못된 id/concat을 거절하고 문서·헤더를 남긴다', async () => {
  const d = await document(); const before = d.sections[0].xml; const header = d.header.xml;
  for (const spec of [{ char: { bolder: true } }, { char: { bold: 'false' } }, { char: { sizePt: NaN } }, { paragraph: { lineSpacing: { type: 'PERCENT', value: -1 } } }]) assert.throws(() => validateFormatSpec(spec), { code: 'FORMAT_SPEC' });
  assert.throws(() => d.formatRange(ref, { start: 0, end: 1, charPrId: '99999' }), { code: 'NO_FORMAT' });
  assert.throws(() => d.replaceTracked(ref, 0, 2, '새글', { author, runs: [{ text: '다름', char: { bold: true } }] }), { code: 'FORMAT_SPEC' });
  assert.throws(() => d.replaceTracked(ref, 0, 2, '새글', { author, format: { charPrId: '99999' } }), { code: 'NO_FORMAT' });
  assert.throws(() => d.insertTracked(ref, 1, '새글', { author, format: { paragraph: { align: 'RIGHT' } } }), { code: 'FORMAT_PARAGRAPH_RANGE' });
  assert.equal(d.sections[0].xml, before); assert.equal(d.header.xml, header);
});

test('새 글꼴은 언어별 등록·중복 재사용하며 원래 글꼴과 다른 모양은 그대로', async () => {
  const d = await document(); const old = props(d)[0];
  d.formatRange(ref, { start: 1, end: 3, char: { font: '시험 글꼴 & serif' } });
  const catalog = d.formattingCatalog(); assert.equal(catalog.fonts.filter(f => f.name === '시험 글꼴 & serif').length, 7);
  assert.equal(props(d)[0].font, old.font); assert.equal(props(d)[1].font, '시험 글꼴 & serif');
  d.formatRange(ref, { start: 4, end: 6, char: { font: '시험 글꼴 & serif' } });
  assert.equal(d.formattingCatalog().fonts.length, catalog.fonts.length); assert.equal(props(await reload(d))[4].font, '시험 글꼴 & serif');
});

test('교체·삽입: 첫 굵게가 전체에 퍼지지 않고 같은 글의 혼합모양·runs 명시를 보존', async () => {
  const d = await document([{ text: '제목', bold: true }, { text: ' 보통 설명입니다' }]);
  const next = '제목 새로운 보통 설명입니다';
  d.replaceTracked(ref, 0, Array.from(d.text(ref)).length, next, { author });
  assert.equal(d.text(ref), next); assert.ok(props(d).slice(0, 2).every(p => p.bold)); assert.ok(props(d).slice(2).every(p => !p.bold));
  d.acceptAll(); const r = await reload(d); assert.ok(props(r).slice(2).every(p => !p.bold));
  r.insertTracked(ref, 2, ' 추가', { author }); assert.ok(props(r).slice(2, 5).every(p => !p.bold));
  r.acceptAll(); const old = r.text(ref); const before = props(r).map(p => p.bold);
  r.replaceTracked(ref, 0, 2, '새 제목', { author, format: { char: { color: '#010203' } }, runs: [{ text: '새 ', char: { bold: false } }, { text: '제목', char: { bold: true } }] });
  assert.deepEqual(props(r).slice(0, 4).map(p => p.bold), [false, false, true, true]); assert.ok(props(r).slice(0, 4).every(p => p.color === '#010203'));
  r.rejectAll(); assert.equal(r.text(ref), old); assert.deepEqual(props(r).map(p => p.bold), before);
  assert.deepEqual(projectTextFormats('강조 보통', '강조 새 보통', [{ start: 0, end: 2, charPrId: 5 }, { start: 2, end: 5, charPrId: 0 }]), [5, 5, 0, 0, 0, 0, 0]);
});

test('서식 undo는 후속 메모를 보존하고 본문/서식 충돌 때 원상복원을 거절', async () => {
  const d = await document(); const before = d.inspectFormatting(ref);
  const action = d.formatRange(ref, { start: 1, end: 4, char: { bold: true } });
  d.addMemo(ref, { start: 0, end: 3, text: '적용 후 기록', author });
  const memo = d.memos().find(m => m.text === '적용 후 기록');
  assert.equal(d.inspectFormatting(ref).fingerprint, action.after.fingerprint);
  d.undoFormatting(action.undo); assert.equal(d.inspectFormatting(ref).fingerprint, before.fingerprint);
  assert.equal(d.memos().find(m => m.id === memo.id).text, '적용 후 기록');
  const again = d.formatRange(ref, { start: 0, end: 2, char: { italic: true } });
  d.insertTracked(ref, 0, '다른 글', { author });
  assert.throws(() => d.undoFormatting(again.undo), { code: 'FORMAT_CONFLICT' });
});

test('새 문단 format/runs와 표 칸의 서식은 주변 문단·메모를 바꾸지 않는다', async () => {
  const d = await document(); const n = d.insertParagraphAfter(0, 2, '소제목 본문', { author, format: { styleId: '1', paragraph: { align: 'CENTER' } }, runs: [{ text: '소제목', char: { bold: true } }, { text: ' 본문', char: { bold: false } }] });
  assert.equal(d.inspectFormatting(n).paragraph.align, 'CENTER'); assert.deepEqual(props(d, n).map(p => p.bold), [true, true, true, false, false, false]);
  d.acceptAll(); d.insertTableAfter(0, 3, { rows: [['첫 칸', '둘째 칸']] }, { author }); d.acceptAll();
  const [a, b] = d.tables().at(-1).cells.map(c => c.refs[0]); const bBefore = d.inspectFormatting(b).fingerprint;
  const act = d.formatRange(a, { start: 1, end: 2, char: { italic: true } });
  assert.equal(d.inspectFormatting(b).fingerprint, bBefore); assert.equal(props(d, a)[1].italic, true);
  d.undoFormatting(act.undo); assert.equal(props(d, a)[1].italic, false); await reload(d);
});

test('교차 문서 서식 복사: 충돌하는 ID·font·style·shape 참조를 재매핑하고 메모/다른 문단을 보존', async () => {
  const source = await document(); const target = await source.clone(); const length = Array.from(source.text(ref)).length;
  source.formatRange(ref, { start: 0, end: length, styleId: '1', paragraph: { align: 'RIGHT', spaceAfterPt: 9 } });
  source.formatRange(ref, { start: 1, end: 4, char: { font: '별도 글꼴', bold: true, sizePt: 17 } });
  // 같은 ID의 정의가 다른 문서도 가정한다.
  target.header.xml = target.header.xml.replace('<hh:charPr id="0" height="1000"', '<hh:charPr id="0" height="1200"');
  target.addMemo(ref, { start: 0, end: 2, text: '남겨야 할 메모', author });
  const unrelated = target.formattingFingerprint('s0/p1');
  const result = target.copyFormattingFrom(source, ref, ref);
  assert.equal(target.formattingFingerprint(ref), source.formattingFingerprint(ref));
  assert.equal(target.formattingFingerprint('s0/p1'), unrelated); assert.ok(target.memos().some(m => m.text === '남겨야 할 메모'));
  assert.equal(props(target)[1].font, '별도 글꼴'); assert.equal(target.inspectFormatting(ref).paragraph.spaceAfterPt, 9);
  const catalog = target.formattingCatalog(); target.copyFormattingFrom(source, ref, ref);
  assert.equal(target.formattingCatalog().charProperties.length, catalog.charProperties.length);
  assert.equal(target.formattingCatalog().styles.length, catalog.styles.length);
  assert.equal((await reload(target)).formattingFingerprint(ref), source.formattingFingerprint(ref));
  target.undoFormatting(result.undo); assert.equal(props(target)[0].sizePt, 12);
});

test('반복 서식 복사는 사이에 생긴 변경 기록을 보존하고 원본·대상 정의 수정은 새로 가져온다', async () => {
  const source=await document(),target=await reload(source),length=Array.from(source.text(ref)).length;
  source.formatRange(ref,{start:0,end:length,char:{bold:true}});
  target.copyFormattingFrom(source,ref,ref);
  target.header.ensureAuthor('뒤에 생긴 작성자');target.header.addChange('Insert',target.header.ensureAuthor(author));
  const changes=target.header.changes(),authors=target.header.authors();
  target.copyFormattingFrom(source,ref,ref);
  assert.deepEqual(target.header.changes(),changes);assert.deepEqual(target.header.authors(),authors);
  source.formatRange(ref,{start:0,end:length,char:{font:'새 원본 글꼴',color:'#123456'}});
  target.copyFormattingFrom(source,ref,ref);assert.equal(props(target)[0].font,'새 원본 글꼴');assert.equal(props(target)[0].color,'#123456');
  const id=target.inspectFormatting(ref).runs[0].charPrId,block=target.header.block('charPr',id);
  target.header.xml=target.header.xml.replace(block,block.replace('textColor="#123456"','textColor="#654321"'));
  target.copyFormattingFrom(source,ref,ref);assert.equal(props(target)[0].color,'#123456');
});

test('그림 자원의 변경은 서식 지문과 이전 복사 계획을 무효화한다', async () => {
  const source=await document();
  source.container.setText('Contents/content.hpf',source.container.getText('Contents/content.hpf').replace('</opf:manifest>','<opf:item id="fill-test" href="BinData/fill-test.png" media-type="image/png"/></opf:manifest>'));
  source.container.setBytes('BinData/fill-test.png',new Uint8Array([1,2,3]));
  const border=source.header.addItem('borderFills','borderFill','<hh:borderFill id="1"><hc:fillBrush><hc:imgBrush mode="TILE"><hc:img binaryItemIDRef="fill-test"/></hc:imgBrush></hc:fillBrush></hh:borderFill>');
  const old=source.header.block('charPr','0');source.header.xml=source.header.xml.replace(old,old.replace(/borderFillIDRef="[^"]*"/,`borderFillIDRef="${border}"`));
  const target=await reload(source);target.copyFormattingFrom(source,ref,ref);const before=source.formattingFingerprint(ref),targetBefore=target.header.xml;
  source.container.setBytes('BinData/fill-test.png',new Uint8Array([4,5,6]));
  assert.notEqual(source.formattingFingerprint(ref),before);
  assert.throws(()=>target.copyFormattingFrom(source,ref,ref),{code:'FORMAT_UNSUPPORTED'});assert.equal(target.header.xml,targetBefore);
});

test('semantic fingerprint와 diff: 같은 ID 정의의 재번호는 같고 format-only/글+서식은 적용 가능한 덩어리', async () => {
  const base = await document([{ text: '제목', bold: true }, { text: ' 보통 내용' }]); const head = await base.clone();
  const old = head.header.block('charPr', '0'); head.header.xml = head.header.xml.replace(old, old.replace('id="0"', 'id="999"')).replaceAll('charPrIDRef="0"', 'charPrIDRef="999"');
  for (const sec of head.sections) sec.load(sec.xml.replaceAll('charPrIDRef="0"', 'charPrIDRef="999"'));
  assert.equal(head.formattingFingerprint(ref), base.formattingFingerprint(ref)); assert.deepEqual((await diffDocs(base, head)).hunks, []);
  head.formatRange(ref, { start: 3, end: 5, char: { italic: true } });
  const format = (await diffDocs(base, head)).hunks.find(h => h.ref === ref);
  assert.equal(format.type, 'format'); assert.equal(format.headRef, ref); assert.equal(format.formatting, true);
  const plain = await base.clone(); plain.replaceTracked(ref, 3, 5, '평범한', { author }); plain.acceptAll();
  const text = (await diffDocs(base, plain)).hunks.find(h => h.ref === ref); assert.equal(text.type, 'replace'); assert.equal(text.formatting, false);
  plain.formatRange(ref, { start: 0, end: 1, char: { italic: true } });
  const rich = (await diffDocs(base, plain)).hunks.find(h => h.ref === ref); assert.equal(rich.formatting, true); assert.notEqual(rich.hid, text.hid);
});

test('기존 메모·개체가 같은 run에 있어도 선택 글자만 바꾸며 빈 문단 서식도 삽입에 이어진다', async () => {
  const d = await document();
  d.addMemo(ref, { start: 1, end: 5, text: '메모 본문', author });
  const memos = JSON.stringify(d.memos()); const { sec, p } = d.resolve(ref); const run = p.runs[0]; const at = sec.tokens[run.openTok].end;
  sec.load(sec.xml.slice(0, at) + '<hp:pic id="701"/>' + sec.xml.slice(at));
  const action = d.formatRange(ref, { start: 0, end: Array.from(d.text(ref)).length, char: { bold: true } });
  assert.equal(JSON.stringify(d.memos()), memos);
  const pic = d.resolve(ref).p.anchors.find(a => a.name === 'hp:pic'); assert.equal(pic.run.charPr, '0');
  d.undoFormatting(action.undo); assert.equal(JSON.stringify(d.memos()), memos);
  const empty = d.insertParagraphAfter(0, 2, '', { author, format: { char: { bold: true } } });
  d.insertTracked(empty, 0, '첫글', { author }); assert.ok(props(d, empty).every(p => p.bold));
});

test('CRLF·XML 정리 문자와 rich runs의 길이는 실제 삽입 글에 맞아 범위 뒤 서식이 바뀌지 않는다', async () => {
  const d = await document([{ text: '앞', bold: true }, { text: '뒤' }]);
  d.insertTracked(ref, 1, '가\r\n나\u0001', { author, runs: [{ text: '가\r\n', char: { bold: true } }, { text: '나\u0001', char: { bold: false } }] });
  assert.equal(d.text(ref), '앞가\n나뒤'); assert.deepEqual(props(d).map(p => p.bold), [true, true, true, false, false]);
  const before = d.sections[0].xml;
  assert.throws(() => d.insertTracked(ref, 0, '\r\n', { author, runs: [{ text: '\r' }, { text: '\n' }] }), { code: 'FORMAT_SPEC' });
  assert.equal(d.sections[0].xml, before);
});

test('서식 적용 HWPX는 실제 rhwp 파서·내보내기 왕복에서도 선택모양과 문단 단위를 유지', async () => {
  const wasmUrl = new URL('../vendor/rhwp/pkg/rhwp_bg.wasm', import.meta.url);
  if (!fs.existsSync(wasmUrl)) return;
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import(new URL('../vendor/rhwp/pkg/rhwp.js', import.meta.url).href);
  mod.initSync({ module: fs.readFileSync(wasmUrl) });
  const d = await document(); const length = Array.from(d.text(ref)).length;
  d.formatRange(ref, { start: 0, end: length, paragraph: { align: 'CENTER', indentPt: -5, spaceBeforePt: 8, lineSpacing: { type: 'FIXED', value: 20 } } });
  d.formatRange(ref, { start: 1, end: 4, char: { bold: true, italic: true, underline: true, sizePt: 17, color: '#12AB34' } });
  const native = new mod.HwpDocument(new Uint8Array(await d.save()));
  const back = await HwpxDoc.load(Buffer.from(native.exportHwpx()));
  assert.equal(back.text(ref), d.text(ref)); assert.deepEqual(props(back), props(d));
  assert.deepEqual(back.inspectFormatting(ref).paragraph, d.inspectFormatting(ref).paragraph);
  native.free?.();
});
