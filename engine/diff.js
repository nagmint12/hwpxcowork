// 문단 목록 정렬·글자 차이·글자 단위 3-way 병합 — 순수 함수 모음(V3_SPEC §4.1).
// 엔진(engine/doc.js 의 mergeBodyTexts·diffDocs)과 studio 플러그인(별칭 @cowork/engine/diff.js 로 번들)이 같은 정렬 규칙을 쓴다.
// 그래서 이 파일은 'diff' 패키지만 가져온다(Node 전용 모듈·DOM 금지).
// 글 안 위치는 모두 유니코드 코드포인트(엔진 offset 과 같음). similarity 만 예전처럼 UTF-16 두 글자 묶음으로 잰다.
import { diffArrays, diffChars } from 'diff';

/**
 * 정렬 항목. 문자열이면 글만 비교한다(예전 HwpxDoc.mergeBodyTexts 와 똑같은 정렬).
 * 객체이면 글에 더해 다음을 본다(엔진 bodyEntries() 가 이 모양을 만든다):
 *  - kind: 'text'(글 있음) | 'empty'(빈 줄) | 'table'(글 없이 표) | 'object'(글 없이 그림·도형 등). 없으면 글로 정한다(text/empty).
 *    'text'·'empty' 끼리는 짝지을 수 있고(빈 줄에 글을 쓰거나 글을 다 지운 문단 = 바꿈), 표·개체 문단은 같은 종류끼리 짝짓는다.
 *    다만 sig 가 같으면(빈 글이 아닐 때) 종류가 달라도 짝짓는다(표·그림만 있던 문단에 글을 쓰거나 글을 다 지운 문단 — 구조가 그대로).
 *    또 바뀐 덩어리에서 짝을 고른 뒤 짝 사이 틈에 글 없는 문단(빈 줄·표·개체)이 양쪽에 남으면 종류가 달라도 짝짓는다
 *    (같은 자리 문단이 표·그림을 잃거나 얻음 — 표를 지워 빈 줄만 남음, 빈 줄에 그림을 넣음).
 *  - sig: 구조 표시(문자열). 양쪽 항목에 모두 있을 때만 '같은 문단' 판정에 쓴다.
 *  - grid: 칸 문단 수를 보지 않는 구조 표시(엔진 _bodyInfo — 칸 안 Enter·Backspace 로 칸 문단 수만 바뀐 표 문단끼리 같다). 양쪽에 있고 같으면
 *    종류가 달라도 짝지을 수 있다(sig 와 같은 규칙 — 표만 있던 문단에 글을 쓰면서 칸도 나눈 경우). '같은 문단' 판정에는 쓰지 않는다.
 *  - fmt: 빈 줄의 모양·부호 지문(엔진 _bodyInfo — 글로 가릴 수 없는 빈 줄끼리 제 짝을 찾게). 양쪽 항목에 모두 있을 때만 '같은 문단' 판정에 쓴다.
 *  - nested: 중첩 문단(표 칸 등) 글 목록(문자열 또는 {text}). 양쪽 모두 있을 때만 '같은 문단' 판정에 쓰고(모양이 같은 표 여럿을 구별),
 *    글 없는 문단(표 등)끼리 비슷한 정도를 잴 때 글 대신 쓴다.
 * @typedef {string | { text?: string, kind?: string, sig?: string|null, grid?: string|null, fmt?: string|null, nested?: Array<string|{text?: string}> }} BodyEntry
 */

/**
 * 정렬 단계의 동작 하나. i = 옛 목록 번호, j = 새 목록 번호(둘 다 목록 전체 기준).
 * @typedef {{op: 'pair', i: number, j: number} | {op: 'del', i: number} | {op: 'ins', j: number}} PlanOp
 */

const TEXTUAL = new Set(['text', 'empty']);
const PAIR_LIMIT = 2500; // 바뀐 덩어리의 옛×새 문단 수가 이보다 크면 비슷함을 재지 않고 차례로 짝짓는다(예전과 같은 값)
// 차이 계산(diff 패키지 — Myers) 편집 거리 상한. 시간이 (편집 거리)² 로 늘어서, 길고 통째로 다른 두 글(긴 문단을 다 바꿈)은
// 상한 없이 몇십 초 동안 서버(이벤트 루프)를 멈춘다(12,000자 두 글 ≈ 21초). 상한을 넘으면 diff 가 그만두고(undefined) 대신 길로 간다:
// 글자 차이는 앞뒤 같은 부분을 뺀 가운데를 통째로 바꾸는 편집 하나, 문단 정렬은 앞뒤 같은 문단을 뺀 가운데를 바뀐 덩어리 하나로.
// 상한 1000 이면 가장 나쁜 경우도 0.1초 안쪽(이 PC 측정). 보통 고침(몇 곳·몇백 글자)은 상한에 닿지 않아 결과가 예전과 같다.
const MAX_EDIT = 1000;

/**
 * 문단 종류(정렬 항목 kind). 글이 있으면 'text', 글이 없으면 표 → 'table', 그림·도형 등 개체 → 'object', 아무것도 없으면 'empty'.
 * @param {string} text 문단 최종본 글
 * @param {{tables?: number, objects?: number}} [counts] 그 문단이 직접 가진 표·개체 수
 * @returns {'text'|'empty'|'table'|'object'}
 */
