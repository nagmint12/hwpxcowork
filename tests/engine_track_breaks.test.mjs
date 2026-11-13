// node --test tests/engine_track_breaks.test.mjs — 문단 나눔 변경 추적(2026-10-30, 엔진 — 한/글 paraend="1").
//  - 파서: 짝 맞는 지운 나눔(deleteBegin/deleteEnd paraend="1", 뒤에 글자 없음)으로 끝나는 본문 물리 문단과 다음 본문 물리 문단은 한 기록(members) —
//    최종본 ref·글·중첩 번호(/n·/d·#t)가 평탄화 사본(작업본)과 같다. 속성은 leader(내용이 남는 첫 member — 한/글 실측)
//  - changes(): kind 'para'·label·paraEnd·scope 'paragraph', 폭 0 나눔은 start = end
//  - 수락은 최종본을 바꾸지 않는다(물리 합침), 지운 나눔 거절 = 가름, 넣은 나눔 거절 = 합침(빈 줄 없음) — 문단 기록(takeParaLog)
//  - 쓰는 쪽: deleteBreakAfter·insertParagraphAfter({ trackBreak })
//  - 불변식: diffDocs(D, D.viewerCopy()) 덩어리 0 · sameBodyTexts · 편집기(rhwp) 왕복 0 · 모두 거절 = 원래 · 묶음 acceptAll 은 구역 다시 읽기를 늘리지 않는다
// 한/글 2022 실측 파일: tests/fixtures/hangul_trk_brk_*.hwpx(바탕 = hangul_trk_brk_base: 문단 0~3, 문단 모양 0·1·2·0)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { Section } from '../engine/section.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const SAMPLE = path.join(here, 'samples', '2025년_전체종합보고서.hwpx');
const RHWP = path.join(here, '..', 'vendor', 'rhwp', 'pkg');
const hasRhwp = fs.existsSync(path.join(RHWP, 'rhwp_bg.wasm'));
let rhwpMod = null;
const rhwp = () => (rhwpMod ??= (async () => {
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import(pathToFileURL(path.join(RHWP, 'rhwp.js')).href);
  if (!(globalThis.__rhwpEngineReady ??= new Set()).has(RHWP)) {
    const wasm = fs.readFileSync(path.join(RHWP, 'rhwp_bg.wasm'));
    if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });
    globalThis.__rhwpEngineReady.add(RHWP);
  }
  return mod;
})());

const AUTHOR = '검토자';
const DATE = new Date(Date.UTC(2026, 9, 30, 1, 2, 3));
const A = { author: AUTHOR, date: DATE };
const T0 = '첫째 문단입니다.'; const T1 = '둘째 문단입니다. 여기에 개체를 넣습니다.'; const T2 = '셋째 문단입니다.'; const T3 = '넷째 문단입니다.';
const reload = async (d) => HwpxDoc.load(await d.save());
const base = () => HwpxDoc.load(fx('hangul_trk_brk_base.hwpx'));

const body = (d) => d.sections.map((s) => s.xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>|<hp:linesegarray\/>/g, ''));
const marks = (d) => d.sections.reduce((n, s) => n + (s.xml.match(/<hp:(?:insert|delete)(?:Begin|End)\b/g) || []).length, 0);
const texts = (d) => d.paragraphs({ nested: false }).map((p) => p.text);
const rows = (d, view) => d.paragraphs(view ? { view } : undefined).map((p) => [p.ref, p.text]);
const attrs = (d) => d.sections[0].bodyParas.map((p) => { const f = d.inspectFormatting(p.ref); return `${f.paraPrId}/${f.styleId}`; });
const changeRows = (d) => d.changes().map((c) => [c.id, c.type, c.ref, c.kind ?? null, c.label ?? null, c.scope ?? null, c.start, c.end, c.text]);
const groups = (d) => d.sections.flatMap((s) => s.bodyParas.filter((p) => p.members).map((p) => [p.ref, p.members.length, p.leader]));

/** 문단 ref 마지막 물리 문단의 글 끝 뒤에 xml 을 그대로 끼운다(손으로 쓴 표식) */
function injectEnd(d, ref, xml) {
  const { sec, p } = d.resolve(ref);
  const c = p.chars[p.chars.length - 1];
  sec.load(sec.xml.slice(0, c.raw[1]) + xml + sec.xml.slice(c.raw[1]));
}
/** 폭 0 나눔 표식 쌍(머리 항목을 만든다) → [id, xml] */
function zwMarks(d, type = 'Delete', author = AUTHOR) {
  const id = d.header.addChange(type, d.header.ensureAuthor(author), DATE);
  if (!d.trackingEnabled()) d.setTracking(true);
  const b = type === 'Insert' ? 'insert' : 'delete';
  return [id, `<hp:${b}Begin Id="${id}" TcId="${id}"/><hp:${b}End Id="${id}" TcId="${id}" paraend="1"/>`];
}

/** server/live.js sameBodyTexts 와 같은 비교(본문·칸 글, 서식 지문, 개체 지문) */
function sameBody(a, b) {
  const X = a.bodyEntries(); const Y = b.bodyEntries();
  if (Object.keys(X).length !== Object.keys(Y).length) return false;
  for (const s of Object.keys(X)) {
    const x = X[s]; const y = Y[s];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i].text !== y[i].text || x[i].nested.length !== y[i].nested.length) return false;
      if (a.formattingFingerprint(`s${s}/p${i}`) !== b.formattingFingerprint(`s${s}/p${i}`)) return false;
      if (a.objectPrint(`s${s}/p${i}`) !== b.objectPrint(`s${s}/p${i}`)) return false;
      for (let k = 0; k < x[i].nested.length; k++) {
        if (x[i].nested[k].text !== y[i].nested[k].text) return false;
        if (a.formattingFingerprint(x[i].nested[k].ref) !== b.formattingFingerprint(y[i].nested[k].ref)) return false;
        if (a.objectPrint(x[i].nested[k].ref) !== b.objectPrint(y[i].nested[k].ref)) return false;
      }
    }
  }
  return true;
}

/**
 * 최종본 보기 불변식(A1): 최종본 ref·글 = 평탄화 사본 = viewerCopy(rhwp 번호), bodyEntries·서식·개체 지문(sameBodyTexts) 같음,
 * diffDocs(D, viewerCopy) 덩어리 0(엄격·너그러운 사본 모두), 모두 수락 본문 = 평탄화 본문 → viewerCopy
 */
