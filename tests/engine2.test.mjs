// node --test tests/engine2.test.mjs — v0.2 엔진: 표 읽기(tables·셀 문단), 표 넣기, 본문 문단 지우기, 중첩 문단 병합·bodyMap.
// 한글 2022 왕복(열림·PDF 에 표)은 tests/hangul_roundtrip.py 로 따로 확인한다(이 시험은 엔진 재로드 + rhwp WASM 까지).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
import { stripCaptionNumber, columnWidths } from '../engine/table.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const BIZ = path.join(here, 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'); // 표 5개(합친 셀 포함)
const hasBiz = fs.existsSync(BIZ);
const biz = () => HwpxDoc.load(fs.readFileSync(BIZ));
const author = '홍길동(Claude)';
const ROWS = [['구분', '2023', '2024', '2025'], ['학부', '1,234', '1,300', ''], ['대학원', '567', '601', '640'], ['합계', '1,801', '1,901', '2,042']];
const reload = async (d) => HwpxDoc.load(await d.save());
const bodyRefs = (d) => d.paragraphs({ nested: false }).map((p) => p.ref);

/** header.xml 의 목록 itemCnt 가 실제 항목 수와 같은가 */
function itemCounts(d) {
  const out = {};
  for (const [list, tag] of [['borderFills', 'borderFill'], ['charProperties', 'charPr'], ['paraProperties', 'paraPr'], ['trackChanges', 'trackChange'], ['trackChangeAuthors', 'trackChangeAuthor']]) {
    const m = new RegExp(`<hh:${list}\\b[^>]*\\bitemCnt="(\\d+)"`).exec(d.header.xml);
    const n = (d.header.xml.match(new RegExp(`<hh:${tag}\\b`, 'g')) || []).length;
    out[list] = m ? [parseInt(m[1], 10), n] : [null, n];
  }
  return out;
}
const assertCountsConsistent = (d) => { for (const [k, [cnt, n]] of Object.entries(itemCounts(d))) if (cnt != null) assert.equal(cnt, n, `${k} itemCnt`); };

// ───────── 읽기 ─────────

test('tables(): 행·열 수, 셀 주소·합침, 캡션은 셀이 아니다', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const t = d.tables();
  assert.deepEqual(t.map((x) => x.key), ['s0/p3#t0', 's0/p7#t0', 's0/p11#t0', 's0/p14#t0', 's0/p17#t0']);
  const t0 = t[0];
  assert.deepEqual([t0.ref, t0.index, t0.rows, t0.cols, t0.cells.length], ['s0/p3', 0, 11, 6, 66]);
  assert.equal(t0.caption.ref, 's0/p3/n0');
  assert.match(t0.caption.text, /연도별 응답자 수\(n\)$/);
  assert.deepEqual(t0.cells[0], { row: 0, col: 0, rowSpan: 1, colSpan: 1, header: true, refs: ['s0/p3/n1'], text: '구분' });
  assert.deepEqual(t0.cells[7], { row: 1, col: 1, rowSpan: 1, colSpan: 1, header: false, refs: ['s0/p3/n8'], text: '268' });
  assert.ok(t.every((x) => x.cells.every((c) => !c.refs.includes(x.caption.ref))), '캡션 문단은 셀에 들지 않는다');
  // 합친 셀: 성별 분포 표의 '경영대학(학부)' 는 5행을 합친 칸
  const merged = t[1].cells.find((c) => c.text === '경영대학(학부)');
  assert.deepEqual([merged.row, merged.col, merged.rowSpan, merged.colSpan], [1, 0, 5, 1]);
  // 모든 표: 셀 넓이 합 = 행×열 (주소·합침을 바르게 읽었는지)
  for (const x of t) assert.equal(x.cells.reduce((s, c) => s + c.rowSpan * c.colSpan, 0), x.rows * x.cols, x.key);
});

test('paragraphs(): parent·container·cell 필드', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const ps = new Map(d.paragraphs().map((p) => [p.ref, p]));
  const body = ps.get('s0/p3'); assert.deepEqual([body.parent, body.container, body.cell], [null, null, null]);
  const cap = ps.get('s0/p3/n0'); assert.deepEqual([cap.parent, cap.container, cap.cell], ['s0/p3', 'hp:tbl', null]);
  const cell = ps.get('s0/p3/n8');
  assert.deepEqual([cell.parent, cell.container, cell.text], ['s0/p3', 'hp:tbl', '268']);
  assert.deepEqual(cell.cell, { table: 's0/p3#t0', row: 1, col: 1, rowSpan: 1, colSpan: 1 });
  // 본문만 볼 때는 중첩 필드가 비어 있다
  assert.ok(d.paragraphs({ nested: false }).every((p) => p.parent === null && p.container === null && p.cell === null));
});

