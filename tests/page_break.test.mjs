// node --test tests/page_break.test.mjs — 편집기 쪽 나누기(Ctrl+Enter)·단 나누기가 한/글처럼 동작하고 공유 문서·한글로 저장까지 가는가.
//  0) 편집기 엔진(rhwp WASM): 한/글 COM 실측 규칙(vendor/README.md 29) — 문단 처음은 그 문단에, 문단 끝은 다음 문단에 걸고(빈 문단 없음)
//     글 가운데서만 가른다 · 이미 나누기가 있는 자리·구역 첫 문단은 가른다 · 나누기만 지우기(문단은 합치지 않음) · 쪽 수가 한/글 실측과 같다
//  1) 서버 엔진 diffDocs: <hp:p pageBreak/columnBreak> 도 서식으로 본다 — 문단 앞 나누기 = format 덩어리('쪽 나누기 넣음'), 문단을 가른 나누기 =
//     넣은 문단 + formatting 교체, 나누기 지움 = '쪽 나누기 지움' · copyFormattingFrom 이 옮긴다 · 손대지 않은 편집기 내보내기는 덩어리 없음
//  2) 실시간 밀어 넣기(PUT /live) → 한글로 저장(kind=export)에 편집기와 같은 문단에 쪽 나누기 · 지운 나누기도 실린다
//  3) 변경 요청(PUT /drafts/mine → merge)도 같다
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, root } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const FX = path.join(root, 'testdata', '매크로테스트용_저장.hwpx');
const SKIP = !fs.existsSync(FX) && 'testdata 없음';
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const bodyRefs = (doc) => doc.paragraphs().filter((p) => /^s\d+\/p\d+$/.test(p.ref));
/** 나누기가 걸린 본문 문단 → [ref, 글 앞 12자, 'page'|'column'] */
async function breaks(bytes) {
  const doc = bytes instanceof HwpxDoc ? bytes : await HwpxDoc.load(bytes);
  return bodyRefs(doc).flatMap((p) => {
    const f = doc.inspectFormatting(p.ref);
    return [f.pageBreak && 'page', f.columnBreak && 'column'].filter(Boolean).map((k) => [p.ref, p.text.slice(0, 12), k]);
  });
}
/** 편집기에서 Ctrl+Enter 셋(뒤 문단부터 — 앞 번호가 흔들리지 않게): p27 문단 앞 · p14 문단 끝 · p8 글 가운데 */
function breakInEditor(bytes, live = {}) {
  const doc = open(bytes);
  doc.insertPageBreak(0, 27, 0);
  doc.insertPageBreak(0, 14, doc.getParagraphLength(0, 14));
  doc.insertPageBreak(0, 8, 6);
  live.doc = doc;
  return Buffer.from(doc.exportHwpx());
}
/** section0.xml 의 n번째(0부터) pageBreak="1" 문단을 "0" 으로(나누기 지운 편집기 내보내기 흉내) */
async function dropBreak(bytes, n) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('Contents/section0.xml').async('string');
  let k = -1;
  const out = xml.replace(/(<hp:p\b[^>]*?\s)pageBreak="1"/g, (m, head) => (++k === n ? `${head}pageBreak="0"` : m));
  assert.notEqual(out, xml);
  zip.file('Contents/section0.xml', out);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const pageOf = (d, p) => JSON.parse(d.getCursorRect(0, p, 0)).pageIndex;
const brk = (d, p) => JSON.parse(d.getParagraphBreak(0, p));
const end = (d, p) => d.getParagraphLength(0, p);

