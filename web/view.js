// v0.4(docs/V4_SPEC.md §1·§2.4·§5) 화면 규칙 — 순수 모듈(Vue·DOM 없음, Node 시험 tests/view.test.mjs).
//  - 문서 설정 모양·기본값(normSettings)·수정 권한(canEditWith — 서버 canEdit 과 같은 규칙, WS doc settings 를 받은 즉시 화면이 쓴다)
//  - 편집기 방식(editorMode: live 실시간 · follow 읽기 전용 · review 승인 방식)
//  - 보기 '간단히'·'자세히'(localStorage hwpx.view, 기본 간단히): 무엇을 숨기나 — 남의 AI 작업 제안(requestHidden·proposalHidden),
//    패널 탭(panelTabIds), 검토 탭 거르기(reviewFilterIds·filterPass), 남의 '수정 중' 덩어리를 변경 요청마다 한 줄(collapseDrafts),
//    AI 작업 한 줄 요약 카드 글(summaryHead·summaryChip)
//  - 이력 탭의 실시간 편집 묶음(groupHistory·liveGroupLabel)
//  - 오른쪽 창(패널) 크기·접기(localStorage hwpx.panel — 넓은 창은 폭·고정/접힘, 좁은 창은 높이 비율·접기)·문서 옆 메모(보임·숨김, 자리·폭, 끌어 옮긴 자리 hwpx.memopos.*),
//    휴대전화 폭의 편집기 도구 막대(hwpx.tools)
//  - 상단 실시간 칩(liveChip) · 한글로 저장 단추 설명(exportTip)
//  - ⚙ 문서 설정 창 모델(SETTING_FIELDS·settingsForm·settingsPatch·editorChoices·settingsWarning)

// ───────── 보기 ─────────
export const VIEW_KEY = 'hwpx.view';
export const VIEWS = Object.freeze(['simple', 'detail']);
export const VIEW_LABEL = Object.freeze({ simple: '간단히', detail: '자세히' });
const storageOf = (st) => (st !== undefined ? st : (typeof localStorage !== 'undefined' ? localStorage : null));
/** 이 브라우저의 보기(없거나 모르는 값·읽기 실패면 '간단히') */
export function readView(storage) {
  try { return storageOf(storage)?.getItem(VIEW_KEY) === 'detail' ? 'detail' : 'simple'; } catch { return 'simple'; }
}
/** 보기를 적어 둔다(실패해도 화면은 그대로 — 사생활 창 등) → 적었으면 true */
export function writeView(v, storage) {
  try { const s = storageOf(storage); if (!s) return false; s.setItem(VIEW_KEY, v === 'detail' ? 'detail' : 'simple'); return true; } catch { return false; }
}

// ───────── 오른쪽 창(패널)·문서 옆 메모 — 경계선 끌기·접기(localStorage hwpx.panel) ─────────
// 넓은 창: 편집기(메모는 쪽 오른쪽 여백 위에 겹쳐 — 한/글처럼) | 패널 w px. pin false 면 패널을 접고 꼭지만 남긴다(꼭지에 마우스를 올리면 잠깐 펼침 — app.js).
// 좁은 창(900px 이하 — 패널이 아래로): 패널 높이 = 배치 높이 × h, min 이면 탭 줄만 남기고 접음.
// 메모(rmode): 'margin' 쪽 옆에 보임(900px 넘으면) · 'off' 숨김(패널 검토 탭). 옛 'column'(오른쪽 칸)은 'margin' 으로 읽는다
export const PANEL_KEY = 'hwpx.panel';
export const PANEL = Object.freeze({ w: 360, wMin: 280, wFold: 160, editorMin: 360, h: 0.35, hMin: 0.15, hMax: 0.8, foldPx: 72, r: 300, rMin: 180, rMax: 560, overMin: 150, open: 280, edit: 520 });
export const RAIL_MODES = Object.freeze(['margin', 'off']);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
/** 패널 폭: 최소 wMin, 편집기가 editorMin 아래로 줄지 않게(배치 폭을 모르면 위 한계 없음) */
export function clampPanelW(w, layoutW) {
  const max = layoutW > 0 ? Math.max(PANEL.wMin, layoutW - PANEL.editorMin) : Infinity;
  return Math.round(Math.min(Math.max(num(w, PANEL.w), PANEL.wMin), max));
}
/** 패널 끌기를 놓은 폭(px) → { w, pin }: wFold 보다 좁으면 접음(폭은 끌기 전 값 — 다시 펴면 그 폭) */
export function panelWidthFrom(px, layoutW, prevW = PANEL.w) {
  if (px < PANEL.wFold) return { w: clampPanelW(prevW), pin: false };
  return { w: clampPanelW(px, layoutW), pin: true };
}
/** 메모 칸 폭: rMin~rMax */
export const clampRailW = (r) => Math.round(Math.min(Math.max(num(r, PANEL.r), PANEL.rMin), PANEL.rMax));
/**
 * 문서 옆 메모 자리(편집기 iframe 안 좌표): 겹침 층 = 문서 스크롤 칸(편집기 도구 막대 아래 ~ 스크롤바 앞), 메모 칸 = 보이는 쪽 오른쪽 끝 + 8px 부터 r 폭.
 * 쪽 옆 빈 곳이 r 보다 좁으면 빈 곳만큼, overMin 보다 좁으면 스크롤바 앞에 붙여 쪽 오른쪽을 조금 덮는다
 * @param m { width(스크롤 칸 안 폭), page(보이는 쪽 오른쪽 끝 x — 스크롤 칸 왼쪽에서, 모르면 null), top, bottom, left(스크롤 칸 왼쪽 — 세로 눈금자), right(스크롤바 폭),
 *   reserve(오른쪽 끝에 비워 둘 폭 — 패널 꼭지) }
 * @param r 메모 칸 폭 설정 → { top, bottom, left, right, col: { left, width, limit } } (col 은 겹침 층 안 좌표, limit = 메모가 넘지 않을 오른쪽 끝)
 */
