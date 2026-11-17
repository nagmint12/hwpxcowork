// 공용 화면 조각: 떠 있는 창·요청 창(composer)·결과 창·메모 달기·메모 고치기·첨부 칩·끌어다 놓기
// + v0.3 협업 공용 도우미(맨 아래): 나·사람 색·권한·편집기 이동(focusRange)·요청 상태 알약·메모 스레드·그 자리 확인 줄
// (우클릭 메뉴는 편집기 안 cowork 플러그인이 그린다 — 메뉴 모델은 menumodel.js)
import { ref, reactive, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } from '/vendor/vue.esm-browser.prod.js';
import { state, api, toast, toastError, fmtShort, fmtSize, clip, kinds, presets, kindLabel, presetLabel, STATUS_LABEL, fileKind, KIND_ICON, copyText, adopterNames, progressText, resolvedText, workEnv, docWorkEnv, routeOptions, agentEnvName, serverEnvName, josa, tocNote, deleteNote, bundleLabel, CONNECT_HELP, SUB_AI_TIP, NO_AI_TIP } from './util.js';
import { diffHtml } from './diff.js';
import { ICON } from './icons.js';
import { requestWait } from './request-wait.js';
import { activityRows, secText } from './activity-rows.js';
import { proposalPlace, refWords, placeNote } from './proposal-place.js';
import { agentPrompt as agentPromptText, groupChanges } from './menumodel.js';
import { colorForUser } from './annotations.js';
import { adoptionInEffect } from './store.js';
import { installHoldToEdit, focusEditingInput } from './hold-to-edit.js';
import { paragraphFormatRequested, formatSummary, runPreviewStyle, isRichProposal, formatAdoptionOf, adoptionRecord } from './formatting.js';

// ───────── 떠 있는 창: 기준점 근처에 두고 화면 안으로 맞춤, 머리줄로 끌어 옮기기 ─────────
export const FloatWin = {
  props: { anchor: Object, width: { type: Number, default: 420 }, title: String, cls: String },
  emits: ['close'],
  template: `<div class="floatwin" :class="cls" ref="el" :style="style" @keydown.esc.stop="$emit('close')" @mousedown.stop @contextmenu.stop>
    <div class="fw-head" @pointerdown="drag"><span class="fw-title">{{ title }}</span><slot name="head"></slot><button class="icon" title="닫기 (Esc)" aria-label="닫기" @pointerdown.stop @mousedown.stop @click="$emit('close')" v-html="ICON.x"></button></div>
    <div class="fw-body"><slot></slot></div></div>`,
  setup(props) {
    const el = ref(null); const pos = reactive({ left: 0, top: 0 }); let moved = false; let ro = null;
    // 화면이 창보다 좁으면(휴대전화) 화면 폭 - 16px 로 줄인다 — 넓은 창이 왼쪽 밖으로 밀려 [반영] 같은 단추를 못 누르던 것(2026-10-31)
    const vw = ref(innerWidth);
    const fitW = computed(() => Math.max(200, Math.min(props.width, vw.value - 16)));
    const style = computed(() => ({ left: `${pos.left}px`, top: `${pos.top}px`, width: `${fitW.value}px` }));
    // 기준점 아래 → 위 → 옆 → 모서리 중에서 대상(avoid: 선택·문단의 화면 사각형)을 가장 덜 가리는 자리
    function place() {
      if (!el.value || moved) return;
      const w = fitW.value; const W = innerWidth; const H = innerHeight;
      const a = props.anchor || { x: W / 2 - w / 2, y: 120 };
      const h = el.value.offsetHeight;
      const cx = (x) => Math.max(8, Math.min(x, W - w - 8)); const cy = (y) => Math.min(Math.max(8, y), Math.max(8, H - h - 8));
      const av = a.avoid;
      if (!av) { let top = a.y; if (top + h > H - 8) top = a.top != null ? a.top - h - 8 : H - h - 8; pos.left = cx(a.x); pos.top = Math.max(8, top); return; }
      const cands = [[cx(a.x), av.bottom + 10], [cx(a.x), av.top - h - 10], [av.right + 14, cy(av.top - 30)], [av.left - w - 14, cy(av.top - 30)], [W - w - 8, cy(av.top - 30)], [W - w - 8, H - h - 8], [W - w - 8, 8]];
      let best = null;
      for (const [l, t] of cands) {
        if (l < 8 || l + w > W - 8 || t < 8) continue;
        const tt = Math.min(t, Math.max(8, H - h - 8)); const vis = Math.min(h, H - 8 - tt);
        const ox = Math.max(0, Math.min(l + w, av.right) - Math.max(l, av.left)); const oy = Math.max(0, Math.min(tt + vis, av.bottom) - Math.max(tt, av.top));
        const cost = ox * oy + (t !== tt ? (t - tt) * 2 : 0) + (h - vis) * 40;
        if (!best || cost < best.cost - 1) best = { l, t: tt, cost };
      }
      if (!best) best = { l: cx(a.x), t: cy(a.y) };
      pos.left = best.l; pos.top = best.t;
    }
    // 머리 줄을 끌어 옮긴다 — 마우스·손가락 모두(pointer). 머리 안의 단추·입력은 끌지 않는다
    function drag(e) {
      if (e.button > 0 || e.target.closest?.('button, input, select, textarea, a')) return;
      e.preventDefault();
      const sx = e.clientX - pos.left; const sy = e.clientY - pos.top; moved = true;
      const mv = (ev) => { pos.left = Math.min(Math.max(0, ev.clientX - sx), innerWidth - 60); pos.top = Math.min(Math.max(0, ev.clientY - sy), innerHeight - 30); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    }
    // 화면 크기가 바뀌면(휴대전화 돌리기) 폭을 다시 맞추고, 옮긴 창도 화면 안으로 되돌린다
    function onResize() {
      vw.value = innerWidth;
      nextTick(() => {
        if (!moved) { place(); return; }
        pos.left = Math.max(0, Math.min(pos.left, innerWidth - fitW.value)); pos.top = Math.max(0, Math.min(pos.top, innerHeight - 30));
      });
    }
    onMounted(() => { place(); ro = new ResizeObserver(() => place()); ro.observe(el.value); addEventListener('resize', onResize); });
    onBeforeUnmount(() => { ro && ro.disconnect(); removeEventListener('resize', onResize); });
    watch(() => props.anchor, () => { moved = false; nextTick(place); });
    return { el, style, drag, ICON };
  },
};

// ───────── 메모 고치기(그 자리에서) ─────────
// 글은 안에 두거나(value = 처음 글) 밖에 둔다(v-model — 카드가 화면에서 빠졌다 돌아와도 쓰던 글이 남게, slot 도우미).
// autofocus=false 면 다시 그려질 때 커서를 가져가지 않는다. busy 동안은 Ctrl+Enter 도 보내지 않는다(두 번 보내기 막기).
export const MemoEditor = {
  // askLabel 을 주면 [AI에게 요청] 단추(보라 ✦ — 같은 글을 AI 작업으로 이어 맡김, emit 'ask')가 [답글 달기] 앞에 붙는다
  props: { value: String, modelValue: { type: String, default: undefined }, placeholder: String, rows: { type: Number, default: 4 }, okLabel: { type: String, default: '저장' }, busy: Boolean, autofocus: { type: Boolean, default: true }, askLabel: { type: String, default: '' }, askTip: { type: String, default: '' } },
  emits: ['save', 'cancel', 'ask', 'update:modelValue'],
  template: `<div class="memoedit"><textarea ref="ta" v-model="text" :rows="rows" :placeholder="placeholder" @keydown.ctrl.enter.prevent="save" @keydown.meta.enter.prevent="save" @keydown.esc.stop.prevent="$emit('cancel')"></textarea>
    <div class="row end"><span class="muted kbd">Ctrl+Enter</span><button class="small" @click="$emit('cancel')">취소</button><button v-if="askLabel" class="small ai-send me-ask" :disabled="busy || !text.trim()" :title="askTip || null" @click="ask">{{ askLabel }}</button><button class="small primary" :disabled="busy || !text.trim()" @click="save">{{ okLabel }}</button></div></div>`,
  setup(props, { emit }) {
    const local = ref(props.modelValue ?? props.value ?? ''); const ta = ref(null);
    watch(ta, (input, previous, onCleanup) => { if (input) onCleanup(installHoldToEdit(input)); }, {flush: 'post'});
    const text = computed({
      get: () => (props.modelValue !== undefined ? props.modelValue : local.value),
      set: (v) => { local.value = v; emit('update:modelValue', v); },
    });
    // 글 길이에 맞춰 높이를 늘린다(rows 아래로는 줄이지 않음) — 긴 메모도 고칠 때 한눈에. 끝은 문서 옆 메모면 그 층 높이 - 150px, 그 밖은 창 높이의 60%(넘으면 칸 안 스크롤)
    function fit() {
      const t = ta.value; if (!t || !t.isConnected) return;
      t.style.height = '';
      const layer = t.closest?.('.review-rail');
      const max = layer ? Math.max(120, layer.clientHeight - 150) : Math.max(160, Math.round(innerHeight * 0.6));
      const need = t.scrollHeight + (t.offsetHeight - t.clientHeight);
      if (need > t.offsetHeight) t.style.height = `${Math.min(need, max)}px`;
      t.style.overflowY = need > max ? 'auto' : '';
    }
    watch(text, () => nextTick(fit));
    onMounted(() => {
      fit(); requestAnimationFrame(fit);   // 문서 옆 메모는 넓어진 뒤(고치는 중 폭)에 한 번 더
      if (!props.autofocus || !ta.value) return;
      // 문서 옆 메모(넘침 숨김) 안에서는 스크롤하지 않는다 — 층이 저절로 스크롤되면 메모 자리가 틀어진다. 패널 탭에서는 보이게 스크롤
      focusEditingInput(ta.value, { preventScroll: !!ta.value.closest?.('.review-rail') });
      ta.value.setSelectionRange(text.value.length, text.value.length);
    });
    const save = () => { if (props.busy || !String(text.value || '').trim()) return; emit('save', text.value); };
    const ask = () => { if (props.busy || !String(text.value || '').trim()) return; emit('ask', text.value); };
    return { text, ta, save, ask };
  },
};

// ───────── 첨부 칩 ─────────
export const AttachChips = {
  props: { aids: Array, removable: Boolean, names: Array },
  emits: ['remove'],
  template: `<span class="chips"><span class="chip att" v-for="a in list" :key="a.key" :title="a.title"><span class="chip-ic">{{ a.icon }}</span>{{ a.name }}<button v-if="removable" class="x" title="빼기" @click.stop="$emit('remove', a.aid)">×</button></span></span>`,
  setup(props) {
    const d = inject('doc');
    const list = computed(() => {
      const out = (props.aids || []).map((aid) => { const a = d.attachment(aid); return { key: aid, aid, name: a?.name || aid, icon: KIND_ICON[a?.kind || fileKind(a?.name)] || '◇', title: a ? `${a.name} · ${fmtSize(a.size)}${a.text ? ` · 글 ${a.text.chars}자` : ''}` : aid }; });
      for (const n of props.names || []) out.push({ key: `n:${n}`, aid: null, name: n, icon: KIND_ICON[fileKind(n)], title: n });
      return out;
    });
    return { list };
  },
};

// ───────── 끌어다 놓는 곳(클릭·붙여넣기 포함) ─────────
export const DropZone = {
  props: { label: { type: String, default: '파일을 끌어다 놓거나 눌러서 고르기 (붙여넣기 가능)' }, compact: Boolean },
  emits: ['files'],
  template: `<div class="dropzone" :class="{over, compact}" tabindex="0" @click="pick" @keydown.enter.prevent="pick" @dragenter.prevent.stop="over=true" @dragover.prevent.stop="over=true" @dragleave.stop="over=false" @drop.prevent.stop="drop" @paste="paste">
    <input type="file" multiple ref="inp" style="display:none" @change="chosen"/><span class="dz-ic" v-html="ICON.attach"></span> {{ label }}</div>`,
  setup(props, { emit, expose }) {
    const over = ref(false); const inp = ref(null);
    const pick = () => inp.value.click();
    const chosen = (e) => { const f = [...e.target.files]; if (f.length) emit('files', f); e.target.value = ''; };
    const drop = (e) => { over.value = false; const f = [...(e.dataTransfer?.files || [])]; if (f.length) emit('files', f); };
    const paste = (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); emit('files', f); } };
    expose({ pick });
    return { over, inp, pick, chosen, drop, paste, ICON };
  },
};

// ───────── 표 미리보기 ─────────
export const TablePreview = {
  props: { table: Object },
  // 단위 줄(table.unit)·주석(table.notes — 줄 배열)은 새 연결의 표 제안만 가진다(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-8). 없으면 예전 그대로
  template: `<div class="tblprev"><div class="muted" v-if="table?.caption">{{ table.caption }}</div><div class="muted" v-if="table?.unit" style="text-align:right">{{ table.unit }}</div><table><tr v-for="(r, i) in (table?.rows || []).slice(0, 12)" :key="i" :class="{head: i < (table.headerRows ?? 1)}"><td v-for="(c, j) in r" :key="j">{{ c }}</td></tr></table>
    <div class="muted" v-if="(table?.rows || []).length > 12">… 모두 {{ table.rows.length }}행</div><div class="muted" v-for="(n, k) in (table?.notes || [])" :key="'n' + k">{{ n }}</div></div>`,
};

// ───────── 작은 '?' 도움말 ─────────
/** 작은 '?' 도움말: 마우스를 올리면 설명(title), 누르면 사용 설명서 그 절(help-dialog.js 가 문서 화면 안 창으로 연다) */
export const Hint = {
  props: { text: String, href: { type: String, default: '/help.html#review' } },
  template: `<a class="hint" :href="href" :title="text" :aria-label="'도움말: ' + text" @click.stop>?</a>`,
};

