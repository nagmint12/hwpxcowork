import { isBodyControl } from './picture-hit-policy';
/** input-handler keyboard methods — extracted from InputHandler class */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { InsertTextCommand, InsertLineBreakCommand, InsertTabCommand, SplitParagraphCommand, SplitParagraphInCellCommand, InsertTextInHeaderFooterCommand, SplitParagraphInHeaderFooterCommand, SplitParagraphInFootnoteCommand, DeleteTextInFootnoteCommand, MergeParagraphInFootnoteCommand, cellParaIndexOf } from './command';
import { objectShortcutCommand } from './object-h2022'; // [hwpx-cowork] 한/글 2022 개체 단축키
import { pageMoveTarget } from './h2022-navigation'; // [hwpx-cowork] 한/글 2022 쪽·구역 이동
import { matchShortcut, defaultShortcuts, isStyleShortcutCommand } from '@/command/shortcut-map';
import {
  resolveCellBlockCtrlShiftS,
  resolveCellBlockLetterShortcut,
  resolveTableKeyShortcut, // [hwpx-cowork]
  type TableKeyShortcutContext,
  type TableKeyShortcutResolution,
} from '@/command/contextual-shortcut';
import * as _connector from './input-handler-connector';
import {
  detectPlatformKind,
  getCellSelectionArrowAction,
  getNavigationAction,
  shouldSuppressUnmappedNavigation,
  type NavigationAction,
  type NavigationKeyInput,
} from './navigation-keymap';
import type { DocumentPosition, CursorRect, CellBbox, CellPathLike } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';
import { tableObjectClipboardTarget } from './table-object-clipboard-target';
import { inlineOfficeClipboardImages, liftImagesToBlockLevel, needsRtfImageInlining } from './office-clipboard-images';
import { sanitizeOfficeHtmlForCore } from './office-html-sanitize';
import { scrollByPageStep, type PageScrollDirection } from '@/view/page-scroll';
import { emitHeaderFooterModeChanged } from './header-footer-mode';
import { queueNativeClipboard, readHancomNativeClipboard } from './native-clipboard'; // [hwpx-cowork]
import { appendHancomBoard, portableClipboardHtml, readPortableClipboard } from './portable-clipboard';
import { unwrapEngineHtmlFragment } from '@/command/export-html'; // [hwpx-cowork]
import { showToast } from '@/ui/toast';

const RHWP_CLIPBOARD_MARKER_RE = /<!--\s*rhwp-studio-clipboard:([A-Za-z0-9._:-]+)\s*-->/;
const PAGINATION_BOUNDARY_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  'Tab',
  'Escape',
]);

/**
 * 머리말/꼬리말·각주처럼 별도 편집 모델을 쓰는 모드에서도 안전하게 실행할 수 있는
 * 전역 편집 명령이다. 이 모드의 문자 입력은 아래 전용 분기가 소유하지만, 되돌리기와
 * 찾아가기는 문서 전체 명령이므로 조기 반환 전에 dispatcher로 전달해야 한다.
 */
/**
 * [Task #6741] 셀 블록 선택을 **유지한 채** 통과시키는 명령.
 *
 * 한컴은 셀 블록에서 되돌리기를 해도 블록을 놓지 않는다(실측: undo 뒤 지우기 전 블록이
 * 되살아난다). 종전 rhwp 는 방향키·Escape 외의 키를 전부 "그 외 키"로 흘려 블록을 먼저
 * 해제했으므로, undo 가 실행될 때는 되살릴 선택이 이미 없었다.
 *
 * 서브모드(머리말/꼬리말·각주)의 우회로보다 좁게 잡는다 — goto·select-all 은 셀 블록을
 * 들고 있을 이유가 없는 조작이라 종전대로 블록을 해제하고 넘긴다.
 */
const CELL_BLOCK_GLOBAL_COMMANDS = new Set([
  'edit:undo',
  'edit:redo',
  'edit:delete',
]);

function dispatchCellBlockGlobalShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const commandId = matchShortcut(e, defaultShortcuts);
  if (!commandId || !CELL_BLOCK_GLOBAL_COMMANDS.has(commandId)) return false;
  e.preventDefault();
  if (commandId === 'edit:delete' && e.ctrlKey && !e.metaKey) {
    if (!this.cursor.isProtectedCellSelectionMode()) {
      this.clearSelectedCellBlock();
      this.updateCellSelection();
    }
    return true;
  }
  this.dispatcher.dispatch(commandId);
  return true;
}

/**
 * [hwpx-cowork] 셀 블록을 **유지한 채** 블록 칸 전부에 적용하는 서식 명령.
 *
 * 서식 경로는 셀 블록을 이미 지원한다(`InputHandler.getSelectedCellBlock` → 블록 칸 전부).
 * 단축키만 셀 블록 분기의 "그 외 키"로 흘러 블록이 먼저 풀렸다. 한컴 「단축키 일람」의
 * '셀 블록 상태에서' 글자 모양(Alt+L)·문단 모양(Alt+T)과 같은 축이다. 스타일(F6)은 블록 적용
 * 경로가 없어 넣지 않았다.
 */
const CELL_BLOCK_FORMAT_COMMANDS = new Set([
  'format:bold',
  'format:italic',
  'format:underline',
  'format:char-shape',
  'format:para-shape',
  'format:align-left',
  'format:align-right',
  'format:align-center',
  'format:align-justify',
  'format:align-distribute',
  'format:font-size-increase',
  'format:font-size-decrease',
  'format:line-spacing-increase',
  'format:line-spacing-decrease',
  'format:char-ratio-increase',
  'format:char-ratio-decrease',
  'format:char-spacing-increase',
  'format:char-spacing-decrease',
]);

function dispatchCellBlockFormatShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const commandId = matchShortcut(e, defaultShortcuts);
  if (!commandId || !CELL_BLOCK_FORMAT_COMMANDS.has(commandId)) return false;
  e.preventDefault();
  this.dispatcher.dispatch(commandId);
  if (this.cursor.isInCellSelectionMode()) this.updateCellSelection();
  return true;
}

/**
 * [hwpx-cowork] Ctrl+1~9·Ctrl+0 스타일 단축키(한컴). 편집 칸에 포커스가 있으면 모드(머리말·각주·
 * 셀 블록·개체 선택·한글 조합 중)와 상관없이 키를 먹어 브라우저 탭 전환보다 먼저 처리한다.
 * 스타일을 넣을 수 없는 자리(머리말·각주 등)는 applyStyle 이 대상 없음으로 지나간다.
 * 셀 블록은 블록 칸 전부에 적용하고 블록을 유지한다(getParaFormatTargetsAtCursor).
 */
function dispatchStyleShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher || !(e.ctrlKey || e.metaKey)) return false;
  const commandId = matchShortcut(e, defaultShortcuts);
  if (!commandId || !isStyleShortcutCommand(commandId)) return false;
  e.preventDefault();
  this.dispatcher.dispatch(commandId);
  if (this.cursor.isInCellSelectionMode()) this.updateCellSelection();
  return true;
}

const SUBMODE_GLOBAL_COMMANDS = new Set([
  'edit:undo',
  'edit:redo',
  'edit:goto',
  'edit:select-all',
]);

/**
 * [#4031] 이 keydown이 아래 switch의 `case 'Enter'`에서 `SplitParagraphInCellCommand`로
 * 확정 실행되는 좁은 조건인지 판정한다. 목록은 flush 지점과 `case 'Enter'` 사이의 모든
 * 조기 분기(모드 가드·단축키 라우팅·선택 삭제)를 보수적으로 배제한다 — 하나라도
 * 확신할 수 없으면 false를 돌려 기존 before-navigation full flush로 fail-closed한다.
 */
function isCommittedCellEnterSplit(this: any, e: KeyboardEvent): boolean {
  return e.key === 'Enter'
    && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
    && !this.isComposing
    && !this.isFormMode?.()
    && !this.cursor.isInHeaderFooter()
    && !this.cursor.isInFootnote()
    && !this.cursor.isInPictureObjectSelection()
    && !this.cursor.isInTableObjectSelection()
    && !this.cursor.isInBlockSelectionMode()
    && !this.cursor.isInCellSelectionMode()
    && !this.cursor.hasSelection()
    && this.cursor.isInCell();
}

// [hwpx-cowork] 본문 Enter와 쪽 나누기는 직전 글자까지 포함해 현재 쪽을 발행한다.
// 성공 전에는 기존 글 입력 타이머를 보존한다. 모드·선택·다른 단축키는 원래 경계를 쓴다.
function isBodyStructuralEnter(this: any, e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || this.isComposing || this.isFormMode?.()) return false;
  const cursor = this.cursor;
  if (cursor.isInCell() || cursor.isInHeaderFooter() || cursor.isInFootnote()
      || cursor.isInPictureObjectSelection() || cursor.isInTableObjectSelection()
      || cursor.isInBlockSelectionMode() || cursor.isInCellSelectionMode() || cursor.hasSelection()
      || cursor.getPosition().parentParaIndex !== undefined) return false;
  return !(e.ctrlKey || e.metaKey)
    || (Boolean(this.dispatcher) && matchShortcut(e, defaultShortcuts) === 'page:break');
}

function dispatchSubmodeGlobalShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const commandId = matchShortcut(e, defaultShortcuts);
  if (!commandId || !SUBMODE_GLOBAL_COMMANDS.has(commandId)) return false;

  e.preventDefault();
  this.dispatcher.dispatch(commandId);
  return true;
}

function dispatchCellBlockCtrlShiftS(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const resolution = resolveCellBlockCtrlShiftS(e, {
    inCellSelectionMode: this.cursor.isInCellSelectionMode(),
    blockSumEnabled: this.dispatcher.isEnabled('table:block-sum'),
    saveAsEnabled: this.dispatcher.isEnabled('file:save-as'),
  });
  if (!resolution) return false;

  e.preventDefault();
  if (resolution.kind === 'dispatch') {
    this.dispatcher.dispatch(resolution.commandId);
  }
  return true;
}

function dispatchCellBlockLetterShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const resolution = resolveCellBlockLetterShortcut(e, {
    inCellSelectionMode: this.cursor.isInCellSelectionMode(),
    protectedCellSelection: this.cursor.isProtectedCellSelectionMode(), // [hwpx-cowork]
  });
  if (!resolution) return false;

  // macOS 한글 IME는 keydown을 막아도 동일 물리 키의 composition/input을 이어서 낼 수 있다.
  // 대화상자를 열기 전에 arm해야 focus 이동 중 발생하는 후속 이벤트도 놓치지 않는다.
  this._cellBlockLetterImeGuard?.arm(e);
  e.preventDefault();
  // [hwpx-cowork] H/W 처럼 아직 실행할 수 없는 셀 블록 글자는 칸에 글자가 들어가지 않게 막기만 한다.
  if (resolution.kind === 'consume') return true;
  // [hwpx-cowork] '하나의 셀처럼'(B/F)은 여러 칸 블록에서만 열린다 — 한 칸이면 '각 셀마다'로 대신한다.
  if (resolution.fallbackCommandId && !this.dispatcher.isEnabled(resolution.commandId)) {
    this.dispatcher.dispatch(resolution.fallbackCommandId, resolution.params);
    return true;
  }
  if (resolution.params) {
    this.dispatcher.dispatch(resolution.commandId, resolution.params);
    return true;
  }
  this.dispatcher.dispatch(resolution.commandId);
  return true;
}

/**
 * [hwpx-cowork] 표 문맥 키(Ctrl+Enter 줄 추가, Ctrl+Backspace 줄 지우기, 셀 블록 Ctrl+E·Ctrl+Shift+A/P,
 * 표 선택 P·Ctrl+E). IME 조기 반환과 셀 블록 해제보다 앞에서 처리한다 — 그 뒤로 흘리면
 * 블록이 먼저 풀리거나(명령 무동작) 한글 입력기가 키를 삼킨다.
 */
function tableKeyShortcutContext(this: any): TableKeyShortcutContext {
  const cursor = this.cursor;
  const inCell = cursor.isInCell();
  const inTextBox = inCell && cursor.isInTextBox();
  const depth = inCell ? cursor.nestingDepth() : 0;
  // 글상자 본문(깊이 1)은 표 칸이 아니다. 글상자 안 표(깊이 ≥2)는 칸이지만 줄 API 가 닿지 않는다.
  const inTableCell = inCell && !(inTextBox && depth < 2);
  let multiRow = false;
  if (cursor.isInCellSelectionMode()) {
    const range = cursor.getSelectedCellRange?.();
    multiRow = !!range && range.startRow !== range.endRow;
  }
  return {
    inTableCell,
    nestedTable: inTableCell && (inTextBox || depth > 1),
    inCellSelectionMode: cursor.isInCellSelectionMode(),
    multiRowCellSelection: multiRow,
    inTableObjectSelection: cursor.isInTableObjectSelection(),
    hasTextSelection: cursor.hasSelection(),
    otherMode: !!(this.isFormMode?.() || cursor.isInHeaderFooter() || cursor.isInFootnote()
      || cursor.isInPictureObjectSelection()),
  };
}

function runTableKeyShortcut(this: any, resolution: NonNullable<TableKeyShortcutResolution>): void {
  if (resolution.kind === 'consume') return;
  if (resolution.kind === 'clear-cell-block') {
    if (!this.cursor.isProtectedCellSelectionMode()) {
      this.clearSelectedCellBlock();
      this.updateCellSelection();
    }
    return;
  }
  this.dispatcher?.dispatch(resolution.commandId);
}

function dispatchTableKeyShortcut(this: any, e: KeyboardEvent): boolean {
  if (!this.dispatcher) return false;
  const resolution = resolveTableKeyShortcut(e, tableKeyShortcutContext.call(this));
  if (!resolution) return false;
  e.preventDefault();
  if (resolution.kind === 'dispatch' && resolution.ime) {
    // 표 선택 P: 대화상자로 포커스가 옮겨 가기 전에 한글 조합 스트림을 막는다.
    this._cellBlockLetterImeGuard?.arm(e);
  }
  // 조합 중(Ctrl 조합 키를 누르기 전에 치던 한글)이면 조합이 확정된 뒤에 표를 바꾼다.
  // 확정 전에 줄을 끼우면 조합 글자가 엉뚱한 칸으로 가거나 사라질 수 있다.
  if (e.isComposing && resolution.kind !== 'consume') {
    const ta: HTMLTextAreaElement | undefined = this.textarea;
    if (ta) {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        ta.removeEventListener('compositionend', onEnd);
        setTimeout(() => runTableKeyShortcut.call(this, resolution), 0);
      };
      const onEnd = () => fire();
      ta.addEventListener('compositionend', onEnd, { once: true });
      // compositionend 가 오지 않는 입력기 대비 — 잠시 뒤 그대로 실행한다.
      setTimeout(fire, 300);
      return true;
    }
  }
  runTableKeyShortcut.call(this, resolution);
  return true;
}

