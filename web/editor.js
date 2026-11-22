// 편집기 하나(docs/V3_SPEC.md §5.2) — rhwp-studio iframe(같은 출처 /studio/) + cowork 플러그인(iframe.contentWindow.rhwpCowork, §1.3).
// mountEditor(el, d) → 손잡이(d.editor, CONTRACT):
//   { ready, focusRange, setActive, applyText, insertParagraphAfter, applyBatch(items)(여러 제안 — 되돌리기 한 번, §9.6), getSelection,
//     anchorToPage(anchor) → 호스트 페이지 좌표,
//     v0.4(docs/V4_SPEC.md §2.5): syncToBase()(편집기 글을 setBase 로 준 기준 글로 — 다시 열지 않음), flash(ranges, { color, scroll })(남이 바꾼 자리 밑줄) }
//   읽기 전용은 s.readOnly → 플러그인 setOptions({ readOnly })(아래 setOptions — s.readOnly 가 바뀌면 다시 보낸다)
//   + 셸·store 용 덧붙임: loading, error, source('draft'|'working'), baseVersion, dirty, locked, reload, saveNow({ force }), saveSoon, cancelSave,
//     draftState, syncDraft(s.draft 를 지금 플러그인 상태로), lock(label) → unlock, carryOver([내 글 옮겨 넣기]), mapping()(기준 지도를 쓰는 중), frame, destroy
//   손잡이의 모든 ref 는 지금 기준(store s.paragraphs) ref 다(머리 주석 8). 모듈은 buildBaseMap(편집기 기준 문단, 지금 기준 문단)도 내보낸다(시험용)
// 수명:
//  1) 열기: GET /drafts/mine(rev) → 수정본이 있으면 GET /drafts/mine/file(X-Base-Version·X-Draft-Rev = 그 바이트의 판), 없으면 GET /file?kind=working(X-Doc-Version)
//     → loadFile → 플러그인 'ready' → setBase({ version, paragraphs: GET /paragraphs?view=final }) → markClean → draftState → setAnnotations
//  2) 플러그인 이벤트: selection → s.sel·s.selection, menu-action → d.emit('menu-action')(셸이 처리), annotation-click/hover → s.active/s.hover
//     (패널 탭은 여백 표식 등 표식을 누를 때만 옮긴다 — 강조된 글에 캐럿만 놓은 것은 강조만, hookFrame),
//     anchors → s.anchors, edited → 자동 저장(쉼 2.5초, 쳐도 15초마다), draft → s.draft(바꾼 문단), editing → POST /editing(1초, 같은 ref 면 안 보냄),
//     key → d.emit('editor-key')(셸: Esc·Ctrl/⌘+Alt+M)
//  3) 자동 저장: exportHwpx → PUT /drafts/mine?base=<기준>&rev=<판> → notifySaved → markClean({ changeSeq: 내보내기 직전 판 }) → s.myCr·s.draft
//     (그새 더 친 글은 dirty 로 남아 다음 저장). 바꾼 문단이 없고 변경 요청도 없으면 서버에 보내지 않는다.
//     rev = 이 창이 마지막으로 읽거나(GET /drafts/mine) 저장해(PUT 응답) 아는 서버 수정본 판. 서버가 409 DRAFT_STALE(그 판 뒤에 다른 곳에서 저장됨)로
//     답하면: 서버 것이 이 창이 아는 것과 같은 내용이면(서명 같음 — 판만 바뀜) 새 판으로 한 번 더 보내고, 다르면 저장을 멈춘다
//     (칩 '다른 곳에서 바뀜' [다시 열기] [이 글로 저장 = rev 없이 덮어쓰기]). 서버가 판을 주지 않으면(옛 서버) rev 없이 보낸다.
//  4) 기준 버전이 바뀌면(store 가 문단·정보를 다시 읽음): 글이 같으면(메모·요청 메모만 늘어남) 조용히 새 기준으로 setBase,
//     글이 다르면 내 수정이 없을 때 스크롤을 기억하고 작업본으로 다시 열고, 있으면 s.draft.behind(칩 '최신 반영 필요') — 정렬은 옛 기준 그대로.
//  5) store 의 메모·제안·변경·요청·변경 요청·타이핑 중이 바뀌면 setAnnotations(100ms 묶음), s.active → setActive, s.focus → focusRange.
//     내가 내 수정본에 반영해 두었고 지금도 편집기 글에 들어간 제안은 status 'adopted' 로 보낸다(강조·'내 수정본에 반영' 항목을 빼게).
//     AI 작업 메모는 내 눈의 진행(§9.7)이 해결이면 resolved(해결된 메모처럼 숨김), 남은 반영 수 open·요청 번호 rid 를 싣는다(우클릭 '남은 제안 모두 반영(n)').
//  6) 서버 내 수정본을 이 창 밖(같은 사람의 다른 창·기기, 관리자)이 바꾸면(WS cr — 서명 비교로 확인, 알림이 늦으면 PUT 의 409 DRAFT_STALE):
//     저장 안 된 편집이 없으면 새 것을 불러오고, 있으면 저장을 멈춘다(s.draft.stale·elsewhere → 칩 [다시 열기]·[이 글로 저장]).
//     덮어쓰기를 서로 모르게 하지 않는다.
//  7) lock(label): 내 수정본을 서버에서 바꾸는 store 동작(반영·닫기·최신 반영 등) 동안 입력을 막는다(iframe inert + 셸 덮개 h.locked).
//     편집기에 파일을 싣는 동안(처음·다시·저절로 다시 열기)도 막는다 — 그 사이 친 글이 옛 문서나 엉뚱한 캐럿 자리로 가지 않게.
//  8) 편집기 기준 ↔ 지금 기준(아래 '기준 지도'): 내 수정본이 옛 기준인 채 다른 사람의 반영으로 기준 글이 바뀌면 플러그인 정렬은 옛 기준
//     (setBase 로 준 문단 목록) 그대로다. store·서버의 ref 는 지금 기준이므로 플러그인과 주고받는 모든 자리(강조·이동·반영·선택·
//     타이핑 중·바꾼 문단)를 이 손잡이에서 옮긴다 — 셸·store 는 언제나 지금 기준 ref 만 본다.
//  9) 다른 곳(같은 사람의 다른 창)에서 최신 반영해 이 창의 옛 기준 글을 저장할 수 없으면(STALE_BASE) 칩 [내 글 옮겨 넣기](carryOver).
// v0.4(docs/V4_SPEC.md §2.4) — 편집기 방식(h.mode)은 열 때 문서 정보(settings·canEdit — web/view.js editorMode)로 정한다:
//  - 'review' = 승인 방식(위 1~9 그대로 — 내 수정본·변경 요청)
//  - 'live'   = 실시간 수정: 작업본(GET /file?kind=working)을 열고, 친 글은 쉼 800ms(쳐도 3초마다) 뒤 PUT /live?base=<기준 기록>&seq=<차례>&loaded=<연 판>로
//               곧바로 공유 문서에 밀어 넣는다(한 번에 하나). 응답이 clean 이면 그 판의 문단(같은 판 읽기)으로 setBase + markClean 만(다시 열지 않음),
//               아니면 맞추기. 409 STALE_BASE 는 저절로 [내 글 옮겨 넣기](carryOver) 뒤 다시 밀어 넣기, 그 밖 실패는 칩 '보내지 못함 — [다시]'(5·10·15초 뒤 저절로)
//  - 'follow' = 수정 권한 없음(어느 방식이든): 읽기 전용(s.readOnly → 플러그인 양식 모드) — 밀어 넣지 않고 남의 고침만 맞추기로 따라간다
//  맞추기(live·follow): 남의 고침(WS doc changed — 내 밀어 넣기는 seq 로 가린다)이나 섞인 밀어 넣기 뒤 '맞춤 대기' → 치는 중이면 기다린다(쉼 700ms,
//  8초가 넘으면 다음 쉼 400ms) → ① 저장 안 된 내 편집 먼저 밀어 넣기 ② 지금 기준 문단(같은 판 읽기)으로 setBase ③ 플러그인 syncToBase(바뀐 문단만 —
//  캐럿·스크롤 그대로, 되돌리기 기록 비움 = Ctrl+Z 는 그 뒤에 친 내 글만) ④ markClean ⑤ 남이 바꾼 자리를 그 사람 색으로 잠깐 밑줄(flash).
//  맞추지 못하면(STRUCTURE·ERROR·UNSUPPORTED, BUSY 가 되풀이됨) 조용히 다시 열기(스크롤·캐럿 되살림 — 플러그인 선택 자리를 새 기준으로 옮겨).
//  '조용한 잠금'은 iframe inert 를 쓰지 않는다(inert 는 편집기 포커스를 빼 맞춘 뒤 이어 친 글이 편집기로 가지 않는다) — 대신 맞추기 직전(같은 작업 안)에
//  판(changeSeq)을 견줘 그새 친 글이 있으면 맞추지 않고 다음 쉼에 다시(먼저 밀어 넣기). syncToBase 는 플러그인 안에서 한 번에 끝나 키 입력이 끼지 않는다.
//  문서 설정이 바뀌면(WS doc settings → s.settings·s.canEdit) 저장 안 된 것을 지금 방식으로 먼저 보내고(못 보내면 새 방식으로 옮겨 넣고) 새 방식으로 다시 연다.
import { reactive, watch, toRaw } from '/vendor/vue.esm-browser.prod.js';
import { createStudio } from '/vendor/rhwp-editor/index.js';
import { state, api, toast, cpLen, cpSlice, josa, docWorkEnv, autoSendLabel } from './util.js';
import { submitDeparture } from './departure-transport.js';
import { buildAnnotations } from './annotations.js';
import { alignOffsets, lcsPairs } from './refmap.js';
import { emptyDraft, adoptionInEffect } from './store.js';
import { editorMode as modeOfInfo, quickAutoSend } from './view.js';
import { requestPhase } from './ui.js';

const IDLE_MS = 2500;        // 자동 저장: 마지막 입력 뒤 쉼
const MAX_MS = 15000;        // 쉬지 않고 쳐도 이 안에 한 번
const EDITING_MS = 1000;     // 타이핑 중 알림 간격
const ANN_MS = 100;          // 강조 다시 보내기 묶음
const READY_MS = 60000;      // 문서를 열고 화면 계산이 끝나기를 기다리는 한도
const RETRY_MS = [5000, 10000, 15000];    // 저장 실패 뒤 저절로 다시 해 보는 간격(세 번까지)
// v0.4 실시간(§2.2·§2.4)
const PUSH_IDLE_MS = 800;    // 밀어 넣기: 마지막 입력 뒤 쉼
const PUSH_MAX_MS = 3000;    // 쉬지 않고 쳐도 이 안에 한 번
const SYNC_IDLE_MS = 700;    // 맞추기: 마지막 입력 뒤 이만큼 쉬면
const SYNC_LATE_MS = 8000;   // 맞춤 대기가 이보다 길면
const SYNC_LATE_IDLE_MS = 400;   // 그때는 이만큼만 쉬어도
const SYNC_RETRY_MS = 150;   // 밀어 넣기·열기 중이면 이만큼 뒤 다시 본다
const SYNC_BUSY_MS = 300;    // 플러그인이 BUSY(한글 조합·머리말 편집 중)면 이만큼 뒤 다시
const SYNC_BUSY_MAX = 10;    // BUSY 가 이만큼 되풀이되면 다시 열기로
const EVENTS = ['ready', 'selection', 'menu-action', 'annotation-click', 'annotation-hover', 'anchors', 'edited', 'draft', 'editing', 'key'];
const DOCUMENT_INPUT = 'textarea[aria-label="문서 편집 입력"], [contenteditable="true"][aria-label="문서 편집 입력"]';

/** 이 동작의 WS cr 알림은 서버 내 수정본(작성자 = 나)의 글·상태를 바꾼다 → 이 창이 아는 것과 같은지 확인한다 */
const MINE_ACTIONS = new Set(['draft', 'deleted', 'rebased', 'reopened', 'closed', 'merged']);
/** 남이 내 변경 요청에 한 일 → [알림 글, 칩 글] */
const ELSEWHERE_KO = { merged: ['반영되었습니다', '반영됨'], closed: ['닫혔습니다', '닫힘'], reopened: ['다시 열렸습니다', '다시 열림'], deleted: ['지워졌습니다', '지워짐'], rebased: ['최신으로 맞춰졌습니다', '최신으로 맞춤'] };

/** Vue 프록시·다른 realm 에서 떼어 낸 JSON 사본(플러그인과는 JSON 으로만 주고받는다, §1.3) */
const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * 서버 내 수정본의 서명: 변경 요청 번호·기준 버전·덩어리 hid(종류·자리·새 글의 해시, engine/doc.js). 없으면 'none'.
 * GET /drafts/mine 과 PUT 응답의 CRView 로 만든다 — 같으면 같은 수정본(검토 요청·제목 고치기 등은 바꾸지 않는다)
 */
const draftSig = (cr) => (cr ? `${cr.cid}@${Number(cr.baseVersion) || 0}:${(Array.isArray(cr.hunks) ? cr.hunks : []).map((x) => x.hid).join(',')}` : 'none');
/** 서버 수정본 판(rev, 사람·문서마다 늘기만 하는 수) — GET /drafts/mine·PUT 응답의 rev(없으면 file·cr 의 것). 모르면 null(→ rev 없이 보낸다) */
function revOf(x) {
  const v = x?.rev ?? x?.file?.rev ?? x?.cr?.rev;
  return v === undefined || v === null || v === '' ? null : v;
}
/** 409 DRAFT_STALE 로 저장을 멈췄을 때 칩 글·설명 */
const STALE_LABEL = '다른 곳에서 바뀜';
const STALE_TIP = '내 수정본이 다른 곳(같은 계정의 다른 창·기기 등)에서 먼저 저장되어 이 창 글은 저장하지 않았습니다. '
  + '[다시 열기]: 서버의 지금 수정본을 불러옴(여기서 친 글은 버림) · [이 글로 저장]: 이 창 글로 덮어씀';
/**
 * 서버 내 수정본이 이 창보다 새 기준으로 바뀌었다(다른 창의 [최신 반영] 등) — 이 창의 옛 기준 글로는 덮어쓸 수 없다(서버 409 STALE_BASE).
 * 칩: '<label> —' [다시 열기] [내 글 옮겨 넣기](carryOver)
 */
// (n = 서버 수정본의 기준 기록 번호 — 사람에게 내지 않는다, §9.1)
const rebasedTip = (where, n) => `${where} 내 수정본을 최신으로 맞춰, 이 창의 옛 버전 글로는 덮어쓸 수 없습니다. `
  + '[내 글 옮기기]: 서버의 지금 수정본을 열고 이 창에서 고친 문단을 그 위에 다시 넣음(그 사이 다른 곳에서도 바뀐 문단은 덮어쓰지 않고 바로 뒤에 따로 넣음) · '
  + '[다시 열기]: 서버의 지금 수정본을 불러옴(여기서 친 글은 버림)';
/** 플러그인 DraftState → s.draft 의 바꾼 문단 칸(없으면 빈 것). count 를 주면 그것(기준 지도로 옮기다 짝을 잃은 문단도 센다) */
function draftFields(p) {
  const changed = Array.isArray(p?.changed) ? p.changed : []; const inserted = Array.isArray(p?.inserted) ? p.inserted : []; const deleted = Array.isArray(p?.deleted) ? p.deleted : [];
  return { changed, inserted, deleted, count: Number.isInteger(p?.count) ? p.count : changed.length + inserted.length + deleted.length };
}

/**
 * 기준 문단 목록의 글 서명 — 메모 본문은 빼고, ref 도 빼고(메모를 달면 그 문단 안 중첩 번호가 밀린다) 문서 순서의 글·칸 자리만.
 * 서명이 같으면 새 버전은 메모·요청·제안 메모만 늘어난 것(본문 글은 그대로)이다.
 */
function textSig(paragraphs) {
  const out = [];
  for (const p of Array.isArray(paragraphs) ? paragraphs : []) {
    if (!p || p.where === '메모') continue;
    out.push(`${p.parent ? 'n' : 'b'}\u0001${p.cell ? `${p.cell.row},${p.cell.col}` : ''}\u0001${p.text ?? ''}`);
  }
  return out.join('\u0002');
}

// ───────── 기준 지도: 편집기 기준(플러그인 setBase 의 문단 목록) ↔ 지금 기준(store s.paragraphs) ─────────
// 본문은 구역마다 글·종류·구조(kind·sig)가 같은 문단끼리 짝짓고(앞뒤 같은 부분을 떼고 가운데는 LCS), 짝 사이 바뀐 덩어리 안은
// engine/diff.js planBody(alignBlock)처럼 비슷한 글끼리 차례를 지켜 짝짓는다(같은 수면 차례로) — 서버가 기준 버전 사이 ref 를 옮기는 규칙과 같은 꼴.
// 중첩 문단(표 칸·캡션·글상자)은 짝지은 본문 문단의 중첩 구조(깊이·담는 요소·표 순번·행·열)가 같으면 같은 자리로, 다르면 자리·글이 같은 것끼리.
// 문단 안 offset 은 두 글이 다를 때만 refmap.alignOffsets 로 옮긴다(범위 끝은 마지막 글자 바로 뒤 — 플러그인 toCurEnd 와 같다).

const REF_PARTS = /^s(\d+)\/p(\d+)((?:\/n\d+)*)$/;
const TEXTUAL_KINDS = new Set(['text', 'empty']);
const GAP_PAIR_LIMIT = 2500;   // engine/diff.js PAIR_LIMIT 과 같은 값(바뀐 덩어리가 이보다 크면 차례로)
const LCS_LIMIT = 4e6;         // 가운데 LCS 표 칸 수 한도(넘으면 같은 문단 짝 없이 차례로)

/** 두 글의 비슷한 정도(두 글자 묶음 Dice — engine/diff.js similarity 와 같은 규칙) */
function similarity(x, y) {
  x = String(x ?? ''); y = String(y ?? '');
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let k = 0; k < x.length - 1; k++) { const g = x.slice(k, k + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hit = 0;
  for (let k = 0; k < y.length - 1; k++) { const g = y.slice(k, k + 2); const c = grams.get(g); if (c) { hit++; grams.set(g, c - 1); } }
  return (2 * hit) / (x.length + y.length - 2);
}

/** 문단 목록(GET /paragraphs) → { byRef, bodies[구역][번호], nested: 본문 ref → 중첩 문단(문서 순서), nestedAt: 중첩 ref → 그 목록 번호 } */
function indexParas(list) {
  const byRef = new Map(); const bodies = []; const nested = new Map(); const nestedAt = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.ref !== 'string' || p.where === '메모' || byRef.has(p.ref)) continue;
    const m = REF_PARTS.exec(p.ref); if (!m) continue;
    byRef.set(p.ref, p);
    const sec = Number(m[1]); const bi = Number(m[2]);
    if (!m[3]) { (bodies[sec] ??= [])[bi] = p; continue; }
    const top = `s${sec}/p${bi}`;
    let l = nested.get(top); if (!l) nested.set(top, (l = []));
    nestedAt.set(p.ref, l.length); l.push(p);
  }
  // 빈 자리(목록에 없는 본문 번호)는 빈 문단으로 메운다 — 번호가 곧 자리라서(플러그인 align.ts 와 같다)
  for (let s = 0; s < bodies.length; s++) { const l = bodies[s] ?? (bodies[s] = []); for (let i = 0; i < l.length; i++) if (!l[i]) l[i] = { ref: `s${s}/p${i}`, text: '', kind: 'empty' }; }
  return { byRef, bodies, nested, nestedAt };
}

