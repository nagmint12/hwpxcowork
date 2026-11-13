// 문서 옆 메모(검토 레일 — 칸을 따로 두지 않고 편집기 쪽 오른쪽 여백 위에 겹쳐, 한/글 메모처럼: app.js·docs/V4_SPEC.md §5) — docs/V3_SPEC.md §5.1.
// 플러그인 anchors(보이는 쪽의 강조 자리, iframe client y)에 카드를 띄운다: 겹치면 8px 간격으로 쌓고(v0.2 말풍선 규칙),
// 고른(또는 마우스를 올린) 카드는 자기 자리에 두고 위·아래 카드를 밀어낸다. 머리 줄을 끌면 그 메모만 어디로든 옮긴다(이 브라우저에 기억).
// 화면 글에서는 '카드'·'레일' 대신 '메모'(문서 옆 메모)라고 부른다(docs/UI_TERMS.md).
// 카드 종류: 메모(사람·AI 의견·지난 제안 메모) · AI 작업 · 제안(대기, 여러 안은 한 카드) · 남의 수정 중(덩어리마다).
// 같은 카드를 패널 '검토' 탭(panels.js)이 문서 순서 목록으로 쓴다 — reviewItems(d) 가 둘의 자료.
// hover ↔ 편집기 강조(setActive), 누르기 → 편집기 그 자리(focusRange + 깜빡임).
// 카드의 입력 칸(답글·고치기·의견·지우기 확인)과 쓰던 글은 문서 store(d.s.cardUi, ui.js slot 도우미)에 둔다 —
// 강조 자리가 보이는 쪽 밖으로 나가 카드가 빠져도, 편집기를 다시 열어도, 남의 수정 중 hid 가 바뀌어도 남는다.
// 입력 칸이 열린 카드는 강조 자리가 없어도(화면 밖) 레일에 남기고 레일 안(위·아래 끝)에 붙여 둔다.
// 보이는 글은 이름표만(docs/UI_TERMS.md): 상태는 칩 하나, 종류·보낸 곳·시각 같은 설명은 title, '해결' → '완료', '기준' → '문서'.
import { ref, computed, watch, inject, onMounted, onBeforeUnmount, nextTick, shallowRef } from '/vendor/vue.esm-browser.prod.js';
import { toast, toastError, fmtShort, clip, kindLabel, presetLabel, adopterNames, tocNote, deleteNote } from './util.js';
import {
  MemoEditor, TablePreview, FormatPreview, InlineConfirm, ThreadList, RequestActions, RequestActivity, focusIn, setActiveAnn, setHoverAnn, openCr, requestBadge, requestPhase, isMeName, colorOf, meName,
  canDirectApply, adoptWith, adoptedByMe, replyMemoWith, resolveMemoWith, askAiLabel, askAiWith, ASK_AI_TIP, cmpRef, editorOf, uiSlots, openSlot, closeSlot, runSlot, callPanel,
} from './ui.js';
import { CollabHost, hunkHtml, hunkBadge, hunkKeys, rememberHunks, hunkKeyFor, threadsByHunk, addHunkThread } from './crs.js';
import { diffHtml } from './diff.js';
import { ICON } from './icons.js';
import { paragraphGeo, memoRange, proposalRange } from './annotations.js';
import { summaryHead, summaryChip, memoWidth, memoLeft, freeBox, readMemoPos, writeMemoPos } from './view.js';
import { formatAdoptionOf } from './formatting.js';

/** collab.css 를 한 번만 붙인다(index.html 이 이미 붙였으면 그대로) */
export function ensureCollabCss() {
  if (typeof document === 'undefined' || document.querySelector('link[data-collab-css], link[href$="collab.css"]')) return;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/collab.css'; l.dataset.collabCss = '1';
  document.head.appendChild(l);
}
ensureCollabCss();

const GAP = 8;
const KIND_ORDER = { memo: 0, request: 1, proposal: 2, draft: 3 };
// 입력 칸 때문에 레일에 남은 카드의 강조 자리 표시(위·아래 끝에 붙임 / 보이는 쪽 밖)
const EDGE_MARK = { up: '↑', down: '↓', off: '↕' };
const EDGE_TIP = { up: '자리가 위쪽에 있음 — 누르면 이동', down: '자리가 아래쪽에 있음 — 누르면 이동', off: '자리가 보이는 쪽 밖에 있음 — 누르면 이동' };
const geoCache = new WeakMap();
/** 기준 문단 목록 → geo(범위 계산용, 같은 배열이면 다시 만들지 않음) */
function geoOf(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  let g = geoCache.get(list);
  if (!g) { g = paragraphGeo(list); geoCache.set(list, g); }
  return g;
}

/**
 * 검토 항목(레일 카드·검토 탭 목록의 자료) — 문서 순서.
 * { key, kind: memo|request|proposal|draft, anchorKind, id(플러그인 anchor id), ids?(제안 묶음 pid들), ref, range{ref,start?,end?,endRef?},
 *   memo?, rid?, proposals?, cr?, hunk?, hkey?, resolved, cat: memo|ai|proposal|draft }
 * - 대기 중인 제안의 메모는 그 제안 카드가 대신한다(플러그인 강조와 같은 규칙). 여러 안(gid)은 한 카드.
 * - 남의 수정 중: draft·open 변경 요청(내 것 빼고)의 덩어리마다(사라진 덩어리 빼고).
 *   key 는 덩어리 열쇠(종류 + 기준 자리, crs.js hunkKeys) — 작성자가 자동 저장해 hid 가 바뀌어도 같은 카드.
 *   id 는 플러그인 강조 id 'cid:hid'(지금 hid).
 * - 완료(resolved — 검토 탭 '완료' 거르기, 레일은 강조가 숨어 카드도 없다): 메모 = 스레드 해결, AI 작업 = 메모 스레드 해결 또는
 *   내 눈의 진행이 해결(§9.7 — 요청이 끝났고 남은 제안이 없음, 메모 없는 요청도), 제안 = 내 눈으로 반영됨(내가 반영해 두고 편집기 글에
 *   들어 있음·남이 반영해 둠 — store proposalDone)
 */
