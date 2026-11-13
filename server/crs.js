// 수정본(draft)·변경 요청(CR, change request) — docs/V3_SPEC.md §3.1–§3.5·§3.7.
// 한 사람이 한 문서에 가진 자기 버전(수정본, data/docs/<id>/drafts/c<cid>.hwpx)을 검토 단위(변경 요청)로 다룬다.
//  - 수정본 저장(PUT)은 버전을 만들지 않는다: 기준 버전(baseVersion) 최종본과 비교한 덩어리(hunks)만 meta 에 둔다.
//  - 기준 문서를 바꾸는 길은 반영(merge) 하나 — 서비스 _tx 한 번 = 버전 하나, 변경 추적 작성자 = 변경 요청 작성자.
//  - 덩어리 ref 는 기준 버전 기준으로 저장하고, 보여 줄 때·반영할 때 planBody 정렬(engine/diff.js)로 지금 기준 문서 ref(curRef)로 옮긴다.
// meta 를 고치는 일은 모두 문서 큐(store.withDoc — 서비스 _tx 와 같은 큐) 안에서 한다.
import { HwpxDoc, EngineError, diffDocs, realSectionHunks } from '../engine/doc.js';
import { planBody, merge3, charOps } from '../engine/diff.js';
import { ServiceError } from './service.js';
import * as MT from './memotext.js';
import { josa } from './josa.js';

const ACTIVE = new Set(['draft', 'open']);
// 원형 없는 객체: 보낸 verdict 가 'constructor'·'toString'·'__proto__' 여도 판단 이름으로 보지 않는다(BAD_VERDICT — 쓰레기 검토·500 막음)
const VERDICTS = Object.assign(Object.create(null), { approve: '승인', changes: '수정 요청', comment: '의견' });
const STATUS_KO = { draft: '수정 중', open: '검토 중', merged: '반영된', closed: '닫힌' };
const REF_RE = /^s(\d+)\/p(\d+)((?:\/n\d+)*)$/;
const LIMITS = { title: 200, description: 10000, comment: 5000, quote: 500, reviews: 300, threads: 300, comments: 300 };   // 글자 수·개수(meta.json 이 끝없이 커지지 않게)

const nowIso = () => new Date().toISOString();
const cpLen = (s) => { let n = 0; for (const _ of String(s ?? '')) n++; return n; };
const isNested = (ref) => /\/n\d+/.test(String(ref || ''));
const secOf = (ref) => { const m = /^s(\d+)\//.exec(String(ref || '')); return m ? Number(m[1]) : null; };
// '홍길동(Claude)' → '홍길동'(사람 단위로 승인을 센다)
const personOf = (name) => String(name ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();
// 작성자 본인이거나 작성자의 에이전트('홍길동(Claude)')
const isOwnerName = (owner, by) => !!owner && (by === owner || String(by || '').startsWith(`${owner}(`));
const posInt = (v) => (/^[1-9]\d{0,8}$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : null);
// 사람이 쓴 글(제목·설명·검토·의견): XML 에 못 넣는 제어 문자는 빼고(MT.xmlSafe — 메모로 문서에 들어갈 수 있다) max 자(UTF-16)로 자른다.
// 자른 끝이 대리 쌍 반쪽이면 그 반쪽도 뺀다
const cut = (s, max) => { const t = s.slice(0, max); return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t; };
const cleanLine = (s, max) => cut(MT.xmlSafe(s).replace(/\s+/g, ' ').trim(), max);
const cleanText = (s, max) => cut(MT.xmlSafe(s), max);

/** 덩어리 수 → stats { changed, inserted, deleted, cells, chars }(chars = 지우고 넣은 글자 수) */
export function hunkStats(hunks) {
  const s = { changed: 0, inserted: 0, deleted: 0, cells: 0, chars: 0 };
  for (const h of hunks || []) {
    if (h.type === 'insert') { s.inserted++; s.chars += cpLen(h.newText); continue; }
    if (h.type === 'delete') { s.deleted++; s.chars += cpLen(h.baseText); continue; }
    if (h.cell || isNested(h.ref)) s.cells++; else s.changed++;
    if (h.type === 'object') continue;   // 그림 속성·조판 부호 — 글자 수 없음(글은 따로 replace 덩어리)
    for (const op of charOps(h.baseText, h.newText)) s.chars += (op.end - op.start) + cpLen(op.text);
  }
  return s;
}

// 검토한 사람: 에이전트 검토(r.agent — MCP review_change_request 가 남김, by = '사용자(에이전트)')는 그 사용자, 아니면 by 의 사람 이름
const reviewerOf = (r) => {
  const by = String(r.by ?? '');
  if (!r.agent) return personOf(by);
  const suf = `(${r.agent})`;
  return personOf(by.endsWith(suf) ? by.slice(0, -suf.length) : by);
};

/**
 * 검토 집계(작성자 본인과 그 에이전트 것은 뺀다, 의견만은 세지 않음):
 *  - 승인 = 사람이 직접 남긴 마지막 판단(승인·수정 요청)이 승인인 사람 수. 에이전트 검토는 승인 수를 바꾸지 않는다
 *    (에이전트는 승인할 수 없으므로 그 사람의 승인을 거두지도 못한다).
 *    승인한 뒤 수정본(덩어리)이 바뀌면 그 승인은 '승인 뒤 바뀜'(r.stale — _staleApprovals)이라 세지 않는다(staleApprovals 로 따로 셈) —
 *    승인은 승인한 그 내용에만 붙는다. 다시 승인하면 센다.
 *  - 수정 요청 = 사람의 마지막 판단이 수정 요청인 사람 수 + 에이전트(사용자(에이전트)마다 따로)의 수정 요청 —
 *    에이전트의 수정 요청은 그 사용자가 나중에 직접 판단(승인·수정 요청)하면 그 판단에 묻힌다.
 */
export function reviewCounts(cr) {
  const author = personOf(cr.author);
  const human = new Map();   // 사람 → { verdict, stale, i }(사람이 직접 남긴 마지막 승인·수정 요청)
  const asks = new Map();    // 에이전트 검토자(by 그대로) → { person, i }(마지막 수정 요청)
  (cr.reviews || []).forEach((r, i) => {
    if (r.verdict !== 'approve' && r.verdict !== 'changes') return;
    const p = reviewerOf(r); if (!p || p === author) return;
    if (!r.agent) human.set(p, { verdict: r.verdict, stale: r.verdict === 'approve' && !!r.stale, i });
    else if (r.verdict === 'changes') asks.set(String(r.by), { person: p, i });
  });
  const approvers = [...human].filter(([, v]) => v.verdict === 'approve' && !v.stale).map(([p]) => p);
  const staleApprovers = [...human].filter(([, v]) => v.verdict === 'approve' && v.stale).map(([p]) => p);
  const changesRequested = [...human.values()].filter((v) => v.verdict === 'changes').length
    + [...asks.values()].filter((a) => !((human.get(a.person)?.i ?? -1) > a.i)).length;
  return { approvals: approvers.length, approvers, changesRequested, staleApprovals: staleApprovers.length, staleApprovers };
}

/** NEED_APPROVAL 글: 필요한 승인 수·지금 승인 수(+ 승인 뒤 수정본이 바뀌어 다시 받아야 하는 승인) */
const needApprovalText = (required, counts) => `다른 사람 승인이 ${required}개 필요합니다(지금 ${counts.approvals}개`
  + `${counts.staleApprovals ? ` — 승인 뒤 수정본이 바뀌어 다시 승인받아야 하는 것 ${counts.staleApprovals}개` : ''})`;

/** 지금 문서의 변경 추적을 문단 ref 별로 */
function changesByRef(doc) {
  const m = new Map();
  for (const c of doc.changes()) { if (!m.has(c.ref)) m.set(c.ref, []); m.get(c.ref).push(c); }
  return m;
}

/**
 * 고칠 범위(charOps — 지금 글 기준 코드포인트)가 처리 안 된 변경 추적과 겹치는가(엔진 OVERLAP 미리 보기, V3 §4.3).
 * 지우기·바꾸기: 삽입 변경 글과 겹치거나 범위 안쪽에 삭제 자리가 있으면 겹침. 넣기: 삽입 변경 글 한가운데에 넣으면 겹침(표식이 포개진다).
 */
function overlapsPending(changes, ops) {
  if (!changes?.length) return false;
  for (const op of ops) {
    for (const c of changes) {
      // 개체만의 변경(표·그림 넣음/지움 — kind 'object')은 글 범위가 없다: 엔진이 개체에 붙은 표식을 글 편집에서 넘기므로 겹침이 아니다.
      // 문단 나눔 변경(kind 'para' — 2026-10-30)도 같다: 묶음 안 글 편집은 나눔 표식을 넘긴다(그것을 넘는 고침을 PENDING_TRACKED 로 막지 않게)
      if (c.kind === 'object' || c.kind === 'para') continue;
      if (c.spansParagraph) return true;
      if (op.start === op.end) { if (c.type === 'Insert' && c.end != null && c.start < op.start && op.start < c.end) return true; continue; }
      if (c.type === 'Insert' && c.end != null && op.start < c.end && c.start < op.end) return true;
      if (c.type === 'Delete' && op.start < c.start && c.start < op.end) return true;
    }
  }
  return false;
}

/** ref 의 본문 번호를 fn 으로 옮긴다(그 구역일 때만) */
function shiftRef(ref, sec, fn) {
  const m = /^s(\d+)\/p(\d+)(.*)$/.exec(String(ref || ''));
  if (!m || Number(m[1]) !== sec) return ref;
  return `s${sec}/p${fn(Number(m[2]))}${m[3]}`;
}

/** 문서 순서 비교 열쇠: [구역, 본문, 중첩 경로…] */
function refKey(ref) {
  const m = REF_RE.exec(String(ref || '')); if (!m) return [Infinity];
  return [Number(m[1]), Number(m[2]), ...(m[3] ? m[3].split('/n').slice(1).map(Number) : [])];
}
function cmpRef(a, b) {
  const x = refKey(a); const y = refKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] == null) return -1; if (y[i] == null) return 1; if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}

/** 중첩 깊이: s0/p2 → 0, s0/p2/n3 → 1, s0/p2/n3/n0 → 2 */
const nestDepth = (ref) => (String(ref ?? '').match(/\/n\d+/g) || []).length;

/**
 * 메모를 달거나 메모 글 줄 수가 바뀌면 그 문단의 중첩 문단(표 칸·각주·머리말 …) 번호 n 이 밀린다 — 메모 본문 줄도 그 문단의 중첩 문단이라서.
 * list 안 중첩 ref 들(r.ref)을 '본문 문단 + 그 문단의 중첩 순번(bodyEntries — 메모 본문 제외, 문서 순서)'으로 적어 두고,
 * restore() 를 부르면 그때 문서 기준 ref 로 r.ref 를 고친다(메모 쓰기는 그 순번을 바꾸지 않는다). 중첩 ref 가 없으면 아무것도 안 한다.
 */
function nestedKeeper(doc, list) {
  const items = list.filter((r) => nestDepth(r.ref) > 0);
  if (!items.length) return { restore() {} };
  const be0 = doc.bodyEntries();
  const keys = items.map((r) => {
    const m = /^s(\d+)\/p(\d+)\//.exec(r.ref);
    const k = m ? (be0[Number(m[1])]?.[Number(m[2])]?.nested || []).findIndex((x) => x.ref === r.ref) : -1;
    return k < 0 ? null : { s: Number(m[1]), i: Number(m[2]), k };
  });
  return {
    restore() {
      const be = doc.bodyEntries();
      items.forEach((r, x) => { const key = keys[x]; const ref = key ? be[key.s]?.[key.i]?.nested?.[key.k]?.ref : null; if (ref) r.ref = ref; });
    },
  };
}

const conflictOut = (h, p) => ({
  hid: h.hid, type: h.type, ref: h.ref, curRef: p.curRef ?? null, baseText: h.baseText, newText: h.newText,
  currentText: p.currentText ?? null, reason: p.reason, message: p.message,
});

// ───────── 덩어리 자리·의견 스레드 ─────────
// hid 는 새 글까지 넣어 셈한다(engine diffDocs) — 작성자가 같은 문단을 또 고치면 hid 가 바뀐다. 내용과 무관한 hid(자리만의 해시)로 바꾸지 않은
// 까닭: 웹 editor.js draftSig 가 hid 목록 변화로 다른 창의 저장을 알아채고, 저장 WS 'draft' 알림도 hid 목록으로 바뀜을 본다. 또 같은 자리에
// 문단을 하나 더 넣었을 때 hid 가 그대로인 덩어리는 그 hid 로 정확히 다시 잇는다(자리 차례만 보면 앞에 넣은 새 문단에 붙어 버림).
// 기준 버전이 바뀌면(다시 맞추기) ref 자체가 옮겨 가므로 자리 열쇠로 다시 잇는 일(_rethread)은 어느 쪽이든 필요하다.

/** 덩어리 자리(의견 스레드 ref 와 같은 규칙): 바꿈·지움 = ref, 문단 추가 = afterRef(문서 맨 앞이면 보여 줄 자리 ref) — 수정본 기준 버전의 ref */
const hunkPos = (h) => (h.type === 'insert' ? (h.afterRef ?? h.ref ?? null) : (h.ref ?? null));

/**
 * 덩어리 자리 열쇠 — web/crs.js hunkKeys 와 같은 규칙: '종류:기준 자리'(바꿈·지움 = ref, 추가 = afterRef, 문서 맨 앞 '^')
 * + 같은 열쇠가 또 나오면 '#차례'. at(h) 로 자리를 바꿔 셀 수 있다(옛 기준 → 새 기준으로 옮긴 자리). 자리가 null 이면 열쇠도 null.
 */
function hunkKeys(hunks, at = (h) => (h.type === 'insert' ? (h.afterRef ?? '^') : (h.ref ?? null))) {
  const seen = new Map();
  return (hunks || []).map((h) => {
    const a = at(h); if (a == null) return null;
    const k = `${h.type || 'replace'}:${a}`; const n = seen.get(k) || 0; seen.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  });
}

/**
 * 옛 기준(수정본 기준 버전)의 자리를 새 기준으로 옮기는 함수들(map = _refMap 옛 → 새, moved = 기준이 바뀜):
 *  moveRef(ref) — 문단 ref(없어졌으면 null; moved 인데 map 이 없으면 null),
 *  moveAt(h)    — 덩어리 자리 열쇠용(hunkKeys 의 at): 문단 추가의 앞 문단이 새 기준에 없으면 앞쪽 가장 가까운 짝 문단(_rebuild 가 넣는 자리)
 */
function hunkMovers(map, moved) {
  const moveRef = (r) => (r == null ? null : !moved ? r : map ? map.ref(r) ?? null : null);
  const moveAt = (h) => {
    if (h.type !== 'insert') return moveRef(h.ref ?? null);
    if (h.afterRef == null) return '^';
    if (!moved) return h.afterRef;
    if (!map) return null;
    const r = map.ref(h.afterRef); if (r) return r;
    const at = map.insertAfter(h.afterRef, secOf(h.afterRef) ?? 0);
    return !at ? null : at.after >= 0 ? `s${at.sec}/p${at.after}` : at.sec === 0 ? '^' : null;
  };
  return { moveRef, moveAt };
}

/**
 * 두 덩어리 목록이 '같은 바뀜'인가(승인을 그대로 둘지, _staleApprovals): 개수가 같고 차례마다 종류·자리·새 글이 같다(hid 와 같은 열쇠 —
 * 기준 글은 보지 않는다: 반영되는 글은 새 글이다). 같은 기준이면 hid 목록이 같으면 된다. 기준이 바뀌었으면(moved) 옛 자리를 map 으로
 * 옮긴 자리 열쇠로 비교한다 — 다시 맞추기·새 기준 저장으로 번호만 밀린 같은 고침은 같은 바뀜. map 이 없으면(옛 버전을 못 읽음) 다른 바뀜.
 */
function sameChange(oldHunks, newHunks, { map = null, moved = false } = {}) {
  const old = oldHunks || []; const neu = newHunks || [];
  if (old.length !== neu.length) return false;
  if (!moved) return old.every((h, i) => h.hid === neu[i].hid);
  if (!map) return false;
  const ok = hunkKeys(old, hunkMovers(map, moved).moveAt); const nk = hunkKeys(neu);
  return old.every((h, i) => ok[i] != null && ok[i] === nk[i] && h.newText === neu[i].newText && h.newFormatFingerprint === neu[i].newFormatFingerprint);
}

// ───────── 제안 '내 수정본에 반영' 기록 — 사람마다 ─────────
// p.adoptedBy = { [이름]: { at, cid } }: 같은 제안을 여러 사람이 각자 자기 수정본에 반영할 수 있다(사람마다 하나 — 남이 반영해도 내 기록은 남는다).
// p.adopted = { by, at, cid } 는 예전 모양 그대로 둔다(웹·옛 자료가 읽음 — 남아 있는 사람 중 하나, 새로 반영하면 그 사람).
// 두 필드는 아래 두 함수로만 고친다.

