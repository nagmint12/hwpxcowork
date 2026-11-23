// studio 비공개 필드 접근은 이 파일 한 곳에만 둔다(docs/V3_SPEC.md §1.2).
// vendor/rhwp 는 고정 스냅샷(v0.8.7, 1a76570)이라 아래 필드 이름이 바뀌지 않는다 — 스냅샷을 올리면 이 파일부터 다시 맞춘다.
// 공개 표면(PluginHost·CommandServices·InputHandler 공개 메서드)으로 되는 일은 여기로 오지 않는다.
// 쓰는 비공개 것: InputHandler.virtualScroll·cursor(CursorState)·updateCaret(skipScroll)·exitPictureObjectSelectionIfNeeded,
// v0.4 맞추기(docs/V4_SPEC.md §2.5)에서 InputHandler.history(CommandHistory.clear)·isComposing.
import type { InputHandler } from '@/engine/input-handler';
import type { VirtualScroll } from '@/view/virtual-scroll';
import type { DocumentPosition } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';

/** CursorState(engine/cursor.ts) 중 쓰는 부분 */
export interface CursorLike {
  moveTo(pos: DocumentPosition): void;
  setAnchor(): void;
  clearSelection(): void;
  resetPreferredX(): void;
  getPosition(): DocumentPosition;
  /** 선택(anchor → focus, 방향 그대로) — 없으면 null */
  getSelection(): { anchor: DocumentPosition; focus: DocumentPosition } | null;
  isInHeaderFooter(): boolean;
  isInFootnote(): boolean;
  exitHeaderFooterMode(): void;
  exitFootnoteMode(): void;
  enterFootnoteMode(sec: number, para: number, ctrl: number, index: number, page: number): void;
  setFnCursorPosition(para: number, offset: number): void;
  setFnAnchor(): void;
}

type Loose = Record<string, unknown>;
const loose = (ih: InputHandler | null): Loose | null => (ih ? (ih as unknown as Loose) : null);

/**
 * InputHandler.virtualScroll — 쪽의 위쪽 offset·왼쪽 위치(getPageOffset·getPageLeftResolved)와 보이는 쪽 목록.
 * 강조 층을 studio 선택 표시(SelectionRenderer)와 똑같은 변환으로 그리려면 같은 VirtualScroll 이 필요한데
 * CommandServices 에는 ViewportManager(배율·스크롤)만 있고 VirtualScroll 은 없다.
 */
export function virtualScrollOf(ih: InputHandler | null): VirtualScroll | null {
  const vs = loose(ih)?.virtualScroll as VirtualScroll | undefined;
  return vs && typeof vs.getPageOffset === 'function' ? vs : null;
}

/**
 * InputHandler.cursor — 기준 범위를 편집기 선택으로 만들 때(찾기 대화상자 navigateToSearchHit 와 같은 방법:
 * moveTo → setAnchor → moveTo) 와 머리말/꼬리말·각주 편집 중인지 볼 때 쓴다. 공개 InputHandler 에는
 * 범위 선택 API 가 없다(moveCursorTo 는 캐럿만, focusBodyParagraph 는 본문 문단 전체만).
 */
export function cursorOf(ih: InputHandler | null): CursorLike | null {
  const c = loose(ih)?.cursor as CursorLike | undefined;
  return c && typeof c.moveTo === 'function' && typeof c.setAnchor === 'function' ? c : null;
}

/** InputHandler.updateCaret() — 캐럿·선택 표시를 다시 그리고 캐럿을 화면 안으로(찾기 대화상자와 같은 호출) */
export function refreshCaret(ih: InputHandler | null): void {
  const fn = loose(ih)?.updateCaret as ((skipScroll?: boolean) => void) | undefined;
  if (typeof fn === 'function') fn.call(ih);
}

/** InputHandler.active — 문서가 떠 있고 편집기가 키를 받는 중인가(우클릭 메뉴는 active 일 때만 뜬다) */
export function isActive(ih: InputHandler | null): boolean {
  return typeof ih?.isActive === 'function' ? ih.isActive() : false;
}

/** 머리말/꼬리말·각주 편집 중인가 — 이때는 '검토' 구역을 넣지 않는다(본문 ref 로 옮길 수 없음) */
export function inSubEditor(ih: InputHandler | null): boolean {
  const c = cursorOf(ih);
  try { return !!c && (c.isInHeaderFooter() || c.isInFootnote()); } catch { return false; }
}

/**
 * 개체 선택(표·그림)·칸 블록 선택을 푼다 — 글 범위를 선택하기 전에. 표·칸은 공개 메서드,
 * 그림은 InputHandler.exitPictureObjectSelectionIfNeeded(비공개: 공개 쪽 exitPictureObjectSelectionAndAfterEdit 는
 * afterEdit 로 document-mutated 를 내서 문서를 고친 것처럼 보인다).
 */
export function exitObjectModes(ih: InputHandler): void {
  try { if (ih.isInTableObjectSelection()) ih.exitTableObjectSelection(); } catch { /* 없음 */ }
  try { if (ih.isInCellSelectionMode()) ih.exitCellSelectionMode(); } catch { /* 없음 */ }
  try {
    if (ih.isInPictureObjectSelection()) {
      const fn = loose(ih)?.exitPictureObjectSelectionIfNeeded as (() => void) | undefined;
      if (typeof fn === 'function') fn.call(ih);
    }
  } catch { /* 없음 */ }
}

