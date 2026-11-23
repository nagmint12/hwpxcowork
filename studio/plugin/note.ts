import type { WasmBridge } from '@/core/wasm-bridge';
import type { SelectionRect } from '@/core/types';
import type { InputHandler } from '@/engine/input-handler';
import { alignOffsets } from '@cowork/web/refmap.js';
import { Alignment, toCurEnd, toCurOffset } from './align';
import { cursorOf, exitObjectModes, refreshCaret } from './internals';
import type { RangeLocation } from './types';
import { cpLen } from './util';

export function isNoteContainer(container: string | null | undefined): boolean {
  return container === 'hp:footNote' || container === 'hp:endNote';
}

export function locateNote(wasm: WasmBridge, align: Alignment, range: RangeLocation) {
  const base = align.baseParagraph(range.ref);
  const note = base?.note;
  const host = base?.parent && align.locate(base.parent);
  if (!base || !note || !host || host.cur.cell || (range.endRef && range.endRef !== range.ref)) return null;
  const kind = base.container === 'hp:endNote' ? 'endnote' : 'footnote';
  const { sec, para } = host.cur;
  const offsets = wasm.getControlTextPositions(sec, para);
  const notes = offsets.flatMap((offset, ctrl) => {
    const info = wasm.getNoteEditInfo(sec, para, ctrl);
    return info?.ok && info.kind === kind ? [{ info, offset, ctrl }] : [];
  });
  if (notes.length !== note.count || !notes[note.index]) return null;
  const { info, offset, ctrl } = notes[note.index];
  const content = wasm.getFootnoteInfo(sec, para, ctrl);
  const current = content.texts[note.paragraph];
  if (content.paraCount !== note.paragraphs || typeof current !== 'string') return null;
  const lo = range.start ?? 0, hi = range.end ?? (range.start == null ? cpLen(base.text) : lo);
  // 한/글 자동 주석 번호는 편집기 글에서 한 자리표를 차지한다.
  const prefix = note.paragraph === 0 && current === ' ' + base.text ? 1 : 0;
  const offsetsMap = current === base.text || prefix ? null : alignOffsets(base.text, current);
  const map = offsetsMap && { b2c: offsetsMap.a2b, c2b: offsetsMap.b2a };
  const length = cpLen(current) - prefix;
  const start = prefix + toCurOffset(map, lo, length);
  const end = Math.max(start, prefix + toCurEnd(map, lo, hi, length));
  const inner = note.paragraph;
  // 미주는 미주를 모아 찍는 구역의 가상 본문으로 배치된다. 논리 주석 위치로 캐럿 좌표를 조회한다.
  const rects: SelectionRect[] = kind === 'footnote' && end > start
    ? wasm.getSelectionRectsInFootnote(info.pageNum, info.footnoteIndex, inner, start, inner, end)
    : [];
  if (!rects.length) {
    const caret = wasm.getCursorRectInNote(sec, para, ctrl, inner, start);
    if (!caret || caret.height <= 0) return null;
    rects.push({ ...caret, width: 2 });
  }
  return { sec, para, ctrl, offset, info, inner, start, end, rects };
}

export function focusNote(ih: InputHandler, target: NonNullable<ReturnType<typeof locateNote>>, select: boolean) {
  const cursor = cursorOf(ih);
  if (!cursor) return false;
  const { sec, para, ctrl, offset, info, inner, start, end } = target;
  exitObjectModes(ih);
  if (cursor.isInHeaderFooter()) cursor.exitHeaderFooterMode();
  if (cursor.isInFootnote()) cursor.exitFootnoteMode();
  cursor.moveTo({ sectionIndex: sec, paragraphIndex: para, charOffset: offset });
  cursor.enterFootnoteMode(sec, para, ctrl, info.footnoteIndex, info.pageNum);
  cursor.setFnCursorPosition(inner, start);
  if (select && end > start) {
    cursor.setFnAnchor();
    cursor.setFnCursorPosition(inner, end);
  }
  refreshCaret(ih);
  ih.focus();
  return true;
}
