// web/refmap.js 시험: rhwp(WASM) 위치 ↔ 엔진 ref 지도가 모든 표 셀·캡션에서 맞는지, 실제 hitTest 로 왕복되는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
import { buildRefMap, alignOffsets, lcsPairs, hitTestPoint, CAPTION_CELL } from '../web/refmap.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
globalThis.measureTextWidth = (font, text) => text.length * 10; // 레이아웃용 폭 측정 스텁
const mod = await import('file:///' + path.join(root, 'vendor/rhwp/pkg/rhwp.js').replace(/\\/g, '/'));
const wasm = fs.readFileSync(path.join(root, 'vendor/rhwp/pkg/rhwp_bg.wasm'));
if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });

const SMALL = path.resolve(root, 'tests', 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx');
const BIG = path.resolve(root, 'tests', 'samples', '2025년_전체종합보고서.hwpx');

async function open(file) {
  const eng = await HwpxDoc.load(fs.readFileSync(file));
  const flat = await eng.flattened();
  const doc = new mod.HwpDocument(new Uint8Array(await flat.save())); // 브라우저가 받는 작업본(최종본)과 같은 것
  const paras = flat.paragraphs({ view: 'final', nested: true });
  return { eng: flat, doc, paras, map: buildRefMap(doc, paras) };
}

const runCache = new WeakMap();
function runsOf(doc, page) {
  let m = runCache.get(doc); if (!m) runCache.set(doc, (m = new Map()));
  if (!m.has(page)) m.set(page, JSON.parse(doc.getPageTextLayout(page)).runs);
  return m.get(page);
}
/** ref 의 offset 자리(글자 가운데)를 화면과 같은 방식(hitTestPoint)으로 다시 찾았을 때 같은 ref·offset 이 나오는지.
 *  raw=true 면 rhwp hitTest 만 쓴다(참고용). */
function hitRoundTrip(doc, map, ref, offset, raw = false) {
  const c = map.caret(ref, offset); if (!c) return { ok: false, why: 'no caret' };
  const x = c.x + 0.5; const y = c.y + c.height / 2;
  const hit = raw ? JSON.parse(doc.hitTest(c.pageIndex, x, y)) : hitTestPoint(doc, c.pageIndex, x, y, runsOf(doc, c.pageIndex));
  const back = map.posToRef(hit);
  return { ok: !!back && back.ref === ref && back.offset === offset, back, hit };
}

test('alignOffsets: 캡션 자동 번호 자리(글자 하나 더) 정렬', () => {
  const r = '[표  ] 연도별'; const e = '[표 ] 연도별';
  const { a2b, b2a } = alignOffsets(r, e);
  assert.equal(a2b[0], 0); assert.equal(a2b[Array.from(r).length], Array.from(e).length);
  assert.equal(b2a[Array.from(e).indexOf('연')], Array.from(r).indexOf('연'));
  assert.equal(a2b[Array.from(r).indexOf('연')], Array.from(e).indexOf('연'));
  for (let i = 1; i < a2b.length; i++) assert.ok(a2b[i] >= a2b[i - 1], '단조 증가');
});

test('lcsPairs: 한쪽에만 있는 항목은 건너뛴다', () => {
  const p = lcsPairs(['a', 'x', 'b', 'c'], ['a', 'b', 'y', 'c'], (x, y) => x === y);
  assert.deepEqual(p, [[0, 0], [2, 1], [3, 3]]);
});

test('경영대학 표본: 본문·모든 셀·캡션이 짝지어지고 왕복된다', { skip: !fs.existsSync(SMALL) && '표본 없음' }, async () => {
  const { doc, paras, map, eng } = await open(SMALL);
  const st = map.stats();
  const body = paras.filter((p) => p.where === '본문'); const nested = paras.filter((p) => p.where !== '본문' && p.where !== '메모');
  assert.equal(st.body, body.length, '본문 문단 수');
  assert.deepEqual(st.unmatchedEngine, [], '짝 없는 엔진 중첩 문단');
  assert.deepEqual(st.unmatchedRhwp, [], '짝 없는 rhwp 셀 문단');
  assert.equal(st.mapped, nested.length, `중첩 ${nested.length}개 모두`);
  let hits = 0; let caps = 0;
  for (const p of paras) {
    if (p.where === '메모') continue;
    const pos = map.refToPos(p.ref); assert.ok(pos, `refToPos ${p.ref}`);
    // 구조 왕복: pos → hit 모양 → ref
    const fake = pos.parentPara == null ? { sectionIndex: pos.sec, paragraphIndex: pos.para, charOffset: 0 }
      : { sectionIndex: pos.sec, paragraphIndex: pos.cellParaIdx, charOffset: 0, parentParaIndex: pos.parentPara, controlIndex: pos.controlIdx, cellIndex: pos.cellIdx, cellParaIndex: pos.cellParaIdx, cellPath: pos.cellPath };
    assert.equal(map.posToRef(fake).ref, p.ref, `posToRef(refToPos(${p.ref}))`);
    if (pos.cellIdx === CAPTION_CELL) caps++;
    // 실제 hitTest 왕복(글이 있는 문단: 끝에서 하나 앞 글자)
    const len = map.length(p.ref);
    if (len > 1) {
      const off = len - 1;
      const r = hitRoundTrip(doc, map, p.ref, off);
      assert.ok(r.ok, `hitTest 왕복 ${p.ref}@${off}: ${JSON.stringify(r.back)} ${JSON.stringify(r.hit)}`);
      const rects = map.rects(p.ref, 0, len); assert.ok(rects.length > 0, `사각형 ${p.ref}`);
      hits++;
    }
  }
  assert.ok(caps >= 5, `캡션 ${caps}개`);
  // 엔진이 셀 주소(cell)를 주면 rhwp getCellInfo 의 행·열과 같아야 한다(v2 엔진)
  const withCell = paras.filter((p) => p.cell);
  if (withCell.length) {
    for (const p of withCell) {
      const pos = map.refToPos(p.ref);
      const info = JSON.parse(doc.getCellInfo(pos.sec, pos.parentPara, pos.controlIdx, pos.cellIdx));
      assert.equal(`${info.row},${info.col}`, `${p.cell.row},${p.cell.col}`, `셀 주소 ${p.ref}`);
    }
    assert.ok(paras.filter((p) => /\/n0$/.test(p.ref) && p.where === '표').every((p) => p.cell === null), '캡션은 cell=null');
  }
  assert.ok(hits > 100, `hitTest 왕복 ${hits}건`);
  // 캡션 offset: 엔진 '[표 ] 연도별…' 의 '연' 자리가 rhwp 에서도 '연'
  const cap = paras.find((p) => p.ref === 's0/p3/n0');
  const at = Array.from(cap.text).indexOf('연');
  const rp = map.refToPos('s0/p3/n0');
  const rtext = doc.getTextInCell(0, rp.parentPara, rp.controlIdx, rp.cellIdx, rp.cellParaIdx, 0, 200);
  assert.equal(Array.from(rtext)[map.toRhwp('s0/p3/n0', at)], '연');
  // 여러 문단 선택 사각형(본문 0→2)
  assert.ok(map.rects('s0/p0', 2, 4, 's0/p2').length >= 2, '여러 문단 사각형');
  assert.deepEqual(map.refsBetween('s0/p0', 's0/p2'), ['s0/p0', 's0/p1', 's0/p2']);
  assert.equal(map.container('s0/p3/n8'), map.container('s0/p3/n8'));
  assert.ok(map.isCell('s0/p3/n8') && !map.isCell('s0/p3/n0') && !map.isCell('s0/p2'), 'isCell');
  void eng;
});

test('큰 보고서: 표 셀·그림 캡션 표본 왕복', { skip: !fs.existsSync(BIG) && '표본 없음', timeout: 600000 }, async () => {
  const t0 = Date.now();
  const { doc, paras, map } = await open(BIG);
  const ms = Date.now() - t0;
  const st = map.stats();
  const nested = paras.filter((p) => p.where !== '본문' && p.where !== '메모');
  const expectMissing = nested.filter((p) => p.where === '꼬리말' || p.where === '머리말').map((p) => p.ref);
  assert.deepEqual(st.unmatchedEngine.filter((r) => !expectMissing.includes(r)), [], '표·그림 중첩 문단은 모두 짝');
  assert.deepEqual(st.unmatchedRhwp, [], '짝 없는 rhwp 셀 문단');
  console.log(`  큰 보고서: 본문 ${st.body}, 중첩 ${st.mapped}/${nested.length}(머리말·꼬리말 ${expectMissing.length} 제외) 열기+지도 ${ms}ms`);
  // 표본: 표 문단을 7개 중 하나, 그림 캡션 전부
  const parents = [...new Set(paras.filter((p) => p.where === '표').map((p) => map.bodyRef(p.ref)))];
  const pick = new Set(parents.filter((_, i) => i % 7 === 0));
  let n = 0; let rawOk = 0;
  for (const p of paras) {
    if (!(p.where === '그림' || (p.where === '표' && pick.has(map.bodyRef(p.ref))))) continue;
    const len = map.length(p.ref); if (len < 2) continue;
    const r = hitRoundTrip(doc, map, p.ref, len - 1);
    assert.ok(r.ok, `hitTest 왕복 ${p.ref}: ${JSON.stringify(r.back)}`);
    if (hitRoundTrip(doc, map, p.ref, len - 1, true).ok) rawOk++;
    n++;
  }
  assert.ok(n > 200, `왕복 ${n}건`);
  console.log(`  표·그림 왕복 ${n}건 (rhwp hitTest 만 썼을 때 ${rawOk}건 일치 — 겹친 캡션 등은 글자 상자 판정으로 보정)`);
  // 본문 표본
  for (const p of paras.filter((x) => x.where === '본문' && x.length > 3).filter((_, i) => i % 15 === 0)) {
    const r = hitRoundTrip(doc, map, p.ref, 1); assert.ok(r.ok, `본문 왕복 ${p.ref}: ${JSON.stringify(r.back)}`);
  }
});