export function entryKind(text, { tables = 0, objects = 0 } = {}) {
  if (text) return 'text';
  if (tables > 0) return 'table';
  return objects > 0 ? 'object' : 'empty';
}

/**
 * 옛 문단 목록과 새 목록의 정렬(짝)과 바꿀 단계.
 * 1) diffArrays 로 그대로인 구간을 찾는다(같음 = 글이 같음; 객체 항목이면 종류·sig·중첩 글까지 같음).
 * 2) 바뀐 덩어리(지운 r개 + 넣은 a개) 안에서는 순서를 지키며 비슷한 글끼리 짝짓는다(두 글자 묶음 Dice).
 *    짝 수는 둘 중 작은 쪽(남는 쪽은 삭제·추가), 비슷함이 같으면 앞쪽끼리. r === a 이거나 r·a > 2500 이면 앞에서부터 차례로 짝짓는다.
 *    객체 항목에서 짝지을 수 없는 종류(표 ↔ 빈 줄 등)가 섞인 덩어리는 짝지을 수 있는 것끼리 '짝 수 최대 → 비슷함 합 최대'로 고르고
 *    (r·a > 2500 이면 짝지을 수 있는지만 보고 diffArrays 로), 짝 사이 틈에 양쪽으로 남은 글 없는 문단(빈 줄·표·개체)을
 *    빈 줄부터 짝짓는다(fillGaps — 같은 자리 문단이 표·그림을 잃거나 얻은 것, 빈 문단 넣기·지우기를 만들지 않는다).
 * 문자열 목록이면 예전 HwpxDoc.mergeBodyTexts 의 정렬과 결과가 똑같다.
 * @param {BodyEntry[]} oldEntries 옛(기준) 문단 목록
 * @param {BodyEntry[]} newEntries 새 문단 목록
 * @returns {{ pairs: Array<[number, number]>, plan: Array<{ at: number, ops: PlanOp[] }> }}
 *   pairs = 짝 [옛 번호, 새 번호](문서 순서, 그대로인 문단 포함).
 *   plan = 바뀐 덩어리마다 한 단계(문서 순서): at = 덩어리가 시작하는 옛 번호(넣기만 있으면 그 자리 앞),
 *   ops = 덩어리 안 동작(문서 순서; 짝 사이 틈에서는 삭제 다음 추가).
 */
export function planBody(oldEntries, newEntries) {
  return planBodyFree(Array.from(oldEntries || []), Array.from(newEntries || []));
}

/**
 * [hwpx-cowork] planBody 와 같되 옛 첫 문단(구역 정의 secPr 를 품은 문단 — 서버는 지우지 못한다)이 짝 없이 지워질 정렬이면 새 첫 문단과
 * 짝짓고 나머지를 다시 정렬한다(diffDocs — 실시간 반영·변경 요청의 덩어리). 머리말·꼬리말만 든 둘째 빈 줄을 첫 줄로 합치면 새 첫 문단이
 * 옛 둘째 문단을 닮아(중첩 머리말) 정렬이 옛 첫 문단을 지우려 했다(지우지 못해 둘째 문단에 첫 문단의 부호가 옮겨 가는 등 덩어리가 엉켰다).
 * 맨 앞에 문단을 넣은 정렬(옛 첫 문단이 뒤 문단과 짝)은 그대로
 */
export function planBodyAnchored(oldEntries, newEntries) {
  const olds = Array.from(oldEntries || []); const news = Array.from(newEntries || []);
  const out = planBodyFree(olds, news);
  if (!olds.length || !news.length || out.pairs.some(([i]) => i === 0)) return out;
  const rest = planBodyFree(olds.slice(1), news.slice(1));
  const shift = (o) => (o.op === 'pair' ? { op: 'pair', i: o.i + 1, j: o.j + 1 } : o.op === 'del' ? { op: 'del', i: o.i + 1 } : { op: 'ins', j: o.j + 1 });
  return {
    pairs: [[0, 0], ...rest.pairs.map(([i, j]) => [i + 1, j + 1])],
    plan: [{ at: 0, ops: [{ op: 'pair', i: 0, j: 0 }] }, ...rest.plan.map((s) => ({ at: s.at + 1, ops: s.ops.map(shift) }))],
  };
}

function planBodyFree(olds, news) {
  const rich = olds.some(isObj) || news.some(isObj);
  const A = rich ? olds.map(normEntry) : olds.map(toText);
  const B = rich ? news.map(normEntry) : news.map(toText);
  // 편집 거리가 상한(MAX_EDIT)을 넘으면 diffArrays 가 undefined — 앞뒤 같은 문단만 빼고 가운데를 바뀐 덩어리 하나로 본다.
  // 글로 센 아래 한계(같은 문단은 글이 같다)만으로 넘으면 돌리지 않는다
  const same = rich ? sameEntry : (x, y) => x === y;
  const keyOf = rich ? (e) => e.text : (t) => t;
  const blocks = (editLowerBound(A.map(keyOf), B.map(keyOf)) <= MAX_EDIT
    ? diffArrays(A, B, rich ? { comparator: sameEntry, maxEditLength: MAX_EDIT } : { maxEditLength: MAX_EDIT })
    : undefined) || middleBlocks(A, B, same);
  const pairs = []; const plan = []; let oi = 0; let ni = 0;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (!b.added && !b.removed) {
      for (let t = 0; t < b.value.length; t++) pairs.push([oi + t, ni + t]);
      oi += b.value.length; ni += b.value.length; continue;
    }
    let r = 0; let a = 0;
    if (b.removed) {
      r = b.value.length;
      const next = blocks[k + 1]; if (next && next.added) { a = next.value.length; k++; }
    } else a = b.value.length;
    const rem = A.slice(oi, oi + r); const add = B.slice(ni, ni + a);
    const rel = rich ? alignEntries(rem, add) : alignBlock(rem, add);
    const ops = rel.map((o) => (o.op === 'pair' ? { op: 'pair', i: oi + o.i, j: ni + o.j } : o.op === 'del' ? { op: 'del', i: oi + o.i } : { op: 'ins', j: ni + o.j }));
    for (const o of ops) if (o.op === 'pair') pairs.push([o.i, o.j]);
    plan.push({ at: oi, ops }); oi += r; ni += a;
  }
  return { pairs, plan };
}

