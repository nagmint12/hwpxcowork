// node --test tests/engine4.test.mjs — v0.3 엔진 정렬·차이(V3_SPEC §4.1·§3.1·§3.2·§4.4).
// planBody 가 예전(v0.2) mergeBodyTexts 정렬과 같은지(그대로 옮긴 기준 함수 + backups 의 v0.2 엔진과 대조), 문단 종류 구분,
// charOps·merge3(글자 단위 3-way), bodyEntries, diffDocs(변경 요청 덩어리·hid·반영 안 되는 변경), 종류를 보는 mergeBodyTexts.
// 편집기 수정본 모양은 rhwp(vendor WASM) 내보내기로도 확인한다(표본이 있을 때).
// tests/samples·backups 는 git 에 없을 수 있다 — 없으면 그 시험만 건너뛴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffArrays } from 'diff';
import { HwpxDoc, diffDocs, realSectionHunks } from '../engine/doc.js';
import { planBody, diffEntries, charOps, merge3, similarity, entryKind } from '../engine/diff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const BIZ = path.join(here, 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'); // 표 5개
const hasBiz = fs.existsSync(BIZ);
const OLD_ENGINE = path.join(here, '..', 'backups', 'v0.2.0_2026-10-22', 'engine', 'doc.js'); // v0.2 엔진 사본(비교 기준)
const OldDoc = fs.existsSync(OLD_ENGINE) ? (await import(pathToFileURL(OLD_ENGINE).href)).HwpxDoc : null;
const RHWP = path.join(here, '..', 'vendor', 'rhwp', 'pkg'); // 편집기(rhwp WASM) — 수정본(편집기 내보내기)을 만들 때만 읽는다
const hasRhwp = fs.existsSync(path.join(RHWP, 'rhwp_bg.wasm'));
let rhwpMod = null;
const rhwp = () => (rhwpMod ??= (async () => {
  globalThis.measureTextWidth ??= (font, text) => text.length * 10; // 레이아웃용 폭 측정 스텁(refmap 시험과 같음)
  const mod = await import(pathToFileURL(path.join(RHWP, 'rhwp.js')).href);
  const wasm = fs.readFileSync(path.join(RHWP, 'rhwp_bg.wasm'));
  if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });
  return mod;
})());
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const author = '홍길동';
const DATE = new Date(Date.UTC(2026, 9, 22, 1, 2, 3));
const reload = async (d) => HwpxDoc.load(await d.save());
const strip = ({ hid, headRef, baseFormatFingerprint, newFormatFingerprint, formatting, ...rest }) => rest; // 글 변경 계약(서식 metadata는 formatting_engine 시험)

// ───────── 예전(v0.2) 정렬: engine/doc.js mergeBodyTexts 안에 있던 코드를 그대로 옮긴 기준 ─────────

function oldSimilarity(x, y) {
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let k = 0; k < x.length - 1; k++) { const g = x.slice(k, k + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hit = 0;
  for (let k = 0; k < y.length - 1; k++) { const g = y.slice(k, k + 2); const c = grams.get(g); if (c) { hit++; grams.set(g, c - 1); } }
  return (2 * hit) / (x.length + y.length - 2);
}

function oldAlignBlock(rem, add) {
  const r = rem.length; const a = add.length; const n = Math.min(r, a);
  const naive = () => {
    const ops = [];
    for (let k = 0; k < n; k++) ops.push({ op: 'pair', i: k, j: k });
    for (let k = n; k < a; k++) ops.push({ op: 'ins', j: k });
    for (let k = n; k < r; k++) ops.push({ op: 'del', i: k });
    return ops;
  };
  if (!n || r === a || r * a > 2500) return naive();
  const remShort = r < a; const S = remShort ? rem : add; const L = remShort ? add : rem;
  const sim = (i, j) => oldSimilarity(S[i], L[j]);
  const f = Array.from({ length: S.length + 1 }, () => new Array(L.length + 1).fill(-Infinity));
  for (let j = 0; j <= L.length; j++) f[0][j] = 0;
  for (let i = 1; i <= S.length; i++) for (let j = i; j <= L.length; j++) f[i][j] = Math.max(f[i][j - 1], f[i - 1][j - 1] + sim(i - 1, j - 1));
  const matched = []; let i = S.length; let j = L.length;
  while (i > 0) { if (j > i && f[i][j] === f[i][j - 1]) j--; else { matched.push([i - 1, j - 1]); i--; j--; } }
  matched.reverse();
  const ops = []; let li = 0;
  for (const [si, lj] of matched) {
    for (; li < lj; li++) ops.push(remShort ? { op: 'ins', j: li } : { op: 'del', i: li });
    ops.push(remShort ? { op: 'pair', i: si, j: lj } : { op: 'pair', i: lj, j: si }); li = lj + 1;
  }
  for (; li < L.length; li++) ops.push(remShort ? { op: 'ins', j: li } : { op: 'del', i: li });
  return ops;
}

/** 예전 mergeBodyTexts 의 짝·단계를 planBody 모양(목록 전체 번호)으로 */
function oldPlan(oldTexts, target) {
  const blocks = diffArrays(oldTexts, target);
  const plan = []; const pairs = []; let oi = 0; let ni = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.added && !b.removed) { for (let k = 0; k < b.value.length; k++) pairs.push([oi + k, ni + k]); oi += b.value.length; ni += b.value.length; continue; }
    let removed = []; let added = [];
    if (b.removed) {
      removed = b.value;
      const next = blocks[i + 1]; if (next && next.added) { added = next.value; i++; }
    } else added = b.value;
    const ops = oldAlignBlock(removed, added);
    for (const o of ops) if (o.op === 'pair') pairs.push([oi + o.i, ni + o.j]);
    const at = oi; const nj = ni;
    plan.push({ at, ops: ops.map((o) => (o.op === 'pair' ? { op: 'pair', i: at + o.i, j: nj + o.j } : o.op === 'del' ? { op: 'del', i: at + o.i } : { op: 'ins', j: nj + o.j })) });
    oi += removed.length; ni += added.length;
  }
  return { pairs, plan };
}

// ───────── 시험 도우미 ─────────

/** 고정 씨앗 난수(mulberry32) */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL = ['사업 개요와 추진 배경을 정리한다.', '2025년 예산 집행 현황은 다음과 같다.', '응답자 수는 전년 대비 늘었다.', '향후 과제와 개선 방안',
  '표 1. 연도별 응답자 수', '', '결론', '참고 문헌', '부록 A. 설문 문항', '조사 방법: 온라인 설문', '분석 결과 요약', '연구 진행 일정'];
const pick = (r, a) => a[Math.floor(r() * a.length)];
function mutate(r, s) {
  const k = Math.floor(r() * 4);
  if (!s || k === 0) return `${s}${s ? ' ' : ''}보완 문장`;
  const a = Math.floor(r() * s.length);
  if (k === 1) return `${s.slice(0, a)}새${s.slice(a)}`;
  if (k === 2) return s.slice(0, a) + s.slice(a + 1);
  return [...s].reverse().join('');
}
/** 무작위 옛 목록과, 넣기·지우기·고치기·옮기기·빈 줄로 만든 새 목록 */
function randomLists(r) {
  const old = Array.from({ length: Math.floor(r() * 13) }, () => (r() < 0.25 ? mutate(r, pick(r, POOL)) : pick(r, POOL)));
  const neu = old.slice();
  for (let e = Math.floor(r() * 6); e > 0; e--) {
    const k = Math.floor(r() * 6); const at = Math.floor(r() * (neu.length + 1)); const last = Math.min(at, neu.length - 1);
    if (k === 0) neu.splice(at, 0, pick(r, POOL));
    else if (k === 1 && neu.length) neu.splice(last, 1);
    else if (k === 2 && neu.length) neu[last] = mutate(r, neu[last]);
    else if (k === 3 && neu.length > 1) { const [x] = neu.splice(last, 1); neu.splice(Math.floor(r() * (neu.length + 1)), 0, x); }
    else if (k === 4) neu.splice(at, 0, '');
    else if (neu.length) neu.splice(at, 0, mutate(r, neu[last]));
  }
  return [old, neu];
}

