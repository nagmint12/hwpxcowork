// 검토 표시(메모·제안·변경·남의 수정 중)의 범위 계산과 studio 플러그인용 Annotations 자료 — 순수 모듈(Vue·DOM 없음).
// 검토 보기(web/review.js)·호스트·Node 시험·studio cowork 플러그인 번들이 같이 쓴다.
// 위치 단위는 엔진 ref(s0/p12, 표 칸 s0/p3/n8) + 최종본 코드포인트 offset(V3_SPEC §0 원칙 3).
// 문서 모양은 geo 로 받는다: { textOf(ref) → 글, length(ref) → 코드포인트 수, container(ref) → 묶음 키, refsBetween(a, b) → [ref…] }
//  - 검토 보기: rhwp 지도(refmap)로 만든 geo(review.js)
//  - 그 밖(호스트·플러그인·시험): paragraphGeo(엔진 문단 목록 — GET /paragraphs 또는 setBase 의 paragraphs)

const cpLen = (s) => Array.from(String(s ?? '')).length;
const clip = (s, n = 40) => { const a = Array.from(String(s ?? '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
const arr = (x) => (Array.isArray(x) ? x : []);

/** 엔진 문단의 묶음 키: 본문은 구역, 중첩은 부모 문단 + 표 칸(표·행·열) 또는 담는 요소 — 선택·여러 문단 범위는 한 묶음 안에서만 */
function containerKey(p) {
  const m = /^s(\d+)\/p\d+$/.exec(p.ref);
  if (m && !p.parent) return `b:${m[1]}`;
  const parent = p.parent || String(p.ref).replace(/\/n\d+$/, '');
  const c = p.cell;
  return c ? `c:${parent}|${c.table}|${c.row}|${c.col}` : `c:${parent}|${p.container || ''}`;
}

/**
 * 엔진 문단 목록으로 만든 geo(rhwp 지도가 없을 때).
 * @param paragraphs [{ ref, text, parent?, cell?, container?, where? }] — 최종본 글
 */
export function paragraphGeo(paragraphs) {
  const byRef = new Map(); const keyOf = new Map(); const groups = new Map();
  for (const p of arr(paragraphs)) {
    if (!p || typeof p.ref !== 'string' || byRef.has(p.ref) || p.where === '메모') continue;
    byRef.set(p.ref, p);
    const k = containerKey(p); keyOf.set(p.ref, k);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p.ref);
  }
  const textOf = (ref) => byRef.get(ref)?.text ?? '';
  return {
    textOf,
    length: (ref) => cpLen(textOf(ref)),
    container: (ref) => keyOf.get(ref) ?? null,
    /** 같은 묶음의 [a..b] 문단 ref(문서 순서). 묶음이 다르거나 모르는 ref 면 [a] — refmap 과 같은 규칙 */
    refsBetween(a, b) {
      const k = keyOf.get(a); if (k == null || k !== keyOf.get(b)) return [a];
      const list = groups.get(k); const i = list.indexOf(a); const j = list.indexOf(b);
      return list.slice(Math.min(i, j), Math.max(i, j) + 1);
    },
  };
}

// ───────── 범위 계산(v0.2 검토 보기에서 옮김) ─────────

/**
 * 메모 범위. 한 문단 메모는 { start, end }, 여러 문단 메모(end 없음 + endRef)는 같은 묶음일 때만 endRef 끝까지,
 * 묶음이 다르면 시작 문단 끝까지. (geo.container 가 없으면 같은 묶음으로 본다 — v0.2 의 지도 없을 때와 같다)
 */
export function memoRange(m, geo) {
  const same = !!m.endRef && geo.container?.(m.endRef) === geo.container?.(m.ref);
  const end = m.end != null ? m.end : geo.length(same ? m.endRef : m.ref);
  const endRef = m.end == null && same ? m.endRef : m.ref;
  return { ref: m.ref, start: m.start || 0, end, endRef };
}

/** 문단 글에서 find 의 occ 번째 자리(겹쳐도 셈). find 가 비면 문단 끝 한 점(point: 빈 칸 채우기). 못 찾으면 null */
export function findRange(ref, find, occ, geo) {
  const t = geo.textOf(ref);
  if (!find) return { ref, start: cpLen(t), end: cpLen(t), endRef: ref, point: true };
  let at = -1; let from = 0;
  for (let k = 0; k < (occ || 1); k++) { at = t.indexOf(find, from); if (at < 0) break; from = at + 1; }
  if (at < 0) return null;
  const s = cpLen(t.slice(0, at));
  return { ref, start: s, end: s + cpLen(find), endRef: ref };
}

/**
 * 바꿈 제안(replace)의 범위: 제안 메모가 있으면 그 범위, 대기 중이고 start/end 가 있으면 그것, 아니면 find 로 찾기.
 * 문단 추가·표 제안은 null.
 * @param memosById Map(메모 id → 메모)
 */
export function proposalRange(p, memosById, geo) {
  if (!['replace', 'format'].includes(p.type || 'replace')) return null;
  if (p.memoId && memosById?.has(p.memoId)) return memoRange(memosById.get(p.memoId), geo);
  if (p.start != null && p.end != null && p.status === 'pending') return { ref: p.ref, start: p.start, end: p.end, endRef: p.ref };
  return findRange(p.ref, p.find, p.occurrence, geo);
}

/**
 * 변경 추적의 누르기 범위: 삽입은 그 글, 삭제(와 끝이 다른 문단인 삽입)는 그 자리 앞뒤 한 글자.
 * 개체 변경(kind 'object' — 표·그림 넣음/지움)은 글 범위가 없으니(start = end) 그 자리 앞뒤 한 글자, 글과 섞인 삽입('mixed')은 넣은 글이 있으면 그 글.
 * 문단 나눔 변경(kind 'para' — 2026-10-30, start = end = 그 문단 끝 자리)은 나눔 바로 앞 한 글자(빈 문단이면 그 자리)
 */
export function changeRange(c) {
  if (c.kind === 'para') {
    // 한/글의 '글과 문단 나눔 넣음'(넣은 글이 있음)은 그 글
    if (c.type === 'Insert' && c.end > c.start) return { ref: c.ref, start: c.start, end: c.end, endRef: c.ref };
    const at = c.start ?? 0;
    return { ref: c.ref, start: Math.max(0, at - 1), end: Math.max(at, 1), endRef: c.ref };
  }
  const objectOnly = c.kind === 'object' || (c.kind && !(c.end > c.start));
  if (c.type === 'Insert' && c.end != null && !objectOnly) return { ref: c.ref, start: c.start, end: c.end, endRef: c.ref };
  const at = c.start ?? 0;
  return { ref: c.ref, start: Math.max(0, at - 1), end: at + 1, endRef: c.ref };
}

/** 적용된 제안이 만든 변경들(changeIds) — 변경 목록 순서 그대로 */
export function proposalChanges(p, changes) {
  const ids = new Set(arr(p.changeIds).map(Number));
  return arr(changes).filter((c) => ids.has(Number(c.id)));
}

/** 범위 rg 가 (ref, off) 자리를 덮는가(양 끝 포함). 여러 문단 범위는 geo.refsBetween 으로 사이 문단까지 */
export function covers(rg, ref, off, geo) {
  if (!rg) return false;
  const endRef = rg.endRef ?? rg.ref;
  if (rg.ref === endRef) return ref === rg.ref && off >= rg.start && off <= rg.end;
  const refs = geo?.refsBetween ? geo.refsBetween(rg.ref, endRef) : [rg.ref];
  const i = refs.indexOf(ref); if (i < 0) return false;
  if (i === 0) return off >= rg.start;
  if (i === refs.length - 1) return off <= rg.end;
  return true;
}

// ───────── 사람 색 ─────────

/** 남의 색 8가지(나는 ME_COLOR 파랑 고정이라 파랑은 넣지 않는다) */
export const PERSON_COLORS = Object.freeze(['#c2255c', '#0c8599', '#5c940d', '#e8590c', '#862e9c', '#087f5b', '#9c6500', '#495057']);
export const ME_COLOR = '#1c7ed6';
// 색 해시용: '홍길동(Claude)' 처럼 끝의 (에이전트) 는 그 사람 색으로 본다
const personOf = (name) => String(name ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();
const nameOf = (me) => (typeof me === 'string' ? me : me?.name);
// 나: 내 이름 그대로이거나 '내 이름(에이전트)' — store 의 '내 것' 판정(by === 나 || by.startsWith('나('))·서버 소유자(사람 이름 그대로)와 같은 규칙.
// 끝 괄호를 떼고 비교하지 않는다('김(A)'·'김(B)' 는 다른 사람)
const isMe = (name, me) => { const m = String(nameOf(me) ?? ''); const n = String(name ?? ''); return !!m && (n === m || n.startsWith(`${m}(`)); };

/**
 * 사람 색: 이름 해시(FNV-1a, 코드포인트 + murmur3 마무리 섞기) → 8색 중 하나, 나(me) = 파랑.
 * 규칙을 바꾸면 사람 색이 판마다 달라지므로 tests/annotations.test.mjs 에 몇 개를 고정해 두었다.
 * @param me 내 이름 또는 { name }
 */
export function colorForUser(name, me) {
  if (isMe(name, me)) return ME_COLOR;
  let h = 0x811c9dc5;
  for (const ch of personOf(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return PERSON_COLORS[(h >>> 0) % PERSON_COLORS.length];
}

// ───────── Annotations(V3_SPEC §1.3) ─────────

const MEMO_KINDS = new Set(['request', 'proposal', 'comment', 'review']);

/** 제안 이름표: 제안 #7 · 안 2 · 홍길동(Claude) */
export function proposalLabel(p) {
  return [`제안 #${p.pid}`, p.option ? `안 ${p.option}` : '', p.by || ''].filter(Boolean).join(' · ');
}

function memoLabel(m, kind) {
  if (kind === 'request') return `AI 작업 #${m.link.rid}`;
  if (kind === 'comment') return `AI 의견 #${m.link.rid}`;
  if (kind === 'proposal') return `제안 #${m.link.pid}`;
  return m.author || '메모';
}

/** 남의 수정 중 덩어리 → { hid, type, ref(지금 기준 문서 ref), afterRef?, preview } */
function hunkOut(h) {
  const o = { hid: String(h.hid ?? ''), type: h.type, ref: h.curRef ?? h.ref ?? h.afterRef ?? null, preview: h.preview ?? (h.type === 'object' && h.objectSummary ? clip(h.objectSummary, 80) : clip(h.type === 'delete' ? h.baseText : h.newText, 80)) };
  if (h.type === 'insert') o.afterRef = h.curRef ?? h.afterRef ?? null;
  return o;
}

/** 남의 수정 중: state.drafts(이미 Annotations 모양)를 그대로, 없으면 state.crs(변경 요청 목록 — draft·open 이고 덩어리가 있는 것)로 */
function draftsOf(state, me) {
  if (Array.isArray(state.drafts)) {
    return state.drafts.filter((x) => x && !isMe(x.user, me))
      .map((x) => ({ cid: x.cid, user: x.user, color: x.color || colorForUser(x.user, me), status: x.status, hunks: arr(x.hunks).map(hunkOut) }));
  }
  return arr(state.crs).filter((cr) => cr && (cr.status === 'draft' || cr.status === 'open') && !isMe(cr.author, me))
    .map((cr) => ({ cid: cr.cid, user: cr.author, color: colorForUser(cr.author, me), status: cr.status, hunks: arr(cr.hunks).filter((h) => h && h.state !== 'gone').map(hunkOut) }));
}

/** 타이핑 중(남): 배열 [{ user, ref, color? }] 이나 store 의 { 사람 → ref }(객체·Map) 둘 다 받는다 */
function editingOf(state, me) {
  const e = state.editing;
  const pairs = e instanceof Map ? [...e] : e && typeof e === 'object' && !Array.isArray(e) ? Object.entries(e) : null;
  const list = Array.isArray(e) ? e : pairs ? pairs.map(([user, ref]) => ({ user, ref })) : [];
  return list.filter((x) => x && x.ref && !isMe(x.user, me)).map((x) => ({ user: x.user, color: x.color || colorForUser(x.user, me), ref: x.ref }));
}

/**
 * store 상태 → 플러그인 setAnnotations 자료(V3_SPEC §1.3 Annotations). 결과는 JSON 그대로 보낼 수 있다.
 * - memos: 모든 메모. kind = 연결(link.type: request·proposal·comment·review) 아니면 'memo', label = 'AI 작업 #3'·'AI 의견 #3'·'제안 #7'·작성자,
 *   status = 연결된 요청·제안의 상태, color = 작성자 색, resolved = 스레드 해결 여부, rid = AI 작업·AI 의견 메모의 요청 번호.
 *   AI 작업 메모는 opts.requestView(rid) → { resolved?, open? } 를 주면(v0.3.1 §9.7 — 호스트의 '내 눈의 진행') 해결이면 resolved: true
 *   (해결된 메모처럼 숨김), open = 내가 한 번에 반영할 수 있는 남은 수(> 0 일 때만 — 우클릭 '남은 제안 모두 반영(n)'), phase = 진행 단계(있으면)를 싣는다.
 * - proposals: 대기 제안(바꿈은 범위 — 못 찾으면 find·occurrence 만, 문단 추가·표는 afterRef 문단 전체) +
 *   적용된 제안은 그 변경 자리마다 한 항목(status 'applied' — 그리지 않고 우클릭 메뉴용, v0.2 와 같다). 거절·복구된 제안은 뺀다.
 * - changes: 기준 문서 변경 추적(최종본 기준 — 삭제는 start = end, 다음 문단까지 이어진 삽입은 문단 끝까지).
 * - drafts·editing: 있으면(state.drafts 또는 state.crs, state.editing) 옮긴다. 내 것(opts.me)은 뺀다.
 * - v0.4(docs/V4_SPEC.md §4.1·§5): opts.proposalVisible(p) 가 false 인 제안은 뺀다('간단히' 보기의 남의 AI 작업 제안 — 강조·우클릭 항목 없음).
 *   opts.adoptLabel 을 주면 대기 제안 항목에 그 이름(adoptLabel)을 싣는다 — 우클릭 '반영' 항목 이름(실시간 문서 '문서에 반영', menumodel.js)
 * @param state { memos, proposals, changes, requests, paragraphs?, crs?, drafts?, editing?, focus? }
 * @param opts { me?: 이름|{name}, geo?: 문서 모양(기본 paragraphGeo(state.paragraphs)), flash?: Range|null, requestView?: (rid) → { resolved?, open? }|null,
 *   proposalVisible?: (p) → boolean, adoptLabel?: string }
 */
export function buildAnnotations(state = {}, opts = {}) {
  const geo = opts.geo || paragraphGeo(state.paragraphs);
  const me = opts.me ?? null;
  const visible = typeof opts.proposalVisible === 'function' ? opts.proposalVisible : null;
  const adoptLabel = typeof opts.adoptLabel === 'string' && opts.adoptLabel ? opts.adoptLabel : null;
  const memos = arr(state.memos); const changes = arr(state.changes);
  const proposals = arr(state.proposals).filter((p) => { if (!visible || !p) return true; try { return visible(p) !== false; } catch { return true; } });
  const reqById = new Map(arr(state.requests).map((r) => [Number(r.rid), r]));
  const propById = new Map(proposals.map((p) => [Number(p.pid), p]));
  const memosById = new Map(memos.map((m) => [m.id, m]));
  const reqView = typeof opts.requestView === 'function' ? opts.requestView : null;

  const outMemos = memos.map((m) => {
    const kind = MEMO_KINDS.has(m.link?.type) ? m.link.type : 'memo';
    const r = memoRange(m, geo);
    const o = { id: String(m.id), ref: r.ref, start: r.start, end: r.end, endRef: r.endRef, kind, label: memoLabel(m, kind), author: m.author || '', color: colorForUser(m.author, me), resolved: !!(m.thread?.resolved || m.resolved) };
    const status = kind === 'request' ? reqById.get(Number(m.link.rid))?.status : kind === 'proposal' ? (propById.get(Number(m.link.pid))?.status ?? m.proposal?.status) : null;
    if (status) o.status = status;
    if (kind === 'request' || kind === 'comment') {
      const rid = Number(m.link.rid);
      if (Number.isFinite(rid)) o.rid = rid;
      if (kind === 'request' && reqView && Number.isFinite(rid)) {
        let v = null;
        try { v = reqView(rid); } catch { v = null; }
        // 요청 메모의 해결 = 요청 해결(내 눈의 진행)만 — 옛 스레드 해결 표시(v0.3.0 [해결])는 보지 않는다(다시 열린 요청이 숨지 않게).
        // 진행을 모르면(없는 요청·묻다가 던짐) 스레드 표시 그대로
        if (v) o.resolved = !!v.resolved;
        const n = Number(v?.open) || 0;
        if (n > 0) o.open = n;
        // 진행 단계(호스트가 셈 — web/ui.js requestPhase): wait·run·act·hold·ok·fail·off → 편집기 강조 cw-ph-…
        if (typeof v?.phase === 'string' && v.phase) o.phase = v.phase;
      }
    }
    return o;
  });

  const outProps = [];
  for (const p of proposals) {
    const type = p.type || 'replace'; const pid = Number(p.pid); const label = proposalLabel(p);
    if (p.status === 'applied') {
      for (const c of proposalChanges(p, changes)) { const r = changeRange(c); outProps.push({ pid, type, ref: r.ref, start: r.start, end: r.end, status: 'applied', label }); }
      continue;
    }
    if (p.status !== 'pending') continue;
    if (type !== 'replace' && type !== 'format') {
      const after = p.afterRef || p.ref;
      const o = { pid, type, ref: after, afterRef: after, start: 0, end: geo.length(after), status: p.status, label };
      if (adoptLabel) o.adoptLabel = adoptLabel;
      outProps.push(o);
      continue;
    }
    const o = { pid, type, ref: p.ref, find: p.find ?? '', occurrence: p.occurrence || 1, status: p.status, label };
    if (adoptLabel) o.adoptLabel = adoptLabel;
    const r = proposalRange(p, memosById, geo);
    if (r) { o.ref = r.ref; o.start = r.start; o.end = r.end; if (r.endRef !== r.ref) o.endRef = r.endRef; }
    outProps.push(o);
  }

  const outChanges = []; const seenIds = new Set();
  for (const c of changes) {
    if (c.type !== 'Insert' && c.type !== 'Delete') continue;
    // 같은 번호가 두 문단에(가른 문단에 걸친 넣음 — 2026-10-30) 있으면 처음 것만(편집기 표지 열쇠가 번호라 겹친다)
    if (seenIds.has(Number(c.id))) continue; seenIds.add(Number(c.id));
    // 추적으로 지운 표·그림 안(숨은 문단 '…/dK' — 편집기에 없음)의 변경은 그리지 않는다(menumodel visibleChanges 와 같은 규칙)
    if (/\/d\d+(?:\/|$)/.test(String(c.ref || ''))) continue;
    const start = c.start ?? 0;
    const end = c.end != null ? c.end : c.type === 'Insert' ? geo.length(c.ref) : start;
    const o = { id: Number(c.id), type: c.type, ref: c.ref, start, end, author: c.author || '' };
    if (typeof c.text === 'string') o.text = c.text;
    // 문단 나눔 변경(kind 'para' — 폭 0): 편집기 지운 글 표지의 설명에 '¶'(넣은 나눔은 다음 문단의 넣은 글로 보인다)
    if (c.kind === 'para' || c.paraEnd) o.text = `${c.text ?? ''}¶`;
    outChanges.push(o);
  }

  return {
    memos: outMemos, proposals: outProps, changes: outChanges,
    drafts: draftsOf(state, me), editing: editingOf(state, me),
    flash: opts.flash !== undefined ? opts.flash : (state.focus?.flash ?? null),
  };
}
