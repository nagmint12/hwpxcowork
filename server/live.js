// 실시간 수정(docs/V4_SPEC.md §2.2·§2.3): 편집기가 보낸 문서(HWPX — 편집기 내보내기)를 그 편집기의 기준 기록과 비교해
// 지금 공유 기준 문서에 곧바로 넣는다(밀어 넣기, PUT /api/docs/:id/live?base=<n>&seq=<k>). 수정본·변경 요청·승인 없이 기록 하나.
//  - 덩어리 = diffDocs(기준 기록 최종본, 보낸 문서)(수정본 저장과 같은 엔진 — 본문·표 칸·문단 추가·지움·서식, 그림 속성(크기·배치)·조판 부호
//    (자동 번호·새 번호 등)·표·도형(선·사각형·글상자·타원·호·다각형·곡선·연결선·묶음 — 옮김·크기·지움·넣음, engine/shapes.js)의 'object'
//    덩어리; 편집기가 읽지 못하는 개체(글맵시 등)의 추가·삭제는 unsupported 로 알리고 반영 안 함)
//  - object 덩어리는 그 문단의 그림 속성·도형·조판 부호를 보낸 문서 것으로 옮긴다(copyObjectsFrom — 겹치면 보낸 쪽이 이긴다). 서식처럼
//    formatting 커밋이라 다른 창은 파일을 다시 연다(글만 맞추기로는 그림·부호가 따라오지 않는다). 보낸 창은 응답의 formatVersion 으로 다시 열지 않는다.
//    '변경 추적으로' 문서(service._objectTracking)는 넣고 지운 표·그림·차트·도형을 변경 추적으로 남긴다(copyObjectsTracked·removeOwnObjectsTracked —
//    작업본에서는 지운 개체가 안 보이고, 한/글로 저장(변경 추적 포함)에서 보인다). 그림·표 문단 지우기도 글 문단처럼 앞 문단 끝에 붙인다
//  - 덩어리마다 지금 문서 자리로 옮겨(_refMap + _place — 변경 요청 반영과 같은 규칙) 글을 정한다: 지금 글 == 기준 글이면 보낸 글, 다르면
//    merge3(기준, 보낸 것, 지금)(글자 단위). 겹쳐 합칠 수 없으면 보낸 글이 이긴다(마지막에 친 사람 — conflicts + 그 문단을 고친 다른 사람에게
//    WS live-overwrite). 그 문단이 지금 없으면(남이 지움) 건너뛴다(skipped GONE).
//  - 글 적용은 서비스 applyLiveText(작성자 = 친 사람; 고친 글만 = 곧바로 수락, 변경 추적으로 = 사람마다 그 문단 변경 하나),
//    문단 추가 = insertParagraphAfter(뒤에서부터), 문단 지움 = 그 본문 문단을 지운다(메모가 달렸거나 표·개체·첫 문단이면 글만 지움). 변경 추적으로면
//    글 전체를 지우는 변경을 남기고(이 사람의 처리 안 된 변경은 거둠) 남은 것(지운 글)이 있으면 그 문단을 앞 문단 끝에 붙이고(joinBodyParagraph —
//    최종본에 빈 줄이 남지 않게), 없으면(빈 문단·내가 넣은 문단) 문단째 지운다. 문단 넣기·지우기는 _remapRefs 를 지난다(제안·요청 ref·liveTouch 가 따라감).
//    (2026-10-30) 엔진이 문단 나눔 변경 추적(한/글 paraend="1")을 하면(service._breakTracking) 붙이는 대신 앞 문단 끝의 나눔을 지움 표식으로 남긴다
//    (deleteBreakAfter — 문단은 따로, 최종본에서는 앞 문단과 한 문단; 거절하면 제 문단으로 돌아옴), 문단 넣기는 나눔에 넣음 표식(trackBreak —
//    거절하면 빈 줄 없이 사라짐). 지울 문단의 글·개체는 구조를 바꾸기 전에 모두 지우고(1차) 나눔은 뒤에서부터(2차)
// 모두 서비스 _tx 한 번 = 기록 하나(note '실시간 편집', 이정표 없음). 바꿀 것이 없으면 커밋하지 않는다.
// 옛 기준에서 다시 보낸 문서(편집기는 치는 동안 기준을 옮기지 않는다 §2.4-1 · 응답을 못 받은 재시도)는 같은 고침을 또 담고 있다 — 덩어리를 그대로
// 다시 넣으면 문단이 두 번 들어가거나(문단 추가), 남이 그새 바로 옆에 친 글이 지워지거나, 같은 글(빈 문단 등)이 여럿인 곳에서 다른 문단에 들어간다.
// 그래서 liveTouch[ref] 에 ins = { by, base, text, v }(넣은 문단)·pushed[사람] = { base, ref: 기준 ref, h: 보낸 글 지문 }(보낸 문단)를 적어 두고
// (30분, 문단 넣기·지우기를 따라감) 기준 뒤에 넣은 문단은 기준 문단의 짝에서 빼며(newSince·freshAwareMap), 같은 창이 넣은 문단은 그 문단에 맞추고,
// 같은 기준에서 같은 글을 다시 보낸 문단은 건너뛴다. (2026-11-03) 옛 기준 뒤 기록이 모두 이 창(seq 천 단위 머리 = 편집기 창)의 앞선 밀어 넣기면
// 그 마지막 기록을 기준으로 본다(ownBase — 전체를 잘라 낸 뒤 같은 글을 다시 붙인 글이 '바뀐 것 없음'으로 버려지던 것). 남는 한계: 그 사이에
// 남의 기록이 끼면 그 뒤로는 예전 규칙이라, 그때 자기가 앞서 보낸 고침을 되돌린 것은 실리지 않는다(맞춘 뒤 다시 고치면 된다).
// (2026-11-03) '변경 추적으로' 문서의 큰 지우기·붙여넣기는 엔진 묶음 함수(clearParagraphsTracked·deleteBreaksTracked·
// insertTrackedParagraphsAfter)로 구역을 한 번만 다시 읽는다 — 하나씩 한 것과 같은 XML(tests/live_track_batch.test.mjs). 흉내 낼 수 없는
// 문단(부호가 든 문단·표·그림 문단 넣기)은 예전처럼 하나씩, 차례는 그대로. 큰 밀어 넣기는 보낸 창에 진행(WS live progress)을 알린다.
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { charOps, merge3, planBody, joinPlan, splitPoints } from '../engine/diff.js';
import { ServiceError } from './service.js';
import * as MT from './memotext.js';

/** 실시간 글 마지막 작성자 기억(meta.liveTouch) 기간 — 덮어쓰기 알림(§2.3)은 이 안에 그 문단을 친 다른 사람에게만 */
export const LIVE_TOUCH_MS = 30 * 60 * 1000;

const BODY_RE = /^s(\d+)\/p(\d+)$/;
const EMPTY_APPLIED = () => ({ changed: [], inserted: [], deleted: [] });
/** 이벤트 루프에 한 번 차례를 내준다(문서 큐는 그대로 쥔 채 — 다른 문서 요청·WebSocket·감시 신호가 돌게) */
const turn = () => new Promise((resolve) => setImmediate(resolve));
/** 문단 글 지문(liveTouch pushed — 같은 글인지만 본다; meta 가 커지지 않게 글 대신) */
const textPrint = (s) => crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('base64').slice(0, 16);

// ── merge3 의 충돌 규칙(engine/diff.js 안쪽 함수의 사본 — 엔진을 고치지 않으려고 여기 둔다. 규칙을 바꾸면 두 곳을 같이) ──
const sameOp = (x, y) => x.start === y.start && x.end === y.end && x.text === y.text;
function clash(x, y) {
  const xi = x.start === x.end; const yi = y.start === y.end;
  if (xi && yi) return x.start === y.start;
  if (xi) return y.start < x.start && x.start < y.end;
  if (yi) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}
function applyOps(cp, from, to, ops) {
  const list = [...ops].sort((x, y) => (x.start - y.start) || ((x.end - x.start) - (y.end - y.start)));
  let out = ''; let pos = from;
  for (const o of list) { out += cp.slice(pos, o.start).join(''); out += o.text; pos = Math.max(pos, o.end); }
  return out + cp.slice(pos, to).join('');
}

/**
 * 겹친 3-way 합치기에서 보낸 쪽(mine)이 이기는 글: 보낸 편집은 모두 넣고, 지금 글(theirs)의 편집 중 보낸 편집과 겹치지 않는 것만 남긴다
 * (같은 편집은 한 번). 겹치지 않은 남의 고침은 지키고 겹친 자리만 마지막에 친 사람 글로 — §2.2-3 '겹치면 보낸 글이 이긴다'
 */
export function mergePreferMine(base, mine, theirs) {
  base = String(base ?? ''); mine = String(mine ?? ''); theirs = String(theirs ?? '');
  const M = charOps(base, mine); const T = charOps(base, theirs);
  const keepT = T.filter((t) => !M.some((m) => sameOp(m, t) || clash(m, t)));
  const cp = Array.from(base);
  return applyOps(cp, 0, cp.length, [...M, ...keepT]);
}

/**
 * [hwpx-cowork] 실시간 반영 뒤에도 남은 차이(clean 이 아님)를 종류별 문단 수로 센다 — 문서 글 없이 수·종류만(2026-11-12 편집 보존: 편집기에서 바꾼
 * 값이 서버에서 조용히 사라지던 것이 다시 생기면 서버 기록에 보이게). 구역·문단 수가 달라 짝지을 수 없으면 paras 만.
 * → { paras, text, format, object, picMore, secDef, tableHead } (object = 판 2 개체 지문, 나머지 셋 = 덧지문의 갈래)
 */
export function liveDrift(a, b) {
  b = b.inFormattingUnitsOf(a);
  const out = { paras: 0, text: 0, format: 0, object: 0, picMore: 0, secDef: 0, tableHead: 0 };
  const A = a.bodyEntries(); const B = b.bodyEntries();
  for (const s of Object.keys(A)) {
    const x = A[s]; const y = B[s];
    if (!y || x.length !== y.length) { out.paras++; continue; }
    for (let i = 0; i < x.length; i++) {
      const r = `s${s}/p${i}`;
      if (x[i].text !== y[i].text) out.text++;
      if (a.formattingFingerprint(r) !== b.formattingFingerprint(r)) out.format++;
      if (a.objectPrint(r) !== b.objectPrint(r)) out.object++;
      else if (a.objectPrintFull(r) !== b.objectPrintFull(r)) {
        const oa = a._objectInfo(r); const ob = b._objectInfo(r);
        const j = (o, f) => JSON.stringify(f(o));
        if (j(oa, (o) => o.pics.map((p) => p.more)) !== j(ob, (o) => o.pics.map((p) => p.more))) out.picMore++;
        if (j(oa, (o) => o.codes.filter((c) => c.secDef).map((c) => c.key)) !== j(ob, (o) => o.codes.filter((c) => c.secDef).map((c) => c.key))) out.secDef++;
        if (j(oa, (o) => o.tables.map((t) => t.head)) !== j(ob, (o) => o.tables.map((t) => t.head))) out.tableHead++;
      }
    }
  }
  if (Object.keys(B).length !== Object.keys(A).length) out.paras++;
  return out;
}

/** clean 판정 + clean 이 아니면 남은 차이의 종류·수를 서버 기록(console)에 남긴다(문서 글·지시 없음 — 문서 id·기록 판·수만) */
function cleanOrLog(id, doc, head, committed) {
  const clean = sameBodyTexts(doc, head);
  if (!clean) {
    try { console.warn(`[live] 반영 뒤 남은 차이 doc=${id} committed=${committed ? 1 : 0} ${JSON.stringify(liveDrift(doc, head))}`); } catch (e) { console.warn(`[live] 남은 차이 세기 실패 doc=${id}: ${e.message}`); }
  }
  return clean;
}

