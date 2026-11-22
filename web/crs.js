// 변경 요청(CR, GitHub 풀 리퀘스트처럼) 화면 — docs/V3_SPEC.md §5.3·§3.3.
//  - 목록: 내 것(초안·검토 중) 맨 위 → 남의 검토 중 → 남의 초안(수정 중) → 반영·닫힘(접기).
//    카드 '#3 제목 [검토 중]' + '홍길동 · 문단 3 · 승인 1 · 수정 요청 1 · 의견 2 · v3에서 고침 · 최신으로 맞추기 필요'
//    (상태는 머리 알약 하나, 0 인 수정 요청·의견과 초안의 승인 수는 쓰지 않는다 — docs/UI_TERMS.md §1)
//    v3 = 사람용 버전(§9.4 — CRView baseV, 반영된 것은 mergedV 'v4로 반영'). 기록 번호(baseVersion·mergedVersion = 내부 판 n)는 내지 않는다
//  - 상세: 제목·설명(작성자·관리자 고침) · 덩어리마다 원문→수정 글자 차이(diffHtml)·상태(충돌/사라짐/원문 바뀜) · [편집기에서 보기][의견] ·
//    의견 스레드(답글·완료) · 검토 [승인][수정 요청][의견만](작성자는 의견만, 초안은 승인 못 함 — 검토 요청 뒤에) ·
//    검토 목록(승인 뒤 수정본이 바뀐 승인은 '승인(내용 바뀜)'으로 옅게) · 반영(막힘 이유는 한 번만·충돌 목록·[최신으로 맞추기]) · 닫기/다시 열기
//    설명 문장은 title·Hint(?)로 — 화면에는 이름표만
//  - 검토 요청 창: 제목(필수, 기본 = 첫 덩어리의 바뀐 낱말 — '「…」 수정'·'문단 추가: …'·'문단 삭제', 30자까지)·설명.
//    d.s.submitOpen 이 true(내 변경 요청) 또는 cid 이면 뜬다.
// 낱말: 검토 판단 'changes' 는 '수정 요청'(서버 crs.js VERDICTS·한글 메모와 같다). '변경 요청'은 변경 요청(CR) 자체의 이름이다.
// store 계약: d.s.crs·d.s.myCr·d.s.draft·d.s.paragraphs, d.crDetail·submitCr·patchCr·reviewCr·addThread·replyThread·resolveThread·mergeCr·closeCr·reopenCr·rebaseMine·discardMine·saveDraftNow
import { ref, reactive, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } from '/vendor/vue.esm-browser.prod.js';
import { toast, toastError, fmt, fmtShort, clip, josa } from './util.js';
import { FloatWin, MemoEditor, InlineConfirm, ThreadList, Hint, focusIn, meName, isMeName, isAdmin, colorOf, agentOf, uiSlots, uiSlot, openSlot, closeSlot, runSlot } from './ui.js';
import { diffHtml } from './diff.js';
import { ICON } from './icons.js';

export const CR_STATUS = { draft: '초안', open: '검토 중', merged: '반영됨', closed: '닫힘' };
const CR_STATUS_CLS = { draft: 'draft', open: 'warn', merged: 'ok', closed: '' };
// 원형 없는 객체: 옛 자료의 이상한 판단('constructor' 등)이 함수 글로 보이지 않게(서버도 이제 막는다 — server/crs.js VERDICTS)
export const VERDICT = Object.assign(Object.create(null), { approve: '승인', changes: '수정 요청', comment: '의견' });
const VERDICT_CLS = Object.assign(Object.create(null), { approve: 'ok', changes: 'bad', comment: '' });
const HUNK_TYPE = { replace: '바꿈', insert: '문단 추가', delete: '문단 지움', format: '서식 변경' };
const UNSUPPORTED = { 'table-structure': '표 행·열 구조', object: '그림·개체', format: '서식(글자 모양)' };
const ACTIVE = new Set(['draft', 'open']);
/** 초안에는 승인할 수 없다(서버도 막는다) — [승인] 설명 */
export const DRAFT_APPROVE_TIP = '검토 요청 후 승인할 수 있습니다';
/** 승인 뒤 수정본이 바뀐 승인(서버 r.stale) — 이름표는 짧게, 설명은 STALE_APPROVE_TIP(title) */
export const STALE_APPROVE_LABEL = '승인(내용 바뀜)';
export const STALE_APPROVE_TIP = '이 승인 뒤에 수정본이 바뀌어 반영에 세지 않습니다 — 다시 승인받아야 합니다';
/** 공유 문서가 바뀌어 내 수정본을 새 버전 위로 옮겨야 할 때(상단 칩·카드·상세 공통 이름표와 설명) */
export const REBASE_LABEL = '최신으로 맞추기';
export const REBASE_TIP = '공유 문서의 새 버전 위로 내 수정본을 옮깁니다(겹치는 곳은 내 글을 남김)';

const hunkCount = (cr) => cr?.hunkCount ?? cr?.hunks?.length ?? 0;
const cps = (s) => Array.from(String(s ?? ''));
/**
 * 사람용 버전(§9.4): 수정본의 기준 v(CRView baseV)·반영으로 생긴 v(mergedV). 옛 서버(그 칸 없음)는 그때의 버전 번호가 곧 버전이다.
 * 새 서버가 null 을 주면(반영 기록의 이정표를 모름) null — 화면은 번호 없이 쓴다
 */
export const baseVOf = (cr) => (!cr ? null : 'baseV' in cr ? cr.baseV : cr.baseVersion ?? null);
export const mergedVOf = (cr) => (!cr ? null : 'mergedV' in cr ? cr.mergedV : cr.mergedVersion ?? null);
/** '반영' 글: 'v4로 반영'(조사 §0-7) 또는 버전을 모르면 '반영' */
export const mergedText = (cr) => { const v = mergedVOf(cr); return v != null ? `${josa(`v${v}`, '으로/로')} 반영` : '반영'; };

// ───────── 검토 요청 제목 기본값 — 바뀐 것에서 ─────────
export const TITLE_MAX = 30;
const isWs = (c) => /\s/u.test(c || '');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 글을 n 자(코드포인트) 안으로 — 넘치면 끝을 '…' 로 */
const fit = (s, n) => { const a = cps(s); return a.length > n ? `${a.slice(0, Math.max(1, n - 1)).join('')}…` : a.join(''); };
/** 두 글의 바뀐 가운데(앞뒤 같은 부분을 뗀 것) — 옛 글 [a0, a1) · 새 글 [b0, b1)(코드포인트) */
function changedRange(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { a0: p, a1: a.length - q, b0: p, b1: b.length - q };
}
/** 글자 범위 [s, e) 가 낱말 가운데서 시작·끝나면 그 낱말 끝까지 넓힌 글(공백 정리) */
function wordsAround(chars, s, e) {
  while (s > 0 && !isWs(chars[s - 1]) && !isWs(chars[s])) s--;
  while (e < chars.length && e > 0 && !isWs(chars[e]) && !isWs(chars[e - 1])) e++;
  return oneLine(chars.slice(s, e).join(''));
}
/**
 * 검토 요청 제목 기본값(30자까지, 창에서 고칠 수 있다): 첫 덩어리에서 바뀐 것으로 —
 *  바꿈 = 새 글에서 바뀐 낱말 '「4월부터」 수정'(넣기만 했으면 '… 추가', 지우기만 했으면 옛 글의 그 낱말 '… 삭제') ·
 *  문단 추가 = '문단 추가: 새 글…'(빈 문단이면 '빈 문단 추가') · 문단 지움 = '문단 삭제'. 덩어리가 더 있으면 끝에 ' 외 n곳'.
 *  띄어쓰기·줄바꿈만 바뀌었으면(바뀐 글이 공백뿐) 그 문단 글 앞부분으로 '「…」 띄어쓰기 수정' — 문단 글 전체를 '추가'·'삭제'했다고 하지 않게.
 */
