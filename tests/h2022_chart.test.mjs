// node --test tests/h2022_chart.test.mjs — 한/글 2022 차트 디자인(차트 종류 변경·차트 구성 추가·줄/칸 전환), 2026-11-11 차트 영역.
// 기대값은 한/글 2022 COM 실측 저장본(tests/fixtures/h2022_chart/*.xml — chart_hangul.hwpx 를 한/글에서 같은 조작 후 다시 저장)이다.
//  1) 종류 바꾸기: 엔진 setChartFormatByIndex(kind) → exportHwpx 의 Chart/chart1.xml 이 한/글 저장본과 같다(29 종류)
//  2) 구성 요소: 제목·범례·데이터 레이블·축·축 제목·눈금선이 한/글 레이아웃 저장본의 요소 꼴로 실리고, 다시 열면 상태가 그대로다
//  3) 그리기(엔진 계산값 — SVG): 범례 없음/왼쪽/위쪽 자리, 축 제목 글, 꺾은선·영역·원형 데이터 레이블, 영역 채우기, 표식 없는 꺾은선
//  4) 서버: diffDocs 가 차트 구성 변경을 object 덩어리로 내고 copyObjectsFrom 뒤 서버 문서 XML 에 실린다, 손대지 않은 왕복은 덩어리 0
//  5) 줄/칸 전환: 데이터 구조 편집(전치) — 항목·계열 이름이 바뀌고 값이 전치된다
// 엔진: RHWP_PKG(기본 vendor/rhwp/pkg). 브라우저·화면 캡처는 쓰지 않는다(AGENTS.md §2.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { root, fixture } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const ONE = fs.readFileSync(fixture('chart_hangul.hwpx'));
const HDIR = fixture('h2022_chart');
const hangul = (name) => fs.readFileSync(path.join(HDIR, name), 'utf8');
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const exportOf = (d) => Buffer.from(d.exportHwpx());
const fmt = (d, i = 0) => JSON.parse(d.getChartFormatByIndex(i));
const setFmt = (d, ops, i = 0) => JSON.parse(d.setChartFormatByIndex(i, JSON.stringify(ops)));
async function chartXml(bytes) {
  const z = await JSZip.loadAsync(bytes);
  return z.file('Chart/chart1.xml').async('string');
}
async function oleBytes(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const n = Object.keys(z.files).find((f) => /^BinData\/.*\.ole$/i.test(f));
  return n ? Buffer.from(await z.file(n).async('uint8array')) : null;
}
function chartSvg(d) {
  const s = d.renderPageSvg(0);
  const i = s.indexOf('<g class="hwp-ooxml-chart">');
  assert.ok(i >= 0, '차트 그림이 있다');
  return s.slice(i);
}

test('엔진 API 가 있다(빌드 확인)', () => {
  const d = open(ONE);
  assert.equal(typeof d.getChartFormatByIndex, 'function', `${pkgDir} 에 getChartFormatByIndex 가 없다 — RHWP_PKG 를 확인`);
  const s = fmt(d);
  assert.equal(s.ok, true);
  assert.deepEqual([s.group, s.index, s.title, s.legend, s.dataLabels, s.hasAxes], [1, 0, 'none', 'right', false, true]);
  assert.ok(s.kinds.length >= 29);
});

// ───────── 1) 종류 바꾸기 = 한/글 저장본 ─────────

// 비교 바탕: 한/글이 이 표본을 열어 손대지 않고 다시 저장한 Chart XML(hangul_resave.xml) — 한/글의 열기·저장 정규화
// (값 축 눈금선·항목 축 numFmt 를 다시 쓰지 않음, 실측)는 조작과 무관하므로, 같은 바탕에 같은 조작을 한 결과끼리 비교한다.
async function resavedBase() {
  const z = await JSZip.loadAsync(ONE);
  z.file('Chart/chart1.xml', hangul('hangul_resave.xml'));
  return open(await z.generateAsync({ type: 'nodebuffer' }));
}

const KINDS = fs.readdirSync(HDIR).map((f) => /^hangul_kind_g(\d)i(\d\d)\.xml$/.exec(f)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2]), m[0]]);

