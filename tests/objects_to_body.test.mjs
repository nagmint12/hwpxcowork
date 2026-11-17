// 개체 → 본문(engine/layout.js·engine/flow.js, 쪽 구성 op objects_to_body — docs/MCP_REDESIGN_2026-11-16.md §4).
// 떠 있는 글상자·괘선 문서는 tests/helpers/floating-doc.mjs 가 만든다(실제 사용자 문서를 쓰지 않는다).
//   node --test tests/objects_to_body.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { HwpxDoc } from '../engine/doc.js';
import { analyzeLayout, analyzeHost, layoutFingerprint, inferMargins, convertibleHosts } from '../engine/layout.js';
import { objectsToBody, textCount } from '../engine/flow.js';
import { editPageLayout, getPageLayout, structureObjectsFingerprint } from '../engine/page-layout.js';
import { normalizePageLayoutOps } from '../server/page-layout-schema.js';
import { verifyStructure } from '../server/edit-verify.js';
import { floatingDoc, textBox } from './helpers/floating-doc.mjs';

const COLS = [5200, 14000, 11000, 17600];
const HEADER = ['기능', 'Action', 'ParameterSet', 'explanation'];
const page1 = { title: 'Frame Action', pageNumber: '1', table: { cols: COLS, header: true, merge: [[1, 0, 2], [3, 0, 2]],
  rows: [HEADER, ['창', 'SplitAll', '없음', '창 가로 세로 나누기'], ['', 'NoSplit', '없음', '창 나누지 않음'], ['기타', 'CharShapeHeight', '없음', '글자 크기'], ['', 'MoveDocBegin', '없음', '문서의 시작으로 이동. 현재 서브 리\n스트 내에 있으면 빠져나간다.']] } };
// 2쪽: 머리행 없이 이어짐. 첫 줄은 앞 쪽 마지막 줄의 나머지(Action 칸이 빔), 첫 열은 앞 쪽 '기타' 칸이 이어진 합친 칸
const page2 = { pageNumber: '2', table: { cols: COLS, merge: [[0, 0, 2]],
  rows: [['', '', '', '서브리스트가 속한 곳이다.'], ['', 'MoveDocEnd', '없음', '문서의 끝으로 이동'], ['도구', 'MacroPlay1', 'KeyMacro', '키 매크로 1']] } };
// 3쪽: 열 구조가 다른 새 표
const page3 = { title: 'Action', pageNumber: '3', table: { cols: [8000, 20000, 19800], header: true, rows: [['이름', '값', '설명'], ['A', '1', '첫째'], ['B', '2', '둘째']] } };

const bodyTexts = (doc) => doc.paragraphs({ nested: false }).map((p) => p.text);
const cellGrid = (t) => { const g = Array.from({ length: t.rows }, () => Array(t.cols).fill(null)); for (const c of t.cells) g[c.row][c.col] = c.text; return g; };

test('배치 읽기: 괘선으로 표 격자와 합친 칸을, 면으로 머리행을, 격자 밖 글상자로 제목 줄과 쪽 번호를 읽는다', async () => {
  const doc = await floatingDoc({ pages: [page1] });
  const h = analyzeHost(doc, 's0/p0');
  assert.equal(h.counts.rule > 0 && h.counts.text > 0, true);
  assert.deepEqual(h.blocks.map((b) => b.type), ['lines', 'grid', 'lines']);
  const g = h.blocks[1];
  assert.deepEqual([g.rows, g.cols, g.headerRows], [5, 4, 1]);
  // 합친 칸(첫 열 1~2줄 '창', 3~4줄 '기타')
  assert.deepEqual(g.cells.filter((c) => c.rs > 1).map((c) => [c.r, c.c, c.rs, c.text]), [[1, 0, 2, '창'], [3, 0, 2, '기타']]);
  // 낱말 조각은 빈칸을 품은 대로 이어 붙이고, 빈칸 없이 줄이 바뀐 낱말('서브 리' + '스트')은 붙인다
  assert.equal(g.cells.find((c) => c.r === 4 && c.c === 3).text, '문서의 시작으로 이동. 현재 서브 리스트 내에 있으면 빠져나간다.');
  assert.equal(h.blocks[0].lines[0].text, 'Frame Action');
  assert.equal(h.blocks[2].lines[0].role, 'page_number');
  assert.equal(h.spaced, true);
});