function createRhwpClipboardToken(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fallback below */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function escapeClipboardHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackClipboardHtml(text: string): string {
  const lines = (text || '').split(/\r?\n/);
  const body = lines.map(line => `<p>${escapeClipboardHtmlText(line)}</p>`).join('\n');
  return `<html><body>\n<!--StartFragment-->\n${body}\n<!--EndFragment-->\n</body></html>`;
}

function readRhwpClipboardToken(html: string): string | null {
  return RHWP_CLIPBOARD_MARKER_RE.exec(html)?.[1] ?? null;
}

function hasCurrentRhwpClipboardMarker(self: any, html: string): boolean {
  const token = readRhwpClipboardToken(html);
  return !!token && token === self.rhwpClipboardToken;
}

function isNestedCellPosition(pos: DocumentPosition): boolean {
  return pos.parentParaIndex !== undefined && (pos.cellPath?.length ?? 0) > 1;
}

function uniqueCellsInReadingOrder(bboxes: CellBbox[]): CellBbox[] {
  const seen = new Set<number>();
  const unique: CellBbox[] = [];
  for (const bbox of bboxes) {
    if (seen.has(bbox.cellIdx)) continue;
    seen.add(bbox.cellIdx);
    unique.push(bbox);
  }
  unique.sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
  return unique;
}

function tableCellStartPosition(pos: DocumentPosition, cellIndex: number): DocumentPosition {
  return {
    sectionIndex: pos.sectionIndex,
    paragraphIndex: 0,
    charOffset: 0,
    parentParaIndex: pos.parentParaIndex,
    controlIndex: pos.controlIndex,
    cellIndex,
    cellParaIndex: 0,
  };
}

function insertRowAfterLastTableCellByTab(this: any): boolean {
  const pos = this.cursor.getPosition() as DocumentPosition;
  const sec = pos.sectionIndex;
  const ppi = pos.parentParaIndex;
  const ci = pos.controlIndex;
  const currentCellIdx = pos.cellIndex;
  if (ppi === undefined || ci === undefined || currentCellIdx === undefined) return false;
  if (isNestedCellPosition(pos)) return false;

  try {
    const order = uniqueCellsInReadingOrder(this.wasm.getTableCellBboxes(sec, ppi, ci));
    if (order.length === 0 || order[order.length - 1].cellIdx !== currentCellIdx) {
      return false;
    }

    const info = this.wasm.getCellInfo(sec, ppi, ci, currentCellIdx);
    const insertAfterRow = info.row + Math.max(1, info.rowSpan || 1) - 1;
    this.executeOperation({
      kind: 'snapshot',
      operationType: 'insertTableRow',
      operation: (wasm: WasmBridge) => {
        wasm.insertTableRow(sec, ppi, ci, insertAfterRow, true);
        const nextOrder = uniqueCellsInReadingOrder(wasm.getTableCellBboxes(sec, ppi, ci));
        const insertedRow = insertAfterRow + 1;
        const nextCell = nextOrder.find(cell => cell.row === insertedRow)
          ?? nextOrder.find(cell => cell.row > insertAfterRow)
          ?? nextOrder[nextOrder.length - 1];
        return tableCellStartPosition(pos, nextCell?.cellIdx ?? currentCellIdx);
      },
    });
    return true;
  } catch (error) {
    console.warn('[InputHandler] 마지막 셀 Tab 행 추가 실패:', error);
    return false;
  }
}

/** ClipboardEvent cut 경로가 쓰는 개체 삭제 helper. keydown은 edit:delete로 라우팅한다. */
type PictureDeleteRef = {
  sec: number;
  ppi: number;
  ci: number;
  type: 'image' | 'shape' | 'equation' | 'group' | 'line' | 'ole';
  cellPath?: CellPathLike;
};

function deleteSelectedObject(wasm: WasmBridge, ref: PictureDeleteRef): void {
  if (ref.type === 'image') {
    if (ref.cellPath && ref.cellPath.length > 0) {
      wasm.deleteCellPictureControlByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci);
    } else {
      wasm.deletePictureControl(ref.sec, ref.ppi, ref.ci);
    }
  } else if (ref.type === 'equation') {
    wasm.deleteEquationControl(ref.sec, ref.ppi, ref.ci);
  } else if (ref.cellPath && ref.cellPath.length > 0) {
    wasm.deleteCellShapeControlByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci);
  } else {
    wasm.deleteShapeControl(ref.sec, ref.ppi, ref.ci);
  }
}

function toNavigationKeyInput(e: KeyboardEvent): NavigationKeyInput {
  return {
    key: e.key,
    code: e.code,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
  };
}

function executeNavigationAction(this: any, action: NavigationAction, shiftKey: boolean): void {
  if (shiftKey) this.cursor.setAnchor();
  else this.cursor.clearSelection();

  switch (action) {
    case 'wordBackward':
      this.cursor.moveToWordBoundary(-1);
      break;
    case 'wordForward':
      this.cursor.moveToWordBoundary(1);
      break;
    case 'lineStart':
      this.cursor.moveToLineStart();
      this.markCurrentFieldStartOutside?.();
      break;
    case 'lineEnd':
      this.cursor.moveToLineEnd();
      this.markCurrentFieldEndOutside?.();
      break;
    case 'paragraphBackward':
      this.cursor.moveToParagraphBoundary(-1);
      break;
    case 'paragraphForward':
      this.cursor.moveToParagraphBoundary(1);
      break;
    // [hwpx-cowork] 한/글 2022 MoveParaBegin·MoveParaEnd(Alt+Home/End)·MoveTopLevelBegin/End(Ctrl+PageUp/Down)
    case 'paragraphStart':
    case 'paragraphEnd':
      moveToParagraphEdge.call(this, action === 'paragraphStart' ? -1 : 1);
      break;
    case 'documentStart':
      this.cursor.moveToDocumentStart();
      break;
    case 'documentEnd':
      this.cursor.moveToDocumentEnd();
      break;
    case 'pagePrev':
    case 'pageNext': {
      // [hwpx-cowork] 한/글 PrevPage/NextPage — 앞/뒤 쪽의 시작(engine/h2022-navigation.ts)
      if (this.cursor.isInFootnote?.()) break;
      const target = pageMoveTarget(this.wasm, this.cursor.getPosition(), action);
      if (target) this.cursor.moveTo(target);
      break;
    }
  }

  this.updateCaret();
  if (shiftKey) this.updateSelection();
}

/** [hwpx-cowork] 지금 문단(본문·표 셀·글상자)의 처음(-1)/끝(1)으로 — 한/글 MoveParaBegin/End. 각주 안은 그대로 둔다. */
function moveToParagraphEdge(this: any, dir: -1 | 1): void {
  if (this.cursor.isInFootnote?.()) return;
  const pos = this.cursor.getPosition();
  let offset = 0;
  if (dir > 0) {
    const path = pos.cellPath as Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }> | undefined;
    if (path?.length && pos.parentParaIndex !== undefined) {
      offset = this.wasm.getCellParagraphLengthByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify(path));
    } else if (pos.parentParaIndex !== undefined && pos.controlIndex !== undefined && pos.cellIndex !== undefined) {
      offset = this.wasm.getCellParagraphLength(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex, pos.cellParaIndex ?? 0);
    } else {
      offset = this.wasm.getParagraphLength(pos.sectionIndex, pos.paragraphIndex);
    }
  }
  if (offset === pos.charOffset) return;
  this.cursor.moveTo({ ...pos, charOffset: offset, codeGap: undefined });
}

function handleNavigationShortcut(this: any, e: KeyboardEvent): boolean {
  const input = toNavigationKeyInput(e);
  const platform = detectPlatformKind();
  const action = getNavigationAction(input, platform);
  if (action) {
    e.preventDefault();
    executeNavigationAction.call(this, action, e.shiftKey);
    return true;
  }
  if (shouldSuppressUnmappedNavigation(input, platform)) {
    e.preventDefault();
    return true;
  }
  return false;
}

function executeHeaderFooterNavigationAction(
  this: any,
  action: NavigationAction,
  shiftKey: boolean,
): void {
  if (shiftKey) this.cursor.setHfAnchor();
  else this.cursor.clearSelection();

  switch (action) {
    case 'wordBackward':
      this.cursor.moveToWordBoundaryInHf(-1);
      break;
    case 'wordForward':
      this.cursor.moveToWordBoundaryInHf(1);
      break;
    case 'lineStart':
      this.cursor.moveToParagraphEdgeInHf(-1);
      break;
    case 'lineEnd':
      this.cursor.moveToParagraphEdgeInHf(1);
      break;
    case 'paragraphBackward':
      this.cursor.moveToParagraphBoundaryInHf(-1);
      break;
    case 'paragraphForward':
      this.cursor.moveToParagraphBoundaryInHf(1);
      break;
    // [hwpx-cowork] 머리말·꼬리말 안의 문단 처음/끝·글 처음/끝
    case 'paragraphStart':
      this.cursor.moveToParagraphEdgeInHf(-1);
      break;
    case 'paragraphEnd':
      this.cursor.moveToParagraphEdgeInHf(1);
      break;
    case 'documentStart':
    case 'documentEnd':
      this.cursor.moveToHeaderFooterBoundary(action === 'documentStart' ? -1 : 1);
      break;
    case 'pagePrev':
    case 'pageNext':
      break; // 머리말·꼬리말 안에서는 쪽 이동하지 않는다
  }

  this.updateCaret();
}

/** 본문과 같은 플랫폼별 탐색 규칙을 머리말/꼬리말 좌표계에 적용한다. */
function handleHeaderFooterNavigationShortcut(this: any, e: KeyboardEvent): boolean {
  const input = toNavigationKeyInput(e);
  const platform = detectPlatformKind();
  const action = getNavigationAction(input, platform);
  if (action) {
    e.preventDefault();
    executeHeaderFooterNavigationAction.call(this, action, e.shiftKey);
    return true;
  }

  const isTargetBoundary =
    ((e.metaKey && !e.ctrlKey && !e.altKey)
      && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))
    || (((e.ctrlKey || e.metaKey) && !e.altKey)
      && (e.key === 'Home' || e.key === 'End'));
  if (isTargetBoundary) {
    e.preventDefault();
    if (e.shiftKey) this.cursor.setHfAnchor();
    else this.cursor.clearSelection();
    const towardStart = e.key === 'ArrowUp' || e.key === 'Home';
    this.cursor.moveToHeaderFooterBoundary(towardStart ? -1 : 1);
    this.updateCaret();
    return true;
  }

  if (shouldSuppressUnmappedNavigation(input, platform)) {
    e.preventDefault();
    return true;
  }
  return false;
}

function positionAfterPasteResult(pos: DocumentPosition, parsed: any): DocumentPosition {
  const newPos: DocumentPosition = {
    // [hwpx-cowork] 실려 온 구역 나누기로 구역이 나뉘면 붙인 끝은 뒤 구역에 있다(secIdx)
    sectionIndex: pos.parentParaIndex === undefined ? parsed.secIdx ?? pos.sectionIndex : pos.sectionIndex,
    paragraphIndex: parsed.paraIdx ?? pos.paragraphIndex,
    charOffset: parsed.charOffset ?? pos.charOffset,
  };

  if (pos.parentParaIndex !== undefined) {
    const nextCellParaIndex = parsed.cellParaIdx ?? parsed.cellParaIndex ?? pos.cellParaIndex;
    newPos.parentParaIndex = pos.parentParaIndex;
    newPos.controlIndex = pos.controlIndex;
    newPos.cellIndex = pos.cellIndex;
    newPos.cellParaIndex = nextCellParaIndex;
    if (pos.cellPath) {
      newPos.cellPath = pos.cellPath.map((entry, index) =>
        index === pos.cellPath!.length - 1
          ? { ...entry, cellParaIndex: nextCellParaIndex ?? entry.cellParaIndex }
          : entry,
      );
    }
  }

  return newPos;
}

function pastePlainText(this: any, text: string, hasSelection: boolean): void {
  if (hasSelection) {
    // [hwpx-cowork] 스냅샷 밖이라 기록해야 되돌릴 수 있다(종전 deferRecord 는 지운 글이 되돌리기로 돌아오지 않았다)
    this.deleteSelection();
  }
  if (!text) return;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      this.executeOperation({ kind: 'command', command: new InsertTextCommand(this.cursor.getPosition(), lines[i]) });
    }
    if (i < lines.length - 1) {
      const position = this.cursor.getPosition();
      const command = this.cursor.isInCell()
        ? new SplitParagraphInCellCommand(position)
        : new SplitParagraphCommand(position);
      this.executeOperation({ kind: 'command', command });
    }
  }
}

export function prepareRhwpInternalClipboardHtml(self: any, html: string, text = ''): string {
  const token = createRhwpClipboardToken();
  self.rhwpClipboardToken = token;
  // [hwpx-cowork] Keep the marker and native document INSIDE StartFragment.
  // Browsers expose that range on paste and discard comments outside it.
  const fragment = self.wasm.exportClipboardHwpx();
  queueNativeClipboard(self, token, fragment);
  // 한글 Ctrl+V 용 문서모델 — 설치 없이 표·그림·자동번호를 원본 구조로 옮긴다. 실패해도 일반 HTML 은 유지.
  let board = '';
  try { board = self.wasm.exportClipboardHancomHtml(); } catch (error) { console.warn('[copy] 한글 문서모델 생성 실패', error); }
  return appendHancomBoard(portableClipboardHtml(html || fallbackClipboardHtml(text), token, fragment), board);
}

export async function writeTextHtmlToClipboard(text: string, html: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const item = new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  });
  await navigator.clipboard.write([item]);
}