// ───────── 요청 창(docs/UI_TERMS.md §3) ─────────
// 고르는 종류는 [요청]·[다듬기] 둘. '요청' = 예전 'AI 검토' + '지시' — 지시·첨부가 없으면 서버 종류 review(검토), 있으면 instruct 로 보낸다(sendKind).
// 상황 종류(문장 제안·표 채우기·표 만들기·문단 추가)는 우클릭에서 그 종류로 열었을 때만 세 번째 칩(m.ctxKind)으로 보인다.
// 설명 문장은 칩·대상·단추의 title 과 '?'(Hint)로 — 창에는 이름표만(§1)
const ASK_KINDS = ['review', 'instruct'];
const CTX_KINDS = ['suggest', 'fill_table', 'make_table', 'insert'];
const DOC_KINDS = ['review', 'polish', 'instruct'];   // 문서 전체 대상이 받는 종류
const isAsk = (k) => ASK_KINDS.includes(k);
/** 보낼 서버 종류: '요청' 칩(review·instruct)이면 지시·첨부가 있을 때 instruct, 없으면 review(검토). 그 밖은 그대로 */
export function sendKind(m) {
  if (!isAsk(m?.kind)) return m?.kind;
  return String(m.instruction || '').trim() || (m.attachments || []).length ? 'instruct' : 'review';
}
const PLACEHOLDER = {
  ask: '무엇을 할까요? 비워 두면 검토합니다',
  suggest: '(선택) 방향 — 예: 더 간결하게',
  polish: '(선택) 덧붙일 지시',
  fill_table: '(선택) 예: 첨부 엑셀 값으로 빈 칸 채우기',
  make_table: '(선택) 예: 연도별 응답자 수 표',
  insert: '무엇을 쓸까요? 예: 위 표의 핵심 요약 한 단락',
};
const KIND_HELP = {
  ask: '원하는 작업을 자유롭게 적고 필요하면 자료를 첨부합니다. 비워 두면 문제점과 고칠 곳을 검토해 수정안·의견을 냅니다. 서식(굵게·가운데 정렬 …)도 지시에 적으면 됩니다',
  polish: '고른 기준(간결하게·공문서체로·맞춤법 …)에 맞춰 다듬은 수정안을 만듭니다',
  suggest: '고른 문장의 권장 수정안 1개를 만듭니다(표현을 비교할 때만 안 개수를 늘리세요)',
  fill_table: '표의 칸을 문서 내용이나 첨부 자료로 채우는 수정안을 만듭니다',
  make_table: '이 문단 뒤에 넣을 새 표를 제안합니다',
  insert: '이 문단 뒤에 넣을 새 문단을 제안합니다',
};
/** [프롬프트 복사] 설명(요청 창·결과 창·AI 작업 탭 카드) */
export const COPY_TIP = 'ChatGPT Work 등 MCP로 연결한 AI 대화창에 붙여 넣을 문장을 복사합니다';

/** 연결한 AI 대화창(MCP)에 붙여 넣을 문장(글은 menumodel.js) — 도구 이름은 이 서버의 MCP 기본 연결(features.mcpDefault, 2026-11-17 기본 'v2')을 따른다.
 *  features 에 mcpDefault 가 없으면 기본이 예전 연결이던 판의 서버다(web/ 은 서버 재시작 없이 바로 보인다) */
export function agentPrompt(d, r) {
  const f = state.config?.features;
  return agentPromptText(d, r, kinds(), { surface: f && f.mcpDefault !== 'v2' ? 'v1' : 'v2' });
}

export const FormatPreview = {
  props: { proposal: Object },
  template: `<div class="format-preview" v-if="rich" title="지정하지 않은 속성은 기존 모양을 유지합니다"><div><b>서식 변경</b><span v-if="summary.length"> · {{ summary.join(' · ') }}</span><span v-if="whole" class="muted"> · 문단 전체</span></div>
    <div class="format-runs" v-if="proposal.runs?.length"><span class="muted">글자별 모양: </span><span v-for="(run,i) in proposal.runs" :key="i" :style="runStyle(run)" :title="run.charPrId != null ? '글자 모양 #' + run.charPrId : ''">{{ run.text }}</span></div></div>`,
  setup(props) {
    const d = inject('doc', null);
    onMounted(() => { if (props.proposal?.format?.styleId != null) d?.loadFormatting?.().catch(() => {}); });
    return { rich: computed(() => isRichProposal(props.proposal)), summary: computed(() => formatSummary(props.proposal?.format, d?.s?.formatting)), whole: computed(() => paragraphFormatRequested(props.proposal?.format, d?.s?.formatting)), runStyle: runPreviewStyle };
  },
};

export const Composer = {
  components: { AttachChips, DropZone, Hint, ResultView: null },
  props: { model: Object, docked: Boolean },
  emits: ['close'],
  template: `<div class="composer" :class="{docked}" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" @paste="paste"
      @dragenter.prevent="dragOver=true" @dragover.prevent="dragOver=true" @dragleave="onLeave" @drop.prevent="drop">
    <template v-if="m.phase !== 'result'">
      <div class="cmp-target" v-if="m.target?.scope==='document'" title="문서 전체가 대상입니다 — 본문에서 범위를 고르면 그 범위로 바뀝니다"><span class="pill k">문서 전체</span></div>
      <div class="cmp-target" v-else-if="m.target" :title="docked ? '본문에서 다른 범위를 고르면 대상이 바뀝니다' : ''"><span class="ref">{{ m.target.ref }}</span><span v-if="(m.target.refs||[]).length > 1" class="muted">외 {{ m.target.refs.length - 1 }}문단</span>
        <span class="quote">「{{ clip(m.target.display || m.target.text, 70) || '(빈 문단)' }}」</span><span v-if="m.target.whole" class="muted">{{ isCell ? '칸 전체' : '문단 전체' }}</span>
        <span v-if="afterNote" class="muted">· {{ afterNote }}</span><span v-if="m.target.note && !problem" class="muted cmp-note">· {{ m.target.note }}</span></div>
      <div class="cmp-target muted" v-else>본문에서 범위를 고르세요</div>
      <div class="chips kinds" role="radiogroup" aria-label="요청 종류">
        <button v-for="k in kindList" :key="k.id" class="chip k" :class="{on: k.on}" role="radio" :aria-checked="k.on" :title="k.title" :data-kind="k.id" @click="setKind(k.id)">{{ k.label }}</button></div>
      <div class="chips presets" v-if="m.kind==='polish'" role="radiogroup" aria-label="다듬기 기준">
        <button v-for="p in presetList" :key="p.id" class="chip p" :class="{on: m.preset===p.id}" role="radio" :aria-checked="m.preset===p.id" @click="m.preset=p.id">{{ p.label }}</button></div>
      <textarea ref="ta" v-model="m.instruction" rows="3" :placeholder="placeholder" class="cmp-instr" aria-label="지시"></textarea>
      <label v-if="workspaceEnabled" class="check" title="내용을 글자·Markdown으로 먼저 정리하고 별도 단계에서 서식을 적용합니다. 결과 사본을 검토한 뒤 한 묶음으로 반영합니다."><input type="checkbox" :checked="m.workflow==='content_format'" @change="m.workflow=$event.target.checked?'content_format':'standard'"/> 내용·서식 나눠 처리(실험)</label>
      <div class="cmp-attach">
        <DropZone ref="dz" compact :class="{over: dragOver}" label="첨부" title="자료 첨부 — 파일을 끌어다 놓거나, 눌러서 고르거나, 붙여 넣으세요" @files="addFiles"/>
        <select v-if="pickable.length" class="cmp-pick" @change="pickExisting" aria-label="문서 첨부함에서 고르기" title="이 문서에 올려 둔 첨부에서 고르기"><option value="">첨부함에서…</option><option v-for="a in pickable" :key="a.aid" :value="a.aid">{{ a.name }}</option></select>
      </div>
      <div class="cmp-chips" v-if="m.attachments.length || busyNames.length"><AttachChips :aids="m.attachments" removable @remove="removeAtt"/><span class="chip uploading" v-for="u in busyNames" :key="u"><span class="spin dark"></span>{{ u }} 올리는 중…</span></div>
      <div class="cmp-opts" v-if="m.kind==='suggest' || showInstrOpt">
        <label v-if="m.kind==='suggest'" title="기본은 권장안 1개 — 표현을 비교할 때만 늘리세요">결과 <select v-model="m.count" aria-label="문장 제안 개수"><option :value="1">권장안 1개</option><option v-for="n in [2,3,4,5]" :key="n" :value="n">{{ n }}개 비교</option></select></label>
        <label v-if="showInstrOpt" class="check" title="지시 글도 한글 메모(공유 요약)에 함께 남깁니다. 기본은 AI 요약만 남깁니다"><input type="checkbox" v-model="m.includeInstruction"/> 메모에 지시 포함</label>
      </div>
      <div class="muted warn" v-if="warn">{{ warn }}</div>
      <div class="muted cmp-noai" v-if="noAi" :title="NO_AI_TIP" data-testid="cmp-noai">연결된 AI 없음 — 내 PC의 Codex·Claude Code 실행기를 켜면 바로 처리 <Hint :text="NO_AI_TIP + ' — 누르면 연결 방법'" :href="CONNECT_HELP"/></div>
      <div class="cmp-foot">
        <select v-model="m.route" class="mini route-sel" aria-label="보낼 곳" :title="routeTip">
          <option v-for="o in routeOpts" :key="o.value" :value="o.value">{{ o.label }}</option></select>
        <Hint :text="routeHelp" :href="CONNECT_HELP"/>
        <span class="spacer"></span>
        <button v-if="!docked" class="small" @click="$emit('close')">닫기</button>
        <button v-if="route==='queue'" class="small cmp-copy" :disabled="!canSend" :title="COPY_TIP + ' — 대기열에 넣고 복사'" @click="sendAndCopy">프롬프트 복사</button>
        <button class="small primary ai-send cmp-send" :data-route="route" :disabled="!canSend" :title="sendTip" @click="send()">
          <span v-if="m.phase==='sending'" class="spin"></span>{{ sendLabel }}</button>
      </div>
    </template>
    <template v-else>
      <ResultView :rid="m.rid" :bare="!docked" @new="again"/>
      <div class="cmp-foot"><button class="small" @click="again">새 요청</button><span class="spacer"></span><button v-if="!docked" class="small" @click="$emit('close')">닫기</button></div>
    </template>
  </div>`,
  setup(props, { emit }) {
    const d = inject('doc'); const m = props.model; const ta = ref(null); const dz = ref(null); const uploading = ref([]); const dragOver = ref(false);
    watch(ta, (input, previous, onCleanup) => { if (input) onCleanup(installHoldToEdit(input)); }, {flush: 'post'});
    // 우클릭에서 상황 종류로 열었으면 그 종류를 세 번째 칩으로 기억(요청·다듬기로 바꿨다 돌아올 수 있게)
    if (m.ctxKind === undefined) m.ctxKind = CTX_KINDS.includes(m.kind) ? m.kind : null;
    const memoEnabled = computed(() => d.s.settings?.aiMemo !== 'none');
    const showInstrOpt = computed(() => memoEnabled.value && !!String(m.instruction || '').trim());
    const workspaceEnabled = computed(() => !!state.config?.features?.contentFormatWorkflow && m.kind === 'instruct');
    watch(workspaceEnabled, on => { if (!on) m.workflow = 'standard'; });
    // 서식: 따로 고르는 칸 없이 지시("굵게", "가운데 정렬" …)를 보고 AI 가 서식 제안을 만든다(server/ai.js SYSTEM·aimock·MCP 안내)
    // 보낼 곳(V3 §2.2·§5.1): 자동 = 채널로 연결된 작업 환경 → 서버(내 AI 키·공용) → 대기열. 고른 길을 못 쓰면 서버가 대기열로 돌린다.
    // 이름은 연결된 환경(API·Codex·Claude Code …, util.workEnv). 공용 서버 AI 는 배포 전이라 따로 고르지 않고 이름도 드러내지 않는다
    if (m.route == null) m.route = 'auto';
    const agent = computed(() => myAgent(d));
    const env = computed(() => docWorkEnv(d.s, { agentName: agent.value.agent }));
    const aiOn = computed(() => env.value.serverOn);
    const route = computed(() => effectiveRoute(m.route || 'auto', agent.value.online, aiOn.value, env.value.ownAi));
    const routeOpts = computed(() => routeOptions(env.value));
    // 고른 환경이 끊기면(선택 칸에서 빠짐) 자동으로 — 빈 선택 칸을 남기지 않는다
    watch(routeOpts, (opts) => { if (m.phase !== 'sending' && !opts.some((o) => o.value === (m.route || 'auto'))) m.route = 'auto'; }, { immediate: true });
    const routeTip = computed(() => `보낼 곳 — 자동: ${env.value.connected || '연결된 AI'}, 없으면 대기열`);
    // 연결 안내는 내 PC 의 구독 AI 먼저(util.js 'AI 연결 차례' — 2026-11-13): 내 AI 키·ChatGPT 앱은 그다음 선택
    const routeHelp = `보낼 곳: 자동은 연결된 AI로 보냅니다 — 내 PC의 Codex·Claude Code 실행기(구독, 추가 비용 없음)가 먼저, 다음 내 AI 키(사용료 별도). 연결이 없으면 대기열에 두었다가 실행기를 켜면 처리합니다. ChatGPT 앱에서는 [프롬프트 복사] 뒤 붙여 넣으면 처리됩니다 — 누르면 연결 방법`;
    // 연결된 AI 가 하나도 없을 때만 한 줄(체험 계정·예시 답변 문서·공용 서버 AI 가 받는 때는 숨김)
    const noAi = computed(() => !env.value.apiOnly && !env.value.ownAi && env.value.autoRoute === 'queue' && !agent.value.online);
    const routeName = computed(() => (route.value === 'agent' ? env.value.agent || agent.value.agent : route.value === 'server' ? env.value.server || 'AI' : route.value === 'example' ? '예시 답변' : '대기열'));
    // 보낼 곳은 선택 칸이 이미 보인다(§1-2 한 번만) — 단추는 '보내기', 어디로 가는지는 title
    const sendLabel = computed(() => (m.phase === 'sending' ? (route.value === 'server' ? 'AI 작업 중…' : '보내는 중…') : '보내기'));
    const sendTip = computed(() => `${route.value === 'queue' ? (noAi.value ? `대기열에 넣습니다 — ${SUB_AI_TIP}` : '대기열에 넣습니다') : `${routeName.value}에 보냅니다`} (Ctrl+Enter)`);
    const isCell = computed(() => !!m.target && (d.isCellRef(m.target.ref) || !!m.target.tableKey));
    const tableOk = computed(() => isCell.value || (!!m.target && d.hasTable(m.target.ref)));
    const ctxKind = computed(() => {
      const k = m.ctxKind;
      if (!k || m.target?.scope === 'document' || (k === 'fill_table' && !tableOk.value)) return null;
      return k;
    });
    const kindList = computed(() => {
      const out = [{ id: 'ask', label: '요청', on: isAsk(m.kind), title: KIND_HELP.ask }, { id: 'polish', label: '다듬기', on: m.kind === 'polish', title: KIND_HELP.polish }];
      if (ctxKind.value) out.push({ id: ctxKind.value, label: kindLabel(ctxKind.value), on: m.kind === ctxKind.value, title: KIND_HELP[ctxKind.value] || '' });
      return out;
    });
    const presetList = computed(() => presets());
    const placeholder = computed(() => PLACEHOLDER[isAsk(m.kind) ? 'ask' : m.kind] || '지시');
    const afterNote = computed(() => (['insert', 'make_table'].includes(m.kind) ? `${bodyRef(m.target?.ref)} 문단 뒤에` : ''));
    const pickable = computed(() => d.s.attachments.filter((a) => !m.attachments.includes(a.aid)));
    // 지시가 꼭 있어야 하는 것은 문단 추가뿐('요청'은 비우면 검토)
    const needsInstr = computed(() => m.kind === 'insert' && !m.instruction.trim() && !m.attachments.length);
    const multiSuggest = computed(() => m.kind === 'suggest' && (m.target?.refs || []).length > 1);
    // 대상 문제(store targetProblem): 지금 문서에 없는 문단·바뀐 글(최신으로 맞추기 전), 내 수정본에서만 고친 글(AI 는 공유 문서 글만 본다) — 보내지 않는다
    const problem = computed(() => (typeof d.targetProblem === 'function' ? d.targetProblem(m.target, m.kind) : ''));
    const warn = computed(() => {
      if (problem.value) return problem.value;
      if (multiSuggest.value) return '문장 제안은 한 문단 안에서 골라 주세요';
      if (needsInstr.value) return '무엇을 쓸지 적어 주세요';
      if (['fill_table', 'make_table'].includes(m.kind) && !m.attachments.length) return '첨부 없음 — 문서 내용만으로 작업합니다';
      if (m.error) return m.error;
      return '';
    });
    const busyNames = computed(() => [...uploading.value, ...(m.pending || [])]);
    const canSend = computed(() => !!m.target && m.phase !== 'sending' && !m.tutorialTyping && !needsInstr.value && !multiSuggest.value && !problem.value && !busyNames.value.length);
    watch(() => m.target?.scope, (sc) => { if (sc === 'document' && !DOC_KINDS.includes(m.kind)) m.kind = 'review'; });
    const bodyRef = (ref_) => (/^(s\d+\/p\d+)/.exec(ref_ || '') || [])[1] || ref_;
    function setKind(id) {
      if (id === 'ask') { if (!isAsk(m.kind)) m.kind = 'review'; } else m.kind = id;
      if (m.kind === 'polish' && !m.preset) m.preset = 'concise';
      nextTick(() => focusEditingInput(ta.value));
    }
    async function addFiles(files) {
      uploading.value = files.map((f) => f.name);
      try { const items = await d.uploadFiles(files); for (const a of items) if (!m.attachments.includes(a.aid)) m.attachments.push(a.aid); }
      finally { uploading.value = []; }
    }
    function pickExisting(e) { const v = e.target.value; if (v && !m.attachments.includes(v)) m.attachments.push(v); e.target.value = ''; }
    const removeAtt = (aid) => { m.attachments = m.attachments.filter((x) => x !== aid); };
    function paste(e) { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } }
    function drop(e) { dragOver.value = false; const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f); }
    function onLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dragOver.value = false; }
    // forceRoute: 문자열일 때만(단축키 Ctrl+Enter 는 이벤트를 넘긴다). quiet: 알림은 부른 쪽이(프롬프트 복사)
    async function send(forceRoute, { quiet = false } = {}) {
      if (!canSend.value) return null;
      const kind = sendKind(m);
      let target = m.target;
      if (['insert', 'make_table'].includes(kind) && target.ref !== bodyRef(target.ref)) target = d.targetForParagraph(bodyRef(target.ref));
      const wanted = typeof forceRoute === 'string' ? forceRoute : (m.route || 'auto');
      m.phase = 'sending'; m.error = '';
      try {
        const r = await d.createRequest({ ...m, kind, target, route: wanted });
        m.rid = r.request?.rid ?? null;
        if (r.failed) { m.error = `AI 처리 실패: ${r.message}`; }
        if (m.rid != null) m.phase = 'result';
        else { m.phase = 'edit'; m.instruction = ''; }   // 보낸 지시는 '쓰다 만 글'로 남기지 않는다
        const msg = r.route === 'agent' ? `${agentEnvName(r.request?.delivery?.agent) || routeName.value}에 보냈습니다`
          : r.queued ? '대기열에 넣었습니다' : m.rid == null ? '요청했습니다' : '';
        if (msg && !quiet) toast(msg);
        return r;
      } catch (e) { m.phase = 'edit'; m.error = e.code === 'STALE' ? '그새 문서가 바뀌었습니다. 다시 골라 주세요.' : e.message; toastError(e, '요청 실패: '); return null; }
    }
    /** 대기열에 넣고 연결한 AI 대화창에 붙여 넣을 프롬프트 복사 */
    async function sendAndCopy() {
      const r = await send('queue', { quiet: true });
      const req = r?.request;
      if (!req) return;
      toast(await copyText(agentPrompt(d, req)) ? '대기열에 넣고 프롬프트를 복사했습니다 — AI 대화창에 붙여 넣으세요' : '대기열에 넣었습니다');
    }
    function again() { m.phase = 'edit'; m.rid = null; m.instruction = ''; m.count = 1; m.error = ''; nextTick(() => focusEditingInput(ta.value)); }
    onMounted(() => { if (m.pickFile) { m.pickFile = false; dz.value?.pick(); } else if (!props.docked) focusEditingInput(ta.value); });
    // [D] AI 빠른 작업 바로 보내기(store openComposer 의 autoSend — 문서 설정 aiQuick 'send'): 열리자마자 [보내기]와 같은 길로 한 번. 보낼 수 없으면 보내지 않고 창에 경고(warn)만
    onMounted(() => { if (m.autoSend) { m.autoSend = false; if (canSend.value) send(); } });
    return { m, ta, dz, uploading, busyNames, dragOver, aiOn, memoEnabled, showInstrOpt, workspaceEnabled, isCell, kindList, presetList, placeholder, afterNote, pickable, problem, warn, canSend, clip, setKind, addFiles, pickExisting, removeAtt, paste, drop, onLeave, send, sendAndCopy, again, agent, env, route, routeOpts, routeTip, routeHelp, noAi, NO_AI_TIP, CONNECT_HELP, sendLabel, sendTip, COPY_TIP };
  },
};