test('쪽을 넘는 표: 열 구조가 같으면 잇고, 끊긴 줄·끊긴 합친 칸을 붙이며, 열 구조가 다르면 새 표다', async () => {
  const doc = await floatingDoc({ pages: [page1, page2, page3] });
  const plan = analyzeLayout(doc);
  assert.equal(plan.tables.length, 2);
  const [a, b] = plan.tables;
  assert.deepEqual([a.hosts, a.rows, a.cols, a.headerRows], [['s0/p0', 's1/p0'], 7, 4, 1]);
  // 2쪽 첫 줄(Action 칸이 빈 줄)은 1쪽 마지막 줄 설명에 이어진다
  assert.equal(a.grid[4][3], '문서의 시작으로 이동. 현재 서브 리스트 내에 있으면 빠져나간다. 서브리스트가 속한 곳이다.');
  assert.deepEqual(a.grid[5], ['', 'MoveDocEnd', '없음', '문서의 끝으로 이동']);
  assert.deepEqual(a.grid[6], ['도구', 'MacroPlay1', 'KeyMacro', '키 매크로 1']);
  // '기타' 칸은 쪽 경계를 넘어 한 칸(3~5줄), '창' 은 그대로
  assert.deepEqual(a.merges, [{ r: 1, c: 0, rs: 2, cs: 1 }, { r: 3, c: 0, rs: 3, cs: 1 }]);
  assert.deepEqual([b.host, b.rows, b.cols, b.headerRows], ['s2/p0', 3, 3, 1]);
  assert.deepEqual(plan.dropped.map((d) => d.text), ['1', '2', '3']);
  assert.deepEqual(plan.flow.map((f) => f.items.map((i) => (i.type === 'para' ? i.text : `표${i.table}`))), [['Frame Action', '표0'], [], ['Action', '표1']]);
  // 잇지 않기·쪽 번호 남기기·줄 버리기
  assert.equal(analyzeLayout(doc, { joinPages: false }).tables.length, 3);
  assert.equal(analyzeLayout(doc, { keepPageNumbers: true }).dropped.length, 0);
  assert.deepEqual(analyzeLayout(doc, { drop: ['s0/p0:L1'] }).dropped.map((d) => `${d.why}:${d.text}`), ['지정:Frame Action', '쪽 번호:1', '쪽 번호:2', '쪽 번호:3']);
});