/** 본문 문단 → 짝짓기 항목: key = 종류·구조·글(같으면 같은 문단), cls = 짝지을 수 있는 종류 묶음(글·빈 줄은 하나) */
function bodyEntry(p) {
  const text = String(p?.text ?? ''); const kind = p?.kind ? String(p.kind) : (text ? 'text' : 'empty'); const sig = p?.sig ?? '';
  return { key: `${kind}\u0001${sig}\u0001${text}`, text, cls: TEXTUAL_KINDS.has(kind) ? 'text' : kind, sig };
}

/** 바뀐 덩어리(A[i0..i1) × B[j0..j1)) 안의 짝: 같은 수면 차례로, 아니면 짧은 쪽을 모두 긴 쪽과 차례를 지켜 비슷한 글끼리(alignBlock) */
function pairGap(A, B, i0, i1, j0, j1) {
  const r = i1 - i0; const a = j1 - j0; const n = Math.min(r, a); const out = [];
  if (!n) return out;
  const fits = (i, j) => A[i].cls === B[j].cls || (!!A[i].sig && A[i].sig === B[j].sig);
  if (r === a || r * a > GAP_PAIR_LIMIT) { for (let k = 0; k < n; k++) if (fits(i0 + k, j0 + k)) out.push([i0 + k, j0 + k]); return out; }
  const shortA = r < a; const S = shortA ? r : a; const L = shortA ? a : r;
  const sim = (si, lj) => (shortA ? similarity(A[i0 + si].text, B[j0 + lj].text) : similarity(A[i0 + lj].text, B[j0 + si].text));
  const f = Array.from({ length: S + 1 }, () => new Float64Array(L + 1).fill(-Infinity));
  for (let j = 0; j <= L; j++) f[0][j] = 0;
  for (let i = 1; i <= S; i++) for (let j = i; j <= L; j++) f[i][j] = Math.max(f[i][j - 1], f[i - 1][j - 1] + sim(i - 1, j - 1));
  const matched = []; let i = S; let j = L;
  while (i > 0) { if (j > i && f[i][j] === f[i][j - 1]) j--; else { matched.push([i - 1, j - 1]); i--; j--; } }
  matched.reverse();
  for (const [si, lj] of matched) { const ai = shortA ? i0 + si : i0 + lj; const bj = shortA ? j0 + lj : j0 + si; if (fits(ai, bj)) out.push([ai, bj]); }
  return out;
}

/** 한 구역 본문 짝 [[A 번호, B 번호]](문서 순서) */
function pairBodies(A, B) {
  const n = A.length; const m = B.length; const out = [];
  let pre = 0; while (pre < n && pre < m && A[pre].key === B[pre].key) { out.push([pre, pre]); pre++; }
  let suf = 0; while (suf < n - pre && suf < m - pre && A[n - 1 - suf].key === B[m - 1 - suf].key) suf++;
  const a1 = n - suf; const b1 = m - suf;
  if (a1 > pre && b1 > pre) {
    const exact = (a1 - pre) * (b1 - pre) <= LCS_LIMIT ? lcsPairs(A.slice(pre, a1), B.slice(pre, b1), (x, y) => x.key === y.key) : [];
    let pi = pre; let pj = pre;
    for (const [x, y] of exact) { const i = x + pre; const j = y + pre; out.push(...pairGap(A, B, pi, i, pj, j)); out.push([i, j]); pi = i + 1; pj = j + 1; }
    out.push(...pairGap(A, B, pi, a1, pj, b1));
  }
  for (let k = suf; k > 0; k--) out.push([n - k, m - k]);
  return out;
}

