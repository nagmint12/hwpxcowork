import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { planBody, charOps, foldOwners } from '../engine/diff.js';
import { alignOffsets, lcsPairs, rhwpNestedList } from '../web/refmap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 실제 플러그인 소스를 실행한다. DOM 조작만 대역으로 두고 정렬·차이·시간 조절 코드는 제품과 공유한다.
function load(file, names, dependencies = {}) {
  const filename = path.join(root, 'studio/plugin', file);
  const source = stripTypeScriptTypes(fs.readFileSync(filename, 'utf8'), { mode: 'transform' })
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export /gm, '');
  return vm.runInNewContext(`${source}\n; ({ ${names} });`, {
    console, performance, Date: { now: () => Date.now() },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer),
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: timer => clearTimeout(timer),
    ...dependencies,
  }, { filename });
}
const util = load('util.ts', 'cpLen, cpSlice, cps, normText, Emitter, debounce, throttle, rafBatch, safe');
const { Alignment } = load('align.ts', 'Alignment', { planBody, charOps, foldOwners, alignOffsets, lcsPairs, rhwpNestedList, ...util });
const { CoworkController } = load('controller.ts', 'CoworkController', {
  Alignment, Geometry: class {}, Overlay: class {}, ReviewMenu: class {}, MiniToolbar: class {},
  paragraphGeo: () => ({}), ...util,
});
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const rows = [{ text: '처음😀' }, { text: '', cells: ['가', '나'] }, { text: '', cells: ['다', '라'] }];
  const reads = { body: [], cells: [] };
  const w = {
    pageCount: 1,
    getSectionCount: () => 1,
    getParagraphCount: () => rows.length,
    getParagraphLength: (_s, p) => { reads.body.push(p); return Array.from(rows[p].text).length; },
    getTextRange: (_s, p, a, b) => Array.from(rows[p].text).slice(a, b).join(''),
    getControlTextPositions: (_s, p) => rows[p].cells ? [0] : [],
    getTableDimensions: (_s, p) => rows[p].cells ? { rowCount: rows[p].cells.length, colCount: 1, cellCount: rows[p].cells.length } : null,
    getCellInfo: (_s, _p, _ci, c) => ({ row: c, col: 0, rowSpan: 1, colSpan: 1 }),
    getCellParagraphCount: (_s, _p, _ci, c) => c === 65534 ? 0 : 1,
    getCellParagraphLength: (_s, p, _ci, c) => { reads.cells.push(p); return Array.from(rows[p].cells[c]).length; },
    getTextInCell: (_s, p, _ci, c) => rows[p].cells[c],
  };
  const base = rows.flatMap((row, p) => [
    { ref: `s0/p${p}`, text: row.text },
    ...(row.cells || []).map((text, c) => ({ ref: `s0/p${p}/c${c}`, text, parent: `s0/p${p}`, container: 'hp:tbl', cell: { table: `s0/p${p}#t0`, row: c, col: 0, rowSpan: 1, colSpan: 1 } })),
  ]);
  const fresh = () => { const a = new Alignment(() => w); a.setBase(1, base); return a; };
  const a = fresh(); a.draft();
  const reset = () => { reads.body = []; reads.cells = []; };
  reset();
  return { a, rows, reads, reset, fresh };
}
const cell = (para, at = 0) => ({ sec: 0, para, cell: { ci: 0, cell: at, cpara: 0, kind: 'cell' } });

test('입력 정렬: 본문 한 글자는 그 문단만 다시 읽고 다른 표의 칸 지도를 재사용한다', () => {
  const { a, rows, reads, fresh } = fixture();
  rows[0].text += '끝';
  a.invalidateText({ sec: 0, para: 0 });
  a.invalidateText({ sec: 0, para: 0 });
  assert.equal(a.stale, true);
  assert.deepEqual(reads.body, []); // 키 이벤트는 읽기를 수행하지 않는다.
  const result = a.draft();
  assert.deepEqual(plain(result.state.changed), ['s0/p0']);
  assert.deepEqual(reads.body, [0]);
  assert.deepEqual(reads.cells, []);
  assert.equal(a.stats.scans, 1);
  assert.equal(a.stats.textRefreshes, 1);
  assert.deepEqual(result, fresh().draft());
  assert.deepEqual(a.locate('s0/p0'), fresh().locate('s0/p0'));
});

