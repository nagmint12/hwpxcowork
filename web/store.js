// 문서 하나의 자료·동작·실시간 알림. DocView 가 만들고 provide('doc') 로 나눠 준다.
// v0.3(docs/V3_SPEC.md §5.4): 변경 요청(crs·myCr)·에이전트(agents·agentMe)·타이핑 중(editing)·내 수정본(draft)·편집기 선택(sel)·
// 강조 자리(anchors)·레일(active·railOpen) 상태와 그 동작. 편집기 손잡이 d.editor 는 web/editor.js(mountEditor)가 단다.
// 편집기는 하나(rhwp-studio)다 — v0.2 검토 보기와 그 상태(되돌리기 목록·보기 모드·직접 고쳐 쓰기)는 없앴다. 되돌리기는 studio 의 것을 쓴다.
// v0.3.1(§9.7): AI 작업의 '내 눈의 진행'(progress — util.requestProgress)·한 번에 정하기(resolveRequest: 모두 반영 = applyBatch + resolve adopt,
// 기준에 바로 적용·남은 것 거절 = resolve apply/reject), 내 반영을 거절하면 편집기에서 먼저 되돌림(rejectProposal),
// 사람용 버전(saveMilestone·versionLabel — 기록 번호 n 은 화면에 내지 않는다).
// v0.4(docs/V4_SPEC.md §1·§3·§4·§5): 문서 설정 s.settings·수정 권한 s.canEdit·설정 권한 s.canConfigure(문서 정보와 WS doc settings 에서),
// patchSettings·listUsers, 보기 s.view('simple'|'detail' — localStorage hwpx.view), 실시간 상태 s.live(편집기가 채움)·읽기 전용 s.readOnly,
// 실시간 문서의 AI 반영 = 공유 문서에 바로(resolveRequest adopt → 서버 resolve { apply }, 하나 = POST /proposals/:pid/apply, 되돌리기 = /undo),
// 한글로 저장 단추 하나(downloadHangul → /file?kind=export — 설정대로, X-Export-Fallback 이면 알림).
import { reactive } from '/vendor/vue.esm-browser.prod.js';
import { api, state, toast, toastError, kindLabel, presetLabel, clip, cpLen, josa, requestProgress, proposalAccepted, batchFailText, fmtStamp } from './util.js';
import { colorForUser } from './annotations.js';
import { isRichProposal, adoptionRecord, formatAdoptionOf } from './formatting.js';
import { readView, writeView, normSettings, quickAutoSend, canEditWith,requestHidden as viewRequestHidden, proposalHidden as viewProposalHidden, collapseDrafts as viewCollapse, EXPORT_LABEL } from './view.js';

const ALL = ['info', 'memos', 'proposals', 'changes', 'requests', 'attachments', 'paragraphs', 'history', 'crs', 'agents'];
const ACTION_LABEL = { add: '달았습니다', delete: '지웠습니다', edit: '고쳤습니다', applied: '적용했습니다', rejected: '거절했습니다', undone: '복구했습니다', reopened: '다시 열었습니다', reopen: '다시 열었습니다' };
const ACTIVE_CR = new Set(['draft', 'open']);
const CR_ORDER = { draft: 0, open: 1, merged: 2, closed: 3 };

/**
 * 이 변경 요청에서 me 가 직접 남긴 마지막 판단(승인·수정 요청 — 에이전트 검토는 빼고, 서버 reviewCounts 와 같은 규칙)이 승인이면
 * 'live'(살아 있음) 또는 'stale'(승인 뒤 수정본이 바뀜 — 서버 r.stale), 아니면 null
 */
export function myApprovalState(cr, me) {
  if (!me || !cr || !Array.isArray(cr.reviews)) return null;
  let last = null;
  for (const r of cr.reviews) if (r && !r.agent && r.by === me && (r.verdict === 'approve' || r.verdict === 'changes')) last = r;
  return last?.verdict === 'approve' ? (last.stale ? 'stale' : 'live') : null;
}
/** 내 승인이 낡았다는 알림 글 */
export const staleApprovalText = (cid) => `변경 요청 #${cid} 내용이 바뀌어 내 승인이 무효가 됐습니다 — 다시 확인해 주세요`;
/**
 * 남이 내 변경 요청에 한 일(WS { type:'cr', action:'review'|'thread', verdict?, resolved?, cid, by }) → 알림 글. 알릴 것이 아니면 ''
 * (의견 스레드를 해결·다시 열기만 한 것은 알리지 않는다)
 */
export function crFeedbackText(msg) {
  if (!msg || !msg.by) return '';
  const mine = `내 변경 요청 #${msg.cid}`;
  if (msg.action === 'review') {
    if (msg.verdict === 'approve') return `${msg.by} 님이 ${josa(mine, '을/를')} 승인했습니다`;
    if (msg.verdict === 'changes') return `${msg.by} 님이 ${mine}에 수정을 요청했습니다`;
    if (msg.verdict === 'comment') return `${msg.by} 님이 ${mine}에 의견을 남겼습니다`;
    return '';
  }
  if (msg.action === 'thread' && !('resolved' in msg)) return `${msg.by} 님이 ${mine}에 의견을 달았습니다`;
  return '';
}

/**
 * 내 수정본 상태의 처음 값. stale = 저장을 멈춤(다시 열기 전까지 — 옛 기준 STALE_BASE 이거나 아래 elsewhere),
 * elsewhere = 서버 내 수정본을 이 창 밖(다른 창·기기·관리자)이 바꿨다는 칩 글(빈 글이면 아님 — WS 확인, 또는 PUT 409 DRAFT_STALE 면
 * '다른 곳에서 바뀜'), error = 칩 설명, rebased = 서버 내 수정본이 이 창보다 새 기준(다른 창의 최신 반영 — 덮어쓸 수 없어 칩이
 * [이 글로 저장] 대신 [내 글 옮겨 넣기]). changed·inserted·deleted 는 지금 기준 ref(편집기가 옮겨 준다), count 는 바꾼 문단 수
 */
export const emptyDraft = () => ({
  dirty: false, saving: false, savedAt: null, error: '', stale: false, elsewhere: '', rebased: false, baseVersion: 0, behind: 0, unsupported: [],
  changed: [], inserted: [], deleted: [], count: 0, conflicts: [],
});

/** 대상 문제 알림 글(targetProblem) */
const TARGET_GONE = '고른 문단이 지금 문서에 없습니다(다른 사람이 반영함) — [최신으로 맞추기] 뒤에 다시 고르세요';
const TARGET_STALE = '고른 글이 지금 문서에서 바뀌었습니다(다른 사람이 반영함) — [최신으로 맞추기] 뒤에 다시 고르세요';
const TARGET_DRAFT_ONLY = '내 수정본에서 고친 글은 아직 공유 문서에 없어 AI에게 맡길 수 없습니다 — 고치지 않은 글을 고르거나 문단을 우클릭해 문단 전체로 맡기세요';
/** '이 문단 뒤에' 요청 — 대상 문단만 지금 기준에 있으면 된다(고른 글은 쓰지 않음) */
const AFTER_KINDS = new Set(['insert', 'make_table']);
/**
 * 요청·메모 대상의 문제(없으면 ''): 그 문단이 지금 기준에 없음(gone) · 고른 글이 지금 기준에서 바뀜(stale) · 고른 글이 내 수정본에만 있음(draftOnly — AI 요청만).
 * kind = 요청 종류 또는 'memo'(메모는 draftOnly 면 문단 전체로 바꿔 단다 — openPopover)
 */
export function targetProblem(t, kind, o = {}) {
  if (!t || t.scope === 'document') return '';
  // 실시간 문서는 [최신으로 맞추기]가 없다 — 편집기가 남의 고침을 곧 맞춘다(손을 멈추면)
  const live = (msg) => (o.realtime ? msg.replace(/ — \[최신으로 맞추기\] 뒤에 다시 고르세요$/, ' — 편집기가 맞춰진 뒤(잠시 뒤) 다시 고르세요') : msg);
  if (t.gone) return live(TARGET_GONE);
  if (AFTER_KINDS.has(kind)) return '';
  if (t.stale) return live(TARGET_STALE);
  if (t.draftOnly && kind !== 'memo') return o.realtime ? '방금 친 글은 아직 공유 문서에 들어가는 중입니다 — 잠시 뒤(칩 \'실시간 · 저장됨\') 다시 고르세요' : TARGET_DRAFT_ONLY;
  return '';
}

const bodyRef = (r) => (/^(s\d+\/p\d+)/.exec(r || '') || [])[1] || r;
/**
 * 제안이 지금 편집기 글(내 수정본)에 들어가 있어 보이나 — 플러그인 draftState(기준 ref 의 바꾼 문단·넣은 문단)로 거칠게 본다.
 * 바꿈: 그 문단(표 칸이면 그 칸 또는 표 격자가 바뀐 본문 문단)이 기준과 다름. 문단 추가: 그 문단 뒤에 넣은 문단이 있음(칸이면 칸이 바뀜).
 * st 를 모르면 true(들어가 있다고 본다 — 두 번 반영을 막는 쪽).
 */
export function adoptionInEffect(p, st) {
  if (!p) return false;
  if (formatAdoptionOf(p, state.me?.name)) return true;
  if (!st) return true;
  const changed = Array.isArray(st.changed) ? st.changed : [];
  const hit = (ref) => changed.includes(ref) || changed.includes(bodyRef(ref));
  if ((p.type || 'replace') === 'insert') {
    const after = p.afterRef || p.ref;
    return (Array.isArray(st.inserted) ? st.inserted : []).some((x) => x && x.afterRef === after) || (/\/n\d+/.test(after || '') && hit(after));
  }
  return hit(p.ref);
}

/** applyBatch 항목 하나(제안 → 편집기 손잡이 인자, adoptProposal 의 applyText·insertParagraphAfter 인자와 같은 꼴, key = pid) */
export function batchItemOf(p) {
  if ((p.type || 'replace') === 'insert') return { op: 'insert', afterRef: p.afterRef || p.ref, text: p.text || '', key: Number(p.pid) };
  const it = { op: 'text', ref: p.ref, find: p.find ?? '', replace: p.replace ?? '', occurrence: p.occurrence || 1, key: Number(p.pid) };
  if (Number.isInteger(p.start) && Number.isInteger(p.end)) { it.start = p.start; it.end = p.end; }
  return it;
}
/**
 * 내 수정본에 반영해 둔 바꿈 제안을 편집기에서 되돌리는 applyText 인자(지금 글의 replace → 원문 find). 자리를 알 수 없어 엉뚱한 곳을
 * 고칠 수 있으면 null — 지운 제안(replace '')인데 원래 범위(start/end)를 모르면 문단 끝에 원문이 붙는다
 */
export function revertArgOf(p) {
  if (!p || isRichProposal(p) || (p.type || 'replace') !== 'replace') return null;
  const ranged = Number.isInteger(p.start) && Number.isInteger(p.end);
  const find = String(p.replace ?? '');
  if (!find && !ranged) return null;
  const arg = { ref: p.ref, find, replace: String(p.find ?? ''), occurrence: 1, label: `제안 #${p.pid} 되돌림` };
  if (ranged) { arg.start = p.start; arg.end = p.end; }
  return arg;
}

/**
 * @param id 문서 id
 */