/**
 * 문단 목록의 바뀐 곳(planBody 정렬 기준, 문서 순서).
 *  - replace {i, j}: 짝지어졌고 글이 다름(글이 같고 구조만 다른 짝은 넣지 않는다)
 *  - insert {j, afterI}: 새 문단 — afterI = 바로 앞 옛 문단 번호(짝·삭제 문단, 없으면 덩어리 바로 앞), 목록 맨 앞이면 -1
 *  - delete {i}: 짝 없는 옛 문단
 * @param {BodyEntry[]} oldEntries
 * @param {BodyEntry[]} newEntries
 * @returns {Array<{type: 'replace', i: number, j: number} | {type: 'insert', j: number, afterI: number} | {type: 'delete', i: number}>}
 */
export function diffEntries(oldEntries, newEntries) {
  const olds = Array.from(oldEntries || []); const news = Array.from(newEntries || []);
  const { plan } = planBody(olds, news);
  const out = [];
  for (const step of plan) {
    let last = step.at - 1;
    for (const o of step.ops) {
      if (o.op === 'ins') { out.push({ type: 'insert', j: o.j, afterI: last }); continue; }
      if (o.op === 'del') out.push({ type: 'delete', i: o.i });
      else if (textOf(olds[o.i]) !== textOf(news[o.j])) out.push({ type: 'replace', i: o.i, j: o.j });
      last = o.i;
    }
  }
  return out;
}

/**
 * 글 a 를 글 b 로 만드는 글자 단위 편집 목록(diffChars) — 코드포인트 위치, a 기준, 앞에서부터(겹치지 않음).
 * 지움 바로 뒤의 넣음은 바꿈 하나로 묶는다. HwpxDoc.mergeParagraphText 가 이 목록을 뒤에서부터 변경 추적으로 적용한다.
 * @param {string} a 옛 글
 * @param {string} b 새 글
 * @returns {Array<{start: number, end: number, text: string}>} [start,end) 를 text 로 바꾼다(start === end 이면 넣기)
 */
export function charOps(a, b) {
  a = toText(a); b = toText(b);
  if (a === b) return [];
  // 편집 거리가 상한을 넘으면 앞뒤 같은 부분을 뺀 가운데를 통째로 바꾸는 편집 하나(MAX_EDIT 설명).
  // 글자 수로 센 아래 한계만으로 넘으면 diff 를 돌리지 않는다(통째로 다시 쓴 긴 문단 — 자동 저장마다 상한까지 도는 시간도 아낌)
  const A = Array.from(a); const B = Array.from(b);
  const parts = editLowerBound(A, B) <= MAX_EDIT ? diffChars(a, b, { maxEditLength: MAX_EDIT }) : undefined;
  if (!parts) return [middleOp(A, B)];
  const ops = []; let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const len = cpLen(part.value);
    if (part.added) { ops.push({ start: pos, end: pos, text: part.value }); continue; }
    if (part.removed) {
      const next = parts[i + 1];
      if (next && next.added) { ops.push({ start: pos, end: pos + len, text: next.value }); i++; }
      else ops.push({ start: pos, end: pos + len, text: '' });
      pos += len; continue;
    }
    pos += len;
  }
  return ops;
}

/** [hwpx-cowork] 편집 목록의 비용 = 지운 글자 + 넣은 글자 수 */
function opsCost(ops) { let n = 0; for (const o of ops) n += (o.end - o.start) + cpLen(o.text); return n; }

/**
 * [hwpx-cowork] 문단 합침 알아보기(문단 나눔 변경 추적 2단계 — 한/글 Backspace·끝에서 Delete): 잇닿은 기준 문단 글들(baseTexts)이 수정본 한 문단(headText)이
 * 됐을 때, 이은 글(baseTexts 를 그대로 이음)에서 headText 로 가는 글자 편집 비용이 '첫 문단 바꿈 + 나머지 지우기'보다 크지 않으면 join(나눔만 지우고 글은
 * 이은 글에 charOps) → { join, joinCost, replaceCost }. 기준이 하나뿐이면 join 아님
 */
export function joinPlan(baseTexts, headText) {
  const list = Array.from(baseTexts || [], toText); const head = toText(headText);
  if (list.length < 2) return { join: false, joinCost: 0, replaceCost: 0 };
  const joinCost = opsCost(charOps(list.join(''), head));
  const replaceCost = opsCost(charOps(list[0], head)) + list.slice(1).reduce((n, t) => n + cpLen(t), 0);
  return { join: joinCost <= replaceCost, joinCost, replaceCost };
}