test('tables(): 셀 안의 중첩 표는 따로, 셀 메모 본문은 셀 문단이 아니다', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const r = d.insertTableAfter(0, 0, { rows: [['가', '나'], ['다', '']], headerRows: 1 }, { author });
  const sec = d.sections[0];
  const outer = d.tables().find((t) => t.key === r.tableKey);
  // 바깥 표 XML 을 그대로 복사해 (1,1) 빈 셀의 run 안에 넣는다
  const tblXml = /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(sec.byRef(r.ref).start, sec.byRef(r.ref).end))[0];
  const target = sec.byRef(outer.cells[3].refs[0]);
  const run = target.runs[0]; assert.ok(run.selfclose);
  sec.load(sec.xml.slice(0, run.end - 2) + `>${tblXml}<hp:t/></hp:run>` + sec.xml.slice(run.end));
  d.addMemo(outer.cells[0].refs[0], { author, text: '셀 메모' });
  const re = await reload(d);
  const tl = re.tables();
  const cellRef = outer.cells[3].refs[0];
  assert.deepEqual(tl.map((t) => t.key), [r.tableKey, `${cellRef}#t0`]);
  const inner = tl[1];
  assert.equal(inner.ref, cellRef);
  assert.deepEqual(inner.cells.map((c) => c.text), ['가', '나', '다', '']);
  assert.ok(inner.cells.every((c) => c.refs.every((x) => x.startsWith(`${cellRef}/n`))));
  const o = tl[0];
  assert.deepEqual(o.cells.map((c) => c.refs.length), [1, 1, 1, 1], '바깥 셀은 자기 문단만(메모 본문·중첩 표 문단 제외)');
  assert.equal(o.cells[0].text, '가');
  const ps = re.paragraphs();
  assert.equal(ps.find((p) => p.ref === inner.cells[0].refs[0]).cell.table, inner.key);
  assert.ok(!ps.some((p) => p.text === '셀 메모'), '메모 본문은 문단 목록에 없다');
  assert.equal(re.memos().find((m) => m.text === '셀 메모').ref, outer.cells[0].refs[0]);
});

// ───────── 표 넣기 ─────────