/** 비-PNG 이미지를 PNG Blob으로 변환한다. PNG는 그대로 반환. */
async function convertToPngBlob(data: Uint8Array, mime: string): Promise<Blob> {
  // new Uint8Array(data)로 ArrayBuffer 기반 복사 — WASM 반환 Uint8Array의 SharedArrayBuffer 호환 문제 방지
  const buf = new Uint8Array(data);
  if (mime === 'image/png') return new Blob([buf], { type: 'image/png' });
  const img = new Image();
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  try {
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** [Task #1161] 선택된 picture ref 의 cellPath 를 native cellPathJson 인자로 변환.
 * 셀/글상자 밖 picture(본문)는 빈 문자열 → native 가 본문 경로로 처리. */
export function pictureCellPathJson(
  ref: { cellPath?: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }> } | null,
): string {
  return ref && ref.cellPath && ref.cellPath.length > 0 ? JSON.stringify(ref.cellPath) : '';
}

/** 이미지 컨트롤의 바이너리를 포함하여 시스템 클립보드에 기록한다. */
export async function writeImageToClipboard(
  wasm: WasmBridge, sec: number, ppi: number, ci: number,
  text: string, html: string, cellPathJson = '',
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const imageData = wasm.getControlImageData(sec, ppi, ci, cellPathJson);
  const mime = wasm.getControlImageMime(sec, ppi, ci, cellPathJson);
  const pngBlob = await convertToPngBlob(imageData, mime);
  if (!isCurrent()) return;
  const item = new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
    'image/png': pngBlob,
  });
  await navigator.clipboard.write([item]);
}

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+K,? 형태) */
const chordMapK: Record<string, string> = {
  h: 'insert:hyperlink',
  ㅗ: 'insert:hyperlink', // 한글 IME 상태
  b: 'insert:bookmark',
  ㅠ: 'insert:bookmark', // 한글 IME 상태
  n: 'format:para-num-shape',
  ㅜ: 'format:para-num-shape', // 한글 IME 상태
  // [hwpx-cowork] 한/글 2022 입력 > 날짜/시간 — Ctrl+K,D 문자열 · Ctrl+K,F 형식 · Ctrl+K,C 코드
  d: 'insert:date-string',
  ㅇ: 'insert:date-string', // 한글 IME 상태
  f: 'insert:date-format',
  ㄹ: 'insert:date-format', // 한글 IME 상태
  c: 'insert:date-code', // Ctrl+K,C 날짜/시간 코드
  ㅊ: 'insert:date-code', // 한글 IME 상태
  r: 'insert:cross-reference', // [hwpx-cowork] Ctrl+K,R 상호 참조
  ㄱ: 'insert:cross-reference', // 한글 IME 상태
};

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+M,? 형태)
 *
 * 한컴 표준 영역 영역 Ctrl+N 영역 영역 chord 시작 영역 영역 Chrome 영역 영역 reserved shortcut
 * (새 창) 영역 영역 JS 차단 불가 영역 영역 Ctrl+M 영역 영역 변경 (PR #786 후속 정정).
 */
const chordMapM: Record<string, string> = {
  a: 'table:split',   // 한컴 Ctrl+N,A — Chrome 이 Ctrl+N 을 차단해 Ctrl+M 계열로 이관
  ㅁ: 'table:split',  // 한글 IME
  z: 'table:attach',  // 한컴 Ctrl+N,Z
  ㅋ: 'table:attach', // 한글 IME
  n: 'insert:footnote',
  ㅜ: 'insert:footnote', // 한글 IME
  s: 'page:hide',
  ㄴ: 'page:hide', // 한글 IME
  // [hwpx-cowork] 한컴 Ctrl+N,P 쪽 번호 매기기(h2022-format)
  p: 'page:pagenum-pos',
  ㅔ: 'page:pagenum-pos', // 한글 IME
  m: 'insert:equation',
  ㅡ: 'insert:equation', // 한글 IME
  // [hwpx-cowork] 한컴 Ctrl+N,F 계산식 — 메뉴에는 'Ctrl+M,F' 로 표시돼 있었으나 연결이 없었다.
  f: 'table:formula',
  ㄹ: 'table:formula', // 한글 IME
};

/** 코드 단축키 → 커맨드 ID 매핑 (Alt+V,? 형태 — 보기 메뉴) */
const chordMapV: Record<string, string> = {
  t: 'view:border-transparent',
  ㅅ: 'view:border-transparent', // 한글 IME
};

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+G,? 형태 — 보기/조판 메뉴) */
const chordMapG: Record<string, string> = {
  c: 'view:ctrl-mark',        // 조판 부호
  ㅊ: 'view:ctrl-mark',       // 한글 IME
  t: 'view:para-mark',        // 문단 부호
  ㅅ: 'view:para-mark',       // 한글 IME
  p: 'view:zoom-fit-page',    // 쪽 맞춤
  ㅍ: 'view:zoom-fit-page',   // 한글 IME
  w: 'view:zoom-fit-width',   // 폭 맞춤
  ㅈ: 'view:zoom-fit-width',  // 한글 IME
  q: 'view:zoom-100',         // 100%
  ㅂ: 'view:zoom-100',        // 한글 IME
};

/**
 * PgUp/PgDn 처리 — 화면을 쪽 단위로 옮기고, 캐럿을 **화면상 같은 자리**에 남긴다.
 *
 * 한글은 PgUp/PgDn 이 캐럿도 함께 옮긴다. 화면만 옮기면 다음 방향키·타이핑 한 번에
 * 원래 쪽으로 되튀어, 사용자 눈에는 이동이 취소된 것처럼 보인다.
 *
 * 캐럿이 없거나(문서 미배치) 캐럿 소유자가 본문이 아닌 하위 모드(머리말/꼬리말·각주·
 * 개체/셀 선택·서식 모드)일 때는 화면만 옮긴다 — 그 모드들의 캐럿은 본문 좌표계로
 * hit-test 할 수 없고, 옮기면 편집 문맥이 바뀌어 버린다.
 *
 * @returns 실제로 스크롤이 일어났으면 true.
 */
export function scrollByPageKey(
  this: any,
  direction: PageScrollDirection,
  extendSelection: boolean,
): boolean {
  const beforeRect: CursorRect | null = caretRectForPageScroll.call(this);
  const result = scrollByPageStep(this.virtualScroll, this.viewportManager, direction);
  if (!result.moved) return false;
  if (beforeRect) {
    moveCaretWithPageScroll.call(
      this,
      beforeRect,
      result.deltaX,
      result.deltaY,
      extendSelection,
    );
  }
  return true;
}

/**
 * Ctrl+Home/Ctrl+End 뒤 화면을 문서 처음/끝에 붙인다.
 *
 * `updateCaret` 의 caret-into-view 는 캐럿이 보이기만 하면 멈추므로, 문서 처음으로
 * 갔는데도 첫 쪽 위 여백이 잘린 채(실측 122px 내려간 채) 남는다. 사용자가 Ctrl+Home 에
 * 기대하는 것은 "문서 맨 위" 지 "첫 줄이 어딘가 보이는 화면" 이 아니다.
 *
 * 단, 끝 화면에 캐럿이 들어올 때만 붙인다 — 확대해서 첫 줄이 한 화면 아래에 있는
 * 경우까지 맨 위로 붙이면 방금 옮긴 캐럿을 화면 밖으로 밀어낸다.
 */
function snapViewToDocumentEdge(this: any, edge: -1 | 1): void {
  const rect: CursorRect | null = this.cursor.getRect?.() ?? null;
  if (!rect) return;

  const zoom = this.viewportManager.getZoom();
  const viewportHeight = this.viewportManager.getViewportSize().height;
  const limit = Math.max(0, this.virtualScroll.getTotalHeight() - viewportHeight);
  const caretTop = this.virtualScroll.getPageOffset(rect.pageIndex) + rect.y * zoom;

  if (edge < 0) {
    if (caretTop + rect.height * zoom <= viewportHeight) this.viewportManager.setScrollTop(0);
  } else if (caretTop >= limit) {
    this.viewportManager.setScrollTop(limit);
  }
}