/**
 * [hwpx-cowork] 문단 가름 알아보기(2단계 — 한/글 가운데 Enter): 기준 한 문단(baseText)이 수정본 여러 문단(headTexts)이 됐을 때, 수정본을 이은 글로 보는
 * 글자 편집 비용이 '첫 문단 바꿈 + 나머지 새 문단 넣기'보다 싸면 가를 자리(기준 최종본 코드포인트 offset, 오름차순 — 문단 수 − 1 개)를, 아니면 null.
 * 가를 자리는 이은 글의 문단 경계를 charOps 로 기준 글에 옮긴 것(바뀐 글 한가운데면 그 편집 앞, 넣은 글 끝이면 그 편집 뒤)
 */
export function splitPoints(baseText, headTexts) {
  const base = toText(baseText); const heads = Array.from(headTexts || [], toText);
  if (heads.length < 2) return null;
  const ops = charOps(base, heads.join(''));
  const splitCost = opsCost(ops);
  const defaultCost = opsCost(charOps(base, heads[0])) + heads.slice(1).reduce((n, t) => n + cpLen(t), 0);
  if (splitCost >= defaultCost) return null;
  const toBase = (H) => {
    let b = 0; let h = 0;
    for (const o of ops) {
      const L = o.start - b;
      if (H <= h + L) return b + (H - h);
      h += L; b = o.start;
      const I = cpLen(o.text);
      if (H <= h + I) return H === h + I ? o.end : o.start;
      h += I; b = o.end;
    }
    return b + (H - h);
  };
  const out = []; let H = 0;
  for (let k = 0; k < heads.length - 1; k++) { H += cpLen(heads[k]); out.push(toBase(H)); }
  for (let k = 1; k < out.length; k++) if (out[k] < out[k - 1]) out[k] = out[k - 1];
  return out;
}

/**
 * 글자 단위 3-way 병합. base 에서 mine·theirs 로 간 편집(charOps)을 함께 적용한다(= theirs 에 mine 의 편집을 얹음).
 * 두 쪽 편집이 겹치면 충돌이다: 범위가 겹치거나, 같은 자리에 서로 다른 글을 넣거나, 한쪽이 지우거나 바꾼 범위 '안'에 다른 쪽이 넣은 경우.
 * 범위 끝에 맞닿은 넣기는 충돌이 아니다(바뀐 범위 앞·뒤에 들어간다). 두 쪽이 똑같이 바꾼 곳은 한 번만 적용하고 충돌이 아니다.
 * @param {string} base 공통 조상 글
 * @param {string} mine 내 글
 * @param {string} theirs 다른 쪽(지금) 글
 * @returns {{ ok: true, text: string } | { ok: false, conflicts: Array<{ start: number, end: number, base: string, mine: string, theirs: string }> }}
 *   conflicts 의 start·end 는 base 의 코드포인트 범위(겹친 편집들을 합친 범위), base·mine·theirs 는 그 범위의 각 쪽 글
 */
export function merge3(base, mine, theirs) {
  base = toText(base); mine = toText(mine); theirs = toText(theirs);
  if (mine === theirs) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: theirs };
  if (theirs === base) return { ok: true, text: mine };
  const M = charOps(base, mine); const T = charOps(base, theirs);
  const shared = new Set(); const edges = [];
  for (let a = 0; a < M.length; a++) {
    for (let b = 0; b < T.length; b++) {
      if (sameOp(M[a], T[b])) shared.add(b);
      else if (clash(M[a], T[b])) edges.push([a, b]);
    }
  }
  const cp = Array.from(base);
  if (!edges.length) return { ok: true, text: applyOps(cp, 0, cp.length, [...M, ...T.filter((_, b) => !shared.has(b))]) };
  // 충돌 묶음: 서로 겹친 편집을 이어 붙인 덩어리(합집합 찾기). 노드 번호 = mine 은 a, theirs 는 M.length + b
  const parent = Array.from({ length: M.length + T.length }, (_, n) => n);
  const find = (n) => { while (parent[n] !== n) { parent[n] = parent[parent[n]]; n = parent[n]; } return n; };
  for (const [a, b] of edges) parent[find(a)] = find(M.length + b);
  const groups = new Map();
  for (const [a, b] of edges) {
    for (const n of [a, M.length + b]) { const root = find(n); if (!groups.has(root)) groups.set(root, new Set()); groups.get(root).add(n); }
  }
  const conflicts = [...groups.values()].map((set) => {
    const ms = [...set].filter((n) => n < M.length).map((n) => M[n]);
    const ts = [...set].filter((n) => n >= M.length).map((n) => T[n - M.length]);
    const all = [...ms, ...ts];
    const start = Math.min(...all.map((o) => o.start)); const end = Math.max(...all.map((o) => o.end));
    return { start, end, base: cp.slice(start, end).join(''), mine: applyOps(cp, start, end, ms), theirs: applyOps(cp, start, end, ts) };
  });
  conflicts.sort((x, y) => (x.start - y.start) || (x.end - y.end));
  return { ok: false, conflicts };
}

