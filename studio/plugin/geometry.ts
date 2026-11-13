// 화면 계산 — 쪽 좌표(rhwp getSelectionRects*·커서 사각형) ↔ #scroll-content 좌표 ↔ iframe client 좌표.
// 쪽 좌표 → 화면 좌표는 studio SelectionRenderer.render 와 똑같은 식을 쓴다:
//   left = virtualScroll.getPageLeftResolved(쪽, #scroll-content.clientWidth) + x·배율, top = virtualScroll.getPageOffset(쪽) + y·배율
// 그래서 강조 층 사각형은 studio 선택 표시와 1px 안에서 겹친다(tests/studio_plugin.py 가 확인).
import type { CommandServices } from '@/command/types';
import type { InputHandler } from '@/engine/input-handler';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { SelectionRect, DocumentPosition, HitTestResult, PageInfo } from '@/core/types';
import type { VirtualScroll } from '@/view/virtual-scroll';
import type { CurPara } from './align';
import type { Rect } from './types';
import { virtualScrollOf } from './internals';

export interface CurPoint extends CurPara { offset: number }
export interface ContentBox { left: number; top: number; width: number; height: number }
export const CAPTION_CELL = 65534;

export class Geometry {
  private pageInfos = new Map<number, PageInfo>();
  /** (구역, 본문 문단) → 그 문단이 시작하는 전역 쪽 — 쪽 배치가 바뀌면 비운다 */
  private paraPages = new Map<number, number>();

  constructor(private readonly services: () => CommandServices | null) {}

  ih(): InputHandler | null { return this.services()?.getInputHandler() ?? null; }
  wasm(): WasmBridge | null { return this.services()?.wasm ?? null; }
  vs(): VirtualScroll | null { return virtualScrollOf(this.ih()); }
  container(): HTMLElement | null { return document.getElementById('scroll-container'); }
  content(): HTMLElement | null { return document.getElementById('scroll-content'); }
  zoom(): number { return this.services()?.getViewportManager()?.getZoom() ?? 1; }

  /** 화면 계산이 가능한가(문서·쪽 배치·스크롤 영역이 있음) */
  ready(): boolean {
    const w = this.wasm(); const vs = this.vs();
    return !!(w && w.pageCount > 0 && vs && vs.pageCount > 0 && this.content());
  }

  /** 쪽 배치가 바뀌었다(쪽 정보·문단 쪽 기억 지움) */
  invalidate(): void { this.pageInfos.clear(); this.paraPages.clear(); }

  pageCount(): number { return this.wasm()?.pageCount ?? 0; }

  /**
   * 본문 문단이 시작하는 전역 쪽(wasm getPageOfPosition — 쪽 나누기 결과를 읽기만 해서 싸다: 479문단 전부 ~2ms).
   * 보이는 쪽 근처의 강조만 사각형을 구하는 데 쓴다(getSelectionRects 는 문단마다 1~5ms). 모르면 -1.
   */
  paragraphPage(sec: number, para: number): number {
    const k = sec * 1048576 + para;
    const hit = this.paraPages.get(k);
    if (hit !== undefined) return hit;
    let v = -1;
    try {
      const r = this.wasm()?.getPageOfPosition(sec, para);
      if (r && r.ok && typeof r.page === 'number' && r.page >= 0) v = r.page;
    } catch { v = -1; }
    this.paraPages.set(k, v);
    return v;
  }

  pageInfo(page: number): PageInfo | null {
    const hit = this.pageInfos.get(page);
    if (hit) return hit;
    try { const pi = this.wasm()!.getPageInfo(page); this.pageInfos.set(page, pi); return pi; } catch { return null; }
  }

  /** 쪽 좌표 사각형 → #scroll-content 좌표 */
  toContent(r: { pageIndex: number; x: number; y: number; width: number; height: number }): ContentBox {
    const vs = this.vs()!; const z = this.zoom(); const cw = this.content()?.clientWidth ?? 0;
    return { left: vs.getPageLeftResolved(r.pageIndex, cw) + r.x * z, top: vs.getPageOffset(r.pageIndex) + r.y * z, width: r.width * z, height: r.height * z };
  }

  /** #scroll-content 좌표 → iframe client 좌표 */
  contentToClient(b: ContentBox): Rect {
    const o = this.content()!.getBoundingClientRect();
    return { x: o.left + b.left, y: o.top + b.top, w: b.width, h: b.height };
  }

  toClient(r: SelectionRect): Rect { return this.contentToClient(this.toContent(r)); }

  /** 쪽 상자(#scroll-content 좌표, 배율 적용) */
  pageBox(page: number): ContentBox {
    const vs = this.vs()!; const cw = this.content()?.clientWidth ?? 0;
    return { left: vs.getPageLeftResolved(page, cw), top: vs.getPageOffset(page), width: vs.getPageWidth(page), height: vs.getPageHeight(page) };
  }