export function reviewItems(d) {
  const s = d.s; const out = [];
  const memos = s.memos || []; const proposals = s.proposals || [];
  const geo = geoOf(s.paragraphs);
  const memosById = new Map(memos.map((m) => [m.id, m]));
  const pending = new Set(proposals.filter((p) => p.status === 'pending').map((p) => Number(p.pid)));
  const reqWithMemo = new Set();
  // 요청마다 내 눈의 진행(한 번만 센다)
  const progs = new Map();
  const reqDone = (rid) => {
    const k = Number(rid);
    if (!progs.has(k)) { let g = null; try { g = typeof d.progress === 'function' ? d.progress(k) : null; } catch { g = null; } progs.set(k, g); }
    return !!progs.get(k)?.resolved;
  };
  // v0.4 보기(§4.1·§5): '간단히'에서 남의 AI 작업은 한 줄 요약 카드(summary)만 — 그 제안 카드는 없다(d.requestHidden·proposalHidden)
  const hidden = (rid) => { try { return typeof d.requestHidden === 'function' && !!d.requestHidden(d.request?.(rid)); } catch { return false; } };
  for (const m of memos) {
    const t = m.link?.type;
    if (t === 'proposal' && pending.has(Number(m.link.pid))) continue;
    let range;
    try { range = memoRange(m, geo); } catch { range = { ref: m.ref, start: m.start || 0, end: m.end ?? undefined }; }
    const resolved = !!(m.thread?.resolved || m.resolved);
    if (t === 'request') {
      reqWithMemo.add(Number(m.link.rid));
      // 요청 메모의 해결 = 요청 해결(내 눈의 진행)만 — 옛 스레드 해결 표시(v0.3.0 [해결])는 보지 않는다(다시 열린 요청이 숨지 않게)
      out.push({ key: `request:${m.id}`, kind: 'request', anchorKind: 'request', id: String(m.id), ref: m.ref, range, memo: m, rid: Number(m.link.rid), resolved: typeof d.progress === 'function' ? reqDone(m.link.rid) : resolved, cat: 'ai', summary: hidden(m.link.rid) });
    } else {
      out.push({ key: `memo:${m.id}`, kind: 'memo', anchorKind: 'memo', id: String(m.id), ref: m.ref, range, memo: m, resolved, cat: t === 'comment' ? 'ai' : 'memo' });
    }
  }
  // 메모가 없는 요청(메모를 지운 경우 등) — 레일 자리는 없고 목록에만
  for (const r of s.requests || []) {
    if (reqWithMemo.has(Number(r.rid)) || !r.target?.ref) continue;
    out.push({ key: `request:r${r.rid}`, kind: 'request', anchorKind: 'request', id: null, ref: r.target.ref, range: { ref: r.target.ref, start: r.target.start ?? 0, end: r.target.end ?? undefined }, rid: Number(r.rid), resolved: reqDone(r.rid), cat: 'ai', summary: hidden(r.rid) });
  }
  const propDone = (p) => { try { return typeof d.proposalDone === 'function' && !!d.proposalDone(p); } catch { return false; } };
  const propHidden = (p) => { try { return typeof d.proposalHidden === 'function' && !!d.proposalHidden(p); } catch { return false; } };
  const groups = new Map();
  for (const p of proposals) {
    if (p.status !== 'pending' || propHidden(p)) continue;
    const gk = p.gid != null ? `g${p.gid}` : `p${p.pid}`;
    let g = groups.get(gk);
    if (!g) {
      const type = p.type || 'replace';
      const isRange = type === 'replace' || type === 'format';
      const ref = isRange ? p.ref : (p.afterRef || p.ref);
      let range = { ref };
      if (isRange) { try { range = proposalRange(p, memosById, geo) || { ref, start: p.start ?? 0, end: p.end ?? undefined }; } catch { range = { ref }; } }
      g = { key: `proposal:${gk}`, kind: 'proposal', anchorKind: 'proposal', id: String(p.pid), ids: [], ref, range, proposals: [], resolved: false, cat: 'proposal', after: !isRange };
      groups.set(gk, g); out.push(g);
    }
    g.proposals.push(p); g.ids.push(String(p.pid));
    if (propDone(p)) g.resolved = true;   // 여러 안 묶음은 한 안이 반영이면 그 묶음이 정해진 것
  }
  for (const g of groups.values()) g.proposals.sort((a, b) => (a.option || 0) - (b.option || 0) || a.pid - b.pid);
  // '간단히'(§5): 남의 '수정 중' 덩어리는 변경 요청마다 한 줄('✎ 김검토 수정 중 · 3문단 [보기]') — 그 변경 요청의 첫 덩어리 자리에 하나
  const collapse = typeof d.collapseDrafts === 'function' && !!d.collapseDrafts();
  for (const cr of s.crs || []) {
    if (!cr || !(cr.status === 'draft' || cr.status === 'open') || isMeName(d, cr.author)) continue;
    const hunks = Array.isArray(cr.hunks) ? cr.hunks : [];
    const keys = rememberHunks(d, cr.cid, hunks, hunkKeys(hunks));
    if (collapse) {
      const live = hunks.map((h, i) => ({ h, i, ref: h && h.state !== 'gone' ? (h.curRef ?? (h.type === 'insert' ? h.afterRef : h.ref)) : null })).filter((x) => x.ref);
      if (!live.length) continue;
      const f = live[0];
      out.push({ key: `draftcr:${cr.cid}`, kind: 'draft', anchorKind: 'draft', collapsed: true, id: `${cr.cid}:${f.h.hid}`, hids: live.map((x) => String(x.h.hid)), ref: f.ref, range: { ref: f.ref }, cr, hunk: f.h, hkey: keys[f.i], count: live.length, resolved: false, cat: 'draft', after: f.h.type === 'insert' });
      continue;
    }
    hunks.forEach((h, i) => {
      if (!h || h.state === 'gone') return;
      const ref = h.curRef ?? (h.type === 'insert' ? h.afterRef : h.ref);
      if (!ref) return;
      out.push({ key: `draft:${cr.cid}:${keys[i]}`, hkey: keys[i], kind: 'draft', anchorKind: 'draft', id: `${cr.cid}:${h.hid}`, ref, range: { ref }, cr, hunk: h, resolved: false, cat: 'draft', after: h.type === 'insert' });
    });
  }
  const at = (it) => (it.after ? Number.MAX_SAFE_INTEGER : (it.range?.start ?? 0));
  out.sort((a, b) => cmpRef(a.ref, b.ref) || at(a) - at(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return out;
}
/** 플러그인 anchor({ kind, id }) → 검토 항목 지도 */
export function anchorIndex(items) {
  const m = new Map();
  for (const it of items) {
    if (it.kind === 'proposal') for (const id of it.ids) m.set(`proposal:${id}`, it);
    // 한 줄로 접은 남의 수정 중(간단히): 그 변경 요청의 모든 덩어리 강조가 이 카드 하나로(처음 자리에 하나만 그린다 — 레일 cards)
    else if (it.kind === 'draft' && it.collapsed) for (const hid of it.hids || []) m.set(`draft:${it.cr.cid}:${hid}`, it);
    else if (it.id != null) m.set(`${it.anchorKind}:${it.id}`, it);
  }
  return m;
}
const annOf = (it) => (it && it.id != null ? { kind: it.anchorKind, id: it.id } : null);
/** 카드에서 입력 칸을 열면 그 카드를 고른다(편집기 강조 + 레일 고정 — 칸을 닫을 때까지 그 카드가 자리 잡기 기준) */
function selectItem(d, it) { const a = annOf(it); if (a) setActiveAnn(d, a); }
/** 수정 중 강조 값 → { cid, hid }(플러그인은 id 'cid:hid', 셸의 '변경 보기'는 id = cid 에 hid 따로) */
function draftParts(a) { const [c0, h0] = String(a.id).split(':'); return { cid: String(a.cid ?? c0), hid: a.hid ?? h0 ?? null }; }
/**
 * 수정 중 강조 값 → 지금 항목: 같은 hid, 또는 옛 hid(작성자가 그새 저장해 바뀜)를 이 세션에서 봤으면 그 덩어리 열쇠로. 못 찾으면 null
 */
export function draftItemFor(index, items, a, d = null) {
  if (!a || a.kind !== 'draft' || a.id == null) return null;
  const { cid, hid } = draftParts(a);
  if (!hid) return null;
  const x = index.get(`draft:${cid}:${hid}`); if (x) return x;
  const k = hunkKeyFor(d, cid, hid);
  return k ? items.find((y) => y.kind === 'draft' && String(y.cr.cid) === cid && y.hkey === k) || null : null;
}
/**
 * 강조 맞춤 값(d.s.active·d.s.hover = { kind, id, cid?, hid? }) → 검토 항목.
 * 플러그인 anchor·누름은 수정 중 id 가 'cid:hid', 셸의 '변경 보기'(우클릭)는 id = cid 에 hid 따로(없으면 그 변경 요청의 첫 덩어리).
 * 메모 메뉴는 요청 메모도 kind 'memo' 로 보낸다(플러그인 setActive 와 같은 규칙: memo ↔ request).
 */
export function itemForAnn(index, items, a, d = null) {
  if (!a || a.id == null) return null;
  const it = index.get(`${a.kind}:${a.id}`);
  if (it) return it;
  if (a.kind === 'draft') {
    const x = draftItemFor(index, items, a, d); if (x) return x;
    const { cid } = draftParts(a);
    return items.find((y) => y.kind === 'draft' && String(y.cr.cid) === cid) || null;
  }
  if (a.kind === 'memo') return index.get(`request:${a.id}`) || null;
  if (a.kind === 'request') return index.get(`memo:${a.id}`) || null;
  return null;
}
/** 카드가 그 강조 맞춤 값에 맞는가(itemForAnn 과 같은 규칙, 수정 중 hid 가 없으면 그 변경 요청 덩어리 모두, 옛 hid 는 열쇠로) */
function annHits(it, a, d = null) {
  if (!a || a.id == null || !it) return false;
  if (it.kind === 'proposal') return a.kind === 'proposal' && it.ids.includes(String(a.id));
  if (it.kind === 'draft') {
    if (a.kind !== 'draft') return false;
    const { cid, hid } = draftParts(a);
    if (cid !== String(it.cr.cid)) return false;
    if (it.collapsed) return true;   // 한 줄로 접은 카드 = 그 변경 요청 덩어리 모두
    return !hid || hid === it.hunk.hid || (!!d && hunkKeyFor(d, cid, hid) === it.hkey);
  }
  return it.id != null && (a.kind === 'memo' || a.kind === 'request') && String(a.id) === it.id;
}
/**
 * 누른 수정 중 덩어리(d.s.active)의 hid 가 작성자 저장으로 바뀌었으면 새 hid 로 맞춘다 — 편집기 강조(setActive)가 그 덩어리에 남게.
 * (레일·검토 탭이 항목이 바뀔 때 부른다)
 */
export function syncActiveDraft(d, index, items) {
  const a = d?.s?.active;
  if (!a || a.kind !== 'draft' || index.has(`draft:${a.id}`)) return;
  const it = draftItemFor(index, items, a, d);
  if (it && it.id !== String(a.id)) setActiveAnn(d, { kind: 'draft', id: it.id, cid: it.cr.cid, hid: it.hunk.hid });
}

// ───────── 카드 몸통: 메모 ─────────
const MemoBody = {
  components: { MemoEditor, InlineConfirm, ThreadList },
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in">
    <div class="rc-head"><i class="dot" :style="{background: color}"></i><b class="rc-who">{{ clip(m.author, 16) }}</b><span class="muted">{{ fmtShort(m.created) }}</span>
      <span class="pill" v-if="tag" :class="tag.cls">{{ tag.label }}</span><span class="spacer"></span>
      <button class="icon" v-if="m.editable && !ui" title="고치기" aria-label="메모 고치기" @click.stop="openUi('edit', { text: m.body ?? m.text ?? '' })" v-html="ICON.edit"></button>
      <button class="icon" v-if="m.editable && !ui" title="삭제" aria-label="메모 삭제" @click.stop="openUi('confirm')" v-html="ICON.trash"></button></div>
    <div class="muted rc-quote" v-if="place==='list' && m.anchorText">「{{ clip(m.anchorText, 60) }}」</div>
    <MemoEditor v-if="ui?.mode==='edit'" v-model="ui.text" :rows="3" :busy="!!ui.busy" :autofocus="!!ui.focus" @save="save" @cancel="closeUi" @click.stop/>
    <div v-else class="rc-body pre" :class="{clamp: !open}">{{ body || '(빈 메모)' }}</div>
    <ThreadList :replies="m.thread?.replies" :resolved="m.thread?.resolved" :max="place==='rail' && !open ? 2 : 0"/>
    <InlineConfirm v-if="ui?.mode==='confirm'" message="이 메모를 지울까요?" ok-label="지우기" danger :busy="!!ui.busy" @ok="remove" @cancel="closeUi"/>
    <MemoEditor v-else-if="ui?.mode==='reply'" v-model="ui.text" placeholder="답글" ok-label="답글 달기" :ask-label="askLabel" :ask-tip="ASK_AI_TIP" :rows="2" :busy="!!ui.busy" :autofocus="!!ui.focus" @save="reply" @ask="ask" @cancel="closeUi" @click.stop/>
    <div class="rc-actions" v-else-if="!ui"><button class="small rc-reply" title="답글 — 한글 메모에도 남습니다" @click.stop="openUi('reply')">답글</button>
      <button class="small rc-resolve" :class="{ ack: !resolved }" :disabled="busy" :title="resolved ? '완료를 풀고 다시 엽니다' : '완료로 표시합니다 — 문서 옆·편집기 강조에서 숨고 검토 탭 「완료」에 남습니다'" @click.stop="resolve">{{ resolved ? '다시 열기' : '완료' }}</button></div></div>`,
  setup(props) {
    const d = inject('doc'); const busy = ref(false);
    // 열린 칸(고치기·답글·지우기 확인)과 쓰던 글 = 문서 store 의 칸('rail:memo:3' 등) — 카드가 빠졌다 돌아와도 남는다
    uiSlots(d);
    const key = () => `${props.place}:${props.item.key}`;
    const ui = computed(() => d.s.cardUi?.[key()] || null);
    const openUi = (mode, extra) => { selectItem(d, props.item); openSlot(d, key(), mode, extra); };
    const closeUi = () => closeSlot(d, key());
    const m = computed(() => props.item.memo);
    const color = computed(() => colorOf(d, m.value.author));
    const resolved = computed(() => !!m.value.thread?.resolved);
    const tag = computed(() => {
      const l = m.value.link;
      if (l?.type === 'comment') return { label: `AI 의견 #${l.rid}`, cls: 'k' };
      if (l?.type === 'proposal') { const p = d.proposal?.(l.pid); return { label: `제안 #${l.pid}${p ? ` · ${({ applied: '적용', rejected: '거절', undone: '복구됨', superseded: '다른 안' })[p.status] || p.status}` : ''}`, cls: 'prop' }; }
      if (l?.type === 'review') return { label: '검토', cls: '' };
      return null;
    });
    const body = computed(() => (m.value.link?.type === 'proposal' ? (m.value.body || m.value.text) : (m.value.body ?? m.value.text)));
    // 칸의 동작(이미 보내는 중이면 무시 — Ctrl+Enter 두 번), 잘 끝나면 칸을 닫는다
    const save = (t) => { const mm = m.value; return runSlot(d, key(), () => d.editMemo(mm, t)); };
    const reply = (t) => { const mm = m.value; return runSlot(d, key(), () => replyMemoWith(d, mm, t)); };
    // [AI에게 요청]: 같은 글을 답글로 남기고 그 AI 작업으로 이어 맡긴다(AI 의견·작업 기록·AI 제안 메모만)
    const askLabel = computed(() => askAiLabel(d, m.value));
    const ask = (t) => { const mm = m.value; return runSlot(d, key(), () => askAiWith(d, mm, t)); };
    const remove = () => { const mm = m.value; return runSlot(d, key(), () => d.deleteMemo(mm, { confirmFirst: false })); };
    async function resolve() {
      if (busy.value) return;
      busy.value = true;
      try { await resolveMemoWith(d, m.value, !resolved.value); } catch (e) { toastError(e); } finally { busy.value = false; }
    }
    return { m, color, resolved, tag, body, ui, openUi, closeUi, busy, save, reply, ask, askLabel, ASK_AI_TIP, resolve, remove, ICON, clip, fmtShort };
  },
};

