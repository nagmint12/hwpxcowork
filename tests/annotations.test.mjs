// web/annotations.js 시험: 범위 계산(memoRange·findRange·proposalRange·covers·changeRange)이 v0.2 검토 보기(review.js)와 같은지,
// paragraphGeo 묶음(본문·표 칸), buildAnnotations 모양(V3_SPEC §1.3), colorForUser. DOM·Vue 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  paragraphGeo, memoRange, findRange, proposalRange, changeRange, proposalChanges, covers,
  colorForUser, PERSON_COLORS, ME_COLOR, buildAnnotations, proposalLabel,
} from '../web/annotations.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SMALL = `${root}/tests/samples/경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx`;
const FIX = `${root}/tests/fixtures/tool_memo_tracked.hwpx`;
const cpLen = (s) => Array.from(String(s ?? '')).length;
// 엔진은 실제 문서를 쓰는 시험에서만 읽는다(범위 계산 시험이 엔진 상태에 묶이지 않게)
const loadDoc = async (file) => (await import('../engine/doc.js')).HwpxDoc.load(fs.readFileSync(file));

// ───────── v0.2 원본(backups/v0.2.0_2026-10-22/web/review.js 의 범위 계산을 그대로 옮김: map = refmap, d = store) ─────────
function v2Ranges(map, d) {
  const len = (ref_) => (map ? map.length(ref_) : cpLen(d.textOf(ref_)));
  function memoRange(m) {
    const end = m.end != null ? m.end : len(m.endRef && map?.container(m.endRef) === map?.container(m.ref) ? m.endRef : m.ref);
    const endRef = m.end == null && m.endRef && map?.container(m.endRef) === map?.container(m.ref) ? m.endRef : m.ref;
    return { ref: m.ref, start: m.start || 0, end, endRef };
  }
  function findRange(ref_, find, occ = 1) {
    const t = d.textOf(ref_); if (!find) return { ref: ref_, start: cpLen(t), end: cpLen(t), endRef: ref_, point: true };
    let at = -1; let from = 0; for (let k = 0; k < (occ || 1); k++) { at = t.indexOf(find, from); if (at < 0) break; from = at + 1; }
    if (at < 0) return null; const s = cpLen(t.slice(0, at)); return { ref: ref_, start: s, end: s + cpLen(find), endRef: ref_ };
  }
  function proposalRange(p, memosById) {
    if ((p.type || 'replace') !== 'replace') return null;
    if (p.memoId && memosById.has(p.memoId)) return memoRange(memosById.get(p.memoId));
    if (p.start != null && p.end != null && p.status === 'pending') return { ref: p.ref, start: p.start, end: p.end, endRef: p.ref };
    return findRange(p.ref, p.find, p.occurrence);
  }
  const covers = (rg, ref_, off) => {
    if (!rg || !map) return false;
    if (rg.ref === rg.endRef) return ref_ === rg.ref && off >= rg.start && off <= rg.end;
    const refs = map.refsBetween(rg.ref, rg.endRef); const i = refs.indexOf(ref_); if (i < 0) return false;
    if (i === 0) return off >= rg.start; if (i === refs.length - 1) return off <= rg.end; return true;
  };
  // rebuildOverlays: 변경 고리의 삽입·삭제 범위, 적용된 제안의 변경과 그 범위
  const insertR = (c) => ({ ref: c.ref, start: c.start, end: c.end, endRef: c.ref });
  const deleteR = (c) => { const at = c.start ?? 0; return { ref: c.ref, start: Math.max(0, at - 1), end: at + 1, endRef: c.ref }; };
  const appliedR = (c) => (c.type === 'Insert' && c.end != null ? { ref: c.ref, start: c.start, end: c.end, endRef: c.ref } : { ref: c.ref, start: Math.max(0, (c.start ?? 0) - 1), end: (c.start ?? 0) + 1, endRef: c.ref });
  const appliedChanges = (p) => d.s.changes.filter((c) => (p.changeIds || []).map(Number).includes(Number(c.id)));
  return { memoRange, findRange, proposalRange, covers, insertR, deleteR, appliedR, appliedChanges };
}
/** review.js 의 새 이음과 같은 모양: 지도(map)로 geo 를 주고 annotations.js 를 부른다 */
function wired(map, d) {
  const len = (ref_) => (map ? map.length(ref_) : cpLen(d.textOf(ref_)));
  const geo = { textOf: d.textOf, length: len, container: (ref_) => map?.container(ref_), refsBetween: (a, b) => map.refsBetween(a, b) };
  return {
    memoRange: (m) => memoRange(m, geo), findRange: (r, f, o) => findRange(r, f, o, geo),
    proposalRange: (p, mm) => proposalRange(p, mm, geo), covers: (rg, r, o) => !!map && covers(rg, r, o, geo),
  };
}

// ───────── 시험 자료: 본문 두 구역 + 표(캡션·칸, 한 칸에 두 문단) ─────────
const cell = (row, col) => ({ table: 's0/p3#t0', row, col, rowSpan: 1, colSpan: 1 });
const PARAS = [
  { ref: 's0/p0', text: '첫째 문단입니다. 😀 이모지와 한글이 섞인 글.' },
  { ref: 's0/p1', text: '둘째 문단: 응답자 수 응답자 수 응답자 수' },
  { ref: 's0/p2', text: '' },
  { ref: 's0/p3', text: '표 문단' },
  { ref: 's0/p3/n0', text: '[표 ] 연도별 응답자 수(n)', parent: 's0/p3', container: 'hp:tbl', cell: null },
  { ref: 's0/p3/n1', text: '구분', parent: 's0/p3', container: 'hp:tbl', cell: cell(0, 0) },
  { ref: 's0/p3/n2', text: '2021년', parent: 's0/p3', container: 'hp:tbl', cell: cell(0, 1) },
  { ref: 's0/p3/n3', text: '칸 둘째 줄', parent: 's0/p3', container: 'hp:tbl', cell: cell(0, 1) },
  { ref: 's0/p3/n4', text: '268', parent: 's0/p3', container: 'hp:tbl', cell: cell(1, 1) },
  { ref: 's0/p4', text: 'aaaa 겹치는 찾기 aaa' },
  { ref: 's0/p5', text: '마지막 문단 🎉🎉 끝' },
  { ref: 's1/p0', text: '둘째 구역 문단' },
  { ref: 's1/p1', text: '둘째 구역 다음 문단' },
];
const GEO = paragraphGeo(PARAS);
const REFS = [...PARAS.map((p) => p.ref), 's9/p9'];
const storeOf = (paras, changes = []) => { const m = new Map(paras.map((p) => [p.ref, p])); return { textOf: (ref) => m.get(ref)?.text ?? '', s: { changes } }; };