/**
 * 칸 접기(V4 §2.2 — 칸 문단 수가 달라진 표 칸): 수정본 칸 문단(head, 차례)마다 그 글을 받을 기준 칸 문단(base, 차례) 번호.
 * 엔진 diffDocs(수정본 → 기준: 칸 문단 수는 그대로 두고 받은 문단 글을 '\n' 으로 이어 그 기준 문단 글로, 받은 것이 없는 기준 문단은 빈 글)와
 * studio 플러그인 맞추기(기준 → 편집기: 편집기 칸 문단을 묶음마다 합쳐 기준 칸 문단 수로)가 같이 쓴다.
 *  - 닻: 글이 같은(빈 문단이 아닌) 문단끼리 차례대로 짝(diffArrays) — 그대로인 문단은 그대로. 빈 문단끼리는 어느 것이 짝인지 가릴 수 없어
 *    닻으로 삼지 않는다(칸 안 빈 줄이 많은 서식에서 엉뚱한 빈 줄에 닻을 내려 글이 다음 문단으로 밀리지 않게). 대신 닻 사이 틈의 맨 앞·맨 뒤에서
 *    양쪽 모두 빈 문단이면 그 빈 문단끼리 짝(서식의 빈 줄은 빈 줄로 남고, 새 줄은 Enter 한 문단으로 — 그 문단 모양 그대로)
 *  - 남은 틈에 기준·수정본 문단이 다 있으면 틈의 글을 문단 구분 글자(U+2029)로 이어 글자 단위로 맞추고(charOps), 수정본 문단마다
 *    첫 글자가 맞는 기준 문단으로(Enter 로 나눈 뒤쪽 조각은 나뉜 문단으로, Backspace 로 합친 글은 앞 문단으로 — 글이 제자리에 남는다)
 *  - 수정본 문단만 있는 틈(새 문단만)은 바로 앞 닻 기준 문단(끝에서 Enter 하고 친 글), 새 문단이 모두 빈 문단이고 뒤에 닻이 있으면 바로 뒤
 *    닻(그 문단 맨 앞에서 Enter — 빈 줄이 그 문단 앞에), 칸 맨 앞이면 바로 뒤 닻으로
 * 주인은 문서 차례대로 늘기만 한다 — 기준 문단마다 받은 수정본 문단을 차례로 '\n' 으로 이으면(받은 것이 없는 문단 빼고) 수정본 글 차례 그대로.
 * @param {string[]} base 기준 칸 문단 글(한 개 이상)
 * @param {string[]} head 수정본 칸 문단 글
 * @returns {number[]} owner[j] = 수정본 문단 j 의 글을 받을 기준 문단 번호(base 가 비면 모두 0)
 */
export function foldOwners(base, head) {
  const bt = Array.from(base || [], toText); const ht = Array.from(head || [], toText);
  const owner = new Array(ht.length).fill(-1);
  if (!bt.length) return owner.fill(0);
  const same = (x, y) => x === y && x !== '';
  const blocks = (editLowerBound(bt, ht) <= MAX_EDIT ? diffArrays(bt, ht, { comparator: same, maxEditLength: MAX_EDIT }) : undefined) || middleBlocks(bt, ht, same);
  let pi = -1; let pj = -1;
  /** 닻 (pi, pj) 와 (i2, j2) 사이 틈의 수정본 문단 주인 */
  const gap = (i2, j2) => {
    let bLo = pi + 1; let bHi = i2; let hLo = pj + 1; let hHi = j2; let prev = pi; let next = i2;
    if (hLo >= hHi) return;   // 기준 문단만 — 받은 것이 없다
    // 틈 맨 앞·맨 뒤의 빈 문단끼리 짝
    while (bLo < bHi && hLo < hHi && bt[bLo] === '' && ht[hLo] === '') { owner[hLo] = bLo; prev = bLo; bLo++; hLo++; }
    while (bLo < bHi && hLo < hHi && bt[bHi - 1] === '' && ht[hHi - 1] === '') { owner[hHi - 1] = bHi - 1; next = bHi - 1; bHi--; hHi--; }
    if (hLo >= hHi) return;
    const bi = []; for (let i = bLo; i < bHi; i++) bi.push(i);
    const hj = []; for (let j = hLo; j < hHi; j++) hj.push(j);
    if (!bi.length) {
      const toNext = next < bt.length && (prev < 0 || hj.every((j) => ht[j] === ''));
      for (const j of hj) owner[j] = toNext ? next : Math.max(prev, 0);
      return;
    }
    const bStar = bi.map((i) => bt[i]).join(PARA_SEP);
    const ops = charOps(bStar, hj.map((j) => ht[j]).join(PARA_SEP));
    const seps = []; let c = 0;
    for (const ch of bStar) { if (ch === PARA_SEP) seps.push(c); c++; }
    let at = 0;
    for (const j of hj) {
      const x = mapBack(ops, at);
      owner[j] = bi[Math.min(seps.filter((s) => s < x).length, bi.length - 1)];
      at += cpLen(ht[j]) + 1;
    }
  };
  let oi = 0; let ni = 0;
  for (const b of blocks) {
    const n = b.value.length;
    if (b.added) { ni += n; continue; }
    if (b.removed) { oi += n; continue; }
    for (let t = 0; t < n; t++) { gap(oi + t, ni + t); owner[ni + t] = oi + t; pi = oi + t; pj = ni + t; }
    oi += n; ni += n;
  }
  gap(bt.length, ht.length);
  for (let j = 0; j < ht.length; j++) if (owner[j] < 0) owner[j] = j > 0 ? owner[j - 1] : 0;   // (모든 수정본 문단을 다루므로 지킴용)
  return owner;
}

