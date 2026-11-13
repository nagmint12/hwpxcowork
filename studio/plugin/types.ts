// cowork 플러그인 계약 형(docs/V3_SPEC.md §1.3, v0.4 더한 것은 docs/V4_SPEC.md §2.5) — 호스트(web/)와 JSON 으로 주고받는 모양.
// 이름·모양을 바꾸면 V3_SPEC·V4_SPEC 도 같이 고친다. 계약에 없는 필드(아래 '덧붙임')는 더해도 되는 것만 둔다.

/** 플러그인 판(window.rhwpCowork.version). scripts/build-studio.mjs 가 이 줄을 읽어 cowork-build.json 에 적는다. */
export const PLUGIN_VERSION = '0.4.0';

/** 기준 문서 문단(GET /api/docs/:id/paragraphs?view=final 그대로) */
export interface EngineParagraph {
  ref: string;
  text: string;
  where?: string;
  parent?: string | null;
  container?: string | null;
  cell?: { table: string; row: number; col: number; rowSpan?: number; colSpan?: number } | null;
  /** 본문 문단 종류(엔진 bodyEntries 와 같은 규칙) — 서버가 주면 쓰고, 없으면 중첩 칸 정보로 짐작한다 */
  kind?: string;
  sig?: string | null;
}

export interface Range { ref: string; start: number; end: number; endRef?: string }
/** 읽기·이동용 개체 위치. objectIndex는 같은 문단·종류 안의 0부터 시작하는 순번이다. */
export interface RangeLocation { ref: string; start?: number; end?: number; endRef?: string; object?: 'image' | 'table'; objectIndex?: number }

export type MemoKind = 'memo' | 'request' | 'proposal' | 'comment' | 'review';

export interface MemoAnn {
  id: string; ref: string; start: number; end: number; endRef?: string;
  kind: MemoKind; label: string; author: string; color?: string; resolved?: boolean; status?: string;
  // 덧붙임(v0.3.1 §9.7): AI 작업·AI 의견 메모의 요청 번호, AI 작업 메모의 '남은 제안 모두 반영(n)' 수(호스트가 센다 — 0 이면 없음)
  rid?: number; open?: number;
  // AI 작업 메모의 진행 단계(호스트 web/ui.js requestPhase — docs/UI_TERMS.md §6): wait·run·act·hold·ok·fail·off → 강조 cw-ph-…
  phase?: string;
}

export interface ProposalAnn {
  pid: number; type: 'replace' | 'insert' | 'table' | 'format'; ref: string;
  start?: number; end?: number; endRef?: string; find?: string; occurrence?: number; afterRef?: string;
  status: string; label: string;
}

export interface ChangeAnn { id: number; type: 'Insert' | 'Delete'; ref: string; start: number; end: number; author: string; text?: string }

export interface DraftHunkAnn { hid: string; type: 'replace' | 'insert' | 'delete' | 'format'; ref: string | null; afterRef?: string | null; preview: string }

export interface DraftAnn { cid: number; user: string; color: string; status: 'draft' | 'open'; hunks: DraftHunkAnn[] }

export interface EditingAnn { user: string; color: string; ref: string }

export interface Annotations {
  memos: MemoAnn[];
  proposals: ProposalAnn[];
  changes: ChangeAnn[];
  drafts: DraftAnn[];
  editing: EditingAnn[];
  flash?: Range | null;
}

/** iframe client 좌표 사각형 */
export interface Rect { x: number; y: number; w: number; h: number }

export interface CoworkSelection {
  ref: string; start: number; end: number; endRef: string; refs: string[]; text: string;
  collapsed: boolean; cell: boolean; tableKey?: string | null;
  source: 'base' | 'draft';
  paragraphText?: string;
  rect: Rect | null;
  // 덧붙임: source 'draft' 일 때 지금(내 수정본) 글 중 선택한 부분(한 문단 안; 여러 문단이면 첫 문단 끝까지)
  draftText?: string;
  // 덧붙임: 내 수정본에만 있는 문단(기준에 없음) — ref 는 그 앞 기준 문단(afterRef), 맨 앞이면 첫 문단
  inserted?: boolean;
  afterRef?: string | null;
  // 덧붙임: 메뉴 대상이 '문단 전체'(선택 밖을 눌렀을 때)
  whole?: boolean;
}

export interface DraftState {
  dirty: boolean;
  changed: string[];
  /** afterRef: 그 뒤에 들어간 기준 문단(구역 맨 앞이면 null) */
  inserted: Array<{ afterRef: string | null; text: string }>;
  deleted: string[];
}

export type AnchorKind = 'memo' | 'proposal' | 'draft' | 'change' | 'request';

export interface Anchor {
  kind: AnchorKind; id: string; ref: string; y: number; x: number; page: number; visible: boolean;
  // 덧붙임: 수정 중(draft) 표시의 변경 요청·덩어리
  cid?: number; hid?: string;
}

