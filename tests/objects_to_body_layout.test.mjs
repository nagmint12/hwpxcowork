// 개체 → 본문의 배치 읽기 품질(engine/layout.js — 2026-11-17 실제 PDF 변환 문서에서 나온 결함 다섯 가지).
// 문서는 tests/helpers/floating-doc.mjs 가 만든다(실제 사용자 문서·숫자·글을 쓰지 않는다 — 글·값은 모두 지어낸 것).
//   1) 바깥 세로선 없는 표  2) 행 사이 가로선 없는 표·한 열을 쌓은 글상자  3) 숫자 값이 붙지 않음  4) 줄바꿈된 문단·한 글상자 안 제목과 절 제목
//   5) 쪽을 넘는 표를 이을 때 되풀이된 머리행 = 버린 글(빠진 글 아님)
//   node --test tests/objects_to_body_layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLayout, analyzeHost, hostItems, layoutHosts } from '../engine/layout.js';
import { objectsToBody } from '../engine/flow.js';
import { floatingDoc, box } from './helpers/floating-doc.mjs';

const grids = (h) => h.blocks.filter((b) => b.type === 'grid');
const gridRows = (b) => { const g = Array.from({ length: b.rows }, () => Array(b.cols).fill(null)); for (const c of b.cells) g[c.r][c.c] = c.text; return g; };
const paras = (plan) => plan.flow.flatMap((f) => f.items.filter((i) => i.type === 'para').map((i) => i.text));
const freeLines = (h) => h.blocks.filter((b) => b.type === 'lines').flatMap((b) => b.lines.map((l) => l.text));

/** 배치 읽기의 글자 보존: 옮길 글상자 글(빈칸 뺀 글자) = 문단 + 표 칸 + 버린 글 */
function assertConserved(doc, opts = {}) {
  const plan = analyzeLayout(doc, opts);
  const bag = new Map(); const add = (s, k) => { for (const c of String(s)) if (!/\s/.test(c)) bag.set(c, (bag.get(c) || 0) + k); };
  for (const ref of layoutHosts(doc)) for (const i of hostItems(doc, ref).items) if (i.kind === 'text') add(i.text, 1);
  for (const t of paras(plan)) add(t, -1);
  for (const t of plan.tables) for (const r of t.grid) for (const c of r) add(c, -1);
  for (const d of plan.dropped) add(d.text, -1);
  assert.deepEqual([...bag].filter(([, v]) => v), [], '옮긴 글 + 버린 글이 원래 글과 같아야 한다');
  return plan;
}

const HEAD = ['구분', '첫째 해', '둘째 해', '셋째 해'];
const BODY = [['가 모둠', '1.25', '2.50', '3.75'], ['나 모둠', '4.10', '5.20', '6.30'], ['다 모둠', '7.40', '-', '9.60'], ['라 모둠', '0.15', '0.25', '0.35']];

test('바깥 세로선 없는 표: 가로선이 덮는 폭까지 표로 보고 첫 열·끝 열을 표 안에 넣는다', async () => {
  const doc = await floatingDoc({ pages: [{ title: '가상 통계 표', table: { cols: [9000, 6000, 6000, 6000], header: true, outer: false, rows: [HEAD, ...BODY] } }] });
  const h = analyzeHost(doc, 's0/p0');
  assert.deepEqual(h.blocks.map((b) => b.type), ['lines', 'grid']);
  const [g] = grids(h);
  assert.deepEqual([g.rows, g.cols, g.headerRows], [5, 4, 1]);
  assert.deepEqual(gridRows(g), [HEAD, ...BODY]);
  assert.deepEqual(freeLines(h), ['가상 통계 표']);
  assertConserved(doc);
  // 대조: 세로선이 하나도 없는 가로선 두 줄(제목 위아래 꾸밈선)은 표가 아니다
  const deco = await floatingDoc({ pages: [{ lines: [{ x: 8000, y: 20000, text: '꾸밈선 사이 제목' }], extra: box(900, 7000, 19500, 30000, 36) + box(901, 7000, 21600, 30000, 36) }] });
  assert.deepEqual(analyzeHost(deco, 's0/p0').blocks.map((b) => b.type), ['lines']);
});