  /** 지금 보이는 쪽(가상 스크롤과 같은 판정) */
  visiblePages(): number[] {
    const vs = this.vs(); const vm = this.services()?.getViewportManager();
    if (!vs || !vm) return [];
    const { width, height } = vm.getViewportSize();
    try { return vs.getVisiblePages(vm.getScrollY(), height, vm.getScrollX(), width); } catch { return []; }
  }

  /** 보이는 영역(iframe client 좌표) */
  viewport(): { top: number; bottom: number; left: number; right: number } {
    const c = this.container();
    if (!c) return { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    const r = c.getBoundingClientRect();
    return { top: r.top, bottom: r.top + c.clientHeight, left: r.left, right: r.left + c.clientWidth };
  }

  // ───────── 편집기 위치 ─────────

  /** 범위 사각형(쪽 좌표). 같은 묶음(본문 — 구역을 넘어도 된다, 또는 같은 칸) 안에서만 */
  rangeRects(a: CurPoint, b: CurPoint): SelectionRect[] {
    const w = this.wasm(); if (!w) return [];
    try {
      if (!a.cell && !b.cell) {
        if (a.sec === b.sec) return w.getSelectionRects(a.sec, a.para, a.offset, b.para, b.offset);
        // 구역을 넘는 본문 범위 — 구역마다(엔진은 한 구역 안 범위만 받는다, docs/SECTIONS.md)
        const out: SelectionRect[] = [];
        for (let s = a.sec; s <= b.sec; s++) {
          const last = w.getParagraphCount(s) - 1;
          if (last < 0) continue;
          out.push(...w.getSelectionRects(s, s === a.sec ? a.para : 0, s === a.sec ? a.offset : 0,
            s === b.sec ? b.para : last, s === b.sec ? b.offset : w.getParagraphLength(s, last)));
        }
        return out;
      }
      if (a.cell && b.cell && a.sec === b.sec && a.para === b.para && a.cell.ci === b.cell.ci && a.cell.cell === b.cell.cell) {
        return w.getSelectionRectsInCell(a.sec, a.para, a.cell.ci, a.cell.cell, a.cell.cpara, a.offset, b.cell.cpara, b.offset);
      }
    } catch { /* 문단 밖 등 */ }
    return [];
  }

  /** 글 오프셋으로 가리킬 수 없는 그림·표의 실제 조판 영역. 개체를 선택하거나 편집하지 않는다. */
  objectRects(cur: CurPara, kind: 'image' | 'table', index = 0): SelectionRect[] {
    const w = this.wasm(); if (!w || cur.cell || !Number.isSafeInteger(index) || index < 0) return [];
    const controls = new Map<number, SelectionRect[]>();
    for (let page = 0; page < w.pageCount; page++) {
      for (const c of w.getPageControlLayout(page).controls) {
        if (c.type !== kind || c.secIdx !== cur.sec || c.paraIdx !== cur.para || c.controlIdx == null
          || c.cellIdx != null || c.noteRef || c.headerFooter || c.outerTableControlIdx != null) continue;
        if (!controls.has(c.controlIdx)) controls.set(c.controlIdx, []);
        controls.get(c.controlIdx)!.push({ pageIndex: page, x: c.x, y: c.y, width: c.w, height: c.h });
      }
    }
    return [...controls].sort(([a], [b]) => a - b)[index]?.[1] || [];
  }

  /**
   * 글자 자리(캐럿) 사각형 {pageIndex,x,y,height} — refmap.caret 과 같은 방법: 글이 있으면 그 글자의 선택 사각형으로
   * (getCursorRect 는 앞에 숨은 조판 부호가 있는 문단에서 한 글자 밀린다), 빈 문단이면 커서 사각형.
   */
  caretRect(p: CurPoint, len: number): { pageIndex: number; x: number; y: number; height: number } | null {
    const o = Math.max(0, Math.min(len, p.offset));
    if (len > 0) {
      const rs = o < len ? this.rangeRects({ ...p, offset: o }, { ...p, offset: o + 1 }) : this.rangeRects({ ...p, offset: o - 1 }, { ...p, offset: o });
      const r = o < len ? rs[0] : rs[rs.length - 1];
      if (r) return { pageIndex: r.pageIndex, x: o < len ? r.x : r.x + r.width, y: r.y, height: r.height };
    }
    const w = this.wasm(); if (!w) return null;
    try {
      if (!p.cell) return w.getCursorRect(p.sec, p.para, o);
      return w.getCursorRectInCell(p.sec, p.para, p.cell.ci, p.cell.cell, p.cell.cpara, o);
    } catch { return null; }
  }

  /**
   * 문단이 차지하는 띠(쪽마다 하나, 쪽 좌표): 글이 있으면 줄 사각형들의 합, 표만 있는 문단이면 칸 상자들의 합,
   * 빈 문단이면 커서 사각형 높이.
   */
  paragraphBand(cur: CurPara, len: number): SelectionRect[] {
    const w = this.wasm(); if (!w) return [];
    let rects: Array<{ pageIndex: number; x: number; y: number; width: number; height: number }> = [];
    if (len > 0) rects = this.rangeRects({ ...cur, offset: 0 }, { ...cur, offset: len });
    if (!rects.length && !cur.cell) {
      try {
        const ctrls = w.getControlTextPositions(cur.sec, cur.para);
        for (let ci = 0; ci < ctrls.length; ci++) {
          try { for (const b of w.getTableCellBboxes(cur.sec, cur.para, ci)) rects.push({ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.w, height: b.h }); } catch { /* 표 아님 */ }
        }
      } catch { /* 없음 */ }
    }
    if (!rects.length) {
      const c = this.caretRect({ ...cur, offset: 0 }, 0);
      if (c) rects = [{ pageIndex: c.pageIndex, x: c.x, y: c.y, width: 1, height: c.height }];
    }
    const byPage = new Map<number, SelectionRect>();
    for (const r of rects) {
      const b = byPage.get(r.pageIndex);
      if (!b) { byPage.set(r.pageIndex, { pageIndex: r.pageIndex, x: r.x, y: r.y, width: r.width, height: r.height }); continue; }
      const x1 = Math.min(b.x, r.x); const y1 = Math.min(b.y, r.y);
      const x2 = Math.max(b.x + b.width, r.x + r.width); const y2 = Math.max(b.y + b.height, r.y + r.height);
      Object.assign(b, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
    return [...byPage.values()].sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y);
  }

  /** iframe client 좌표 → 쪽·쪽 좌표·hitTest(우클릭 처리기 onContextMenu 와 같은 계산) */
  hitAt(clientX: number, clientY: number): { page: number; px: number; py: number; hit: HitTestResult | null } | null {
    const vs = this.vs(); const content = this.content(); const w = this.wasm();
    if (!vs || !content || !w || !(w.pageCount > 0)) return null;
    const z = this.zoom(); const cr = content.getBoundingClientRect();
    const cx = clientX - cr.left; const cy = clientY - cr.top;
    const page = vs.getPageAtPoint(cx, cy);
    const px = (cx - vs.getPageLeftResolved(page, content.clientWidth)) / z;
    const py = (cy - vs.getPageOffset(page)) / z;
    let hit: HitTestResult | null = null;
    try { hit = w.hitTest(page, px, py); } catch { hit = null; }
    return { page, px, py, hit };
  }

  /** 편집기 자리 → studio DocumentPosition */
  toPosition(p: CurPoint): DocumentPosition {
    if (!p.cell) return { sectionIndex: p.sec, paragraphIndex: p.para, charOffset: p.offset };
    const pos: DocumentPosition = {
      sectionIndex: p.sec, paragraphIndex: p.para, charOffset: p.offset,
      parentParaIndex: p.para, controlIndex: p.cell.ci, cellIndex: p.cell.cell, cellParaIndex: p.cell.cpara,
    };
    if (p.cell.kind === 'shape') pos.isTextBox = true;
    return pos;
  }

  /** studio DocumentPosition(커서·선택·hitTest) → 편집기 자리. 칸 안의 표(2단 이상)는 바깥 칸으로 근사(approx) */
  fromPosition(pos: DocumentPosition | HitTestResult | null | undefined): (CurPoint & { approx?: boolean }) | null {
    if (!pos || typeof pos.sectionIndex !== 'number') return null;
    if (pos.parentParaIndex === undefined || pos.parentParaIndex === null) {
      if (typeof pos.paragraphIndex !== 'number' || pos.paragraphIndex >= 0xffffff00) return null;
      return { sec: pos.sectionIndex, para: pos.paragraphIndex, offset: pos.charOffset ?? 0 };
    }
    const path = pos.cellPath;
    if (path && path.length > 1) {
      const top = path[0];
      return { sec: pos.sectionIndex, para: pos.parentParaIndex, offset: 0, approx: true, cell: { ci: top.controlIndex, cell: top.cellIndex, cpara: top.cellParaIndex, kind: 'cell' } };
    }
    const ci = pos.controlIndex ?? path?.[0]?.controlIndex; const cell = pos.cellIndex ?? path?.[0]?.cellIndex; const cpara = pos.cellParaIndex ?? path?.[0]?.cellParaIndex;
    if (ci == null || cell == null || cpara == null) return null;
    const kind = pos.isTextBox ? 'shape' : cell === CAPTION_CELL ? 'caption' : 'cell';
    return { sec: pos.sectionIndex, para: pos.parentParaIndex, offset: pos.charOffset ?? 0, cell: { ci, cell, cpara, kind } };
  }
}