export function marginBox(m, r = PANEL.r) {
  const W = Math.max(0, Math.round(Number(m?.width) || 0));
  const limit = Math.max(0, W - Math.max(0, Math.round(Number(m?.reserve) || 0)));
  const page = m?.page == null || !Number.isFinite(Number(m.page)) ? null : Math.round(Number(m.page));
  const gap = page == null ? 0 : limit - page - 16;   // 쪽과 8px, 오른쪽 끝과 8px 띄움
  const width = Math.round(Math.max(PANEL.overMin, Math.min(clampRailW(r), gap)));
  const left = gap >= width ? page + 8 : Math.max(0, limit - 4 - width);
  const px = (v) => Math.max(0, Math.round(Number(v) || 0));
  return { top: px(m?.top), bottom: px(m?.bottom), left: px(m?.left), right: px(m?.right), col: { left, width, limit } };
}
/** 문서 옆 메모가 지금 보이나(= s.railOpen): 좁은 창(패널이 아래로)·숨김이면 아님 */
export function railVisible(rmode, { stacked = false } = {}) {
  return !stacked && rmode !== 'off';
}
/**
 * 메모 한 칸의 폭(겹침 층 W 안): 보통은 메모 칸 폭, 고른 것·입력 칸이 열린 것은 open(280)px 이상, 고치는 중이면 edit(520)px 까지 넓게(층보다 넓지 않게)
 * @param state '' | 'open' | 'edit'
 */
export function memoWidth(colW, state, W) {
  const c = Math.max(1, Math.round(Number(colW) || PANEL.overMin));
  const room = Number(W) > 0 ? Math.max(c, Math.round(W) - 16) : Infinity;
  if (state === 'edit') return Math.max(c, Math.min(PANEL.edit, room));
  if (state === 'open') return Math.max(c, Math.min(PANEL.open, room));
  return c;
}
/** 메모 칸 왼쪽 x: 메모 칸에서 시작하고, 넓힌 메모가 층 오른쪽을 넘으면 왼쪽으로 민다 */
export function memoLeft(colLeft, width, W) {
  const l = Math.round(Number(colLeft) || 0);
  return Number(W) > 0 && l + width > W - 4 ? Math.max(0, Math.round(W - 4 - width)) : l;
}
// 끌어 옮긴 메모(이 브라우저·문서마다 localStorage hwpx.memopos.<문서 id>): { 항목 열쇠: { dx, dy } } — dx = 메모 칸 왼쪽에서, dy = 강조 자리 높이에서(문서와 같이 스크롤)
export const MEMO_POS_KEY = 'hwpx.memopos.';
const MEMO_POS_MAX = 300;
function normMemoPos(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, p] of Object.entries(v).slice(-MEMO_POS_MAX)) {
    const dx = Number(p?.dx); const dy = Number(p?.dy);
    if (k && Number.isFinite(dx) && Number.isFinite(dy)) out[k] = { dx: Math.round(dx), dy: Math.round(dy) };
  }
  return out;
}
export function readMemoPos(docId, storage) {
  try { return normMemoPos(JSON.parse(storageOf(storage)?.getItem(MEMO_POS_KEY + docId) || 'null')); } catch { return {}; }
}
export function writeMemoPos(docId, map, storage) {
  try {
    const s = storageOf(storage); if (!s) return false;
    const v = normMemoPos(map);
    if (Object.keys(v).length) s.setItem(MEMO_POS_KEY + docId, JSON.stringify(v)); else s.removeItem?.(MEMO_POS_KEY + docId);
    return true;
  } catch { return false; }
}
/**
 * 끌어 옮긴 메모의 자리: 왼쪽 = 메모 칸 + dx(층 안에 들게), 위 = 강조 자리 + dy
 * @param p { dx, dy } @param base { colLeft, top(강조 자리 높이) } @param width 메모 폭 @param W 층 폭
 */