test('insertTableAfter: 표가 있는 문서 — 본보기 표 모양·폭을 빌리고 캡션은 표 안 자동 번호 캡션(제목 글만 변경 추적 삽입)', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const r = d.insertTableAfter(0, 1, { rows: ROWS, headerRows: 1, caption: '표 1. 연도별 응답자 수(시험)' }, { author });
  assert.deepEqual(r, { ref: 's0/p2', captionRef: 's0/p2/n0', tableKey: 's0/p2#t0', bodyShift: 1 });
  const re = await reload(d);
  const tl = re.tables();
  assert.deepEqual(tl.map((t) => t.key), ['s0/p2#t0', 's0/p4#t0', 's0/p8#t0', 's0/p12#t0', 's0/p15#t0', 's0/p18#t0']);
  const t = tl[0];
  // 사람이 적은 번호('표 1.')는 떼고 문서 꼴 '[표 ' + 자동 번호 + '] 제목'
  assert.deepEqual([t.rows, t.cols, t.caption], [4, 4, { ref: 's0/p2/n0', text: '[표 ] 연도별 응답자 수(시험)' }]);
  assert.deepEqual(t.cells.map((c) => c.text), ROWS.flat());
  assert.deepEqual(t.cells.filter((c) => c.header).map((c) => c.text), ROWS[0]);
  assert.equal(re.text('s0/p2/n0', 'markup'), '[표 ] {+연도별 응답자 수(시험)+}');
  assert.equal(re.text('s0/p2', 'final'), '');
  const ch = re.changes(); assert.equal(ch.length, 1);
  assert.deepEqual([ch[0].type, ch[0].author, ch[0].ref], ['Insert', author, 's0/p2/n0']);
  // 셀 문단 ref 가 paragraphs() 에 있다
  const cellParas = re.paragraphs().filter((p) => p.cell?.table === 's0/p2#t0');
  assert.deepEqual(cellParas.map((p) => p.ref), t.cells.flatMap((c) => c.refs));
  assert.deepEqual(cellParas[5].cell, { table: 's0/p2#t0', row: 1, col: 1, rowSpan: 1, colSpan: 1 });
  // 모양: 머리행 = 원본 머리행(굵은 charPr 19, 테두리 14/18/16), 첫 본문 행 = 13/17/15, 나머지 = 11/10/12
  const sec = re.sections[0]; const xml = sec.xml.slice(sec.byRef('s0/p2').start, sec.byRef('s0/p2').end);
  const tcs = [...xml.matchAll(/<hp:tc\b[^>]*borderFillIDRef="(\d+)"[^>]*>[\s\S]*?<hp:run charPrIDRef="(\d+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tcs.map((x) => x[0]), ['14', '18', '18', '16', '13', '17', '17', '15', '11', '10', '10', '12', '11', '10', '10', '12']);
  assert.ok(tcs.slice(0, 4).every((x) => x[1] === '19') && re.header.isBold('19'));
  // 번호 종류 '표', 캡션은 원본 표처럼 위·간격 850, 자동 번호는 문서 첫 새 번호(51)부터 이 표가 첫째
  assert.match(/<hp:tbl\b[^>]*>/.exec(xml)[0], /numberingType="TABLE"/);
  assert.match(xml, /<hp:caption side="TOP" fullSz="0" width="8503" gap="850" lastWidth="42240">/);
  assert.match(xml, /<hp:t>\[표 <\/hp:t><hp:ctrl><hp:autoNum num="51" numType="TABLE">/);
  // 너비 = 본보기 표 폭(42240 — 본문 폭 42519 의 90% 이상), 열은 글 길이 비율(다 한 줄에 들어간다)
  assert.match(xml, /<hp:sz width="42240"/);
  const widths = [...xml.matchAll(/<hp:cellSz width="(\d+)"/g)].slice(0, 4).map((m) => parseInt(m[1], 10));
  assert.deepEqual(widths, [11079, 10386, 10386, 10389]);
  assertCountsConsistent(re);
});

test('columnWidths: 좁은 열은 제 폭, 긴 글 열이 남은 폭을 나눈다(합 = 표 폭)', () => {
  const rows = [['순서', '분석 단위', '제시 내용', '분석 목적'], ['1', '교육 영역 전체', '만족도 수준, 연도별 추이', '전체 만족도 수준과 추이 파악'],
    ['3', '중분류·소분류별 개별 문항', '평균, 전년 대비 증감, 응답분포', '종합 평균만으로 파악하기 어려운 세부 항목의 특징 확인']];
  assert.deepEqual(columnWidths(rows, 42240), [3000, 13080, 13080, 13080]);
  // 다 들어가면 바라는 폭 비율, 열이 아주 많으면 고르게(최소 폭보다 좁아도)
  assert.deepEqual(columnWidths([['가', '나'], ['1', '2']], 10000), [5000, 5000]);
  const many = columnWidths([Array.from({ length: 30 }, (_, i) => `값${i}`)], 42240);
  assert.equal(many.reduce((a, b) => a + b, 0), 42240); assert.ok(many.every((w) => Math.abs(w - 1408) <= 1));
});

test('insertTableAfter: 본보기 표의 첫 열이 합친 칸이어도 첫 열 왼쪽·끝 열 오른쪽에 세로선이 생기지 않는다', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const sec = d.sections[0];
  // 합친 칸이 없는 표를 모두 '번호 없음'으로 바꿔, 첫 열이 5행 합친 칸인 성별 분포 표(s0/p7)가 본보기가 되게 한다
  for (const t of d.tables().filter((x) => x.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1))) {
    const at = sec.xml.indexOf('numberingType="TABLE"', sec.byRef(t.ref).start);
    sec.load(sec.xml.slice(0, at) + 'numberingType="NONE"' + sec.xml.slice(at + 'numberingType="TABLE"'.length));
  }
  assert.equal(d._tableModel().t.key, 's0/p7#t0');
  const rows = [['순서', '분석 단위', '제시 내용', '분석 목적'], ['1', '교육 영역 전체', '만족도 수준', '추이 파악'], ['2', '소분류', '연도별 만족도', '변화 비교'], ['3', '문항', '평균·응답분포', '특징 확인'], ['4', '종합', '주요 특징', '종합·요약']];
  const r = d.insertTableAfter(0, 1, { rows, headerRows: 1, caption: '보고서 분석 범위 및 구성' }, { author });
  const xml = sec.xml.slice(sec.byRef(r.ref).start, sec.byRef(r.ref).end);
  const bfs = [...xml.matchAll(/<hp:tc\b[^>]*borderFillIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(bfs, ['14', '18', '18', '16', '13', '17', '17', '15', '11', '10', '10', '12', '11', '10', '10', '12', '11', '10', '10', '12']);
  const side = (id, s) => /type="(\w+)"/.exec(new RegExp(`<hh:${s}Border\\b[^>]*>`).exec(d.header.block('borderFill', id))[0])[1];
  for (let i = 0; i < bfs.length; i += 4) assert.deepEqual([side(bfs[i], 'left'), side(bfs[i + 3], 'right')], ['NONE', 'NONE'], `${i / 4}행`);
  // 글 열은 가운데(본보기 칸은 숫자라 오른쪽이었다), 첫 열은 본보기 첫 열 정렬 그대로
  const align = (id) => /<hh:align horizontal="(\w+)"/.exec(d.header.block('paraPr', id))[1];
  const cellPp = (row, col) => /paraPrIDRef="(\d+)"/.exec(sec.xml.slice(sec.byRef(d.tables().find((t) => t.key === r.tableKey).cells[row * 4 + col].refs[0]).start))[1];
  assert.deepEqual([1, 2, 3].map((c) => align(cellPp(2, c))), ['CENTER', 'CENTER', 'CENTER']);
});

test('insertTableAfter: 표가 없는 문서 — 표준서식 표 모양(첫 열 왼쪽·끝 열 오른쪽 선 없음, 머리행 회색·굵게)을 header 에 만들고 메모·변경은 그대로', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const before = itemCounts(d);
  const r = d.insertTableAfter(0, 0, { rows: ROWS, caption: '표 1. 시험' }, { author });
  assert.deepEqual(r, { ref: 's0/p1', captionRef: 's0/p1/n0', tableKey: 's0/p1#t0', bodyShift: 1 });
  const after = itemCounts(d);
  assert.equal(after.borderFills[1], before.borderFills[1] + 10); // 표 바깥 1 + (머리행 · 첫 본문 행 · 나머지 행) × (첫 열 · 가운데 열 · 끝 열)
  assert.equal(after.charProperties[1], before.charProperties[1] + 1); // 굵은 글자
  assertCountsConsistent(d);
  // 두 번째 표는 같은 모양 항목을 다시 쓴다(목록이 불어나지 않는다)
  const r2 = d.insertTableAfter(0, 3, { rows: [['a', 'b'], ['1', '2']], headerRows: 1 }, { author });
  assert.deepEqual(r2, { ref: 's0/p4', captionRef: null, tableKey: 's0/p4#t0', bodyShift: 1 });
  assert.equal(itemCounts(d).borderFills[1], after.borderFills[1]);
  assert.equal(itemCounts(d).charProperties[1], after.charProperties[1]);
  const re = await reload(d);
  assertCountsConsistent(re);
  assert.deepEqual(re.tables().map((t) => [t.key, t.rows, t.cols, t.caption?.text ?? null]), [['s0/p1#t0', 4, 4, '[표 ] 시험'], ['s0/p4#t0', 2, 2, null]]);
  const sec = re.sections[0]; const xml = sec.xml.slice(sec.byRef('s0/p1').start, sec.byRef('s0/p1').end);
  // 문서에 캡션 꼴이 없으면 표준서식: 표 위 '[표 ' + 자동 번호 + '] 제목', 번호 종류 '표'
  assert.match(/<hp:tbl\b[^>]*>/.exec(xml)[0], /numberingType="TABLE"/);
  assert.match(xml, /<hp:caption side="TOP"[^>]*><hp:subList\b[^>]*><hp:p\b[^>]*><hp:run charPrIDRef="\d+"><hp:t>\[표 <\/hp:t><hp:ctrl><hp:autoNum num="1" numType="TABLE">/);
  const headCp = /<hp:tc\b[^>]*header="1"[\s\S]*?<hp:run charPrIDRef="(\d+)"/.exec(xml)[1];
  assert.ok(re.header.isBold(headCp), '머리행 글자는 굵게');
  const bfs = [...xml.matchAll(/<hp:tc\b[^>]*borderFillIDRef="(\d+)"/g)].map((m) => re.header.block('borderFill', m[1]));
  const line = (b, s) => /type="(\w+)" width="([\d.]+ mm)"/.exec(new RegExp(`<hh:${s}Border\\b[^>]*>`).exec(b)[0]).slice(1).join(' ');
  assert.deepEqual([line(bfs[0], 'left'), line(bfs[0], 'top'), line(bfs[0], 'bottom'), line(bfs[0], 'right')], ['NONE 0.1 mm', 'SOLID 0.5 mm', 'DOUBLE_SLIM 0.5 mm', 'SOLID 0.15 mm']);
  assert.match(bfs[0], /faceColor="#BFBFBF"/);
  assert.deepEqual([line(bfs[5], 'top'), line(bfs[5], 'bottom'), line(bfs[7], 'right'), line(bfs[8], 'left'), line(bfs[9], 'top')], ['DOUBLE_SLIM 0.5 mm', 'SOLID 0.15 mm', 'NONE 0.1 mm', 'NONE 0.1 mm', 'SOLID 0.15 mm']);
  assert.ok(!bfs[5].includes('faceColor'), '본문 칸은 바탕 없음');
  // 정렬: 머리행 가운데, 첫 열 왼쪽, 숫자 열 오른쪽
  const align = (row, col) => {
    const cell = re.tables()[0].cells[row * 4 + col];
    return /<hh:align horizontal="(\w+)"/.exec(re.header.block('paraPr', /paraPrIDRef="(\d+)"/.exec(sec.xml.slice(sec.byRef(cell.refs[0]).start))[1]))[1];
  };
  assert.deepEqual([align(0, 0), align(1, 0), align(1, 1), align(1, 3)], ['CENTER', 'LEFT', 'RIGHT', 'RIGHT']);
  // 원래 메모·변경 추적이 살아 있다(캡션 제목 삽입 1건이 끝에 붙음)
  assert.deepEqual(re.memos().map((m) => [m.id, m.ref]), [['memo1', 's0/p0']]);
  assert.deepEqual(re.changes().map((c) => [c.id, c.type, c.ref]), [[1, 'Insert', 's0/p2'], [2, 'Delete', 's0/p2'], [3, 'Insert', 's0/p3'], [4, 'Delete', 's0/p3'], [5, 'Insert', 's0/p1/n0']]);
  assert.equal(re.text('s0/p2', 'final'), '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)');
});

test('stripCaptionNumber: 사람이 적은 표 번호만 뗀다', () => {
  for (const [a, b] of [['[표 3] 보고서', '보고서'], ['<표 3> 보고서', '보고서'], ['표 3. 보고서', '보고서'], ['표3 보고서', '보고서'], ['표 3-1. 제목', '제목'],
    ['표. 요약', '요약'], ['[표 ] 교육', '교육'], ['(표 4) 제목', '제목'], ['표 2', ''], ['표본 설계', '표본 설계'], ['표 1,234명', '표 1,234명'], ['표 캡션', '표 캡션']]) assert.equal(stripCaptionNumber(a), b, a);
});

test('insertTableAfter: 빈 셀 채우기·셀 교체·셀 메모(변경 추적) — 빈 문단 감싸기 편집 회귀', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const r = d.insertTableAfter(0, 1, { rows: ROWS, caption: '셀 편집 시험' }, { author });
  const cells = d.tables().find((t) => t.key === r.tableKey).cells;
  const empty = cells.find((c) => c.row === 1 && c.col === 3).refs[0];
  d.insertTracked(empty, 0, '1,402', { author }); // <hp:run …/> 빈 셀
  const c11 = cells.find((c) => c.row === 1 && c.col === 1).refs[0];
  const f = d.find(c11, '1,234'); d.replaceTracked(c11, f.start, f.end, '1,235', { author });
  d.addMemo(c11, { author, text: '[제안 7] 셀 값' });
  d.addMemo(r.ref, { author, text: '[제안 8 · 표 삽입]' }); // 글 없는 표 문단 전체 메모
  d.insertTracked(r.ref, 0, '표 뒤 글', { author }); // 표 뒤 <hp:t/> → <hp:t>…</hp:t>
  // run 안에 hp:t 가 없는 빈 문단(<hp:run …></hp:run>)
  const sec = d.sections[0]; const p3 = sec.bodyParas[3];
  sec.load(sec.xml.slice(0, p3.end) + '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"></hp:run></hp:p>' + sec.xml.slice(p3.end));
  d.insertTracked('s0/p4', 0, '빈 run 채움', { author });
  const re = await reload(d);
  assert.equal(re.sections[0].bodyParas.length, 5); // 3 + 표(캡션은 표 안) + 빈 run 문단
  assert.equal(re.text(empty, 'markup'), '{+1,402+}');
  assert.equal(re.text(c11, 'markup'), '[-1,234-]{+1,235+}');
  assert.equal(re.text(r.ref, 'markup'), '{+표 뒤 글+}');
  assert.equal(re.text(r.captionRef, 'markup'), '[표 ] {+셀 편집 시험+}');
  assert.equal(re.text('s0/p4', 'markup'), '{+빈 run 채움+}');
  assert.deepEqual(re.memos().filter((m) => m.author === author).map((m) => [m.ref, m.text]), [[r.ref, '[제안 8 · 표 삽입]'], [c11, '[제안 7] 셀 값']]);
  assert.equal(re.tables().find((t) => t.key === r.tableKey).cells.find((c) => c.row === 1 && c.col === 3).text, '1,402');
  // 셀 글 병합(빈 셀 → 글)
  const d2 = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const r2 = d2.insertTableAfter(0, 0, { rows: [['a', ''], ['', 'b']] }, { author });
  const e2 = d2.tables().find((t) => t.key === r2.tableKey).cells[1].refs[0];
  assert.equal(d2.mergeParagraphText(e2, '채움', { author }).length, 1);
  assert.equal((await reload(d2)).text(e2, 'markup'), '{+채움+}');
});

test('insertTableAfter: 긴 표는 자리 차지(쪽에서 셀 단위로 나뉨), 잘못된 rows 는 거절', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const tall = [['번호', '값']]; for (let i = 1; i <= 70; i++) tall.push([String(i), String(i * 3)]);
  const r = d.insertTableAfter(0, 1, { rows: tall }, { author });
  const sec = d.sections[0]; const xml = sec.xml.slice(sec.byRef(r.ref).start, sec.byRef(r.ref).end);
  assert.match(xml, /treatAsChar="0"/); assert.match(xml, /pageBreak="CELL"/); assert.match(xml, /repeatHeader="1"/);
  // 작은 표는 글자처럼 취급(새 문서). 표가 이미 있는 문서에서는 그 표의 배치(자리 차지 포함)를 빌린다.
  const fresh = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const small = fresh.insertTableAfter(0, 0, { rows: [['a', 'b'], ['1', '2']] }, { author });
  const fs0 = fresh.sections[0];
  assert.match(fs0.xml.slice(fs0.byRef(small.ref).start, fs0.byRef(small.ref).end), /treatAsChar="1"/);
  const borrowed = d.insertTableAfter(0, 0, { rows: [['a']] }, { author });
  assert.match(sec.xml.slice(sec.byRef(borrowed.ref).start, sec.byRef(borrowed.ref).end), /treatAsChar="0"/);
  // 열 수가 다른 행은 빈 칸으로 채운다, 제어 문자는 뺀다
  const r3 = d.insertTableAfter(0, 0, { rows: [['a', 'b', 'c'], ['x\u0001y']], headerRows: 0 }, { author });
  const t3 = d.tables().find((t) => t.key === r3.tableKey);
  assert.deepEqual([t3.rows, t3.cols, t3.cells.map((c) => c.text)], [2, 3, ['a', 'b', 'c', 'xy', '', '']]);
  assert.ok(t3.cells.every((c) => !c.header));
  for (const bad of [[], [[]], ['ab'], null]) assert.throws(() => d.insertTableAfter(0, 0, { rows: bad }, { author }), (e) => e.code === 'TABLE_ROWS');
  assert.throws(() => d.insertTableAfter(9, 0, { rows: [['a']] }, { author }), (e) => e.code === 'NO_SECTION');
});

