/**
 * [hwpx-cowork] 한/글 2022 커서 이동 — 쪽·구역 단위(2026-11-12).
 * 한/글 액션 표(ActionTable): MovePageBegin/End '현재 페이지의 시작/끝점', PrevPage/NextPage(Alt+PageUp/PageDown, 단축키 표)
 * '앞/뒤 페이지의 시작', MoveSectionUp/Down '앞/뒤 섹션으로 이동'. 본문 좌표만 다룬다(표 셀·머리말 안이면 본문으로 나온다 — 한/글도
 * 탑레벨 리스트로 빠져나온다고 적혀 있다).
 */
import type { DocumentPosition } from '@/core/types';

type Bridge = {
  getPageOfPosition(sec: number, para: number): { ok: boolean; page?: number };
  getPositionOfPage(page: number): { ok: boolean; sec?: number; para?: number; charOffset?: number };
  getSectionCount(): number;
  getParagraphCount(sec: number): number;
  getParagraphLength(sec: number, para: number): number;
  getPageInfo(page: number): { bodyLeft: number; bodyRight: number; height: number; marginTop: number; marginHeader: number; marginBottom: number; marginFooter: number };
  hitTest(page: number, x: number, y: number): DocumentPosition;
  getCursorRect(sec: number, para: number, charOffset: number): { pageIndex: number };
  pageCount: number;
};

const body = (sec: number, para: number, charOffset: number): DocumentPosition => ({ sectionIndex: sec, paragraphIndex: para, charOffset });

/**
 * 캐럿이 놓인 쪽(0부터). 본문은 캐럿 사각형의 쪽(여러 쪽에 걸친 문단도 정확), 셀 안이면 표를 품은 본문 문단의 쪽
 * (엔진 getPageOfPosition 은 문단 단위라 긴 문단은 첫 쪽을 준다).
 */
export function pageOf(wasm: Bridge, pos: DocumentPosition): number | null {
  if (pos.parentParaIndex === undefined && !pos.cellPath?.length) {
    try { return wasm.getCursorRect(pos.sectionIndex, pos.paragraphIndex, pos.charOffset).pageIndex; } catch { /* 아래로 */ }
  }
  const r = wasm.getPageOfPosition(pos.sectionIndex, pos.parentParaIndex ?? pos.paragraphIndex);
  return r.ok && r.page != null ? r.page : null;
}

/** 본문 상자 안의 점 → 히트 자리(엔진 hitTest — 쪽 사이에서 이어지는 문단도 그 쪽의 줄 자리를 준다) */
function hitBody(wasm: Bridge, page: number, corner: 'start' | 'end'): DocumentPosition | null {
  try {
    const i = wasm.getPageInfo(page);
    const top = i.marginTop + i.marginHeader;
    const bottom = i.height - i.marginBottom - i.marginFooter;
    return corner === 'start' ? wasm.hitTest(page, i.bodyLeft + 1, top + 1) : wasm.hitTest(page, i.bodyRight - 1, bottom - 1);
  } catch {
    return null;
  }
}

/** 쪽(0부터)의 첫 자리 — 본문 상자 왼쪽 위의 히트 자리(못 얻으면 그 쪽에서 시작하는 문단 머리) */
export function pageStart(wasm: Bridge, page: number): DocumentPosition | null {
  if (page < 0 || page >= wasm.pageCount) return null;
  const hit = hitBody(wasm, page, 'start');
  if (hit) return hit;
  const r = wasm.getPositionOfPage(page);
  return r.ok ? body(r.sec!, r.para!, r.charOffset ?? 0) : null;
}

/**
 * 쪽(0부터)의 끝 자리 — 본문 상자 오른쪽 아래의 히트 자리(쪽 마지막 줄 끝; 문단이 다음 쪽으로 이어지면 글자 번호는 다음 쪽 첫 자리와 같고
 * 캐럿 사각형(cursorRect)이 이 쪽을 가리킨다). 못 얻으면 다음 쪽 첫 자리 앞 / 문서 끝.
 */
export function pageEnd(wasm: Bridge, page: number): DocumentPosition | null {
  if (page < 0 || page >= wasm.pageCount) return null;
  const hit = hitBody(wasm, page, 'end');
  if (hit) return hit;
  const next = page + 1 < wasm.pageCount ? wasm.getPositionOfPage(page + 1) : null;
  if (!next || !next.ok) {
    const sec = wasm.getSectionCount() - 1;
    const para = wasm.getParagraphCount(sec) - 1;
    return body(sec, para, wasm.getParagraphLength(sec, para));
  }
  if (next.para! > 0) return body(next.sec!, next.para! - 1, wasm.getParagraphLength(next.sec!, next.para! - 1));
  return body(next.sec!, 0, 0);
}

/** 구역 sec 의 첫 자리 */
export function sectionStart(wasm: Bridge, sec: number): DocumentPosition | null {
  if (sec < 0 || sec >= wasm.getSectionCount()) return null;
  return body(sec, 0, 0);
}

export type PageMove = 'pageBegin' | 'pageEnd' | 'pagePrev' | 'pageNext' | 'sectionPrev' | 'sectionNext';

/** 이동할 자리(갈 곳이 없으면 null) */
export function pageMoveTarget(wasm: Bridge, pos: DocumentPosition, move: PageMove): DocumentPosition | null {
  if (move === 'sectionPrev') return sectionStart(wasm, pos.sectionIndex - 1);
  if (move === 'sectionNext') return sectionStart(wasm, pos.sectionIndex + 1);
  const page = pageOf(wasm, pos);
  if (page == null) return null;
  if (move === 'pageBegin') return pageStart(wasm, page);
  if (move === 'pageEnd') return pageEnd(wasm, page);
  return pageStart(wasm, move === 'pagePrev' ? page - 1 : page + 1);
}

/**
 * 찾아가기(GotoDlg)의 '스타일'·'조판 부호' — 캐럿 다음 본문 문단부터 문서 끝까지, 없으면 처음부터 캐럿 문단까지(한 바퀴) 찾는다.
 * `hit(sec, para)` 가 그 문단의 글자 자리(맞으면) 또는 null. 반환 = 찾은 자리와 돌았는가.
 */
export function findForward(
  wasm: Pick<Bridge, 'getSectionCount' | 'getParagraphCount'>,
  from: { sec: number; para: number },
  hit: (sec: number, para: number) => number | null,
): { pos: DocumentPosition; wrapped: boolean } | null {
  const secs = wasm.getSectionCount();
  const order: Array<[number, number, boolean]> = [];
  for (let s = from.sec; s < secs; s++) {
    const n = wasm.getParagraphCount(s);
    for (let p = s === from.sec ? from.para + 1 : 0; p < n; p++) order.push([s, p, false]);
  }
  for (let s = 0; s <= from.sec && s < secs; s++) {
    const n = wasm.getParagraphCount(s);
    for (let p = 0; p < n && (s < from.sec || p <= from.para); p++) order.push([s, p, true]);
  }
  for (const [s, p, wrapped] of order) {
    const at = hit(s, p);
    if (at != null) return { pos: body(s, p, at), wrapped };
  }
  return null;
}