/** 두 문서의 본문·칸 글(최종본, 메모 본문 제외 — bodyEntries)·서식·그림 속성/조판 부호가 똑같은가(§2.2-5 clean) */
export function sameBodyTexts(a, b) {
  b = b.inFormattingUnitsOf(a);
  const A = a.bodyEntries(); const B = b.bodyEntries();
  const ka = Object.keys(A); if (ka.length !== Object.keys(B).length) return false;
  for (const s of ka) {
    const x = A[s]; const y = B[s];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i].text !== y[i].text || x[i].nested.length !== y[i].nested.length) return false;
      if (a.formattingFingerprint(`s${s}/p${i}`) !== b.formattingFingerprint(`s${s}/p${i}`)) return false;
      // [hwpx-cowork] 덧지문(그림 선·효과, 구역 정의 내용, 표 순서·보호)까지 견준다(objectPrintFull — 2026-11-12 편집 보존)
      if (a.objectPrintFull(`s${s}/p${i}`) !== b.objectPrintFull(`s${s}/p${i}`)) return false;
      for (let k = 0; k < x[i].nested.length; k++) {
        if (x[i].nested[k].text !== y[i].nested[k].text) return false;
        if (a.formattingFingerprint(x[i].nested[k].ref) !== b.formattingFingerprint(y[i].nested[k].ref)) return false;
        if (a.objectPrintFull(x[i].nested[k].ref) !== b.objectPrintFull(y[i].nested[k].ref)) return false;
      }
    }
  }
  return true;
}

/** ref 의 본문 번호를 fn 으로 옮긴다(그 구역일 때만) */
function shiftRef(ref, sec, fn) {
  const m = /^s(\d+)\/p(\d+)(.*)$/.exec(String(ref || ''));
  if (!m || Number(m[1]) !== sec) return ref;
  return `s${sec}/p${fn(Number(m[2]))}${m[3]}`;
}

/** 문서 순서 비교 */
function cmpRef(a, b) {
  const key = (r) => { const m = /^s(\d+)\/p(\d+)((?:\/n\d+)*)$/.exec(String(r || '')); return m ? [Number(m[1]), Number(m[2]), ...(m[3] ? m[3].split('/n').slice(1).map(Number) : [])] : [Infinity]; };
  const x = key(a); const y = key(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] == null) return -1; if (y[i] == null) return 1; if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}

/**
 * 기준 기록(n) 뒤에 실시간으로 넣은 문단(지금 문서 번호, 구역 → Set) — liveTouch[ref].ins = { by, base, text, v }(넣은 사람·그때 편집기 기준 기록·
 * 그 사람이 마지막에 보낸 글·그 문단을 넣은 기록)로 알아본다(30분 — liveTouch 와 같이 잊음).
 *  - fresh: ins.v > n — 기준(n)에 없는 문단이라 기준 문단의 짝이 될 수 없다. planBody 는 바뀐 덩어리에서 수가 같으면 차례로 짝지으므로, 빼지 않으면
 *    이미 지워진 기준 문단(남이 지움·이 창이 앞서 지움)의 덩어리가 그 자리에 남이 새로 넣은 문단에 짝지어 그 문단을 지우거나 덮어쓴다
 *  - own: 그중 이 창이 같은 기준(n)에서 넣은 것(by·base) — 편집기는 치는 동안 기준을 옮기지 않으므로(§2.4-1 — clean 이 아닌 응답 뒤 맞추기 전,
 *    응답을 못 받은 재시도도) 다시 보낸 문서에도 그 문단이 '새 문단'으로 들어 있다 → 다시 넣지 않고 그 문단에 맞춘다
 */
function newSince(touch, ce, by, n) {
  const fresh = new Map(); const own = new Map();
  const add = (map, s, j) => { if (!map.has(s)) map.set(s, new Set()); map.get(s).add(j); };
  for (const [k, v] of Object.entries(touch || {})) {
    const m = BODY_RE.exec(k); const ins = v?.ins;
    if (!m || !ins) continue;
    const mine = ins.by === by && ins.base === n;
    if (!mine && !(Number.isInteger(ins.v) && ins.v > n)) continue;
    const s = Number(m[1]); const j = Number(m[2]);
    if (!ce[s]?.[j]) continue;
    add(fresh, s, j); if (mine) add(own, s, j);
  }
  return { fresh, own };
}

/**
 * 기준 기록 → 지금 문서 지도(crs._refMap 과 같은 모양 { ref, bodyIdx, insertAfter })인데 기준 뒤에 넣은 문단(skip — newSince 의 fresh)은 빼고
 * 짝짓는다. 돌려주는 번호·ref 는 지금 문서(빼기 전) 번호
 */
function freshAwareMap(crs, be, ce, skipBySec) {
  const ceF = {}; const back = {};
  for (const k of Object.keys(ce)) {
    const skip = skipBySec.get(Number(k));
    ceF[k] = []; back[k] = [];
    ce[k].forEach((e, j) => { if (skip?.has(j)) return; ceF[k].push(e); back[k].push(j); });
  }
  const mf = crs._refMap(be, ceF);
  const real = (s, j) => (j == null ? null : back[s]?.[j] ?? null);
  return {
    bodyIdx: (s, i) => real(s, mf.bodyIdx(s, i)),
    ref: (r) => {
      const x = mf.ref(r); const m = x ? BODY_RE.exec(x) : null;   // 중첩 ref 는 항목의 ref(빼기 전 번호) 그대로
      if (!m) return x;
      const j = real(Number(m[1]), Number(m[2]));
      return j == null ? null : `s${m[1]}/p${j}`;
    },
    insertAfter: (afterRef, sec0) => {
      const at = mf.insertAfter(afterRef, sec0);
      return !at || at.after < 0 ? at : { ...at, after: real(at.sec, at.after) };
    },
  };
}

/** ?base= 값: 양의 정수(기록 n)만, 아니면 400 BAD_BASE */
function parseBase(v) {
  const s = String(v ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(s)) throw new ServiceError('BAD_BASE', `편집기 기준(base)이 올바르지 않습니다: ${MT.clip(s, 20) || '(없음)'}`);
  return Number(s);
}
/** ?seq= 값(진단용 — 이 창의 밀어 넣기 차례): 0 이상 정수면 그 수, 아니면 null(오류 아님) */
const parseSeq = (v) => (/^\d{1,9}$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : null);

/**
 * [hwpx-cowork] (2026-11-03) 옛 기준(n)에서 보낸 밀어 넣기의 실제 기준: n 뒤 기록이 모두 이 창의 앞선 밀어 넣기(같은 사람, seq 천 단위 머리 =
 * 편집기 창 — web/editor.js seqBase, 이번 seq 보다 앞)로 이어지면 그 마지막 기록. 편집기는 clean 이 아닌 응답 뒤 맞추기 전까지 기준을 옮기지
 * 않으므로, 그 사이 친 글은 옛 기준으로 온다 — 옛 기준과 견주면 '앞서 보낸 고침을 되돌린 글'(전체를 잘라 낸 뒤 같은 글을 다시 붙임)이
 * 바뀐 것 없음이 되어 커밋되지 않고, 편집기가 서버 판으로 맞추며 그 글이 사라졌다. 자기 기록까지 기준으로 보면 그 글이 고침으로 실린다.
 * 남의 기록이 끼면 거기서 멈춘다(그 뒤는 예전처럼 옛 기준 규칙)
 */
function ownBase(meta, n, seq, by) {
  if (seq == null || n >= meta.version) return n;
  const win = Math.floor(seq / 1000);
  const recs = new Map((meta.versions || []).map((v) => [v.n, v]));
  let m = n;
  while (m < meta.version) {
    const v = recs.get(m + 1);
    if (!v || v.by !== by || !Number.isSafeInteger(v.seq) || Math.floor(v.seq / 1000) !== win || v.seq >= seq) break;
    m++;
  }
  return m;
}

// ── [hwpx-cowork] 실시간 밀어 넣기의 메모 맞추기 ──
// 메모는 글 비교(덩어리)에 나타나지 않는다. 메모 id(부호의 ID 인자 — 편집기 내보내기에도 그대로)로 기준·보낸 문서·지금 문서를 견준다.

const memoMap = (doc) => { try { return new Map(doc.memos().filter((m) => m.id).map((m) => [m.id, m])); } catch { return new Map(); } };

/** memoKnown 이 편집기 메모를 알 수 없을 때(연 판의 기록 파일이 정리됨) — 지우지 않는다 */
const MEMO_UNKNOWN = Symbol('memo-unknown');

/**
 * → { gone: 지금 문서에서 지울 메모(편집기 문서에 있었고 보낸 문서에 없음), back: 보낸 문서에서 들여올 메모(편집기 문서에 없었고 지금 문서에도 없음 —
 *     되돌리기로 돌아옴), movable: 보낸 문서에 있는 메모 id(그 메모가 든 문단은 지울 수 있다 — 메모는 옮긴다), head: 보낸 문서 메모(id → 메모), parked: [] }
 * known = 편집기 문서가 기준에서 가졌던 메모 id(LiveEditor._memoKnown). 없으면(옛 편집기·?loaded 없이 보낸 것) 기준 문서의 메모.
 * 기준 뒤에 남이 단 메모(편집기 문서에 없음)는 건드리지 않는다.
 * [hwpx-cowork] 2026-11-04 편집기는 메모만 바뀐 새 판(남이 단·지운 메모, AI 작업 메모)을 다시 열지 않고 기준만 옮긴다(web/editor.js
 * quietAdvance·맞추기) — 그래서 '기준 판의 메모'가 편집기 문서의 메모가 아니다. 종전처럼 기준 판으로 견주면 남이 단 메모가 다음 밀어 넣기에서
 * 지워지고(서식 커밋 → 다른 창 다시 열기 — test:ui:studio [13g]) 남이 지운 메모는 되살아났다. 그래서 편집기가 연 판(?loaded)에서 센다
 */
function liveMemoPlan(svc, baseDoc, src, doc, known = null) {
  const B = svc._engine(() => memoMap(baseDoc)); const H = svc._engine(() => memoMap(src)); const C = svc._engine(() => memoMap(doc));
  const K = known === MEMO_UNKNOWN ? new Set([...B.keys()].filter((k) => H.has(k))) : known instanceof Set ? known : new Set(B.keys());
  return {
    gone: [...C.values()].filter((m) => K.has(m.id) && !H.has(m.id)),
    back: [...H.values()].filter((m) => !K.has(m.id) && !C.has(m.id) && m.endRef === m.ref),
    movable: new Set(H.keys()), head: H, parked: [], headerFooters: [],
  };
}

/** 본문 문단 ref 의 메모가 모두 같은 문단에서 닫히고 보낸 문서에 있는가(옮길 수 있다) */
function memosMovable(doc, ref, movable) {
  if (!movable) return false;
  let list; try { list = doc.memos(); } catch { return false; }
  const body = (r) => (/^(s\d+\/p\d+)/.exec(String(r || '')) || [])[1] || null;
  const mine = list.filter((m) => body(m.ref) === ref || (m.endRef && body(m.endRef) === ref));
  return mine.every((m) => m.ref === ref && m.endRef === ref && movable.has(m.id));
}

