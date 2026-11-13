// 자연어 모델은 모의 도구 호출로 대체한다. 임시 서버·임시 문서만 쓰며 브라우저/Python 차트 생성은 사용하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { chartDataFromTable, normalizeNativeChart, nativeChartDocument } from '../server/native-chart.js';
import { editorEngine } from '../server/toc-engine.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { TOOL_PROFILES } from '../server/tool-profiles.js';
import { leanReceipt } from '../server/lean.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const author = '차트 시험';
const data = { categories: ['2024', '2025', '2026'], series: [{ name: '인원', values: [3200, 3500, 3700] }, { name: '비율', values: [25.5, 30, 0] }] };
const sourceFor = key => ({ table: key, header_row: 0, category_col: 0, value_cols: [1, 2], data_rows: [1, 2, 3] });
async function tableDoc(blank = false) {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  d.insertTableAfter(0, 0, { rows: [['연도', '인원', '비율'], ['2024', '3,200', '25.5%'], ['2025', '3,500', '30%'], ['2026', blank ? '' : '3,700', '0']], headerRows: 1 }, { author });
  return d;
}
function open(bytes) { return new (editorEngine().HwpDocument)(new Uint8Array(bytes)); }
async function mcp(srv, name, args, lean = false) {
  const r = await fetch(`${srv.base}/mcp?agent=NativeChartTest${lean ? '&lean=1' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text(), line = raw.split(/\r?\n/).find(l => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  assert.ok(res, raw);
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('표의 실제 자료: 쉼표·%·빈칸·0, 잘못된 범위·합친 칸·단위·중복 선택 거절', async () => {
  const d = await tableDoc(), source = sourceFor(d.tables()[0].key);
  assert.deepEqual(chartDataFromTable(d, source), data);
  const blankData = chartDataFromTable(await tableDoc(true), source);
  assert.equal(blankData.series[0].values[2], null);
  assert.throws(() => normalizeNativeChart({ type: 'bar', ...blankData }), /빈칸·결측값/);
  const bad = patch => assert.throws(() => chartDataFromTable(d, { ...source, ...patch }), e => ['BAD_CHART', 'NO_TABLE'].includes(e.code));
  bad({ value_cols: [1, 1] }); bad({ data_rows: [1, 1] }); bad({ data_rows: [0] }); bad({ value_cols: [0] }); bad({ data_rows: [99] }); bad({ table: 's0/p99#t0' });
  const t = d.tables()[0], cell = t.cells.find(c => c.row === 1 && c.col === 1);
  d.replaceTracked(cell.refs[0], 0, 5, '3,200명', { author });
  assert.throws(() => chartDataFromTable(d, source), /숫자로 해석/);
  const merged = await tableDoc(); merged.editTable(source.table, [{ op: 'merge', range: { row_from: 1, row_to: 1, col_from: 0, col_to: 1 } }]);
  assert.throws(() => chartDataFromTable(merged, source), /합친 칸/);
});

test('직접 자료: 값 수·유한수·결측·원형 계열·알 수 없는 옵션을 검사한다', () => {
  assert.deepEqual(normalizeNativeChart({ type: 'line', ...data }), { type: 'line', ...data });
  for (const c of [
    { type: 'line', ...data, series: [{ name: '값', values: [1] }] },
    { type: 'line', categories: ['가'], series: [{ name: '값', values: [null] }] },
    { type: 'line', categories: ['가'], series: [{ name: '값', values: [Infinity] }] },
    { type: 'pie', ...data }, { type: 'line', ...data, y_min: 1 }, { type: 'bar', ...data, title: '제목\u0000' },
    { type: 'pie', categories: ['가'], series: [{ name: '값', values: [-1] }] },
  ]) assert.throws(() => normalizeNativeChart(c), e => e.code === 'BAD_CHART');
});

test('10종 엔진 차트: 실제 OOXML 종류·크기·데이터 편집·SVG 출력', async () => {
  // 기대 좌표는 한/글 2022 갤러리 실측 계약(tests/h2022_chart.test.mjs의 fixture 대조와 동일).
  const kinds = { bar: [1, 0], hbar: [0, 0], line: [2, 3], pie: [3, 0], doughnut: [3, 6], area: [2, 7],
    stacked_bar: [1, 1], stacked_hbar: [0, 1], percent_stacked_bar: [1, 2], percent_stacked_hbar: [0, 2] };
  for (const [type, expected] of Object.entries(kinds)) {
    const spec = { type, ...data, ...(['pie', 'doughnut'].includes(type) ? { series: data.series.slice(0, 1) } : { x_title: '가로축', y_title: '세로축' }), title: '연도별 비교', legend: 'bottom', data_labels: true };
    const donor = nativeChartDocument(spec, { width: 30000, height: 18000 });
    assert.deepEqual(donor.ownObjects('s0/p1'), [{ kind: 'chart', name: '차트' }]);
    // 생성용 빈 문서는 스타일 없는 개체 공급자다. 실제 제품과 같은 경로로 원본에 차트만 옮긴 뒤 검사한다.
    const target = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
    const ref = target.insertParagraphAfter(0, 0, '', { author });
    target.copyObjectsFrom(donor, 's0/p1', ref);
    const d = open(await target.save());
    try {
      const fmt = JSON.parse(d.getChartFormatByIndex(0));
      assert.deepEqual([fmt.group, fmt.index], expected, type);
      assert.deepEqual([fmt.titleText, fmt.legend, fmt.dataLabels], ['연도별 비교', 'bottom', true], type);
      if (fmt.hasAxes) assert.deepEqual([fmt.horizontalAxis.titleText, fmt.verticalAxis.titleText], ['가로축', '세로축'], type);
      assert.match(target.sections[0].xml, /<hp:sz width="30000"[^>]*height="18000"/);
      const read = JSON.parse(d.getChartDataByIndex(0));
      assert.deepEqual(read.labels, data.categories, type);
      assert.deepEqual(read.series[0].values, ['3200', '3500', '3700'], type);
      const changed = JSON.parse(d.setChartDataByIndex(0, JSON.stringify({ structure: true, labels: read.labels, series: read.series.map((s, i) => ({ name: i === 0 ? '수정 인원' : s.name, values: i === 0 ? ['3300', '3600', '3700'] : s.values })) })));
      assert.equal(changed.ok, true, JSON.stringify(changed));
      const svg = d.renderPageSvg(0);
      assert.match(svg, /hwp-ooxml-chart/, type); assert.doesNotMatch(svg, /<image\b/, type);
      const again = open(d.exportHwpx());
      try { assert.equal(JSON.parse(again.getChartDataByIndex(0)).series[0].values[0], '3300', type); } finally { again.free(); }
    } finally { d.free(); }
  }
});

test('MCP → 표 기반 제안 → 적용 → 저장·재열기 → 되돌리기, 추적/최종 모드', { timeout: 60000 }, async t => {
  const srv = await startServer({ ai: 'off', env: { HWPX_COWORK_PYTHON: 'no-python-for-native-chart' } });
  try {
    const A = srv.api('a');
    for (const track of ['final', 'tracked']) await t.test(track, async () => {
      const source = await tableDoc(), src = sourceFor(source.tables()[0].key);
      const doc = await uploadDoc(srv.base, srv.tokens.a, await source.save()), D = `/api/docs/${doc.id}`;
      await A(`${D}/settings`, { method: 'PATCH', body: { track } });
      const p = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: 's0/p1', source_table: src,
        chart: { type: 'line', title: '연도별 비교', legend: 'bottom', data_labels: true, x_title: '연도', y_title: '표에 기재된 값' }, width_mm: 100, height_mm: 60 });
      assert.ok(!p.error, p.error); assert.deepEqual(p.figure.nativeChart.series, data.series);
      assert.equal(p.figure.aid, undefined); assert.equal((await A(`${D}/attachments`)).length, 0);
      const before = await HwpxDoc.load(await A(`${D}/file?kind=tracked`));
      const applied = await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
      const bytes = await A(`${D}/file?kind=tracked`), saved = await HwpxDoc.load(bytes);
      assert.equal(applied.status, 'applied'); assert.deepEqual(saved.tables(), before.tables());
      assert.equal(saved.figures().length, 0); assert.deepEqual(saved.ownObjects(applied.insertedRef), [{ kind: 'chart', name: '차트' }]);
      assert.ok(saved.container.has('Chart/chart1.xml'));
      const r = open(bytes);
      try { assert.deepEqual(JSON.parse(r.getChartDataByIndex(0)).series.map(s => s.values), [['3200', '3500', '3700'], ['25.5', '30', '0']]); } finally { r.free(); }
      if (track === 'tracked') assert.ok(saved.changes().some(c => c.objects?.some(o => o.what === 'chart')), '차트 삽입 변경 추적');
      const undo = await A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
      assert.equal(undo.status, 'undone');
      const back = await HwpxDoc.load(await A(`${D}/file?kind=tracked`));
      assert.equal(back.container.has('Chart/chart1.xml'), false); assert.deepEqual(back.tables(), before.tables());
      assert.equal(back.sections[0].bodyParas.length, before.sections[0].bodyParas.length);
    });

    await t.test('제안 뒤 표 수치 변경은 STALE, 실패가 문서를 바꾸지 않는다', async () => {
      const source = await tableDoc(), table = source.tables()[0];
      const doc = await uploadDoc(srv.base, srv.tokens.a, await source.save()), D = `/api/docs/${doc.id}`;
      const p = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: table.ref, source_table: sourceFor(table.key), chart: { type: 'bar' } });
      assert.ok(!p.error, p.error);
      const q = await A(`${D}/proposals`, { method: 'POST', body: { ref: table.cells.find(c => c.row === 1 && c.col === 1).refs[0], find: '3,200', replace: '3,300' } });
      await A(`${D}/proposals/${q.pid}/apply`, { method: 'POST' });
      const before = Buffer.from(await A(`${D}/file?kind=tracked`));
      const no = await A.res(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
      assert.deepEqual([no.status, no.data.error], [409, 'STALE']);
      assert.deepEqual(Buffer.from(await A(`${D}/file?kind=tracked`)), before);
    });

    await t.test('원본 표 주소가 이동해도 같은 표에서 만들고, 추가 메모는 되돌리기로 지우지 않는다', async () => {
      const source = await tableDoc(), table = source.tables()[0];
      const doc = await uploadDoc(srv.base, srv.tokens.a, await source.save()), D = `/api/docs/${doc.id}`;
      const p = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: table.ref, source_table: sourceFor(table.key), chart: { type: 'bar' } });
      const ins = await A(`${D}/proposals`, { method: 'POST', body: { type: 'insert', afterRef: 's0/p0', text: '추가 글' } });
      await A(`${D}/proposals/${ins.pid}/apply`, { method: 'POST' });
      const moved = (await A(`${D}/proposals`)).find(x => x.pid === p.pid);
      assert.equal(moved.figure.sourceTable.table, 's0/p2#t0');
      const ap = await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
      await A(`${D}/memos`, { method: 'POST', body: { ref: ap.insertedRef, start: 0, end: 0, text: '사용자가 추가한 검토 의견' } });
      const undo = await A.res(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
      assert.deepEqual([undo.status, undo.data.error], [409, 'STALE']);
      assert.ok((await A(`${D}/memos`)).some(m => JSON.stringify(m).includes('사용자가 추가한 검토 의견')));
    });

    await t.test('직접 자료·여러 차트·주소 이동·lean 완료·잘못된 자료 거절', async () => {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx')), D = `/api/docs/${doc.id}`;
      const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '연도별 인원을 편집 가능한 막대 차트로 작성해 주세요', route: 'queue', target: { ref: 's0/p1' } } })).request;
      const start = await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid }, true);
      assert.ok(!start.error, start.error);
      const wrongAttempt = await mcp(srv, 'propose_chart', { doc_id: doc.id, request_id: req.rid, expected_attempt: 999, after_ref: 's0/p1', chart: { type: 'bar', ...data } });
      assert.match(wrongAttempt.error, /ATTEMPT_CHANGED/);
      const p = await mcp(srv, 'propose_chart', { doc_id: doc.id, request_id: req.rid, after_ref: 's0/p1', chart: { type: 'bar', ...data }, complete: '한/글에서 편집 가능한 차트를 제안했습니다.' }, true);
      assert.ok(!p.error, p.error); assert.equal(p.figure.editableChart, true); assert.equal(p.figure.nativeChart, undefined);
      assert.equal((await A(`${D}/requests/${req.rid}`)).status, 'done');
      const q = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: 's0/p2', chart: { type: 'bar', ...data } });
      await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
      const q2 = (await A(`${D}/proposals`)).find(x => x.pid === q.pid); assert.equal(q2.afterRef, 's0/p3');
      await A(`${D}/proposals/${q.pid}/apply`, { method: 'POST' });
      const d = await HwpxDoc.load(await A(`${D}/file?kind=tracked`));
      const charts = d.sections[0].xml.match(/<hp:chart\b[^>]*>/g); assert.equal(charts.length, 2);
      assert.notEqual(/\bid="([^"]+)"/.exec(charts[0])[1], /\bid="([^"]+)"/.exec(charts[1])[1]);
      assert.ok(d.container.has('Chart/chart2.xml'));
      const bad = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: 's0/p1', chart: { type: 'bar', ...data }, source_table: sourceFor('s0/p0#t0') });
      assert.match(bad.error, /BAD_CHART/);
      const tooWide = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: 's0/p1', chart: { type: 'bar', ...data }, width_mm: 300 });
      assert.match(tooWide.error, /BAD_CHART/);
      const blank = await tableDoc(true), blankDoc = await uploadDoc(srv.base, srv.tokens.a, await blank.save());
      const missing = await mcp(srv, 'propose_chart', { doc_id: blankDoc.id, after_ref: 's0/p1', chart: { type: 'bar' }, source_table: sourceFor('s0/p1#t0') });
      assert.match(missing.error, /빈칸·결측값/);
    });

    await t.test('기존 한/글 차트·대체 OLE는 새 차트를 넣고 되돌려도 보존한다', async () => {
      const original = fs.readFileSync(fixture('chart_hangul.hwpx'));
      const doc = await uploadDoc(srv.base, srv.tokens.a, original), D = `/api/docs/${doc.id}`;
      const engine = open(original); let expected;
      try { expected = JSON.parse(engine.getChartDataByIndex(0)); } finally { engine.free(); }
      const p = await mcp(srv, 'propose_chart', { doc_id: doc.id, after_ref: 's0/p0', chart: { type: 'line', ...data } });
      assert.ok(!p.error, p.error);
      const ap = await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
      const bytes = await A(`${D}/file?kind=tracked`), merged = open(bytes);
      try {
        assert.deepEqual(JSON.parse(merged.getChartDataByIndex(1)), { ...expected, chart: 2 });
      } finally { merged.free(); }
      const saved = await HwpxDoc.load(bytes), source = await HwpxDoc.load(original);
      const olePaths = [...source.container.files.keys()].filter(k => /^BinData\/.*\.ole$/i.test(k));
      assert.ok(olePaths.length > 0);
      for (const path of olePaths) assert.deepEqual(saved.container.getBytes(path), source.container.getBytes(path));
      const undone = await A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
      assert.equal(undone.status, 'undone');
      const back = open(await A(`${D}/file?kind=tracked`));
      try { assert.deepEqual(JSON.parse(back.getChartDataByIndex(0)), expected); } finally { back.free(); }
      assert.equal(ap.status, 'applied');
    });
  } finally { await srv.stop(); }
});

test('API·Codex 도구 노출·고정·중복 억제, lean에서 자료를 되풀이하지 않는다', async () => {
  assert.ok(TOOL_PROFILES.api.includes('propose_chart')); assert.ok(TOOL_PROFILES.codex.includes('propose_chart'));
  const calls = [];
  const ctx = await createApiToolContext({ docId: 'd', requestId: 2, attempt: 3, assertCurrent: async () => {}, listTools: async () => ({ tools: [
    { name: 'propose_chart', inputSchema: { properties: { doc_id: {}, request_id: {}, expected_attempt: {}, chart: {} } } },
  ] }), callTool: async (name, args) => { calls.push(args); return { content: [{ type: 'text', text: JSON.stringify({ pid: 7, type: 'figure', figure: { nativeChart: { type: 'bar', ...data }, sourceHash: 'secret', sourceTable: sourceFor('s0/p1#t0') } }) }] }; } });
  const args = { after_ref: 's0/p1', chart: { type: 'bar', ...data } };
  const first = await ctx.call('propose_chart', args); await ctx.call('propose_chart', args);
  assert.equal(calls.length, 1); assert.equal(ctx.nativeCharts, 1); assert.equal(ctx.figures, 0, '차트와 함께 최종 JSON으로 제출한 별도 도식 그림을 지우지 않는다');
  assert.deepEqual([calls[0].doc_id, calls[0].request_id, calls[0].expected_attempt], ['d', 2, 3]);
  assert.doesNotMatch(first.content[0].text, /categories|series|sourceHash/);
  assert.equal(leanReceipt('propose_chart', { pid: 1, figure: { nativeChart: { type: 'bar', ...data } } }).figure.editableChart, true);
});