test('insertTableAfter: rhwp(WASM) 가 표로 읽고 그 쪽 SVG 에 셀 글이 있다', async (t) => {
  const core = path.join(here, '..', 'vendor', 'rhwp', 'pkg');
  if (!fs.existsSync(path.join(core, 'rhwp_bg.wasm'))) { t.skip('vendor/rhwp/pkg 없음'); return; }
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import('file:///' + path.join(core, 'rhwp.js').replace(/\\/g, '/'));
  mod.initSync({ module: fs.readFileSync(path.join(core, 'rhwp_bg.wasm')) });
  const sources = [['fixture', fx('tool_memo_tracked.hwpx')]];
  if (hasBiz) sources.push(['biz', fs.readFileSync(BIZ)]);
  for (const [name, buf] of sources) {
    const d = await HwpxDoc.load(buf);
    const r = d.insertTableAfter(0, 1, { rows: ROWS, caption: '표 9. rhwp 시험' }, { author });
    const body = parseInt(r.ref.split('/p')[1], 10);
    const rd = new mod.HwpDocument(new Uint8Array(await d.save()));
    assert.deepEqual(JSON.parse(rd.getTableDimensions(0, body, 0)), { rowCount: 4, colCount: 4, cellCount: 16 }, name);
    const page = JSON.parse(rd.getPageOfPosition(0, body)).page;
    const text = [...rd.renderPageSvg(page).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('');
    for (const w of ['구분', '1,234', '합계', '2,042']) assert.ok(text.includes(w), `${name}: ${w}`);
    // 캡션 자동 번호를 rhwp 가 매긴다(표 없는 문서는 1, biz 는 새 번호 51 부터 첫 표)
    assert.ok(text.includes(name === 'biz' ? '[표51]rhwp시험' : '[표1]rhwp시험'), `${name}: 캡션`);
    rd.free?.();
  }
});

// ───────── 본문 문단 지우기 ─────────

test('removeBodyParagraph: 첫 문단은 거부, 변경 표식은 헤더까지 정리하고 번호를 다시 매긴다', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  assert.throws(() => d.removeBodyParagraph(0, 0), (e) => e.code === 'FIRST_PARAGRAPH');
  assert.throws(() => d.removeBodyParagraph(0, 9), (e) => e.code === 'NO_PARAGRAPH');
  assert.equal(d.removeBodyParagraph(0, 1), true); // 변경 1·2 가 든 문단
  assert.deepEqual(d.changes().map((c) => [c.id, c.type, c.text, c.ref]), [[1, 'Insert', 'AI 제안대로 ', 's0/p1'], [2, 'Delete', '그대로 ', 's0/p1']]);
  // 서비스가 하는 방식(차례로 적용)으로 제안 changeIds 를 맞추면 3,4 → 1,2
  let ids = [1, 2, 3, 4];
  for (const e of d.takeRenumberLog()) ids = ids.filter((c) => c !== e.removed).map((c) => (e.map.has(c) ? e.map.get(c) : c));
  assert.deepEqual(ids, [1, 2]);
  assertCountsConsistent(d);
  const re = await reload(d);
  assert.deepEqual(re.paragraphs({ nested: false }).map((p) => p.text), ['첫째 문단입니다. 메모 대상 문장이 여기 있습니다.', '셋째 문단은 AI 제안대로 둡니다.']);
  assert.equal(re.text('s0/p1', 'markup'), '셋째 문단은 [-그대로 -]{+AI 제안대로 +}둡니다.');
  assert.equal(re.memos().length, 1);
});

