// 오른쪽 패널 탭(V3_SPEC §5.1): 검토 · 변경 요청 · AI 작업 · 변경 추적 · 첨부 · 이력
// 탭 id: review · cr · ai · change · attach · history (PANEL_TABS). 탭 머리줄까지 통째로 쓰려면 <PanelTabs/>.
import { ref, reactive, computed, watch, inject, onMounted, nextTick } from '/vendor/vue.esm-browser.prod.js';
import { state, api, toast, toastError, fmt, fmtShort, fmtSize, clip, kindLabel, presetLabel, STATUS_LABEL, KIND_ICON, copyText, fmtStamp, downloadName, milestoneAt, workEnv, agentEnvName } from './util.js';
import {
  Composer, ResultView, MemoEditor, AttachChips, DropZone, InlineConfirm, RequestActions, RequestActivity, agentPrompt, groupChanges,
  focusIn, setActiveAnn, requestBadge, requestKindText, requestPhase, requestGlance, Hint, COPY_TIP, isMeName, colorOf, cmpRef, retryTip,
} from './ui.js';
import { ReviewCard, ReviewRail, reviewItems, anchorIndex, itemForAnn, syncActiveDraft, ensureCollabCss } from './rail.js';
import { CrTab, CrList, CrDetail, CrSubmitDialog, CollabHost } from './crs.js';
import { ICON } from './icons.js';
import { AppliedHistory } from './applied-history.js';
import { requestWait } from './request-wait.js';
import { changeGroupLabel, changeText, visibleChanges } from './menumodel.js';
import { panelTabIds, REVIEW_FILTERS, reviewFilterIds, filterPass, groupHistory, liveGroupLabel } from './view.js';

ensureCollabCss();
export { ReviewRail, ReviewCard, reviewItems, CrTab, CrList, CrDetail, CrSubmitDialog, CollabHost };
// 셸(app.js)이 hid 만 들고 의견을 달 때(우클릭 '의견 달기' 작은 창): 작성자 저장으로 hid 가 바뀌어도 NO_HUNK 없이 — crs.js
export { addThreadByHid, addHunkThread, hunkKeys, threadsByHunk } from './crs.js';
export const ChangeRequestTab = CrTab;
export const CrsTab = CrTab;

const goTo = (d, ref_, start, end) => { if (ref_) focusIn(d, { ref: ref_, start, end }); };