test('입력 정렬: 칸 편집은 해당 표만 읽고 다른 표·본문은 다시 읽지 않는다', () => {
  const { a, rows, reads, fresh } = fixture();
  rows[1].cells[0] += '😀';
  a.invalidateText(cell(1));
  const result = a.draft();
  assert.deepEqual(plain(result.state.changed), ['s0/p1/c0']);
  assert.deepEqual(reads.body, []);
  assert.deepEqual(reads.cells, [1]);
  assert.deepEqual(result, fresh().draft());
  assert.deepEqual(a.toBase(cell(1)), fresh().toBase(cell(1)));
});

test('입력 정렬: 같은 쉼 구간의 본문·여러 표 변경도 누락 없이 합친다', () => {
  const { a, rows, reads, fresh } = fixture();
  rows[0].text = '';
  rows[1].cells[0] = '가변경'; rows[2].cells[1] = '라변경';
  a.invalidateText(cell(1)); a.invalidateText({ sec: 0, para: 0 }); a.invalidateText(cell(2, 1));
  const result = a.draft();
  assert.deepEqual(reads.body, [0]);
  assert.deepEqual(reads.cells, [1, 2]);
  assert.deepEqual(result, fresh().draft());
});

test('입력 정렬: 표 행 글이 이동한 경우 기존 구조 충돌 판정을 유지한다', () => {
  const { a, rows, fresh } = fixture();
  [rows[1].cells[0], rows[1].cells[1]] = [rows[1].cells[1], rows[1].cells[0]];
  a.invalidateText(cell(1)); a.invalidateText(cell(1, 1));
  const result = a.draft();
  assert.equal(a.stats.gridChanged, 1);
  assert.deepEqual(result, fresh().draft());
  assert.equal(a.toBase(cell(1)).approx, true);
});

test('입력 정렬: 예상 밖의 문단 수 변경과 일반 무효화는 전체 검사로 돌아간다', () => {
  const { a, rows, reads, reset, fresh } = fixture();
  rows.splice(0, 0, { text: '새 문단' });
  a.invalidateText({ sec: 0, para: 0 });
  const result = a.draft();
  assert.deepEqual(reads.body, [0, 1, 2, 3]);
  assert.deepEqual(result, fresh().draft());
  reset();
  a.invalidate();
  rows[1].text += '일반수정';
  a.invalidateText({ sec: 0, para: 1 }); // 전체 무효화 후 부분 힌트로 앞선 변경이 사라져선 안 된다.
  assert.deepEqual(a.draft(), fresh().draft());
  assert.equal(a.stats.scans, 3);
});

test('입력 중 위치: 글 편집 중에는 기존 ref를 읽기 없이 유지하고 구조 변경 뒤에는 사용하지 않는다', () => {
  const { a, rows, reads } = fixture();
  rows[0].text += '추가'; rows[1].cells[0] += '추가';
  a.invalidateText({ sec: 0, para: 0 }); a.invalidateText(cell(1));
  assert.equal(a.cachedEditingRef({ sec: 0, para: 0 }), 's0/p0');
  assert.equal(a.cachedEditingRef(cell(1)), 's0/p1/c0');
  assert.deepEqual(reads, { body: [], cells: [] });
  a.invalidate();
  assert.equal(a.cachedEditingRef(cell(1)), null);
});