const TEXTUAL = new Set(['text', 'empty']);
const kindOf = (e) => (typeof e === 'string' ? (e ? 'text' : 'empty') : (e.kind || (e.text ? 'text' : 'empty')));
const textOfE = (e) => (typeof e === 'string' ? e : (e.text ?? ''));
const sigOfE = (e) => (typeof e === 'string' ? null : (e.sig ?? null));
/** 짝지을 수 있는 종류: 같은 종류, 글 문단(글·빈 줄)끼리, 또는 구조(sig, 빈 글 아님)가 같음 */
const compatible = (x, y) => kindOf(x) === kindOf(y) || (TEXTUAL.has(kindOf(x)) && TEXTUAL.has(kindOf(y))) || (!!sigOfE(x) && sigOfE(x) === sigOfE(y));
/** 짝이 될 수 있는가: 짝지을 수 있는 종류이거나, 둘 다 글 없는 문단(짝 사이 틈 채우기 — 같은 자리 문단이 표·그림을 잃거나 얻음) */
const pairable = (x, y) => compatible(x, y) || (!textOfE(x) && !textOfE(y));

/**
 * planBody 결과가 올바른 정렬인가: 번호마다 한 번씩, 짝은 문서 순서, 짝이 될 수 없는 것끼리는 짝이 없고,
 * 짝 사이 틈(맨 앞·맨 뒤 포함)에 짝이 될 수 있는 옛·새 문단이 함께 남지 않는다(짝 수 최대 + 글 없는 문단 채우기).
 */
function checkPlan(olds, news, { pairs, plan }) {
  const usedO = new Array(olds.length).fill(0); const usedN = new Array(news.length).fill(0);
  for (const [i, j] of pairs) { usedO[i]++; usedN[j]++; assert.ok(pairable(olds[i], news[j]), `짝 ${i}↔${j} 종류`); }
  const set = new Set(pairs.map(([i, j]) => `${i}:${j}`));
  for (const step of plan) {
    for (const o of step.ops) {
      if (o.op === 'del') usedO[o.i]++;
      else if (o.op === 'ins') usedN[o.j]++;
      else assert.ok(set.has(`${o.i}:${o.j}`), '단계의 짝은 pairs 에 있다');
    }
  }
  assert.ok(usedO.every((c) => c === 1), '옛 문단은 한 번씩');
  assert.ok(usedN.every((c) => c === 1), '새 문단은 한 번씩');
  for (let k = 1; k < pairs.length; k++) assert.ok(pairs[k][0] > pairs[k - 1][0] && pairs[k][1] > pairs[k - 1][1], '짝은 문서 순서');
  const bounds = [[-1, -1], ...pairs, [olds.length, news.length]];
  for (let k = 1; k < bounds.length; k++) {
    const [i0, j0] = bounds[k - 1]; const [i1, j1] = bounds[k];
    for (let i = i0 + 1; i < i1; i++) for (let j = j0 + 1; j < j1; j++) assert.ok(!pairable(olds[i], news[j]), `틈에 짝 ${i}↔${j} 이 남음`);
  }
}

/** 문단 첫 run 맨 앞에 개체 요소를 끼운다(엔진 모형 시험용 — 그림 자료는 없다) */
function injectObject(d, ref, tag = 'hp:pic') {
  const sec = d.sections[0]; const p = sec.byRef(ref); const run = p.runs[0];
  assert.ok(run && !run.selfclose, `${ref} 에 열린 run 이 있어야 한다`);
  const at = sec.tokens[run.openTok].end;
  sec.load(`${sec.xml.slice(0, at)}<${tag}/>${sec.xml.slice(at)}`);
}

/** 시험 문서: tool_memo 를 평탄화하고 첫 문단 뒤에 빈 문단, 그 뒤에 2×2 표 → [글(메모), 빈 줄, 표, 글, 글] */
async function tableDoc() {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  d.insertParagraphAfter(0, 0, '', { author, date: DATE });
  d.insertTableAfter(0, 1, { rows: [['구분', '값'], ['가', '1']] }, { author, date: DATE });
  return reload(d);
}

// ───────── planBody: 예전 정렬과 같다 ─────────

test('planBody: 문자열 목록은 예전 mergeBodyTexts 정렬과 같다(같음·넣기·지우기·자리 바꿈·빈 줄)', () => {
  const cases = [
    [['가', '나', '다'], ['가', '나', '다']],
    [['가', '나', '다'], ['새', '가', '나', '다']],
    [['가', '나', '다'], ['가', '나', '새', '다']],
    [['가', '나', '다'], ['가', '나', '다', '새']],
    [['가', '나', '다'], ['가', '다']],
    [['가', '나', '다', '라'], ['가', '다', '나', '라']],
    [['가', '나', '다', '라'], ['라', '가', '나', '다']],
    [[], ['새 1', '새 2']], [['옛 1', '옛 2'], []], [[], []],
    [['', '', '가'], ['', '가', '']],
    [['머리', '둘째 문단입니다. 있던 낱말을 지웁니다.', '끝'], ['머리', '새 문단', '둘째 문단입니다. 있던 단어를 지웁니다.', '끝']],
    [['첫째 문단 원문', '둘째 문단 원문', '셋째 문단 원문'], ['둘째 문단 원문 고침', '셋째 문단 원문']],
  ];
  for (const [o, n] of cases) assert.deepEqual(planBody(o, n), oldPlan(o, n), JSON.stringify([o, n]));
  // 바뀐 문단 앞에 새 문단을 넣으면 옛 문단은 비슷한 새 글과 짝(새 문단은 그 앞에 넣기)
  assert.deepEqual(planBody(['A 문단 원문입니다', '끝'], ['새 문단', 'A 문단 원문입니다 고침', '끝']),
    { pairs: [[0, 1], [1, 2]], plan: [{ at: 0, ops: [{ op: 'ins', j: 0 }, { op: 'pair', i: 0, j: 1 }] }] });
  // 덩어리가 크면(옛 60 × 새 50 = 3000 > 2500) 비슷함을 재지 않고 차례로 짝짓는다
  const old60 = Array.from({ length: 60 }, (_, i) => `옛 문단 ${i}`); const new50 = Array.from({ length: 50 }, (_, i) => `새 글 ${i}`);
  const big = planBody(old60, new50);
  assert.deepEqual(big, oldPlan(old60, new50));
  assert.deepEqual(big.plan, [{ at: 0, ops: [...new50.map((_, k) => ({ op: 'pair', i: k, j: k })), ...old60.slice(50).map((_, k) => ({ op: 'del', i: 50 + k }))] }]);
  // 2500 이하(40 × 60)는 비슷함으로 짝짓는다 — 역시 예전과 같다
  const old40 = Array.from({ length: 40 }, (_, i) => `문단 ${i}번 글`); const new60 = Array.from({ length: 60 }, (_, i) => (i % 3 ? `문단 ${Math.floor(i / 1.5)}번 글 고침` : `새 ${i}`));
  assert.deepEqual(planBody(old40, new60), oldPlan(old40, new60));
});

test('planBody: 무작위 목록 600개 — 문자열·{text} 객체 모두 예전 정렬과 같고, 정렬 조건을 지킨다', () => {
  const r = rng(20261022);
  for (let n = 0; n < 600; n++) {
    const [o, nw] = randomLists(r);
    const want = oldPlan(o, nw);
    const got = planBody(o, nw);
    assert.deepEqual(got, want, `#${n} ${JSON.stringify([o, nw])}`);
    // 종류·sig·중첩 글이 없는 객체 항목은 글만 본 것과 같다
    assert.deepEqual(planBody(o.map((text) => ({ text })), nw.map((text) => ({ text }))), want, `#${n} 객체`);
    checkPlan(o, nw, got);
  }
});

test('planBody: 실제 문서 본문 글(fixture·표본)로 만든 고친 목록도 예전 정렬과 같다', async () => {
  const docs = [fx('tool_memo_tracked.hwpx'), fx('hangul_tracked.hwpx'), fx('hangul_resaved_dedup.hwpx')];
  if (hasBiz) docs.push(fs.readFileSync(BIZ));
  for (const bytes of docs) {
    const d = await HwpxDoc.load(bytes);
    for (const target of scenarios(d, 7)) assert.deepEqual(planBody(d.bodyTexts()[0], target), oldPlan(d.bodyTexts()[0], target));
  }
});