/**
 * [hwpx-cowork] 문단 합침·가름 알아보기(2026-10-30 문단 나눔 변경 추적 2단계 — 한/글 실측 꼴). 이웃 덩어리를 묶는다:
 *  - 합침(뒤 문단 머리에서 Backspace·앞 문단 끝에서 Delete): 잇닿은 기준 문단들이 바꿈 하나 + 지움(들)이고 이은 글로 보는 편이 싸면(joinPlan) →
 *    { kind: 'join', sec, at(지금 첫 번호), count(지울 나눔 수), key, order, target(합친 문단 글), headRef, hid, baseRef, dels: [hid] } — 나눔만 지움
 *    표식(P{-¶-}), 글은 지우고 다시 넣지 않는다(이은 글에 charOps 만)
 *  - 가름(가운데 Enter): 기준 문단 하나의 바꿈 + 바로 뒤(또는 앞) 틈의 넣기들이고 이은 글로 보는 편이 싸면(splitPoints) →
 *    { kind: 'split', sec, at, key, order, offsets(지금 글 = 기준 글의 코드포인트 자리), parts: [{ text, headRef, hid, insert, baseRef }] } — P머리{+¶+} / P꼬리
 * 지금 문단이 기준 글 그대로(그새 남이 고치지 않음)이고 지금 번호가 잇닿았으며 글만 든 본문 문단(중첩·그림·표·도형 없음, 합칠 뒤 문단은 메모·구역
 * 나누기도 없음)일 때만 — 아니면 그 덩어리들은 기본 규칙(글 바꿈 + 문단 지우기/넣기). → { used: Set(덩어리 차례), steps }
 */
function planBreaks(svc, crs, doc, ce, map, hunks) {
  const used = new Set(); const steps = [];
  const places = new Map();
  const place = (i) => { if (!places.has(i)) places.set(i, crs._place(hunks[i], map, doc, null)); return places.get(i); };
  const idxOf = (r) => { const m = BODY_RE.exec(String(r || '')); return m ? [Number(m[1]), Number(m[2])] : null; };
  const refOf = (s, k) => `s${s}/p${k}`;
  const busy = new Set();     // 개체·서식 덩어리가 있는 기준 문단(합침·가름으로 보지 않음)
  const byBase = new Map();   // 기준 본문 ref → 바꿈·지움 덩어리 차례
  const gaps = new Map();     // 틈(앞 기준 ref, 구역 첫머리는 '^구역') → 넣기 덩어리 차례들(문서 차례)
  hunks.forEach((h, i) => {
    if (h.type === 'object' || h.type === 'format') { busy.add(h.ref); return; }
    if (h.type === 'insert') {
      if (h.objects) return;
      const key = h.afterRef ?? `^${idxOf(h.ref)?.[0] ?? 0}`;
      if (!gaps.has(key)) gaps.set(key, []);
      gaps.get(key).push(i);
      return;
    }
    if ((h.type === 'replace' || h.type === 'delete') && !h.objects && !h.structure && !h.cell && BODY_RE.test(h.ref)) byBase.set(h.ref, i);
  });
  // 지금 문단이 기준 글 그대로·글만 든 본문 문단이면 지금 [구역, 번호] | null (tail = 합칠 뒤 문단: 메모·구역 나누기도 없어야)
  const curOk = (i, tail = false) => {
    const h = hunks[i]; if (busy.has(h.ref)) return null;
    const p = place(i);
    if (!p?.curRef || p.currentText !== h.baseText) return null;
    const c = idxOf(p.curRef); if (!c) return null;
    const e = ce[c[0]]?.[c[1]]; if (!e || e.nested?.length) return null;
    try {
      const oi = doc._objectInfo(p.curRef);
      if (oi.pics.length || oi.tables.length || oi.shapes.length) return null;
      if (tail && (svc._paraHasMemo(doc, p.curRef) || doc.hasSectionBreak(p.curRef))) return null;
    } catch { return null; }
    return c;
  };
  // 합침: 바꿈 하나 + 바로 뒤(또는 앞)의 잇닿은 지움들
  for (const [bref, ri] of byBase) {
    if (used.has(ri) || hunks[ri].type !== 'replace') continue;
    const [s, b] = idxOf(bref);
    const delAt = (k) => { const i = byBase.get(refOf(s, k)); return i != null && !used.has(i) && hunks[i].type === 'delete' ? i : null; };
    let lo = b; while (lo > 0 && delAt(lo - 1) != null) lo--;
    let hi = b; while (delAt(hi + 1) != null) hi++;
    if (lo === hi) continue;
    for (const [x, y] of [[b, hi], [lo, b], [lo, hi]]) {
      if (y <= x) continue;
      const idx = []; for (let k = x; k <= y; k++) idx.push(k === b ? ri : delAt(k));
      let gapIns = false; for (let k = x; k < y; k++) if ((gaps.get(refOf(s, k)) || []).some((g) => !used.has(g))) gapIns = true;
      if (gapIns) continue;
      const cur = idx.map((i, j) => curOk(i, j > 0));
      if (cur.some((c) => !c) || cur.some((c, j) => c[0] !== cur[0][0] || c[1] !== cur[0][1] + j)) continue;
      if (!joinPlan(idx.map((i) => hunks[i].baseText), MT.xmlSafe(hunks[ri].newText)).join) continue;
      steps.push({
        kind: 'join', sec: cur[0][0], at: cur[0][1], count: y - x, key: cur[0][1] + (y - x), order: ri, target: MT.xmlSafe(hunks[ri].newText),
        headRef: hunks[ri].headRef || null, hid: hunks[ri].hid, baseRef: bref, dels: idx.filter((i) => i !== ri).map((i) => hunks[i].hid),
      });
      idx.forEach((i) => used.add(i));
      break;
    }
  }
  // 가름: 바꿈 하나 + 바로 뒤 틈(먼저)·바로 앞 틈의 넣기들
  for (const [bref, ri] of byBase) {
    if (used.has(ri) || hunks[ri].type !== 'replace') continue;
    const [s, b] = idxOf(bref);
    const after = (gaps.get(bref) || []).filter((g) => !used.has(g));
    const before = (gaps.get(b > 0 ? refOf(s, b - 1) : `^${s}`) || []).filter((g) => !used.has(g));
    if (!after.length && !before.length) continue;
    const c = curOk(ri); if (!c) continue;
    for (const order of [after.length ? [ri, ...after] : null, before.length ? [...before, ri] : null]) {
      if (!order) continue;
      const heads = order.map((i) => MT.xmlSafe(hunks[i].newText));
      const offsets = splitPoints(hunks[ri].baseText, heads);
      if (!offsets) continue;
      steps.push({
        kind: 'split', sec: c[0], at: c[1], key: c[1], order: ri, offsets,
        parts: order.map((i, j) => ({ text: heads[j], headRef: hunks[i].headRef || null, hid: hunks[i].hid, insert: i !== ri, baseRef: i === ri ? bref : null })),
      });
      order.forEach((i) => used.add(i));
      break;
    }
  }
  return { used, steps };
}

/** 본문 문단 ref 가 가진 직접 중첩 문단('/n'·'/d')·표('#t'·'#d') 수 — 합칠 때 뒤 문단 꼬리 주소를 옮기는 데(엔진 _partCounts, 없으면 0) */
function partCounts(doc, ref) {
  try {
    if (typeof doc._partCounts === 'function') {
      const { sec, p } = doc.resolve(ref);
      const c = doc._partCounts(sec, p, Infinity, null);
      return { n: c.n | 0, d: c.d | 0, t: c.t | 0, td: c.td | 0 };
    }
  } catch { /* 0 */ }
  return { n: 0, d: 0, t: 0, td: 0 };
}

/** 지울 문단 ref 의 메모 중 보낸 문서에 있는 것을 빼 둔다(memoSync.parked — 부호 XML·뺀 자리) */
function parkMemos(svc, ctx, ref, memoSync) {
  const { doc } = ctx;
  const m = BODY_RE.exec(ref); if (!m) return;
  const list = svc._engine(() => doc.memos()).filter((x) => x.ref === ref && x.endRef === ref && memoSync.movable.has(x.id));
  for (const x of list) {
    const parts = svc._engine(() => doc.memoParts(x.id));
    if (!parts) continue;
    svc._memoEdit(ctx, ref, () => svc._engine(() => doc.deleteMemo(x.id)));
    memoSync.parked.push({ id: x.id, parts, sec: Number(m[1]), at: Number(m[2]) });
  }
}

/**
 * 빼 둔 메모·들여올 메모를 보낸 문서(src)의 자리에 넣는다 — 본문 문단은 지금 문서와 보낸 문서의 짝(본문 글이 같으면 같은 번호, 아니면
 * planBody 짝)으로 옮긴다. 짝이 없으면 빼 둔 메모는 뺀 자리 앞 문단 끝으로(잃지 않게), 들여올 메모는 넣지 않는다
 */
/** 보낸 문서(src) 본문 ref → 지금 문서 ref(본문 글이 같으면 같은 번호, 아니면 planBody 짝) — 짝이 없으면 null */
function headToCurrent(svc, doc, src) {
  const cb = svc._engine(() => doc.bodyEntries()); const hb = svc._engine(() => src.bodyEntries());
  const maps = new Map();
  const mapOf = (sec) => {
    if (!maps.has(sec)) {
      const c = cb[sec] || []; const h = hb[sec] || [];
      const same = c.length === h.length && c.every((e, i) => (e?.text ?? e) === (h[i]?.text ?? h[i]));
      maps.set(sec, same ? null : new Map(planBody(c, h).pairs.map(([i, j]) => [j, i])));
    }
    return maps.get(sec);
  };
  const toCur = (ref) => {
    const m = /^s(\d+)\/p(\d+)(.*)$/.exec(String(ref || '')); if (!m) return null;
    const sec = Number(m[1]); const map = mapOf(sec);
    const i = map ? map.get(Number(m[2])) : Number(m[2]);
    return i == null || !(cb[sec] || [])[i] ? null : `s${sec}/p${i}${m[3]}`;
  };
  return { toCur };
}

/**
 * 빼 둔 머리말·꼬리말을 보낸 문서에서 같은 열쇠(종류·적용 쪽)를 가진 문단의 짝인 지금 문단 끝에 넣는다(그 문단에 같은 열쇠가 모자랄 때).
 * 자리를 못 찾으면 뺀 자리 앞 문단 끝(잃지 않게)
 */
function placeHeaderFooters(svc, ctx, src, memoSync) {
  const { doc } = ctx;
  const { toCur } = headToCurrent(svc, doc, src);
  const cb = svc._engine(() => doc.headerFooterKeys()); const hb = svc._engine(() => src.headerFooterKeys());
  const count = (keys, k) => (keys || []).filter((x) => x === k).length;
  const want = new Map();   // 지금 ref → 넣을 [{ key, xml }]
  for (const park of memoSync.headerFooters) {
    for (const item of park.list) {
      let ref = null;
      for (const [sec, list] of Object.entries(hb)) {
        for (let j = 0; j < list.length && !ref; j++) {
          if (!count(list[j], item.key)) continue;
          const r = toCur(`s${sec}/p${j}`); const m = r && BODY_RE.exec(r);
          if (!m) continue;
          const have = count(cb[m[1]]?.[Number(m[2])], item.key) + (want.get(r) || []).filter((x) => x.key === item.key).length;
          if (have < count(list[j], item.key)) ref = r;
        }
        if (ref) break;
      }
      // 모자란 문단이 없으면 버린다 — 같은 밀어 넣기의 object 덩어리(머리말·꼬리말도 조판 부호)가 이미 옮겼거나, 편집기에서 지운 것
      if (!ref) continue;
      if (!want.has(ref)) want.set(ref, []);
      want.get(ref).push(item);
    }
  }
  for (const [ref, list] of want) svc._engine(() => doc.putHeaderFooters(ref, list));
  ctx.dirty = true; ctx.formatting = true;
}