// 결정적 난수(mulberry32)
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const int = (r, n) => Math.floor(r() * n);
function randFind(r, ref) {
  const t = Array.from(GEO.textOf(ref)); const a = int(r, t.length + 1); const b = a + int(r, 4);
  return pick(r, [undefined, null, '', '없는 글', t.slice(a, b).join(''), t.slice(a, a + 1).join(''), 'aa', '응답자 수']);
}
function randMemo(r, i) {
  const ref = pick(r, REFS); const L = GEO.length(ref);
  return { id: `m${i}`, ref, start: pick(r, [undefined, null, 0, int(r, L + 1)]), end: pick(r, [null, undefined, int(r, L + 1)]), endRef: pick(r, [null, undefined, '', ref, pick(r, REFS), pick(r, REFS)]) };
}

// ───────── paragraphGeo ─────────

test('paragraphGeo: 본문은 구역별, 표 칸은 칸별 묶음, 사이 문단은 문서 순서', () => {
  const k = (ref) => GEO.container(ref);
  assert.equal(k('s0/p0'), k('s0/p5')); assert.notEqual(k('s0/p0'), k('s1/p0'));
  assert.equal(k('s0/p3/n2'), k('s0/p3/n3'), '한 칸의 두 문단');
  assert.notEqual(k('s0/p3/n1'), k('s0/p3/n2')); assert.notEqual(k('s0/p3/n0'), k('s0/p3/n1'), '캡션은 칸과 다른 묶음');
  assert.notEqual(k('s0/p3'), k('s0/p3/n1')); assert.equal(k('s9/p9'), null);
  assert.deepEqual(GEO.refsBetween('s0/p1', 's0/p4'), ['s0/p1', 's0/p2', 's0/p3', 's0/p4'], '중첩 문단은 본문 사이에 끼지 않는다');
  assert.deepEqual(GEO.refsBetween('s0/p4', 's0/p1'), ['s0/p1', 's0/p2', 's0/p3', 's0/p4'], '거꾸로 줘도 문서 순서');
  assert.deepEqual(GEO.refsBetween('s0/p3/n3', 's0/p3/n2'), ['s0/p3/n2', 's0/p3/n3']);
  assert.deepEqual(GEO.refsBetween('s0/p5', 's1/p0'), ['s0/p5'], '묶음이 다르면 [a](refmap 과 같은 규칙)');
  assert.deepEqual(GEO.refsBetween('s9/p9', 's0/p0'), ['s9/p9']);
  assert.equal(GEO.textOf('s0/p5'), '마지막 문단 🎉🎉 끝'); assert.equal(GEO.length('s0/p5'), 11); assert.equal(GEO.length('s9/p9'), 0);
  const g0 = paragraphGeo(undefined); assert.equal(g0.length('s0/p0'), 0); assert.deepEqual(g0.refsBetween('a', 'b'), ['a']);
});

test('paragraphGeo: 실제 표본의 표 칸 묶음 = 엔진 tables() 의 칸', { skip: !fs.existsSync(SMALL) && '표본 없음' }, async () => {
  const doc = await loadDoc(SMALL);
  const paras = doc.paragraphs({ view: 'final', nested: true }); const geo = paragraphGeo(paras);
  const body = paras.filter((p) => !p.parent).map((p) => p.ref);
  assert.ok(body.length > 10);
  assert.equal(new Set(body.map(geo.container)).size, 1, '본문 한 구역');
  assert.deepEqual(geo.refsBetween(body[0], body[body.length - 1]), body);
  const keys = new Set(); let cells = 0;
  for (const t of doc.tables()) {
    for (const c of t.cells) {
      const ks = new Set(c.refs.map(geo.container)); assert.equal(ks.size, 1, `${t.key} ${c.row},${c.col} 한 묶음`);
      const key = [...ks][0]; assert.ok(!keys.has(key), '다른 칸과 겹치지 않음'); keys.add(key); cells++;
      assert.deepEqual(geo.refsBetween(c.refs[c.refs.length - 1], c.refs[0]), c.refs, '칸 안 문단 순서');
      assert.deepEqual(geo.refsBetween(c.refs[0], body[0]), [c.refs[0]], '칸 ↔ 본문은 다른 묶음');
    }
  }
  assert.ok(cells > 100, `칸 ${cells}개`);
});

// ───────── 범위 계산 ─────────