test('개체 → 본문: 글상자·선을 지우고 본문 문단·표로 옮긴다 — 글자 보존, 구역 합치기, 여백 추정, 구조 검사 통과', async () => {
  const doc = await floatingDoc({ pages: [page1, page2, page3] });
  const before = textCount(doc); const beforeBytes = await doc.save();
  const { report, mapping } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual(report.tables.map((t) => [t.ref, t.rows, t.cols, t.headerRows, t.merges, t.pages]), [['s0/p1', 7, 4, 1, 2, 2], ['s0/p3', 3, 3, 1, 0, 1]]);
  assert.deepEqual([report.paragraphs, report.kept, report.sections, report.text.lost, report.text.extra], [2, 0, [3, 1], 0, 0]);
  assert.equal(report.text.moved + report.text.dropped, report.text.source);
  assert.deepEqual(report.margins, { left: 20, right: 20, top: 20, bottom: 15, header: 15, footer: 15, gutter: 0 });
  // 문서: 제목 글은 첫 문단으로 올라오고(빈 줄을 남기지 않는다), 표 문단, 제목, 표 문단
  assert.deepEqual(bodyTexts(doc), ['Frame Action', '', 'Action', '']);
  assert.equal(doc.sections.length, 1);
  for (const sec of doc.sections) for (const p of sec.bodyParas) assert.equal(doc.ownObjects(p.ref).filter((o) => o.kind === 'shape').length, 0);
  const tables = doc.tables();
  assert.deepEqual(tables.map((t) => [t.key, t.rows, t.cols]), [['s0/p1#t0', 7, 4], ['s0/p3#t0', 3, 3]]);
  const g = cellGrid(tables[0]);
  assert.deepEqual(g[0], ['기능', 'Action', 'ParameterSet', 'explanation']);
  assert.deepEqual(g[1], ['창', 'SplitAll', '없음', '창 가로 세로 나누기']);
  assert.equal(g[2][0], null);   // 합친 칸에 가려진 자리
  assert.deepEqual(tables[0].cells.filter((c) => c.rowSpan > 1).map((c) => [c.row, c.col, c.rowSpan, c.text]), [[1, 0, 2, '창'], [3, 0, 3, '기타']]);
  // 칸 너비는 원래 괘선 간격의 비율을 따른다
  const widths = [...doc.sections[0].xml.matchAll(/<hp:cellAddr colAddr="(\d)" rowAddr="0"\/><hp:cellSpan[^>]*\/><hp:cellSz width="(\d+)"/g)].slice(0, 4).map((m) => Number(m[2]));
  const total = widths.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(widths[1] / total - 14000 / 47800) < 0.01, `칸 너비 비율 ${widths}`);
  // 주소 옮김표: 첫 문단은 그대로, 비게 된 구역 첫 문단들은 지워짐
  assert.deepEqual(mapping, [{ old: [0, 0], to: [0, 0] }, { old: [1, 0], to: null }, { old: [2, 0], to: null }]);
  // 글자 보존(쪽 번호 6글자 빼고 같음)과 저장 파일 구조
  let diff = 0; const after = textCount(doc);
  for (const ch of new Set([...before.keys(), ...after.keys()])) diff += Math.abs((before.get(ch) || 0) - (after.get(ch) || 0));
  assert.equal(diff, 3);
  const baseIssues = await verifyStructure(beforeBytes, { parse: true });
  const v1 = await verifyStructure(await doc.save(), { before: new Set(baseIssues.all.keys()), parse: true });
  assert.deepEqual(v1.fresh, []);
  const again = await HwpxDoc.load(await doc.save());
  assert.deepEqual(again.tables().map((t) => t.rows), [7, 3]);
  assert.equal(Math.round(getPageLayout(again).sections[0].paper.margins.left), 20);
});

test('개체 → 본문: 대상·여백·구역 합치기 옵션과 남기는 개체', async () => {
  // 대상 문단만(2쪽은 그대로), 여백 그대로, 구역 합치지 않기
  const doc = await floatingDoc({ pages: [page1, page3] });
  const { report } = objectsToBody(doc, { refs: ['s0/p0'], margins: 'keep', mergeSections: false, author: '시험' });
  assert.deepEqual([report.tables.length, report.sections, report.margins], [1, [2, 2], null]);
  assert.equal(doc.ownObjects('s1/p0').length > 0, true);
  assert.equal(getPageLayout(doc).sections[0].paper.margins.left, 0);
  // 글이 든 글상자 안에 표·그림이 없는 보통 문단과 섞인 문서: 본문 문단은 그대로, 주소는 뒤로 밀린다
  const mixed = await floatingDoc({ pages: [{ title: '머리 글', body: ['본문 첫 줄', '본문 둘째 줄'] }], zeroMargins: false });
  const out = objectsToBody(mixed, { author: '시험' });
  assert.deepEqual(bodyTexts(mixed), ['머리 글', '본문 첫 줄', '본문 둘째 줄']);
  assert.deepEqual(out.mapping, [{ old: [0, 0], to: [0, 0] }, { old: [0, 1], to: [0, 1] }, { old: [0, 2], to: [0, 2] }]);
  assert.equal(out.report.margins, null);   // 여백이 0 이 아니면 손대지 않는다
  // 옮길 개체가 없으면 NO_OBJECTS
  const plain = await floatingDoc({ pages: [{ body: ['글만'] }] });
  assert.throws(() => objectsToBody(plain), (e) => e.code === 'NO_OBJECTS');
});