function placeMemos(svc, ctx, src, memoSync, memoEvents) {
  const { doc, meta } = ctx;
  const { toCur } = headToCurrent(svc, doc, src);
  const put = (ref, hm, parts) => {
    try { svc._memoEdit(ctx, ref, () => svc._engine(() => doc.putMemo(ref, hm.start, hm.end ?? hm.start, parts))); return true; } catch { return false; }
  };
  for (const p of memoSync.parked) {
    const hm = memoSync.head.get(p.id);
    const ref = hm ? toCur(hm.ref) : null;
    if (ref && put(ref, hm, p.parts)) continue;
    // 잃지 않게: 뺀 자리 앞 문단 끝(붙은 글 없는 메모로)
    const prev = `s${p.sec}/p${Math.max(0, p.at - 1)}`;
    put(prev, { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER }, p.parts);
  }
  const alreadyImported = svc._engine(() => memoMap(doc));
  for (const hm of memoSync.back) {
    const ref = toCur(hm.ref);
    const present = alreadyImported.get(hm.id);
    // A newly copied table/picture already carries its nested memo XML. Restore
    // only memos not brought in with that object; keep reply/trash restoration.
    if (!present || present.ref !== ref || present.start !== hm.start || present.end !== hm.end) {
      const parts = ref ? svc._engine(() => src.memoParts(hm.id)) : null;
      if (!parts || !put(ref, hm, parts)) continue;
    }
    // 편집기에서 지웠다 되돌린 메모 — 답글 기록이 남아 있으면 돌려준다
    const key = svc._memoKey(hm);
    const kept = meta.memoTrash?.[key];
    if (kept?.thread && meta.memoThreads && !meta.memoThreads[key]) meta.memoThreads[key] = kept.thread;
    if (meta.memoTrash) delete meta.memoTrash[key];
    memoEvents.push({ action: 'add', memoId: hm.id });
  }
  ctx.dirty = true; ctx.formatting = true;
}

export class LiveEditor {
  /** @param {{ service, crs }} o  crs = server/crs.js ChangeRequests(기록 문서·정렬 지도·덩어리 자리 — 변경 요청 반영과 같은 것을 쓴다) */
  constructor({ service, crs }) {
    this.service = service; this.crs = crs;
    // (2026-11-03) 변경 추적 문서의 큰 지우기·넣기를 엔진 묶음 함수로(구역 한 번 다시 읽기 — 하나씩 한 것과 같은 결과). 시험이 끄고 견준다
    this.batch = true;
    // (2026-11-04) 창마다 편집기 문서가 가진 메모 id(문서·사람·창 → { loaded, ids, at }) — 밀어 넣은 뒤 편집기 문서 = 보낸 문서라 그 메모로 둔다.
    // 메모리에만(서버를 다시 띄우면 첫 밀어 넣기가 연 판의 기록 파일에서 다시 센다)
    this.memoKnown = new Map();
  }

  /**
   * 편집기 문서가 기준에서 가진 메모 id(Set) — liveMemoPlan 의 known. 편집기는 메모만 바뀐 판을 다시 열지 않으므로(남이 단 메모는 편집기 문서에
   * 없다) 연 판(loaded)의 메모에 이 창이 밀어 넣어 바꾼 메모를 더한 것이다 = 이 창이 지난번 밀어 넣은 문서의 메모(같은 loaded 일 때), 처음이면
   * 연 판의 메모. loaded 가 없으면(옛 편집기·시험의 직접 밀어 넣기) null(= 기준 판의 메모, 종전), 연 판의 기록 파일이 없으면 MEMO_UNKNOWN(지우지 않음)
   */
  async _memoKnown(id, { loaded, win, by, n, baseDoc }) {
    if (!loaded || loaded > n) return null;
    const kept = win != null ? this.memoKnown.get(`${id}\u0000${by}\u0000${win}`) : null;
    if (kept && kept.loaded === loaded) return kept.ids;
    let ldoc = null;
    if (loaded === n) ldoc = baseDoc;
    else { try { ldoc = await this.crs._versionDoc(id, loaded); } catch { ldoc = null; } }
    return ldoc ? new Set(this.service._engine(() => memoMap(ldoc)).keys()) : MEMO_UNKNOWN;
  }

  /** 밀어 넣은 뒤: 이 창의 편집기 문서 메모 = 보낸 문서 메모(다음 밀어 넣기의 known). 하루 지난 창은 잊는다 */
  _rememberMemos(id, { loaded, win, by, head }) {
    if (!loaded || win == null || !head) return;
    const now = Date.now();
    if (this.memoKnown.size > 500) for (const [k, v] of this.memoKnown) if (v.at < now - 24 * 3600 * 1000) this.memoKnown.delete(k);
    this.memoKnown.set(`${id}\u0000${by}\u0000${win}`, { loaded, ids: new Set(head.keys()), at: now });
  }

  /** 실시간 문서가 아니면 409 NOT_REALTIME, 수정 권한이 없으면 403 FORBIDDEN */
  _gate(meta, user) {
    if (!this.service.isRealtime(meta)) throw new ServiceError('NOT_REALTIME', '실시간 수정 문서가 아닙니다(문서 설정: 승인 후 반영) — 내 수정본에 저장하고 변경 요청으로 반영하세요', 409);
    this.service._assertCanEdit(user, meta);
  }

  /**
   * 문단을 통째로 지워도 되는가: 첫 문단(구역 속성) 아님·글/빈 문단이거나 그 밖의 것이 제 그림·표뿐(글상자 등 없음 — 편집기에서 그림·표
   * 문단을 지운 것)·메모가 달리지 않음(메모를 앞 문단 끝으로 옮기지 못하므로 그때는 글만 지우고 빈 문단을 남긴다 — §2.2-4).
   * objects(그림·표 문단 지우기)면 메모가 그 문단 안에서 시작·끝나는 것(표 칸에 단 메모 등)은 표와 함께 지운다(편집기에서도 함께 사라졌다)
   */
  _removable(doc, ce, ref, { objects = false, movable = null } = {}) {
    const m = BODY_RE.exec(ref); if (!m) return false;
    const sec = Number(m[1]); const at = Number(m[2]);
    if (at === 0) return false;
    if (!ce[sec]?.[at]) return false;
    let ok = false; try { ok = doc.plainOrObjectParagraph(ref); } catch { ok = false; }
    if (!ok) return false;
    // [hwpx-cowork] 메모가 든 문단: 메모가 모두 보낸 문서의 다른 자리로 옮겨 갔으면(편집기에서 빈 줄을 합침) 지운다 — 메모는 지우기 전에
    // 빼 두었다가(parkMemos) 끝에 보낸 자리로 다시 넣는다
    if (!objects) return !this.service._paraHasMemo(doc, ref) || memosMovable(doc, ref, movable);
    const body = `s${sec}/p${at}`; const bodyOf = (r) => (/^(s\d+\/p\d+)/.exec(String(r || '')) || [])[1] || null;
    let memos = []; try { memos = doc.memos(); } catch { return false; }
    return !memos.some((x) => (bodyOf(x.ref) === body) !== (x.endRef ? bodyOf(x.endRef) === body : bodyOf(x.ref) === body));
  }