export function freeBox(p, base, width, W) {
  let left = Math.round((Number(base?.colLeft) || 0) + (Number(p?.dx) || 0));
  if (Number(W) > 0) left = Math.min(Math.max(0, left), Math.max(0, Math.round(W) - width));
  return { left, top: Math.round((Number(base?.top) || 0) + (Number(p?.dy) || 0)) };
}
export const clampPanelH = (h) => Math.min(Math.max(num(h, PANEL.h), PANEL.hMin), PANEL.hMax);
/**
 * 좁은 창에서 끌어 놓은 패널 높이(px) → { h, min }: foldPx 보다 낮으면 접음(높이는 접기 전 값을 둔다 — 펼치면 돌아감)
 * @param px 패널 높이 @param layoutH 편집기+패널 배치 높이 @param prevH 지금 비율
 */
export function panelHeightFrom(px, layoutH, prevH = PANEL.h) {
  if (!(layoutH > 0)) return { h: clampPanelH(prevH), min: false };
  if (px < PANEL.foldPx) return { h: clampPanelH(prevH), min: true };
  return { h: clampPanelH(px / layoutH), min: false };
}
const normPanel = (v = {}) => ({ w: clampPanelW(v.w), h: clampPanelH(v.h), min: v.min === true, r: clampRailW(v.r), rmode: v.rmode === 'off' ? 'off' : 'margin', pin: v.pin !== false });
export const DEFAULT_PANEL = Object.freeze(normPanel());
/** 이 브라우저의 패널·레일 크기(없거나 깨졌으면 기본) */
export function readPanel(storage) {
  try { return normPanel(JSON.parse(storageOf(storage)?.getItem(PANEL_KEY) || 'null') || {}); } catch { return { ...DEFAULT_PANEL }; }
}
export function writePanel(p, storage) {
  try { const s = storageOf(storage); if (!s) return false; s.setItem(PANEL_KEY, JSON.stringify(normPanel(p || {}))); return true; } catch { return false; }
}
// 휴대전화 폭(600px 이하)의 편집기 메뉴·도구 막대: 기본은 숨김(문서 칸을 넓게), [⋯] 메뉴에서 켜면 이 브라우저에 기억(localStorage hwpx.tools). 넓은 창은 언제나 보임
export const TOOLS_KEY = 'hwpx.tools';
export function readTools(storage) {
  try { return storageOf(storage)?.getItem(TOOLS_KEY) === 'show'; } catch { return false; }
}
export function writeTools(show, storage) {
  try { const s = storageOf(storage); if (!s) return false; s.setItem(TOOLS_KEY, show ? 'show' : 'hide'); return true; } catch { return false; }
}