export function defaultTitle(cr) {
  const hs = cr?.hunks || [];
  const h = hs[0];
  if (!h) return '';
  const more = hs.length > 1 ? ` 외 ${hs.length - 1}곳` : '';
  const room = TITLE_MAX - cps(more).length;
  let t;
  if (h.type === 'insert') { const s = oneLine(h.newText); t = s ? `문단 추가: ${fit(s, room - 7)}` : '빈 문단 추가'; }
  else if (h.type === 'delete') t = '문단 삭제';
  else if (h.type === 'format') t = `서식 변경: ${fit(oneLine(h.newText || h.baseText), room - 7)}`;
  else if (h.type === 'object') t = fit(h.objectSummary || '그림·조판 부호 변경', room);
  else {
    const a = cps(h.baseText); const b = cps(h.newText);
    const r = changedRange(a, b);
    const ins = r.b1 > r.b0; const del = r.a1 > r.a0;
    let words = ins ? wordsAround(b, r.b0, r.b1) : del ? wordsAround(a, r.a0, r.a1) : '';
    let verb = ins && !del ? '추가' : del && !ins ? '삭제' : '수정';
    // 바뀐 글이 공백뿐(낱말이 안 잡힘): 문단 글 앞부분 + '띄어쓰기 수정'
    if (!words) { words = oneLine(h.newText) || oneLine(h.baseText); if (ins || del) verb = '띄어쓰기 수정'; }
    t = `「${fit(words, room - 3 - cps(verb).length)}」 ${verb}`;
  }
  return t + more;
}

// ───────── 검토 수 · 판단 이름 ─────────
/**
 * 변경 요청의 검토 수(서버 CRView 그대로): 승인(살아 있는 것) · 다시 승인 필요(승인 뒤 수정본이 바뀐 승인, staleApprovals) ·
 * 수정 요청 · 의견(의견 스레드 + '의견만' 검토)
 */
export function crCounts(cr) {
  return {
    approvals: Number(cr?.approvals) || 0,
    stale: Number(cr?.staleApprovals) || 0,
    changes: Number(cr?.changesRequested) || 0,
    comments: (cr?.threads || []).length + (cr?.reviews || []).filter((r) => r?.verdict === 'comment').length,
  };
}
/** 승인 뒤 수정본이 바뀐 승인인가(서버가 r.stale = { at, by } 를 적는다) */
export const isStaleReview = (r) => r?.verdict === 'approve' && !!r.stale;
/** 검토 판단 이름: 승인 · 수정 요청 · 의견(낡은 승인은 '승인(내용 바뀜)') */
export const verdictLabel = (r) => (isStaleReview(r) ? STALE_APPROVE_LABEL : VERDICT[r?.verdict] || r?.verdict || '');
/**
 * 검토 수 한 줄(카드·상단 칩 공통): '승인 1 · 수정 요청 1 · 의견 2' — 0 인 수정 요청·의견은 쓰지 않는다.
 * 승인 수는 초안이면 쓰지 않는다(초안은 승인할 수 없다)
 */
export function crCountParts(cr) {
  const c = crCounts(cr); const out = [];
  if (cr?.status !== 'draft') out.push(`승인 ${c.approvals}`);
  if (c.changes) out.push(`수정 요청 ${c.changes}`);
  if (c.comments) out.push(`의견 ${c.comments}`);
  return out;
}
/** 상단 '변경 요청' 칩 글: '검토 중 #3 · 승인 1 · 의견 2'(0 인 수정 요청·의견은 뺌 — 칩 title 이 '변경 요청 #3') */
export function crChipText(cr) {
  if (!cr) return '';
  return [`${CR_STATUS[cr.status] || cr.status} #${cr.cid}`, ...crCountParts(cr)].join(' · ');
}

// ───────── 덩어리 '편집기에서 보기' 자리 ─────────
const REF_NUM = /^s(\d+)\/p(\d+)/;
/** 두 문단 ref 의 거리(같은 구역 본문 번호 차이, 구역이 다르면 멀다) */
function refDistance(x, y) {
  const a = REF_NUM.exec(String(x || '')); const b = REF_NUM.exec(String(y || ''));
  if (!a || !b) return Infinity;
  return Math.abs(Number(a[1]) - Number(b[1])) * 1e6 + Math.abs(Number(a[2]) - Number(b[2]));
}
/**
 * 덩어리의 '편집기에서 보기' 자리(지금 기준 문서 ref) → { ref, why }(ref 가 없으면 why = 단추를 막은 까닭).
 *  - 진행 중: 서버가 지금 기준으로 옮겨 준 curRef(없으면 그 문단이 사라짐).
 *  - 반영됨: curRef 가 지금 기준 문단 목록에 있을 때. 서버가 반영된 변경 요청의 덩어리에 curRef 를 하나도 주지 않으면
 *    지금 기준 문단 중 그 덩어리의 새 글과 같은 문단(그 자리 → 가장 가까운 것). 지운 문단·그 뒤에 바뀐 문단은 없음.
 *  - 닫힘: 기준 문서에 들어가지 않았다.
 * @param paragraphs 지금 기준 문단 목록(store s.paragraphs — 최종본 글)
 */
export function hunkViewRef(cr, h, paragraphs) {
  if (!cr || !h) return { ref: null, why: '' };
  if (ACTIVE.has(cr.status)) return h.curRef ? { ref: h.curRef, why: '' } : { ref: null, why: '그 문단이 지금 문서에 없습니다' };
  if (cr.status !== 'merged') return { ref: null, why: '닫힌 변경 요청입니다 — 문서에 들어가지 않았습니다' };
  const list = (Array.isArray(paragraphs) ? paragraphs : []).filter((p) => p && p.where !== '메모');
  const gone = { ref: null, why: '이 문단이 지금 문서에 없습니다(반영 뒤에 바뀌었거나 지워짐)' };
  if ((cr.hunks || []).some((x) => x && x.curRef)) return h.curRef && list.some((p) => p.ref === h.curRef) ? { ref: h.curRef, why: '' } : gone;
  if (h.type === 'delete') return { ref: null, why: '지운 문단입니다' };
  const want = String(h.newText ?? '');
  if (!want.trim()) return gone;
  const hits = list.filter((p) => String(p.text ?? '') === want);
  if (!hits.length) return gone;
  const at = h.type === 'insert' ? (h.afterRef ?? h.ref) : h.ref;
  const best = hits.find((p) => p.ref === at) || hits.slice().sort((p, q) => refDistance(p.ref, at) - refDistance(q.ref, at))[0];
  return { ref: best.ref, why: '' };
}

// ───────── 반영 막힘 이유와 반영 실패(서버 오류 코드) — 같은 설명을 두 번 보이지 않게 ─────────
const ERR_BLOCKERS = { NEED_APPROVAL: ['NEED_APPROVAL'], MERGE_CONFLICT: ['CONFLICT', 'PENDING_TRACKED'], FORBIDDEN: ['FORBIDDEN'], STATE: ['STATE', 'NOT_SUBMITTED'], NO_CHANGES: ['NO_CHANGES'] };
/** 반영 실패 코드가 막힘 이유 목록에 이미 있는 그 이유 코드(없으면 null) */
export function blockerFor(code, blockers) {
  const want = ERR_BLOCKERS[code] || [code];
  return (blockers || []).find((b) => want.includes(b?.code))?.code ?? null;
}
/** 덩어리 차이 HTML(바꿈 = 글자 차이, 추가 = 새 글, 지움 = 옛 글) */
export function hunkHtml(h) {
  const e = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if (!h) return '';
  if (h.type === 'format') return `<div class="format-preview"><b>서식 변경</b><div>${e(h.formatSummary || '글 내용은 그대로 유지됩니다.')}</div></div>${e(h.newText || h.baseText)}`;
  if (h.type === 'object') return `<div class="format-preview"><b>그림·조판 부호 변경</b><div>${e(h.objectSummary || '글 내용은 그대로 유지됩니다.')}</div></div>${e(h.newText || h.baseText)}`;
  if (h.type === 'insert') return `<ins>${e(h.newText)}</ins>`;
  if (h.type === 'delete') return `<del>${e(h.baseText)}</del>`;
  return diffHtml(h.baseText || '', h.newText || '');
}
/** 덩어리 상태 표시: 사라짐(지금 문서에 그 문단 없음) / 충돌(반영 막힘) / 원문 바뀜(합칠 수 있음) */
export function hunkBadge(h) {
  if (!h) return null;
  if (h.state === 'gone') return { label: '사라짐', cls: 'bad', title: h.conflict?.message || '그 문단이 지금 문서에 없습니다' };
  if (h.conflict) return { label: h.conflict.reason === 'PENDING_TRACKED' ? '변경 추적과 겹침' : '충돌', cls: 'bad', title: h.conflict.message || '같은 자리를 다른 사람도 고쳤습니다' };
  if (h.state === 'conflict') return { label: '원문 바뀜', cls: 'warn', title: '이 문단이 그 사이 공유 문서에서 바뀌었습니다(겹치지 않아 합쳐 반영됩니다)' };
  return null;
}
const hunkKind = (h) => (h.cell || /\/n\d+/.test(String(h.ref || '')) ? '표 칸' : HUNK_TYPE[h.type] || h.type);
export const hunkQuote = (h) => clip(h.type === 'delete' ? h.baseText : (h.newText || h.baseText), 80);