/**
 * 두 글의 비슷한 정도(0..1, 두 글자 묶음 Dice). 같으면 1, 어느 한쪽이 두 글자(UTF-16) 미만이면 0.
 * @param {string} x
 * @param {string} y
 * @returns {number}
 */
export function similarity(x, y) {
  x = toText(x); y = toText(y);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let k = 0; k < x.length - 1; k++) { const g = x.slice(k, k + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hit = 0;
  for (let k = 0; k < y.length - 1; k++) { const g = y.slice(k, k + 2); const c = grams.get(g); if (c) { hit++; grams.set(g, c - 1); } }
  return (2 * hit) / (x.length + y.length - 2);
}

// ───────── 내부 도우미 ─────────

const isObj = (e) => e !== null && typeof e === 'object';
const toText = (v) => (typeof v === 'string' ? v : String(v ?? ''));
const textOf = (e) => (isObj(e) ? toText(e.text) : toText(e));
function cpLen(s) { let n = 0; for (const _ of s) n++; return n; }

/** 객체 정렬 항목 → 비교용 {text, kind, sig, grid, fmt, nk(중첩 글 열쇠|null), st(비슷함 잴 글)} */
function normEntry(e) {
  if (!isObj(e)) { const text = toText(e); return { text, kind: text ? 'text' : 'empty', sig: null, grid: null, fmt: null, nk: null, st: text }; }
  const text = toText(e.text);
  const kind = e.kind != null && e.kind !== '' ? String(e.kind) : (text ? 'text' : 'empty');
  const nested = Array.isArray(e.nested) ? e.nested.map((n) => toText(isObj(n) ? n.text : n)) : null;
  return {
    text, kind, sig: e.sig ?? null, grid: e.grid ?? null, fmt: e.fmt ?? null,
    nk: nested ? `${nested.length}\u0001${nested.join('\u0000')}` : null,
    st: text || (nested ? nested.join('\n') : ''),
  };
}

/** 같은 문단인가: 글·종류가 같고, sig·fmt·중첩 글은 양쪽 모두 있을 때만 같아야 한다 */
function sameEntry(x, y) {
  return x.text === y.text && x.kind === y.kind
    && (x.sig == null || y.sig == null || x.sig === y.sig)
    && (x.fmt == null || y.fmt == null || x.fmt === y.fmt)
    && (x.nk == null || y.nk == null || x.nk === y.nk);
}

/** 짝지을 수 있는 종류 묶음: 글 문단(text·empty)은 하나로, 나머지는 종류 그대로 */
const classOf = (e) => (TEXTUAL.has(e.kind) ? 'text' : e.kind);

/**
 * 짝지을 수 있는가: 종류 묶음이 같거나, 양쪽 sig 가 같다(빈 글이 아닐 때) — 또는 양쪽 grid(칸 문단 수를 보지 않는 구조)가 같다.
 * sig 가 같으면 표·개체 구조가 그대로인 같은 문단이다 — 표만 있던 문단에 글을 쓰거나(표 → 글) 글을 다 지운 경우(글 → 표). 칸 글도 비교할 수 있다.
 * grid 가 같으면 칸 문단 수만 다른 같은 표 문단이다(칸 안 Enter 와 함께 표 문단에 글을 씀 — 칸 글은 diffDocs 가 접어서 비교한다).
 */
const compatible = (x, y) => classOf(x) === classOf(y) || (!!x.sig && x.sig === y.sig) || (!!x.grid && x.grid === y.grid);

/** 빈 줄: 글도 표·개체도 없는 글 문단 */
const isBlank = (e) => !e.text && TEXTUAL.has(e.kind);

/**
 * (예전 HwpxDoc 내부 함수 그대로) 바뀐 덩어리 안의 옛 글(rem)과 새 글(add)을 순서를 지키며 짝짓는다.
 * 짝 수는 둘 중 작은 쪽(남는 쪽은 삭제·추가), 어느 것끼리 짝지을지는 글이 비슷한 쪽(두 글자 묶음 Dice)으로 고른다
 * — 바뀐 문단 앞에 새 문단을 넣어도 옛 문단이 제 짝을 찾는다. 같으면 앞쪽끼리 짝짓는다.
 * → [{op:'pair',i,j} | {op:'del',i} | {op:'ins',j}] (덩어리 안 번호, 문서 순서)
 */
function alignBlock(rem, add) {
  const r = rem.length; const a = add.length; const n = Math.min(r, a);
  const naive = () => {
    const ops = [];
    for (let k = 0; k < n; k++) ops.push({ op: 'pair', i: k, j: k });
    for (let k = n; k < a; k++) ops.push({ op: 'ins', j: k });
    for (let k = n; k < r; k++) ops.push({ op: 'del', i: k });
    return ops;
  };
  if (!n || r === a || r * a > PAIR_LIMIT) return naive();
  // 짧은 쪽(S)을 모두 긴 쪽(L)의 어딘가와 짝짓는 순서 보존 정합: f[i][j] = S 앞 i개를 L 앞 j개 안에 짝지었을 때 최대 유사도
  const remShort = r < a; const S = remShort ? rem : add; const L = remShort ? add : rem;
  const sim = (i, j) => similarity(S[i], L[j]);
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

/**
 * 객체 항목 덩어리 정렬. 짝지을 수 있는 종류가 하나뿐이면 예전 alignBlock(비슷함은 st 로) 그대로,
 * 섞여 있으면 짝지을 수 있는 것끼리(compatible) '짝 수 최대 → 비슷함 합 최대'(같으면 앞쪽끼리)로 짝짓고,
 * 짝 사이 틈에 양쪽으로 남은 글 없는 문단을 채운다(fillGaps).
 */
function alignEntries(rem, add) {
  const classes = new Set([...rem, ...add].map(classOf));
  if (classes.size <= 1 || !rem.length || !add.length) return alignBlock(rem.map((e) => e.st), add.map((e) => e.st));
  const r = rem.length; const a = add.length;
  return opsFromMatches(fillGaps(r * a > PAIR_LIMIT ? classMatches(rem, add) : bestMatches(rem, add), rem, add), r, a);
}

/** 순서 보존 짝 고르기(동적 계획법): 점수 = 짝 수 × W + 비슷함 합(W 가 비슷함 합의 최댓값보다 커서 짝 수가 먼저) */
function bestMatches(rem, add) {
  const r = rem.length; const a = add.length; const W = Math.min(r, a) + 1;
  const gain = new Float64Array(r * a).fill(-1);
  for (let i = 0; i < r; i++) for (let j = 0; j < a; j++) if (compatible(rem[i], add[j])) gain[i * a + j] = W + similarity(rem[i].st, add[j].st);
  const f = Array.from({ length: r + 1 }, () => new Float64Array(a + 1));
  for (let i = 1; i <= r; i++) {
    for (let j = 1; j <= a; j++) {
      let v = Math.max(f[i - 1][j], f[i][j - 1]);
      const g = gain[(i - 1) * a + (j - 1)];
      if (g >= 0) v = Math.max(v, f[i - 1][j - 1] + g);
      f[i][j] = v;
    }
  }
  // 뒤에서부터 되짚되, 같은 점수면 뒤쪽을 건너뛴다(= 앞쪽끼리 짝)
  const out = []; let i = r; let j = a;
  while (i > 0 && j > 0) {
    if (f[i][j] === f[i][j - 1]) j--;
    else if (f[i][j] === f[i - 1][j]) i--;
    else { out.push([i - 1, j - 1]); i--; j--; }
  }
  return out.reverse();
}

/**
 * 큰 덩어리: 짝지을 수 있는지(compatible)만 보고 diffArrays 로 맞추고(최장 공통 부분), 맞은 구간은 차례로 짝짓는다.
 * 편집 거리가 상한(MAX_EDIT)을 넘으면 같은 번호끼리(짝지을 수 있을 때만) 짝짓는다
 */
function classMatches(rem, add) {
  const parts = Math.abs(rem.length - add.length) <= MAX_EDIT ? diffArrays(rem, add, { comparator: compatible, maxEditLength: MAX_EDIT }) : undefined;
  if (!parts) {
    const out = [];
    for (let k = 0; k < Math.min(rem.length, add.length); k++) if (compatible(rem[k], add[k])) out.push([k, k]);
    return out;
  }
  const out = []; let i = 0; let j = 0;
  for (const p of parts) {
    const n = p.value.length;
    if (p.added) j += n;
    else if (p.removed) i += n;
    else { for (let k = 0; k < n; k++) out.push([i + k, j + k]); i += n; j += n; }
  }
  return out;
}

/**
 * 짝 사이 틈(맨 앞·맨 뒤 포함)마다 양쪽에 남은 글 없는 문단(빈 줄·표·개체)을 종류가 달라도 짝짓는다
 * — 같은 자리 문단이 표·그림을 잃거나 얻은 것으로 본다(표를 지워 빈 줄만 남음, 빈 줄에 그림·표를 넣음).
 * 두 글이 같아('') 바꿈 덩어리가 생기지 않고, 표·개체 차이는 반영 안 되는 변경으로만 남는다
 * (짝짓지 않으면 지움 + 넣음이 되어 반영할 때 빈 문단이 하나 더 생긴다).
 * 틈에서 빈 줄은 한쪽에만 남는다(빈 줄은 글 문단과 짝지을 수 있어, 반대쪽에 글 문단이 있었다면 이미 짝이 됐다).
 * 짝이 모자라면 빈 줄부터 짝을 준다(짝 없는 빈 줄은 빈 문단 넣기·지우기 덩어리가 되지만 표·개체 문단은 덩어리를 만들지 않는다).
 * 나머지는 앞쪽끼리. 글이 있는 문단은 채우지 않는다.
 * @param {Array<[number, number]>} matched 덩어리 안 짝 [옛, 새](문서 순서)
 * @param {Array<object>} rem 덩어리의 옛 항목(normEntry)
 * @param {Array<object>} add 덩어리의 새 항목(normEntry)
 * @returns {Array<[number, number]>} 채운 짝을 더한 짝 목록(문서 순서)
 */
function fillGaps(matched, rem, add) {
  const out = []; let pi = 0; let pj = 0;
  const gap = (i2, j2) => {
    const os = []; for (let i = pi; i < i2; i++) if (!rem[i].text) os.push(i);
    const ns = []; for (let j = pj; j < j2; j++) if (!add[j].text) ns.push(j);
    if (!os.length || !ns.length) return;
    // S = 빈 줄이 있을 수 있는 쪽, R = 반대쪽(표·개체 문단). 둘 다 빈 줄이 없으면 S = 새 쪽
    const oldBlank = os.some((i) => isBlank(rem[i]));
    const S = oldBlank ? os : ns; const R = oldBlank ? ns : os; const src = oldBlank ? rem : add;
    let pick = S;
    if (S.length > R.length) {
      const blanks = S.filter((x) => isBlank(src[x])).slice(0, R.length);
      pick = [...blanks, ...S.filter((x) => !isBlank(src[x])).slice(0, R.length - blanks.length)].sort((x, y) => x - y);
    }
    pick.forEach((s, k) => out.push(oldBlank ? [s, R[k]] : [R[k], s]));
  };
  for (const [i, j] of matched) { gap(i, j); out.push([i, j]); pi = i + 1; pj = j + 1; }
  gap(rem.length, add.length);
  return out;
}

/** 짝 목록 → 동작 목록(문서 순서; 짝 사이 틈에서는 삭제 다음 추가) */
function opsFromMatches(matched, r, a) {
  const ops = []; let pi = 0; let pj = 0;
  for (const [i, j] of matched) {
    for (; pi < i; pi++) ops.push({ op: 'del', i: pi });
    for (; pj < j; pj++) ops.push({ op: 'ins', j: pj });
    ops.push({ op: 'pair', i, j }); pi = i + 1; pj = j + 1;
  }
  for (; pi < r; pi++) ops.push({ op: 'del', i: pi });
  for (; pj < a; pj++) ops.push({ op: 'ins', j: pj });
  return ops;
}

/**
 * 두 목록(글의 코드포인트 배열·문단 글 목록) 사이 편집 거리(넣기 + 지우기 수)의 아래 한계: 길이 합 − 2 × 값별 개수의 공통 몫
 * (가장 긴 공통 부분열은 값마다 두 목록 개수 중 작은 것의 합을 넘지 못한다). 길이에 비례하는 시간.
 */
function editLowerBound(A, B) {
  const left = new Map();
  for (const c of A) left.set(c, (left.get(c) || 0) + 1);
  let common = 0;
  for (const c of B) { const n = left.get(c); if (n) { common++; left.set(c, n - 1); } }
  return A.length + B.length - 2 * common;
}

/**
 * 차이 계산을 그만둔 두 글(코드포인트 배열)의 편집 하나: 앞뒤 같은 부분을 뺀 가운데 [start,end) 를 새 글 가운데로 바꾼다.
 * 길이에 비례하는 시간만 든다(charOps 의 대신 길 — MAX_EDIT)
 */
function middleOp(A, B) {
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { start: p, end: A.length - s, text: B.slice(p, B.length - s).join('') };
}

/**
 * 차이 계산을 그만둔 두 문단 목록의 블록(diffArrays 결과 모양 { value, added?, removed? }): 앞뒤 같은 문단(same)은 그대로,
 * 가운데는 지움 + 넣음 덩어리 하나(planBody 의 대신 길 — MAX_EDIT)
 */
function middleBlocks(A, B, same) {
  let p = 0; while (p < A.length && p < B.length && same(A[p], B[p])) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && same(A[A.length - 1 - s], B[B.length - 1 - s])) s++;
  const out = [];
  if (p) out.push({ value: A.slice(0, p) });
  if (A.length - s > p) out.push({ value: A.slice(p, A.length - s), removed: true });
  if (B.length - s > p) out.push({ value: B.slice(p, B.length - s), added: true });
  if (s) out.push({ value: A.slice(A.length - s) });
  return out;
}

/** foldOwners 가 바뀐 덩어리의 칸 문단 글을 이을 때 문단 구분 글자(문단 글에는 나오지 않는 U+2029) */
const PARA_SEP = ' ';

/** charOps(a, b) 편집 목록에서 b 의 코드포인트 자리 h 에 맞는 a 의 자리(넣은 글 안이면 그 편집이 시작하는 a 자리) */
function mapBack(ops, h) {
  let delta = 0;
  for (const o of ops) {
    const s = o.start + delta;
    if (h < s) break;
    const tl = cpLen(o.text);
    if (h < s + tl) return o.start;
    delta += tl - (o.end - o.start);
  }
  return h - delta;
}

const sameOp = (x, y) => x.start === y.start && x.end === y.end && x.text === y.text;

/** 두 편집(서로 다른 쪽)이 겹치는가 — merge3 의 충돌 규칙 */
function clash(x, y) {
  const xi = x.start === x.end; const yi = y.start === y.end;
  if (xi && yi) return x.start === y.start; // 같은 자리에 서로 다른 글 넣기
  if (xi) return y.start < x.start && x.start < y.end; // 넣은 자리가 다른 쪽 범위 안(끝에 맞닿으면 괜찮다)
  if (yi) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end; // 범위끼리 겹침
}

/** 코드포인트 배열 cp 의 [from,to) 에 편집들(겹치지 않음)을 적용한 글. 같은 자리면 넣기가 범위보다 앞 */
function applyOps(cp, from, to, ops) {
  const list = [...ops].sort((x, y) => (x.start - y.start) || ((x.end - x.start) - (y.end - y.start)));
  let out = ''; let pos = from;
  for (const o of list) { out += cp.slice(pos, o.start).join(''); out += o.text; pos = Math.max(pos, o.end); }
  return out + cp.slice(pos, to).join('');
}
