/**
 * [hwpx-cowork] 한/글 2022 편집·입력 — 캐럿·선택 영역의 글 읽기와 바꾸기(2026-11-11).
 *
 * 본문 문단은 `getTextRange`·`replaceText`, 표 셀·글상자는 경로 API(`getTextInCellByPath`·`deleteTextInCellByPath`·
 * `insertTextInCellByPath`)를 쓴다. 바꾸기는 바뀐 글자 구간만(`changedSegments`) 뒤에서부터 — 바뀌지 않은 글자와
 * 그 사이 조판 부호(메모·필드 등)를 건드리지 않는다. 서버는 이 결과를 글 바꿈으로 받아 문서 설정(고친 글만 / 변경 추적)대로 적는다.
 */
import type { DocumentPosition, CellPathEntry } from '@/core/types';
import { changedSegments } from './h2022-edit-convert';

/** 글을 읽고 바꿀 문단 하나 */
export interface TextHost {
  sec: number;
  /** 본문 문단 번호, 셀이면 표·글상자를 품은 본문 문단 번호 */
  para: number;
  /** 셀·글상자 경로(마지막 칸의 cellParaIndex 가 그 문단) */
  cellPath?: CellPathEntry[];
}

/** 캐럿 자리 → 그 문단(머리말·꼬리말·각주 안은 null — 아직 받지 않는다) */
export function hostOf(pos: DocumentPosition): TextHost | null {
  if (pos.cellPath && pos.cellPath.length > 0) {
    return { sec: pos.sectionIndex, para: pos.parentParaIndex ?? pos.paragraphIndex, cellPath: pos.cellPath.map((e) => ({ ...e })) };
  }
  if (pos.parentParaIndex !== undefined && pos.controlIndex !== undefined && pos.cellIndex !== undefined) {
    return {
      sec: pos.sectionIndex,
      para: pos.parentParaIndex,
      cellPath: [{ controlIndex: pos.controlIndex, cellIndex: pos.cellIndex, cellParaIndex: pos.cellParaIndex ?? 0 }],
    };
  }
  return { sec: pos.sectionIndex, para: pos.paragraphIndex };
}

const inCell = (h: TextHost) => (h.cellPath?.length ?? 0) > 0;
const pathJson = (h: TextHost) => JSON.stringify(h.cellPath ?? []);

type Bridge = Record<string, any>;

export function paragraphLength(wasm: Bridge, h: TextHost): number {
  return inCell(h) ? wasm.getCellParagraphLengthByPath(h.sec, h.para, pathJson(h)) : wasm.getParagraphLength(h.sec, h.para);
}

export function readText(wasm: Bridge, h: TextHost, offset: number, count: number): string {
  if (count <= 0) return '';
  return inCell(h) ? wasm.getTextInCellByPath(h.sec, h.para, pathJson(h), offset, count) : wasm.getTextRange(h.sec, h.para, offset, count);
}

/** offset 부터 length 글자를 text 로 바꾼다(본문은 모양을 잇는 한 단계 바꾸기). */
export function replaceRange(wasm: Bridge, h: TextHost, offset: number, length: number, text: string): void {
  if (inCell(h)) {
    if (length > 0) wasm.deleteTextInCellByPath(h.sec, h.para, pathJson(h), offset, length);
    if (text) wasm.insertTextInCellByPath(h.sec, h.para, pathJson(h), offset, text);
    return;
  }
  if (!text) { if (length > 0) wasm.deleteText(h.sec, h.para, offset, length); return; }
  const r = wasm.replaceText(h.sec, h.para, offset, length, text);
  if (r && r.ok === false) throw new Error('replaceText 실패');
}

/** 바뀐 구간만 바꾼다 → 바꾼 구간 수 */
export function applyConversion(wasm: Bridge, h: TextHost, offset: number, before: string, after: string): number {
  if (before === after) return 0;
  const segs = changedSegments(before, after);
  for (const s of [...segs].reverse()) replaceRange(wasm, h, offset + s.start, s.length, s.text);
  return segs.length;
}

/** 선택 영역을 문단 조각들로 → [{host, start, end}]. 본문 여러 문단·같은 셀 목록 안의 여러 문단만(그 밖은 null). */
export function selectionPieces(start: DocumentPosition, end: DocumentPosition, wasm: Bridge): Array<{ host: TextHost; start: number; end: number }> | null {
  const a = hostOf(start);
  const b = hostOf(end);
  if (!a || !b) return null;
  if (!inCell(a) && !inCell(b)) {
    const out: Array<{ host: TextHost; start: number; end: number }> = [];
    for (let sec = a.sec; sec <= b.sec; sec++) {
      const count = wasm.getParagraphCount(sec);
      const p0 = sec === a.sec ? a.para : 0;
      const p1 = sec === b.sec ? b.para : count - 1;
      for (let p = p0; p <= p1; p++) {
        const host = { sec, para: p };
        const len = paragraphLength(wasm, host);
        const s = sec === a.sec && p === a.para ? start.charOffset : 0;
        const e = sec === b.sec && p === b.para ? end.charOffset : len;
        if (e > s) out.push({ host, start: s, end: e });
      }
    }
    return out;
  }
  if (inCell(a) && inCell(b) && a.sec === b.sec && a.para === b.para) {
    const pa = a.cellPath!;
    const pb = b.cellPath!;
    const same = pa.length === pb.length && pa.every((x, i) => x.controlIndex === pb[i].controlIndex && x.cellIndex === pb[i].cellIndex
      && (i === pa.length - 1 || x.cellParaIndex === pb[i].cellParaIndex));
    if (!same) return null;
    const out: Array<{ host: TextHost; start: number; end: number }> = [];
    const first = pa[pa.length - 1].cellParaIndex;
    const last = pb[pb.length - 1].cellParaIndex;
    for (let q = first; q <= last; q++) {
      const path = pa.map((x, i) => (i === pa.length - 1 ? { ...x, cellParaIndex: q } : { ...x }));
      const host = { sec: a.sec, para: a.para, cellPath: path };
      const len = paragraphLength(wasm, host);
      const s = q === first ? start.charOffset : 0;
      const e = q === last ? end.charOffset : len;
      if (e > s) out.push({ host, start: s, end: e });
    }
    return out;
  }
  return null;
}