// ───────── 덩어리 열쇠: 작성자가 계속 고쳐도 같은 덩어리는 같은 열쇠 ─────────
// 서버(엔진 diffDocs)의 hid 는 새 글(newText)까지 넣어 셈하므로 작성자가 자동 저장할 때마다 바뀐다.
// 화면(카드·의견 칸·고정)은 '종류 + 기준 자리(바꿈·지움 = ref, 추가 = afterRef)'(+ 같은 자리 추가의 차례)로 잡고,
// 서버에 보낼 때만 지금 hid 를 찾는다. 이 세션에서 본 hid → 열쇠는 기억해 둔다(옛 hid 로 단 의견 스레드·고정을 잇는 데).
/** 덩어리 목록 → 열쇠 목록(같은 순서) */
export function hunkKeys(hunks) {
  const seen = new Map();
  return (hunks || []).map((h) => {
    const at = h?.type === 'insert' ? (h.afterRef ?? '^') : (h?.ref ?? '?');
    const k = `${h?.type || 'replace'}:${at}`;
    const n = seen.get(k) || 0; seen.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  });
}
const hidAlias = new WeakMap();   // 문서 store → Map('cid:hid' → 열쇠)
function aliasMap(d) {
  if (!d || typeof d !== 'object') return null;
  let m = hidAlias.get(d); if (!m) { m = new Map(); hidAlias.set(d, m); }
  return m;
}
/** 본 덩어리의 hid → 열쇠를 기억(→ 열쇠 목록) */
export function rememberHunks(d, cid, hunks, keys = hunkKeys(hunks)) {
  const m = aliasMap(d);
  if (m) (hunks || []).forEach((h, i) => { if (h?.hid) m.set(`${cid}:${h.hid}`, keys[i]); });
  return keys;
}
/** hid(옛 것이어도, 이 세션에서 봤으면) → 덩어리 열쇠 */
export const hunkKeyFor = (d, cid, hid) => (hid ? aliasMap(d)?.get(`${cid}:${hid}`) ?? null : null);
/** 열쇠로 덩어리 찾기(list 의 지금 hid) */
export function hunkByKey(hunks, key) {
  const ks = hunkKeys(hunks); const i = ks.indexOf(key);
  return i >= 0 ? hunks[i] : null;
}
/** store 목록(d.s.crs — 초안·검토 중은 덩어리 포함)에서 지금 덩어리 */
export function currentHunk(d, cid, key) {
  const cr = (d?.s?.crs || []).find((c) => c.cid === Number(cid));
  return cr && Array.isArray(cr.hunks) ? hunkByKey(cr.hunks, key) : null;
}
const commonPrefix = (a, b) => { const x = Array.from(String(a || '')); const y = Array.from(String(b || '')); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };
/**
 * 의견 스레드 → 덩어리 열쇠별 목록 + 전체 의견(덩어리 없음). 옛 hid 로 단 스레드도 붙인다:
 *  ① 같은 hid ② 이 세션에서 본 옛 hid 의 열쇠 ③ 같은 자리(ref)의 덩어리 중 인용 글이 가장 많이 겹치는 것.
 * 스레드 하나는 덩어리 하나에만 붙는다. → { keys, byKey: Map(열쇠 → 스레드[]), general: 스레드[] }
 */
export function threadsByHunk(d, cr) {
  const hunks = cr?.hunks || []; const keys = rememberHunks(d, cr?.cid, hunks);
  const byKey = new Map(keys.map((k) => [k, []])); const general = [];
  const byHid = new Map(hunks.map((h, i) => [h.hid, keys[i]]));
  for (const t of cr?.threads || []) {
    let k = null;
    if (t.hid) {
      k = byHid.get(t.hid) ?? null;
      if (!k) { const a = hunkKeyFor(d, cr.cid, t.hid); if (a && byKey.has(a)) k = a; }
      if (!k && (t.ref || t.curRef)) {
        const q = String(t.quote || '').replace(/…$/, ''); let best = -1;
        hunks.forEach((h, i) => {
          // 스레드 ref 는 수정본 기준 버전 자리, curRef 는 지금 기준 문서 자리(서버 CRView)
          const here = (r) => !!r && (h.curRef === r || h.ref === r || (h.type === 'insert' && h.afterRef === r));
          if (!(here(t.ref) || (t.curRef && h.curRef === t.curRef))) return;
          const sc = commonPrefix(q, h.type === 'delete' ? h.baseText : (h.newText || h.baseText));
          if (sc > best) { best = sc; k = keys[i]; }
        });
      }
    }
    if (k) byKey.get(k).push(t); else general.push(t);
  }
  return { keys, byKey, general };
}
/**
 * 덩어리에 의견 달기 — 보내기 직전에 그 덩어리의 지금 hid 를 찾는다(작성자가 그새 저장했으면 hid 가 바뀜).
 * 그래도 NO_HUNK 면 변경 요청을 다시 읽어 한 번 더, 덩어리가 없어졌으면 자리(ref)·인용만 붙여 변경 요청 전체 의견으로(글을 잃지 않게).
 * @param h0 화면이 들고 있던 덩어리(찾지 못할 때 쓴다)
 */
export async function addHunkThread(d, cid, key, h0, text) {
  const body = (h, withHid = true) => ({
    ...(withHid && h.hid ? { hid: h.hid } : {}),
    ref: h.curRef || (h.type === 'insert' ? h.afterRef : h.ref) || null, quote: hunkQuote(h), text,
  });
  const h1 = currentHunk(d, cid, key) || h0;
  try { return await d.addThread(cid, body(h1)); } catch (e) { if (e?.code !== 'NO_HUNK') throw e; }
  let fresh = null;
  try {
    const v = await d.crDetail(cid);
    if (v && Array.isArray(v.hunks)) { rememberHunks(d, cid, v.hunks); fresh = hunkByKey(v.hunks, key); }
  } catch { /* 아래 */ }
  if (fresh) { try { return await d.addThread(cid, body(fresh)); } catch (e) { if (e?.code !== 'NO_HUNK') throw e; } }
  return d.addThread(cid, body(fresh || h1, false));
}
/**
 * hid 로 덩어리에 의견(셸의 우클릭 '의견 달기'처럼 hid 만 들고 있을 때): 그 hid 가 옛 것이어도(작성자가 그새 저장)
 * 이 세션에서 본 덩어리 열쇠로 지금 hid 를 찾아 addHunkThread 로 보낸다. 덩어리를 모르면 자리(ref)·인용만 붙여 전체 의견으로.
 */
export async function addThreadByHid(d, cid, hid, text, { ref = null, quote = '' } = {}) {
  const cr = (d?.s?.crs || []).find((c) => c.cid === Number(cid));
  const hunks = Array.isArray(cr?.hunks) ? cr.hunks : [];
  const keys = rememberHunks(d, cid, hunks);
  const i = hid ? hunks.findIndex((h) => h.hid === hid) : -1;
  const key = i >= 0 ? keys[i] : hunkKeyFor(d, cid, hid);
  const h0 = i >= 0 ? hunks[i] : (key ? hunkByKey(hunks, key) : null);
  if (key && h0) return addHunkThread(d, cid, key, h0, text);
  return d.addThread(cid, { ...(ref ? { ref } : {}), ...(quote ? { quote } : {}), text });
}