/** 화면과 함께 옮겨도 되는 캐럿이면 그 rect 를, 아니면 null 을 준다. */
function caretRectForPageScroll(this: any): CursorRect | null {
  const cursor = this.cursor;
  if (this.isFormMode?.()) return null;
  if (cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return null;
  if (cursor.isInPictureObjectSelection?.() || cursor.isInTableObjectSelection?.()) return null;
  if (cursor.isInBlockSelectionMode?.() || cursor.isInCellSelectionMode?.()) return null;
  return cursor.getRect?.() ?? null;
}

/**
 * 스크롤 뒤, 스크롤 전 캐럿이 있던 **화면 위치**에 해당하는 문서 위치로 캐럿을 옮긴다.
 * 내용이 `deltaX`/`deltaY` 만큼 왼쪽/위로 흘렀으니, 같은 화면 자리는 문서 좌표로
 * 각각 그 변화량만큼 오른쪽/아래다.
 */
function moveCaretWithPageScroll(
  this: any,
  beforeRect: CursorRect,
  deltaX: number,
  deltaY: number,
  extendSelection: boolean,
): void {
  const hit = hitTestAfterPageScroll.call(this, beforeRect, deltaX, deltaY);
  // hit 이 없으면(여백·빈 쪽에 떨어짐) 캐럿을 그대로 둔다 — 화면 이동만으로도
  // 읽기는 되고, 엉뚱한 위치로 옮기는 것보다 낫다.
  if (!hit) return;

  if (extendSelection) {
    this.cursor.setAnchor();
  } else {
    this.cursor.clearSelection();
  }
  this.cursor.moveToHit(hit);
  this.cursor.resetPreferredX();
  // 캐럿은 이미 화면 안(스크롤 전과 같은 자리)이라 다시 스크롤할 이유가 없다.
  // updateCaret() 을 쓰면 caret-into-view 가 방금 맞춘 화면을 흔든다.
  this.updateCaretNoScroll();
  if (extendSelection) this.updateSelection();
}

/** 스크롤 전 캐럿 rect + X/Y 스크롤 변화량 → 스크롤 후 같은 화면 자리의 문서 위치. */
function hitTestAfterPageScroll(
  this: any,
  beforeRect: CursorRect,
  deltaX: number,
  deltaY: number,
): DocumentPosition | null {
  const scrollContent = this.container.querySelector('#scroll-content');
  if (!scrollContent) return null;

  const zoom = this.viewportManager.getZoom();
  const pageLeft = this.virtualScroll.getPageLeftResolved(
    beforeRect.pageIndex,
    scrollContent.clientWidth,
  );
  const contentX = pageLeft + beforeRect.x * zoom;
  // 캐럿 세로 중앙을 기준점으로 삼는다 — 줄 경계에 딱 걸려 이웃 줄로 새지 않게.
  const contentY = this.virtualScroll.getPageOffset(beforeRect.pageIndex)
    + (beforeRect.y + beforeRect.height / 2) * zoom;

  // scroll-content 의 화면 좌표는 이미 스크롤이 반영된 값이라, 문서 좌표에 그대로 더하면
  // 스크롤 후의 화면 좌표가 된다.
  const contentRect = scrollContent.getBoundingClientRect();
  return this.hitTestFromClientPoint(
    contentRect.left + contentX + deltaX,
    contentRect.top + contentY + deltaY,
  );
}

/**
 * 키보드 이벤트 처리 순서:
 *

 * 1. 코드 단축키 2번째 키 (Ctrl+K → ? / Ctrl+M → ?)
 * 2. 특수 모드 탈출 (연결선/다각형/이미지/글상자 배치 모드 → Escape)
 * 3. IME 조합 중 네비게이션 키 보류
 * 4. PgUp/PgDn 화면 이동 — 아래 편집 모드 분기(5~8)가 삼키기 전에 먼저 소비한다
 * 5. 편집 모드별 키 처리 (머리말꼬리말 / 각주)
 * 6. F5 셀 선택 모드
 * 7. 셀 선택 모드 키 처리
 * 8. 그림/표 객체 선택 모드 키 처리
 * 9. 플랫폼별 navigation shortcut 처리
 * 10. Ctrl/Meta 조합 → handleCtrlKey() → shortcut-map.ts 단축키 테이블 경유
 * 11. Alt 조합 → shortcut-map.ts 단축키 테이블 경유
 * 12. 본문 키 처리 (Esc, Backspace, Enter, Arrow 등)
 *
 * 새 단축키 추가 시: shortcut-map.ts의 defaultShortcuts 테이블에 등록
 */
export function onKeyDown(this: any, e: KeyboardEvent): void {
  if (!this.active) return;
  if (['Delete', 'Backspace', 'Enter', 'Tab'].includes(e.key)
    && !(e.key === 'Tab' && this.isFormMode?.())
    && this.cursor.hasSelection()
    && this.canDeleteSelectionInFormMode?.() === false) {
    e.preventDefault();
    return;
  }

  // fcitx forwards the same physical key after its Process/compositionend sequence.
  if (this._imeNavigationGuard?.consume(e)) {
    e.preventDefault();
    return;
  }

  // 이전 셀 문자 단축키의 compositionend가 브라우저 focus 이동으로 누락됐더라도 다음
  // 물리 입력까지 억제 상태가 새지 않게 한다. 현재 S/M이면 아래 resolver가 다시 arm한다.
  this._cellBlockLetterImeGuard?.reset();

  // ─── 1. 코드 단축키 2번째 키 처리 (Ctrl+K → ? / Ctrl+M → ?) ───
  if (this._pendingChordK) {
    this._pendingChordK = false;
    const key = e.key.toLowerCase();
    const cmdId = chordMapK[key];
    if (cmdId && this.dispatcher) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }
  // 한글 IME 조합 중이면 e.key 가 'Process' 라 여기서 chord 를 판별할 수 없다.
  // flag 를 소모하지 않고 아래 IME 전용 분기(e.code 기반)로 넘긴다 — 종전에는
  // 여기서 flag 를 지워 버려 IME 분기가 도달 불가였다. (M chord 만 IME 전용
  // 분기를 갖고 있어 예외도 M 에만 둔다 — K/V/G 는 IME 경로 자체가 없다.)
  if (this._pendingChordM && !(e.isComposing || e.keyCode === 229)) {
    this._pendingChordM = false;
    const key = e.key.toLowerCase();
    const cmdId = chordMapM[key];
    if (cmdId && this.dispatcher) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }
  if (this._pendingChordV) {
    this._pendingChordV = false;
    const key = e.key.toLowerCase();
    const cmdId = chordMapV[key];
    if (cmdId && this.dispatcher) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }
  if (this._pendingChordG) {
    this._pendingChordG = false;
    const key = e.key.toLowerCase();
    const cmdId = chordMapG[key];
    if (cmdId && this.dispatcher) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }

  // 연결선 드로잉 모드
  if (this.connectorDrawingMode) {
    if (e.key === 'Escape') {
      e.preventDefault();
      _connector.exitConnectorDrawingMode.call(this);
      return;
    }
    return; // 다른 키 무시
  }

  // 다각형 그리기 모드
  if (this.polygonDrawingMode) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.polygonPoints.length >= 2) {
        this.finishPolygonDrawing(); // 현재까지 그린 다각형 확정
      } else {
        this.cancelPolygonDrawing();
      }
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      this.polygonPoints.pop();
      if (this.polygonPoints.length === 0) {
        this.cancelPolygonDrawing();
      } else {
        const last = this.polygonPoints[this.polygonPoints.length - 1];
        this.updatePolygonOverlay(this.polygonMousePos?.x ?? last.x, this.polygonMousePos?.y ?? last.y);
      }
      return;
    }
    return; // 다른 키 무시
  }

  // 연속 형광펜 모드에서 Escape → 종료
  if (this.highlightPenColor && e.key === 'Escape') {
    e.preventDefault();
    this.setHighlightPen(null);
    return;
  }

  // 그림 배치 모드에서 Escape → 취소
  if (this.imagePlacementMode && e.key === 'Escape') {
    e.preventDefault();
    this.cancelImagePlacement();
    return;
  }

  // 글상자 배치 모드에서 Escape → 취소
  if (this.textboxPlacementMode && e.key === 'Escape') {
    e.preventDefault();
    this.cancelTextboxPlacement();
    return;
  }

  if (dispatchCellBlockCtrlShiftS.call(this, e)) return;
  if (dispatchCellBlockLetterShortcut.call(this, e)) return;
  if (dispatchTableKeyShortcut.call(this, e)) return; // [hwpx-cowork]
  if (dispatchStyleShortcut.call(this, e)) return; // [hwpx-cowork]

  // IME 조합 중 처리 (한국어 IME에서 e.key는 항상 'Process'이므로 e.code로 판별)
  if (e.isComposing || e.keyCode === 229) {
    // [PR #786 후속] Ctrl+M chord 1번째/2번째 키 영역 영역 IME 합성 중 영역 영역도 활성화.
    // 한글 IME 영역 영역 e.key === 'Process' 영역 영역, e.code (KeyM/KeyN/KeyS/KeyF/KeyK 등) 영역 영역 판별.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyM') {
      e.preventDefault();
      this._pendingChordM = true;
      return;
    }
    // chord 2번째 키 — _pendingChordM 활성화 시 e.code 영역 영역 chordMapM lookup
    if (this._pendingChordM) {
      this._pendingChordM = false;
      const codeToKey: Record<string, string> = {
        KeyM: 'm', KeyN: 'n', KeyS: 's', KeyF: 'f', KeyK: 'k',
        KeyA: 'a', KeyZ: 'z', // 표 나누기/붙이기 (Ctrl+M,A / Ctrl+M,Z)
        KeyP: 'p', // [hwpx-cowork] 쪽 번호 매기기 (Ctrl+M,P)
      };
      const key = codeToKey[e.code];
      if (key && this.dispatcher) {
        const cmdId = chordMapM[key];
        if (cmdId) {
          e.preventDefault();
          this.dispatcher.dispatch(cmdId);
          return;
        }
      }
    }
    // 조합 중에도 e.code로 판별 가능한 기본 Ctrl/Meta 단축키는 일반 경로와 같은 dispatcher로 보낸다.
    // Ctrl+M chord는 위에서 먼저 소비하고, 매칭되지 않는 키는 기존 조합 처리로 계속 진행한다.
    if ((e.ctrlKey || e.metaKey) && this.dispatcher) {
      const cmdId = matchShortcut(e, defaultShortcuts);
      if (cmdId) {
        e.preventDefault();
        if (cmdId === 'edit:delete' && this.cursor.isInCellSelectionMode() && e.ctrlKey && !e.metaKey) {
          if (!this.cursor.isProtectedCellSelectionMode()) {
            this.clearSelectedCellBlock();
            this.updateCellSelection();
          }
          return;
        }
        this.dispatcher.dispatch(cmdId);
        return;
      }
    }
    const navCodes = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                      'Home', 'End', 'Escape', 'Enter', 'Tab',
                      'PageUp', 'PageDown'];
    if (navCodes.includes(e.code)) {
      // 브라우저가 조합을 자연스럽게 종료하도록 두고,
      // compositionEnd 후 탐색 키를 처리하도록 예약
      this._pendingNavAfterIME = {
        key: e.key, code: e.code, shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
      };
      this._imeNavigationGuard?.queue(this._pendingNavAfterIME);
    }
    return;
  }

  // [#4031] 셀 Enter는 `SplitParagraphInCellCommand`의 동기 full pagination이 확정이라,
  // 곧 폐기될 분할 전 pagination을 flush로 완주하는 대신 stale deferred job만 취소한다.
  // admission 미충족 시 기존 full barrier 그대로다.
  const committedCellEnterSplit = PAGINATION_BOUNDARY_KEYS.has(e.key)
    && isCommittedCellEnterSplit.call(this, e);
  if (PAGINATION_BOUNDARY_KEYS.has(e.key)) {
    if (committedCellEnterSplit) {
      this.cancelDeferredPaginationForOwnedMutation();
    } else if (!isBodyStructuralEnter.call(this, e)) {
      this.flushDeferredPaginationIfNeeded('before-navigation', false);
    }
  }

  // [hwpx-cowork] 셀 블록(F5 한 칸 단계) Home/End/PgUp/PgDn = 그 줄의 처음·끝 칸 / 그 칸(열)의 맨 위·아래 칸.
  // 한/글 단축키 자료 TableMoveColBegin/End(Home/End)·TableMovePageUp/Down(PgUp/PgDn), 2022 COM TableColBegin/End/
  // PageUp/PageDown 실측((2,1) → (2,0)·(2,2)·(0,1)·(3,1)). 화면 쪽 이동(아래 4.)보다 먼저 본다(h2022 표).
  if ((e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown')
      && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      && this.cursor.isInCellSelectionMode() && this.cursor.getCellSelectionPhase() === 1) {
    const ctx = this.cursor.getCellTableContext();
    if (ctx && this.cursor.getCellSelectionFocus()) {
      e.preventDefault();
      const bboxes: Array<{ row: number; col: number; rowSpan: number; colSpan: number }> = ctx.cellPath
        ? this.wasm.getTableCellBboxesByPath(ctx.sec, ctx.ppi, JSON.stringify(ctx.cellPath))
        : this.wasm.getTableCellBboxes(ctx.sec, ctx.ppi, ctx.ci);
      const colCount = Math.max(0, ...bboxes.map((b) => b.col + b.colSpan));
      const dr = e.key === 'PageUp' ? -1 : e.key === 'PageDown' ? 1 : 0;
      const dc = e.key === 'Home' ? -1 : e.key === 'End' ? 1 : 0;
      for (let guard = 0; guard < 512; guard += 1) {
        const f = this.cursor.getCellSelectionFocus();
        if (!f) break;
        const cur = bboxes.find((b) => f.row >= b.row && f.row < b.row + b.rowSpan && f.col >= b.col && f.col < b.col + b.colSpan);
        // 가로 이동은 줄 끝에서 다음 줄로 넘어가므로(moveCellSelection) 줄의 처음·끝 칸에서 멈춘다
        if (dc < 0 && (!cur || cur.col === 0)) break;
        if (dc > 0 && (!cur || cur.col + cur.colSpan >= colCount)) break;
        this.cursor.moveCellSelection(dr, dc);
        const g = this.cursor.getCellSelectionFocus();
        if (!g || (g.row === f.row && g.col === f.col)) break; // 표 끝(세로)
      }
      this.caret.hide();
      this.updateCellSelection();
      return;
    }
  }

  // ─── 4. PgUp/PgDn 화면 이동 ───────────────────────────────
  // 편집 위치가 아니라 화면을 옮기는 키다. 아래 모드별 분기(머리말/꼬리말·각주·개체
  // 선택·셀 선택 등)가 키를 삼켜 무동작이 되지 않도록 여기서 먼저 처리한다.
  if ((e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    scrollByPageKey.call(this, e.key === 'PageUp' ? -1 : 1, e.shiftKey);
    return;
  }

  // ─── 머리말/꼬리말 편집 모드 키보드 처리 ──────────────────
  if (this.cursor.isInHeaderFooter()) {
    if (dispatchSubmodeGlobalShortcut.call(this, e)) return;

    // 선택이 있는 Esc는 선택만 해제한다. Shift+Esc 또는 선택 없는 Esc는 모드 탈출.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!e.shiftKey && this.cursor.hasHeaderFooterSelection()) {
        this.cursor.clearSelection();
        this.updateCaret();
        return;
      }
      // 현재 보고 있는 페이지 기억
      const hfPage = this.cursor.rect?.pageIndex ?? 0;
      this.cursor.exitHeaderFooterMode();
      emitHeaderFooterModeChanged(this.eventBus, this.cursor);
      // 해당 페이지의 본문 첫 문단 시작점으로 커서 이동
      try {
        const pageInfo = this.wasm.getPageInfo(hfPage);
        const bodyX = pageInfo.marginLeft + 1;
        const bodyY = pageInfo.marginTop + pageInfo.marginHeader + 1;
        const hit = this.wasm.hitTest(hfPage, bodyX, bodyY);
        if (hit.paragraphIndex < 0xFFFFFF00) {
          this.cursor.moveTo(hit);
        }
      } catch { /* hitTest 실패 시 기존 위치 유지 */ }
      this.afterEdit();
      this.textarea?.focus();
      return;
    }

    if (handleHeaderFooterNavigationShortcut.call(this, e)) return;

    // 수정자에 별도 의미가 없는 방향키 → 머리말/꼬리말 내 시각 이동.
    // Shift는 현재 위치를 HF anchor로 고정해 범위를 확장한다.
    if (
      e.key === 'ArrowLeft'
      || e.key === 'ArrowRight'
      || e.key === 'ArrowUp'
      || e.key === 'ArrowDown'
    ) {
      e.preventDefault();
      if (e.shiftKey) this.cursor.setHfAnchor();
      else this.cursor.clearSelection();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.cursor.moveHorizontalInHf(e.key === 'ArrowLeft' ? -1 : 1);
      } else {
        this.cursor.moveVerticalInHf(e.key === 'ArrowUp' ? -1 : 1);
      }
      this.updateCaret();
      return;
    }

    // Shift+Enter → 머리말/꼬리말 내 강제 줄바꿈
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      const isHeader = this.cursor.headerFooterMode === 'header';
      try {
        const target = {
          sectionIdx: this.cursor.hfSectionIdx, isHeader, applyTo: this.cursor.hfApplyTo,
          previewPage: this.cursor.hfPreviewPage,
        };
        const paraIdx = this.cursor.hfParaIdx;
        const charOffset = this.cursor.hfCharOffset;
        this.wasm.insertTextInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx, charOffset, '\n');
        this.executeOperation({ kind: 'record', command: new InsertTextInHeaderFooterCommand(target, paraIdx, charOffset, '\n') });
        this.cursor.setHfCursorPosition(paraIdx, charOffset + 1);
        this.afterEdit();
      } catch { /* ignore */ }
      return;
    }

    // Enter → 머리말/꼬리말 내 문단 분할
    if (e.key === 'Enter') {
      e.preventDefault();
      const isHeader = this.cursor.headerFooterMode === 'header';
      try {
        const target = {
          sectionIdx: this.cursor.hfSectionIdx, isHeader, applyTo: this.cursor.hfApplyTo,
          previewPage: this.cursor.hfPreviewPage,
        };
        const paraIdx = this.cursor.hfParaIdx;
        const charOffset = this.cursor.hfCharOffset;
        const result = JSON.parse(this.wasm.splitParagraphInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx, charOffset));
        this.executeOperation({ kind: 'record', command: new SplitParagraphInHeaderFooterCommand(target, paraIdx, charOffset, result.hfParaIndex) });
        this.cursor.setHfCursorPosition(result.hfParaIndex, 0);
        this.afterEdit();
      } catch { /* ignore */ }
      return;
    }

    // Backspace / Delete는 handleBackspace/handleDelete에서 처리
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (this.getNonEmptyHeaderFooterSelection()) {
        this.deleteSelection();
        return;
      }
      const pos = this.cursor.getPosition();
      if (e.key === 'Backspace') {
        this.handleBackspace(pos, false);
      } else {
        this.handleDelete(pos, false);
      }
      return;
    }

    // 기타 키 (문자 입력)는 기본 처리로 전달 (textarea의 input 이벤트로 처리)
    return;
  }

  // ─── 각주 편집 모드 키보드 처리 ──────────────────────────
  if (this.cursor.isInFootnote()) {
    if (dispatchSubmodeGlobalShortcut.call(this, e)) return;

    // Shift+Esc 또는 Escape → 주석 편집 모드 탈출
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cursor.exitFootnoteMode();
      this.eventBus.emit('footnoteModeChanged', false);
      this.afterEdit();
      this.textarea?.focus();
      return;
    }

    // 방향키 → 각주 내 이동
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      this.cursor.moveHorizontalInFn(delta);
      this.updateCaret();
      return;
    }

    // Home/End → 각주 내 줄 처음·끝. 머리말/꼬리말과 같은 이유로 여기서 처리한다.
    if ((e.key === 'Home' || e.key === 'End') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.cursor.moveToParagraphEdgeInFn(e.key === 'Home' ? -1 : 1);
      this.updateCaret();
      return;
    }

    // Enter → 각주 내 문단 분할
    if (e.key === 'Enter') {
      e.preventDefault();
      try {
        const target = { sectionIdx: this.cursor.fnSectionIdx, paraIdx: this.cursor.fnParaIdx, controlIdx: this.cursor.fnControlIdx, footnoteIndex: this.cursor.fnFootnoteIndex, pageNum: this.cursor.fnPageNum };
        const innerParaIdx = this.cursor.fnInnerParaIdx;
        const charOffset = this.cursor.fnCharOffset;
        const result = this.wasm.splitParagraphInFootnote(target.sectionIdx, target.paraIdx, target.controlIdx, innerParaIdx, charOffset);
        this.executeOperation({ kind: 'record', command: new SplitParagraphInFootnoteCommand(target, innerParaIdx, charOffset, result.fnParaIndex) });
        this.cursor.setFnCursorPosition(result.fnParaIndex, 0);
        this.afterEdit();
      } catch { /* ignore */ }
      return;
    }

    // Backspace / Delete
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const target = { sectionIdx: this.cursor.fnSectionIdx, paraIdx: this.cursor.fnParaIdx, controlIdx: this.cursor.fnControlIdx, footnoteIndex: this.cursor.fnFootnoteIndex, pageNum: this.cursor.fnPageNum };
      const innerParaIdx = this.cursor.fnInnerParaIdx;
      const fnOff = this.cursor.fnCharOffset;
      if (e.key === 'Backspace') {
        if (fnOff > 0) {
          try {
            // [Task #2337] 삭제 텍스트를 반환에서 확보해 역연산 기록. Backspace → undo 후 커서 fnOff.
            const res = this.wasm.deleteTextInFootnote(target.sectionIdx, target.paraIdx, target.controlIdx, innerParaIdx, fnOff - 1, 1);
            this.executeOperation({ kind: 'record', command: new DeleteTextInFootnoteCommand(target, innerParaIdx, fnOff - 1, res.deletedText ?? '', fnOff) });
            this.cursor.setFnCursorPosition(innerParaIdx, fnOff - 1);
            this.afterEdit();
          } catch { /* ignore */ }
        } else if (innerParaIdx > 0) {
          // 문단 시작에서 Backspace → 이전 문단과 병합. 병합 전 커서 (innerParaIdx, 0).
          try {
            const result = this.wasm.mergeParagraphInFootnote(target.sectionIdx, target.paraIdx, target.controlIdx, innerParaIdx);
            this.executeOperation({ kind: 'record', command: new MergeParagraphInFootnoteCommand(target, innerParaIdx, result.fnParaIndex, result.charOffset, innerParaIdx, 0, result.removedParaMeta) });
            this.cursor.setFnCursorPosition(result.fnParaIndex, result.charOffset);
            this.afterEdit();
          } catch { /* ignore */ }
        }
      } else {
        // Delete(forward): 커서는 fnOff 유지 → undo 후에도 fnOff.
        try {
          const res = this.wasm.deleteTextInFootnote(target.sectionIdx, target.paraIdx, target.controlIdx, innerParaIdx, fnOff, 1);
          // 문단 끝(삭제 대상 없음)에서는 clamp 로 실삭제 0 → 유령 undo 엔트리를 만들지
          // 않도록 실제로 삭제됐을 때만 기록한다(HF Delete 의 charCount 가드와 동형).
          if (res.deletedText) {
            this.executeOperation({ kind: 'record', command: new DeleteTextInFootnoteCommand(target, innerParaIdx, fnOff, res.deletedText, fnOff) });
          }
          this.afterEdit();
        } catch { /* ignore */ }
      }
      return;
    }

    // 기타 키 (문자 입력)는 textarea의 input 이벤트로 처리
    return;
  }

  // ─── F5 블록 선택 모드 진입/해제 ────────────────────────────────
  if (e.key === 'F5') {
    e.preventDefault();
    if (this.cursor.isInCell() && !this.cursor.isInTextBox()) {
      if (this.cursor.isInCellSelectionMode()) {
        this.cursor.advanceCellSelectionPhase();
        this.updateCellSelection();
      } else {
        if (this.cursor.enterCellSelectionMode()) {
          this.caret.hide();
          this.selectionRenderer.clear();
          this.updateCellSelection();
        }
      }
    } else {
      // 본문 블록 선택 모드 (#220)
      if (this.cursor.isInBlockSelectionMode()) {
        this.cursor.exitBlockSelectionMode();
        this.selectionRenderer.clear();
        this.updateCaret();
      } else {
        this.cursor.enterBlockSelectionMode();
        this.updateSelection();
      }
    }
    return;
  }

  // ─── F3 선택 영역 확장 (#220) ──────────────────────────
  if (e.key === 'F3') {
    e.preventDefault();
    if (!this.cursor.isInBlockSelectionMode()) {
      this.cursor.enterBlockSelectionMode();
    }
    this.cursor.expandSelection();
    this.updateSelection();
    return;
  }

  // ─── 그림/글상자 객체 선택 모드 중 키 처리 ──────────────────────────
  if (this.cursor.isInPictureObjectSelection()) {
    // [hwpx-cowork] 한/글 2022 개체 단축키(Shift+PgUp/PgDn 맨 앞/뒤, Shift+Home/End 글 앞/뒤, Alt+Shift+C/V 개체 모양)
    const h2022ObjCmd = objectShortcutCommand(e);
    if (h2022ObjCmd) {
      e.preventDefault();
      this.dispatcher.dispatch(h2022ObjCmd);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cursor.returnToSelectedObjectOwner();
      this.pictureObjectRenderer?.clear();
      this.eventBus.emit('picture-object-selection-changed', false);
      this.updateCaret();
      return;
    }
    // Enter → 글상자 내부 텍스트 편집 진입
    if (e.key === 'Enter') {
      const ref = this.cursor.getSelectedPictureRef();
      if (ref && ref.type === 'shape') {
        e.preventDefault();
        this.cursor.exitPictureObjectSelection();
        this.pictureObjectRenderer?.clear();
        this.eventBus.emit('picture-object-selection-changed', false);
        this.enterTextboxEditing(ref.sec, ref.ppi, ref.ci);
        return;
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:delete');
      return;
    }
    // Ctrl+C/X는 메뉴·컨텍스트 메뉴와 같은 edit command로 실행한다.
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:copy');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:cut');
      return;
    }
    // Ctrl+V → 개체 선택 해제 후 붙여넣기 (paste 이벤트로 처리)
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      this.cursor.moveOutOfSelectedPicture();
      this.pictureObjectRenderer?.clear();
      this.eventBus.emit('picture-object-selection-changed', false);
      // paste 이벤트에서 처리되도록 폴스루 (preventDefault 하지 않음)
      return;
    }
    // 방향키 → 개체 위치 이동, Shift+방향키 → 개체 크기 조절 (#1231 한컴 정합)
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const arrow = e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
      if (e.shiftKey) {
        this.resizeSelectedPicture(arrow);
      } else {
        this.moveSelectedPicture(arrow);
      }
      return;
    }
    // Shift/Ctrl/Alt/Meta 키만 누름 → 무시
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    // [#3682] 개체 선택 상태를 요구하는 커맨드(예: 'P' 개체 속성)를 먼저 시도한다.
    // 아래 폴스루는 선택을 해제하므로, 그 뒤 일반 단축키 경로에 도달할 때는 이미
    // canExecute(inPictureObjectSelection) 가 거짓이 되어 영영 실행되지 않았다
    // — 차트뿐 아니라 그림·도형 공통으로 개체 속성이 열리지 않던 원인.
    {
      const cmdId = matchShortcut(e, defaultShortcuts);
      if (cmdId && this.dispatcher?.isEnabled?.(cmdId)) {
        e.preventDefault();
        this.dispatcher.dispatch(cmdId);
        return;
      }
    }
    // 기타 키 → 개체 선택 해제 후 일반 처리로 폴스루
    this.exitPictureObjectSelectionIfNeeded();
  }

  // ─── 표 객체 선택 모드 중 키 처리 ──────────────────────────
  if (this.cursor.isInTableObjectSelection()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 표 객체 선택 → 표 밖으로 커서 이동
      this.cursor.moveOutOfSelectedTable();
      this.eventBus.emit('table-object-selection-changed', false);
      this.updateCaret();
      // [Task #394] 셀 진입 자동 ON 로직 비활성화 — input-handler.ts 의 코멘트 참고.
      // this.checkTransparentBordersTransition();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // 표 객체 선택 → 셀 편집 복귀
      this.cursor.exitTableObjectSelection();
      this.eventBus.emit('table-object-selection-changed', false);
      this.updateCaret();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:delete');
      return;
    }
    // Ctrl+C/X는 그림 선택과 마찬가지로 canonical edit command를 사용한다.
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:copy');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:cut');
      return;
    }
    // Ctrl+V → 표 선택 해제 후 붙여넣기 (paste 이벤트로 위임)
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      this.cursor.moveOutOfSelectedTable();
      this.eventBus.emit('table-object-selection-changed', false);
      return;
    }
    // 방향키 → 표 위치 이동
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.moveSelectedTable(e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight');
      return;
    }
    // 수정자 키만 누른 경우 무시
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    // 그 외 키 → 표 객체 선택 해제 후 기본 키 처리
    this.cursor.exitTableObjectSelection();
    this.eventBus.emit('table-object-selection-changed', false);
    // fall through
  }

  // ─── 본문 블록 선택 모드 해제 (#220) ──────────────────────
  if (this.cursor.isInBlockSelectionMode() && e.key === 'Escape') {
    e.preventDefault();
    this.cursor.exitBlockSelectionMode();
    this.selectionRenderer.clear();
    this.updateCaret();
    return;
  }

  // ─── 셀 선택 모드 중 키 처리 ────────────────────────────
  if (this.cursor.isInCellSelectionMode()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // F5 셀 선택 모드 → 마지막 선택 셀의 편집 상태
      this.cursor.exitCellSelectionMode();
      this.cellSelectionRenderer?.clear();
      this.updateCaret();
      return;
    }

    // [Task #6741] 되돌리기/다시실행은 블록을 놓지 않고 통과시킨다. 히스토리 점프가
    // 파생 상태를 해제하면(#2339) undo 쪽은 커맨드가 실어 둔 셀 블록으로 다시 세워진다.
    if (dispatchCellBlockGlobalShortcut.call(this, e)) return;

    // [Task #6741] 선택한 칸들의 내용을 한 번에 지우고 블록을 유지한다 — 한컴과 같다.
    // 종전에는 아래 "그 외 키"로 떨어져 블록이 풀리고 캐럿에서 한 글자만 지워졌다.
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!this.cursor.isProtectedCellSelectionMode()) {
        this.clearSelectedCellBlock();
        this.updateCellSelection();
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:delete');
      return;
    }
    const cellArrowAction = getCellSelectionArrowAction(e);
    if (cellArrowAction === 'resize') {
      e.preventDefault();
      const phase = this.cursor.getCellSelectionPhase();
      if (phase === 3) {
        // phase 3: 전체 표 비율 리사이즈 (모든 셀에 동일 delta)
        this.resizeTableProportional(e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight');
      } else {
        // phase 1, 2: 선택 칸/줄 전체 크기 조절
        this.resizeCellByKeyboard(e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight');
      }
      return;
    }
    if (cellArrowAction === 'navigate') {
      e.preventDefault();
      const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const phase = this.cursor.getCellSelectionPhase();
      if (phase === 2) {
        // phase 2: 범위 확장 (anchor 고정, focus만 이동)
        this.cursor.expandCellSelection(dr, dc);
      } else if (phase === 3) {
        // phase 3: 전체 선택 상태에서 방향키 → 무시 (Ctrl+방향키는 위에서 리사이즈 처리)
      } else {
        // phase 1: 단일 셀 이동
        this.cursor.moveCellSelection(dr, dc);
        // 문서 입력 위치는 CursorState가 새 셀로 갱신하지만, F5 셀 선택 중에는
        // 한컴처럼 텍스트 캐럿을 노출하지 않는다.
        this.caret.hide();
      }
      this.updateCellSelection();
      return;
    }
    // M/S 셀 명령은 한글 IME의 Process/물리 code를 보존하기 위해 조기 resolver가 소유한다.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const cmdId = matchShortcut(e, defaultShortcuts);
      if (cmdId === 'edit:format-copy') {
        e.preventDefault();
        this.dispatcher?.dispatch(cmdId);
        return;
      }
    }
    if (this.cursor.isProtectedCellSelectionMode()) {
      e.preventDefault();
      this.textarea.focus();
      return;
    }
    // [hwpx-cowork] 글자·문단 서식 단축키(Ctrl+B, Alt+L, Alt+T …)는 블록을 놓지 않고 블록 칸 전부에
    // 적용한다 — 한컴과 같다. 종전에는 아래 "그 외 키"가 블록을 먼저 풀어 캐럿에만 적용됐다.
    if (dispatchCellBlockFormatShortcut.call(this, e)) return;
    // [hwpx-cowork] Enter = 편집 모드로 전환(블록을 풀고 그 칸에 캐럿). 문단을 나누지 않는다.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.cursor.exitCellSelectionMode();
      this.cellSelectionRenderer?.clear();
      this.updateCaret();
      this.eventBus?.emit?.('command-state-changed');
      return;
    }
    // 수정자 키(Shift/Ctrl/Alt/Meta)만 누른 경우 무시
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return;
    }
    // 그 외 키 → 셀 선택 모드 종료 후 기존 처리로 넘김
    this.cursor.exitCellSelectionMode();
    this.cellSelectionRenderer?.clear();
    this.updateCaret();
    // fall through: 아래 기존 키 처리 계속 진행
  }

  // [hwpx-cowork] 표 칸 안 Alt+방향키 = 셀 단위로 커서 이동(한컴). 표 밖의 Alt+←/→ 억제는 그대로다.
  // macOS 의 Option+←/→ 는 단어 이동(시스템 관례)이라 맥이 아닐 때만 쓴다.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && detectPlatformKind() !== 'mac'
      && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')
      && this.cursor.isInCell() && !(this.cursor.isInTextBox() && this.cursor.nestingDepth() < 2)) {
    e.preventDefault();
    this.cursor.clearSelection();
    const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    this.cursor.moveToAdjacentCell(dr, dc);
    this.updateCaret();
    return;
  }

  if (handleNavigationShortcut.call(this, e)) return;

  // Ctrl/Meta 조합 처리 (Ctrl+Enter, Ctrl+C 등 모두 shortcut-map.ts에서 정의)
  if (e.ctrlKey || e.metaKey) {
    this.handleCtrlKey(e);
    return;
  }

  // Alt 조합 단축키 처리
  // - Alt+Backspace → 이전 단어 삭제 (아래 Backspace/Delete case)
  // - Alt+Delete → 표 안 영역은 'table:delete-row-col' 대화상자,
  //                표 외 영역 영역 다음 단어 삭제 (아래 Backspace/Delete case)
  const isAltWordKey = e.altKey && (
    e.key === 'Backspace' ||
    (e.key === 'Delete' && !this.cursor.isInCell())
  );
  if (e.altKey && !isAltWordKey && this.dispatcher) {
    // Alt+V → Chord 대기 (보기 메뉴 단축키, 한컴 Alt+V,T 계승)
    if ((e.key === 'v' || e.key === 'V' || e.key === 'ㅍ') && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      this._pendingChordV = true;
      return;
    }
    const cmdId = matchShortcut(e, defaultShortcuts);
    if (cmdId) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }

  // ─── Esc: 가장 안쪽 컨테이너부터 escape ──
  //  - 글상자 안 표 셀 → 표 객체 선택 (안 표가 가장 안쪽)
  //  - 글상자 안 (안 표 외 위치) → 글상자 객체 선택
  //  - 본문 표 셀 → 표 객체 선택
  //  한컴 UX 정합 (`feedback_visual_judgment_authority`).
  if (e.key === 'Escape') {
    e.preventDefault();
    const inCell = this.cursor.isInCell();
    const inTextBox = this.cursor.isInTextBox();
    const nestingDepth = this.cursor.nestingDepth();
    // [Task #919] 글상자 안 표 셀 (cellPath.length >= 2 + isTextBox) → 표 객체 선택.
    // enterTableObjectSelection 이 가장 안쪽 셀 (innermost) 의 표를 선택.
    const inNestedTableInTextBox = inTextBox && nestingDepth >= 2;
    if (inNestedTableInTextBox) {
      // 글상자 안 표 → 표 객체 선택 (가장 안쪽)
      const entered = this.cursor.enterTableObjectSelection();
      if (entered) {
        this.caret.hide();
        this.selectionRenderer.clear();
        // event subscriber가 선택 외곽선을 한 번 렌더링한다. 여기서 직접 호출하면
        // 다중 페이지 bbox 조회가 키다운 한 번에 중복 실행된다 (#4252).
        this.eventBus.emit('table-object-selection-changed', true);
      }
    } else if (inTextBox) {
      // 글상자 편집 (안 표 외 영역) → 글상자 객체 선택
      const pos = this.cursor.getPosition();
      const sec = pos.sectionIndex;
      const ppi = pos.parentParaIndex!;
      const ci = pos.controlIndex!;
      // 컨트롤 타입 판별: getPictureProperties 성공 → image, 아니면 shape
      let objType: 'image' | 'shape' = 'shape';
      try { this.wasm.getPictureProperties(sec, ppi, ci); objType = 'image'; } catch { /* shape */ }
      this.cursor.clearSelection();
      this.cursor.enterPictureObjectSelectionDirect(sec, ppi, ci, objType);
      this.caret.hide();
      this.selectionRenderer.clear();
      this.renderPictureObjectSelection();
      this.eventBus.emit('picture-object-selection-changed', true);
    } else if (inCell) {
      // 본문 셀 편집 모드 → 표 객체 선택
      const entered = this.cursor.enterTableObjectSelection();
      if (entered) {
        this.caret.hide();
        this.selectionRenderer.clear();
        // event subscriber가 선택 외곽선을 한 번 렌더링한다 (#4252).
        this.eventBus.emit('table-object-selection-changed', true);
      }
    }
    return;
  }

  // F11은 onF11Intercept(capture)에서 handleF11()로 직접 호출됨

  const pos = this.cursor.getPosition();
  const inCell = this.cursor.isInCell();

  switch (e.key) {
    case 'Backspace':
    case 'Delete': {
      e.preventDefault();
      if (this.isFormMode?.() && e.altKey) return;
      if (this.cursor.hasSelection()) {
        this.deleteSelection();
      } else if (e.altKey) {
        // Alt/Option+Backspace/Delete: 단어 삭제 (macOS standard)
        this.cursor.setAnchor();
        this.cursor.moveToWordBoundary(e.key === 'Backspace' ? -1 : 1);
        if (this.cursor.hasSelection()) this.deleteSelection();
      } else if (e.key === 'Backspace') {
        this.handleBackspace(pos, inCell);
      } else {
        this.handleDelete(pos, inCell);
      }
      break;
    }
    case 'Enter': {
      e.preventDefault();
      if (this.isFormMode?.()) return;
      if (this.cursor.hasSelection()) this.deleteSelection();
      if (e.shiftKey) {
        // Shift+Enter: 강제 줄바꿈 (문단 유지, 줄만 바꿈)
        this.executeOperation({ kind: 'command', command: new InsertLineBreakCommand(this.cursor.getPosition()) });
      } else if (inCell) {
        try {
          // [#4031] 성공한 split은 IMMEDIATE_TEXT_MUTATION_EFFECTS를 선언해
          // executeOperation의 effects 경로가 pending 해소·runner 취소·geometry
          // invalidation(완료 소유)을 수행한다.
          this.executeOperation({ kind: 'command', command: new SplitParagraphInCellCommand(this.cursor.getPosition()) });
        } catch (err) {
          // [#4031] structural command 실패 — 기존 full-flush barrier로 fail-closed 복귀.
          if (committedCellEnterSplit) this.flushDeferredPaginationIfNeeded('cell-enter-split-fallback', false);
          throw err;
        }
      } else {
        this.executeOperation({ kind: 'command', command: new SplitParagraphCommand(this.cursor.getPosition()) });
      }
      break;
    }
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const vertical = this.cursor.isInVerticalCell();
      // 세로쓰기 셀: ↑↓=글자이동(horizontal), ←→=줄이동(vertical)
      // 가로쓰기:    ←→=글자이동(horizontal), ↑↓=줄이동(vertical)
      let moveH: number | null = null;
      let moveV: number | null = null;
      if (e.key === 'ArrowLeft') {
        if (vertical) moveV = -1; else moveH = -1;
      } else if (e.key === 'ArrowRight') {
        if (vertical) moveV = 1; else moveH = 1;
      } else if (e.key === 'ArrowUp') {
        if (vertical) moveH = -1; else moveV = -1;
      } else { // ArrowDown
        if (vertical) moveH = 1; else moveV = 1;
      }
      if (e.shiftKey) {
        this.cursor.setAnchor();
      } else {
        this.cursor.clearSelection();
      }
      if (!e.shiftKey && moveH === 1 && this.tryEnterExitedFieldStart?.()) {
        this.updateCaret();
        break;
      }
      if (!e.shiftKey && moveH === -1 && this.tryEnterExitedFieldEnd?.()) {
        this.updateCaret();
        break;
      }
      if (!e.shiftKey && moveH === -1 && this.tryExitCurrentFieldStart?.()) {
        this.updateCaret();
        break;
      }
      if (!e.shiftKey && moveH === 1 && this.tryExitCurrentFieldEnd?.()) {
        this.updateCaret();
        break;
      }
      if (moveH !== null) this.cursor.moveHorizontal(moveH);
      if (moveV !== null) this.cursor.moveVertical(moveV);
      this.updateCaret();
      if (e.shiftKey) this.updateSelection();
      break;
    }
    case 'Home': {
      e.preventDefault();
      if (e.shiftKey) {
        this.cursor.setAnchor();
        this.cursor.moveToLineStart();
      } else {
        this.cursor.clearSelection();
        this.cursor.moveToLineStart();
      }
      this.markCurrentFieldStartOutside?.();
      this.updateCaret();
      if (e.shiftKey) this.updateSelection();
      break;
    }
    case 'End': {
      e.preventDefault();
      if (e.shiftKey) {
        this.cursor.setAnchor();
        this.cursor.moveToLineEnd();
      } else {
        this.cursor.clearSelection();
        this.cursor.moveToLineEnd();
      }
      this.markCurrentFieldEndOutside?.();
      this.updateCaret();
      if (e.shiftKey) this.updateSelection();
      break;
    }
    case 'Tab': {
      e.preventDefault();
      if (this.isFormMode?.()) {
        this.moveToAdjacentFormField?.(e.shiftKey ? -1 : 1);
        return;
      }
      if (this.cursor.isInCell() && !this.cursor.isInTextBox()) {
        if (e.shiftKey) {
          this.cursor.moveToCellPrev();
        } else if (insertRowAfterLastTableCellByTab.call(this)) {
          // 마지막 셀 Tab은 한컴처럼 새 줄을 자동 추가하고 새 줄 첫 셀로 이동한다.
        } else {
          this.cursor.moveToCellNext();
        }
        this.updateCaret();
        break;
      }
      if (e.shiftKey) {
        this.applyHangingIndentAtCursor();
        break;
      }
      // 탭 문자 삽입 (본문·글상자 공통)
      this.executeOperation({ kind: 'command', command: new InsertTabCommand(this.cursor.getPosition()) });
      break;
    }
    case 'Insert': {
      e.preventDefault();
      this.insertMode = !this.insertMode;
      this.eventBus.emit('insert-mode-changed', this.insertMode);
      break;
    }
    default: {
      // Function 키(F1~F12) 등 Ctrl 없는 단축키 처리
      if (this.dispatcher) {
        const cmdId = matchShortcut(e, defaultShortcuts);
        if (cmdId) {
          // 실행된 키만 삼킨다. modifier 없는 글자 단축키('P' 개체 속성, #3682)는 개체 선택
          // 상태에서만 실행되는데, 무조건 preventDefault 하면 **본문 타이핑의 'p'/'ㅔ' 가
          // 문서에 들어가지 못한다** — canExecute 는 실행을 막을 뿐 키 소비를 막지 못한다.
          // 비활성·차단으로 실행되지 않았으면 키를 그대로 흘려보내 글자로 입력되게 한다.
          const result = this.dispatcher.dispatchWithResult(cmdId);
          if (result.ok || result.reason === 'threw') e.preventDefault();
        }
      }
      break;
    }
  }
}