// ───────── 결과 창 ─────────
// v0.3.1(docs/V3_SPEC.md §9.7) + 2026-10-29 정리(docs/UI_TERMS.md): 머리 'AI 작업 #n' + 상태 칩 하나 + 대상 → (기다리는 동안) 한 줄 + [프롬프트 복사]·[취소] →
// 진행 줄·단추(RequestActions) → 남은 것 → 반영한 것 → (접힘) 거절 n건([다시 열기]) → 의견 → (접힘) 기록 → (접힘) 메모 요약.
// 항목 = 서버 outcome 과 같은 규칙(여러 안 묶음은 하나 — util.requestProgress)

const ADOPT_TIP = '내 수정본에 넣습니다(검토 요청 뒤 문서에 들어감)';
const LIVE_TIP = '공유 문서에 바로 반영합니다(모두에게 보임)';
const DIRECT_TIP = '공유 문서에 바로 적용합니다(변경 추적으로 남음)';
/** 결과 창의 항목 하나(여러 안 묶음 또는 제안 하나)와 그 단추 */
const ResultItem = {
  components: { TablePreview, MemoEditor, FormatPreview },
  props: { it: Object, req: Object, ro: Boolean },
  template: `<div class="rs-item" :class="'st-' + (it.state || 'open')" :data-gid="it.gid != null ? it.gid : null">
    <template v-if="altStyle">
      <div class="rs-alts-h muted" v-if="it.list.length > 1" title="안마다 원문 대비 차이">안 {{ it.list.length }}개</div>
      <div class="alt" v-for="(p, i) in it.list" :key="p.pid" :class="p.status" :data-pid="p.pid">
        <div class="alt-h"><b>{{ it.list.length === 1 ? '권장안' : '안 ' + (p.option || i + 1) }}</b><span class="pill" :class="pillCls(p)" v-if="p.status!=='pending'">{{ statusLabel(p) }}</span><span class="spacer"></span><span class="muted">#{{ p.pid }}</span></div>
        <div class="difftext" v-if="p.type==='format'">{{ p.find }}</div>
        <div class="difftext" v-else-if="editing!==p.pid" v-html="diff(p.find, p.replace)"></div>
        <MemoEditor v-else :value="p.replace" ok-label="고쳐서 반영" :rows="3" :busy="editBusy" @save="(t) => editApply(p, t)" @cancel="editing=null"/>
        <FormatPreview :proposal="p"/>
        <div class="muted" v-if="p.reason">{{ p.reason }}</div>
        <div class="muted rs-others" v-if="others(p)">{{ others(p) }}</div>
        <div class="actions" v-if="editing!==p.pid && !ro">
          <template v-if="p.status==='pending'">
            <button v-if="live" class="small primary rs-adopt rs-live" :disabled="busy" :title="LIVE_TIP" @click="adopt(p)">반영</button>
            <template v-else><span class="pill ok adopted" v-if="adopted(p)" title="내 수정본에 들어 있습니다">반영됨</span>
              <button v-else class="small primary rs-adopt" :disabled="busy" :title="ADOPT_TIP" @click="adopt(p)">반영</button></template>
            <button v-if="!rich(p)" class="small rs-edit" title="글을 고친 뒤 반영합니다" @click="editing=p.pid">고쳐서 반영</button>
            <button v-if="!live && canUndoFormat(p)" class="small rs-format-undo" :disabled="busy" title="반영한 서식을 되돌립니다" @click="act('undoAdoptFormat',p)">서식 되돌리기</button>
            <button v-if="direct" class="small rs-apply" :disabled="busy" :title="DIRECT_TIP" @click="act('applyProposal', p)">문서에 바로 적용</button>
            <button class="small rs-reject" :disabled="busy" @click="act('rejectProposal', p)">거절</button></template>
          <button v-if="p.status==='applied'" class="small rs-undo" :disabled="busy" :title="live ? '' : '문서에 적용한 것을 되돌립니다'" @click="act('undoProposal', p)">{{ live ? '되돌리기' : '복구' }}</button>
          <button v-if="p.status==='rejected' || p.status==='undone' || p.supersededByRequest" class="small rs-reopen" :disabled="busy" @click="act('reopenProposal', p)">다시 열기</button></div>
      </div>
    </template>
    <div v-else class="prop" :class="p.status" :data-pid="p.pid">
      <div class="alt-h"><b>#{{ p.pid }}</b><span class="ref" v-if="place.ref && !place.gone" :title="placeTip" @click="goPlace">{{ place.ref }}</span>
        <span class="muted prop-gone" v-else title="그 문단이 그 뒤 지워졌습니다">자리 없음</span><span class="muted" v-if="cellNote(p)">{{ cellNote(p) }}</span>
        <span class="pill" :class="pillCls(p)" v-if="p.status !== 'pending'">{{ statusLabel(p) }}</span></div>
      <template v-if="p.type==='table'"><div class="muted">{{ placeNote(place, (p.table?.rows?.length || 0) + '×' + (p.table?.rows?.[0]?.length || 0) + ' 표') }}</div><TablePreview :table="p.table"/></template>
      <template v-else-if="p.type==='edit_batch'"><div class="muted">내용·서식 나눠 처리한 묶음 제안</div><div class="difftext">내용 {{p.batch?.contentOperations || 0}}건 · 형식 {{p.batch?.formatOperations || 0}}건</div><div class="row"><button class="small" @click="downloadWorkspace(p,'hwpx')">결과 HWPX</button><button class="small" @click="downloadWorkspace(p,'markdown')">내용 Markdown</button></div></template>
      <template v-else-if="p.type==='toc'"><div class="muted">차례 새로 고침</div><div class="difftext" v-if="tocNote(p)">{{ tocNote(p) }}</div></template>
      <template v-else-if="p.type==='table_edit'"><div class="muted">표{{ p.tableEdit?.caption ? ' 「' + p.tableEdit.caption + '」' : '' }} 고치기{{ p.tableEdit?.size?.[0] != null ? ' — ' + p.tableEdit.size[0] + '×' + p.tableEdit.size[1] + ' → ' + p.tableEdit.result[0] + '×' + p.tableEdit.result[1] : '' }}</div><div class="difftext">{{ (p.tableEdit?.labels || []).join(', ') }}</div></template>
      <template v-else-if="p.type==='delete'"><div class="muted">{{ p.status === 'applied' ? '지운 개체' : '이 문단의 개체 지우기' }}(글은 그대로)</div><div class="difftext">{{ deleteNote(p) }}</div></template>
      <template v-else-if="p.type==='para_delete' || p.type==='para_move'"><div class="muted">{{ parasNote(p) }}</div><div class="difftext" v-if="p.type==='para_delete'"><del>{{ parasLines(p) }}</del></div><div class="difftext" v-else>{{ parasLines(p) }}</div></template>
      <template v-else-if="p.type==='page_layout'"><div class="muted">쪽 구성</div><div class="difftext">{{ (p.pageLayout?.labels || []).join(', ') }}</div></template>
      <template v-else-if="p.type==='figure'"><div class="muted">{{ p.figure?.replace ? '이 문단의 그림 교체' : placeNote(place, '그림') }}{{ p.figure?.name ? ' — ' + p.figure.name : '' }}</div><div class="difftext" v-if="p.figure?.caption || p.figure?.replace?.caption">{{ p.figure.caption || p.figure.replace.caption }}</div><div class="muted" v-for="(n, k) in (p.figure?.notes || [])" :key="'n' + k">{{ n }}</div></template>
      <template v-else-if="p.type==='insert'"><div class="muted">{{ placeNote(place, '새 문단', { many: '문단' }) }}</div><div class="difftext"><ins>{{ p.text }}</ins></div></template>
      <div v-else-if="p.type==='format'" class="difftext">{{ p.find }}</div>
      <div v-else class="difftext" v-html="diff(p.find, p.replace)"></div>
      <FormatPreview :proposal="p"/>
      <div class="muted" v-if="p.reason">{{ p.reason }}</div>
      <div class="muted rs-others" v-if="others(p)">{{ others(p) }}</div>
      <div class="actions" v-if="!ro">
        <template v-if="p.status==='pending'">
          <button v-if="live" class="small primary rs-adopt rs-live" :disabled="busy" :title="LIVE_TIP" @click="adopt(p)">반영</button>
          <template v-else><span class="pill ok adopted" v-if="adopted(p)" title="내 수정본에 들어 있습니다">반영됨</span>
            <button v-else-if="!['table','table_edit','toc','figure','page_layout','delete','edit_batch','para_delete','para_move'].includes(p.type)" class="small primary rs-adopt" :disabled="busy" :title="ADOPT_TIP" @click="adopt(p)">반영</button>
            <span v-else-if="!direct" class="muted" title="개체·묶음 제안은 문서에 바로 적용할 권한이 필요합니다">{{p.type==='edit_batch'?'내용·서식 묶음':String(p.type).startsWith('para_')?'문단 지우기·옮기기':'개체 제안'}}은 문서에 바로 적용만</span></template>
          <button v-if="!live && canUndoFormat(p)" class="small rs-format-undo" :disabled="busy" title="반영한 서식을 되돌립니다" @click="act('undoAdoptFormat',p)">서식 되돌리기</button>
          <button v-if="direct" class="small rs-apply" :class="{primary: ['table','table_edit','toc','figure','page_layout','delete','edit_batch','para_delete','para_move'].includes(p.type)}" :disabled="busy" :title="DIRECT_TIP" @click="act('applyProposal', p)">문서에 바로 적용</button>
          <button class="small rs-reject" :disabled="busy" @click="act('rejectProposal', p)">거절</button></template>
        <button v-if="p.status==='applied'" class="small rs-undo" :disabled="busy" :title="live ? '' : '문서에 적용한 것을 되돌립니다'" @click="act('undoProposal', p)">{{ live ? '되돌리기' : '복구' }}</button>
        <button v-if="p.status==='rejected' || p.status==='undone' || p.supersededByRequest" class="small rs-reopen" :disabled="busy" @click="act('reopenProposal', p)">다시 열기</button></div>
    </div>
  </div>`,
  setup(props) {
    const d = inject('doc');
    const editing = ref(null); const busy = ref(false); const editBusy = ref(false);
    // 묶음(여러 안)이거나 문장 제안 요청이면 '안' 모양(고쳐서 반영 포함), 그 밖은 제안 하나 모양
    const altStyle = computed(() => props.it.gid != null || props.req?.kind === 'suggest');
    const p = computed(() => props.it.list[0] || {});
    async function downloadWorkspace(p, kind) {
      try {
        const query = new URLSearchParams({ kind, attempt: String(p.batch.attempt), revision: String(p.batch.revision) });
        const bytes = await api(`/api/docs/${encodeURIComponent(d.s.id)}/requests/${p.rid}/workspace-file?${query}`);
        const url = URL.createObjectURL(new Blob([bytes], { type: kind === 'markdown' ? 'text/markdown' : 'application/vnd.hancom.hwpx' }));
        const a = document.createElement('a'); a.href = url; a.download = `AI-${p.rid}-결과.${kind === 'markdown' ? 'md' : 'hwpx'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { toastError(e); }
    }
    const diff = (a, b) => diffHtml(a || '', b || '');
    const pillCls = (x) => ({ applied: 'ok', pending: 'warn', rejected: '', undone: '', superseded: '' })[x.status] || '';
    function cellNote(x) { const c = d.byRef(x.ref)?.cell; return c ? `${c.row + 1}행 ${c.col + 1}열` : ''; }
    // v0.4 실시간 문서(§4.2): [반영] = 공유 문서에 바로(서버 apply), 적용된 것은 [되돌리기](/undo — 그 뒤 고쳐졌으면 서버 409 STALE 글을 알림)
    const live = computed(() => isRealtimeDoc(d));
    const statusLabel = (x) => (x.supersededByRequest ? `재검토 #${x.supersededByRequest} — 이전 제안` : live.value && x.status === 'applied' ? '반영됨' : live.value && x.status === 'undone' ? '되돌림' : STATUS_LABEL[x.status] || x.status);
    // 기본은 [반영](내 수정본 — 편집기 + /adopt), [문서에 바로 적용]은 관리자 또는 /api/config allowDirectApply 일 때만(v0.2 apply) — 실시간 문서는 [반영]이 곧 그것
    const direct = computed(() => !live.value && canDirectApply());
    const adopted = (x) => adoptedByMe(d, x);
    const canUndoFormat = (x) => adopted(x) && formatAdoptionOf(x, meName(d))?.canUndo;
    /** 남이 자기 수정본에 반영해 둔 제안: '김검토 님이 반영함' */
    function others(x) {
      if (x.status !== 'pending') return '';
      const me = meName(d);
      const names = adopterNames(x).filter((n) => n !== me);
      return names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}명` : ''} 님이 반영함` : '';
    }
    async function guard(fn) { if (busy.value) return null; busy.value = true; try { return await fn(); } catch (e) { toastError(e); return null; } finally { busy.value = false; } }
    const adopt = (x) => guard(() => adoptWith(d, x));
    const act = (name, x) => guard(() => d[name](x));
    async function editApply(x, t) {
      if (editBusy.value) return;   // Ctrl+Enter 두 번 → 한 번만
      editBusy.value = true;
      try {
        if (t !== x.replace) await d.patchProposal(x, { replace: t });
        const res = await adoptWith(d, { ...x, replace: t });
        if (!res || res.ok !== false) editing.value = null;
      } catch (e) { toastError(e); } finally { editBusy.value = false; }
    }
    function go(ref_) { if (ref_) focusIn(d, { ref: ref_ }); }
    // 카드의 자리(web/proposal-place.js): 넣기 제안은 반영 전 '그 뒤에 넣을 문단', 반영 뒤 '실제로 넣은 문단' — 누르면 그 문단(여러 문단이면 끝까지)으로
    const place = computed(() => proposalPlace(p.value));
    const placeTip = computed(() => {
      const pl = place.value; const head = clip(String(d.byRef(pl.ref)?.text ?? '').trim(), 24);
      const span = pl.endRef ? ` ~ ${pl.endRef}(문단 ${pl.count}개)` : '';
      return `${refWords(pl.ref)}${span}${head ? ` 「${head}」` : ''} — 누르면 그 자리로 갑니다`;
    });
    function goPlace() {
      const pl = place.value; if (!pl.ref || pl.gone) return;
      const tail = pl.endRef ? d.byRef(pl.endRef) : null;
      // 여러 문단이면 첫 문단 머리부터 마지막 문단 끝까지 깜빡인다(마지막 문단 글을 모르면 첫 문단만)
      focusIn(d, tail ? { ref: pl.ref, start: 0, end: Array.from(String(tail.text ?? '')).length, endRef: pl.endRef } : { ref: pl.ref });
    }
    // 문단 지우기·옮기기 제안(para_delete·para_move — 2026-11-17, server/paragraph-ops.js): 문단 수·옮길 자리 한 줄과 첫 글 몇 줄(제안할 때 서버가 적어 둔 글)
    function parasNote(x) {
      const n = Number(x.paras?.count) || 0; const dest = x.paras?.dest || {};
      if (x.type === 'para_delete') return x.status === 'applied' ? `지운 문단 ${n}개(이 문단 뒤에 있던)` : `문단 ${n}개 지우기(글·표·그림째)`;
      const where = dest.before ? `「${clip(String(dest.beforeText || ''), 24)}」 앞` : `「${clip(String(dest.text || ''), 24)}」 뒤`;
      return x.status === 'applied' ? `옮긴 문단 ${n}개(${where})` : `문단 ${n}개 옮기기 → ${where}`;
    }
    function parasLines(x) { const f = Array.isArray(x.paras?.first) ? x.paras.first : []; return [...f, ...(x.paras?.last ? ['…', x.paras.last] : [])].join(' / '); }
    return { d, editing, busy, editBusy, altStyle, p, diff, pillCls, cellNote, live, statusLabel, direct, adopted, others, adopt, act, editApply, go, place, placeTip, goPlace, placeNote, downloadWorkspace, STATUS_LABEL, rich: isRichProposal, canUndoFormat, tocNote, deleteNote, parasNote, parasLines, ADOPT_TIP, LIVE_TIP, DIRECT_TIP };
  },
};

// 묶음 제안 항목(2026-11-17, docs/UI_TERMS.md §9 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-11): 한 번에 낸 한 덩어리(논문 절 50문단 + 표·그림, 용어 바꾸기 61곳)를
// 항목 하나로 — 머리 이름 · 첫 몇 개 미리보기 · [반영 (n)]·[거절 (n)](그 묶음의 남은 제안 — 요청 [모두 반영]·[남은 n건 거절]과 같은 길을 그 pid 로 좁힘, store resolveRequest)
// · [펼치기](구성원마다 ResultItem — 하나씩 반영·거절·고쳐서 반영 그대로). 단추의 n 은 제안 수(진행 줄의 '건'은 항목 수)
const BUNDLE_PEEK = 3;
const BundleItem = {
  components: { ResultItem, InlineConfirm: null },
  props: { it: Object, req: Object, ro: Boolean },
  template: `<div class="rs-item rs-bundle" :class="'st-' + (it.state || 'open')" :data-bundle="it.bundle">
    <div class="alt-h"><b class="rs-b-label">{{ label }}</b><span class="muted rs-b-count">{{ countText }}</span><span class="spacer"></span>
      <span class="ref" v-if="placeRef" :title="placeTip" @click="goPlace">{{ placeRef }}</span></div>
    <div class="rs-b-peek" v-if="!expanded">
      <div class="difftext" v-for="x in peek" :key="x.pid">{{ peekText(x) }}</div>
      <div class="muted" v-if="it.list.length > peek.length">… 외 {{ it.list.length - peek.length }}건</div></div>
    <InlineConfirm v-if="asking" :message="'이 묶음의 남은 ' + left.length + '건을 거절할까요?'" ok-label="거절" danger :busy="busy === 'reject'" @ok="reject" @cancel="asking=false"/>
    <div class="actions" v-else>
      <template v-if="!ro && left.length">
        <button v-if="adoptN" class="small primary rs-b-adopt" :disabled="!!busy" :title="live ? LIVE_TIP : ADOPT_TIP" @click="run('adopt')"><span v-if="busy==='adopt'" class="spin"></span>반영 ({{ adoptN }})</button>
        <button v-if="direct" class="small rs-b-apply" :class="{ primary: !adoptN }" :disabled="!!busy" :title="DIRECT_TIP" @click="run('apply')"><span v-if="busy==='apply'" class="spin dark"></span>문서에 바로 적용 ({{ left.length }})</button>
        <span v-else-if="!adoptN" class="muted" title="개체 제안은 문서에 바로 적용할 권한이 필요합니다">개체 제안은 문서에 바로 적용만</span>
        <button class="small rs-b-reject" :disabled="!!busy" @click="asking=true">거절 ({{ left.length }})</button>
      </template>
      <button class="small rs-b-more" :aria-expanded="expanded ? 'true' : 'false'" @click="expanded = !expanded">{{ expanded ? '접기' : '펼치기' }}</button></div>
    <div class="rs-b-list" v-if="expanded"><ResultItem v-for="m in members" :key="'p' + m.list[0].pid" :it="m" :req="req" :ro="ro"/></div>
  </div>`,
  setup(props) {
    const d = inject('doc');
    const expanded = ref(false); const busy = ref(''); const asking = ref(false);
    const live = computed(() => isRealtimeDoc(d));
    const direct = computed(() => !live.value && canDirectApply());
    const openSet = computed(() => new Set((props.it.open || []).map(Number)));
    const left = computed(() => props.it.list.filter((p) => openSet.value.has(Number(p.pid))));
    // 비실시간 문서의 [반영] = 내 수정본에 넣을 수 있는 바꿈·문단 추가만(표·그림은 [모두 반영]처럼 남는다), 실시간 문서는 남은 것 모두를 공유 문서에
    const adoptN = computed(() => (live.value ? left.value.length : left.value.filter((p) => !BUNDLE_OBJECTS.includes(p.type)).length));
    const label = computed(() => bundleLabel(props.it.list));
    const countText = computed(() => {
      const n = props.it.list.length; const l = left.value.length;
      const acc = props.it.list.filter((p) => p.status === 'applied' || (p.status === 'pending' && !openSet.value.has(Number(p.pid)))).length;
      return props.it.state === 'open' && l < n ? `${n}건 · 반영 ${acc} · 남음 ${l}` : `${n}건`;
    });
    const peek = computed(() => (left.value.length ? left.value : props.it.list).slice(0, BUNDLE_PEEK));
    function peekText(p) {
      if (p.type === 'insert') return p.blank || !String(p.text ?? '').trim() ? '(빈 줄)' : clip(p.text, 80);
      if (p.type === 'table') return `표 ${p.table?.rows?.length || 0}×${p.table?.rows?.[0]?.length || 0}${p.table?.caption ? ` 「${clip(p.table.caption, 40)}」` : ''}`;
      if (p.type === 'figure') return `${p.figure?.nativeChart ? '차트' : '그림'}${p.figure?.caption ? ` 「${clip(p.figure.caption, 40)}」` : ''}`;
      if (p.type === 'format') return `서식: 「${clip(p.find || '빈 문단', 40)}」`;
      if (p.type === 'delete') return `개체 지우기: ${deleteNote(p)}`;
      if (p.type === 'para_delete') return `문단 ${Number(p.paras?.count) || 0}개 지우기${Array.isArray(p.paras?.first) && p.paras.first.length ? `: 「${clip(p.paras.first[0], 40)}」` : ''}`;
      if (p.type === 'replace' || !p.type) return `「${clip(p.find ?? '', 30)}」 → 「${clip(p.replace ?? '', 30)}」`;
      return `#${p.pid}`;
    }
    // 구성원 카드: 상태는 묶음의 셈과 같게(남음 = 대기 + 반영해 두지 않음)
    const members = computed(() => props.it.list.map((p) => ({ gid: null, list: [p], state: openSet.value.has(Number(p.pid)) ? 'open' : p.status === 'applied' || p.status === 'pending' ? 'accepted' : 'declined' })));
    const place = computed(() => proposalPlace(props.it.list[0] || {}));
    const placeRef = computed(() => (place.value.ref && !place.value.gone ? place.value.ref : ''));
    const placeTip = computed(() => `${refWords(place.value.ref)} — 누르면 그 자리로 갑니다`);
    function goPlace() { if (placeRef.value) focusIn(d, { ref: placeRef.value }); }
    async function run(mode) {
      if (busy.value || !props.req) return;
      busy.value = mode;
      try { await d.resolveRequest(props.req, mode, { pids: left.value.map((p) => Number(p.pid)) }); } catch (e) { toastError(e, `AI 작업 #${props.req.rid}: `); } finally { busy.value = ''; }
    }
    async function reject() { await run('reject'); asking.value = false; }
    watch(() => left.value.length, (n) => { if (!n) asking.value = false; });
    return { expanded, busy, asking, live, direct, left, adoptN, label, countText, peek, peekText, members, placeRef, placeTip, goPlace, run, reject, ADOPT_TIP, LIVE_TIP, DIRECT_TIP };
  },
};
// 수정본에 넣지 못하는 종류(web/util.js OBJECT_TYPES 와 같다 — 2026-11-17 문단 지우기·옮기기 더함)
const BUNDLE_OBJECTS = ['table', 'table_edit', 'toc', 'figure', 'page_layout', 'delete', 'edit_batch', 'para_delete', 'para_move'];

// 대기 중 안내 — 내 PC 의 구독 AI 를 먼저, ChatGPT 앱(프롬프트 복사)은 그다음(util.js 'AI 연결 차례')
// '?'는 설명서 ①절(#agents). 체험 계정의 관리자 ChatGPT 이벤트 대기(request-wait.js — wait 가 있을 때)만 ChatGPT 절(#chatgpt-oauth) — 그 요청은 관리자 ChatGPT 가 처리한다
const WAIT_HINT = `대기열의 요청은 연결된 AI가 가져가 처리합니다. ${SUB_AI_TIP}. ChatGPT Work 등 MCP로 연결한 AI 대화창이면 [프롬프트 복사] 뒤 붙여 넣으세요`;
export const ResultView = {
  components: { AttachChips, TablePreview, MemoEditor, ResultItem, BundleItem, Hint, RequestActions: null },
  // bare: 떠 있는 창 안(창 제목이 이미 'AI 작업 #n') — 머리에 번호를 다시 쓰지 않는다. 슬롯 head = 머리 끝 단추(AI 작업 탭 결과 [×])
  props: { rid: Number, compact: Boolean, bare: Boolean },
  emits: ['new'],
  template: `<div class="result" v-if="r" :data-rid="r.rid">
    <div class="rs-head"><b v-if="!bare" class="rs-title" :title="kindTitle">AI 작업 #{{ r.rid }}</b>
      <span class="pill req-st" :class="badge.cls" :title="badge.title">{{ badge.label }}</span><span class="spacer"></span>
      <span class="ref" v-if="r.target" @click="go(r.target.ref, r.target.start, r.target.end)">{{ r.target.scope === 'document' ? '문서 전체' : r.target.ref }}</span><slot name="head"></slot></div>
    <div class="rs-target muted" v-if="r.target?.text">「{{ clip(r.target.text, 90) }}」</div>
    <AttachChips v-if="r.attachments?.length" :aids="r.attachments"/>

    <div v-if="r.status==='pending' || r.status==='working'" class="rs-wait" :class="badge.cls">
      <template v-if="r.status==='working'"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>처리 중</span><span class="muted" v-if="badge.who">· {{ badge.who }}</span></template>
      <template v-else><span class="ph-wait-dot" aria-hidden="true"></span><span v-if="wait">{{ wait.text }}</span><span v-else-if="r.delivery">{{ deliveredTo }}에 전달됨</span><span v-else>대기열에 있습니다</span><span class="muted" v-if="badge.phase === 'late'">· 응답 없음</span></template>
      <span class="spacer"></span>
      <template v-if="r.status==='pending'"><Hint :text="wait?.hint || WAIT_HINT" :href="wait ? '/help.html#chatgpt-oauth' : CONNECT_HELP"/><button v-if="!wait || wait.manualCopy" class="small rs-copy" :title="COPY_TIP" @click="copyAgent">프롬프트 복사</button></template>
      <button v-if="canEdit" class="small rs-cancel" @click="cancel">취소</button></div>
    <div v-if="r.status==='failed'" class="rs-fail"><span class="rs-fail-msg">실패: {{ r.error || '알 수 없음' }}</span><span class="spacer"></span>
      <button v-if="canEdit" class="small ai-send rs-retry" :disabled="retrying" :title="retryTip(d, r)" @click="retry"><span v-if="retrying" class="spin dark"></span>다시</button></div>
    <div v-if="r.status==='cancelled' && canEdit && !d.s?.info?.tutorialOwnAi" class="row rs-again"><button class="small ai-send rs-retry" :disabled="retrying" :title="retryTip(d, r)" @click="retry">다시 요청</button></div>

    <p v-if="r.recoveryOf" class="muted">AI 작업 #{{ r.recoveryOf.rid }}의 남은 제안을 현재 문서에서 다시 검토합니다. 이미 반영한 내용은 유지합니다.</p>
    <p v-if="r.recoveredBy" class="muted">이전 제안을 보관했습니다. 새 검토 결과는 AI 작업 #{{ r.recoveredBy }}에서 확인하세요.</p>
    <RequestActions :rid="r.rid" place="result"/>
    <div class="muted rs-ro" v-if="ro && (sec.open.length || sec.accepted.length)" :title="roTip">{{ roWhy }}</div>

    <div v-if="sec.open.length" class="rs-sec rs-open"><div class="rs-sec-h">남은 제안 {{ sec.open.length }}건</div>
      <template v-for="it in sec.open" :key="itKey(it)"><BundleItem v-if="it.bundle != null" :it="it" :req="r" :ro="ro"/><ResultItem v-else :it="it" :req="r" :ro="ro"/></template></div>
    <div v-if="sec.accepted.length" class="rs-sec rs-accepted"><div class="rs-sec-h">반영한 제안 {{ sec.accepted.length }}건</div>
      <template v-for="it in sec.accepted" :key="itKey(it)"><BundleItem v-if="it.bundle != null" :it="it" :req="r" :ro="ro"/><ResultItem v-else :it="it" :req="r" :ro="ro"/></template></div>
    <details v-if="sec.declined.length" class="rs-sec rs-declined"><summary class="rs-sec-h" title="다시 열어 고를 수 있습니다">{{ r.recoveredBy ? '거절·이전 제안 보관' : '거절' }} {{ sec.declined.length }}건</summary>
      <template v-for="it in sec.declined" :key="itKey(it)"><BundleItem v-if="it.bundle != null" :it="it" :req="r" :ro="ro"/><ResultItem v-else :it="it" :req="r" :ro="ro"/></template></details>

    <div v-if="comments.length" class="rs-sec"><div class="rs-sec-h">의견 {{ comments.length }}건</div>
      <div class="cmt" v-for="c in comments" :key="c.id"><span class="ref" @click="go(c.ref, c.start, c.end)">{{ c.ref }}</span> <span class="pre">{{ c.body ?? c.text }}</span></div></div>

    <details v-if="log.length" class="rs-log"><summary class="rs-sec-h">기록 {{ log.length }}</summary>
      <div class="rs-log-row" v-for="(x, i) in log" :key="i"><span class="muted">{{ fmtShort(x.at) }}</span> · {{ x.by }} · {{ x.detail || x.action }}</div></details>

    <details class="rs-share">
      <summary class="rs-sec-h" :title="memoEnabled ? '한글 메모에 남는 공유 요약 — 고쳐 저장할 수 있습니다' : 'AI 작업 탭에 보이는 공유 요약'">{{ memoEnabled ? '메모 요약' : '요약' }} <span class="muted rs-share-by">{{ summaryByLabel }}</span></summary>
      <textarea v-model="summary" rows="2" :disabled="!canEdit" placeholder="공유용 요약" aria-label="메모 요약" @keydown.ctrl.enter.prevent="saveSummary"></textarea>
      <div class="row"><label v-if="memoEnabled && (r.instruction || r.options?.includeInstruction)" class="check" title="지시 글도 한글 메모에 함께 남깁니다"><input type="checkbox" :checked="!!r.options?.includeInstruction" :disabled="!canEdit" @change="toggleInstr"/> 지시 포함</label><span class="spacer"></span>
        <button class="small" v-if="memoText" @click="showMemo=!showMemo">{{ showMemo ? '메모 접기' : '한글 메모 보기' }}</button>
        <button class="small primary" v-if="canEdit" :disabled="!dirty" @click="saveSummary">저장</button></div>
      <pre class="memo-preview" v-if="showMemo">{{ memoText }}</pre>
    </details>
  </div>
  <div v-else class="muted">요청을 불러오는 중…</div>`,
  setup(props) {
    const d = inject('doc');
    const r = computed(() => d.request(props.rid));
    // 내 눈의 진행(§9.7) — 항목 = 여러 안 묶음 하나 또는 제안 하나, 상태 open·accepted·declined
    const g = computed(() => (r.value && typeof d.progress === 'function' ? d.progress(r.value) : null));
    const sec = computed(() => {
      const e = g.value?.entries || [];
      return { open: e.filter((x) => x.state === 'open'), accepted: e.filter((x) => x.state === 'accepted'), declined: e.filter((x) => x.state === 'declined') };
    });
    const itKey = (it) => (it.gid != null ? `g${it.gid}` : it.bundle != null ? `b${it.bundle}` : `p${it.list[0]?.pid}`);
    const comments = computed(() => d.commentsOf(r.value));
    const log = computed(() => (Array.isArray(r.value?.log) ? r.value.log : []));
    const showMemo = ref(false);
    const summary = ref(''); watch(() => r.value?.summary, (v) => { summary.value = v || ''; }, { immediate: true });
    const dirty = computed(() => (r.value?.summary || '') !== summary.value);
    const canEdit = computed(() => !!r.value && (r.value.by === state.me?.name || r.value.recoveryOwner === state.me?.name || state.me?.role === 'admin'));
    const memoText = computed(() => d.s.memos.find((m) => m.id === r.value?.memoId)?.text || '');
    const summaryByLabel = computed(() => ({ auto: '자동', ai: 'AI', user: '사람이 고침' })[r.value?.summaryBy] || '');
    const memoEnabled = computed(() => d.s.settings?.aiMemo !== 'none');
    const badge = computed(() => requestBadge(d, r.value));
    const wait = computed(() => requestWait(r.value));
    const kindTitle = computed(() => requestKindText(r.value));
    async function saveSummary() { if (!dirty.value) return; try { await d.patchRequest(r.value, { summary: summary.value }); toast('메모 요약을 고쳤습니다'); } catch (e) { toastError(e); } }
    async function toggleInstr(e) { try { await d.patchRequest(r.value, { includeInstruction: e.target.checked }); } catch (err) { toastError(err); } }
    async function copyAgent() { if (await copyText(agentPrompt(d, r.value))) toast('프롬프트를 복사했습니다 — AI 대화창에 붙여 넣으세요'); }
    function go(ref_, start, end) { if (ref_) focusIn(d, { ref: ref_, start, end }); }
    const mineReq = computed(() => isMeName(d, r.value?.by));
    const deliveredTo = computed(() => { const env = agentEnvName(r.value?.delivery?.agent) || '연결된 AI'; return mineReq.value ? env : `${r.value?.by} 님의 ${env}`; });
    // v0.4: 읽기만 — '간단히' 보기에서 남의 AI 작업(요청한 사람이 정한다, §4.1) 또는 수정 권한 없음(§1)
    const hiddenReq = computed(() => (typeof d.requestHidden === 'function' ? !!d.requestHidden(r.value) : false));
    const ro = computed(() => hiddenReq.value || (typeof d.canDecide === 'function' && !d.canDecide()));
    const roWhy = computed(() => (hiddenReq.value ? `${r.value?.by || '요청한 사람'} 님의 AI 작업입니다 — 반영·거절은 요청한 사람이 합니다` : '수정 권한이 없어 반영·거절할 수 없습니다'));
    const roTip = computed(() => (hiddenReq.value ? "보기 '자세히'에서는 모든 단추가 보입니다" : '문서 설정에서 수정 권한을 받으면 반영·거절할 수 있습니다'));
    // 다시·취소: 서버 경로(AI 키) 처리가 또 실패하면(502) 결과 창이 실패 상태를 다시 보여 주고 알림만 띄운다
    const retrying = ref(false);
    async function retry() { retrying.value = true; try { await d.retryRequest(r.value); } catch (e) { toastError(e, '다시 요청 실패: '); await d.refresh(['requests', 'memos']); } finally { retrying.value = false; } }
    async function cancel() { try { await d.cancelRequest(r.value); } catch (e) { toastError(e); } }
    return { d, r, g, sec, itKey, comments, log, showMemo, summary, dirty, canEdit, memoText, memoEnabled, summaryByLabel, saveSummary, toggleInstr, copyAgent, go, retry, cancel, retrying, retryTip, wait,
      clip, fmtShort, badge, kindTitle, mineReq, deliveredTo, ro, roWhy, roTip, COPY_TIP, WAIT_HINT, CONNECT_HELP };
  },
};
Composer.components.ResultView = ResultView;

// ───────── 메모 달기 작은 창(쓰던 글은 창 모델 model.text 에 — 창이 다시 그려져도 남게) ─────────
export const EditPopover = {
  components: { FloatWin, MemoEditor },
  props: { model: Object },
  emits: ['close'],
  template: `<FloatWin :anchor="model.anchor" :width="380" title="메모 달기" cls="popover" @close="$emit('close')">
    <div class="cmp-target"><span class="ref">{{ t.ref }}</span> <span class="quote">「{{ clip(t.display || t.text, 60) || '(빈 문단)' }}」</span><span class="muted" v-if="t.refs?.length > 1">첫 문단만</span>
      <span class="muted cmp-note" v-if="t.note">· {{ t.note }}</span></div>
    <MemoEditor v-model="text" placeholder="의견을 적으세요 — 한글에서도 메모로 보입니다" ok-label="메모 달기" :busy="busy" @save="saveMemo" @cancel="$emit('close')"/>
  </FloatWin>`,
  setup(props, { emit }) {
    const d = inject('doc'); const t = props.model.target; const busy = ref(false);
    const text = computed({ get: () => props.model.text ?? '', set: (v) => { props.model.text = v; } });
    // 단 뒤에는 글을 비우고 닫는다(닫을 때 '쓰다 만 글'로 남기지 않게 — store closeWindow)
    async function saveMemo(v) { if (busy.value) return; busy.value = true; try { await d.addMemo(t, v); props.model.text = ''; emit('close'); } catch (e) { toastError(e); } finally { busy.value = false; } }
    return { t, busy, text, clip, saveMemo };
  },
};

export { groupChanges };

// ───────── v0.3 협업 공용 도우미(레일·검토 탭·변경 요청·AI 작업이 같이 쓴다) ─────────
// store 계약(편집기 껍데기 쪽): d.me·d.colorOf·d.isMe·d.editor{ ready, focusRange, setActive, … }·d.replyMemo·d.resolveMemo …

const REF_RE = /^s(\d+)\/p(\d+)((?:\/n\d+)*)$/;
/** 문서 순서 비교 열쇠: [구역, 본문, 중첩 경로…](서버 crs.js 와 같은 규칙) */
function refKey(ref_) {
  const m = REF_RE.exec(String(ref_ || '')); if (!m) return [Infinity];
  return [Number(m[1]), Number(m[2]), ...(m[3] ? m[3].split('/n').slice(1).map(Number) : [])];
}
/** 문단 ref 문서 순서 비교 */
export function cmpRef(a, b) {
  const x = refKey(a); const y = refKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] == null) return -1; if (y[i] == null) return 1; if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}