test('쪽 번호: 한 쪽뿐이거나 번호가 쪽마다 늘 때만 쪽 번호로 보고, 본문에 놓인 숫자 줄은 지우지 않는다', async () => {
  const same = await floatingDoc({ pages: [{ title: '가', pageNumber: '7' }, { title: '나', pageNumber: '7' }] });
  assert.equal(analyzeLayout(same).dropped.length, 0);
  const mid = await floatingDoc({ pages: [{ title: '가', lines: [{ x: 6000, y: 40000, text: '2026' }] }] });
  assert.equal(analyzeLayout(mid).dropped.length, 0);
});

test('쪽 구성 제안 op: objects_to_body 는 쪽 구성 ops 와 함께 검사·적용되고 주소 옮김표·결과 줄을 돌려준다', async () => {
  const ops = normalizePageLayoutOps([{ op: 'objects_to_body' }, { op: 'paper', section: 0, margins: { top: 25 } }]);
  assert.throws(() => normalizePageLayoutOps([{ op: 'objects_to_body', nope: 1 }]));
  const doc = await floatingDoc({ pages: [page1, page2] });
  const print = structureObjectsFingerprint(doc, ops);
  assert.equal(typeof print, 'string');
  assert.equal(structureObjectsFingerprint(doc, [{ op: 'paper', section: 0 }]), null);
  const out = editPageLayout(doc, ops, { author: '시험' });
  assert.match(out.labels[0], /^개체 → 본문: 표 1개\(7×4\) · 문단 1개 · 글상자·선 \d+개 지움 · 쪽 번호 2줄 버림 · 구역 2→1 · 여백 좌우 20mm$/);
  assert.equal(out.reports.length, 1);
  assert.deepEqual(out.mapping, [{ old: [0, 0], to: [0, 0] }, { old: [1, 0], to: null }]);
  // 글상자 안 문단 주소는 모두 없어진다
  assert.equal(out.refMapping.length > 0 && out.refMapping.every((m) => m.to === null), true);
  assert.equal(Math.round(getPageLayout(doc).sections[0].paper.margins.top), 25);
  // 개체가 바뀌면 지문이 달라진다(제안 뒤 바뀐 문서에는 적용하지 않는다)
  const other = await floatingDoc({ pages: [page1, { ...page2, pageNumber: '9' }] });
  assert.notEqual(structureObjectsFingerprint(other, ops), print);
  assert.equal(layoutFingerprint(other, ['s0/p0']), layoutFingerprint(await floatingDoc({ pages: [page1] }), ['s0/p0']));
});

test('여백 추정: 조각의 좌우 끝으로 잡고 범위를 벗어나면 한도로', () => {
  assert.deepEqual(inferMargins([{ paper: { w: 59500, h: 84100 }, bounds: { left: 5800, right: 53700 } }]).left, 20);
  assert.equal(inferMargins([{ paper: { w: 59500, h: 84100 }, bounds: { left: 100, right: 59400 } }]).left, 10);
  assert.equal(inferMargins([]).left, 30);
});

// 안에 표가 든 글상자(옮기지 못해 남는 개체): 글상자 글 '안쪽' + 안의 표 칸 글 '칸' = 글자 3개
const INNER_TABLE = '<hp:tbl id="900" zOrder="900" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">'
  + '<hp:sz width="5000" widthRelTo="ABSOLUTE" height="1000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
  + '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:tr><hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">'
  + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>칸</hp:t></hp:run></hp:p></hp:subList>'
  + '<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="5000" height="1000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr></hp:tbl>';