test('편집기 엔진: Ctrl+Enter 는 한/글처럼(문단 처음·끝은 가르지 않음) · 나누기만 지우기 · 쪽 수가 한/글 실측과 같다', { skip: SKIP }, () => {
  const bytes = fs.readFileSync(FX);   // 33문단 7쪽(한/글)
  const cases = [
    // [조작, 캐럿 {paraIdx}, 문단 수, 나누기 문단, 한/글 쪽 수] — 한/글 COM BreakPage 실측(2026-10-29)
    ['p8 처음', (d) => d.insertPageBreak(0, 8, 0), 8, 33, [8], 7],
    ['p17 끝 → 다음 문단에', (d) => d.insertPageBreak(0, 17, end(d, 17)), 18, 33, [18], 7],
    ['p26 글 가운데', (d) => d.insertPageBreak(0, 26, 82), 27, 34, [27], 7],
    ['셋', (d) => { d.insertPageBreak(0, 26, 82); d.insertPageBreak(0, 17, end(d, 17)); return d.insertPageBreak(0, 8, 0); }, 8, 34, [8, 18, 27], 8],
    ['같은 문단 처음 두 번 → 둘째는 가름', (d) => { d.insertPageBreak(0, 8, 0); return d.insertPageBreak(0, 8, 0); }, 9, 34, [8, 9], 8],
    ['같은 문단 끝 두 번 → 둘째는 빈 문단', (d) => { d.insertPageBreak(0, 17, end(d, 17)); return d.insertPageBreak(0, 17, end(d, 17)); }, 18, 34, [18, 19], 8],
    ['마지막 문단 끝 → 빈 문단', (d) => d.insertPageBreak(0, 32, end(d, 32)), 33, 34, [33], 8],
    ['구역 첫 문단 처음 → 가름', (d) => d.insertPageBreak(0, 0, 0), 1, 34, [1], 8],
  ];
  for (const [name, op, caret, paras, at, hangulPages] of cases) {
    const d = open(bytes);
    const r = JSON.parse(op(d));
    assert.equal(r.paraIdx, caret, `${name}: 캐럿 문단`);
    assert.equal(d.getParagraphCount(0), paras, `${name}: 문단 수`);
    const got = []; for (let p = 0; p < paras; p++) if (brk(d, p).page) got.push(p);
    assert.deepEqual(got, at, `${name}: 나누기 문단`);
    for (const p of at) assert.ok(pageOf(d, p) > pageOf(d, p - 1), `${name}: p${p} 는 새 쪽에서 시작`);
    assert.equal(d.pageCount(), hangulPages, `${name}: 쪽 수(한/글 ${hangulPages})`);
  }
  // 나누기만 지운다(문단은 합치지 않음) — 지우면 원래 7쪽(한/글: 앞 문단 끝 Delete 실측)
  for (const [name, op, k, paras] of [['p8 처음', (d) => d.insertPageBreak(0, 8, 0), 8, 33], ['p17 끝', (d) => d.insertPageBreak(0, 17, end(d, 17)), 18, 33], ['p26 가운데', (d) => d.insertPageBreak(0, 26, 82), 27, 34]]) {
    const d = open(bytes); op(d);
    assert.deepEqual(JSON.parse(d.clearParagraphBreak(0, k)), { ok: true, changed: true });
    assert.deepEqual(brk(d, k), { page: false, column: false, section: false }, name);
    assert.equal(d.getParagraphCount(0), paras, `${name}: 합치지 않는다`);
    assert.equal(d.pageCount(), 7, `${name}: 지운 뒤 7쪽`);
    assert.deepEqual(JSON.parse(d.clearParagraphBreak(0, k)), { ok: true, changed: false });
  }
  // 단 나누기도 같은 규칙(1단 문서라 쪽이 나뉜다)
  {
    const d = open(bytes);
    assert.equal(JSON.parse(d.insertColumnBreak(0, 8, 0)).paraIdx, 8);
    assert.deepEqual(brk(d, 8), { page: false, column: true, section: false });
    assert.equal(d.getParagraphCount(0), 33);
  }
  // 나누기가 많은 표본 보고서(479문단 59쪽 — 한/글 실측 쪽 수)
  const sample = fs.readFileSync(path.join(root, 'tests', 'samples', '2025년_전체종합보고서.hwpx'));
  for (const [name, op, pages] of [['p100 처음', (d) => d.insertPageBreak(0, 100, 0), 60], ['p102 가운데', (d) => d.insertPageBreak(0, 102, 40), 59],
    ['p143 끝', (d) => d.insertPageBreak(0, 143, end(d, 143)), 60], ['p146 나누기 지움', (d) => d.clearParagraphBreak(0, 146), 59]]) {
    const d = open(sample); op(d);
    assert.equal(d.pageCount(), pages, `표본 ${name}: 쪽 수(한/글 ${pages})`);
  }
});