async function invariants(d, label) {
  const f = await d.flattened();
  assert.deepEqual(rows(d), rows(f), `${label}: 최종본 ref·글 = 평탄화 사본`);
  assert.deepEqual(d.bodyEntries(), f.bodyEntries(), `${label}: bodyEntries`);
  assert.deepEqual(d.tables().map((t) => [t.key, t.ref]), f.tables().map((t) => [t.key, t.ref]), `${label}: tables`);
  const v = await d.viewerCopy();
  assert.deepEqual(d.paragraphs({ view: 'final' }).map((p) => p.ref), v.paragraphs().map((p) => p.ref), `${label}: ref = viewerCopy ref`);
  assert.ok(sameBody(d, v), `${label}: sameBodyTexts(D, viewerCopy)`);
  const r = await diffDocs(d, v);
  assert.deepEqual(r.hunks.map((h) => [h.type, h.ref, h.formatSummary ?? '']), [], `${label}: diffDocs(D, viewerCopy)`);
  assert.deepEqual(r.unsupported, [], `${label}: diffDocs unsupported`);
  assert.deepEqual((await diffDocs(d, await d.viewerCopy({ tolerant: true }))).hunks, [], `${label}: tolerant viewerCopy`);
  const ac = await d.clone(); ac.acceptAll();
  assert.deepEqual(body(ac), body(f), `${label}: acceptAll 본문 = 평탄화 본문`);
  assert.equal(groups(f).length, 0, `${label}: 사본에 묶음 없음`);
  return v;
}

/** 편집기(rhwp) 왕복: viewerCopy → rhwp → exportHwpx → diffDocs(D, 그것) 덩어리 0 */
async function rhwpRoundTrip(d, v, label) {
  if (!hasRhwp) return;
  const mod = await rhwp();
  const doc = new mod.HwpDocument(new Uint8Array(await v.save()));
  const back = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  assert.deepEqual((await diffDocs(v, back)).hunks.map((h) => [h.type, h.ref]), [], `${label}: 편집기 왕복(사본)`);
  assert.deepEqual((await diffDocs(d, back)).hunks.map((h) => [h.type, h.ref]), [], `${label}: 편집기 왕복 diffDocs(D, back)`);
}

/** 모두 거절 = 원래 본문(줄 정보 뺌) */
async function rejectsTo(d, orig, label) {
  const rj = await d.clone(); rj.rejectAll();
  assert.equal(marks(rj), 0, `${label}: 모두 거절 표식`);
  assert.deepEqual(body(rj), body(orig), `${label}: 모두 거절 = 원래`);
  return rj;
}

/** 바탕 + 표만 든 문단(추적 없이) — afters: 표를 넣을 본문 번호들(뒤에서부터 넣는다) */
async function withTables(afters, rowsOf = (i) => [[`가${i}`, `나${i}`], [`다${i}`, `라${i}`]]) {
  const d = await base();
  [...afters].sort((x, y) => y - x).forEach((a, i) => d.insertTableAfter(0, a, { rows: rowsOf(i), headerRows: 1, caption: '' }, A));
  return reload(d);
}

/** 문단 통째 지우기(글 지움 + 앞 나눔 지움 — 실시간 반영 2차 차례와 같다) */
function deleteParagraph(d, k) {
  const len = [...d.text(`s0/p${k}`)].length;
  if (len) d.deleteTracked(`s0/p${k}`, 0, len, A);
  d.removeOwnObjectsTracked(`s0/p${k}`, A);
  return d.deleteBreakAfter(`s0/p${k - 1}`, A);
}

const seeded = (s) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ───────── T1 파서 ─────────

test('T1 파서: 지운 나눔으로 이은 물리 문단 = 최종본 한 문단 · 묶지 않는 것 · 표본 보고서에는 묶음 없음', async () => {
  const d = await base();
  const [id, x] = zwMarks(d);
  injectEnd(d, 's0/p1', x);
  assert.deepEqual(texts(d), [T0, T1 + T2, T3]);
  assert.deepEqual(groups(d), [['s0/p1', 2, 0]]);
  const p = d.resolve('s0/p1').p;
  assert.deepEqual(Section.members(p).map((m) => [m.c0, m.r0]), [[0, 0], [[...T1].length, 1]]);
  assert.deepEqual(Section.breakOf(p, 0), { type: 'Delete', id: String(id), begin: Section.breakOf(p, 0).begin, end: Section.breakOf(p, 0).end, zw: true });
  assert.equal(Section.breakOf(p), null);
  assert.equal(Section.linesegs(p).length, 0);
  assert.equal(d.text('s0/p1', 'original'), `${T1}\n${T2}`);
  assert.equal(d.text('s0/p1', 'markup'), `${T1}[-¶-]${T2}`);
  await invariants(d, '폭 0 지운 나눔');

  // 묶지 않는 것: 짝 없는 끝(시작 없음) · 문단을 넘는 범위 · 넣은 나눔 · 구역 마지막 문단 · 뒤에 글자가 있는 나눔
  const cases = {
    orphan: (q) => injectEnd(q, 's0/p1', zwMarks(q)[1].replace(/<hp:deleteBegin[^>]*\/>/, '')),
    span: (q) => { const [i] = zwMarks(q); injectEnd(q, 's0/p1', `<hp:deleteBegin Id="${i}" TcId="${i}"/>`); injectEnd(q, 's0/p2', `<hp:deleteEnd Id="${i}" TcId="${i}" paraend="1"/>`); },
    insert: (q) => injectEnd(q, 's0/p1', zwMarks(q, 'Insert')[1]),
    last: (q) => injectEnd(q, 's0/p3', zwMarks(q)[1]),
    mid: (q) => { const { sec, p } = q.resolve('s0/p1'); const c = p.chars[3]; sec.load(sec.xml.slice(0, c.raw[1]) + zwMarks(q)[1] + sec.xml.slice(c.raw[1])); },
  };
  for (const [name, make] of Object.entries(cases)) {
    const q = await base(); make(q);
    assert.equal(q.paragraphs({ nested: false }).length, 4, name);
    assert.deepEqual(groups(q), [], name);
  }

  // 중첩 번호: 두 표 문단을 이으면 칸 /n·표 #t 가 기록 안에서 이어진다(평탄화 사본과 같다)
  const t = await withTables([1, 1]); // s0/p2 = 표(가0…), s0/p3 = 표(가1…)
  assert.deepEqual(t.tables().map((x) => x.key), ['s0/p2#t0', 's0/p3#t0']);
  const [, tx] = zwMarks(t);
  t.sections[0].load(t.sections[0].xml.slice(0, t.resolve('s0/p2').p.runs.at(-1).end - '</hp:run>'.length) + `<hp:t>${tx}</hp:t>` + t.sections[0].xml.slice(t.resolve('s0/p2').p.runs.at(-1).end - '</hp:run>'.length));
  assert.deepEqual(groups(t), [['s0/p2', 2, 0]]);
  assert.deepEqual(t.tables().map((x) => x.key), ['s0/p2#t0', 's0/p2#t1']);
  assert.equal(t.tables()[1].cells[0].refs[0], 's0/p2/n4');
  await invariants(t, '표 둘 이음');

  // 표본 보고서(paraend="1" 없음): 어느 기록에도 members 없음
  if (fs.existsSync(SAMPLE)) {
    const s = await HwpxDoc.load(fs.readFileSync(SAMPLE));
    assert.equal(s.sections.flatMap((x) => x.paras).filter((q) => q.members).length, 0);
  }
});