export function handleCtrlKey(this: any, e: KeyboardEvent): void {
  // Ctrl+/ → 커맨드 팔레트 열기
  if (e.key === '/' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    this.commandPalette?.open();
    return;
  }

  // 커맨드 시스템 경유 단축키 처리
  if (this.dispatcher) {
    const cmdId = matchShortcut(e, defaultShortcuts);
    if (cmdId) {
      e.preventDefault();
      this.dispatcher.dispatch(cmdId);
      return;
    }
  }

  // ─── 코드 단축키 1번째 키 (Ctrl+K / Ctrl+M) ───
  if ((e.key === 'k' || e.key === 'K' || e.key === 'ㅏ') && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    this._pendingChordK = true;
    return;
  }
  // [PR #786 후속] Ctrl+N 영역 영역 Chrome reserved shortcut (새 창) 영역 영역 JS 차단 불가
  // 영역 영역 Ctrl+M 영역 영역 chord 1번째 키 영역 영역 변경.
  if ((e.key === 'm' || e.key === 'M' || e.key === 'ㅡ') && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    this._pendingChordM = true;
    return;
  }
  if ((e.key === 'g' || e.key === 'G' || e.key === 'ㅎ') && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    this._pendingChordG = true;
    return;
  }

  // 커맨드 시스템에 없는 직접 처리 (Ctrl/Cmd+Backspace, Ctrl+Home/End, Ctrl/Cmd+Arrow 등)
  switch (e.key.toLowerCase()) {
    case 'backspace': {
      e.preventDefault();
      if (this.isFormMode?.()) return;
      if (this.cursor.hasSelection()) {
        this.deleteSelection();
      } else if (e.metaKey && !e.ctrlKey) {
        // Cmd+Backspace (macOS): 줄 시작까지 삭제
        this.cursor.setAnchor();
        this.cursor.moveToLineStart();
        if (this.cursor.hasSelection()) this.deleteSelection();
      } else {
        // Ctrl+Backspace (Win/Linux): 이전 단어 경계까지 삭제
        this.cursor.setAnchor();
        this.cursor.moveToWordBoundary(-1);
        if (this.cursor.hasSelection()) this.deleteSelection();
      }
      break;
    }
    case 'delete': {
      if (!e.ctrlKey) break;
      e.preventDefault();
      if (this.isFormMode?.()) return;
      if (this.cursor.hasSelection()) {
        this.deleteSelection();
      } else {
        // Ctrl+Delete (Win/Linux): 다음 단어 경계까지 삭제
        this.cursor.setAnchor();
        this.cursor.moveToWordBoundary(1);
        if (this.cursor.hasSelection()) this.deleteSelection();
      }
      break;
    }
    case 'home': {
      e.preventDefault();
      if (e.shiftKey) {
        this.cursor.setAnchor();
        this.cursor.moveToDocumentStart();
      } else {
        this.cursor.clearSelection();
        this.cursor.moveToDocumentStart();
      }
      this.updateCaret();
      snapViewToDocumentEdge.call(this, -1);
      break;
    }
    case 'end': {
      e.preventDefault();
      if (e.shiftKey) {
        this.cursor.setAnchor();
        this.cursor.moveToDocumentEnd();
      } else {
        this.cursor.clearSelection();
        this.cursor.moveToDocumentEnd();
      }
      this.updateCaret();
      snapViewToDocumentEdge.call(this, 1);
      break;
    }
    case 'arrowleft': {
      e.preventDefault();
      if (e.shiftKey) this.cursor.setAnchor();
      else this.cursor.clearSelection();
      this.cursor.moveToLineStart();
      this.updateCaret();
      break;
    }
    case 'arrowright': {
      e.preventDefault();
      if (e.shiftKey) this.cursor.setAnchor();
      else this.cursor.clearSelection();
      this.cursor.moveToLineEnd();
      this.updateCaret();
      break;
    }
    case 'arrowup': {
      e.preventDefault();
      if (e.shiftKey) this.cursor.setAnchor();
      else this.cursor.clearSelection();
      // [Issue #784 후속] macOS Cmd+↑ = 문서 시작 (macOS 표준).
      // Windows/Linux Ctrl+↑ = 이전 문단 (한컴 표준).
      if (e.metaKey && !e.ctrlKey) {
        this.cursor.moveToDocumentStart();
      } else {
        this.cursor.moveToParagraphBoundary(-1);
      }
      this.updateCaret();
      break;
    }
    case 'arrowdown': {
      e.preventDefault();
      if (e.shiftKey) this.cursor.setAnchor();
      else this.cursor.clearSelection();
      // [Issue #784 후속] macOS Cmd+↓ = 문서 끝 (macOS 표준).
      // Windows/Linux Ctrl+↓ = 다음 문단 (한컴 표준).
      if (e.metaKey && !e.ctrlKey) {
        this.cursor.moveToDocumentEnd();
      } else {
        this.cursor.moveToParagraphBoundary(1);
      }
      this.updateCaret();
      break;
    }
    // 그 외 Ctrl 조합 (줌 등)은 브라우저 기본 동작 허용
  }
}