// ───────── 문서 설정(§1) ─────────
export const SETTING_VALUES = Object.freeze({
  editMode: ['realtime', 'review'], track: ['final', 'tracked'], exportKind: ['final', 'tracked'], aiMemo: ['summary', 'detail', 'none'],
  aiQuick: ['send', 'compose'],   // AI에게 빠르게 맡기기(예시 지시): 누르면 바로 보내기 | 요청 창에서 확인 후 보내기
  aiApply: ['manual', 'auto'],
});
export const SETTING_KEYS = Object.freeze(['editMode', 'editors', 'track', 'exportKind', 'aiMemo', 'aiQuick', 'aiApply']);
export const DEFAULT_SETTINGS = Object.freeze({ editMode: 'realtime', editors: 'all', track: 'final', exportKind: 'final', aiMemo: 'summary', aiQuick: 'send', aiApply: 'manual' });
/** 요청 창 없이 바로 보낼 수 있는 빠른 작업 종류 — 'AI에게 빠르게 맡기기'(예시 지시를 넣은 instruct, 2026-11-03)와 옛 종류 */
export const QUICK_KINDS = Object.freeze(['instruct', 'review', 'suggest', 'polish']);
/** 빠르게 맡기기(store openComposer quick)를 누르면 곧바로 보내는가 — 문서 설정 aiQuick 이 'compose' 가 아니고 종류가 QUICK_KINDS 일 때 */
export const quickAutoSend = (settings, kind) => QUICK_KINDS.includes(kind) && normSettings(settings).aiQuick !== 'compose';
/** editors 값: 'all' 또는 이름 배열(빈 이름·중복 뺌). 모르는 값이면 'all' */
function normEditors(v) {
  if (v === 'all' || v == null) return 'all';
  if (!Array.isArray(v)) return 'all';
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
}
/** 서버 settings(없거나 모르는 값이면 기본값 — 옛 서버면 null 을 준다) → 여섯 값이 다 있는 설정 */
export function normSettings(s) {
  const src = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(SETTING_VALUES)) if (SETTING_VALUES[k].includes(src[k])) out[k] = src[k];
  out.editors = normEditors(src.editors);
  return out;
}
export const isRealtimeSettings = (s) => !!s && s.editMode === 'realtime';
/**
 * 수정 권한(§1 — 서버 canEdit 과 같은 규칙): 관리자는 언제나, 그 밖은 문서함 편집 권한이 있고(docs/LIBRARY_SPEC.md) editors 가 'all' 이거나 그 이름이 있을 때.
 * perms = 서버가 문서 정보에 준 내 권한(['read','edit',…]) — 없으면(옛 서버) 역할로: viewer 는 어디서나 읽기 전용
 * @param me { name, role }
 */
export function canEditWith(settings, me, perms = null) {
  if (!me || !me.name) return false;
  if (me.role === 'admin') return true;
  if (Array.isArray(perms)) { if (!perms.includes('edit')) return false; } else if (me.role === 'viewer') return false;
  const ed = normSettings(settings).editors;
  return ed === 'all' || ed.includes(me.name);
}
/**
 * 편집기 방식: 'live'(실시간 수정 — 친 글을 곧바로 공유 문서에), 'follow'(수정 권한 없음 — 읽기 전용, 남의 고침만 따라감),
 * 'review'(승인 방식 — v0.3 내 수정본·변경 요청). info = 문서 정보(GET /api/docs/:id — settings·canEdit). 옛 서버(설정 없음)는 'review'
 */
export function editorMode(info) {
  if (!info || typeof info !== 'object' || !('settings' in info)) return 'review';
  const can = 'canEdit' in info ? !!info.canEdit : true;
  if (!can) return 'follow';
  return isRealtimeSettings(normSettings(info.settings)) ? 'live' : 'review';
}

// ───────── 누구 것인가 ─────────
/** 나(내 이름 그대로이거나 '내 이름(에이전트)') — annotations.js·store 와 같은 규칙 */
export function isMine(name, me) {
  const m = String((typeof me === 'string' ? me : me?.name) ?? ''); const n = String(name ?? '');
  return !!m && (n === m || n.startsWith(`${m}(`));
}
/**
 * '간단히' 보기에서 그 AI 작업의 제안을 숨기나(§4.1·§5): 남의 요청이면 숨긴다(카드·강조·우클릭 항목·검토 목록 — 한 줄 요약 카드만).
 * 내 요청의 남은 제안은 보인다(내가 정해야 하므로). '자세히'면 모두 보인다(관리자도 기본은 같다).
 * @param ctx { me, view }
 */
export function requestHidden(r, ctx = {}) {
  if (!r || ctx.view === 'detail') return false;
  return !isMine(r.by, ctx.me) && !isMine(r.recoveryOwner, ctx.me);
}
/** 제안 하나: 요청에 딸린 제안(rid)이고 그 요청이 숨으면 숨김. requestOf(rid) → 요청(모르면 숨기지 않는다) */
export function proposalHidden(p, requestOf, ctx = {}) {
  if (!p || p.rid == null || ctx.view === 'detail') return false;
  const r = typeof requestOf === 'function' ? requestOf(Number(p.rid)) : null;
  return !!r && requestHidden(r, ctx);
}