// ───────── T2 changes() · 한/글 파일 ─────────

test('T2 changes(): 나눔 kind para·label·scope·start=end · 한/글 저장본(b꼴·a꼴·빈 앞 문단·넣음·가름)의 최종본 = 한/글 모두 수락 결과', async () => {
  const d = await base();
  deleteParagraph(d, 2);
  assert.deepEqual(changeRows(d), [
    [1, 'Delete', 's0/p1', null, null, 'paragraph', 23, 23, T2],
    [2, 'Delete', 's0/p1', 'para', '문단 나눔 지움', null, 23, 23, ''],
  ]);
  assert.equal(d.changes()[1].paraEnd, true);
  assert.equal(d.text('s0/p1', 'markup'), `${T1}[-¶-][-${T2}-]`);
  const n = await base();
  assert.equal(n.insertParagraphAfter(0, 1, '새 문단', { ...A, trackBreak: true }), 's0/p2');
  assert.deepEqual(changeRows(n), [
    [1, 'Insert', 's0/p2', null, null, null, 0, 4, '새 문단'],
    [2, 'Insert', 's0/p1', 'para', '문단 나눔 넣음', null, 23, 23, ''],
  ]);

  // 한/글 2022 가 저장한 파일 — 모두 수락한 한/글 결과(문단 글·문단 모양/스타일, 2026-10-30 실측)가 우리 최종본과 같다
  const hangul = [
    // Delete(문단 끝) = 앞 문단 끝 폭 0 지운 나눔 + 뒤 문단 ParaShape(한/글이 앞 문단 모양으로) — 앞 문단 속성
    ['hangul_trk_brk_del_end.hwpx', [T0, T1 + T2, T3], ['0/0', '1/1', '0/0'], [[1, 'Delete', 's0/p1', 'para', '문단 나눔 지움', null, 23, 23, '']]],
    // 앞 나눔 + 문단 글 골라 지움 = b꼴(폭 0 나눔 + 글 지움 따로)
    ['hangul_trk_brk_sel_prev.hwpx', [T0, T1, T3], ['0/0', '1/1', '0/0'], [[1, 'Delete', 's0/p1', null, null, 'paragraph', 23, 23, T2], [2, 'Delete', 's0/p1', 'para', '문단 나눔 지움', null, 23, 23, '']]],
    // 문단 + 그 나눔 골라 지움 = a꼴(글과 나눔 한 범위) — 비게 된 문단은 자리를 내주고 뒤 문단 태그(한/글이 ParaShape 로 앞 문단 모양을 준 것)
    ['hangul_trk_brk_sel_para.hwpx', [T0, T1, T3], ['0/0', '1/1', '2/0'], [[1, 'Delete', 's0/p2', 'para', '글과 문단 나눔 지움', 'paragraph', 0, 0, T2]]],
    // 빈 줄 끝에서 Delete = b꼴이지만 빈 앞 문단이 자리를 내준다
    ['hangul_trk_brk_empty_first.hwpx', [T0, T2, T3], ['0/0', '1/2', '0/0'], [[1, 'Delete', 's0/p1', 'para', '문단 나눔 지움', null, 0, 0, '']]],
    // 끝에서 Enter 뒤 입력 = 앞 문단 넣은 나눔 + 새 문단 글 넣음
    ['hangul_trk_brk_enter_type.hwpx', [T0, T1, '새 문단', T2, T3], ['0/0', '1/1', '1/1', '2/2', '0/0'], null],
    // 가운데 Enter = 앞쪽 반 넣은 나눔, 뒤쪽 반은 같은 속성의 새 문단
    ['hangul_trk_brk_enter_mid.hwpx', [T0, '둘째 문단', '입니다. 여기에 개체를 넣습니다.', T2, T3], ['0/0', '1/1', '1/1', '2/2', '0/0'], null],
  ];
  for (const [name, want, wantAttrs, wantRows] of hangul) {
    const h = await HwpxDoc.load(fx(name));
    assert.deepEqual(texts(h), want, name);
    assert.deepEqual(attrs(h), wantAttrs, `${name}: 속성 = 한/글 모두 수락`);
    if (wantRows) assert.deepEqual(changeRows(h), wantRows, name);
    const v = await invariants(h, name);
    await rhwpRoundTrip(h, v, name);
    const ac = await h.clone(); ac.acceptAll();
    assert.deepEqual([texts(ac), attrs(ac), marks(ac)], [want, wantAttrs, 0], `${name}: 모두 수락`);
    const rj = await h.clone(); rj.rejectAll();
    assert.deepEqual([texts(rj), marks(rj)], [[T0, name.includes('empty_first') ? '' : T1, T2, T3], 0], `${name}: 모두 거절 = 원래 네 문단`);
  }
});

// ───────── T3·T4 불변식 · 하나씩 수락·거절 · 문단 기록 ─────────