/** 사람별 기록(새 객체). 옛 자료(p.adopted 하나뿐)도 읽는다 */
function adoptionsOf(p) {
  const m = Object.create(null);
  if (p.adoptedBy && typeof p.adoptedBy === 'object' && !Array.isArray(p.adoptedBy)) {
    for (const [k, v] of Object.entries(p.adoptedBy)) if (v && typeof v === 'object') m[k] = { ...v, at: v.at ?? null, cid: v.cid ?? null };
  }
  if (p.adopted?.by && !m[p.adopted.by]) m[p.adopted.by] = { at: p.adopted.at ?? null, cid: p.adopted.cid ?? null };
  return m;
}

/** 사람별 기록을 써 넣는다. 비면 둘 다 지운다. p.adopted = prefer(있으면) → 지금 p.adopted 의 사람(남아 있으면) → 가장 최근에 반영한 사람 */
function writeAdoptions(p, m, prefer = null) {
  const names = Object.keys(m);
  if (!names.length) { delete p.adoptedBy; delete p.adopted; return; }
  p.adoptedBy = m;
  const pick = prefer && m[prefer] ? prefer : p.adopted?.by && m[p.adopted.by] ? p.adopted.by
    : names.reduce((a, b) => (String(m[b].at ?? '') > String(m[a].at ?? '') ? b : a));
  p.adopted = { ...m[pick], by: pick };
}

/** ?rev= 값(수정본 판): 없으면 null(판 확인 안 함 — 예전 클라이언트·도구), 0 이상 정수가 아니면 400 BAD_REV */
function revArg(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{1,9}$/.test(s)) throw new ServiceError('BAD_REV', `수정본 판(rev)이 올바르지 않습니다: ${MT.clip(s, 20)}`);
  return Number(s);
}

/**
 * 한글로 저장(§3.7): 덩어리 메모가 없는 문단에 단 의견(덩어리가 없어진 스레드 — 작성자가 그 문단을 되돌림 등, 문단에 단 전체 의견) 메모:
 *   [변경 요청 #3 · 수정 중] 홍길동 — 제목
 *   이 문단에 단 의견(수정본은 지금 이 문단을 고치지 않음)
 *   의견: 김검토: 예산 근거는? (답 1)
 */
function renderCrNoteMemo(cr, threads) {
  const head = `[변경 요청 #${cr.cid} · ${STATUS_KO[cr.status] || '수정 중'}] ${cr.author}${cr.title ? ` — ${cleanLine(cr.title, LIMITS.title)}` : ''}`;
  const parts = threads.map((t) => MT.crThreadSummary(t)).filter(Boolean);
  return MT.xmlSafe([head, '이 문단에 단 의견(수정본은 지금 이 문단을 고치지 않음)', `의견: ${parts.join(' · ')}`].join('\n'));
}

export class ChangeRequests {
  /**
   * @param {{ service, store?, hub?, config?, registry? }} o
   *   registry: 개인 에이전트 등록부(AgentRegistry — push(user, event, data)). 없으면 service.agents 를 찾아본다(없어도 됨).
   */
  constructor({ service, store, hub, config, registry = null }) {
    this.service = service; this.store = store || service.store; this.hub = hub || service.hub; this.cfg = config || service.cfg || {};
    this.registry = registry;
    // 버전 파일은 바뀌지 않으므로 그대로 둔다(LRU). 문서 통째(그림 등 포함)는 수정본 비교용으로 몇 개만,
    // 정렬 지도에 쓰는 문단 항목(bodyEntries — 글·종류·구조)은 가벼우니 더 많이
    this._docCache = new Map();     // `${id}:${n}` → HwpxDoc
    this._entryCache = new Map();   // `${id}:${n}` → bodyEntries()
  }

  get requireApprovals() { const n = Number(this.cfg.changeRequests?.requireApprovals); return Number.isInteger(n) && n >= 0 ? n : 1; }

  // ───────── 공통 ─────────

  _meta(id) { return this.service._meta(id); }

  /** 옛 자료에도 필드가 있게 */
  _norm(cr) {
    if (cr.title == null) cr.title = '';
    if (cr.description == null) cr.description = '';
    for (const k of ['hunks', 'reviews', 'threads', 'adopted', 'log', 'unsupported']) if (!Array.isArray(cr[k])) cr[k] = [];
    if (!cr.stats) cr.stats = hunkStats(cr.hunks);
    if (!Number.isInteger(cr.rev) || cr.rev < 0) cr.rev = 0;
    return cr;
  }

  // ───────── 수정본 판(rev) — 같은 사람의 두 창(기기)이 서로 덮어쓰지 않게 ─────────
  // 사람마다 문서마다 늘기만 하는 수 하나(meta.draftRevs[이름] = { rev, at }; 없으면 0). 수정본을 바꾸는 일 — 저장(PUT)·버리기·
  // 다시 맞추기·반영·닫기·다시 열기 — 마다 +1 하고, 진행 중인 변경 요청에는 그 값(cr.rev)을 적는다(진행 중인 것의 cr.rev = 지금 판).
  // 0 으로 되돌리지 않는다: 버린 뒤 새로 만든 수정본이 옛 창의 판 번호와 우연히 같아지지 않게(ABA).
  // PUT ?rev= 를 주면 지금 판과 같아야 저장한다(다르면 409 DRAFT_STALE { rev, updatedAt }), 안 주면 예전처럼 확인 없음.

  _revInfo(meta, name) {
    const r = meta.draftRevs && typeof meta.draftRevs === 'object' ? meta.draftRevs[name] : null;
    return { rev: Number.isInteger(r?.rev) && r.rev > 0 ? r.rev : 0, at: r?.at ?? null };
  }

  _rev(meta, name) { return this._revInfo(meta, name).rev; }

  /** name 의 수정본 판 +1 → 새 판(호출자가 meta 를 저장한다) */
  _bumpRev(meta, name, at = nowIso()) {
    if (!meta.draftRevs || typeof meta.draftRevs !== 'object' || Array.isArray(meta.draftRevs)) meta.draftRevs = {};
    const rev = this._rev(meta, name) + 1;
    meta.draftRevs[name] = { rev, at };
    return rev;
  }

  /** PUT ?rev= 확인: want 가 있고 지금 판과 다르면 409 DRAFT_STALE { rev, updatedAt } */
  _checkRev(meta, name, want, cr) {
    if (want == null) return;
    const { rev, at } = this._revInfo(meta, name);
    if (want === rev) return;
    throw new ServiceError('DRAFT_STALE', `내 수정본이 다른 창(또는 기기)에서 바뀌었습니다(이 창이 읽은 판 ${want}, 지금 판 ${rev}) — 덮어쓰지 않았습니다. 수정본을 다시 여세요`, 409,
      { rev, updatedAt: at ?? cr?.updatedAt ?? null });
  }

  _get(meta, cid) {
    const cr = meta.changeRequests.find((c) => c.cid === Number(cid));
    if (!cr) throw new ServiceError('NO_CR', `변경 요청이 없습니다: #${cid}`, 404);
    return this._norm(cr);
  }

  /** 이 사람의 진행 중(draft·open) 변경 요청 — 사람당 문서당 하나 */
  _mine(meta, name) {
    const cr = meta.changeRequests.find((c) => ACTIVE.has(c.status) && c.author === name);
    return cr ? this._norm(cr) : null;
  }

  static _lru(map, key, value, max) {
    map.delete(key); map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
    return value;
  }

  /** 버전 문서(고치지 않는다 — 읽기 전용으로만 쓸 것) */
  async _versionDoc(id, n) {
    const key = `${id}:${n}`;
    const hit = this._docCache.get(key);
    if (hit) return ChangeRequests._lru(this._docCache, key, hit, 3);
    const bytes = this.store.versionBytes(id, n);
    // 기록 번호(내부 판 n)는 사람에게 '버전'으로 부르지 않는다(§9.1) — 파일 이름으로만 알린다
    if (!bytes) throw new ServiceError('NO_VERSION', `수정본 기준 문서의 기록 파일이 없습니다(versions/${n}.hwpx)`, 404);
    return ChangeRequests._lru(this._docCache, key, await HwpxDoc.load(bytes), 3);
  }

  /** 기준 버전 문서: 지금 버전이면 손에 든 지금 문서(cur), 아니면 버전 파일 */
  async _baseDoc(id, n, meta, cur) { return n === meta.version && cur ? cur : this._versionDoc(id, n); }

  /** 버전 n 의 본문 문단 항목(bodyEntries) */
  async _versionEntries(id, n) {
    const key = `${id}:${n}`;
    const hit = this._entryCache.get(key);
    if (hit) return ChangeRequests._lru(this._entryCache, key, hit, 32);
    return ChangeRequests._lru(this._entryCache, key, (await this._versionDoc(id, n)).bodyEntries(), 32);
  }

  /** 기준 버전 n 의 문단 항목: 지금 버전이면 지금 문서 항목(ce) 그대로 — 같은 객체면 _refMap 이 그대로 옮긴다 */
  async _entriesFor(meta, n, ce) { return n === meta.version ? ce : this._versionEntries(meta.id, n); }

  /**
   * 기준 버전 → 지금 문서 ref 지도(V3 §3.4-1): 구역마다 planBody(글 + 종류 + 구조) 짝.
   * be·ce = 기준·지금 문서의 bodyEntries(같은 객체면 그대로 옮김).
   * 중첩 ref(표 칸 등)는 그 본문 문단의 중첩 구조(sig 목록)가 같을 때만 같은 자리로 옮긴다(다르면 null = 사라짐).
   */
  _refMap(be, ce) {
    const same = be === ce;
    const secMaps = new Map();
    const bodyIdx = (s, i) => {
      if (!be[s]?.[i]) return null;
      if (same) return i;
      if (!secMaps.has(s)) secMaps.set(s, be[s] && ce[s] ? new Map(planBody(be[s], ce[s]).pairs) : null);
      const m = secMaps.get(s); const j = m ? m.get(i) : undefined;
      return j == null ? null : j;
    };
    const ref = (r) => {
      const m = REF_RE.exec(String(r ?? '')); if (!m) return null;
      const s = Number(m[1]); const i = Number(m[2]); const j = bodyIdx(s, i); if (j == null) return null;
      if (!m[3]) return `s${s}/p${j}`;
      const bn = be[s][i].nested || []; const cn = ce[s]?.[j]?.nested || [];
      if (bn.length !== cn.length || bn.some((x, k) => x.sig !== cn[k].sig)) return null;
      const k = bn.findIndex((x) => x.ref === r);
      return k < 0 ? null : cn[k].ref;
    };
    /**
     * 문단을 넣을 자리 { sec, after }(after = 지금 본문 번호, -1 = 구역 맨 앞 → 엔진은 첫 문단 뒤에 넣는다).
     * afterRef 짝이 없으면 같은 구역에서 앞쪽으로 가장 가까운 짝 문단 뒤, 그것도 없으면 구역 맨 앞.
     */
    const insertAfter = (afterRef, sec0 = 0) => {
      if (afterRef == null) return ce[sec0] ? { sec: sec0, after: -1, exact: true } : null;
      const m = /^s(\d+)\/p(\d+)/.exec(String(afterRef)); if (!m) return null;
      const s = Number(m[1]); if (!ce[s]) return null;
      let i = Number(m[2]);
      const j = bodyIdx(s, i); if (j != null) return { sec: s, after: j, exact: true };
      for (i -= 1; i >= 0; i--) { const k = bodyIdx(s, i); if (k != null) return { sec: s, after: k, exact: false }; }
      return { sec: s, after: -1, exact: false };
    };
    return { ref, bodyIdx, insertAfter };
  }

  /**
   * 덩어리 하나를 지금 기준 문서(cur)에 놓아 본다(V3 §3.4-2) — 문서는 바꾸지 않는다.
   * → { curRef, state: 'ok'|'conflict'|'gone', currentText, kind: 'edit'|'insert'|'skip'|'conflict', target?, sec?, after?, reason?, message? }
   *   state: 지금 그 문단이 기준 글 그대로(ok)/바뀜(conflict)/없음(gone). kind: 반영할 때 할 일.
   *   바뀌었으면 merge3(기준 글, 내 글, 지금 글)이 겹치지 않을 때 합친 글(target), 겹치면 conflict 'TEXT'.
   *   pending(문단별 변경 추적)을 주면 고칠 범위가 처리 안 된 변경 추적과 겹칠 때 conflict 'PENDING_TRACKED'.
   */
  _place(h, map, cur, pending) {
    // 넣을 글(내 글)은 XML 에 못 넣는 제어 문자를 뺀 것 — 편집기 내보내기에 섞여 들어온 U+0001 등이 기준 문서 XML 을 깨지 않게.
    // 반영·다시 맞추기는 이 함수가 돌려준 글(target·text)만 쓴다
    const mine = MT.xmlSafe(h.newText);
    if (h.type === 'insert') {
      const at = map ? map.insertAfter(h.afterRef ?? null, secOf(h.ref) ?? 0) : null;
      if (!at) return { curRef: null, state: 'gone', currentText: null, kind: 'conflict', reason: 'GONE', message: '문단을 넣을 자리를 지금 문서에서 찾지 못했습니다' };
      return { curRef: `s${at.sec}/p${Math.max(0, at.after)}`, state: 'ok', currentText: null, kind: 'insert', sec: at.sec, after: at.after, text: mine };
    }
    const curRef = map ? map.ref(h.ref) : null;
    let currentText = null;
    if (curRef) { try { currentText = cur.text(curRef, 'final'); } catch { currentText = null; } }
    if (currentText == null) {
      if (h.type === 'delete') return { curRef: null, state: 'gone', currentText: null, kind: 'skip', reason: 'GONE', message: '이미 없어진 문단입니다' };
      return { curRef: null, state: 'gone', currentText: null, kind: 'conflict', reason: 'GONE', message: '그 문단이 지금 문서에 없습니다(문단·표 구조가 바뀜)' };
    }
    if (h.type === 'object') {
      // 그림 속성·조판 부호(글은 보지 않는다): 지금 = 내 것이면 할 일 없음, 지금이 기준과 다르면(그새 남이 같은 문단의 그림·부호를 바꿈) 충돌
      // [hwpx-cowork] 지문 판(objectPrintVersion)대로 견준다 — 단 정의 부호를 넣기 전에 만든 변경 요청은 종전 판으로(거짓 충돌 없음, h2022-format)
      const same = (stored) => { try { return cur.matchesObjectPrint(curRef, stored, h.objectPrintVersion); } catch { return false; } };
      const at = { curRef, state: same(h.baseObjectPrint) ? 'ok' : 'conflict', currentText };
      if (same(h.newObjectPrint)) return { ...at, kind: 'skip', reason: 'SAME', message: '이미 같은 그림·조판 부호입니다' };
      if (h.baseObjectPrint != null && !same(h.baseObjectPrint)) return { ...at, kind: 'conflict', reason: 'OBJECT', message: '같은 문단의 그림·조판 부호를 다른 사람도 바꿨습니다' };
      return { ...at, kind: 'edit', target: currentText, object: true };
    }
    if (h.type === 'delete' && h.objects && currentText === '') {
      // 지운 그림·표 문단(글 없음): 그 문단에 그림·표가 아직 있으면 지울 것(반영 = 그림·표째 지움), 이미 없으면 할 일 없음
      let pics = 0; try { const oi = cur._objectInfo(curRef); pics = oi.pics.length + oi.tables.length; } catch { pics = 0; }
      if (!pics) return { curRef, state: 'ok', currentText, kind: 'skip', reason: 'SAME', message: '그림·표가 이미 없습니다' };
      return { curRef, state: 'ok', currentText, kind: 'edit', target: '', removePictures: true };
    }
    const state = currentText === h.baseText ? 'ok' : 'conflict';
    const base = { curRef, state, currentText };
    if (h.type === 'format' || h.formatting) {
      const fingerprint = cur.formattingFingerprint(curRef);
      if (currentText === mine && fingerprint === h.newFormatFingerprint) return { ...base, kind: 'skip', reason: 'SAME' };
      if (currentText !== h.baseText || (h.baseFormatFingerprint && fingerprint !== h.baseFormatFingerprint)) {
        return { ...base, kind: 'conflict', reason: 'FORMAT', message: '같은 문단의 글 또는 서식이 변경되었습니다. 최신 수정본에서 다시 확인하세요.' };
      }
      // 개체만의 변경(표·그림 넣음/지움 — kind 'object')은 글자 모양과 겹치지 않는다(개체째 정해진다) — 그것만 있으면 서식 반영을 막지 않는다
      // 문단 나눔 변경(kind 'para')도 글자 모양과 겹치지 않는다
      if (pending?.get(curRef)?.some((c) => c.kind !== 'object' && c.kind !== 'para')) return { ...base, kind: 'conflict', reason: 'PENDING_TRACKED', message: '이 문단의 변경 추적을 먼저 처리하세요.' };
      return { ...base, kind: 'edit', target: mine, formatting: true };
    }
    if (currentText === mine) return { ...base, kind: 'skip', reason: 'SAME', message: '이미 같은 글입니다' };
    let target = mine;
    if (state === 'conflict') {
      const m = merge3(h.baseText, mine, currentText);
      if (!m.ok) return { ...base, kind: 'conflict', reason: 'TEXT', message: '같은 자리를 다른 사람도 고쳤습니다', ranges: m.conflicts };
      target = m.text;
      if (target === currentText) return { ...base, kind: 'skip', reason: 'SAME', message: '이미 반영된 글입니다' };
    }
    if (pending && overlapsPending(pending.get(curRef), charOps(currentText, target))) {
      return { ...base, kind: 'conflict', reason: 'PENDING_TRACKED', message: '그 문단에 아직 처리하지 않은 변경 추적이 있습니다. 먼저 변경 추적을 수락/거절하세요', target };
    }
    return { ...base, kind: 'edit', target };
  }