test(`차트 종류 변경: ${KINDS.length} 종류(막대·꺾은선·영역·원형·도넛·분산형) 모두 한/글 2022 가 같은 조작으로 저장한 Chart XML 과 같다`, async () => {
  assert.equal(KINDS.length, 36); // 1차 29 + 도넛 2 + 분산형 5(2026-11-12)
  const diffs = [];
  for (const [g, i, file] of KINDS) {
    const d = await resavedBase();
    const r = setFmt(d, { kind: { group: g, index: i } });
    assert.equal(r.ok, true, `${file}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.wrote, ['zipPart', 'nestedCopy'], `${file}: ①② 모두 쓴다`);
    const out = exportOf(d);
    const ours = await chartXml(out);
    if (ours !== hangul(file)) diffs.push(file);
    // 다시 열면 같은 종류로 읽는다
    const back = fmt(open(out));
    assert.deepEqual([back.group, back.index], [g, i], `${file}: 다시 열기`);
    // 값 편집이 계속 된다(스캐너가 새 꼴을 읽는다)
    assert.equal(JSON.parse(open(out).getChartDataByIndex(0)).ok, true, `${file}: 값 읽기`);
  }
  assert.deepEqual(diffs, [], '한/글 저장본과 바이트가 다른 종류');
});

test('종류 바꾸기 왕복: 원형 → 세로 막대는 한/글처럼 축을 새로 만든다(항목 축 numFmt 없음, 값 축 눈금선 없음 — 축 번호만 다르다)', async () => {
  const d = await resavedBase();
  setFmt(d, { kind: { group: 3, index: 0 } });
  setFmt(d, { kind: { group: 1, index: 0 } });
  const ours = await chartXml(exportOf(d));
  const want = hangul('hangul_pie_to_col.xml').replace(/381321462/g, '1001').replace(/625779119/g, '1002');
  assert.equal(ours, want);
});

test('받지 않는 종류(주식형·거품형·원통형)는 거부하고 문서를 건드리지 않는다', async () => {
  const d = open(ONE);
  const before = await chartXml(exportOf(d));
  for (const [g, i] of [[5, 0], [4, 5], [1, 7]]) {
    const r = setFmt(d, { kind: { group: g, index: i } });
    assert.equal(r.ok, false);
    assert.equal(r.invalid[0].reason, 'chartFormat');
  }
  assert.equal(await chartXml(exportOf(d)), before);
});

// ───────── 2) 구성 요소 ─────────

test('차트 구성 추가: 제목·범례·데이터 레이블·축·축 제목·눈금선이 한/글 저장 꼴로 실리고 다시 열면 그대로다', async () => {
  const d = open(ONE);
  const r = setFmt(d, {
    title: { mode: 'top', text: '분기별 매출' }, legend: 'top', dataLabels: true,
    horizontalAxis: { title: true, titleText: '분기' }, verticalAxis: { title: true, majorGrid: false },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = exportOf(d);
  const x = await chartXml(out);
  // 한/글 레이아웃 저장본과 같은 꼴
  const L02 = hangul('hangul_layout02_col.xml');
  const dl = /<c:dLbls>.*?<\/c:dLbls>/.exec(L02)[0];
  assert.ok(x.includes(dl), '데이터 레이블 = 한/글 레이아웃 2 의 dLbls');
  assert.match(x, /<\/c:ser><c:dLbls>/, 'plot 단, 계열 뒤');
  assert.match(x, /<c:legend><c:legendPos val="t"\/><c:layout\/><c:overlay val="0"\/><\/c:legend>/);
  assert.match(x, /<c:chart><c:title><c:tx><c:rich>.*<a:t>분기별 매출<\/a:t>.*<\/c:rich><\/c:tx><c:layout\/><c:overlay val="0"\/><\/c:title><c:autoTitleDeleted val="0"\/>/);
  // 축 제목 자리 = 한/글 저장본(c:delete 뒤 numFmt 앞), 글 없는 축 제목 = 한/글이 넣는 txPr 꼴
  const axT = /<c:delete val="0"\/>(<c:title><c:layout\/><c:overlay val="0"\/><c:txPr>.*?<\/c:txPr><\/c:title>)<c:numFmt/.exec(hangul('hangul_axis_title_h.xml'))[1];
  assert.match(x, /<c:catAx>.*<c:delete val="0"\/><c:title><c:tx><c:rich>.*<a:t>분기<\/a:t>.*<\/c:title><c:numFmt/);
  assert.ok(x.includes(axT.replace('rot="0"', 'rot="-5400000"')), '세로 축 제목(글 없음) = 한/글 꼴 + 세로 회전');
  assert.doesNotMatch(/<c:valAx>.*<\/c:valAx>/.exec(x)[0], /majorGridlines/);
  const s = fmt(open(out));
  assert.deepEqual(
    [s.title, s.titleText, s.legend, s.dataLabels, s.horizontalAxis.title, s.horizontalAxis.titleText, s.verticalAxis.title, s.verticalAxis.majorGrid],
    ['top', '분기별 매출', 'top', true, true, '분기', true, false],
  );
  // 없음으로 되돌리기 — 한/글: 제목 요소 지우고 autoTitleDeleted 1, 범례 요소 지움
  const e = open(out);
  setFmt(e, { title: { mode: 'none' }, legend: 'none', dataLabels: false, verticalAxis: { title: false, majorGrid: true }, horizontalAxis: { visible: false } });
  const y = await chartXml(exportOf(e));
  assert.match(y, /<c:chart><c:autoTitleDeleted val="1"\/>/);
  assert.doesNotMatch(y, /<c:legend>|dLbls/);
  assert.match(y, /<c:catAx><c:axId val="1001"\/><c:scaling><c:orientation val="minMax"\/><\/c:scaling><c:axPos val="b"\/><c:crossAx val="1002"\/><c:delete val="1"\/>/);
  assert.match(/<c:valAx>.*<\/c:valAx>/.exec(y)[0], /<c:delete val="0"\/><c:majorGridlines\/><c:numFmt/);
});

test('구성 편집은 ①(Chart/chart1.xml)과 ②(대체 OLE 의 OOXMLChartContents)에 함께 쓴다', async () => {
  const d = open(ONE);
  const ole0 = await oleBytes(exportOf(d));
  setFmt(d, { legend: 'bottom' });
  const out = exportOf(d);
  const ole1 = await oleBytes(out);
  assert.ok(ole0 && ole1 && !ole0.equals(ole1), '대체 OLE 도 바뀐다');
  assert.ok(ole1.includes(Buffer.from('<c:legendPos val="b"/>')), '② 에도 같은 범례 위치');
});

test('바뀐 것이 없으면 아무것도 쓰지 않는다', () => {
  const d = open(ONE);
  const r = setFmt(d, { legend: 'right' });
  assert.deepEqual([r.ok, r.changed, r.wrote], [true, false, []]);
});

test('차트 넣기에서 종류 고르기(한/글 갤러리 좌표): 넣은 차트가 그 종류로 저장된다', async () => {
  const d = open(ONE);
  const c = JSON.parse(d.listCharts())[0];
  d.deleteShapeControl(c.section, c.paragraph, c.control);
  const r = JSON.parse(d.insertChart(0, 1, 0, JSON.stringify({ chartGroup: 2, chartIndex: 7 })));
  assert.equal(r.ok, true);
  const x = await chartXml(exportOf(d));
  assert.match(x, /<c:areaChart><c:grouping val="standard"\/>/);
  assert.match(x, /<c:crossBetween val="midCat"\/>/);
});

// ───────── 3) 그리기(엔진 계산값) ─────────

test('그리기: 범례 없음·왼쪽·위쪽 자리, 축 제목, 데이터 레이블(꺾은선·원형), 영역 채우기, 표식 없는 꺾은선', () => {
  const legendX = (svg) => Number(/<g class="hwp-chart-legend"><g[^>]*>\s*(?:<[^>]*>\s*)*?<text x="([\d.]+)"/.exec(svg)?.[1]);
  const frame = (svg) => /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg).slice(1).map(Number);
  const axisLine = (svg) => /class="hwp-chart-axis" x1="([\d.]+)" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)"/.exec(svg).slice(1).map(Number);
  const base = open(ONE);
  const s0 = chartSvg(base);
  assert.match(s0, /hwp-chart-legend/);
  // 없음
  let d = open(ONE); setFmt(d, { legend: 'none' });
  assert.doesNotMatch(chartSvg(d), /hwp-chart-legend/, '범례 없음 = 그리지 않는다');
  const [fx, , fw] = frame(chartSvg(d));
  // 왼쪽: 범례 글이 그림 영역(값 축선) 왼쪽에
  d = open(ONE); setFmt(d, { legend: 'left' });
  let s = chartSvg(d);
  const [ax] = axisLine(s);
  assert.ok(legendX(s) < ax, `왼쪽 범례(${legendX(s)}) < 값 축(${ax})`);
  assert.ok(legendX(s) < fx + fw / 2);
  // 위쪽: 범례 글이 그림 영역 위
  d = open(ONE); setFmt(d, { legend: 'top' });
  s = chartSvg(d);
  const [, top] = axisLine(s);
  const ly = Number(/<g class="hwp-chart-legend">[\s\S]*?<text x="[\d.]+" y="([\d.]+)"/.exec(s)[1]);
  assert.ok(ly < top, `위쪽 범례 글(${ly}) < 그림 영역 위(${top})`);
  // 축 제목·제목 겹치기
  d = open(ONE); setFmt(d, { title: { mode: 'overlay', text: '겹친 제목' }, horizontalAxis: { title: true, titleText: '항목' }, verticalAxis: { title: true } });
  s = chartSvg(d);
  assert.match(s, /class="hwp-chart-axis-title"[^>]*>항목</);
  assert.match(s, /class="hwp-chart-axis-title"[^>]*rotate\(-90[^>]*>축 제목</);
  assert.match(s, /class="hwp-chart-title"[^>]*>겹친 제목</);
  const [, topOverlay] = axisLine(s);
  const d2 = open(ONE); setFmt(d2, { title: { mode: 'top', text: '겹친 제목' } });
  const [, topTitle] = axisLine(chartSvg(d2));
  assert.ok(topOverlay < topTitle, `겹치기는 그림 영역을 줄이지 않는다(${topOverlay} < ${topTitle})`);
  // 꺾은선 데이터 레이블 + 표식 없는 꺾은선형(한/글 2,0)
  d = open(ONE); setFmt(d, { kind: { group: 2, index: 0 }, dataLabels: true });
  s = chartSvg(d);
  assert.equal((s.match(/class="hwp-chart-data-label"/g) || []).length, 6, '꺾은선 레이블 = 점 6개');
  assert.doesNotMatch(s, /hwp-chart-marker/, '표식 없는 꺾은선형');
  d = open(ONE); setFmt(d, { kind: { group: 2, index: 3 } });
  assert.match(chartSvg(d), /hwp-chart-marker/, '표식이 있는 꺾은선형');
  // 영역
  d = open(ONE); setFmt(d, { kind: { group: 2, index: 8 } });
  assert.equal((chartSvg(d).match(/class="hwp-chart-area"/g) || []).length, 2, '누적 영역 = 계열 2개 면');
  // 원형 레이블·조각 색(점 색 accentN 이 계열 색으로 새지 않는다)
  d = open(ONE); setFmt(d, { kind: { group: 3, index: 0 }, dataLabels: true });
  s = chartSvg(d);
  assert.equal((s.match(/class="hwp-chart-data-label"/g) || []).length, 3, '원형 레이블 = 조각 3개');
  const fills = [...s.matchAll(/<path d="M[^"]+ A[^"]+" fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  assert.equal(new Set(fills).size, 3, `조각 색이 서로 다르다: ${fills}`);
});

test('그리기: 한/글 가로 막대(항목 축 axPos=b 그대로)도 값 눈금선을 값 축에서 읽는다', () => {
  const d = open(ONE);
  setFmt(d, { kind: { group: 0, index: 0 } });
  const s = chartSvg(d);
  // 값 축(가로) 눈금선 = 세로로 선 회색 선들
  const vlines = [...s.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#8c8c8c"/g)].filter((m) => m[1] === m[3] && m[2] !== m[4]);
  assert.ok(vlines.length >= 3, `세로 눈금선 ${vlines.length}개`);
  setFmt(d, { horizontalAxis: { majorGrid: true }, verticalAxis: { majorGrid: false } });
  const x = fmt(d);
  assert.deepEqual([x.horizontalAxis.kind, x.horizontalAxis.majorGrid, x.verticalAxis.kind, x.verticalAxis.majorGrid], ['valAx', true, 'catAx', false]);
});

// ───────── 4) 서버 ─────────

const brief = (r) => r.hunks.map((h) => [h.type, h.ref, h.objectSummary ?? '']);

test('서버: 구성 변경은 object 덩어리 → copyObjectsFrom 뒤 서버 문서에 실린다, 손대지 않은 왕복은 덩어리 0', async () => {
  assert.deepEqual(brief(await diffDocs(ONE, exportOf(open(ONE)))), []);
  const d = open(ONE);
  setFmt(d, { kind: { group: 2, index: 3 }, title: { mode: 'top', text: '서버 제목' }, legend: 'bottom' });
  const head = exportOf(d);
  const base = await HwpxDoc.load(ONE); const h = await HwpxDoc.load(head);
  const r = await diffDocs(base, h);
  assert.deepEqual(brief(r).map((x) => x[0]), ['object']);
  for (const k of r.hunks) if (k.type === 'object') base.copyObjectsFrom(h, k.headRef, k.ref);
  const saved = await base.save();
  const x = await chartXml(saved);
  assert.match(x, /<c:lineChart>/);
  assert.match(x, /<a:t>서버 제목<\/a:t>/);
  assert.match(x, /<c:legendPos val="b"\/>/);
  // 서버 문서를 편집기로 다시 열어도 같은 구성
  const s = fmt(open(saved));
  assert.deepEqual([s.group, s.index, s.titleText, s.legend], [2, 3, '서버 제목', 'bottom']);
  // 서버 문서 → 편집기 왕복은 덩어리 0
  assert.deepEqual(brief(await diffDocs(saved, exportOf(open(saved)))), []);
});

// ───────── 5) 줄/칸 전환 ─────────

test('줄/칸 전환: 항목 이름 ↔ 계열 이름, 값 전치(데이터 구조 편집)', async () => {
  const { transposeEdits } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/core/h2022-chart-format.ts')).href).catch(() => ({}));
  const d = open(ONE);
  const data = JSON.parse(d.getChartDataByIndex(0));
  // 순수 함수(TS)를 Node 가 못 읽으면 같은 규칙을 여기서 만든다
  const edits = transposeEdits ? transposeEdits(data).edits : {
    structure: true, labels: data.series.map((s) => s.name),
    series: data.labels.map((label, r) => ({ name: label, values: data.series.map((s) => s.values[r]) })),
  };
  const r = JSON.parse(d.setChartDataByIndex(0, JSON.stringify(edits)));
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = JSON.parse(open(exportOf(d)).getChartDataByIndex(0));
  assert.deepEqual(after.labels, data.series.map((s) => s.name));
  assert.deepEqual(after.series.map((s) => s.name), data.labels);
  assert.deepEqual(after.series.map((s) => s.values), data.labels.map((_, r) => data.series.map((s) => s.values[r])));
});

// ───────── 6) 대화상자 값 ↔ 엔진 JSON(순수 함수, 편집기 core/h2022-chart-format.ts) ─────────

test('대화상자: 바뀐 칸만 싣고, 원형으로 바꾸면 축 편집은 빼며, 원형에서 막대로 바꾸면 축 값을 모두 싣는다', async () => {
  const m = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/core/h2022-chart-format.ts')).href);
  const d = open(ONE);
  const st = fmt(d);
  const f = m.formFromState(st);
  assert.deepEqual(m.buildFormatOps(st, f), {});
  f.legend = 'left'; f.title = 'top'; f.titleText = '제목'; f.verticalAxis.majorGrid = false;
  assert.deepEqual(m.buildFormatOps(st, f), { title: { mode: 'top', text: '제목' }, legend: 'left', verticalAxis: { majorGrid: false } });
  f.group = 3; f.index = 0;
  assert.deepEqual(m.buildFormatOps(st, f), { kind: { group: 3, index: 0 }, title: { mode: 'top', text: '제목' }, legend: 'left' });
  // 원형 상태에서 막대로
  setFmt(d, { kind: { group: 3, index: 0 } });
  const pie = fmt(d);
  const g = m.formFromState(pie);
  assert.equal(g.horizontalAxis, null);
  g.group = 1; g.index = 0;
  g.horizontalAxis = { visible: true, majorGrid: false, title: false, titleText: '' };
  g.verticalAxis = { visible: true, majorGrid: true, title: false, titleText: '' };
  const ops = m.buildFormatOps(pie, g);
  assert.deepEqual(ops.verticalAxis, { visible: true, majorGrid: true, title: false });
  assert.equal(setFmt(d, ops).ok, true);
  assert.equal(fmt(d).verticalAxis.majorGrid, true);
  // 줄/칸 전환: 빈 값은 거부
  assert.ok('error' in m.transposeEdits({ ok: true, labels: ['a', 'b'], series: [{ name: 'x', values: ['1', ''] }] }));
});

// ───────── 7) 2차(2026-11-12): 레이아웃 77·차트 색·도넛·분산형 그리기·자동 눈금 ─────────

/** 대체 OLE 없는 차트(편집기에서 넣은 꼴)에 Chart/chart1.xml 을 갈아 끼운 문서 — 한/글 실측 바탕 XML 을 그대로 쓰기 위해 */
async function zipOnlyDoc(xml, opts = {}) {
  const d = open(ONE);
  const c = JSON.parse(d.listCharts())[0];
  d.deleteShapeControl(c.section, c.paragraph, c.control);
  d.insertChart(0, 1, 0, JSON.stringify(opts));
  const z = await JSZip.loadAsync(exportOf(d));
  if (xml != null) z.file('Chart/chart1.xml', xml);
  return open(await z.generateAsync({ type: 'nodebuffer' }));
}
const LDIR = path.join(HDIR, 'layouts');
const CDIR = path.join(HDIR, 'colors');

test('차트 레이아웃 11종 × 7 종류(세로/가로 막대·꺾은선·3차원 꺾은선·영역·원형·3차원 원형) = 한/글 저장본과 바이트가 같다', async () => {
  const bad = [];
  for (const fam of ['col', 'barh', 'line', 'line3d', 'area', 'pie', 'pie3d']) {
    const base = fs.readFileSync(path.join(LDIR, `${fam}_base.xml`), 'utf8');
    for (let n = 0; n <= 10; n++) {
      const d = await zipOnlyDoc(base);
      const r = setFmt(d, { layout: n });
      assert.equal(r.ok, true, `${fam} L${n}: ${JSON.stringify(r)}`);
      const want = fs.readFileSync(path.join(LDIR, `${fam}_L${String(n).padStart(2, '0')}.xml`), 'utf8');
      if ((await chartXml(exportOf(d))) !== want) bad.push(`${fam} L${n}`);
    }
  }
  assert.deepEqual(bad, []);
});

const serSpPr = (xml) => [...xml.matchAll(/<c:ser>.*?<\/c:ser>/g)].map((m) => {
  const x = m[0];
  const sp = /<\/c:tx>(<c:spPr>.*?<\/c:spPr>|<c:spPr\/>)/.exec(x)?.[1] ?? null;
  const mk = /<c:marker>.*?(<c:spPr>.*?<\/c:spPr>)<\/c:marker>/.exec(x)?.[1] ?? null;
  const dpt = [...x.matchAll(/<c:dPt>.*?<\/c:dPt>/g)].map((d) => /<c:spPr>.*?<\/c:spPr>/.exec(d[0])?.[0] ?? null);
  return { sp, mk, dpt };
});

test('차트 색: 계열 6 개 막대 — 색상형 0~3·단색형 10~22 를 한/글 저장본과 바이트까지 같게 쓴다', async () => {
  const base = fs.readFileSync(path.join(CDIR, 'n6_base.xml'), 'utf8');
  const bad = [];
  for (const c of [0, 1, 2, 3, ...Array.from({ length: 13 }, (_, i) => 10 + i)]) {
    const d = await zipOnlyDoc(base);
    const r = setFmt(d, { colors: c });
    assert.equal(r.ok, true, `${c}: ${JSON.stringify(r)}`);
    if ((await chartXml(exportOf(d))) !== fs.readFileSync(path.join(CDIR, `n6_c${c}.xml`), 'utf8')) bad.push(c);
  }
  assert.deepEqual(bad, []);
});

test('차트 색: 계열 수(1~16)에 따른 명암·색상형 묶음·회색 = 한/글 저장본의 계열 spPr', async () => {
  const bad = [];
  for (const f of fs.readdirSync(CDIR).filter((f) => f.startsWith('spread_'))) {
    const [, n, g, i] = /spread_n(\d+)_g(\d)i(\d+)\.xml/.exec(f).map(Number);
    const c = g === 0 ? i : 10 + i;
    const d = await zipOnlyDoc(null, { categories: ['가', '나'], series: Array.from({ length: n }, (_, k) => ({ name: `계열 ${k + 1}`, values: [String(k + 1), String(k + 1)] })) });
    const r = setFmt(d, { colors: c });
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r)}`);
    const ours = serSpPr(await chartXml(exportOf(d))).map((x) => x.sp);
    const want = serSpPr(fs.readFileSync(path.join(CDIR, f), 'utf8')).map((x) => x.sp);
    if (JSON.stringify(ours) !== JSON.stringify(want)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test('차트 색: 꺾은선(계열 선+표식)·원형(점마다)·영역 = 한/글 저장본의 spPr', async () => {
  const bad = [];
  const kinds = { line: [2, 3], pie: [3, 0], area: [2, 7] };
  for (const f of fs.readdirSync(CDIR).filter((f) => f.startsWith('color_'))) {
    const [, fam, g, i] = /color_(\w+?)_g(\d)i(\d)\.xml/.exec(f);
    const c = Number(g) === 0 ? Number(i) : 10 + Number(i);
    const d = await zipOnlyDoc(null, { categories: ['가', '나'], series: [1, 2, 3, 4, 5, 6].map((k) => ({ name: `계열 ${k}`, values: [String(k), String(k)] })) });
    const [kg, ki] = kinds[fam];
    assert.equal(setFmt(d, { kind: { group: kg, index: ki } }).ok, true);
    const r = setFmt(d, { colors: c });
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r)}`);
    const ours = JSON.stringify(serSpPr(await chartXml(exportOf(d))));
    const want = JSON.stringify(serSpPr(fs.readFileSync(path.join(CDIR, f), 'utf8')));
    if (ours !== want) bad.push(`${f}: ${ours.slice(0, 300)} ≠ ${want.slice(0, 300)}`);
  }
  assert.deepEqual(bad, []);
});

test('그리기(2차): 테마 강조색 = 한/글 색상표, 단색 명암(shade/tint), 원형 점 색, 도넛 고리, 로그 X 분산형, 자동 눈금 7칸', async () => {
  // 모든 계열 accent1 → 모두 #6183d7(한/글 PDF 실측 파랑)
  let d = await zipOnlyDoc(fs.readFileSync(path.join(CDIR, 'n6_c10.xml'), 'utf8'));
  let s = chartSvg(d);
  const fills = [...s.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]).filter((c) => c !== '#ffffff');
  // 한/글 PDF 실측(래스터 +1 치우침 빼고): 첫 계열 shade 51970 → #4760A0 근처, 마지막 tint 52970 → #C3C9EB 근처
  const near = (a, b) => [1, 3, 5].every((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) <= 4);
  assert.ok(near(fills[0], '#4760a0'), `첫 계열 ${fills[0]}`);
  assert.ok(fills.some((f) => near(f, '#c3c9eb')), `밝은 계열 ${fills}`);
  // 원형 + 단색형: 조각 색이 서로 다르다(점 색)
  d = await zipOnlyDoc(fs.readFileSync(path.join(CDIR, 'color_pie_g1i0.xml'), 'utf8'));
  s = chartSvg(d);
  const pie = [...s.matchAll(/<path d="M[^"]+ A[^"]+" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.equal(new Set(pie).size, 2, `원형 조각 ${pie}`);
  // 도넛: 계열 2 → 고리 2 × 조각 3
  d = await zipOnlyDoc(hangul('hangul_kind_g3i06.xml'));
  assert.equal((chartSvg(d).match(/class="hwp-chart-doughnut"/g) || []).length, 6);
  // 분산형(한/글 꼴 — 항목 글 X, logBase 2): X 눈금 1·2·4, 값 축은 X=2 에서
  d = await zipOnlyDoc(hangul('hangul_kind_g4i00.xml'));
  s = chartSvg(d);
  const xl = [...s.matchAll(/text-anchor="middle" dominant-baseline="text-after-edge">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(xl, ['1', '2', '4']);
  assert.equal((s.match(/class="hwp-chart-marker"/g) || []).length, 6);
  // 자동 눈금: 최댓값 6 → 0~7 간격 1(한/글 PDF 실측 — 종전 0~8 간격 2)
  d = await zipOnlyDoc(null, { categories: ['가', '나', '다'], series: [{ name: 'A', values: ['3', '6', '4.8'] }] });
  const yl = [...chartSvg(d).matchAll(/text-anchor="end">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(yl, ['0', '1', '2', '3', '4', '5', '6', '7']);
});