// ───────── 카드 몸통: AI 작업 ─────────
// v0.3.1(§9.7): 진행 줄·한 번에 정하는 단추(RequestActions — 결과 창·AI 작업 탭과 같은 것). 완료되면 한 줄로 접힌다.
// 머리 = 'AI 작업 #3' + 상태 칩 하나(ui.js requestBadge — 대기열·전달됨·처리 중·확인 필요·완료·실패·취소됨). 종류·요청한 사람·시각은 #3 의 title,
// 보낸 곳·맡은 이는 칩의 title(docs/UI_TERMS.md §1-2·3). 요약은 사람·AI 가 쓴 것만(자동 요약 'AI 검토 요청 — AI 처리 대기'는 상태를 되풀이하므로 숨김).
// 요청 메모 스레드의 [완료] 단추는 없다(완료는 제안을 정하면 저절로) — [답글]은 그대로
const RequestBody = {
  components: { MemoEditor, ThreadList, RequestActions, RequestActivity },
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in" :class="{ 'rc-done': done }">
    <div class="rc-head"><span class="ic rc-ai" v-html="ICON.review"></span><b class="rc-req-head" :title="headTip || null">AI 작업 #{{ item.rid }}</b><span class="muted" v-if="other">{{ clip(other, 10) }}</span><span class="spacer"></span>
      <span class="pill req-st" :class="st.cls" :title="st.title || null">{{ st.label || '…' }}</span></div>
    <div class="rc-body pre" v-if="!done && summary" :class="{clamp: !open}">{{ summary }}</div>
    <RequestActions :rid="item.rid" :place="place"/>
    <RequestActivity :rid="item.rid" place="rail"/>
    <ThreadList v-if="m && (!done || open)" :replies="m.thread?.replies" :resolved="null" :max="place==='rail' && !open ? 2 : 0"/>
    <MemoEditor v-if="m && ui?.mode==='reply'" v-model="ui.text" placeholder="답글" ok-label="답글 달기" :ask-label="askLabel" :ask-tip="ASK_AI_TIP" :rows="2" :busy="!!ui.busy" :autofocus="!!ui.focus" @save="reply" @ask="ask" @cancel="closeUi" @click.stop/>
    <div class="rc-actions" v-else-if="showResultBtn || m"><button v-if="showResultBtn" class="small rc-result" :class="{primary: !done}" title="AI 작업 탭에서 결과 보기" @click.stop="showResult">결과 보기</button>
      <button v-if="m" class="small rc-reply" @click.stop="openUi">답글</button></div></div>`,
  setup(props) {
    const d = inject('doc');
    uiSlots(d);
    const key = () => `${props.place}:${props.item.key}`;
    const ui = computed(() => d.s.cardUi?.[key()] || null);
    const openUi = () => { selectItem(d, props.item); openSlot(d, key(), 'reply'); };
    const closeUi = () => closeSlot(d, key());
    const m = computed(() => props.item.memo || null);
    const r = computed(() => d.request?.(props.item.rid) || null);
    const g = computed(() => (r.value && typeof d.progress === 'function' ? d.progress(r.value) : null));
    const done = computed(() => !!g.value?.resolved);
    // 남은 제안이 있으면 진행 줄의 [하나씩 보기]가 결과로 데려간다 — 그 밖(제안 없음·해결됨)에는 [결과 보기]
    const showResultBtn = computed(() => !(g.value && !g.value.resolved && g.value.open > 0));
    const st = computed(() => requestBadge(d, r.value));
    // 요청한 사람: 남의 요청일 때만 머리에(내 것이면 되풀이)
    const other = computed(() => (r.value?.by && !isMeName(d, r.value.by) ? r.value.by : ''));
    const headTip = computed(() => {
      const x = r.value; if (!x) return '';
      const kind = (x.label || kindLabel(x.kind)) + (x.preset && !x.label ? ` · ${presetLabel(x.preset)}` : '');
      return [kind, x.by, x.at ? fmtShort(x.at) : ''].filter(Boolean).join(' · ');
    });
    const summary = computed(() => sharedSummary(r.value));
    function showResult() { d.s.activeRid = props.item.rid; d.s.tab = 'ai'; callPanel(d); }
    const reply = (t) => { const mm = m.value; return mm ? runSlot(d, key(), () => replyMemoWith(d, mm, t)) : null; };
    const askLabel = computed(() => askAiLabel(d, m.value));
    const ask = (t) => { const mm = m.value; return mm ? runSlot(d, key(), () => askAiWith(d, mm, t)) : null; };
    return { m, r, g, done, showResultBtn, st, other, headTip, summary, ui, openUi, closeUi, showResult, reply, ask, askLabel, ASK_AI_TIP, ICON, clip, fmtShort };
  },
};
/** 카드에 보일 요약: 사람(user)·AI(ai) 가 쓴 것만 — 자동 요약(auto·없음)은 상태를 되풀이하므로 '' (UI_TERMS §1-2) */
function sharedSummary(r) {
  return r && (r.summaryBy === 'ai' || r.summaryBy === 'user') ? String(r.summary || '') : '';
}

// ───────── 카드 몸통: 남의 AI 작업 한 줄 요약('간단히' 보기 — V4 §4.1) ─────────
// 'AI 작업 #2 · 홍길동' + 상태 칩 하나(view.js summaryChip — 끝난 것은 서버 outcome, 반영·남은 수는 title) + 요약(사람·AI 가 쓴 것만, 두 줄에서 접힘).
// 누르면 AI 작업 탭 결과(읽기만 — 그 요청의 제안 단추는 요청한 사람만, '자세히' 보기면 모두)
const SummaryBody = {
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in rc-summary" :data-rid="item.rid">
    <div class="rc-head"><span class="ic rc-ai" v-html="ICON.review"></span><b class="rc-sum-head" :title="headTip || null">{{ head }}</b><span class="spacer"></span>
      <span class="pill rc-sum-chip" v-if="chip" :class="chip.cls" :title="chipTip || null">{{ chip.text }}</span></div>
    <div class="rc-body pre clamp2 rc-sum-text" v-if="summary">{{ summary }}</div>
    <div class="rc-actions"><button class="small rc-result" title="AI 작업 탭에서 결과 보기(읽기만)" @click.stop="showResult">자세히</button></div></div>`,
  setup(props) {
    const d = inject('doc');
    const r = computed(() => d.request?.(props.item.rid) || null);
    const g = computed(() => (r.value && typeof d.progress === 'function' ? d.progress(r.value) : null));
    const head = computed(() => (r.value ? summaryHead(r.value) : `AI 작업 #${props.item.rid}`));
    const chip = computed(() => summaryChip(r.value, g.value));
    // 칩 title: 끝나지 않은 요청은 requestBadge 의 설명(보낸 곳·맡은 이), 끝난 요청은 맡은 이 + 반영·남은 수(서버 outcome — 남의 요청이므로
    // '반영하거나 거절하세요' 같은 내 할 일 안내는 쓰지 않는다). 종류·시각은 머리의 title
    const badge = computed(() => requestBadge(d, r.value));
    const headTip = computed(() => (r.value ? [r.value.label || kindLabel(r.value.kind), r.value.at ? fmtShort(r.value.at) : ''].filter(Boolean).join(' · ') : ''));
    const chipTip = computed(() => {
      if (!r.value) return '';
      if (r.value.status !== 'done') return badge.value.title;
      return [badge.value.who ? `${badge.value.who} 처리` : '', chip.value?.title].filter(Boolean).join(' · ');
    });
    const summary = computed(() => sharedSummary(r.value));
    function showResult() { d.s.activeRid = props.item.rid; d.s.tab = 'ai'; callPanel(d); }
    return { r, head, chip, headTip, chipTip, summary, showResult, ICON };
  },
};