// ───────── 패널 탭·검토 탭 거르기(§5) ─────────
/** 드라이브는 문서함 탐색기에만 표시한다(보관 모듈: drive-editor.js). */
export const DETAIL_TABS = Object.freeze(['ai', 'review', 'cr', 'change', 'attach', 'history']);
/**
 * 보일 패널 탭 id(차례대로). 간단히: 검토 · (승인 방식이고 진행 중 변경 요청이 있으면) 변경 요청 · AI 작업 · 이력 · 첨부.
 * 변경 추적은 '자세히'일 때만(자세히는 v0.3.1 화면 그대로 — 탭 여섯 개).
 * @param o { view, realtime, activeCrs(진행 중 변경 요청 수) }
 */
export function panelTabIds(o = {}) {
  if (o.view === 'detail') return [...DETAIL_TABS];
  const out = ['ai', 'review'];
  if (!o.realtime && Number(o.activeCrs) > 0) out.push('cr');
  return out;
}
export const REVIEW_FILTERS = Object.freeze([
  { id: 'all', label: '전체', tip: '완료하지 않은 것 모두(문서 순서)' }, { id: 'memo', label: '메모', tip: '사람이 단 메모' },
  { id: 'ai', label: 'AI', tip: 'AI 작업·AI 의견' }, { id: 'proposal', label: '제안', tip: '대기 중인 제안' }, { id: 'draft', label: '수정 중', tip: '다른 사람이 수정 중인 곳' },
  { id: 'resolved', label: '완료', tip: '완료한 메모·AI 작업, 반영한 제안' },
]);
/** 검토 탭 거르기: 간단히 = 전체 · 메모 · AI · 완료(제안·수정 중 칩 없음), 자세히 = 여섯 개. id 'resolved' 는 그대로(옛 이름 '해결됨') */
export function reviewFilterIds(view) {
  return view === 'detail' ? REVIEW_FILTERS.map((f) => f.id) : ['all', 'memo', 'ai', 'resolved'];
}
/**
 * 검토 항목(rail.js reviewItems — { cat: memo|ai|proposal|draft, resolved })이 거르기에 드나. 해결됨은 해결된 것만, 그 밖은 해결 안 된 것 중
 * 그 종류(간단히의 'AI' 는 내 AI 작업의 남은 제안 카드까지 — 제안 칩이 없으므로)
 */
export function filterPass(it, filter, view) {
  if (!it) return false;
  if (filter === 'resolved') return !!it.resolved;
  if (it.resolved) return false;
  if (filter === 'all' || !filter) return true;
  if (view !== 'detail' && filter === 'ai') return it.cat === 'ai' || it.cat === 'proposal';
  return it.cat === filter;
}
/** 남의 '수정 중' 덩어리를 변경 요청마다 한 줄로 접나(간단히 — §5) */
export const collapseDrafts = (view) => view !== 'detail';

// ───────── AI 작업 한 줄 요약 카드(§4.1) ─────────
/** 머리: 'AI 작업 #2 · 홍길동'(상태는 칩 하나로 — docs/UI_TERMS.md §1-3, 종류는 title) */
export function summaryHead(r) {
  if (!r) return '';
  return `AI 작업 #${r.rid}${r.by ? ` · ${r.by}` : ''}`;
}
/**
 * 상태 칩 하나(UI_TERMS §1-3 — web/ui.js requestBadge 와 같은 이름): 대기열 · 전달됨 · 처리 중 · 확인 필요 · 완료 · 실패 · 취소됨.
 * 끝난 요청은 서버 outcome(누가 했든 — 남의 요청이므로), 없으면 g(내 눈의 진행)로 정한다: 남은 제안이 있으면 '확인 필요', 아니면 '완료'.
 * 반영·남은 수는 title 에('반영 14건 · 남은 제안 2건'). cls = 진행 단계 색(ui.js requestPhase — 남의 요청이라 '내 차례' 강조 없이 ph-hold). → { text, cls, title } | null
 */