  /**
   * 반영 막힘 이유 [{ code, message }](user 가 없으면 권한은 보지 않음). 실시간 문서(V4 §5)는 승인을 요구하지 않고(수정 권한이면 반영)
   * 수정 중(draft)인 것도 바로 반영할 수 있다 — NEED_APPROVAL·NOT_SUBMITTED 는 승인 방식 문서에서만
   */
  _blockers(cr, user, counts, placed, meta = null) {
    const out = [];
    const realtime = !!meta && this.service.isRealtime(meta);
    if (user) {
      const admin = user.role === 'admin'; const author = user.name === cr.author;
      if (!admin && !author) out.push({ code: 'FORBIDDEN', message: '반영은 관리자 또는 작성자만 할 수 있습니다' });
      else if (meta && !this.service.canEdit(user, meta)) out.push({ code: 'FORBIDDEN', message: '이 문서의 수정 권한이 없습니다(문서 설정)' });
      else if (!admin && !realtime && counts.approvals < this.requireApprovals) out.push({ code: 'NEED_APPROVAL', message: needApprovalText(this.requireApprovals, counts) });
    }
    if (cr.status === 'draft' && !realtime) out.push({ code: 'NOT_SUBMITTED', message: '먼저 검토 요청(제출)을 하세요' });
    else if (!ACTIVE.has(cr.status) || (!realtime && cr.status !== 'open')) out.push({ code: 'STATE', message: `이미 ${STATUS_KO[cr.status] || cr.status} 변경 요청입니다` });
    if (!cr.hunks.length) out.push({ code: 'NO_CHANGES', message: '반영할 변경이 없습니다' });
    const bad = placed.filter((x) => x.p.kind === 'conflict');
    const pend = bad.filter((x) => x.p.reason === 'PENDING_TRACKED').length;
    if (bad.length - pend) out.push({ code: 'CONFLICT', message: `충돌 ${bad.length - pend}건 — 최신 반영(다시 맞추기) 뒤 반영하세요` });
    if (pend) out.push({ code: 'PENDING_TRACKED', message: `처리 안 된 변경 추적과 겹치는 덩어리 ${pend}건 — 먼저 변경 추적을 수락/거절하세요` });
    return out;
  }

  /**
   * CRView(V3 §3.3) = 저장 모양 + { behind, approvals, approvers, changesRequested, canMerge, mergeBlockers, hunkCount, currentVersion }.
   * withHunks 면 hunks 마다 지금 기준 문서 기준 curRef·state(+ 바뀐 경우 currentText, 반영 미리 보기 conflict), 아니면 hunks 를 빼고 개수만.
   */
  _viewOf(meta, cr, user, { map, cur, pending, withHunks }) {
    const active = ACTIVE.has(cr.status);
    const placed = cr.hunks.map((h) => ({ h, p: active ? this._place(h, map, cur, pending) : { curRef: null, state: null, kind: 'skip' } }));
    const counts = reviewCounts(cr);
    const blockers = this._blockers(cr, user, counts, placed, meta);
    const v = structuredClone(cr);
    // 사람용 버전(§9.4): baseV = 수정본 기준 기록(baseVersion) 이하의 마지막 이정표 v(없으면 1), mergedV = 반영으로 생긴 버전
    // (저장된 cr.mergedV — 옛 자료는 반영 기록 n 의 이정표에서 찾는다)
    const svc = this.service;
    const mergedV = cr.mergedV ?? (cr.status === 'merged' && cr.mergedVersion != null ? (meta.milestones || []).find((x) => x.n === cr.mergedVersion)?.v ?? null : null);
    Object.assign(v, {
      behind: Math.max(0, meta.version - cr.baseVersion), currentVersion: meta.version,
      baseV: svc._milestoneAt(meta, cr.baseVersion)?.v ?? 1, mergedV,
      approvals: counts.approvals, approvers: counts.approvers, changesRequested: counts.changesRequested, staleApprovals: counts.staleApprovals,
      canMerge: !blockers.length, mergeBlockers: blockers, hunkCount: cr.hunks.length,
    });
    if (withHunks) {
      v.hunks = placed.map(({ h, p }) => {
        const o = { ...structuredClone(h), curRef: p.curRef ?? null, state: p.state ?? null, conflict: p.kind === 'conflict' ? { reason: p.reason, message: p.message } : null };
        if (p.state === 'conflict' && p.currentText != null) o.currentText = p.currentText;
        return o;
      });
    } else delete v.hunks;
    // 스레드마다 지금 기준 문서 자리(curRef): 덩어리 스레드는 그 덩어리의 curRef, 문단에 단 의견(hid 없음)은 ref(수정본 기준 버전)를 옮긴 자리.
    // 진행 중이 아니면(반영·닫힘) null
    const curOfHid = new Map(placed.map(({ h, p }) => [h.hid, p.curRef ?? null]));
    v.threads = (v.threads || []).map((t) => ({
      ...t, curRef: t.hid && curOfHid.has(t.hid) ? curOfHid.get(t.hid) : (active && map && t.ref ? map.ref(t.ref) ?? null : null),
    }));
    return v;
  }

  /** 여러 변경 요청의 CRView — 같은 기준 버전끼리 정렬 지도를 함께 쓴다 */
  async _views(meta, list, user, { withHunks = true, cur = null } = {}) {
    if (!list.length) return [];
    cur = cur || await this.store.doc(meta.id);
    if (!cur) throw new ServiceError('NO_DOC', `문서가 없습니다: ${meta.id}`, 404);
    const maps = new Map(); let pending = null; let ce = null;
    const out = [];
    for (const cr of list) {
      let map = null;
      if (ACTIVE.has(cr.status)) {
        // 실시간 '고친 글만' 문서는 반영이 겹치는 처리 안 된 변경 추적을 먼저 수락하므로(merge) PENDING_TRACKED 로 막지 않는다
        if (!ce) { ce = cur.bodyEntries(); pending = this.service._liveFinal(meta) ? null : changesByRef(cur); }
        if (!maps.has(cr.baseVersion)) {
          let be = null;
          try { be = await this._entriesFor(meta, cr.baseVersion, ce); } catch (e) { if (!(e instanceof ServiceError)) throw e; }
          maps.set(cr.baseVersion, be ? this._refMap(be, ce) : null);
        }
        map = maps.get(cr.baseVersion);
      }
      out.push(this._viewOf(meta, cr, user, { map, cur, pending, withHunks }));
    }
    return out;
  }

  /**
   * diffDocs. 구역 수가 바뀐 수정본(구역 합치기·나누기 — docs/SECTIONS.md)은 덩어리 주소를 구역별로 되돌린다(변경 요청은 글·서식만 반영).
   * { flat: true } 면 이은 문서 주소 그대로(sections·flatBase·flatHead 포함 — 실시간 밀어 넣기가 구역 파일까지 맞춘다)
   */
  async _diff(baseDoc, headDoc, { flat = false, anchorFirst = false, yieldEvery = 0 } = {}) {
    try { const r = await diffDocs(baseDoc, headDoc, { anchorFirst, yieldEvery }); return flat ? r : realSectionHunks(r); } catch (e) {
      if (e instanceof EngineError) throw new ServiceError(e.code, `수정본을 비교하지 못했습니다: ${e.message}`, 400);
      throw e;
    }
  }

  /**
   * [hwpx-cowork] 문단 나눔 옮기기(2026-10-30 — service._migrateBreakView, DESIGN §1.8): 지운 나눔으로 이어진 연속 문단을 새 엔진이 최종 문단
   * 하나로 읽게 된 문서의 진행 중 변경 요청(반영·닫힘 아닌 것) 덩어리를 다시 읽은 기준 버전으로 다시 센다(덩어리 ref = 기준 버전의 최종 번호) —
   * 의견 스레드는 _rethread 로 다시 잇는다. 기준 기록·수정본 파일을 못 읽으면 그 변경 요청은 그대로. 문서 큐 안(meta 는 호출자가 저장) → 다시 센 수
   */
  async _rediffBreakView(id, meta) {
    let n = 0;
    for (const cr of meta.changeRequests || []) {
      if (cr.status === 'merged' || cr.status === 'closed') continue;
      try {
        const bytes = this.store.readDraft(id, cr.cid); if (!bytes) continue;
        const base = await this._versionDoc(id, cr.baseVersion);
        const { hunks, unsupported } = await this._diff(base, await HwpxDoc.load(bytes));
        if (cr.threads?.length) this._rethread(cr, cr.hunks, hunks);
        Object.assign(cr, { hunks, unsupported, stats: hunkStats(hunks) });
        n++;
      } catch { /* 그 변경 요청은 그대로 */ }
    }
    return n;
  }

  _copyFormatting(target, source, sourceRef, targetRef) {
    const text = source.text(sourceRef, 'final');
    const finalText = target.text(targetRef, 'final');
    // Editor uploads can contain XML control characters. Match the same
    // sanitization used by text merge, projecting formats onto the clean text.
    if (text !== finalText && MT.xmlSafe(text) === finalText) this.service._engine(() => source.mergeParagraphText(sourceRef, finalText, { author: '서식 가져오기' }));
    return this.service._engine(() => target.copyFormattingFrom(source, sourceRef, targetRef));
  }

  async _copyFormattingBatch(target, source, pairs) {
    for (const { sourceRef, targetRef } of pairs) {
      const text = source.text(sourceRef, 'final'); const finalText = target.text(targetRef, 'final');
      if (text !== finalText && MT.xmlSafe(text) === finalText) this.service._engine(() => source.mergeParagraphText(sourceRef, finalText, { author: '서식 가져오기' }));
    }
    try { return await target.copyFormattingBatch(source, pairs); }
    catch (error) { return this.service._engine(() => { throw error; }); }
  }

  _ws(id, action, cr, by, extra = {}) {
    this.hub.broadcast(id, { type: 'cr', action, cid: cr.cid, author: cr.author, by, status: cr.status, ...extra });
  }

  /** 지금 기준 문서 ref 목록(WS refs) */
  _curRefs(view) { return [...new Set((view?.hunks || []).map((h) => h.curRef).filter(Boolean))].sort(cmpRef); }

  _registry() {
    for (const r of [this.registry, this.registry?.registry, this.service.agents, this.service.agents?.registry]) if (r && typeof r.push === 'function') return r;
    return null;
  }

  /** 작성자에게 남이 한 일(검토·의견·반영·닫기)을 그 사람 에이전트에 알린다(§2.1 cr_event). 등록부가 없으면 조용히 건너뛴다 */
  _push(docId, docTitle, cr, action, by) {
    if (isOwnerName(cr.author, by)) return;
    const reg = this._registry(); if (!reg) return;
    try { reg.push(cr.author, 'cr_event', { docId, docTitle, cid: cr.cid, action, by }); } catch (e) { console.error(`[crs] cr_event 알림 실패: ${e.message}`); }
  }

  _newCr(meta, name, baseVersion, at) {
    meta.seq.cr = (Number(meta.seq.cr) || 0) + 1;
    const cr = {
      cid: meta.seq.cr, author: name, title: '', description: '', status: 'draft', baseVersion, createdAt: at, updatedAt: at,
      stats: hunkStats([]), hunks: [], unsupported: [], reviews: [], threads: [], adopted: [], log: [{ at, by: name, action: 'create', detail: '수정 시작' }],
    };
    meta.changeRequests.push(cr);
    // 변경 요청이 생기기 전에 '내 수정본에 반영'해 둔 제안을 묶는다(편집기 반영 → 자동 저장 사이) — 이 사람의 기록만
    for (const p of meta.proposals) {
      if (p.status !== 'pending' || (!p.adopted && !p.adoptedBy)) continue;
      const m = adoptionsOf(p);
      if (m[name] && m[name].cid == null) { m[name].cid = cr.cid; writeAdoptions(p, m); cr.adopted.push(p.pid); }
    }
    this.store.log(meta, name, 'cr.create', `#${cr.cid}`);
    return cr;
  }

  /**
   * 반영해 둔 제안의 묶음을 푼다(수정본을 버리거나 닫음·반영) — 이 변경 요청 작성자의 기록만(같은 제안을 반영해 둔 남의 기록은 그대로).
   * → 반영 기록이 풀린 제안이 딸린 AI 작업 번호(Set) — 그 요청은 다시 센다(§9.2: 반영 → 남음으로 바뀔 수 있다)
   */
  _releaseAdopted(meta, cr) {
    const rids = new Set();
    for (const pid of cr.adopted) {
      const p = meta.proposals.find((x) => x.pid === pid);
      if (p && this._unadopt(p, cr) && p.rid != null) rids.add(p.rid);
    }
    return rids;
  }

  /** 제안 p 에서 cr 작성자의 반영 기록을 지운다(이 변경 요청에 묶였거나 아직 묶이지 않은 것만) → 지웠으면 true */
  _unadopt(p, cr) {
    if (!p.adopted && !p.adoptedBy) return false;
    const m = adoptionsOf(p); const e = m[cr.author];
    if (!e || (e.cid != null && e.cid !== cr.cid)) return false;
    delete m[cr.author];
    writeAdoptions(p, m);
    return true;
  }

  /** '내 수정본에 반영'할 수 있는 제안인지(§3.3): 대기 중(아니면 409 STATE)·표·그림 아님(400 BAD_TYPE) */
  _checkAdoptable(p) {
    if (p.status !== 'pending') throw new ServiceError('STATE', `대기 중인 제안만 수정본에 반영할 수 있습니다(지금: ${p.status})`, 409);
    if (p.type === 'table' || p.type === 'figure' || p.type === 'table_edit' || p.type === 'toc' || p.type === 'delete') throw new ServiceError('BAD_TYPE', `${p.type === 'figure' ? '그림' : p.type === 'toc' ? '차례 새로 고침' : p.type === 'delete' ? '개체 지우기' : '표'} 제안은 수정본에 반영할 수 없습니다(기준에 바로 적용을 쓰세요)`);
  }

  /**
   * 반영 기록을 묶을 변경 요청: cid 를 주면 내 진행 중 변경 요청이어야 한다(없으면 404 NO_CR, 남의 것 403 FORBIDDEN, 반영·닫힌 것 409 STATE),
   * 안 주면 내 진행 중 변경 요청(없으면 null — 변경 요청이 생길 때 묶인다)
   */
  _adoptTarget(meta, name, cid) {
    if (cid != null && cid !== '') {
      const cr = this._get(meta, cid);
      if (cr.author !== name) throw new ServiceError('FORBIDDEN', '내 변경 요청에만 반영할 수 있습니다', 403);
      if (!ACTIVE.has(cr.status)) throw new ServiceError('STATE', `이미 ${STATUS_KO[cr.status] || cr.status} 변경 요청입니다`, 409);
      return cr;
    }
    return this._mine(meta, name);
  }

  /**
   * 반영 기록(meta 만 — 서비스 _tx 안에서 부른다): 사람마다(p.adoptedBy[이름] = { at, cid }), p.adopted(예전 모양)는 방금 반영한 사람.
   * cr 이 있으면 그 변경 요청의 adopted 에 더한다
   */
  _recordAdoption(meta, p, name, cr, at = nowIso()) {
    const m = adoptionsOf(p); m[name] = { at, cid: cr ? cr.cid : null }; writeAdoptions(p, m, name);
    if (cr && !cr.adopted.includes(p.pid)) { cr.adopted.push(p.pid); cr.updatedAt = at; }
  }