/**
 * 문서 본문 글로 만든 고친 목록들(넣기·지우기·고치기·자리 바꿈·무작위). 메모·표 등 컨트롤이 든 문단은 지우거나 고치지 않는다
 * (그 경우는 §4.3 에서 엔진 동작이 바뀔 수 있어 v0.2 엔진과 대조하지 않는다).
 */
function scenarios(d, seed) {
  const T = d.bodyTexts()[0];
  const safe = d.sections[0].bodyParas.map((p, i) => i).filter((i) => i > 0 && !d.sections[0].bodyParas[i].anchors.some((a) => a.kind === 'ctrl'));
  const out = [T.slice(), ['맨 앞 새 문단', ...T], [T[0], '둘째 자리 새 문단', ...T.slice(1)], [...T, '끝 새 문단', '']];
  for (const i of safe.slice(0, 4)) {
    out.push(T.filter((_, k) => k !== i));
    out.push(T.map((t, k) => (k === i ? `${t} 고친 글` : t)));
    out.push(T.map((t, k) => (k === i ? t.slice(Math.floor(t.length / 2)) : t)));
    out.push([...T.slice(0, i), '사이 새 문단', `${T[i]}(덧붙임)`, ...T.slice(i + 1)]);
  }
  if (safe.length >= 2) { const s = T.slice(); [s[safe[0]], s[safe[1]]] = [s[safe[1]], s[safe[0]]]; out.push(s); }
  const r = rng(seed);
  for (let k = 0; k < 10; k++) {
    let s = T.map((t, i) => ({ t, i }));
    for (let e = 1 + Math.floor(r() * 4); e > 0; e--) {
      const op = Math.floor(r() * 4); const at = 1 + Math.floor(r() * s.length);
      const cand = s.map((x, q) => q).filter((q) => safe.includes(s[q].i));
      if (op === 0 || !cand.length) s.splice(Math.min(at, s.length), 0, { t: r() < 0.3 ? '' : `무작위 새 문단 ${k}-${e}`, i: -1 });
      else if (op === 1) s.splice(pick(r, cand), 1);
      else { const q = pick(r, cand); s[q] = { t: mutate(r, s[q].t), i: -1 }; }
      s = s.slice();
    }
    out.push(s.map((x) => x.t));
  }
  return out;
}

test('mergeBodyTexts: v0.2 엔진과 결과가 같다(보고·문단 글·변경 목록, 변경 추적이 있는 원본·평탄화본)', { skip: !OldDoc && 'backups/v0.2.0 엔진 없음' }, async () => {
  const run = async (Doc, bytes, target, opts) => {
    const d = await Doc.load(bytes);
    try {
      const rep = d.mergeBodyTexts({ 0: target }, { author, date: DATE, ...opts });
      return { rep, paras: d.paragraphs().map((p) => [p.ref, d.text(p.ref, 'markup')]), changes: d.changes().map((c) => [c.id, c.type, c.ref, c.text, c.author]) };
    } catch (e) { return { error: e.code || String(e.message) }; }
  };
  let compared = 0;
  const sources = [fx('tool_memo_tracked.hwpx'), fx('hangul_tracked.hwpx'), fx('hangul_resaved_dedup.hwpx')];
  for (const raw of sources) {
    const flat = await (await (await HwpxDoc.load(raw)).flattened()).save();
    for (const bytes of [raw, flat]) {
      const d = await HwpxDoc.load(bytes);
      for (const target of scenarios(d, 11)) {
        assert.deepEqual(await run(HwpxDoc, bytes, target), await run(OldDoc, bytes, target), JSON.stringify(target));
        compared++;
      }
    }
  }
  if (hasBiz) {
    // 표가 있는 문서: 본문 글 + 중첩 문단(표 칸) 병합까지
    const bytes = fs.readFileSync(BIZ);
    const d = await HwpxDoc.load(bytes);
    const N = d.bodyTexts({ nested: true })[0];
    const t1 = structuredClone(N); t1[3].nested[7].text = '270'; t1.splice(2, 0, { text: '새 문단', nested: [] });
    const t2 = structuredClone(N); t2[7].nested.pop(); t2[11].nested[4].text = '바뀐 칸';
    const t3 = structuredClone(N); t3.splice(4, 1); t3[0] = { ...t3[0], text: `${t3[0].text} 고침` };
    for (const target of [N, t1, t2, t3, ...scenarios(d, 3).slice(0, 6)]) {
      assert.deepEqual(await run(HwpxDoc, bytes, target), await run(OldDoc, bytes, target), JSON.stringify(target).slice(0, 200));
      compared++;
    }
    // 글 목록은 문자열, 중첩 글은 opts.nested 로
    const bt = t1.map((e) => e.text); const nt = { 0: t1.map((e) => e.nested) };
    assert.deepEqual(await run(HwpxDoc, bytes, bt, { nested: nt }), await run(OldDoc, bytes, bt, { nested: nt }));
  }
  assert.ok(compared > 60, `대조 ${compared}건`);
});

// ───────── planBody: 종류·구조 ─────────

test('planBody: 종류 구분 — 표·개체 문단은 빈 줄과 짝짓지 않고(같은 자리에 하나씩 남으면 짝), 빈 줄과 글 문단은 서로 짝짓는다', () => {
  const A = { text: '첫 문단', kind: 'text' }; const E = { text: '', kind: 'empty' }; const T = { text: '', kind: 'table' }; const B = { text: '끝 문단', kind: 'text' };
  const O = { text: '', kind: 'object' };
  // 표 앞 빈 줄을 지운 수정본: 글만 보면 빈 줄 ↔ 표가 짝이 되고 표가 지워진 것으로 보인다
  assert.deepEqual(planBody(['첫 문단', '', '', '끝 문단'], ['첫 문단', '', '끝 문단']).pairs, [[0, 0], [1, 1], [3, 2]]);
  assert.deepEqual(planBody([A, E, T, B], [A, T, B]), { pairs: [[0, 0], [2, 1], [3, 2]], plan: [{ at: 1, ops: [{ op: 'del', i: 1 }] }] });
  // 짝을 고른 뒤 틈에 글 없는 문단이 양쪽에 남으면 종류가 달라도 짝 — 같은 자리 문단이 표·그림을 잃거나 얻음(빈 문단 넣기·지우기를 만들지 않는다)
  const pair11 = [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }] }];
  assert.deepEqual(planBody([A, T, B], [A, E, B]).plan, pair11, '표를 지워 빈 줄만 남음');
  assert.deepEqual(planBody([A, E, B], [A, O, B]).plan, pair11, '빈 줄에 그림');
  assert.deepEqual(planBody([A, E, B], [A, T, B]).plan, pair11, '빈 줄에 표');
  assert.deepEqual(planBody([A, O, B], [A, T, B]).plan, pair11, '개체 ↔ 표');
  assert.deepEqual(planBody([A, T, { ...T }, B], [A, E, { ...E }, B]).pairs, [[0, 0], [1, 1], [2, 2], [3, 3]], '여럿이면 앞쪽끼리');
  // 짝이 모자라면 빈 줄부터(짝 없는 빈 줄은 빈 문단 지우기·넣기 덩어리가 되고, 표·개체 문단은 덩어리가 없다)
  assert.deepEqual(planBody([A, T, E, B], [A, O, B]).plan, [{ at: 1, ops: [{ op: 'del', i: 1 }, { op: 'pair', i: 2, j: 1 }] }]);
  assert.deepEqual(planBody([A, O, B], [A, T, E, B]).plan, [{ at: 1, ops: [{ op: 'ins', j: 1 }, { op: 'pair', i: 1, j: 2 }] }]);
  assert.deepEqual(planBody([A, T, O, B], [A, E, B]).plan, [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }, { op: 'del', i: 2 }] }], '빈 줄 쪽이 하나면 앞쪽과');
  // 글이 있는 문단은 채우지 않는다(표를 지우고 그 줄에 글을 씀 = 표 문단 지움 + 글 문단 넣기)
  assert.deepEqual(planBody([A, T, B], [A, { text: '표 대신 글', kind: 'text' }, B]).plan, [{ at: 1, ops: [{ op: 'del', i: 1 }, { op: 'ins', j: 1 }] }]);
  // 같은 종류 짝이 있으면 그 짝이 먼저: 바뀐 표는 표와 짝, 표 앞 빈 줄은 지움(빈 줄이 틈에 혼자 남음)
  const T9 = { text: '', kind: 'table', nested: ['9'] };
  assert.deepEqual(planBody([A, E, { ...T, nested: ['1'] }, B], [A, T9, B]).plan, [{ at: 1, ops: [{ op: 'del', i: 1 }, { op: 'pair', i: 2, j: 1 }] }]);
  // 빈 줄에 글을 쓰거나 글을 다 지운 문단은 바꿈(짝)
  assert.deepEqual(planBody([A, E, B], [A, { text: '새로 쓴 글', kind: 'text' }, B]).plan, [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }] }]);
  assert.deepEqual(planBody([A, B], [A, E]).plan, [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }] }]);
  // 섞인 덩어리: 짝 수가 먼저, 그다음 비슷함 — 글은 비슷한 글과, 표는 표와
  const T1 = { text: '', kind: 'table', sig: 't1' }; const T2 = { text: '', kind: 'table', sig: 't2' };
  assert.deepEqual(planBody([{ text: '서론 문단입니다' }, T1], [E, { text: '서론 문단입니다 고침' }, T2]).plan,
    [{ at: 0, ops: [{ op: 'ins', j: 0 }, { op: 'pair', i: 0, j: 1 }, { op: 'pair', i: 1, j: 2 }] }]);
  // 문자열과 객체를 섞어도 된다(문자열 = 글 문단)
  assert.deepEqual(planBody(['첫 문단', T, '끝 문단'], [A, E, T, B]).pairs, [[0, 0], [1, 2], [2, 3]]);
});