test('입력 이벤트: 연속 타이핑 중 정렬·선택·입력 중 표시가 전체 문서를 동기로 읽지 않는다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ setAttribute() {} }) };
  const cw = new CoworkController({});
  let stale = false; let scans = 0; let selections = 0; let presence = 0;
  const ensure = () => { if (stale) { scans++; stale = false; } return true; };
  cw.align = { invalidate: () => { stale = true; }, ensure, get stale() { return stale; }, cachedEditingRef: () => null, toBase: () => { ensure(); return { ref: 's0/p0' }; } };
  cw.geo = { fromPosition: () => ({ sec: 0, para: 0, offset: 1 }), ready: () => true, invalidate() {} };
  cw.toolbar = { hide() {}, visible: false };
  cw.emitter = { has: () => true, emit: (name) => { if (name === 'selection') selections++; if (name === 'editing') presence++; } };
  cw.viewReady = true;
  cw.renderNow = ensure;
  cw.computeSelection = () => { ensure(); return { ref: 's0/p0', start: cw.changeSeq }; };
  cw.draftNow = () => ({ dirty: true, changed: [], inserted: [], deleted: [] });
  cw.ih = () => ({ getCursorPosition: () => ({}) });
  try {
    for (let i = 0; i < 20; i++) {
      cw.onMutated('input-handler-edit');
      cw.selTimer();
      t.mock.timers.tick(100);
      assert.equal(scans, 0);
    }
    t.mock.timers.tick(240);
    assert.equal(scans, 1);
    assert.equal(selections, 1);
    t.mock.timers.tick(1000);
    assert.equal(presence, 1);
    assert.equal(scans, 1);
  } finally {
    for (const key of ['layoutTimer', 'draftTimer', 'selTimer', 'editingTimer', 'editingIdle']) cw[key].cancel();
    globalThis.document = oldDocument;
    t.mock.timers.reset();
  }
});

test('연속 글 입력 중에도 입력 중 알림은 초당 한 번 유지하며 문서 읽기는 쉼 뒤 한 번만 한다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const cw = new CoworkController({});
  let stale = false; let scans = 0; let presence = 0;
  const ensure = () => { if (stale) { scans++; stale = false; } return true; };
  cw.align = {
    invalidateText: () => { stale = true; }, get stale() { return stale; },
    cachedEditingRef: () => 's0/p0', toBase: () => { ensure(); return { ref: 's0/p0' }; },
  };
  cw.geo = { fromPosition: () => ({ sec: 0, para: 0, offset: 1 }), ready: () => true, invalidate() {} };
  cw.toolbar = { hide() {}, visible: false };
  cw.emitter = { has: () => true, emit: name => { if (name === 'editing') presence++; } };
  cw.viewReady = true; cw.renderNow = ensure;
  cw.computeSelection = () => { ensure(); return { ref: 's0/p0', start: cw.changeSeq }; };
  cw.draftNow = () => ({ dirty: true, changed: [], inserted: [], deleted: [] });
  cw.ih = () => ({ getCursorPosition: () => ({}) });
  try {
    for (let i = 0; i < 30; i++) {
      cw.onMutated('input-handler-edit', { kind: 'text', position: { sectionIndex: 0, paragraphIndex: 0, charOffset: 1 } });
      t.mock.timers.tick(100);
      assert.equal(scans, 0);
    }
    assert.ok(presence >= 3 && presence <= 4);
    t.mock.timers.tick(240);
    assert.equal(scans, 1);
  } finally {
    for (const key of ['layoutTimer', 'draftTimer', 'selTimer', 'editingTimer', 'editingIdle']) cw[key].cancel();
    t.mock.timers.reset();
  }
});

test('프로그램으로 선택을 보정하면 열린 미니 도구 막대도 새 요청·메모 범위를 사용한다', () => {
  const cw = new CoworkController({});
  const previous = { ref: 's0/p3', start: 2, end: 8, text: '연습 문장.' };
  let selection = { ...previous, end: 7, text: '연습 문장' };
  let target = previous; let updates = 0; const emitted = [];
  cw.toolbar = { visible: true, reposition: value => { target = value; updates++; } };
  cw.computeSelection = () => selection;
  cw.emitter = { has: () => true, emit: (_name, value) => { emitted.push(value); assert.equal(target, value); } };
  cw.emitSelection();
  assert.equal(target, selection, '새로 고른 범위를 도구 막대에 먼저 반영');
  cw.emitSelection();
  assert.equal(updates, 1, '같은 선택의 반복 알림은 재배치하지 않음');
  selection = null; cw.emitSelection();
  assert.equal(target, null, '선택 해제도 도구 막대에 전달');
  assert.equal(emitted.length, 2);
  cw.toolbar.visible = false; cw.emitter.emit = (_name, value) => emitted.push(value);
  selection = previous; cw.emitSelection();
  assert.equal(updates, 2, '닫힌 도구 막대를 자동으로 열지 않음');
});

