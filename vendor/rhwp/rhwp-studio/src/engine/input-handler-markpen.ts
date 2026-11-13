/**
 * [hwpx-cowork] 형광펜을 한/글 형광펜(markpen)으로 (2026-11-12, h2022-format 2·3차).
 *
 * 한/글 2022 MarkPenShape 실측(artifacts/h2022-format/com/result_mp.json): 고른 범위에 `hp:markpenBegin color/markpenEnd` 를 단다.
 * 덧칠은 나중 색이 이기고, '색 없음' = 그 범위의 형광펜 지우기, 문단을 넘으면 문단마다, 변경 추적 중에도 추적 없이 칠한다.
 * MarkPenDelete = 블록 범위만 지우고 블록이 없으면 아무것도 안 한다. MarkPenNext/Prev(result_nav.json) = 다음/이전 형광펜 범위를
 * 블록으로 고르고 캐럿은 그 끝, 끝에 닿으면 처음으로 돌아간다(문단마다 따로 단 표지는 따로 센다).
 *
 * 다루는 자리: 본문 블록(구역 넘기), 표 칸 안 블록(중첩 표·글상자 — 경로), 셀 블록(F5, 고른 칸 전부), 머리말·꼬리말, 각주·미주.
 */
import type { DocumentPosition, CellPathEntry } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';
import { withCellPathTarget } from './cell-block-format';

/** 서식 도구 '색 없음'은 #ffffff 를 보낸다 — 형광펜에서는 지우기 */
export function markpenColorArg(color: string): string {
  const c = (color || '').trim().toLowerCase();
  return c === '' || c === 'none' || c === '#ffffff' ? '' : c;
}

/** 본문 블록을 구역별 범위로 나눈다(같은 구역이면 하나) */
export function bodyMarkpenSpans(
  start: { sec: number; para: number; offset: number },
  end: { sec: number; para: number; offset: number },
  paraCount: (sec: number) => number,
  paraLength: (sec: number, para: number) => number,
): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  for (let s = start.sec; s <= end.sec; s++) {
    const sp = s === start.sec ? start.para : 0;
    const so = s === start.sec ? start.offset : 0;
    const ep = s === end.sec ? end.para : Math.max(0, paraCount(s) - 1);
    const eo = s === end.sec ? end.offset : paraLength(s, ep);
    if (ep < sp || (ep === sp && eo <= so)) continue;
    out.push([s, sp, so, ep, eo]);
  }
  return out;
}

const WHOLE = 0x7fffffff;

/** 칠할 일 — 본문 범위 또는 문단 하나(대상) */
export type MarkpenJob =
  | { kind: 'body'; span: [number, number, number, number, number] }
  | { kind: 'target'; target: Record<string, unknown>; from: number; to: number };

/** 시작·끝 문단 사이(같은 묶음)의 문단마다 [from, to) */
export function paragraphRuns(sp: number, so: number, ep: number, eo: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let p = sp; p <= ep; p++) {
    const from = p === sp ? so : 0;
    const to = p === ep ? eo : WHOLE;
    if (to > from) out.push([p, from, to]);
  }
  return out;
}

/** 표 칸 위치의 경로(평면 칸이면 한 칸짜리 경로) — cellParaIndex 는 바꿔 쓴다 */
function cellPathOf(p: DocumentPosition): CellPathEntry[] | null {
  if (p.parentParaIndex === undefined) return null;
  if (p.cellPath && p.cellPath.length) return p.cellPath.map((e) => ({ ...e }));
  if (p.controlIndex === undefined || p.cellIndex === undefined) return null;
  return [{ controlIndex: p.controlIndex, cellIndex: p.cellIndex, cellParaIndex: p.cellParaIndex ?? 0 } as CellPathEntry];
}

const containerKey = (sec: number, parent: number, path: CellPathEntry[]): string =>
  JSON.stringify([sec, parent, path.map((e, i) => (i === path.length - 1 ? [e.controlIndex, e.cellIndex] : [e.controlIndex, e.cellIndex, e.cellParaIndex]))]);

interface MarkpenHost {
  wasm: WasmBridge;
  cursor: {
    isInHeaderFooter(): boolean;
    isInFootnote(): boolean;
    getSelectionOrdered(): { start: DocumentPosition; end: DocumentPosition } | null;
    getHeaderFooterSelectionOrdered?(): { start: { sectionIdx: number; isHeader: boolean; applyTo: number; paraIdx: number; charOffset: number }; end: { paraIdx: number; charOffset: number } } | null;
    getFootnoteSelectionOrdered?(): { start: { fnParaIdx: number; charOffset: number }; end: { fnParaIdx: number; charOffset: number } } | null;
    fnSectionIdx?: number;
    fnParaIdx?: number;
    fnControlIdx?: number;
  };
  executeOperation(op: unknown): unknown;
  getCursorPosition(): DocumentPosition;
  getSelectedCellBlock?: () => { sec: number; ppi: number; ci: number; cellIndices: number[]; cellPath?: CellPathEntry[] } | null;
}