export function handleSelectAll(this: any): void {
  // ⌘A는 선택 범위만 바꾼다. 캐럿이 범위 끝(문서·셀 끝)으로 가더라도 화면을 그쪽으로
  // 스크롤하지 않는다 — 보던 위치가 문서 맨 아래로 튀는 결함을 막는다.
  if (this.cursor.isInHeaderFooter()) {
    this.cursor.selectAllInHeaderFooter();
    this.updateCaret(true);
    return;
  }

  // 한컴 정합: 셀 블록(F5) 상태의 ⌘A 는 블록을 풀고 캐럿이 있는 셀 내용만 선택한다.
  // 키 경로는 셀 선택 분기의 fallthrough 가 블록을 먼저 해제하지만, 메뉴 등 다른
  // 경로로 들어와도 여기서 블록을 풀어 셀 선택이 되도록 방어적으로 처리한다.
  if (this.cursor.isInCellSelectionMode()) {
    this.cursor.exitCellSelectionMode();
    this.cellSelectionRenderer?.clear();
  }
  // 셀·글상자 안의 ⌘A 는 그 컨테이너 내용만 선택한다 (본문 전체가 아니다).
  if (this.cursor.isInCell()) {
    if (this.cursor.selectAllInCell()) {
      this.updateCaret(true);
      return;
    }
  }

  // anchor를 문서 시작, focus를 문서 끝으로 설정
  // (기존 부분 선택의 anchor가 남지 않도록 먼저 비운다)
  this.cursor.clearSelection();
  this.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  this.cursor.setAnchor();
  this.cursor.moveToDocumentEnd();
  this.updateCaret(true);
}

function copyHeaderFooterSelection(this: any, e: ClipboardEvent): boolean {
  const selection = this.getNonEmptyHeaderFooterSelection();
  if (!selection) return false;
  e.preventDefault();
  if (!e.clipboardData) return false;
  try {
    const result = this.wasm.copySelectionInHeaderFooter(
      selection.start.sectionIdx,
      selection.start.isHeader,
      selection.start.applyTo,
      selection.start.paraIdx,
      selection.start.charOffset,
      selection.end.paraIdx,
      selection.end.charOffset,
    );
    if (result.ok !== true) return false;
    e.clipboardData.setData('text/plain', result.text);
    e.clipboardData.setData(
      'text/html',
      prepareRhwpInternalClipboardHtml(this, '', result.text),
    );
    return true;
  } catch (err) {
    console.warn('[InputHandler] HF 선택 복사 실패:', err);
    return false;
  }
}

export function onCopy(this: any, e: ClipboardEvent): boolean {
  if (!this.active) return false;

  if (this.cursor.isInHeaderFooter() && this.getNonEmptyHeaderFooterSelection()) {
    return copyHeaderFooterSelection.call(this, e);
  }

  // 개체(글상자/그림) 선택 모드 → 개체 복사
  if (this.cursor.isInPictureObjectSelection()) {
    const ref = this.cursor.getSelectedPictureRef();
    if (ref) {
      e.preventDefault();
      if (!e.clipboardData) return false;
      try {
        const cellPathJson = pictureCellPathJson(ref);
        const result = this.wasm.copyControl(ref.sec, ref.ppi, ref.ci, cellPathJson);
        if (JSON.parse(result).ok !== true) return false;
        const text = this.wasm.getClipboardText() || '[그림]';
        let html = '';
        try { html = this.wasm.exportControlHtml(ref.sec, ref.ppi, ref.ci, cellPathJson) || ''; } catch { /* HTML 내보내기 실패는 fallback */ }
        const markedHtml = prepareRhwpInternalClipboardHtml(this, html, text);
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', markedHtml);
        // 이미지 컨트롤이면 image/png Blob 포함 클립보드 기록
        if (ref.type === 'image') {
          writeImageToClipboard(this.wasm, ref.sec, ref.ppi, ref.ci, text, markedHtml, cellPathJson)
            .catch(() => {});
        }
        return true;
      } catch (err) {
        console.warn('[InputHandler] 개체 복사 실패:', err);
      }
    }
    return false;
  }

  if (!this.cursor.hasSelection()) return false;
  e.preventDefault();
  if (!e.clipboardData) return false;

  const sel = this.cursor.getSelectionOrdered();
  if (!sel) return false;
  const { start, end } = sel;

  try {
    // WASM 내부 클립보드에 복사 (서식 보존)
    let result: string;
    if (isNestedCellPosition(start)) {
      result = this.wasm.copySelectionInCellByPath(
        start.sectionIndex, start.parentParaIndex!, JSON.stringify(start.cellPath),
        cellParaIndexOf(start), start.charOffset,
        cellParaIndexOf(end), end.charOffset,
      );
    } else if (start.parentParaIndex !== undefined) {
      result = this.wasm.copySelectionInCell(
        start.sectionIndex, start.parentParaIndex, start.controlIndex!, start.cellIndex!,
        start.cellParaIndex!, start.charOffset,
        end.cellParaIndex!, end.charOffset,
      );
    } else if (start.sectionIndex !== end.sectionIndex) {
      // [hwpx-cowork] 구역을 넘는 복사 — 넘는 구역 나누기를 싣는다(docs/SECTIONS.md)
      result = this.wasm.copySelectionAcross(
        start.sectionIndex, start.paragraphIndex, start.charOffset,
        end.sectionIndex, end.paragraphIndex, end.charOffset,
      );
    } else {
      result = this.wasm.copySelection(
        start.sectionIndex,
        start.paragraphIndex, start.charOffset,
        end.paragraphIndex, end.charOffset,
      );
    }
    if (JSON.parse(result).ok !== true) return false;

    // 시스템 클립보드에 플레인 텍스트 + HTML 설정
    const text = this.wasm.getClipboardText();
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      // HTML 내보내기 (표/서식 보존)
      let html = '';
      try {
        if (isNestedCellPosition(start)) {
          html = this.wasm.exportSelectionInCellHtmlByPath(
            start.sectionIndex, start.parentParaIndex!, JSON.stringify(start.cellPath),
            cellParaIndexOf(start), start.charOffset,
            cellParaIndexOf(end), end.charOffset,
          );
        } else if (start.parentParaIndex !== undefined) {
          html = this.wasm.exportSelectionInCellHtml(
            start.sectionIndex, start.parentParaIndex, start.controlIndex!, start.cellIndex!,
            start.cellParaIndex!, start.charOffset,
            end.cellParaIndex!, end.charOffset,
          );
        } else {
          html = exportBodySelectionHtml(this.wasm, start, end);
        }
      } catch { /* HTML 내보내기 실패는 fallback HTML 사용 */ }
      const markedHtml = prepareRhwpInternalClipboardHtml(this, html, text);
      e.clipboardData.setData('text/html', markedHtml);
    }
    return true;
  } catch (err) {
    console.warn('[InputHandler] 복사 실패:', err);
    return false;
  }
}

