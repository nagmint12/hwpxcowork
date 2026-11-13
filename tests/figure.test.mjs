// node --test tests/figure.test.mjs — 그림 넣기: 엔진(insertPictureAfter·figures·removeUnusedBinary·imageInfo), 차트 그리기(server/chart.js),
// 그림 제안(MCP propose_figure: 그림 파일·차트·첨부 → 적용 → 되돌리기). 한글 2022 확인은 tests/hangul_roundtrip.py 로 따로 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HwpxDoc } from '../engine/doc.js';
import { imageInfo } from '../engine/picture.js';
import { sectionTextWidth } from '../engine/table.js';
import { normChart, renderChart } from '../server/chart.js';
import { makePng, jpegHead, gifHead, bmpHead } from './helpers/image.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SAMPLE = path.join(here, 'samples', '2025년_전체종합보고서.hwpx'); // 자동 번호 그림 캡션 45개
const hasSample = fs.existsSync(SAMPLE);
const author = '홍길동(Claude)';
const reload = async (d) => HwpxDoc.load(await d.save());
const paraXml = (d, ref) => { const sec = d.sections[Number(/^s(\d+)/.exec(ref)[1])]; const p = sec.byRef(ref); return sec.xml.slice(p.start, p.end); };
const py = process.env.HWPX_COWORK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasMatplotlib = spawnSync(py, ['-c', 'import matplotlib'], { windowsHide: true }).status === 0;

test('imageInfo: PNG·JPEG·GIF·BMP 크기, 그 밖은 null', () => {
  assert.deepEqual(imageInfo(makePng(40, 20)), { ext: 'png', mime: 'image/png', width: 40, height: 20 });
  assert.deepEqual(imageInfo(jpegHead(1600, 900)), { ext: 'jpg', mime: 'image/jpg', width: 1600, height: 900 });
  assert.deepEqual(imageInfo(gifHead(300, 200)), { ext: 'gif', mime: 'image/gif', width: 300, height: 200 });
  assert.deepEqual(imageInfo(bmpHead(64, 48)), { ext: 'bmp', mime: 'image/bmp', width: 64, height: 48 });
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(0), Buffer.from('hello world, not an image')]) assert.equal(imageInfo(bad), null);
});

test('insertPictureAfter: 그림이 없는 문서 — 표준서식(그림 아래 [그림 N] 캡션·번호 종류 그림·가운데), BinData·매니페스트, 원본보다 키우지 않음', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  const TW = sectionTextWidth(d.sections[0]);
  const r = d.insertPictureAfter(0, 0, { data: makePng(400, 200), caption: '그림 3. 연도별 추이' }, { author });
  assert.deepEqual(r, { ref: 's0/p1', captionRef: 's0/p1/n0', binId: 'image1', width: 30000, height: 15000, bodyShift: 1 });
  const re = await reload(d);
  assert.deepEqual(re.figures(), [{ ref: 's0/p1', n: 1, binId: 'image1', width: 30000, height: 15000, caption: { ref: 's0/p1/n0', text: '[그림 ] 연도별 추이' } }]);
  assert.equal(re.text('s0/p1/n0', 'markup'), '[그림 ] {+연도별 추이+}');
  assert.deepEqual(re.changes().filter((c) => c.author === author).map((c) => [c.type, c.ref]), [['Insert', 's0/p1/n0']]);
  const xml = paraXml(re, 's0/p1');
  assert.match(/<hp:pic\b[^>]*>/.exec(xml)[0], /numberingType="PICTURE"/);
  assert.match(xml, /<hp:orgSz width="30000" height="15000"\/><hp:curSz width="30000" height="15000"\/>/);
  assert.match(xml, /<hp:caption side="BOTTOM" fullSz="0" width="8503" gap="850" lastWidth="30000">.*<hp:t>\[그림 <\/hp:t><hp:ctrl><hp:autoNum num="1" numType="PICTURE">/);
  assert.match(xml, /holdAnchorAndSO="1"/);
  // 문단은 바탕글 가운데 정렬이라 바깥 여백으로 가운데 맞출 필요가 없다
  assert.match(xml, /<hp:outMargin left="0" right="0" top="0" bottom="283"\/>/);
  assert.match(re.header.block('paraPr', /^<hp:p\b[^>]*paraPrIDRef="(\d+)"/.exec(xml)[1]), /<hh:align horizontal="CENTER"/);
  assert.equal(re.container.getBytes('BinData/image1.png').length, makePng(400, 200).length);
  assert.match(re.container.getText('Contents/content.hpf'), /<opf:item id="image1" href="BinData\/image1\.png" media-type="image\/png" isEmbeded="1"\/><\/opf:manifest>/);
  // 넓은 그림은 본문 폭으로, 긴 그림은 한 쪽 높이 안으로, width_mm 는 그 폭(본문 폭까지)
  const wide = d.insertPictureAfter(0, 1, { data: makePng(2000, 1000) }, { author });
  assert.deepEqual([wide.width, wide.height, wide.captionRef, wide.binId], [TW, Math.round(TW / 2), null, 'image2']);
  assert.match(/<hp:pic\b[^>]*>/.exec(paraXml(d, wide.ref))[0], /numberingType="NONE"/, '캡션 없는 그림은 번호를 먹지 않는다');
  const tall = d.insertPictureAfter(0, 1, { data: makePng(500, 3000) }, { author });
  assert.ok(tall.height <= 56000 && Math.abs(tall.width / tall.height - 500 / 3000) < 0.01, `${tall.width}x${tall.height}`);
  assert.equal(d.insertPictureAfter(0, 1, { data: makePng(2000, 1000), widthMm: 80 }, { author }).width, Math.round(80 * 7200 / 25.4));
  assert.throws(() => d.insertPictureAfter(0, 0, { data: Buffer.from('not image') }, { author }), (e) => e.code === 'BAD_IMAGE');
});