test('planBody: sig·중첩 글은 양쪽에 다 있을 때만 본다 — 모양·내용이 다른 표를 구별, sig 가 같으면 표 ↔ 글 문단도 짝', () => {
  const A = { text: '앞', kind: 'text' }; const B = { text: '뒤', kind: 'text' };
  const Ta = { text: '', kind: 'table', sig: 'a' }; const Tb = { text: '', kind: 'table', sig: 'b' };
  assert.deepEqual(planBody([A, Ta, Tb, B], [A, { ...Tb }, B]).pairs, [[0, 0], [2, 1], [3, 2]], 'sig 로 남은 표를 찾는다');
  assert.deepEqual(planBody([A, Ta, Tb, B], [A, { text: '', kind: 'table' }, B]).pairs, [[0, 0], [1, 1], [3, 2]], '한쪽에 sig 가 없으면 글·종류만');
  const t1 = { text: '', kind: 'table', nested: ['1', '2'] }; const t2 = { text: '', kind: 'table', nested: [{ text: '3' }, { text: '4' }] };
  assert.deepEqual(planBody([A, t1, t2, B], [A, { text: '', kind: 'table', nested: ['3', '4'] }, B]).pairs, [[0, 0], [2, 1], [3, 2]], '중첩 글로 구별');
  // 칸 글만 바뀐 표는 바뀐 덩어리 안에서 그대로 짝
  assert.deepEqual(planBody([A, t1, B], [A, { text: '', kind: 'table', nested: ['1', '9'] }, B]).plan, [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }] }]);
  // sig 가 같으면(빈 글 아님) 종류가 달라도 짝: 표만 있던 문단에 글을 씀 / 표를 품은 글 문단의 글을 다 지움
  const Ts = { text: '', kind: 'table', sig: 's1' }; const Xs = { text: '(단위: 명)', kind: 'text', sig: 's1' };
  const pair11 = [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }] }];
  assert.deepEqual(planBody([A, Ts, B], [A, Xs, B]).plan, pair11);
  assert.deepEqual(planBody([A, Xs, B], [A, Ts, B]).plan, pair11);
  assert.deepEqual(planBody([A, Ts, B], [A, { ...Xs, sig: 's2' }, B]).plan, [{ at: 1, ops: [{ op: 'del', i: 1 }, { op: 'ins', j: 1 }] }], '구조가 다르면 짝 없음');
  assert.deepEqual(planBody([A, { ...Ts, sig: '' }, B], [A, { ...Xs, sig: '' }, B]).plan, [{ at: 1, ops: [{ op: 'del', i: 1 }, { op: 'ins', j: 1 }] }], '빈 sig 는 구조가 아니다');
  // 같은 구조의 글 문단과 다투면 짝 수 → 비슷함(글 문단끼리 글이 비슷하면 그쪽)
  assert.deepEqual(planBody([A, { text: '표 설명 글', kind: 'text', sig: '' }, Ts, B], [A, { text: '표 설명 글 고침', kind: 'text', sig: 's1' }, B]).plan,
    [{ at: 1, ops: [{ op: 'pair', i: 1, j: 1 }, { op: 'del', i: 2 }] }]);
  // 큰 덩어리(60 × 50 > 2500)에서도 sig 가 같은 표 ↔ 글 문단을 짝짓고, 나머지 글 없는 문단(표 ↔ 개체)은 틈마다 앞쪽끼리
  const old = Array.from({ length: 60 }, (_, i) => (i === 30 ? { ...Ts } : { text: '', kind: 'table', sig: `o${i}` }));
  const neu = Array.from({ length: 50 }, (_, j) => (j === 25 ? { ...Xs } : { text: '', kind: 'object', sig: `n${j}` }));
  const res = planBody(old, neu);
  checkPlan(old, neu, res);
  assert.deepEqual(res.pairs.filter(([i, j]) => i === 30 || j === 25), [[30, 25]]);
  assert.equal(res.pairs.length, 50);
});

test('planBody: 종류가 섞인 무작위 목록·큰 덩어리(> 2500)도 정렬 조건을 지킨다', () => {
  const r = rng(77);
  const entry = () => {
    const k = r();
    if (k < 0.15) return { text: '', kind: 'table', sig: `t${Math.floor(r() * 3)}` };
    if (k < 0.25) return { text: '', kind: 'object' };
    if (k < 0.4) return { text: '', kind: 'empty' };
    if (k < 0.5) return { text: pick(r, POOL) || '표 설명', kind: 'text', sig: `t${Math.floor(r() * 3)}` }; // 표를 품은 글 문단
    return { text: pick(r, POOL) || '글', kind: 'text' };
  };
  for (let n = 0; n < 600; n++) {
    const old = Array.from({ length: Math.floor(r() * 12) }, entry);
    const neu = old.filter(() => r() > 0.2).map((e) => (r() < 0.2 ? entry() : e));
    for (let k = Math.floor(r() * 3); k > 0; k--) neu.splice(Math.floor(r() * (neu.length + 1)), 0, entry());
    checkPlan(old, neu, planBody(old, neu));
  }
  // 한 덩어리 60 × 50: 종류 묶음만 맞춰 차례로 짝짓는다
  const old = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? { text: '', kind: 'table', sig: `o${i}` } : { text: `옛 문단 ${i}`, kind: 'text' }));
  const neu = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? { text: '', kind: 'table', sig: `n${i}` } : { text: `새 글 ${i}`, kind: 'text' }));
  const res = planBody(old, neu);
  checkPlan(old, neu, res);
  assert.equal(res.plan.length, 1);
  assert.equal(res.pairs.length, 40 + 10, '글 40개 + 표 10개가 모두 짝(종류 열의 최장 공통 부분)');
});

