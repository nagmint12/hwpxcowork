// node --test tests/chart_fidelity.test.mjs — 차트(hp:chart + Chart/chartN.xml)를 넣고·고치고·지우고·옮겨도 한/글과 같은 꼴로 저장되는가(2026-10-30).
//  1) 꾸러미: 지운 차트의 Chart/chartN.xml·대체 OLE(BinData/oleN.ole)·매니페스트 항목이 남지 않는다. 남은 차트는 한/글처럼 문서 차례로
//     chart1·chart2… 로 다시 매긴다. 되돌리기(스냅숏)는 지운 차트와 부분을 되살린다. 표 셀 안 차트도 지운다(deleteCellShapeControlByPath)
//  2) 차트 넣기(insertChart): 맨 hp:chart + 한/글이 다시 저장하는 것과 같은 Chart/chart1.xml(한글 COM 실측: 다시 저장본과 바이트 같음).
//     값 고치기는 대체 OLE 가 없으면 ①만 쓴다. 수가 아닌 값·빈 값은 거부한다
//  3) 그리기(한/글 PDF 실측 — 32250×18750 묶은 막대): 고정 최대 5 에 값 15 는 그림 영역 위 끝에서 잘린다(값은 15 그대로), 고정 범위 눈금,
//     자동 범위 눈금(크기에 따라 3~10칸), 음수는 0 에서, 빈 칸(점 생략)은 제자리, 큰 수 지수 표기
//  4) 서버(실시간 밀어 넣기): 한/글 차트(<hp:switch> 안 hp:chart + 대체 OLE) 값 고치기·크기·지우기·넣기 → 한글로 저장(kind=export)의
//     꾸러미가 맞다(남는 부분·없는 부분 0)
// 고정(fixture)은 한/글이 저장한 파일이다: chart_hangul(차트 하나), chart_hangul_two(차트 둘), chart_hangul_cell(표 셀 안 차트).
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { chartPartReport } from '../engine/chart-parts.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const ONE = fs.readFileSync(fixture('chart_hangul.hwpx'));
const TWO = fs.readFileSync(fixture('chart_hangul_two.hwpx'));
const CELL = fs.readFileSync(fixture('chart_hangul_cell.hwpx'));
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const exportOf = (d) => Buffer.from(d.exportHwpx());
const charts = (d) => JSON.parse(d.listCharts());