/** 중첩 문단 구조 열쇠: 깊이·담는 요소·(표 칸이면) 표 순번@행,열 — ref 번호는 메모가 끼면 밀리므로 쓰지 않는다 */
function nestKey(p) {
  const depth = (String(p.ref).match(/\/n\d+/g) || []).length; const c = p.cell;
  return `${depth}|${p.container ?? ''}|${c ? `${/#t(\d+)$/.exec(String(c.table ?? ''))?.[1] ?? ''}@${c.row},${c.col}` : ''}`;
}
/** 짝지은 두 본문 문단의 중첩 문단 짝: L1 번호 → L2 번호 */
function pairNested(L1, L2) {
  const out = new Map();
  if (L1.length === L2.length && L1.every((p, k) => nestKey(p) === nestKey(L2[k]))) { for (let k = 0; k < L1.length; k++) out.set(k, k); return out; }
  const strong = L1.length * L2.length <= LCS_LIMIT ? lcsPairs(L1, L2, (a, b) => nestKey(a) === nestKey(b) && String(a.text ?? '') === String(b.text ?? '')) : [];
  let pi = 0; let pj = 0;
  const fill = (i2, j2) => {
    let j = pj;
    for (let i = pi; i < i2 && j < j2; i++) for (let k = j; k < j2; k++) if (nestKey(L1[i]) === nestKey(L2[k])) { out.set(i, k); j = k + 1; break; }
  };
  for (const [i, j] of strong) { fill(i, j); out.set(i, j); pi = i + 1; pj = j + 1; }
  fill(L1.length, L2.length);
  return out;
}

/** 글 t 에서 find 의 occ 번째 자리(겹쳐도 셈 — annotations.findRange 와 같다), 코드포인트. 없으면 -1 */
function nthAt(t, find, occ) {
  let at = -1; let from = 0;
  for (let k = 0; k < Math.max(1, occ || 1); k++) { at = t.indexOf(find, from); if (at < 0) return -1; from = at + 1; }
  return cpLen(t.slice(0, at));
}
/** 글 t 에서 코드포인트 자리 cp 에 가장 가까운 find 가 몇 번째인지(1부터). 없으면 0 */
function occNear(t, find, cp) {
  let best = 0; let bestD = Infinity; let k = 0; let from = 0;
  for (;;) {
    const at = t.indexOf(find, from); if (at < 0) break;
    k++; const d = Math.abs(cpLen(t.slice(0, at)) - cp);
    if (d < bestD) { bestD = d; best = k; }
    from = at + 1;
  }
  return best;
}

/**
 * 편집기 기준(ePars)과 지금 기준(cPars) 사이 지도. 두 목록이 같으면(본문·중첩 글과 ref 가 모두 같음) null(그대로 쓴다).
 * dir 'c' = 편집기 기준 → 지금 기준(플러그인 → store·서버), 'e' = 지금 기준 → 편집기 기준(store → 플러그인)
 */
export function buildBaseMap(ePars, cPars) {
  const E = indexParas(ePars); const C = indexParas(cPars);
  const e2c = []; const c2e = []; let same = true;
  for (let s = 0; s < Math.max(E.bodies.length, C.bodies.length); s++) {
    const A = (E.bodies[s] || []).map(bodyEntry); const B = (C.bodies[s] || []).map(bodyEntry);
    if (A.length !== B.length || A.some((x, i) => x.key !== B[i].key)) same = false;
    const a2b = new Int32Array(A.length).fill(-1); const b2a = new Int32Array(B.length).fill(-1);
    for (const [i, j] of pairBodies(A, B)) { a2b[i] = j; b2a[j] = i; }
    e2c[s] = a2b; c2e[s] = b2a;
  }
  if (same) {
    const keys = new Set([...E.nested.keys(), ...C.nested.keys()]);
    for (const k of keys) {
      const x = E.nested.get(k) || []; const y = C.nested.get(k) || [];
      if (x.length !== y.length || x.some((p, i) => p.ref !== y[i].ref || String(p.text ?? '') !== String(y[i].text ?? ''))) { same = false; break; }
    }
  }
  if (same) return null;
  const side = (dir) => (dir === 'c' ? { from: E, to: C, map: e2c } : { from: C, to: E, map: c2e });
  const textIn = (idx, r) => String(idx.byRef.get(r)?.text ?? '');
  const nestCache = new Map(); const offCache = new Map();
  /** ref 하나 → 저쪽 ref(짝 없으면 null) */
  function ref(dir, r) {
    const m = REF_PARTS.exec(String(r ?? '')); if (!m) return null;
    const { from, to, map } = side(dir);
    const s = Number(m[1]); const i = Number(m[2]);
    const j = map[s] && i < map[s].length ? map[s][i] : -1;
    if (j < 0) return null;
    const top = `s${s}/p${j}`;
    if (!m[3]) return top;
    const k = from.nestedAt.get(r); if (k == null) return null;
    const ck = `${dir}|s${s}/p${i}|${top}`;
    let pairs = nestCache.get(ck);
    if (!pairs) nestCache.set(ck, (pairs = pairNested(from.nested.get(`s${s}/p${i}`) || [], to.nested.get(top) || [])));
    const k2 = pairs.get(k);
    return k2 == null ? null : to.nested.get(top)[k2].ref;
  }
  /** 문단을 넣을 자리(afterRef): 짝이 있으면 그것, 없으면 같은 구역에서 앞쪽으로 가장 가까운 짝 본문 문단(없으면 null = 구역 맨 앞) */
  function after(dir, r) {
    if (r == null) return null;
    const direct = ref(dir, r); if (direct) return direct;
    const m = /^s(\d+)\/p(\d+)/.exec(String(r)); if (!m) return null;
    const arr = side(dir).map[Number(m[1])]; if (!arr) return null;
    for (let i = Math.min(Number(m[2]), arr.length - 1); i >= 0; i--) if (arr[i] >= 0) return `s${m[1]}/p${arr[i]}`;
    return null;
  }
  /** r1(이쪽 글) offset → r2(저쪽 글) offset 표(글이 같으면 null) */
  function offMap(dir, r1, r2) {
    const { from, to } = side(dir);
    const t1 = textIn(from, r1); const t2 = textIn(to, r2);
    if (t1 === t2) return null;
    const ck = `${dir}|${r1}|${r2}`; const hit = offCache.get(ck);
    if (hit && hit.t1 === t1 && hit.t2 === t2) return hit.m;
    const m = alignOffsets(t1, t2).a2b; offCache.set(ck, { t1, t2, m });
    return m;
  }
  function point(dir, r1, r2, off) {
    const len2 = cpLen(textIn(side(dir).to, r2)); const o = Math.max(0, Number(off) || 0);
    const m = offMap(dir, r1, r2);
    if (!m) return Math.min(o, len2);
    return Math.max(0, Math.min(len2, m[Math.min(m.length - 1, o)]));
  }
  function end(dir, r1, r2, start, e) {
    const v = point(dir, r1, r2, e); const m = offMap(dir, r1, r2);
    if (!m || !(e > start) || e < 1) return v;
    const last = m[Math.max(0, Math.min(m.length - 1, e - 1))];
    return last < v ? Math.max(0, Math.min(v, last + 1)) : v;
  }
  /** 범위 { ref, start?, end?, endRef? }(그 밖의 칸은 그대로) → 저쪽. 시작 문단 짝이 없으면 null, 끝 문단 짝만 없으면 시작 문단 끝까지 */
  function range(dir, x) {
    if (!x) return null;
    const r = ref(dir, x.ref); if (!r) return null;
    const out = { ...x, ref: r };
    const s0 = x.start != null ? Number(x.start) || 0 : null;
    if (s0 != null) out.start = point(dir, x.ref, r, s0);
    const er = x.endRef != null && x.endRef !== x.ref ? x.endRef : null;
    if (er) {
      const r2 = ref(dir, er);
      if (r2) { out.endRef = r2; if (x.end != null) out.end = end(dir, er, r2, 0, Number(x.end) || 0); } else { out.endRef = r; out.end = cpLen(textIn(side(dir).to, r)); }
    } else {
      if (x.endRef != null) out.endRef = r;
      if (x.end != null) out.end = end(dir, x.ref, r, s0 ?? 0, Number(x.end) || 0);
    }
    return out;
  }
  return {
    ref, after, point, end, range,
    /** 편집기 기준 글 · 지금 기준 글 */
    textE: (r) => textIn(E, r), textC: (r) => textIn(C, r),
  };
}

/** 인증 머리글을 붙여 파일 바이트와 머리글을 받는다(실패하면 서버 오류 글로 던진다) */
async function fetchBytes(path) {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` }, cache: 'no-store' });
  if (!r.ok) {
    let data = null; try { data = await r.json(); } catch { /* 본문 없음 */ }
    throw Object.assign(new Error(data?.message || `HTTP ${r.status}`), { status: r.status, code: data?.error, data });
  }
  return { bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers };
}

/**
 * @param el 편집기를 넣을 요소(iframe 이 100% 로 들어간다)
 * @param d 문서 store(web/store.js) — d.editor 에 손잡이를 단다
 */
export function mountEditor(el, d, { foreground = true } = {}) {
  const s = d.s;
  let studio = null; let cw = null; let iframe = null; let destroyed = false;
  const offs = []; const stops = [];
  let loadGen = 0;
  // 진행 중인 저절로 다시 열기의 loadGen(없으면 0). 그동안 기준이 또 바뀌어도 새로 열지 않는다 — 여는 쪽이 끝에서
  // onBaseMaybeChanged 로 다시 본다. (2026-11-04) 없을 때는 다시 열기가 applyInfo 로 s.info 를 갈아 감시를 깨우고,
  // 감시가 새 열기를 불러 앞 열기를 그만두게 하는 고리가 끝없이 돌았다(서식 커밋 뒤 20초에 약 2,000번, 매번 작업본 전체 받기).
  let autoOpening = 0;
  let previewOpenActive = false; let previewDocumentGeneration = -1;
  // 편집기 기준: 버전·글 서명(textSig, 같은 버전에서 읽었을 때만)·플러그인 setBase 로 준 문단 목록(pars — 기준 지도의 한쪽)
  let base = { version: 0, sig: '', pars: null };
  let loadedFormatVersion = 0; // 마지막으로 실제 HWPX 파일에서 읽은 서식 판(글만 맞추기로는 올리지 않는다)
  // 편집기 문서를 연 작업본의 판(2026-11-04): 메모만 바뀐 판은 다시 열지 않고 기준만 옮기므로(quietAdvance·맞추기) 편집기 문서의 메모는 이 판의 것
  // (+ 이 창이 밀어 넣어 바꾼 것)이다 — 밀어 넣기에 ?loaded= 로 실어 서버가 남이 단 메모를 지우거나 남이 지운 메모를 되살리지 않게 한다(server/live.js _memoKnown)
  let loadedVersion = 0;
  let mapMemo = { e: null, c: null, m: null };
  // 자동 저장
  let saveTimer = null; let firstEditAt = 0; let lastSeq = 0; let savedSeq = 0; let saving = null; let again = false; let failCount = 0;
  // 타이핑 중 알림
  let editRef = null; let editPending; let editSentAt = 0; let editTimer = null;
  let annTimer = null;
  // 서버 내 수정본 확인: known = 이 창이 마지막으로 읽거나 저장해 만든 서버 상태의 서명(draftSig), saveGen = 보낸 PUT 수,
  // trigger = 확인을 부른 WS 알림(누가·무엇을 — 칩·알림 글에 씀), rev = 이 창이 아는 서버 수정본 판(PUT 의 rev — 머리 주석 3)
  let known = null; let saveGen = 0; let checkTimer = null; let checkTries = 0; let trigger = null; let rev = null;
  let locks = 0; let holds = 0; const lockLabels = [];
  let carrying = false;
  // 편집기 안에서 마지막으로 누른 곳(표식인가) — 'annotation-click' 이 패널 탭을 옮길지(hookFrame)
  let markDown = null; let hookedWin = null;
  // 서버 내 수정본에 들어 있다고 이 창이 아는(마지막으로 열거나 저장한) 내 수정 모습 — 바꾼 문단 글(편집기 기준 ref → 글)·넣은 문단 글·지운 문단.
  // [내 글 옮겨 넣기](carryOver)가 이 창에서 그 뒤에 고친 것만 옮기고, 다른 곳에서 다시 맞춘 수정본의 그 문단이 '이 창이 알던 글 그대로'인지 본다
  let savedShape = { texts: new Map(), inserted: new Set(), deleted: new Set() };
  // v0.4 실시간(머리 주석 v0.4): 방식, 밀어 넣기(타이머·진행 중·실패 수·차례), 이 창이 보낸 차례(WS 알림에서 내 것을 가린다), 마지막 입력 시각,
  // 맞춤 대기 { version, since, by: ref → 고친 사람, last, force }·타이머·진행 중, 방식 바꾸기
  let mode = 'review';
  let pushTimer = null; let pushFirstAt = 0; let pushing = null; let pushAgain = false; let pushFails = 0; let pushNo = 0;
  const seqBase = (Math.floor(Math.random() * 900000) + 1000) * 1000;   // 창마다 다른 시작(차례는 진단용 정수 — 같은 사람의 두 창이 겹치지 않게)
  const mySeqs = new Set();
  let lastInputAt = 0;
  let syncWant = null; let syncTimer = null; let syncRun = null; let syncBusyTries = 0;
  let switching = false; let switchAgain = false;
  let warnedUnsupported = false;

  // 셸·store 와는 지금 기준 ref 로, 플러그인과는 편집기 기준 ref 로(머리 주석 8 — 기준이 같으면 그대로 넘긴다)
  let acceptedSave = null;
  const h = reactive({
    editRevision: () => lastSeq,
    departureReceived: () => acceptedSave?.gen === loadGen && acceptedSave.seq === lastSeq && !s.draft.error && !s.draft.stale,
    ready: false, loading: true, previewReady: false, previewPages: 0, previewPageCount: null,
    error: '', notice: '', source: '', baseVersion: 0, dirty: false,
    mode: 'review',  // v0.4: 'review' | 'live' | 'follow'(머리 주석 v0.4)
    syncing: false,  // v0.4: 남의 고침을 맞추는 중
    opens: 0,        // 편집기에 파일을 실은 횟수(시험 — 맞추기는 다시 열지 않는다)
    locked: '',      // 잠금 글(잠근 동안 셸이 편집기를 덮는다) — lock()
    focusRange: (p) => { const q = rangeToEd(p); return q ? call('focusRange', q, false) : Promise.resolve(false); },
    setActive: (p) => call('setActive', p ? { kind: String(p.kind), id: String(p.id) } : null, undefined),
    applyText: (p) => { const q = applyToEd(p); return q ? call('applyText', q, { ok: false, reason: 'READONLY' }) : Promise.resolve({ ok: false, reason: 'NO_PARAGRAPH' }); },
    insertParagraphAfter: (p) => { const q = afterToEd(p); return q ? call('insertParagraphAfter', q, { ok: false, reason: 'READONLY' }) : Promise.resolve({ ok: false, reason: 'NO_PARAGRAPH' }); },
    applyBatch: (items) => applyBatch(items),
    /** 넣기 인자 skip(같은 기준 문단 뒤 내 초안 건너뛰기)을 쓸 수 있는가 — 옛 편집기 빌드면 false(store 가 예전 길로) */
    canInsertSkip: () => insertSkipOk(),
    applyFormatProposal,
    syncToBase: () => syncToBase(),
    flash: (ranges, opts) => flash(ranges, opts),
    getSelection: async () => selToCur(await call('getSelection', undefined, null)),
    draftState: async () => draftToCur(await call('draftState', undefined, null)),
    syncDraft,
    anchorToPage,
    reload: (o) => open(o || {}),
    saveNow, saveSoon, cancelSave, destroy, lock, carryOver, setForeground, focusDocumentInput,
    /** 시험·문제 찾기용: 지금 쓰는 기준 지도가 있는가(편집기 기준 ≠ 지금 기준) */
    mapping: () => !!edMap(),
    frame: () => iframe,
    /** 편집기 메뉴·도구 막대·상태 줄 보이기({ menu, toolbar, statusbar } 중 넘긴 것만 — 좁은 화면에서 문서 칸을 넓히려고) → 적용 뒤 상태(못 하면 null) */
    setChrome: (v) => (studio?.chrome ? Promise.resolve(studio.chrome.set(v)).catch(() => null) : Promise.resolve(null)),
  });
  d.editor = h;

  // 첫 쪽은 보이되 전체 조판과 협업 기준 설정 전에는 편집/저장을 열지 않는다.
  const onProgressiveOpen = (event) => {
    if (destroyed || event.origin !== location.origin || event.source !== iframe?.contentWindow
        || !previewOpenActive || !h.loading || h.ready) return;
    const message = event.data;
    if (message?.type === 'cowork-document-preview') {
      const generation = Number(message.documentGeneration);
      const pages = Number(message.pages);
      if (!Number.isSafeInteger(generation) || generation < previewDocumentGeneration
          || !Number.isSafeInteger(pages) || pages < 1) return;
      previewDocumentGeneration = generation;
      h.previewReady = true; h.previewPages = pages;
      applyInert();
    } else if (message?.type === 'cowork-document-pagination' && message.complete === true) {
      if (!h.previewReady || Number(message.documentGeneration) !== previewDocumentGeneration) return;
      const count = Number(message.pageCount);
      if (Number.isSafeInteger(count) && count > 0) h.previewPageCount = count;
    }
  };
  window.addEventListener('message', onProgressiveOpen);
  stops.push(() => window.removeEventListener('message', onProgressiveOpen));

  async function call(name, arg, fallback) {
    if (!cw || destroyed) return fallback;
    const fn = cw[name];
    if (typeof fn !== 'function') return fallback;
    try { return await (arg === undefined ? fn() : fn(plain(arg))); } catch (e) { console.warn(`[editor] ${name}:`, e); return fallback; }
  }

  /** 잠금·입력 막기가 하나라도 있으면 iframe 을 inert 로(포커스가 안에 있으면 먼저 뺀다 — 키 입력이 편집기로 가지 않게) */
  function applyInert() {
    const on = !foreground || locks + holds > 0 || (h.loading && h.previewReady);
    try { if (iframe) { if (on && document.activeElement === iframe) iframe.blur(); iframe.inert = on; } } catch { /* iframe 없음 */ }
  }
  function setForeground(value) {
    foreground = value;
    applyInert();
    if (!foreground) { editPending = null; flushEditing(); }
  }
  function focusDocumentInput() {
    if (destroyed || !foreground || !h.ready || h.loading || h.locked || !iframe || iframe.inert) return false;
    try {
      const doc = iframe.contentDocument;
      if (!doc || doc.querySelector('dialog[open], .modal-overlay, [aria-modal="true"]')) return false;
      const input = doc.querySelector(DOCUMENT_INPUT);
      if (!input) return false;
      // 기존 캐럿과 선택을 그대로 두고 실제 키 입력만 Studio로 돌려보낸다.
      input.focus({ preventScroll: true });
      return doc.activeElement === input && document.activeElement === iframe;
    } catch { return false; }
  }
  /**
   * 편집기 잠그기 → 푸는 함수(여러 번 불러도 한 번만 푼다). 잠근 동안 iframe 은 inert(입력·포커스·우클릭 없음)이고
   * 셸이 h.locked 글로 편집기를 덮는다. 내 수정본을 서버에서 바꾸고 편집기를 다시 여는 사이에 친 글이 사라지지 않게 한다.
   * 겹쳐 잠그면 나중 글이 보이고, 그것을 풀면 앞 글로 돌아간다. o.silent: 글 없이 입력만 막는다(h.locked 는 그대로 — 셸이
   * '불러오는 중'을 따로 보일 때, 편집기에 파일을 싣는 동안)
   */
  function lock(label = '잠시 기다리세요…', o = {}) {
    const silent = !!o?.silent; const entry = { label: String(label) };
    if (silent) holds++; else { locks++; lockLabels.push(entry); h.locked = entry.label; }
    applyInert();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (silent) holds = Math.max(0, holds - 1);
      else {
        locks = Math.max(0, locks - 1);
        const i = lockLabels.indexOf(entry); if (i >= 0) lockLabels.splice(i, 1);
        h.locked = locks && lockLabels.length ? lockLabels[lockLabels.length - 1].label : '';
      }
      applyInert();
    };
  }

  // ───────── 기준 지도(머리 주석 8) ─────────

  /** 지금 쓰는 기준 지도(편집기 기준 = 지금 기준이면 null). 두 목록이 그대로면 지난 것을 다시 쓴다 */
  function edMap() {
    const e = base.pars; const c = toRaw(s.paragraphs);
    if (!e || !Array.isArray(c) || !c.length || e === c) return null;
    if (mapMemo.e === e && mapMemo.c === c) return mapMemo.m;
    let m = null;
    try { m = buildBaseMap(e, c); } catch (err) { console.warn('[editor] 기준 지도:', err); m = null; }
    mapMemo = { e, c, m };
    return m;
  }
  /** 표 열쇠('<문단 ref>#t<n>')의 문단을 옮긴다(짝 없으면 null) */
  function tableKeyTo(M, dir, key) {
    const m = /^(s\d+\/p\d+(?:\/n\d+)*)(#t\d+)$/.exec(String(key ?? ''));
    if (!m) return key ?? null;
    const r = M.ref(dir, m[1]);
    return r ? `${r}${m[2]}` : null;
  }
  /** 지금 기준 범위 → 편집기 기준(focusRange 등 — 그 밖의 칸은 그대로). 짝이 없으면 null */
  function rangeToEd(p) {
    const M = edMap();
    if (!M || !p || typeof p !== 'object' || !p.ref) return p;
    return M.range('e', p);
  }
  /**
   * applyText 인자(지금 기준) → 편집기 기준. 범위(start/end)가 있으면 옮기고, find 만 있으면 지금 글에서 그 차례의 자리를 찾아 범위로 옮겨
   * 함께 준다(플러그인은 그 자리 글이 find 와 같으면 그대로, 아니면 편집기 기준 글의 가장 가까운 차례로 찾는다)
   */
  function applyToEd(p) {
    const M = edMap();
    if (!M || !p || typeof p !== 'object') return p;
    const ref = M.ref('e', p.ref); if (!ref) return null;
    const q = { ...p, ref };
    if (p.start != null && p.end != null) {
      q.start = M.point('e', p.ref, ref, p.start); q.end = M.end('e', p.ref, ref, Number(p.start) || 0, Number(p.end) || 0);
    } else if (p.find) {
      const find = String(p.find); const at = nthAt(M.textC(p.ref), find, Number(p.occurrence) || 1);
      if (at >= 0) {
        q.start = M.point('e', p.ref, ref, at); q.end = M.end('e', p.ref, ref, at, at + cpLen(find));
        const occ = occNear(M.textE(ref), find, q.start); if (occ) q.occurrence = occ;
      }
    }
    return q;
  }
  /** 편집기 플러그인이 넣기의 skip 인자를 아는가(window.rhwpCowork.features 에 'insertSkip' — PLUGIN_VERSION 0.4.1 부터, 2026-11-17) */
  function insertSkipOk() {
    try { return !!cw && !destroyed && Array.isArray(cw.features) && cw.features.includes('insertSkip'); } catch { return false; }
  }
  /** insertParagraphAfter 인자 → 편집기 기준(그 문단이 편집기 기준에 없으면 null) */
  function afterToEd(p0) {
    // skip(앞 차례 형제의 내 초안 글 — 2026-11-17 §10.4 나-3)은 그 인자를 아는 플러그인(0.4.1 'insertSkip')에만 — 옛 편집기 빌드에는 예전 인자 그대로
    let p = p0;
    if (p && typeof p === 'object' && 'skip' in p && !insertSkipOk()) { p = { ...p }; delete p.skip; }
    const M = edMap();
    if (!M || !p || typeof p !== 'object') return p;
    const af = M.ref('e', p.afterRef);
    return af ? { ...p, afterRef: af } : null;
  }
  /**
   * 여러 제안을 내 수정본에 한 번에(§9.6 — 플러그인 applyBatch: 트랜잭션 하나 = studio 되돌리기 한 번). 항목마다 기준 지도로 편집기 기준에
   * 옮기고(op 'insert' 는 afterToEd, 그 밖은 applyToEd) 옮기지 못한 항목은 보내지 않고 그 자리 결과를 NO_PARAGRAPH 로 채운다.
   * → { ok, applied, results: [{ key, ok, reason? }], reason?, message? } — results 는 받은 items 순서, key 는 받은 것(없으면 items 안 번호 0부터).
   * 플러그인에 applyBatch 가 없으면(옛 편집기 빌드) 모두 UNSUPPORTED, 플러그인이 답하지 못하면(편집기 없음) 보낸 항목은 READONLY(applyText 손잡이와 같다)
   */
  async function applyBatch(items) {
    const list = Array.isArray(items) ? items : [];
    const results = new Array(list.length);
    // 옛 편집기 빌드(플러그인에 applyBatch 가 없음 — PLUGIN_VERSION 0.3.0 이전)는 읽기 전용(READONLY)이 아니라 UNSUPPORTED 로 알린다
    // (store 가 'npm run build:studio 로 다시 빌드' 안내를 띄운다)
    if (cw && !destroyed && typeof cw.applyBatch !== 'function') {
      const results0 = list.map((it, k) => ({ key: it && typeof it === 'object' && it.key != null ? it.key : k, ok: false, reason: 'UNSUPPORTED' }));
      return { ok: false, applied: 0, results: results0, reason: 'UNSUPPORTED' };
    }
    const send = []; const at = [];
    list.forEach((it, k) => {
      const obj = !!it && typeof it === 'object';
      const key = obj && it.key != null ? it.key : k;
      const q = obj ? (it.op === 'insert' ? afterToEd(it) : applyToEd(it)) : null;
      if (q) { send.push({ ...q, key }); at.push(k); } else results[k] = { key, ok: false, reason: 'NO_PARAGRAPH' };
    });
    const r = send.length ? await call('applyBatch', send, null) : { ok: true };
    const got = Array.isArray(r?.results) ? r.results : [];
    at.forEach((k, i) => {
      const x = got[i];
      results[k] = x && typeof x === 'object' ? { ...x, key: send[i].key } : { key: send[i].key, ok: false, reason: r?.reason || 'READONLY' };
    });
    const out = { ok: !!r && r.ok !== false, applied: results.filter((x) => x.ok).length, results };
    if (!r) out.reason = 'READONLY';
    else if (r.ok === false) { out.reason = r.reason || 'ERROR'; if (r.message) out.message = r.message; }
    return out;
  }
  /**
   * v0.4(V4 §2.5): 편집기 글을 setBase 로 준 기준 글로 맞춘다(플러그인 syncToBase — 다시 열지 않음, 캐럿·스크롤 그대로, 되돌리기 기록 비움,
   * 'edited' 없음·끝나면 깨끗함). → { ok, changed, inserted, deleted, reason?, message? } — changed·inserted 는 지금 기준 ref(편집기 기준 =
   * 지금 기준이면 그대로, 아니면 기준 지도로 옮기고 짝이 없으면 뺀다), deleted 는 지운 편집기 문단 수. reason: STRUCTURE(다시 열어 맞출 것)·
   * BUSY(한글 조합·머리말 편집 중 — 잠시 뒤 다시)·READONLY(편집기 없음)·ERROR, 옛 편집기 빌드면 UNSUPPORTED
   */
  async function syncToBase() {
    const fail = (reason) => ({ ok: false, reason, changed: [], inserted: [], deleted: 0 });
    if (cw && !destroyed && typeof cw.syncToBase !== 'function') return fail('UNSUPPORTED');
    const r = await call('syncToBase', undefined, null);
    if (!r || typeof r !== 'object') return fail('READONLY');
    const M = edMap();
    if (!M) return r;
    const refs = (x) => (Array.isArray(x) ? x : []).map((ref) => M.ref('c', ref)).filter(Boolean);
    return { ...r, changed: refs(r.changed), inserted: refs(r.inserted) };
  }
  /**
   * v0.4(V4 §2.4-5): 남이 바꾼 자리를 잠깐(1.5초) 밑줄로 — 스크롤하지 않는다(opts.scroll 이 true 일 때만). ranges = 지금 기준 범위
   * { ref, start?, end?, endRef? } 하나 또는 목록 → 편집기 기준으로 옮겨(rangeToEd — 짝 없으면 뺀다) 보낸다. opts.color = 그 사람 색. → 그렸으면 true
   */
  async function flash(ranges, opts) {
    const list = (Array.isArray(ranges) ? ranges : ranges ? [ranges] : []).map((x) => rangeToEd(x)).filter((x) => x && x.ref);
    if (!list.length || !cw || destroyed || typeof cw.flash !== 'function') return false;
    const o = { scroll: false, ...(opts && typeof opts === 'object' ? opts : {}) };
    try { return !!(await cw.flash(plain(list), plain(o))); } catch (e) { console.warn('[editor] flash:', e); return false; }
  }
  /** 선택 글 비교(여러 문단은 공백을 빼고 — 서버 _validateTarget 과 같은 규칙) */
  const selNorm = (t, multi) => (multi ? String(t ?? '').replace(/\s+/g, '') : String(t ?? '').replace(/\r\n/g, '\n'));
  /**
   * 플러그인 CoworkSelection(편집기 기준) → 지금 기준. 시작 문단이 지금 기준에 없으면 gone(ref null — 대상으로 쓰지 않는다),
   * 펼친 선택의 글이 지금 기준의 그 자리 글과 다르면(다른 사람의 반영으로 바뀜) stale. 둘 다 store.targetFromCw 가 막는다
   */
  function selToCur(p) {
    const M = edMap();
    if (!M || !p || typeof p !== 'object' || !p.ref) return p;
    const r = M.range('c', { ref: p.ref, start: p.start, end: p.end, endRef: p.endRef });
    if (!r) return { ...p, ref: null, endRef: null, refs: [], afterRef: null, tableKey: null, gone: true };
    const out = { ...p, ref: r.ref, start: r.start, end: r.end, endRef: r.endRef ?? r.ref };
    const refs = (Array.isArray(p.refs) && p.refs.length ? p.refs : [p.ref]).map((x) => M.ref('c', x));
    out.refs = refs.filter(Boolean);
    if (out.refs[0] !== out.ref) out.refs = [out.ref, ...out.refs.filter((x) => x !== out.ref)];
    if (p.afterRef !== undefined) out.afterRef = p.afterRef == null ? null : M.after('c', p.afterRef);
    if (p.tableKey) out.tableKey = tableKeyTo(M, 'c', p.tableKey);
    // 펼친 선택만 글을 견준다(캐럿·문단 전체·내가 넣은 문단은 store 가 지금 기준 문단 글을 쓴다)
    if (!p.collapsed && !p.whole && !p.inserted) {
      const multi = out.refs.length > 1;
      const now = multi
        ? [cpSlice(M.textC(out.refs[0]), out.start), ...out.refs.slice(1, -1).map((x) => M.textC(x)), cpSlice(M.textC(out.refs[out.refs.length - 1]), 0, out.end)].join('\n')
        : cpSlice(M.textC(out.ref), out.start, out.end);
      if (refs.some((x) => !x) || selNorm(now, multi) !== selNorm(p.text, multi)) out.stale = true;
    }
    return out;
  }
  /** 플러그인 DraftState(편집기 기준 ref) → 지금 기준. 짝을 잃은 문단은 목록에서 빼되 count 에는 센다 */
  function draftToCur(st) {
    const M = edMap();
    if (!M || !st || typeof st !== 'object') return st;
    const list = (x) => (Array.isArray(x) ? x : []);
    const refs = (x) => list(x).map((r) => M.ref('c', r)).filter(Boolean);
    return {
      ...st, changed: refs(st.changed), deleted: refs(st.deleted),
      inserted: list(st.inserted).map((x) => ({ ...x, afterRef: x?.afterRef == null ? null : M.after('c', x.afterRef) })),
      count: list(st.changed).length + list(st.inserted).length + list(st.deleted).length,
    };
  }
  /** store 의 Annotations(지금 기준) → 편집기 기준. 편집기 기준에 없는 문단의 것은 뺀다(그 문단은 이 편집기에 없다) */
  function annToEd(a) {
    const M = edMap();
    if (!M || !a) return a;
    const R = (x) => M.range('e', x);
    const out = { ...a, proposals: [] };
    out.memos = (a.memos || []).map(R).filter(Boolean);
    for (const p of a.proposals || []) {
      if (p.afterRef != null && (p.type || 'replace') !== 'replace' && p.status !== 'applied') {
        const af = M.ref('e', p.afterRef); if (!af) continue;
        out.proposals.push({ ...p, ref: af, afterRef: af, start: 0, end: cpLen(M.textE(af)) });
      } else if (p.start != null && p.end != null) {
        const r = R(p); if (r) out.proposals.push(r);
      } else {
        const r = M.ref('e', p.ref); if (r) out.proposals.push({ ...p, ref: r });
      }
    }
    out.changes = (a.changes || []).map(R).filter(Boolean);
    out.drafts = (a.drafts || []).map((dr) => ({
      ...dr,
      hunks: (dr.hunks || []).map((hk) => {
        const q = { ...hk };
        if (hk.ref != null) q.ref = M.ref('e', hk.ref);
        if (hk.afterRef != null) q.afterRef = M.ref('e', hk.afterRef);
        return (hk.type === 'insert' ? (q.afterRef ?? q.ref) : q.ref) ? q : null;
      }).filter(Boolean),
    })).filter((dr) => dr.hunks.length);
    out.editing = (a.editing || []).map((e) => { const r = M.ref('e', e.ref); return r ? { ...e, ref: r } : null; }).filter(Boolean);
    if (a.flash) out.flash = R(a.flash);
    return out;
  }

  /**
   * 바꾼 문단(s.draft)을 지금 플러그인 상태로 맞춘다('draft' 이벤트와 같은 처리). 'draft' 는 편집 뒤 600ms 쉼에 오고 자동 저장의 markClean 이
   * 그 쉼을 또 미루므로, 제안을 내 수정본에 반영한 직후(store.adoptProposal) 부른다 — 그사이 결과 창·레일이 '내 수정본에 반영' 단추를
   * 다시 보이지 않게('내 수정본에 반영됨'은 s.draft 를 본다, ui.js adoptedByMe)
   */
  async function syncDraft() {
    const st = await call('draftState', undefined, null);
    if (st && !destroyed && h.ready) HANDLERS.draft(st);
    return draftToCur(st);
  }

  /** 편집기 지금 글(편집기 기준 ref 의 문단 — 플러그인 debug.text). 모르면 null */
  function edText(ref) {
    try { const v = cw?.debug?.text?.(ref); return typeof v === 'string' ? v : null; } catch { return null; }
  }
  /** 내 수정 모습(DraftState — 편집기 기준 ref): 바꾼 문단의 지금 글·넣은 문단 글·지운 문단 */
  function shapeOf(st) {
    const texts = new Map();
    for (const ref of Array.isArray(st?.changed) ? st.changed : []) { const t = edText(ref); if (t != null) texts.set(ref, t); }
    return { texts, inserted: new Set((Array.isArray(st?.inserted) ? st.inserted : []).map((x) => String(x?.text ?? ''))), deleted: new Set(Array.isArray(st?.deleted) ? st.deleted : []) };
  }

  // ───────── 누른 곳: 강조 층의 표식인가(플러그인 div.cowork-marks 안 — 여백 원·수정 중 막대·이름표·삭제 쐐기) ─────────
  // 플러그인 'annotation-click' 은 표식을 누를 때도, 강조된 글을 그냥 눌러 캐럿을 놓을 때도 온다 — 패널 탭은 표식일 때만 옮긴다.
  // (표식은 mousedown 을 막아 편집기로 보내지 않지만, 편집기 창(iframe window)의 capture 단계는 그보다 먼저 지난다)
  function onFrameDown(e) {
    if (e?.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') touchDown(e);
    let mark = false;
    try { mark = !!e?.target?.closest?.('.cowork-marks'); } catch { mark = false; }
    markDown = { at: Date.now(), mark };
  }
  // ───────── 터치 화면의 숨은 입력 칸 ─────────
  // 휴대전화·태블릿(굵은 포인터 — '데스크톱 사이트'로 볼 때 포함)에서 본문을 누르면 studio 의 숨은 입력 칸(input-handler — 왼쪽 위 화면 밖, 작은 글자)에
  // 포커스가 가고 키보드가 뜬다. 그때 브라우저가 그 칸으로 화면을 옮기며 '읽기 좋은 배율'로 확대해 왼쪽 위가 크게 보였다
  // (크롬·브레이브: 데스크톱 화면에서 칸의 캐럿 높이 × 배율이 16px 보다 작으면 확대). 칸을 캐럿 자리로 옮기고(캐럿이 움직일 때마다)
  // 글자를 크게 해(보이지 않음) 확대 없이 캐럿만 보이게 한다. 마우스 화면은 그대로
  let touchFix = null;
  function fixTouchInput() {
    if (touchFix?.input?.isConnected) { touchFix.watch(); return; }
    touchFix?.stop();
    let doc = null; try { doc = iframe?.contentDocument || null; } catch { doc = null; }
    const view = doc?.defaultView;
    if (!doc || !view?.matchMedia?.('(pointer: coarse)')?.matches) return;
    const input = doc.querySelector(DOCUMENT_INPUT);
    if (!input) return;
    // iOS(contentEditable div — 16px 라 확대는 없다)는 자리만, 나머지(textarea)는 글자도 크게. 캐럿을 아직 모르면 화면 가운데
    const big = input.tagName === 'TEXTAREA' ? { width: '1px', height: '1.2em', fontSize: '72px', lineHeight: '1.2', padding: '0', border: '0', opacity: '0', resize: 'none', overflow: 'hidden' } : {};
    Object.assign(input.style, { position: 'fixed', margin: '0', pointerEvents: 'none', left: `${Math.round(view.innerWidth / 2)}px`, top: `${Math.round(view.innerHeight / 3)}px`, ...big });
    let caret = null; let mo = null; let last = '';
    const put = (x, y) => {
      const left = Math.round(Math.min(Math.max(0, x), Math.max(0, view.innerWidth - 2)));
      const top = Math.round(Math.min(Math.max(0, y), Math.max(0, view.innerHeight - 2)));
      const k = `${left},${top}`;
      if (k === last) return;   // 캐럿 깜박임(opacity)마다 다시 쓰지 않게
      last = k; input.style.left = `${left}px`; input.style.top = `${top}px`;
    };
    const place = () => { const r = caret?.isConnected ? caret.getBoundingClientRect() : null; if (r && r.height > 0) put(r.left, r.top); };
    // 캐럿은 문서를 열 때 떼었다가 다시 붙는다 — 없으면 다음 누름·선택 때 찾아 단다
    const watch = () => {
      const c = doc.querySelector('#scroll-content .caret');
      if (c && c !== caret) { mo?.disconnect(); caret = c; mo = new view.MutationObserver(place); mo.observe(c, { attributes: true, attributeFilter: ['style'] }); }
      place();
    };
    input.addEventListener('focus', watch, true);
    watch();
    touchFix = { input, watch, put, stop: () => { mo?.disconnect(); input.removeEventListener('focus', watch, true); touchFix = null; } };
  }
  /** 터치로 누름(편집기 창 capture — studio 가 입력 칸에 포커스를 주기 전): 칸을 누른 자리에 먼저 둔다(캐럿이 정해지면 캐럿 자리로) */
  function touchDown(e) {
    fixTouchInput();
    touchFix?.put(e.clientX, e.clientY);
  }
  /** 지금 편집기 창에 누름 감시를 단다(창이 바뀌었으면 옛 것은 뗀다) */
  function hookFrame() {
    let w = null;
    try { w = iframe?.contentWindow || null; } catch { w = null; }
    if (!w || w === hookedWin) return;
    unhookFrame();
    try { w.addEventListener('pointerdown', onFrameDown, true); w.addEventListener('mousedown', onFrameDown, true); w.addEventListener('paste', onFramePaste, true); hookedWin = w; } catch { hookedWin = null; }
  }
  function unhookFrame() {
    const w = hookedWin; hookedWin = null;
    if (!w) return;
    try { w.removeEventListener('pointerdown', onFrameDown, true); w.removeEventListener('mousedown', onFrameDown, true); w.removeEventListener('paste', onFramePaste, true); } catch { /* 편집기 창이 이미 없음 */ }
  }
  /** (2026-11-03) 앞 편집을 아직 공유 문서에 넣는 중(큰 잘라내기 등 — 서버 진행이 온 밀어 넣기)에 붙여넣으면: 붙인 글은 그 뒤 이어서 저장된다고 알린다 */
  function onFramePaste() {
    const p = s.live.progress;
    if (mode !== 'live' || !pushing || !p?.total) return;
    toast(`앞 편집을 문서에 넣는 중입니다(${p.done}/${p.total}) — 붙여 넣은 글은 끝나는 대로 이어서 저장됩니다`, { ms: 6000 });
  }

  /** 플러그인 좌표(iframe client) → 호스트 페이지 좌표 */
  function anchorToPage(a) {
    const r = iframe?.getBoundingClientRect?.() || { left: 0, top: 0 };
    return { x: r.left + (Number(a?.x) || 0), y: r.top + (Number(a?.y) || 0), w: Number(a?.w) || 0, h: Number(a?.h) || 0 };
  }

  const fileName = () => `${s.info?.title || 'document'}.hwpx`;

  // ───────── 띄우기·열기 ─────────

  async function start() {
    try {
      if (state.config?.studio?.mode === 'remote') { await startRemote(); return; }
      studio = await createStudio(el, { studioUrl: `${location.origin}/studio/cowork-embed.html?chrome=embed`, plugins: ['cowork'], renderer: 'canvas2d', requestTimeoutMs: 120000 });
      if (destroyed) { try { studio.destroy(); } catch { /* 이미 없음 */ } studio = null; return; }
      iframe = studio.element || el.querySelector('iframe');
      iframe?.setAttribute('title', '문서 편집기');
      applyInert();
      cw = await waitCowork();
      if (!cw) throw new Error('편집기에 cowork 플러그인이 없습니다(npm run build:studio 로 다시 빌드하세요)');
      hookFrame();
      for (const ev of EVENTS) offs.push(cw.on(ev, (p) => { if (!destroyed) { try { HANDLERS[ev]?.(p); } catch (e) { console.warn(`[editor] ${ev}:`, e); } } }));
      setOptions();
      installWatches();
      await open();
    } catch (e) {
      if (destroyed) return;
      h.error = `편집기를 띄우지 못했습니다: ${e.message}`;
      h.loading = false;
    }
  }

  /**
   * 원격 편집기(config studio.mode=remote — cowork 플러그인 없음, §1.1): 기준 작업본을 보여 주기만 한다.
   * 수정본·자동 저장·검토 강조·우클릭 검토 구역은 없다(ready 는 false 그대로) — 셸이 notice 로 알린다(검토는 패널 탭으로).
   */
  async function startRemote() {
    studio = await createStudio(el, { studioUrl: state.config.studioUrl, plugins: [], requestTimeoutMs: 120000 });
    if (destroyed) { try { studio.destroy(); } catch { /* 이미 없음 */ } studio = null; return; }
    iframe = studio.element || el.querySelector('iframe');
    applyInert();
    const f = await fetchBytes(`${d.base}/file?kind=working`);
    await studio.loadFile(f.bytes, fileName(), { skipUnsavedGuard: true, suppressDialogs: true });
    h.baseVersion = Number(f.headers.get('X-Doc-Version')) || 0; h.source = 'working';
    h.notice = '원격 편집기라 검토 기능이 꺼져 있습니다 — 여기서 고친 글은 저장되지 않습니다(메모·AI 작업·변경 요청은 AI 작업 창에서). 관리자: config studio.mode=local 뒤 npm run build:studio';
    h.loading = false;
  }

  /** iframe 안 window.rhwpCowork(같은 출처) — 플러그인이 올라오면 바로 있다. 늦으면 잠깐 기다린다 */
  async function waitCowork() {
    for (let i = 0; i < 100 && !destroyed; i++) {
      try { const x = iframe?.contentWindow?.rhwpCowork; if (x) return x; } catch { return null; }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  /** 다음 'ready'(문서 화면 계산 가능) — loadFile 전에 구독한다. 놓쳐도 한도 뒤 이어 간다(setBase 는 언제 불러도 된다) */
  function nextReady() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); off(); resolve(); };
      const off = cw.on('ready', finish);
      const t = setTimeout(() => { console.warn(`[editor] 편집기 'ready' 없이 ${READY_MS / 1000}초 한도로 이어 갑니다`); finish(); }, READY_MS);
    });
  }

  /**
   * 열기(처음·다시): 내 수정본이 있으면 그것, 없으면 기준 작업본. keepScroll 이면 스크롤 자리를 되살린다.
   * 저장 예약은 버리고(새 문서 기준으로 다시 잰다) 저장 중이면 끝나기를 기다린다.
   * auto = 기준이 바뀌어 저절로 다시 여는 것(내 수정 없음일 때), sync = 이 창 밖에서 바뀐 서버 내 수정본을 불러오는 것(저장 안 된 편집 없음일 때).
   * 둘 다 파일을 받는 동안 지금 문서를 그대로 두고, 그사이 사용자가 치기 시작하면 다시 열지 않는다. 파일을 편집기에 싣기 시작하면
   * 끝날 때까지 편집기를 잠근다(덮개 '새 기준으로 여는 중…') — 싣는 동안 친 글은 옛 문서·엉뚱한 캐럿 자리로 가거나 사라지므로 아예 받지 않는다.
   * 처음·다시 열기(저절로가 아님)는 여는 내내 입력만 막는다(셸이 '편집기를 불러오는 중'을 보인다).
   */
  async function open({ keepScroll = false, auto = false, sync = false, live = false } = {}) {
    if (!studio || !cw || destroyed) return;
    hookFrame();
    const gen = ++loadGen;
    const quiet = auto || sync;
    const seq0 = lastSeq;
    if (auto) autoOpening = gen;
    let release = quiet ? null : lock('', { silent: true });
    try {
      if (!quiet) { clearTimeout(saveTimer); saveTimer = null; firstEditAt = 0; clearTimeout(pushTimer); pushTimer = null; pushFirstAt = 0; }
      if (saving) { try { await saving; } catch { /* 저장 실패는 칩이 보여 준다 */ } }
      if (pushing) { try { await pushing; } catch { /* 칩이 보여 준다 */ } }
      if (gen !== loadGen || destroyed) return;
      await openBody({ gen, quiet, auto, sync, live, seq0, keepScroll, hold: (label) => { release?.(); release = lock(label); } });
    } finally {
      release?.();
      if (autoOpening === gen) autoOpening = 0;
    }
  }
  /** 방식을 정한다(머리 주석 v0.4): 읽기 전용·실시간 상태를 store 에(플러그인 readOnly 는 s.readOnly 를 보는 setOptions 가 보낸다) */
  function setMode(m) {
    if (m !== 'live') { clearTimeout(pushTimer); pushTimer = null; pushFirstAt = 0; s.live.error = ''; s.live.pushing = false; }
    if (m === 'review') { syncWant = null; clearTimeout(syncTimer); syncTimer = null; }
    mode = m; h.mode = m;
    s.readOnly = m === 'follow';
    s.live.on = m === 'live';
  }
  async function openBody({ gen, quiet, auto, sync, live, seq0, keepScroll, hold }) {
    const scroll = keepScroll ? readScroll() : null;
    previewOpenActive = false;
    h.previewReady = false; h.previewPages = 0; h.previewPageCount = null;
    if (!quiet) { h.loading = true; h.ready = false; }
    h.openPhase = 'fetch';
    try {
      // 파일·문단·버전을 한 상태에서 읽었는지 확인한다(그사이 커밋이 끼면 다시). 문단 서명(base.sig)은 편집기 기준과 같은 버전일 때만 쓴다 —
      // 다른 버전의 서명이면 '글이 같은 새 버전'을 잘못 알아 내 수정본 저장이 남이 바꾼 글을 되돌릴 수 있다(→ sig 를 null 로 둬 조용한 기준 바꾸기를 막는다).
      // v0.4: 방식(next)도 같은 문서 정보로 정한다 — 실시간·읽기 전용이면 내 수정본을 보지 않고 작업본을 연다
      let mine = null; let bytes = null; let version = 0; let source = 'working'; let paragraphs = []; let sigOk = false; let paraVersion = 0; let fileRev = null; let next = mode; let formatVersion = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const info1 = await api(d.base);
        const v1 = Number(info1?.version) || 0;
        next = modeOfInfo(info1);
        mine = null; bytes = null; source = 'working'; fileRev = null;
        if (next === 'review') {
          try { mine = await api(`${d.base}/drafts/mine`); } catch (e) { if (e.status && e.status !== 404) throw e; }
          if (mine?.cr && mine.file) {
            try {
              const f = await fetchBytes(`${d.base}/drafts/mine/file`);
              bytes = f.bytes; version = Number(f.headers.get('X-Base-Version')) || Number(mine.cr.baseVersion) || 0; source = 'draft';
              fileRev = revOf({ rev: f.headers.get('X-Draft-Rev') });   // 이 바이트의 판(다음 PUT ?rev= 에)
            } catch (e) { if (e.status !== 404) throw e; }
          }
        }
        if (!bytes) {
          const f = await fetchBytes(`${d.base}/file?kind=working`);
          bytes = f.bytes; version = Number(f.headers.get('X-Doc-Version')) || 0; source = 'working';
        }
        paragraphs = await api(`${d.base}/paragraphs?view=final`);
        const info2 = await api(d.base);
        const v2 = Number(info2?.version) || 0;
        formatVersion = Number(info2?.formatVersion) || 0;
        if (!s.info || v2 >= (Number(s.info.version) || 0)) d.applyInfo?.(info2);
        sigOk = v1 === v2 && version === v2;
        paraVersion = v1 === v2 ? v2 : 0;
        // 수정본 바이트의 판이 방금 읽은 상태(GET /drafts/mine)의 판과 다르면 그 사이 다른 곳에서 저장한 것 — 다시 읽는다
        const revOk = source !== 'draft' || fileRev == null || revOf(mine) == null || String(fileRev) === String(revOf(mine));
        // 그사이 문서 설정(방식·권한)이 바뀌었으면 다시 읽는다
        const modeOk = modeOfInfo(info2) === next;
        // 옛 기준의 수정본(뒤처짐)은 다시 읽어도 같다 — 기다리지 않는다
        if (modeOk && revOk && (sigOk || (source === 'draft' && v1 === v2))) break;
        if (gen !== loadGen || destroyed) return;
      }
      if (gen !== loadGen || destroyed) return;
      // (방금 받은 서버 상태를 연다 — store 의 s.myCr 은 목록이 늦게 와서 옛것일 수 있어 보지 않는다. 이 창이 그새 친 글·저장은 아래가 잡는다)
      if (auto && !live && mode === 'review' && (lastSeq !== seq0 || saving)) {
        // 그사이 고치기 시작했다 — 지금 문서를 두고 '최신 반영 필요'로 알린다
        const ver = Number(s.paraVersion) || 0;
        if (ver > base.version) s.draft.behind = ver - base.version;
        return;
      }
      // 다른 곳에서 바뀐 수정본을 받는 사이 이 창에서 치기 시작했다 — 덮어쓰지도 버리지도 않고 저장을 멈춰 묻는다
      if (sync && (lastSeq !== seq0 || saving || h.dirty)) { stopForElsewhere(!!mine?.cr, newerBase(mine)); return; }
      // 여기부터 파일을 싣는다 — 저절로 다시 여는 것도 끝날 때까지 잠근다(머리 주석 7: 싣는 동안 친 글이 엉뚱한 자리로 가지 않게)
      if (quiet) hold(auto ? '새 버전으로 여는 중…' : '바뀐 수정본을 여는 중…');
      clearTimeout(saveTimer); saveTimer = null; firstEditAt = 0;
      // 방식을 먼저 정한다 — 읽기 전용이면 싣기 전에 양식 모드로(실은 문서에 바로 치지 못하게)
      setMode(next);
      h.loading = true; h.ready = false;
      const ready = nextReady();
      previewOpenActive = true;
      // h.openPhase: 지금 어느 단계를 기다리는지(화면 오류 기록 web/client-log.js 가 남긴다)
      h.openPhase = 'loadFile';
      await studio.loadFile(bytes, fileName(), { skipUnsavedGuard: true, suppressDialogs: true });
      h.opens++;
      h.openPhase = 'ready';
      await ready;
      if (gen !== loadGen || destroyed) return;
      h.openPhase = 'setBase';
      await cw.setBase({ version, paragraphs: plain(paragraphs) });
      h.openPhase = 'markClean';
      await cw.markClean();
      // 바꾼 문단(플러그인 draftState)을 먼저 받아 s.draft 를 한 번에 채운다 — 플러그인 'draft'(setBase 뒤 600ms 쉼)를 기다리거나 빈 값을 거치면
      // 그사이 반영해 둔 제안이 대기로 다시 그려지고 결과 창·레일이 '내 수정본에 반영' 단추를 다시 보인다(adoptedNow·ui.js adoptedByMe 가 s.draft 를 본다)
      h.openPhase = 'draftState';
      const st = await call('draftState', undefined, null);
      h.openPhase = 'done';
      if (gen !== loadGen || destroyed) return;
      savedShape = shapeOf(st);
      base = { version, sig: sigOk ? textSig(paragraphs) : null, pars: paragraphs };
      loadedFormatVersion = Math.min(formatVersion, version);
      loadedVersion = source === 'working' ? version : 0;
      savedSeq = lastSeq; h.dirty = false;
      h.baseVersion = version; h.source = source;
      known = draftSig(mine?.cr); rev = fileRev ?? revOf(mine);
      // 실시간·읽기 전용은 내 수정본을 읽지 않았다 — 목록의 내 변경 요청(승인 방식 때 남은 것 — 셸의 띠)을 지우지 않는다
      if (next === 'review') d.setMyCr(mine?.cr ?? null);
      // 문단 목록을 먼저 맞춘다(같은 목록이면 기준 지도가 필요 없다 — 바꾼 문단도 그대로 지금 기준 ref)
      if (paraVersion && paraVersion >= (Number(s.paraVersion) || 0)) { s.paragraphs = paragraphs; s.paraVersion = paraVersion; }
      // 내 수정본이 옛 기준이면 칩에 '최신 반영 필요'(서버가 센 뒤처진 버전 수), 작업본이면 기준 = 지금
      const behind = source === 'draft' ? Math.max(0, Number(mine?.cr?.behind) || 0) : 0;
      Object.assign(s.draft, { ...emptyDraft(), tutorialRestored: false, fileReplaced: false, baseVersion: version, behind, unsupported: mine?.cr?.unsupported || [], ...draftFields(draftToCur(st)) });
      if (next !== 'live') s.live.error = '';
      h.error = ''; h.loading = false; h.ready = true;
      previewOpenActive = false; h.previewReady = false; applyInert();
      fixTouchInput();
      pushAnnotations(true);
      if (s.active) h.setActive(s.active);
      if (scroll) await restoreScroll(scroll);
      // 연 사이 기준이 또 바뀌었으면 맞춘다 · 연 사이 문서 설정이 또 바뀌었으면(WS doc settings) 새 방식으로(잠금이 풀린 뒤)
      if (autoOpening && autoOpening <= gen) autoOpening = 0;   // 이 열기와 그보다 앞선(이미 그만둔) 저절로 열기
      onBaseMaybeChanged();
      setTimeout(() => maybeSwitchMode(), 0);
    } catch (e) {
      if (gen !== loadGen || destroyed) return;
      if (quiet && h.ready) {
        // 지금 문서는 그대로 쓸 수 있다. 다만 다른 곳에서 바뀐 수정본을 못 받았으면 이 창 글로 덮어쓰지 않게 저장을 멈춘다
        console.warn('[editor] 다시 열지 못했습니다:', e);
        if (sync) stopForElsewhere();
        return;
      }
      h.error = `문서를 편집기에 열지 못했습니다: ${e.message}`;
      h.loading = false;
      previewOpenActive = false; h.previewReady = false; applyInert();
    }
  }

  // ───────── 스크롤 기억 ─────────

  function scrollEl() { try { return iframe?.contentDocument?.getElementById('scroll-container') || null; } catch { return null; } }
  function readScroll() {
    const c = scrollEl();
    const first = (s.anchors || []).find((a) => a.visible);
    return c ? { top: c.scrollTop, left: c.scrollLeft, ref: first?.ref || null } : (first ? { ref: first.ref } : null);
  }
  async function restoreScroll(sc) {
    const c = scrollEl();
    if (c && sc.top != null) {
      // 쪽이 다 놓일 때까지(높이가 생길 때까지) 몇 프레임 기다린다
      for (let i = 0; i < 20 && c.scrollHeight < sc.top + c.clientHeight && !destroyed; i++) await nextFrame();
      c.scrollTop = sc.top; c.scrollLeft = sc.left || 0;
      return;
    }
    if (sc.ref) await h.focusRange({ ref: sc.ref, flash: false });
  }

  // ───────── 플러그인 이벤트 ─────────

  // 플러그인이 주는 자리는 편집기 기준 ref 다 — 셸·store 로 넘기기 전에 지금 기준으로 옮긴다(머리 주석 8)
  const HANDLERS = {
    selection(raw) {
      fixTouchInput();   // 편집기를 다시 열어 입력 칸·캐럿이 새로 생겼으면 다시 단다(이미 달았으면 곧바로 끝)
      const p = selToCur(raw);
      s.sel = p || null;
      s.selection = p && !p.collapsed && !p.inserted && !p.gone ? { ref: p.ref, start: p.start, end: p.end, endRef: p.endRef, refs: p.refs, text: p.text } : null;
    },
    'menu-action'(p) { if (p && p.action) d.emit('menu-action', p.target ? { ...p, target: selToCur(p.target) } : p); },
    'annotation-click'(p) {
      if (!p) return;
      const a = { kind: String(p.kind), id: String(p.id) };
      if (p.cid != null) { a.cid = p.cid; a.hid = p.hid; }
      // 강조는 언제나 그 항목으로(편집기 강조·레일 카드 고정)
      s.active = a;
      if (a.kind === 'memo' || a.kind === 'request') s.activeMemo = a.id;
      // 패널 탭은 표식(여백 원·수정 중 막대·이름표·삭제 쐐기)을 누를 때만 옮긴다 — 강조된 글을 그냥 눌러 캐럿을 놓은 것(타이핑하려고)은
      // 탭을 바꾸지 않는다(markDown). 변경 추적(기준 문서) 강조는 레일 카드가 없다 — 패널 '변경 추적' 탭이 그 변경 묶음을 보인다(panels.js ChangeTab).
      // 나머지는 레일 카드가 맞춘다(좁은 창 — 레일이 접혔으면 패널 '검토' 탭)
      const viaMark = !!markDown && markDown.mark && Date.now() - markDown.at < 10000;
      if (viaMark) {
        if (a.kind === 'change') s.tab = 'change';
        else if (!s.railOpen) s.tab = 'review';
      }
      d.emit('annotation-click', { ...a, anchor: p.anchor || null, viaMark });
    },
    'annotation-hover'(p) {
      if (!p) { s.hover = null; return; }
      const a = { kind: String(p.kind), id: String(p.id) };
      if (p.cid != null) { a.cid = p.cid; a.hid = p.hid; }
      s.hover = a;
    },
    anchors(p) {
      const M = edMap();
      s.anchors = !Array.isArray(p) ? [] : M ? p.map((a) => (a && a.ref ? { ...a, ref: M.ref('c', a.ref) } : a)) : p;
    },
    edited(p) {
      lastSeq = Math.max(lastSeq, Number(p?.changeSeq) || 0);
      lastInputAt = Date.now();
      // 읽기 전용(수정 권한 없음): 양식 모드에서도 고칠 수 있는 누름틀에 친 글이 와도 밀어 넣지 않는다 — 다음 맞춤 때 기준 글로 돌아간다(V4 §2.5)
      if (mode === 'follow') { if (syncWant) scheduleSync(); return; }
      h.dirty = true; s.draft.dirty = true;
      if (mode === 'live') { schedulePush(); if (syncWant) scheduleSync(); return; }
      scheduleSave();
    },
    draft(p) {
      if (!p) return;
      Object.assign(s.draft, draftFields(draftToCur(p)));
      if (mode === 'follow') return;
      // 플러그인이 저장 안 된 편집이 있다는데(markClean 뒤 판이 바뀜) 여기서 못 봤으면('edited' 를 놓침) 저장(밀어 넣기)을 예약한다
      if (p.dirty && !h.dirty && h.ready && !saving && !pushing && !syncRun) {
        h.dirty = true; s.draft.dirty = true;
        if (mode === 'live') schedulePush(); else scheduleSave();
      }
    },
    // 타이핑 중 문단도 지금 기준 ref 로 알린다(편집기 기준에만 있는 문단이면 null — 남의 화면에 엉뚱한 문단을 표시하지 않게). 읽기 전용은 알리지 않는다
    editing(p) { if (!foreground || mode === 'follow') return; const M = edMap(); editPending = p?.ref ? (M ? M.ref('c', p.ref) : p.ref) : null; flushEditing(); },
    key(p) { if (p) d.emit('editor-key', p); },
    ready() { /* nextReady 가 받는다 */ },
  };

  // ───────── 타이핑 중 알림(POST /editing) ─────────

  function flushEditing() {
    if (editPending === undefined || destroyed) return;
    if (editPending === editRef) { editPending = undefined; return; }
    const wait = editSentAt + EDITING_MS - Date.now();
    if (wait > 0) { if (!editTimer) editTimer = setTimeout(() => { editTimer = null; flushEditing(); }, wait); return; }
    const ref = editPending; editPending = undefined; editRef = ref; editSentAt = Date.now();
    api(`${d.base}/editing`, { method: 'POST', body: { ref } }).catch((e) => console.warn('[editor] editing:', e.message));
  }

  // ───────── 자동 저장 ─────────

  function scheduleSave(ms = IDLE_MS) {
    if (destroyed || s.draft.stale || mode !== 'review') return;   // 저장을 멈춘 동안(다시 열기 전)은 예약하지 않는다 · 승인 방식에서만(실시간은 밀어 넣기)
    const now = Date.now();
    if (!firstEditAt) firstEditAt = now;
    clearTimeout(saveTimer);
    const wait = Math.max(0, Math.min(ms, firstEditAt + MAX_MS - now));
    saveTimer = setTimeout(() => { saveTimer = null; doSave().catch(() => { /* 칩이 보여 준다 */ }); }, wait);
  }
  /** 곧 저장(제안을 반영한 뒤 등) — 실시간이면 곧 밀어 넣기, 읽기 전용이면 아무것도 안 함 */
  function saveSoon() { if (mode === 'live') schedulePush(400); else if (mode === 'review') scheduleSave(400); }
  /**
   * 지금 저장(저장 안 된 것이 있으면). 저장 중이면 끝난 뒤 남은 것을. 저장을 멈춘 상태(s.draft.stale)면 던진다(STALE_BASE·CHANGED_ELSEWHERE) —
   * 부른 쪽(반영·닫기·최신 반영·검토 요청)이 그 동작을 하지 않게. o.force: 다른 곳에서 바뀐 서버 수정본을 이 창 글로 덮어쓴다(칩 [이 글로 저장])
   * v0.4: 실시간이면 지금 밀어 넣기(못 보내면 칩이 알리고 s.draft.dirty 가 남는다 — 던지지 않는다), 읽기 전용이면 할 것이 없다
   */
  async function saveNow(o = {}) {
    if (s.draft.tutorialRestored) throw Object.assign(new Error(s.draft.error), { code: 'TUTORIAL_RESTORED' });
    if (s.draft.fileReplaced) throw Object.assign(new Error(s.draft.error), { code: 'FILE_REPLACED' });
    if (mode === 'live') {
      clearTimeout(pushTimer); pushTimer = null;
      if (pushing) { try { await pushing; } catch { /* 칩 */ } }
      if (!h.ready || destroyed) return null;
      return lastSeq > savedSeq ? pushOnce(!!o.departure) : null;
    }
    if (mode === 'follow') return null;
    clearTimeout(saveTimer); saveTimer = null;
    const force = !!o?.force && !!s.draft.elsewhere;
    if (force) Object.assign(s.draft, { stale: false, elsewhere: '', error: '' });
    if (saving) { try { await saving; } catch { /* 아래에서 다시 */ } }
    if (!h.ready || destroyed) return null;
    // 덮어쓰기는 저장 안 된 편집이 없어도 이 창 글을 보낸다(서버 것이 이 창 것과 다르다)
    if (force || lastSeq > savedSeq || h.dirty) return doSave({ force, departure: !!o.departure });
    return null;
  }
  const staleError = () => Object.assign(new Error(s.draft.error || '내 수정본을 다시 열어야 저장할 수 있습니다'), { code: s.draft.elsewhere ? 'CHANGED_ELSEWHERE' : 'STALE_BASE' });
  /** 저장 예약을 버리고 저장 중이면 끝나기를 기다린다(수정본을 지우기 전에) */
  async function cancelSave() {
    clearTimeout(saveTimer); saveTimer = null; firstEditAt = 0;
    clearTimeout(pushTimer); pushTimer = null; pushFirstAt = 0;
    if (saving) { try { await saving; } catch { /* 무시 */ } }
    if (pushing) { try { await pushing; } catch { /* 무시 */ } }
  }

  /** PUT 주소: 기준 버전 + 이 창이 아는 서버 수정본 판(rev, 알 때만). 덮어쓰기(force — 칩 [이 글로 저장])는 판 없이 보낸다 */
  const putPath = (force) => `${d.base}/drafts/mine?base=${base.version}${!force && rev != null ? `&rev=${encodeURIComponent(String(rev))}` : ''}`;

  /** 현재 수정본 저장 → 서버 서식 적용 → 파일 재열기. 버전 검사로 다른 창의 편집을 보호한다. */
  async function applyFormatProposal(pid, { undo = false } = {}) {
    if (mode !== 'review' || !h.ready || h.loading || h.locked) throw new Error('편집기가 준비된 뒤 다시 반영하세요.');
    const release = lock(undo ? '서식 반영을 되돌리는 중…' : '글·서식을 수정본에 반영하는 중…');
    try {
      await saveNow();
      if (h.dirty || s.draft.stale || s.draft.error) throw new Error(s.draft.error || '수정본 저장을 마친 뒤 다시 반영하세요.');
      const body = { expectedBaseVersion: base.version };
      if (s.myCr?.cid != null) body.cid = s.myCr.cid;
      if (rev != null) body.expectedDraftRev = rev;
      saveGen++;
      const result = await api(`${d.base}/proposals/${Number(pid)}/${undo ? 'undo-adopt-format' : 'adopt-format'}`, { method: 'POST', body });
      d.setMyCr(result?.cr || null);
      await open({ keepScroll: true, sync: true });
      if (h.error || !h.ready || s.draft.stale) throw new Error('서식은 저장됐지만 편집기를 다시 열지 못했습니다. 새로고침해 확인하세요.');
      return result;
    } finally { release(); }
  }
  /**
   * 수정본 PUT. 409 DRAFT_STALE(이 창이 아는 판 뒤에 서버 수정본이 다른 곳에서 저장됨)이면 서버 것을 읽어 보고, 이 창이 아는 것과
   * 같은 내용이면(서명 같음 — 판만 바뀜: 같은 글을 다시 저장·검토 요청 등) 새 판으로 한 번 더 보낸다. 다르면 그대로 던진다(→ 저장을 멈추고 묻는다)
   */
  const departureRequest = (seq, gen) => (path, options) => submitDeparture(api, d.base, path, options, () => {
    if (!destroyed && gen === loadGen) acceptedSave = { seq, gen };
  });
  async function put(bytes, force, send = api) {
    saveGen++;
    try { return await send(putPath(force), { method: 'PUT', body: bytes, raw: true }); } catch (e) {
      if (e?.code !== 'DRAFT_STALE' || force) throw e;
      const mine = await api(`${d.base}/drafts/mine`).catch(() => null);
      // 서버 수정본이 이 창보다 새 기준이면(다른 창의 [최신 반영]) 이 창 글로는 덮어쓸 수도 없다(STALE_BASE) — [내 글 옮겨 넣기]로
      const nb = newerBase(mine);
      if (nb) { e.newerBase = nb; throw e; }
      const fresh = revOf(mine);
      if (!mine || fresh == null || String(fresh) === String(rev) || draftSig(mine.cr) !== known) throw e;
      rev = fresh; saveGen++;
      return send(putPath(false), { method: 'PUT', body: bytes, raw: true });
    }
  }
  /** 서버 내 수정본(GET /drafts/mine)의 기준 버전이 이 창 편집기 기준보다 새것이면 그 버전, 아니면 0 */
  function newerBase(mine) {
    const v = Number(mine?.cr?.baseVersion) || 0;
    return mine?.cr && v > (Number(base.version) || 0) ? v : 0;
  }
  /**
   * 409 DRAFT_STALE: 저장을 멈추고 칩으로 묻는다 — '다른 곳에서 바뀜' [다시 열기] [이 글로 저장(rev 없이 덮어쓰기)].
   * newer(서버 수정본의 더 새 기준 버전, 모르면 true): 다른 곳에서 최신 반영했다 — 덮어쓰기는 서버가 막으므로(STALE_BASE) [이 글로 저장] 대신
   * [내 글 옮겨 넣기](s.draft.rebased)
   */
  function markStale(newer = 0) {
    clearTimeout(saveTimer); saveTimer = null; firstEditAt = 0;
    if (newer) Object.assign(s.draft, { stale: true, rebased: true, elsewhere: '다른 곳에서 최신으로 맞춤', error: rebasedTip('다른 곳(같은 계정의 다른 창·기기)에서', Number(newer) > 0 ? Number(newer) : 0) });
    else Object.assign(s.draft, { stale: true, rebased: false, elsewhere: STALE_LABEL, error: STALE_TIP });
  }

  /** o.force: 바꾼 문단이 없어도 보낸다(덮어쓰기 — 서버의 다른 수정본을 이 창 글로, rev 없이) */
  async function doSave(o = {}) {
    if (!cw || !studio || destroyed || !h.ready || mode !== 'review') return null;
    if (saving) { again = true; return saving; }
    if (s.draft.stale) throw staleError();
    const gen = loadGen; const seq = lastSeq;
    firstEditAt = 0;
    s.draft.saving = true;
    let stale409 = false;
    const job = (async () => {
      try {
        // 바꾼 문단이 없고(정렬 결과) 변경 요청도 없으면 보낼 것이 없다 — 깨끗하다고만 적는다
        const st = await cw.draftState().catch(() => null);
        if (!o.force && st && !st.dirty && !s.myCr && !st.changed?.length && !st.inserted?.length && !st.deleted?.length) {
          await cw.markClean({ changeSeq: seq });
          savedSeq = Math.max(savedSeq, seq);
          return { cr: null, unchanged: true, skipped: true };
        }
        const shape = shapeOf(st);   // 이 저장에 실리는 내 수정 모습(저장되면 savedShape)
        const bytes = await studio.exportHwpx();
        if (gen !== loadGen || destroyed) return null;
        const res = await put(bytes, !!o.force, o.departure ? departureRequest(seq, gen) : undefined);
        known = draftSig(res?.cr);   // 서버 내 수정본 = 방금 보낸 것
        rev = revOf(res);
        savedShape = shape;
        if (gen !== loadGen || destroyed) return null;
        try { await studio.notifySaved(); } catch { /* notify-saved 를 모르는 studio */ }
        await cw.markClean({ changeSeq: seq });
        savedSeq = Math.max(savedSeq, seq);
        d.setMyCr(res?.cr ?? null);
        s.draft.savedAt = new Date().toISOString();
        if (res?.cr) s.draft.baseVersion = Number(res.cr.baseVersion) || base.version;
        return res;
      } finally {
        s.draft.saving = false;
      }
    })();
    saving = job;
    try {
      const res = await job;
      if (res) {
        s.draft.error = ''; s.draft.stale = false; s.draft.elsewhere = ''; s.draft.rebased = false;
        // 저장한 뒤 더 치지 않았으면 '입력 중' 알림을 거둔다 — 남의 화면에는 '✎ 수정 중'(저장된 내 수정본)이 보인다.
        // 다시 치면 플러그인이 'editing' 을 또 낸다
        if (lastSeq === seq && editRef != null) { editPending = null; flushEditing(); }
      }
      return res;
    } catch (e) {
      if (e?.code === 'DRAFT_STALE') { stale409 = true; markStale(e.newerBase || 0); }
      // 다시 맞춘 뒤의 옛 창(서버 수정본이 더 새 기준) — 덮어쓸 수 없으니 [다시 열기]·[내 글 옮겨 넣기]로 묻는다(저장 안 된 편집이 없으면 아래에서 그냥 불러온다)
      else if (e?.code === 'STALE_BASE') { stale409 = true; markStale(Number(e.data?.baseVersion ?? e.data?.details?.baseVersion) || true); }
      else { s.draft.error = e.message || String(e); s.draft.stale = false; s.draft.elsewhere = ''; }
      failCount++;
      throw e;
    } finally {
      if (saving === job) saving = null;
      if (!s.draft.error) failCount = 0;
      if (gen === loadGen && !destroyed) {
        const dirty = lastSeq > savedSeq;
        h.dirty = dirty; s.draft.dirty = dirty;
        if (stale409) {
          again = false;
          // 저장 안 된 편집이 없다(기준 따라가기 같은 저절로 한 저장) — 잃을 글이 없으니 묻지 않고 서버 것을 불러온다
          if (!dirty) { Object.assign(s.draft, { stale: false, elsewhere: '', error: '', rebased: false }); trigger = null; toast('다른 곳에서 바뀐 내 수정본을 불러왔습니다', { ms: 4000 }); open({ keepScroll: true, sync: true }); }
        } else if ((again || dirty) && !s.draft.error) { again = false; scheduleSave(); }
        // 잠깐 끊긴 것일 수 있다 — 저장 안 된 것이 있으면 5초·10초·15초 뒤 다시 해 본다(그 뒤로는 칩의 [다시]·다음 입력이)
        else if (dirty && s.draft.error && !s.draft.stale && failCount <= RETRY_MS.length) scheduleSave(RETRY_MS[failCount - 1]);
        // 수정이 기준과 같아졌는데(변경 요청 없음) 그새 기준 글이 바뀌어 있었다 → 최신 기준으로 다시 연다
        else if (!dirty && !s.myCr && s.draft.behind > 0) open({ keepScroll: true, auto: true });
      }
    }
  }

  // ───────── v0.4 실시간 수정: 밀어 넣기(§2.2) ─────────

  /** 밀어 넣기 예약: 쉼 ms(기본 800ms) — 쉬지 않고 쳐도 첫 입력 뒤 3초 안에 한 번. o.exact: 그 시간 그대로(실패 뒤 다시 — 5·10·15초) */
  function schedulePush(ms = PUSH_IDLE_MS, o = {}) {
    if (destroyed || mode !== 'live' || reopenRequired()) return;
    const now = Date.now();
    if (!pushFirstAt) pushFirstAt = now;
    clearTimeout(pushTimer);
    const wait = o.exact ? ms : Math.max(0, Math.min(ms, pushFirstAt + PUSH_MAX_MS - now));
    pushTimer = setTimeout(() => { pushTimer = null; pushOnce().catch((e) => console.warn('[editor] 밀어 넣기:', e)); }, wait);
  }

  /**
   * 지금 편집기 글을 공유 문서에 밀어 넣는다(PUT /live?base=<편집기 기준 기록>&seq=<이 창의 차례>, 본문 = exportHwpx). 한 번에 하나 —
   * 진행 중이면 끝난 뒤 남은 것을. 응답 뒤: markClean({ changeSeq: 내보내기 직전 판 })(그새 친 글은 dirty 로 남아 다음에) → 기준 옮기기(afterPush).
   * 실패: STALE_BASE·BAD_BASE → 저절로 [내 글 옮겨 넣기] 뒤 다시, NOT_REALTIME·FORBIDDEN(문서 설정이 바뀜) → 새 방식으로, 그 밖 → 칩
   * '보내지 못함'(5·10·15초 뒤 저절로). 던지지 않는다 → 응답 | null
   */
  async function pushOnce(departure = false) {
    if (mode !== 'live' || !cw || !studio || destroyed || !h.ready || s.readOnly || reopenRequired()) return null;
    if (pushing) { pushAgain = true; return pushing; }
    if (lastSeq <= savedSeq) return null;
    clearTimeout(pushTimer); pushTimer = null; pushFirstAt = 0;
    const gen = loadGen; const seq = lastSeq; const baseV = base.version;
    s.live.pushing = true; s.draft.saving = true;
    let failed = null;
    const job = (async () => {
      const bytes = await studio.exportHwpx();
      if (gen !== loadGen || destroyed) return null;
      const k = seqBase + (++pushNo);
      mySeqs.add(k);
      if (mySeqs.size > 400) mySeqs.delete(mySeqs.values().next().value);
      const send = departure ? departureRequest(seq, gen) : api;
      const res = await send(`${d.base}/live?base=${baseV}&seq=${k}${loadedVersion ? `&loaded=${loadedVersion}` : ''}`, { method: 'PUT', body: bytes, raw: true });
      if (gen !== loadGen || destroyed) return null;
      try { await studio.notifySaved(); } catch { /* notify-saved 를 모르는 studio */ }
      await cw.markClean({ changeSeq: seq });
      savedSeq = Math.max(savedSeq, seq);
      const now = new Date().toISOString();
      s.live.pushes++; s.live.savedAt = now; s.live.error = ''; s.draft.error = ''; s.draft.savedAt = now;
      await afterPush(res, gen);
      return res;
    })();
    pushing = job;
    try { return await job; } catch (e) { failed = e; return onPushError(e); } finally {
      if (pushing === job) pushing = null;
      s.live.pushing = false; s.draft.saving = false; s.live.progress = null;
      if (gen === loadGen && !destroyed) {
        const dirty = lastSeq > savedSeq;
        h.dirty = dirty; s.draft.dirty = dirty;
        if (!failed) pushFails = 0;
        if (mode === 'live' && !failed && (pushAgain || dirty)) { pushAgain = false; schedulePush(); }
        // 다 보냈고 더 치지 않았으면 '입력 중' 알림을 거둔다(글은 이미 공유 문서에 — 남의 화면에 보인다). 밀어 넣기가 '입력 중' 알림(1초 간격)보다
        // 먼저 끝날 수 있다 — 아직 보내지 않은 알림(editPending)도 거둔다(보낸 것이 없으면 아무것도 보내지 않는다)
        if (!dirty && lastSeq === seq && (editRef != null || editPending !== undefined)) { editPending = null; flushEditing(); }
        if (syncWant) scheduleSync();
        if (!failed) queueMicrotask(onBaseMaybeChanged);
      }
    }
  }
  /**
   * 밀어 넣은 뒤 기준 옮기기(§2.4-2): clean(서버 문서 글 = 보낸 글)이면 그 판의 문단을 같은 판으로 읽어 setBase(다시 열지 않음).
   * 그새 판이 또 움직였거나 clean 이 아니면(남의 고침이 섞임·건너뜀) 맞추기로. 건너뛴 문단(남이 지움)·반영 안 되는 변경(서식·표 구조)은 알린다
   */
  async function afterPush(res, gen) {
    const v = Number(res?.version) || 0;
    if (Array.isArray(res?.skipped) && res.skipped.length) toast(`이 창에서 고친 ${res.skipped.length}문단은 그사이 다른 사람이 지워 문서에 넣지 못했습니다`, { kind: 'warn', ms: 7000 });
    if (Number(res?.unsupported) > 0 && !warnedUnsupported) {
      warnedUnsupported = true;
      // (그림·표·도형·글상자·차트의 넣기·지우기·옮기기·크기는 반영된다(2026-10-30) — 남은 것은 글맵시 같은 개체·머리말 안 도형 등)
      toast('글맵시 같은 일부 개체 변경은 아직 공유 문서에 들어가지 않습니다 — 그 부분은 한글에서 고쳐 주세요', { kind: 'warn', ms: 8000 });
    }
    if (!res?.clean) { wantSync({ version: v, force: true }); return; }
    // 이 밀어 넣기가 서식·그림 속성·조판 부호를 바꾼 커밋(formatVersion = 이 판)이고 서버 문서 = 보낸 문서(clean)면 편집기는 이미 그 모습이다 —
    // 서식 판을 맞춰 다시 열지 않는다(그림 크기를 바꾼 사람의 화면이 1초 뒤 다시 열리던 것)
    if (v && Number(res?.formatVersion) === v) loadedFormatVersion = Math.max(loadedFormatVersion, v);
    if (!v || v <= base.version) return;   // 바꿀 것이 없었다(커밋 없음)
    const rb = await readBase();
    if (gen !== loadGen || destroyed) return;
    if (rb && rb.version === v) { await setBaseTo(rb.version, rb.paragraphs); storeParas(rb.version, rb.paragraphs); return; }
    // 그새 다른 사람이 또 고쳤다(판이 움직임) — 맞춘다
    wantSync({ version: rb?.version || v, force: true });
  }
  /** 밀어 넣기 실패 → null(머리 주석 v0.4) */
  function onPushError(e) {
    const code = e?.code;
    if (destroyed) return null;
    const fileReplaced = code === 'FILE_REPLACED';
    if ((code === 'TUTORIAL_RESTORED' || fileReplaced) && e?.data?.reload) {
      clearTimeout(pushTimer); pushTimer = null; pushFirstAt = 0; pushAgain = false;
      clearTimeout(syncTimer); syncTimer = null; syncWant = null;
      const message = fileReplaced
        ? '문서가 이력의 파일로 교체되어 이 창의 자동 저장이 멈췄습니다. [다시 열기]로 최신 문서를 여세요.'
        : '다른 창에서 이 연습 문서를 복구했습니다. 이 창의 글은 자동 저장하지 않습니다. [다시 열기]로 복구한 문서를 여세요.';
      Object.assign(s.draft, { tutorialRestored: !fileReplaced, fileReplaced, stale: true, rebased: false,
        elsewhere: fileReplaced ? '문서 파일 교체됨' : '연습 문서 복구됨', error: message });
      s.live.error = message;
      toast(message, { kind: 'warn', ms: 10000 });
      return null;
    }
    // (아래 둘은 이 창이 알아서 푼다 — 지난 '보내지 못함'은 지운다)
    if (code === 'STALE_BASE' || code === 'BAD_BASE' || code === 'NOT_REALTIME' || code === 'FORBIDDEN') { s.live.error = ''; s.draft.error = ''; pushFails = 0; }
    // (곧바로 부른다 — 앞부분이 바로 carrying·switching 을 세워 그 사이 맞추기가 옛 기준으로 또 밀어 넣지 않게)
    if (code === 'STALE_BASE' || code === 'BAD_BASE') {
      // 편집기 기준 기록이 정리됐다(오래 쉰 창) — 지금 문서를 열고 이 창에서 고친 글을 옮겨 넣은 뒤 곧 밀어 넣는다(§2.4-4, 글을 잃지 않음)
      carryOver({ live: true }).catch((err) => console.warn('[editor] 옮겨 넣기:', err));
      return null;
    }
    if (code === 'NOT_REALTIME' || code === 'FORBIDDEN') {
      // 문서 설정이 바뀌었다(승인 방식으로·수정 권한 없음) — 새 방식으로 다시 연다(보내지 못한 글은 승인 방식이면 내 수정본으로 옮겨 넣는다)
      d.refresh?.(['info']);
      switchMode({ lost: code }).catch((err) => console.warn('[editor] 방식 바꾸기:', err));
      return null;
    }
    pushFails++;
    s.live.error = e?.message || String(e); s.draft.error = s.live.error;
    // [hwpx-cowork] 저장 실패가 UI 상태에만 남아 복사/붙여넣기 장애를 추적할 수 없었다.
    // 본문·클립보드 내용 없이 코드와 요청 기준만 기존 client-log에 남긴다.
    console.warn('[LivePush] save failed', { endpoint: d.base, base: base?.version, code: e?.code || '', message: s.live.error });
    if (pushFails <= RETRY_MS.length) schedulePush(RETRY_MS[pushFails - 1], { exact: true });
    return null;
  }

  // ───────── v0.4 실시간 수정: 맞추기(따라가기, §2.4) ─────────

  /** 지금 기준 문단을 같은 판으로 읽는다(앞뒤 문서 정보의 판이 같을 때 — V3 §5.2-1) → { version, paragraphs } | null */
  async function readBase() {
    for (let k = 0; k < 3; k++) {
      const a = await api(d.base);
      const paragraphs = await api(`${d.base}/paragraphs?view=final`);
      const b = await api(d.base);
      const v1 = Number(a?.version) || 0; const v2 = Number(b?.version) || 0;
      if (v1 === v2) {
        if (!s.info || v2 >= (Number(s.info.version) || 0)) d.applyInfo?.(b);
        return { version: v2, paragraphs };
      }
      if (destroyed) return null;
    }
    return null;
  }
  /** 편집기 기준을 그 판·문단으로(플러그인 setBase) */
  async function setBaseTo(version, paragraphs) {
    await cw.setBase({ version, paragraphs: plain(paragraphs) });
    base = { version, sig: textSig(paragraphs), pars: paragraphs };
    h.baseVersion = version; s.draft.baseVersion = version; s.draft.behind = 0;
    savedShape = { texts: new Map(), inserted: new Set(), deleted: new Set() };
  }
  /** store 의 문단 목록도 그 판으로(더 새것이 이미 있으면 그대로) — 같은 목록이면 기준 지도가 필요 없다 */
  function storeParas(version, paragraphs) {
    if (version >= (Number(s.paraVersion) || 0)) { s.paragraphs = paragraphs; s.paraVersion = version; }
  }
  const reopenRequired = () => s.draft.tutorialRestored || s.draft.fileReplaced;
  /** 맞춤 대기에 더한다(남의 고침·섞인 밀어 넣기). by·refs = 고친 사람·그 자리(지금 기준 ref — 밑줄 색), force = 판을 몰라도 확인 */
  function wantSync({ version = 0, by = null, refs = [], force = false, formatting = false } = {}) {
    if (mode === 'review' || destroyed || reopenRequired()) return;
    if (!syncWant) syncWant = { version: 0, since: Date.now(), by: new Map(), last: null, force: false };
    syncWant.version = Math.max(syncWant.version, Number(version) || 0);
    if (force) syncWant.force = true;
    if (formatting) { syncWant.formatting = true; syncWant.force = true; }
    if (by) { syncWant.last = by; for (const r of Array.isArray(refs) ? refs : []) if (typeof r === 'string') syncWant.by.set(r, by); }
    scheduleSync();
  }
  /** 맞출 수 없는 때: 밀어 넣기·저장·열기·잠금·방식 바꾸기·옮겨 넣기 중, 또는 보내지 못한 내 글이 있음(그 글을 먼저 보내야 한다) */
  const syncBusy = () => !!pushing || !!saving || !!syncRun || h.loading || !h.ready || !!h.locked || locks > 0 || holds > 0 || switching || carrying
    || (mode === 'live' && !!s.live.error && lastSeq > savedSeq);
  /** 맞추기 예약: 마지막 입력 뒤 700ms(맞춤 대기가 8초를 넘으면 400ms) 쉼 */
  function scheduleSync(delay) {
    if (!syncWant || destroyed) return;
    clearTimeout(syncTimer);
    const now = Date.now();
    const need = now - syncWant.since > SYNC_LATE_MS ? SYNC_LATE_IDLE_MS : SYNC_IDLE_MS;
    const wait = delay != null ? delay : Math.max(0, need - (now - lastInputAt));
    syncTimer = setTimeout(() => { syncTimer = null; trySync(); }, wait);
  }
  function trySync() {
    const w = syncWant;
    if (!w || destroyed || syncRun) return;
    if (!w.force && w.version && w.version <= base.version) { syncWant = null; return; }
    if (syncBusy()) { scheduleSync(SYNC_RETRY_MS); return; }
    const now = Date.now();
    const need = now - w.since > SYNC_LATE_MS ? SYNC_LATE_IDLE_MS : SYNC_IDLE_MS;
    if (now - lastInputAt < need) { scheduleSync(); return; }
    syncWant = null;
    const run = runSync(w).catch((e) => { console.warn('[editor] 맞추기:', e); requeue(w, 1000); });
    syncRun = run;
    run.finally(() => {
      if (syncRun === run) syncRun = null;
      if (syncWant) scheduleSync();
      queueMicrotask(onBaseMaybeChanged);
    });
  }
  /** 맞춤 대기를 되돌려 둔다(그새 쳤다 등) — 처음 대기 시각(8초 규칙)은 지킨다 */
  function requeue(w, delay) {
    if (destroyed || mode === 'review' || reopenRequired()) return;
    if (!syncWant) syncWant = w;
    else {
      syncWant.version = Math.max(syncWant.version, w.version); syncWant.since = Math.min(syncWant.since, w.since); syncWant.force ||= w.force;
      syncWant.formatting ||= w.formatting;
      for (const [k, v] of w.by) if (!syncWant.by.has(k)) syncWant.by.set(k, v);
      syncWant.last ||= w.last;
    }
    scheduleSync(delay);
  }
  /** 맞추기 한 번(머리 주석 v0.4 ①~⑤) */
  async function runSync(w) {
    const gen = loadGen;
    h.syncing = true;
    try {
      // ① 저장 안 된 내 편집을 먼저 밀어 넣는다(맞추면 그 글이 기준 글로 돌아가므로)
      if (mode === 'live' && lastSeq > savedSeq) {
        await pushOnce();
        if (gen !== loadGen || destroyed) return;
        if (lastSeq > savedSeq) { requeue(w); return; }   // 보내지 못했거나 그새 또 쳤다 — 다음 쉼에
      }
      // 글이 같아도 서식은 달라질 수 있다. 저장을 마친 뒤 원본 HWPX를 다시 읽는다.
      // 단 그 서식 판을 이미 보고 있으면(내 밀어 넣기가 만든 서식·그림·부호 커밋 — afterPush) 다시 열지 않고 글만 맞춘다
      const seenFormat = (Number(s.info?.formatVersion) || 0) <= loadedFormatVersion && (Number(w.version) || 0) <= base.version;
      if (w.formatting && !seenFormat) { await reopenKeep({ push: true }); return; }
      // ② 지금 기준 문단(같은 판 읽기)
      const rb = await readBase();
      if (gen !== loadGen || destroyed) return;
      if (!rb) { requeue(w, 500); return; }
      if (rb.version <= base.version) return;   // 이미 맞음(내 밀어 넣기가 기준을 옮겼다)
      // 그새 친 글이 있으면(맞추면 그 글이 지워진다) 맞추지 않고 다음 쉼에 — 먼저 밀어 넣는다
      if (mode === 'live' && lastSeq > savedSeq) { requeue(w); return; }
      const seq0 = lastSeq;
      const prev = { ...base };
      await setBaseTo(rb.version, rb.paragraphs);
      if (gen !== loadGen || destroyed) return;
      let r;
      if (mode === 'live' && lastSeq !== seq0) r = { ok: false, reason: 'TYPED' };
      else if (typeof cw?.syncToBase !== 'function') r = { ok: false, reason: 'UNSUPPORTED' };
      // ③ 편집기 글을 기준 글로(바뀐 문단만 — 캐럿·스크롤 그대로, 되돌리기 기록 비움). 플러그인 안에서 한 번에 끝난다
      else r = (await call('syncToBase', undefined, null)) || { ok: false, reason: 'READONLY' };
      if (gen !== loadGen || destroyed) return;
      if (r.ok) {
        // ④ 깨끗함(편집기 = 새 기준)
        try { await cw.markClean({ changeSeq: lastSeq }); } catch { /* 다음 'draft' 가 맞춘다 */ }
        savedSeq = Math.max(savedSeq, lastSeq);
        if (mode === 'live') { h.dirty = false; s.draft.dirty = false; }
        storeParas(rb.version, rb.paragraphs);
        syncBusyTries = 0;
        s.live.syncs++;
        s.live.lastSync = { at: new Date().toISOString(), version: rb.version, changed: r.changed || [], inserted: r.inserted || [], deleted: Number(r.deleted) || 0, by: w.last || null };
        // ⑤ 남이 바꾼 자리를 그 사람 색으로 잠깐 밑줄(스크롤하지 않음)
        flashChanged(r, w);
        return;
      }
      // 맞추지 못했다 — 기준을 되돌린다(편집기 글은 그대로 옛 기준 — 그 기준으로 밀어 넣어야 남의 글을 되돌리지 않는다)
      try { await cw.setBase({ version: prev.version, paragraphs: plain(prev.pars) }); } catch { /* 다시 열기가 맞춘다 */ }
      base = prev; h.baseVersion = prev.version; s.draft.baseVersion = prev.version;
      if (r.reason === 'TYPED') { requeue(w); return; }
      if (r.reason === 'BUSY' && ++syncBusyTries <= SYNC_BUSY_MAX) { requeue(w, SYNC_BUSY_MS); return; }
      syncBusyTries = 0;
      // 표 구조·개체·문단 수 차이가 커서 등 — 조용히 다시 열기(스크롤·캐럿 그대로)
      console.info(`[editor] 맞추기 대신 다시 열기(${r.reason}${r.message ? `: ${r.message}` : ''})`);
      await reopenKeep({ push: true });
    } finally { h.syncing = false; }
  }
  /** 맞춘 자리 밑줄: 바뀐·넣은 문단을 고친 사람 색으로(WS 의 자리별 사람, 모르면 마지막 사람) */
  function flashChanged(r, w) {
    const refs = [...(Array.isArray(r?.changed) ? r.changed : []), ...(Array.isArray(r?.inserted) ? r.inserted : [])];
    if (!refs.length) return;
    const groups = new Map();
    for (const ref of refs) {
      const by = w?.by?.get(ref) || w?.last || '';
      const color = by ? d.colorOf?.(by) || '' : '';
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push({ ref });
    }
    for (const [color, list] of groups) flash(list, color ? { color, scroll: false } : { scroll: false });
  }
  /**
   * 조용히 다시 열기(맞추기를 못 할 때·방식이 바뀔 때): 잠그고(싣는 동안 친 글이 엉뚱한 자리로 가지 않게) → (push 면) 내 글을 먼저 밀어 넣고 →
   * 지금 선택(기준 자리)을 기억 → 다시 열기(스크롤 기억) → 풀고 캐럿·선택을 새 기준 자리로 되살린다(편집기에 포커스가 있었을 때만 포커스도)
   */
  async function reopenKeep({ push = false } = {}) {
    if (destroyed || !cw) return;
    let hadFocus = false; let prevActive = null;
    try { hadFocus = document.activeElement === iframe; prevActive = hadFocus ? null : document.activeElement; } catch { hadFocus = false; }
    let caret = null;
    const release = lock('최신 문서로 맞추는 중…');
    try {
      if (push && mode === 'live' && lastSeq > savedSeq) await pushOnce();
      if (push && mode === 'live' && lastSeq > savedSeq) throw new Error('저장하지 못한 편집이 있어 최신 문서를 아직 열 수 없습니다.');
      const sel = await call('getSelection', undefined, null);
      if (sel && sel.ref) caret = { ref: sel.ref, start: Number(sel.start) || 0, end: Number(sel.end ?? sel.start) || 0, endRef: sel.endRef && sel.endRef !== sel.ref ? sel.endRef : null, pars: base.pars };
      s.live.reopens++;
      await open({ keepScroll: true, auto: true, live: true });
    } finally { release(); }
    if (caret && h.ready && !destroyed) await restoreCaret(caret, hadFocus, prevActive);
  }
  /** 다시 연 뒤 캐럿·선택을 되살린다 — 옛 기준 자리를 새 기준 자리로 옮겨(기준 지도) 플러그인 선택으로. 스크롤은 그대로 */
  async function restoreCaret(caret, hadFocus, prevActive) {
    try {
      const M = caret.pars && caret.pars !== base.pars ? buildBaseMap(caret.pars, base.pars) : null;
      const rg = M ? M.range('c', { ref: caret.ref, start: caret.start, end: caret.end, ...(caret.endRef ? { endRef: caret.endRef } : {}) }) : caret;
      if (!rg || !rg.ref || typeof cw?.debug?.select !== 'function') return;
      const sc = readScroll();
      cw.debug.select(rg.ref, rg.start ?? 0, rg.end ?? rg.start ?? 0, rg.endRef && rg.endRef !== rg.ref ? rg.endRef : undefined);
      if (sc) await restoreScroll(sc);
      // 편집기 밖(메모 창 등)에 포커스가 있었으면 돌려준다(선택은 편집기로 포커스를 옮긴다)
      if (foreground && !hadFocus && prevActive && typeof prevActive.focus === 'function' && prevActive !== document.body && prevActive.isConnected) prevActive.focus({ preventScroll: true });
    } catch (e) { console.warn('[editor] 캐럿 되살리기:', e); }
  }

  // ───────── v0.4 문서 설정이 바뀜(§2.4-7) ─────────

  /** 지금 설정(s.settings·s.canEdit)으로 본 방식이 이 편집기의 방식과 다르면 바꾼다 */
  function maybeSwitchMode() {
    // 여는 중이면 그 열기가 정한 방식이 끝난 뒤 다시 본다(openBody 끝에서 부른다)
    if (!h.ready || destroyed || !s.settings || h.loading || holds > 0 || switching) return;
    const want = modeOfInfo({ settings: s.settings, canEdit: s.canEdit });
    if (want !== mode) switchMode().catch((e) => console.warn('[editor] 방식 바꾸기:', e));
  }
  /**
   * 방식 바꾸기: 저장 안 된 것을 지금 방식으로 먼저 보내고(실시간 = 밀어 넣기, 승인 = 내 수정본 저장) 새 방식으로 다시 연다(스크롤·캐럿 그대로).
   * 실시간 글을 보내지 못했으면(설정이 이미 바뀌어 서버가 받지 않음 — lost) 새 방식이 승인 방식이면 내 수정본으로 옮겨 넣고(carryOver),
   * 읽기 전용이면 알린다(넣을 길이 없다)
   */
  async function switchMode({ lost = null } = {}) {
    if (destroyed || !h.ready) return;
    if (switching) { switchAgain = true; return; }
    switching = true;
    let deferred = false;
    try {
      let carry = false;
      if (mode === 'live' && lastSeq > savedSeq) {
        if (!lost) { try { await pushOnce(); } catch { /* 아래 */ } }
        carry = lastSeq > savedSeq;
      } else if (mode === 'review' && (h.dirty || lastSeq > savedSeq)) {
        try { await saveNow(); } catch { /* 저장을 멈춘 상태 — 다시 열면 그 글은 사라진다 */ }
      }
      const info = await api(d.base).catch(() => null);
      // 서버 것을 store 에도(그래야 maybeSwitchMode 의 방식과 여기서 연 방식이 같다 — 되풀이하지 않게)
      if (info && (!s.info || (Number(info.version) || 0) >= (Number(s.info.version) || 0))) d.applyInfo?.(info);
      const next = info ? modeOfInfo(info) : null;
      if (carry && next === 'review') { await carryOver({ quiet: true }); return; }
      if (next && next !== mode && (h.dirty || lastSeq > savedSeq)) {
        deferred = true;
        const message = '저장하지 못한 변경이 이 탭에 남아 있습니다. 변경을 저장한 뒤 편집 방식을 바꿀 수 있습니다.';
        if (s.draft.error !== message) {
          s.draft.error = message;
          toast(message, { kind: 'warn', ms: 9000 });
        }
        return;
      }
      if (next && next !== mode) await reopenKeep();
    } finally {
      switching = false; switchAgain = false;
      // 바꾸는 사이 설정이 또 바뀌었으면(그때 온 알림은 기다리지 않았다) 한 번 더 본다
      if (!deferred) setTimeout(() => maybeSwitchMode(), 0);
    }
  }

  // ───────── 이 창 밖에서 바뀐 서버 내 수정본(같은 사람의 다른 창·기기, 관리자) ─────────

  /** 서버 내 수정본이 이 창이 아는 것(known)과 같은지 곧 확인한다(내 변경 요청 WS 알림·WebSocket 붙음) */
  function checkMine(delay = 200) {
    if (destroyed || !cw || mode !== 'review') return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { checkTimer = null; runCheck().catch((e) => console.warn('[editor] 내 수정본 확인:', e?.message || e)); }, delay);
  }
  // 이 창의 저장·열기·잠금(반영·최신 반영 등 store 동작)이 진행 중이면 끝난 뒤에 본다 — 그 결과가 known 에 들어간다
  const checkBusy = () => !!saving || h.loading || !h.ready || !!h.locked;
  async function runCheck() {
    if (destroyed || !cw) return;
    if (checkBusy()) { if (++checkTries <= 300) checkMine(400); return; }
    const g0 = `${saveGen}:${loadGen}`;
    const mine = await api(`${d.base}/drafts/mine`);
    if (destroyed) return;
    // 읽는 사이 이 창이 저장·열기를 시작했으면 그 결과와 견줄 수 없다 — 끝난 뒤 다시
    if (checkBusy() || `${saveGen}:${loadGen}` !== g0) { if (++checkTries <= 300) checkMine(400); return; }
    checkTries = 0;
    // 같은 내용이면(판만 바뀌었어도) 그 판을 이 창의 판으로 — 다음 저장이 헛되이 DRAFT_STALE 로 멈추지 않게
    if (draftSig(mine?.cr) === known) { trigger = null; const r = revOf(mine); if (r != null) rev = r; return; }
    changedElsewhere(!!mine?.cr, newerBase(mine));
  }
  /**
   * 확인을 부른 알림(trigger — 확인이 같다고 끝나면 지운다)과 서버에 지금 내 수정본이 있는지(has)·더 새 기준인지(newer — 서버 수정본의
   * 기준 버전, 아니면 0)로 쓰는 글: { toast(불러올 때), label(칩), tip(칩 설명) }
   */
  function elsewhereWhy(has = true, newer = 0) {
    const t = trigger;
    // 다른 창(기기)이 최신 반영(다시 맞춤)했다 — 이 창의 옛 기준 글로는 덮어쓸 수 없다(칩 [내 글 옮겨 넣기])
    if (has && newer) {
      const where = t ? '다른 창(기기)에서' : '이 창 밖에서';
      return {
        toast: `${where} 최신으로 맞춘 내 수정본을 불러왔습니다`,
        label: `${where} ${t?.action === 'rebased' ? ELSEWHERE_KO.rebased[1] : '새 버전으로 바뀜'}`,
        tip: rebasedTip(where, newer),
      };
    }
    // 남(관리자)이나 내 에이전트('홍길동(Claude)')가 한 일이면 그 이름으로. 내 이름 그대로면 같은 계정의 다른 창·기기
    const by = t?.by && t.by !== (state.me?.name || '') ? t.by : '';
    const ko = ELSEWHERE_KO[t?.action];
    if (by && ko) {
      const head = `${josa(`내 변경 요청 #${t.cid}`, '이/가')} ${ko[0]}(${by})`;
      // 사람이 반영·닫은 알림은 store 가 이미 띄웠다(에이전트·AI 이름은 store 가 알리지 않는다)
      const told = ['merged', 'closed'].includes(t.action) && !/AI/.test(by) && !by.includes('(');
      return {
        specific: true,
        toast: told ? '' : `${head} — ${has ? '그 수정본을' : '공유 문서를'} 편집기에 엽니다`,
        label: `변경 요청 #${t.cid} ${ko[1]}(${by})`,
        tip: `${head}. 여기서 친 글은 아직 저장되지 않았습니다 — [다시 열기]: 서버의 지금 상태를 불러옴(친 글은 버림) · [이 글로 저장]: 이 창 글을 내 수정본으로 저장`,
      };
    }
    // 내 알림이면 같은 계정의 다른 창·기기, 알림 없이(WebSocket 다시 붙음) 알게 됐으면 누가 했는지 모른다
    const where = t ? '다른 창(기기)에서' : '이 창 밖에서';
    if (!has) {
      return {
        toast: `${where} 내 수정본이 끝났습니다(버림·반영·닫힘) — 편집기를 공유 문서로 다시 엽니다`,
        label: `${where} 내 수정본이 끝남`,
        tip: `${where} 내 수정본을 버렸거나 반영·닫았습니다. 여기서 친 글은 아직 저장되지 않았습니다 — [다시 열기]: 공유 문서를 불러옴(여기서 친 글은 버림) · [이 글로 저장]: 이 창 글로 새 수정본을 만듦`,
      };
    }
    return {
      toast: `${where} 바뀐 내 수정본을 불러왔습니다`,
      label: `${where} 바뀐 수정본`,
      tip: `${where} 내 수정본이 바뀌었습니다. 여기서 친 글은 아직 저장되지 않았습니다 — [다시 열기]: 그 수정본을 불러옴(여기서 친 글은 버림) · [이 글로 저장]: 이 창 글로 덮어씀`,
    };
  }
  /** 서버 내 수정본이 이 창 밖에서 바뀌었다(has = 지금 서버에 내 수정본이 있음): 저장 안 된 편집이 없으면 새 상태를 불러오고, 있으면 저장을 멈춰 칩으로 묻는다 */
  function changedElsewhere(has, newer = 0) {
    const dirty = h.dirty || lastSeq > savedSeq;
    if (!dirty && !saving) {
      const why = elsewhereWhy(has, newer);
      if (why.toast) toast(why.toast, { ms: 4000 });
      open({ keepScroll: true, sync: true });
      return;
    }
    stopForElsewhere(has, newer);
  }
  /**
   * 저장을 멈춘다(덮어쓰지 않게) — 칩: '<label> —' [다시 열기] [이 글로 저장]
   * (서버 수정본이 더 새 기준이면 덮어쓸 수 없으므로 [이 글로 저장] 대신 [내 글 옮겨 넣기] — s.draft.rebased).
   * 이미 멈춰 있으면(예: 409 DRAFT_STALE '다른 곳에서 바뀜') 새 확인이 더 알려 주는 것(남이 반영·닫음, 서버에 내 수정본이 없어짐,
   * 더 새 기준)이 있을 때만 글을 바꾼다
   */
  function stopForElsewhere(has = true, newer = 0) {
    const why = elsewhereWhy(has, newer);
    clearTimeout(saveTimer); saveTimer = null; firstEditAt = 0;
    const rebased = !!(has && newer);
    if (s.draft.stale && s.draft.elsewhere && has && !why.specific && !(rebased && !s.draft.rebased)) return;
    Object.assign(s.draft, { stale: true, elsewhere: why.label, error: why.tip, rebased });
  }

  /**
   * [내 글 옮겨 넣기](머리 주석 9): 다른 곳(같은 사람의 다른 창·기기)에서 내 수정본을 더 새 기준으로 다시 맞춰 이 창의 옛 기준 글을 저장할 수 없을 때.
   * 이 창에서 고친 문단(편집기 기준 대비 — 플러그인 draftState)과 그 글을 모아 두고 → 서버의 지금 수정본을 다시 연 뒤 → 새 기준 자리로 옮겨 넣는다.
   *  - 바꾼 문단: 연 수정본의 그 문단이 이 창의 기준 글 그대로면 이 창 글로 바꾸고(이미 같으면 그대로), 그 사이 다른 곳에서도 바뀌었거나
   *    문단이 없어졌으면 덮어쓰지 않고 바로 뒤(없으면 앞 문단 뒤)에 '[이 창에서 고친 글] …' 문단으로 넣는다 — 사람이 맞춰 고친 뒤 지운다(글을 잃지 않게)
   *  - 넣은 문단: 연 수정본에 같은 글의 넣은 문단이 없으면 그 앞 문단(새 자리) 뒤에 넣는다
   *  - 지운 문단: 다시 지우지 않는다(알림으로 알린다 — 지우는 반영은 편집기에서)
   * 넣은 것이 있으면 곧 자동 저장. → { applied, marked, inserted, deleted } | null(옮길 수 없음)
   */
  // v0.4: o.live = 실시간 밀어 넣기가 409 STALE_BASE(편집기 기준 기록이 정리됨) — 지금 문서를 열고 옮겨 넣은 뒤 곧 밀어 넣는다(§2.4-4).
  //       o.quiet = 문서 설정이 승인 방식으로 바뀌어 보내지 못한 실시간 글을 새 방식(내 수정본)으로 옮겨 넣는다(§2.4-7). 알림 글만 다르다
  async function carryOver(o = {}) {
    if (!cw || destroyed || !h.ready || carrying) return null;
    const readCur = edText;
    if (typeof cw?.debug?.text !== 'function') { toast('이 편집기 판은 글을 옮겨 넣을 수 없습니다 — [다시 열기]를 쓰세요', { kind: 'error' }); return null; }
    const where = o.live ? '지금 문서' : o.quiet ? '내 수정본' : '새 수정본';
    carrying = true;
    try {
      // 이 창에서 마지막으로 열거나 저장한 뒤 고친 것만(그 전 것은 서버 수정본에 이미 있다 — 다른 곳에서 그 뒤에 또 고쳤을 수도 있으니 되살리지 않는다)
      const st = await call('draftState', undefined, null);
      const oldPars = base.pars; const oldIdx = indexParas(oldPars); const known0 = savedShape;
      const changed = []; const inserted = []; const deleted = [];
      for (const ref of st?.changed || []) {
        const text = readCur(ref); if (text == null || known0.texts.get(ref) === text) continue;
        changed.push({ ref, from: known0.texts.has(ref) ? known0.texts.get(ref) : String(oldIdx.byRef.get(ref)?.text ?? ''), text });
      }
      for (const x of st?.inserted || []) { const t = String(x?.text ?? ''); if (t.trim() && !known0.inserted.has(t)) inserted.push({ afterRef: x.afterRef ?? null, text: t }); }
      for (const ref of st?.deleted || []) if (!known0.deleted.has(ref)) deleted.push({ ref, text: String(oldIdx.byRef.get(ref)?.text ?? '') });
      if (!changed.length && !inserted.length && !deleted.length) { Object.assign(s.draft, { stale: false, elsewhere: '', error: '', rebased: false }); await open({ keepScroll: true }); return { applied: 0, marked: 0, inserted: 0, deleted: 0 }; }
      // 서버의 지금 수정본을 연다(이 창 글은 위에 모아 두었다)
      Object.assign(s.draft, { stale: false, elsewhere: '', error: '', rebased: false });
      await open({ keepScroll: true });
      if (destroyed || !h.ready || !cw) return null;
      const M = buildBaseMap(oldPars, base.pars);   // 옛 편집기 기준 → 새 편집기 기준('c' 방향)
      const to = (r) => (M ? M.ref('c', r) : r); const toAfter = (r) => (r == null ? null : M ? M.after('c', r) : r);
      const now = await call('draftState', undefined, null);
      const have = new Set((now?.inserted || []).map((x) => String(x?.text ?? '')));
      let applied = 0; let marked = 0; let added = 0; let dropped = 0;
      const MARK = '[이 창에서 고친 글] ';
      for (const c of changed) {
        const r2 = to(c.ref); const cur = r2 ? readCur(r2) : null;
        if (cur != null && cur === c.text) continue;   // 이미 같다(다른 곳에서 저장해 둔 글)
        if (cur != null && cur === c.from) {
          const r = await call('applyText', { ref: r2, replace: c.text, label: '이 창 글 옮겨 넣기' }, { ok: false });
          if (r?.ok) { applied++; continue; }
        }
        // 그 사이 다른 곳에서도 바뀌었다(또는 문단이 없어짐) — 덮어쓰지 않고 바로 뒤에 따로 넣는다
        const af = r2 && cur != null ? r2 : toAfter(c.ref);
        const r = af ? await call('insertParagraphAfter', { afterRef: af, text: MARK + c.text }, { ok: false }) : null;
        if (r?.ok) marked++; else dropped++;
      }
      for (const x of inserted) {
        if (have.has(x.text)) continue;
        const af = toAfter(x.afterRef);
        const r = af ? await call('insertParagraphAfter', { afterRef: af, text: x.text }, { ok: false }) : null;
        if (r?.ok) added++; else dropped++;
      }
      // 이 창에서 지운 문단 중 연 수정본에 아직 있는 것(다른 곳에서 지운 것은 이미 없다)
      const stillThere = deleted.filter((x) => { const r2 = to(x.ref); return r2 && readCur(r2) != null; }).length;
      if (applied || marked || added) { h.dirty = true; s.draft.dirty = true; saveSoon(); }
      const parts = [];
      if (applied + added) parts.push(`이 창에서 고친 ${applied + added}문단을 ${where}에 옮겨 넣었습니다`);
      if (marked) parts.push(`다른 곳에서도 바뀐 ${marked}문단은 덮어쓰지 않고 바로 뒤에 '${MARK.trim()}' 문단으로 넣었습니다 — 맞춰 고친 뒤 그 문단을 지우세요`);
      if (stillThere) parts.push(`이 창에서 지운 ${stillThere}문단은 다시 지우지 않았습니다(편집기에서 지우세요)`);
      if (dropped) parts.push(`${dropped}문단은 넣을 자리를 찾지 못했습니다`);
      toast(parts.join(' · ') || `옮겨 넣을 글이 없습니다(${where}에 이미 들어 있음)`, { kind: marked || dropped ? 'error' : 'info', ms: marked || dropped || stillThere ? 9000 : 5000 });
      return { applied: applied + added, marked, inserted: added, deleted: stillThere, dropped };
    } finally { carrying = false; }
  }

  // ───────── store → 플러그인 ─────────

  /** 내가 내 수정본에 반영해 두었고 지금도 편집기 글(s.draft: 플러그인 'draft')에 들어 있는 대기 제안 pid */
  function adoptedNow() {
    const out = new Set();
    for (const p of s.proposals) if (p.status === 'pending' && d.adoptedByMe?.(p) && adoptionInEffect(p, s.draft)) out.add(Number(p.pid));
    return out;
  }

  /**
   * AI 작업 메모 강조(§9.7): 내 눈의 진행(store d.progress)이 해결이면 해결된 메모처럼(resolved — 플러그인이 숨기고 레일 카드도 없다),
   * 그리고 내가 한 번에 반영할 수 있는 남은 바꿈·문단 추가 수(open — 우클릭 'AI 작업 메모 ▸ 남은 제안 모두 반영(n)', 요청자·관리자만)
   */
  function requestViewOf(rid) {
    const r = d.request?.(rid);
    if (!r || typeof d.progress !== 'function') return null;
    const g = d.progress(r);
    if (!g) return null;
    // (canResolve = 요청자·관리자 + 수정 권한 + '간단히'에서 숨는 남의 요청이 아님 — store)
    const can = typeof d.canResolve === 'function' ? !!d.canResolve(r) : false;
    // 실시간 문서는 표 제안도 공유 문서에 바로 반영한다(서버 resolve { apply }) — 승인 방식은 표 제안을 수정본에 넣지 못한다
    // 수는 남은 항목(묶음 제안은 하나 — docs/UI_TERMS.md §9, util.requestProgress adoptOpen). adoptOpen 이 없는 옛 꼴이면 제안 수
    const n = d.realtime?.() ? g.open - g.openAlt : g.adoptOpen ?? g.openPids.length - g.tables;
    // 진행 단계(ui.js requestPhase — docs/UI_TERMS.md §6): 편집기 강조도 응답 대기(붉은 톤)·처리 중(보라, 움직임)·내 차례(테두리)를 칩과 같이.
    // 오래 응답 없음(late)은 편집기에서는 대기와 같게(시각에 따라 강조를 다시 보내지 않게)
    const ph = requestPhase(d, r);
    return { resolved: !!g.resolved, open: can && !g.resolved ? Math.max(0, n) : 0, phase: ph === 'late' ? 'wait' : ph };
  }

  function pushAnnotations(now = false) {
    clearTimeout(annTimer);
    const run = () => {
      annTimer = null;
      if (!cw || !h.ready || destroyed) return;
      let a;
      try {
        // v0.4 보기(§5): '간단히'에서 남의 AI 작업 제안은 강조·우클릭 항목에서 뺀다(한 줄 요약 카드만). 실시간 문서의 반영 = 공유 문서에 바로(우클릭 '문서에 반영')
        a = buildAnnotations({ memos: s.memos, proposals: s.proposals, changes: s.changes, requests: s.requests, paragraphs: s.paragraphs, crs: s.crs, editing: s.editing },
          { me: state.me?.name || '', requestView: requestViewOf, proposalVisible: (p) => !d.proposalHidden?.(p), adoptLabel: d.realtime?.() ? '문서에 반영' : undefined });
        // 내 수정본에 이미 반영한 제안은 그리지 않고 우클릭에 '내 수정본에 반영'을 내지 않게(플러그인은 대기만 그린다, 메뉴는 '내 수정본에 반영' 표시만).
        // 그 제안 메모도 뺀다 — 대기 아닌 제안의 메모는 플러그인이 메모로 그리는데, 레일은 대기 제안의 메모 카드를 만들지 않아 카드 없는 강조가 된다.
        // (편집기에서 되돌리면 그 문단이 기준과 같아져 다시 대기로 그린다 — adoptedNow 가 s.draft 를 본다)
        const adopted = adoptedNow();
        if (adopted.size) {
          for (const x of a.proposals || []) if (x.status === 'pending' && adopted.has(Number(x.pid))) x.status = 'adopted';
          const hide = new Set(s.memos.filter((m) => m.link?.type === 'proposal' && adopted.has(Number(m.link.pid))).map((m) => String(m.id)));
          if (hide.size) a.memos = (a.memos || []).filter((m) => !hide.has(String(m.id)));
        }
        // 지금 기준 ref → 편집기 기준(내 수정본이 옛 기준일 때 — 머리 주석 8)
        a = annToEd(a);
      } catch (e) { console.warn('[editor] buildAnnotations:', e); return; }
      call('setAnnotations', a, undefined);
    };
    if (now) run(); else annTimer = setTimeout(run, ANN_MS);
  }

  function setOptions() {
    // readOnly(v0.4 §2.5): 수정 권한이 없으면 편집기 읽기 전용(studio 양식 모드) — 맞추기(syncToBase)는 된다
    const o = { showResolved: !!s.showResolved, readOnly: !!s.readOnly, quickSend: quickSendLabel() };
    if (Array.isArray(state.config?.presets) && state.config.presets.length) o.presets = state.config.presets;
    call('setOptions', o, undefined);
  }
  /** AI에게 빠르게 맡기기를 누르면 바로 보낼 곳 이름표(자동 경로 — util.workEnv), 문서 설정이 확인 후 보내기면 '' → 플러그인 quickSend */
  function quickSendLabel() {
    if (!quickAutoSend(s.settings, 'instruct')) return '';
    const env = docWorkEnv(s);
    return autoSendLabel(env);
  }

  /** 기준 버전이 바뀌었나 보고 맞춘다(머리 주석 4 — v0.4 실시간·읽기 전용은 맞추기로) */
  function onBaseMaybeChanged() {
    if (!h.ready || destroyed) return;
    // 맞추는 중·방식을 바꾸는 중이면 그것이 기준을 정한다(끝나면 다시 본다)
    if (mode !== 'review' && (syncRun || switching)) return;
    // 저절로 다시 여는 중이면 그 열기가 끝에서 다시 본다(위 autoOpening 주석)
    if (autoOpening) return;
    // 문단 목록과 같은 버전으로 판단한다(정보만 먼저 와서 옛 문단과 새 버전을 맞대면 글이 바뀐 새 버전을 '같다'고 볼 수 있다)
    const ver = Number(s.paraVersion) || 0;
    const formatVersion = Number(s.info?.formatVersion) || 0;
    if (formatVersion > loadedFormatVersion) {
      if (mode !== 'review') { wantSync({ version: Number(s.info?.version) || ver, formatting: true }); return; }
      if (!s.myCr && !h.dirty && !saving && !h.loading && !h.locked) { open({ keepScroll: true, auto: true }); return; }
      s.draft.behind = Math.max(1, ver - base.version);
      return;
    }
    if (!ver || ver <= base.version || !s.paragraphs?.length) return;
    const sig = textSig(s.paragraphs);
    if (base.sig !== null && sig === base.sig) { quietAdvance(ver); return; }
    // 실시간·읽기 전용: 글이 바뀐 새 기준(알림이 없던 것 — 제안 적용·반영·복구, 놓친 알림) → 맞추기
    if (mode !== 'review') { wantSync({ version: ver }); return; }
    if (!s.myCr && !h.dirty && !saving) { open({ keepScroll: true, auto: true }); return; }
    s.draft.behind = ver - base.version;
  }
  /** 본문 글이 같은 새 기준(메모·요청 메모만 늘어남) — 다시 열지 않고 기준만 바꾼다. 내 변경 요청도 새 기준으로 저장해 둔다 */
  function quietAdvance(ver) {
    base = { version: ver, sig: base.sig, pars: toRaw(s.paragraphs) };
    h.baseVersion = ver; s.draft.baseVersion = ver; s.draft.behind = 0;
    call('setBase', { version: ver, paragraphs: s.paragraphs }, undefined);
    if (mode === 'review' && s.myCr && Number(s.myCr.baseVersion) < ver) scheduleSave(800);
  }

  function installWatches() {
    // (보기 '간단히'·'자세히'·문서 방식이 바뀌면 숨기는 제안·반영 이름이 바뀐다 — view.js)
    stops.push(watch(() => [s.memos, s.proposals, s.changes, s.requests, s.crs, s.editing, s.paragraphs, s.view, s.settings?.editMode, s.canEdit], () => pushAnnotations()));
    // v0.4 문서 설정(WS doc settings·문서 정보)이 바뀌어 방식(실시간·승인·읽기 전용)이 달라지면 지금 방식으로 저장한 뒤 새 방식으로 다시 연다
    stops.push(watch(() => [s.settings?.editMode, s.canEdit], () => maybeSwitchMode()));
    stops.push(watch(() => s.draft.dirty, dirty => { if (!dirty) maybeSwitchMode(); }));
    stops.push(watch(() => (s.active ? `${s.active.kind}\u0000${s.active.id}` : ''), () => { if (h.ready) h.setActive(s.active); }));
    stops.push(watch(() => s.focus, (f) => {
      if (!f?.ref || !h.ready) return;
      const p = { ref: f.ref, flash: true };
      if (f.start != null) p.start = f.start;
      if (f.end != null) p.end = f.end;
      if (f.endRef) p.endRef = f.endRef;
      h.focusRange(p);
    }));
    stops.push(watch(() => [s.showResolved, !!s.readOnly, quickSendLabel()], () => setOptions()));
    stops.push(watch(() => [s.paragraphs, s.paraVersion, s.info?.formatVersion], () => onBaseMaybeChanged()));
    // 반영해 둔 제안이 편집기 글에 들어갔다·빠졌다(되돌리기) → 강조·우클릭 항목을 다시
    stops.push(watch(() => [...adoptedNow()].join(','), () => pushAnnotations()));
    // 서버 내 수정본(작성자 = 나)을 바꾸는 알림 → 이 창이 아는 것과 같은지 확인(이 창이 한 일이면 같다 — 저장·동작이 끝난 뒤 견준다).
    // 다르면 다른 창·기기나 관리자가 바꾼 것: 새 것을 불러오거나(저장 안 된 편집 없음) 저장을 멈춘다(머리 주석 6)
    offs.push(d.on('ws', (msg) => {
      // (2026-11-03) 이 창이 보낸 큰 밀어 넣기의 서버 진행(server/live.js — 1초에 한 번) → 상단 칩 '반영 중 n/m'
      if (msg?.type === 'live' && msg.action === 'progress') {
        if (pushing && msg.seq != null && mySeqs.has(Number(msg.seq))) s.live.progress = { done: Number(msg.done) || 0, total: Number(msg.total) || 0 };
        return;
      }
      // v0.4 실시간·읽기 전용: 기준이 바뀜(내 밀어 넣기 말고 — 이 창이 보낸 차례 seq 로 가린다) → 맞춤 대기(치는 중이면 손을 멈출 때)
      if (msg?.type === 'doc' && msg.action === 'changed' && mode !== 'review') {
        if (msg.live && msg.seq != null && mySeqs.has(Number(msg.seq))) return;
        const v = Number(msg.version) || 0;
        if (v && v <= base.version && !msg.formatting) return;
        wantSync({ version: v, formatting: !!msg.formatting, by: msg.by || null, refs: [...(Array.isArray(msg.changed) ? msg.changed : []), ...(Array.isArray(msg.inserted) ? msg.inserted : [])] });
        return;
      }
      if (mode !== 'review') return;
      if (msg?.type !== 'cr' || !MINE_ACTIONS.has(msg.action) || !msg.author || msg.author !== (state.me?.name || '')) return;
      trigger = msg; checkTries = 0;
      checkMine();
    }));
    // (남이 내 변경 요청을 반영·닫으면 store 가 알림을 띄우고, 편집기는 위 확인이 맞춘다)
    // WebSocket 이 붙을 때(처음·다시): 그사이 놓친 알림이 있을 수 있다 → 확인
    offs.push(d.on('reconnect', () => { trigger = null; checkMine(); }));
    offs.push(d.on('ws-open', () => { trigger = null; checkMine(); }));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(saveTimer); clearTimeout(annTimer); clearTimeout(editTimer); clearTimeout(checkTimer); clearTimeout(pushTimer); clearTimeout(syncTimer);
    syncWant = null;
    for (const off of offs.splice(0)) { try { off(); } catch { /* 이미 없음 */ } }
    for (const stop of stops.splice(0)) { try { stop(); } catch { /* 이미 없음 */ } }
    unhookFrame();
    try { touchFix?.stop(); } catch { /* 편집기 창이 이미 없음 */ }
    if (editRef) api(`${d.base}/editing`, { method: 'POST', body: { ref: null } }).catch(() => {});
    try { studio?.destroy(); } catch { /* iframe 이 이미 없음 */ }
    studio = null; cw = null; iframe = null;
    h.ready = false;
    if (d.editor === h) d.editor = null;
  }

  start();
  return h;
}