// ───────── 의견 스레드 하나(첫 글 + 답글 + 완료) ─────────
const CrThread = {
  components: { MemoEditor, ThreadList },
  props: { cid: Number, t: Object, closed: Boolean, inHunk: Boolean },
  template: `<div class="cr-thread" :class="{resolved: !!t.resolved}" :data-tid="t.tid">
    <div class="ct-head"><span class="ct-by" :style="{color: color(first.by)}">{{ first.by }}</span><span class="muted">{{ fmtShort(first.at) }}</span>
      <span class="muted ct-quote" v-if="t.quote && !inHunk">「{{ clip(t.quote, 30) }}」</span>
      <span class="ref ct-ref" v-if="where && !inHunk" :class="{dim: !t.curRef}" :title="t.curRef ? '편집기에서 그 자리로' : '수정본을 시작한 버전의 자리(지금 문서에서는 찾지 못함)'" @click="go">{{ where }}</span></div>
    <div class="ct-text pre">{{ first.text }}</div>
    <ThreadList :replies="t.comments.slice(1)" :resolved="t.resolved" :max="4"/>
    <MemoEditor v-if="ui && !closed" v-model="ui.text" placeholder="답글" ok-label="답글 달기" :rows="2" :busy="!!ui.busy" :autofocus="!!ui.focus" @save="reply" @cancel="close"/>
    <div class="actions" v-else-if="!closed">
      <button class="small" @click="open"><span class="ic" v-html="ICON.memo"></span>답글</button>
      <button class="small" :class="{ ack: !t.resolved }" :disabled="busy" :title="t.resolved ? '이 의견을 다시 엽니다' : '다 본 의견으로 표시합니다(다시 열 수 있음)'" @click="resolve">{{ t.resolved ? '다시 열기' : '완료' }}</button></div></div>`,
  setup(props) {
    const d = inject('doc'); const busy = ref(false);
    uiSlots(d);
    // 답글 칸·쓰던 글은 문서 store 에(탭을 옮기거나 상세를 닫았다 열어도 남게)
    const key = () => `crt:${props.cid}:${props.t.tid}`;
    const ui = computed(() => d.s.cardUi?.[key()] || null);
    const first = computed(() => props.t.comments?.[0] || { by: '', at: '', text: '' });
    // 자리 표시: 지금 기준 문서 자리(서버 curRef)가 있으면 그것, 없으면 수정본 기준 버전의 자리(ref)
    const where = computed(() => props.t.curRef ?? props.t.ref ?? null);
    const go = () => { if (props.t.curRef) focusIn(d, { ref: props.t.curRef }); };
    const open = () => openSlot(d, key(), 'reply');
    const close = () => closeSlot(d, key());
    const reply = (text) => runSlot(d, key(), () => d.replyThread(props.cid, props.t.tid, text), { errPrefix: '답글 실패: ' });
    async function resolve() {
      if (busy.value) return;
      busy.value = true;
      try { await d.resolveThread(props.cid, props.t.tid, !props.t.resolved); } catch (e) { toastError(e); } finally { busy.value = false; }
    }
    return { ui, busy, first, where, go, open, close, reply, resolve, ICON, clip, fmtShort, color: (n) => colorOf(d, n) };
  },
};

// ───────── 충돌 목록(반영 409 MERGE_CONFLICT · 최신으로 맞춘 뒤 남은 충돌) — 원문·내 글·지금 글 ─────────
const CONFLICT_REASON = { TEXT: '충돌', GONE: '사라짐', PENDING_TRACKED: '변경 추적과 겹침' };
const ConflictList = {
  props: { list: Array },
  template: `<div class="cr-conflicts"><div class="cr-conflict" v-for="(c, i) in list" :key="(c.hid || '') + ':' + i" :data-hid="c.hid">
    <div class="ch-head"><span class="ref" @click="go(c.curRef || c.ref)">{{ c.curRef || c.ref }}</span><span class="pill bad">{{ CONFLICT_REASON[c.reason] || '충돌' }}</span></div>
    <div class="cc-row"><span class="cc-k" title="내가 고치기 시작할 때의 글">원문</span><span class="pre">{{ c.baseText }}</span></div>
    <div class="cc-row"><span class="cc-k">내 글</span><span class="pre">{{ c.newText }}</span></div>
    <div class="cc-row" v-if="c.currentText != null"><span class="cc-k" title="지금 공유 문서의 글">지금</span><span class="pre">{{ c.currentText }}</span></div>
    <div class="muted" v-if="c.message">{{ c.message }}</div></div></div>`,
  setup() { const d = inject('doc'); return { CONFLICT_REASON, go: (r) => { if (r) focusIn(d, { ref: r }); } }; },
};

// ───────── 목록 카드 ─────────
const CrCard = {
  props: { cr: Object },
  template: `<div class="card cr-card" :class="['st-' + cr.status, {mine}]" :data-cid="cr.cid" tabindex="0" role="button" @click="open" @keydown.enter.prevent="open" :style="{'--who': color}">
    <div class="head"><b>#{{ cr.cid }}</b><span class="cr-title">{{ title }}</span><span class="spacer"></span><span class="pill" :class="stCls">{{ CR_STATUS[cr.status] || cr.status }}</span></div>
    <div class="cr-meta"><span class="who"><i class="dot" :style="{background: color}"></i>{{ cr.author }}<span v-if="agent" class="muted" :title="cr.author + '의 AI 연결됨'"> ●</span></span>
      <span> · 문단 {{ n }}</span><span v-for="p in parts" :key="p"> · {{ p }}</span>
      <span v-if="cnt.stale && active" class="stale-n" title="승인 뒤 수정본이 바뀌어 다시 승인받아야 하는 승인"> · 다시 승인 필요 {{ cnt.stale }}</span>
      <span v-if="baseV != null" :title="'v' + baseV + '에서 고치기 시작함'"> · v{{ baseV }}에서 고침</span></div>
    <div class="muted cr-sub" v-if="cr.status==='merged'">{{ mergedText(cr) }} · {{ cr.mergedBy }} · {{ fmtShort(cr.mergedAt) }}</div>
    <div class="muted cr-sub" v-else-if="cr.status==='closed'">닫음 · {{ cr.closedBy }} · {{ fmtShort(cr.closedAt) }}</div>
    <div class="cr-sub behind" v-else-if="cr.behind && active" :title="'공유 문서에 새 버전이 있습니다 — 작성자가 [' + REBASE_LABEL + ']를 해야 반영할 수 있습니다'">{{ REBASE_LABEL }} 필요</div></div>`,
  setup(props) {
    const d = inject('doc');
    const mine = computed(() => isMeName(d, props.cr.author));
    const color = computed(() => colorOf(d, props.cr.author));
    const agent = computed(() => agentOf(d, props.cr.author));
    const title = computed(() => props.cr.title || '(제목 없음)');
    const n = computed(() => hunkCount(props.cr));
    const cnt = computed(() => crCounts(props.cr));
    const parts = computed(() => crCountParts(props.cr));
    const stCls = computed(() => CR_STATUS_CLS[props.cr.status] || '');
    const active = computed(() => ACTIVE.has(props.cr.status));
    const baseV = computed(() => baseVOf(props.cr));
    const open = () => { d.s.crOpen = props.cr.cid; d.s.crFocusHid = null; };
    return { mine, color, agent, title, n, cnt, parts, stCls, active, baseV, open, CR_STATUS, REBASE_LABEL, fmtShort, josa, mergedText };
  },
};

// ───────── 목록 ─────────
export const CrList = {
  components: { CrCard, Hint },
  template: `<div class="cr-list">
    <div class="sec-h">내 변경 요청<Hint text="편집기에서 글을 고치면 내 수정본으로 자동 저장됩니다. [검토 요청]으로 변경 요청을 열고, 승인받으면 공유 문서에 반영합니다"/><span class="spacer"></span>
      <button class="small primary cr-submit-open" v-if="myDraft" @click="d.s.submitOpen = myDraft.cid">검토 요청…</button></div>
    <CrCard v-for="c in groups.mine" :key="c.cid" :cr="c"/>
    <p class="muted" v-if="!groups.mine.length">아직 내 수정이 없습니다</p>
    <template v-if="groups.othersOpen.length"><div class="sec-h">검토 중 <span class="muted">{{ groups.othersOpen.length }}</span></div><CrCard v-for="c in groups.othersOpen" :key="c.cid" :cr="c"/></template>
    <template v-if="groups.othersDraft.length"><div class="sec-h">다른 사람이 수정 중 <span class="muted">{{ groups.othersDraft.length }}</span></div><CrCard v-for="c in groups.othersDraft" :key="c.cid" :cr="c"/></template>
    <details class="cr-done" v-if="groups.done.length"><summary class="sec-h">반영·닫힘 <span class="muted">{{ groups.done.length }}</span></summary><CrCard v-for="c in groups.done" :key="c.cid" :cr="c"/></details>
  </div>`,
  setup() {
    const d = inject('doc');
    const groups = computed(() => {
      const all = (d.s.crs || []).slice().sort((a, b) => b.cid - a.cid);
      const mine = all.filter((c) => ACTIVE.has(c.status) && isMeName(d, c.author));
      const rest = all.filter((c) => !mine.includes(c));
      return { mine, othersOpen: rest.filter((c) => c.status === 'open'), othersDraft: rest.filter((c) => c.status === 'draft'), done: rest.filter((c) => !ACTIVE.has(c.status)) };
    });
    const myDraft = computed(() => groups.value.mine.find((c) => c.status === 'draft' && hunkCount(c) > 0) || null);
    return { d, groups, myDraft };
  },
};