/**
 * [hwpx-cowork] 본문 선택의 클립보드 HTML. 엔진 HTML 내보내기는 한 구역 안 범위만 받으므로 구역을 넘으면 구역마다 내보내
 * 몸통을 잇는다(문서 HTML 내보내기 collectDocumentHtml 과 같은 방식).
 */
function exportBodySelectionHtml(wasm: WasmBridge, start: DocumentPosition, end: DocumentPosition): string {
  if (start.sectionIndex === end.sectionIndex) {
    return wasm.exportSelectionHtml(start.sectionIndex, start.paragraphIndex, start.charOffset, end.paragraphIndex, end.charOffset);
  }
  const parts: string[] = [];
  for (let s = start.sectionIndex; s <= end.sectionIndex; s++) {
    const lastPara = wasm.getParagraphCount(s) - 1;
    if (lastPara < 0) continue;
    const fromPara = s === start.sectionIndex ? start.paragraphIndex : 0;
    const fromOff = s === start.sectionIndex ? start.charOffset : 0;
    const toPara = s === end.sectionIndex ? end.paragraphIndex : lastPara;
    const toOff = s === end.sectionIndex ? end.charOffset : wasm.getParagraphLength(s, lastPara);
    const inner = unwrapEngineHtmlFragment(wasm.exportSelectionHtml(s, fromPara, fromOff, toPara, toOff) ?? '');
    if (inner) parts.push(inner);
  }
  return `<html><body>\n<!--StartFragment-->\n${parts.join('\n')}\n<!--EndFragment-->\n</body></html>`;
}

export function onCut(this: any, e: ClipboardEvent): void {
  if (!this.active) return;
  if (this.cursor.hasSelection() && this.canDeleteSelectionInFormMode?.() === false) {
    e.preventDefault();
    return;
  }
  if (this.isFormMode?.()) {
    e.preventDefault();
    return;
  }

  if (this.cursor.isInHeaderFooter() && this.getNonEmptyHeaderFooterSelection()) {
    if (copyHeaderFooterSelection.call(this, e)) this.deleteSelection();
    return;
  }

  // 개체 선택 모드 → 개체 잘라내기 (복사 후 삭제)
  if (this.cursor.isInPictureObjectSelection()) {
    const ref = this.cursor.getSelectedPictureRef();
    if (ref) {
      if (!this.onCopy(e)) return;
      this.cursor.moveOutOfSelectedPicture();
      this.pictureObjectRenderer?.clear();
      this.executeOperation({ kind: 'snapshot', operationType: 'cutObject', operation: (wasm: WasmBridge) => {
        deleteSelectedObject(wasm, ref);
        return this.cursor.getPosition();
      }});
      // 알림 수신자가 문서를 교체할 수 있으므로 복사한 문서의 삭제를 먼저 끝낸다.
      this.eventBus.emit('picture-object-selection-changed', false);
    }
    return;
  }

  if (!this.cursor.hasSelection()) return;
  // 복사 실패로 원문을 잃지 않도록 이번 클립보드 기록이 끝난 뒤에만 지운다.
  if (this.onCopy(e)) this.deleteSelection();
}



export function onPaste(this: any, e: ClipboardEvent): void {
  if (!this.active) return;
  e.preventDefault();
  if (this.cursor.hasSelection() && this.canDeleteSelectionInFormMode?.() === false) return;
  if (this.isFormMode?.()) return;

  // 개체/표 선택 모드 해제 후 붙여넣기 진행
  if (this.cursor.isInPictureObjectSelection()) {
    this.cursor.moveOutOfSelectedPicture();
    this.pictureObjectRenderer?.clear();
    this.eventBus.emit('picture-object-selection-changed', false);
  }
  if (this.cursor.isInTableObjectSelection()) {
    this.cursor.moveOutOfSelectedTable();
    this.eventBus.emit('table-object-selection-changed', false);
  }

  // 선택 영역 삭제 여부 캡처 (스냅샷 내부에서 처리)
  const hasSelection = this.cursor.hasSelection();

  const pos = this.cursor.getPosition();
  const clipboardData = e.clipboardData;
  const html = clipboardData?.getData('text/html') || '';
  const text = clipboardData?.getData('text/plain') || '';
  const rtf = clipboardData?.getData('text/rtf') || '';
  // HF는 이번 이슈에서 rich clipboard round-trip을 만들지 않는다. 내부 marker/HTML이
  // 있어도 시스템 plain text를 코어의 원자 범위 primitive로 삽입·치환한다.
  if (this.cursor.isInHeaderFooter()) {
    if (text) {
      this.replaceHeaderFooterSelection(text, {
        operationType: 'pastePlainTextInHeaderFooter',
        allowCollapsed: true,
      });
    }
    return;
  }
  const hasCurrentInternalMarker = hasCurrentRhwpClipboardMarker(this, html);
  let portable: Uint8Array | null;
  try { portable = readPortableClipboard(html); }
  catch {
    showToast({ message: '복사 원본을 읽지 못했습니다. 다시 복사해 주세요.', durationMs: 5000 });
    return;
  }
  if (portable) {
    pasteDocumentFragment.call(this, portable, hasSelection);
    return;
  }
  const useInternalClipboard =
    this.wasm.hasInternalClipboard() &&
    (!clipboardData || hasCurrentInternalMarker);

  // [hwpx-cowork] Only a matching unique marker authorizes this editor's
  // in-memory clipboard. Text such as '[그림]' does not identify its source.
  if (useInternalClipboard) {
    // 컨트롤(개체) 붙여넣기 — 본문에서만 허용
    if (this.wasm.clipboardHasControl() && pos.parentParaIndex === undefined) {
      this.executeOperation({ kind: 'snapshot', operationType: 'pasteControl', operation: (wasm: WasmBridge) => {
        if (hasSelection) this.deleteSelection({ deferRecord: true });
        const p = this.cursor.getPosition();
        const result = wasm.pasteControl(p.sectionIndex, p.paragraphIndex, p.charOffset);
        const parsed = JSON.parse(result);
        if (parsed.ok) {
          const newParaIdx = (parsed.paraIdx ?? p.paragraphIndex) + 1;
          return {
            sectionIndex: p.sectionIndex,
            paragraphIndex: newParaIdx,
            charOffset: 0,
          } as DocumentPosition;
        }
        return p;
      }});
      return;
    }

    // 내부 클립보드 텍스트 붙여넣기 (서식 보존)
    this.executeOperation({ kind: 'snapshot', operationType: 'pasteInternal', operation: (wasm: WasmBridge) => {
      this.pastedFieldEndOutsidePending = false;
      if (hasSelection) this.deleteSelection({ deferRecord: true });
      const p = this.cursor.getPosition();
      let result: string;
      if (isNestedCellPosition(p)) {
        result = wasm.pasteInternalInCellByPath(
          p.sectionIndex, p.parentParaIndex!, JSON.stringify(p.cellPath), p.charOffset,
        );
      } else if (p.parentParaIndex !== undefined) {
        result = wasm.pasteInternalInCell(
          p.sectionIndex, p.parentParaIndex, p.controlIndex!,
          p.cellIndex!, p.cellParaIndex!, p.charOffset,
        );
      } else {
        result = wasm.pasteInternal(p.sectionIndex, p.paragraphIndex, p.charOffset);
      }
      const parsed = JSON.parse(result);
      if (parsed.ok) {
        if (parsed.containsField === true) {
          this.pastedFieldEndOutsidePending = true;
        }
        return positionAfterPasteResult(p, parsed);
      }
      return p;
    }});
    return;
  }

  // [hwpx-cowork] HWP offers preview images alongside the actual document.
  // Read its structure before considering those images or generic HTML.
  const model = extractHwpJsonModel(html);
  if (model || /hancom|hwp/i.test(html)) {
    const position = JSON.stringify([this.cursor.getPosition(), this.cursor.getSelectionOrdered()]);
    const generation = this.wasm.documentGeneration;
    let changed = false;
    const stop = this.eventBus.on('document-changed', () => { changed = true; });
    void (async () => {
      let native: Uint8Array | null = null;
      try { native = await readHancomNativeClipboard(text, model); } catch { /* use embedded HWP model */ }
      stop();
      if (changed || this.wasm.documentGeneration !== generation ||
          position !== JSON.stringify([this.cursor.getPosition(), this.cursor.getSelectionOrdered()])) return;
      if (native && pasteDocumentFragment.call(this, native, hasSelection, false)) return;
      if (model && pasteHwpJsonModel.call(this, model, hasSelection)) return;
      if (model) {
        showToast({ message: '한글 원본 구조를 읽지 못했습니다. 원본 문서를 HWPX로 열어 복사해 주세요.', durationMs: 6000 });
        return;
      }
      let fallback = html;
      if (needsRtfImageInlining(html, rtf)) {
        try { fallback = await inlineOfficeClipboardImages(html, rtf); } catch { /* ordinary HTML fallback */ }
      }
      pasteExternalHtml.call(this, liftImagesToBlockLevel(fallback), text, hasSelection);
    })();
    return;
  }

  // 외부 클립보드: 이미지 파일이 있으면 그림으로 삽입
  const items = clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pasteImageFile.call(this, file, hasSelection);
          return;
        }
      }
    }
  }

  // 외부 클립보드: HTML이 있으면 pasteHtml로 표/서식 보존 붙여넣기
  if (html) {
    // Hancom document models were handled above, before image previews.
    // 한글은 그림을 HTML 에 file:/// 로만 적고 실제 픽셀은 같은 클립보드의
    // text/rtf 안에 둔다. 그 경우에만 RTF 에서 그림을 꺼내 data URI 로 채운 뒤 붙여넣는다.
    if (needsRtfImageInlining(html, rtf)) {
      void (async () => {
        let merged = html;
        try {
          merged = await inlineOfficeClipboardImages(html, rtf);
        } catch (error) {
          console.warn('[paste] RTF 그림 삽입 실패 — 그림 없이 붙여넣기:', error);
        }
        pasteExternalHtml.call(this, merged, text, hasSelection);
      })();
      return;
    }
    pasteExternalHtml.call(this, liftImagesToBlockLevel(html), text, hasSelection);
    return;
  }

  // 플레인 텍스트 붙여넣기 (fallback — 기존 InsertTextCommand 사용, 정밀 undo 유지)
  pastePlainText.call(this, text, hasSelection);
}


// [hwpx-cowork] All structural paste runs in one undoable snapshot. A failed
// import throws, so snapshot rollback also restores a replaced selection.
function fragmentTarget(p: DocumentPosition): { para: number; path: string } {
  const path = p.cellPath?.length ? p.cellPath : p.parentParaIndex !== undefined ? [{
    controlIndex: p.controlIndex!, cellIndex: p.cellIndex!, cellParaIndex: p.cellParaIndex!,
  }] : [];
  return { para: p.parentParaIndex ?? p.paragraphIndex, path: JSON.stringify(path) };
}

function pasteDocumentFragment(this: any, bytes: Uint8Array, hasSelection: boolean, reportFailure = true): boolean {
  let applied = false;
  try {
    this.executeOperation({ kind: 'snapshot', operationType: 'pasteDocumentFragment', operation: (wasm: WasmBridge) => {
      if (hasSelection) this.deleteSelection({ deferRecord: true });
      const p = this.cursor.getPosition();
      const target = fragmentTarget(p);
      const result = JSON.parse(wasm.pasteDocumentFragment(p.sectionIndex, target.para, target.path, p.charOffset, bytes));
      if (!result.ok) throw new Error(result.error || '붙여넣기 실패');
      applied = true;
      return positionAfterPasteResult(p, result);
    }});
    return applied;
  } catch (error) {
    console.warn('[paste] 원본 문서 구조 붙여넣기 실패:', error);
    if (reportFailure) showToast({ message: '표·그림·조판 부호의 원본을 붙여넣지 못했습니다. 다시 복사해 주세요.', durationMs: 5000 });
    return false;
  }
}


/**
 * 한글 클립보드 HTML 에서 문서 모델 JSON 을 꺼낸다.
 *
 * 형태는 `<!--[data-hwpjson]{ … }-->` 이고, 주석 안이 통째로 JSON 이다.
 * 없으면 한글이 아닌 곳(워드·엑셀·브라우저)에서 온 것이므로 null 을 준다.
 */
export function extractHwpJsonModel(html: string): string | null {
  const marker = html.indexOf('[data-hwpjson]');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  const end = html.indexOf('-->', start);
  const raw = (end < 0 ? html.slice(start) : html.slice(start, end)).trim();
  if (raw.length < 2 || raw[0] !== '{') return null;
  return raw;
}

/**
 * 문서 모델 붙여넣기. 코어가 이 경로를 못 다루면 false 를 돌려
 * 호출한 쪽이 종전 HTML 경로로 되돌아가게 한다.
 */
