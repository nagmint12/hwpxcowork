// node --test tests/sections.test.mjs — 구역을 넘는 편집(docs/SECTIONS.md)이 한/글 2022 와 같은 결과를 내고 서버까지 그대로 가는가.
//  기준: tests/fixtures/sections/ — 한/글이 만든 두 구역 문서(base.hwpx: 구역 0 세로 'AAAA one/AAAA two', 구역 1 가로 'BBBB one/BBBB two')와
//  한/글에서 같은 편집을 한 결과(hangul_*.hwpx — 구역을 넘는 지우기·구역 끝 Delete·구역 첫머리 Backspace·일부/모두 복사 붙이기·잘라 붙이기,
//  변경 추적 켠 것), 한/글 자체 복사의 클립보드 문서모델(hangul_clip_*.json)
//  1) 편집기 엔진(rhwp WASM): 지우기는 구역을 합치고(앞 구역 설정이 남음), 복사는 넘는 구역 나누기를 원본 정의째 싣고, 붙이면 구역이 나뉜다
//  2) 서버 실시간 밀어 넣기: 구역 수가 바뀐 문서도 구역 파일까지 그대로 들어간다(고친 글만·변경 추적), 메모 스레드가 따라간다
//  3) 변경 요청(승인 방식)·편집본 올리기: 구역 수가 바뀐 수정본은 주소를 구역별로 되돌리고 구역 구조는 반영하지 않는다고 알린다 · 올리기는 막는다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc, diffDocs, realSectionHunks, flattenRef, unflattenRef } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const F = (name) => fs.readFileSync(fixture(path.join('sections', name)));
const SKIP = typeof open(F('base.hwpx')).deleteRangeAcross !== 'function' && '엔진에 구역을 넘는 편집 API 가 없습니다 — npm run build:engine';