// ───────── 카드 몸통: 제안(대기, 여러 안 묶음) ─────────
// v0.4 실시간 문서(§4.2): [반영] = 공유 문서에 바로(서버 apply — 모두에게 보임), [문서에 바로 적용] 은 없음(같은 것). 수정 권한이 없으면 단추 없음.
// 승인 방식: [반영] = 내 수정본에(검토 요청 뒤 문서에) → '반영됨', 남이 자기 수정본에 반영해 둔 것은 '○○ 님이 반영함'
const ProposalBody = {
  components: { TablePreview, FormatPreview },
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in">
    <div class="rc-head"><span class="ic rc-prop" v-html="ICON.suggest"></span><b>{{ head }}</b><span class="pill k rc-rtag" v-if="first.rid != null" :title="'AI 작업 #' + first.rid + '의 제안'">AI 작업 #{{ first.rid }}</span>
      <span class="muted">{{ clip(first.by, 14) }}</span><span class="spacer"></span><span class="muted">{{ fmtShort(first.at) }}</span></div>
    <div class="rc-opt" v-for="(p, i) in list" :key="p.pid" :data-pid="p.pid">
      <div class="rc-opt-h muted" v-if="list.length > 1">안 {{ p.option || i + 1 }} <span>#{{ p.pid }}</span></div>
      <template v-if="p.type==='table'"><div class="muted">이 문단 뒤에 표 {{ p.table?.rows?.length || 0 }}×{{ p.table?.rows?.[0]?.length || 0 }}</div><TablePreview v-if="open" :table="p.table"/></template>
      <div v-else-if="p.type==='toc'" class="difftext" :class="{clamp: !open}"><span class="muted">차례 새로 고침</span>{{ tocNote(p) }}</div>
      <div v-else-if="p.type==='table_edit'" class="difftext" :class="{clamp: !open}"><span class="muted">표{{ p.tableEdit?.caption ? ' 「' + p.tableEdit.caption + '」' : '' }} 고치기: </span>{{ (p.tableEdit?.labels || []).join(', ') }}</div>
      <div v-else-if="p.type==='delete'" class="difftext"><span class="muted">이 문단의 개체 지우기: </span>{{ deleteNote(p) }}</div>
      <div v-else-if="p.type==='page_layout'" class="difftext"><span class="muted">쪽 구성: </span>{{ (p.pageLayout?.labels || []).join(', ') }}</div>
      <div v-else-if="p.type==='figure'" class="muted">{{ p.figure?.nativeChart ? '이 문단 뒤에 편집 가능한 차트' + (p.figure.caption ? ' 「' + p.figure.caption + '」' : '') : p.figure?.replace ? '이 문단의 그림' + (p.figure.replace.caption ? ' 「' + p.figure.replace.caption + '」' : '') + ' 교체' : '이 문단 뒤에 그림' + (p.figure?.caption ? ' 「' + p.figure.caption + '」' : '') }}{{ p.figure?.name ? ' — ' + p.figure.name : '' }}</div>
      <div v-else-if="p.type==='insert'" class="difftext" :class="{clamp: !open}"><span class="muted">이 문단 뒤에 새 문단: </span><ins>{{ p.text }}</ins></div>
      <div v-else-if="p.type==='format'" class="difftext" :class="{clamp: !open}">{{ p.find }}</div>
      <div v-else class="difftext" :class="{clamp: !open}" v-html="diff(p)"></div>
      <FormatPreview :proposal="p"/>
      <div class="muted rc-reason" v-if="p.reason && open">{{ p.reason }}</div>
      <div class="muted rc-others" v-if="!live && others(p)">{{ others(p) }}</div>
      <div class="rc-actions" v-if="decide">
        <template v-if="live"><button class="small primary rc-adopt rc-live" :disabled="busy" title="공유 문서에 바로 반영합니다(모두에게 보임)" @click.stop="adopt(p)">반영</button></template>
        <template v-else>
          <span class="pill ok adopted" v-if="adopted(p)" title="내 수정본에 넣었습니다 — 검토 요청 뒤 문서에 들어갑니다">반영됨</span>
          <button v-else-if="!['table','table_edit','toc','figure','page_layout','delete'].includes(p.type)" class="small primary rc-adopt" :disabled="busy" title="내 수정본에 넣습니다(검토 요청 뒤 문서에 들어감)" @click.stop="adopt(p)">반영</button>
          <button v-if="canUndoFormat(p)" class="small rc-format-undo" :disabled="busy" title="서식 반영을 되돌립니다" @click.stop="undoFormat(p)">되돌리기</button>
          <button v-if="direct" class="small rc-apply" :class="{primary: ['table','table_edit','toc','figure','page_layout','delete'].includes(p.type)}" :disabled="busy" title="공유 문서에 바로 적용합니다" @click.stop="apply(p)">문서에 바로 적용</button></template>
        <button class="small rc-reject" :disabled="busy" @click.stop="reject(p)">거절</button></div></div></div>`,
  setup(props) {
    const d = inject('doc'); const busy = ref(false);
    const list = computed(() => props.item.proposals || []);
    const first = computed(() => list.value[0] || {});
    const head = computed(() => (list.value.length > 1 ? `제안 ${list.value.length}안` : `제안 #${first.value.pid}`));
    const live = computed(() => typeof d.realtime === 'function' && d.realtime());
    // 문서를 정하는 단추(반영·거절)는 수정 권한이 있을 때만(서버도 403 — V4 §4.3)
    const decide = computed(() => (typeof d.canDecide === 'function' ? d.canDecide() : true));
    // '문서에 바로 적용'(v0.2 apply)은 관리자 또는 /api/config allowDirectApply 일 때만 — 기본은 [반영](내 수정본에)
    const direct = computed(() => canDirectApply());
    const adopted = (p) => adoptedByMe(d, p);
    /** 남이 자기 수정본에 반영해 둔 제안: '김검토 님이 반영함'(여럿이면 '김검토, 홍길동 외 2명 님이 반영함') */
    function others(p) {
      if (p.status !== 'pending') return '';
      const me = meName(d);
      const names = adopterNames(p).filter((n) => n !== me);
      return names.length ? `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` 외 ${names.length - 2}명` : ''} 님이 반영함` : '';
    }
    const canUndoFormat = (p) => adopted(p) && formatAdoptionOf(p, meName(d))?.canUndo;
    const diff = (p) => diffHtml(p.find || '', p.replace || '');
    async function guard(fn) { if (busy.value) return; busy.value = true; try { await fn(); } catch (e) { toastError(e); } finally { busy.value = false; } }
    const adopt = (p) => guard(() => adoptWith(d, p));
    const apply = (p) => guard(() => d.applyProposal(p));
    const reject = (p) => guard(() => d.rejectProposal(p));
    const undoFormat = (p) => guard(() => d.undoAdoptFormat(p));
    return { list, first, head, live, decide, direct, adopted, others, canUndoFormat, undoFormat, diff, busy, adopt, apply, reject, tocNote, deleteNote, ICON, clip, fmtShort };
  },
};