test('diffEntries: 바뀐 곳만 문서 순서로(replace·insert(afterI)·delete), 맨 앞에 넣으면 afterI = -1', () => {
  assert.deepEqual(diffEntries(['가', '나', '다'], ['가', '새', '나', '다 고침']), [{ type: 'insert', j: 1, afterI: 0 }, { type: 'replace', i: 2, j: 3 }]);
  assert.deepEqual(diffEntries(['가'], ['맨 앞', '가']), [{ type: 'insert', j: 0, afterI: -1 }]);
  assert.deepEqual(diffEntries(['가', '나', '다'], ['가', '다']), [{ type: 'delete', i: 1 }]);
  // 지운 문단 뒤의 새 문단은 그 지운 문단 뒤(mergeBodyTexts 와 같은 자리 규칙)
  const T = { text: '', kind: 'table' };
  assert.deepEqual(diffEntries([{ text: '가' }, T, { text: '끝' }], [{ text: '가' }, { text: '표 대신 쓴 글' }, { text: '끝' }]),
    [{ type: 'delete', i: 1 }, { type: 'insert', j: 1, afterI: 1 }]);
  // 같은 자리에서 표만 없어진 문단(빈 줄로 남음)은 짝 — 글이 같아 바뀐 곳이 없다
  assert.deepEqual(diffEntries([{ text: '가' }, T, { text: '끝' }], [{ text: '가' }, { text: '' }, { text: '끝' }]), []);
  // 글이 같고 구조만 다른 짝은 replace 가 아니다
  assert.deepEqual(diffEntries([{ text: '', kind: 'table', sig: 'a' }], [{ text: '', kind: 'table', sig: 'b' }]), []);
  assert.deepEqual(diffEntries([], []), []);
});

// ───────── 글자 차이·3-way ─────────

test('charOps·similarity·entryKind: 코드포인트 위치, 지움+넣음은 바꿈 하나', () => {
  assert.deepEqual(charOps('같은 글', '같은 글'), []);
  assert.deepEqual(charOps('', '새 글'), [{ start: 0, end: 0, text: '새 글' }]);
  assert.deepEqual(charOps('지울 글', ''), [{ start: 0, end: 4, text: '' }]);
  assert.deepEqual(charOps('가나다라', '가X다라Y'), [{ start: 1, end: 2, text: 'X' }, { start: 4, end: 4, text: 'Y' }]);
  assert.deepEqual(charOps('a👍b', 'a👍c'), [{ start: 2, end: 3, text: 'c' }], '이모지는 한 글자(코드포인트)');
  assert.equal(similarity('같은 글', '같은 글'), 1);
  assert.equal(similarity('a', 'ab'), 0);
  assert.equal(similarity('abcd', 'abce'), 4 / 6);
  assert.deepEqual([entryKind('글'), entryKind('', { tables: 1, objects: 2 }), entryKind('', { objects: 1 }), entryKind('')], ['text', 'table', 'object', 'empty']);
});

test('mergeParagraphText 는 charOps 를 뒤에서부터 변경 추적으로 적용한다', async () => {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const before = d.text('s0/p2'); const after = before.replace('AI 제안대로', '그대로').replace('둡니다', '둡니다!');
  const ops = charOps(before, after);
  const ids = d.mergeParagraphText('s0/p2', after, { author });
  assert.equal(d.text('s0/p2'), after);
  assert.equal(d.text('s0/p2', 'original'), before);
  assert.equal(ids.length, ops.reduce((n, o) => n + (o.start < o.end ? 1 : 0) + (o.text ? 1 : 0), 0), '바꿈 = 삭제+삽입, 넣기 = 삽입');
});

test('merge3: 겹치지 않는 고침은 합치고, 겹치면 충돌(기준 코드포인트 범위 + 각 쪽 글)', () => {
  assert.deepEqual(merge3('가나다라마바사', '가너다라마바사', '가나다라마버사'), { ok: true, text: '가너다라마버사' });
  assert.deepEqual(merge3('예산은 100억 원이다.', '예산은 120억 원이다.', '예산은 100억 원이었다.'), { ok: true, text: '예산은 120억 원이었다.' });
  // 같은 범위를 서로 다르게 · 일부만 겹침
  assert.deepEqual(merge3('abcdef', 'abXYef', 'abZef'), { ok: false, conflicts: [{ start: 2, end: 4, base: 'cd', mine: 'XY', theirs: 'Z' }] });
  assert.deepEqual(merge3('0123456789', '01ab456789', '012cd56789'), { ok: false, conflicts: [{ start: 2, end: 5, base: '234', mine: 'ab4', theirs: '2cd' }] });
  // 충돌이 둘이면 둘 다(앞에서부터)
  const two = merge3('abc def ghi', 'aXc def gYi', 'aZc def gWi');
  assert.equal(two.ok, false);
  assert.deepEqual(two.conflicts.map((c) => [c.start, c.end, c.mine, c.theirs]), [[1, 2, 'X', 'Z'], [9, 10, 'Y', 'W']]);
  // 같은 글자가 이어지면 글자 정렬이 여러 가지라 충돌 범위는 달라질 수 있어도, 충돌은 놓치지 않는다
  assert.equal(merge3('aaa bbb ccc', 'aXa bbb cYc', 'aZa bbb cWc').ok, false);
});

test('merge3: 같은 고침은 충돌이 아니다 · 맞닿은 넣기는 괜찮고 범위 안 넣기·같은 자리 다른 넣기는 충돌', () => {
  assert.deepEqual(merge3('같은 글', '바뀐 글', '바뀐 글'), { ok: true, text: '바뀐 글' });
  assert.deepEqual(merge3('abcdef', 'aXcdef', 'aXcdeY'), { ok: true, text: 'aXcdeY' }, '똑같은 바꿈은 한 번만');
  assert.deepEqual(merge3('abc', 'abXc', 'aYc'), { ok: true, text: 'aYXc' }, '바꾼 범위 끝에 맞닿은 넣기');
  assert.deepEqual(merge3('abc', 'Xabc', 'aYc'), { ok: true, text: 'XaYc' });
  assert.deepEqual(merge3('abcd', 'abXcd', 'ad'), { ok: false, conflicts: [{ start: 1, end: 3, base: 'bc', mine: 'bXc', theirs: '' }] }, '지운 범위 안에 넣기');
  assert.deepEqual(merge3('ab', 'aXb', 'aYb'), { ok: false, conflicts: [{ start: 1, end: 1, base: '', mine: 'X', theirs: 'Y' }] }, '같은 자리 다른 넣기');
  assert.deepEqual(merge3('ab', 'aXb', 'aXbZ'), { ok: true, text: 'aXbZ' }, '같은 자리 같은 넣기');
});

test('merge3: 빈 글·이모지(코드포인트)', () => {
  assert.deepEqual(merge3('', '', ''), { ok: true, text: '' });
  assert.deepEqual(merge3('', '새 글', ''), { ok: true, text: '새 글' });
  assert.deepEqual(merge3('', '', '새 글'), { ok: true, text: '새 글' });
  assert.deepEqual(merge3('', '가', '나'), { ok: false, conflicts: [{ start: 0, end: 0, base: '', mine: '가', theirs: '나' }] });
  assert.deepEqual(merge3('지울 글', '', '지울 글'), { ok: true, text: '' });
  assert.deepEqual(merge3('지울 글', '', '지울 말'), { ok: false, conflicts: [{ start: 0, end: 4, base: '지울 글', mine: '', theirs: '지울 말' }] });
  assert.deepEqual(merge3(null, undefined, '글'), { ok: true, text: '글' }, '문자열이 아니면 빈 글');
  assert.deepEqual(merge3('👍 좋아요', '👍 좋아요!', '👎 좋아요'), { ok: true, text: '👎 좋아요!' });
  assert.deepEqual(merge3('👍a👍', '👍b👍', '👍c👍'), { ok: false, conflicts: [{ start: 1, end: 2, base: 'a', mine: 'b', theirs: 'c' }] });
  assert.deepEqual(merge3('🙂🙂', '🙂🎉🙂', '🙂🙂🎈'), { ok: true, text: '🙂🎉🙂🎈' });
});

// ───────── bodyEntries ─────────