test('removeBodyParagraph: 표 넣기를 되돌리면(캡션이 든 표 문단 지우기) 구역 XML 이 원래대로', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const xml0 = d.sections[0].xml; const refs0 = bodyRefs(d); const tables0 = d.tables().length;
  const r = d.insertTableAfter(0, 5, { rows: ROWS, caption: '되돌릴 표' }, { author });
  d.removeBodyParagraph(0, parseInt(r.ref.split('/p')[1], 10));
  assert.equal(d.sections[0].xml, xml0);
  assert.deepEqual([bodyRefs(d), d.tables().length, d.changes().length], [refs0, tables0, 0]);
  assert.deepEqual(d.takeRenumberLog().map((e) => e.removed), [1]);
});

test('removeBodyParagraph: 문단 밖으로 이어진 메모 필드의 짝을 정리한다', async () => {
  // 메모를 s0/p1 에서 시작해 s0/p2 에서 끝나게 만든다
  const make = async () => {
    const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
    const id = d.addMemo('s0/p1', { start: 0, end: 4, author, text: '두 문단 메모' });
    const sec = d.sections[0];
    const fid = d.memos().find((m) => m.id === id).fieldId;
    const endRe = new RegExp(`<hp:ctrl><hp:fieldEnd beginIDRef="${fid}"[^>]*/></hp:ctrl>`);
    const endXml = endRe.exec(sec.xml)[0];
    let xml = sec.xml.replace(endXml, '');
    const p2 = /<hp:p\b[^>]*>(<hp:run charPrIDRef="0">)<hp:t>셋째/.exec(xml);
    const at = p2.index + p2[0].indexOf('<hp:t>셋째');
    xml = xml.slice(0, at) + endXml + xml.slice(at);
    sec.load(xml);
    const m = d.memos().find((x) => x.id === id);
    assert.deepEqual([m.ref, m.endRef], ['s0/p1', 's0/p2']);
    return { d, id, fid };
  };
  // 시작이 든 문단을 지우면 바깥 끝 표식도 지운다
  let { d, id, fid } = await make();
  d.removeBodyParagraph(0, 1);
  assert.ok(!d.sections[0].xml.includes(`beginIDRef="${fid}"`));
  assert.ok(!d.memos().some((m) => m.id === id));
  // 끝이 든 문단을 지우면 끝 표식을 앞 문단 끝으로 옮긴다
  ({ d, id, fid } = await make());
  d.removeBodyParagraph(0, 2);
  const re = await reload(d);
  const m = re.memos().find((x) => x.id === id);
  assert.deepEqual([m.ref, m.endRef, m.text, m.start], ['s0/p1', 's0/p1', '두 문단 메모', 0]);
  assert.equal(m.end, re.paragraphs().find((p) => p.ref === 's0/p1').length);
});