export function createDocStore(id) {
  const s = reactive({
    id, info: null, memos: [], proposals: [], changes: [], requests: [], attachments: [], paragraphs: [], history: { versions: [], activity: [], milestones: [] },
    paraVersion: 0,    // paragraphs 가 어느 기준 버전의 것인지(모르면 0)
    presence: [], loaded: false, formatting: null, formattingVersion: 0,
    tab: 'review',     // 패널 탭: review · cr · ai · change · attach · history
    selection: null,   // { ref, start, endRef, end, refs, text } — 편집기의 펼친 선택(기준 ref·최종본 코드포인트, 캐럿이면 null)
    composer: null,    // 떠 있는 요청 창
    popover: null,     // { kind: 'memo', target, anchor, text } 메모 달기 작은 창(text = 쓰던 글)
    focus: null,       // { ref, start, end, t } 그 자리로(편집기가 준비되면 focusRange)
    activeMemo: null, activeRid: null,
    busy: 0, sending: 0,
    crs: [],           // CRView[] — draft·open 은 덩어리(curRef·state) 포함, merged·closed 는 개수만
    myCr: null,        // 내 진행 중(draft·open) 변경 요청
    agents: {},        // { 사람: [{ agent, channel }] }
    agentMe: { online: false, sessions: [] },
    editing: {},       // { 사람: ref } — 남이 지금 타이핑 중인 문단(내 것은 넣지 않는다)
    draft: emptyDraft(),
    sel: null,         // 편집기 선택(CoworkSelection) — 캐럿 포함
    anchors: [],       // 플러그인 강조 자리(Anchor[], iframe client 좌표)
    active: null,      // { kind, id } 레일 카드·편집기 강조 맞춤(누름)
    hover: null,       // { kind, id } 편집기 강조 hover(덧붙임)
    railOpen: true,
    submitOpen: false, // [검토 요청] → 패널 '변경 요청' 탭의 제출 창
    activeCid: null,   // 패널 '변경 요청' 탭에서 펼칠 변경 요청(상단 칩·접속자 목록에서 누름)
    showResolved: false,
    reply: null,       // 셸의 답글·의견 작은 창 { kind: 'memo'|'draft', …, text(쓰던 글 — 보내기가 실패해도 남는다) }
    agentHelp: 0,      // 내 에이전트 알약을 누른 시각(AI 작업 탭이 연결 안내를 펼친다)
    editor: null,      // 편집기 손잡이(web/editor.js) — d.editor 로 읽는다
    // v0.4: 문서 설정(모르면 null — 옛 서버·아직 안 읽음)·수정 권한·설정 권한(문서 정보 GET /api/docs/:id 의 settings·canEdit·canConfigure)
    settings: null, canEdit: true, canConfigure: false,
    view: readView(),  // 보기: 'simple'(기본) | 'detail' — 사람마다(브라우저 localStorage hwpx.view)
    readOnly: false,   // 편집기 읽기 전용(수정 권한 없음 — 편집기가 정한다, 플러그인 setOptions({ readOnly }))
    // 실시간 편집기 상태(web/editor.js 가 채움): on = 실시간 수정 중, pushing = 보내는 중, savedAt = 마지막으로 보낸·맞춘 시각, error = 보내지 못한 까닭,
    // pushes·syncs·reopens = 보낸·맞춘·다시 연 횟수(시험·문제 찾기), lastSync = 마지막 맞춤 { at, changed, inserted, by }
    live: { on: false, pushing: false, progress: null, savedAt: null, error: '', pushes: 0, syncs: 0, reopens: 0, lastSync: null },
    settingsOpen: false,   // ⚙ 문서 설정 창
    // AI 작업 진행 기록(server/activity.js): 요청 번호 → [{ n, at, tool, label, ok, ms }] — AI 가 부른 도구를 한 줄씩(WebSocket 으로 실시간)
    activity: {},
  });
  const listeners = new Map();
  const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); };
  const emit = (ev, data) => { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.warn(ev, e); } } };
  const base = `/api/docs/${id}`;
  const me = () => state.me || { name: '', role: '' };
  const myName = () => state.me?.name || '';
  const v2 = () => !!state.config?.kinds;
  /** 나인가: 내 이름 그대로이거나 '내 이름(에이전트)' (web/annotations.js 와 같은 규칙) */
  const isMe = (name) => { const m = myName(); const n = String(name ?? ''); return !!m && (n === m || n.startsWith(`${m}(`)); };
  const colorOf = (name) => colorForUser(name, myName());
  /**
   * 내가 내 수정본에 반영해 둔 제안인가 — 서버 기록은 사람마다 p.adoptedBy[이름] = { at, cid }(옛 자료는 p.adopted = { by, cid, at } 하나뿐:
   * 그때는 by 가 나일 때만). 다른(끝난) 변경 요청에 묶인 옛 기록은 뺀다
   */
  const adoptedByMe = (p) => {
    if (!p) return false;
    const me = myName(); if (!me) return false;
    const e = adoptionRecord(p, me);
    if (!e || typeof e !== 'object') return false;
    return e.cid == null || !s.myCr || Number(e.cid) === s.myCr.cid;
  };
  /** '내 눈'의 규칙(§9.7): 내 반영 기록 + 지금 편집기 글(s.draft)에 들어 있나 + 내 이름 */
  const viewOpts = () => ({ adoptedByMe, inEffect: (p) => adoptionInEffect(p, s.draft), me: myName() });
  /** 제안이 내 눈으로 '반영'인가(적용됨·남이 반영해 둠·내가 반영해 두고 편집기 글에 들어 있음) — 검토 탭 '해결됨' 거르기 */
  const proposalDone = (p) => proposalAccepted(p, viewOpts());

  // ── 문서 설정(v0.4 §1) ──
  /** 문서 정보(GET /api/docs/:id) → s.info 와 설정·권한. 옛 서버(settings 없음)면 설정은 null(승인 방식 v0.3 그대로) */
  function applyInfo(x) {
    if (!x || typeof x !== 'object') return;
    s.info = x;
    if ('settings' in x) {
      s.settings = normSettings(x.settings);
      if ('canEdit' in x) s.canEdit = !!x.canEdit;
      if ('canConfigure' in x) s.canConfigure = !!x.canConfigure;
    }
  }
  /** 실시간 수정 문서인가(설정을 아직 모르면 false) */
  const realtime = () => s.settings?.editMode === 'realtime';
  /** 보기 바꾸기('simple'|'detail') — 이 브라우저에 적어 둔다 */
  function setView(v) { s.view = v === 'detail' ? 'detail' : 'simple'; writeView(s.view); }
  const viewCtx = () => ({ me: myName(), view: s.view });
  /** 이 요청의 제안을 숨기나('간단히'에서 남의 AI 작업 — 한 줄 요약 카드만, §4.1·§5) */
  const requestHidden = (r) => viewRequestHidden(r, viewCtx());
  /** 이 제안을 숨기나(숨는 요청에 딸린 제안) */
  const proposalHidden = (p) => viewProposalHidden(p, request, viewCtx());
  /** 남의 '수정 중' 덩어리를 변경 요청마다 한 줄로(간단히) */
  const collapseDrafts = () => viewCollapse(s.view);
  /** 문서를 정하는 동작(반영·거절·되돌리기·변경 수락 …)을 할 수 있나 — 수정 권한(서버도 403 FORBIDDEN 으로 막는다) */
  const canDecide = () => s.canEdit !== false;
  /**
   * PATCH /settings(관리자·문서를 올린 사람) → { settings }. 바뀐 키만 보낸다(patch). 서버 오류(FORBIDDEN·BAD_SETTING)는 그대로 던진다
   */
  async function patchSettings(patch) {
    const r = await api(`${base}/settings`, { method: 'PATCH', body: patch || {} });
    if (r?.settings) { s.settings = normSettings(r.settings); s.canEdit = canEditWith(s.settings, state.me, s.info?.perms); }
    refresh(['info']);
    return r;
  }
  /** 설정 창의 사람 목록 GET /api/users → [{ name, role }] */
  const listUsers = () => api('/api/users');
  /** WS { type: 'doc', action: 'settings', settings, by } — 곧바로 설정·내 수정 권한을 맞춘다(편집기가 방식을 바꿔 다시 연다) */
  function onSettingsMsg(msg) {
    const prev = s.settings;
    s.settings = normSettings(msg.settings);
    s.canEdit = canEditWith(s.settings, state.me, s.info?.perms);
    if (msg.by && !isMe(msg.by)) {
      const parts = [];
      if (!prev || prev.editMode !== s.settings.editMode) parts.push(s.settings.editMode === 'realtime' ? '실시간 수정' : '승인 후 반영');
      if (prev && JSON.stringify(prev.editors) !== JSON.stringify(s.settings.editors)) parts.push(s.canEdit ? '수정 권한 있음' : '수정 권한 없음(읽기 전용)');
      if (prev && prev.exportKind !== s.settings.exportKind) parts.push(`한글로 저장: ${EXPORT_LABEL[s.settings.exportKind]}`);
      toast(`${msg.by} 님이 문서 설정을 바꿨습니다${parts.length ? ` — ${parts.join(' · ')}` : ''}`, { ms: 5000 });
    }
  }

  // ── 읽기 ──
  let pending = new Set(); let timer = null; let inflight = null;
  async function refreshNow(what = ALL) {
    const jobs = {
      // 버전은 늘기만 한다 — 같이 돌던 문단 읽기가 더 새 정보를 이미 넣었으면 덮지 않는다
      info: async () => { const x = await api(base); if (!s.info || (Number(x?.version) || 0) >= (Number(s.info.version) || 0)) applyInfo(x); },
      memos: async () => { s.memos = (await api(`${base}/memos`)).map(normMemo); },
      proposals: async () => { s.proposals = await api(`${base}/proposals`); },
      changes: async () => { s.changes = await api(`${base}/changes`); },
      requests: async () => { s.requests = (await api(`${base}/requests`)).filter((r) => !r.docId || r.docId === id); },
      attachments: async () => { try { s.attachments = await api(`${base}/attachments`); } catch (e) { if (e.status !== 404) throw e; s.attachments = []; } },
      // 문단 목록이 어느 기준 버전의 것인지 같이 적는다(앞뒤 버전이 같을 때만 — 편집기가 '글이 같은 새 버전'을 가릴 때 쓴다, web/editor.js)
      paragraphs: async () => {
        for (let k = 0; k < 3; k++) {
          const v1 = Number((await api(base))?.version) || 0;
          const list = await api(`${base}/paragraphs`);
          const info = await api(base);
          const v2 = Number(info?.version) || 0;
          if (v1 === v2 || k === 2) {
            // 편집기가 이미 더 새 판의 문단을 넣었으면(실시간 맞춤 — web/editor.js) 덮지 않는다
            if (!(v1 === v2 && v2 < (Number(s.paraVersion) || 0))) { s.paragraphs = list; s.paraVersion = v1 === v2 ? v2 : 0; }
            if (!s.info || (Number(s.info.version) || 0) <= v2) applyInfo(info);
            return;
          }
        }
      },
      history: async () => { s.history = await api(`${base}/history`); },
      crs: async () => {
        const [act, done] = await Promise.all([
          api(`${base}/change-requests?status=draft,open&hunks=1`),
          api(`${base}/change-requests?status=merged,closed`),
        ]);
        setCrs([...act, ...done]);
      },
      agents: async () => { applyAgentStatus(await api('/api/agent/status')); },
    };
    await Promise.all(what.filter((w) => jobs[w]).map((w) => jobs[w]().catch((e) => console.warn(w, e))));
    s.loaded = true;
  }
  /** 짧은 시간 안의 요청을 묶어서 한 번에 */
  let waiters = [];
  function refresh(what = ALL) {
    for (const w of what) pending.add(w);
    clearTimeout(timer);
    return new Promise((resolve) => {
      waiters.push(resolve);
      timer = setTimeout(async () => {
        const list = [...pending]; pending = new Set(); const done = waiters; waiters = [];
        const run = (inflight || Promise.resolve()).then(() => refreshNow(list));
        inflight = run; await run; if (inflight === run) inflight = null; done.forEach((f) => f());
      }, 60);
    });
  }
  function normMemo(m) {
    const link = m.link !== undefined ? m.link : (m.proposal ? { type: 'proposal', pid: m.proposal.pid } : null);
    const mine = (m.author || '').startsWith(me().name) || me().role === 'admin';
    return { ...m, link, body: m.body != null ? m.body : m.text, editable: m.editable != null ? m.editable : mine };
  }
  let paraCache = { list: null, map: null };
  function byRef(ref) {
    if (paraCache.list !== s.paragraphs) paraCache = { list: s.paragraphs, map: new Map(s.paragraphs.map((p) => [p.ref, p])) };
    return paraCache.map.get(ref) || null;
  }
  const textOf = (ref) => byRef(ref)?.text ?? '';
  const request = (rid) => s.requests.find((r) => r.rid === Number(rid)) || null;
  const proposal = (pid) => s.proposals.find((p) => p.pid === Number(pid)) || null;
  const attachment = (aid) => s.attachments.find((a) => a.aid === aid) || null;
  const memo = (mid) => s.memos.find((m) => m.id === mid) || null;
  const cr = (cid) => s.crs.find((c) => c.cid === Number(cid)) || null;
  const proposalsOf = (rid) => s.proposals.filter((p) => p.rid === Number(rid));
  const commentsOf = (r) => {
    const ids = new Set(r?.comments || []);
    return s.memos.filter((m) => ids.has(m.id) || (m.link?.type === 'comment' && m.link.rid === r?.rid));
  };
  /** AI 작업의 '내 눈의 진행'(util.requestProgress, §9.7) — 요청 또는 rid. 모르는 요청이면 null */
  function progress(r0) {
    const r = r0 && typeof r0 === 'object' ? r0 : request(r0);
    if (!r) return null;
    return requestProgress(r, proposalsOf(r.rid), viewOpts());
  }
  /**
   * 이 요청을 한 번에 정할 수 있는 사람(웹 단추) = 요청자·관리자(서버는 로그인한 사람 누구나 받는다 — §9.5).
   * v0.4: 수정 권한이 있어야 하고(서버 403 FORBIDDEN), '간단히' 보기에서 숨는 남의 요청은 한 줄 요약뿐이라 단추가 없다(§4.1)
   */
  const canResolve = (r) => !!r && (r.by === myName() || r.recoveryOwner === myName() || state.me?.role === 'admin') && canDecide() && !requestHidden(r);

  // ── 변경 요청·에이전트 상태 ──
  function setCrs(list) {
    // 내 승인이 살아 있던 변경 요청 — 새 목록에서 그 승인이 낡았으면(작성자가 승인 뒤 수정본을 바꿈, 서버 r.stale) 알린다
    const me = myName();
    const live = new Set(s.crs.filter((c) => ACTIVE_CR.has(c.status) && myApprovalState(c, me) === 'live').map((c) => c.cid));
    s.crs = [...list].sort((a, b) => (CR_ORDER[a.status] ?? 9) - (CR_ORDER[b.status] ?? 9) || b.cid - a.cid);
    for (const c of s.crs) {
      if (live.has(c.cid) && ACTIVE_CR.has(c.status) && myApprovalState(c, me) === 'stale') toast(staleApprovalText(c.cid), { kind: 'warn', ms: 9000 });
    }
    setMyCr(s.crs.find((c) => ACTIVE_CR.has(c.status) && c.author === myName()) || null, { fromList: true });
  }
  /** 내 변경 요청을 바꾼다(수정본 저장 응답·목록). cr 이 null 이면 내 진행 중 변경 요청 없음 */
  function setMyCr(next, { fromList = false } = {}) {
    const c = next && ACTIVE_CR.has(next.status) && next.author === myName() ? next : null;
    s.myCr = c;
    s.draft.unsupported = c?.unsupported || [];
    if (fromList) return;
    // 목록에도 같은 것을 둔다(목록이 다시 오기 전에 화면이 맞게). 내 진행 중 변경 요청이 없어졌으면(수정본이 기준과 같아져 지워짐 등)
    // 목록의 내 초안을 뺀다 — 반영·닫힘은 곧 오는 목록이 맞춘다
    if (c) {
      const i = s.crs.findIndex((x) => x.cid === c.cid);
      if (i >= 0) s.crs.splice(i, 1, c); else s.crs = [c, ...s.crs];
    } else s.crs = s.crs.filter((x) => !(x.author === myName() && x.status === 'draft'));
  }
  function applyAgentStatus(st) {
    s.agentMe = { online: !!st?.me?.online, sessions: Array.isArray(st?.me?.sessions) ? st.me.sessions : [] };
    const out = {};
    for (const u of st?.users || []) out[u.user] = (u.agents || []).map((a) => ({ agent: a.agent, channel: !!a.channel }));
    s.agents = out;
  }

  // ── 대상(target) ──
  function targetForParagraph(ref) {
    const t = textOf(ref);
    return { ref, start: 0, end: cpLen(t), text: t, refs: [ref], display: t, whole: true, tableKey: byRef(ref)?.cell?.table };
  }
  /**
   * 편집기 선택(플러그인 CoworkSelection — 편집기가 지금 기준 ref·offset 으로 옮겨 준다, web/editor.js) → 요청·메모 대상(v0.2 모양).
   *  - 캐럿만 있거나(collapsed) 내가 넣은 문단(기준에 없음)이면 그 문단 전체(넣은 문단이면 앞 기준 문단 — note 로 알린다).
   *  - 문단 전체(우클릭이 선택 밖, whole)면 지금 기준 그 문단 글 전체.
   *  - 펼친 선택: 서버 규칙 그대로 { ref, start, end(끝 문단 안), text(고른 기준 글 — 여러 문단은 '\n' 으로 이음), refs }. 메모는 첫 문단만(memoEnd).
   *    고른 글이 내 수정본에서 고친 글이라 기준 문서에 없으면(편집기에 보이는 글 draftText ≠ 기준 글) draftOnly — 창에는 보이는 글을 싣고
   *    AI 요청은 막는다(targetProblem). 편집기 기준이 옛것이라(최신 반영 전) 그 문단이 지금 기준에 없으면 gone, 글이 바뀌었으면 stale.
   */
  function targetFromCw(sel) {
    if (!sel) return null;
    if (sel.gone) return { ref: null, refs: [], start: 0, end: 0, text: '', display: sel.draftText || sel.text || '', gone: true };
    if (!sel.ref) return null;
    if (sel.inserted || sel.collapsed) {
      const t = targetForParagraph(sel.inserted ? (sel.afterRef || sel.ref) : sel.ref);
      if (sel.cell) t.tableKey = sel.tableKey || t.tableKey;
      if (sel.inserted) {
        t.note = '내가 넣은 문단은 아직 공유 문서에 없어 앞 문단을 대상으로 합니다';
        // 내가 넣은 문단 안의 글을 골랐다 — 그 글은 기준 문서에 없다
        if (!sel.collapsed && sel.draftText) { t.draftOnly = true; t.display = sel.draftText; }
      }
      return t;
    }
    if (sel.whole) {
      // 문단 전체 = 지금 기준 그 문단 글 전체(서버가 받는 글). 표를 품은 문단이면 그 표(플러그인 tableKey)
      const t = targetForParagraph(sel.ref);
      t.tableKey = sel.tableKey ?? t.tableKey;
      if (sel.source === 'draft') t.note = '내가 고친 문단 — 고치기 전 글(공유 문서)을 대상으로 합니다';
      return t;
    }
    const refs = Array.isArray(sel.refs) && sel.refs.length ? sel.refs : [sel.ref];
    const text = String(sel.text ?? '');
    const first = text.split('\n')[0];
    const out = { ref: sel.ref, start: sel.start, end: sel.end, text, refs, display: text, tableKey: sel.tableKey ?? byRef(sel.ref)?.cell?.table };
    if (refs.length > 1) { out.endRef = refs[refs.length - 1]; out.memoEnd = sel.start + cpLen(first); }
    else if (sel.endRef && sel.endRef !== sel.ref) { out.end = sel.start + cpLen(first); out.text = first; out.display = first; }   // 끝 문단을 모르면 첫 문단만
    if (sel.stale) out.stale = true;
    if (sel.source === 'draft' && typeof sel.draftText === 'string' && sel.draftText !== (refs.length > 1 ? first : out.text)) {
      out.draftOnly = true; out.display = sel.draftText; out.note = '내가 고친 글 — 공유 문서에는 아직 없습니다';
    }
    return out;
  }
  const isCellRef = (ref) => !!byRef(ref)?.cell || (byRef(ref)?.where === '표' && /\/n\d+$/.test(ref) && byRef(ref)?.cell !== null);
  /** 표를 품은 본문 문단인가(표 채우기 대상) */
  const hasTable = (ref) => !!ref && !/\/n\d+/.test(ref) && s.paragraphs.some((p) => p.ref.startsWith(`${ref}/`) && (p.cell || (p.cell === undefined && p.where === '표')));

  // ── 쓰기 ──
  async function call(fn, what = ALL) {
    s.busy++;
    try { const r = await fn(); await refresh(what); return r; } finally { s.busy--; }
  }
  /** 메모 자리: 한 문단 안(여러 문단을 골랐으면 첫 문단의 고른 곳부터 끝까지 — memoEnd) */
  const memoBody = (t) => ({ ref: t.ref, start: t.start, end: t.memoEnd ?? t.end });

  async function addMemo(target, text) {
    const m = await call(() => api(`${base}/memos`, { method: 'POST', body: { ...memoBody(target), text } }), ['memos', 'info', 'history', 'paragraphs']);
    toast('메모를 달았습니다'); emit('memo', m); return m;
  }
  async function editMemo(m, text) {
    const r = await call(() => api(`${base}/memos/${m.id}`, { method: 'PATCH', body: { text } }), ['memos', 'requests', 'proposals', 'info']);
    toast('메모를 고쳤습니다'); return r;
  }
  async function deleteMemo(m, { confirmFirst = true } = {}) {
    if (confirmFirst && !confirm('메모를 지울까요?')) return false;
    await call(() => api(`${base}/memos/${m.id}`, { method: 'DELETE' }), ['memos', 'proposals', 'requests', 'info']);
    toast('메모를 지웠습니다'); return true;
  }
  /** 메모 답글(§3.6) — 누구나 */
  async function replyMemo(m, text) {
    const mid = m?.id ?? m;
    const r = await call(() => api(`${base}/memos/${encodeURIComponent(mid)}/replies`, { method: 'POST', body: { text } }), ['memos', 'requests', 'proposals', 'info']);
    toast('답글을 달았습니다'); return r;
  }
  /**
   * 'AI에게 요청하기' — 메모 답장을 그 메모 자리의 AI 작업(지시)으로 이어 맡긴다(서버가 같은 글을 답글로도 남긴다). 보낼 곳은 서버가 앞 작업 경로로 정한다
   * → 서버 응답(request·route·hint). 서버 AI 가 바로 처리하면 결과까지 기다린다
   */
  async function askAiFromMemo(m, text) {
    const mid = m?.id ?? m;
    s.busy++; s.sending++;
    try {
      const r = await api(`${base}/memos/${encodeURIComponent(mid)}/ask-ai`, { method: 'POST', body: { text } });
      await refresh();
      const rid = r?.request?.rid;
      if (rid != null) s.activeRid = rid;
      toast(rid != null ? `AI 작업 #${rid} 요청` : 'AI에게 보냈습니다');
      return r;
    } catch (e) {
      if (e.data?.request) await refresh();   // 서버 AI 실패 — 요청은 남았다
      throw e;
    } finally { s.busy--; s.sending--; }
  }
  /** 메모 완료(true — 서버 resolve)·다시 열기(false) — 누구나 */
  async function resolveMemo(m, resolved = true) {
    const mid = m?.id ?? m;
    const r = await call(() => api(`${base}/memos/${encodeURIComponent(mid)}/resolve`, { method: 'POST', body: { resolved: !!resolved } }), ['memos', 'requests', 'proposals', 'info']);
    toast(resolved ? '메모를 완료로 표시했습니다' : '메모를 다시 열었습니다'); return r;
  }
  /**
   * 제안 동작(v0.2 경로): apply = '기준에 바로 적용'(관리자·allowDirectApply — 실시간 문서는 수정 권한: 공유 문서에 바로 반영, V4 §4.2),
   * reject·undo(적용 취소 — 실시간 '고친 글만' 문서는 글 되돌리기, 그 뒤 그 자리가 다시 고쳐졌으면 서버 409 STALE 글을 그대로 던진다)·reopen
   */
  async function proposalAction(p, action) {
    const pid = p.pid ?? p;
    // 실시간 문서: 서버가 공유 문서를 고치기 전에 이 창에서 친 글을 먼저 보낸다(밀어 넣기 — 서버가 그 위에서 반영·되돌린다)
    if (realtime() && (action === 'apply' || action === 'undo')) {
      await saveDraftNow();
      if (s.editor?.dirty || s.live.error) throw new Error(s.live.error || '저장하지 못한 편집이 있습니다. 저장을 마친 뒤 반영하세요.');
    }
    const r = await call(() => api(`${base}/proposals/${pid}/${action}`, { method: 'POST' }));
    const label = realtime() ? { apply: '문서에 반영', reject: '거절', undo: '되돌림', reopen: '다시 열기' }[action] : { apply: '문서에 적용', reject: '거절', undo: '복구', reopen: '다시 열기' }[action];
    toast(`제안 #${pid} ${label}`); emit('doc-edit', { pid, action }); return r;
  }
  const applyProposal = (p) => proposalAction(p, 'apply');
  /**
   * 거절. 내가 내 수정본에 반영해 둔 제안이 지금도 편집기 글에 들어 있으면 편집기에서 먼저 되돌린다(§9.7):
   * 바꿈 = applyText({ ref, find: replace, replace: find }) — 못 찾으면 알림 '편집기에서 직접 되돌리세요', 문단 추가 = 알림만. 그 뒤 거절
   */
  async function rejectProposal(p0) {
    const pid = Number(p0?.pid ?? p0);
    const p = proposal(pid) || (p0 && typeof p0 === 'object' ? p0 : null);
    const ed = s.editor;
    if (p && p.status === 'pending' && adoptedByMe(p) && adoptionInEffect(p, s.draft) && ed?.ready) {
      if (formatAdoptionOf(p, myName())) { const r = await undoAdoptFormat(p); if (!r?.ok) return r; }
      else if ((p.type || 'replace') === 'insert') toast(`제안 #${pid}: 내 수정본에 넣은 문단은 편집기에서 직접 지우세요`, { kind: 'warn', ms: 7000 });
      else {
        const arg = revertArgOf(p);
        let r = null;
        if (arg && !ed.locked) { try { r = await ed.applyText(arg); } catch { r = null; } }
        if (r?.ok) {
          try { await ed.syncDraft?.(); } catch { /* 다음 'draft' 이벤트가 맞춘다 */ }
          ed.saveSoon?.();
        } else toast(`제안 #${pid}: 편집기에서 직접 되돌리세요(내 수정본에서 바뀐 글을 찾지 못했습니다)`, { kind: 'warn', ms: 7000 });
      }
    }
    return proposalAction(p || pid, 'reject');
  }
  const undoProposal = (p) => proposalAction(p, 'undo');
  const reopenProposal = (p) => proposalAction(p, 'reopen');
  async function patchProposal(p, patch) { return call(() => api(`${base}/proposals/${p.pid ?? p}`, { method: 'PATCH', body: patch }), ['proposals', 'memos']); }
  /**
   * 변경 하나 또는 묶음(교체 = 삭제+삽입, 개체 짝). 묶음은 한 번에(POST /changes/resolve — 서버 엔진이 큰 번호부터 풀며 번호 다시 매김을 따라간다:
   * 하나씩 부르면 개체째 지운 안쪽 변경 때문에 뒤 번호가 밀려 엉뚱한 변경을 정할 수 있다)
   */
  async function resolveChange(c, mode) {
    const ids = (Array.isArray(c) ? c : [c]).map((x) => Number(x.id ?? x)).sort((a, b) => b - a);
    await call(async () => {
      if (ids.length > 1) await api(`${base}/changes/resolve`, { method: 'POST', body: { ids, mode } });
      else for (const cid of ids) await api(`${base}/changes/${cid}/${mode}`, { method: 'POST' });
    });
    toast(mode === 'accept' ? `변경을 적용(수락)했습니다${ids.length > 1 ? ` (${ids.length}건)` : ''}` : `변경을 복구(거절)했습니다${ids.length > 1 ? ` (${ids.length}건)` : ''}`);
  }

  // 요청(AI 작업)
  function requestBody(c) {
    // 서버 대상 모양만(§ V2 target: ref·start·end·text·refs·tableKey) — 창 표시용 칸(display·note·draftOnly …)은 보내지 않는다
    const src = c.target || {};
    const t = src.scope === 'document' ? { scope: 'document' } : { ref: src.ref, start: src.start, end: src.end, text: src.text, refs: src.refs };
    if (src.scope !== 'document' && src.tableKey) t.tableKey = src.tableKey;
    for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
    const body = { kind: c.kind, preset: c.kind === 'polish' ? c.preset || 'concise' : null, instruction: c.instruction || '', target: t, attachments: [...c.attachments], options: { count: c.kind === 'suggest' ? Number(c.count) || 1 : undefined, includeInstruction: !!c.includeInstruction }, summary: null };
    if (c.route) body.route = c.route;
    if (c.tutorialStep) body.tutorialStep = c.tutorialStep;   // 튜토리얼 6 의 단계(연결이 없으면 그 단계의 예시 답변)
    if (c.format) body.options.format = c.format;
    return body;
  }
  let formattingLoad = null;
  async function loadFormatting() {
    const version = Number(s.info?.version) || 0;
    if (s.formatting && s.formattingVersion === version) return s.formatting;
    if (formattingLoad) return formattingLoad;
    formattingLoad = (async () => {
      const r = await api(`${base}/formatting`);
      s.formatting = r.catalog || null; s.formattingVersion = version;
      return s.formatting;
    })();
    try { return await formattingLoad; } finally { formattingLoad = null; }
  }
  async function createRequest(c) {
    s.busy++; s.sending++;
    try {
      let body = requestBody(c);
      if (!v2()) body = { ...body, ref: body.target.ref || undefined, instruction: body.instruction || `${kindLabel(c.kind)}${c.preset ? `(${presetLabel(c.preset)})` : ''}: 「${clip(body.target.text, 200)}」` };
      const r = await api(`${base}/requests`, { method: 'POST', body });
      await refresh(); return r;
    } catch (e) {
      if (e.data?.request) { await refresh(); return { failed: true, request: e.data.request, message: e.message }; }
      throw e;
    } finally { s.busy--; s.sending--; }
  }
  async function patchRequest(r, patch) {
    return call(() => api(`${base}/requests/${r.rid}`, { method: 'PATCH', body: patch }), ['requests', 'memos', 'info']);
  }
  const cancelRequest = (r) => call(() => api(`${base}/requests/${r.rid}/cancel`, { method: 'POST' })).then(() => toast(`AI 작업 #${r.rid} 취소`));
  const retryRequest = (r) => call(() => api(`${base}/requests/${r.rid}/retry`, { method: 'POST' })).then(() => toast(`AI 작업 #${r.rid} 다시 요청`));
  async function recoverRequest(r) {
    await saveDraftNow();
    if (s.editor?.dirty || s.live.error) throw new Error(s.live.error || '편집을 저장한 뒤 다시 요청하세요.');
    const out = await call(() => api(`${base}/requests/${r.rid}/recover`, { method: 'POST' }), ['requests', 'proposals', 'memos', 'info']);
    if (out?.request) { s.activeRid = out.request.rid; s.tab = 'ai'; s.panelPing++; }
    toast(`AI 작업 #${r.rid}의 남은 제안을 현재 문서로 다시 요청했습니다. 이전 제안은 새 결과가 나올 때까지 유지됩니다.`);
    return out;
  }

  // ── AI 작업 하나를 한 번에 정하기(§9.5·§9.7) ──
  const resolving = new Set();   // 지금 정하는 중인 rid(두 번 누름·레일과 탭에서 같이 누름)
  /** 요청 보기(응답의 request)를 목록에 바로 넣는다(다시 읽기 전에 카드가 맞게) */
  function putRequest(v) {
    if (!v || v.rid == null || (v.docId && v.docId !== id)) return;
    const i = s.requests.findIndex((x) => x.rid === v.rid);
    if (i >= 0) s.requests.splice(i, 1, v);
  }
  /** 'rest' 와 내 눈의 목록이 같으면 'rest'(서버가 그 순간의 남은 것을 고른다), 다르면(내 반영을 Ctrl+Z 로 되돌림 등) 내 눈의 pid 목록 */
  function restOr(mine, theirs) {
    const a = [...new Set(mine.map(Number))].sort((x, y) => x - y); const b = [...new Set((theirs || []).map(Number))].sort((x, y) => x - y);
    return a.length === b.length && a.every((x, i) => x === b[i]) ? 'rest' : a;
  }
  /**
   * AI 작업 하나를 한 번에 정한다(POST /requests/:rid/resolve). mode:
   *  - 'adopt': 남은 바꿈·문단 추가 제안(여러 안 묶음·표 빼고, 내가 반영해 두어 편집기 글에 들어 있는 것도 빼고)을 편집기에 한 번에 넣고
   *    (d.editor.applyBatch — 트랜잭션 하나 = Ctrl+Z 한 번) 넣은 것만 반영 기록 { adopt, cid }. 넣지 못한 것은 알림에 이유별 수
   *  - 'apply': 기준에 바로 적용 { apply: 'rest' }(관리자·allowDirectApply — 서버도 막는다), 남은 표 제안도
   *  - 'reject': 남은 것 거절 { reject: 'rest' }(여러 안 묶음의 대기 안 포함)
   * → 서버 응답({ request, results, counts, version, milestone }) 또는 null(하지 않음)
   */
  async function resolveRequest(r0, mode0) {
    const r = r0 && typeof r0 === 'object' ? (request(r0.rid) || r0) : request(r0);
    if (!r) { toast('AI 작업을 찾지 못했습니다'); return null; }
    const rid = Number(r.rid); const tag = `AI 작업 #${rid}`;
    if (resolving.has(rid)) return null;
    const g = progress(r);
    const post = (body) => api(`${base}/requests/${rid}/resolve`, { method: 'POST', body });
    // v0.4 실시간 문서(§4.2): [모두 반영] = 공유 문서에 바로(서버 resolve { apply }) — 편집기 applyBatch·반영 기록(adopt)을 쓰지 않는다.
    // 반영하면 WS doc changed 로 모든 편집기(요청자 것도)가 따라간다(web/editor.js 맞추기)
    const liveAdopt = mode0 === 'adopt' && realtime();
    const mode = liveAdopt ? 'apply' : mode0;
    resolving.add(rid); s.busy++;
    try {
      if (mode === 'adopt') {
        const ed = s.editor;
        if (!ed?.ready) { toast('편집기가 아직 준비되지 않았습니다 — 잠시 뒤 다시 누르세요'); return null; }
        if (ed.locked) { toast(`편집기가 잠시 잠겨 있습니다(${ed.locked}) — 끝난 뒤 다시 하세요`); return null; }
        const NO_BATCH = '이 편집기 빌드는 제안을 한 번에 반영할 수 없습니다 — npm run build:studio 로 다시 빌드하세요(하나씩 보기에서 하나씩은 반영할 수 있습니다)';
        if (typeof ed.applyBatch !== 'function') { toast(NO_BATCH, { kind: 'error', ms: 8000 }); return null; }
        const list = (g?.openPids || []).map((pid) => proposal(pid)).filter((p) => p && p.status === 'pending' && p.gid == null && !['table', 'table_edit', 'toc', 'figure', 'page_layout', 'delete'].includes(p.type || 'replace')).sort((a, b) => a.pid - b.pid);
        if (!list.length) { toast(`${tag}: 반영할 남은 제안이 없습니다${g?.openAlt ? ' — 여러 안은 하나씩 보기에서 고르세요' : ''}`); return null; }
        // 서식은 서버가 현재 수정본 위에 적용한다. 각 성공 뒤 저장·다시 열기를 마쳐 다음 제안을 처리한다.
        if (list.some(isRichProposal)) {
          const results = [];
          for (const p of list.slice(0, 200)) {
            const result = await adoptProposal(p);
            results.push({ pid: p.pid, ...result });
            if (!result?.ok) break;
          }
          const count = results.filter(x => x.ok).length;
          await refresh(['requests', 'proposals', 'crs', 'info']);
          toast(`${tag}: ${count}건을 내 수정본에 반영했습니다${count < list.length ? ` · ${list.length - count}건 남음` : ''} — 서식 되돌리기는 그 제안에서`, { ms: 6500 });
          return { results, counts: { adopted: count, failed: results.filter(x => !x.ok).length } };
        }
        // 저장 중이거나 저장할 편집이 있으면 먼저 끝낸다 — 반영 기록에 실을 내 변경 요청(cid)이 서버와 맞게
        // (예: Ctrl+Z 로 되돌려 기준과 같아진 수정본은 저장되며 지워진다 — 지워질 변경 요청에 반영을 기록하면 그 기록도 같이 풀린다)
        try { await ed.saveNow?.(); } catch { /* 저장을 멈춘 상태 등 — 칩이 알린다. 반영은 그대로 한다 */ }
        if (!ed.ready || ed.locked) { toast('편집기가 다시 열리는 중입니다 — 잠시 뒤 다시 누르세요'); return null; }
        const take = list.slice(0, 200);   // 플러그인 한도(§9.6 — 넘으면 TOO_MANY)
        const res = await ed.applyBatch(take.map(batchItemOf));
        const results = Array.isArray(res?.results) ? res.results : [];
        const okPids = results.filter((x) => x && x.ok).map((x) => Number(x.key)).filter((x) => take.some((p) => Number(p.pid) === x));
        if (res?.reason === 'UNSUPPORTED') { toast(NO_BATCH, { kind: 'error', ms: 8000 }); return null; }   // 옛 편집기 빌드(web/editor.js applyBatch)
        if (!okPids.length) {
          const whole = res?.reason === 'READONLY' || res?.reason === 'ERROR' || res?.reason === 'TOO_MANY';
          const why = res?.reason === 'READONLY' ? '편집기가 읽기 전용입니다' : res?.reason === 'ERROR' ? `편집기 오류${res.message ? `: ${res.message}` : ''}`
            : res?.reason === 'TOO_MANY' ? '한 번에 넣을 수 있는 수를 넘었습니다' : `편집기에서 넣을 자리를 찾지 못했습니다${batchFailText(results)}`;
          toast(`${tag}: 반영하지 못했습니다 — ${why}${!whole && s.draft.behind > 0 ? ' — 옛 버전이라 없는 문단은 [최신으로 맞추기] 뒤에' : ''}`, { kind: 'error', ms: 7000 });
          return null;
        }
        // 바꾼 문단(s.draft)을 지금 맞춘다 — 반영 기록이 오는 순간 '반영함'으로 보이게(adoptProposal 과 같다)
        try { await ed.syncDraft?.(); } catch { /* 다음 'draft' 이벤트가 맞춘다 */ }
        let out = null;
        try {
          out = await post({ adopt: okPids, ...(s.myCr ? { cid: s.myCr.cid } : {}) });
          putRequest(out?.request);
        } catch (e) { toastError(e, `${tag} 반영 기록 실패(편집기 글은 들어갔습니다): `); }
        ed.saveSoon?.();
        await refresh(['requests', 'proposals', 'memos', 'crs', 'info']);
        if (!out) return null;   // 반영 기록 실패는 위 알림이 말한다(편집기 글은 Ctrl+Z 로 되돌릴 수 있다)
        const behindHint = s.draft.behind > 0 && results.some((x) => x && x.reason === 'NO_PARAGRAPH') ? ' — 옛 버전이라 없는 문단은 [최신으로 맞추기] 뒤에' : '';
        const more = list.length > take.length ? ` · ${list.length - take.length}건은 한 번에 넣을 수 있는 수(200)를 넘어 다음에` : '';
        // 편집기에 넣지 못한 것(이유별) · 넣었지만 서버가 반영 기록을 거절한 것(그새 남이 거절·적용 등)
        const fails = batchFailText(results) + (out.counts?.failed ? ` · ${out.counts.failed}건은 반영 기록 실패(${(out.results || []).filter((x) => !x.ok).map((x) => x.code || '?').slice(0, 3).join(', ')})` : '');
        toast(`${tag}: ${okPids.length}건을 내 수정본에 반영했습니다 — 되돌리기는 편집기에서 Ctrl+Z 한 번${fails}${more}${behindHint}`, { kind: fails || more ? 'warn' : 'info', ms: fails || more ? 8000 : 5000 });
        return out;
      }
      if (mode === 'apply' || mode === 'reject') {
        const serverOpen = Array.isArray(r.outcome?.openPids) ? r.outcome.openPids : null;
        let body;
        if (mode === 'apply') {
          const groupPid = new Set(proposalsOf(rid).filter((p) => p.gid != null).map((p) => Number(p.pid)));
          const mine = g?.openPids || [];
          if (!mine.length) { toast(liveAdopt ? `${tag}: 문서에 반영할 남은 제안이 없습니다${g?.openAlt ? ' — 여러 안은 하나씩 보기에서 고르세요' : ''}` : `${tag}: 문서에 적용할 남은 제안이 없습니다`); return null; }
          body = { apply: serverOpen ? restOr(mine, serverOpen.filter((pid) => !groupPid.has(Number(pid)))) : 'rest' };
          // 실시간 문서: 이 창에서 친 글을 먼저 보낸다(서버가 그 위에 반영한다)
          if (realtime()) {
            await saveDraftNow();
            if (s.editor?.dirty || s.live.error) throw new Error(s.live.error || '저장하지 못한 편집이 있습니다. 저장을 마친 뒤 반영하세요.');
          }
        } else {
          const mine = (g?.entries || []).filter((it) => it.state === 'open').flatMap((it) => it.list.filter((p) => p.status === 'pending').map((p) => Number(p.pid)));
          if (!mine.length) { toast(`${tag}: 거절할 남은 제안이 없습니다`); return null; }
          body = { reject: serverOpen ? restOr(mine, serverOpen) : 'rest' };
        }
        const n0 = g?.open || 0;
        const out = await post(body);
        putRequest(out?.request);
        await refresh(['requests', 'proposals', 'memos', 'info', 'changes', 'paragraphs', 'history', 'crs']);
        const c = out?.counts || {};
        const failed = c.failed ? ` · ${c.failed}건은 ${mode === 'apply' ? '적용' : '거절'}하지 못함(${(out.results || []).filter((x) => !x.ok).map((x) => `#${x.pid}`).slice(0, 5).join(' ')})` : '';
        if (mode === 'apply') {
          const v = out?.milestone?.v;
          if (liveAdopt) toast(`${tag}: ${c.applied ?? 0}건을 문서에 반영했습니다${v != null ? `(v${v})` : ''}${failed}`, { kind: failed ? 'warn' : 'info', ms: failed ? 8000 : 5000 });
          else toast(`${tag}: ${c.applied ?? 0}건을 문서에 적용했습니다${v != null ? `(v${v})` : ''}${failed}`, { kind: failed ? 'warn' : 'info', ms: failed ? 8000 : 5000 });
        } else if (failed) toast(`${tag}: ${c.rejected ?? 0}건을 거절했습니다${failed}`, { kind: 'warn', ms: 8000 });
        // 단추의 '남은 n건'(항목 — 여러 안 묶음은 하나)과 같은 수로 알린다
        else toast(`${tag}: 남은 ${n0 || c.rejected || 0}건을 거절했습니다`, { ms: 4000 });
        emit('doc-edit', { rid, action: mode });
        return out;
      }
      return null;
    } finally { s.busy--; resolving.delete(rid); }
  }
  /** [버전 저장](§9.4 manual): 지금 기록에 사람용 버전 하나(한 줄 메모) → { milestone } — 바뀐 것이 없으면 서버가 409 NO_CHANGES */
  async function saveMilestone(note = '') {
    const r = await call(() => api(`${base}/milestones`, { method: 'POST', body: { note: String(note ?? '').trim() } }), ['info', 'history']);
    const v = r?.milestone?.v;
    toast(v != null ? `${josa(`버전 v${v}`, '을/를')} 저장했습니다` : '버전을 저장했습니다');
    return r;
  }
  /** 기록 n 의 사람용 이름: 이정표면 'v3', 아니면 '10-23 01:16 기록'(기록 번호는 화면에 내지 않는다) */
  function versionLabel(n) {
    const ms = (s.history?.milestones || []).find((x) => Number(x.n) === Number(n));
    if (ms) return `v${ms.v}`;
    const rec = (s.history?.versions || []).find((x) => Number(x.n) === Number(n)) || (s.info?.versions || []).find((x) => Number(x.n) === Number(n));
    const st = fmtStamp(rec?.at);
    return st ? `${st} 기록` : '그 기록';
  }

  // 첨부
  async function uploadFiles(files) {
    const out = [];
    for (const f of files) {
      const max = state.config?.attachments?.maxBytes;
      if (max && f.size > max) { toast(`${f.name}: 크기 한도(${Math.round(max / 1048576)}MB)를 넘습니다`, { kind: 'error' }); continue; }
      try { out.push(await api(`${base}/attachments`, { method: 'POST', raw: true, body: await f.arrayBuffer(), headers: { 'x-file-name': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' } })); }
      catch (e) { toastError(e, `${f.name} 올리기 실패: `); }
    }
    if (out.length) { await refresh(['attachments']); toast(`첨부 ${out.length}개 올림`); }
    return out;
  }
  async function deleteAttachment(a) { if (!confirm(`첨부 ${josa(`'${a.name}'`, '을/를')} 지울까요? (메모에 남은 이름 기록은 그대로)`)) return; await call(() => api(`${base}/attachments/${a.aid}`, { method: 'DELETE' }), ['attachments']); }
  async function attachmentText(a, max = 4000) { return api(`${base}/attachments/${a.aid}/text?max=${max}`); }
  /** 파일 내려받기. name 이 없으면 Content-Disposition(filename*) 의 이름 → 실패하면 false, 되면 { name, headers }(참 값) */
  async function download(path, name) {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!r.ok) {
      let msg = ''; try { msg = (await r.json())?.message || ''; } catch { /* 본문 없음 */ }
      toast(`내려받기 실패(${r.status})${msg ? `: ${msg}` : ''}`, { kind: 'error' }); return false;
    }
    const cd = r.headers.get('content-disposition') || '';
    let fileName = name;
    if (!fileName) { const m = /filename\*=UTF-8''([^;]+)/i.exec(cd); try { fileName = m ? decodeURIComponent(m[1]) : 'document.hwpx'; } catch { fileName = 'document.hwpx'; } }
    const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { name: fileName, headers: r.headers };
  }
  /**
   * 버전·기록 복구(서버는 기록 n 을 받는다). 알림은 사람용 이름으로 — 'v3 내용으로 복구했습니다(v5 · 변경 추적, 문단 2개)'·
   * '10-23 01:16 기록 내용으로 …'(label 을 주면 그것). 응답의 v = 복구로 생긴 새 버전(바뀐 것이 없으면 없음)
   */
  async function restoreVersion(n, label = null) {
    const name = label || versionLabel(n);
    const r = await call(() => api(`${base}/versions/${n}/restore`, { method: 'POST' }));
    toast(r?.unchanged ? `${josa(name, '과/와')} 같습니다(바뀐 것 없음)` : `${name} 내용으로 복구했습니다(${r?.v != null ? `v${r.v} · ` : ''}변경 추적, 문단 ${r?.report?.changed?.length ?? '?'}개)`);
    return r;
  }

  // ── v0.3: 내 수정본·변경 요청(§3.3) ──
  const crPath = (cid) => `${base}/change-requests/${Number(cid)}`;
  /** 변경 요청 동작: 부르고 목록을 다시 읽는다 */
  async function crCall(fn, what = ['crs']) {
    s.busy++;
    try { const r = await fn(); await refresh(what); return r; } finally { s.busy--; }
  }
  const refreshCrs = () => refresh(['crs']);
  const crDetail = (cid) => api(crPath(cid));
  const submitCr = (cid, { title, description } = {}) => crCall(() => api(`${crPath(cid)}/submit`, { method: 'POST', body: { title, ...(description !== undefined ? { description } : {}) } }));
  const patchCr = (cid, patch) => crCall(() => api(crPath(cid), { method: 'PATCH', body: patch || {} }));
  const reviewCr = (cid, verdict, body) => crCall(() => api(`${crPath(cid)}/reviews`, { method: 'POST', body: { verdict, ...(body != null ? { body } : {}) } }));
  const addThread = (cid, { hid, ref, quote, text } = {}) => crCall(() => api(`${crPath(cid)}/threads`, { method: 'POST', body: { ...(hid ? { hid } : {}), ...(ref ? { ref } : {}), ...(quote ? { quote } : {}), text } }));
  const replyThread = (cid, tid, text) => crCall(() => api(`${crPath(cid)}/threads/${Number(tid)}/replies`, { method: 'POST', body: { text } }));
  const resolveThread = (cid, tid, resolved = true) => crCall(() => api(`${crPath(cid)}/threads/${Number(tid)}/resolve`, { method: 'POST', body: { resolved: !!resolved } }));
  /** 내 변경 요청인가(목록·내 진행 중 변경 요청으로) */
  const isMyCr = (cid) => cr(cid)?.author === myName() || s.myCr?.cid === Number(cid);
  /**
   * 내 수정본을 서버에서 바꾸는 동작(반영·닫기·다시 열기·최신 반영·버리기)을 편집기를 잠근 채 한다:
   * 잠그고(입력·우클릭 막음) → (save 면) 저장 안 된 편집을 먼저 저장(실패하면 던진다 — 동작하지 않음) → fn(서버 동작 + 편집기 다시 열기) → 풂.
   * 잠근 동안 친 글이 다시 열기로 사라지지 않게 하려는 것이다.
   */
  async function withMyDraft(label, fn, { save = true } = {}) {
    const unlock = s.editor?.lock ? s.editor.lock(label) : null;
    try {
      if (save) await saveDraftNow();
      return await fn();
    } finally { if (unlock) unlock(); }
  }
  /**
   * 반영(merge) → { version, cr, report }. 충돌이면 api() 가 던진 Error(.code 'MERGE_CONFLICT', .data.conflicts),
   * 승인 모자라면 .code 'NEED_APPROVAL' 을 그대로 던진다. 내 변경 요청이면 저장 안 된 편집을 먼저 저장하고(못 하면 반영하지 않음)
   * 반영 뒤 편집기를 새 기준(작업본)으로 다시 연다.
   */
  async function mergeCr(cid) {
    const was = cr(cid);
    const go = async () => {
      const r = await crCall(() => api(`${crPath(cid)}/merge`, { method: 'POST' }), ALL);
      if (r?.cr && r.cr.author === myName()) { setMyCr(null); await s.editor?.reload?.({ keepScroll: true }); }
      return r;
    };
    const r = isMyCr(cid) ? await withMyDraft('반영하는 중…', go) : await go();
    // 사람용 버전(§9.4) v — 옛 서버(v 없음)면 그때의 version 이 곧 버전이다
    const ver = r && 'v' in r ? r.v : r?.version;
    toast(`${josa(`변경 요청 #${Number(cid)}`, '을/를')} 반영했습니다${ver != null ? `(v${ver})` : ''}${was && was.author !== myName() ? ` — ${was.author}` : ''}`);
    return r;
  }
  /** 닫기. 내 변경 요청이면 저장 안 된 편집을 먼저 저장한다(닫힌 수정본 파일에 남아 다시 열면 돌아온다) */
  async function closeCr(cid) {
    const go = async () => {
      const r = await crCall(() => api(`${crPath(cid)}/close`, { method: 'POST' }));
      if (r?.author === myName()) { setMyCr(null); await s.editor?.reload?.({ keepScroll: true }); }
      return r;
    };
    return isMyCr(cid) ? withMyDraft('닫는 중…', go) : go();
  }
  /** 다시 열기. 내 것이면 저장 안 된 편집을 먼저 저장한다(그 편집이 새 초안이 되면 서버가 ACTIVE_EXISTS 로 막는다) */
  async function reopenCr(cid) {
    const go = async () => {
      const r = await crCall(() => api(`${crPath(cid)}/reopen`, { method: 'POST' }));
      if (r?.author === myName()) { setMyCr(r); await s.editor?.reload?.({ keepScroll: true }); }
      return r;
    };
    return isMyCr(cid) ? withMyDraft('다시 여는 중…', go) : go();
  }
  /**
   * 저장 안 된 편집을 지금 저장(편집기가 없으면 아무것도 안 함). 저장이 멈춘 상태(다른 곳에서 바뀜·옛 기준)면 던진다.
   * o.force: 멈춘 것을 풀고 이 창 글로 저장(다른 곳에서 바뀐 서버 수정본을 덮어씀)
   */
  const saveDraftNow = (o) => (s.editor?.saveNow ? s.editor.saveNow(o) : Promise.resolve(null));
  /**
   * 최신 반영(rebase, §3.5) → { cr, conflicts }. 먼저 저장 안 된 편집을 저장하고, 다시 맞춘 수정본을 편집기에 다시 연다.
   * 충돌 문단은 내 글을 남기고 s.draft.conflicts 에 둔다(레일·패널이 보여 준다).
   */
  async function rebaseMine() {
    const r = await withMyDraft('최신으로 맞추는 중…', async () => {
      s.busy++;
      let x;
      try { x = await api(`${base}/drafts/mine/rebase`, { method: 'POST' }); } finally { s.busy--; }
      setMyCr(x?.cr ?? null);
      await s.editor?.reload?.({ keepScroll: true });
      return x;
    });
    s.draft.conflicts = Array.isArray(r?.conflicts) ? r.conflicts : [];
    await refresh(['crs', 'info', 'paragraphs']);
    const n = s.draft.conflicts.length;
    toast(n ? `최신으로 맞췄습니다 — 겹친 ${n}문단은 내 글을 남겼습니다` : '최신으로 맞췄습니다', n ? { kind: 'error', ms: 6000 } : {});
    if (n) { const c = s.draft.conflicts[0]; const ref = c.curRef || c.ref; if (ref) s.editor?.focusRange?.({ ref, flash: true }); }
    return { cr: r?.cr ?? null, conflicts: s.draft.conflicts };
  }
  /** 내 수정 버리기: draft 면 지우고 open 이면 닫는다 → 편집기를 기준(작업본)으로 다시 연다(저장 안 된 편집도 버린다) */
  async function discardMine({ confirmFirst = true } = {}) {
    if (confirmFirst && !confirm('내 수정본을 버릴까요?\n(검토 중이면 변경 요청이 닫히고, 편집기는 공유 문서로 돌아갑니다)')) return false;
    await withMyDraft('수정본을 버리는 중…', async () => {
      await s.editor?.cancelSave?.();
      s.busy++;
      try { await api(`${base}/drafts/mine`, { method: 'DELETE' }); } finally { s.busy--; }
      setMyCr(null);
      await s.editor?.reload?.({ keepScroll: true });
    }, { save: false });
    await refresh(['crs']);
    toast('내 수정본을 버렸습니다');
    return true;
  }
  /**
   * 제안을 내 수정본(편집기 문서)에 반영: 바꿈은 applyText, 문단 추가는 insertParagraphAfter(트랜잭션 1개 = studio 되돌리기 1번),
   * 그 뒤 POST /proposals/:pid/adopt { cid } 로 기록하고 자동 저장을 앞당긴다. → { ok, reason? }
   * 이미 내 수정본에 반영해 둔 제안(서버 adopted 가 나)이고 그 문단이 지금도 바뀌어 있으면 또 바꾸지 않는다(reason 'ADOPTED') —
   * 같은 find 를 또 찾으면 문단의 다른 자리가 바뀐다. 되돌린 뒤라 그 문단이 기준과 같으면 그대로 반영한다.
   * 문단이 다른 편집으로도 바뀌어 있어 가릴 수 없으면 확인(confirm)을 받고, opts.force 면 묻지 않는다.
   */
  async function adoptProposal(p, opts = {}) {
    // v0.4 실시간 문서(§4.2): 반영 = 공유 문서에 바로(POST /proposals/:pid/apply — 수정 권한) — 편집기에는 WS doc changed 의 맞추기로 들어온다
    if (realtime()) {
      const pid = Number(p && typeof p === 'object' ? p.pid : p);
      try { await applyProposal(pid); return { ok: true }; } catch (e) { toastError(e, `제안 #${pid}: `); return { ok: false, reason: e.code || 'ERROR', message: e.message }; }
    }
    // 객체로 받으면 그 값(예: 고쳐서 반영 { ...p, replace })이 이기고, 상태·반영 기록은 지금 store 의 것으로 본다
    const fresh = proposal(p && typeof p === 'object' ? p.pid : p);
    const prop = p && typeof p === 'object' ? { ...(fresh || {}), ...p, status: fresh?.status ?? p.status, adopted: fresh ? fresh.adopted : p.adopted } : fresh;
    const ed = s.editor;
    if (!prop) { toast('제안을 찾지 못했습니다'); return { ok: false, reason: 'NO_PROPOSAL' }; }
    if (!ed?.ready) { toast('편집기가 아직 준비되지 않았습니다'); return { ok: false, reason: 'NOT_READY' }; }
    if (ed.locked) { toast(`편집기가 잠시 잠겨 있습니다(${ed.locked}) — 끝난 뒤 다시 하세요`); return { ok: false, reason: 'BUSY' }; }
    const type = prop.type || 'replace';
    if (['table', 'table_edit', 'toc', 'figure', 'page_layout', 'delete'].includes(type)) { toast(`${type === 'page_layout' ? '쪽 구성' : type === 'figure' ? '그림' : type === 'toc' ? '차례 새로 고침' : type === 'delete' ? '개체 지우기' : '표'} 제안은 [문서에 바로 적용]을 쓰세요`); return { ok: false, reason: 'TABLE' }; }
    if (prop.status !== 'pending') { toast(`대기 중인 제안만 반영할 수 있습니다(지금: ${prop.status})`); return { ok: false, reason: 'STATE' }; }
    if (isRichProposal(prop)) {
      if (adoptedByMe(prop) && formatAdoptionOf(prop, myName())) return { ok: false, reason: 'ADOPTED' };
      try {
        await ed.applyFormatProposal(prop.pid);
        await refresh(['proposals', 'requests', 'crs', 'info']);
        toast(`제안 #${prop.pid}의 글·서식을 내 수정본에 반영했습니다 — 서식 되돌리기는 그 제안에서`, { ms: 6500 });
        return { ok: true };
      } catch (e) { toastError(e, `제안 #${prop.pid}: `); return { ok: false, reason: e.code || 'ERROR', message: e.message }; }
    }
    if (!opts.force && adoptedByMe(prop)) {
      const st = await ed.draftState?.();
      if (adoptionInEffect(prop, st)) {
        const msg = `${josa(`제안 #${prop.pid}`, '은/는')} 이미 내 수정본에 반영했습니다 — 되돌리려면 편집기에서 Ctrl+Z`;
        const again = typeof confirm === 'function' && confirm(`${msg}.\n\n또 반영하면 그 문단의 다른 자리가 바뀔 수 있습니다. 그래도 반영할까요?\n(반영을 되돌린 뒤 다시 하는 것이면 [확인])`);
        if (!again) { toast(msg); return { ok: false, reason: 'ADOPTED' }; }
      }
    }
    let r;
    if (type === 'insert') r = await ed.insertParagraphAfter({ afterRef: prop.afterRef || prop.ref, text: prop.text || '' });
    else {
      const arg = { ref: prop.ref, find: prop.find ?? '', replace: prop.replace ?? '', occurrence: prop.occurrence || 1, label: `제안 #${prop.pid}` };
      if (Number.isInteger(prop.start) && Number.isInteger(prop.end)) { arg.start = prop.start; arg.end = prop.end; }
      r = await ed.applyText(arg);
    }
    if (!r?.ok) {
      // 내 수정본이 옛 기준이면(최신으로 맞추기 전) 지금 기준에 새로 생긴 문단은 편집기에 없다
      const noPara = s.draft.behind > 0 ? '그 문단은 내 수정본(옛 버전)에 없습니다 — [최신으로 맞추기] 뒤에 반영하세요' : '그 문단을 편집기에서 찾지 못했습니다';
      const why = { NOT_FOUND: '편집기 문단에서 바꿀 글을 찾지 못했습니다(이미 고쳤을 수 있음)', NO_PARAGRAPH: noPara, READONLY: '편집기가 읽기 전용입니다' }[r?.reason] || `반영하지 못했습니다${r?.message ? `: ${r.message}` : ''}`;
      toast(`제안 #${prop.pid}: ${why}`, { kind: 'error' });
      return r || { ok: false, reason: 'ERROR' };
    }
    // 바꾼 문단(s.draft)을 지금 맞춘다 — 플러그인 'draft' 이벤트(600ms 쉼, 자동 저장의 markClean 이 또 미룸)를 기다리면
    // 그사이 결과 창·레일이 '내 수정본에 반영됨' 대신 '내 수정본에 반영' 단추를 다시 보인다(ui.js adoptedByMe 는 s.draft 를 본다)
    try { await ed.syncDraft?.(); } catch { /* 다음 'draft' 이벤트가 맞춘다 */ }
    try { await api(`${base}/proposals/${prop.pid}/adopt`, { method: 'POST', body: s.myCr ? { cid: s.myCr.cid } : {} }); } catch (e) { toastError(e, `제안 #${prop.pid} 반영 기록 실패: `); }
    ed.saveSoon?.();
    refresh(['proposals', 'crs']);
    toast(`${josa(`제안 #${prop.pid}`, '을/를')} 내 수정본에 반영했습니다 — 되돌리기는 편집기에서 Ctrl+Z`);
    return { ok: true };
  }
  async function undoAdoptFormat(p0) {
    const p = proposal(p0?.pid ?? p0) || p0;
    const ed = s.editor;
    if (!ed?.ready || ed.locked) return { ok: false, reason: 'BUSY' };
    try {
      await ed.applyFormatProposal(p.pid, { undo: true });
      await refresh(['proposals', 'requests', 'crs', 'info']);
      toast(`제안 #${p.pid}의 서식 반영을 되돌렸습니다`);
      return { ok: true };
    } catch (e) { toastError(e, '서식 반영 되돌리기: '); return { ok: false, reason: e.code || 'ERROR', message: e.message }; }
  }
  /**
   * 한글로 저장 — 단추 하나(V4 §3): GET /file?kind=export 한 번 = 문서 설정 exportKind 대로(보이는 그대로 + 메모 / 변경 추적 포함 + 메모,
   * 승인 방식이면 진행 중 변경 요청의 검토 메모까지 — 서버가 정한다). 파일 이름은 서버 것(<제목>.hwpx).
   * 최종본을 만들지 못해 변경 추적 포함으로 냈으면(머리글 X-Export-Fallback) 알린다. 저장 안 된 내 편집을 먼저 저장·밀어 넣는다
   */
  async function downloadHangul() {
    try { await saveDraftNow(); } catch { /* 저장 실패는 칩이 보여 준다 — 내려받기는 계속 */ }
    const r = await download(`${base}/file?kind=export`, null);
    if (r && r.headers?.get?.('X-Export-Fallback')) toast('겹친 변경 추적이 있어 변경 추적 포함으로 저장했습니다(변경 추적을 정리하면 보이는 그대로 저장됩니다)', { kind: 'warn', ms: 8000 });
    return r;
  }

  // ── 떠 있는 창(요청 창 composer · 메모 달기 popover · 답글/의견 작은 창 reply) ──
  // 한 번에 하나만 뜬다. 보내지 않은 글은 창을 닫거나(Esc·닫기) 다른 창으로 바꿔도 버리지 않고 대상별로 둔다 —
  // 같은 대상(같은 문단의 요청·메모, 같은 메모의 답글, 같은 덩어리의 의견)의 창을 다시 열면 그 글이 돌아온다. 보내면 창이 글을 비운다.
  const unsent = new Map();   // 열쇠 → { text, attachments? }
  const WIN = {
    composer: { key: (m) => (m?.target ? `ask:${m.target.scope === 'document' ? 'doc' : m.target.ref}` : null), text: (m) => (m.phase === 'edit' ? String(m.instruction ?? '') : '') },
    popover: { key: (m) => (m?.target?.ref ? `memo:${m.target.ref}` : null), text: (m) => String(m.text ?? '') },
    reply: { key: (m) => (!m ? null : m.kind === 'memo' ? `reply:m:${m.memoId}` : `reply:d:${m.cid}:${m.hkey ?? m.hid ?? m.ref ?? ''}`), text: (m) => String(m.text ?? '') },
  };
  /** 떠 있는 창(kind)에 보내지 않은 글이 있는가 */
  const windowHasText = (kind) => { const m = s[kind]; return !!m && !!WIN[kind]?.text(m).trim(); };
  function stashWindow(kind) {
    const m = s[kind]; const w = WIN[kind]; if (!m || !w) return;
    const key = w.key(m); const text = w.text(m);
    if (!key || !text.trim()) return;
    unsent.set(key, kind === 'composer' ? { text, attachments: [...(m.attachments || [])] } : { text });
    if (unsent.size > 40) unsent.delete(unsent.keys().next().value);
  }
  function takeUnsent(kind, model) { const key = WIN[kind].key(model); const v = key ? unsent.get(key) : null; if (v) unsent.delete(key); return v || null; }
  /** 떠 있는 창 닫기 — 쓰던 글은 대상별로 둔다(다시 열면 돌아온다) */
  function closeWindow(kind) { if (!WIN[kind] || !s[kind]) return; stashWindow(kind); s[kind] = null; }
  /** 다른 창을 열기 전에 지금 떠 있는 창들을 닫는다(글은 둔다) */
  function replaceWindows() { for (const k of Object.keys(WIN)) closeWindow(k); }

  // ── 요청 창 ──
  /**
   * 요청 창 열기. opts: { preset, anchor, instruction, attachments, pickFile, pending, quick }
   * quick = AI 빠른 작업(검토·문장 고쳐 쓰기·다듬기 — 우클릭 'AI 빠른 작업 ▸'·도구 막대): 문서 설정 aiQuick 이 'send'(기본)면
   * 창을 연 채 곧바로 보낸다(autoSend — Composer 가 열리며 [보내기]와 같은 길로 한 번 보낸다. 보낼 수 없으면 보내지 않고 경고만 보인다).
   * 바로 보낼 때는 그 대상에 쓰다 둔 지시를 꺼내 함께 보내지 않는다(그 글은 그대로 두어 다음에 창을 열면 돌아온다)
   */
  function openComposer(target, kind = 'review', opts = {}) {
    if (!target) { toast('본문에서 범위나 문단을 먼저 고르세요'); return; }
    const why = targetProblem(target, kind, { realtime: realtime() });
    if (why) { toast(why, { kind: 'error', ms: 7000 }); return; }
    replaceWindows();
    const autoSend = !!opts.quick && quickAutoSend(s.settings, kind);
    // 바로 보내거나 지시를 넣어 열면(빠르게 맡기기·안내) 그 대상에 쓰다 둔 글은 꺼내지 않는다(그대로 두어 다음에 창을 열면 돌아온다)
    const saved = autoSend || opts.instruction ? null : takeUnsent('composer', { target });
    s.composer = { key: Date.now(), target, kind, preset: opts.preset || (kind === 'polish' ? 'concise' : null), instruction: opts.instruction || saved?.text || '', attachments: [...(opts.attachments || saved?.attachments || [])],
      count: 1, includeInstruction: false, anchor: opts.anchor || null, phase: 'edit', rid: null, error: '', hint: '', pickFile: !!opts.pickFile, pending: [...(opts.pending || [])], autoSend,
      ...(opts.tutorialStep ? { tutorialStep: opts.tutorialStep } : {}), ...(opts.route ? { route: opts.route } : {}) };
  }
  /** 메모 달기 창. 내 수정본에서 고친 글(기준 문서에 없음)을 골랐으면 그 문단 전체에 단다(창에 알린다) */
  function openPopover(kind, target, anchor) {
    if (!target) return;
    const why = targetProblem(target, 'memo', { realtime: realtime() });
    if (why) { toast(why, { kind: 'error', ms: 7000 }); return; }
    if (target.draftOnly && target.ref) target = { ...targetForParagraph(target.ref), tableKey: target.tableKey ?? byRef(target.ref)?.cell?.table, note: '내가 고친 글은 아직 공유 문서에 없어 문단 전체에 답니다' };
    replaceWindows();
    const saved = takeUnsent('popover', { target });
    s.popover = { key: Date.now(), kind, target, anchor, text: saved?.text || '' };
  }
  /** 답글·의견 작은 창(셸 QuickReply) — model: { key, kind: 'memo'|'draft', memoId | cid·hid·hkey·hunk, ref, quote, anchor } */
  function openReply(model) {
    replaceWindows();
    const saved = takeUnsent('reply', model);
    s.reply = { ...model, text: saved?.text || '' };
  }

  // ── 실시간 ──
  let ws = null; let closed = false; let dropped = false; let retryMs = 1500; let retryTimer = null;
  const quietUntil = new Map();   // 사람 → 이 시각까지 메모·문서 알림을 띄우지 않음(변경 요청 반영 직후)
  function connect() {
    if (closed) return;   // 다시 붙기를 기다리는 사이 문서를 떠났다(close) — 새로 붙지 않는다
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}&doc=${id}`);
    ws.onopen = () => {
      retryMs = 1500;
      // 끊겼다 다시 붙으면 그사이 놓친 알림이 있을 수 있다 → 전체 다시 읽기(v0.2 의 빠진 부분)
      if (dropped) { dropped = false; refresh().then(() => emit('reconnect', {})); }
      // 처음 붙을 때도: 편집기를 연 뒤 붙기 전까지 놓친 내 수정본 변화를 편집기가 확인한다(web/editor.js)
      else emit('ws-open', {});
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const mine = msg.by && isMe(msg.by);
      if (msg.type === 'presence') { onPresence(msg); return; }
      const ver = Number(msg.version) || 0;
      const bump = ver > 0 && ver > (Number(s.info?.version) || 0);
      const want = new Set();
      const add = (...xs) => xs.forEach((x) => want.add(x));
      if (msg.type === 'memo') add('memos', 'info', 'requests');
      else if (msg.type === 'proposal') add('proposals', 'memos', 'info', 'changes', 'paragraphs', 'requests');
      else if (msg.type === 'doc') {
        if (msg.action === 'deleted') { toast('문서가 지워졌습니다'); location.hash = '#/'; return; }
        // 사람용 버전(이정표, §9.4)만 생김 — 글은 그대로: 문서 정보(상단 v)·이력만 다시 읽는다
        if (msg.action === 'milestone') add('info', 'history');
        // v0.4 문서 설정이 바뀜(§1): 곧바로 설정·내 수정 권한을 맞추고(편집기가 방식을 바꿔 다시 연다) 문서 정보만 다시 읽는다
        else if (msg.action === 'settings') { onSettingsMsg(msg); add('info'); }
        // 문서함 자리·권한이 바뀜(docs/LIBRARY_SPEC.md): 내 권한(perms·canEdit)은 문서 정보로 다시 받는다
        else if (msg.action === 'access') add('info');
        // PC 폴더 문서의 파일 맞춤 상태(저장됨·쓰기 대기·읽기 실패)·함께 검토 보냄: 문서 정보만 다시 읽는다(web/local.js)
        else if (msg.action === 'local') add('info');
        // 문서 이름이 바뀜: 상단 제목만 곧바로 맞춘다
        else if (msg.action === 'renamed') { if (s.info && typeof msg.title === 'string') s.info.title = msg.title; }
        // 실시간 편집에서 겹쳐 내 글 일부가 덮였다(§2.3) — 그 사람(to)에게만 알림. 글은 함께 오는 'changed' 가 맞춘다
        else if (msg.action === 'live-overwrite') {
          if (msg.to && msg.to === myName() && msg.by && !isMe(msg.by)) toast(`${msg.by} 님이 같은 곳을 동시에 고쳐 내 글 일부가 바뀌었습니다(이력 탭에서 되돌릴 수 있음)`, { kind: 'warn', ms: 7000 });
        }
        // 실시간 밀어 넣기(§2.2): 타이핑마다(사람마다 1~3초) 오므로 꼭 필요한 것만 다시 읽는다 — 글(문단)·문서 정보는 언제나,
        // 메모·제안 자리는 문단을 넣거나 지웠을 때나 바뀐 문단에 메모·대기 제안이 있을 때만(글이 바뀌면 그 문단 안 자리가 움직인다),
        // 변경 추적은 변경 추적 문서이거나 남은 변경이 있을 때만. 변경 요청·이력은 다시 읽지 않는다(이력 탭은 버전을 보고 스스로 읽는다)
        else if (msg.live) {
          add('info', 'paragraphs');
          const structural = (Array.isArray(msg.inserted) && msg.inserted.length > 0) || (Array.isArray(msg.deleted) && msg.deleted.length > 0);
          const touched = new Set((Array.isArray(msg.changed) ? msg.changed : []).map(bodyRef));
          const hit = (ref) => !!ref && touched.has(bodyRef(ref));
          if (structural || (s.memos || []).some((m) => hit(m.ref))) add('memos');
          if (structural || (s.proposals || []).some((p) => p.status === 'pending' && hit(p.ref || p.afterRef))) add('proposals');
          if (s.settings?.track === 'tracked' || (s.changes || []).length) add('changes');
        }
        else add('info', 'changes', 'paragraphs', 'history', 'memos', 'proposals', 'crs');
      }
      else if (msg.type === 'activity') { pushActivity(msg.rid, msg.item); return; }   // 진행 기록 한 줄 — 다시 읽을 것 없음
      else if (msg.type === 'request') { add('requests', 'proposals', 'memos', 'info'); if (msg.action === 'done' && !s.sending && s.composer?.rid !== msg.rid) toast(`AI 작업 #${msg.rid} 완료 — ${msg.by}`); }
      else if (msg.type === 'attachment') add('attachments');
      else if (msg.type === 'cr') { add('crs'); onCrEvent(msg); }
      else if (msg.type === 'editing') { onEditing(msg); emit('ws', msg); return; }
      else if (msg.type === 'agent') add('agents');
      // 기준 버전이 바뀌었으면(메모·요청 메모도 버전을 만든다) 문단·변경 요청 상태도 — 편집기가 기준을 맞춘다(web/editor.js)
      // (실시간 밀어 넣기는 진행 중 변경 요청이 있을 때만 그 상태(뒤처짐 수)를 다시 읽는다 — 타이핑마다 오므로)
      if (bump) add('info', 'paragraphs', ...(msg.live && !(s.crs || []).some((c) => c.status === 'draft' || c.status === 'open') ? [] : ['crs']));
      if (want.size) refresh([...want]);
      // 다른 사람이 한 일만 짧게 알린다(서버 AI 가 내 요청을 처리하며 생긴 알림은 결과 창이 보여 주므로 뺀다).
      // 변경 요청 반영은 반영·문서 바뀜·기록 메모 알림이 잇달아 오므로 반영 하나만 알린다
      const human = msg.by && !mine && !/AI/.test(msg.by) && !msg.by.includes('(') && msg.by !== '예시 답변';   // 튜토리얼 6 의 준비된 답변도 AI 쪽
      const act = ACTION_LABEL[msg.action];
      const quiet = human && (quietUntil.get(msg.by) || 0) > Date.now();
      // 남(다른 사람이나 그 사람의 에이전트 — 나와 내 에이전트는 빼고)이 내 변경 요청에 승인·수정 요청·의견을 남김 → 작성자에게 알림
      // (상단 '변경 요청 #n · 검토 중 · 승인 a · 수정 요청 b · 의견 c' 칩은 다시 읽은 목록으로 맞는다)
      if (msg.type === 'cr' && msg.by && !mine && msg.author === myName()) {
        const fb = crFeedbackText(msg);
        if (fb) toast(fb, { ms: 5000 });
      }
      // 반영으로 생긴 사람용 버전(§9.4) — 알림 끝에 '(v4)'
      const vTag = msg.v != null ? `(v${msg.v})` : '';
      if (human && msg.type === 'cr' && msg.author === myName() && ['merged', 'closed'].includes(msg.action)) {
        // 남이 내 변경 요청을 반영·닫음 — 편집기는 새 상태로 다시 열거나(저장 안 된 편집 없음) 칩으로 묻는다(web/editor.js)
        if (msg.action === 'merged') quietUntil.set(msg.by, Date.now() + 4000);
        toast(`${josa(`내 변경 요청 #${msg.cid}`, '이/가')} ${msg.action === 'merged' ? `반영되었습니다${vTag}` : '닫혔습니다'}(${msg.by})`, { ms: 5000 });
      } else if (human && msg.type === 'cr' && ['open', 'merged'].includes(msg.action)) {
        if (msg.action === 'merged') quietUntil.set(msg.by, Date.now() + 4000);
        toast(msg.author === msg.by ? `${msg.by} 님의 변경 요청 #${msg.cid} ${msg.action === 'open' ? '검토 요청' : `반영${vTag}`}` : `${msg.by} 님이 ${josa(`변경 요청 #${msg.cid}(${msg.author})`, '을/를')} ${msg.action === 'open' ? '검토 요청했습니다' : `반영했습니다${vTag}`}`, { ms: 2600 });
      } else if (msg.type === 'doc' && msg.action === 'milestone' && msg.kind === 'manual' && msg.by && !mine) {
        // 남이 [버전 저장] — 요청 해결·반영·복구로 생긴 버전은 그 일의 알림이 따로 있다
        toast(`${msg.by} 님이 ${josa(`버전 v${msg.v}`, '을/를')} 저장했습니다`, { ms: 4000 });
      } else if (human && !quiet && act && ['memo', 'proposal'].includes(msg.type)) {
        toast(`${msg.by} 님이 ${josa(`${msg.type === 'memo' ? '메모' : '제안'}${msg.pid ? ` #${msg.pid}` : ''}`, '을/를')} ${act}`, { ms: 2600 });
        if (msg.type === 'proposal') quietUntil.set(`doc:${msg.by}`, Date.now() + 2000);   // 제안 적용·복구 뒤 '문서를 고쳤습니다'는 겹친다
      } else if (human && !quiet && msg.type === 'doc' && msg.action === 'changed' && !msg.live && !msg.cr && !((quietUntil.get(`doc:${msg.by}`) || 0) > Date.now())) toast(`${msg.by} 님이 문서를 고쳤습니다`, { ms: 2200 });
      emit('ws', msg);
    };
    ws.onclose = () => {
      if (closed) return;
      dropped = true;
      clearTimeout(retryTimer); retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(15000, retryMs * 2);
    };
  }
  function onPresence(msg) {
    const users = Array.isArray(msg.users) ? msg.users : [];
    s.presence = users;
    // 나간 사람의 '입력 중' 표시는 지운다
    const ed = {}; let changed = false;
    for (const [u, r] of Object.entries(s.editing)) { if (users.includes(u)) ed[u] = r; else changed = true; }
    if (changed) s.editing = ed;
    if (Array.isArray(msg.agents)) {
      const meOnline = msg.agents.some((a) => a.user === myName());
      if (meOnline !== s.agentMe.online) refresh(['agents']);
    }
  }
  function onEditing(msg) {
    if (!msg.user || isMe(msg.user)) return;
    const next = { ...s.editing };
    if (msg.ref) next[msg.user] = String(msg.ref); else delete next[msg.user];
    s.editing = next;
  }
  /** 남이 내 변경 요청을 반영·닫음 → 편집기를 새 기준으로(내 수정본 파일은 없어졌거나 닫힘) */
  function onCrEvent(msg) {
    if (msg.author !== myName()) return;
    if (msg.action === 'merged' || msg.action === 'closed') {
      if (s.myCr && s.myCr.cid === msg.cid) setMyCr(null);
      emit('my-cr', msg);
    }
  }
  function close() { closed = true; clearTimeout(timer); clearTimeout(retryTimer); retryTimer = null; if (ws) { ws.onclose = null; ws.close(); } }

  /**
   * 실시간 문서에 남은 내 수정본(승인 방식 때의 진행 중 변경 요청 — V4 §5)을 지금 문서에 반영(merge — 실시간 문서는 수정 권한이면 승인 없이).
   * 충돌이면 V3 의 최신 반영(rebase) 뒤 다시 반영한다. → 반영 응답 | null
   */
  async function mergeLeftover(cid) {
    try { return await mergeCr(cid); } catch (e) {
      if (e?.code !== 'MERGE_CONFLICT') throw e;
      toast(`변경 요청 #${cid}: 최신으로 맞춘 뒤 다시 반영합니다`, { ms: 4000 });
      await rebaseMine();
      return mergeCr(cid);
    }
  }

  // ── AI 작업 진행 기록 ──
  const activityLoaded = new Set();
  function pushActivity(rid, item) {
    if (rid == null || !item || item.n == null) return;
    const list = s.activity[rid] || (s.activity[rid] = []);
    if (list.some((x) => x.n === item.n)) return;
    list.push(item); list.sort((a, b) => a.n - b.n);
    if (list.length > 300) list.splice(0, list.length - 300);
  }
  /** 그 요청의 진행 기록(이미 받은 줄) */
  const activityOf = (rid) => s.activity[rid] || [];
  /** 서버에서 한 번 읽어 온다(문서를 처음 열었거나 처리 중에 들어왔을 때 — 그 뒤 줄은 WebSocket 으로 온다) */
  async function loadActivity(rid, { force = false } = {}) {
    if (rid == null || (!force && activityLoaded.has(rid))) return activityOf(rid);
    activityLoaded.add(rid);
    try { const out = await api(`${base}/requests/${rid}/activity`); for (const item of out.items || []) pushActivity(rid, item); }
    catch { activityLoaded.delete(rid); }   // 예전 서버(404)·끊김 — 다음에 다시
    return activityOf(rid);
  }
  const d = {
    s, id, base, on, emit, refresh, byRef, textOf, request, proposal, attachment, memo, cr, proposalsOf, commentsOf, isCellRef, hasTable,
    targetForParagraph, targetFromCw, targetProblem: (t, kind) => targetProblem(t, kind, { realtime: realtime() }),
    addMemo, editMemo, deleteMemo, replyMemo, askAiFromMemo, resolveMemo, applyProposal, rejectProposal, undoProposal, reopenProposal, patchProposal, resolveChange,
    createRequest, patchRequest, cancelRequest, retryRequest, uploadFiles, deleteAttachment, attachmentText, download, restoreVersion,
    progress, canResolve, resolveRequest, recoverRequest, proposalDone, saveMilestone, versionLabel,
    openComposer, openPopover, openReply, closeWindow, windowHasText, connect, close,
    isMe, colorOf, setMyCr, adoptedByMe,
    refreshCrs, crDetail, submitCr, patchCr, reviewCr, addThread, replyThread, resolveThread, mergeCr, closeCr, reopenCr,
    rebaseMine, discardMine, saveDraftNow, adoptProposal, undoAdoptFormat, loadFormatting, downloadHangul,
    // v0.4
    applyInfo, realtime, setView, requestHidden, proposalHidden, collapseDrafts, canDecide, patchSettings, listUsers, mergeLeftover,
    activityOf, loadActivity,
  };
  // d.me = 내 이름, d.editor = 편집기 손잡이(없으면 null) — 읽을 때마다 지금 값
  Object.defineProperty(d, 'me', { get: myName, enumerable: true });
  Object.defineProperty(d, 'editor', { get: () => s.editor, set: (v) => { s.editor = v; }, enumerable: true });
  return d;
}