test('T4 하나씩: 지운 나눔 수락 = 물리 합침(최종본 그대로) · 거절 = 가름(문단 기록 split) · 넣은 나눔 거절 = 합침(merge, 이음매 run 접음) · 섞인 목록', async () => {
  const o = await base();
  const d = await o.clone(); deleteParagraph(d, 2); // 1 = 글 지움, 2 = 나눔 지움
  const v = await invariants(d, '문단 지움');
  await rhwpRoundTrip(d, v, '문단 지움');
  await rejectsTo(d, o, '문단 지움');
  // 나눔만 거절 → 지운 글이 제 문단으로(빈 줄 아님 — 글 지움은 남음)
  const r1 = await d.clone(); r1.rejectChange(2);
  assert.deepEqual(texts(r1), [T0, T1, '', T3]);
  assert.deepEqual(r1.takeParaLog(), [{ sec: 0, op: 'split', at: 1, n: 0, d: 0, t: 0, td: 0 }]);
  assert.deepEqual(changeRows(r1), [[1, 'Delete', 's0/p2', null, null, null, 0, 0, T2]]);
  // 나눔만 수락 → 최종본 그대로, 문단 기록 없음. 그다음 글 수락
  const a1 = await d.clone(); a1.acceptChange(2);
  assert.deepEqual([texts(a1), a1.takeParaLog(), groups(a1)], [[T0, T1, T3], [], []]);
  a1.acceptChange(1);
  assert.deepEqual([texts(a1), marks(a1)], [[T0, T1, T3], 0]);
  // 섞인 목록(글·나눔 함께): 글을 먼저 풀어 합칠 때 빈 run 을 버린다 = 평탄화 본문
  const a2 = await d.clone(); a2.resolveChanges([1, 2], 'accept');
  assert.deepEqual(body(a2), body(await d.flattened()));
  const r2 = await d.clone(); r2.resolveChanges([2, 1], 'reject');
  assert.deepEqual(body(r2), body(o));

  // 넣은 문단: 나눔만 거절 → 넣은 글이 앞 문단 끝으로(한/글과 같다), 이음매 run 하나로
  const n = await o.clone(); n.insertParagraphAfter(0, 1, '새 문단', { ...A, trackBreak: true });
  await invariants(n, '문단 넣음');
  await rejectsTo(n, o, '문단 넣음');
  const nr = await n.clone(); nr.rejectChange(2);
  assert.deepEqual(texts(nr), [T0, T1 + '새 문단', T2, T3]);
  assert.deepEqual(nr.takeParaLog(), [{ sec: 0, op: 'merge', at: 1, n: 0, d: 0, t: 0, td: 0 }]);
  assert.equal(nr.resolve('s0/p1').p.runs.length, 1, '이음매 run 접음');
  nr.rejectChange(1);
  assert.deepEqual(body(nr), body(o));
  // 글 먼저 거절하면 빈 새 문단은 합칠 때 버려진다
  const nr2 = await n.clone(); nr2.rejectChange(1); nr2.rejectChange(1);
  assert.deepEqual(body(nr2), body(o));

  // 표 문단 가름·합침의 수(n·d·t·td): 표 둘을 이은 묶음의 나눔 거절 → 첫 부분 = 첫 표(칸 4 · 표 1)
  const t = await withTables([1, 1]);
  const tt = await t.clone(); tt.deleteBreakAfter('s0/p2', A);
  assert.deepEqual(groups(tt), [['s0/p2', 2, 0]]);
  await invariants(tt, '표 문단 이음');
  tt.rejectChange(tt.changes().find((c) => c.kind === 'para').id);
  assert.deepEqual(tt.takeParaLog(), [{ sec: 0, op: 'split', at: 2, n: 4, d: 0, t: 1, td: 0 }]);
  assert.deepEqual(body(tt), body(t));
});

// ───────── T5 묶음 안 글 편집 ─────────

test('T5 묶음 안 글: 경계에 넣기 · 경계를 넘는 지우기·바꾸기(member 마다 지움) · 메모 · 글자 모양 · 무작위 mergeParagraphText', async () => {
  const o = await base();
  const j = await o.clone(); j.deleteBreakAfter('s0/p1', A); // [P1, P2] 이음(글은 그대로)
  const jt = T1 + T2; const L = [...T1].length;
  // 경계에 넣기 → 앞 글자 뒤·나눔 표식 앞(묶음 그대로)
  const a = await j.clone(); a.insertTracked('s0/p1', L, '★', A);
  assert.deepEqual([a.text('s0/p1'), groups(a)], [T1 + '★' + T2, [['s0/p1', 2, 0]]]);
  assert.match(a.sections[0].xml, /넣습니다\.<hp:insertBegin Id="2" TcId="2"\/>★<hp:insertEnd Id="2" TcId="2" paraend="0"\/><hp:deleteBegin Id="1"/);
  await invariants(a, '경계 넣기');
  // 경계를 넘는 지우기: member 마다 지움 하나(OVERLAP 없음)
  const b = await j.clone(); const r = b.deleteTracked('s0/p1', L - 3, L + 2, A);
  assert.equal(r.deleteIds.length, 2);
  assert.equal(b.text('s0/p1'), [...jt].slice(0, L - 3).join('') + [...jt].slice(L + 2).join(''));
  assert.deepEqual(b.changes().filter((c) => !c.kind).map((c) => [c.ref, c.text]), [['s0/p1', '니다.'], ['s0/p1', '셋째']]);
  await invariants(b, '경계 넘는 지우기');
  await rejectsTo(b, o, '경계 넘는 지우기');
  const c = await j.clone(); c.replaceTracked('s0/p1', L - 1, L + 1, '바꿈', A);
  assert.equal(c.text('s0/p1'), [...jt].slice(0, L - 1).join('') + '바꿈' + [...jt].slice(L + 1).join(''));
  await invariants(c, '경계 넘는 바꾸기');
  // 메모가 member 를 넘는다
  const m = await j.clone(); m.addMemo('s0/p1', { start: L - 2, end: L + 3, author: AUTHOR, text: '경계 메모', date: DATE });
  assert.deepEqual(m.memos().map((x) => [x.ref, x.start, x.end, x.anchorText]), [['s0/p1', L - 2, L + 3, [...jt].slice(L - 2, L + 3).join('')]]);
  await invariants(m, '경계 메모');
  // 글자 모양(굵게)이 member 를 넘는다
  const f = await j.clone(); f.formatRange('s0/p1', { start: L - 2, end: L + 2, char: { bold: true } });
  assert.equal(f.inspectFormatting('s0/p1').runs.length, 3);
  await invariants(f, '경계 굵게');
  // 무작위 목표 글
  const rnd = seeded(30);
  const pool = [...'가나다라 마바사.아자'];
  for (let round = 0; round < 25; round++) {
    const q = await j.clone();
    const cps = [...jt];
    let want = '';
    for (let i = 0; i < cps.length; i++) { const x = rnd(); if (x < 0.08) continue; if (x < 0.14) want += pool[Math.floor(rnd() * pool.length)]; want += cps[i]; }
    if (rnd() < 0.3) want += '끝';
    q.mergeParagraphText('s0/p1', want, A);
    assert.equal(q.text('s0/p1'), want, `round ${round}`);
    assert.deepEqual(texts(q).length, 3, `round ${round}`);
    if (round % 5 === 0) await invariants(q, `무작위 ${round}`);
    const rj = await q.clone(); rj.rejectAll();
    assert.deepEqual(body(rj), body(o), `round ${round}: 모두 거절`);
  }
});