/** 내 이름(store 의 d.me, 없으면 로그인 정보) */
export const meName = (d) => d?.me || state.me?.name || '';
export const isAdmin = () => state.me?.role === 'admin';
/** 나(또는 내 에이전트 '나(Claude)')인가 — store·annotations.js 와 같은 규칙 */
export function isMeName(d, name) {
  if (typeof d?.isMe === 'function') { try { return !!d.isMe(name); } catch { /* 아래 */ } }
  const me = meName(d); const n = String(name ?? '');
  return !!me && (n === me || n.startsWith(`${me}(`));
}
/** 사람 색(store 의 d.colorOf, 없으면 annotations.js colorForUser — 나 = 파랑) */
export function colorOf(d, name) {
  if (typeof d?.colorOf === 'function') { try { const c = d.colorOf(name); if (c) return c; } catch { /* 아래 */ } }
  return colorForUser(name, meName(d));
}
/** 제안 [문서에 바로 적용](v0.2 apply) 권한: 관리자 또는 /api/config 의 allowDirectApply 가 true */
export const canDirectApply = () => isAdmin() || state.config?.allowDirectApply === true;
/** v0.4: 실시간 수정 문서인가(문서 설정 — store d.realtime) */
export const isRealtimeDoc = (d) => typeof d?.realtime === 'function' && !!d.realtime();
/** 쓸 수 있는 편집기 손잡이(없거나 아직 준비 안 됨 → null) */
export function editorOf(d) { const e = d?.editor; return e && e.ready !== false ? e : null; }