// ───────── 카드 몸통: 남의 수정 중 — '간단히'는 변경 요청마다 한 줄(V4 §5) ─────────
const DraftLine = {
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in rc-draftline" :data-cid="cr.cid">
    <div class="rc-head"><i class="dot" :style="{background: color}"></i><b class="rc-who rc-draft-title" :style="{color}" :title="'변경 요청 #' + cr.cid + (cr.status === 'open' ? ' · 검토 중' : ' · 초안')">✎ {{ cr.author }} 수정 중 · {{ item.count }}문단</b><span class="spacer"></span>
      <button class="small rc-show" title="변경 요청 탭에서 보기" @click.stop="show">보기</button></div></div>`,
  setup(props) {
    const d = inject('doc');
    const cr = computed(() => props.item.cr);
    const color = computed(() => colorOf(d, cr.value.author));
    const show = () => openCr(d, cr.value.cid, props.item.hunk?.hid || null);
    return { cr, color, show };
  },
};

// ───────── 카드 몸통: 남의 수정 중(변경 요청 덩어리) ─────────
const DraftBody = {
  components: { MemoEditor },
  props: { item: Object, place: String, open: Boolean },
  template: `<div class="rc-in">
    <div class="rc-head"><i class="dot" :style="{background: color}"></i><b class="rc-who rc-draft-title" :style="{color}">✎ {{ cr.author }} 수정 중</b>
      <span class="pill rc-crtag" :class="cr.status === 'open' ? 'info' : 'draft'" :title="crTip">{{ cr.status === 'open' ? '검토 중 ' : '' }}#{{ cr.cid }}</span><span class="spacer"></span><span class="rc-hunk-k muted">{{ kindText }}</span></div>
    <div class="rc-sub muted" v-if="threads.length || badge"><span class="pill" v-if="badge" :class="badge.cls" :title="badge.title">{{ badge.label }}</span><span v-if="threads.length" class="rc-ncomm">{{ badge ? ' · ' : '' }}의견 {{ threads.length }}</span></div>
    <div class="difftext" :class="{clamp: !open}" v-html="html"></div>
    <div class="rc-lastc muted" v-if="open && lastComment">↳ {{ lastComment.by }}: {{ clip(lastComment.text, 60) }}</div>
    <MemoEditor v-if="ui?.mode==='comment'" v-model="ui.text" placeholder="이 변경에 대한 의견" ok-label="의견 달기" :rows="2" :busy="!!ui.busy" :autofocus="!!ui.focus" @save="comment" @cancel="closeUi" @click.stop/>
    <div class="rc-actions" v-else><button class="small rc-show" title="변경 요청 탭에서 보기" @click.stop="show">변경 보기</button><button class="small rc-comment" @click.stop="openUi">의견</button></div></div>`,
  setup(props) {
    const d = inject('doc');
    // 의견 칸·쓰던 글은 덩어리 열쇠(종류 + 기준 자리)의 칸 — 작성자가 자동 저장해 hid 가 바뀌어도 남는다
    uiSlots(d);
    const key = () => `${props.place}:${props.item.key}`;
    const ui = computed(() => d.s.cardUi?.[key()] || null);
    const openUi = () => { selectItem(d, props.item); openSlot(d, key(), 'comment'); };
    const closeUi = () => closeSlot(d, key());
    const cr = computed(() => props.item.cr); const h = computed(() => props.item.hunk);
    const color = computed(() => colorOf(d, cr.value.author));
    const html = computed(() => hunkHtml(h.value));
    const badge = computed(() => hunkBadge(h.value));
    const kindText = computed(() => (h.value.type === 'format' ? '서식 바꿈' : h.value.type === 'object' ? '그림·부호 바꿈' : h.value.type === 'insert' ? '문단 추가' : h.value.type === 'delete' ? '문단 지움' : (h.value.cell || /\/n\d+/.test(String(h.value.ref || ''))) ? '표 칸 바꿈' : '문단 바꿈'));
    const crTip = computed(() => `변경 요청 #${cr.value.cid}${cr.value.title ? ` 「${cr.value.title}」` : ''} · ${cr.value.status === 'open' ? '검토 중' : '초안'}`);
    // 스레드: 같은 hid, 옛 hid(이 세션에서 본 열쇠), 같은 자리·인용(crs.js threadsByHunk)
    const threads = computed(() => threadsByHunk(d, cr.value).byKey.get(props.item.hkey) || []);
    const lastComment = computed(() => { const t = threads.value[threads.value.length - 1]; return t?.comments?.[t.comments.length - 1] || null; });
    const show = () => openCr(d, cr.value.cid, h.value.hid);
    // 보내기 직전에 그 덩어리의 지금 hid 를 찾는다(addHunkThread — NO_HUNK 면 다시 읽어 한 번 더)
    function comment(text) {
      const cid = cr.value.cid; const hk = props.item.hkey; const h0 = h.value;
      return runSlot(d, key(), async () => { const v = await addHunkThread(d, cid, hk, h0, text); toast(`변경 요청 #${cid}에 의견을 달았습니다`); return v; });
    }
    return { cr, color, html, badge, kindText, crTip, threads, lastComment, ui, openUi, closeUi, show, comment, clip };
  },
};