/** 꾸러미 점검 → { charts(Chart/ 부분), bins(BinData/), items(매니페스트 BinData 항목), refs(chartIDRef), problems } */
async function pkg(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
  const hpf = await z.file('Contents/content.hpf').async('string');
  const secs = await Promise.all(names.filter((n) => /^Contents\/section\d+\.xml$/.test(n)).map((n) => z.file(n).async('string')));
  const sec = secs.join('');
  const items = [...hpf.matchAll(/<opf:item [^>]*>/g)].map((m) => m[0]).filter((s) => /href="BinData\//.test(s));
  const refs = [...sec.matchAll(/chartIDRef="([^"]+)"/g)].map((m) => m[1]);
  const bins = [...sec.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]);
  const chartsIn = names.filter((n) => /^Chart\//.test(n)).sort();
  const binFiles = names.filter((n) => /^BinData\//.test(n)).sort();
  const problems = [];
  for (const r of refs) if (!names.includes(r)) problems.push(`없는 차트 부분: ${r}`);
  for (const c of chartsIn) if (!refs.includes(c)) problems.push(`남은 차트 부분: ${c}`);
  for (const it of items) {
    const id = /\bid="([^"]+)"/.exec(it)[1]; const href = /href="([^"]+)"/.exec(it)[1];
    if (!bins.includes(id)) problems.push(`남은 매니페스트 항목: ${href}`);
    if (!names.includes(href)) problems.push(`파일 없는 매니페스트 항목: ${href}`);
  }
  for (const b of binFiles) if (!items.some((s) => s.includes(`href="${b}"`))) problems.push(`매니페스트에 없는 BinData: ${b}`);
  if (/Chart\//.test(hpf)) problems.push('content.hpf 에 차트 부분이 올라 있다(한/글은 올리지 않는다)');
  return { z, sec, charts: chartsIn, bins: binFiles, items, refs, problems };
}

/** 한/글 차트를 지운 빈 바탕(문단은 그대로) */
function blank() {
  const d = open(ONE);
  const c = charts(d)[0];
  d.deleteShapeControl(c.section, c.paragraph, c.control);
  return open(exportOf(d));
}

// ───────── 1) 꾸러미 ─────────

test('한/글 차트 왕복: 차트 부분·대체 OLE 를 그대로 싣는다(매니페스트에는 OLE 만, 소문자 .ole·application/ole)', async () => {
  const p = await pkg(exportOf(open(ONE)));
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.charts, ['Chart/chart1.xml']);
  assert.equal(p.bins.length, 1);
  assert.match(p.items[0], /href="BinData\/[^"]+\.ole" media-type="application\/ole"/);
  assert.match(p.sec, /<hp:switch><hp:case hp:required-namespace="http:\/\/www\.hancom\.co\.kr\/hwpml\/2016\/ooxmlchart"><hp:chart [^>]*chartIDRef="Chart\/chart1\.xml"/);
});

test('차트 지우기: Chart 부분·대체 OLE·매니페스트 항목이 남지 않고, 되돌리면(스냅숏) 다시 실린다', async () => {
  const d = open(ONE);
  const before = exportOf(d);
  const snap = d.saveSnapshot();
  const c = charts(d)[0];
  d.deleteShapeControl(c.section, c.paragraph, c.control);
  const p = await pkg(exportOf(d));
  assert.deepEqual([p.charts, p.bins, p.items, p.problems], [[], [], [], []]);
  assert.doesNotMatch(p.sec, /hp:chart|hp:switch|hp:ole/);
  d.restoreSnapshot(snap);
  const back = await pkg(exportOf(d));
  assert.deepEqual([back.charts, back.bins.length, back.problems], [['Chart/chart1.xml'], 1, []]);
  assert.equal(charts(d).length, 1);
  assert.equal(back.sec, (await pkg(before)).sec, '되돌린 본문 = 지우기 전');
});

test('차트 둘 중 첫째 지우기: 남은 차트는 한/글처럼 chart1 로 다시 매기고, 번호에 구멍이 난 꾸러미도 읽는다', async () => {
  const d = open(TWO);
  const [c0] = charts(d);
  const kept = JSON.parse(d.getChartDataByIndex(1));
  d.deleteShapeControl(c0.section, c0.paragraph, c0.control);
  const out = exportOf(d);
  const p = await pkg(out);
  assert.deepEqual([p.charts, p.refs, p.bins.length, p.problems], [['Chart/chart1.xml'], ['Chart/chart1.xml'], 1, []]);
  const again = open(out);
  assert.deepEqual(JSON.parse(again.getChartDataByIndex(0)).series, kept.series, '남은 차트의 값 그대로');
  // 구멍 난 꾸러미(chart2 만 — 다른 도구가 쓴 꼴): 다 읽는다(종전엔 chart1 이 없으면 멈춰 빈 차트)
  const z = await JSZip.loadAsync(out);
  const xml = await z.file('Chart/chart1.xml').async('uint8array');
  z.remove('Chart/chart1.xml'); z.file('Chart/chart2.xml', xml);
  const sec = await z.file('Contents/section0.xml').async('string');
  z.file('Contents/section0.xml', sec.replace('chartIDRef="Chart/chart1.xml"', 'chartIDRef="Chart/chart2.xml"'));
  const gap = open(await z.generateAsync({ type: 'nodebuffer' }));
  assert.equal(JSON.parse(gap.getChartDataByIndex(0)).ok, true);
  assert.deepEqual((await pkg(exportOf(gap))).charts, ['Chart/chart1.xml'], '다시 저장하면 chart1');
});

test('표 셀 안 차트 지우기(deleteCellShapeControlByPath): 표는 그대로, 차트 부분·대체 OLE 없음', async () => {
  const d = open(CELL);
  const c = charts(d)[0];
  assert.equal(c.container?.[0]?.kind, 'tableCell');
  const cellPath = [{ controlIndex: c.container[0].control, cellIndex: c.container[0].cell, cellParaIndex: c.container[0].paragraph }];
  assert.throws(() => d.deleteShapeControl(c.section, c.paragraph, c.control), '본문 주소로는 셀 안 차트를 짚지 못한다');
  assert.equal(JSON.parse(d.deleteCellShapeControlByPath(c.section, c.paragraph, JSON.stringify(cellPath), c.control)).ok, true);
  const p = await pkg(exportOf(d));
  assert.deepEqual([p.charts, p.bins, p.problems], [[], [], []]);
  assert.equal((p.sec.match(/<hp:tbl\b/g) || []).length, 1);
  assert.equal(charts(d).length, 0);
});

// ───────── 2) 넣기·값 고치기 ─────────

test('차트 넣기: 맨 hp:chart(글자처럼·위아래·그림 번호) + 한/글 다시 저장본과 같은 Chart/chart1.xml, 값 15 고치기는 ①만', async () => {
  const d = blank();
  const r = JSON.parse(d.insertChart(0, 1, 0, ''));
  assert.deepEqual([r.ok, r.chartIndex, r.chartIDRef], [true, 0, 'Chart/chart1.xml']);
  const data = JSON.parse(d.getChartDataByIndex(0));
  assert.deepEqual([data.labels, data.series.map((s) => s.name), data.series[0].values], [['항목 1', '항목 2', '항목 3', '항목 4'], ['계열 1', '계열 2', '계열 3'], ['4.3', '2.5', '3.5', '4.5']]);
  let p = await pkg(exportOf(d));
  assert.deepEqual([p.charts, p.bins, p.problems], [['Chart/chart1.xml'], [], []]);
  assert.match(p.sec, /<hp:chart [^>]*numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" chartIDRef="Chart\/chart1\.xml"><hp:sz width="32250" widthRelTo="ABSOLUTE" height="18750"[^>]*\/><hp:pos treatAsChar="1"/);
  const xml = await p.z.file('Chart/chart1.xml').async('string');
  // 한/글이 다시 저장해도 바뀌지 않는 꼴(한글 COM 2026-10-30: 맨 hp:chart 를 열어 HWPX 로 저장 → Chart/chart1.xml 바이트 같음)
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes" \?><c:chartSpace [^>]*><c:date1904 val="0"\/><c:roundedCorners val="0"\/><mc:AlternateContent/);
  assert.match(xml, /<c:invertIfNegative val="0"\/>/);
  assert.match(xml, /<ho:hncChartStyle xmlns:ho="http:\/\/schemas\.haansoft\.com\/office\/8\.0" layoutIndex="-1" colorIndex="-1" styleIndex="-1"\/>/);
  const edit = (values) => ({ series: data.series.map((s, i) => ({ name: s.name, values: i === 0 ? values : s.values })) });
  const w = JSON.parse(d.setChartDataByIndex(0, JSON.stringify(edit(['15', '2.5', '3.5', '4.5']))));
  assert.deepEqual([w.ok, w.wrote], [true, ['zipPart']]);
  for (const bad of [['abc', '2.5', '3.5', '4.5'], ['', '2.5', '3.5', '4.5'], ['1e999', '2.5', '3.5', '4.5']]) {
    const x = JSON.parse(d.setChartDataByIndex(0, JSON.stringify(edit(bad))));
    assert.deepEqual([x.ok, x.wrote, x.invalid[0].reason], [false, [], 'notANumber'], `거부: ${bad[0]}`);
  }
  p = await pkg(exportOf(d));
  assert.match(await p.z.file('Chart/chart1.xml').async('string'), /<c:pt idx="0"><c:v>15<\/c:v><\/c:pt>/);
  assert.deepEqual(JSON.parse(open(exportOf(d)).getChartDataByIndex(0)).series[0].values, ['15', '2.5', '3.5', '4.5']);
});

test('차트 넣기 극단값: 매우 큰·작은 크기, 1×1, 60 항목, 12 계열, 긴 이름, 음수·소수·1e9, 빈 칸 — 꾸러미 정상, 다시 열림, 그리기 멈춤 없음', async () => {
  const cats = (n) => Array.from({ length: n }, (_, i) => `항목${i + 1}`);
  const cases = {
    huge: { width: 200000, height: 150000 },
    tiny: { width: 600, height: 400 },
    one: { categories: ['하나'], series: [{ name: 'A', values: ['7'] }] },
    many: { categories: cats(60), series: [{ name: 'A', values: cats(60).map((_, i) => String((i * 7) % 23)) }] },
    series12: { categories: ['가', '나', '다'], series: Array.from({ length: 12 }, (_, i) => ({ name: `계열${i + 1}`, values: [i + 1, i + 2, i + 3].map(String) })) },
    long: { categories: ['아주 긴 항목 이름 '.repeat(12), '나'], series: [{ name: '계열 이름이 아주 긴 경우 '.repeat(5), values: ['1', '2'] }] },
    numbers: { categories: ['가', '나', '다', '라'], series: [{ name: 'A', values: ['-3', '0', '2.75', '1e9'] }] },
    blankCell: { categories: ['가', '나', '다'], series: [{ name: 'A', values: ['1', '', '3'] }] },
    line: { kind: 'line' }, pie: { kind: 'pie', categories: ['가', '나', '다'], series: [{ name: '판매', values: ['3', '5', '2'] }] },
  };
  for (const [name, o] of Object.entries(cases)) {
    const d = blank();
    assert.equal(JSON.parse(d.insertChart(0, 1, 0, JSON.stringify(o))).ok, true, name);
    const t0 = Date.now();
    for (let pg = 0; pg < d.pageCount(); pg++) assert.match(d.renderPageSvg(pg), /<svg/);
    assert.ok(Date.now() - t0 < 5000, `${name}: 그리기 5초 안`);
    const out = exportOf(d);
    const p = await pkg(out);
    assert.deepEqual([p.charts, p.problems], [['Chart/chart1.xml'], []], name);
    assert.equal(charts(open(out)).length, 1, `${name}: 다시 열림`);
    if (name === 'blankCell') assert.match(await p.z.file('Chart/chart1.xml').async('string'), /<c:ptCount val="3"\/><c:pt idx="0"><c:v>1<\/c:v><\/c:pt><c:pt idx="2"><c:v>3<\/c:v>/, '빈 칸은 한/글처럼 점째 뺀다');
  }
  assert.throws(() => blank().insertChart(0, 1, 0, JSON.stringify({ series: [{ name: 'A', values: ['abc'] }] })), /수여야/);
});

// ───────── 3) 그리기 ─────────

/** 차트 하나를 넣고(크기·값) 값축 scaling(min/max)을 고친 문서 → 첫 쪽 차트 SVG 조각 */
async function chartSvg({ values, cats = ['가', '나', '다'], max, min, kind = 'bar', width = 32250, height = 18750, raw = null }) {
  const d = blank();
  d.insertChart(0, 1, 0, JSON.stringify({ kind, width, height, categories: cats, series: [{ name: 'A', values: values.map(String) }] }));
  const z = await JSZip.loadAsync(exportOf(d));
  let xml = await z.file('Chart/chart1.xml').async('string');
  const sc = `<c:scaling><c:orientation val="minMax"/>${max != null ? `<c:max val="${max}"/>` : ''}${min != null ? `<c:min val="${min}"/>` : ''}</c:scaling>`;
  xml = xml.replace(/(<c:valAx><c:axId val="1002"\/>)<c:scaling><c:orientation val="minMax"\/><\/c:scaling>/, `$1${sc}`);
  if (raw) xml = raw(xml);
  z.file('Chart/chart1.xml', xml);
  const s = open(await z.generateAsync({ type: 'nodebuffer' })).renderPageSvg(0);
  const i = s.indexOf('<g class="hwp-ooxml-chart">');
  return s.slice(i);
}
/** 값축 눈금 글(축선 왼쪽 — 세로 값축) 차례 */
function valueLabels(svg) {
  const ax = /class="hwp-chart-axis" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(svg);
  const axisX = Number(ax[1]);
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)]
    .filter((m) => Number(m[1]) < axisX).map((m) => [Number(m[2]), m[3]]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}
/** 그림 영역 { left, right, top, bottom } — 값축 선(세로)과 가로 격자선 */
function plotBox(svg) {
  const ax = /class="hwp-chart-axis" x1="([\d.]+)" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)"/.exec(svg);
  const grid = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].map((m) => m.slice(1).map(Number)).filter(([, y1, , y2]) => y1 === y2);
  return { left: Number(ax[1]), right: Math.max(...grid.map((g) => g[2])), top: Number(ax[2]), bottom: Number(ax[3]) };
}
/** 그림 영역 안쪽 x 의 막대 rect 들 [x, y, w, h] */
function bars(svg) {
  const b = plotBox(svg);
  return [...svg.matchAll(/<rect x="([\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#(?!ffffff)/g)].map((m) => m.slice(1).map(Number))
    .filter(([x]) => x >= b.left - 0.5 && x < b.right);
}
/** 막대(세로)가 모두 그림 영역 [top, bottom] 안인가 */
function barsInside(svg) {
  const b = plotBox(svg); const r = bars(svg);
  return r.length > 0 && r.every(([, y, , h]) => y >= b.top - 0.5 && y + h <= b.bottom + 0.5);
}

// 한/글 PDF 실측(한글 COM 2026-10-30, 32250×18750 HWPUNIT 묶은 세로 막대 — 값축 눈금 글)
const HANGUL_AXES = [
  ['고정 0~5, 값 15', { values: [1, 15, 3], max: 5, min: 0 }, ['0', '1', '2', '3', '4', '5']],
  ['고정 0~10', { values: [1, 15, 3], max: 10, min: 0 }, ['0', '2', '4', '6', '8', '10']],
  ['고정 0~7', { values: [1, 15, 3], max: 7, min: 0 }, ['0', '1', '2', '3', '4', '5', '6', '7']],
  ['고정 0~3', { values: [1, 15, 3], max: 3, min: 0 }, ['0', '0.5', '1', '1.5', '2', '2.5', '3']],
  ['고정 0~1', { values: [0.2, 1.5, 0.7], max: 1, min: 0 }, ['0', '0.2', '0.4', '0.6', '0.8', '1']],
  ['고정 0~100', { values: [10, 150, 30], max: 100, min: 0 }, ['0', '20', '40', '60', '80', '100']],
  ['고정 0~12', { values: [1, 15, 3], max: 12, min: 0 }, ['0', '2', '4', '6', '8', '10', '12']],
  ['고정 0~2.5', { values: [1, 15, 2], max: 2.5, min: 0 }, ['0', '0.5', '1', '1.5', '2', '2.5']],
  ['고정 −5~5, 값 −8·15', { values: [-8, 15, 3], max: 5, min: -5 }, ['-5', '-3', '-1', '1', '3', '5']],
  ['최대만 5', { values: [1, 15, 3], max: 5 }, ['0', '1', '2', '3', '4', '5']],
  ['자동 −3·2·5', { values: [-3, 2, 5] }, ['-4', '-2', '0', '2', '4', '6']],
  ['자동 소수 2.75', { values: [0.25, 1.5, 2.75] }, ['0', '0.5', '1', '1.5', '2', '2.5', '3']],
  ['자동 1e9', { values: [1e9, 2.5e9, 5e8] }, ['0', '500000000', '1.0E+09', '1.5E+09', '2.0E+09', '2.5E+09', '3.0E+09']],
  ['자동 모두 0', { values: [0, 0, 0] }, ['0', '0.2', '0.4', '0.6', '0.8', '1', '1.2']],
  ['자동 최대 4', { values: [1, 4, 2] }, ['0', '1', '2', '3', '4', '5']],
  // 크기(한/글: 같은 값 1·2·5 도 높이 16000 이하면 간격 2, 17000 이상이면 1)
  ['높이 16000', { values: [1, 2, 5], height: 16000 }, ['0', '2', '4', '6']],
  ['높이 17000', { values: [1, 2, 5], height: 17000 }, ['0', '1', '2', '3', '4', '5', '6']],
  ['높이 50000', { values: [1, 2, 5], height: 50000 }, ['0', '1', '2', '3', '4', '5', '6']],
];

for (const [name, spec, want] of HANGUL_AXES) {
  test(`값축 눈금 = 한/글: ${name}`, async () => {
    const svg = await chartSvg(spec);
    assert.deepEqual(valueLabels(svg), want);
    assert.ok(barsInside(svg), '막대가 그림 영역 안(넘는 값은 끝에서 잘림)');
  });
}

test('그리기: 음수 막대는 0 에서 아래로, 항목 이름은 0 줄로(한/글), 빈 칸(점 생략)은 제자리, 꺾은선은 그림 영역에서 잘린다', async () => {
  // 음수: 0 줄 y 보다 아래로 내려가는 막대가 있다
  const neg = await chartSvg({ values: [-3, 2, 5] });
  // 0.9 emits world coordinates for the same zero crossing; 0.8.7 uses a
  // translated category group. Verify the physical crossing in either form.
  const categoryAxis = /class="hwp-chart-cat-axis"[^>]*y1="([\d.]+)"/.exec(neg);
  if (neg.includes('class="hwp-chart-cat-cross"')) {
    assert.match(neg, /class="hwp-chart-cat-cross" transform="translate\(0\.00,-/);
  } else if (categoryAxis) {
    const zeroY = Number(categoryAxis[1]);
    const box = plotBox(neg);
    assert.ok(zeroY > box.top && zeroY < box.bottom, '항목축은 그림 영역 안의 0 선');
    const horizontalLines = [...neg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)"/g)];
    assert.ok(horizontalLines.some(m => Math.abs(Number(m[1]) - zeroY) < 0.02 && m[1] === m[2]), '값축 눈금 선과 항목축의 0 교차가 같다');
    assert.ok(bars(neg).some(([, y, , h]) => y >= zeroY - 0.02 && y + h > zeroY), '음수 막대는 0 선 아래로');
  } else {
    assert.match(neg, /class="hwp-chart-cat-cross" transform="translate\(0\.00,-/);
  }
  // 빈 칸: 1, (빈), 3 → 막대 두 개, 둘째(가운데) 자리는 비고 셋째 자리에 3(종전엔 3 이 가운데로 당겨졌다)
  const blankSvg = await chartSvg({ values: [1, 3, 3], raw: (x) => x.replace('<c:pt idx="1"><c:v>3</c:v></c:pt>', '') });
  const tall = bars(blankSvg).filter(([, , , h]) => h > 1);
  assert.equal(tall.length, 2);
  assert.ok(tall[1][0] - tall[0][0] > 150, '3 은 셋째 항목 자리');
  // 꺾은선 고정 최대 5, 값 15: 선은 그림 영역 위 끝에서 끊기고 그 점 표식은 없다
  const line = await chartSvg({ kind: 'line', values: [1, 15, 3], max: 5, min: 0, cats: ['가', '나', '다'] });
  const ax = /class="hwp-chart-axis" x1="[\d.]+" y1="([\d.]+)"/.exec(line);
  const top = Number(ax[1]);
  const ys = [...line.matchAll(/<path d="([^"]+)" fill="none"/g)].flatMap((m) => [...m[1].matchAll(/[ML][\d.]+,([\d.]+)/g)].map((q) => Number(q[1])));
  assert.ok(ys.length && ys.every((y) => y >= top - 0.5), '선은 그림 영역 안');
});

// ───────── 4) 서버 ─────────

/** 서버 쪽 반영(실시간 밀어 넣기의 object 덩어리와 같은 일) */
async function applyObjects(baseBytes, headBytes) {
  const base = await HwpxDoc.load(baseBytes); const head = await HwpxDoc.load(headBytes);
  const r = await diffDocs(base, head);
  for (const h of r.hunks) if (h.type === 'object') base.copyObjectsFrom(head, h.headRef, h.ref);
  return { base, r };
}
const brief = (r) => r.hunks.map((h) => [h.type, h.ref, h.objectSummary ?? '']);

test('서버 문서: 한/글 차트(<hp:switch>)를 도형으로 짝짓고 값·크기·지우기·넣기를 옮긴다 — 차트 부분·대체 OLE 를 같이 옮기고 거둔다', async () => {
  // 손대지 않은 편집기 왕복은 덩어리 0
  assert.deepEqual(brief(await diffDocs(ONE, exportOf(open(ONE)))), []);
  // 값 고치기: 차트 부분 내용·대체 OLE 가 바뀐다 — 새 내용은 새 항목으로 옮기고 옛 것은 저장할 때 거둔다, 차트 부분은 한/글처럼 chart1 로 다시 매긴다
  let d = open(ONE);
  const data = JSON.parse(d.getChartDataByIndex(0));
  d.setChartDataByIndex(0, JSON.stringify({ series: data.series.map((s, i) => ({ name: s.name, values: s.values.map((v, j) => (i === 0 && j === 1 ? '15' : v)) })) }));
  let { base, r } = await applyObjects(ONE, exportOf(d));
  assert.deepEqual(brief(r), [['object', 's0/p2', '차트 모양 바꿈']]);
  let p = await pkg(await base.save());
  assert.deepEqual([p.charts, p.bins.length, p.problems], [['Chart/chart1.xml'], 1, []]);
  assert.match(await p.z.file('Chart/chart1.xml').async('string'), /<c:v>15<\/c:v>/);
  // 크기
  d = open(ONE);
  const c = charts(d)[0];
  const sp = JSON.parse(d.getShapeProperties(c.section, c.paragraph, c.control));
  d.setShapeProperties(c.section, c.paragraph, c.control, JSON.stringify({ width: sp.width * 2, height: sp.height * 2 }));
  ({ base, r } = await applyObjects(ONE, exportOf(d)));
  assert.deepEqual(brief(r), [['object', 's0/p2', '차트 크기 114×66mm → 228×132mm']]);
  p = await pkg(await base.save());
  assert.match(p.sec, /<hp:chart [^>]*><hp:sz width="64500" widthRelTo="ABSOLUTE" height="37500"/);
  assert.deepEqual(p.problems, []);
  // 지우기
  d = open(ONE);
  d.deleteShapeControl(c.section, c.paragraph, c.control);
  const deleted = exportOf(d);
  ({ base, r } = await applyObjects(ONE, deleted));
  assert.deepEqual(brief(r), [['object', 's0/p2', '도형 지움: 차트']]);
  p = await pkg(await base.save());
  assert.deepEqual([p.charts, p.bins, p.items, p.problems], [[], [], [], []]);
  assert.deepEqual(chartPartReport(base).orphans, []);
  // 넣기(지운 문서에 한/글 차트 문서를 밀어 넣는다): 차트 부분·대체 OLE 가 따라온다
  ({ base, r } = await applyObjects(deleted, ONE));
  assert.deepEqual(brief(r), [['object', 's0/p2', '도형 넣음: 차트']]);
  p = await pkg(await base.save());
  assert.deepEqual([p.charts, p.bins.length, p.problems], [['Chart/chart1.xml'], 1, []]);
});

test('실시간 밀어 넣기: 차트 넣기·값 고치기·크기·지우기 → clean, 한글로 저장(kind=export) 꾸러미에 남는·없는 부분 0', { timeout: 180000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  const { id } = await uploadDoc(srv.base, srv.tokens.a, ONE, '차트.hwpx');
  const step = async (name, edit) => {
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const d = open(w.data);
    assert.deepEqual(brief(await diffDocs(Buffer.from(w.data), exportOf(d))), [], `${name}: 서버 문서의 편집기 왕복은 덩어리 0`);
    edit(d);
    const head = exportOf(d);
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: head });
    assert.equal(r.clean, true, `${name}: clean`);
    assert.equal(r.unsupported, 0, `${name}: 반영 안 되는 변경 없음`);
    const again = await A(`/api/docs/${id}/live?base=${r.version}`, { method: 'PUT', body: head });
    assert.equal(again.version, r.version, `${name}: 다시 보내도 그대로`);
    const ex = await pkg(Buffer.from((await A.res(`/api/docs/${id}/file?kind=export`)).data));
    assert.deepEqual(ex.problems, [], `${name}: 꾸러미`);
    const working = await HwpxDoc.load((await A.res(`/api/docs/${id}/file?kind=working`)).data);
    assert.deepEqual(brief(await diffDocs(working, await HwpxDoc.load(head))), [], `${name}: 서버 문서 = 보낸 문서`);
    return ex;
  };
  // 넣기: 첫 문단 끝에 기본 차트
  let ex = await step('넣기', (d) => { assert.equal(JSON.parse(d.insertChart(0, 1, 0, '')).ok, true); });
  assert.equal(ex.refs.length, 2);
  assert.deepEqual(ex.charts, ['Chart/chart1.xml', 'Chart/chart2.xml']);
  // 값 고치기(새 차트 — 대체 OLE 없는 맨 hp:chart)
  ex = await step('값', (d) => {
    const i = charts(d).findIndex((c) => c.nestedCopy == null);
    const data = JSON.parse(d.getChartDataByIndex(i));
    assert.equal(JSON.parse(d.setChartDataByIndex(i, JSON.stringify({ series: data.series.map((s, k) => ({ name: s.name, values: s.values.map((v, j) => (k === 0 && j === 0 ? '15' : v)) })) }))).ok, true);
  });
  const xmls = await Promise.all(ex.charts.map((n) => ex.z.file(n).async('string')));
  assert.ok(xmls.some((x) => x.includes('<c:v>15</c:v>')), '고친 값이 실린다');
  // 크기(한/글 차트)
  ex = await step('크기', (d) => {
    const c = charts(d).find((x) => x.nestedCopy != null);
    d.setShapeProperties(c.section, c.paragraph, c.control, JSON.stringify({ width: 20000, height: 12000 }));
  });
  assert.match(ex.sec, /<hp:sz width="20000" widthRelTo="ABSOLUTE" height="12000"/);
  // 지우기(한/글 차트): 대체 OLE·차트 부분이 빠진다
  ex = await step('지우기', (d) => {
    const c = charts(d).find((x) => x.nestedCopy != null);
    d.deleteShapeControl(c.section, c.paragraph, c.control);
  });
  assert.deepEqual([ex.charts.length, ex.bins, ex.items], [1, [], []]);
});