/**
 * 기준 ref 범위로 이동: 편집기(플러그인 focusRange, 깜빡임)가 있으면 그것, 없으면 v0.2 처럼 d.s.focus.
 * @param r { ref, start?, end?, endRef? } — 기준 문서 ref + 최종본 코드포인트
 */
export function focusIn(d, r, { select = false, quiet = false } = {}) {
  if (!d || !r || !r.ref) return false;
  const ed = editorOf(d);
  if (ed && typeof ed.focusRange === 'function') {
    const p = { ref: r.ref, flash: true };
    if (r.start != null) p.start = r.start;
    if (r.end != null) p.end = r.end;
    if (r.endRef && r.endRef !== r.ref) p.endRef = r.endRef;
    if (select) p.select = true;
    Promise.resolve().then(() => ed.focusRange(p)).then((okk) => {
      if (okk === false && !quiet) toast('편집기에서 그 자리를 찾지 못했습니다(내 수정본에서 그 문단·표가 바뀌었을 수 있음)', { ms: 3000 });
    }).catch(() => {});
    return true;
  }
  d.s.focus = { ref: r.ref, start: r.start, end: r.end, t: Date.now() };
  return true;
}
const sameAnn = (x, y) => x === y || (!!x && !!y && x.kind === y.kind && String(x.id) === String(y.id));
function editorActive(d, a) {
  try { const r = d.editor?.setActive?.(a); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* 편집기 없음 */ }
}
/**
 * 레일 카드·검토 탭 ↔ 편집기 강조(setActive). store 규칙: d.s.active = 누른 것(고정), d.s.hover = 마우스를 올린 것.
 * hover(true)  → 편집기 강조를 그 항목으로, hover(false) → 누른 것(active)으로 되돌림.
 */