test('bodyEntries: 종류(글·빈 줄·표·개체)·구조 표시·중첩 문단(메모 본문 제외)', async () => {
  const d = await tableDoc();
  const e = d.bodyEntries()[0];
  assert.deepEqual(e.map((x) => x.kind), ['text', 'empty', 'table', 'text', 'text']);
  assert.deepEqual(e.map((x) => x.text), d.bodyTexts()[0]);
  assert.deepEqual(e[0].nested, [], '메모 본문은 중첩 문단이 아니다');
  assert.ok(d.memos().some((m) => m.ref === 's0/p0'));
  assert.deepEqual([e[0].sig, e[1].sig, e[3].sig], ['', '', ''], '구조 없는 문단은 sig 가 빈 글');
  assert.match(e[2].sig, /^[0-9a-z]{10}$/);
  assert.deepEqual(e[2].nested, [
    { ref: 's0/p2/n0', text: '구분', sig: 'hp:tbl#t0@0,0' }, { ref: 's0/p2/n1', text: '값', sig: 'hp:tbl#t0@0,1' },
    { ref: 's0/p2/n2', text: '가', sig: 'hp:tbl#t0@1,0' }, { ref: 's0/p2/n3', text: '1', sig: 'hp:tbl#t0@1,1' },
  ]);
  // sig 는 구조만 본다(칸 글이 바뀌어도 같고, 칸 수가 바뀌면 다르다)
  const c = await d.clone(); c.mergeParagraphText('s0/p2/n3', '2', { author }); c.acceptAll();
  assert.equal(c.bodyEntries()[0][2].sig, e[2].sig);
  const w = await d.clone(); w.removeBodyParagraph(0, 2); w.insertTableAfter(0, 1, { rows: [['구분', '값', '비고'], ['가', '1', '']] }, { author });
  assert.notEqual(w.bodyEntries()[0][2].sig, e[2].sig);
  // 개체: 빈 줄에 그림 요소 → 'object', 글 문단에 그림 → 'text'(sig 만 바뀜)
  injectObject(w, 's0/p1'); injectObject(w, 's0/p3', 'hp:rect');
  const we = w.bodyEntries()[0];
  assert.deepEqual([we[1].kind, we[3].kind], ['object', 'text']);
  assert.notEqual(we[3].sig, '');
  // mergeBodyTexts 에 그대로 넘길 수 있다(같은 문서 → 바뀐 것 없음)
  const rep = d.mergeBodyTexts(d.bodyEntries(), { author });
  assert.deepEqual([rep.ids, rep.changed, rep.inserted, rep.deleted, rep.skippedNested], [[], [], [], [], []]);
});

test('bodyEntries: 실제 보고서 — 글 8·빈 줄 6·표 5, 표 문단의 중첩 문단 = 캡션 + 칸', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await HwpxDoc.load(fs.readFileSync(BIZ));
  const e = d.bodyEntries()[0];
  const count = (k) => e.filter((x) => x.kind === k).length;
  assert.deepEqual([count('text'), count('empty'), count('table'), count('object')], [8, 6, 5, 0]);
  assert.deepEqual(e.map((x, i) => (x.kind === 'table' ? i : -1)).filter((i) => i >= 0), [3, 7, 11, 14, 17]);
  const nested = d.paragraphs().filter((p) => p.parent === 's0/p3' && p.where !== '메모');
  assert.deepEqual(e[3].nested.map((n) => n.ref), nested.map((p) => p.ref));
  assert.equal(e[3].nested[0].sig, 'hp:tbl#t0:caption');
});

// ───────── diffDocs ─────────

test('diffDocs: 평탄화한 사본을 고친 수정본 — 바꿈·문단 넣기·문단 지우기, ref 는 기준 문서', async () => {
  const base = await HwpxDoc.load(fx('tool_memo_tracked.hwpx')); // 변경 추적·메모가 있는 기준(최종본 글로 비교)
  const head = await base.flattened();
  head.mergeParagraphText('s0/p0', `${base.text('s0/p0')} 덧붙인 문장.`, { author });
  head.insertParagraphAfter(0, 0, '새로 넣은 문단', { author });
  head.removeBodyParagraph(0, 3); // 기준 s0/p2
  head.acceptAll();
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map(strip), [
    { type: 'replace', ref: 's0/p0', baseText: base.text('s0/p0'), newText: `${base.text('s0/p0')} 덧붙인 문장.`, cell: null },
    { type: 'insert', ref: 's0/p0', afterRef: 's0/p0', baseText: '', newText: '새로 넣은 문단', cell: null },
    { type: 'delete', ref: 's0/p2', baseText: '셋째 문단은 AI 제안대로 둡니다.', newText: '', cell: null },
  ]);
  for (const h of r.hunks) assert.match(h.hid, /^h[0-9a-z]{10}$/);
  assert.equal(new Set(r.hunks.map((h) => h.hid)).size, r.hunks.length, 'hid 는 서로 다르다');
  // 같은 덩어리는 다시 계산해도(바이트로 다시 읽어도) 같은 hid
  const again = await diffDocs(base, head);
  const fromBytes = await diffDocs(await base.save(), await head.save());
  assert.deepEqual(again, r);
  assert.deepEqual(fromBytes, r);
  // hid 는 새 글까지 넣어 셈한다: 같은 문단을 또 고치면 그 덩어리 hid 만 바뀌고 다른 덩어리 hid 는 그대로
  // (웹 editor.js draftSig 가 이 변화로 다른 창의 저장을 알아채고, 서버 crs.js _rethread 가 의견 스레드를 자리로 다시 잇는다)
  const head2 = await head.clone();
  head2.mergeParagraphText('s0/p0', `${base.text('s0/p0')} 다시 고친 문장.`, { author });
  head2.acceptAll();
  const r2 = await diffDocs(base, head2);
  assert.deepEqual(r2.hunks.map((h) => [h.type, h.ref]), r.hunks.map((h) => [h.type, h.ref]));
  assert.notEqual(r2.hunks[0].hid, r.hunks[0].hid, '같은 자리라도 새 글이 바뀌면 hid 가 바뀐다');
  assert.deepEqual(r2.hunks.slice(1).map((h) => h.hid), r.hunks.slice(1).map((h) => h.hid), '다른 덩어리 hid 는 그대로');
  // 같은 문서끼리는 덩어리 없음
  assert.deepEqual(await diffDocs(base, await base.flattened()), { hunks: [], unsupported: [] });
});

test('diffDocs: 문서 맨 앞에 넣은 문단은 afterRef = null(보여 줄 자리 = 첫 문단), 같은 자리 같은 글이 둘이면 hid 를 나눈다', async () => {
  const base = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const head = await base.clone();
  const sec = head.sections[0]; const p0 = sec.bodyParas[0];
  sec.load(`${sec.xml.slice(0, p0.start)}<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>맨 앞 문단</hp:t></hp:run></hp:p>${sec.xml.slice(p0.start)}`);
  head.insertParagraphAfter(0, 2, '', { author }); head.insertParagraphAfter(0, 2, '', { author }); // 기준 s0/p1 뒤에 빈 줄 둘
  const r = await diffDocs(base, head);
  assert.deepEqual(r.hunks.map(strip), [
    { type: 'insert', ref: 's0/p0', afterRef: null, baseText: '', newText: '맨 앞 문단', cell: null },
    { type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '', cell: null },
    { type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '', cell: null },
  ]);
  assert.equal(new Set(r.hunks.map((h) => h.hid)).size, 3);
  assert.deepEqual((await diffDocs(base, head)).hunks.map((h) => h.hid), r.hunks.map((h) => h.hid));
});

test('diffDocs: 표 칸 글 바꿈 → 칸 정보가 붙은 replace(중첩 ref), 빈 줄을 지워도 표는 제 짝', async () => {
  const base = await tableDoc();
  const head = await base.clone();
  head.mergeParagraphText('s0/p2/n3', '2', { author });
  head.removeBodyParagraph(0, 1); // 표 앞 빈 줄 지움 → 수정본에서는 표가 s0/p1
  head.acceptAll();
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map(strip), [
    { type: 'delete', ref: 's0/p1', baseText: '', newText: '', cell: null },
    { type: 'replace', ref: 's0/p2/n3', baseText: '1', newText: '2', cell: { table: 's0/p2#t0', row: 1, col: 1 } },
  ]);
});