  /**
   * PUT /api/docs/:id/live?base=<n>&seq=<k>(본문 HWPX) →
   *   { version, clean, applied: { changed, inserted, deleted }(지금 ref), skipped: [{ hid, reason: 'GONE' }], conflicts: [{ ref, by, to }],
   *     unsupported(수), seq }
   * 검사 차례: 404 NO_DOC → 409 NOT_REALTIME → 403 FORBIDDEN → 400 BAD_BASE(정수 아님) → 400 EMPTY·BAD_FILE → (문서 큐 안에서 한 번 더 방식·권한)
   * → 400 BAD_BASE(지금 기록보다 큼) → 409 STALE_BASE { baseVersion: 지금 기록 }(기준 기록 파일이 정리됨).
   * conflicts: 겹쳐 보낸 글이 이긴 문단 — by = 덮어쓴 사람(보낸 사람), to = 그 문단의 지금 글을 쓴 사람(30분 안 실시간 기록, 다른 사람일 때만, 아니면 null).
   * clean = 커밋 뒤(바꿀 것이 없으면 지금) 문서의 본문·칸 글이 보낸 문서와 똑같은가
   */
  async push(id, bytes, { base, seq = null, loaded = null, user } = {}) {
    const svc = this.service; const crs = this.crs;
    this._gate(svc._meta(id), user);
    let n = parseBase(base);
    if (!bytes || !bytes.length) throw new ServiceError('EMPTY', '보낸 문서가 비었습니다');
    let head;
    try { head = await HwpxDoc.load(bytes); } catch (e) { throw new ServiceError('BAD_FILE', `보낸 문서(HWPX)를 읽지 못했습니다: ${e.message}`); }
    if (!head.sections?.length) throw new ServiceError('BAD_FILE', '구역(section)이 없는 파일입니다');
    const by = user.name; const seqNo = parseSeq(seq);
    // ?loaded= 편집기 문서를 연 판(메모 맞추기 — _memoKnown), win = 이 창(seq 의 천 단위 — ownBase 와 같음)
    const loadedV = parseSeq(loaded) || null; const win = seqNo != null ? Math.floor(seqNo / 1000) : null;
    let memoHead = null;

    const out = await svc._tx(id, async () => {
      const { doc, meta } = await svc._load(id);
      this._gate(meta, user);
      // A recovered practice session must not merge an old tab's buffered edits back into its restored document.
      // Check the original base before ownBase advances it, and the version of the document actually opened by the editor.
      const restoredAt = meta.tutorialRestoreVersion;
      if (meta.tutorialSession && Number.isInteger(restoredAt) && (n < restoredAt || (loadedV !== null && loadedV < restoredAt))) {
        throw new ServiceError('TUTORIAL_RESTORED', '연습 문서를 이 단계의 시작 상태로 되돌렸습니다. 현재 문서를 다시 열어 계속하세요.', 409,
          { baseVersion: meta.version, restoreVersion: restoredAt, reload: true });
      }
      svc._assertFileVersion(meta, n, loadedV);
      if (n > meta.version) throw new ServiceError('BAD_BASE', '보낸 기준(base)이 지금 문서보다 새것입니다 — 편집기를 다시 여세요');
      // 빈 문서가 붙여넣은 원본의 판본을 채택할 수 있다. 저장·재전송·clean 판정은
      // 모두 서버 문서의 단위로 읽되, 그 문서나 편집기가 보낸 원본은 변경하지 않는다.
      head = head.inFormattingUnitsOf(doc);
      const sentBase = n;
      n = ownBase(meta, n, seqNo, by);
      let baseDoc = doc;
      if (n !== meta.version) {
        try { baseDoc = await crs._versionDoc(id, n); } catch (e) {
          if (e instanceof ServiceError && e.code === 'NO_VERSION') {
            throw new ServiceError('STALE_BASE', '편집기의 기준 기록이 정리되어 이 창의 글을 맞출 수 없습니다 — 지금 문서를 열고 이 창에서 고친 글을 옮겨 넣으세요', 409, { baseVersion: meta.version });
          }
          throw e;
        }
      }
      // 문서 큐 안이고 보낸 문서는 이 밀어 넣기만 쓴다 — 견주는 동안 40ms 마다 다른 요청에 차례를 내준다(개체 수천 개 문서에서 1초 넘게 막혔다 —
      // 아래 큰 단계 사이에도 turn() 으로 내준다, 2026-11-10)
      const diff = await crs._diff(baseDoc, head, { flat: true, anchorFirst: true, yieldEvery: 40 });
      await turn();
      const { hunks, unsupported } = diff;
      // [hwpx-cowork] 구역 수가 바뀐 밀어 넣기(구역을 넘는 지우기·구역 나누기를 실은 붙여넣기 — docs/SECTIONS.md): diffDocs 가 두 문서를 구역 0
      // 하나로 이어 견줬다(덩어리 ref·headRef = 이은 번호, 구역 나누기 = 파일 안 secPr 조판 부호). 아래 3) 뒤까지 지금 문서·meta 주소도 이어서
      // 같은 규칙을 쓰고, 끝에 보낸 문서의 구역 경계에서 구역 파일로 다시 나눈다. 글·서식·그림을 옮겨 올 문서(src)도 이은 사본이다
      const secs = diff.sections || null;
      const src = secs ? diff.flatHead : head;
      const ctx = svc._ctx(id, doc, meta, by);
      // A pasted document may introduce styles that its current paragraphs do
      // not reference (character styles and next-style chains included).
      if ((await doc.copyStyleDefinitionsFrom(src)).changed) { ctx.dirty = true; ctx.formatting = true; }
      await turn();
      const mode = svc._textMode(meta);   // 'final' | 'tracked'(실시간 문서)
      // 표·그림·차트·도형 변경도 변경 추적으로(2026-10-30 — '변경 추적으로' 문서, 엔진에 추적판이 있을 때): 넣음 = Insert 로 감쌈, 지움 = Delete 로
      // 감쌈(제가 추적으로 넣은 것은 그 넣음을 거절 = 바로 지움). 작성자 = 친 사람
      const trk = svc._objectTracking(meta, doc);
      // 문단 나눔도 변경 추적으로(2026-10-30 — '변경 추적으로' 문서, 엔진에 deleteBreakAfter 가 있을 때): 문단 넣기 = 앞 문단 끝 나눔에 넣음 표식,
      // 문단 지우기 = 앞 문단 끝 나눔에 지움 표식(문단은 따로 남고 최종본에서는 앞 문단과 한 문단) — 거절하면 제 문단으로 돌아오고 넣은 문단은 빈 줄 없이
      const brk = svc._breakTracking(meta, doc);
      const now = Date.now(); const at = new Date(now).toISOString();
      const objOpt = { author: by, date: new Date(now) };
      // 실시간 글 마지막 작성자: 30분 넘은 것은 잊는다
      let touch = meta.liveTouch && typeof meta.liveTouch === 'object' ? meta.liveTouch : {};
      for (const k of Object.keys(touch)) if (!(Date.parse(touch[k]?.at) > now - LIVE_TOUCH_MS)) delete touch[k];
      meta.liveTouch = touch;
      // ownBase 로 기준을 옮겼으면: 이 창이 그 사이 기록(보낸 기준 < v ≤ n)에서 넣은 문단의 개체·서식만의 차이는 서버가 옮기며 고친 꼴(표 테두리
      // 번호 등)이다 — 옛 기준 길처럼(같은 창이 넣은 문단은 글만 맞춤) 다시 옮기지 않는다(밀어 넣기마다 표를 다시 들여와 커밋이 쌓이지 않게)
      const ownInserted = (ref) => {
        const ins = n > sentBase && ref ? touch[ref]?.ins : null;
        return !!ins && ins.by === by && Number.isInteger(ins.v) && ins.v > sentBase && ins.v <= n;
      };
      const skipped = [];
      // clean(§2.2-5): 문서 큐 안에서 — 커밋한 문서(바꿀 것이 없으면 지금 문서) 글 == 보낸 문서 글
      const untouched = () => ({ version: meta.version, committed: false, clean: cleanOrLog(id, doc, head, false), skipped, unsupported: unsupported.length });
      // [hwpx-cowork] 메모: 편집기에서 지운 메모(기준에 있고 보낸 문서에 없음 — 메모가 붙은 글을 지움·메모 부호 지우기)는 서버에서도 지운다
      // (답글·연결 정리, 답글 기록은 하루 동안 memoTrash). 문단을 합쳐 다른 문단으로 옮겨 간 메모는 3)에서 빼 두었다가 끝에 다시 넣고,
      // 되돌리기로 돌아온 메모(보낸 문서에만 있음)는 보낸 문서의 메모 부호를 들여온다. 메모만 바뀐 밀어 넣기도 커밋한다(덩어리 없음)
      const known = await this._memoKnown(id, { loaded: loadedV, win, by, n, baseDoc });
      const memoSync = liveMemoPlan(svc, baseDoc, src, doc, known);
      memoHead = memoSync.head;
      const memoEvents = [];
      for (const m of memoSync.gone) {
        svc._memoEdit(ctx, m.ref, () => svc._engine(() => doc.deleteMemo(m.id)));
        svc._forgetMemo(ctx, m, m.id, by, { keep: true });
        svc.store.log(meta, by, 'memo.delete', `${m.id}(편집기에서 지움)`);
        memoEvents.push({ action: 'delete', memoId: m.id });
        ctx.dirty = true; ctx.formatting = true;
      }
      if (!hunks.length && !memoSync.back.length && !ctx.dirty) return untouched();
      // 구역을 이었다가 실패하면 meta 주소를 되돌린다(문서는 _tx 가 버린다)
      const metaBackup = secs ? structuredClone(meta) : null;
      const flat = secs ? svc._flattenLive(doc, meta) : null;
      if (flat) { touch = meta.liveTouch; await turn(); }
      let recs = [];
      try {

      // 1) 덩어리마다 자리·글 정하기(아직 문서는 그대로)
      const ce = doc.bodyEntries();
      const be = n === meta.version ? ce : secs ? diff.flatBase.bodyEntries() : await crs._versionEntries(id, n);
      // 옛 기준에서 보낸 문서: 기준 뒤에 넣은 문단은 기준 문단의 짝에서 빼고(fresh), 같은 창이 앞서 넣은 문단(own)은 다시 넣지 않고 그 문단을
      // 고친다(아니면 문단이 두 번 들어간다)
      const { fresh, own } = n === meta.version ? { fresh: new Map(), own: new Map() } : newSince(touch, ce, by, n);
      const map = fresh.size ? freshAwareMap(crs, be, ce, fresh) : crs._refMap(be, ce);
      const imgs = new Map();   // 구역 → 기준 문단의 짝인 지금 번호(오름차순) — 문단 넣을 틈의 끝
      const gapEnd = (sec, after) => {
        if (!imgs.has(sec)) {
          const arr = []; (be[sec] || []).forEach((_, i) => { const j = map.bodyIdx(sec, i); if (j != null) arr.push(j); });
          imgs.set(sec, arr.sort((a, b) => a - b));
        }
        const nx = imgs.get(sec).find((j) => j > after);
        return nx == null ? (ce[sec]?.length ?? 0) : nx;
      };
      const used = new Set(); const anchors = new Map(); const ownSeen = []; const shadows = [];
      // 이 사람이 이 기준(n)에서 보낸 기준 문단의 지금 자리: 기준 ref → { ref: 지금 ref, h: 보낸 글 지문 } · 지금 ref → 기준 ref(본문 문단만 — 중첩 ref 는
      // 메모 쓰기로 번호가 밀려도 liveTouch 열쇠가 따라가지 않으므로 자리로 쓰지 않는다)
      const shadowIdx = new Map(); const claimed = new Map();
      if (n !== meta.version) {
        for (const [k, v] of Object.entries(touch)) {
          const s = v?.pushed?.[by];
          if (!s || s.base !== n || typeof s.ref !== 'string') continue;
          shadowIdx.set(s.ref, { ref: k, h: s.h });
          if (BODY_RE.test(k) && BODY_RE.test(s.ref)) claimed.set(k, s.ref);
        }
      }
      const edits = []; const structural = []; const formats = []; const objects = [];
      // 문단 합침·가름(2단계 — 문단 나눔을 추적하는 문서): 이웃 덩어리를 나눔 변경 하나로(합침 = 나눔 지움, 가름 = 나눔 넣음 + 꼬리 옮김). 옛 기준에서
      // 다시 보낸 문서(같은 창이 넣은 문단·보낸 글 기억)는 기본 규칙으로만 — 짝을 알 수 없다
      const bp = brk && (n === meta.version || (!fresh.size && !shadowIdx.size)) ? planBreaks(svc, crs, doc, ce, map, hunks) : null;
      if (bp) structural.push(...bp.steps);
      hunks.forEach((h, order) => {
        if (bp?.used.has(order)) return;
        const p = crs._place(h, map, doc, null);
        if (h.type === 'object') {
          // 그새 남이 같은 그림·부호를 바꿨어도(conflict) 보낸 쪽이 이긴다(글 겹침과 같은 규칙). 문단이 없으면 건너뛴다
          if (p.curRef == null || p.kind === 'skip' || ownInserted(p.curRef)) return;
          objects.push({ ref: p.curRef, headRef: h.headRef, hid: h.hid });
          return;
        }
        if (h.type === 'format' && ownInserted(p.curRef)) return;
        if ((h.type === 'format' || (h.type === 'replace' && h.formatting)) && !ownInserted(p.curRef)) {
          if (p.kind === 'skip') return;
          if (p.kind !== 'edit') throw new ServiceError('FORMAT_CONFLICT', p.message || '서식 변경이 현재 문서와 충돌합니다.', 409, { ref: p.curRef });
          formats.push({ ref: p.curRef, target: p.target, headRef: h.headRef, hid: h.hid });
          return;
        }
        if (h.type === 'insert') {
          if (p.kind !== 'insert') { skipped.push({ hid: h.hid, reason: 'GONE' }); return; }
          // 같은 틈(앞 짝 문단 뒤 ~ 다음 짝 문단 앞)에 이 창이 앞서 넣은 문단이 있으면 차례대로 그 문단에 맞춘다 — 그 문단 글 =
          // 3-way(이 창이 마지막에 보낸 글, 지금 보낸 글, 지금 글: 그새 남이 고친 곳은 남긴다). 짝이 없는 새 문단은 그 틈에서 맞춘 문단 뒤에
          const ownSec = own.get(p.sec); const gap = `${p.sec}:${p.after}`;
          if (ownSec?.size) {
            const end = gapEnd(p.sec, p.after);
            let j = -1;
            for (let k = Math.max(0, p.after + 1); k < end; k++) if (ownSec.has(k) && !used.has(`${p.sec}/${k}`)) { j = k; break; }
            if (j >= 0) {
              used.add(`${p.sec}/${j}`); anchors.set(gap, j);
              const ref = `s${p.sec}/p${j}`; const mine = p.text;
              const t = touch[ref]; const was = String(t?.ins?.text ?? '');
              let cur; try { cur = doc.text(ref, 'final'); } catch { cur = mine; }
              let target = mine; let clashed = false;
              if (cur !== mine && cur !== was) {
                const m = merge3(was, mine, cur);
                if (m.ok) target = m.text; else { target = mergePreferMine(was, mine, cur); clashed = true; }
              }
              if (target === cur) ownSeen.push({ ref, kind: 'touch', insText: mine });
              else edits.push({ ref, target, kind: 'changed', hid: h.hid, clashed, prev: clashed ? (t || null) : null, insText: mine });
              return;
            }
          }
          const a = anchors.get(gap);
          const after = a != null ? a : p.after;
          structural.push({ kind: 'insert', sec: p.sec, after, key: Math.max(0, after) + 0.5, text: p.text, order, hid: h.hid, headRef: h.headRef, objects: !!h.objects });
          return;
        }
        // 이 사람이 이 기준(n)에서 이 기준 문단(h.ref)에 보낸 적이 있으면(liveTouch[ref].pushed[사람] = { base, ref: 기준 ref, h: 보낸 글 지문 })
        // 그 문단이 지금 어디 있는지 안다(문단 넣기·지우기를 따라 옮겨진 열쇠). 본문 문단이면 글 정렬(planBody — 같은 글·빈 문단이 여럿이면 옛 기준과
        // 지금 사이에서 다른 짝을 고를 수 있다) 대신 그 자리를 쓰고, 정렬이 그 자리를 다른 기준 문단의 짝으로 주면 믿지 않는다(GONE).
        // 보낸 글이 그때와 같으면(응답을 못 받은 재시도 · 옛 기준 창이 그 뒤 손대지 않은 문단) 다시 합치지 않는다 — 옛 기준과 3-way 를 또 하면
        // 그새 남이 바로 옆에 친 글이 내 앞 고침과 한 덩어리 편집으로 잡혀 겹침(보낸 글이 이김)으로 지워질 수 있다. 같은 글인지만 보므로 같은
        // 사람의 다른 창이어도 틀리지 않는다
        const mineText = h.type === 'delete' ? '' : MT.xmlSafe(h.newText);
        const shAt = shadowIdx.get(h.ref);
        let curRef = p.curRef; let cur = p.currentText;
        if (shAt && BODY_RE.test(h.ref) && shAt.ref !== curRef) {
          let t = null; try { t = doc.text(shAt.ref, 'final'); } catch { t = null; }
          if (t != null) { curRef = shAt.ref; cur = t; }
        } else if (!shAt && curRef && claimed.has(curRef) && claimed.get(curRef) !== h.ref) { curRef = null; cur = null; }
        if (curRef == null || cur == null) { if (h.type === 'replace') skipped.push({ hid: h.hid, reason: 'GONE' }); return; }   // 지울 문단이 이미 없으면 할 일 없음
        if (shAt && shAt.ref === curRef && shAt.h === textPrint(mineText)) return;
        const shadow = { ref: curRef, kind: 'shadow', baseRef: h.ref, shText: mineText };
        let target; let clashed = false;
        if (h.type === 'delete') {
          if (cur === h.baseText) target = '';
          else { const m = merge3(h.baseText, '', cur); if (m.ok) target = m.text; else { target = mergePreferMine(h.baseText, '', cur); clashed = true; } }
        } else if (cur === mineText) { shadows.push(shadow); return; }   // 이미 같은 글
        else if (cur === h.baseText) target = mineText;
        else {
          const m = merge3(h.baseText, mineText, cur);
          if (m.ok) target = m.text; else { target = mergePreferMine(h.baseText, mineText, cur); clashed = true; }   // 겹침 — 보낸 글(마지막에 친 사람)이 이긴다
        }
        const prev = clashed ? (touch[curRef] || null) : null;
        if (h.type === 'delete' && target === '') {
          const m = BODY_RE.exec(curRef);
          // 그림 문단(h.objects)은 개체를 추적하지 않는 문서면 남길 글이 없다 — 문단째 지운다(못 지우면 그림만).
          // 변경 추적(tracked) 글 문단도 문단은 없앤다(track) — 글은 3)에서 지우는 변경으로 남기고 앞 문단 끝에 붙인다. 문단을 남기면 최종본에
          // 빈 줄이 남고, 빈 문단은 남길 변경이 없어 아무것도 바뀌지 않아 편집기에서 지운 문단이 맞추기로 되살아난다.
          // 개체를 추적하는 문서(trk)면 그림·표 문단도 같다: 개체는 지우는 변경으로 감싸 앞 문단 끝에 붙인다(objects)
          if (m && this._removable(doc, ce, curRef, { objects: !!h.objects, movable: memoSync.movable })) structural.push({ kind: 'remove', sec: Number(m[1]), at: Number(m[2]), key: Number(m[2]), order, hid: h.hid, clashed, prev, track: mode === 'tracked' && (!h.objects || trk), objects: !!h.objects });
          else {
            if (cur !== '') edits.push({ ref: curRef, target: '', kind: 'deleted', hid: h.hid, clashed, prev });
            if (h.objects) objects.push({ ref: curRef, remove: true, hid: h.hid });
            shadows.push(shadow);
          }
          return;
        }
        shadows.push(shadow);
        if (target === cur) return;
        edits.push({ ref: curRef, target, kind: 'changed', hid: h.hid, clashed, prev });
      });

      // (2026-11-03) 큰 밀어 넣기의 진행 — 보낸 창(seq 로 알아봄)의 상태 칩 '반영 중 n/m'. 1초에 한 번만 WS 로
      const prog = { done: 0, at: Date.now(), total: edits.length + formats.length + objects.length + structural.length
        + (brk ? structural.filter((s) => s.kind === 'remove' && s.track).length : 0) };
      const tick = (k = 1) => {
        prog.done += k;
        if (seqNo == null || Date.now() - prog.at < 1000) return;
        prog.at = Date.now();
        svc.hub.broadcast(id, { type: 'live', action: 'progress', seq: seqNo, by, done: Math.min(prog.done, prog.total), total: prog.total });
      };

      // 2) 글 적용(문단 수 그대로) — 작성자 = 친 사람
      // 'touch' = 이 창이 앞서 넣은 문단인데 글이 그대로, 'shadow' = 이 밀어 넣기가 보낸 문단 글(4)에서 pushed 로 적음) — 둘 다 보고하지 않는다
      recs = [...ownSeen, ...shadows];
      for (const e of edits) {
        svc.applyLiveText(ctx, e.ref, e.target, by); recs.push({ ...e });
        tick();
        await new Promise((resolve) => setImmediate(resolve));   // 많은 문단을 고친 붙여넣기에도 서버가 멈추지 않게(아래 1차 지우기와 같다)
      }
      // [hwpx-cowork] 표 셀(/n) 하나가 섞여도 전체 일괄 처리를 끄지 않는다.
      // 각 문단의 자체 태그·run만 바꾸므로 부모와 셀 문단도 함께 준비할 수 있다.
      const formatRef = /^s\d+\/p\d+(?:\/n\d+)*$/;
      const batchFormats = this.batch && formats.length > 1 && formats.every(e => formatRef.test(e.ref) && formatRef.test(e.headRef)) && new Set(formats.map(e => e.ref)).size === formats.length;
      for (const e of formats) {
        if (doc.text(e.ref, 'final') !== e.target) svc.applyLiveText(ctx, e.ref, e.target, by);
        if (!batchFormats) svc._engine(() => crs._copyFormatting(doc, src, e.headRef, e.ref));
        ctx.dirty = true; ctx.formatting = true; ctx.changed.add(e.ref);
        recs.push({ ref: e.ref, kind: 'changed', hid: e.hid });
        tick();
        // 대량 서식의 구역 재해석 사이에도 HTTP·IPC 생존 신호를 처리한다.
        // 문서 쓰기 큐는 계속 소유하므로 다른 쓰기와 섞이지 않는다.
        await new Promise(resolve => setImmediate(resolve));
      }
      if (batchFormats) await crs._copyFormattingBatch(doc, src, formats.map(e => ({ sourceRef: e.headRef, targetRef: e.ref })));
      // 그림 속성·조판 부호(문단 수 그대로 — 넣기·지우기 전에). 서식처럼 formatting 커밋(다른 창은 파일을 다시 연다).
      // 개체를 추적하는 문서(trk)는 넣고 지운 개체를 변경 추적으로(옮김·크기·속성은 그대로 고침 — 엔진 OBJECT_TRACK.modify)
      const objectStep = (e) => {
        if (trk) return e.remove ? doc.removeOwnObjectsTracked(e.ref, objOpt).count > 0 : doc.copyObjectsTracked(src, e.headRef, e.ref, objOpt).changed;
        return e.remove ? doc.removeOwnObjects(e.ref) > 0 : doc.copyObjectsFrom(src, e.headRef, e.ref);
      };
      for (const e of objects) {
        const changed = svc._engine(() => objectStep(e));
        tick();
        await new Promise((resolve) => setImmediate(resolve));
        if (!changed) continue;
        ctx.dirty = true; ctx.formatting = true; ctx.changed.add(e.ref);
        recs.push({ ref: e.ref, kind: 'changed', hid: e.hid });
      }
      // 제가 추적으로 넣은 개체를 지우면 그 넣음을 거절한다(번호가 다시 매겨짐) — 제안의 changeIds 를 맞춘다
      if (trk && objects.length) svc._syncChangeIds(meta, doc);
      // 3) 문단 넣기·지우기: 뒤에서부터(앞 번호가 흔들리지 않게 — 같은 자리 넣기는 문서 차례가 지켜지게 큰 차례부터)
      structural.sort((a, b) => a.sec - b.sec || b.key - a.key || b.order - a.order);
      const date = new Date();
      // 합친·가른 문단의 글자·문단 모양이 보낸 문단과 다르면 옮긴다(서식 커밋 — 같으면 손대지 않음)
      const syncFormat = (ref, headRef) => {
        if (!headRef) return;
        let same = true; try { same = doc.formattingFingerprint(ref) === src.formattingFingerprint(headRef); } catch { same = true; }
        if (same) return;
        svc._engine(() => crs._copyFormatting(doc, src, headRef, ref)); ctx.formatting = true;
      };
      // 문단 나눔을 추적하는 문서(brk): 지울 문단의 글·개체 지우기를 구조를 바꾸기 전에 모두 한다(1차 — 아직 문단이 따로 있어 ref 가 그대로다.
      // 앞 문단과 묶은 뒤에 하면 묶음 안 문단마다 다시 거절·다시 지우기가 되풀이돼 연속 지우기가 O(m²) — DESIGN §4-6). 남은 것이 있는지(keep —
      // 지운 글·지운 개체·남의 변경 표식)도 이때 적어 둔다. 나눔 지우기(2차)는 아래 고리에서 뒤에서부터
      if (brk) {
        const clears = structural.filter((s) => s.kind === 'remove' && s.track);
        // (2026-11-03) 구역마다 한 번에(clearParagraphsTracked — 엔진이 흉내 낼 수 있는 문단뿐일 때, 하나씩 한 것과 같은 XML). 아니면 하나씩
        // 흉내 낼 수 없는 문단(머리말·감추기·필드 등 부호가 든 문단)이 끼면 그 문단만 하나씩 — 차례(큰 번호부터)는 그대로라 머리 항목 차례도 같다
        const clearOne = async (s) => {
          const ref = `s${s.sec}/p${s.at}`;
          svc.applyLiveText(ctx, ref, '', by);
          if (trk) { svc._engine(() => doc.removeOwnObjectsTracked(ref, objOpt)); svc._syncChangeIds(meta, doc); }
          s.keep = svc._engine(() => doc.text(ref, 'markup') !== '' || doc.changes().some((c) => c.ref === ref));
          s.cleared = true;
          tick();
          // (2026-11-03) 하나씩이면 문단마다 구역을 다시 읽는다 — 쉬지 않으면 큰 잘라내기 동안 서버 전체(다른 문서·WebSocket·로그)가
          // 멈췄다(전체 583문단 15초). 문서 쓰기 큐는 계속 쥐므로 다른 쓰기와 섞이지 않는다
          await new Promise((resolve) => setImmediate(resolve));
        };
        for (const sec of new Set(clears.map((s) => s.sec))) {
          const items = clears.filter((s) => s.sec === sec);
          for (let i = 0; i < items.length;) {
            let j = i;
            if (this.batch && trk) while (j < items.length && doc.canClearTracked(sec, items[j].at)) j++;
            const run = items.slice(i, j);
            const keep = run.length > 1
              ? svc._engine(() => doc.clearParagraphsTracked(sec, run.map((s) => s.at), { author: by, date: new Date(), objectDate: objOpt.date })) : null;
            if (keep) {
              for (const s of run) { s.keep = keep.get(s.at); s.cleared = true; s.batched = true; }
              ctx.dirty = true;
              svc._syncChangeIds(meta, doc);
              tick(run.length);
              await new Promise((resolve) => setImmediate(resolve));
              i = j;
              continue;
            }
            const end = Math.max(j, i + 1);
            for (const s of items.slice(i, end)) await clearOne(s);
            i = end;
          }
        }
      }
      for (let structuralIndex = 0; structuralIndex < structural.length; structuralIndex++) {
        const s = structural[structuralIndex];
        // [hwpx-cowork] 최종본의 같은 틈에 붙여넣은 문단은 생성·서식을 구역마다 한 번에
        // 처리한다. 추적/문서 맨 앞/다른 구조 연산은 기존 경로를 유지한다. 그림·표·도형은
        // 기존 copyObjectsFrom을 기존 내림차순으로 호출해 자산·ID·필드 규칙을 보존한다.
        if (mode === 'final' && !brk && !trk && s.kind === 'insert' && s.after >= 0
            && s.after < doc.sections[s.sec]?.bodyParas.length && BODY_RE.test(s.headRef || '')) {
          let end = structuralIndex + 1;
          while (end < structural.length) {
            const next = structural[end];
            if (next.kind !== 'insert' || next.sec !== s.sec || next.after !== s.after || !BODY_RE.test(next.headRef || '')) break;
            end++;
          }
          if (end - structuralIndex > 1) {
            const group = structural.slice(structuralIndex, end);
            const ordered = [...group].reverse();
            // 기존 삽입→수락 경로가 남기는 작성자/추적 설정은 보존하되 임시 변경 항목은 만들지 않는다.
            if (group.some(item => item.text)) {
              doc.header.ensureAuthor(by || '?');
              if (!doc.header.trackingEnabled()) doc.header.setTracking(true);
            }
            const refs = svc._engine(() => doc.insertFinalParagraphsAfter(s.sec, s.after, ordered.map(item => item.text)));
            await crs._copyFormattingBatch(doc, src, ordered.map((item, i) => ({ sourceRef: item.headRef, targetRef: refs[i] })));
            const first = s.after + 1; const count = refs.length;
            const shift = i => i >= first ? i + count : i;
            svc._remapRefs(meta, s.sec, shift);
            for (const record of recs) record.ref = shiftRef(record.ref, s.sec, shift);
            for (let i = 0; i < group.length; i++) {
              const item = group[i]; const ref = refs[count - i - 1];
              if (item.objects) svc._engine(() => doc.copyObjectsFrom(src, item.headRef, ref));
              recs.push({ ref, kind: 'inserted', hid: item.hid, insText: item.text });
              if (i % 8 === 7) await new Promise(resolve => setImmediate(resolve));
            }
            ctx.dirty = true; ctx.formatting = true;
            tick(end - structuralIndex);
            structuralIndex = end - 1;
            continue;
          }
        }
        // (2026-11-03) 변경 추적 문서: 1차를 묶음으로 지운 문단이 잇달아 있으면 2차(앞 문단 끝 나눔 지움)도 한 번에(deleteBreaksTracked —
        // 하나씩 deleteBreakAfter 한 것과 같은 XML). 자리 옮김·기록은 아래 하나씩 길과 같다
        if (this.batch && s.kind === 'remove' && s.batched) {
          let end = structuralIndex + 1;
          while (end < structural.length && structural[end].kind === 'remove' && structural[end].batched && structural[end].sec === s.sec) end++;
          const run = structural.slice(structuralIndex, end);
          if (run.length > 1 && svc._engine(() => doc.deleteBreaksTracked(s.sec, run.map((x) => x.at), objOpt))) {
            for (let i = 0; i < run.length; i++) {
              const x = run[i];
              svc._syncChangeIds(meta, doc);
              svc._remapRefs(meta, x.sec, (j) => (j === x.at ? -1 : j > x.at ? j - 1 : j));
              for (const r of recs) r.ref = shiftRef(r.ref, x.sec, (j) => (j > x.at ? j - 1 : j));
              recs.push({ ref: `s${x.sec}/p${x.at}`, kind: 'deleted', removed: true, hid: x.hid, clashed: x.clashed, prev: x.prev });
              if (i % 32 === 31) await new Promise((resolve) => setImmediate(resolve));
            }
            ctx.dirty = true;
            tick(run.length);
            structuralIndex = end - 1;
            await new Promise((resolve) => setImmediate(resolve));
            continue;
          }
        }
        // (2026-11-03) 변경 추적 문서의 같은 틈에 붙여넣은 글 문단(개체 없음)은 한 번에(insertTrackedParagraphsAfter + 서식 묶음 —
        // 하나씩 insertParagraphAfter(trackBreak)·_copyFormatting 한 것과 같은 XML). 개체 문단은 아래 하나씩 길(같은 차례)로
        const bulkTracked = (x) => x.kind === 'insert' && !x.objects && x.after >= 0 && BODY_RE.test(x.headRef || '');
        if (this.batch && brk && trk && mode === 'tracked' && bulkTracked(s)) {
          let end = structuralIndex + 1;
          while (end < structural.length && bulkTracked(structural[end]) && structural[end].sec === s.sec && structural[end].after === s.after) end++;
          const group = structural.slice(structuralIndex, end);
          const refs = group.length > 1 ? svc._engine(() => doc.insertTrackedParagraphsAfter(s.sec, s.after, group.map((x) => x.text), { author: by, date })) : null;
          if (refs) {
            await crs._copyFormattingBatch(doc, src, group.map((x, i) => ({ sourceRef: x.headRef, targetRef: refs[i] })));
            ctx.formatting = true;
            const nb = s.after + 1; const fn = (j) => (j >= nb ? j + 1 : j);
            for (let i = 0; i < group.length; i++) {
              svc._remapRefs(meta, s.sec, fn);
              for (const r of recs) r.ref = shiftRef(r.ref, s.sec, fn);
              recs.push({ ref: `s${s.sec}/p${nb}`, kind: 'inserted', hid: group[i].hid, insText: group[i].text });
              if (i % 32 === 31) await new Promise((resolve) => setImmediate(resolve));
            }
            ctx.dirty = true;
            tick(group.length);
            structuralIndex = end - 1;
            await new Promise((resolve) => setImmediate(resolve));
            continue;
          }
        }
        if (s.kind === 'insert') {
          // 문단 나눔을 추적하는 문서면 넣은 문단의 나눔도 넣음 표식으로(trackBreak — 거절하면 앞 문단과 합쳐져 빈 줄이 남지 않는다)
          const newRef = svc._engine(() => doc.insertParagraphAfter(s.sec, s.after, s.text, { author: by, date, atStart: s.after < 0, ...(brk ? { trackBreak: true } : {}) }));
          if (s.headRef) { svc._engine(() => crs._copyFormatting(doc, src, s.headRef, newRef)); ctx.formatting = true; }
          // 넣은 문단의 그림·조판 부호(그림 문단·그림이 든 글 문단). 개체를 추적하는 문서면 넣은 개체를 Insert 로 감싼다
          if (s.headRef && s.objects) {
            svc._engine(() => (trk ? doc.copyObjectsTracked(src, s.headRef, newRef, objOpt) : doc.copyObjectsFrom(src, s.headRef, newRef)));
            if (trk) svc._syncChangeIds(meta, doc);
          }
          const nb = Number(/\/p(\d+)$/.exec(newRef)[1]);
          const fn = (i) => (i >= nb ? i + 1 : i);
          svc._remapRefs(meta, s.sec, fn);
          for (const r of recs) r.ref = shiftRef(r.ref, s.sec, fn);
          if (mode === 'final') svc._resolveIds(ctx, doc.changes().filter((c) => c.ref === newRef).map((c) => c.id), 'accept');
          recs.push({ ref: newRef, kind: 'inserted', hid: s.hid, insText: s.text });
        } else if (s.kind === 'join') {
          // 합침(2단계): 뒤에서부터 나눔만 지움 표식(deleteBreakAfter — 제가 넣은 나눔이면 그 넣음 거절 = 물리로 합침). 글은 지우고 다시 넣지 않는다 —
          // 합친 최종 문단 글을 보낸 글로(charOps 만: 순수 Backspace 면 할 일 없음). meta·recs 주소는 합침 규칙(_applyParaLog merge)으로
          for (let j = s.count - 1; j >= 0; j--) {
            const r0 = `s${s.sec}/p${s.at + j}`;
            const cnt = partCounts(doc, r0);
            svc._engine(() => doc.deleteBreakAfter(r0, objOpt));
            svc._syncChangeIds(meta, doc, recs);
            svc._applyParaLog(meta, { sec: s.sec, op: 'merge', at: s.at + j, ...cnt }, recs);
          }
          const ref = `s${s.sec}/p${s.at}`;
          if (svc._engine(() => doc.text(ref, 'final')) !== s.target) svc.applyLiveText(ctx, ref, s.target, by);
          syncFormat(ref, s.headRef);
          recs.push({ ref, kind: 'changed', hid: s.hid }, { ref, kind: 'shadow', baseRef: s.baseRef, shText: s.target });
          for (const hid of s.dels) recs.push({ ref: `s${s.sec}/p${s.at + 1}`, kind: 'deleted', removed: true, hid });
        } else if (s.kind === 'split') {
          // 가름(2단계): 뒤 자리부터 가르고(splitParagraphTracked — P머리{+¶+}, 꼬리는 추적 없이 새 문단으로) 각 부분을 보낸 글로(순수 Enter 면 할 일 없음).
          // meta·recs 주소는 가름 규칙(_applyParaLog split — 꼬리 쪽 중첩 주소도). 새 부분은 넣은 문단으로 적는다(liveTouch ins — 옛 기준 다시 보내기)
          const ref0 = `s${s.sec}/p${s.at}`;
          for (let j = s.offsets.length - 1; j >= 0; j--) {
            const r = svc._engine(() => doc.splitParagraphTracked(ref0, s.offsets[j], objOpt));
            svc._syncChangeIds(meta, doc, recs);
            svc._applyParaLog(meta, { sec: s.sec, op: 'split', at: s.at, n: r?.n | 0, d: r?.d | 0, t: r?.t | 0, td: r?.td | 0 }, recs);
          }
          s.parts.forEach((part, j) => {
            const ref = `s${s.sec}/p${s.at + j}`;
            if (svc._engine(() => doc.text(ref, 'final')) !== part.text) svc.applyLiveText(ctx, ref, part.text, by);
            syncFormat(ref, part.headRef);
            if (part.insert) recs.push({ ref, kind: 'inserted', hid: part.hid, insText: part.text });
            else recs.push({ ref, kind: 'changed', hid: part.hid }, { ref, kind: 'shadow', baseRef: part.baseRef, shText: part.text });
          });
        } else {
          const ref = `s${s.sec}/p${s.at}`;
          // 변경 추적: 글 전체를 지우는 변경(이 사람의 처리 안 된 변경은 먼저 거둠 — 내가 넣은 문단·글이면 그것으로 끝)을 남긴 뒤, 남은 것(지운 글·
          // 남의 변경 표식)이 있으면 그 문단을 앞 문단 끝에 붙이고(최종본은 앞 문단 그대로, 한글 변경 추적에는 지운 글로 보임), 없으면 문단째 지운다
          let join = false; let broke = false;
          const keep = () => svc._engine(() => doc.text(ref, 'markup') !== '' || doc.changes().some((c) => c.ref === ref));
          if (s.cleared) {
            // 2차(문단 나눔 추적 — 글·개체는 1차에서 지움): 앞 문단 끝의 나눔을 지움 표식으로(deleteBreakAfter — 제가 넣은 나눔이면 그 넣음을 거절해
            // 물리로 합치고, 남이 넣은 나눔은 수락한 뒤 지운다). 문단은 따로 남아 한/글에서는 제 줄의 지운 글로 보이고, 최종본에서는 앞 문단과
            // 한 문단(빈 줄 없음) — 나눔 지움을 거절하면 제 문단으로 돌아온다. 남은 것이 없는 문단(빈 줄)도 '문단 나눔 지움'으로 남는다(한/글처럼).
            // 그런 문단의 보낸 문서 다른 자리로 옮겨 간 메모·머리말은 옛 길처럼 빼 두었다가 옮긴다. 마지막 문단·구역 나누기 문단
            // (LAST_PARAGRAPH·SECTION_BREAK — 드물게 이미 지운 나눔 BREAK_STATE)이면 옛 길(붙이기·문단째 지우기)
            if (!s.keep) {
              parkMemos(svc, ctx, ref, memoSync);
              const hfs = svc._engine(() => doc.takeHeaderFooters(ref));
              if (hfs.length) memoSync.headerFooters.push({ list: hfs, sec: s.sec, at: s.at });
            }
            try { doc.deleteBreakAfter(`s${s.sec}/p${s.at - 1}`, objOpt); broke = true; } catch (e) {
              if (!['LAST_PARAGRAPH', 'SECTION_BREAK', 'BREAK_STATE'].includes(e?.code)) svc._engine(() => { throw e; });
            }
            join = !broke && s.keep;
          } else if (s.track) {
            svc.applyLiveText(ctx, ref, '', by);
            // 개체를 추적하는 문서: 그 문단의 보이는 개체도 지우는 변경으로 감싼다(제가 추적으로 넣은 개체는 그 넣음 거절 = 바로 지움).
            // 지운 개체가 남으면(keep — 개체 변경도 changes() 에 그 문단 ref 로 나온다) 문단을 앞 문단 끝에 붙인다(한/글에서 지운 표로 보임)
            if (trk) { svc._engine(() => doc.removeOwnObjectsTracked(ref, objOpt)); svc._syncChangeIds(meta, doc); }
            join = keep();
          } else if (mode === 'tracked' && svc._engine(() => doc.changes().some((c) => c.ref === ref))) {
            // (개체를 추적하지 않는 엔진) 그림·표 문단에 변경 추적이 있으면(같은 밀어 넣기에서 함께 지운 뒤 문단의 지운 글이 붙어 옴 등) 그 기록을
            // 잃지 않게 그림·표만 지우고 글은 지우는 변경으로 남겨 앞 문단에 붙인다
            svc._engine(() => doc.removeOwnObjects(ref));
            svc.applyLiveText(ctx, ref, '', by); join = keep();
          }
          if (broke) { /* 나눔 지움 표식으로 묶음 — 문단은 따로 남음 */ }
          else if (join) svc._engine(() => doc.joinBodyParagraph(s.sec, s.at));
          else {
            // 지운 문단(그림·표 문단)의 그림 파일은 아무도 안 쓰면 거둔다
            let bins = []; let goneXml = ''; try { const { sec: S0, p: P0 } = doc.resolve(ref); goneXml = S0.xml.slice(P0.start, P0.end); bins = [...goneXml.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((x) => x[1]); } catch { bins = []; }
            // 보낸 문서의 다른 문단으로 옮겨 간 메모는 빼 두었다가 아래에서 다시 넣는다(문단째 지우면 메모도 사라진다)
            parkMemos(svc, ctx, ref, memoSync);
            // 머리말·꼬리말이 든 줄을 앞 줄로 합쳤으면(보낸 문서에서 그 머리말이 다른 문단에) 머리말째 빼 두었다가 옮긴다
            const hfs = svc._engine(() => doc.takeHeaderFooters(ref));
            if (hfs.length) memoSync.headerFooters.push({ list: hfs, sec: s.sec, at: s.at });
            svc._engine(() => doc.removeBodyParagraph(s.sec, s.at));
            for (const b of bins) doc.removeUnusedBinary(b);
            // [hwpx-cowork] 지운 문단의 차트 부분(Chart/chartN.xml)도 아무도 안 쓰면 거둔다(engine/chart-parts.js)
            if (goneXml.includes('chartIDRef=')) doc._releaseShapeParts(goneXml);
          }
          svc._syncChangeIds(meta, doc);
          const fn = (i) => (i === s.at ? -1 : i > s.at ? i - 1 : i);
          svc._remapRefs(meta, s.sec, fn);
          for (const r of recs) r.ref = shiftRef(r.ref, s.sec, (i) => (i > s.at ? i - 1 : i));
          // 지운 문단의 ref = 그 자리(지금은 다음 문단이 차지)
          recs.push({ ref: `s${s.sec}/p${s.at}`, kind: 'deleted', removed: true, hid: s.hid, clashed: s.clashed, prev: s.prev });
        }
        ctx.dirty = true;
        tick();
        // Let health checks, WebSockets and the supervisor heartbeat run while
        // a large paste still holds this document's write lock.
        await new Promise(resolve => setImmediate(resolve));
      }
      // [hwpx-cowork] 빼 둔 메모·되돌리기로 돌아온 메모를 보낸 문서의 자리로(구역을 이었으면 이은 번호 그대로 — 다시 나누기 전에)
      if (memoSync.parked.length || memoSync.back.length) placeMemos(svc, ctx, src, memoSync, memoEvents);
      if (memoSync.headerFooters.length) placeHeaderFooters(svc, ctx, src, memoSync);
      // [hwpx-cowork] 이었던 구역을 다시 구역 파일로 — 고쳤으면 보낸 문서의 구역 경계(보낸 문서 구역 첫 문단과 짝인 지금 문단 중 구역 나누기
      // 문단)에서, 아무것도 안 바꿨으면 원래 경계에서. meta·recs 주소도 구역별로 돌아간다
      if (flat) {
        let starts = [];
        let off = 0; const bounds = flat.sizes.map((nn) => { const b = off; off += nn; return b; });
        if (ctx.dirty) {
          off = 0; const headBounds = secs.head.map((nn) => { const b = off; off += nn; return b; });
          const pairs = planBody(doc.bodyEntries()[0] || [], diff.flatHead.bodyEntries()[0] || []).pairs;
          // 구역 나누기 맞추기: 짝 문단의 구역 나누기 유무가 보낸 문서와 다르면(구역 첫 문단에 짝지은 문단 — 그때는 첫 문단이라 덩어리로
          // 옮기지 못했다 — 등) 보낸 문단의 부호를 다시 옮긴다. 문서 첫 문단의 구역 정의는 늘 그대로
          for (const [i, j] of pairs) {
            if (i === 0) continue;
            const want = diff.flatHead.hasSectionBreak(`s0/p${j}`);
            if (doc.hasSectionBreak(`s0/p${i}`) !== want) svc._engine(() => doc.copyObjectsFrom(src, `s0/p${j}`, `s0/p${i}`));
          }
          const back = new Map(pairs.map(([i, j]) => [j, i]));
          starts = headBounds.map((j) => back.get(j)).filter((i) => i != null);
        } else starts = bounds;
        svc._unflattenLive(doc, meta, flat, starts, recs);
        // 구역 구조가 바뀐 커밋 — 다른 창은 구역 수가 달라 글만 맞출 수 없으니 서식 커밋처럼 다시 열게 한다(보낸 창은 formatVersion 으로 넘긴다)
        if (ctx.dirty) ctx.formatting = true;
      }
      } catch (e) {
        if (metaBackup) { for (const k of Object.keys(meta)) delete meta[k]; Object.assign(meta, metaBackup); }
        throw e;
      }
      if (!ctx.dirty) return untouched();

      // 4) 마지막 작성자 기억(§2.3) — 글이 남은 문단만(통째로 지운 문단의 것은 _remapRefs 가 버렸다). 이 창이 넣은(또는 다시 맞춘) 문단은
      //    ins = { by, base, text, v }(v = 그 문단을 넣은 기록 — 이 커밋이 만들 기록은 meta.version + 1; newSince), 남이 넣은 문단을 고치면 그 ins 는 그대로
      const lt = meta.liveTouch || (meta.liveTouch = {});
      const made = meta.version + 1;
      for (const r of recs) {
        if (r.removed || r.kind === 'shadow') continue;
        const old = lt[r.ref];
        const insOf = () => ({ by, base: n, text: r.insText, v: r.kind === 'inserted' ? made : (Number.isInteger(old?.ins?.v) ? old.ins.v : made) });
        if (r.kind === 'touch') { if (old) lt[r.ref] = { ...old, ins: insOf() }; continue; }
        const ins = r.insText != null ? insOf() : old?.ins;
        lt[r.ref] = { by, at, ...(ins ? { ins } : {}), ...(old?.pushed ? { pushed: old.pushed } : {}) };
      }
      // 이 사람이 이 기준에서 보낸 문단 글(지문) — 같은 기준에서 같은 글을 다시 보내면 건너뛴다(위 1)
      for (const r of recs) {
        if (r.kind !== 'shadow') continue;
        const o = lt[r.ref] || { by, at };
        lt[r.ref] = { ...o, pushed: { ...(o.pushed || {}), [by]: { base: n, ref: r.baseRef, h: textPrint(r.shText) } } };
      }
      // (같은 문단의 글·서식·그림/부호가 함께 바뀌면 기록이 여럿이다 — 한 번씩)
      const refsOf = (k) => [...new Set(recs.filter((r) => r.kind === k).map((r) => r.ref))].sort(cmpRef);
      const applied = { changed: refsOf('changed'), inserted: refsOf('inserted'), deleted: refsOf('deleted') };
      const conflicts = recs.filter((r) => r.clashed).map((r) => ({ ref: r.ref, by, to: r.prev && r.prev.by !== by ? r.prev.by : null }));
      svc.store.log(meta, by, 'edit.live', `${applied.changed.length}문단 변경, ${applied.inserted.length} 추가, ${applied.deleted.length} 삭제${conflicts.length ? `, 겹침 ${conflicts.length}` : ''}`);
      // 서식·그림·부호 커밋의 WS(formatting — 다른 창은 다시 연다)에 이 밀어 넣기 차례를 싣는다 — 보낸 창은 제 차례로 알아보고 넘긴다
      if (seqNo != null) {
        ctx.liveSeq = seqNo;
        // 이 기록을 만든 창의 차례(ownBase — 같은 창의 다음 밀어 넣기가 옛 기준으로 와도 이 기록까지 기준으로 본다)
        ctx.beforeSave = () => { const rec = meta.versions[meta.versions.length - 1]; if (rec && rec.n === meta.version) rec.seq = seqNo; };
      }
      ctx.skipVerify = true; // 편집기에서 사람이 한 편집 — 그 파일이 기준이라 편집 뒤 검증(server/edit-verify.js)으로 막지 않는다
      const version = await svc._finish(ctx, '실시간 편집');
      return {
        version, committed: true, clean: cleanOrLog(id, ctx.doc, head, true), applied, skipped, conflicts, unsupported: unsupported.length, memoEvents,
        ...(ctx.formatting ? { formatVersion: meta.formatVersion } : {}),
      };
    });
    this._rememberMemos(id, { loaded: loadedV, win, by, head: memoHead });

    const res = {
      version: out.version, clean: out.clean, applied: out.applied || EMPTY_APPLIED(), skipped: out.skipped || [], conflicts: out.conflicts || [],
      unsupported: out.unsupported ?? 0, ...(seqNo != null ? { seq: seqNo } : {}), ...(out.formatVersion != null ? { formatVersion: out.formatVersion } : {}),
    };
    if (out.committed) {
      const a = res.applied;
      svc.hub.broadcast(id, { type: 'doc', action: 'changed', version: out.version, by, live: true, changed: a.changed, inserted: a.inserted, deleted: a.deleted, ...(seqNo != null ? { seq: seqNo } : {}) });
      for (const c of res.conflicts) if (c.to) svc.hub.broadcast(id, { type: 'doc', action: 'live-overwrite', ref: c.ref, by, to: c.to });
      for (const e of out.memoEvents || []) svc.hub.broadcast(id, { type: 'memo', ...e, by, version: out.version });
    }
    return res;
  }
}