// ───────── AI 작업(docs/UI_TERMS.md) ─────────
// 새 요청(요청 창 — 대상은 본문 선택, 없으면 문서 전체) → (누른 요청의) 결과 → 목록. 연결 안내는 사용 설명서(/help.html#ai — 상단 AI 알약·'?')
// 카드 한 장 = #n(종류는 title) · 상태 칩 하나(requestBadge — 보낸 곳·맡은 이·시각은 title) · 요청한 사람 · 시각 · 대상,
// 사람·AI 가 쓴 요약(자동 요약 'AI 검토 요청 — AI 처리 대기'는 상태를 되풀이하므로 숨김), 지시(접힘), 진행 줄·단추(RequestActions)
/** 카드에 보일 요약: 사람·AI 가 쓴 것만(summaryBy 'auto'·없음은 숨김 — server/memotext.js autoSummary) */
const realSummary = (r) => (r?.summaryBy === 'ai' || r?.summaryBy === 'user' ? String(r.summary || '') : '');
export const AiTab = {
  components: { Composer, ResultView, MemoEditor, AttachChips, CollabHost, RequestActions, RequestActivity, Hint },
  template: `<div class="tab-ai"><CollabHost/>
    <div class="sec-h">새 요청<Hint text="본문에서 범위를 고르면 그 범위가, 고르지 않으면 문서 전체가 대상입니다" href="/help.html#review"/></div>
    <Composer :model="pm" docked :key="pm.key"/>
    <div class="result-card" v-if="d.s.activeRid != null && d.request(d.s.activeRid) && !(pm.phase === 'result' && pm.rid === d.s.activeRid)">
      <ResultView :rid="d.s.activeRid"><template #head><button class="icon rs-close" title="결과 닫기" aria-label="결과 닫기" @click="d.s.activeRid=null" v-html="ICON.x"></button></template></ResultView></div>
    <div class="sec-h ai-list-h">AI 작업<span v-if="list.length" class="ai-count">{{ list.length }}건</span>
      <span class="ai-glance" v-if="glance.length"><button v-for="g in glance" :key="g.ph" class="glance" :class="['ph-' + g.ph, {on: filter === g.key}]" :data-ph="g.ph" :title="g.tip + (filter === g.key ? ' — 다시 누르면 전체' : ' — 누르면 이것만')" @click="filter = filter === g.key ? '' : g.key">{{ g.label }} {{ g.n }}</button></span>
      <span class="spacer"></span>
      <select v-model="filter" class="mini" aria-label="거르기"><option value="">전체</option><option value="act">확인 필요</option><option value="run">처리 중</option><option value="wait">응답 대기</option><option value="done">완료</option><option value="failed">실패·취소</option></select></div>
    <div class="card req" v-for="r in list" :key="r.rid" :class="['st-' + r.status, badge(r).cls, {active: d.s.activeRid===r.rid}]" :data-rid="r.rid">
      <div class="head"><b class="req-no" :title="kindText(r)">#{{ r.rid }}</b>
        <span class="pill req-st" :class="badge(r).cls" :title="badge(r).title">{{ badge(r).label }}</span>
        <span class="muted req-by">{{ r.by }} · {{ fmtShort(r.at) }}</span><span class="spacer"></span>
        <span class="ref" v-if="r.target" @click="go(r.target.ref, r.target.start, r.target.end)">{{ r.target.scope === 'document' ? '문서 전체' : r.target.ref }}</span></div>
      <div class="muted quote" v-if="r.target?.text">「{{ clip(r.target.text, 70) }}」</div>
      <MemoEditor v-if="editing===r.rid" :value="realSummary(r)" :rows="2" placeholder="메모 요약" :busy="savingSummary" @save="(t) => saveSummary(r, t)" @cancel="editing=null"/>
      <div class="sum" v-else-if="realSummary(r)"><span class="pre">{{ r.summary }}</span>
        <button class="icon" v-if="mine(r)" title="메모 요약 고치기" aria-label="메모 요약 고치기" @click="editing=r.rid" v-html="ICON.edit"></button></div>
      <AttachChips v-if="r.attachments?.length" :aids="r.attachments"/>
      <details v-if="r.instruction" class="instr"><summary>지시</summary><div class="pre">{{ r.instruction }}</div></details>
      <div class="muted instr-hidden" v-else-if="r.instructionHidden">지시는 요청자만 봅니다</div>
      <RequestActions :rid="r.rid" place="ai"/>
      <RequestActivity :rid="r.rid" place="ai"/>
      <div class="actions"><span class="muted" v-if="nComments(r)">의견 {{ nComments(r) }}건</span>
        <button class="icon" v-if="mine(r) && r.status==='done' && !realSummary(r) && editing!==r.rid" title="메모 요약 쓰기" aria-label="메모 요약 쓰기" @click="editing=r.rid" v-html="ICON.edit"></button>
        <span class="spacer"></span>
        <button class="small" @click="d.s.activeRid = d.s.activeRid===r.rid ? null : r.rid">{{ d.s.activeRid===r.rid ? '접기' : '결과' }}</button>
        <button class="small ai-send req-retry" v-if="['failed','cancelled','done'].includes(r.status) && mine(r) && !d.s?.info?.tutorialOwnAi" :title="retryTip(d, r)" @click="d.retryRequest(r).catch(err)">다시</button>
        <button class="small" v-if="['pending','working'].includes(r.status) && mine(r)" @click="d.cancelRequest(r).catch(err)">취소</button>
        <button class="small" v-if="r.status==='pending' && (!requestWait(r) || requestWait(r).manualCopy)" :title="COPY_TIP" @click="copyAgent(r)">프롬프트 복사</button></div>
    </div>
    <p class="muted" v-if="!list.length">AI 작업이 없습니다</p>
  </div>`,
  setup() {
    const d = inject('doc'); const filter = ref(''); const editing = ref(null);
    const pm = reactive({ key: 1, target: null, kind: 'review', preset: null, instruction: '', attachments: [], count: 1, includeInstruction: false, anchor: null, phase: 'edit', rid: null, error: '', route: 'auto' });
    // 대상: 편집기 선택(CoworkSelection — 캐럿만이면 문서 전체)
    function targetNow() {
      const sel = d.s.sel;
      if (sel && !sel.collapsed) { const t = d.targetFromCw(sel); if (t) return t; }
      return { scope: 'document', display: '문서 전체', refs: [] };
    }
    watch(() => d.s.sel, () => { if (pm.phase === 'edit') pm.target = targetNow(); }, { immediate: true });
    // 거르기: 진행 단계(확인 필요·처리 중·응답 대기 — ui.js requestPhase) 또는 끝난 상태(완료·실패·취소)
    const FILTER_PHASES = { act: ['act'], run: ['run'], wait: ['wait', 'late'] };
    const list = computed(() => {
      const f = filter.value;
      const pass = (r) => !f || (FILTER_PHASES[f] ? FILTER_PHASES[f].includes(requestPhase(d, r)) : f === 'done' ? r.status === 'done' : ['failed', 'cancelled'].includes(r.status));
      return (d.s.requests || []).filter(pass).slice().sort((a, b) => b.rid - a.rid);
    });
    // 한눈에: 내 차례·처리 중·응답 대기 수(누르면 그것만 — 거르기와 같은 값)
    const GLANCE_LABEL = { act: '확인', run: '처리 중', wait: '대기', late: '응답 없음' };
    const glance = computed(() => requestGlance(d, d.s.requests).map((g) => ({ ...g, key: g.ph === 'late' ? 'wait' : g.ph, label: GLANCE_LABEL[g.ph] })));
    // 상태 칩(카드마다 한 번 셈 — 확인 필요는 d.progress)
    const badges = computed(() => new Map(list.value.map((r) => [r.rid, requestBadge(d, r)])));
    const badge = (r) => badges.value.get(r.rid) || requestBadge(d, r);
    // [결과](레일·목록): 결과가 이미 위 요청 창에 떠 있으면 그 창을, 아니면 결과 카드를 보이게
    watch(() => d.s.activeRid, (rid) => {
      if (rid == null) return;
      nextTick(() => document.querySelector(pm.phase === 'result' && pm.rid === rid ? '.tab-ai .composer.docked' : '.tab-ai .result-card')?.scrollIntoView({ block: 'nearest' }));
    });
    const mine = (r) => r.by === state.me?.name || state.me?.role === 'admin';
    // 제안의 진행은 RequestActions(진행 줄 '제안 n건 — 반영 · 거절 · 남음'), 여기는 AI 의견 수만
    const nComments = (r) => d.commentsOf(r).length;
    const savingSummary = ref(false);
    async function saveSummary(r, t) {
      if (savingSummary.value) return;   // Ctrl+Enter 두 번 → 한 번만
      savingSummary.value = true;
      try { await d.patchRequest(r, { summary: t }); editing.value = null; toast('메모 요약을 고쳤습니다'); } catch (e) { toastError(e); } finally { savingSummary.value = false; }
    }
    async function copyAgent(r) { if (await copyText(agentPrompt(d, r))) toast('프롬프트를 복사했습니다 — AI 대화창에 붙여 넣으세요'); }
    return { d, pm, filter, editing, list, glance, badge, kindText: requestKindText, realSummary, mine, nComments, savingSummary, saveSummary, copyAgent, retryTip, ICON, COPY_TIP, requestWait, go: (...a) => goTo(d, ...a), err: toastError, clip, fmtShort };
  },
};