test('diffDocs: 표 구조 바뀜·표 지움·표 넣음은 표째 덩어리(2026-10-28), 개체(그림·표·도형 말고) 넣음은 unsupported', async () => {
  const base = await tableDoc();
  const ws = (u) => u.map(({ ref, what }) => [ref, what]);
  const hs = (r) => r.hunks.map((h) => [h.type, h.ref, !!h.objects, h.objectSummary ?? '']);
  // 표 행·열이 바뀜(같은 자리 2×2 → 2×3): 그 문단의 표째 object 덩어리(칸 글은 따로 비교하지 않는다 — 표째 옮김)
  const reshaped = await base.clone();
  reshaped.removeBodyParagraph(0, 2); reshaped.insertTableAfter(0, 1, { rows: [['구분', '값', '비고'], ['가', '2', '']] }, { author });
  let r = await diffDocs(base, reshaped);
  assert.deepEqual([hs(r), ws(r.unsupported)], [[['object', 's0/p2', false, '표 고침(크기·줄·칸)']], []]);
  // 표 문단 지움 · 표 문단 넣음(앞 기준 문단 자리) — 그림·표 문단은 문단째 delete/insert(objects)
  const dropped = await base.clone(); dropped.removeBodyParagraph(0, 2);
  r = await diffDocs(base, dropped);
  assert.deepEqual([hs(r), ws(r.unsupported)], [[['delete', 's0/p2', true, '']], []]);
  const added = await base.clone(); added.insertTableAfter(0, 3, { rows: [['새 표', '칸']] }, { author });
  r = await diffDocs(base, added);
  assert.deepEqual([hs(r), ws(r.unsupported)], [[['insert', 's0/p3', true, '']], []]);
  // 글 문단에 글맵시(편집기가 읽지 못하는 개체)가 생김: 글은 같아 덩어리 없음, 개체는 unsupported(그림은 2026-10-28 부터, 도형·글상자는
  // 2026-10-30 부터 object 덩어리 — objects_codes·shapes_sync 시험)
  const pic = await base.clone(); injectObject(pic, 's0/p3', 'hp:textart');
  r = await diffDocs(base, pic);
  assert.deepEqual([r.hunks, ws(r.unsupported)], [[], [['s0/p3', 'object']]]);
  assert.match(r.unsupported[0].detail, /개체\(그림 말고\) 0개 → 1개/);
  // 글 문단을 지웠는데 그 문단에 (그림·도형 말고) 개체가 있으면 delete + 개체 unsupported
  const picBase = await base.clone(); injectObject(picBase, 's0/p4', 'hp:textart');
  const gone = await picBase.clone(); gone.removeBodyParagraph(0, 4);
  r = await diffDocs(picBase, gone);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref]), ws(r.unsupported)], [[['delete', 's0/p4']], [['s0/p4', 'object']]]);
});

test('diffDocs: 같은 자리에서 표·그림만 없어지거나 생긴 문단은 짝 — 빈 문단 넣기·지우기 없이 그 문단의 표 지움·넣음(object)', async () => {
  const base = await tableDoc(); // [글(메모), 빈 줄, 표, 글, 글]
  const ws = (u) => u.map(({ ref, what }) => [ref, what]);
  const merged = async (head) => {
    const a = await base.clone();
    const rep = a.mergeBodyTexts(head.bodyEntries(), { author: '편집자', date: DATE });
    return [a.sections[0].bodyParas.length, rep.ids, rep.inserted, rep.deleted, rep.skippedNested];
  };
  // 표를 지워 빈 줄만 남음(편집기에서 표 개체만 지운 것과 같은 모양)
  const noTable = await base.clone(); noTable.removeBodyParagraph(0, 2); noTable.insertParagraphAfter(0, 1, '', { author }); noTable.acceptAll();
  assert.deepEqual(noTable.bodyEntries()[0].map((e) => e.kind), ['text', 'empty', 'empty', 'text', 'text']);
  let r = await diffDocs(base, noTable);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref, h.objectSummary]), ws(r.unsupported)], [[['object', 's0/p2', '표 지움']], []]);
  assert.deepEqual(await merged(noTable), [5, [], [], [], ['s0/p2']], '빈 문단을 더하지 않는다(표 칸은 구조가 달라 건너뜀)');
  // 빈 줄에 개체(글맵시)를 넣음 — 그림·도형은 object 덩어리(objects_codes·shapes_sync 시험), 그 밖의 개체는 unsupported
  const pic = await base.clone(); injectObject(pic, 's0/p1', 'hp:textart');
  r = await diffDocs(base, pic);
  assert.deepEqual([r.hunks, ws(r.unsupported)], [[], [['s0/p1', 'object']]]);
  assert.match(r.unsupported[0].detail, /개체\(그림 말고\) 0개 → 1개/);
  assert.deepEqual(await merged(pic), [5, [], [], [], []]);
  // 거꾸로(빈 줄 → 표: 표 넣음, 글맵시 → 빈 줄: 덩어리 없음 + unsupported)
  r = await diffDocs(noTable, base);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref, h.objectSummary]), r.unsupported], [[['object', 's0/p2', '표 넣음']], []]);
  assert.deepEqual((await diffDocs(pic, base)).hunks, []);
});

test('diffDocs: 표만 있던 문단에 글을 쓰고 칸도 고침 — 구조(sig)가 같아 그 문단 replace + 칸 replace(거꾸로도)', async () => {
  const base = await tableDoc();
  const head = await base.clone();
  head.mergeParagraphText('s0/p2/n3', '2', { author }); head.mergeParagraphText('s0/p2', '(단위: 명)', { author }); head.acceptAll();
  assert.deepEqual([base.bodyEntries()[0][2].kind, head.bodyEntries()[0][2].kind], ['table', 'text']);
  assert.equal(head.bodyEntries()[0][2].sig, base.bodyEntries()[0][2].sig);
  const cell = { table: 's0/p2#t0', row: 1, col: 1 };
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map(strip), [
    { type: 'replace', ref: 's0/p2', baseText: '', newText: '(단위: 명)', cell: null },
    { type: 'replace', ref: 's0/p2/n3', baseText: '1', newText: '2', cell },
  ]);
  assert.deepEqual((await diffDocs(base, head)).hunks.map((h) => h.hid), r.hunks.map((h) => h.hid));
  const back = await diffDocs(head, base); // 글을 다 지워 표만 남음
  assert.deepEqual([back.hunks.map(strip), back.unsupported], [[
    { type: 'replace', ref: 's0/p2', baseText: '(단위: 명)', newText: '', cell: null },
    { type: 'replace', ref: 's0/p2/n3', baseText: '2', newText: '1', cell },
  ], []]);
  // mergeBodyTexts(bodyEntries) 도 그 자리에서 바꾼다(문단을 넣거나 지우지 않는다)
  const a = await base.clone();
  const rep = a.mergeBodyTexts(head.bodyEntries(), { author: '편집자', date: DATE });
  assert.deepEqual([rep.changed, rep.inserted, rep.deleted, rep.skippedNested], [['s0/p2', 's0/p2/n3'], [], [], []]);
  assert.deepEqual([a.text('s0/p2', 'markup'), a.text('s0/p2/n3', 'markup')], ['{+(단위: 명)+}', '[-1-]{+2+}']);
});

test('diffDocs: 짝지어진 글 문단의 글과 표 구조가 함께 바뀌면 글 replace + 표째 object 덩어리(2026-10-28 — 종전 structure 표시·unsupported)', async () => {
  // 표를 품은 글 문단(글 + 표): 기준은 2×2, 수정본은 글을 고치고 표를 2×3 으로
  const make = async (rows, text) => {
    const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
    d.insertTableAfter(0, 0, { rows }, { author });
    const sec = d.sections[0]; const p = sec.bodyParas[1]; const seg = sec.xml.slice(p.start, p.end); const k = seg.lastIndexOf('<hp:t/>');
    assert.ok(k > 0);
    sec.load(sec.xml.slice(0, p.start + k) + `<hp:t>${text}</hp:t>` + sec.xml.slice(p.start + k + '<hp:t/>'.length));
    return reload(d);
  };
  const base = await make([['구분', '값'], ['가', '1']], '표 설명 글입니다');
  const head = await make([['구분', '값', '비고'], ['가', '1', '']], '표 설명 글입니다(고침)');
  assert.deepEqual(base.bodyEntries()[0].map((e) => e.kind), ['text', 'text', 'text', 'text']);
  const r = await diffDocs(base, head);
  assert.deepEqual(r.hunks.map((h) => [h.type, h.ref, h.newText, h.objectSummary ?? null, h.structure ?? false]), [
    ['replace', 's0/p1', '표 설명 글입니다(고침)', null, false],
    ['object', 's0/p1', '표 설명 글입니다(고침)', '표 고침(크기·줄·칸)', false],
  ]);
  assert.deepEqual(r.unsupported, []);
});