/**
 * 범위 선택: start → end. 본문은 공개 moveCursorTo(검증·active·포커스 포함) 뒤 anchor 를 세우고,
 * 셀은 moveCursorTo 의 사전 검증이 본문 좌표만 보므로(찾기 대화상자 주석과 같은 이유) 커서를 직접 옮긴다.
 */
export function selectRange(ih: InputHandler, start: DocumentPosition, end: DocumentPosition): boolean {
  // 빈 범위는 캐럿만(anchor 를 세우면 길이 0 인 '선택'이 남아 Delete·글자 입력이 선택 지우기로 처리된다)
  if (samePosition(start, end)) return placeCaret(ih, start);
  const cursor = cursorOf(ih);
  if (!cursor) return false;
  exitObjectModes(ih);
  const inCell = start.parentParaIndex !== undefined;
  if (inCell) { cursor.clearSelection(); cursor.moveTo(start); }
  else if (!ih.moveCursorTo(start)) { cursor.clearSelection(); cursor.moveTo(start); }
  cursor.setAnchor();
  cursor.moveTo(end);
  cursor.resetPreferredX();
  refreshCaret(ih);
  ih.focus();
  return true;
}

function samePosition(a: DocumentPosition, b: DocumentPosition): boolean {
  return a.sectionIndex === b.sectionIndex && a.paragraphIndex === b.paragraphIndex && a.charOffset === b.charOffset
    && a.parentParaIndex === b.parentParaIndex && a.controlIndex === b.controlIndex && a.cellIndex === b.cellIndex && a.cellParaIndex === b.cellParaIndex;
}

/** 캐럿만 옮기기(선택 없음). 셀은 커서를 직접 옮긴다(위와 같은 이유) */
export function placeCaret(ih: InputHandler, pos: DocumentPosition): boolean {
  exitObjectModes(ih);
  if (pos.parentParaIndex === undefined) {
    if (ih.moveCursorTo(pos)) return true;
  }
  const cursor = cursorOf(ih);
  if (!cursor) return false;
  cursor.clearSelection();
  cursor.moveTo(pos);
  cursor.resetPreferredX();
  refreshCaret(ih);
  ih.focus();
  return true;
}

// ───────── 맞추기(syncToBase — docs/V4_SPEC.md §2.5) 용 ─────────

/** 지금 선택(anchor → focus, 방향 그대로). 없으면 null — InputHandler.getSelection 은 앞뒤로 정렬해 방향을 잃는다 */
export function cursorSelection(ih: InputHandler): { anchor: DocumentPosition; focus: DocumentPosition } | null {
  try { return cursorOf(ih)?.getSelection() ?? null; } catch { return null; }
}

/**
 * 트랜잭션 안(문서를 고친 뒤)에서 커서를 고친 문서의 자리로 옮긴다(선택은 푼다). studio 는 트랜잭션이 끝나면 커서를 그 자리로 다시 옮기므로
 * (executeOperation 'snapshot' → cursor.moveTo(operation 이 돌려준 자리)) 이 자리가 고친 문서에서 유효해야 한다. 스크롤·포커스는 건드리지 않는다.
 */
export function setCursor(ih: InputHandler, pos: DocumentPosition): void {
  const cursor = cursorOf(ih);
  if (!cursor) return;
  cursor.clearSelection();
  cursor.moveTo(pos);
  cursor.resetPreferredX();
}

/**
 * 선택(anchor → focus)·캐럿을 되살린다 — 스크롤하지 않고(updateCaret(skipScroll=true)) 포커스도 옮기지 않는다
 * (남의 고침을 맞추는 동안 사용자가 호스트 창에서 메모를 쓰고 있을 수 있다). anchor 가 없거나 focus 와 같으면 캐럿만.
 */
export function restoreSelection(ih: InputHandler, anchor: DocumentPosition | null, focus: DocumentPosition): void {
  const cursor = cursorOf(ih);
  if (!cursor) return;
  cursor.clearSelection();
  if (anchor && !samePosition(anchor, focus)) { cursor.moveTo(anchor); cursor.setAnchor(); }
  cursor.moveTo(focus);
  cursor.resetPreferredX();
  const fn = loose(ih)?.updateCaret as ((skipScroll?: boolean) => void) | undefined;
  if (typeof fn === 'function') fn.call(ih, true);
}

/**
 * InputHandler.history(CommandHistory) — 되돌리기·다시하기 기록을 비운다(스냅샷 자원도 놓는다: clear(wasm)). studio 는 문서를 열 때만 비우고
 * 공개 API 가 없다. 남의 고침을 편집기에 맞춘 뒤 그 앞의 되돌리기(문서 전체 스냅샷·글자 자리 명령)가 남의 글까지 되돌리지 않게 한다.
 */
export function clearHistory(ih: InputHandler, wasm: WasmBridge): boolean {
  const h = loose(ih)?.history as { clear?: (w?: WasmBridge) => void } | undefined;
  if (!h || typeof h.clear !== 'function') return false;
  h.clear(wasm);
  return true;
}

/** InputHandler.isComposing — 한글 조합 중(조합 글자가 이미 문서에 들어가 있고 조합이 끝나면 기록된다)이면 문서를 고치지 않는다 */
export function isComposing(ih: InputHandler | null): boolean {
  return loose(ih)?.isComposing === true;
}