  /**
   * 덩어리를 다시 계산한 뒤(수정본 저장·다시 맞추기) 의견 스레드를 새 덩어리에 다시 잇는다 → 바뀐(hid·ref) 스레드 수.
   * hid 는 새 글까지 넣어 셈하므로 작성자가 같은 문단을 또 고치면 바뀐다(위 '덩어리 자리·의견 스레드' 설명). 스레드마다:
   *  ① 같은 hid 의 새 덩어리 — 기준이 바뀌었으면(moved) 옛 덩어리 자리를 옮긴 열쇠까지 같을 때만(번호가 밀려 우연히 같은 hid 가 된 덩어리에 붙지 않게)
   *  ② 옛 덩어리의 자리 열쇠(종류 + 기준 자리 + 같은 자리의 차례 — web/crs.js hunkKeys 와 같은 규칙; moved 면 map 으로 새 기준에 옮긴 자리)가 같은 새 덩어리
   *  ③ 둘 다 없으면(작성자가 그 문단을 되돌림·문단이 없어짐·옛 자료의 남은 hid) hid = null — ref(그 문단 자리)·quote 는 남겨
   *     '그 문단에 단 의견'(변경 요청 전체 의견)으로 둔다. 남은(새 덩어리에 없는) hid 를 남기지 않는다.
   * 덩어리에 붙은 스레드의 ref 는 그 덩어리 자리(hunkPos — 수정본 기준 버전의 ref)로 맞춘다. 덩어리 없는 스레드의 ref 는 moved 면 map 으로
   * 옮긴다(그 문단이 새 기준에 없으면 null — 인용은 남음). moved 인데 map 이 없으면(옛 버전 파일을 못 읽음) ①(hid 그대로)만 쓰고 나머지 ref 는 null.
   * @param {{ map?: object|null, moved?: boolean }} o  map = 옛 기준 → 새 기준 ref 지도(_refMap)
   */
  _rethread(cr, oldHunks, newHunks, { map = null, moved = false } = {}) {
    const threads = cr.threads || [];
    if (!threads.length) return 0;
    const old = oldHunks || [];
    const { moveRef, moveAt } = hunkMovers(map, moved);
    const oldKeys = hunkKeys(old, moveAt);
    const newKeys = hunkKeys(newHunks);
    const oldIdx = new Map(old.map((h, i) => [h.hid, i]));
    const newIdx = new Map(newHunks.map((h, i) => [h.hid, i]));
    const byKey = new Map(); newKeys.forEach((k, i) => { if (k && !byKey.has(k)) byKey.set(k, i); });
    let n = 0;
    for (const t of threads) {
      const before = `${t.hid ?? ''}\u0001${t.ref ?? ''}`;
      if (t.hid) {
        const i = oldIdx.has(t.hid) ? oldIdx.get(t.hid) : -1;
        const same = newIdx.has(t.hid) ? newIdx.get(t.hid) : -1;
        let j = -1;
        if (same >= 0 && (!moved || !map || (i >= 0 && oldKeys[i] != null && oldKeys[i] === newKeys[same]))) j = same;
        else if (i >= 0 && oldKeys[i] != null && byKey.has(oldKeys[i])) j = byKey.get(oldKeys[i]);
        if (j >= 0) { t.hid = newHunks[j].hid; t.ref = hunkPos(newHunks[j]); } else {
          const pos = i >= 0 ? hunkPos(old[i]) : (t.ref ?? null);   // 옛 덩어리 자리(옛 자료의 남은 hid 면 스레드 ref)
          t.hid = null; t.ref = moveRef(pos);
        }
      } else if (t.ref != null) t.ref = moveRef(t.ref);
      if (`${t.hid ?? ''}\u0001${t.ref ?? ''}` !== before) n++;
    }
    return n;
  }

  /**
   * 승인을 승인한 내용에 묶는다(§3.3 승인 세기): 수정본 저장·다시 맞추기로 덩어리가 '다른 바뀜'이 되면(sameChange — 종류·자리·새 글;
   * 기준만 옮겨 간 같은 고침은 그대로) 그 전에 받은 승인에 stale = { at, by } 를 적는다 → reviewCounts 가 세지 않는다(다시 승인하면 셈).
   * 승인 뒤에 몰래 고친 글을 그 승인으로 반영하지 못하게. → 낡게 만든 승인 수(호출자가 meta 를 저장한다)
   */
  _staleApprovals(cr, oldHunks, newHunks, { map = null, moved = false } = {}, { by, at } = {}) {
    const live = (cr.reviews || []).filter((r) => r.verdict === 'approve' && !r.stale);
    if (!live.length || sameChange(oldHunks, newHunks, { map, moved })) return 0;
    for (const r of live) r.stale = { at, by };
    cr.log.push({ at, by, action: 'stale', detail: `승인 뒤 수정본이 바뀜 — 승인 ${live.length}건 다시 필요` });
    return live.length;
  }

  /**
   * 지금 기준 문서 ref(화면이 보낸 자리) → 수정본 기준 버전(cr.baseVersion) ref — 문단에 단 의견(덩어리 없는 스레드)의 ref 를
   * 덩어리 ref 와 같은 기준으로 둔다. 그 버전에 없는 문단(그 뒤에 남이 넣은 문단)이면 앞쪽 가장 가까운 문단, 표 칸이면 그 칸의 본문 문단. 못 찾으면 null
   */
  async _baseRefOf(meta, cr, ref) {
    try {
      const cur = await this.store.doc(meta.id); if (!cur) return null;
      const back = this._refMap(cur.bodyEntries(), await this._versionEntries(meta.id, cr.baseVersion));
      const r = back.ref(ref); if (r) return r;
      const body = /^s\d+\/p\d+/.exec(ref)?.[0];
      if (!body) return null;
      const rb = back.ref(body); if (rb) return rb;
      const at = back.insertAfter(body, secOf(body) ?? 0);
      return at && at.after >= 0 ? `s${at.sec}/p${at.after}` : null;
    } catch (e) { if (e instanceof ServiceError || e instanceof EngineError) return null; throw e; }
  }

  /** draft 변경 요청 지우기(목록에서 빼고 수정본 파일도). 작성자 수정본 판 +1 → 반영 기록이 풀린 AI 작업 번호(Set) */
  _drop(meta, cr, by, at = nowIso()) {
    meta.changeRequests = meta.changeRequests.filter((c) => c !== cr);
    const rids = this._releaseAdopted(meta, cr);
    this.store.deleteDraft(meta.id, cr.cid);
    this._bumpRev(meta, cr.author, at);
    this.store.log(meta, by, 'cr.delete', `#${cr.cid}`);
    return rids;
  }

  /** 닫기(작성자의 진행 중 수정본이 없어진다 → 작성자 수정본 판 +1). 수정본 파일은 다시 열기용으로 남긴다 → 반영 기록이 풀린 AI 작업 번호(Set) */
  _close(meta, cr, by, at, detail) {
    cr.status = 'closed'; cr.closedAt = at; cr.closedBy = by; cr.updatedAt = at;
    cr.log.push({ at, by, action: 'close', detail });
    const rids = this._releaseAdopted(meta, cr);
    this._bumpRev(meta, cr.author, at);
    this.store.log(meta, by, 'cr.close', `#${cr.cid}`);
    return rids;
  }

  /**
   * meta 만 고치는 일(닫기·버리기·다시 열기 …)로 반영 기록이 풀리거나 되살아난 제안의 AI 작업을 다시 센다(§9.2 — 큐 밖에서, 서비스 refreshRequests 의
   * 따로 _tx: 해결 상태·작업 기록 메모). 실패해도 그 일은 그대로(서비스가 알리기만 한다)
   */
  async _refreshRequests(id, rids, by, note) {
    if (!rids || !rids.size || typeof this.service.refreshRequests !== 'function') return;
    await this.service.refreshRequests(id, rids, { by, note });
  }

  // ───────── 수정본(내 것) ─────────