test('removeUnusedBinary: 그림 문단을 지우면 그림 파일·매니페스트 항목을 거둔다(아직 쓰이면 남긴다)', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  const xml0 = d.sections[0].xml; const hpf0 = d.container.getText('Contents/content.hpf'); const files0 = [...d.container.order];
  const r = d.insertPictureAfter(0, 1, { data: makePng(100, 50), caption: '지울 그림' }, { author });
  assert.equal(d.removeUnusedBinary(r.binId), false, '아직 쓰이는 그림 파일');
  d.removeBodyParagraph(0, 2);
  assert.equal(d.removeUnusedBinary(r.binId), true);
  assert.deepEqual([d.sections[0].xml, d.container.getText('Contents/content.hpf'), d.container.order, d.changes().length], [xml0, hpf0, files0, 4]);
  const re = await reload(d);
  assert.equal(re.figures().length, 0);
});

test('insertPictureAfter: 그림 캡션이 있는 문서 — 본보기 그림의 캡션 꼴·문단 모양·배치를 따르고 자동 번호는 문서 차례', { skip: !hasSample && '2025 표본 없음' }, async () => {
  const d = await HwpxDoc.load(fs.readFileSync(SAMPLE));
  const first = d.figures().find((f) => f.caption);
  const at = Number(first.ref.split('/p')[1]);
  const r = d.insertPictureAfter(0, at, { data: makePng(2000, 1000), caption: '[그림 9] 시험 그림' }, { author });
  const xml = paraXml(d, r.ref);
  const model = paraXml(d, first.ref);
  const attr = (s, re) => (re.exec(s) || [])[1];
  // 문단 모양·배치·바깥 여백·캡션 여는 태그·캡션 문단 모양이 본보기와 같다
  assert.equal(attr(xml, /^<hp:p\b[^>]*paraPrIDRef="(\d+)"/), attr(model, /^<hp:p\b[^>]*paraPrIDRef="(\d+)"/));
  assert.equal(/<hp:pos\b[^>]*\/>/.exec(xml)[0], /<hp:pos\b[^>]*\/>/.exec(model)[0]);
  assert.equal(/<hp:caption\b[^>]*>/.exec(xml)[0], /<hp:caption\b[^>]*>/.exec(model)[0]);
  assert.equal(attr(xml, /<hp:caption\b[\s\S]*?<hp:p\b[^>]*paraPrIDRef="(\d+)"/), attr(model, /<hp:caption\b[\s\S]*?<hp:p\b[^>]*paraPrIDRef="(\d+)"/));
  // 첫 그림 바로 뒤 → 자동 번호 2(문서 첫 새 번호 1부터)
  assert.match(xml, /<hp:t>\[그림 <\/hp:t><hp:ctrl><hp:autoNum num="2" numType="PICTURE">/);
  const re = await reload(d);
  assert.equal(re.figures().find((f) => f.ref === r.ref).caption.text, '[그림 ] 시험 그림');
});

test('insertPictureAfter: rhwp(WASM) 가 그림을 그리고 캡션 자동 번호를 매긴다', async (t) => {
  const core = path.join(here, '..', 'vendor', 'rhwp', 'pkg');
  if (!fs.existsSync(path.join(core, 'rhwp_bg.wasm'))) { t.skip('vendor/rhwp/pkg 없음'); return; }
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import('file:///' + path.join(core, 'rhwp.js').replace(/\\/g, '/'));
  mod.initSync({ module: fs.readFileSync(path.join(core, 'rhwp_bg.wasm')) });
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  const r = d.insertPictureAfter(0, 1, { data: makePng(800, 400), caption: 'rhwp 그림 시험' }, { author });
  const rd = new mod.HwpDocument(new Uint8Array(await d.save()));
  const page = JSON.parse(rd.getPageOfPosition(0, Number(r.ref.split('/p')[1]))).page;
  const svg = rd.renderPageSvg(page);
  assert.match(svg, /<image\b/);
  assert.ok([...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('').includes('[그림1]rhwp그림시험'));
  rd.free?.();
});

test('normChart: 차트 명세 검사', () => {
  const ok = normChart({ type: 'bar', categories: ['가', '나'], series: [{ name: '2025년', values: [3.5, null] }], y_min: 1, y_max: 5, valueLabels: 'last' });
  assert.deepEqual(ok, { type: 'bar', categories: ['가', '나'], series: [{ name: '2025년', values: [3.5, null] }], y_label: null, unit: null, y_min: 1, y_max: 5, value_labels: 'last', decimals: null });
  for (const [bad, re] of [[{ type: 'pie', categories: ['가'], series: [{ values: [1] }] }, /종류/], [{ type: 'bar', categories: ['가', '나'], series: [{ values: [1] }] }, /값 수/],
    [{ type: 'line', categories: ['가'], series: [{ values: ['x'] }] }, /숫자/], [{ type: 'line', categories: ['가'], series: [{ values: [null] }] }, /그릴 값/],
    [{ type: 'bar', categories: ['가'], series: [{ values: [1] }], y_min: 5, y_max: 1 }, /y_min/]]) assert.throws(() => normChart(bad), (e) => e.code === 'BAD_CHART' && re.test(e.message));
});

test('renderChart: 네 종류 모두 폭 2000px PNG', { skip: !hasMatplotlib && 'Python matplotlib 없음' }, async () => {
  const cats = ['수업 전반', '교양교육', '전공교육 구성 및 개설'];
  for (const type of ['bar', 'hbar', 'line', 'stacked_hbar']) {
    const png = await renderChart(normChart({ type, categories: cats, series: [{ name: '2024년', values: [3.9, 4.05, 3.79] }, { name: '2025년', values: [3.87, 4.02, null] }], y_min: type === 'stacked_hbar' ? undefined : 1, y_max: type === 'stacked_hbar' ? undefined : 5 }));
    const info = imageInfo(png);
    assert.equal(info.ext, 'png', type); assert.equal(info.width, 2000, type); assert.ok(info.height >= 400, `${type} ${info.height}`);
  }
});

async function mcp(srv, name, args) {
  const r = await fetch(`${srv.base}/mcp?agent=FigureTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  const text = res.content[0].text;
  return res.isError ? { error: text } : JSON.parse(text);
}

test('그림 제안(MCP propose_figure): 그림 파일·차트·첨부 → 요청 묶음·적용·되돌리기(그림 파일까지 거둠)·잘못된 출처', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '이 내용을 그림으로', route: 'queue', target: { ref: 's0/p1' } } })).request;
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid });
    // 1) 그림 파일(base64) → 첨부로 올라가고 요청에 묶인 제안(제안 메모 없음)
    const p1 = await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p1', caption: '그림 1. 응답률 추이', image_base64: makePng(1600, 800).toString('base64'), file_name: 'chart.jpg', request_id: req.rid });
    assert.equal(p1.type, 'figure'); assert.equal(p1.rid, req.rid); assert.equal(p1.memo, false);
    assert.deepEqual([p1.figure.caption, p1.figure.name, p1.figure.px], ['응답률 추이', 'chart.png', [1600, 800]]);
    const atts = await A(`${D}/attachments`);
    assert.deepEqual(atts.map((a) => [a.aid, a.name, a.kind]), [[p1.figure.aid, 'chart.png', 'image']]);
    // 2) 잘못된 출처 — 첨부를 남기지 않는다
    assert.match((await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p1', image_base64: Buffer.from('nope').toString('base64') })).error, /BAD_IMAGE/);
    assert.match((await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p1', attachment_id: p1.figure.aid, image_base64: makePng(10, 10).toString('base64') })).error, /BAD_FIGURE/);
    assert.match((await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p9', image_base64: makePng(10, 10).toString('base64') })).error, /오류/);
    assert.equal((await A(`${D}/attachments`)).length, 1, '실패한 제안의 첨부는 거둔다');
    // 3) 이미 있는 첨부로(폭 지정)
    const p2 = await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p2', caption: '같은 그림 작게', attachment_id: p1.figure.aid, width_mm: 80 });
    assert.equal(p2.figure.widthMm, 80);
    // 4) 차트 명세 → 서버가 그린 PNG(첨부)
    if (hasMatplotlib) {
      const p3 = await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p0', caption: '만족도 추이', chart: { type: 'line', categories: ['2023년', '2024년', '2025년'], series: [{ name: '전체', values: [3.95, 3.93, 3.91] }], y_min: 3, y_max: 4.5 }, request_id: req.rid });
      assert.equal(p3.figure.chart.type, 'line'); assert.equal(p3.figure.px[0], 2000); assert.equal(p3.figure.name, '만족도 추이.png');
      await A(`${D}/proposals/${p3.pid}/reject`, { method: 'POST' });
    }
    // 고치기: 캡션·폭
    const ed = await A(`${D}/proposals/${p1.pid}`, { method: 'PATCH', body: { figure: { caption: '[그림 2] 응답률 연도별 추이' } } });
    assert.deepEqual([ed.figure.caption, ed.figure.aid], ['응답률 연도별 추이', p1.figure.aid]);
    // 적용 → 문서에 그림·캡션(변경 추적), 뒤 문단의 대기 제안 자리 재매김
    const ap = await A(`${D}/proposals/${p1.pid}/apply`, { method: 'POST' });
    assert.deepEqual([ap.insertedRef, ap.captionRef, ap.binId], ['s0/p2', 's0/p2/n0', 'image1']);
    assert.equal((await A(`${D}/proposals`)).find((p) => p.pid === p2.pid).afterRef, 's0/p3');
    const saved = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(saved.figures().map((f) => [f.ref, f.binId, f.width, f.caption?.text]), [['s0/p2', 'image1', sectionTextWidth(saved.sections[0]), '[그림 ] 응답률 연도별 추이']]);
    assert.ok(saved.container.has('BinData/image1.png'));
    // 작업 기록 메모·제안 목록에 그림 줄
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === req.rid);
    assert.ok(memo, '작업 기록 메모');
    // 되돌리기 → 그림 문단·그림 파일·매니페스트 항목까지 거둔다
    const un = await A(`${D}/proposals/${p1.pid}/undo`, { method: 'POST' });
    assert.equal(un.status, 'undone');
    const back = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual([back.figures().length, back.container.has('BinData/image1.png'), back.container.getText('Contents/content.hpf').includes('id="image1"')], [0, false, false]);
    assert.equal((await A(`${D}/proposals`)).find((p) => p.pid === p2.pid).afterRef, 's0/p2');
    // 수정본에 반영은 안 된다(기준에 바로 적용만)
    const adopt = await A.res(`${D}/proposals/${p2.pid}/adopt`, { method: 'POST', body: {} });
    assert.deepEqual([adopt.status, adopt.data.error], [400, 'BAD_TYPE']);
  } finally { await srv.stop(); }
});