test('memoRange: 한 문단·여러 문단(같은 묶음만 endRef 끝까지)·시작 없음', () => {
  const L = (ref) => GEO.length(ref);
  assert.deepEqual(memoRange({ ref: 's0/p0', start: 2, end: 5, endRef: 's0/p0' }, GEO), { ref: 's0/p0', start: 2, end: 5, endRef: 's0/p0' });
  assert.deepEqual(memoRange({ ref: 's0/p0', start: 3, end: null, endRef: 's0/p1' }, GEO), { ref: 's0/p0', start: 3, end: L('s0/p1'), endRef: 's0/p1' });
  assert.deepEqual(memoRange({ ref: 's0/p3/n2', start: 1, end: null, endRef: 's0/p3/n3' }, GEO), { ref: 's0/p3/n2', start: 1, end: L('s0/p3/n3'), endRef: 's0/p3/n3' });
  assert.deepEqual(memoRange({ ref: 's0/p3/n1', start: 0, end: null, endRef: 's0/p3/n4' }, GEO), { ref: 's0/p3/n1', start: 0, end: L('s0/p3/n1'), endRef: 's0/p3/n1' }, '다른 칸이면 시작 문단 끝까지');
  assert.deepEqual(memoRange({ ref: 's0/p5', start: 0, end: null, endRef: 's1/p0' }, GEO), { ref: 's0/p5', start: 0, end: 11, endRef: 's0/p5' }, '다른 구역');
  assert.deepEqual(memoRange({ ref: 's0/p1', end: null, endRef: null }, GEO), { ref: 's0/p1', start: 0, end: L('s0/p1'), endRef: 's0/p1' });
  assert.deepEqual(memoRange({ ref: 's0/p0', start: 1, end: 4, endRef: 's0/p1' }, GEO), { ref: 's0/p0', start: 1, end: 4, endRef: 's0/p0' }, 'end 가 있으면 한 문단(v0.2 규칙)');
  assert.deepEqual(memoRange({ ref: 's0/p0', start: 1, endRef: 's1/p1' }, { length: L }), { ref: 's0/p0', start: 1, end: L('s1/p1'), endRef: 's1/p1' }, 'container 가 없으면 같은 묶음으로 본다');
});