export function summaryChip(r, g = null) {
  if (!r) return null;
  const o = r.outcome && typeof r.outcome === 'object' ? r.outcome : null;
  const accepted = Number(o?.accepted ?? g?.accepted ?? 0) || 0;
  const open = Number(o?.open ?? g?.open ?? 0) || 0;
  const counts = [accepted ? `반영 ${accepted}건` : '', open ? `남은 제안 ${open}건` : ''].filter(Boolean).join(' · ');
  switch (r.status) {
    case 'pending': return r.delivery ? { text: '전달됨', cls: 'ph-wait', title: '' } : { text: '대기열', cls: 'ph-wait', title: '' };
    case 'working': return { text: '처리 중', cls: 'ph-run', title: '' };
    case 'failed': return { text: '실패', cls: 'ph-fail', title: r.error || '' };
    case 'cancelled': return { text: '취소됨', cls: 'ph-off', title: counts };
    default: break;
  }
  const resolved = o && 'resolved' in o ? !!o.resolved : !!g?.resolved;
  if (!resolved && open > 0) return { text: '확인 필요', cls: 'ph-hold', title: counts };
  return { text: '완료', cls: 'ph-ok', title: counts };
}

// ───────── 이력: 실시간 편집 묶음(§2.6) ─────────
export const LIVE_NOTE = '실시간 편집';
export const LIVE_GROUP_GAP_MS = 5 * 60 * 1000;
const atMs = (x) => { const t = Date.parse(x?.at ?? ''); return Number.isFinite(t) ? t : NaN; };
/**
 * 변경 이력(기록) 목록 → 줄: 같은 사람의 이어진 '실시간 편집' 기록(서로 5분 안)은 묶음 하나 { kind: 'live', key, by, recs(받은 차례), count, from, to }
 * (from·to = 가장 이른·늦은 시각), 그 밖(이정표가 된 기록 포함)은 { kind: 'rec', rec }. 받은 차례(이력 탭은 새것부터)를 그대로 지킨다. 한 개뿐인 실시간 기록은 그냥 줄
 */