test('diffDocs: 구역 수가 다르면 두 문서를 이어 견준다(구역 나누기 = 파일 안 secPr) · 구역별 주소로 되돌리면 구역 구조는 반영하지 않는다고 알린다', async () => {
  // [hwpx-cowork] docs/SECTIONS.md — 종전에는 남는 구역을 마지막 공통 구역 뒤로 묶고 '구역 나눔은 반영되지 않습니다'만 알렸다
  const base = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const head = await base.clone();
  const c = head.container;
  c.setText('Contents/content.hpf', c.getText('Contents/content.hpf').replace(/(<opf:item\b[^>]*href="Contents\/section0\.xml"[^>]*\/>)/, '$1<opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/>'));
  c.setText('Contents/section1.xml', head.sections[0].xml);
  const two = await reload(head);
  assert.equal(two.sections.length, 2);
  const r = await diffDocs(base, two);
  assert.deepEqual(r.sections, { base: [3], head: [3, 3] });
  assert.deepEqual(r.hunks.map((h) => [h.type, h.afterRef, h.newText]), base.bodyTexts()[0].map((t) => ['insert', 's0/p2', t]));
  assert.equal(r.hunks[0].objects, true, '뒤 구역 첫 문단은 구역 나누기(secPr)를 싣는다');
  assert.equal(base.sections.length, 1, '기준 문서는 그대로(사본을 이었다)');
  const real = realSectionHunks(r);
  assert.deepEqual(real.hunks.map((h) => h.headRef), ['s1/p0', 's1/p1', 's1/p2']);
  assert.ok(real.unsupported.some((u) => u.what === 'format' && /구역 수가 바뀌었습니다/.test(u.detail)));
  // 반대로 기준이 구역을 더 가지면 그 구역 문단은 지움(구역별 주소)
  const back = realSectionHunks(await diffDocs(two, base));
  assert.deepEqual(back.hunks.map((h) => [h.type, h.ref]), [['delete', 's1/p0'], ['delete', 's1/p1'], ['delete', 's1/p2']]);
});

test('diffDocs: 실제 보고서 — 칸·캡션 글 바꿈과 본문 문단 넣기', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const base = await HwpxDoc.load(fs.readFileSync(BIZ));
  const head = await HwpxDoc.load(fs.readFileSync(BIZ));
  const cap = base.text('s0/p3/n0');
  head.mergeParagraphText('s0/p3/n8', '270', { author }); // 표 (1,1) 268 → 270
  head.mergeParagraphText('s0/p3/n0', `${cap} 고침`, { author }); // 캡션
  head.insertParagraphAfter(0, 1, '새 문단', { author }); // 뒤 문단 번호가 하나씩 밀려도 ref 는 기준 문서
  head.acceptAll();
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map(strip), [
    { type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '새 문단', cell: null },
    { type: 'replace', ref: 's0/p3/n0', baseText: cap, newText: `${cap} 고침`, cell: null },
    { type: 'replace', ref: 's0/p3/n8', baseText: '268', newText: '270', cell: { table: 's0/p3#t0', row: 1, col: 1 } },
  ]);
  assert.deepEqual((await diffDocs(base, head)).hunks.map((h) => h.hid), r.hunks.map((h) => h.hid));
});

test('diffDocs: 편집기(rhwp) 내보내기 — 표 개체만 지움·빈 줄에 그림·표 문단에 글 + 칸·표 앞 빈 줄 지움 + 칸', { skip: !(hasBiz && hasRhwp) && 'biz 표본 또는 rhwp 없음' }, async () => {
  const mod = await rhwp();
  const base = await (await HwpxDoc.load(fs.readFileSync(BIZ))).flattened(); // 편집기가 받는 작업본(최종본)
  const bytes = new Uint8Array(await base.save());
  const edit = async (fn) => { const d = new mod.HwpDocument(bytes.slice()); fn(d); return HwpxDoc.load(Buffer.from(d.exportHwpx())); };
  const ws = (u) => u.map(({ ref, what }) => [ref, what]);
  const n = base.sections[0].bodyParas.length;
  const mergedCount = async (head) => { const a = await base.clone(); a.mergeBodyTexts(head.bodyEntries(), { author }); return a.sections[0].bodyParas.length; };
  assert.deepEqual([1, 3].map((i) => base.bodyEntries()[0][i].kind), ['empty', 'table']);
  // 표 개체만 지움 → 그 문단은 빈 줄로 남는다: 빈 문단을 더하지 않고 그 문단의 표 지움(object — 2026-10-28 부터 반영)
  let head = await edit((d) => d.deleteTableControl(0, 3, 0));
  let r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref, h.objectSummary]), ws(r.unsupported)], [[['object', 's0/p3', '표 지움']], []]);
  assert.equal(await mergedCount(head), n);
  // 빈 줄에 그림 → 빈 줄 지움 덩어리가 없고 그 문단의 그림 넣음(object 덩어리 — 2026-10-28 부터 반영)
  head = await edit((d) => d.insertPicture(0, 1, 0, '', PNG_1PX, 1000, 1000, 1, 1, 'png', ''));
  r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref]), ws(r.unsupported)], [[['object', 's0/p1']], []]);
  assert.match(r.hunks[0].objectSummary, /그림 넣음/);
  assert.equal(await mergedCount(head), n);
  // 표 문단(표 뒤)에 글 + 칸 고침 → 그 문단 replace + 칸 replace
  head = await edit((d) => { d.insertTextInCell(0, 3, 0, 5, 0, 0, '9'); d.insertText(0, 3, d.getParagraphLength(0, 3), ' (단위: 명)'); });
  r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map((h) => [h.type, h.ref, h.baseText, h.newText]), [['replace', 's0/p3', '', ' (단위: 명)'], ['replace', 's0/p3/n6', '2025년', '92025년']]);
  assert.deepEqual(r.hunks[1].cell, { table: 's0/p3#t0', row: 0, col: 5 });
  assert.equal(await mergedCount(head), n);
  // 표 앞 빈 줄 지움 + 칸 고침 → 빈 줄 지움, 표는 제 짝(칸 replace)
  head = await edit((d) => { d.deleteParagraph(0, 1); d.insertTextInCell(0, 2, 0, 5, 0, 0, '9'); });
  r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref, h.newText]), r.unsupported], [[['delete', 's0/p1', ''], ['replace', 's0/p3/n6', '92025년']], []]);
});

// ───────── 종류를 보는 mergeBodyTexts ─────────

test('mergeBodyTexts: bodyEntries 를 넘기면 종류까지 보고 정렬한다(표 앞 빈 줄을 지워도 표 칸이 병합된다)', async () => {
  const base = await tableDoc();
  const head = await base.clone();
  head.removeBodyParagraph(0, 1); head.mergeParagraphText('s0/p1/n3', '2', { author }); head.acceptAll(); // [글, 표(칸 (1,1)=2), 글, 글]
  const a = await base.clone();
  const repA = a.mergeBodyTexts(head.bodyEntries(), { author: '편집자', date: DATE });
  assert.deepEqual([repA.deleted, repA.changed, repA.inserted, repA.skippedNested], [['s0/p1'], ['s0/p2/n3'], [], []]);
  assert.equal(a.text('s0/p2/n3', 'markup'), '[-1-]{+2+}');
  // 글만 넘기면(예전 방식) 빈 줄 ↔ 표가 짝이 되어 칸 병합을 건너뛴다
  const b = await base.clone();
  const repB = b.mergeBodyTexts(head.bodyTexts({ nested: true }), { author: '편집자', date: DATE });
  assert.deepEqual([repB.deleted, repB.changed, repB.skippedNested], [['s0/p2'], [], ['s0/p1']]);
});