export function setActiveAnn(d, a) {
  if (!d?.s) return;
  if (!sameAnn(d.s.active, a)) d.s.active = a;
  editorActive(d, a);
}
export function setHoverAnn(d, a) {
  if (!d?.s) return;
  if (!sameAnn(d.s.hover, a)) d.s.hover = a;
  editorActive(d, a || d.s.active || null);
}
/** 변경 요청 탭의 상세로 이동(레일 '변경 보기', 우클릭 '변경 보기') */
export function openCr(d, cid, hid = null) {
  if (!d?.s) return;
  d.s.crOpen = cid == null ? null : Number(cid);
  d.s.crFocusHid = hid || null;
  d.s.tab = 'cr';
  callPanel(d);
}
/** 오른쪽 창(패널)을 부른다 — 접혀 있으면 펼쳐 둔다(app.js reveal). 탭·고른 값이 이미 같아도 알리게 수를 올린다 */
export function callPanel(d) { if (d?.s) d.s.panelPing = (d.s.panelPing || 0) + 1; }

/** 요청 종류 글(#n 의 title·상태 칩 title 머리): 'AI 검토' · '다듬기 · 간결하게' … */
export function requestKindText(r) {
  if (!r) return '';
  return `${r.label || kindLabel(r.kind)}${r.preset && !r.label ? ` · ${presetLabel(r.preset)}` : ''}`;
}
// ── 진행 단계(색·움직임 — docs/UI_TERMS.md §6): 상태 칩·카드 테두리·꼭지 수·편집기 강조가 같은 단계를 쓴다 ──
// wait = 보냈고 아직 응답 없음(대기열·전달됨 — 은은한 붉은 톤) · late = 오래 응답 없음(LATE_MS 넘게 대기, 맡은 시간 지남 — 조금 짙게)
// run = AI 처리 중(보라, 움직임) · act = 도착 — 내가 반영·거절할 제안이 남음(테두리 강조) · hold = 남은 제안이 있지만 남의 요청(강조 없음)
// ok = 완료 · fail = 실패 · off = 취소됨
export const LATE_MS = 2 * 60 * 1000;
const clock = ref(Date.now()); let ticking = false;
/** 지금 시각(반응형 — 20초마다 바뀌어 '응답 없음'으로 넘어가는 칩이 저절로 다시 그려진다). 브라우저에서만 돈다 */
function nowMs() {
  if (typeof window === 'undefined') return Date.now();
  if (!ticking) { ticking = true; clock.value = Date.now(); setInterval(() => { clock.value = Date.now(); }, 20000); }
  return clock.value;
}
/** 지금 상태로 기다리기 시작한 시각(ms): 만든 때·마지막 기록(다시 요청 등)·전달된 때 중 가장 늦은 것 */
function waitSince(r) {
  const last = Array.isArray(r.log) && r.log.length ? r.log[r.log.length - 1]?.at : null;
  const ts = [r.at, r.delivery?.at, last].map((x) => Date.parse(x || '')).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : NaN;
}
/** 대기 중 요청이 응답 없이 기다린 분(LATE_MS 를 넘었을 때만 — 아니면 0) */
function lateMinutes(r) {
  const t = waitSince(r);
  const ms = Number.isFinite(t) ? nowMs() - t : 0;
  return ms > LATE_MS ? Math.floor(ms / 60000) : 0;
}
/** AI 작업의 진행 단계(위 표) — 칩 색·카드 테두리·편집기 강조가 같은 것을 쓴다 */
export function requestPhase(d, r) {
  if (!r) return '';
  switch (r.status) {
    case 'pending': return lateMinutes(r) ? 'late' : 'wait';
    case 'working': { const x = Date.parse(r.claim?.expires || ''); return r.claim?.expired || (Number.isFinite(x) && x < nowMs()) ? 'late' : 'run'; }
    case 'done': {
      const g = typeof d?.progress === 'function' ? d.progress(r) : null;
      if (!(g && !g.resolved && g.open > 0)) return 'ok';
      const can = typeof d?.canResolve === 'function' ? d.canResolve(r) : isMeName(d, r.by);
      return can ? 'act' : 'hold';
    }
    case 'failed': return 'fail';
    case 'cancelled': return 'off';
    default: return '';
  }
}
/** 단계 이름(꼭지·탭 수의 title) */
export const PHASE_TEXT = { wait: '응답 대기', late: '응답 없음', run: '처리 중', act: '확인 필요', hold: '확인 필요', ok: '완료', fail: '실패', off: '취소됨' };
/** 요청 목록 → 한눈에 볼 수: [{ ph: 'act'|'run'|'wait', n, late, tip }](0 인 것은 뺌 — 내 할 일, 움직이는 것, 기다리는 것 차례) */
export function requestGlance(d, list) {
  let act = 0; let run = 0; let wait = 0; let late = 0;
  for (const r of list || []) {
    const ph = requestPhase(d, r);
    if (ph === 'act') act++;
    else if (ph === 'run') run++;
    else if (ph === 'wait' || ph === 'late') { wait++; if (ph === 'late') late++; }
  }
  const out = [];
  if (act) out.push({ ph: 'act', n: act, tip: `확인 필요 ${act}건 — 도착한 제안을 반영하거나 거절하세요` });
  if (run) out.push({ ph: 'run', n: run, tip: `AI 처리 중 ${run}건` });
  if (wait) out.push({ ph: late ? 'late' : 'wait', n: wait, tip: late ? `응답 대기 ${wait}건 — ${late}건은 오래 응답이 없습니다` : `응답 대기 ${wait}건 — 보냈고 AI가 아직 맡지 않음` });
  return out;
}

/**
 * AI 작업 상태 칩 하나(docs/UI_TERMS.md §1-3): 대기열 → 전달됨 → 처리 중 → 확인 필요 → 완료 · 실패 · 취소됨.
 * 종류(#n 옆에 따로 쓰지 않음)·보낸 곳·맡은 이·시각은 title 에. 확인 필요 = AI 는 끝냈고 반영·거절할 제안이 남음(d.progress)
 * 색·움직임은 진행 단계(requestPhase — cls 'ph-…', §6)
 * → { label, cls, title, who, phase }
 */
export function requestBadge(d, r) {
  if (!r) return { label: '', cls: '', title: '', who: '', phase: '' };
  const who = handlerName(r);
  const kind = requestKindText(r);
  const t = (s) => (s ? `${kind} — ${s}` : kind);
  const phase = requestPhase(d, r);
  const cls = phase ? `ph-${phase}` : '';
  const out = (label, title) => ({ label, cls, who, title, phase });
  switch (r.status) {
    case 'pending': {
      const late = phase === 'late' ? ` · ${lateMinutes(r)}분째 응답 없음` : '';
      const wait = requestWait(r);
      if (wait) return out(wait.label, t(`${wait.text}${late} — ${wait.hint}`));
      if (r.delivery) return out('전달됨', t(`${agentEnvName(r.delivery.agent) || '연결된 AI'}에 전달${r.delivery.at ? ` · ${fmtShort(r.delivery.at)}` : ''}${late} — AI가 맡으면 '처리 중'`));
      return out('대기열', t(`AI가 가져가길 기다리는 중${late} — 내 PC의 Codex·Claude Code 실행기를 켜 두면 바로 처리됩니다. ChatGPT Work 등 연결한 AI 대화창이면 [프롬프트 복사] 뒤 붙여 넣으세요`));
    }
    case 'working': {
      const c = r.claim || {};
      const by = c.by && !c.server && !isMeName(d, c.by) ? `(${c.by})` : '';
      return out('처리 중', t(`${who || 'AI'}${by} 처리 중${c.expires ? ` · ${fmtShort(c.expires)}까지 맡음` : ''}${phase === 'late' ? ' · 맡은 시간 지남 — 응답 없음' : ''}`));
    }
    case 'done': {
      const g = typeof d?.progress === 'function' ? d.progress(r) : null;
      if (g && !g.resolved && g.open > 0) return out('확인 필요', t(`${who ? `${who} 처리 · ` : ''}남은 제안 ${g.open}건${phase === 'act' ? ' — 반영하거나 거절하세요' : ''}`));
      return out('완료', t(who ? `${who} 처리` : ''));
    }
    case 'failed': return out('실패', t(r.error || ''));
    case 'cancelled': return out('취소됨', t(''));
    default: return out(STATUS_LABEL[r.status] || r.status || '', kind);
  }
}