// 변경 추적 실시간 문서에서 지운 문단(server/live.js): 지운 글 표식은 남기고 문단만 앞 문단에 붙인다
test('joinBodyParagraph: 내용을 앞 문단 마지막 run 끝으로(글자 모양·변경 표식 그대로) · 빈 hp:t·짝 없는 필드 끝은 버림', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  assert.throws(() => d.joinBodyParagraph(0, 0), (e) => e.code === 'FIRST_PARAGRAPH');
  assert.throws(() => d.joinBodyParagraph(0, 9), (e) => e.code === 'NO_PARAGRAPH');
  // s0/p2 머리에 짝 없는 필드 끝 + 빈 run, 끝에 빈 hp:t(다른 글자 모양) — 옮기지 않을 것
  const sec = d.sections[0]; const p2 = sec.bodyParas[2];
  const runAt = sec.xml.indexOf('<hp:run', p2.start); const runEnd = sec.xml.indexOf('</hp:run>', p2.start) + '</hp:run>'.length;
  sec.load(sec.xml.slice(0, runAt) + '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="999999" fieldid="1"/></hp:ctrl><hp:t/></hp:run>'
    + sec.xml.slice(runAt, runEnd) + '<hp:run charPrIDRef="1"><hp:t></hp:t></hp:run>' + sec.xml.slice(runEnd));
  const runsOfP1 = () => { const p = d.sections[0].bodyParas[1]; return d.sections[0].xml.slice(p.start, p.end).match(/<hp:run\b[^>]*>/g); };
  const runs0 = runsOfP1(); const ids0 = d.changes().map((c) => [c.id, c.type, c.text]);
  assert.equal(d.joinBodyParagraph(0, 2), true);
  assert.deepEqual(d.paragraphs({ nested: false }).map((p) => p.ref), ['s0/p0', 's0/p1']);
  assert.equal(d.text('s0/p1', 'markup'), '둘째 문단입니다. [-원래 -]있던 낱말을 지우고 새 낱말을 넣습니다.{+ (AI가 추가한 문장)+}셋째 문단은 [-그대로 -]{+AI 제안대로 +}둡니다.');
  assert.deepEqual(runsOfP1(), runs0, '앞 문단의 run(글자 모양)은 그대로 — 옮긴 글은 마지막 run 안으로');
  assert.deepEqual(d.changes().map((c) => [c.id, c.type, c.text]), ids0, '변경 표식·헤더 항목 그대로');
  const xml = d.sections[0].xml;
  assert.ok(!xml.includes('beginIDRef="999999"') && !/<hp:t\/>|<hp:t><\/hp:t>/.test(xml), '짝 없는 필드 끝·빈 hp:t 는 옮기지 않음');
  assertCountsConsistent(d);
  const re = await reload(d);
  assert.equal(re.text('s0/p1', 'markup'), d.text('s0/p1', 'markup'));
  assert.equal((await re.flattened()).bodyTexts()[0][1], '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)셋째 문단은 AI 제안대로 둡니다.');
});