// ───────── T6 쓰는 쪽 ─────────

test('T6 deleteBreakAfter·insertParagraphAfter({ trackBreak }) · removeBodyParagraph 넣은 나눔 정리', async () => {
  const o = await base();
  // 보통 → b꼴 지운 나눔 { id, merged:false }
  const d = await o.clone(); d.deleteTracked('s0/p2', 0, 9, A);
  assert.deepEqual(d.deleteBreakAfter('s0/p1', A), { id: 2, merged: false });
  assert.equal(d.takeParaLog().length, 0, '쓰는 쪽은 문단 기록을 남기지 않는다');
  // 연속 둘(뒤에서부터 — 실시간 반영 2차)
  const e = await o.clone(); e.deleteTracked('s0/p2', 0, 9, A); e.deleteTracked('s0/p3', 0, 9, A);
  assert.deepEqual([e.deleteBreakAfter('s0/p2', A), e.deleteBreakAfter('s0/p1', A)], [{ id: 3, merged: false }, { id: 4, merged: false }]);
  assert.deepEqual([texts(e), groups(e)], [[T0, T1], [['s0/p1', 3, 0]]]);
  await invariants(e, '연속 지우기');
  await rejectsTo(e, o, '연속 지우기');
  // 내가 넣고 처리 안 된 문단 지우기 → 넣음 거절(변경 0)
  const own = await o.clone(); own.insertParagraphAfter(0, 1, '새 문단', { ...A, trackBreak: true });
  own.rejectChange(1);
  assert.deepEqual(own.deleteBreakAfter('s0/p1', A), { id: null, merged: true });
  assert.deepEqual([own.changes(), body(own)], [[], body(o)]);
  // 남이 넣은 나눔 → 수락 뒤 지운 나눔
  const other = await o.clone(); other.insertParagraphAfter(0, 1, '남의 문단', { author: '다른 사람', date: DATE, trackBreak: true });
  other.acceptChange(1); other.deleteTracked('s0/p2', 0, 5, A);
  assert.deepEqual(other.deleteBreakAfter('s0/p1', A), { id: 2, merged: false });
  assert.deepEqual([texts(other), other.changes().map((c) => [c.type, c.author, c.kind ?? null])], [[T0, T1, T2, T3], [['Delete', AUTHOR, null], ['Delete', AUTHOR, 'para']]]);
  // 빈 앞 문단 뒤 문단 지우기 → 지운 문단 자기 나눔(빈 줄이 제 속성을 지킨다 — 한/글 수락 규칙)
  const em = await HwpxDoc.load(fx('hangul_trk_brk_empty_first.hwpx')); em.rejectAll();
  const emo = await reload(em);
  const ed = await emo.clone(); ed.deleteTracked('s0/p2', 0, 9, A);
  const eb = ed.deleteBreakAfter('s0/p1', A); // (한/글 파일의 ParaShape 머리 항목이 남아 번호는 그 뒤)
  assert.deepEqual(eb, { id: ed.changes().find((c) => c.kind === 'para').id, merged: false });
  assert.deepEqual([texts(ed), attrs(ed), groups(ed)], [[T0, '', T3], ['0/0', '1/1', '0/0'], [['s0/p2', 2, 1]]]);
  await invariants(ed, '빈 앞 문단');
  await rejectsTo(ed, emo, '빈 앞 문단');
  // 던짐
  assert.throws(() => o.deleteBreakAfter('s0/p3', A), (x) => x.code === 'LAST_PARAGRAPH');
  assert.throws(() => o.deleteBreakAfter('s0/p1', {}), (x) => x.code === 'NO_AUTHOR');
  assert.throws(() => o.deleteBreakAfter('s0/p9', A), (x) => x.code === 'NO_PARAGRAPH');
  const t = await withTables([1]);
  assert.throws(() => t.deleteBreakAfter('s0/p2/n0', A), (x) => x.code === 'NOT_BODY');
  const sb = await o.clone(); sb.flattenSections();
  { // 다음 문단 첫 run 에 구역 정의(파일 안 구역 나누기)
    const sec = sb.sections[0]; const p0 = sec.bodyParas[0]; const brk = /<hp:secPr\b[\s\S]*?<\/hp:secPr>/.exec(sec.xml)[0];
    const p2 = sec.bodyParas[2]; const at = sec.xml.indexOf('>', p2.runs[0].start) + 1;
    sec.load(sec.xml.slice(0, at) + brk + sec.xml.slice(at));
    assert.ok(p0);
    assert.throws(() => sb.deleteBreakAfter('s0/p1', A), (x) => x.code === 'SECTION_BREAK');
  }
  // insertParagraphAfter: 보통 · 넣은 나눔 뒤(둘째 넣기는 새 문단 자기 나눔) · 구역 첫머리
  const n = await o.clone();
  n.insertParagraphAfter(0, 1, '새 문단 2', { ...A, trackBreak: true });
  n.insertParagraphAfter(0, 1, '새 문단 1', { ...A, trackBreak: true });
  assert.deepEqual(texts(n), [T0, T1, '새 문단 1', '새 문단 2', T2, T3]);
  assert.deepEqual(n.changes().filter((c) => c.kind === 'para').map((c) => [c.ref, c.type]), [['s0/p1', 'Insert'], ['s0/p2', 'Insert']]);
  await invariants(n, '넣기 둘');
  await rejectsTo(n, o, '넣기 둘');
  const s = await o.clone();
  assert.equal(s.insertParagraphAfter(0, -1, '첫머리', { ...A, atStart: true, trackBreak: true }), 's0/p0');
  assert.deepEqual(s.changes().map((c) => [c.ref, c.kind ?? null, c.start, c.end]), [['s0/p0', null, 0, 3], ['s0/p0', 'para', 3, 3]]);
  assert.ok(s.hasSectionBreak('s0/p0'));
  await invariants(s, '첫머리 넣기');
  const sr = await s.clone(); sr.rejectAll();
  assert.deepEqual([texts(sr), sr.hasSectionBreak('s0/p0'), marks(sr)], [[T0, T1, T2, T3], true, 0]);
  // trackBreak 없으면 예전 그대로(표식 없음)
  const plain = await o.clone(); plain.insertParagraphAfter(0, 1, '새 문단', A);
  assert.equal(plain.changes().filter((c) => c.kind === 'para').length, 0);

  // removeBodyParagraph: 넣은 나눔 정리(나눔 상태 넷)
  const one = await o.clone(); one.insertParagraphAfter(0, 1, '새', { ...A, trackBreak: true }); one.removeBodyParagraph(0, 2);
  assert.deepEqual([one.changes(), body(one)], [[], body(o)], 'P{+¶+} N → N 지움: P 넣은 나눔도 지움');
  const two = await o.clone(); two.insertParagraphAfter(0, 1, '둘', { ...A, trackBreak: true }); two.insertParagraphAfter(0, 1, '하나', { ...A, trackBreak: true });
  const t1 = await two.clone(); t1.removeBodyParagraph(0, 2); // N1(자기 나눔 넣음) 지움 → P 넣은 나눔은 그대로(N2 를 넣은 나눔)
  assert.deepEqual([texts(t1), t1.changes().filter((c) => c.kind === 'para').map((c) => c.ref)], [[T0, T1, '둘', T2, T3], ['s0/p1']]);
  await rejectsTo(t1, o, 'N1 지움');
  const t2 = await two.clone(); t2.removeBodyParagraph(0, 3); // N2(원래 나눔) 지움 → N1 넣은 나눔도 지움
  assert.deepEqual([texts(t2), t2.changes().filter((c) => c.kind === 'para').map((c) => c.ref)], [[T0, T1, '하나', T2, T3], ['s0/p1']]);
  await rejectsTo(t2, o, 'N2 지움');
  const t3 = await o.clone(); t3.removeBodyParagraph(0, 2);
  assert.deepEqual(t3.changes(), [], '보통 나눔');
});