// 2026-11-19 칸 짝짓기(pairNested)의 값: 칸 문단을 하나 넣거나 지우면(Enter·합치기) 표의 칸 목록 길이가 달라져 lcsPairs 가
// 두 목록의 모든 쌍을 견준다 — 칸 1,936개 표에서 375만 번이고 그때마다 표 순번 정규식을 돌려 편집 뒤의 정렬이 0.2초였다.
// 견줌에 쓰는 값은 항목마다 한 번만 구하고, 앞에서부터 같은 항목은 표를 만들지 않고 짝짓는다. 짝은 전과 같아야 한다.
const pairing = load('align.ts', 'pairNested, lcsPairsAfterCommonPrefix', { planBody, charOps, foldOwners, alignOffsets, lcsPairs, rhwpNestedList, ...util });

test('칸 짝짓기: 같은 앞부분을 건너뛴 LCS 는 lcsPairs 와 같은 짝을 같은 차례로 낸다', () => {
  let seed = 20261119;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (n) => Math.floor(rand() * n);
  const list = () => Array.from({ length: pick(14) }, () => 'abca'[pick(4)]);   // 같은 값이 겹치는 목록
  const eq = (x, y) => x === y;
  for (let n = 0; n < 4000; n++) {
    const a = list();
    // 절반은 앞부분이 같은 목록(문단 하나를 넣거나 지운 꼴), 절반은 아무 목록
    const b = n % 2 ? list() : (() => { const copy = a.slice(); const at = pick(copy.length + 1); if (rand() < 0.5) copy.splice(at, 0, 'abca'[pick(4)]); else copy.splice(at, 1); return copy; })();
    assert.deepEqual(plain(pairing.lcsPairsAfterCommonPrefix(a, b, eq)), plain(lcsPairs(a, b, eq)), `${a.join('')} / ${b.join('')}`);
  }
});

test('칸 짝짓기: 큰 표의 칸에 문단을 넣어도 모든 쌍을 견주지 않고 같은 자리 짝을 낸다', () => {
  const cells = 400;
  const base = Array.from({ length: cells }, (_, c) => ({ ref: `s0/p3/n${c}`, text: `칸 ${c % 7}`, parent: 's0/p3', container: 'hp:tbl', cell: { table: 's0/p3#t0', row: Math.floor(c / 4), col: c % 4, rowSpan: 1, colSpan: 1 } }));
  const itemsAfter = (at) => {
    const out = [];
    for (let c = 0; c < cells; c++) {
      const shape = { kind: 'cell', tableOrd: 0, row: Math.floor(c / 4), col: c % 4, rowSpan: 1, colSpan: 1 };
      out.push({ pos: { sec: 0, parentPara: 3, controlIdx: 0, cellIdx: c, cellParaIdx: 0 }, text: `칸 ${c % 7}`, ...shape });
      if (c === at) out.push({ pos: { sec: 0, parentPara: 3, controlIdx: 0, cellIdx: c, cellParaIdx: 1 }, text: '새 문단', ...shape });
    }
    return out;
  };
  for (const at of [cells - 1, cells / 2, 0]) {
    const items = itemsAfter(at);
    let reads = 0;
    // 표 순번을 읽는 횟수 = 모양 견줌 횟수의 어림. 전에는 두 목록의 모든 쌍(n×m — 여기서는 16만 번)마다 읽었다.
    const counted = items.map((item) => ({ ...item, get tableOrd() { reads++; return item.tableOrd; } }));
    const result = pairing.pairNested(base, counted);
    assert.equal(result.structure, false);
    assert.equal(result.pairs.length, cells);
    // 기준 칸 c 는 넣은 문단 뒤에서 한 칸씩 밀린 항목과 짝이다(넣은 문단은 짝 없음)
    assert.deepEqual(plain(result.pairs), Array.from({ length: cells }, (_, c) => [c, c > at ? c + 1 : c]));
    assert.ok(reads <= items.length * 8, `표 순번 읽기 ${reads}회(항목 ${items.length}개) — 쌍마다 읽지 않는다`);
  }
});