const complexBox = () => textBox(500, 6000, 50000, 8000, 3000, '안쪽').replace('<hp:t>안쪽</hp:t>', `${INNER_TABLE}<hp:t>안쪽</hp:t>`);

test('안에 표가 든 글상자는 옮기지 않고 남긴다', async () => {
  const doc = await floatingDoc({ pages: [{ title: '제목 줄', extra: complexBox() }] });
  const h = analyzeHost(doc, 's0/p0');
  assert.deepEqual([h.counts.complex, h.kept], [1, 1]);
  const { report } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual([report.kept, report.removedRest, report.text.removedWithObjects], [1, 0, 0]);
  assert.equal(doc.ownObjects('s0/p0').length, 1);
  assert.deepEqual(bodyTexts(doc), ['', '제목 줄']);   // 글상자가 남은 문단은 그대로 두고 제목 줄은 뒤에 넣는다
});

test('남는 개체도 지우기(remove_rest): 옮기지 못해 남은 개체를 같은 옮기기 안에서 지우고, 함께 사라진 글자 수를 밝힌다', async () => {
  const make = () => floatingDoc({ pages: [{ title: '제목 줄', extra: complexBox() }, page3] });
  assert.deepEqual(convertibleHosts(await make()), ['s0/p0', 's1/p0']);
  // true = 모든 종류: 남은 글상자(안의 표째)를 지운다 — 안의 글자 3개는 '개체와 함께 지운 글'로 세고 빠진 글자는 0
  const all = await make();
  const a = objectsToBody(all, { removeRest: true, author: '시험' }).report;
  assert.deepEqual([a.removedRest, a.kept, a.text.removedWithObjects, a.text.lost, a.text.extra], [1, 0, 3, 0, 0]);
  assert.equal(a.text.source, a.text.moved + a.text.dropped + a.text.removedWithObjects);
  assert.equal(all.sections.reduce((n, s) => n + s.bodyParas.reduce((m, p) => m + all.ownObjects(p.ref).filter((o) => o.kind === 'shape').length, 0), 0), 0);
  assert.equal(bodyTexts(all)[0], '제목 줄');   // 비게 된 첫 문단에는 뒤의 글 문단을 끌어올린다
  // 종류 목록: 그 문단이 직접 가진 개체의 종류로 고른다(글상자 = shape — 안에 든 표는 글상자의 것이라 'table' 로는 지워지지 않는다)
  const byKind = await make();
  assert.deepEqual([objectsToBody(byKind, { removeRest: ['table'], author: '시험' }).report.removedRest, byKind.ownObjects('s0/p0').length], [0, 1]);
  // 문단마다: at 은 옮기기 전 주소 — 가리킨 문단에서만 지운다
  const other = await make();
  assert.equal(objectsToBody(other, { removeRest: [{ kinds: ['shape'], at: ['s1/p0'] }], author: '시험' }).report.removedRest, 0);
  const here = await make();
  assert.equal(objectsToBody(here, { removeRest: [{ at: ['s0/p0'] }], author: '시험' }).report.removedRest, 1);
  // 쪽 구성 op 꼴과 결과 줄
  for (const v of [true, ['shape'], [{ kinds: ['shape'], at: ['s0/p0'] }], [{}]]) normalizePageLayoutOps([{ op: 'objects_to_body', remove_rest: v }]);
  for (const v of [[], ['nope'], [{ at: [] }], 'all']) assert.throws(() => normalizePageLayoutOps([{ op: 'objects_to_body', remove_rest: v }]), `remove_rest ${JSON.stringify(v)}`);
  const viaOp = editPageLayout(await make(), normalizePageLayoutOps([{ op: 'objects_to_body', remove_rest: [{ kinds: ['shape'], at: ['s0/p0'] }] }]), { author: '시험' });
  assert.match(viaOp.labels[0], / · 글상자·선 \d+개 지움 · 남은 개체 1개도 지움\(안의 글자 3자 포함\) · /);
  assert.ok(!/남긴 개체/.test(viaOp.labels[0]));
});