// ───────── 카드 틀(종류별 몸통 + hover/누르기) ─────────
export const ReviewCard = {
  components: { MemoBody, RequestBody, SummaryBody, ProposalBody, DraftBody, DraftLine },
  props: { item: Object, place: { type: String, default: 'rail' }, pinned: Boolean },
  emits: ['activate'],
  template: `<div class="rcard" :class="['k-' + item.kind, 'c-' + item.cat, phase ? 'ph-' + phase : '', {active: isActive, hover: isHover, pinned, resolved: item.resolved, 'k-summary': item.summary, 'k-draftline': item.collapsed}]" :style="{'--who': who}"
      :data-key="item.key" :data-kind="item.kind" :data-id="item.id" :data-ref="item.ref" :data-rid="item.rid ?? null" tabindex="0"
      @mouseenter="hover(true)" @mouseleave="hover(false)" @click="activate" @keydown.enter.self.prevent="activate">
    <MemoBody v-if="item.kind==='memo'" :item="item" :place="place" :open="open"/>
    <SummaryBody v-else-if="item.kind==='request' && item.summary" :item="item" :place="place" :open="open"/>
    <RequestBody v-else-if="item.kind==='request'" :item="item" :place="place" :open="open"/>
    <ProposalBody v-else-if="item.kind==='proposal'" :item="item" :place="place" :open="open"/>
    <DraftLine v-else-if="item.kind==='draft' && item.collapsed" :item="item" :place="place" :open="open"/>
    <DraftBody v-else-if="item.kind==='draft'" :item="item" :place="place" :open="open"/></div>`,
  setup(props, { emit }) {
    const d = inject('doc');
    // 누른 것(s.active)·고른 메모(s.activeMemo)는 펼쳐 보이고, 마우스만 올린 것(s.hover — 편집기·카드)은 강조만
    const isActive = computed(() => annHits(props.item, d.s.active, d) || (!!props.item.memo && d.s.activeMemo === props.item.memo.id));
    const isHover = computed(() => annHits(props.item, d.s.hover, d));
    const open = computed(() => props.pinned || isActive.value || props.place === 'list');
    const who = computed(() => {
      const it = props.item;
      if (it.kind === 'draft') return colorOf(d, it.cr.author);
      if (it.kind === 'memo') return colorOf(d, it.memo.author);
      return '';
    });
    // 진행 단계(docs/UI_TERMS.md §6 — 카드 테두리): AI 작업은 그 단계(응답 대기·처리 중·확인 필요 …), 도착해서 내가 정할 것 —
    // 내 요청의 대기 제안(내 수정본에 아직 안 넣음)·내 요청의 AI 의견(아직 완료 안 함) — 은 '내 차례'(act)
    const mineReq = (rid) => { const r = rid == null ? null : d.request?.(rid); return !!r && isMeName(d, r.by); };
    const phase = computed(() => {
      const it = props.item;
      if (it.kind === 'request') return requestPhase(d, d.request?.(it.rid));
      if (it.kind === 'proposal') {
        const can = typeof d.canDecide === 'function' ? d.canDecide() : true;
        const open = (it.proposals || []).some((p) => p.status === 'pending' && !adoptedByMe(d, p) && (p.rid == null || mineReq(p.rid)));
        return can && open ? 'act' : '';
      }
      if (it.kind === 'memo' && it.memo?.link?.type === 'comment' && !it.resolved && mineReq(it.memo.link.rid)) return 'act';
      return '';
    });
    function hover(on) {
      const a = annOf(props.item); if (!a) return;
      if (on) setHoverAnn(d, a);
      else if (isHover.value) setHoverAnn(d, null);
    }
    function activate(e) {
      if (e && e.target?.closest?.('button, a, textarea, input, select, .memoedit, .confirm-row, details')) return;
      const it = props.item;
      const a = annOf(it); if (a) setActiveAnn(d, a);
      if (it.memo) d.s.activeMemo = it.memo.id;
      focusIn(d, it.range || { ref: it.ref });
      // 남의 AI 작업 한 줄 요약(간단히): 누르면 [자세히] — AI 작업 탭 결과(읽기만, V4 §4.1)
      if (it.summary && it.rid != null) { d.s.activeRid = it.rid; d.s.tab = 'ai'; callPanel(d); }
      emit('activate', it);
    }
    return { isActive, isHover, open, who, phase, hover, activate };
  },
};