/** (옛) AI 작업 상태 알약 — 새 화면은 requestBadge(종류·확인 필요까지 한 칩). 검토 레일이 옮겨 갈 때까지 둔다 */
export function reqState(r) {
  if (!r) return { label: '', cls: '', title: '' };
  const claim = r.claim || null;
  switch (r.status) {
    case 'pending':
      if (r.delivery) return { label: '전달됨', cls: 'info', title: `${agentEnvName(r.delivery.agent) || '연결된 AI'}에 전달${r.delivery.at ? ` · ${fmtShort(r.delivery.at)}` : ''} — AI가 맡으면 '처리 중'` };
      return { label: '대기열', cls: 'warn', title: 'AI가 가져가길 기다리는 중' };
    case 'working': {
      const who = handlerName(r);
      return { label: '처리 중', cls: 'warn', title: who ? `${who} 처리 중${claim?.expires ? ` · ${fmtShort(claim.expires)}까지 맡음` : ''}` : '처리 중', who };
    }
    case 'done': { const who = handlerName(r); return { label: '완료', cls: 'ok', title: who ? `${who} 처리` : '완료' }; }
    case 'failed': return { label: '실패', cls: 'bad', title: r.error || '실패' };
    case 'cancelled': return { label: '취소됨', cls: '', title: '취소됨' };
    default: return { label: STATUS_LABEL[r.status] || r.status || '', cls: '', title: '' };
  }
}
/**
 * 요청을 맡은(맡을) 작업 환경 이름(util.agentEnvName·serverEnvName) — 서버 경로는 내 AI 키 환경 이름 또는 'AI'
 * (중앙 공용 서버 AI·모의 AI 의 이름은 참여자 화면에 드러내지 않는다), 에이전트는 환경 이름(모르는 이름·사람 이름은 그대로)
 */
export function handlerName(r) {
  if (!r) return '';
  const server = !!r.claim?.server || (!r.claim?.agent && !r.delivery && r.route === 'server');
  if (server) return r.handledBy || r.claim ? serverEnvName(r.handledBy) : '';
  const raw = r.claim?.agent || r.handledBy || r.delivery?.agent || '';
  return agentEnvName(raw) || raw;
}
/** (옛) 요청 경로 칩: 받은 작업 환경 이름(Claude Code·Codex·API …) / 대기열 — 새 화면은 상태 칩 title(requestBadge) */
export function routeChip(d, r) {
  if (!r?.route) return null;
  if (r.route === 'agent') {
    const env = agentEnvName(r.delivery?.agent || r.claim?.agent || r.handledBy) || '연결된 AI';
    return { label: isMeName(d, r.by) ? env : `${clip(r.by, 8)}의 ${env}`, cls: 'agent' };
  }
  if (r.route === 'server') return { label: serverEnvName(r.handledBy), cls: 'server' };
  if (r.route === 'queue') return { label: '대기열', cls: 'queue' };
  if (r.route === 'example') return { label: '예시 답변', cls: 'server' };
  return { label: r.route, cls: '' };
}

/** 내 에이전트(채널) 상태: { online, agent } — store 의 agentMe(GET /api/agent/status + WS 'agent') */
export function myAgent(d) {
  const am = d?.s?.agentMe;
  const ss = Array.isArray(am?.sessions) ? am.sessions.filter((x) => x && x.channel) : [];
  const online = !!am?.online;
  const last = ss[ss.length - 1];   // 서버는 가장 최근 채널 세션에 알린다(sessions 는 붙은 순)
  const fromMap = (d?.s?.agents?.[meName(d)] || []).filter((x) => x && x.channel !== false);
  return { online, agent: last?.agent || fromMap[fromMap.length - 1]?.agent || 'Claude Code' };
}
/** 고른 길(want: auto|agent|server|queue|example) → 실제로 갈 길(서버 routeRequest·_usableRoute 와 같은 규칙). ownAi = 튜토리얼 6(연결이 없으면 예시 답변) */
export function effectiveRoute(want, agentOnline, aiOn, ownAi = false) {
  if (ownAi) return 'example';   // 튜토리얼 6 — 늘 준비된 예시 답변(2026-11-04)
  if (want === 'agent') return agentOnline ? 'agent' : 'queue';
  if (want === 'server') return aiOn ? 'server' : 'queue';
  if (want === 'queue') return 'queue';
  return agentOnline ? 'agent' : aiOn ? 'server' : 'queue';
}
/**
 * [다시]·[다시 요청] title: 처음 고른 길(routeWanted, 없으면 자동 — 서버 retryRequest 와 같은 규칙)로 어디에 다시 가는가.
 * 'Claude Code로 다시 보냅니다'·'대기열에 다시 넣습니다'(단추는 AI 보라 ai-send — docs/UI_TERMS.md §4)
 */
export function retryTip(d, r) {
  const agent = myAgent(d);
  const env = docWorkEnv(d?.s, { agentName: agent.agent });
  const route = effectiveRoute(r?.routeWanted || 'auto', agent.online, env.serverOn, env.ownAi);
  const name = route === 'agent' ? env.agent : route === 'server' ? env.server : route === 'example' ? '예시 답변' : '';
  return name ? `같은 요청을 ${josa(name, '으로/로')} 다시 보냅니다` : '같은 요청을 대기열에 다시 넣습니다';
}
/** 남의 에이전트(채널) 붙음: d.s.agents { 이름: [{ agent, channel }] } */
export function agentOf(d, name) {
  const list = (d?.s?.agents?.[name] || []).filter((x) => x && x.channel !== false);
  return list.length ? list[list.length - 1].agent || 'AI' : null;
}

/** 제안을 내 수정본에 반영(편집기 applyText/insertParagraphAfter + /adopt) — 실패 이유를 알림으로 */
const ADOPT_FAIL = {
  NOT_FOUND: '내 수정본에서 원문을 찾지 못했습니다(이미 고쳤거나 문단이 바뀌었을 수 있음)',
  NO_PARAGRAPH: '그 문단을 내 수정본에서 찾지 못했습니다(표 구조가 바뀌었을 수 있음)',
  READONLY: '편집기가 읽기 전용이라 반영하지 못했습니다',
  NO_EDITOR: '편집기를 여는 중입니다 — 잠시 뒤 다시 누르세요',
};
// store 의 adoptProposal 이 결과(성공·실패 이유)를 알림으로 띄운다 — 여기서는 던진 오류만 알린다
export async function adoptWith(d, p) {
  if (!editorOf(d)) { toast(ADOPT_FAIL.NO_EDITOR); return { ok: false, reason: 'NO_EDITOR' }; }
  try { return (await d.adoptProposal(p)) || { ok: true }; } catch (e) { toastError(e, `제안 #${p.pid}: `); return { ok: false, reason: 'ERROR', message: e.message }; }
}
/**
 * 내가 내 수정본에 반영해 둔 제안이 지금도 편집기 글에 들어 있나('반영됨' 알약 — 아니면 [반영] 단추).
 * 편집기(web/editor.js adoptedNow)·store.adoptProposal 과 같은 규칙: 서버 기록(사람마다 p.adoptedBy[이름], 옛 자료는 p.adopted = { by, at, cid })이
 * 나(store d.adoptedByMe — 끝난 변경 요청의 옛 기록은 뺀다)이고, 그 문단이 지금 내 수정본에서 바뀌어 있음(d.s.draft = 플러그인 'draft').
 * 편집기에서 Ctrl+Z 로 되돌려 그 문단이 기준과 같아지면 서버 기록이 남아 있어도 다시 단추를 준다(편집기 강조·우클릭 메뉴와 같게)
 */
export function adoptedByMe(d, p) {
  const me = meName(d);
  const mine = typeof d?.adoptedByMe === 'function' ? !!d.adoptedByMe(p)
    : !!adoptionRecord(p, me);
  return mine && (!!formatAdoptionOf(p, me) || adoptionInEffect(p, d?.s?.draft));
}

// ───────── 열린 입력 칸(답글·고치기·의견·지우기 확인)과 쓰던 글 — 문서 store(d.s.cardUi)에 둔다 ─────────
// 카드가 화면에서 빠졌다 돌아와도(편집기 스크롤·다시 열기), 덩어리 hid 가 바뀌어도, 탭을 옮겨도 칸과 글이 남는다.
// 열쇠: 'rail:<항목>'·'list:<항목>'(검토 레일·검토 탭 카드), 'crc:<cid>:<덩어리>'(변경 요청 의견), 'crt:<cid>:<tid>'(스레드 답글) …
// 칸 = { mode, text, busy, focus } — focus 는 막 연 칸만 커서를 가져가게(다시 그려질 때는 안 가져간다)
/** 이 문서의 칸 지도(없으면 만든다 — setup·동작에서 부른다. computed 안에서는 d.s.cardUi?.[열쇠] 로 읽기만) */
export function uiSlots(d) {
  if (!d?.s) return {};
  if (!d.s.cardUi || typeof d.s.cardUi !== 'object') d.s.cardUi = {};
  return d.s.cardUi;
}
export const uiSlot = (d, key) => d?.s?.cardUi?.[key] || null;
/** 칸 열기(이미 열려 있으면 그대로 — 쓰던 글을 지우지 않는다) */
export function openSlot(d, key, mode, extra = {}) {
  const m = uiSlots(d);
  const cur = m[key];
  if (cur && cur.mode === mode) { cur.focus = true; } else m[key] = { mode, text: '', busy: false, focus: true, ...extra };
  // 그 칸이 그려진 뒤(다음 틱)에는 다시 그려져도 커서를 가져가지 않게
  nextTick(() => { const x = d.s.cardUi?.[key]; if (x) x.focus = false; });
  return m[key];
}
export function closeSlot(d, key) { const m = d?.s?.cardUi; if (m && key in m) delete m[key]; }
/**
 * 칸의 동작 하나(보내기·저장·지우기): 이미 보내는 중이면 무시(Ctrl+Enter 두 번 등), 잘 끝나면 칸을 닫는다.
 * 카드가 그사이 화면에서 빠져도 열쇠로 칸을 찾아 닫는다. → { ok, v }
 */
export async function runSlot(d, key, fn, { close = true, errPrefix = '' } = {}) {
  const sl = uiSlot(d, key);
  if (sl?.busy) return { ok: false, busy: true };
  if (sl) sl.busy = true;
  try {
    const v = await fn();
    // 보내는 사이 칸을 닫았다 새로 열었으면(다른 칸) 그 새 칸은 두고
    if (close && (!sl || uiSlot(d, key) === sl)) closeSlot(d, key);
    return { ok: true, v };
  } catch (e) { toastError(e, errPrefix); return { ok: false, error: e }; }
  finally { const cur = uiSlot(d, key); if (cur) cur.busy = false; }
}

/** 메모 답글·완료(store 의 d.replyMemo·d.resolveMemo — 알림도 store 가 띄운다) */
export const replyMemoWith = (d, m, text) => d.replyMemo(m, text);
/** 'AI에게 요청하기' 단추를 보일 메모인가: AI 의견·AI 작업 기록·AI 제안 메모·사람 메모(수정 권한이 있을 때) → 단추 글('ChatGPT에게 요청' 등) | '' */
export function askAiLabel(d, m) {
  if (!m || d?.s?.canEdit === false) return '';
  const l = m.link;
  // 사람 메모(연결 없음)도 그 메모대로 AI 에게 맡길 수 있다(2026-10-31 — 체험 '메모에 답글로 AI 에게 맡기기')
  if (!l) return 'AI에게 요청';
  if (!['comment', 'request', 'proposal'].includes(l.type)) return '';
  const rid = l.rid ?? (l.type === 'proposal' ? d.proposal?.(l.pid)?.rid : null);
  const r = rid != null ? d.request?.(rid) : null;
  const who = r?.handledBy && !/^(대기열|AI)$/.test(r.handledBy) ? r.handledBy : '';
  return who ? `${clip(who, 14)}에게 요청` : 'AI에게 요청';
}
export const ASK_AI_TIP = '이 답장을 그 AI 에게 이어서 맡깁니다(새 AI 작업) — 메모에 답글로도 남습니다';
export const askAiWith = (d, m, text) => d.askAiFromMemo(m, text);
export const resolveMemoWith = (d, m, resolved) => d.resolveMemo(m, resolved);

// ───────── 그 자리 확인 줄(window.confirm 대신) ─────────
export const InlineConfirm = {
  props: { message: String, okLabel: { type: String, default: '확인' }, danger: Boolean, busy: Boolean },
  emits: ['ok', 'cancel'],
  template: `<div class="confirm-row" role="alertdialog" :aria-label="message" @keydown.esc.stop.prevent="$emit('cancel')" @click.stop>
    <span class="cf-msg">{{ message }}</span><span class="spacer"></span>
    <button class="small" ref="cancelBtn" @click.stop="$emit('cancel')">취소</button>
    <button class="small" :class="danger ? 'danger' : 'primary'" :disabled="busy" @click.stop="$emit('ok')"><span v-if="busy" class="spin dark"></span>{{ okLabel }}</button></div>`,
  setup() { const cancelBtn = ref(null); onMounted(() => cancelBtn.value?.focus({ preventScroll: true })); return { cancelBtn }; },
};