// ───────── 병합: bodyMap · 중첩 문단 ─────────

test('mergeBodyTexts: bodyMap 과 report ref 는 병합 뒤 문서 기준', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  d.acceptAll();
  const old = d.paragraphs({ nested: false }).map((p) => p.text);
  const target = [old[0], '새 문단 A', old[1].replace('있던 낱말을', '있던 단어를'), old[2], '새 문단 B'];
  const rep = d.mergeBodyTexts({ 0: target }, { author: '편집자' });
  assert.deepEqual(rep.bodyMap, { 0: [0, 2, 3] });
  assert.deepEqual(rep.inserted, ['s0/p1', 's0/p4']);
  assert.deepEqual(rep.changed, ['s0/p2']);
  assert.deepEqual([rep.deleted, rep.skippedNested], [[], []]);
  assert.deepEqual(d.paragraphs({ nested: false }).map((p) => p.text), target);
  // 삭제(추적)는 문단이 남으므로 bodyMap 에 -1 이 없다
  const d2 = await HwpxDoc.load(fx('tool_memo_tracked.hwpx')); d2.acceptAll();
  const o2 = d2.paragraphs({ nested: false }).map((p) => p.text);
  const rep2 = d2.mergeBodyTexts({ 0: [o2[0], o2[2], '끝 문단'] }, { author: '편집자' });
  assert.deepEqual([rep2.bodyMap[0], rep2.deleted, rep2.inserted], [[0, 1, 2], ['s0/p1'], ['s0/p3']]);
  // 맨 앞(첫 문단 앞) 추가는 첫 문단 뒤로, 순서는 유지
  const d3 = await HwpxDoc.load(fx('tool_memo_tracked.hwpx')); d3.acceptAll();
  const o3 = d3.paragraphs({ nested: false }).map((p) => p.text);
  const rep3 = d3.mergeBodyTexts({ 0: ['앞 1', '앞 2', ...o3] }, { author: '편집자' });
  assert.deepEqual([rep3.inserted, rep3.bodyMap[0]], [['s0/p1', 's0/p2'], [0, 3, 4]]);
  assert.deepEqual(d3.paragraphs({ nested: false }).map((p) => p.text), [o3[0], '앞 1', '앞 2', o3[1], o3[2]]);
});