// ───────── 상세 ─────────
export const CrDetail = {
  components: { MemoEditor, CrThread, InlineConfirm, ConflictList },
  props: { cid: Number },
  template: `<div class="cr-detail" ref="root" :data-cid="cid">
    <div class="row cr-top"><button class="small" @click="back">← 목록</button><b>변경 요청 #{{ cid }}</b>
      <span class="pill" v-if="cr" :class="stCls">{{ CR_STATUS[cr.status] || cr.status }}</span><span class="spacer"></span>
      <span class="muted" v-if="loading"><span class="spin dark"></span></span></div>
    <p class="muted" v-if="!cr && !loading">{{ err || '변경 요청을 찾지 못했습니다(지워졌을 수 있음).' }}</p>
    <template v-if="cr">
      <div class="cr-head">
        <template v-if="!editSlot || !canEdit">
          <div class="cr-h-title"><span>{{ cr.title || '(제목 없음)' }}</span><button class="icon" v-if="canEdit" title="제목·설명 고치기" aria-label="제목·설명 고치기" @click="startEdit" v-html="ICON.edit"></button></div>
          <div class="pre cr-desc" v-if="cr.description">{{ cr.description }}</div></template>
        <div v-else class="cr-edit"><input v-model="editSlot.title" placeholder="제목" aria-label="제목"/><textarea v-model="editSlot.desc" rows="3" placeholder="설명(선택)" aria-label="설명"></textarea>
          <div class="row end"><button class="small" @click="cancelEdit">취소</button><button class="small primary" :disabled="!!editSlot.busy || !String(editSlot.title || '').trim()" @click="saveEdit">저장</button></div></div>
        <div class="cr-meta"><span class="who"><i class="dot" :style="{background: color}"></i>{{ cr.author }}</span><span> · 문단 {{ n }}</span>
          <span v-if="cr.status !== 'draft'" :title="cr.approvers?.length ? '승인: ' + cr.approvers.join(', ') : null"> · 승인 {{ cnt.approvals }}</span>
          <span v-if="cnt.stale && active" class="stale-n" title="승인 뒤 수정본이 바뀌어 다시 승인받아야 하는 승인"> · 다시 승인 필요 {{ cnt.stale }}</span>
          <span v-if="cnt.changes"> · 수정 요청 {{ cnt.changes }}</span>
          <span v-if="baseV != null" :title="'v' + baseV + '에서 고치기 시작함'"> · v{{ baseV }}에서 고침</span>
          <span class="muted"> · {{ fmtShort(cr.submittedAt || cr.createdAt) }}</span></div>
      </div>

      <div class="cr-box warn" v-if="active && cr.behind > 0" :title="(baseV != null ? 'v' + baseV + ' 이후 ' : '') + '공유 문서가 바뀌었습니다 — ' + REBASE_TIP">
        <b>새 버전 있음</b><span class="spacer"></span>
        <button v-if="author" class="small primary cr-rebase" :disabled="busy" :title="REBASE_TIP" @click="rebase">{{ REBASE_LABEL }}</button>
        <span v-else class="muted">작성자가 맞출 수 있습니다</span></div>
      <div class="cr-box cr-rebased" v-if="author && active && rebaseConflicts.length">
        <div class="row"><b title="최신으로 맞출 때 겹친 문단은 내 글을 남겼습니다. 편집기에서 확인하고 고친 뒤 반영하세요">겹친 곳 {{ rebaseConflicts.length }}문단 — 내 글을 남김</b><span class="spacer"></span>
          <button class="small" title="확인했으면 이 안내를 닫습니다" @click="d.s.draft.conflicts = []">확인</button></div>
        <ConflictList :list="rebaseConflicts"/></div>
      <details class="cr-box" v-if="cr.unsupported?.length"><summary title="표 행·열 구조·그림 같은 변경은 공유 문서에 들어가지 않습니다">반영 불가 {{ cr.unsupported.length }}건</summary>
        <div class="muted" v-for="(u, i) in cr.unsupported" :key="i"><span class="ref" @click="go(u.ref)">{{ u.ref }}</span> {{ UNSUPPORTED[u.what] || u.what }}{{ u.detail ? ' · ' + u.detail : '' }}</div></details>

      <div class="sec-h">바뀐 곳 {{ rows.length }}<span class="muted" v-if="!rows.length && n">(불러오는 중…)</span></div>
      <div class="cr-hunk" v-for="r in rows" :key="r.k" :data-hid="r.h.hid" :data-hkey="r.k" :class="{focus: focusKey===r.k, bad: !!badge(r.h) && badge(r.h).cls==='bad'}">
        <div class="ch-head"><span class="pill k">{{ hunkKind(r.h) }}</span><span class="ref" :class="{dim: !r.view.ref}" @click="go(r.view.ref)" :title="(baseV != null ? 'v' + baseV + '의 자리 ' : '원래 자리 ') + r.h.ref + (r.view.ref ? '' : ' — ' + r.view.why)">{{ r.view.ref || r.h.ref }}</span>
          <span class="pill" v-if="badge(r.h)" :class="badge(r.h).cls" :title="badge(r.h).title">{{ badge(r.h).label }}</span>
          <span class="muted" v-if="r.h.structure" title="표 행·열 구조 변경은 공유 문서에 들어가지 않습니다">표 구조 반영 안 됨</span><span class="spacer"></span>
          <span class="muted" v-if="r.threads.length">의견 {{ r.threads.length }}</span></div>
        <div class="difftext" v-html="hunkHtml(r.h)"></div>
        <div class="muted ch-cur" v-if="r.h.currentText != null && r.h.currentText !== r.h.baseText" title="그 사이 공유 문서에서 바뀐 이 문단의 지금 글">지금 문서 글: 「{{ clip(r.h.currentText, 120) }}」</div>
        <div class="muted" v-if="r.h.conflict?.message">{{ r.h.conflict.message }}</div>
        <div class="actions"><span class="btnwrap" :title="r.view.ref ? null : r.view.why"><button class="small cr-view" :disabled="!r.view.ref" :title="r.view.ref ? '편집기에서 그 자리로' : r.view.why" @click="go(r.view.ref)">편집기에서 보기</button></span>
          <button class="small" v-if="active && !slotOf(r.k)" @click="openComment(r.k)">의견</button></div>
        <MemoEditor v-if="active && slotOf(r.k)" :model-value="slotOf(r.k).text" @update:model-value="(v) => setText(r.k, v)" placeholder="이 변경에 대한 의견" ok-label="의견 달기" :rows="2"
          :busy="!!slotOf(r.k).busy" :autofocus="!!slotOf(r.k).focus" @save="(t) => comment(r, t)" @cancel="closeComment(r.k)"/>
        <CrThread v-for="t in r.threads" :key="t.tid" :cid="cid" :t="t" :closed="!active" in-hunk/>
      </div>

      <div class="sec-h">전체 의견 {{ general.length }}<span class="spacer"></span><button class="small" v-if="active && !slotOf('*')" @click="openComment('*')">의견 남기기</button></div>
      <MemoEditor v-if="active && slotOf('*')" :model-value="slotOf('*').text" @update:model-value="(v) => setText('*', v)" placeholder="변경 요청 전체에 대한 의견" ok-label="의견 달기" :rows="2"
        :busy="!!slotOf('*').busy" :autofocus="!!slotOf('*').focus" @save="(t) => comment(null, t)" @cancel="closeComment('*')"/>
      <CrThread v-for="t in general" :key="t.tid" :cid="cid" :t="t" :closed="!active"/>

      <template v-if="cr.reviews?.length"><div class="sec-h">검토 {{ cr.reviews.length }}</div>
        <div class="cr-review" v-for="(r, i) in cr.reviews" :key="i" :class="{stale: isStaleReview(r)}" :data-verdict="r.verdict">
          <span class="pill" :class="isStaleReview(r) ? 'stale' : VERDICT_CLS[r.verdict]" :title="isStaleReview(r) ? STALE_APPROVE_TIP : null">{{ verdictLabel(r) }}</span>
          <b :style="{color: colorFor(r.by)}">{{ r.by }}</b><span class="muted">{{ fmtShort(r.at) }}</span><div class="pre" v-if="r.body">{{ r.body }}</div></div></template>

      <div class="cr-box cr-reviewbox" v-if="active">
        <textarea v-model="reviewBody" rows="2" :placeholder="author ? '의견' : '검토 의견'" :title="author ? '작성자는 자기 변경 요청에 의견만 남길 수 있습니다' : '승인·수정 요청에는 의견이 없어도 됩니다. [의견만]은 의견을 적어야 합니다'" aria-label="검토 의견"></textarea>
        <div class="row"><span class="btnwrap" v-if="!author" :title="approveTip || null"><button class="small primary cr-approve" :disabled="busy || !!approveTip" :title="approveTip || null" @click="review('approve')">승인</button></span>
          <button class="small cr-changes" v-if="!author" :disabled="busy" @click="review('changes')">수정 요청</button>
          <button class="small cr-comment" :disabled="busy || !reviewBody.trim()" @click="review('comment')">의견만</button>
          <span class="muted" v-if="author" title="작성자는 자기 변경 요청을 승인·수정 요청할 수 없습니다">작성자는 의견만</span>
          <span class="muted cr-approve-note" v-else-if="approveTip">{{ approveTip }}</span></div></div>

      <div class="cr-box cr-mergebox" v-if="cr.status==='open' && (author || admin)">
        <div class="cr-blockers" v-if="cr.mergeBlockers?.length"><div v-for="(b, i) in cr.mergeBlockers" :key="i" class="blocker" :class="{hit: hitCode === b.code}" :data-code="b.code">⚠ {{ b.message }}</div></div>
        <div class="cr-mergeerr" v-if="mergeErr && (errLine || (mergeErr.conflicts || []).length)">
          <div class="err" v-if="errLine">{{ mergeErr.message }}</div>
          <ConflictList :list="mergeErr.conflicts || []"/>
          <div class="row" v-if="author && (mergeErr.conflicts || []).length"><button class="small primary cr-rebase" :disabled="busy" :title="REBASE_TIP" @click="rebase">{{ REBASE_LABEL }}</button></div></div>
        <div class="row"><span class="muted cr-mergeok" v-if="!cr.mergeBlockers?.length">반영할 수 있음</span><span class="spacer"></span>
          <button class="cr-merge" :class="{primary: cr.canMerge}" :disabled="busy" :title="'공유 문서에 변경 추적(작성자 ' + cr.author + ')으로 들어가고 새 버전이 됩니다'" @click="merge"><span v-if="merging" class="spin" :class="{dark: !cr.canMerge}"></span>반영</button></div></div>

      <InlineConfirm v-if="confirming" :message="confirming.msg" :ok-label="confirming.ok" danger :busy="busy" @ok="confirming.run()" @cancel="confirming=null"/>
      <div class="row cr-foot" v-else>
        <button class="small primary" v-if="author && cr.status==='draft'" :disabled="!n" @click="d.s.submitOpen = cid">검토 요청…</button>
        <button class="small" v-if="author && cr.status==='draft'" @click="askDiscard">수정 버리기</button>
        <button class="small" v-if="(author || admin) && cr.status==='open'" @click="askClose">닫기</button>
        <button class="small" v-if="(author || admin) && cr.status==='closed'" :disabled="busy" @click="reopen">다시 열기</button>
        <span class="spacer"></span><span class="muted cr-merged" v-if="cr.status==='merged'">{{ mergedText(cr) }}됨 · {{ cr.mergedBy }} · {{ fmt(cr.mergedAt) }}</span></div>
    </template></div>`,
  setup(props) {
    const d = inject('doc'); const root = ref(null);
    const view = ref(null); const loading = ref(false); const err = ref(''); const busy = ref(false); const merging = ref(false);
    const mergeErr = ref(null); const confirming = ref(null);
    const focusKey = ref(null);
    const summary = computed(() => (d.s.crs || []).find((c) => c.cid === props.cid) || null);
    const cr = computed(() => view.value || summary.value);
    const hunks = computed(() => cr.value?.hunks || []);
    const n = computed(() => hunkCount(cr.value));
    const active = computed(() => !!cr.value && ACTIVE.has(cr.value.status));
    const author = computed(() => !!cr.value && cr.value.author === meName(d));
    const admin = computed(() => isAdmin());
    const canEdit = computed(() => !!cr.value && (author.value || admin.value) && cr.value.status !== 'merged');
    const color = computed(() => colorOf(d, cr.value?.author));
    const stCls = computed(() => CR_STATUS_CLS[cr.value?.status] || '');
    const cnt = computed(() => crCounts(cr.value));
    const baseV = computed(() => baseVOf(cr.value));
    // 초안에는 승인할 수 없다(서버도 막는다) — 남에게는 [승인]을 막고 까닭을 보인다
    const approveTip = computed(() => (cr.value?.status === 'draft' ? DRAFT_APPROVE_TIP : ''));
    // 덩어리는 열쇠(종류 + 기준 자리)로 잡는다 — 작성자가 자동 저장해 hid 가 바뀌어도 의견 칸·강조·스레드가 그 덩어리에 남게.
    // view = '편집기에서 보기' 자리(진행 중 = curRef, 반영됨 = 그 문단이 지금 기준에 있을 때 — hunkViewRef)
    const tb = computed(() => threadsByHunk(d, { cid: props.cid, hunks: hunks.value, threads: cr.value?.threads || [] }));
    const rows = computed(() => hunks.value.map((h, i) => ({ h, k: tb.value.keys[i], threads: tb.value.byKey.get(tb.value.keys[i]) || [], view: hunkViewRef(cr.value, h, d.s.paragraphs) })));
    const general = computed(() => tb.value.general);
    // 반영 실패 설명이 막힘 이유 목록에 이미 있으면(같은 까닭) 한 번만 — 실패 줄은 숨기고 그 막힘 줄을 잠깐 짚는다
    const errLine = computed(() => !!mergeErr.value && !blockerFor(mergeErr.value.code, cr.value?.mergeBlockers));
    // 반영 실패 뒤 서버가 다시 '반영할 수 있음'(canMerge)이라 하면(다시 승인 등으로 막힘이 풀림) 지난 실패 줄은 지운다 —
    // '반영할 수 있습니다'와 지난 실패 글('승인이 1개 필요합니다(지금 0개)')이 같이 보이지 않게. 막힌 동안(canMerge false)은 그대로 둔다
    watch(() => !!cr.value?.canMerge, (can) => { if (can) mergeErr.value = null; });
    const hitCode = ref(null); let hitTimer = null;
    function pointBlocker(code) {
      const b = blockerFor(code, cr.value?.mergeBlockers);
      if (!b) return;
      clearTimeout(hitTimer); hitCode.value = b;
      hitTimer = setTimeout(() => { if (hitCode.value === b) hitCode.value = null; }, 2400);
    }
    onBeforeUnmount(() => clearTimeout(hitTimer));
    // 입력 칸(덩어리 의견·전체 의견·제목 고치기·검토 글)과 쓰던 글은 문서 store 에 — 탭을 옮기거나 목록에 다녀와도 남게
    uiSlots(d);
    const sk = (k) => `crc:${props.cid}:${k}`;
    const slotOf = (k) => d.s.cardUi?.[sk(k)] || null;
    const setText = (k, v) => { const sl = slotOf(k); if (sl) sl.text = v; };
    const openComment = (k) => openSlot(d, sk(k), 'comment');
    const closeComment = (k) => closeSlot(d, sk(k));
    const hk = () => `crh:${props.cid}`;
    const editSlot = computed(() => d.s.cardUi?.[hk()] || null);
    const rk = () => `crr:${props.cid}`;
    const reviewBody = computed({
      get: () => d.s.cardUi?.[rk()]?.text ?? '',
      set: (v) => { const m = uiSlots(d); if (!m[rk()]) m[rk()] = { mode: 'review', text: '', busy: false, focus: false }; m[rk()].text = v; },
    });
    // store.rebaseMine 이 남긴 '최신 반영' 충돌(내 글을 남긴 문단) — 내 변경 요청일 때만
    const rebaseConflicts = computed(() => (author.value && d.s.myCr?.cid === props.cid ? (d.s.draft?.conflicts || []) : []));

    let seq = 0;
    async function load() {
      const my = ++seq; loading.value = true;
      try {
        const v = await d.crDetail(props.cid);
        if (my === seq) { view.value = v || null; err.value = ''; }
      } catch (e) { if (my === seq) { err.value = e.status === 404 ? '변경 요청이 없습니다(지워졌을 수 있음).' : e.message; if (e.status === 404) view.value = null; } }
      finally { if (my === seq) loading.value = false; }
    }
    /** 동작이 돌려준 CRView(덩어리 포함)면 바로 쓰고, 아니면 다시 읽기 */
    const take = (v) => { if (v && v.cid === props.cid && Array.isArray(v.hunks)) view.value = v; else load(); };
    // 목록(WS 'cr' 로 store 가 다시 읽음)의 이 변경 요청이 바뀌면 상세도 다시 읽는다
    const sig = (c) => (c ? [c.updatedAt, c.status, c.hunkCount, c.approvals, c.staleApprovals, c.changesRequested, c.behind, c.currentVersion, (c.threads || []).length, (c.reviews || []).length,
      (c.threads || []).reduce((k, t) => k + (t.comments?.length || 0) + (t.resolved ? 1000 : 0), 0)].join('|') : 'none');
    // 보던 변경 요청이 목록에서 빠졌으면(수정본을 버려 지워짐) 다시 읽지 않고 알린다 — 다시 나타나면(목록 다시 읽기) 그때 읽는다
    watch(() => sig(summary.value), (v, old) => {
      if (v === 'none' && old && old !== 'none') { view.value = null; err.value = '변경 요청이 지워졌습니다(수정본을 버림).'; return; }
      load();
    }, { immediate: true });

    // 레일·우클릭에서 '변경 보기'로 온 덩어리(hid — 옛 것이면 이 세션에서 본 열쇠로): 보이게 하고 잠깐 강조
    function showFocus() {
      const hid = d.s.crFocusHid; if (!hid) return;
      const alias = hunkKeyFor(d, props.cid, hid);
      const row = rows.value.find((r) => r.h.hid === hid) || (alias ? rows.value.find((r) => r.k === alias) : null);
      if (!row) return;   // 덩어리를 아직 못 읽음 — 읽으면 다시
      const k = row.k; focusKey.value = k;
      nextTick(() => {
        const el = root.value?.querySelector(`.cr-hunk[data-hkey="${CSS.escape(k)}"]`);
        if (el) { el.scrollIntoView({ block: 'nearest' }); d.s.crFocusHid = null; setTimeout(() => { if (focusKey.value === k) focusKey.value = null; }, 2200); }
      });
    }
    watch([() => d.s.crFocusHid, () => rows.value.map((r) => r.h.hid).join(',')], showFocus, { immediate: true });

    const go = (r) => { if (r) focusIn(d, { ref: r }); };
    const back = () => { d.s.crOpen = null; d.s.crFocusHid = null; };
    /** store 동작 하나: → { ok, v }(동작이 값을 돌려주지 않아도 ok). 이미 하는 중이면 무시(두 번 누르기) */
    const run = async (fn, okMsg) => {
      if (busy.value) return { ok: false, busy: true };
      busy.value = true;
      try { const v = await fn(); if (okMsg) toast(okMsg); return { ok: true, v }; } catch (e) { toastError(e); return { ok: false }; } finally { busy.value = false; }
    };
    function startEdit() { openSlot(d, hk(), 'edit', { title: cr.value.title || '', desc: cr.value.description || '' }); }
    const cancelEdit = () => closeSlot(d, hk());
    async function saveEdit() {
      const sl = editSlot.value; if (!sl || sl.busy || !String(sl.title || '').trim()) return;
      const r = await runSlot(d, hk(), () => d.patchCr(props.cid, { title: String(sl.title).trim(), description: sl.desc ?? '' }));
      if (r.ok) { toast('제목·설명을 고쳤습니다'); take(r.v); }
    }
    /** 의견: 덩어리(r = { h, k })면 보내기 직전에 그 덩어리의 지금 hid 로(addHunkThread), 아니면 변경 요청 전체에 */
    async function comment(r, text) {
      const k = r ? r.k : '*';
      const res = await runSlot(d, sk(k), () => (r ? addHunkThread(d, props.cid, r.k, r.h, text) : d.addThread(props.cid, { text })));
      if (res.ok) { toast('의견을 달았습니다'); take(res.v); }
    }
    const REVIEW_DONE = { approve: '승인했습니다', changes: '수정을 요청했습니다', comment: '의견을 남겼습니다' };
    async function review(verdict) {
      if (verdict === 'approve' && approveTip.value) { toast(approveTip.value); return; }
      const r = await run(() => d.reviewCr(props.cid, verdict, reviewBody.value.trim()), REVIEW_DONE[verdict] || '검토를 남겼습니다');
      if (r.ok) { closeSlot(d, rk()); take(r.v); }
    }
    async function merge() {
      if (busy.value) return;
      merging.value = true; mergeErr.value = null; busy.value = true;
      try {
        const r = await d.mergeCr(props.cid);   // 반영 알림은 store 가 띄운다
        take(r?.cr);
      } catch (e) {
        // 막힘 이유 목록이 이미 그 까닭을 보이면 실패 줄은 숨긴다(errLine) — 다시 읽은 목록에 없으면 그때 실패 줄로
        if (e.code === 'MERGE_CONFLICT') mergeErr.value = { code: e.code, message: e.message || '충돌이 있어 반영하지 못했습니다', conflicts: e.data?.conflicts || [] };
        else if (e.code === 'NEED_APPROVAL') mergeErr.value = { code: e.code, message: e.message || '다른 사람의 승인이 필요합니다', conflicts: [] };
        else if (!blockerFor(e.code, cr.value?.mergeBlockers)) toastError(e, '반영 실패: ');
        pointBlocker(e.code);
        await load();
        pointBlocker(e.code);
      } finally { merging.value = false; busy.value = false; }
    }
    // 최신 반영 결과(충돌 수) 알림은 store 가 띄운다
    async function rebase() {
      const r = await run(() => d.rebaseMine());
      if (!r.ok) return;
      mergeErr.value = null;
      take(r.v?.cr);
    }
    function askDiscard() {
      confirming.value = { msg: '내 수정본을 버릴까요? 편집기는 공유 문서로 돌아갑니다.', ok: '버리기', run: async () => { const r = await run(() => d.discardMine({ confirmFirst: false })); confirming.value = null; if (r.ok) back(); } };
    }
    function askClose() {
      confirming.value = { msg: `${josa(`변경 요청 #${props.cid}`, '을/를')} 닫을까요? (다시 열 수 있습니다)`, ok: '닫기', run: async () => { const r = await run(() => d.closeCr(props.cid), '변경 요청을 닫았습니다'); confirming.value = null; if (r.ok) take(r.v); } };
    }
    async function reopen() { const r = await run(() => d.reopenCr(props.cid), '다시 열었습니다(초안)'); if (r.ok) take(r.v); }
    return {
      d, root, cr, hunks, rows, n, cnt, baseV, mergedText, active, author, admin, canEdit, color, stCls, loading, err, busy, merging, reviewBody, mergeErr, errLine, hitCode, approveTip, confirming, rebaseConflicts,
      editSlot, focusKey, general, slotOf, setText, openComment, closeComment, go, back, startEdit, cancelEdit, saveEdit, comment, review, merge, rebase, askDiscard, askClose, reopen,
      hunkHtml, badge: hunkBadge, hunkKind, clip, fmt, fmtShort, josa, ICON, CR_STATUS, VERDICT, VERDICT_CLS, UNSUPPORTED, isStaleReview, verdictLabel, colorFor: (nm) => colorOf(d, nm),
      REBASE_LABEL, REBASE_TIP, STALE_APPROVE_TIP,
    };
  },
};

// ───────── 검토 요청 창 ─────────
export const CrSubmitDialog = {
  components: { FloatWin },
  props: { cid: Number },
  emits: ['close'],
  template: `<FloatWin :anchor="null" :width="440" title="검토 요청" cls="cr-submit" :data-office-unsent="unsent" @close="$emit('close')">
    <template v-if="cr">
      <div class="muted" title="변경 요청을 열어 다른 사람에게 검토를 받습니다. 저장 안 된 수정은 먼저 저장합니다">변경 요청 #{{ cr.cid }} · 문단 {{ n }}<span v-if="baseV(cr) != null"> · v{{ baseV(cr) }}에서 고침</span></div>
      <label class="fld">제목 <span class="err" v-if="tried && !String(title || '').trim()">— 제목을 적어 주세요</span>
        <input ref="titleEl" v-model="title" class="cr-submit-title" placeholder="무엇을 고쳤나요?" maxlength="200" @keydown.enter.prevent="submit" aria-label="제목"/></label>
      <label class="fld">설명<textarea v-model="desc" rows="4" class="cr-submit-desc" placeholder="고친 이유·검토할 점(선택)" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" aria-label="설명"></textarea></label>
      <div class="row end"><span class="muted kbd">Ctrl+Enter</span><button class="small" @click="$emit('close')">취소</button>
        <button class="small primary cr-submit-go" :disabled="busy" @click="submit"><span v-if="busy" class="spin"></span>검토 요청</button></div>
    </template>
    <template v-else>
      <p class="muted">{{ loading ? '내 수정본을 확인하는 중…' : '아직 내 수정본이 없습니다 — 편집기에서 글을 고치세요' }}</p>
      <div class="row end"><button class="small" @click="$emit('close')">닫기</button></div></template>
  </FloatWin>`,
  setup(props, { emit }) {
    const d = inject('doc'); const titleEl = ref(null);
    const busy = ref(false); const tried = ref(false); const loading = ref(true); const full = ref(null);
    // 적던 제목·설명은 문서 store(d.s.submitForm)에 — 창을 그리는 자리(레일·탭)가 바뀌어 창이 다시 그려져도 남게.
    // 창을 열 때(submitOpen 값이 바뀔 때) 한 번 만들고, 닫거나 보내면 CollabHost 가 지운다
    if (!d.s.submitForm || d.s.submitForm.open !== d.s.submitOpen) d.s.submitForm = { open: d.s.submitOpen, title: '', desc: '', titled: false };
    const form = () => d.s.submitForm || { title: '', desc: '', titled: false };
    const title = computed({ get: () => form().title ?? '', set: (v) => { if (d.s.submitForm) d.s.submitForm.title = v; } });
    const desc = computed({ get: () => form().desc ?? '', set: (v) => { if (d.s.submitForm) d.s.submitForm.desc = v; } });
    const cid = computed(() => props.cid ?? d.s.myCr?.cid ?? null);
    const cr = computed(() => {
      if (full.value && full.value.cid === cid.value) return full.value;
      return (d.s.crs || []).find((c) => c.cid === cid.value) || (d.s.myCr?.cid === cid.value ? d.s.myCr : null);
    });
    const n = computed(() => hunkCount(cr.value));
    const draftDirty = computed(() => !!(d.s.draft?.dirty || d.s.draft?.saving));
    const unsent = computed(() => desc.value.trim() !== String(cr.value?.description || '').trim()
      || !!title.value.trim() && title.value.trim() !== (cr.value?.title || (cr.value ? defaultTitle(cr.value) : '')));
    function fillDefault() {
      const f = d.s.submitForm;
      if (!f || f.titled || !cr.value) return;
      const t = cr.value.title || defaultTitle(cr.value);
      if (!cr.value.hunks?.length && !cr.value.title) return;   // 덩어리가 아직 없으면 상세를 읽은 뒤
      f.title = t; f.desc = cr.value.description || ''; f.titled = true;
      nextTick(() => { titleEl.value?.focus(); titleEl.value?.select(); });
    }
    onMounted(async () => {
      try {
        if (draftDirty.value && typeof d.saveDraftNow === 'function') await d.saveDraftNow();
        if (cid.value == null && typeof d.refreshCrs === 'function') await d.refreshCrs();
        if (cid.value != null) full.value = await d.crDetail(cid.value);
      } catch (e) { if (e?.status !== 404) toastError(e); }
      finally { loading.value = false; fillDefault(); }
    });
    watch(cr, fillDefault);
    async function submit() {
      tried.value = true;
      if (!cr.value || !String(title.value || '').trim() || busy.value) return;
      busy.value = true;
      try {
        if (draftDirty.value && typeof d.saveDraftNow === 'function') await d.saveDraftNow();
        const id = cr.value.cid;
        await d.submitCr(id, { title: String(title.value).trim(), description: desc.value });
        toast(`${josa(`변경 요청 #${id}`, '을/를')} 검토 요청했습니다`);
        d.s.crOpen = id; d.s.tab = 'cr';
        emit('close');
      } catch (e) { toastError(e, '검토 요청 실패: '); }
      finally { busy.value = false; }
    }
    return { titleEl, title, desc, busy, tried, loading, cr, n, draftDirty, unsent, submit, baseV: baseVOf };
  },
};

// ───────── 떠 있는 창 자리(검토 요청 창) — 레일·패널 탭 어디에 끼워도 문서마다 하나만 그린다 ─────────
// 레일(priority 0)이 있으면 레일이, 없으면(좁은 창) 지금 탭이 그린다 — 패널의 모든 탭에 하나씩 둔다(AI 작업·첨부로 옮겨도 창이 남게).
// 그리는 자리가 바뀌면 창은 다시 그려지지만 적던 글은 d.s.submitForm 에 남는다.
const hosts = reactive([]); let hostSeq = 0;
export const CollabHost = {
  components: { CrSubmitDialog },
  props: { priority: { type: Number, default: 1 } },
  template: `<Teleport :to="overlay"><CrSubmitDialog v-if="isHost && open" :key="'s' + (cid ?? 'mine')" :cid="cid ?? undefined" @close="close"/></Teleport>`,
  setup(props) {
    const d = inject('doc'); const id = ++hostSeq;
    const overlay = inject('officeDocument', null)?.overlay || 'body';
    // hosts 는 반응형 배열이라 넣은 store 를 꺼내면 프록시가 된다 — 문서 id 로 견준다
    onMounted(() => { hosts.push({ id, doc: String(d.id ?? ''), pri: props.priority }); });
    onBeforeUnmount(() => { const i = hosts.findIndex((h) => h.id === id); if (i >= 0) hosts.splice(i, 1); });
    // 같은 문서의 자리 중 priority 가 가장 작은 것(같으면 먼저 붙은 것)
    const isHost = computed(() => {
      let best = null;
      for (const h of hosts) if (h.doc === String(d.id ?? '') && (!best || h.pri < best.pri)) best = h;
      return !!best && best.id === id;
    });
    const open = computed(() => !!d.s.submitOpen);
    const cid = computed(() => (typeof d.s.submitOpen === 'number' ? d.s.submitOpen : null));
    const close = () => { d.s.submitOpen = false; d.s.submitForm = null; };
    // 다른 곳(셸)이 창을 닫았으면 적던 글도 지운다(다음에 열면 새로)
    watch(() => d.s.submitOpen, (v) => { if (!v && d.s.submitForm) d.s.submitForm = null; });
    return { isHost, open, cid, close, overlay };
  },
};

// ───────── 패널 '변경 요청' 탭 ─────────
export const CrTab = {
  components: { CrList, CrDetail, CollabHost },
  template: `<div class="tab-cr"><CrDetail v-if="d.s.crOpen != null" :cid="d.s.crOpen" :key="d.s.crOpen"/><CrList v-else/><CollabHost/></div>`,
  setup() {
    const d = inject('doc');
    if (d.s.crOpen === undefined) d.s.crOpen = null;
    // 셸(상단 '변경 요청 #3 · 검토 중' 칩·접속자 창)은 d.s.activeCid 로 상세를 연다 — 받아서 비운다(같은 것을 또 눌러도 다시 열리게)
    const take = () => { const c = d.s.activeCid; if (c != null && c !== '') { d.s.crOpen = Number(c); d.s.crFocusHid = null; d.s.activeCid = null; } };
    take(); watch(() => d.s.activeCid, take);
    return { d };
  },
};
export const ChangeRequestTab = CrTab;
export const CrsTab = CrTab;