// ───────── 문서 옆 메모(레일) ─────────
// 편집기 문서 스크롤 칸 위에 겹친 층(app.js .railover — 빈 곳은 편집기가 그대로 받는다). 메모는 보통 메모 칸(col — 쪽 오른쪽 끝 옆)에 강조 높이로 쌓고,
// 머리 줄·손잡이를 끌면 그 메모만 어디로든 옮긴다(d.s.memoPos — 강조 자리에서 떨어진 거리라 문서와 같이 스크롤, 이 브라우저에 기억 view.js writeMemoPos).
// 옮긴 메모·고른 메모·마우스를 올린 메모는 강조 자리에서 메모까지 선을 긋는다(한/글 메모 선처럼). 두 번 누르거나 ↺ 이면 제자리
const INTERACTIVE = 'button, a, input, textarea, select, label, summary, .memoedit, .confirm-row';
const KIND_COLOR = { request: 'var(--ai)', proposal: 'var(--prop)' };
export const ReviewRail = {
  components: { ReviewCard, CollabHost },
  props: { col: { type: Object, default: null } },
  template: `<aside class="review-rail" ref="el" v-show="open" aria-label="문서 옆 메모" @click.self="unpin">
    <svg class="rail-links" v-if="links.length" aria-hidden="true"><g v-for="l in links" :key="l.key" :class="l.cls" :style="{ color: l.color }"><path :d="l.d"/><circle :cx="l.ax" :cy="l.ay" r="2.5"/></g></svg>
    <div class="rail-cards" @click.self="unpin">
      <div class="rail-slot" v-for="c in cards" :key="c.item.key" :ref="(e) => setEl(c.item.key, e)" :data-key="c.item.key" :data-sticky="c.anchored ? null : '1'"
           :class="{placed: tops[c.item.key] != null, free: !!posOf(c.item.key), dragging: drag?.key === c.item.key, ['edge-' + edges[c.item.key]]: !!edges[c.item.key]}" :style="slotStyle(c)"
           @pointerdown="startDrag($event, c)" @click.capture="eatClick" @dblclick="onDbl($event, c)">
        <span class="rail-grip" title="끌어서 옮기기 · 두 번 누르면 제자리" aria-hidden="true"></span>
        <button class="rail-home" v-if="posOf(c.item.key)" title="제자리로" aria-label="메모 제자리로" @click.stop="home(c.item.key)">↺</button>
        <span class="rail-edge" v-if="edges[c.item.key]" :title="EDGE_TIP[edges[c.item.key]]">{{ EDGE_MARK[edges[c.item.key]] }}</span>
        <ReviewCard :item="c.item" place="rail" :pinned="pinned===c.item.key" @activate="pin"/></div>
    </div>
    <div class="rail-empty muted" v-if="!cards.length" :title="emptyTip">{{ emptyText }}</div>
    <CollabHost :priority="0"/>
  </aside>`,
  setup(props) {
    const d = inject('doc');
    const el = ref(null); const pinned = ref(null); const tops = shallowRef({}); const edges = shallowRef({}); const pts = shallowRef({});
    const railW = ref(0);
    const drag = ref(null);   // 끄는 중인 메모 { key, left, top }(층 안 좌표)
    if (d.s.railOpen === undefined) d.s.railOpen = true;
    if (!d.s.memoPos) d.s.memoPos = readMemoPos(d.s.id);
    uiSlots(d);
    const open = computed(() => d.s.railOpen !== false);
    const items = computed(() => reviewItems(d));
    const index = computed(() => anchorIndex(items.value));
    const byKey = computed(() => new Map(items.value.map((it) => [it.key, it])));
    // 편집기를 다시 여는 동안(문서 바꾸기·새 기준) 잠깐 비는 강조 자리는 무시하고 지난 자리를 쓴다(메모가 깜빡이며 빠지지 않게)
    let lastAnchors = [];
    const anchorList = computed(() => {
      const a = Array.isArray(d.s.anchors) ? d.s.anchors : [];
      const ed = d.editor;
      if (!a.length && lastAnchors.length && ed && !ed.ready && ed.loading !== false) return lastAnchors;
      lastAnchors = a;
      return a;
    });
    // 입력 칸(답글·고치기·의견·지우기 확인)이 열린 메모 — 강조 자리가 없어도(보이는 쪽 밖) 남긴다
    const openKeys = computed(() => {
      const out = new Set();
      for (const k of Object.keys(d.s.cardUi || {})) if (k.startsWith('rail:')) out.add(k.slice(5));
      return out;
    });
    // anchors(플러그인, 쪽·y 순) → 메모(같은 항목은 처음 자리 하나) + 입력 칸이 열린 메모(자리 없음 → 지난 자리)
    const cards = computed(() => {
      const out = []; const seen = new Set();
      for (const a of anchorList.value) {
        if (!a || a.kind === 'change') continue;
        // 남의 수정 중 강조가 옛 hid 면(작성자가 그새 저장 — 목록은 벌써 새 hid, 편집기 강조는 다음 setAnnotations 까지 옛 hid)
        // 덩어리 열쇠로 같은 메모를 찾는다 — 메모가 잠깐 빠졌다 다시 그려지며 깜빡이지 않게
        const it = index.value.get(`${a.kind}:${a.id}`) || (a.kind === 'draft' ? draftItemFor(index.value, items.value, a, d) : null);
        if (!it || seen.has(it.key)) continue;
        seen.add(it.key); out.push({ item: it, y: Number(a.y) || 0, x: Number(a.x) || 0, page: Number.isFinite(Number(a.page)) ? Number(a.page) : null, visible: a.visible !== false, anchored: true });
      }
      out.sort((p, q) => p.y - q.y || p.x - q.x);
      for (const k of openKeys.value) {
        if (seen.has(k)) continue;
        const it = byKey.value.get(k); if (!it) continue;
        seen.add(k); out.push({ item: it, y: null, x: 0, visible: false, anchored: false });
      }
      return out;
    });
    const emptyText = computed(() => {
      if (!editorOf(d)) return '편집기를 여는 중…';
      return items.value.length ? '이 화면에 검토 표시 없음' : '메모·제안 없음';
    });
    const emptyTip = computed(() => (items.value.length ? '검토 탭에서 모두 볼 수 있습니다' : '글을 고르고 우클릭 → 메모 달기 · AI에게 요청'));
    // 자리 잡기의 기준 메모 = 마지막으로 누른 것(메모·편집기 강조 누름 s.active·메모 '보기' s.activeMemo).
    // 마우스만 올린 것(s.hover)은 강조만 하고 메모를 옮기지 않는다(메모가 마우스 밑에서 움직이지 않게)
    const activeKey = computed(() => itemForAnn(index.value, items.value, d.s.active, d)?.key ?? null);
    const hoverKey = computed(() => itemForAnn(index.value, items.value, d.s.hover, d)?.key ?? null);
    // 누른 수정 중 덩어리의 hid 가 작성자 저장으로 바뀌면 편집기 강조도 새 hid 로
    watch(items, () => syncActiveDraft(d, index.value, items.value));

    // ── 폭·옆 자리(높이는 아래 layout) ──
    const posOf = (key) => d.s.memoPos?.[key] || null;
    /** 메모 칸(쪽 옆 — limit 은 메모가 넘지 않을 오른쪽 끝, 꼭지 자리 앞) — 아직 재지 못했으면 층 오른쪽 끝에 300px */
    const colOf = () => props.col || { left: Math.max(0, railW.value - 304), width: Math.min(300, railW.value || 300), limit: railW.value };
    /** 고치는 중이면 넓게(view.js memoWidth 'edit'), 고른 것·입력 칸이 열린 것은 조금 넓게 */
    function slotState(key) {
      const u = d.s.cardUi?.[`rail:${key}`];
      if (u?.mode === 'edit') return 'edit';
      return u || pinned.value === key ? 'open' : '';
    }
    function boxOf(c) {
      const key = c.item.key; const W = railW.value; const col = colOf(); const lim = Math.min(W || Infinity, col.limit ?? Infinity);
      const width = memoWidth(col.width, slotState(key), Number.isFinite(lim) ? lim : W);
      if (drag.value?.key === key) return { left: drag.value.left, top: drag.value.top, width };
      const top = tops.value[key];
      const p = posOf(key);
      // 끌어 옮긴 메모는 층 어디든(꼭지 아래도), 칸 메모는 꼭지 앞까지
      const left = p ? freeBox(p, { colLeft: col.left }, width, W).left : memoLeft(col.left, width, Number.isFinite(lim) ? lim : W);
      return { left, top, width };
    }
    /** 메모 자리(잡기 전에는 강조 y·지난 자리 — 잡기 전에는 숨겨 둔다) */
    function slotStyle(c) {
      const b = boxOf(c);
      const top = b.top != null ? b.top : (c.anchored ? c.y : (lastWant.get(c.item.key) ?? 0));
      return { top: `${top}px`, left: `${b.left}px`, width: `${b.width}px` };
    }
    // 강조 자리 → 메모 선: 옮긴 메모·끄는 메모는 곧장, 칸에 있는 메모(고른 것·마우스를 올린 것)는 글줄을 따라 쪽 끝까지 간 뒤 메모로
    const links = computed(() => {
      const out = []; const P = pts.value; const col = colOf();
      for (const c of cards.value) {
        const key = c.item.key; const p = P[key];
        if (!p || !c.anchored || tops.value[key] == null) continue;
        const moved = !!posOf(key) || drag.value?.key === key;
        if (!moved && key !== pinned.value && key !== hoverKey.value) continue;
        const b = boxOf(c);
        const right = b.left < p.ax;
        const tx = right ? b.left + b.width : b.left; const ty = b.top + 12;
        const bend = !moved && !right ? Math.max(p.ax, Math.min(tx, col.left) - 6) : null;
        const it = c.item;
        const color = it.kind === 'draft' ? colorOf(d, it.cr.author) : it.kind === 'memo' ? (it.cat === 'ai' ? 'var(--ai)' : colorOf(d, it.memo.author)) : (KIND_COLOR[it.kind] || 'var(--memo)');
        out.push({ key, ax: p.ax, ay: p.ay, color, cls: moved ? 'free' : 'hot', d: bend != null ? `M${p.ax},${p.ay}H${bend}L${tx},${ty}` : `M${p.ax},${p.ay}L${tx},${ty}` });
      }
      return out;
    });

    // ── 자리 잡기(높이) ──
    const elMap = new Map(); let ro = null; let raf = 0;
    const lastWant = new Map();   // 항목 → 마지막으로 강조 자리에서 잰 층 안 y(자리를 잃은 입력 중 메모의 자리)
    const lastPage = new Map();   // 항목 → 마지막으로 본 강조의 쪽(자리를 잃은 메모가 위·아래 어느 쪽인지)
    function setEl(key, e) {
      const old = elMap.get(key); if (old === e) return;
      if (old && ro) ro.unobserve(old);
      if (e) { elMap.set(key, e); if (ro) ro.observe(e); } else elMap.delete(key);
    }
    function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; layout(); }); }
    /** iframe client 좌표 → 층 안 좌표: 편집기 iframe 왼쪽 위(호스트 쪽 좌표) - 층 왼쪽 위 */
    function frameOffset() {
      const rail = el.value; if (!rail) return { x: 0, y: 0 };
      const rr = rail.getBoundingClientRect();
      let fx = null; let fy = null;
      try { const r = d.editor?.anchorToPage?.({ x: 0, y: 0, w: 0, h: 0 }); if (r && Number.isFinite(r.y)) { fy = r.y; fx = Number.isFinite(r.x) ? r.x : null; } } catch { /* 편집기 없음 */ }
      if (fy == null || fx == null) { const f = document.querySelector('.editorhost iframe') || document.querySelector('iframe'); if (f) { const b = f.getBoundingClientRect(); fy = fy ?? b.top; fx = fx ?? b.left; } }
      return { x: fx == null ? 0 : fx - rr.left, y: fy == null ? 0 : fy - rr.top };
    }
    /** 지금 입력 중인(포커스가 안에 있는) 메모 */
    function focusedKey() {
      const a = document.activeElement;
      if (!a || !el.value || !el.value.contains(a)) return null;
      return a.closest?.('.rail-slot')?.dataset?.key || null;
    }
    function layout() {
      const list = cards.value;
      if (el.value && el.value.clientWidth !== railW.value) railW.value = el.value.clientWidth;
      // 층이 숨어 있으면(v-show·좁은 창) 잴 수 없다 — 다시 보일 때 잡는다
      if (!list.length || !el.value || !el.value.getClientRects().length) {
        if (!list.length && (Object.keys(tops.value).length || Object.keys(edges.value).length)) { tops.value = {}; edges.value = {}; pts.value = {}; }
        return;
      }
      const off = frameOffset();
      const H = el.value.clientHeight;
      const opened = openKeys.value;
      const n = list.length;
      const hs = list.map((c) => elMap.get(c.item.key)?.offsetHeight || 80);
      const edge = {}; const pt = {};
      // 지금 강조가 보이는 쪽 범위 — 자리를 잃은 메모의 강조가 그 위·아래 어느 쪽인지(멀리 건너뛴 스크롤·이동)
      const pages = list.filter((c) => c.anchored && c.page != null).map((c) => c.page);
      const pmin = pages.length ? Math.min(...pages) : null; const pmax = pages.length ? Math.max(...pages) : null;
      // 입력 칸이 열린 메모는 층 안에 둔다 — 자리가 화면 위·아래 밖(또는 보이는 쪽 밖)이면 그 끝에 붙인다
      const keepIn = (key, k, w, anchored) => {
        if (!opened.has(key)) return w;
        const hi = Math.max(0, H - hs[k]);
        if (w < 0) { edge[key] = 'up'; return 0; }
        if (w > hi) { edge[key] = 'down'; return hi; }
        if (!anchored) edge[key] = 'off';
        return w;
      };
      const free = list.map((c) => posOf(c.item.key));
      const want = list.map((c, k) => {
        const key = c.item.key;
        let w;
        if (c.anchored) {
          w = Math.round(c.y + off.y - 6); lastWant.set(key, w);
          if (c.page != null) lastPage.set(key, c.page);
          pt[key] = { ax: Math.round(c.x + off.x), ay: Math.round(c.y + off.y + 9) };
        } else {
          w = lastWant.get(key) ?? 0;
          const lp = lastPage.get(key);
          if (lp != null && pmin != null) { if (lp < pmin) w = -Infinity; else if (lp > pmax) w = Infinity; }
        }
        // 옮긴 메모는 강조 자리 + dy(쌓지 않는다)
        if (free[k]) w = Number.isFinite(w) ? w + free[k].dy : w;
        return keepIn(key, k, w, c.anchored);
      });
      const top = new Array(n);
      list.forEach((_, k) => { if (free[k]) top[k] = want[k]; });
      // 칸에 있는 메모: 위에서 아래로 놓는 차례(원하는 y 순 — 강조 자리 순서와 같다), 겹치면 8px 간격으로 민다
      const order = list.map((_, k) => k).filter((k) => !free[k]).sort((p, q) => want[p] - want[q] || p - q);
      if (order.length) {
        const at = (pred) => order.findIndex((k) => pred(list[k]));
        // 기준 메모(제자리에 두고 나머지를 위·아래로 민다): 입력 중(포커스) → 누른 것 → 입력 칸이 열린 것 → 처음 보이는 것
        const fk = focusedKey();
        let p = fk ? at((c) => c.item.key === fk) : -1;
        const pk = pinned.value;
        if (p < 0 && pk) p = at((c) => c.item.key === pk && (c.visible || opened.has(pk)));
        if (p < 0) p = at((c) => opened.has(c.item.key));
        if (p < 0) p = at((c) => c.visible);
        if (p < 0) p = 0;
        top[order[p]] = want[order[p]];
        for (let i = p - 1; i >= 0; i--) { const k = order[i]; top[k] = Math.min(want[k], top[order[i + 1]] - GAP - hs[k]); }
        for (let i = p + 1; i < order.length; i++) { const k = order[i]; const q = order[i - 1]; top[k] = Math.max(want[k], top[q] + hs[q] + GAP); }
      }
      const next = {}; list.forEach((c, k) => { next[c.item.key] = top[k]; });
      const prev = tops.value; const keys = Object.keys(next);
      if (keys.length !== Object.keys(prev).length || keys.some((k) => prev[k] !== next[k])) tops.value = next;
      const pe = edges.value; const ek = Object.keys(edge);
      if (ek.length !== Object.keys(pe).length || ek.some((k) => pe[k] !== edge[k])) edges.value = edge;
      const pp = pts.value; const tk = Object.keys(pt);
      if (tk.length !== Object.keys(pp).length || tk.some((k) => pp[k]?.ax !== pt[k].ax || pp[k]?.ay !== pt[k].ay)) pts.value = pt;
    }
    watch(cards, () => nextTick(schedule));
    watch(activeKey, (k) => { if (k) pinned.value = k; }, { immediate: true });
    watch(pinned, () => schedule());
    watch(open, (v) => { if (v) nextTick(schedule); });
    watch(() => d.s.memoPos, () => schedule());
    // v0.2 식 '고른 메모'(우클릭 메뉴 '보기'·편집기 표식 누름 등): 그 메모를 고정
    watch(() => d.s.activeMemo, (id) => {
      if (id == null) return;
      const it = items.value.find((x) => x.memo && x.memo.id === id);
      if (it) pinned.value = it.key;
    });
    function pin(it) { pinned.value = it.key; }
    function unpin() { pinned.value = null; if (d.s.active) setActiveAnn(d, null); if (d.s.activeMemo != null) d.s.activeMemo = null; schedule(); }

    // ── 끌어 옮기기: 머리 줄·손잡이를 5px 넘게 끌면(그 안의 단추·입력 칸 빼고). 그냥 누르면 보통 누름(메모 고르기) ──
    let eatUntil = 0; let stopDrag = null;
    function setPos(key, p) {
      const next = { ...(d.s.memoPos || {}) };
      if (p) next[key] = { dx: Math.round(p.dx), dy: Math.round(p.dy) }; else delete next[key];
      d.s.memoPos = next; writeMemoPos(d.s.id, next);
    }
    const home = (key) => setPos(key, null);
    function startDrag(e, c) {
      if (e.button !== 0 || !el.value) return;
      const t = e.target;
      if (!t.closest?.('.rail-grip, .rc-head') || t.closest(INTERACTIVE)) return;
      // 강조 자리를 한 번도 재지 못한 메모(입력 칸 때문에 남았을 뿐)는 옮길 기준이 없다
      if (!c.anchored && !lastWant.has(c.item.key)) return;
      stopDrag?.();
      const slot = e.currentTarget; const box = el.value.getBoundingClientRect(); const b = slot.getBoundingClientRect();
      const x0 = e.clientX; const y0 = e.clientY; const l0 = b.left - box.left; const t0 = b.top - box.top; const key = c.item.key;
      let moved = false;
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved) {
          if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
          moved = true;
          try { slot.setPointerCapture(e.pointerId); } catch { /* 잡지 못해도 끌기는 된다 */ }
          document.documentElement.classList.add('memo-dragging');
        }
        ev.preventDefault();
        drag.value = { key, left: Math.round(l0 + ev.clientX - x0), top: Math.round(t0 + ev.clientY - y0) };
      };
      const end = (ev) => {
        if (ev && ev.pointerId !== e.pointerId) return;
        stopDrag?.();
        const g = drag.value; drag.value = null;
        if (!moved || !g || ev?.type === 'pointercancel') return;
        eatUntil = Date.now() + 400;   // 끌기를 놓은 누름이 메모 고르기로 가지 않게
        const base = lastWant.get(key);
        if (base == null) return;
        setPos(key, { dx: g.left - colOf().left, dy: g.top - base });
      };
      stopDrag = () => {
        removeEventListener('pointermove', move, true); removeEventListener('pointerup', end, true); removeEventListener('pointercancel', end, true);
        document.documentElement.classList.remove('memo-dragging');
        stopDrag = null;
      };
      addEventListener('pointermove', move, true); addEventListener('pointerup', end, true); addEventListener('pointercancel', end, true);
    }
    function eatClick(e) { if (Date.now() < eatUntil) { e.stopPropagation(); e.preventDefault(); } }
    function onDbl(e, c) {
      if (!posOf(c.item.key) || !e.target.closest?.('.rail-grip, .rc-head') || e.target.closest(INTERACTIVE)) return;
      home(c.item.key);
    }

    const onResize = () => schedule();
    onMounted(() => {
      ro = new ResizeObserver(() => schedule());
      for (const e of elMap.values()) ro.observe(e);
      if (el.value) ro.observe(el.value);
      addEventListener('resize', onResize);
      schedule();
    });
    onBeforeUnmount(() => { if (ro) ro.disconnect(); cancelAnimationFrame(raf); removeEventListener('resize', onResize); stopDrag?.(); });
    // 시험·진단용: 메모 자리(층 안 y·x)와 원하는 자리(sticky = 강조 자리 없이 입력 칸 때문에 남은 메모, edge = 끝에 붙임, free = 끌어 옮김)
    if (typeof window !== 'undefined') {
      window.__rail = {
        layout: () => { layout(); return { ...tops.value }; },
        cards: () => cards.value.map((c) => { const b = boxOf(c); return { key: c.item.key, id: c.item.id, y: c.y, top: tops.value[c.item.key] ?? null, left: b.left, width: b.width, sticky: !c.anchored, edge: edges.value[c.item.key] || null, free: !!posOf(c.item.key) }; }),
        links: () => links.value.map((l) => ({ key: l.key, cls: l.cls, d: l.d })),
      };
    }
    return { d, el, pinned, tops, edges, open, cards, links, drag, emptyText, emptyTip, setEl, slotStyle, posOf, pin, unpin, startDrag, eatClick, onDbl, home, EDGE_MARK, EDGE_TIP };
  },
};
export default ReviewRail;