  /** GET /drafts/mine → { cr: CRView|null, file: { baseVersion, size, updatedAt }|null, rev }(rev = 내 수정본 판 — 다음 PUT ?rev= 에) */
  async mine(id, user) {
    return this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      const rev = this._rev(meta, user.name);
      const cr = this._mine(meta, user.name);
      if (!cr) return { cr: null, file: null, rev };
      const [view] = await this._views(meta, [cr], user);
      const f = this.store.listDrafts(id).find((x) => x.cid === cr.cid);
      return { cr: view, file: f ? { baseVersion: cr.baseVersion, size: f.size, updatedAt: f.updatedAt } : null, rev };
    });
  }

  /** GET /drafts/mine/file → { bytes, cid, baseVersion, title, rev } (없으면 404). rev = 이 바이트의 판(같은 큐에서 함께 읽음) */
  async mineFile(id, user) {
    return this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      const cr = this._mine(meta, user.name);
      if (!cr) throw new ServiceError('NO_DRAFT', '내 수정본이 없습니다', 404);
      const bytes = this.store.readDraft(id, cr.cid);
      if (!bytes) throw new ServiceError('NO_DRAFT', '수정본 파일이 없습니다', 404);
      return { bytes, cid: cr.cid, baseVersion: cr.baseVersion, title: meta.title, rev: this._rev(meta, user.name) };
    });
  }

  /**
   * PUT /drafts/mine?base=<n>&rev=<판>: 수정본 저장 + 덩어리 계산(V3 §3.2) → { cr, unchanged, rev }. 버전을 만들지 않는다.
   * base 가 없으면 내 변경 요청의 기준 버전(없으면 지금 버전). 덩어리가 0개면 draft 변경 요청과 파일을 지운다(cr: null) —
   * open 이면 남겨 두고 덩어리만 비운다. unchanged = 수정본이 기준과 같음(덩어리 없음).
   * rev(이 창이 읽어 온 판)를 주면 지금 판과 같을 때만 저장한다 — 다르면 409 DRAFT_STALE { rev, updatedAt }(같은 사람의 다른 창이 그새 저장·버림·다시 맞춤).
   * 저장하면 판 +1(응답 rev). 변경 요청도 없고 바뀐 것도 없는 저장은 아무것도 남기지 않으므로 판도 그대로.
   */
  async saveDraft(id, bytes, { base, rev, user }) {
    if (!bytes || !bytes.length) throw new ServiceError('EMPTY', '수정본 파일이 비었습니다');
    const given = base == null || base === '' ? null : posInt(base);
    if (base != null && base !== '' && !given) throw new ServiceError('BAD_BASE', `수정본 기준(base)이 올바르지 않습니다: ${MT.clip(String(base), 20)}`);
    const wantRev = revArg(rev);
    let draft;
    try { draft = await HwpxDoc.load(bytes); } catch (e) { throw new ServiceError('BAD_FILE', `수정본(HWPX)을 읽지 못했습니다: ${e.message}`); }
    if (!draft.sections?.length) throw new ServiceError('BAD_FILE', '구역(section)이 없는 파일입니다');
    const name = user.name;
    const out = await this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      this.service._assertCanEdit(user, meta);   // 수정본 저장·변경 요청 만들기는 수정 권한이 있어야(V4 §6 — 승인 방식에서도)
      let cr = this._mine(meta, name);
      this._checkRev(meta, name, wantRev, cr);
      const baseVersion = given ?? (cr ? cr.baseVersion : meta.version);
      // 글에 기록 번호(내부 판)를 'v' 로 내지 않는다(§9.1 — 사람용 버전 v 와 헷갈림). 번호는 응답 필드(baseVersion)로만
      if (baseVersion > meta.version) throw new ServiceError('BAD_BASE', '보낸 수정본 기준(base)이 지금 기준 문서보다 새것입니다 — 편집기에서 수정본을 다시 여세요');
      // 다시 맞춘(rebase) 뒤의 옛 편집기 창이 옛 기준으로 저장하면 다시 맞춘 것을 덮어쓴다 → 막고 다시 열게 한다
      if (cr && given != null && given < cr.baseVersion) {
        throw new ServiceError('STALE_BASE', '내 수정본은 이미 더 새 기준 문서로 다시 맞춰져 있습니다(이 창은 옛 기준으로 보냄) — 편집기에서 수정본을 다시 여세요', 409, { baseVersion: cr.baseVersion });
      }
      const cur = await this.store.doc(id);
      let baseDoc;
      try { baseDoc = await this._baseDoc(id, baseVersion, meta, cur); } catch (e) {
        // 편집기의 기준 기록 파일이 정리되었으면(V4 §2.6 기록 파일 정리 — 오래 열어 둔 창) 404 가 아니라 409 STALE_BASE: 웹은 [내 글 옮겨 넣기]로
        // 지금 기준을 열고 이 창에서 고친 글을 옮겨 넣는다(실시간 밀어 넣기의 STALE_BASE 와 같다)
        if (e instanceof ServiceError && e.code === 'NO_VERSION') {
          throw new ServiceError('STALE_BASE', '편집기의 기준 기록이 정리되어 이 창의 글을 맞출 수 없습니다 — 지금 문서를 열고 이 창에서 고친 글을 옮겨 넣으세요', 409, { baseVersion: meta.version });
        }
        throw e;
      }
      const { hunks, unsupported } = await this._diff(baseDoc, draft);
      const at = nowIso();
      if (!hunks.length && (!cr || cr.status === 'draft')) {
        if (!cr) return { view: null, unchanged: true, event: null, rev: this._rev(meta, name) };
        const rids = this._drop(meta, cr, name, at);   // 판 +1
        this.store.saveMeta(meta);
        return { view: null, unchanged: true, event: { action: 'deleted', cr }, rev: this._rev(meta, name), rids };
      }
      let created = false;
      if (!cr) { cr = this._newCr(meta, name, baseVersion, at); created = true; }
      const key = (list) => list.map((h) => h.hid).join(',');
      let changed = created || cr.baseVersion !== baseVersion || key(cr.hunks) !== key(hunks);
      // 의견 스레드를 새 덩어리에 다시 잇고(같은 기준이면 자리 그대로, 기준이 바뀌었으면 옛 기준 → 새 기준 지도로 — 못 만들면 hid 그대로인 것만),
      // 바뀜이 달라졌으면 그 전 승인을 낡은 것으로(_staleApprovals — 기준만 옮겨 간 같은 고침은 그대로)
      const approved = cr.reviews.some((r) => r.verdict === 'approve' && !r.stale);
      if (!created && (cr.threads.length || approved)) {
        const moved = cr.baseVersion !== baseVersion;
        let map = null;
        if (moved) { try { map = this._refMap(await this._versionEntries(id, cr.baseVersion), baseDoc.bodyEntries()); } catch { map = null; } }
        if (cr.threads.length && this._rethread(cr, cr.hunks, hunks, { map, moved })) changed = true;
        if (approved && this._staleApprovals(cr, cr.hunks, hunks, { map, moved }, { by: name, at })) changed = true;
      }
      Object.assign(cr, { baseVersion, hunks, unsupported, stats: hunkStats(hunks), updatedAt: at });
      cr.rev = this._bumpRev(meta, name, at);
      this.store.writeDraft(id, cr.cid, bytes);
      this.store.saveMeta(meta);
      const [view] = await this._views(meta, [cr], user, { cur });
      return { view, unchanged: !hunks.length, event: changed ? { action: 'draft', cr: view } : null, rev: cr.rev };
    });
    if (out.event) this._ws(id, out.event.action, out.event.cr, name, out.event.action === 'draft' ? { refs: this._curRefs(out.view), hunkCount: out.view.hunkCount, rev: out.rev } : {});
    await this._refreshRequests(id, out.rids, name, `수정본 지움 — AI 작업 ${[...(out.rids || [])].map((x) => `#${x}`).join('·')} 반영 기록 풂`);
    return { cr: out.view, unchanged: out.unchanged, rev: out.rev };
  }

  /** DELETE /drafts/mine: 내 수정 버리기 — draft 는 지우고, open 은 닫는다(파일은 다시 열기용으로 남김). 판 +1 → { ok, cr, rev } */
  async discard(id, user) {
    const name = user.name;
    const out = await this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      this.service._assertCanEdit(user, meta);
      const cr = this._mine(meta, name);
      if (!cr) return { view: null, event: null, rev: this._rev(meta, name) };
      const at = nowIso();
      if (cr.status === 'draft') {
        const rids = this._drop(meta, cr, name, at); this.store.saveMeta(meta);
        return { view: null, event: { action: 'deleted', cr }, rev: this._rev(meta, name), rids, cid: cr.cid };
      }
      const rids = this._close(meta, cr, name, at, '수정 버림(닫음)');
      this.store.saveMeta(meta);
      const [view] = await this._views(meta, [cr], user);
      return { view, event: { action: 'closed', cr: view }, rev: this._rev(meta, name), rids, cid: cr.cid };
    });
    if (out.event) this._ws(id, out.event.action, out.event.cr, name);
    await this._refreshRequests(id, out.rids, name, `변경 요청 #${out.cid} 수정 버림 — AI 작업 반영 기록 풂`);
    return { ok: true, cr: out.view, rev: out.rev };
  }

  /**
   * POST /drafts/mine/rebase(V3 §3.5): 새 수정본 = 지금 기준 최종본 + 내 덩어리. 깔끔·3-way 합침은 반영,
   * 충돌은 내 글을 남기고 conflicts 로 돌려준다. baseVersion = 지금 버전, 수정본 파일 교체(판 +1), 덩어리 다시 계산 → { cr, conflicts, rev }.
   * 표 구조·그림 등 반영 안 되는 변경(unsupported)은 새 수정본에 옮기지 않는다(글 덩어리만).
   */
  async rebase(id, user) {
    const name = user.name;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await this.service.workingSnapshot(id);   // 지금 기준 최종본(편집기용 사본) + 그 버전
      const out = await this.store.withDoc(id, async () => {
        const meta = this._meta(id);
        this.service._assertCanEdit(user, meta);
        const cr = this._mine(meta, name);
        if (!cr) throw new ServiceError('NO_DRAFT', '내 수정본(변경 요청)이 없습니다', 404);
        if (meta.version !== snap.version) return { retry: true };
        if (cr.baseVersion === meta.version) { const [view] = await this._views(meta, [cr], user); return { view, conflicts: [], event: null, rev: this._rev(meta, name) }; }
        const cur = await this.store.doc(id);
        const be = await this._versionEntries(id, cr.baseVersion);
        const work = await HwpxDoc.load(snap.bytes);
        const map = this._refMap(be, cur.bodyEntries());
        const source = await HwpxDoc.load(this.store.readDraft(id, cr.cid));
        const conflicts = this._rebuild(work, cur, cr, map, source);
        let flat;
        try { flat = await work.flattened({ tolerant: true }); } catch (e) {
          if (e instanceof EngineError) throw new ServiceError('REBASE_FAILED', `새 수정본을 만들지 못했습니다: ${e.message}`, 409);
          throw e;
        }
        const bytes = Buffer.from(await flat.save());
        const { hunks, unsupported } = await this._diff(cur, flat);
        const at = nowIso(); const prev = cr.baseVersion;
        if (!hunks.length && cr.status === 'draft') {
          const rids = this._drop(meta, cr, name, at);   // 판 +1
          this.store.saveMeta(meta);
          return { view: null, conflicts, event: { action: 'deleted', cr }, rev: this._rev(meta, name), rids };
        }
        this._rethread(cr, cr.hunks, hunks, { map, moved: true });   // 의견 스레드를 새 기준의 같은 자리 덩어리로(ref 도 새 기준으로)
        // 합쳐진 글(3-way)·옮기지 못한 고침으로 바뀜이 달라졌으면 승인을 낡은 것으로(번호만 밀린 같은 고침은 그대로)
        this._staleApprovals(cr, cr.hunks, hunks, { map, moved: true }, { by: name, at });
        Object.assign(cr, { baseVersion: meta.version, hunks, unsupported, stats: hunkStats(hunks), updatedAt: at });
        // 기록에는 사람용 버전(baseV, §9.4)만 적는다 — 기록 번호(내부 판)를 'v' 로 내지 않는다(§9.1)
        const oldV = this.service._milestoneAt(meta, prev)?.v ?? 1; const newV = this.service._milestoneAt(meta, meta.version)?.v ?? 1;
        const moved = oldV !== newV ? `v${oldV} 기준 → v${newV} 기준으로 다시 맞춤` : `최신 기준 문서로 다시 맞춤(v${newV} 기준)`;
        cr.log.push({ at, by: name, action: 'rebase', detail: `${moved}${conflicts.length ? ` · 충돌 ${conflicts.length}건(내 글 남김)` : ''}` });
        cr.rev = this._bumpRev(meta, name, at);   // 수정본 파일이 바뀐다 — 옛 창의 판은 낡음
        this.store.writeDraft(id, cr.cid, bytes);
        this.store.saveMeta(meta);
        const [view] = await this._views(meta, [cr], user, { cur });
        return { view, conflicts, event: { action: 'rebased', cr: view, from: prev }, rev: cr.rev };
      });
      if (out.retry) continue;
      if (out.event) {
        const ev = out.event;
        this._ws(id, ev.action, ev.cr, name, ev.action === 'rebased' ? { refs: this._curRefs(out.view), from: ev.from, version: ev.cr.baseVersion, conflicts: out.conflicts.length, rev: out.rev } : {});
      }
      await this._refreshRequests(id, out.rids, name, '수정본 지움(다시 맞춘 뒤 바뀐 것 없음) — AI 작업 반영 기록 풂');
      return { cr: out.view, conflicts: out.conflicts, rev: out.rev };
    }
    throw new ServiceError('BUSY', '문서가 계속 바뀌어 다시 맞추지 못했습니다. 잠시 뒤 다시 하세요', 409);
  }

  /**
   * 지금 기준 최종본 사본(work, 변경 추적 없음)에 내 덩어리를 얹는다(변경 추적으로 넣고 호출자가 평탄화). → conflicts
   * 글 고치기는 문단 수가 그대로일 때 먼저, 문단 넣기·지우기는 뒤에서부터(앞 번호가 흔들리지 않게, 같은 자리는 문서 순서 유지).
   */
  _rebuild(work, cur, cr, map, source) {
    const conflicts = [];
    const author = cr.author; const date = new Date();
    const edits = []; const structural = [];
    cr.hunks.forEach((h, order) => {
      const p = this._place(h, map, cur, null);
      const note = (reason, message) => conflicts.push(conflictOut(h, { ...p, reason, message }));
      if (h.type === 'insert') {
        if (p.kind === 'insert') structural.push({ kind: 'insert', sec: p.sec, after: p.after, key: Math.max(0, p.after) + 0.5, text: p.text, order, h });
        else note(p.reason, p.message);
        return;
      }
      if (h.type === 'object') {
        // 그림 속성·조판 부호: 문단이 없으면 알리고, 그새 남도 바꿨으면 내 것을 남기고 알린다(글 충돌과 같은 규칙)
        if (p.state === 'gone') { note('GONE', '그림·조판 부호를 옮길 문단이 사라졌습니다'); return; }
        if (p.kind === 'skip') return;
        if (p.kind === 'conflict') note(p.reason, '같은 문단의 그림·조판 부호를 다른 사람도 바꿨습니다 — 내 것을 남겼습니다');
        edits.push({ ref: p.curRef, text: p.currentText, h, object: true });
        return;
      }
      if (p.state === 'gone') {
        if (h.type === 'format') note('GONE', '서식을 적용할 문단이 사라졌습니다.');
        if (h.type === 'replace') {
          // 내 글을 남긴다: 그 문단이 없어졌으면(본문) 앞쪽 가장 가까운 짝 문단 뒤에 새 문단으로
          const at = !isNested(h.ref) ? map.insertAfter(h.ref, secOf(h.ref) ?? 0) : null;
          if (at) structural.push({ kind: 'insert', sec: at.sec, after: at.after, key: Math.max(0, at.after) + 0.5, text: MT.xmlSafe(h.newText), order, h });
          note('GONE', at ? '그 문단이 지금 문서에 없어 내 글을 새 문단으로 넣었습니다' : '그 칸(중첩 문단)이 지금 문서에 없어 옮기지 못했습니다');
        }
        return;   // 지운 문단이 이미 없으면 할 일 없음
      }
      let target;
      if (p.kind === 'edit') target = p.target;
      else if (p.kind === 'skip') target = p.currentText;   // 이미 같은 글
      else { target = MT.xmlSafe(h.newText); note(p.reason, '같은 자리를 다른 사람도 고쳤습니다 — 내 글을 남겼습니다'); }
      const m = /^s(\d+)\/p(\d+)$/.exec(p.curRef);
      if (h.type === 'delete' && target === '' && m) structural.push({ kind: 'remove', sec: Number(m[1]), at: Number(m[2]), key: Number(m[2]), order });
      else if (target !== p.currentText || h.type === 'format' || h.formatting) edits.push({ ref: p.curRef, text: target, h });
    });
    const eng = (fn) => { try { return fn(); } catch (e) { if (e instanceof EngineError) throw new ServiceError('REBASE_FAILED', `새 수정본을 만들지 못했습니다: ${e.message}`, 409); throw e; } };
    // 글·서식을 먼저(문단 수 그대로), 그림 속성·조판 부호는 그 뒤(같은 문단의 글을 고친 뒤 자리를 맞춘다)
    for (const e of edits) {
      if (e.object) continue;
      eng(() => work.mergeParagraphText(e.ref, e.text, { author, date }));
      if (source && e.h.headRef && (e.h.type === 'format' || e.h.formatting)) eng(() => this._copyFormatting(work, source, e.h.headRef, e.ref));
    }
    for (const e of edits) if (e.object && source && e.h.headRef) eng(() => work.copyObjectsFrom(source, e.h.headRef, e.ref));
    structural.sort((a, b) => a.sec - b.sec || b.key - a.key || b.order - a.order);
    for (const s of structural) {
      if (s.kind === 'insert') {
        const ref = eng(() => work.insertParagraphAfter(s.sec, s.after, s.text, { author, date, atStart: s.after < 0 }));
        if (source && s.h?.headRef) eng(() => this._copyFormatting(work, source, s.h.headRef, ref));
        if (source && s.h?.headRef && s.h.objects) eng(() => work.copyObjectsFrom(source, s.h.headRef, ref));   // 넣은 문단의 그림·조판 부호
        continue;
      }
      try { work.removeBodyParagraph(s.sec, s.at); } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        // 첫 문단(구역 속성)은 지울 수 없다 → 글만 비운다
        eng(() => work.mergeParagraphText(`s${s.sec}/p${s.at}`, '', { author, date }));
      }
    }
    return conflicts;
  }

  // ───────── 목록·보기 ─────────

  /** GET /change-requests?status=draft,open&hunks=1 — 기본은 hunks 없이 개수만(hunkCount) */
  async list(id, { status, hunks = false } = {}, user) {
    const want = status ? new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean)) : null;
    return this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      const list = meta.changeRequests.map((c) => this._norm(c)).filter((c) => !want || want.has(c.status));
      return this._views(meta, list, user, { withHunks: !!hunks });
    });
  }

  async get(id, cid, user) {
    return this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      return (await this._views(meta, [this._get(meta, cid)], user))[0];
    });
  }

  /**
   * MCP get_change_request(에이전트 검토)용: CRView(덩어리 포함) + 지금 기준 문서 문단(최종본·중첩 포함, paragraphs()) →
   * { view, paragraphs, version }. 같은 문서 큐에서 함께 읽는다(덩어리 curRef 와 주변 글이 같은 기준 상태를 가리키게)
   */
  async agentView(id, cid, user) {
    return this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      const cr = this._get(meta, cid);
      const cur = await this.store.doc(id);
      if (!cur) throw new ServiceError('NO_DOC', `문서가 없습니다: ${id}`, 404);
      const [view] = await this._views(meta, [cr], user, { cur });
      return { view, paragraphs: cur.paragraphs({ view: 'final', nested: true }), version: meta.version };
    });
  }

  /**
   * meta 만 고치는 일(검토·스레드·제목·상태): (async 여도 됨) fn(meta, cr, { by, at }) → 방송할 일 { action, push?, extra?, rids?, refreshNote? } | null.
   * rids(반영 기록이 풀리거나 되살아난 제안의 AI 작업)가 있으면 큐를 나온 뒤 그 요청들을 다시 센다(_refreshRequests)
   */
  async _op(id, cid, user, agent, fn) {
    const by = this.service.authorName(user, agent);
    const out = await this.store.withDoc(id, async () => {
      const meta = this._meta(id);
      const cr = this._get(meta, cid);
      const at = nowIso();
      const ev = (await fn(meta, cr, { by, at })) || null;
      if (ev) { cr.updatedAt = at; this.store.saveMeta(meta); }
      const [view] = await this._views(meta, [cr], user);
      return { view, ev, title: meta.title };
    });
    if (out.ev) {
      this._ws(id, out.ev.action, out.view, by, out.ev.extra || {});
      if (out.ev.push) this._push(id, out.title, out.view, out.ev.push, by);
      await this._refreshRequests(id, out.ev.rids, by, out.ev.refreshNote);
    }
    return out.view;
  }

  _canEdit(user, cr) { return user.role === 'admin' || user.name === cr.author; }

  /** PATCH { title?, description? } — 작성자·관리자 */
  async patch(id, cid, body, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      if (!this._canEdit(user, cr)) throw new ServiceError('FORBIDDEN', '제목·설명은 작성자·관리자만 고칠 수 있습니다', 403);
      if (cr.status === 'merged') throw new ServiceError('STATE', '반영된 변경 요청은 고칠 수 없습니다', 409);
      const b = body || {}; const ch = [];
      if (b.title !== undefined) { const t = cleanLine(b.title, LIMITS.title); if (t !== cr.title) { cr.title = t; ch.push('제목'); } }
      if (b.description !== undefined) { const d = cleanText(b.description, LIMITS.description); if (d !== cr.description) { cr.description = d; ch.push('설명'); } }
      if (!ch.length) return null;
      cr.log.push({ at, by, action: 'edit', detail: `${ch.join('·')} 수정` });
      return { action: 'update' };
    });
  }

  /** POST submit { title, description? }: draft → open(작성자). 제목이 없으면 첫 덩어리 앞 20자 */
  async submit(id, cid, body, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      if (user.name !== cr.author) throw new ServiceError('FORBIDDEN', '검토 요청은 작성자만 할 수 있습니다', 403);
      this.service._assertCanEdit(user, meta);
      if (cr.status !== 'draft') throw new ServiceError('STATE', `수정 중인 변경 요청만 검토 요청할 수 있습니다(지금: ${STATUS_KO[cr.status] || cr.status})`, 409);
      if (!cr.hunks.length) throw new ServiceError('NO_CHANGES', '바뀐 곳이 없습니다', 409);
      const b = body || {};
      const h = cr.hunks[0];
      const fallback = MT.clip(h.type === 'delete' ? h.baseText : h.newText, 20).trim() || `변경 요청 #${cr.cid}`;
      cr.title = cleanLine(b.title, LIMITS.title) || cr.title || fallback;
      if (b.description !== undefined) cr.description = cleanText(b.description, LIMITS.description);
      cr.status = 'open'; cr.submittedAt = at;
      cr.log.push({ at, by, action: 'submit', detail: '검토 요청' });
      this.store.log(meta, by, 'cr.submit', `#${cr.cid}`);
      return { action: 'open' };
    });
  }

  /**
   * POST reviews { verdict: approve|changes|comment, body? } — 누구나(작성자는 승인 불가).
   * 승인은 검토 요청(open) 뒤에만: 수정 중(draft)은 작성자가 아직 고치는 중이라 승인할 내용이 정해지지 않았다 → 409 NOT_OPEN.
   * 의견(comment)·수정 요청(changes)과 의견 스레드는 draft 에도 남길 수 있다. 작성자 자기 승인은 상태와 상관없이 403 SELF_APPROVE(먼저 본다)
   */
  async review(id, cid, body, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      const verdict = String(body?.verdict || '');
      if (!VERDICTS[verdict]) throw new ServiceError('BAD_VERDICT', `검토 결과가 올바르지 않습니다: ${verdict} (approve·changes·comment)`);
      if (!ACTIVE.has(cr.status)) throw new ServiceError('STATE', `이미 ${STATUS_KO[cr.status] || cr.status} 변경 요청입니다`, 409);
      if (verdict === 'approve' && isOwnerName(cr.author, by)) throw new ServiceError('SELF_APPROVE', '작성자는 자기 변경 요청을 승인할 수 없습니다', 403);
      if (verdict === 'approve' && cr.status !== 'open') throw new ServiceError('NOT_OPEN', '검토 요청 후 승인할 수 있습니다', 409);
      const text = MT.xmlSafe(body?.body).trim();
      if (text.length > LIMITS.comment) throw new ServiceError('TOO_LONG', `검토 글은 ${LIMITS.comment}자까지입니다`);
      if (verdict === 'comment' && !text) throw new ServiceError('EMPTY', '의견 글이 없습니다');
      if (cr.reviews.length >= LIMITS.reviews) throw new ServiceError('TOO_MANY', `검토는 변경 요청마다 ${LIMITS.reviews}개까지입니다`, 409);
      // 에이전트 검토(MCP)는 agent 를 남긴다 — 승인 수는 사람 검토로만 센다(reviewCounts)
      cr.reviews.push({ by, at, verdict, body: text, ...(agent ? { agent: String(agent) } : {}) });
      cr.log.push({ at, by, action: 'review', detail: VERDICTS[verdict] });
      return { action: 'review', push: 'review', extra: { verdict } };
    });
  }

  /**
   * POST threads { hid?, ref?, quote?, text } — 누구나.
   * 스레드 ref 는 덩어리 ref 처럼 수정본 기준 버전(cr.baseVersion)의 ref 다: hid 를 주면 그 덩어리 자리(hunkPos — 보낸 ref 는 안 씀),
   * hid 없이 ref(지금 기준 문서 ref — 화면이 보는 자리)를 주면 진행 중이고 기준이 뒤처졌을 때 수정본 기준 ref 로 옮겨 둔다.
   * 보기(CRView)의 threads[].curRef 가 지금 기준 문서 자리다.
   */
  async addThread(id, cid, body, user, agent) {
    return this._op(id, cid, user, agent, async (meta, cr, { by, at }) => {
      const b = body || {};
      const text = this._commentText(b.text);
      const hid = b.hid ? String(b.hid) : null;
      const hunk = hid ? cr.hunks.find((h) => h.hid === hid) : null;
      if (hid && !hunk) throw new ServiceError('NO_HUNK', `덩어리가 없습니다: ${hid}`);
      let ref = b.ref != null && b.ref !== '' ? String(b.ref) : null;
      if (ref && (ref.length > 64 || !REF_RE.test(ref))) throw new ServiceError('BAD_REF', `문단 주소가 올바르지 않습니다: ${MT.clip(ref, 64)}`);
      if (cr.threads.length >= LIMITS.threads) throw new ServiceError('TOO_MANY', `의견 스레드는 변경 요청마다 ${LIMITS.threads}개까지입니다`, 409);
      if (hunk) ref = hunkPos(hunk);
      else if (ref && ACTIVE.has(cr.status) && cr.baseVersion !== meta.version) ref = await this._baseRefOf(meta, cr, ref);
      const tid = cr.threads.reduce((n, t) => Math.max(n, Number(t.tid) || 0), 0) + 1;
      cr.threads.push({ tid, hid, ref, quote: b.quote ? MT.clip(b.quote, LIMITS.quote) : '', comments: [{ by, at, text }], resolved: null });
      cr.log.push({ at, by, action: 'thread', detail: `의견 #${tid}` });
      return { action: 'thread', push: 'thread', extra: { tid } };
    });
  }

  _commentText(v) {
    const t = MT.xmlSafe(v).trim();
    if (!t) throw new ServiceError('EMPTY', '글이 없습니다');
    if (t.length > LIMITS.comment) throw new ServiceError('TOO_LONG', `글은 ${LIMITS.comment}자까지입니다`);
    return t;
  }

  _thread(cr, tid) {
    const t = cr.threads.find((x) => Number(x.tid) === Number(tid));
    if (!t) throw new ServiceError('NO_THREAD', `의견 스레드가 없습니다: ${tid}`, 404);
    if (!Array.isArray(t.comments)) t.comments = [];
    return t;
  }

  /** POST threads/:tid/replies { text } */
  async replyThread(id, cid, tid, body, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      const t = this._thread(cr, tid);
      const text = this._commentText(body?.text);
      if (t.comments.length >= LIMITS.comments) throw new ServiceError('TOO_MANY', `답글은 스레드마다 ${LIMITS.comments}개까지입니다`, 409);
      t.comments.push({ by, at, text });
      return { action: 'thread', push: 'thread', extra: { tid: t.tid } };
    });
  }

  /** POST threads/:tid/resolve { resolved } */
  async resolveThread(id, cid, tid, resolved, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      const t = this._thread(cr, tid);
      if (!!t.resolved === !!resolved) return null;
      t.resolved = resolved ? { by, at } : null;
      return { action: 'thread', extra: { tid: t.tid, resolved: !!resolved } };
    });
  }

  /** POST close — 작성자·관리자. 수정본 파일은 다시 열기용으로 남긴다 */
  async close(id, cid, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      if (!this._canEdit(user, cr)) throw new ServiceError('FORBIDDEN', '닫기는 작성자·관리자만 할 수 있습니다', 403);
      if (!ACTIVE.has(cr.status)) throw new ServiceError('STATE', `이미 ${STATUS_KO[cr.status] || cr.status} 변경 요청입니다`, 409);
      const rids = this._close(meta, cr, by, at, '닫음');
      return { action: 'closed', push: 'closed', rids, refreshNote: `변경 요청 #${cr.cid} 닫음 — AI 작업 반영 기록 풂` };
    });
  }

  /** POST reopen: closed → draft(작성자·관리자). 작성자에게 진행 중인 다른 변경 요청이 있으면 409 */
  async reopen(id, cid, user, agent) {
    return this._op(id, cid, user, agent, (meta, cr, { by, at }) => {
      if (!this._canEdit(user, cr)) throw new ServiceError('FORBIDDEN', '다시 열기는 작성자·관리자만 할 수 있습니다', 403);
      this.service._assertCanEdit(user, meta);   // 진행 중 수정본이 다시 생긴다 — 수정 권한이 있어야
      if (cr.status !== 'closed') throw new ServiceError('STATE', '닫힌 변경 요청만 다시 열 수 있습니다', 409);
      const other = this._mine(meta, cr.author);
      if (other) throw new ServiceError('ACTIVE_EXISTS', `${cr.author} 님에게 이미 진행 중인 ${josa(`변경 요청 #${other.cid}`, '이/가')} 있습니다`, 409);
      if (!this.store.readDraft(meta.id, cr.cid)) throw new ServiceError('NO_DRAFT', '수정본 파일이 없어 다시 열 수 없습니다', 409);
      cr.status = 'draft'; cr.reopenedAt = at;
      cr.rev = this._bumpRev(meta, cr.author, at);   // 작성자의 진행 중 수정본이 다시 생김 — '수정본 없음'을 읽은 창은 낡음
      cr.log.push({ at, by, action: 'reopen', detail: '다시 열기' });
      const rids = new Set();   // 반영 기록이 되살아난 제안의 AI 작업 — 다시 센다(남음 → 반영)
      for (const pid of cr.adopted) {
        const p = meta.proposals.find((x) => x.pid === pid);
        if (!p || p.status !== 'pending') continue;
        const m = adoptionsOf(p);
        if (!m[cr.author]) { m[cr.author] = { at, cid: cr.cid }; writeAdoptions(p, m); if (p.rid != null) rids.add(p.rid); }
      }
      this.store.log(meta, by, 'cr.reopen', `#${cr.cid}`);
      return { action: 'reopened', rids, refreshNote: `변경 요청 #${cr.cid} 다시 열기 — AI 작업 반영 기록 되살림` };
    });
  }

  // ───────── 반영(merge, §3.4) ─────────

  /**
   * POST merge → { version, cr, report } / 409 MERGE_CONFLICT { conflicts } / 403 NEED_APPROVAL.
   * 한 번의 _tx = 버전 하나. 충돌(글 겹침·사라진 문단·처리 안 된 변경 추적)이 하나라도 있으면 아무것도 바꾸지 않는다.
   */
  async merge(id, cid, user, agent) {
    const by = this.service.authorName(user, agent);
    const svc = this.service;
    const out = await svc._tx(id, async () => {
      const { doc, meta } = await svc._load(id);
      const cr = this._get(meta, cid);
      const admin = user.role === 'admin';
      // 실시간 문서(V4 §5): 수정 권한이 있는 작성자(또는 관리자)는 승인 없이 반영한다 — 수정 중(draft)인 것도(제출 단계가 없다).
      // 승인 방식 문서는 v0.3 그대로(검토 중(open) + 다른 사람 승인). 수정 권한이 없으면 어디서나 403 FORBIDDEN
      const realtime = svc.isRealtime(meta);
      if (!admin && user.name !== cr.author) throw new ServiceError('FORBIDDEN', '반영은 관리자 또는 작성자만 할 수 있습니다', 403);
      svc._assertCanEdit(user, meta);
      if (realtime ? !ACTIVE.has(cr.status) : cr.status !== 'open') throw new ServiceError('STATE', cr.status === 'draft' ? '검토 요청(제출) 뒤에 반영할 수 있습니다' : `이미 ${STATUS_KO[cr.status] || cr.status} 변경 요청입니다`, 409);
      const counts = reviewCounts(cr);
      if (!admin && !realtime && counts.approvals < this.requireApprovals) {
        throw new ServiceError('NEED_APPROVAL', needApprovalText(this.requireApprovals, counts), 403, { approvals: counts.approvals, required: this.requireApprovals, staleApprovals: counts.staleApprovals });
      }
      if (!cr.hunks.length) throw new ServiceError('NO_CHANGES', '반영할 변경이 없습니다', 409);

      // 1) 기준 버전 → 지금 문서 정렬, 덩어리마다 자리·글 정하기(아직 아무것도 바꾸지 않는다)
      const ctx = svc._ctx(id, doc, meta, by);
      const ce = doc.bodyEntries();
      const map = this._refMap(await this._entriesFor(meta, cr.baseVersion, ce), ce);
      let pending = changesByRef(doc);
      let placed = cr.hunks.map((h, order) => ({ h, p: this._place(h, map, doc, pending), order }));
      // 실시간 '고친 글만' 문서(V4 §2.3 — 처리 안 된 변경 추적과 겹치면 그 문단의 변경 추적을 먼저 수락하고 다시): 덩어리가 겹치는 처리 안 된
      // 변경 추적(승인 방식 때 적용한 제안 등)은 그 문단 것을 먼저 수락하고 다시 놓는다 — 아니면 승인 방식 때 남은 수정본을 실시간 문서에서
      // 영영 반영하지 못한다(변경 추적 탭은 '자세히'에서만 보임). 반영이 다른 까닭으로 막히면 _tx 가 이 수락도 함께 버린다
      if (svc._liveFinal(meta)) {
        const stuck = new Set(placed.filter((x) => x.p.kind === 'conflict' && x.p.reason === 'PENDING_TRACKED').map((x) => x.p.curRef));
        if (stuck.size) {
          svc._resolveIds(ctx, doc.changes().filter((c) => stuck.has(c.ref)).map((c) => c.id), 'accept', { tolerant: true });
          pending = changesByRef(doc);
          placed = cr.hunks.map((h, order) => ({ h, p: this._place(h, map, doc, pending), order }));
        }
      }
      const conflicts = placed.filter((x) => x.p.kind === 'conflict').map(({ h, p }) => conflictOut(h, p));
      const fail = (list) => new ServiceError('MERGE_CONFLICT', `충돌 ${list.length}건 — ${list.some((c) => c.reason === 'PENDING_TRACKED') ? '먼저 그 문단의 변경 추적을 수락/거절하거나 ' : ''}최신 반영(다시 맞추기) 뒤 반영하세요`, 409, { conflicts: list });
      if (conflicts.length) throw fail(conflicts);
      const source = await HwpxDoc.load(this.store.readDraft(id, cr.cid));
      if ((await doc.copyStyleDefinitionsFrom(source)).changed) { ctx.dirty = true; ctx.formatting = true; }

      // 2) 적용(작성자 = 변경 요청 작성자). 글 고치기 먼저(문단 수 그대로), 문단 넣기는 뒤에서부터
      const author = cr.author; const date = new Date(); const at = date.toISOString();
      const recs = []; const skipped = []; const late = [];
      for (const { h, p } of placed) {
        if (p.kind === 'skip') { skipped.push({ hid: h.hid, reason: p.reason }); continue; }
        if (p.kind !== 'edit' || p.object || p.removePictures) continue;   // 그림 속성·조판 부호·그림 지우기는 글을 다 고친 뒤(아래)
        let ids;
        let formatUndo = null;
        try {
          const before = p.formatting ? doc.inspectFormatting(p.curRef) : null;
          ids = doc.mergeParagraphText(p.curRef, p.target, { author, date });
          if (p.formatting && h.headRef) {
            this._copyFormatting(doc, source, h.headRef, p.curRef);
            formatUndo = { ref: p.curRef, before, afterFingerprint: doc.inspectFormatting(p.curRef).fingerprint };
            ctx.formatting = true;
          }
        } catch (e) {
          if (!(e instanceof EngineError)) throw e;
          late.push(conflictOut(h, { ...p, reason: e.code === 'OVERLAP' ? 'PENDING_TRACKED' : e.code, message: e.code === 'OVERLAP' ? '그 문단에 아직 처리하지 않은 변경 추적이 있습니다. 먼저 변경 추적을 수락/거절하세요' : e.message }));
          continue;
        }
        // before·after = 이 문단 반영 전·뒤 최종본 글(반영으로 들어간 제안의 변경 id 를 가릴 때 — _adoptedChangeIds)
        recs.push({ ref: p.curRef, hid: h.hid, kind: h.type === 'delete' ? 'deleted' : (h.cell || isNested(p.curRef)) ? 'cells' : 'changed', ids, before: p.currentText, after: p.target, formatUndo });
      }
      if (late.length) throw fail(late);   // _tx 가 메모리 문서를 버린다(반쯤 고친 상태가 남지 않음)
      // 그림 속성·조판 부호(object 덩어리 — 글은 그대로, 다른 창은 파일을 다시 연다).
      // 개체를 추적하는 문서(service._objectTracking — 실시간 '변경 추적으로')는 넣고 지운 표·그림·차트·도형을 변경 추적으로(작성자 = 변경 요청 작성자).
      // 추적판이 제가 추적으로 넣은 개체를 지우면 그 넣음을 거절해 번호가 다시 매겨진다 → 앞 기록의 ids 도 따라 옮긴다(_syncChangeIds holders)
      const trk = svc._objectTracking(meta, doc); const objOpt = { author, date };
      for (const { h, p } of placed) {
        if (p.kind !== 'edit') continue;
        if (p.removePictures) {
          // 지운 그림·표 문단: 그림·표를 지운다(글 지우기처럼 빈 문단은 남는다)
          let ids = [];
          if (trk) {
            const r = svc._engine(() => doc.removeOwnObjectsTracked(p.curRef, objOpt));
            svc._syncChangeIds(meta, doc, recs);
            if (!r?.count) continue;
            ids = [...(r.ids || [])];
          } else if (!svc._engine(() => doc.removeOwnObjects(p.curRef))) continue;
          ctx.formatting = true;
          recs.push({ ref: p.curRef, hid: h.hid, kind: 'deleted', ids, before: p.currentText, after: '', formatUndo: null });
          continue;
        }
        if (!p.object || !h.headRef) continue;
        let ids = [];
        if (trk) {
          const r = svc._engine(() => doc.copyObjectsTracked(source, h.headRef, p.curRef, objOpt));
          svc._syncChangeIds(meta, doc, recs);
          if (!r?.changed) continue;
          ids = [...(r.ids || [])];
        } else if (!svc._engine(() => doc.copyObjectsFrom(source, h.headRef, p.curRef))) continue;
        ctx.formatting = true;
        recs.push({ ref: p.curRef, hid: h.hid, kind: (h.cell || isNested(p.curRef)) ? 'cells' : 'changed', ids, before: p.currentText, after: p.currentText, formatUndo: null });
      }
      // 문단 나눔을 추적하는 문서(service._breakTracking — 실시간 '변경 추적으로'·승인 방식)는 넣은 문단의 나눔도 넣음 표식으로(trackBreak — 거절하면
      // 빈 줄 없이 사라짐). 그 표식은 앞 문단 끝에 있을 수 있어(ref 가 앞 문단) 넣기 전후의 변경 목록을 견줘 rec.ids 에 넣는다.
      // 지운 문단(글·그림·표를 위에서 지움 — 이미 빈 문단도)은 앞 문단 끝 나눔을 지움 표식으로(deleteBreakAfter — 2단계, 빈 문단을 남기지 않음:
      // 최종본에서는 앞 문단과 한 문단, 거절하면 제 문단으로). 넣기·나눔 지우기는 함께 뒤에서부터(앞 번호가 흔들리지 않게)
      const brk = svc._breakTracking(meta, doc);
      const brkDels = !brk ? [] : placed.filter(({ h, p }) => {
        if (h.type !== 'delete' || !p.curRef || !/^s\d+\/p\d+$/.test(p.curRef)) return false;
        if (!(p.kind === 'edit' || (p.kind === 'skip' && p.reason === 'SAME' && p.currentText === ''))) return false;
        const at = Number(/\/p(\d+)$/.exec(p.curRef)[1]);
        if (at < 1) return false;
        try { return doc.plainOrObjectParagraph(p.curRef) && !svc._paraHasMemo(doc, p.curRef); } catch { return false; }
      }).map((x) => ({ ...x, del: true }));
      const ins = [...placed.filter((x) => x.p.kind === 'insert'), ...brkDels]
        .map((x) => ({ ...x, key: x.del ? Number(/\/p(\d+)$/.exec(x.p.curRef)[1]) : Math.max(0, x.p.after) + 0.5, sec: x.del ? Number(/^s(\d+)/.exec(x.p.curRef)[1]) : x.p.sec }))
        .sort((a, b) => a.sec - b.sec || b.key - a.key || b.order - a.order);
      for (const { h, p, del, key, sec } of ins) {
        if (del) {
          const atNo = key; const ref = `s${sec}/p${atNo}`;
          let r = null;
          try { r = doc.deleteBreakAfter(`s${sec}/p${atNo - 1}`, { author, date }); } catch (e) {
            if (!['LAST_PARAGRAPH', 'SECTION_BREAK', 'BREAK_STATE'].includes(e?.code)) svc._engine(() => { throw e; });
            continue;   // 구역 끝·구역 나누기 문단: 예전처럼 빈 문단을 남긴다
          }
          svc._syncChangeIds(meta, doc, recs);
          svc._remapRefs(meta, sec, (i) => (i === atNo ? -1 : i > atNo ? i - 1 : i));
          // 지운 문단 기록의 ref 는 그 자리 그대로(실시간 밀어 넣기의 지운 문단과 같은 규칙 — 지금은 다음 문단이 차지), 뒤 기록은 한 칸 당긴다
          let mine = recs.find((x) => x.ref === ref && x.hid === h.hid && x.kind === 'deleted');
          if (!mine) { mine = { ref, hid: h.hid, kind: 'deleted', ids: [], before: p.currentText ?? '', after: '', formatUndo: null }; recs.push(mine); }
          for (const x of recs) if (x !== mine) x.ref = shiftRef(x.ref, sec, (i) => (i > atNo ? i - 1 : i));
          if (r?.id != null) mine.ids = [...(mine.ids || []), r.id];
          // 이미 빈 문단이라 글로는 할 일이 없었던 지우기(SAME)도 이제 반영한 것
          const sk = skipped.findIndex((x) => x.hid === h.hid); if (sk >= 0) skipped.splice(sk, 1);
          continue;
        }
        const before = brk ? new Set(doc.changes().map((c) => c.id)) : null;
        const newRef = svc._engine(() => doc.insertParagraphAfter(p.sec, p.after, p.text, { author, date, atStart: p.after < 0, ...(brk ? { trackBreak: true } : {}) }));
        const rec = { ref: newRef, hid: h.hid, kind: 'inserted', text: p.text, ids: before ? doc.changes().filter((c) => !before.has(c.id) && c.ref !== newRef).map((c) => c.id) : [] };
        if (h.headRef) { svc._engine(() => this._copyFormatting(doc, source, h.headRef, newRef)); ctx.formatting = true; }
        // 넣은 문단의 그림·조판 부호(개체를 추적하는 문서면 Insert 로 감싼다 — 그 id 는 아래 changes() 로 rec.ids 에 든다)
        if (h.headRef && h.objects) {
          svc._engine(() => (trk ? doc.copyObjectsTracked(source, h.headRef, newRef, objOpt) : doc.copyObjectsFrom(source, h.headRef, newRef)));
          if (trk) svc._syncChangeIds(meta, doc, [...recs, rec]);
        }
        const nb = Number(/\/p(\d+)$/.exec(newRef)[1]);
        const shift = (i) => (i >= nb ? i + 1 : i);
        svc._remapRefs(meta, p.sec, shift);
        for (const r of recs) r.ref = shiftRef(r.ref, p.sec, shift);
        rec.ids = [...new Set([...rec.ids, ...doc.changes().filter((c) => c.ref === newRef).map((c) => c.id)])];
        recs.push(rec);
      }
      if (recs.length) ctx.dirty = true;
      // 메모를 달거나 메모 글 줄 수가 바뀌면 그 문단 안 중첩 문단(표 칸 등) 번호가 밀린다(메모 본문도 중첩 문단) —
      // 바뀐 칸 자리를 적어 두고 메모를 쓴 뒤마다 다시 찾는다(보고·WS refs 가 엉뚱한 칸을 가리키지 않게)
      const nested = nestedKeeper(doc, recs);

      // 3) 수정본에 반영해 둔 제안: 그 글이 들어갔으면 applied(via cid), 아니면 대기로
      const adopted = this._settleAdopted(ctx, cr, recs, by, at);
      if (adopted.applied.length) nested.restore();   // 제안 메모를 다시 썼다(상태 줄이 늘어남)
      // 실시간 '고친 글만' 문서(V4 §2.3)는 반영이 만든 변경도 곧바로 수락한다 — 그 글이 들어가 적용된 제안은 글로 되돌린다(appliedRange)
      if (svc._liveFinal(meta)) {
        svc._resolveIds(ctx, recs.flatMap((r) => r.ids || []), 'accept');
        // 반영으로 적용된 제안 중 제 변경 id 를 가려내지 못한 것(다시 맞추기로 글이 합쳐진 문단 등)도 글 되돌리기로 — 고친 글만 문서에는
        // 변경 추적이 남지 않으므로 그대로 두면 되돌리기가 늘 409 STATE('되돌릴 변경이 남아 있지 않습니다')가 된다
        for (const pid of adopted.applied) { const p = meta.proposals.find((x) => x.pid === pid); if (p) p.appliedFinal = true; }
      }

      // 4) 반영 기록 메모 — 첫 바뀐 문단(글이 남은 문단을 먼저)
      const counts2 = { changed: 0, inserted: 0, deleted: 0, cells: 0 };
      for (const r of recs) counts2[r.kind]++;
      let memoId = null;
      const order = [...recs].sort((a, b) => cmpRef(a.ref, b.ref));
      const txt = (ref) => { try { return doc.text(ref, 'final'); } catch { return null; } };
      const first = order.find((r) => txt(r.ref)) || order.find((r) => txt(r.ref) != null);
      if (first) {
        const text = MT.renderCrRecordMemo({ cid: cr.cid, author: cr.author, title: cr.title, counts: counts2, approvers: counts.approvers, mergedBy: by });
        // 기록용 메모라 못 달아도 반영은 그대로 한다(addMemo 는 다 확인한 뒤 한 번에 고치므로 실패하면 문서는 그대로).
        // 그 문단 안 meta 중첩 ref(대기 중인 요청 칸 제안 등)는 서비스 _memoEdit 가 지킨다(보고 refs 는 위 nested 가)
        try { memoId = svc._memoEdit(ctx, first.ref, () => doc.addMemo(first.ref, { start: 0, end: cpLen(txt(first.ref)), author: by, text, date })); ctx.dirty = true; } catch (e) {
          if (!(e instanceof EngineError)) throw e;
          console.error(`[crs] 변경 요청 #${cr.cid} 반영 기록 메모를 달지 못했습니다(${first.ref}): ${e.message}`);
        }
      }

      // 5) 상태·저장(기록 하나 + 사람용 버전 하나 — §9.4 merge), 수정본 파일 지우기
      cr.status = 'merged'; cr.mergedAt = at; cr.mergedBy = by; cr.updatedAt = at;
      for (const rid of this._releaseAdopted(meta, cr)) ctx.reqs.add(rid);   // 풀린 반영 기록의 AI 작업도 다시 센다(§9.2)
      this._bumpRev(meta, cr.author, at);   // 작성자 수정본이 없어진다(파일 지움) — 옛 창이 반영된 글로 새 수정본을 만들지 않게
      svc.store.log(meta, by, 'cr.merge', `#${cr.cid}: ${MT.crCountParts(counts2).join(', ') || '바뀐 것 없음'}`);
      ctx.milestone = { kind: 'merge', note: `변경 요청 #${cr.cid} 반영${cr.title ? ` — ${cr.title}` : ''}` };
      // 커밋(과 이정표) 뒤 저장 직전: 반영된 기록 n(mergedVersion)·사람용 버전 v(mergedV) — 기록 메모 'v4로 반영'(조사 §0-7)
      ctx.beforeSave = () => {
        cr.mergedVersion = meta.version;
        cr.mergedV = (ctx.madeMilestone || svc._milestoneAt(meta, meta.version))?.v ?? null;
        cr.log.push({ at, by, action: 'merge', detail: cr.mergedV != null ? `${josa(`v${cr.mergedV}`, '으로/로')} 반영` : '반영' });
      };
      ctx.skipVerify = true; // 사람 수정본(변경 요청) 반영 — 그 수정본이 기준이라 편집 뒤 검증(server/edit-verify.js)으로 막지 않는다
      const version = await svc._finish(ctx, `변경 요청 #${cr.cid} 반영`);
      // 이미 커밋했다 — 아래가 실패해도 반영은 성공.
      // 보고·WS refs 의 칸 ref 를 기록 메모(글이 표·각주 앞에 있는 문단에 달면 그 안 칸 번호가 밀림)·_finish 의 요청 메모 다시 쓰기 뒤로 맞춘다
      try { nested.restore(); } catch (e) { console.error(`[crs] 변경 요청 #${cr.cid} 반영 보고의 칸 ref 를 다시 찾지 못했습니다: ${e.message}`); }
      // 수정본 파일을 못 지워도 반영은 성공(남은 파일은 merged 변경 요청이라 다시 쓰이지 않는다)
      try { this.store.deleteDraft(id, cr.cid); } catch (e) { console.error(`[crs] ${josa(`수정본 파일 c${cr.cid}`, '을/를')} 지우지 못했습니다: ${e.message}`); }
      const [view] = await this._views(meta, [cr], user, { cur: doc });
      const refsOf = (k) => recs.filter((r) => r.kind === k).map((r) => r.ref).sort(cmpRef);
      const report = {
        changed: refsOf('changed'), cells: refsOf('cells'), inserted: refsOf('inserted'), deleted: refsOf('deleted'),
        skipped, unsupported: cr.unsupported.length, adopted, memoId,
      };
      return { view, version, v: cr.mergedV ?? null, report, rids: [...ctx.reqs], resolved: ctx.resolvedNow.map((x) => x.rid), title: meta.title };
    });
    const { report } = out;
    const changed = [...report.changed, ...report.cells];
    const vx = out.v != null ? { v: out.v } : {};
    this._ws(id, 'merged', out.view, by, { refs: [...changed, ...report.inserted, ...report.deleted].sort(cmpRef), version: out.version, ...vx });
    this.hub.broadcast(id, { type: 'doc', action: 'changed', version: out.version, changed, inserted: report.inserted, deleted: report.deleted, by, cr: out.view.cid, ...vx });
    if (report.memoId) this.hub.broadcast(id, { type: 'memo', action: 'add', memoId: report.memoId, by, version: out.version });
    const props = report.adopted.applied.length + report.adopted.released.length;
    if (props) this.hub.broadcast(id, { type: 'proposal', action: 'batch', count: props, by, version: out.version });
    for (const rid of out.rids) this.hub.broadcast(id, { type: 'request', action: 'update', rid, by, owner: this.service._reqOwner(id, rid), ...(out.resolved.includes(rid) ? { resolved: true } : {}) });
    this._push(id, out.title, out.view, 'merged', by);
    return { version: out.version, v: out.v, cr: out.view, report };
  }

  /**
   * 반영한 변경 요청에 묶인 제안(adopted): 바꿈은 그 문단이 이번에 바뀌었고 제안 글이 들어 있으면,
   * 문단 추가는 같은 글의 문단이 들어갔으면 applied(via: { cid }). 아니면 작성자의 묶음만 푼다(대기 그대로, 남의 반영 기록은 그대로).
   * 적용된 제안의 변경(changeIds — 복구 = 그 변경 거절): 문단 추가는 넣은 문단의 변경, 바꿈은 그 문단의 이번 변경 중 제안 자리에 걸친 것만
   * (_adoptedChangeIds — 같은 문단의 작성자 다른 고침까지 담으면 제안을 복구할 때 그 고침도 함께 되돌아간다).
   * 들어갔는지·변경 id 는 메모를 다시 쓰기 전에 모두 정한다(메모 글 줄 수가 바뀌면 그 문단의 중첩 문단 번호가 밀린다).
   */
  _settleAdopted(ctx, cr, recs, by, at) {
    const { doc, meta } = ctx; const svc = this.service;
    const applied = []; const released = [];
    // 작성자의 반영 기록을 풀면 그 제안의 AI 작업도 다시 센다(§9.2 — 반영 → 남음)
    const release = (p) => { if (this._unadopt(p, cr) && p.rid != null) ctx.reqs.add(p.rid); };
    const touched = new Map(recs.filter((r) => r.kind !== 'inserted').map((r) => [r.ref, r]));
    const inserted = recs.filter((r) => r.kind === 'inserted');
    let changes = null; const changesNow = () => (changes ??= doc.changes());   // 1단계에서는 문서를 고치지 않는다
    const plan = [];
    for (const pid of cr.adopted) {
      const p = meta.proposals.find((x) => x.pid === pid);
      if (!p) continue;
      if (p.status !== 'pending') { release(p); continue; }
      let hit = null; let ids = [];
      if (p.type === 'insert') {
        hit = inserted.find((r) => String(r.text ?? '').trim() === String(p.text ?? '').trim()) || null;
        if (hit) ids = changesNow().filter((c) => c.ref === hit.ref).map((c) => c.id);
      } else if (p.type === 'replace') {
        const ref = svc._locate(doc, p, 'ref');
        const r = touched.get(ref);
        if (r) {
          let t = ''; try { t = doc.text(ref, 'final'); } catch { t = ''; }
          if (p.replace ? t.includes(p.replace) : (!!p.find && !t.includes(p.find))) { hit = r; ids = this._adoptedChangeIds(changesNow(), p, r); }
        }
      } else if (p.type === 'format') {
        const ref = svc._locate(doc, p, 'ref');
        const r = touched.get(ref);
        const u = p.draftFormatUndo?.[cr.author];
        if (r?.formatUndo && u?.after) {
          try {
            const range = p.find ? doc.find(ref, p.find, p.occurrence || 1) : { start: p.start ?? 0, end: p.end ?? 0 };
            svc._formatExpectedFingerprint(doc, { ...p, formatSnapshot: u.after, formatFingerprint: u.afterFingerprint }, ref, range);
            hit = r;
          } catch (e) { if (!(e instanceof ServiceError || e instanceof EngineError)) throw e; }
        }
      }
      plan.push({ p, hit, ids });
    }
    for (const { p, hit, ids } of plan) {
      if (p.status !== 'pending') { release(p); continue; }   // 같은 묶음(여러 안)의 다른 안이 방금 적용되어 대체됨
      if (!hit) { release(p); released.push(p.pid); continue; }
      p.status = 'applied'; p.appliedBy = cr.author; p.appliedAt = at; p.appliedVersion = meta.version + 1; p.via = { cid: cr.cid };
      if (p.type === 'insert') p.insertedRef = hit.ref;
      p.changeIds = ids;
      if (p.type === 'format' && hit.formatUndo) {
        const range = p.find ? doc.find(hit.ref, p.find, p.occurrence || 1) : { start: p.start ?? 0, end: p.end ?? 0 };
        p.formatUndo = { ...hit.formatUndo, ...range, format: p.format, after: doc.inspectFormatting(hit.ref) }; p.appliedFinal = true;
      }
      else if ((p.format || p.runs) && hit.formatUndo) { p.formatBefore = hit.formatUndo.before; p.formatAfterFingerprint = hit.formatUndo.afterFingerprint; }
      p.log.push({ at, by, action: 'apply', detail: `변경 요청 #${cr.cid} 반영으로 적용` });
      delete p.adopted; delete p.adoptedBy;   // 적용됨 — 남이 자기 수정본에 반영해 둔 기록도 끝
      svc._writeProposalMemo(ctx, p);
      if (p.gid != null) {
        for (const x of meta.proposals) {
          if (x.gid !== p.gid || x.pid === p.pid || x.status !== 'pending') continue;
          x.status = 'superseded'; x.supersededBy = p.pid; x.log.push({ at, by, action: 'supersede', detail: `안 ${p.option} 적용으로 대체` });
          svc._writeProposalMemo(ctx, x);
        }
      }
      svc._reqEvent(ctx, p.rid, 'apply', `${p.gid != null ? `안 ${p.option}` : `#${p.pid}`} 적용(변경 요청 #${cr.cid})`, by);
      applied.push(p.pid);
    }
    return { applied, released };
  }

  /**
   * 변경 요청 반영으로 들어간 바꿈 제안(p)의 변경 추적 id: 그 문단의 이번 변경(rec.ids) 중 제안 자리에 걸친 편집이 만든 것만.
   * 제안 자리 = 반영 전 글(rec.before)에서 p.find 의 occurrence 번째(빈 find 는 offset 자리). 반영 전 → 뒤 글(rec.after)의 편집
   * (mergeParagraphText 와 같은 charOps) 중 그 자리를 덮거나 끝에 맞닿은 것의 반영 뒤(최종본) 범위 [lo, hi] 에 든 변경만 고른다
   * (삭제 표식은 최종본에서 한 점, 삽입은 넣은 글 범위). 자리를 못 찾으면 [] — 복구는 409(변경 추적 탭에서 직접 거절).
   * @param {Array} changes doc.changes()(반영 뒤 — 이 단계에서 문서는 그대로)  @param {object} rec 반영 기록 { ref, ids, before, after }
   */
  _adoptedChangeIds(changes, p, rec) {
    if (rec.before == null || rec.after == null || !rec.ids?.length) return [];
    const before = String(rec.before); const n = cpLen(before);
    let s; let e;
    if (!p.find) { s = p.offset != null ? Math.min(Math.max(0, Number(p.offset) || 0), n) : n; e = s; } else {
      let at = -1; let from = 0;
      for (let k = 0; k < Math.max(1, Number(p.occurrence) || 1); k++) { at = before.indexOf(p.find, from); if (at < 0) break; from = at + 1; }
      if (at < 0) return [];
      s = cpLen(before.slice(0, at)); e = s + cpLen(p.find);
    }
    let shift = 0; let lo = null; let hi = null;
    for (const op of charOps(before, rec.after)) {
      const len = cpLen(op.text); const fs = op.start + shift;
      const touch = op.start === op.end ? (s <= op.start && op.start <= e)   // 넣기: 자리 안·끝
        : s === e ? (op.start <= s && s <= op.end)                           // 빈 find(넣을 자리): 그 자리를 품은 바꿈
          : (op.start < e && s < op.end);                                     // 범위끼리 겹침
      if (touch) { if (lo == null) lo = fs; hi = fs + len; }
      shift += len - (op.end - op.start);
    }
    if (lo == null) return [];
    const ids = new Set(rec.ids.map(Number));
    return changes.filter((c) => c.ref === rec.ref && ids.has(Number(c.id)) && c.start != null && c.start >= lo && (c.end ?? c.start) <= hi).map((c) => c.id);
  }

  // ───────── 제안 반영 기록·타이핑 알림 ─────────

  /** Rich proposals are applied to a private draft under the document lock. */
  async adoptFormat(id, pid, opts = {}, user, undo = false) {
    const svc = this.service; const name = user.name;
    const eng = fn => svc._engine(fn);
    const out = await svc._tx(id, async () => {
      const { doc, meta } = await svc._load(id);
      svc._assertCanEdit(user, meta);
      const p = svc._prop(meta, pid); this._checkAdoptable(p);
      if (p.type !== 'format' && !p.format && !p.runs) throw new ServiceError('BAD_TYPE', '서식을 포함한 제안만 이 경로로 반영할 수 있습니다.');
      let cr = this._adoptTarget(meta, name, opts.cid);
      this._checkRev(meta, name, revArg(opts.expectedDraftRev), cr);
      if (opts.expectedBaseVersion != null && Number(opts.expectedBaseVersion) !== (cr?.baseVersion ?? meta.version)) throw new ServiceError('STALE_BASE', '수정본 기준이 바뀌었습니다. 다시 여세요.', 409);
      const original = cr ? this.store.readDraft(id, cr.cid) : null;
      let work = original ? await HwpxDoc.load(original) : await doc.flattened({ tolerant: true });
      const adoption = adoptionsOf(p);
      let savedUndo = null;
      if (undo) {
        const u = p.draftFormatUndo?.[name];
        if (!cr || !u || adoption[name]?.cid !== cr.cid) throw new ServiceError('STATE', '취소할 서식 반영 기록이 없습니다.', 409);
        if (p.type !== 'format' && work.inspectFormatting(u.ref).fingerprint !== u.afterFingerprint) throw new ServiceError('FORMAT_CONFLICT', '반영한 문단이 다시 수정되었습니다. 현재 내용을 확인하세요.', 409);
        if (p.type === 'format') svc._undoFormatOnDocument(work, p, u.ref, u);
        else if (u.inserted) {
          const m = /^s(\d+)\/p(\d+)$/.exec(u.ref);
          eng(() => work.removeBodyParagraph(Number(m[1]), Number(m[2])));
        } else {
          eng(() => work.mergeParagraphText(u.ref, u.before.text, { author: name }));
          eng(() => work.undoFormatting({ ref: u.ref, before: u.before, afterFingerprint: work.inspectFormatting(u.ref).fingerprint }));
        }
        delete adoption[name];
        delete p.draftFormatUndo[name];
      } else {
        if (adoption[name]?.formatApplied) throw new ServiceError('STATE', '이 제안은 이미 내 수정본에 반영했습니다.', 409);
        const source = await doc.flattened({ tolerant: true });
        const propRef = svc._locate(doc, p, p.type === 'insert' ? 'afterRef' : 'ref');
        const map = this._refMap(doc.bodyEntries(), work.bodyEntries());
        const ref = map.ref(propRef);
        if (!ref || (p.type !== 'format' && work.formattingFingerprint(ref) !== doc.formattingFingerprint(propRef))) throw new ServiceError('FORMAT_CONFLICT', '수정본의 대상 문단이 달라졌습니다. 해당 문단의 수정 내용을 확인한 뒤 다시 요청하세요.', 409);
        const before = work.inspectFormatting(ref);
        if (p.type === 'format') eng(() => source.copyFormattingFrom(work, ref, propRef));
        let target = ref;
        if (p.type === 'insert') {
          const a = /^s(\d+)\/p(\d+)$/.exec(propRef); const b = /^s(\d+)\/p(\d+)$/.exec(ref);
          if (!a || !b) throw new ServiceError('BAD_REF', '본문 문단 뒤에만 추가할 수 있습니다.');
          const sr = eng(() => source.insertParagraphAfter(Number(a[1]), Number(a[2]), p.text, { author: name, format: p.format, runs: p.runs }));
          target = eng(() => work.insertParagraphAfter(Number(b[1]), Number(b[2]), p.text, { author: name }));
          eng(() => work.copyFormattingFrom(source, sr, target));
        } else {
          const range = p.find ? source.find(propRef, p.find, p.occurrence || 1) : { start: p.start ?? p.offset ?? 0, end: p.end ?? p.offset ?? 0 };
          if (p.type === 'format') {
            const expectedFingerprint = svc._formatExpectedFingerprint(source, p, propRef, range);
            eng(() => source.formatRange(propRef, { ...p.format, ...range, expectedFingerprint }));
          } else eng(() => source.replaceTracked(propRef, range.start, range.end, p.replace, { author: name, format: p.format, runs: p.runs }));
          eng(() => work.mergeParagraphText(ref, source.text(propRef, 'final'), { author: name }));
          eng(() => work.copyFormattingFrom(source, propRef, ref));
        }
        savedUndo = { ref: target, before, inserted: p.type === 'insert' };
        if (p.type === 'format') Object.assign(savedUndo, p.find ? source.find(propRef, p.find, p.occurrence || 1) : { start: p.start ?? 0, end: p.end ?? 0 }, { format: p.format });
      }
      work = await work.flattened({ tolerant: true });
      if (savedUndo) {
        savedUndo.after = work.inspectFormatting(savedUndo.ref);
        savedUndo.afterFingerprint = savedUndo.after.fingerprint;
        savedUndo.afterSemantic = work.formattingFingerprint(savedUndo.ref);
      }
      const baseDoc = cr ? await this._baseDoc(id, cr.baseVersion, meta, doc) : doc;
      const { hunks, unsupported } = await this._diff(baseDoc, work);
      const at = nowIso();
      if (!cr) cr = this._newCr(meta, name, meta.version, at);
      this._staleApprovals(cr, cr.hunks, hunks, {}, { by: name, at });
      this._rethread(cr, cr.hunks, hunks);
      Object.assign(cr, { hunks, unsupported, stats: hunkStats(hunks), updatedAt: at });
      cr.rev = this._bumpRev(meta, name, at);
      if (savedUndo) {
        (p.draftFormatUndo ||= {})[name] = savedUndo;
        adoption[name] = { at, cid: cr.cid, formatApplied: true, canUndo: true };
        if (!cr.adopted.includes(p.pid)) cr.adopted.push(p.pid);
      } else cr.adopted = cr.adopted.filter(x => x !== p.pid);
      writeAdoptions(p, adoption, name);
      this.store.writeDraft(id, cr.cid, Buffer.from(await work.save()));
      this.store.log(meta, name, undo ? 'proposal.unadopt-format' : 'proposal.adopt-format', `#${p.pid}`);
      this.store.saveMeta(meta);
      const [view] = await this._views(meta, [cr], user, { cur: doc });
      return { cr: view, proposal: structuredClone(p), formatting: true, rev: cr.rev, rid: p.rid };
    });
    this._ws(id, 'draft', out.cr, name, { rev: out.rev, formatting: true });
    this.hub.broadcast(id, { type: 'proposal', action: undo ? 'unadopted' : 'adopted', pid: out.proposal.pid, by: name, cid: out.cr.cid });
    await this._refreshRequests(id, out.rid == null ? new Set() : new Set([out.rid]), name, '서식 제안 수정본 반영 기록 갱신');
    return out;
  }

  /**
   * POST /proposals/:pid/adopt { cid? }: 제안을 내 수정본에 반영했다고 기록(편집기 반영은 플러그인이 한다).
   * 변경 요청이 아직 없으면(자동 저장 전) 제안에만 적어 두고, 변경 요청이 생길 때 묶는다. 상태는 대기 그대로 → { proposal, cr }
   * 기록은 사람마다(p.adoptedBy[이름] = { at, cid }), p.adopted = { by, at, cid } 는 방금 반영한 사람(예전 모양).
   * 서비스 _tx 로 한다(§9.5 — 문서 큐는 같음): 요청에 딸린 제안이면 그 요청을 다시 센다(해결·작업 기록 메모) + WS request update
   */
  async adopt(id, pid, { cid } = {}, user) {
    const name = user.name; const svc = this.service;
    const out = await svc._tx(id, async () => {
      const { doc, meta } = await svc._load(id);
      svc._assertCanEdit(user, meta);   // 내 수정본에 반영 = 수정본을 고치는 일(V4 §4.3)
      const ctx = svc._ctx(id, doc, meta, name);
      const p = svc._prop(meta, pid);
      this._checkAdoptable(p);
      const cr = this._adoptTarget(meta, name, cid);
      svc._adoptCore(ctx, p, cr);
      const version = await svc._finish(ctx, `제안 ${p.pid} 수정본에 반영(기록)`);
      const view = cr ? (await this._views(meta, [cr], user, { cur: ctx.doc }))[0] : null;
      return { proposal: structuredClone(p), view, version, rid: p.rid ?? null, owner: p.rid != null ? meta.requests.find((r) => r.rid === p.rid)?.by ?? null : null, resolved: ctx.resolvedNow.some((x) => x.rid === p.rid) };
    });
    this.hub.broadcast(id, { type: 'proposal', action: 'adopted', pid: out.proposal.pid, by: name, cid: out.view?.cid ?? null });
    if (out.rid != null) this.hub.broadcast(id, { type: 'request', action: 'update', rid: out.rid, by: name, owner: out.owner, version: out.version, ...(out.resolved ? { resolved: true } : {}) });
    return { proposal: out.proposal, cr: out.view };
  }

  /** POST /editing { ref|null }: 타이핑 중 문단 알림(저장 없음) → WS { type:'editing', user, ref } */
  editing(id, ref, user) {
    this._meta(id);
    const r = ref == null || ref === '' ? null : ref;
    if (r != null && (typeof r !== 'string' || r.length > 64 || !REF_RE.test(r))) throw new ServiceError('BAD_REF', '문단 주소(ref)가 올바르지 않습니다');
    this.hub.broadcast(id, { type: 'editing', user: user.name, ref: r });
    return { ok: true };
  }

  // ───────── 한글로 저장(§3.7) ─────────

  /**
   * 기준 문서 사본(tracked: 변경 추적 그대로, final: 최종본)에 draft·open 변경 요청의 덩어리마다 검토 메모를 더한다.
   * 의견 스레드: 덩어리 스레드는 그 덩어리 메모에, 문단에 단 의견(덩어리가 없어진 스레드 등)은 그 문단 덩어리 메모에 — 그 문단에 덩어리 메모가
   * 없으면 그 문단에 의견 메모 하나(renderCrNoteMemo), 자리 없는 전체 의견은 첫 덩어리 메모에.
   * 원본·버전·메모리 문서는 그대로(커밋하지 않음). 메모 시각은 그 변경 요청의 updatedAt — 같은 상태면 몇 번 내려받아도 같은 메모.
   * opts.reviews = false 면 검토 메모를 넣지 않는다(실시간 문서의 한글로 저장 — 문서의 메모만, V4 §3).
   * opts.strict = true 면 최종본을 엄격히 만든다(수락할 수 없는 변경이 하나라도 있으면 409 CANNOT_FLATTEN — 한글로 저장 kind=export 가
   * 그때 변경 추적 포함으로 바꿔 낸다). 기본(tolerant)은 그런 변경을 건너뛰고 만든다.
   * → { bytes, version, memos(더한 메모 수), fileName, title }
   */
  async exportWithReviews(id, kind = 'tracked', { reviews = true, strict = false } = {}) {
    if (kind !== 'tracked' && kind !== 'final') throw new ServiceError('BAD_KIND', `검토 메모는 tracked·final 에만 넣습니다: ${kind}`);
    // 커밋된 상태(meta + current.hwpx)를 문서 큐 안에서 함께 읽는다 — 진행 중인 _tx 의 고친 메모리 문서를 쓰지 않는다
    const snap = await this.store.withDoc(id, async () => ({ meta: this._meta(id), bytes: this.store.currentBytes(id) }));
    const { meta } = snap;
    const doc = await HwpxDoc.load(snap.bytes);
    // 덩어리가 없어도 의견이 남은 진행 중 변경 요청(작성자가 다 되돌린 open 등)은 문단에 단 의견을 그 문단에 남긴다
    const list = !reviews ? [] : meta.changeRequests.map((c) => this._norm(c)).filter((c) => ACTIVE.has(c.status) && (c.hunks.length || c.threads.length));
    const views = await this._views(meta, list, null, { cur: doc });
    let out = doc;
    if (kind === 'final') {
      try { out = await doc.flattened(strict ? undefined : { tolerant: true }); } catch (e) {
        if (e instanceof EngineError) throw new ServiceError('CANNOT_FLATTEN', `최종본을 만들지 못했습니다(한글에서 변경 추적을 정리해 주세요): ${e.message}`, 409);
        throw e;
      }
    }
    const items = [];
    for (const v of views) {
      const placed = v.hunks.filter((h) => h.curRef && h.state !== 'gone');
      const hids = new Set(placed.map((h) => h.hid));
      // 의견 스레드 나누기: 덩어리 스레드 → 그 덩어리 메모 / 문단에 단 의견(hid 없음 — 덩어리가 없어진 스레드 등, 지금 자리 curRef 가 있음)
      // → 그 문단의 덩어리 메모, 없으면 그 문단에 의견 메모 하나 / 자리 없는 전체 의견(지금 문서에 없는 덩어리의 의견 포함) → 첫 덩어리 메모
      const byHid = new Map(); const atRef = new Map(); const general = [];
      const add = (m, k, t) => { if (!m.has(k)) m.set(k, []); m.get(k).push(t); };
      for (const t of v.threads) {
        if (t.hid && hids.has(t.hid)) add(byHid, t.hid, t);
        else if (t.curRef) add(atRef, t.curRef, t);
        else general.push(t);
      }
      const notes = v.reviews.filter((r) => r.body && r.verdict !== 'approve').map((r) => `${r.by}(${VERDICTS[r.verdict] || r.verdict}): ${MT.clip(r.body, 40)}`);
      const date = new Date(v.updatedAt || v.createdAt || Date.now());
      const lenOf = (ref) => { try { return cpLen(out.text(ref, 'final')); } catch { return null; } };
      let k = 0;
      for (const h of placed) {
        const len = lenOf(h.curRef); if (len == null) continue;
        const here = atRef.get(h.curRef) || []; atRef.delete(h.curRef);
        const threads = [...(byHid.get(h.hid) || []), ...here, ...(k === 0 ? general : [])];
        const text = MT.renderCrHunkMemo({ cr: v, hunk: h, threads, notes: k === 0 ? notes : [], approvals: v.approvals, changesRequested: v.changesRequested });
        items.push({ ref: h.curRef, start: 0, end: len, author: v.author, text, date });
        k++;
      }
      for (const [ref, threads] of atRef) {
        const len = lenOf(ref); if (len == null) continue;
        items.push({ ref, start: 0, end: len, author: v.author, text: renderCrNoteMemo(v, threads), date });
      }
    }
    // 깊은 중첩 문단(표 칸·각주·머리말 …) 메모부터 단다: 문단에 메모를 달면 메모 본문 줄이 그 문단의 중첩 문단이 되어
    // 그 문단 안 중첩 번호 n 이 밀린다(글이 표 앞에 있는 문단 등 — addMemos 설명). 메모는 자기 아래 번호만 밀므로 자손 먼저면 충분하다
    // (같은 깊이끼리는 원래 차례 — sort 는 안정)
    items.sort((a, b) => nestDepth(b.ref) - nestDepth(a.ref));
    const ids = this._addMemos(out, items);
    const bytes = await out.save();
    return { bytes, version: meta.version, memos: ids.length, fileName: `${meta.title || 'document'}${kind === 'final' ? '_최종' : '_검토본'}.hwpx`, title: meta.title || 'document' };
  }

  /** 메모 여러 개: 엔진 addMemos(구역마다 한 번 다시 읽기, §4.2)가 있으면 그것, 없으면 하나씩 */
  _addMemos(doc, items) {
    if (!items.length) return [];
    try {
      if (typeof doc.addMemos === 'function') return doc.addMemos(items);
      return items.map((it) => doc.addMemo(it.ref, { start: it.start, end: it.end, author: it.author, text: it.text, date: it.date }));
    } catch (e) {
      if (e instanceof EngineError) throw new ServiceError(e.code, `검토 메모를 넣지 못했습니다: ${e.message}`, 400);
      throw e;
    }
  }
}