// ───────── T7 개체 ─────────

test('T7 표 문단 지우기(b꼴): 지운 표 안 문단은 묶음의 /d · 표만 거절하면 앞 문단 끝으로, 나눔까지 거절하면 제 문단으로', async () => {
  const o = await withTables([1]); // s0/p2 = 표 문단
  const d = await o.clone();
  assert.deepEqual(deleteParagraph(d, 2), { id: 2, merged: false });
  assert.deepEqual(changeRows(d).map((r) => r.slice(0, 5)), [[1, 'Delete', 's0/p1', 'object', '표 지움'], [2, 'Delete', 's0/p1', 'para', '문단 나눔 지움']]);
  assert.deepEqual(texts(d), [T0, T1, T2, T3]);
  assert.deepEqual(d.tables(), []);
  assert.ok(d.paragraphs({ view: 'markup' }).some((p) => p.ref === 's0/p1/d0' && p.hidden));
  const v = await invariants(d, '표 문단 지움');
  await rhwpRoundTrip(d, v, '표 문단 지움');
  await rejectsTo(d, o, '표 문단 지움');
  const r1 = await d.clone(); r1.rejectChange(1);
  assert.deepEqual([r1.tables().map((t) => t.key), texts(r1).length], [['s0/p1#t0'], 4]);
  await invariants(r1, '표만 거절');
  r1.rejectChange(1);
  assert.deepEqual([r1.tables().map((t) => t.key), body(r1)], [['s0/p2#t0'], body(o)]);
});

// ───────── T8 구역 ─────────

test('T8 구역: 묶음이 있는 문서의 flattenSections·splitSectionsAt', async () => {
  const d = await base();
  { // 둘째 구역: P2 머리에 구역 정의를 복사해 넣고 나눈다
    const sec = d.sections[0]; const brk = /<hp:secPr\b[\s\S]*?<\/hp:secPr>(<hp:ctrl>[\s\S]*?<\/hp:ctrl>)?/.exec(sec.xml)[0];
    const p2 = sec.bodyParas[2]; const at = sec.xml.indexOf('>', p2.runs[0].start) + 1;
    sec.load(sec.xml.slice(0, at) + brk + sec.xml.slice(at));
    assert.deepEqual(d.splitSectionsAt([2]), [2]);
  }
  d.deleteBreakAfter('s1/p0', A);
  assert.deepEqual(rows(d), [['s0/p0', T0], ['s0/p1', T1], ['s1/p0', T2 + T3]]);
  const before = rows(d);
  await invariants(d, '둘째 구역 묶음');
  const f = await d.clone();
  assert.deepEqual(f.flattenSections(), [2, 1]);
  assert.deepEqual(rows(f), [['s0/p0', T0], ['s0/p1', T1], ['s0/p2', T2 + T3]]);
  assert.throws(() => f.deleteBreakAfter('s0/p1', A), (x) => x.code === 'SECTION_BREAK');
  assert.deepEqual(f.splitSectionsAt([2]), [2]);
  assert.deepEqual(rows(f), before);
  await invariants(f, '다시 나눔');
});

// ───────── T9 너그러운 길 ─────────