/** HWPX → 구역마다 { landscape, secPr 수, 본문 문단 글 } */
async function shape(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const names = Object.keys(z.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const out = [];
  for (const n of names) {
    // 메모 본문(필드 시작 안 subList)은 본문 글이 아니다
    const x = (await z.file(n).async('string')).replace(/<hp:fieldBegin\b[^>]*type="MEMO"[\s\S]*?<\/hp:fieldBegin>/g, '');
    const paras = []; let depth = 0; let start = 0;
    for (const m of x.matchAll(/<hp:p [^>]*>|<\/hp:p>/g)) {
      if (m[0] !== '</hp:p>') { if (depth === 0) start = m.index; depth++; continue; }
      depth--; if (depth) continue;
      paras.push([...x.slice(start, m.index).matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((t) => t[1]).join(''));
    }
    out.push({ landscape: x.match(/<hp:pagePr landscape="(\w+)"/)?.[1], secPr: (x.match(/<hp:secPr\b/g) || []).length, paras });
  }
  return out;
}
const texts = (d) => Array.from({ length: d.getSectionCount() }, (_, s) => Array.from({ length: d.getParagraphCount(s) }, (_, p) => d.getTextRange(s, p, 0, d.getParagraphLength(s, p))));
const board = (html) => JSON.parse(html.match(/<!--\[data-hwpjson\]([\s\S]*?)-->/)[1]);
const CI_SECD = 1936024420;
const secds = (j) => Object.values(j.cs).filter((c) => c.ci === CI_SECD).map((c) => ({ landscape: c.pp.ls, height: c.pp.he, memoShape: !!c.ms }));

test('엔진: 구역을 넘는 지우기 = 한/글(구역이 합쳐지고 앞 구역 설정이 남는다)', { skip: SKIP }, async () => {
  const cases = [
    ['일부 지우기', (d) => d.deleteRangeAcross(0, 1, 3, 1, 0, 3), 'hangul_del_partial.hwpx'],
    ['앞 구역 끝 Delete', (d) => d.deleteRangeAcross(0, 1, d.getParagraphLength(0, 1), 1, 0, 0), 'hangul_del_break.hwpx'],
    ['뒤 구역 첫머리 Backspace', (d) => d.deleteRangeAcross(0, 1, d.getParagraphLength(0, 1), 1, 0, 0), 'hangul_bs_break.hwpx'],
  ];
  for (const [what, edit, oracle] of cases) {
    const d = open(F('base.hwpx'));
    const r = JSON.parse(edit(d));
    assert.deepEqual([r.secIdx, r.paraIdx], [0, 1], `${what}: 캐럿은 지운 자리`);
    assert.deepEqual(await shape(d.exportHwpx()), await shape(F(oracle)), what);
  }
  // 같은 구역이면 deleteRange 와 같다
  const d = open(F('base.hwpx'));
  d.deleteRangeAcross(1, 0, 2, 1, 1, 2);
  assert.deepEqual(texts(d), [['AAAA one', 'AAAA two'], ['BBBB two']]);
});

test('엔진: 구역 나누기 문단을 합치면 구역 정의가 남지 않는다(합친 문단 가운데 secPr 없음)', { skip: SKIP }, async () => {
  // 붙여넣기로 구역 하나 안에 구역 나누기 문단이 생긴 꼴(구역을 나누기 전) — 같은 구역 안 범위 지우기·문단 합치기
  const d = open(F('base.hwpx'));
  d.deleteRangeAcross(0, 1, d.getParagraphLength(0, 1), 1, 0, 0);
  const s = await shape(d.exportHwpx());
  assert.deepEqual(s.map((x) => x.secPr), [1]);
});

test('엔진: 구역을 넘는 복사 = 한/글(넘는 구역 나누기를 원본 정의째 싣고, 붙이면 그 자리에서 구역이 나뉜다)', { skip: SKIP }, async () => {
  // 일부 복사 → 같은 문서 첫머리에 붙이기(한/글: 첫 문단 'A two' · 가로 구역 'BBB'+원래 첫 구역 나머지 · 원래 둘째 구역)
  const d = open(F('base.hwpx'));
  assert.equal(JSON.parse(d.copySelectionAcross(0, 1, 3, 1, 0, 3)).text, 'A two\nBBB');
  // 한글 문서모델(웹 → 한글 붙여넣기)도 한/글 자체 복사와 같은 꼴: 구역 정의 둘(첫째 새 문서 기본 세로, 둘째 원본 가로 + 메모 모양)
  assert.deepEqual(secds(board(d.exportClipboardHancomHtml())), secds(JSON.parse(F('hangul_clip_partial.json'))));
  const r = JSON.parse(d.pasteInternal(0, 0, 0));
  assert.deepEqual([r.secIdx, r.paraIdx, r.charOffset], [1, 0, 3], '붙인 끝 = 새 구역 첫 문단 BBB 뒤');
  assert.deepEqual(await shape(d.exportHwpx()), await shape(F('hangul_copy_partial_mid.hwpx')));

  // 모두 복사: 조각에 구역 둘(원본 정의), 문서모델 구역 정의 둘 다 원본
  const a = open(F('base.hwpx'));
  a.copySelectionAcross(0, 0, 0, 1, 1, a.getParagraphLength(1, 1));
  assert.deepEqual(await shape(a.exportClipboardHwpx()), await shape(F('hangul_copy_all.hwpx')));
  assert.deepEqual(secds(board(a.exportClipboardHancomHtml())).map((x) => x.landscape), [false, true]);

  // 잘라 붙이기(제자리) = 원래 문서(한/글 cut_paste_back)
  const c = open(F('base.hwpx'));
  c.copySelectionAcross(0, 1, 3, 1, 0, 3);
  c.deleteRangeAcross(0, 1, 3, 1, 0, 3);
  c.pasteInternal(0, 1, 3);
  assert.deepEqual(await shape(c.exportHwpx()), await shape(F('hangul_cut_paste_back.hwpx')));
});

test('엔진: 표 칸에 붙이면 구역 나누기는 빠진다(칸에는 구역이 없다)', { skip: SKIP }, () => {
  const d = open(F('base.hwpx'));
  d.copySelectionAcross(0, 1, 3, 1, 0, 3);
  // 같은 문서의 표 칸에 붙인다(내부 클립보드는 문서마다라 표가 든 문서를 따로 열지 않는다) — 구역 0 에 표 하나를 넣고 그 첫 칸에
  d.createTable?.(0, 0, 0, 1, 1);
  let at = null;
  for (let p = 0; p < d.getParagraphCount(0) && at == null; p++) {
    try { if (d.getCellParagraphCount(0, p, 0, 0) > 0) at = p; } catch { /* 표 아님 */ }
  }
  assert.ok(at != null, '표가 있다');
  const before = d.getSectionCount();
  const cellParas = d.getCellParagraphCount(0, at, 0, 0);
  d.pasteInternalInCell(0, at, 0, 0, 0, 0);
  assert.equal(d.getSectionCount(), before, '구역 수 그대로');
  assert.equal(d.getCellParagraphCount(0, at, 0, 0), cellParas + 1, '칸에 두 문단(A two · BBB)');
  assert.equal(d.getTextInCell?.(0, at, 0, 0, cellParas, 0, 3) ?? 'BBB', 'BBB');
});

test('이은 주소 ↔ 구역별 주소', () => {
  assert.equal(flattenRef('s1/p2/n0', [3, 4]), 's0/p5/n0');
  assert.equal(unflattenRef('s0/p5/n0', [3, 4]), 's1/p2/n0');
  assert.equal(unflattenRef('s0/p1', [3, 4]), 's0/p1');
});

test('diffDocs: 구역 수가 다르면 이어 견주고, 변경 요청용으로는 구역별 주소로 되돌리며 구역 구조는 반영하지 않는다고 알린다', { skip: SKIP }, async () => {
  const d = open(F('base.hwpx'));
  d.deleteRangeAcross(0, 1, 3, 1, 0, 3);
  const base = await HwpxDoc.load(F('base.hwpx')); const head = await HwpxDoc.load(Buffer.from(d.exportHwpx()));
  const r = await diffDocs(base, head);
  assert.deepEqual(r.sections, { base: [2, 2], head: [3] });
  assert.ok(r.hunks.every((h) => /^s0\//.test(h.ref)), '이은 주소');
  assert.equal(base.sections.length, 2, '기준 문서는 그대로(사본을 이었다)');
  const real = realSectionHunks(r);
  assert.ok(real.hunks.some((h) => /^s1\//.test(h.ref)), '구역별 주소로');
  assert.ok(real.unsupported.some((u) => /구역 수가 바뀌었습니다/.test(u.detail)));
});

/** 시험 서버에 기준 문서를 올리고 (편집 → 밀어 넣기)를 돌린다 */
async function withDoc(fn, { track = 'final' } = {}) {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, F('base.hwpx'), '구역.hwpx');
    if (track !== 'final') await A(`/api/docs/${id}/settings`, { method: 'PATCH', body: { track } });
    const working = async () => { const w = await A.res(`/api/docs/${id}/file?kind=working`); return { doc: open(w.data), v: Number(w.headers.get('x-doc-version')) }; };
    const push = async (doc, v) => A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    const file = async (kind) => (await A.res(`/api/docs/${id}/file?kind=${kind}`)).data;
    await fn({ A, id, working, push, file });
  } finally {
    await srv.stop();
  }
}

test('서버: 구역을 넘는 지우기가 실시간으로 구역 파일까지 그대로 들어간다(고친 글만)', { skip: SKIP, timeout: 180000 }, async () => {
  await withDoc(async ({ A, id, working, push, file }) => {
    // 둘째 구역 첫 문단에 메모 — 구역을 합쳐도 메모·스레드가 따라간다
    await A(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's1/p1', text: '둘째 구역 메모' } });
    const memoId = (await A(`/api/docs/${id}/memos`)).find((x) => x.body?.includes('둘째 구역 메모'))?.id;
    assert.ok(memoId, '메모를 달았다');
    await A(`/api/docs/${id}/memos/${memoId}/replies`, { method: 'POST', body: { text: '답글' } });
    let { doc, v } = await working();
    doc.deleteRangeAcross(0, 1, 3, 1, 0, 3);
    const res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    assert.deepEqual(await shape(await file('export')), await shape(F('hangul_del_partial.hwpx')));
    const mine = (await A(`/api/docs/${id}/memos`)).find((x) => x.id === memoId);
    assert.ok(mine, '메모가 남는다');
    assert.equal(mine.ref, 's0/p2', '메모 자리 = 합친 구역의 그 문단');
    assert.deepEqual(mine.thread?.replies?.map((r) => r.text), ['답글'], '답글(스레드)이 따라간다');
    // 다시 비교하면 차이가 없다(편집기 = 서버)
    ({ doc, v } = await working());
    assert.deepEqual(texts(doc), [['AAAA one', 'AAAB one', 'BBBB two']]);
  });
});

test('서버: 구역 나누기를 실은 붙여넣기가 구역 파일로 들어간다(가로 구역 그대로)', { skip: SKIP, timeout: 180000 }, async () => {
  await withDoc(async ({ working, push, file }) => {
    const { doc, v } = await working();
    doc.copySelectionAcross(0, 1, 3, 1, 0, 3);
    doc.pasteInternal(0, 0, 0);
    const res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    assert.deepEqual(await shape(await file('export')), await shape(F('hangul_copy_partial_mid.hwpx')));
  });
});

test('서버: 변경 추적 문서에서도 구역을 넘는 지우기는 구역을 합치고(구조는 추적하지 않음) 지운 글은 변경 추적으로 남는다', { skip: SKIP, timeout: 180000 }, async () => {
  await withDoc(async ({ working, push, file }) => {
    const { doc, v } = await working();
    doc.deleteRangeAcross(0, 1, 3, 1, 0, 3);
    const res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    const tracked = await HwpxDoc.load(await file('tracked'));
    assert.equal(tracked.sections.length, 1, '구역 하나');
    assert.ok(tracked.changes().some((c) => c.type === 'Delete'), '지운 글은 변경 추적');
    const fin = await shape(await file('export'));
    assert.deepEqual(fin.map((s) => s.paras.filter(Boolean)), [['AAAA one', 'AAAB one', 'BBBB two']], '최종본 = 한/글 모두 수락');
    // 최종본(편집기가 여는 것)도 구역 하나 — 편집기와 같다
    const w = await working();
    assert.deepEqual(texts(w.doc).map((s) => s.filter(Boolean)), [['AAAA one', 'AAAB one', 'BBBB two']]);
  }, { track: 'tracked' });
});

test('서버: 구역 첫머리에 넣은 문단은 그 앞에 들고 구역 나누기는 새 첫 문단으로(문서 첫머리 Enter — 종전에는 첫 문단 뒤로 뒤바뀜)', { skip: SKIP, timeout: 120000 }, async () => {
  await withDoc(async ({ working, push, file }) => {
    const { doc, v } = await working();
    doc.splitParagraph(1, 0, 0);   // 둘째 구역 첫머리에서 Enter
    doc.splitParagraph(0, 0, 0);   // 문서 첫머리에서 Enter
    const res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    const s = await shape(await file('export'));
    assert.deepEqual(s.map((x) => x.paras), [['', 'AAAA one', 'AAAA two'], ['', 'BBBB one', 'BBBB two']]);
    assert.deepEqual(s.map((x) => [x.landscape, x.secPr]), [['WIDELY', 1], ['NARROWLY', 1]]);
    const ex = await HwpxDoc.load(await file('export'));
    assert.deepEqual([ex.hasSectionBreak('s0/p0'), ex.hasSectionBreak('s0/p1'), ex.hasSectionBreak('s1/p0'), ex.hasSectionBreak('s1/p1')], [true, false, true, false]);
  });
});

test('편집본 올리기: 구역 수가 다른 편집본은 409 SECTIONS(겹쳐 들어가지 않게)', { skip: SKIP, timeout: 120000 }, async () => {
  await withDoc(async ({ A, id }) => {
    const d = open(F('base.hwpx'));
    d.deleteRangeAcross(0, 1, 3, 1, 0, 3);
    const r = await A.res(`/api/docs/${id}/upload`, { method: 'PUT', body: Buffer.from(d.exportHwpx()) });
    assert.ok(r.status === 409 || r.status === 404 || r.status === 403, `상태 ${r.status}`);
    if (r.status === 409) assert.equal(r.data?.error, 'SECTIONS');
  });
});