test('서버 diffDocs: 쪽·단 나누기도 서식 — 넣음·가름·지움 덩어리, copyFormattingFrom 이 옮긴다, 손대지 않은 내보내기는 덩어리 없음', { skip: SKIP }, async () => {
  const bytes = fs.readFileSync(FX);
  const base = await HwpxDoc.load(bytes);
  assert.deepEqual(await breaks(base), []);
  // 문단 앞(글자 0)에서: 그 문단에 나누기만 건다(한/글) — 글이 같아 format 덩어리 하나
  {
    const d = open(bytes); d.insertPageBreak(0, 2, 0);
    const r = await diffDocs(base, Buffer.from(d.exportHwpx()));
    assert.deepEqual(r.hunks.map((h) => [h.type, h.ref, h.formatSummary ?? '']), [['format', 's0/p2', '쪽 나누기 넣음']]);
  }
  // 글 가운데서: 앞 조각은 넣은 문단, 나누기가 걸린 뒤 조각은 짝 문단의 글 교체 — 서식(나누기)도 옮기도록 formatting
  {
    const d = open(bytes); d.insertPageBreak(0, 2, 3);
    const r = await diffDocs(base, Buffer.from(d.exportHwpx()));
    assert.deepEqual(r.hunks.map((h) => [h.type, h.ref, h.newText.slice(0, 4), h.formatting]), [['insert', 's0/p1', '기본지', true], ['replace', 's0/p2', '표 분석', true]]);
  }
  // 단 나누기(Ctrl+Shift+Enter)
  {
    const d = open(bytes); d.insertColumnBreak(0, 3, 0);
    const head = await HwpxDoc.load(Buffer.from(d.exportHwpx()));
    assert.deepEqual((await breaks(head)).map((x) => x[2]), ['column']);
    const r = await diffDocs(base, head);
    assert.deepEqual(r.hunks.filter((h) => h.type === 'format').map((h) => h.formatSummary), ['단 나누기 넣음']);
    const ref = r.hunks.find((h) => h.type === 'format').headRef;
    base.copyFormattingFrom(head, ref, 's0/p3');
    assert.equal(base.inspectFormatting('s0/p3').columnBreak, true);
    assert.equal(base.formattingFingerprint('s0/p3'), head.formattingFingerprint(ref));
  }
  // 지움: 나누기가 걸린 문서(편집기 내보내기)에서 그 나누기만 뺀 것 → '쪽 나누기 지움', 옮기면 지문이 같아진다
  {
    const d = open(bytes); d.insertPageBreak(0, 2, 0);
    const withBreak = Buffer.from(d.exportHwpx());
    const b = await HwpxDoc.load(withBreak); const h = await HwpxDoc.load(await dropBreak(withBreak, 0));
    const r = await diffDocs(b, h);
    assert.deepEqual(r.hunks.map((x) => [x.type, x.ref, x.formatSummary]), [['format', 's0/p2', '쪽 나누기 지움']]);
    b.copyFormattingFrom(h, 's0/p2', 's0/p2');
    assert.equal(b.inspectFormatting('s0/p2').pageBreak, false);
    assert.equal(b.formattingFingerprint('s0/p2'), h.formattingFingerprint('s0/p2'));
    assert.match(b.sections[0].xml, /<hp:p\b[^>]*\spageBreak="0"[^>]*>(?:(?!<hp:p\b)[\s\S])*?기본지표 분석에서는/);
  }
  // 나누기가 많은 문서(54곳)를 편집기에서 손대지 않고 내보내면 덩어리가 없다(나누기를 잃거나 더하지 않는다)
  const sample = fs.readFileSync(path.join(root, 'tests', 'samples', '2025년_전체종합보고서.hwpx'));
  assert.ok((await breaks(sample)).length > 10);
  assert.deepEqual((await diffDocs(await HwpxDoc.load(sample), Buffer.from(open(sample).exportHwpx()))).hunks, []);
});

test('실시간 밀어 넣기·변경 요청 반영 → 한글로 저장에 편집기에서 넣고 지운 쪽 나누기가 실린다', { skip: SKIP, timeout: 120000 }, async (t) => {
  const bytes = fs.readFileSync(FX);
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');

  // 실시간(기본 설정)
  {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '쪽나누기.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const live = {};
    const head = breakInEditor(w.data, live);
    const want = await breaks(head);
    assert.equal(want.length, 3);
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: head });
    assert.equal(r.clean, true, '서버 문서 = 보낸 문서(나누기까지)');
    assert.ok(r.formatVersion, '서식 커밋 — 다른 창은 다시 연다');
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    assert.equal(ex.status, 200);
    assert.deepEqual(await breaks(ex.data), want);
    // 다른 창(다시 여는 편집기)이 여는 서버 작업본도 보낸 편집기와 같은 쪽 배치 — 서버는 나누기 문단의 줄 캐시만 지우고
    // 뒤 문단의 옛 줄 캐시는 그대로 두지만 편집기 엔진이 나누기 문단부터 다시 조판한다
    const sent = live.doc; const reopened = open((await A.res(`/api/docs/${id}/file?kind=working`)).data);
    assert.equal(reopened.pageCount(), sent.pageCount());
    for (let p = 0; p < sent.getParagraphCount(0); p++) assert.equal(pageOf(reopened, p), pageOf(sent, p), `p${p} 쪽`);
    // 같은 것을 다시 보내면 바꿀 것이 없다
    const again = await A(`/api/docs/${id}/live?base=${r.version}`, { method: 'PUT', body: head });
    assert.equal(again.version, r.version); assert.equal(again.clean, true);
    // 둘째 나누기를 지운 문서를 보내면 그 나누기만 빠진다
    const r2 = await A(`/api/docs/${id}/live?base=${r.version}`, { method: 'PUT', body: await dropBreak(head, 1) });
    assert.equal(r2.clean, true);
    assert.deepEqual(await breaks((await A.res(`/api/docs/${id}/file?kind=export`)).data), [want[0], want[2]]);
  }
  // 변경 요청(수정본 저장 → 반영)
  {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '쪽나누기_변경요청.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const head = breakInEditor(w.data);
    const saved = await A(`/api/docs/${id}/drafts/mine?base=${v}`, { method: 'PUT', body: head });
    const cid = saved.cr?.cid;
    assert.ok(cid, '변경 요청이 생긴다');
    const view = await A(`/api/docs/${id}/change-requests/${cid}`);
    assert.ok(view.hunks.some((h) => h.type === 'format' && h.formatSummary === '쪽 나누기 넣음'));
    await A(`/api/docs/${id}/change-requests/${cid}/merge`, { method: 'POST' });
    assert.deepEqual(await breaks((await A.res(`/api/docs/${id}/file?kind=export`)).data), await breaks(head));
  }
});