test('mergeBodyTexts: 표 셀(중첩 문단) 병합, 구조가 다르면 건너뛴다, 메모 본문은 비교에서 뺀다', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  d.addMemo('s0/p3/n8', { author, text: '셀 메모(비교에서 빠져야 함)' });
  const edited = await biz();
  edited.mergeParagraphText('s0/p3/n8', '270', { author: 'x' }); // 셀 (1,1) 268 → 270
  edited.mergeParagraphText('s0/p7/n20', '9', { author: 'x' }); // 둘째 표의 한 셀
  edited.acceptAll();
  const texts = edited.bodyTexts({ nested: true });
  texts[0].splice(2, 0, { text: '새 문단', nested: [] }); // 본문 문단 하나 추가 → 뒤 문단 번호 +1
  const rep = d.mergeBodyTexts(texts, { author: '편집자' });
  assert.deepEqual(rep.changed, ['s0/p4/n8', 's0/p8/n20']);
  assert.deepEqual([rep.inserted, rep.skippedNested], [['s0/p2'], []]);
  assert.deepEqual(rep.bodyMap[0].slice(0, 5), [0, 1, 3, 4, 5]);
  assert.equal(d.text('s0/p4/n8', 'markup'), '2[-68-]{+70+}');
  assert.equal(d.memos().find((m) => m.author === author).ref, 's0/p4/n8');
  // 글 목록은 문자열로 두고 중첩 글만 opts.nested 로 줄 수도 있다
  const d2 = await biz();
  const nt = edited.nestedTexts(); const bt = edited.bodyTexts();
  const rep2 = d2.mergeBodyTexts(bt, { author: '편집자', nested: nt });
  assert.deepEqual(rep2.changed, ['s0/p3/n8', 's0/p7/n20']);
  // 구조가 다르면(셀 문단 수가 다름) 건너뛰고 본문 ref 를 알린다
  const d3 = await biz();
  const t3 = d3.bodyTexts({ nested: true });
  t3[0][3].nested.pop(); t3[0][7].nested[5] = { text: '바뀐 글', sig: 'hp:tbl#t0@99,99' };
  const rep3 = d3.mergeBodyTexts(t3, { author: '편집자' });
  assert.deepEqual([rep3.changed, rep3.skippedNested, rep3.ids], [[], ['s0/p3', 's0/p7'], []]);
  // 같은 것끼리 병합하면 아무 일도 없다(메모 본문이 있어도)
  assert.deepEqual(d.mergeBodyTexts(d.bodyTexts({ nested: true }), { author: '편집자' }).ids, []);
});

test('mergeBodyTexts: 옛 버전으로 복구(본문 + 표 셀)', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const v1 = await biz();
  const cur = await biz();
  cur.mergeParagraphText('s0/p1', cur.text('s0/p1') + ' 덧붙임', { author: 'A' });
  cur.mergeParagraphText('s0/p3/n9', '999', { author: 'A' });
  cur.acceptAll();
  const rep = cur.mergeBodyTexts(v1.bodyTexts({ nested: true }), { author: '복구자' });
  assert.deepEqual(rep.changed, ['s0/p1', 's0/p3/n9']);
  assert.deepEqual(cur.bodyTexts({ nested: true }), v1.bodyTexts({ nested: true }));
  assert.ok(cur.changes().every((c) => c.author === '복구자'));
  const re = await reload(cur);
  assert.deepEqual(re.bodyTexts({ nested: true }), v1.bodyTexts({ nested: true }));
});