// ───────── 검토(레일의 모든 카드를 문서 순서로) ─────────
// 거르기: 자세히 = 전체·메모·AI·제안·수정 중·완료, 간단히 = 전체·메모·AI·완료(v0.4 §5 — view.js reviewFilterIds·filterPass).
// 보이는 글은 이름표만(docs/UI_TERMS.md) — 거르기 설명·문서 순서·↑↓ 는 title
export const ReviewTab = {
  components: { ReviewCard, CollabHost },
  template: `<div class="tab-review" @keydown="onKey">
    <div class="row filt rt-filters" role="group" aria-label="거르기">
      <button v-for="f in filters" :key="f.id" class="chip" :class="{on: filter===f.id}" :data-filter="f.id" :title="f.tip || null" @click="setFilter(f.id)">{{ f.label }} <span class="muted">{{ f.n }}</span></button></div>
    <div class="row rt-nav"><span class="muted rt-pos" title="문서 순서 · ↑↓ 키로 이동">{{ list.length ? (cur >= 0 ? (cur + 1) + ' / ' + list.length : list.length + '건') : '' }}</span><span class="spacer"></span>
      <label class="check rt-showres" title="완료한 메모·AI 작업도 편집기 강조와 문서 옆 메모로 옅게 보입니다"><input type="checkbox" v-model="d.s.showResolved"/> 완료 보기</label>
      <button class="small nav-prev" :disabled="!list.length" title="이전 항목 (↑)" aria-label="이전 항목" @click="step(-1)">↑</button>
      <button class="small nav-next" :disabled="!list.length" title="다음 항목 (↓)" aria-label="다음 항목" @click="step(1)">↓</button></div>
    <div class="rt-list" ref="listEl">
      <ReviewCard v-for="(it, i) in list" :key="it.key" :item="it" place="list" :pinned="i===cur" @activate="onActivate(i)"/></div>
    <p class="muted rt-empty" v-if="!list.length" :title="filter === 'all' ? '편집기에서 글을 고르고 우클릭 → AI에게 맡기기 · 메모 달기' : null">{{ empty }}</p>
    <CollabHost/>
  </div>`,
  setup() {
    const d = inject('doc'); const listEl = ref(null);
    if (!d.s.reviewFilter) d.s.reviewFilter = 'all';
    // 이 보기에 없는 거르기(간단히의 제안·수정 중)를 골라 두었으면 전체로
    const filter = computed(() => (reviewFilterIds(d.s.view).includes(d.s.reviewFilter) ? d.s.reviewFilter : 'all'));
    const items = computed(() => reviewItems(d));
    // 누른 수정 중 덩어리의 hid 가 작성자 저장으로 바뀌면 편집기 강조도 새 hid 로(좁은 창 — 레일이 없을 때도)
    watch(items, () => { if (!d.s.railOpen) syncActiveDraft(d, anchorIndex(items.value), items.value); });
    const pass = (it, f) => filterPass(it, f, d.s.view);
    const filters = computed(() => REVIEW_FILTERS.filter((f) => reviewFilterIds(d.s.view).includes(f.id)).map((f) => ({ ...f, n: items.value.filter((it) => pass(it, f.id)).length })));
    const list = computed(() => items.value.filter((it) => pass(it, filter.value)));
    const curKey = ref(null);
    const cur = computed(() => (curKey.value ? list.value.findIndex((it) => it.key === curKey.value) : -1));
    const empty = computed(() => ({ resolved: '완료한 항목 없음', memo: '메모 없음', ai: 'AI 작업 없음', proposal: '대기 중인 제안 없음', draft: '수정 중인 곳 없음' })[filter.value]
      || '검토할 것 없음');
    function setFilter(id) { d.s.reviewFilter = id; curKey.value = null; }
    function select(i, { focus = true } = {}) {
      const it = list.value[i]; if (!it) return;
      curKey.value = it.key;
      if (it.id != null) setActiveAnn(d, { kind: it.anchorKind, id: it.id });
      if (focus) focusIn(d, it.range || { ref: it.ref });
      nextTick(() => listEl.value?.querySelector(`[data-key="${CSS.escape(it.key)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
    function step(dir) {
      const n = list.value.length; if (!n) return;
      const i = cur.value < 0 ? (dir > 0 ? 0 : n - 1) : (cur.value + dir + n) % n;
      select(i);
    }
    // 카드를 누르면 카드가 이미 편집기로 옮겼다 — 여기서는 '지금 항목'만 맞춘다
    function onActivate(i) { const it = list.value[i]; if (it) curKey.value = it.key; }
    function onKey(e) {
      if (e.target.closest?.('textarea, input, select')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    }
    // 편집기 강조·우클릭 '보기'로 고른 것(d.s.active·d.s.activeMemo): 레일이 접힌 좁은 창이면 셸이 이 탭으로 옮긴다 —
    // 그 카드를 '지금 항목'으로 두고 보이게 스크롤한다(거르기에 걸리면 전체·완료로). 넓은 창은 레일이 그 카드를 고정한다
    function follow() {
      if (d.s.railOpen) return;
      const its = items.value;
      let it = itemForAnn(anchorIndex(its), its, d.s.active, d);
      if (!it && d.s.activeMemo != null) it = its.find((x) => x.memo && x.memo.id === d.s.activeMemo) || null;
      if (!it) return;
      if (!list.value.some((x) => x.key === it.key)) setFilter(it.resolved ? 'resolved' : 'all');
      curKey.value = it.key;
      nextTick(() => listEl.value?.querySelector(`[data-key="${CSS.escape(it.key)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
    watch(() => [d.s.active, d.s.activeMemo], follow);
    onMounted(follow);
    return { d, listEl, filter, filters, list, cur, empty, setFilter, step, onActivate, onKey };
  },
};

// ───────── 변경 추적(공유 문서) — 교체(지움+넣음)는 한 묶음으로 수락·거절 ─────────
export const ChangeTab = {
  components: { InlineConfirm, CollabHost, Hint },
  template: `<div class="tab-change" ref="root"><CollabHost/>
    <div class="row filt"><button class="small" v-if="canDecide" @click="askAll=true" :disabled="!d.s.changes.length || busy">모두 수락</button>
      <span class="muted chg-count" v-if="groups.length" :title="'변경 ' + d.s.changes.length + '개'">{{ groups.length }}건</span><Hint text="교체(지움+넣음)는 함께 수락·거절됩니다. 표·그림·차트·도형 변경은 개체째 수락·거절됩니다. 문단 지움·문단 넣음은 문단 나눔(¶)과 그 문단 글이 함께 수락·거절됩니다(거절하면 지운 문단이 제 줄로 돌아오고, 넣은 문단은 빈 줄 없이 사라집니다). 한글에서도 검토 > 변경 내용으로 처리할 수 있습니다"/></div>
    <InlineConfirm v-if="askAll" message="변경 추적을 모두 수락할까요?" ok-label="모두 수락" :busy="busy" @ok="acceptAll" @cancel="askAll=false"/>
    <div class="card chg" v-for="g in groups" :key="g.key" :class="{pair: g.items.length > 1, active: isActive(g)}" :data-ids="g.ids.join(',')" @click="pick(g, $event)">
      <div class="head"><b>{{ g.items.map((x) => '#' + x.id).join('·') }}</b><span class="pill" :class="g.cls">{{ g.kind }}</span>
        <span class="chg-who" :style="{color: color(g.author)}">{{ g.author }}</span><span class="muted">{{ fmtShort(g.date) }}</span><span class="spacer"></span>
        <span class="ref" @click="go(g)">{{ g.ref }}</span></div>
      <div class="chg-body difftext" :title="g.tip || null"><del v-if="g.del">{{ g.delText }}</del><span class="muted" v-if="g.del && g.ins"> → </span><ins v-if="g.ins">{{ g.insText }}</ins></div>
      <div class="actions" v-if="canDecide"><button class="small primary chg-accept" :disabled="busy" title="이 변경을 문서에 확정합니다" @click="resolve(g, 'accept')">수락</button><button class="small chg-reject" :disabled="busy" title="이 변경을 되돌립니다" @click="resolve(g, 'reject')">거절</button></div></div>
    <p class="muted" v-if="!groups.length">변경 추적 없음</p></div>`,
  setup() {
    const d = inject('doc'); const askAll = ref(false); const busy = ref(false);
    // 변경 추적을 정하는 것도 문서를 고치는 일 — 수정 권한이 없으면 단추 없음(서버도 403, V4 §1)
    const canDecide = computed(() => (typeof d.canDecide === 'function' ? d.canDecide() : true));
    // 추적으로 지운 표·그림 안의 변경(숨은 문단 '…/dK')은 빼고 보인다 — 그 개체 변경과 함께 정해진다
    const groups = computed(() => groupChanges(visibleChanges(d.s.changes)).map((items) => {
      const del = items.find((x) => x.type === 'Delete') || null; const ins = items.find((x) => x.type === 'Insert') || null;
      const first = items[0];
      // 개체 변경(kind 'object'·'mixed'): 알약 = 엔진 이름('표 지움'·'그림 넣음' — 짝이면 '표 바꿈'), 본문 = '[표]'·'[그림]'.
      // 지운 개체는 편집기(최종본)에 보이지 않는다 — 본문에 마우스를 올리면 알린다.
      // 문단 나눔 묶음(kind 'para' — '문단 지움'·'문단 넣음', 2026-10-30): 본문 = '¶' + 그 문단 글(같은 종류의 변경을 차례로 이음)
      const textOf = (type) => items.filter((x) => x.type === type).map(changeText).join('');
      return {
        key: items.map((x) => x.id).join('-'), ids: items.map((x) => x.id), items, del, ins,
        delText: textOf('Delete'), insText: textOf('Insert'),
        tip: items.some((x) => x.type === 'Delete' && x.kind && x.kind !== 'para') ? '편집기(최종본)에는 지운 개체가 보이지 않습니다 — 한글로 저장(변경 추적 포함)에서 보입니다' : '',
        kind: changeGroupLabel(items), cls: del && ins ? 'warn' : ins ? 'ok' : 'bad',
        author: first.author, date: first.date, ref: first.ref, start: Math.min(...items.map((x) => x.start ?? 0)), end: ins?.end ?? ins?.start ?? first.start,
      };
    }).sort((a, b) => cmpRef(a.ref, b.ref) || a.start - b.start));
    const go = (g) => focusIn(d, { ref: g.ref, start: g.start, end: g.end });
    // 편집기에서 누른 변경 추적 강조(d.s.active kind 'change' — web/editor.js 가 이 탭으로 옮긴다) ↔ 그 묶음 카드
    const root = ref(null);
    const isActive = (g) => d.s.active?.kind === 'change' && g.ids.includes(Number(d.s.active.id));
    function pick(g, e) {
      if (e?.target?.closest?.('button, .ref, .confirm-row')) return;
      setActiveAnn(d, { kind: 'change', id: String(g.ids[0]) });
      go(g);
    }
    function showActive() {
      const a = d.s.active; if (a?.kind !== 'change') return;
      nextTick(() => {
        const el = [...(root.value?.querySelectorAll('.card.chg') || [])].find((x) => String(x.dataset.ids || '').split(',').includes(String(Number(a.id))));
        el?.scrollIntoView({ block: 'nearest' });
      });
    }
    watch(() => (d.s.active?.kind === 'change' ? String(d.s.active.id) : ''), showActive);
    onMounted(showActive);
    async function resolve(g, mode) { busy.value = true; try { await d.resolveChange(g.items, mode); } catch (e) { toastError(e); } finally { busy.value = false; } }
    // 모두 수락: 그 자리 확인 줄(브라우저 확인 창 아님) 뒤에 REST 를 부른다
    async function acceptAll() {
      busy.value = true;
      try { const r = await api(`${d.base}/changes/accept-all`, { method: 'POST' }); await d.refresh(); toast(`변경을 모두 수락했습니다${r?.accepted != null ? ` (${r.accepted}건)` : ''}`); askAll.value = false; }
      catch (e) { toastError(e); } finally { busy.value = false; }
    }
    return { d, root, askAll, busy, canDecide, groups, go, isActive, pick, resolve, acceptAll, fmtShort, color: (n) => colorOf(d, n) };
  },
};

// ───────── 첨부 ─────────
export const AttachTab = {
  components: { DropZone, CollabHost },
  template: `<div><CollabHost/>
    <DropZone class="attach-drop" label="파일 끌어다 놓기 · 눌러서 고르기" :title="dropTip" @files="up"/>
    <div class="card att" v-for="a in d.s.attachments" :key="a.aid" :data-aid="a.aid">
      <div class="head"><span class="att-ic">{{ KIND_ICON[a.kind] || '◇' }}</span><b>{{ a.name }}</b><span class="muted">{{ fmtSize(a.size) }}</span><span class="spacer"></span><span class="muted">{{ a.by }} · {{ fmtShort(a.at) }}</span></div>
      <div class="muted"><template v-if="a.text">글 {{ a.text.chars?.toLocaleString() }}자{{ a.text.truncated ? '(잘림)' : '' }}<template v-if="a.text.sheets?.length"> · 시트 {{ a.text.sheets.map((s) => s.name + ' ' + s.rows + '×' + s.cols).join(', ') }}</template></template>
        <template v-else-if="a.error">글 뽑기 실패: {{ a.error }}</template><template v-else>글 없음(원본으로 전달)</template>
        <template v-if="a.usedBy?.length"> · <span class="ref" v-for="rid in a.usedBy" :key="rid" title="이 첨부를 쓴 AI 작업" @click="d.s.activeRid=rid; d.s.tab='ai'">AI 작업 #{{ rid }}</span></template></div>
      <pre class="att-prev" v-if="prev[a.aid]">{{ prev[a.aid] }}</pre>
      <div class="actions"><button class="small" v-if="a.text" title="뽑은 글 미리보기" @click="toggle(a)">{{ prev[a.aid] ? '접기' : '미리보기' }}</button>
        <button class="small" @click="d.download(d.base + '/attachments/' + a.aid, a.name)">내려받기</button>
        <button class="small" v-if="a.by===me.name || me.role==='admin'" @click="d.deleteAttachment(a)">삭제</button></div></div>
    <p class="muted" v-if="!d.s.attachments.length" title="본문 위로 파일을 끌어다 놓으면 첨부하고 바로 요청 창이 열립니다">첨부 없음</p></div>`,
  setup() {
    const d = inject('doc'); const prev = reactive({});
    async function toggle(a) { if (prev[a.aid]) { delete prev[a.aid]; return; } try { const r = await d.attachmentText(a, 3000); prev[a.aid] = (r.text || '(글 없음)') + (r.truncated ? '\n…' : ''); } catch (e) { toastError(e); } }
    const up = (files) => d.uploadFiles(files);
    const cfg = state.config || {};
    // 받는 파일·한도·쓰임은 끌어다 놓는 곳의 title(UI_TERMS §1 — 화면에 펼쳐 두지 않음)
    const dropTip = `엑셀·CSV·한글(HWPX)·워드·PDF·이미지${cfg.attachments?.maxBytes ? ` · 한 파일 ${fmtSize(cfg.attachments.maxBytes)}까지` : ''} · 문서당 100개 — 서버가 글을 뽑아 AI에게 줍니다`;
    return { d, prev, toggle, up, cfg, dropTip, me: state.me || {}, fmtSize, fmtShort, KIND_ICON };
  },
};

// ───────── 이력(docs/V3_SPEC.md §9.4·§9.7) ─────────
// 사람에게 보이는 것은 버전(이정표 v — 큰 일이 끝났을 때만 오른다)과 그 사이 '변경 이력'(기록의 무엇·누가·언제)뿐 — 기록 번호 n 은 내지 않는다.
// 맨 위 'v3 이후 변경 이력 n개' + [버전 저장](한 줄 메모 → POST /milestones, 바뀐 것이 없으면 꺼짐) → 버전 목록(v 내림차순, [내려받기]
// 과거 버전의 파일로 교체할 수 있고, 펼친 변경 이력에서도 파일을 선택할 수 있다.
const MS_KIND = { upload: '올림', merge: '변경 요청 반영', restore: '파일 교체', request: 'AI 작업 완료', manual: '버전 저장' };
/** 변경 이력 한 줄(시각 · 누가 · 무엇 [내려받기] [이 파일로 교체]) — top = 그 버전 자신의 기록, h = 이력 탭의 공용 상태·동작 */
const HistRec = {
  components: { InlineConfirm },
  props: { x: Object, top: { type: Number, default: null }, h: Object },
  template: `<div class="hist-rec" :data-n="x.n"><span class="muted">{{ fmtStamp(x.at) }}</span> <span>· {{ x.by }} · {{ x.note }}</span><span class="spacer"></span>
      <span class="pill ok" v-if="x.n === h.cur">지금</span>
      <button class="linkish hist-rec-dl" v-if="x.n !== top" @click="h.dl(x.n, null, x.at)">내려받기</button>
      <button class="linkish hist-rec-restore" v-if="h.canReplace && x.n !== h.cur && x.n !== top" :disabled="h.replacing" @click="h.askReplace('r' + x.n, x.n, h.recLabel(x))">이 파일로 교체</button></div>
    <InlineConfirm v-if="h.confirming?.key === 'r' + x.n" :message="h.confirming.msg" ok-label="교체" danger :busy="h.replacing" @ok="h.doReplace" @cancel="h.cancel"/>`,
  setup() { return { fmtStamp }; },
};
/**
 * 변경 이력 목록(새것부터): 같은 사람의 이어진 '실시간 편집' 기록(5분 안)은 한 줄로 묶는다 — '홍길동 · 실시간 편집 23번 · 10:02~10:15'(펼치면 기록마다,
 * [이 파일로 교체]) — V4 §2.6, view.js groupHistory
 */
const HistRows = {
  components: { HistRec },
  props: { list: Array, top: { type: Number, default: null }, h: Object },
  template: `<template v-for="row in rows" :key="row.kind === 'live' ? row.key : 'r' + row.rec.n">
      <HistRec v-if="row.kind === 'rec'" :x="row.rec" :top="top" :h="h"/>
      <details v-else class="hist-live" :data-count="row.count" :data-by="row.by" :data-first="row.recs[row.recs.length - 1].n" :data-last="row.recs[0].n">
        <summary class="hist-live-h" :title="'같은 사람의 이어진 실시간 편집 기록(5분 안) ' + row.count + '개'">{{ label(row) }}</summary>
        <HistRec v-for="x in row.recs" :key="x.n" :x="x" :top="top" :h="h"/>
      </details>
    </template>`,
  setup(props) {
    const rows = computed(() => groupHistory(props.list || []));
    return { rows, label: liveGroupLabel };
  },
};
export const HistoryTab = {
  components: { CollabHost, InlineConfirm, HistRows, AppliedHistory },
  template: `<div class="tab-history"><CollabHost/>
    <div class="card hist-top">
      <div class="row"><b class="hist-since">{{ sinceLine }}</b><span class="spacer"></span>
        <button class="small primary hist-save" :disabled="!since || saving || saveOpen" :title="since ? '지금 문서를 버전 하나로 남깁니다' : '마지막 버전 뒤로 바뀐 것이 없습니다'" @click="openSave">버전 저장</button></div>
      <div class="row hist-saverow" v-if="saveOpen">
        <input ref="noteEl" v-model="note" class="hist-note" maxlength="200" placeholder="메모(선택) 예: 1차 검토 반영" aria-label="버전 메모" @keydown.enter.prevent="save" @keydown.esc.stop.prevent="saveOpen=false"/>
        <button class="small" @click="saveOpen=false">취소</button>
        <button class="small primary hist-save-go" :disabled="saving" @click="save"><span v-if="saving" class="spin"></span>저장</button></div>
      <details class="hist-recs" v-if="sinceRecs.length"><summary class="muted">변경 이력 {{ sinceRecs.length }}개</summary>
        <HistRows :list="sinceRecs" :h="hctx"/></details>
    </div>
    <AppliedHistory/>
    <div class="sec-h">버전 {{ milestones.length }}</div>
    <div class="card hist-v" v-for="m in milestones" :key="m.v" :data-v="m.v" :class="{now: isNow(m)}">
      <div class="head"><b class="hist-vname">v{{ m.v }}</b><span class="hist-vnote" :title="m.note || ''">{{ m.note || MS_KIND[m.kind] || '' }}</span><span class="spacer"></span>
        <span class="pill ok" v-if="isNow(m)">지금</span></div>
      <div class="row hist-meta"><span class="muted">{{ m.by }} · {{ fmtStamp(m.at) }}</span><span class="spacer"></span>
        <button class="small hist-dl" @click="dl(m.n, m.v, m.at)">내려받기</button>
        <button class="small hist-restore" v-if="canReplace && !isNow(m)" :disabled="replacing" @click="askReplace('v' + m.v, m.n, 'v' + m.v)">이 파일로 교체</button></div>
      <InlineConfirm v-if="confirming?.key === 'v' + m.v" :message="confirming.msg" ok-label="교체" danger :busy="replacing" @ok="doReplace" @cancel="confirming=null"/>
      <details class="hist-recs" v-if="recsOf(m).length"><summary class="muted">변경 이력 {{ recsOf(m).length }}개</summary>
        <HistRows :list="recsOf(m)" :top="Number(m.n)" :h="hctx"/></details>
    </div>
    <p class="muted" v-if="!milestones.length">버전이 없습니다.</p>
    <details class="hist-act"><summary class="sec-h">활동 기록 {{ activity.length }}</summary>
      <div v-for="(a, i) in activity" :key="i" class="act muted">{{ fmtShort(a.at) }} · {{ a.by }} · {{ a.type }} {{ a.detail }}</div></details>
  </div>`,
  setup() {
    const d = inject('doc');
    const noteEl = ref(null);
    const recs = computed(() => (Array.isArray(d.s.history?.versions) ? d.s.history.versions : []));
    // 이정표(오래된 것부터). 옛 서버(milestones 없음)면 그때의 기록이 곧 버전이다
    const msAsc = computed(() => {
      const list = d.s.history?.milestones;
      if (Array.isArray(list)) return list.slice().sort((a, b) => Number(a.v) - Number(b.v));
      return recs.value.map((x) => ({ v: x.n, n: x.n, at: x.at, by: x.by, kind: 'upload', note: x.note }));
    });
    const milestones = computed(() => msAsc.value.slice().reverse());
    const cur = computed(() => Number(d.s.info?.version) || 0);
    const canReplace = computed(() => d.s.info?.canEdit === true);
    const last = computed(() => (d.s.info?.milestone !== undefined ? d.s.info.milestone : null) || milestoneAt(msAsc.value, cur.value));
    const isNow = (m) => Number(m.n) === cur.value;
    const byN = (a, b) => Number(b.n) - Number(a.n);
    /** 버전마다 그 버전까지의 변경 이력: 앞 버전 뒤 ~ 이 버전(새것부터) — 한 번에 나눠 둔다 */
    const recsByV = computed(() => {
      const out = new Map();
      const sorted = recs.value.slice().sort((a, b) => Number(a.n) - Number(b.n));
      let k = 0;
      msAsc.value.forEach((m) => {
        const list = [];
        while (k < sorted.length && Number(sorted[k].n) <= Number(m.n)) list.push(sorted[k++]);
        out.set(m.v, list.reverse());
      });
      return out;
    });
    const recsOf = (m) => recsByV.value.get(m.v) || [];
    const sinceRecs = computed(() => { const n0 = Number(last.value?.n) || 0; return recs.value.filter((x) => Number(x.n) > n0).sort(byN); });
    const since = computed(() => {
      const v = d.s.info?.sinceMilestone;
      if (Number.isFinite(Number(v)) && v !== null) return Number(v);
      return last.value ? Math.max(0, cur.value - Number(last.value.n)) : sinceRecs.value.length;
    });
    const sinceLine = computed(() => (last.value ? `v${last.value.v} 이후 ${since.value ? `변경 이력 ${since.value}개` : '바뀐 것 없음'}` : `변경 이력 ${since.value}개`));
    const activity = computed(() => d.s.history?.activity || []);
    const recLabel = (x) => `${fmtStamp(x.at)} 기록`;
    // 내려받기 이름: 버전이면 '제목_v3.hwpx', 기록이면 '제목_10-23_0116.hwpx'
    const dl = (n, v, at) => d.download(`${d.base}/file?kind=version&n=${n}`, downloadName(d.s.info?.title, { v, at }));
    const confirming = ref(null); const replacing = ref(false);
    function askReplace(key, n, label) {
      confirming.value = { key, n, label, msg: `${label}에 저장된 파일로 현재 문서 전체를 교체할까요? 현재 저장본은 이력에 남습니다.` };
    }
    async function doReplace() {
      const c = confirming.value; if (!c || replacing.value) return;
      replacing.value = true;
      try { await d.replaceVersion(c.n, c.label); confirming.value = null; } catch (e) { toastError(e, '교체 실패: '); } finally { replacing.value = false; }
    }
    // [버전 저장]: 한 줄 메모 칸 → 저장
    const saveOpen = ref(false); const note = ref(''); const saving = ref(false);
    function openSave() { saveOpen.value = true; nextTick(() => noteEl.value?.focus()); }
    async function save() {
      if (saving.value) return;
      saving.value = true;
      try { await d.saveMilestone(note.value); saveOpen.value = false; note.value = ''; } catch (e) { toastError(e, '버전 저장: '); } finally { saving.value = false; }
    }
    // 이력은 문서가 바뀔 때(기록 n)·탭을 열 때 다시 읽는다(메모·제안 기록은 WS 'doc' 이 아니어도 기록을 만든다)
    onMounted(() => d.refresh(['history', 'info']));
    watch(() => d.s.info?.version, (v, old) => { if (v && v !== old) d.refresh(['history']); });
    // 변경 이력 줄(HistRows·HistRec)이 같이 쓰는 상태·동작(reactive 가 ref·computed 를 풀어 준다)
    const hctx = reactive({ cur, canReplace, confirming, replacing, dl, askReplace, doReplace, recLabel, cancel: () => { confirming.value = null; } });
    return { d, noteEl, milestones, cur, last, isNow, canReplace, recsOf, sinceRecs, since, sinceLine, activity, recLabel, dl, confirming, replacing, askReplace, doReplace, saveOpen, note, saving, openSave, save, hctx, fmtStamp, fmtShort, MS_KIND };
  },
};

// ───────── v0.3 패널 탭 목록 · 탭 머리줄까지 그리는 패널 ─────────
export const PANEL_TABS = Object.freeze([
  { id: 'review', label: '메모', comp: ReviewTab },
  { id: 'cr', label: '변경 요청', comp: CrTab },
  { id: 'ai', label: 'AI 작업', comp: AiTab },
  { id: 'change', label: '변경 추적', comp: ChangeTab },
  { id: 'attach', label: '첨부', comp: AttachTab },
  { id: 'history', label: '이력', comp: HistoryTab },
]);
/**
 * 탭 머리줄 자료: [{ id, label, count }] — 검토(해결 안 된 항목)·변경 요청(진행 중)·AI 작업(대기·처리 중)·변경 추적(묶음)·첨부.
 * v0.4(§5): 보이는 탭은 보기 규칙(view.js panelTabIds) — 자세히 = 여섯 탭 그대로, 간단히 = 검토 · (승인 방식이고 진행 중 변경 요청이 있으면) 변경 요청 ·
 * AI 작업 · 이력 · 첨부(그 차례)
 */
export function panelTabs(d) {
  const s = d.s;
  let review = 0; try { review = reviewItems(d).filter((it) => !it.resolved).length; } catch { review = 0; }
  const activeCrs = (s.crs || []).filter((c) => c.status === 'draft' || c.status === 'open').length;
  const counts = {
    review,
    cr: activeCrs,
    ai: (s.requests || []).filter((r) => ['pending', 'working'].includes(r.status)).length,
    change: groupChanges(visibleChanges(s.changes)).length,
    attach: (s.attachments || []).length,
  };
  const ids = panelTabIds({ view: s.view, realtime: s.settings?.editMode === 'realtime', activeCrs });
  const byId = new Map(PANEL_TABS.map((t) => [t.id, t]));
  // AI 작업 탭은 수 하나 대신 진행 단계별 수(확인 필요·처리 중·응답 대기 — ui.js requestGlance, 색은 docs/UI_TERMS.md §6)
  const glance = requestGlance(d, s.requests);
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, label: byId.get(id).label, count: counts[id] || 0, glance: id === 'ai' ? glance : null }));
}
export const PanelTabs = {
  template: `<div class="panel-tabs">
    <div class="tabs" role="tablist"><button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="cur.id===t.id" :class="{active: cur.id===t.id}" :data-tab="t.id" @click="d.s.tab=t.id">{{ t.label }}<template v-if="t.glance?.length"><span v-for="g in t.glance" :key="g.ph" class="cnt" :class="'ph-' + g.ph" :title="g.tip">{{ g.n }}</span></template><span v-else-if="t.count" class="cnt">{{ t.count }}</span></button></div>
    <div class="tabbody"><component :is="cur.comp" :key="cur.id"/></div></div>`,
  setup() {
    const d = inject('doc');
    const tabs = computed(() => panelTabs(d));
    const cur = computed(() => (tabs.value.some((t) => t.id === d.s.tab) && PANEL_TABS.find((t) => t.id === d.s.tab)) || PANEL_TABS[0]);
    return { d, tabs, cur };
  },
};
export const CollabPanel = PanelTabs;