test('findRange: 코드포인트 offset·n 번째(겹침 포함)·빈 find 는 문단 끝 한 점·못 찾으면 null', () => {
  assert.deepEqual(findRange('s0/p0', '이모지', 1, GEO), { ref: 's0/p0', start: 12, end: 15, endRef: 's0/p0' }, '😀 는 한 글자');
  assert.deepEqual(findRange('s0/p1', '응답자 수', 2, GEO), { ref: 's0/p1', start: 13, end: 18, endRef: 's0/p1' });
  assert.deepEqual(findRange('s0/p1', '응답자 수', 3, GEO), { ref: 's0/p1', start: 19, end: 24, endRef: 's0/p1' });
  assert.equal(findRange('s0/p1', '응답자 수', 4, GEO), null);
  for (const occ of [undefined, null, 0, 1]) assert.deepEqual(findRange('s0/p1', '응답자 수', occ, GEO), { ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1' }, `occ ${occ}`);
  assert.equal(findRange('s0/p1', '응답자 수', -1, GEO), null);
  assert.deepEqual([2, 3, 4, 5].map((o) => findRange('s0/p4', 'aa', o, GEO)?.start), [1, 2, 12, 13], '겹치는 찾기');
  assert.equal(findRange('s0/p4', 'aa', 6, GEO), null);
  assert.deepEqual(findRange('s0/p5', '', 1, GEO), { ref: 's0/p5', start: 11, end: 11, endRef: 's0/p5', point: true });
  assert.deepEqual(findRange('s0/p2', undefined, 1, GEO), { ref: 's0/p2', start: 0, end: 0, endRef: 's0/p2', point: true });
  assert.equal(findRange('s0/p0', '없는 글', 1, GEO), null);
});

test('proposalRange: 메모 범위 → 대기 중 start/end → find, 문단 추가·표는 null', () => {
  const memos = new Map([['memo3', { id: 'memo3', ref: 's0/p1', start: 13, end: 18, endRef: 's0/p1' }]]);
  assert.equal(proposalRange({ type: 'insert', ref: 's0/p1', afterRef: 's0/p1' }, memos, GEO), null);
  assert.equal(proposalRange({ type: 'table', ref: 's0/p1' }, memos, GEO), null);
  assert.deepEqual(proposalRange({ ref: 's0/p1', memoId: 'memo3', find: '응답자 수', status: 'pending' }, memos, GEO), { ref: 's0/p1', start: 13, end: 18, endRef: 's0/p1' });
  assert.deepEqual(proposalRange({ ref: 's0/p1', memoId: 'memo-없음', find: '응답자 수', occurrence: 3, status: 'applied' }, memos, GEO), { ref: 's0/p1', start: 19, end: 24, endRef: 's0/p1' });
  assert.deepEqual(proposalRange({ ref: 's0/p3/n4', find: '', start: 3, end: 3, status: 'pending' }, memos, GEO), { ref: 's0/p3/n4', start: 3, end: 3, endRef: 's0/p3/n4' });
  assert.deepEqual(proposalRange({ ref: 's0/p1', find: '응답자 수', start: 0, end: 2, status: 'rejected' }, memos, GEO), { ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1' }, '대기가 아니면 find');
  assert.deepEqual(proposalRange({ ref: 's0/p1', find: '응답자 수' }, null, GEO), { ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1' }, '메모 지도 없음');
});

test('covers: 양 끝 포함, 여러 문단은 사이 문단 전부, endRef 없으면 한 문단', () => {
  const one = { ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1' };
  assert.deepEqual([6, 7, 12, 13].map((o) => covers(one, 's0/p1', o, GEO)), [false, true, true, false]);
  assert.equal(covers(one, 's0/p0', 8, GEO), false);
  const multi = { ref: 's0/p0', start: 5, end: 3, endRef: 's0/p3' };
  assert.deepEqual([covers(multi, 's0/p0', 4, GEO), covers(multi, 's0/p0', 5, GEO), covers(multi, 's0/p1', 0, GEO), covers(multi, 's0/p2', 99, GEO), covers(multi, 's0/p3', 3, GEO), covers(multi, 's0/p3', 4, GEO), covers(multi, 's0/p4', 0, GEO), covers(multi, 's0/p3/n1', 0, GEO)],
    [false, true, true, true, true, false, false, false]);
  assert.equal(covers({ ref: 's0/p1', start: 7, end: 12 }, 's0/p1', 9, GEO), true, 'endRef 없음 = 한 문단');
  assert.equal(covers({ ref: 's0/p1', start: 7, end: 12 }, 's0/p1', 13, GEO), false);
  assert.equal(covers(null, 's0/p1', 0, GEO), false);
  assert.equal(covers(multi, 's0/p0', 9), true, 'geo 없으면 시작 문단만');
  assert.equal(covers(multi, 's0/p1', 0), false);
});

test('changeRange·proposalChanges: 삽입은 그 글, 삭제는 앞뒤 한 글자, 적용 제안의 변경은 목록 순서', () => {
  assert.deepEqual(changeRange({ type: 'Insert', ref: 'r', start: 3, end: 7 }), { ref: 'r', start: 3, end: 7, endRef: 'r' });
  assert.deepEqual(changeRange({ type: 'Delete', ref: 'r', start: 3, end: 3 }), { ref: 'r', start: 2, end: 4, endRef: 'r' });
  assert.deepEqual(changeRange({ type: 'Delete', ref: 'r', start: 0 }), { ref: 'r', start: 0, end: 1, endRef: 'r' });
  assert.deepEqual(changeRange({ type: 'Delete', ref: 'r' }), { ref: 'r', start: 0, end: 1, endRef: 'r' });
  assert.deepEqual(changeRange({ type: 'Insert', ref: 'r', start: 5, end: null }), { ref: 'r', start: 4, end: 6, endRef: 'r' }, '다음 문단까지 이어진 삽입');
  const changes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: '4' }];
  assert.deepEqual(proposalChanges({ changeIds: ['3', 1, 4] }, changes).map((c) => c.id), [1, 3, '4']);
  assert.deepEqual(proposalChanges({}, changes), []);
  assert.deepEqual(proposalChanges({ changeIds: [1] }, undefined), []);
});

test('changeRange: 개체 변경(표·그림 넣음/지움 — 2026-10-30)은 그 자리 앞뒤 한 글자, 글과 섞인 삽입은 넣은 글', () => {
  const tbl = [{ tag: 'hp:tbl', what: 'table', name: '표' }];
  assert.deepEqual(changeRange({ type: 'Insert', kind: 'object', objects: tbl, label: '표 넣음', ref: 'r', start: 4, end: 4 }), { ref: 'r', start: 3, end: 5, endRef: 'r' }, '넣은 표(start = end)');
  assert.deepEqual(changeRange({ type: 'Delete', kind: 'object', objects: tbl, label: '표 지움', ref: 'r', start: 0, end: 0 }), { ref: 'r', start: 0, end: 1, endRef: 'r' }, '문단 앞 지운 표');
  assert.deepEqual(changeRange({ type: 'Insert', kind: 'object', ref: 'r', start: 2, end: 6 }), { ref: 'r', start: 1, end: 3, endRef: 'r' }, '개체만이면 end 가 있어도 한 점');
  assert.deepEqual(changeRange({ type: 'Insert', kind: 'mixed', objects: tbl, ref: 'r', start: 2, end: 6 }), { ref: 'r', start: 2, end: 6, endRef: 'r' }, '섞인 삽입은 넣은 글');
  assert.deepEqual(changeRange({ type: 'Insert', kind: 'mixed', objects: tbl, ref: 'r', start: 2, end: 2 }), { ref: 'r', start: 1, end: 3, endRef: 'r' }, '글이 빈 섞인 삽입');
  assert.deepEqual(changeRange({ type: 'Delete', kind: 'mixed', objects: tbl, ref: 'r', start: 5, end: 5 }), { ref: 'r', start: 4, end: 6, endRef: 'r' });
  // 편집기 강조: 추적으로 지운 표 안(숨은 문단 '…/dK')의 변경은 그리지 않는다, 개체 변경 자체는 그린다
  const hidden = [
    { id: 8, type: 'Insert', ref: 's0/p0/d3', start: 0, end: 1, author: 'y', text: '0' },
    { id: 9, type: 'Insert', ref: 's0/p0/d3/n0', start: 0, end: 1, author: 'y', text: '0' },
    { id: 10, type: 'Delete', kind: 'object', objects: tbl, label: '표 지움', ref: 's0/p0', start: 2, end: 2, author: 'x', text: '' },
  ];
  const a = buildAnnotations({ ...STATE, changes: [...STATE.changes, ...hidden] }, { me: '홍길동' });
  assert.deepEqual(a.changes.map((c) => c.id), [...STATE.changes.map((c) => c.id), 10]);
});

test('changeRange: 문단 나눔 변경(kind para — 2026-10-30, 폭 0)은 나눔 앞 한 글자, 편집기 강조 설명은 ¶', () => {
  const B = (type, extra = {}) => ({ type, kind: 'para', paraEnd: true, label: type === 'Insert' ? '문단 나눔 넣음' : '문단 나눔 지움', ref: 'r', start: 6, end: 6, ...extra });
  assert.deepEqual(changeRange(B('Insert')), { ref: 'r', start: 5, end: 6, endRef: 'r' }, '넣은 나눔(문단 끝)');
  assert.deepEqual(changeRange(B('Delete')), { ref: 'r', start: 5, end: 6, endRef: 'r' }, '지운 나눔(묶음 안 문단 경계)');
  assert.deepEqual(changeRange(B('Delete', { start: 0, end: 0 })), { ref: 'r', start: 0, end: 1, endRef: 'r' }, '빈 문단');
  assert.deepEqual(changeRange(B('Insert', { start: 2, end: 6, text: '끝 글' })), { ref: 'r', start: 2, end: 6, endRef: 'r' }, '한/글의 글과 나눔 넣음 = 그 글');
  const a = buildAnnotations({ ...STATE, changes: [{ id: 11, author: 'x', ...B('Delete', { ref: 's0/p0', start: 2, end: 2, text: '' }) }] }, { me: '홍길동' });
  const c = a.changes.find((x) => x.id === 11);
  assert.equal(c.text, '¶');
  assert.equal(c.start, 2);
});

test('v0.2 와 같다: 무작위 메모·찾기·제안·덮기·변경 범위(지도 있음/없음)', () => {
  const r = rng(20261022);
  let n = 0;
  for (const withMap of [true, false]) {
    for (let round = 0; round < 40; round++) {
      const changes = Array.from({ length: 6 }, (_, i) => ({ id: pick(r, [i + 1, String(i + 1)]), type: pick(r, ['Insert', 'Delete']), ref: pick(r, REFS), start: pick(r, [undefined, null, 0, int(r, 12)]), end: pick(r, [null, undefined, int(r, 20)]) }));
      const d = storeOf(PARAS, changes); const map = withMap ? GEO : null;
      const old = v2Ranges(map, d); const now = wired(map, d);
      const memos = Array.from({ length: 12 }, (_, i) => randMemo(r, i));
      const memosById = new Map(memos.map((m) => [m.id, m]));
      for (const m of memos) { assert.deepEqual(now.memoRange(m), old.memoRange(m), JSON.stringify(m)); n++; }
      for (let i = 0; i < 25; i++) {
        const ref = pick(r, REFS); const find = randFind(r, ref); const occ = pick(r, [undefined, null, 0, 1, 2, 3, 5, -1]);
        assert.deepEqual(now.findRange(ref, find, occ), old.findRange(ref, find, occ), JSON.stringify([ref, find, occ])); n++;
        const p = { pid: i, type: pick(r, [undefined, 'replace', 'replace', 'insert', 'table']), ref, find, occurrence: occ, memoId: pick(r, [undefined, null, 'memo-없음', pick(r, memos).id]), status: pick(r, ['pending', 'pending', 'applied', 'rejected', 'undone']), start: pick(r, [undefined, null, int(r, 6)]), end: pick(r, [undefined, null, int(r, 9)]), changeIds: pick(r, [undefined, [], [1, '2'], ['3', 4, 9]]) };
        assert.deepEqual(now.proposalRange(p, memosById), old.proposalRange(p, memosById), JSON.stringify(p)); n++;
        assert.deepEqual(proposalChanges(p, changes), old.appliedChanges(p)); n++;
      }
      const ranges = [...memos.map((m) => old.memoRange(m)), ...changes.map(old.appliedR)];
      for (let i = 0; i < 60; i++) {
        const rg = pick(r, ranges); const ref = pick(r, REFS); const off = int(r, 26);
        assert.equal(now.covers(rg, ref, off), old.covers(rg, ref, off), JSON.stringify([rg, ref, off])); n++;
      }
      for (const c of changes) {
        assert.deepEqual(changeRange(c), old.appliedR(c)); n++;
        if (c.type === 'Insert' && c.end != null) assert.deepEqual(changeRange(c), old.insertR(c));
        if (c.type === 'Delete') assert.deepEqual(changeRange(c), old.deleteR(c));
      }
    }
  }
  assert.ok(n > 8000, `비교 ${n}번`);
});

// ───────── 사람 색 ─────────

test('colorForUser: 이름별로 늘 같은 색, 나는 파랑, (에이전트) 는 그 사람 색', () => {
  assert.equal(PERSON_COLORS.length, 8); assert.ok(!PERSON_COLORS.includes(ME_COLOR), '남에게 파랑을 주지 않는다');
  for (const c of PERSON_COLORS) assert.match(c, /^#[0-9a-f]{6}$/);
  assert.equal(colorForUser('홍길동', '홍길동'), ME_COLOR);
  assert.equal(colorForUser('홍길동', { name: '홍길동', role: 'user' }), ME_COLOR);
  assert.equal(colorForUser('홍길동(Claude)', '홍길동'), ME_COLOR, '내 에이전트');
  assert.notEqual(colorForUser('홍길동', '김검토'), ME_COLOR);
  assert.equal(colorForUser('김검토(Claude)', '홍길동'), colorForUser('김검토', '홍길동'));
  assert.equal(colorForUser('김검토'), colorForUser('김검토', null));
  assert.notEqual(colorForUser('', ''), ME_COLOR, '이름이 없으면 나로 보지 않는다');
  const names = Array.from({ length: 60 }, (_, i) => `사용자${i}`);
  const first = names.map((x) => colorForUser(x, '홍길동')); const again = names.map((x) => colorForUser(x, '홍길동'));
  assert.deepEqual(again, first, '결정적');
  assert.ok(first.every((c) => PERSON_COLORS.includes(c)));
  assert.ok(new Set(first).size >= 6, `고르게 퍼짐(${new Set(first).size}색)`);
  // 해시 규칙이 바뀌면 사람 색이 판마다 달라진다 — 몇 개를 고정해 둔다(config.example.json 의 세 사람은 서로 다른 색)
  assert.deepEqual(['관리자', '홍길동', '김검토', '모의 AI', 'Nag', ''].map((x) => colorForUser(x)), ['#0c8599', '#9c6500', '#5c940d', '#087f5b', '#c2255c', '#e8590c']);
});

// ───────── buildAnnotations ─────────

const STATE = {
  paragraphs: PARAS,
  memos: [
    { id: 'memo1', author: '관리자', ref: 's0/p0', start: 0, end: 4, endRef: 's0/p0', text: '사람 메모', link: null, editable: true },
    { id: 'memo2', author: '홍길동', ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1', text: '[AI 작업 #3] …', link: { type: 'request', rid: 3 } },
    { id: 'memo3', author: '모의 AI', ref: 's0/p1', start: 13, end: 18, endRef: 's0/p1', text: '[제안 #7] …', link: { type: 'proposal', pid: 7 }, proposal: { pid: 7, status: 'pending' } },
    { id: 'memo4', author: '모의 AI', ref: 's0/p4', start: 0, end: 4, endRef: 's0/p4', text: '의견', link: { type: 'comment', rid: 3 } },
    { id: 'memo5', author: '김검토(Claude)', ref: 's0/p0', start: 3, end: null, endRef: 's0/p1', text: '여러 문단 메모', link: null, thread: { replies: [], resolved: { by: '관리자', at: '2026-10-22T05:00:00Z' } } },
    { id: 'memo6', author: '', ref: 's0/p2', start: 0, end: 0, endRef: 's0/p2', text: '이름 없는 메모', link: { type: 'proposal', pid: 99 }, proposal: { pid: 99, status: 'undone' } },
  ],
  requests: [{ rid: 3, kind: 'suggest', status: 'working' }],
  proposals: [
    { pid: 7, type: 'replace', ref: 's0/p1', find: '응답자 수', occurrence: 2, status: 'pending', by: '모의 AI', memoId: 'memo3', option: 1, gid: 1 },
    { pid: 8, type: 'replace', ref: 's0/p1', find: '응답자 수', occurrence: 3, status: 'pending', by: '홍길동(Claude)' },
    { pid: 9, type: 'replace', ref: 's0/p1', find: '없는 글', status: 'pending', by: 'x' },
    { pid: 10, type: 'insert', afterRef: 's0/p4', ref: 's0/p4', text: '새 문단', status: 'pending', by: 'y' },
    { pid: 11, type: 'table', afterRef: 's0/p5', ref: 's0/p5', status: 'pending' },
    { pid: 12, type: 'replace', ref: 's0/p0', find: '첫째', status: 'applied', changeIds: [1, '2'], by: 'z' },
    { pid: 13, status: 'rejected', ref: 's0/p0', find: 'x' },
    { pid: 14, status: 'pending', ref: 's0/p3/n4', find: '', start: 3, end: 3, by: 'AI' },
    { pid: 15, status: 'superseded', ref: 's0/p1', find: '응답자 수' },
  ],
  changes: [
    { id: 1, type: 'Insert', ref: 's0/p0', start: 0, end: 2, author: 'z', text: '첫째', date: '2026-10-22T05:00:00Z' },
    { id: 2, type: 'Delete', ref: 's0/p0', start: 0, end: 0, author: 'z', text: '첫' },
    { id: 3, type: 'Insert', ref: 's0/p5', start: 4, end: null, author: 'w', text: '이어진 삽입', spansParagraph: true },
    { id: 4, type: 'Delete', ref: 's0/p5', start: 2, end: null, author: 'w', text: '…' },
  ],
  editing: { 김검토: 's0/p1', 관리자: 's0/p0', 홍길동: 's0/p4', 이없음: null },
  crs: [
    { cid: 3, author: '김검토', status: 'open', hunks: [
      { hid: 'h1', type: 'replace', ref: 's0/p0', curRef: 's0/p0', baseText: '첫째 문단', newText: '바뀐 글', state: 'ok' },
      { hid: 'h2', type: 'insert', afterRef: 's0/p3', curRef: 's0/p4', baseText: '', newText: '새로 넣은 문단', state: 'ok' },
      { hid: 'h3', type: 'delete', ref: 's0/p5', baseText: '지운 글', newText: '', state: 'gone' },
      { hid: 'h4', type: 'delete', ref: 's1/p1', curRef: 's1/p1', baseText: '지울 문단', newText: '', state: 'conflict' },
    ] },
    { cid: 4, author: '관리자', status: 'draft', hunkCount: 2 },
    { cid: 5, author: '홍길동', status: 'open', hunks: [] },
    { cid: 6, author: '이반영', status: 'merged', hunks: [] },
  ],
};
const C = (name) => colorForUser(name, '홍길동');

test('buildAnnotations: 메모 종류·이름표·상태·색, 제안(대기 + 적용된 변경 자리), 변경, 남의 수정 중·타이핑 중', () => {
  const a = buildAnnotations(STATE, { me: '홍길동' });
  assert.deepEqual(Object.keys(a), ['memos', 'proposals', 'changes', 'drafts', 'editing', 'flash']);
  assert.deepEqual(a.memos, [
    { id: 'memo1', ref: 's0/p0', start: 0, end: 4, endRef: 's0/p0', kind: 'memo', label: '관리자', author: '관리자', color: C('관리자'), resolved: false },
    { id: 'memo2', ref: 's0/p1', start: 7, end: 12, endRef: 's0/p1', kind: 'request', label: 'AI 작업 #3', author: '홍길동', color: ME_COLOR, resolved: false, status: 'working', rid: 3 },
    { id: 'memo3', ref: 's0/p1', start: 13, end: 18, endRef: 's0/p1', kind: 'proposal', label: '제안 #7', author: '모의 AI', color: C('모의 AI'), resolved: false, status: 'pending' },
    { id: 'memo4', ref: 's0/p4', start: 0, end: 4, endRef: 's0/p4', kind: 'comment', label: 'AI 의견 #3', author: '모의 AI', color: C('모의 AI'), resolved: false, rid: 3 },
    { id: 'memo5', ref: 's0/p0', start: 3, end: GEO.length('s0/p1'), endRef: 's0/p1', kind: 'memo', label: '김검토(Claude)', author: '김검토(Claude)', color: C('김검토'), resolved: true },
    { id: 'memo6', ref: 's0/p2', start: 0, end: 0, endRef: 's0/p2', kind: 'proposal', label: '제안 #99', author: '', color: C(''), resolved: false, status: 'undone' },
  ]);
  assert.deepEqual(a.proposals, [
    { pid: 7, type: 'replace', ref: 's0/p1', find: '응답자 수', occurrence: 2, status: 'pending', label: '제안 #7 · 안 1 · 모의 AI', start: 13, end: 18 },
    { pid: 8, type: 'replace', ref: 's0/p1', find: '응답자 수', occurrence: 3, status: 'pending', label: '제안 #8 · 홍길동(Claude)', start: 19, end: 24 },
    { pid: 9, type: 'replace', ref: 's0/p1', find: '없는 글', occurrence: 1, status: 'pending', label: '제안 #9 · x' },
    { pid: 10, type: 'insert', ref: 's0/p4', afterRef: 's0/p4', start: 0, end: GEO.length('s0/p4'), status: 'pending', label: '제안 #10 · y' },
    { pid: 11, type: 'table', ref: 's0/p5', afterRef: 's0/p5', start: 0, end: 11, status: 'pending', label: '제안 #11' },
    { pid: 12, type: 'replace', ref: 's0/p0', start: 0, end: 2, status: 'applied', label: '제안 #12 · z' },
    { pid: 12, type: 'replace', ref: 's0/p0', start: 0, end: 1, status: 'applied', label: '제안 #12 · z' },
    { pid: 14, type: 'replace', ref: 's0/p3/n4', find: '', occurrence: 1, status: 'pending', label: '제안 #14 · AI', start: 3, end: 3 },
  ]);
  assert.deepEqual(a.changes, [
    { id: 1, type: 'Insert', ref: 's0/p0', start: 0, end: 2, author: 'z', text: '첫째' },
    { id: 2, type: 'Delete', ref: 's0/p0', start: 0, end: 0, author: 'z', text: '첫' },
    { id: 3, type: 'Insert', ref: 's0/p5', start: 4, end: 11, author: 'w', text: '이어진 삽입' },
    { id: 4, type: 'Delete', ref: 's0/p5', start: 2, end: 2, author: 'w', text: '…' },
  ]);
  assert.deepEqual(a.drafts, [
    { cid: 3, user: '김검토', color: C('김검토'), status: 'open', hunks: [
      { hid: 'h1', type: 'replace', ref: 's0/p0', preview: '바뀐 글' },
      { hid: 'h2', type: 'insert', ref: 's0/p4', preview: '새로 넣은 문단', afterRef: 's0/p4' },
      { hid: 'h4', type: 'delete', ref: 's1/p1', preview: '지울 문단' },
    ] },
    { cid: 4, user: '관리자', color: C('관리자'), status: 'draft', hunks: [] },
  ]);
  assert.deepEqual(a.editing, [{ user: '김검토', color: C('김검토'), ref: 's0/p1' }, { user: '관리자', color: C('관리자'), ref: 's0/p0' }]);
  assert.equal(a.flash, null);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'JSON 그대로');
});

test('buildAnnotations: AI 작업 메모 — 호스트의 내 눈의 진행(requestView)이 해결이면 resolved · 남은 반영 수 open(> 0 일 때만) · rid', () => {
  const asked = [];
  const view = (rid) => { asked.push(rid); return rid === 3 ? { resolved: false, open: 4 } : null; };
  const a = buildAnnotations(STATE, { me: '홍길동', requestView: view });
  const m2 = a.memos.find((m) => m.id === 'memo2');
  assert.equal(m2.open, 4); assert.equal(m2.rid, 3); assert.equal(m2.resolved, false);
  assert.deepEqual(asked, [3], 'AI 작업 메모만 묻는다(AI 의견·사람 메모·제안 메모는 묻지 않음)');
  assert.equal(a.memos.find((m) => m.id === 'memo4').open, undefined, 'AI 의견 메모에는 open 이 없다');
  // 해결(내 눈) → resolved(해결된 메모처럼 숨김), open 0 이면 칸을 싣지 않는다
  const b = buildAnnotations(STATE, { me: '홍길동', requestView: () => ({ resolved: true, open: 0 }) });
  const b2 = b.memos.find((m) => m.id === 'memo2');
  assert.equal(b2.resolved, true); assert.ok(!('open' in b2));
  // 스레드가 해결된 옛 요청 메모(v0.3.0 [해결]): 진행이 해결 아님이면 숨기지 않는다(다시 열린 요청) · 진행을 모르면(requestView 가 던짐) 스레드 표시 그대로 — 그리기는 이어 간다
  const st = { ...STATE, memos: STATE.memos.map((m) => (m.id === 'memo2' ? { ...m, thread: { replies: [], resolved: { by: 'x', at: 1 } } } : m)) };
  assert.equal(buildAnnotations(st, { me: '홍길동', requestView: () => ({ resolved: false, open: 1 }) }).memos.find((m) => m.id === 'memo2').resolved, false);
  const c = buildAnnotations(st, { me: '홍길동', requestView: () => { throw new Error('boom'); } });
  assert.equal(c.memos.find((m) => m.id === 'memo2').resolved, true);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'JSON 그대로');
});

test('buildAnnotations: 비어 있거나 옛 상태(crs·editing 없음)·drafts/editing 배열 그대로·flash', () => {
  assert.deepEqual(buildAnnotations(), { memos: [], proposals: [], changes: [], drafts: [], editing: [], flash: null });
  assert.deepEqual(buildAnnotations({ memos: [], proposals: [], changes: [], requests: [], paragraphs: [] }, {}).drafts, []);
  const drafts = [{ cid: 9, user: '김검토', status: 'draft', hunks: [{ hid: 'hx', type: 'replace', ref: 's0/p1', preview: '미리' }] }, { cid: 10, user: '홍길동(Claude)', status: 'draft', hunks: [] }];
  const a = buildAnnotations({ drafts, crs: STATE.crs, editing: [{ user: '김검토', ref: 's0/p3', color: '#123456' }, { user: '홍길동', ref: 's0/p1' }, { user: '누구', ref: null }] }, { me: { name: '홍길동' } });
  assert.deepEqual(a.drafts, [{ cid: 9, user: '김검토', color: C('김검토'), status: 'draft', hunks: [{ hid: 'hx', type: 'replace', ref: 's0/p1', preview: '미리' }] }], 'drafts 가 있으면 그것(내 것은 뺌)');
  assert.deepEqual(a.editing, [{ user: '김검토', color: '#123456', ref: 's0/p3' }]);
  assert.deepEqual(buildAnnotations({ editing: new Map([['김검토', 's0/p1'], ['홍길동', 's0/p2']]) }, { me: '홍길동' }).editing, [{ user: '김검토', color: C('김검토'), ref: 's0/p1' }], 'Map 도 받는다');
  const flash = { ref: 's0/p1', start: 0, end: 3, endRef: 's0/p1' };
  assert.deepEqual(buildAnnotations({ focus: { flash } }).flash, flash);
  assert.equal(buildAnnotations({ focus: { flash } }, { flash: null }).flash, null);
  // geo 를 주면 그것으로(검토 보기 지도 등)
  const geo = { textOf: () => '', length: () => 42, container: () => 'k', refsBetween: (x) => [x] };
  assert.equal(buildAnnotations({ memos: [{ id: 'm', ref: 's0/p0', start: 0, end: null, author: 'a' }] }, { geo }).memos[0].end, 42);
});

test('buildAnnotations: 나 = 내 이름 그대로 또는 내 이름(에이전트) — store·서버 소유자 규칙과 같다(끝 괄호를 떼고 비교하지 않음)', () => {
  // web/store.js 의 '내 것'(by === 나 || by.startsWith('나(')) — 서버의 CR author·editing user 는 사람 이름 그대로
  const storeMine = (by, me) => by === me || by.startsWith(`${me}(`);
  const cases = [['김(A)', '김(B)'], ['홍길동 (외부)', '홍길동'], ['홍길동', '홍길동 (외부)'], ['홍길동(Claude)', '홍길동'], ['김검토', '홍길동'], ['홍길동', '홍길동']];
  for (const [user, me] of cases) {
    const a = buildAnnotations({ drafts: [{ cid: 1, user, status: 'draft', hunks: [] }], editing: [{ user, ref: 's0/p0' }] }, { me });
    const mine = storeMine(user, me);
    assert.equal(a.drafts.length, mine ? 0 : 1, `drafts: ${user} / 나 ${me}`);
    assert.equal(a.editing.length, mine ? 0 : 1, `editing: ${user} / 나 ${me}`);
    assert.equal(colorForUser(user, me) === ME_COLOR, mine, `색: ${user} / 나 ${me}`);
  }
  // crs 로 만들 때도 같다
  const crs = [{ cid: 2, author: '김(A)', status: 'open', hunks: [{ hid: 'h', type: 'replace', ref: 's0/p1', curRef: 's0/p1', state: 'ok', baseText: 'a', newText: 'b' }] }];
  assert.equal(buildAnnotations({ crs }, { me: '김(B)' }).drafts.length, 1, '김(B) 에게 김(A) 의 수정 중이 보인다');
  assert.equal(buildAnnotations({ crs }, { me: '김(A)' }).drafts.length, 0);
});

test('buildAnnotations: 실제 변경 추적·메모 문서(엔진 목록 그대로)', async () => {
  const doc = await loadDoc(FIX);
  const paragraphs = doc.paragraphs({ view: 'final', nested: true });
  const a = buildAnnotations({ paragraphs, memos: doc.memos(), changes: doc.changes(), proposals: [], requests: [] }, { me: 'Nag' });
  const len = (ref) => cpLen(paragraphs.find((p) => p.ref === ref).text);
  assert.deepEqual(a.memos.map((m) => [m.id, m.ref, m.start, m.end, m.kind, m.label]), [['memo1', 's0/p0', 0, 10, 'memo', 'AI 검토자']]);
  assert.deepEqual(a.changes.map((c) => [c.id, c.type, c.ref, c.start, c.end, c.author]), [[1, 'Insert', 's0/p1', 32, 45, 'Nag'], [2, 'Delete', 's0/p1', 10, 10, 'Nag'], [3, 'Insert', 's0/p2', 7, 15, 'AI 검토자'], [4, 'Delete', 's0/p2', 7, 7, 'AI 검토자']]);
  for (const x of [...a.memos, ...a.changes]) assert.ok(x.start >= 0 && x.start <= x.end && x.end <= len(x.ref), `${x.id} 범위가 문단 안`);
  assert.equal(a.changes[0].color, undefined); assert.equal(a.memos[0].color, colorForUser('AI 검토자', 'Nag'));
});

test('proposalLabel', () => {
  assert.equal(proposalLabel({ pid: 7, option: 2, by: '홍길동(Claude)' }), '제안 #7 · 안 2 · 홍길동(Claude)');
  assert.equal(proposalLabel({ pid: 9 }), '제안 #9');
  assert.equal(proposalLabel({ pid: 3, by: '김검토' }), '제안 #3 · 김검토');
});

test('buildAnnotations(v0.4 보기): proposalVisible 이 false 인 제안은 빼고(간단히 — 남의 AI 작업 제안, 적용된 것의 우클릭 자리도) · adoptLabel 은 대기 제안에만', () => {
  const hide = new Set([7, 8, 10, 12]);
  const a = buildAnnotations(STATE, { me: '홍길동', proposalVisible: (p) => !hide.has(Number(p.pid)) });
  assert.deepEqual([...new Set(a.proposals.map((p) => p.pid))].sort((x, y) => x - y), [9, 11, 14]);
  // 던지면(규칙을 모름) 보인다
  const b = buildAnnotations(STATE, { me: '홍길동', proposalVisible: () => { throw new Error('boom'); } });
  assert.deepEqual([...new Set(b.proposals.map((p) => p.pid))].sort((x, y) => x - y), [7, 8, 9, 10, 11, 12, 14]);
  // 실시간 문서: 대기 제안 항목에 adoptLabel(우클릭 '문서에 반영'), 적용된 것(메뉴용 applied 항목)에는 없음 · 없으면 칸 없음(v0.3 그대로)
  const c = buildAnnotations(STATE, { me: '홍길동', adoptLabel: '문서에 반영' });
  assert.ok(c.proposals.filter((p) => p.status === 'pending').every((p) => p.adoptLabel === '문서에 반영'));
  assert.ok(c.proposals.filter((p) => p.status === 'applied').every((p) => !('adoptLabel' in p)));
  assert.ok(buildAnnotations(STATE, { me: '홍길동' }).proposals.every((p) => !('adoptLabel' in p)));
  // 메모(요청 메모 포함)는 그대로 — 남의 AI 작업은 메모 강조(보라)와 한 줄 요약 카드로 남는다
  assert.equal(a.memos.length, buildAnnotations(STATE, { me: '홍길동' }).memos.length);
});