// ───────── AI 작업 진행 줄·단추(docs/V3_SPEC.md §9.7) — 레일 카드·검토 탭 카드·AI 작업 탭 카드·결과 창 위가 같이 쓴다 ─────────
// 진행 줄 '제안 16건 — 반영 3 · 거절 1 · 남음 12'(내 눈의 진행 — store d.progress), 남음이 있으면 요청자·관리자에게
// [모두 반영 (n)](남은 바꿈·문단 추가를 편집기에 한 번에 — Ctrl+Z 한 번) · [문서에 바로 적용 (n)](관리자·allowDirectApply) · [남은 n건 거절](그 자리 확인 줄),
// 여러 안 묶음만 남았으면 '안 고르기', 그리고 [하나씩 보기](AI 작업 탭 결과 — 결과 창·AI 작업 탭 카드에서는 없음). 남의 요청이면 진행 줄과 [하나씩 보기]만.
// 끝나면 '반영 14 · 거절 2' 한 줄(없으면 '의견 n'·'고칠 곳 없음', 취소면 줄 없음) — 이 줄을 쓰는 곳(레일·검토 탭 카드·AI 작업 탭 카드·결과 창)은 모두
// 머리에 상태 칩(requestBadge)이 있어 '완료'·'취소됨'은 칩이 한 번만 말한다(UI_TERMS §1-2).
// 실패한 요청은 [다시 요청](레일·검토 탭 카드에서 — 결과 창·AI 작업 탭 카드는 제 [다시]가 있다)
export const RequestActions = {
  components: { InlineConfirm },
  props: { rid: Number, place: { type: String, default: 'rail' } },
  template: `<div class="req-actions" v-if="r && g && (g.items || (g.resolved && doneText) || retryable)" :class="['ra-' + place, { done: g.resolved }]" :data-rid="rid">
    <div class="ra-done" v-if="g.resolved">{{ doneText }}</div>
    <template v-else>
      <div class="ra-line" v-if="g.items">{{ line }}</div>
      <InlineConfirm v-if="asking" :message="'AI 작업 #' + rid + '의 남은 ' + g.open + '건을 거절할까요?'" ok-label="거절" danger :busy="busy === 'reject'" @ok="reject" @cancel="asking=false"/>
      <div class="ra-btns" v-else-if="g.open > 0">
        <template v-if="bulk">
          <button v-if="adoptable" class="small primary ra-adopt" :disabled="!!busy" :title="live ? '남은 제안을 공유 문서에 바로 반영합니다(모두에게 보임 — 되돌리기는 하나씩)' : hasFormats ? '서식 제안을 차례로 저장·반영합니다(서식 되돌리기는 제안마다)' : '남은 제안을 내 수정본에 한 번에 넣습니다 — 되돌리기는 편집기에서 Ctrl+Z 한 번'" @click="run('adopt')"><span v-if="busy==='adopt'" class="spin"></span>모두 반영 ({{ adoptable }})</button>
          <span v-else-if="g.openAlt" class="muted ra-pick" :title="oneByOne ? '여러 안은 [하나씩 보기]에서 하나를 골라 반영합니다' : '여러 안 중 하나를 골라 반영합니다'">안 고르기</span>
          <button v-if="direct && g.openPids.length" class="small ra-apply" :disabled="!!busy" title="공유 문서에 바로 적용합니다(변경 추적) — 남은 표 제안도" @click="run('apply')"><span v-if="busy==='apply'" class="spin dark"></span>문서에 바로 적용 ({{ g.open - g.openAlt }})</button>
          <button class="small ra-reject" :disabled="!!busy" @click="asking=true">남은 {{ g.open }}건 거절</button>
        </template>
        <button v-if="oneByOne" class="small ra-one" @click="showOne">하나씩 보기</button>
      </div>
    </template>
    <div class="ra-btns" v-if="retryable"><button class="small ai-send ra-retry" :disabled="!!busy" :title="retryTip(d, r)" @click="retry"><span v-if="busy==='retry'" class="spin dark"></span>다시 요청</button></div>
    <div class="ra-btns" v-if="recoverable"><button class="small ai-send ra-recover" :disabled="!!busy" title="현재 문서를 읽고 남은 의도만 새 AI 작업으로 다시 검토합니다. 새 제안이 나오면 이전 제안은 기록에 보관합니다." @click="recover"><span v-if="busy==='recover'" class="spin dark"></span>남은 제안 다시 요청</button></div>
  </div>`,
  setup(props) {
    const d = inject('doc');
    const busy = ref(''); const asking = ref(false);
    const r = computed(() => (typeof d?.request === 'function' ? d.request(props.rid) : null));
    const g = computed(() => (r.value && typeof d.progress === 'function' ? d.progress(r.value) : null));
    const bulk = computed(() => (typeof d.canResolve === 'function' ? d.canResolve(r.value) : !!r.value && (r.value.by === meName(d) || isAdmin())));
    // v0.4 실시간 문서(§4.2): [모두 반영] = 공유 문서에 바로(표 제안 포함 — 서버 resolve { apply }), [문서에 바로 적용]은 같은 것이라 없다
    const live = computed(() => isRealtimeDoc(d));
    const direct = computed(() => !live.value && canDirectApply());
    // 단추의 n 은 남은 항목 수(진행 줄 '남음'과 같은 셈 — 묶음 제안은 하나, docs/UI_TERMS.md §9): 실시간 문서는 여러 안이 아닌 남은 항목 모두, 아니면 수정본에 넣을 바꿈·문단 추가가 있는 항목
    const adoptable = computed(() => (g.value ? Math.max(0, live.value ? g.value.open - g.value.openAlt : g.value.adoptOpen ?? g.value.openPids.length - g.value.tables) : 0));
    const hasFormats = computed(() => (g.value?.openPids || []).some(pid => isRichProposal(d.proposal(pid))));
    const line = computed(() => progressText(g.value));
    // 상태 칩이 머리에 있으므로 '✓ 완료'·'취소됨' 없이 수만
    const doneText = computed(() => resolvedText(g.value, r.value, { head: false }));
    const oneByOne = computed(() => props.place !== 'result' && props.place !== 'ai');
    // 튜토리얼 6(늘 예시 답변): 다시 요청할 곳이 없어 [다시 요청]·[남은 제안 다시 요청]을 숨긴다(2026-11-04)
    const practice = computed(() => !!d?.s?.info?.tutorialOwnAi);
    const retryable = computed(() => !practice.value && r.value?.status === 'failed' && (props.place === 'rail' || props.place === 'list') && bulk.value);
    const recoverable = computed(() => !practice.value && bulk.value && g.value?.open > 0 && ['done', 'failed', 'cancelled'].includes(r.value?.status));
    // 남은 것이 없어지면(다른 곳에서 정함) 확인 줄을 닫는다
    watch(() => g.value?.open || 0, (n) => { if (!n) asking.value = false; });
    async function run(mode) {
      if (busy.value || !r.value) return;
      busy.value = mode;
      try { await d.resolveRequest(r.value, mode); } catch (e) { toastError(e, `AI 작업 #${props.rid}: `); } finally { busy.value = ''; }
    }
    async function reject() { await run('reject'); asking.value = false; }
    function showOne() { d.s.activeRid = props.rid; d.s.tab = 'ai'; callPanel(d); }
    async function retry() {
      if (busy.value || !r.value) return;
      busy.value = 'retry';
      try { await d.retryRequest(r.value); } catch (e) { toastError(e, '다시 요청 실패: '); } finally { busy.value = ''; }
    }
    async function recover() {
      if (busy.value || !r.value) return;
      busy.value = 'recover';
      try { await d.recoverRequest(r.value); } catch (e) { toastError(e, '남은 제안 재검토 실패: '); } finally { busy.value = ''; }
    }
    return { d, r, g, bulk, live, direct, adoptable, hasFormats, line, doneText, oneByOne, retryable, recoverable, busy, asking, run, reject, showOne, retry, recover, retryTip };
  },
};
ResultView.components.RequestActions = RequestActions;
BundleItem.components.InlineConfirm = InlineConfirm;

// ───────── AI 작업 진행 기록(server/activity.js) ─────────
// AI 가 요청을 처리하며 부른 도구를 한 줄씩(문서 읽기 → 검색 → 수정 제안 20건 → 의견 → 완료). 처리 중에는 맨 위에 '지금' 한 줄
// (마지막 단계 → 생각 중 n초 — 도구 호출 사이에 AI 가 생각하거나 글을 쓰는 동안은 서버가 그 내용을 볼 수 없어 시간만 보인다),
// [작업 기록 n]을 펼치면 채팅처럼 차례대로. 같은 단계가 이어지면 한 줄로 묶는다(의견 남김 ×8). 줄 사이 +n초 = 그 단계 전에 생각·작성한 시간.
// place 'rail'(본문 옆 카드)은 처리 중일 때만 보이고 접혀 있다. 'ai'(AI 작업 탭)는 끝난 뒤에도 남고 처리 중에는 펼쳐 둔다.
const ACTIVITY_THINK_TIP = '도구를 부르는 사이에는 AI 가 생각하거나 글을 쓰고 있습니다. 그 내용은 서버가 볼 수 없어 시간만 보입니다';
export const RequestActivity = {
  props: { rid: Number, place: { type: String, default: 'ai' } },
  template: `<div class="req-activity" v-if="show" :class="['rq-' + place, { running }]" :data-rid="rid">
    <div class="rq-now" v-if="running" :title="THINK_TIP"><span class="spin dark"></span><span class="rq-now-label">{{ nowLabel }}</span><span class="rq-now-time muted" v-if="waitText">{{ waitText }}</span></div>
    <details class="rq-log" v-if="rows.length" :open="open" @toggle="open = $event.target.open">
      <summary>작업 기록 {{ items.length }}<span class="muted rq-total" v-if="totalText"> · {{ totalText }}</span></summary>
      <ol class="rq-chat"><li v-for="row in rows" :key="row.n" :class="{ fail: row.ok === false }">
        <span class="rq-t">{{ row.time }}</span><span class="rq-l">{{ row.label }}<b v-if="row.count > 1"> ×{{ row.count }}</b></span><span class="rq-gap muted" v-if="row.gap" :title="THINK_TIP">{{ row.gap }}</span></li></ol>
    </details></div>`,
  setup(props) {
    const d = inject('doc');
    const r = computed(() => (typeof d?.request === 'function' ? d.request(props.rid) : null));
    const running = computed(() => r.value?.status === 'working');
    const items = computed(() => d?.s?.activity?.[props.rid] || []);
    const rows = computed(() => activityRows(items.value));
    const show = computed(() => (props.place === 'rail' ? running.value : running.value || rows.value.length > 0));
    const open = ref(props.place !== 'rail' && running.value);
    // 처리 중이거나 방금(30분 안) 끝난 요청만 서버에서 읽는다 — 그 뒤 줄은 WebSocket 으로 온다(오래된 요청마다 묻지 않는다)
    const recent = () => { const x = r.value; return !!x && (x.status === 'working' || (x.doneAt && Date.now() - new Date(x.doneAt).getTime() < 30 * 60 * 1000)); };
    const load = () => { if (recent() && typeof d?.loadActivity === 'function') d.loadActivity(props.rid); };
    onMounted(load);
    // 처리 중에는 펼쳐 두고 끝나면 접는다(누르면 다시 펼침 — docs/UI_TERMS.md §7). 예전에는 끝나도 펼친 채였고 다시 열어야 접혔다(2026-11-16)
    watch(running, (on) => { if (on) load(); if (props.place !== 'rail') open.value = on; });
    // 처리 중에만 1초마다 다시 그린다('생각 중 n초')
    const now = ref(Date.now()); let timer = null;
    const tick = (on) => { if (on && !timer) timer = setInterval(() => { now.value = Date.now(); }, 1000); else if (!on && timer) { clearInterval(timer); timer = null; } };
    watch(running, tick, { immediate: true });
    onBeforeUnmount(() => tick(false));
    const lastItem = computed(() => items.value[items.value.length - 1] || null);
    const nowLabel = computed(() => (lastItem.value ? lastItem.value.label : '처리 중'));
    const waitText = computed(() => {
      const from = lastItem.value ? new Date(lastItem.value.at).getTime() : NaN;
      return Number.isFinite(from) && now.value - from >= 3000 ? `→ 생각 중 ${secText(now.value - from)}` : '';
    });
    const totalText = computed(() => {
      const a = items.value[0]; const b = lastItem.value;
      return !running.value && a && b && b !== a ? secText(new Date(b.at).getTime() - (new Date(a.at).getTime() - (Number(a.ms) || 0))) : '';
    });
    return { running, items, rows, show, open, nowLabel, waitText, totalText, THINK_TIP: ACTIVITY_THINK_TIP };
  },
};

// ───────── 스레드(답글 목록 + 완료 표시) — 메모 카드·변경 요청 의견이 같이 쓴다 ─────────
export const ThreadList = {
  props: { replies: Array, resolved: Object, max: { type: Number, default: 0 }, dense: Boolean },
  template: `<div class="thread" v-if="(replies && replies.length) || resolved">
    <button v-if="hidden > 0" class="linkish" @click.stop="all=true">답글 {{ hidden }}개 더 보기</button>
    <div class="th-reply" v-for="(r, i) in shown" :key="i"><span class="th-by" :style="{color: color(r.by)}">↳ {{ r.by }}</span><span class="muted"> {{ fmtShort(r.at) }}</span><div class="th-text pre">{{ r.text }}</div></div>
    <div class="th-resolved" v-if="resolved">✓ 완료 · {{ resolved.by }} <span class="muted">{{ fmtShort(resolved.at) }}</span></div></div>`,
  setup(props) {
    const d = inject('doc', null); const all = ref(false);
    const list = computed(() => props.replies || []);
    const hidden = computed(() => (props.max && !all.value ? Math.max(0, list.value.length - props.max) : 0));
    const shown = computed(() => (hidden.value ? list.value.slice(-props.max) : list.value));
    return { all, hidden, shown, fmtShort, color: (n) => colorOf(d, n) };
  },
};