/** 지금 블록에서 칠할 일들. 고른 것이 없으면 빈 배열(= 아무것도 안 함 — 한/글 MarkPenDelete 실측과 같다) */
export function planMarkpenJobs(host: MarkpenHost): MarkpenJob[] {
  const { wasm, cursor } = host;
  if (cursor.isInHeaderFooter()) {
    const sel = cursor.getHeaderFooterSelectionOrdered?.();
    if (!sel) return [];
    const { sectionIdx, isHeader, applyTo } = sel.start;
    return paragraphRuns(sel.start.paraIdx, sel.start.charOffset, sel.end.paraIdx, sel.end.charOffset).map(([p, from, to]) => ({
      kind: 'target' as const, target: { kind: 'hf', sec: sectionIdx, isHeader, applyTo, para: p }, from, to,
    }));
  }
  if (cursor.isInFootnote()) {
    const sel = cursor.getFootnoteSelectionOrdered?.();
    if (!sel || cursor.fnSectionIdx === undefined) return [];
    const base = { kind: 'note', sec: cursor.fnSectionIdx, para: cursor.fnParaIdx, control: cursor.fnControlIdx };
    return paragraphRuns(sel.start.fnParaIdx, sel.start.charOffset, sel.end.fnParaIdx, sel.end.charOffset).map(([p, from, to]) => ({
      kind: 'target' as const, target: { ...base, notePara: p }, from, to,
    }));
  }
  const block = host.getSelectedCellBlock?.();
  if (block) {
    const jobs: MarkpenJob[] = [];
    for (const cell of block.cellIndices) {
      const path0 = block.cellPath ? withCellPathTarget(block.cellPath, cell) : [{ controlIndex: block.ci, cellIndex: cell, cellParaIndex: 0 } as CellPathEntry];
      const count = block.cellPath
        ? wasm.getCellParagraphCountByPath(block.sec, block.ppi, JSON.stringify(path0))
        : wasm.getCellParagraphCount(block.sec, block.ppi, block.ci, cell);
      for (let p = 0; p < count; p++) {
        const path = path0.map((e, i) => (i === path0.length - 1 ? { ...e, cellParaIndex: p } : e));
        jobs.push({ kind: 'target', target: { kind: 'path', sec: block.sec, parentPara: block.ppi, path }, from: 0, to: WHOLE });
      }
    }
    return jobs;
  }
  const sel = cursor.getSelectionOrdered();
  if (!sel) return [];
  const { start, end } = sel;
  const sp = cellPathOf(start); const ep = cellPathOf(end);
  if (!sp && !ep) {
    return bodyMarkpenSpans(
      { sec: start.sectionIndex, para: start.paragraphIndex, offset: start.charOffset },
      { sec: end.sectionIndex, para: end.paragraphIndex, offset: end.charOffset },
      (s) => wasm.getParagraphCount(s),
      (s, p) => wasm.getParagraphLength(s, p),
    ).map((span) => ({ kind: 'body' as const, span }));
  }
  // 표 칸·글상자 안: 같은 묶음(같은 칸·같은 글상자) 안의 블록만
  if (!sp || !ep || start.sectionIndex !== end.sectionIndex || start.parentParaIndex !== end.parentParaIndex
    || containerKey(start.sectionIndex, start.parentParaIndex!, sp) !== containerKey(end.sectionIndex, end.parentParaIndex!, ep)) return [];
  const a = sp[sp.length - 1].cellParaIndex ?? 0; const b = ep[ep.length - 1].cellParaIndex ?? 0;
  return paragraphRuns(a, start.charOffset, b, end.charOffset).map(([p, from, to]) => ({
    kind: 'target' as const,
    target: { kind: 'path', sec: start.sectionIndex, parentPara: start.parentParaIndex, path: sp.map((e, i) => (i === sp.length - 1 ? { ...e, cellParaIndex: p } : e)) },
    from, to,
  }));
}

/**
 * 지금 블록에 형광펜을 칠한다(또는 '색 없음'이면 지운다). 고른 것이 없으면 false — 부르는 쪽이 연속 형광펜 모드 등으로 간다.
 * 문서 변경은 executeOperation snapshot 으로 되돌리기에 남긴다.
 */
export function applyMarkpenSelection(host: MarkpenHost, color: string): boolean {
  const d = (host.wasm as unknown as { doc?: Record<string, unknown> }).doc;
  if (!d || typeof d.applyMarkpenTarget !== 'function') return false;
  const jobs = planMarkpenJobs(host);
  if (!jobs.length) return false;
  const arg = markpenColorArg(color);
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'markpen',
    operation: (wasm: WasmBridge) => {
      let changed = 0;
      for (const j of jobs) {
        changed += j.kind === 'body'
          ? wasm.applyMarkpen(j.span[0], j.span[1], j.span[2], j.span[3], j.span[4], arg).changed
          : wasm.applyMarkpenTarget(j.target, j.from, j.to, arg).changed;
      }
      return changed ? host.getCursorPosition() : null;
    },
  });
  return true;
}

// 형광펜 이동 고르기는 Node 시험이 읽는 순수 모듈에 둔다
export { pickMarkpenRange } from '@/ui/h2022-format-model';