export function groupHistory(recs, { gapMs = LIVE_GROUP_GAP_MS } = {}) {
  const out = []; let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.recs.length === 1) out.push({ kind: 'rec', rec: cur.recs[0] });
    else {
      const ts = cur.recs.map(atMs).filter(Number.isFinite);
      out.push({ kind: 'live', key: `live:${cur.recs[0].n}`, by: cur.by, recs: cur.recs, count: cur.recs.length,
        from: ts.length ? new Date(Math.min(...ts)).toISOString() : null, to: ts.length ? new Date(Math.max(...ts)).toISOString() : null });
    }
    cur = null;
  };
  for (const r of Array.isArray(recs) ? recs : []) {
    const live = !!r && r.note === LIVE_NOTE && r.v == null;
    if (!live) { flush(); out.push({ kind: 'rec', rec: r }); continue; }
    const t = atMs(r);
    if (cur && cur.by === r.by && Number.isFinite(t) && Number.isFinite(cur.lastAt) && Math.abs(t - cur.lastAt) <= gapMs) { cur.recs.push(r); cur.lastAt = t; continue; }
    flush();
    cur = { by: r.by, recs: [r], lastAt: t };
  }
  flush();
  return out;
}
const pad2 = (x) => String(x).padStart(2, '0');
const hhmmOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const sameDay = (a, b) => { const x = new Date(a); const y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
/** 묶음 한 줄: '홍길동 · 실시간 편집 23번 · 10:02~10:15'(날이 다르면 '10-22 23:58~10-23 00:04') */
export function liveGroupLabel(g) {
  if (!g) return '';
  const md = (iso) => { const d = new Date(iso); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `; };
  const day = g.from && g.to && !sameDay(g.from, g.to);
  const span = g.from && g.to ? `${day ? md(g.from) : ''}${hhmmOf(g.from)}~${day ? md(g.to) : ''}${hhmmOf(g.to)}` : '';
  return [g.by || '', `${LIVE_NOTE} ${g.count}번`, span].filter(Boolean).join(' · ');
}

// ───────── 상단 칩(§2.4-8) · 한글로 저장 단추(§3) ─────────
export const READONLY_TIP = '이 문서의 수정 권한이 없습니다(문서 설정). 메모·AI 요청은 됩니다';
export const LIVE_TIP = '실시간 수정 — 친 글은 잠시 쉬면 곧바로 공유 문서에 들어가 다른 사람 화면에 1~2초 안에 보입니다(승인 없음). '
  + '되돌리기(Ctrl+Z)는 다른 사람의 고침이 이 편집기에 들어온 뒤에 친 내 글만 되돌립니다.';
/**
 * 실시간·읽기 전용 칩: { text, cls, tip, retry? }.
 * st = { ready, readOnly, error, pushing, dirty, savedAt(시각 글 'HH:MM' 또는 '') }
 */
export function liveChip(st = {}) {
  if (!st.ready) return { text: '편집기 준비 중…', cls: 'idle', tip: '' };
  if (st.readOnly) return { text: '읽기 전용', cls: 'readonly', tip: READONLY_TIP };
  if (st.error) return { text: '보내지 못함 —', cls: 'error', retry: true, tip: `${st.error} — 잠시 뒤 저절로 다시 보냅니다(5·10·15초). 이 창의 글은 그대로 있습니다` };
  // (2026-11-03) 큰 붙여넣기·지우기는 서버가 넣는 동안 진행을 알려 온다(server/live.js) — 이 창의 글은 그대로, 끝나면 '저장됨'
  if (st.pushing && st.progress?.total) return { text: `반영 중 ${st.progress.done}/${st.progress.total}`, cls: 'saving', tip: '고친 문단을 공유 문서에 넣고 있습니다. 이 창의 글은 그대로 있고, 끝나면 저장됨으로 바뀝니다' };
  if (st.pushing || st.dirty) return { text: '보내는 중…', cls: 'saving', tip: LIVE_TIP };
  return { text: `실시간 · 저장됨${st.savedAt ? ` ${st.savedAt}` : ''}`, cls: 'saved live', tip: LIVE_TIP };
}
export const EXPORT_LABEL = Object.freeze({ final: '보이는 그대로 + 메모', tracked: '변경 추적 포함 + 메모' });
/** [한글로 저장] 설명: '보이는 그대로 + 메모 (문서 설정에서 바꿈)' */
export function exportTip(settings) {
  const k = normSettings(settings).exportKind;
  return `${EXPORT_LABEL[k] || EXPORT_LABEL.final} (문서 설정에서 바꿈)`;
}

// ───────── ⚙ 문서 설정 창 모델(§5) ─────────
// 이름표는 짧게(UI_TERMS §1), 설명은 help(이름 옆 '?')·tips(선택지 마우스 올림). 값(options 의 첫 칸)은 서버 설정 값 그대로
export const SETTING_FIELDS = Object.freeze([
  { key: 'editMode', label: '편집 방식', options: [['realtime', '실시간'], ['review', '승인 후 반영']],
    help: '실시간: 고친 글이 바로 공유 문서에 들어갑니다. 승인 후 반영: 각자 내 수정본에서 고친 뒤 검토 요청 → 승인 → 반영',
    tips: { realtime: '고친 글이 곧바로 공유 문서에 들어가 모두에게 보입니다(승인 없음)', review: '내 수정본에서 고치고, 검토 요청 → 승인 뒤 문서에 들어갑니다' } },
  { key: 'editors', label: '수정 권한', options: [['all', '편집자 모두'], ['some', '지정한 사람']],
    tips: { all: '편집자 역할이면 누구나 고칠 수 있습니다(관리자는 언제나)', some: '고른 사람만 고칩니다 — 나머지는 읽기 전용(메모·AI 요청은 됨)' } },
  { key: 'track', label: '실시간 기록', options: [['final', '고친 글만'], ['tracked', '변경 추적']],
    help: '실시간 편집일 때 고친 글을 남기는 방식',
    tips: { final: '고친 글만 남깁니다(변경 추적 없음)', tracked: '고친 곳을 한글 변경 추적으로 남깁니다' } },
  { key: 'exportKind', label: '한글로 저장', options: [['final', '보이는 그대로'], ['tracked', '변경 추적 포함']],
    help: '[한글로 저장] 파일의 모양 — 둘 다 메모가 들어갑니다',
    tips: { final: EXPORT_LABEL.final, tracked: EXPORT_LABEL.tracked } },
  { key: 'aiMemo', label: 'AI 메모', options: [['summary', '요약'], ['detail', '요약 + 반영 목록'], ['none', '안 남김']],
    help: 'AI 작업 결과를 문서 메모로 남기는 방식. 작업과 결과는 언제나 AI 작업 탭에 있습니다. 「안 남김」은 새 자동 작업 메모에만 적용되고 기존 메모·답글은 그대로입니다',
    tips: { summary: '요약만 메모로 남깁니다', detail: '요약과 반영한 제안 목록을 메모로 남깁니다', none: '메모를 남기지 않습니다(AI 작업 탭에서 확인)' } },
  { key: 'aiQuick', label: 'AI에게 빠르게 맡기기', options: [['send', '바로 보내기'], ['compose', '확인 후 보내기']],
    help: '우클릭 「AI에게 빠르게 맡기기」·선택 도구 막대의 검토하기·문장 고쳐 쓰기·다듬기(예시 지시를 넣은 요청). 「AI에게 맡기기…」는 언제나 요청 창에서 보냅니다',
    tips: { send: '누르면 예시 지시로 곧바로 AI에게 보냅니다', compose: '예시 지시를 넣은 요청 창을 열어 확인·수정한 뒤 보냅니다' } },
  { key: 'aiApply', label: 'AI 자동 반영', options: [['manual', '직접 반영'], ['auto', '자동 반영']],
    help: 'AI 작업이 끝나면 권장안을 문서에 자동으로 반영합니다. 직접 반영 권한이 있는 경우에만 동작하며, 여러 비교안은 직접 선택합니다. 반영한 결과는 되돌릴 수 있습니다',
    tips: { manual: '결과를 확인하고 반영을 누릅니다', auto: '작업 완료 시 글·서식·표·그림을 자동 반영합니다. 기존 대기 제안은 그대로 둡니다' } },
]);
/** 설정 → 창의 값 { editMode, editorsMode: 'all'|'some', editors: [이름…], track, exportKind, aiMemo, aiQuick } */
export function settingsForm(settings) {
  const s = normSettings(settings);
  return { editMode: s.editMode, editorsMode: s.editors === 'all' ? 'all' : 'some', editors: s.editors === 'all' ? [] : [...s.editors], track: s.track, exportKind: s.exportKind, aiMemo: s.aiMemo, aiQuick: s.aiQuick, aiApply: s.aiApply };
}
/**
 * 창의 값 → PATCH 본문(바뀐 키만 — 아무것도 바뀌지 않았으면 빈 객체). editors 는 'all' 또는 이름 배열(중복 뺌, 받은 차례).
 * 관리자는 언제나 고칠 수 있으므로 목록에 넣지 않아도 된다(넣어도 된다 — 서버는 그대로 받는다)
 */
export function settingsPatch(form, settings) {
  const s = normSettings(settings); const out = {};
  for (const k of ['editMode', 'track', 'exportKind', 'aiMemo', 'aiQuick', 'aiApply']) if (form && SETTING_VALUES[k].includes(form[k]) && form[k] !== s[k]) out[k] = form[k];
  const ed = form?.editorsMode === 'all' ? 'all' : normEditors(Array.isArray(form?.editors) ? form.editors : []);
  if (JSON.stringify(ed) !== JSON.stringify(s.editors)) out.editors = ed;
  return out;
}
/**
 * 사람 고르기 목록(GET /api/users): [{ name, role, checked, disabled, note }]. 관리자는 언제나 고칠 수 있다(체크·꺼짐 '관리자는 언제나'),
 * 역할 viewer 는 고를 수 없다(꺼짐 '읽기 전용 역할'). '편집자 모두'면 편집자는 모두 체크(꺼짐 — 지정할 때만 고름)
 */
export function editorChoices(users, form) {
  const all = form?.editorsMode === 'all'; const picked = new Set(Array.isArray(form?.editors) ? form.editors : []);
  const out = (Array.isArray(users) ? users : []).filter((u) => u && u.name).map((u) => {
    const role = u.role || 'editor';
    if (role === 'admin') return { name: u.name, role, checked: true, disabled: true, note: '관리자는 언제나' };
    if (role === 'viewer') return { name: u.name, role, checked: false, disabled: true, note: '읽기 전용 역할' };
    return { name: u.name, role, checked: all || picked.has(u.name), disabled: all, note: '' };
  });
  // config 에 없는 이름(지정해 둔 사람이 사용자 목록에서 빠짐)도 보이게
  for (const n of picked) if (!out.some((x) => x.name === n)) out.push({ name: n, role: '', checked: true, disabled: all, note: '사용자 목록에 없음' });
  return out;
}
/** 승인 → 실시간으로 바꾸는데 진행 중 변경 요청이 있으면 경고 줄('' 이면 없음 — 까닭은 창의 title: SETTINGS_WARN_TIP) */
export const SETTINGS_WARN_TIP = '실시간 편집기는 승인 방식 때의 수정본을 열지 않습니다 — 변경 요청 탭에서 반영하거나 닫으세요';
export function settingsWarning(settings, form, activeCrs = 0) {
  const s = normSettings(settings); const n = Number(activeCrs) || 0;
  if (s.editMode === 'review' && form?.editMode === 'realtime' && n > 0) return `진행 중 변경 요청 ${n}건을 먼저 반영하거나 닫으세요`;
  return '';
}