test('행 사이 가로선 없는 표: 기준선마다 여러 열에 걸친 줄을 행으로 나누고, 한 칸만 줄바꿈된 줄은 그 행에 붙인다', async () => {
  // 머리행 칸이 거의 다 두 줄이어도(머리 아래 괘선은 있음) 머리행은 한 행
  const rows = [['구분', '첫째 \n해', '둘째 \n해', '셋째 \n해'], ...BODY.slice(0, 3), ['라 모둠 \n긴 이름', '0.15', '0.25', '0.35']];
  const doc = await floatingDoc({ pages: [{ title: '가상 통계 표', table: { cols: [9000, 6000, 6000, 6000], header: true, rowRules: false, rows } }] });
  const [g] = grids(analyzeHost(doc, 's0/p0'));
  assert.deepEqual([g.rows, g.cols, g.headerRows], [5, 4, 1]);
  assert.deepEqual(gridRows(g), [HEAD, ...BODY.slice(0, 3), ['라 모둠 긴 이름', '0.15', '0.25', '0.35']]);
  assertConserved(doc);
  // 대조: 행마다 가로선이 있는 표는 괘선이 곧 행이다 — 한 칸만 두 줄이든 여러 칸이 함께 두 줄이든 더 나누지 않는다
  const ruled = await floatingDoc({ pages: [{ title: '가상 통계 표', table: { cols: [9000, 6000, 6000, 6000], header: true,
    rows: [['구분', '첫째 \n해', '둘째 해', '셋째 해'], ...BODY.slice(0, 2), ['다 모둠 \n긴 이름', '7.40', '-', '9.60'], ['마 모둠 \n둘째 줄', '설명 \n이어짐', '설명 \n이어짐', '설명 \n이어짐']] } }] });
  const [r] = grids(analyzeHost(ruled, 's0/p0'));
  assert.deepEqual([r.rows, r.cols], [5, 4]);
  assert.deepEqual(gridRows(r)[0], HEAD);
  assert.deepEqual(gridRows(r)[3], ['다 모둠 긴 이름', '7.40', '-', '9.60']);
  assert.deepEqual(gridRows(r)[4], ['마 모둠 둘째 줄', '설명 이어짐', '설명 이어짐', '설명 이어짐']);
});

test('한 열을 쌓은 글상자(변환기 꼴): 저장된 줄 배치로 줄마다 제 행·열에 넣는다 — 한 문단에 여러 행의 값이 있어도', async () => {
  const rows = [['구분', '첫째', '둘째', '넷째 열'], ['가', '1.10', '1.20', '1.30'], ['나', '2.10', '2.20', '2.30'], ['다', '3.10', '3.20', '3.30'], ['라', '4.10', '4.20', '4.30'], ['마', '5.10', '5.20', '5.30']];
  const doc = await floatingDoc({ pages: [{ title: '가상 문항 표', table: { cols: [9000, 6000, 6000, 6000], header: true, rows, columnBox: { col: 3, groups: [[0, 1], [3, 4, 5]] } } }] });
  const items = hostItems(doc, 's0/p0').items.filter((i) => i.parts);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '넷째 열1.30\n2.30\n3.304.305.30');   // 문단 글 그대로(행 사이 빈칸 없음)
  const [g] = grids(analyzeHost(doc, 's0/p0'));
  assert.deepEqual([g.rows, g.cols], [6, 4]);
  assert.deepEqual(gridRows(g), rows);
  assertConserved(doc);
  // 저장된 줄 배치가 없으면 나누지 못한다(문단이 셋이면 높이를 셋으로 나눈 어림) — 글은 잃지 않는다
  const noSegs = await floatingDoc({ pages: [{ title: '가상 문항 표', table: { cols: [9000, 6000, 6000, 6000], header: true, rows, columnBox: { col: 3, groups: [[0, 1], [3, 4, 5]] } } }] });
  for (const sec of noSegs.sections) sec.load(sec.xml.replace(/<hp:linesegarray>.*?<\/hp:linesegarray>/g, ''));
  assertConserved(noSegs);
});

test('숫자 값은 붙이지 않는다: 한 칸에 숫자 줄이 둘이면 빈칸으로 띄우고, 낱말 가운데 줄바꿈은 그대로 붙인다', async () => {
  const rows = [['구분', '설명 칸', '값'], ['가 모둠', '줄이 바뀌는 낱말 서브 리\n스트 끝', '2.59\n2.75'], ['나 모둠', '보통 칸', '3.44\n-']];
  const doc = await floatingDoc({ pages: [{ title: '가상 숫자 표 제목', table: { cols: [9000, 16000, 7000], header: true, rows } }] });
  const h = analyzeHost(doc, 's0/p0');
  assert.equal(h.spaced, true);
  const g = gridRows(grids(h)[0]);
  assert.deepEqual(g[1], ['가 모둠', '줄이 바뀌는 낱말 서브 리스트 끝', '2.59 2.75']);
  assert.deepEqual(g[2], ['나 모둠', '보통 칸', '3.44 -']);
});