test('T9 너그러운 길: _acceptLoose·_sweepChangeMarks 도 묶음을 합친다 · 무작위 폭 0 나눔(사본 글·문단 수 = 최종본)', async () => {
  const o = await base();
  const d = await o.clone(); deleteParagraph(d, 2);
  const l = await d.clone(); l._acceptLoose(2);
  assert.deepEqual([texts(l), groups(l), l.changes().map((c) => c.id)], [[T0, T1, T3], [], [1]]);
  const s = await d.clone(); s._sweepChangeMarks();
  assert.deepEqual([texts(s), groups(s), marks(s)], [[T0, T1, T3], [], 0]);
  // 무작위: 아무 문단 끝에 폭 0 지운 나눔·글 지움·넣음 — 사본 글·문단 수 = 최종본, 모두 거절 = 원래
  const rnd = seeded(9);
  for (let round = 0; round < 12; round++) {
    const q = await o.clone();
    for (let e = 0; e < 4; e++) {
      const k = Math.floor(rnd() * 4); const ref = `s0/p${Math.min(k, q.paragraphs({ nested: false }).length - 1)}`;
      const kind = Math.floor(rnd() * 3);
      try {
        if (kind === 0) q.deleteBreakAfter(ref, A);
        else if (kind === 1) { const n = [...q.text(ref)].length; if (n > 2) q.deleteTracked(ref, 1, Math.min(n, 1 + Math.ceil(rnd() * 4)), A); }
        else q.insertParagraphAfter(0, Number(ref.slice(4)), `넣${round}`, { ...A, trackBreak: true });
      } catch (x) { if (!['LAST_PARAGRAPH', 'OVERLAP', 'BREAK_STATE'].includes(x.code)) throw x; }
    }
    const want = texts(q);
    for (const tolerant of [false, true]) {
      const v = await q.viewerCopy({ tolerant });
      assert.deepEqual(texts(v), want, `round ${round} tolerant=${tolerant}`);
    }
    assert.deepEqual((await diffDocs(q, await q.viewerCopy())).hunks, [], `round ${round}: diffDocs`);
    await rejectsTo(q, o, `round ${round}`);
  }
});

// ───────── T10 physToFinalRef ─────────

test('T10 physToFinalRef: 묶기 전 물리 ref → 최종본 ref(뒤 member 의 /n·#t 를 민다)', async () => {
  const phys = await withTables([1, 1]); // 물리: s0/p2 표(칸 4), s0/p3 표(칸 4)
  const d = await phys.clone(); d.deleteBreakAfter('s0/p2', A);
  assert.equal(d.physToFinalRef('s0/p1'), 's0/p1');
  assert.equal(d.physToFinalRef('s0/p2'), 's0/p2');
  assert.equal(d.physToFinalRef('s0/p3'), 's0/p2');
  assert.equal(d.physToFinalRef('s0/p3/n1'), 's0/p2/n5');
  assert.equal(d.physToFinalRef('s0/p3#t0'), 's0/p2#t1');
  assert.equal(d.physToFinalRef('s0/p4'), 's0/p3');
  assert.equal(d.physToFinalRef('s0/p9'), null);
  for (const r of ['s0/p3/n1', 's0/p2/n0', 's0/p5']) assert.equal(d.text(d.physToFinalRef(r)), phys.text(r), r);
});

// ───────── T11 성능 ─────────

test('T11 성능: 표본 보고서에 나눔 변경 40개 — viewerCopy 의 구역 다시 읽기 수 = 변경 0 + 1, 시간도 변경 0 과 비슷', { skip: !fs.existsSync(SAMPLE) && '표본 없음' }, async () => {
  const s = await HwpxDoc.load(fs.readFileSync(SAMPLE));
  const d = await s.clone();
  const sec = d.sections[0];
  let made = 0;
  for (let k = sec.bodyParas.length - 3; k > 0 && made < 40; k -= 3) {
    const p = sec.bodyParas[k]; if (!p.chars.length || !sec.bodyParas[k + 1]?.chars.length) continue;
    try { d.deleteBreakAfter(p.ref, A); made++; } catch (x) { if (!['SECTION_BREAK', 'LAST_PARAGRAPH'].includes(x.code)) throw x; }
  }
  assert.equal(made, 40);
  assert.equal(d.changes().filter((c) => c.kind === 'para').length, 40);
  // 결정적인 잣대: viewerCopy 동안 구역 다시 읽기(Section.load) 수 — 묶음 acceptAll 은 변경 40개를 한 번에(변경 0 문서보다 한 번 더)
  const loads = async (doc) => {
    const orig = Section.prototype.load; let n = 0;
    Section.prototype.load = function (xml) { n++; return orig.call(this, xml); };
    try { await doc.viewerCopy(); } finally { Section.prototype.load = orig; }
    return n;
  };
  const [l0, l1] = [await loads(s), await loads(d)];
  assert.ok(l1 <= l0 + 1, `구역 다시 읽기 ${l1}번(변경 0: ${l0}번)`);
  // 시간(참고 — 같은 프로세스에서 번갈아 재고 가장 빠른 것끼리, 나란히 도는 시험 부하를 넉넉히 봐준다)
  let t0 = Infinity; let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    let a = performance.now(); await s.viewerCopy(); t0 = Math.min(t0, performance.now() - a);
    a = performance.now(); await d.viewerCopy(); t1 = Math.min(t1, performance.now() - a);
  }
  assert.ok(t1 <= t0 * 1.5 + 250, `viewerCopy ${t1.toFixed(0)}ms (변경 0: ${t0.toFixed(0)}ms)`);
  const v = await d.viewerCopy();
  assert.equal(v.paragraphs({ nested: false }).length, d.paragraphs({ nested: false }).length);
});

// ───────── T12 2단계: 가름·합침 알아보기 ─────────