export interface CoworkOptions {
  overlays: boolean;
  miniToolbar: boolean;
  showResolved: boolean;
  /**
   * v0.4(V4 §2.5): 읽기 전용(수정 권한 없음) — studio 편집 모드 'form'(글 입력·지우기·붙여넣기·서식 명령이 막힘), 되돌리기 기록 비움,
   * applyText·insertParagraphAfter·applyBatch 는 READONLY, 우클릭 '검토' 구역의 반영·거절 항목을 숨김(메모·AI 요청은 남김). syncToBase 는 된다.
   */
  readOnly: boolean;
  // 덧붙임: 다듬기 기준(서버 /api/config 의 presets — 'AI에게 빠르게 맡기기' 목록)
  presets?: Array<{ id: string; label: string }>;
  /**
   * AI에게 빠르게 맡기기를 누르면 바로 보낼 때 그 보낼 곳 이름표('Claude Code로 보내기'·'대기열에 넣기' — 호스트 util.sendToLabel).
   * 빈 글이면 요청 창에서 확인 후 보내기(문서 설정 aiQuick 'compose') — 바로 보냄 표시(cw-send·머리글)를 하지 않는다
   */
  quickSend?: string;
}

/** applyText 인자(기준 ref·기준 offset — §1.3) */
export interface TextArgs { ref: string; find?: string; replace: string; occurrence?: number; start?: number; end?: number; label?: string }
/** insertParagraphAfter 인자 */
export interface InsertArgs { afterRef: string; text: string }

export type ApplyResult = { ok: boolean; reason?: 'NOT_FOUND' | 'NO_PARAGRAPH' | 'READONLY' | 'ERROR'; message?: string };

/** applyBatch 한 번에 받는 항목 수 한도(§9.6 — 넘으면 TOO_MANY) */
export const BATCH_MAX = 200;
export type BatchKey = string | number;
/**
 * applyBatch 항목(§9.6): op 'text' 는 applyText, 'insert' 는 insertParagraphAfter 와 같은 인자.
 * key 는 결과에 그대로 돌려준다(없으면 items 안 번호 — 0부터). 덧붙임: op 가 없으면 'text'
 */
export type BatchItem = ({ op: 'text'; key?: BatchKey } & TextArgs) | ({ op: 'insert'; key?: BatchKey } & InsertArgs);
/**
 * 항목 하나의 결과 까닭: 그 항목만 — 문단 없음(NO_PARAGRAPH)·글 없음(NOT_FOUND)·앞 항목과 겹침(OVERLAP)·덧붙임 BAD_ITEM(모르는 op),
 * 묶음 전체 — TOO_MANY·READONLY·ERROR(이때는 모든 항목이 ok:false)
 */
export type BatchItemReason = 'NOT_FOUND' | 'NO_PARAGRAPH' | 'OVERLAP' | 'BAD_ITEM' | 'TOO_MANY' | 'READONLY' | 'ERROR';
export interface BatchItemResult { key: BatchKey; ok: boolean; reason?: BatchItemReason }
/**
 * applyBatch 결과(§9.6). results 는 items 순서, applied = ok 인 항목 수.
 * ok:false(reason TOO_MANY·READONLY·ERROR)면 문서는 그대로다(트랜잭션이 던지면 studio 가 롤백). 덧붙임: 실패해도 results 를 준다
 */
export interface BatchResult { ok: boolean; applied: number; results: BatchItemResult[]; reason?: 'TOO_MANY' | 'READONLY' | 'ERROR'; message?: string }

/**
 * syncToBase 결과(V4 §2.5). ok 면 편집기 본문·칸 글 = setBase 로 준 기준 글이다('edited' 는 내지 않았고 편집기는 깨끗함 — draftState().dirty
 * false; 고친 것이 있었으면 되돌리기·다시하기 기록도 비웠다, 없었으면 트랜잭션도 기록 비우기도 없다). changed·inserted = 기준 ref(글을 바꾼
 * 본문·칸 문단, 넣은 본문 문단 — 문서 차례), deleted = 지운 편집기 문단 수(편집기에만 있던 문단이라 기준 ref 가 없다).
 * ok:false 면 문서는 그대로다: STRUCTURE(표 격자·칸 지도·표/개체 문단 넣기·지우기 등 — 다시 열어 맞춘다), BUSY(한글 조합 중·머리말/꼬리말·각주
 * 편집 중 — 잠시 뒤 다시), READONLY(문서 없음), ERROR(트랜잭션이 던짐·고친 뒤 확인 실패 — studio 가 롤백했다).
 */
export interface SyncResult {
  ok: boolean;
  changed: string[];
  inserted: string[];
  deleted: number;
  reason?: 'STRUCTURE' | 'BUSY' | 'READONLY' | 'ERROR';
  message?: string;
  // 덧붙임: STRUCTURE 를 부른 기준 ref(있으면), 걸린 시간(ms — 고친 것이 있을 때)
  ref?: string;
  ms?: number;
}

/** flash(ranges, opts) 의 opts(V4 §2.4-5): color = 밑줄 색(사람 색), scroll = 첫 범위로 스크롤(기본 false) */
export interface FlashOptions { color?: string; scroll?: boolean }

/** 플러그인 → 호스트 이벤트 이름(§1.3 표) */
export const EVENT_NAMES = ['ready', 'selection', 'menu-action', 'annotation-click', 'annotation-hover', 'anchors', 'edited', 'draft', 'editing', 'key'] as const;
export type EventName = typeof EVENT_NAMES[number];