test('줄바꿈된 본문: 내어쓰기(글머리 뒤)·첫 줄 들여쓰기 문단은 한 문단으로 잇고, 문장 끝·글머리·넓은 줄 사이는 나눈다', async () => {
  const doc = await floatingDoc({ pages: [{
    paras: [
      { x: 8500, next: 10200, bullet: '➢', y: 16000, width: 42000, lines: ['(범위) 지어낸 자료에서 모둠마다 평균을 구하였고 ', '줄이 바뀌어도 앞 줄과 같은 문단으로 이어 ', '써야 한다.'] },
      { x: 8500, next: 10200, bullet: '➢', y: 22000, width: 42000, lines: ['(기준) 둘째 문단은 따로 시작하고 여기서 줄이 ', '끝난다.'] },
      { x: 9500, next: 8500, y: 27000, width: 41000, lines: ['첫 줄만 들여 쓴 문단도 다음 줄이 왼쪽에서 이어지면 ', '한 문단이다.'] },
    ],
    // 오른쪽 끝까지 차지 않은 짧은 줄은 잇지 않는다
    lines: [{ x: 8500, y: 31000, text: '짧은 줄' }, { x: 8500, y: 32700, text: '다음 짧은 줄' }] }] });
  const plan = assertConserved(doc);
  assert.deepEqual(paras(plan), [
    '➢ (범위) 지어낸 자료에서 모둠마다 평균을 구하였고 줄이 바뀌어도 앞 줄과 같은 문단으로 이어 써야 한다.',
    '➢ (기준) 둘째 문단은 따로 시작하고 여기서 줄이 끝난다.',
    '첫 줄만 들여 쓴 문단도 다음 줄이 왼쪽에서 이어지면 한 문단이다.',
    '짧은 줄', '다음 짧은 줄',
  ]);
  // 'keep' 이면 줄마다
  assert.equal(paras(analyzeLayout(doc, { wrap: 'keep' })).length, 9);
});

test('한 글상자 안 여러 문단: 큰 제목과 절 제목은 따로, 한 문단의 줄바꿈은 원문대로 잇는다(저장된 줄 배치가 없어도 문단은 나눈다)', async () => {
  const page = { boxes: [
    { x: 0, y: 9000, w: 59500, hp: 8500, paras: [['지어낸 보고서 큰 제목'], ['가. 첫째 절']] },
    { x: 0, y: 14000, w: 59500, hp: 8500, paras: [['한 문단의 첫 줄은 낱말 가운데서 줄이 바', '뀌어도 원문대로 이어진다.'], ['주1: 따로 선 둘째 문단']] },
  ] };
  const doc = await floatingDoc({ pages: [page] });
  const plan = assertConserved(doc);
  assert.deepEqual(paras(plan), ['지어낸 보고서 큰 제목', '가. 첫째 절', '한 문단의 첫 줄은 낱말 가운데서 줄이 바뀌어도 원문대로 이어진다.', '주1: 따로 선 둘째 문단']);
  // 쪽 폭 글상자에 놓인 글은 저장된 줄 시작(horzpos)에서 시작하는 것으로 읽는다
  assert.equal(freeLines(analyzeHost(doc, 's0/p0'))[0], '지어낸 보고서 큰 제목');
  assert.equal(analyzeHost(doc, 's0/p0').blocks[0].lines[0].x, 8500);
  const noSegs = await floatingDoc({ pages: [{ boxes: page.boxes.map((b) => ({ ...b, segs: false })) }] });
  assert.deepEqual(paras(assertConserved(noSegs)).slice(0, 2), ['지어낸 보고서 큰 제목', '가. 첫째 절']);
});

test('쪽을 넘는 표 잇기: 되풀이된 머리행은 버린 글로 알리고 글 보존 검사를 통과한다(빠진 글자 0)', async () => {
  const t = (rows) => ({ cols: [9000, 6000, 6000, 6000], header: true, rows: [HEAD, ...rows] });
  const doc = await floatingDoc({ pages: [{ title: '이어지는 가상 표', table: t(BODY.slice(0, 2)), pageNumber: '1' }, { table: t(BODY.slice(2)), pageNumber: '2' }] });
  const plan = assertConserved(doc);
  assert.equal(plan.tables.length, 1);
  assert.deepEqual([plan.tables[0].rows, plan.tables[0].cols, plan.tables[0].headerRows], [5, 4, 1]);
  assert.deepEqual(plan.tables[0].grid, [HEAD, ...BODY]);
  assert.deepEqual(plan.dropped.map((d) => `${d.why}:${d.text}`), ['쪽 번호:1', '되풀이 머리행:구분 첫째 해 둘째 해 셋째 해', '쪽 번호:2']);
  assertConserved(doc, { keepPageNumbers: true });
  const { report } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual([report.text.lost, report.text.extra], [0, 0]);
  assert.equal(report.text.moved + report.text.dropped, report.text.source);
  assert.ok(report.dropped.some((d) => d.why === '되풀이 머리행'));
  // 잇지 않으면 머리행을 버리지 않는다
  assert.deepEqual(analyzeLayout(await floatingDoc({ pages: [{ table: t(BODY.slice(0, 2)) }, { table: t(BODY.slice(2)) }] }), { joinPages: false }).dropped, []);
});