function pasteHwpJsonModel(this: any, model: string, hasSelection: boolean): boolean {
  let ok = false;
  try {
    this.executeOperation({
      kind: 'snapshot',
      operationType: 'pasteHwpJson',
      operation: (wasm: WasmBridge) => {
        const p = this.cursor.getPosition();
        if (hasSelection) this.deleteSelection({ deferRecord: true });
        const target = fragmentTarget(this.cursor.getPosition());
        const at = this.cursor.getPosition();
        const result = wasm.pasteHwpJsonFragment(at.sectionIndex, target.para, target.path, at.charOffset, model);
        console.debug('[paste] pasteHwpJson 결과:', String(result).slice(0, 200));
        const parsed = JSON.parse(result);
        if (!parsed.ok) throw new Error(parsed.error || '한글 모델 붙여넣기 실패');
        ok = true;
        return positionAfterPasteResult(at, parsed);
      },
    });
  } catch (error) {
    console.warn('[paste] 문서모델 붙여넣기 실패 — HTML 경로로 되돌아감:', error);
    return false;
  }
  if (!ok) console.debug('[paste] 문서모델 경로 미적용 — HTML 경로로 되돌아감');
  return ok;
}

/** jb: 외부 HTML 붙여넣기 본체 — 코어 정리 → pasteHtml → 실패 시 text/plain 폴백. */
function pasteExternalHtml(this: any, html: string, text: string, hasSelection: boolean): void {
  const htmlForCore = sanitizeOfficeHtmlForCore(html);
  console.debug(`[paste] HTML 붙여넣기 시작: 원본 ${html.length}자 → 정리 ${htmlForCore.length}자, img ${(htmlForCore.match(/<img\b/gi) ?? []).length}개`);
  let htmlPasted = false;
  let selectionConsumed = false;
  try {
    this.executeOperation({ kind: 'snapshot', operationType: 'pasteHtml', operation: (wasm: WasmBridge) => {
      if (hasSelection) {
        this.deleteSelection({ deferRecord: true });
        selectionConsumed = true;
      }
      const p = this.cursor.getPosition();
      let result: string;
      if (isNestedCellPosition(p)) {
        result = wasm.pasteHtmlInCellByPath(
          p.sectionIndex, p.parentParaIndex!, JSON.stringify(p.cellPath), p.charOffset, htmlForCore,
        );
      } else if (p.parentParaIndex !== undefined) {
        result = wasm.pasteHtmlInCell(
          p.sectionIndex, p.parentParaIndex, p.controlIndex!,
          p.cellIndex!, p.cellParaIndex!, p.charOffset, htmlForCore,
        );
      } else {
        result = wasm.pasteHtml(p.sectionIndex, p.paragraphIndex, p.charOffset, htmlForCore);
      }
      const parsed = JSON.parse(result);
      console.debug('[paste] pasteHtml 결과:', String(result).slice(0, 200));
      if (parsed.ok) {
        htmlPasted = true;
        return positionAfterPasteResult(p, parsed);
      }
      console.warn('[paste] HTML 가져오기 거절(ok=false) — 텍스트로 폴백:', parsed.error ?? parsed);
      return p;
    }});
  } catch (error) {
    console.warn('[paste] HTML 붙여넣기 실패 — 텍스트로 폴백:', error);
  }
  if (!htmlPasted && text) {
    pastePlainText.call(this, text, hasSelection && !selectionConsumed);
  }
}

/** 클립보드의 이미지 파일을 커서 위치에 삽입한다. */
async function pasteImageFile(this: any, file: File, hasSelection: boolean): Promise<void> {
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');

    // 이미지 크기 측정
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      img.src = url;
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }

    // px → HWPUNIT (1px = 75 HWPUNIT at 96 DPI)
    let wHwp = Math.round(img.naturalWidth * 75);
    let hHwp = Math.round(img.naturalHeight * 75);

    // 열 폭 초과 시 비례 축소
    const pos = this.cursor.getPosition();
    try {
      const pageDef = this.wasm.getPageDef(pos.sectionIndex);
      const colWidth = pageDef.width - pageDef.marginLeft - pageDef.marginRight;
      if (wHwp > colWidth) {
        const ratio = colWidth / wHwp;
        wHwp = Math.round(colWidth);
        hHwp = Math.round(hHwp * ratio);
      }
    } catch { /* 페이지 정보 없으면 그대로 */ }

    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    // 스냅샷으로 삽입 (Undo 지원)
    this.executeOperation({ kind: 'snapshot', operationType: 'pasteImage', operation: (wasm: WasmBridge) => {
      if (hasSelection) this.deleteSelection();
      const p = this.cursor.getPosition();
      // 표 셀 안 paste (#1151): floating picture 분기 — parentParaIndex + cellPath 전달.
      const inCell = (p.cellPath?.length ?? 0) > 0 && p.parentParaIndex !== undefined;
      const paraForCall = inCell ? p.parentParaIndex! : p.paragraphIndex;
      const cellPathJson = inCell ? JSON.stringify(p.cellPath) : '';
      const result = wasm.insertPicture(
        p.sectionIndex, paraForCall, p.charOffset,
        cellPathJson, data, wHwp, hHwp, natW, natH, ext, '',
      );
      if (result.ok) {
        return {
          sectionIndex: p.sectionIndex,
          paragraphIndex: result.paraIdx + 1,
          charOffset: 0,
        } as DocumentPosition;
      }
      return p;
    }});
  } catch (err) {
    console.warn('[InputHandler] 클립보드 이미지 삽입 실패:', err);
  }
}

/** 기존 컨트롤 선택 상태를 모두 해제한다 */
function clearAllControlSelection(self: any): void {
  if (self.cursor.isInTableObjectSelection()) {
    self.cursor.exitTableObjectSelection();
    self.tableObjectRenderer?.clear();
  }
  if (self.cursor.isInPictureObjectSelection()) {
    self.cursor.exitPictureObjectSelection();
    self.pictureObjectRenderer?.clear();
  }
  if (self.cursor.hasSelection()) {
    self.cursor.clearSelection();
  }
}

/** F11: 이전 방향 가장 가까운 컨트롤 선택 */
export function handleF11(this: any): void {
  try {
    // 현재 선택 상태에 따라 검색 시작점 결정
    // - 필드 텍스트 선택 중: anchor(선택 시작점)에서 검색 → 같은 필드 재선택 방지
    // - 표/그림 객체 선택 중: 선택된 컨트롤 위치에서 검색
    // - 그 외: 현재 커서 위치
    let searchSec: number, searchPara: number, searchCharOffset: number;

    if (this.cursor.isInTableObjectSelection()) {
      const ref = this.cursor.getSelectedTableRef();
      searchSec = ref!.sec; searchPara = ref!.ppi; searchCharOffset = 0;
    } else if (this.cursor.isInPictureObjectSelection()) {
      const ref = this.cursor.getSelectedPictureRef();
      searchSec = ref!.sec; searchPara = ref!.ppi;
      // 선택된 도형의 텍스트 위치를 검색 시작점으로 사용
      const ctrlPositions = this.wasm.getControlTextPositions?.(ref!.sec, ref!.ppi);
      searchCharOffset = ctrlPositions?.[ref!.ci] ?? 0;
    } else if (this.cursor.hasSelection()) {
      const sel = this.cursor.getSelection()!;
      searchSec = sel.anchor.sectionIndex;
      searchPara = sel.anchor.paragraphIndex;
      searchCharOffset = sel.anchor.charOffset;
    } else {
      const pos = this.cursor.getPosition();
      searchSec = pos.sectionIndex; searchPara = pos.paragraphIndex; searchCharOffset = pos.charOffset;
    }

    const result = this.wasm.findNearestControlBackward(searchSec, searchPara, searchCharOffset);

    if (result.type === 'none') {
      // 더 이상 이전 컨트롤 없음 → 현재 선택 해제
      // 선택 해제 후 커서를 원래 검색 위치에 두어 다시 F11 시 재선택 가능
      const hadSelection = this.cursor.isInTableObjectSelection()
        || this.cursor.isInPictureObjectSelection()
        || this.cursor.hasSelection();
      clearAllControlSelection(this);
      if (hadSelection) {
        // 커서를 검색 시작 위치의 다음 문단으로 이동 (컨트롤 문단 다음)
        const paraCount = this.wasm.getParagraphCount(searchSec);
        const nextPara = Math.min(searchPara + 1, paraCount - 1);
        try { this.cursor.moveTo({ sectionIndex: searchSec, paragraphIndex: nextPara, charOffset: 0 }); } catch {}
      }
      this.updateCaret();
      return;
    }

    // 새 컨트롤 선택 전 기존 선택 모두 해제
    clearAllControlSelection(this);

    if (result.type === 'table') {
      // 표 전용 문단은 커서를 놓을 수 없으므로 표 다음 문단으로 커서 이동
      const paraCount = this.wasm.getParagraphCount(result.sec);
      const cursorPara = Math.min(result.para + 1, paraCount - 1);
      try { this.cursor.moveTo({ sectionIndex: result.sec, paragraphIndex: cursorPara, charOffset: 0 }); } catch {}
      this.cursor.enterTableObjectSelectionDirect(result.sec, result.para, result.ci);
      this.updateCaret();
      this.renderTableObjectSelection();
    } else if (result.type === 'shape' || result.type === 'picture' || result.type === 'equation') {
      // 개체 문단도 커서 위치 오류 가능 → try/catch
      try { this.cursor.moveTo({ sectionIndex: result.sec, paragraphIndex: result.para, charOffset: 0 }); } catch {}
      // 도형 타입 세분화: 직선은 'line' (2점 핸들용)
      let ctrlType: string = result.type === 'picture' ? 'image'
        : result.type === 'equation' ? 'equation'
        : 'shape';
      if (ctrlType === 'shape') {
        // getPageControlLayout에서 line 타입 확인
        try {
          const pageCount = this.wasm.pageCount;
          for (let p = 0; p < pageCount; p++) {
            const layout = { controls: this.wasm.getPageControlLayout(p).controls.filter(isBodyControl) };
            for (const ctrl of layout.controls) {
              if (ctrl.type === 'line' && ctrl.secIdx === result.sec && ctrl.paraIdx === result.para && ctrl.controlIdx === result.ci) {
                ctrlType = 'line';
                break;
              }
            }
            if (ctrlType === 'line') break;
          }
        } catch { /* ignore */ }
      }
      this.cursor.enterPictureObjectSelectionDirect(
        result.sec, result.para, result.ci, ctrlType as any,
      );
      this.updateCaret();
      this.renderPictureObjectSelection();
    } else if (result.type === 'bookmark') {
      // 책갈피: 해당 위치로 커서 이동
      const charPos = result.charPos ?? 0;
      try { this.cursor.moveTo({ sectionIndex: result.sec, paragraphIndex: result.para, charOffset: charPos }); } catch {}
      this.updateCaret();
      // 책갈피 대화상자를 열어 수정/삭제 가능하게
      this.dispatcher?.dispatch('insert:bookmark');
    } else if (result.type === 'field') {
      // 누름틀: 필드 텍스트 블록 선택 (charPos = 필드의 텍스트 내 위치)
      const fieldPos = { sectionIndex: result.sec, paragraphIndex: result.para, charOffset: result.charPos ?? 0 };
      const fi = this.wasm.getFieldInfoAt(fieldPos);
      if (fi.inField && fi.startCharIdx !== undefined && fi.endCharIdx !== undefined) {
        const startPos = { sectionIndex: result.sec, paragraphIndex: result.para, charOffset: fi.startCharIdx };
        const endPos = { sectionIndex: result.sec, paragraphIndex: result.para, charOffset: fi.endCharIdx };
        // anchor를 끝에, focus(커서)를 시작에 → 캐럿이 입력시작위치에 표시
        this.cursor.moveTo(endPos);
        this.cursor.setAnchor();
        this.cursor.moveTo(startPos);
        this.updateCaret();
        this.eventBus.emit('field-info-changed', {
          fieldId: fi.fieldId, fieldType: fi.fieldType, guideName: fi.guideName,
        });
      }
    }
  } catch (err) {
    console.warn('[F11] error:', err);
  }
}

/** Shift+F11: 순방향(→) 가장 가까운 컨트롤 선택 */
export function handleShiftF11(this: any): void {
  try {
    let searchSec: number, searchPara: number, searchCharOffset: number;

    if (this.cursor.isInTableObjectSelection()) {
      const ref = this.cursor.getSelectedTableRef();
      searchSec = ref!.sec; searchPara = ref!.ppi;
      const ctrlPositions = this.wasm.getControlTextPositions?.(ref!.sec, ref!.ppi);
      searchCharOffset = ctrlPositions?.[ref!.ci] ?? 0;
    } else if (this.cursor.isInPictureObjectSelection()) {
      const ref = this.cursor.getSelectedPictureRef();
      searchSec = ref!.sec; searchPara = ref!.ppi;
      const ctrlPositions = this.wasm.getControlTextPositions?.(ref!.sec, ref!.ppi);
      searchCharOffset = ctrlPositions?.[ref!.ci] ?? 0;
    } else {
      const pos = this.cursor.getPosition();
      searchSec = pos.sectionIndex; searchPara = pos.paragraphIndex; searchCharOffset = pos.charOffset;
    }

    const result = this.wasm.findNearestControlForward(searchSec, searchPara, searchCharOffset);

    if (result.type === 'none') {
      const hadSelection = this.cursor.isInTableObjectSelection()
        || this.cursor.isInPictureObjectSelection();
      clearAllControlSelection(this);
      if (hadSelection) {
        const paraCount = this.wasm.getParagraphCount(searchSec);
        const nextPara = Math.min(searchPara + 1, paraCount - 1);
        try { this.cursor.moveTo({ sectionIndex: searchSec, paragraphIndex: nextPara, charOffset: 0 }); } catch {}
      }
      this.updateCaret();
      return;
    }

    clearAllControlSelection(this);

    if (result.type === 'table') {
      const paraCount = this.wasm.getParagraphCount(result.sec);
      const cursorPara = Math.min(result.para + 1, paraCount - 1);
      try { this.cursor.moveTo({ sectionIndex: result.sec, paragraphIndex: cursorPara, charOffset: 0 }); } catch {}
      this.cursor.enterTableObjectSelectionDirect(result.sec, result.para, result.ci);
      this.updateCaret();
      this.renderTableObjectSelection();
    } else if (result.type === 'shape' || result.type === 'picture' || result.type === 'equation') {
      try { this.cursor.moveTo({ sectionIndex: result.sec, paragraphIndex: result.para, charOffset: 0 }); } catch {}
      let ctrlType: string = result.type === 'picture' ? 'image'
        : result.type === 'equation' ? 'equation'
        : 'shape';
      if (ctrlType === 'shape') {
        try {
          const pageCount = this.wasm.pageCount;
          for (let p = 0; p < pageCount; p++) {
            const layout = { controls: this.wasm.getPageControlLayout(p).controls.filter(isBodyControl) };
            for (const ctrl of layout.controls) {
              if (ctrl.type === 'line' && ctrl.secIdx === result.sec && ctrl.paraIdx === result.para && ctrl.controlIdx === result.ci) {
                ctrlType = 'line';
                break;
              }
            }
            if (ctrlType === 'line') break;
          }
        } catch { /* ignore */ }
      }
      this.cursor.enterPictureObjectSelectionDirect(
        result.sec, result.para, result.ci, ctrlType as any,
      );
      this.updateCaret();
      this.renderPictureObjectSelection();
    }
  } catch (err) {
    console.warn('[Shift+F11] error:', err);
  }
}