test('T12 splitParagraphTracked(가운데 Enter = 앞쪽 {+¶+}, 뒤쪽은 추적 없이 옮김) · 걸친 넣음은 같은 번호로 · 묶음 안 가름 · joinPlan·splitPoints', async () => {
  const { joinPlan, splitPoints } = await import('../engine/diff.js');
  const o = await base();
  for (const [off, want] of [[0, ['', T1]], [5, ['둘째 문단', '입니다. 여기에 개체를 넣습니다.']], [23, [T1, '']]]) {
    const d = await o.clone();
    assert.deepEqual(d.splitParagraphTracked('s0/p1', off, A), { id: 1, ref: 's0/p2', n: 0, d: 0, t: 0, td: 0 }, `offset ${off}`);
    assert.deepEqual(texts(d), [T0, ...want, T2, T3], `offset ${off}`);
    assert.deepEqual(changeRows(d), [[1, 'Insert', 's0/p1', 'para', '문단 나눔 넣음', null, off, off, '']], `offset ${off}`);
    assert.deepEqual(attrs(d).slice(1, 3), ['1/1', '1/1'], `offset ${off}: 뒤쪽 반은 같은 속성`);
    assert.equal(d.takeParaLog().length, 0);
    const v = await invariants(d, `가름 ${off}`);
    if (off === 5) await rhwpRoundTrip(d, v, '가름');
    await rejectsTo(d, o, `가름 ${off}`);
  }
  // 한/글 가운데 Enter 저장본과 같은 꼴
  const h = await HwpxDoc.load(fx('hangul_trk_brk_enter_mid.hwpx'));
  const ours = await o.clone(); ours.splitParagraphTracked('s0/p1', 5, A);
  assert.deepEqual([texts(ours), ours.text('s0/p1', 'markup')], [texts(h), h.text('s0/p1', 'markup')]);
  // 처리 안 된 넣음 한가운데서 가름 → 앞쪽에서 닫고 뒤쪽에서 같은 번호로 다시 엶(모두 거절·수락이 둘 다 푼다)
  const g = await o.clone(); g.insertTracked('s0/p1', 5, '추가글', A);
  assert.deepEqual(g.splitParagraphTracked('s0/p1', 7, A).ref, 's0/p2');
  assert.deepEqual(changeRows(g).map((r) => [r[0], r[2], r[8]]), [[1, 's0/p1', '추가'], [1, 's0/p2', '글'], [2, 's0/p1', '']]);
  await invariants(g, '넣음에 걸친 가름');
  await rejectsTo(g, o, '넣음에 걸친 가름');
  const ga = await g.clone(); ga.acceptAll();
  assert.deepEqual([texts(ga), marks(ga)], [[T0, '둘째 문단추가', '글입니다. 여기에 개체를 넣습니다.', T2, T3], 0]);
  // 묶음(지운 나눔으로 이은 P1+P2) 안 뒤 member 에서 가름 → 앞쪽 [P1, P2 앞] · 뒤쪽 [P2 뒤]
  const j = await o.clone(); j.deleteBreakAfter('s0/p1', A);
  const jo = await j.clone();
  j.splitParagraphTracked('s0/p1', [...T1].length + 3, A);
  assert.deepEqual([texts(j), groups(j)], [[T0, T1 + '셋째 ', '문단입니다.', T3], [['s0/p1', 2, 0]]]);
  await invariants(j, '묶음 안 가름');
  const jr = await j.clone(); jr.rejectChange(2);
  assert.deepEqual(body(jr), body(jo));
  assert.throws(() => o.splitParagraphTracked('s0/p1', 99, A), (x) => x.code === 'RANGE');
  assert.throws(() => o.splitParagraphTracked('s0/p1', 1, {}), (x) => x.code === 'NO_AUTHOR');
  // 알아보기
  assert.deepEqual(joinPlan([T1, T2], T1 + T2), { join: true, joinCost: 0, replaceCost: [...T2].length * 2 });
  assert.equal(joinPlan(['', T2], T2).join, true);
  assert.deepEqual(joinPlan(['가나다라마바', '사아자'], '가나다라마바'), { join: true, joinCost: 3, replaceCost: 3 }); // 같으면 합침(나눔 지움 + 글 지움 — 같은 표식)
  assert.equal(joinPlan([T1], T1).join, false);
  assert.deepEqual(splitPoints(T1, ['둘째 문단', '입니다. 여기에 개체를 넣습니다.']), [5]);
  assert.deepEqual(splitPoints('abcdef', ['ab', 'cdXef']), [2]);
  assert.deepEqual(splitPoints('abcdef', ['abc', '', 'def']), [3, 3]);
  assert.equal(splitPoints('abc', ['zzz', 'yyy']), null);
  assert.equal(splitPoints('abc', ['abc']), null);
});

// ───────── T13 표·그림 문단 넣기의 나눔 ─────────

test('T13 insertTableAfter·insertPictureAfter({ trackBreak }): 표·그림 넣음과 나눔 넣음 둘 다 거절 = 빈 줄 없이 원래 XML, 수락 = 문단이 남는다', async () => {
  const zlib = (await import('node:zlib')).default;
  const png = (w, h) => {
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 120)]);
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]));
  };
  const o = await base();
  const cases = {
    표: (d) => d.insertTableAfter(0, 1, { rows: [['가', '나'], ['다', '라']], headerRows: 1, caption: '' }, { ...A, trackBreak: true }),
    그림: (d) => d.insertPictureAfter(0, 1, { data: png(40, 20), caption: '' }, { ...A, trackBreak: true }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const d = await o.clone();
    const r = make(d);
    assert.equal(r.ref, 's0/p2', name);
    const objIds = d.trackObjectInsert(r.ref, A);
    assert.deepEqual(d.changes().map((c) => [c.id, c.ref, c.kind, c.label]), [[r.breakId, 's0/p1', 'para', '문단 나눔 넣음'], [objIds[0], 's0/p2', 'object', `${name} 넣음`]], name);
    const v = await invariants(d, `${name} 문단 넣음`);
    await rhwpRoundTrip(d, v, `${name} 문단 넣음`);
    const rj = await d.clone(); rj.resolveChanges([r.breakId, ...objIds], 'reject');
    assert.deepEqual([texts(rj), body(rj)], [[T0, T1, T2, T3], body(o)], `${name}: 둘 다 거절`);
    const ac = await d.clone(); ac.resolveChanges([r.breakId, ...objIds], 'accept');
    assert.deepEqual([texts(ac).length, marks(ac), name === '표' ? ac.tables().length : ac.figures().length], [5, 0, 1], `${name}: 수락`);
    // 같은 자리에 하나 더 — 앞 나눔이 이미 넣은 나눔이면 새 문단 자기 나눔
    const r2 = make(d);
    assert.deepEqual(d.changes().filter((c) => c.kind === 'para').map((c) => [c.id, c.ref]), [[r.breakId, 's0/p1'], [r2.breakId, 's0/p2']], name);
    d.trackObjectInsert(r2.ref, A);
    await invariants(d, `${name} 둘`);
    await rejectsTo(d, o, `${name} 둘`);
  }
  const plain = await o.clone();
  assert.equal('breakId' in plain.insertTableAfter(0, 1, { rows: [['가']], headerRows: 0 }, A), false, 'trackBreak 없으면 반환 모양 그대로');
  assert.equal(plain.changes().filter((c) => c.kind === 'para').length, 0);
});
